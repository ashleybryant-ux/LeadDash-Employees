import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { notify } from "./notify";

/**
 * Team chat: the people in a workspace talking to each other. One channel for
 * everyone, and a direct message between any two people. No AI employees read
 * or write here. Each workspace has its own Everyone channel, so the LeadDash
 * team and the Legacy team never see each other's channel. A direct message is
 * between two people, so it shows in every workspace they're both in: a DM
 * sent from one workspace is never hidden from someone looking in another.
 */

export const EVERYONE = "everyone";

export function dmKey(a: number, b: number) {
  return `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
}

/** The other person in a direct message, or null when the channel isn't one of yours. */
export function dmOther(channel: string, me: number) {
  const m = /^dm:(\d+)-(\d+)$/.exec(channel);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a !== me && b !== me) return null;
  return a === me ? b : a;
}

// Who has the app open, from their last check-in (in memory: it only needs to be roughly right).
const seen = new Map<string, number>();
export function markSeen(orgId: number, userId: number) {
  seen.set(`${orgId}:${userId}`, Date.now());
}
export function isOnline(orgId: number, userId: number) {
  return Date.now() - (seen.get(`${orgId}:${userId}`) ?? 0) < 90_000;
}

/** The people who can chat: everyone in the workspace except the app reviewer. */
export async function people(orgId: number) {
  return (await db.listMembers(orgId)).filter((m) => m.role !== "reviewer");
}

/** The workspaces where both people can chat (not as the app reviewer). Always includes this one. */
async function sharedOrgs(orgId: number, a: number, b: number) {
  const out = [orgId];
  for (const o of await db.listOrganizationsForUser(a)) {
    if (o.id === orgId) continue;
    const ma = await db.getOrganizationMembership(o.id, a);
    const mb = await db.getOrganizationMembership(o.id, b);
    if (ma && mb && ma.role !== "reviewer" && mb.role !== "reviewer") out.push(o.id);
  }
  return out;
}

/** Where a channel's messages live: this workspace for Everyone; every shared workspace for a DM. */
async function scopeOf(orgId: number, me: number, channel: string) {
  const other = dmOther(channel, me);
  return other == null ? orgId : sharedOrgs(orgId, me, other);
}

async function assertChannel(orgId: number, me: number, channel: string) {
  if (channel === EVERYONE) return null;
  const other = dmOther(channel, me);
  const list = await people(orgId);
  if (other == null || other === me || !list.some((p) => p.userId === other)) throw new TRPCError({ code: "NOT_FOUND", message: "That conversation isn't in this workspace." });
  return list.find((p) => p.userId === other)!;
}

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export async function channels(orgId: number, me: number) {
  markSeen(orgId, me);
  const list = await people(orgId);
  const others = list.filter((p) => p.userId !== me);
  const row = async (key: string) => {
    const orgs = await scopeOf(orgId, me, key);
    const last = db.team.last(orgs, key);
    const read = db.team.read(orgs, me, key);
    return { last: last ? { text: last.content || (last.attachments ? "Sent a file" : ""), author: last.authorName, mine: last.userId === me, at: last.createdAt } : null, unread: db.team.unread(orgs, me, key, read?.lastReadId ?? 0) };
  };
  const dms = [];
  for (const p of others) {
    const key = dmKey(me, p.userId);
    dms.push({ key, kind: "dm" as const, name: p.name || p.email, sub: ROLE[p.role] ?? p.role, userId: p.userId, avatarUrl: p.avatarUrl, online: isOnline(orgId, p.userId), ...(await row(key)) });
  }
  return [{ key: EVERYONE, kind: "channel" as const, name: "Everyone", sub: list.length === 2 ? `You and ${others[0]?.name || others[0]?.email}` : `${list.length} people`, userId: null, avatarUrl: null, online: false, ...(await row(EVERYONE)) }, ...dms];
}

export async function messages(orgId: number, me: number, channel: string) {
  markSeen(orgId, me);
  const other = await assertChannel(orgId, me, channel);
  const list = await people(orgId);
  const orgs = await scopeOf(orgId, me, channel);
  const rows = db.team.messages(orgs, channel);
  // "Seen": the other person has read past my last message.
  let seenAt: Date | null = null;
  if (other) {
    const mineLast = [...rows].reverse().find((m) => m.userId === me);
    const theirs = db.team.read(orgs, other.userId, channel);
    if (mineLast && theirs && theirs.lastReadId >= mineLast.id) seenAt = theirs.readAt ?? null;
  }
  return {
    channel,
    title: other ? other.name || other.email : "Everyone",
    sub: other ? `${ROLE[other.role] ?? other.role}${isOnline(orgId, other.userId) ? " · online now" : ""}` : list.length === 2 ? `You and ${list.find((p) => p.userId !== me)?.name ?? "your teammate"}` : `${list.length} people`,
    online: other ? isOnline(orgId, other.userId) : false,
    people: list.map((p) => ({ userId: p.userId, name: p.name || p.email, avatarUrl: p.avatarUrl })),
    messages: rows.map((m) => ({ id: m.id, userId: m.userId, authorName: m.authorName, content: m.content, attachments: m.attachments, createdAt: m.createdAt })),
    seenAt,
  };
}

export async function send(orgId: number, me: { id: number; name: string }, channel: string, content: string, attachmentIds: number[]) {
  const other = await assertChannel(orgId, me.id, channel);
  const text = content.trim().slice(0, 8000);
  const files = db.getChatFiles(orgId, attachmentIds.slice(0, 10)).filter((f) => f.employeeId === 0 && f.userId === me.id && f.messageId == null);
  if (!text && !files.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a message or attach a file." });
  const msg = db.team.send({
    organizationId: orgId,
    channel,
    userId: me.id,
    authorName: me.name,
    content: text,
    attachments: files.length ? JSON.stringify(files.map((f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, url: f.fileUrl }))) : null,
  });
  if (files.length) db.attachChatFiles(orgId, files.map((f) => f.id), -msg.id);
  db.team.markRead(orgId, me.id, channel, msg.id);
  markSeen(orgId, me.id);
  // Everyone else in the conversation hears about it, by their own choices.
  const to = other ? [other.userId] : (await people(orgId)).map((p) => p.userId).filter((id) => id !== me.id);
  if (to.length) {
    await notify(orgId, "team_message", { title: other ? me.name : `${me.name} in Everyone`, body: text || "Sent a file", url: `/chats/team/${channel}`, tag: `team-${channel}` }, { only: to }).catch(() => null);
  }
  return msg;
}

export function markRead(orgId: number, me: number, channel: string, lastId: number) {
  db.team.markRead(orgId, me, channel, lastId);
  markSeen(orgId, me);
}
