import type { Express, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { ENV } from "./_core/env";
import * as team from "./team";

/**
 * Team chat for LeadDash EHR (2026-11-10).
 *
 * The chat screen is drawn in LeadDash EHR; the channels, messages and
 * threads live here. A person never signs in to this app for it. The EHR's
 * server asks on their behalf: every call carries a short-lived token the
 * EHR signed with the secret the two servers share, naming the practice
 * (its location id, name and time zone) and the person (email, name, and
 * whether they administer the practice in the EHR). The browser never holds
 * the secret and never talks to this server.
 *
 * From the token this finds or makes the practice's workspace and puts the
 * person on its team. A workspace made here is team chat only: no AI
 * employees, nothing that runs on its own, and no notice leaves this app for
 * it, because a message may name a client and the EHR sends its own notice
 * with initials only. The practice's EHR administrators own or administer
 * the workspace; everyone else is a team chat only member.
 *
 * The workspace is always the one the token's location id names. Nothing in
 * the request body can choose another: a call carries no workspace id.
 */

const TOKEN_MAX_AGE_S = 5 * 60;

export type ChatToken = {
  use: "chat";
  loc: string;
  practice: string;
  tz?: string;
  user: { email: string; name?: string; role?: string };
  iat: number;
  exp: number;
};

const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Checks a token the EHR signed for Team chat. Returns it, or the reason it is refused. */
export function readChatToken(token: string, secret = ENV.ehrLinkSecret, now = Date.now()): { token: ChatToken } | { error: string } {
  if (!secret) return { error: "Team chat is not connected to LeadDash EHR yet." };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { error: "That is not a LeadDash EHR Team chat token." };
  const [h, p, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "That token was not signed by LeadDash EHR." };
  let header: { alg?: string };
  let t: ChatToken;
  try {
    header = JSON.parse(fromB64url(h).toString("utf8"));
    t = JSON.parse(fromB64url(p).toString("utf8"));
  } catch {
    return { error: "That is not a LeadDash EHR Team chat token." };
  }
  if (header.alg !== "HS256" || t.use !== "chat") return { error: "That is not a LeadDash EHR Team chat token." };
  if (!t.exp || t.exp * 1000 < now) return { error: "That token has expired." };
  if (t.iat && t.exp - t.iat > TOKEN_MAX_AGE_S * 2) return { error: "That is not a LeadDash EHR Team chat token." };
  if (!t.loc || !t.practice || !t.user?.email) return { error: "That token is missing the practice or the person." };
  return { token: t };
}

/** Signs a token the way the EHR does. Used by tests and by a local EHR. */
export function signChatToken(payload: Omit<ChatToken, "iat" | "exp" | "use">, secret = ENV.ehrLinkSecret, ttlS = TOKEN_MAX_AGE_S) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(Buffer.from(JSON.stringify({ ...payload, use: "chat", iat: now, exp: now + ttlS })));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

const slugOf = (name: string, loc: string) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "practice";
  return `${base}-${loc.slice(-6).toLowerCase()}`;
};

/** The practice's workspace and this person on its team, made the first time either is seen. */
export async function seat(t: ChatToken) {
  let org = await db.getOrganizationByEhrLocation(t.loc);
  if (!org) {
    let slug = slugOf(t.practice, t.loc);
    if (await db.getOrganizationBySlug(slug)) slug = `${slug}-${Date.now().toString(36)}`;
    // Team chat only and quiet: no AI employees are added and nothing runs on its own.
    org = await db.createOrganization({ name: t.practice, slug, plan: "growth", orgType: "healthcare", timezone: t.tz || "America/Chicago", ehrLocationId: t.loc, chatOnly: true, quiet: true });
    await db.logAction({ organizationId: org.id, actorType: "human_user", actorName: t.user.name?.trim() || t.user.email, action: "Workspace created", details: "Team chat turned on in LeadDash EHR" });
  }
  const email = t.user.email.trim().toLowerCase();
  let user = await db.getUserByEmail(email);
  if (!user) user = await db.createUser({ email, role: "user", name: t.user.name?.trim() || null });
  else if (!user.name && t.user.name?.trim()) user = (await db.updateUser(user.id, { name: t.user.name.trim() })) ?? user;
  const members = await db.listMembers(org.id);
  if (!members.some((m) => m.userId === user!.id)) {
    const admin = String(t.user.role || "").toLowerCase() === "admin";
    const role = admin ? (members.some((m) => m.role === "owner") ? "admin" : "owner") : "chat";
    await db.addOrganizationMember({ organizationId: org.id, userId: user.id, role, title: admin ? "Administrator" : "Staff" });
  }
  team.ensureGeneral(org.id);
  return { org, user, me: { id: user.id, name: user.name?.trim() || email } };
}

