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
 *
 * WHO MAY TALK TO WHOM (2026-11-10)
 * Channels are for everyone, always (the owner's decision the same evening;
 * the first build hid them until the practice opened chat to the whole
 * team). Direct messages are what the practice's rule limits: a practice
 * starts with its team able to direct message its administrators and nobody
 * else, and an administrator able to direct message anyone. The practice's
 * administrator is asked in the EHR whether the whole team may message each
 * other; once they say yes the token carries scope "all" and every direct
 * message opens up. While it is administrators only, making, renaming,
 * archiving and adding people to a channel is for administrators, so a
 * private channel cannot stand in for the direct message the rule closes. The scope rides in the signed token, so the browser
 * cannot widen it, and it is enforced here on every call, not only by what
 * the screen chooses to draw.
 */

const TOKEN_MAX_AGE_S = 5 * 60;

export type ChatToken = {
  use: "chat";
  loc: string;
  practice: string;
  tz?: string;
  /** "all": the whole team chats with each other. Anything else: team members and administrators only. */
  scope?: "all" | "admins";
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

/**
 * THE PRACTICE'S TEAM (2026-11-10)
 * Team chat lists everyone on the practice's team, not only the people who
 * have opened it. The EHR is the record of who is on the team, so it sends
 * its list with a call now and then: the same link secret signs it, it names
 * the practice, and it is read only when that practice is the one the call's
 * own token names. Each person on it is given a seat here (by email, with
 * their name and whether they administer the practice); someone no longer on
 * it loses theirs. Their messages stay. Only in a team chat only workspace:
 * one with the employees keeps the team its owner set.
 */
export type RosterPerson = { email: string; name?: string; admin?: boolean };
type RosterToken = { use: "chat-roster"; loc: string; people: RosterPerson[]; iat: number; exp: number };

export function readRosterToken(token: string, loc: string, secret = ENV.ehrLinkSecret, now = Date.now()): RosterPerson[] | null {
  if (!secret) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest()));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let t: RosterToken;
  try {
    if (JSON.parse(fromB64url(h).toString("utf8")).alg !== "HS256") return null;
    t = JSON.parse(fromB64url(p).toString("utf8"));
  } catch {
    return null;
  }
  if (t.use !== "chat-roster" || !t.exp || t.exp * 1000 < now || t.loc !== loc || !Array.isArray(t.people)) return null;
  const seen = new Set<string>();
  const out: RosterPerson[] = [];
  for (const x of t.people.slice(0, 1000)) {
    const email = String(x?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: String(x?.name || "").trim().slice(0, 120), admin: x?.admin === true });
  }
  return out;
}

