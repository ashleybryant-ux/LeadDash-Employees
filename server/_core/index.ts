import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { ENV } from "./env";
import { getDb, purgeExpiredAuthRecords } from "../db";
import { uploadsRoot } from "../storage";
import { aiStatus } from "./llm";
import { hasSecretsKey } from "./crypto";
import { startScheduler } from "../employees/runner";

async function startServer() {
  // Open the database and run any pending migrations before taking traffic.
  getDb();

  const app = express();
  const server = createServer(app);

  // Behind nginx on the EC2 box: trust the first proxy for req.ip and https detection.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  app.use(express.json({ limit: "16mb" })); // Brain uploads arrive as base64
  app.use(express.urlencoded({ limit: "2mb", extended: true }));

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
    res.json({ ok: true, ai: aiStatus(), secretsKey: hasSecretsKey() });
  });

  // Generated images and banners. Keys are random; nothing here is client data.
  app.use("/files", express.static(uploadsRoot(), { fallthrough: false, maxAge: "7d", dotfiles: "deny" }));

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Scheduled tasks (checks once a minute).
  if (process.env.NODE_ENV !== "test") startScheduler();

  // Clear expired sign-in codes and sessions every hour.
  setInterval(() => purgeExpiredAuthRecords().catch(() => {}), 3600_000).unref();

  server.listen(ENV.port, "127.0.0.1", () => {
    const ai = aiStatus();
    console.log(`LeadDash Employees listening on http://127.0.0.1:${ENV.port}/`);
    console.log(
      `AI: writing ${ai.writing ? "on" : "OFF"}, web search ${ai.webSearch ? "on" : "OFF"}, images ${ai.images ? "on" : "OFF"}; secrets key ${hasSecretsKey() ? "set" : "MISSING"}`
    );
    if (ENV.adminEmails.length === 0) console.warn("ADMIN_EMAILS is empty: nobody can create workspaces.");
  });
}

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