const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const int = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new TRPCError({ code: "BAD_REQUEST", message: "That request is missing a number it needs." });
  return n;
};
const ints = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max).map(int) : []);

/**
 * One Team chat call for the person the token names, in the workspace the token names.
 * The names match the app's own team chat procedures; anything else is refused.
 */
export async function call(t: ChatToken, name: string, raw: unknown) {
  const { org, user, me } = await seat(t);
  const o = org.id;
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  switch (name) {
    case "me":
      return { userId: user.id, name: me.name, practice: org.name };
    case "channels":
      return team.channels(o, user.id);
    case "people":
      return (await team.people(o)).map((p) => ({ userId: p.userId, name: p.name || p.email, role: p.role, avatarUrl: p.avatarUrl ?? null, online: team.isOnline(o, p.userId) }));
    case "messages":
      return team.messages(o, user.id, str(i.channel, 40));
    case "thread":
      return team.thread(o, user.id, int(i.messageId));
    case "details":
      return team.details(o, user.id, str(i.channel, 40));
    case "send":
      // Files come in a later step; a message here is text.
      return team.send(o, me, str(i.channel, 40), str(i.content, 8000), [], { threadOf: i.threadOf == null ? null : int(i.threadOf), alsoToChannel: i.alsoToChannel === true });
    case "edit":
      return team.edit(o, me, int(i.messageId), str(i.content, 8000));
    case "remove":
      return team.remove(o, me, int(i.messageId));
    case "react":
      return team.react(o, me, int(i.messageId), str(i.emoji, 64));
    case "pin":
      return team.pin(o, me, int(i.messageId));
    case "markRead":
      return team.markRead(o, user.id, str(i.channel, 40), int(i.lastId));
    case "presence":
      return team.presence(o, user.id, str(i.channel, 40));
    case "typing":
      return team.markTyping(o, user.id, str(i.channel, 40), i.on === true);
    case "createChannel":
      // People only: no AI employee reads or answers in a channel made from the EHR.
      return team.createChannel(o, me, { name: str(i.name, 80), purpose: str(i.purpose, 250), private: i.private === true, memberIds: ints(i.memberIds, 200), aiAllowed: false });
    case "updateChannel":
      return team.updateChannel(o, me, int(i.channelId), { ...(i.name === undefined ? {} : { name: str(i.name, 80) }), ...(i.purpose === undefined ? {} : { purpose: str(i.purpose, 250) }), ...(i.private === undefined ? {} : { private: i.private === true }) });
    case "archiveChannel":
      return team.archiveChannel(o, me, int(i.channelId));
    case "addMembers":
      return team.addMembers(o, me, int(i.channelId), ints(i.userIds, 200));
    case "leaveChannel":
      return team.leaveChannel(o, me, int(i.channelId));
    case "joinChannel":
      return team.joinChannel(o, me, int(i.channelId));
    case "setNotify": {
      const mode = i.notify === "mentions" || i.notify === "none" ? i.notify : "all";
      return team.setNotify(o, me, int(i.channelId), mode, i.muted === true);
    }
    case "search":
      return team.search(o, user.id, str(i.q, 200), { from: i.from == null ? null : int(i.from), in: i.in == null ? null : str(i.in, 40), files: i.files === true, days: i.days == null ? null : int(i.days) });
    default:
      throw new TRPCError({ code: "NOT_FOUND", message: "Team chat does not know that request." });
  }
}

const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, TOO_MANY_REQUESTS: 429 };

export function registerEhrChat(app: Express) {
  // The EHR's server calls for one person. The token rides in a header, never in the address.
  app.post("/api/ehr-chat/:name", async (req: Request, res: Response) => {
    const read = readChatToken(String(req.headers["x-ehr-chat"] || ""));
    if ("error" in read) return res.status(401).json({ ok: false, error: read.error });
    try {
      const result = await call(read.token, String(req.params.name || ""), req.body);
      res.json({ ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof TRPCError) return res.status(STATUS[err.code] ?? 400).json({ ok: false, error: err.message });
      console.error("[ehr-chat] call failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ ok: false, error: "Team chat could not do that. Try again." });
    }
  });
}