export function signRosterToken(loc: string, people: RosterPerson[], secret = ENV.ehrLinkSecret, ttlS = TOKEN_MAX_AGE_S) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(Buffer.from(JSON.stringify({ use: "chat-roster", loc, people, iat: now, exp: now + ttlS })));
  const sig = b64url(createHmac("sha256", secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

/** Seats everyone on the EHR's list and unseats whoever is no longer on it. The caller is never unseated. */
async function syncRoster(orgId: number, people: RosterPerson[], callerId: number, callerEmail: string) {
  // A list that does not even hold the person asking is not the practice's team: nothing is taken from it.
  const whole = people.some((p) => p.email === callerEmail.trim().toLowerCase());
  const members = await db.listMembers(orgId);
  let hasOwner = members.some((m) => m.role === "owner");
  const keep = new Set<number>([callerId]);
  for (const p of people) {
    let user = await db.getUserByEmail(p.email);
    if (!user) user = await db.createUser({ email: p.email, role: "user", name: p.name || null });
    else if (!user.name && p.name) user = (await db.updateUser(user.id, { name: p.name })) ?? user;
    keep.add(user.id);
    if (user.id === callerId) continue; // seat() has just set the caller's own seat from their own token
    const mine = members.find((m) => m.userId === user!.id);
    if (!mine) {
      const role = p.admin ? (hasOwner ? "admin" : "owner") : "chat";
      if (role === "owner") hasOwner = true;
      await db.addOrganizationMember({ organizationId: orgId, userId: user.id, role, title: p.admin ? "Administrator" : "Staff" });
    } else {
      const isAdminHere = mine.role === "owner" || mine.role === "admin";
      if (p.admin && !isAdminHere) await db.updateMemberRole(orgId, user.id, "admin");
      if (!p.admin && isAdminHere) await db.updateMemberRole(orgId, user.id, "chat");
    }
  }
  if (whole) {
    for (const m of members) {
      if (keep.has(m.userId) || m.role === "reviewer") continue;
      await db.removeMember(orgId, m.userId);
    }
  }
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
  const admin = String(t.user.role || "").toLowerCase() === "admin";
  const mine = members.find((m) => m.userId === user!.id);
  if (!mine) {
    const role = admin ? (members.some((m) => m.role === "owner") ? "admin" : "owner") : "chat";
    await db.addOrganizationMember({ organizationId: org.id, userId: user.id, role, title: admin ? "Administrator" : "Staff" });
  } else if (org.chatOnly) {
    // The EHR is the record of who administers the practice: someone made an administrator there
    // (or no longer one) is the same here the next time they call. Only in a team chat only
    // workspace; a workspace with the employees keeps the roles its owner set.
    const isAdminHere = mine.role === "owner" || mine.role === "admin";
    if (admin && !isAdminHere) await db.updateMemberRole(org.id, user.id, "admin");
    if (!admin && isAdminHere) await db.updateMemberRole(org.id, user.id, "chat");
  }
  team.ensureGeneral(org.id);
  return { org, user, me: { id: user.id, name: user.name?.trim() || email }, admin };
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
/**
 * NOTICES (2026-11-10)
 * A team chat only workspace sends nothing out of this app (notify.ts). The
 * EHR sends the notice, so a send here answers with who should hear about
 * it: each person's email, the kind of conversation, how many messages now
 * wait for them, and the start of the message, which the notice shows the
 * way a chat app does (the owner's decision, 2026-11-10). Someone with that
 * conversation open on screen is left out. The EHR takes the list off the
 * answer before the browser sees it, so it reaches only the people it names.
 */
const VIEWING_MS = 12_000;
const viewing = new Map<string, { channel: string; at: number }>();
const isViewing = (orgId: number, userId: number, channel: string) => {
  const v = viewing.get(`${orgId}:${userId}`);
  return !!v && v.channel === channel && Date.now() - v.at < VIEWING_MS;
};

const ADMINS_ONLY = "Your practice has direct messages set to administrators only. An administrator can open them to the whole team.";
const ADMIN_MAKES = "A practice administrator sets up channels while direct messages are set to administrators only.";
/** While it is administrators only: for administrators alone, because each could build a private room between team members. */
const ADMIN_ONLY_CALLS = new Set(["createChannel", "updateChannel", "archiveChannel", "addMembers"]);
/** Reads across every conversation, old direct messages included: closed while it is administrators only. */
const NEEDS_ALL = new Set(["search"]);
const isDm = (key: string) => /^dm:\d+-\d+$/.test(key);
type Notice = { email: string; kind: "dm" | "channel" | "thread"; from: string; channel: string; key: string; unread: number; text: string };

export async function call(t: ChatToken, name: string, raw: unknown) {
  const { org, user, me, admin } = await seat(t);
  const o = org.id;
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  // The practice's team, when the EHR sent it with this call (signed, and for this practice only).
  if (org.chatOnly && typeof i.roster === "string") {
    const people = readRosterToken(i.roster, t.loc);
    if (people && people.length) await syncRoster(o, people, user.id, t.user.email);
  }

  // Team members and administrators only, unless the practice opened it to the whole team.
  if (t.scope !== "all") {
    const refuse = () => {
      throw new TRPCError({ code: "FORBIDDEN", message: ADMINS_ONLY });
    };
    const adminIds = new Set((await db.listMembers(o)).filter((m) => m.role === "owner" || m.role === "admin").map((m) => m.userId));
    /** A direct message with one end an administrator: an administrator with anyone, anyone with an administrator. */
    const allowedKey = (key: string) => {
      const other = team.dmOther(key, user.id);
      return other != null && other !== user.id && (admin || adminIds.has(other));
    };
    if (NEEDS_ALL.has(name)) refuse();
    if (ADMIN_ONLY_CALLS.has(name) && !admin) throw new TRPCError({ code: "FORBIDDEN", message: ADMIN_MAKES });
    // A channel is open to whoever may see it (team.ts checks that); a direct message needs an administrator at one end.
    const okKey = (key: string) => !isDm(key) || allowedKey(key);
    if (["messages", "send", "markRead", "presence", "typing", "details"].includes(name) && !okKey(str(i.channel, 40))) refuse();
    if (name === "muteDm" && !allowedKey(str(i.channel, 40)) && isDm(str(i.channel, 40))) refuse();
    if (["thread", "edit", "remove", "react", "pin"].includes(name)) {
      const m = db.team.get(o, int(i.messageId));
      if (!m || !okKey(m.channel)) refuse();
    }
    if (name === "channels") {
      const all = await team.channels(o, user.id);
      const dms = all.dms.filter((d) => admin || adminIds.has(d.userId));
      const unread = all.channels.filter((c) => !c.muted).reduce((n, c) => n + c.unread, 0) + dms.filter((d) => !d.muted).reduce((n, d) => n + d.unread, 0);
      return { ...all, dms, counts: { ...all.counts, unread }, admin, scope: "admins" as const };
    }
    if (name === "people") {
      return (await team.people(o))
        .filter((p) => admin || p.userId === user.id || adminIds.has(p.userId))
        .map((p) => ({ userId: p.userId, name: p.name || p.email, role: p.role, avatarUrl: p.avatarUrl ?? null, online: team.isOnline(o, p.userId) }));
    }
  }

  // For the EHR's server only (it does not forward this name from a browser): who is who, so it can add each person's picture.
  if (name === "directory") {
    const list = await team.people(o);
    // Everyone on the team: with channels for all, anyone's picture can sit beside a message.
    return list.map((p) => ({ userId: p.userId, email: p.email }));
  }

  switch (name) {
    case "me":
      return { userId: user.id, name: me.name, practice: org.name };
    case "channels":
      return { ...(await team.channels(o, user.id)), scope: "all" as const };
    case "people":
      return (await team.people(o)).map((p) => ({ userId: p.userId, name: p.name || p.email, role: p.role, avatarUrl: p.avatarUrl ?? null, online: team.isOnline(o, p.userId) }));
    case "messages": {
      const out = await team.messages(o, user.id, str(i.channel, 40));
      // The screen asks for the open conversation every few seconds: that is how we know it is on screen.
      viewing.set(`${o}:${user.id}`, { channel: out.channel, at: Date.now() });
      return out;
    }
    case "thread":
      return team.thread(o, user.id, int(i.messageId));
    case "details":
      return team.details(o, user.id, str(i.channel, 40));
    case "send": {
      // Files come in a later step; a message here is text.
      const key = str(i.channel, 40);
      const msg = await team.send(o, me, key, str(i.content, 8000), [], { threadOf: i.threadOf == null ? null : int(i.threadOf), alsoToChannel: i.alsoToChannel === true });
      // Only a team chat only workspace: one with the employees sends its own notices.
      const h = org.chatOnly ? team.heardBy(msg) : null;
      const notices: Notice[] = [];
      if (h && h.to.length) {
        const list = await team.people(o);
        for (const id of h.to) {
          const p = list.find((x) => x.userId === id);
          if (!p?.email || isViewing(o, id, key)) continue;
          const read = db.team.read(o, id, key);
          const unread = Math.max(1, db.team.unread(o, id, key, read?.lastReadId ?? 0).count);
          notices.push({ email: p.email, kind: h.kind, from: me.name, channel: h.channelName, key, unread, text: (msg.content || "").replace(/\s+/g, " ").trim().slice(0, 200) });
        }
      }
      return { ...msg, notices };
    }
    case "muteDm":
      return team.muteDm(o, me, str(i.channel, 40), i.muted === true);
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
