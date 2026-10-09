import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { ENV } from "./_core/env";
import { encryptJson } from "./_core/crypto";
import { startSession } from "./_core/auth";
import { ensureRoster } from "./employees/roster-sync";
import { ROSTER } from "./employees/roster";
import { saveRosterPortrait } from "./employees/files";

/**
 * The door from LeadDash EHR (2026-10-09).
 *
 * A practice never pastes a key. LeadDash EHR turns LeadDash Employees on for
 * a practice from its agency screen, and the practice's Settings then shows
 * one button: Open LeadDash Employees. Pressing it sends the person here with
 * a short-lived pass the EHR signed with a secret the two servers share. The
 * pass carries the practice (location id, name, time zone), the EHR address,
 * the employees key the EHR minted, and who is opening (email, name, EHR
 * role). From it this app finds or makes the workspace, puts the person on
 * it, stores the key as the EHR connection, and signs them in.
 *
 * The same secret lets the EHR's agency screen read and change how the roster
 * employees look and sound in every workspace (portraits and voices).
 */

const PASS_MAX_AGE_S = 5 * 60;

export type EhrPass = {
  loc: string;
  practice: string;
  tz?: string;
  url: string;
  key: string;
  user: { email: string; name?: string; role?: string };
  iat: number;
  exp: number;
};

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Checks an HS256 token the EHR signed with the shared secret. Returns the payload, or the reason it is refused. */
export function readPass(token: string, secret = ENV.ehrLinkSecret, now = Date.now()): { pass: EhrPass } | { error: string } {
  if (!secret) return { error: "This app has no link to LeadDash EHR yet (EHR_LINK_SECRET is not set)." };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { error: "That link is not a LeadDash EHR pass." };
  const [h, p, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "That link was not signed by LeadDash EHR." };
  let header: { alg?: string };
  let pass: EhrPass;
  try {
    header = JSON.parse(fromB64url(h).toString("utf8"));
    pass = JSON.parse(fromB64url(p).toString("utf8"));
  } catch {
    return { error: "That link is not a LeadDash EHR pass." };
  }
  if (header.alg !== "HS256") return { error: "That link is not a LeadDash EHR pass." };
  if (!pass.exp || pass.exp * 1000 < now) return { error: "That link has expired. Open LeadDash Employees from the EHR again." };
  if (pass.iat && pass.exp - pass.iat > PASS_MAX_AGE_S * 2) return { error: "That link is not a LeadDash EHR pass." };
  if (!pass.loc || !pass.practice || !pass.url || !pass.key || !pass.user?.email) return { error: "That link is missing what it needs. Open LeadDash Employees from the EHR again." };
  return { pass };
}

/** Signs a pass the way the EHR does. Used by tests and by a local EHR. */
export function signPass(payload: Omit<EhrPass, "iat" | "exp">, secret = ENV.ehrLinkSecret, ttlS = PASS_MAX_AGE_S) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlS })));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

/** The EHR role, as the workspace role. Administrators own or administer; everyone else the EHR lets in is a member. */
export function roleFor(ehrRole: string | undefined, hasOwner: boolean): "owner" | "admin" | "member" {
  if (String(ehrRole || "").toLowerCase() === "admin") return hasOwner ? "admin" : "owner";
  return "member";
}

const slugOf = (name: string, loc: string) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "practice";
  return `${base}-${loc.slice(-6).toLowerCase()}`;
};

/**
 * Finds or makes the workspace for a pass, puts the person on it, and stores
 * the EHR connection. Returns the workspace and whether it was just made.
 */
