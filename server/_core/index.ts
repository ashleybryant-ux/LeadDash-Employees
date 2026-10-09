import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { authenticateRequest, createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { ENV } from "./env";
import { getDb, getOrganizationMembership, guestSharesForUser, publicFileByToken, purgeExpiredAuthRecords } from "../db";
import path from "node:path";
import { fileOwner, uploadsRoot } from "../storage";
import { aiStatus, searchModel } from "./llm";
import { hasSecretsKey } from "./crypto";
import { startScheduler } from "../employees/runner";
import { registerUploads } from "../uploads";
import { registerVoice } from "../voice";
import { ensureIndexed } from "../employees/kb";
import { markStuckApplications, markStuckPages } from "../db";
import { ensureAllRosters } from "../employees/roster-sync";
import { pushReady, startNotifications } from "../notify";
import { readyApps, registerOAuth } from "../integrations";
import { registerPublicPages } from "../public-pages";
import { registerSalesPages } from "../sales-pages";
import { registerProjectPages } from "../project-pages";

async function startServer() {
  // Open the database and run any pending migrations before taking traffic.
  getDb();
  await markStuckApplications();
  markStuckPages();
  await ensureAllRosters();
  startNotifications();
  // Once per workspace: earlier AI costs are matched to the person whose chat message started them.
  import("../aiLimits").then((m) => m.backfillAll()).catch((err) => console.error("[ai limits] back-count failed:", err));
  ensureIndexed().catch((err) => console.error("[knowledge] indexing failed:", err));

  const app = express();
  const server = createServer(app);

  // Behind nginx on the EC2 box: trust the first proxy for req.ip and https detection.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // Pages can't be framed by other sites. Stored files may be framed by this app itself, for the preview window.
    if (_req.path.startsWith("/files/")) res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    else res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Large files (videos, RFPs, signed forms) arrive as raw bodies, before JSON parsing.
  registerUploads(app);
  // Team huddles: spoken answers, the meeting bot's page and its transcript webhook.
  registerVoice(app);

  app.use(express.json({ limit: "16mb" })); // Brain uploads arrive as base64
  app.use(express.urlencoded({ limit: "2mb", extended: true }));
  // The door from LeadDash EHR: a practice opens this app from its Settings, and the EHR's agency screen sets portraits and voices.
  (await import("../ehrLink")).registerEhrLink(app);
  // The Claude and ChatGPT connector.
  (await import("../mcp")).registerMcp(app);

  // Sign-in protection: at most 30 sign-in calls per 15 minutes per address, and
  // no batching of sign-in calls (one request cannot carry many code guesses).
  const hits = new Map<string, { n: number; reset: number }>();
  app.use("/api/trpc", (req, res, next) => {
    const procs = decodeURIComponent(req.path.replace(/^\//, "")).split(",");
    if (procs.length > 20) return res.status(400).json({ error: "Too many calls in one request" });
    if (!procs.some((p) => p.startsWith("auth.requestCode") || p.startsWith("auth.verifyCode"))) return next();
    if (procs.length > 1) return res.status(400).json({ error: "Sign-in calls cannot be batched" });
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) hits.set(key, { n: 1, reset: now + 15 * 60_000 });
    else if (++entry.n > 30) return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    if (hits.size > 10_000) hits.forEach((v, k) => v.reset < now && hits.delete(k));
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ai: aiStatus(), secretsKey: hasSecretsKey(), push: pushReady(), connect: readyApps() });
  });

  // Public links for images used on published pages (photos and stock images Jordan
  // placed). Only files given a link are served; everything else stays private.
  app.get("/pub/:file", async (req, res) => {
    const token = String(req.params.file).replace(/\.[a-z0-9]+$/i, "");
    if (!/^[a-f0-9]{24}$/.test(token)) return res.status(404).send("Not found");
    const row = publicFileByToken(token);
    if (!row) return res.status(404).send("Not found");
    const root = uploadsRoot();
    const full = path.resolve(root, row.fileKey);
    if (!full.startsWith(root + path.sep)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "public, max-age=604800");
    return res.sendFile(full, (err) => {
      if (err && !res.headersSent) res.status(404).send("Not found");
    });
  });

  // Stored files (W-9s, licenses, RFPs, videos, downloads, images). Keys are
  // random, and every request must also come from a signed-in person on the
  // workspace the file belongs to (org-<id>/...). LeadDash staff have support access.
  // Web pages and SVGs people upload are never run on this site: they download as text.
  const files = express.static(uploadsRoot(), {
    fallthrough: false,
    maxAge: "1h",
    dotfiles: "deny",
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (/\.(html?|xhtml|svg|xml)$/i.test(filePath)) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  });
  app.use("/files", async (req, res, next) => {
    try {
      // A roster portrait (chosen by LeadDash staff for every workspace) is a public picture of an AI employee: shown
      // on the EHR's agency screen and the huddle bot's page without a sign-in. Its name is random; nothing else is.
      if (/^\/roster\/[a-z0-9_-]+\/portrait-[a-z0-9_]+\.(png|jpg|webp|gif)$/i.test(req.path)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
        return files(req, res, next);
      }
      const { user } = await authenticateRequest(req);
      if (!user) return res.status(401).send("Sign in to open this file.");
      // Every file belongs to a workspace (org-<id>/) or is one person's photo (user-<id>/). Anything else is never served.
      const owner = fileOwner(req.path);
      if (!owner) return res.status(404).send("Not found");
      const org = owner.kind === "org" ? String(owner.id) : null;
      if (org && user.role !== "admin" && !(await getOrganizationMembership(Number(org), user.id))) {
        // A guest on a shared Projects list can open the files on its tasks (their names carry a random key).
        const guest = /^\/org-\d+\/work\//.test(decodeURIComponent(req.path)) && guestSharesForUser(user.id).some((g) => g.organizationId === Number(org));
        if (!guest) return res.status(403).send("This file belongs to another workspace.");
      }
      res.setHeader("Cache-Control", "private, max-age=3600");
      return files(req, res, next);
    } catch (err) {
      return next(err);
    }
  });

  // One-click connections (Google, LinkedIn, Meta, X) and signed image links for Meta.
  registerOAuth(app);
  registerPublicPages(app);
  registerSalesPages(app);
  registerProjectPages(app);

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Scheduled tasks (checks once a minute).
  // The deploy's boot check runs on a copy of the database with NO_SCHEDULER=1, so it never starts paid work.
  if (process.env.NODE_ENV !== "test" && process.env.NO_SCHEDULER !== "1") startScheduler();

  // Clear expired sign-in codes and sessions every hour.
  setInterval(() => purgeExpiredAuthRecords().catch(() => {}), 3600_000).unref();

  server.listen(ENV.port, "127.0.0.1", () => {
    const ai = aiStatus();
    console.log(`LeadDash Employees listening on http://127.0.0.1:${ENV.port}/`);
    console.log(
      `AI: writing ${ai.writing ? "on" : "OFF"}, web search ${ai.webSearch ? `on (${ENV.searchProvider}, ${searchModel()})` : "OFF"}, images ${ai.images ? "on" : "OFF"}; secrets key ${hasSecretsKey() ? "set" : "MISSING"}`
    );
    if (ENV.adminEmails.length === 0) console.warn("ADMIN_EMAILS is empty: nobody can create workspaces.");
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