export async function openFromEhr(pass: EhrPass) {
  let org = await db.getOrganizationByEhrLocation(pass.loc);
  let created = false;
  if (!org) {
    let slug = slugOf(pass.practice, pass.loc);
    if (await db.getOrganizationBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`;
    org = await db.createOrganization({ name: pass.practice, slug, plan: "growth", orgType: "healthcare", timezone: pass.tz || "America/Chicago", ehrLocationId: pass.loc });
    await ensureRoster(org.id);
    created = true;
  } else if (org.orgType !== "healthcare") {
    await db.updateOrganization(org.id, { orgType: "healthcare" });
  }
  const email = pass.user.email.trim().toLowerCase();
  let user = await db.getUserByEmail(email);
  if (!user) user = await db.createUser({ email, role: "user", name: pass.user.name?.trim() || null });
  else if (!user.name && pass.user.name?.trim()) user = (await db.updateUser(user.id, { name: pass.user.name.trim() })) ?? user;
  const members = await db.listMembers(org.id);
  const mine = members.find((m) => m.userId === user!.id);
  if (!mine) {
    const hasOwner = members.some((m) => m.role === "owner");
    await db.addOrganizationMember({ organizationId: org.id, userId: user.id, role: roleFor(pass.user.role, hasOwner), title: pass.user.role === "admin" ? "Administrator" : "Staff" });
  }
  const existing = await db.getConnectionByProvider(org.id, "leaddash_ehr");
  const settings = { ...(existing?.settings ? safeJson(existing.settings) : {}), url: pass.url.replace(/\/+$/, ""), practice: pass.practice, locationId: pass.loc, via: "ehr" };
  await db.upsertExternalConnection({ organizationId: org.id, provider: "leaddash_ehr", accountLabel: pass.practice, status: "connected", settings: JSON.stringify(settings), secretsEncrypted: encryptJson({ key: pass.key }) });
  if (created) {
    await db.logAction({ organizationId: org.id, actorType: "human_user", actorName: pass.user.name?.trim() || email, action: "Workspace created", details: `Opened from LeadDash EHR as ${pass.practice}, with ${ROSTER.length} employees and the EHR connected.` });
  }
  return { org, user, created };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The EHR's agency screen calls with the shared secret in a header. */
function fromEhrServer(req: Request) {
  const given = String(req.headers["x-leaddash-link"] || "");
  if (!ENV.ehrLinkSecret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ENV.ehrLinkSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The portrait chosen for a kind in every workspace, or null when the bundled one stands. */
export function portraitFor(kind: string) {
  return db.rosterDefaults.get(kind)?.avatarUrl ?? null;
}

/** An employee as the app shows it: a workspace's own photo first, then the portrait chosen for everyone, then nothing (the bundled file). */
export function withPortrait<T extends { kind: string; avatar: string | null }>(emp: T): T {
  if (emp.avatar) return emp;
  const chosen = portraitFor(emp.kind);
  return chosen ? { ...emp, avatar: chosen } : emp;
}

/** Every roster employee with the portrait and voice chosen for all workspaces. */
export function rosterView() {
  const defaults = new Map(db.rosterDefaults.list().map((r) => [r.kind, r]));
  return ROSTER.map((r) => {
    const kind = r.kind;
    const d = defaults.get(kind);
    return { kind, name: r.name, roleTitle: r.roleTitle, avatarUrl: d?.avatarUrl ?? null, bundledAvatar: `/avatars/${kind}.webp`, voiceId: d?.voiceId ?? null, voiceName: d?.voiceName ?? null, updatedBy: d?.updatedBy ?? null, updatedAt: d?.updatedAt ?? null };
  });
}

export function registerEhrLink(app: Express) {
  // The person arrives from the EHR's Open button.
  app.get("/from-ehr", async (req: Request, res: Response) => {
    const read = readPass(String(req.query.pass || ""));
    if ("error" in read) return res.status(400).send(page("Could not open LeadDash Employees", read.error));
    try {
      const { org, user, created } = await openFromEhr(read.pass);
      await db.updateUser(user.id, { lastSignedIn: new Date() });
      await startSession(user.id, req, res);
      res.redirect(created ? `/welcome?org=${org.id}` : `/chats?org=${org.id}`);
    } catch (err) {
      console.error("[ehr-link] open failed:", err);
      res.status(500).send(page("Could not open LeadDash Employees", "Something went wrong setting up the workspace. Try again from LeadDash EHR, or write to info@leaddash.io."));
    }
  });

  app.get("/api/ehr-link/roster", (req, res) => {
    if (!fromEhrServer(req)) return res.status(401).json({ ok: false, error: "Not from LeadDash EHR" });
    res.json({ ok: true, roster: rosterView() });
  });

  app.get("/api/ehr-link/voices", async (req, res) => {
    if (!fromEhrServer(req)) return res.status(401).json({ ok: false, error: "Not from LeadDash EHR" });
    try {
      const huddle = await import("./employees/huddle");
      res.json({ ok: true, voices: await huddle.listVoices() });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/api/ehr-link/roster/:kind", async (req, res) => {
    if (!fromEhrServer(req)) return res.status(401).json({ ok: false, error: "Not from LeadDash EHR" });
    const kind = String(req.params.kind || "");
    if (!ROSTER.some((r) => r.kind === kind)) return res.status(404).json({ ok: false, error: "No such employee" });
    const body = (req.body ?? {}) as { voiceId?: string | null; voiceName?: string | null; portrait?: string | null; clearPortrait?: boolean; by?: string };
    const patch: { avatarUrl?: string | null; voiceId?: string | null; voiceName?: string | null } = {};
    try {
      if (typeof body.portrait === "string" && body.portrait) patch.avatarUrl = (await saveRosterPortrait(kind, body.portrait)).url;
      if (body.clearPortrait) patch.avatarUrl = null;
      if ("voiceId" in body) {
        patch.voiceId = body.voiceId ? String(body.voiceId).slice(0, 120) : null;
        patch.voiceName = body.voiceId ? String(body.voiceName || "").slice(0, 120) || null : null;
      }
      db.rosterDefaults.set(kind, patch, String(body.by || "LeadDash staff").slice(0, 120));
      if ("voiceId" in body) (await import("./employees/huddle")).forgetVoices();
      res.json({ ok: true, employee: rosterView().find((r) => r.kind === kind) });
    } catch (err) {
      const msg = err instanceof TRPCError ? err.message : err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });
}

function page(title: string, text: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:system-ui,sans-serif;background:#f8fafb;color:#14221c;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#fff;border:1px solid #e3e9e6;border-radius:12px;padding:28px 32px;max-width:460px"><h1 style="font-size:20px;margin:0 0 10px">${esc(title)}</h1><p style="margin:0;font-size:15px;line-height:1.5">${esc(text)}</p></div></body></html>`;
}
