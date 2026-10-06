import { TRPCError } from "@trpc/server";
import * as db from "./db";
import * as links from "./teamLinks";
import { notify } from "./notify";

/**
 * Team chat: the people in a workspace talking to each other, like Slack.
 * Each workspace has its own channels: "general" (key "everyone", the one
 * every workspace starts with), the channels people make ("ch:<id>", public
 * or private), and a direct message between any two people ("dm:<a>-<b>"),
 * which shows in every workspace they are both in. Messages have threads,
 * reactions, pins, saved copies and @mentions. An AI employee mentioned in a
 * channel that allows it answers in a thread under that message.
 */

export const EVERYONE = "everyone";
export const GENERAL_NAME = "general";

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

type Me = { id: number; name: string };
const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", chat: "Team chat only" };

/** The people who can chat: everyone in the workspace except the app reviewer (team chat only people included). */
export async function people(orgId: number) {
  return (await db.listMembers(orgId)).filter((m) => m.role !== "reviewer");
}

/** True for a team chat only person: they chat with people, never with the AI employees, so no AI employee is offered or answers them. */
export async function chatOnly(orgId: number, me: number) {
  return (await db.getOrganizationMembership(orgId, me))?.role === "chat";
}

/**
 * LeadDash staff (users.role = admin) reach every workspace without being on its team.
 * Team chat is between people on the team, so a staff member who talks in a workspace's
 * chat joins its team: as its owner when it has none, else as an admin. Without this,
 * the people they write to can't see the conversation, because it isn't between two members.
 */
export async function ensureOnTeam(orgId: number, me: number) {
  if (await db.getOrganizationMembership(orgId, me)) return false;
  const u = await db.getUserById(me);
  if (u?.role !== "admin") return false;
  const members = await db.listMembers(orgId);
  const role = members.some((m) => m.role === "owner") ? "admin" : "owner";
  await db.addOrganizationMember({ organizationId: orgId, userId: me, role, title: role === "owner" ? "Owner" : "LeadDash" });
  return true;
}

/** Staff who already wrote in this workspace's chat before joining its team: put them on it now. */
async function repairStaff(orgId: number) {
  for (const userId of db.team.authors(orgId)) await ensureOnTeam(orgId, userId).catch(() => null);
}

/** The workspace's owner or an admin, or LeadDash staff (a platform admin, who can reach every workspace). */
async function isAdmin(orgId: number, me: number) {
  const m = await db.getOrganizationMembership(orgId, me);
  if (m && (m.role === "owner" || m.role === "admin")) return true;
  return (await db.getUserById(me))?.role === "admin";
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

/** Where a channel's messages live: this workspace for a channel; every shared workspace for a DM. */
async function scopeOf(orgId: number, me: number, channel: string) {
  const other = dmOther(channel, me);
  return other == null ? orgId : sharedOrgs(orgId, me, other);
}

// ==========================================
// Channels
// ==========================================

/** Every workspace has a general channel; it's made the first time anyone looks. */
export function ensureGeneral(orgId: number) {
  return db.team.channelByKey(orgId, EVERYONE) ?? db.team.addChannel({ organizationId: orgId, key: EVERYONE, name: GENERAL_NAME, purpose: "", private: false, aiAllowed: true });
}

function memberRow(channelId: number, me: number) {
  return db.team.members(channelId).find((m) => m.userId === me) ?? null;
}

/** Can this person see the channel? Members of a private one; anyone who hasn't left a public one. */
function canSee(ch: db.TeamChannelRow, me: number) {
  const row = memberRow(ch.id, me);
  if (ch.private) return !!row && !row.left;
  return !row || !row.left;
}

/** The channels this person can see, general first. */
export function visibleChannels(orgId: number, me: number) {
  ensureGeneral(orgId);
  return db.team
    .channels(orgId)
    .filter((c) => !c.archived && canSee(c, me))
    .sort((a, b) => (a.key === EVERYONE ? -1 : b.key === EVERYONE ? 1 : a.name.localeCompare(b.name)));
}

/** The channel behind a key the person may read, or an error. */
async function channelFor(orgId: number, me: number, key: string) {
  if (dmOther(key, me) != null) {
    const other = dmOther(key, me)!;
    const list = await people(orgId);
    const p = list.find((x) => x.userId === other);
    if (!p || other === me) throw new TRPCError({ code: "NOT_FOUND", message: "That conversation isn't in this workspace." });
    return { kind: "dm" as const, other: p, channel: null };
  }
  ensureGeneral(orgId);
  const ch = db.team.channelByKey(orgId, key);
  if (!ch || ch.archived || !canSee(ch, me)) throw new TRPCError({ code: "NOT_FOUND", message: "That channel isn't in this workspace." });
  return { kind: "channel" as const, other: null, channel: ch };
}

/** Who gets notified about a channel: its members (private), or everyone who hasn't left (public). */
async function channelPeople(orgId: number, ch: db.TeamChannelRow) {
  const list = await people(orgId);
  const rows = db.team.members(ch.id);
  if (ch.private) return list.filter((p) => rows.some((m) => m.userId === p.userId && !m.left));
  return list.filter((p) => !rows.some((m) => m.userId === p.userId && m.left));
}

const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

export async function createChannel(orgId: number, me: Me, input: { name: string; purpose: string; private: boolean; memberIds: number[]; aiAllowed: boolean }) {
  const name = slug(input.name);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the channel a name: lowercase letters, numbers and hyphens." });
  ensureGeneral(orgId);
  if (db.team.channels(orgId).some((c) => c.name === name && !c.archived)) throw new TRPCError({ code: "BAD_REQUEST", message: `There's already a #${name} channel.` });
  const ch = db.team.addChannel({ organizationId: orgId, name, purpose: input.purpose.trim().slice(0, 300), private: input.private, aiAllowed: input.aiAllowed, createdBy: me.id });
  const list = await people(orgId);
  const ids = Array.from(new Set([me.id, ...input.memberIds])).filter((id) => list.some((p) => p.userId === id));
  if (input.private) for (const id of ids) db.team.setMember(orgId, ch.id, id, { notify: "all" });
  db.team.send({ organizationId: orgId, channel: ch.key, userId: me.id, authorName: me.name, content: input.purpose.trim() ? `${me.name} made this channel for: ${input.purpose.trim()}` : `${me.name} made this channel.` });
  return ch;
}

export async function updateChannel(orgId: number, me: Me, id: number, patch: { name?: string; purpose?: string; aiAllowed?: boolean; private?: boolean }) {
  const ch = db.team.channel(orgId, id);
  if (!ch || !canSee(ch, me.id)) throw new TRPCError({ code: "NOT_FOUND", message: "That channel isn't in this workspace." });
  if (ch.createdBy !== me.id && !(await isAdmin(orgId, me.id))) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who made the channel, or an admin, can change it." });
  const next: Partial<db.TeamChannelRow> = {};
  if (patch.name != null && ch.key !== EVERYONE) {
    const name = slug(patch.name);
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the channel a name: lowercase letters, numbers and hyphens." });
    if (db.team.channels(orgId).some((c) => c.id !== id && c.name === name && !c.archived)) throw new TRPCError({ code: "BAD_REQUEST", message: `There's already a #${name} channel.` });
    next.name = name;
  }
  if (patch.purpose != null) next.purpose = patch.purpose.trim().slice(0, 300);
  if (patch.aiAllowed != null) next.aiAllowed = patch.aiAllowed;
  if (patch.private != null && ch.key !== EVERYONE) {
    next.private = patch.private;
    // Going private keeps the people who are in it now.
    if (patch.private && !ch.private) for (const p of await channelPeople(orgId, ch)) db.team.setMember(orgId, ch.id, p.userId, {});
  }
  return db.team.updateChannel(orgId, id, next);
}

export async function archiveChannel(orgId: number, me: Me, id: number) {
  const ch = db.team.channel(orgId, id);
  if (!ch || ch.key === EVERYONE) throw new TRPCError({ code: "BAD_REQUEST", message: "The general channel stays." });
  if (ch.createdBy !== me.id && !(await isAdmin(orgId, me.id))) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who made the channel, or an admin, can archive it." });
  return db.team.updateChannel(orgId, id, { archived: true });
}

export async function addMembers(orgId: number, me: Me, id: number, userIds: number[]) {
  const ch = db.team.channel(orgId, id);
  if (!ch || !canSee(ch, me.id)) throw new TRPCError({ code: "NOT_FOUND", message: "That channel isn't in this workspace." });
  const list = await people(orgId);
  const added: string[] = [];
  for (const uid of userIds) {
    const p = list.find((x) => x.userId === uid);
    if (!p) continue;
    db.team.setMember(orgId, ch.id, uid, { left: false });
    added.push(p.name || p.email);
  }
  if (added.length) db.team.send({ organizationId: orgId, channel: ch.key, userId: me.id, authorName: me.name, content: `${me.name} added ${added.join(", ")}.` });
  return { added };
}

export async function leaveChannel(orgId: number, me: Me, id: number) {
  const ch = db.team.channel(orgId, id);
  if (!ch) throw new TRPCError({ code: "NOT_FOUND", message: "That channel isn't in this workspace." });
  if (ch.key === EVERYONE) throw new TRPCError({ code: "BAD_REQUEST", message: "Everyone stays in general." });
  db.team.setMember(orgId, ch.id, me.id, { left: true });
  return { ok: true };
}

export async function joinChannel(orgId: number, me: Me, id: number) {
  const ch = db.team.channel(orgId, id);
  if (!ch || ch.archived || ch.private) throw new TRPCError({ code: "NOT_FOUND", message: "That channel isn't open to join." });
  db.team.setMember(orgId, ch.id, me.id, { left: false });
  return { ok: true };
}

export async function setNotify(orgId: number, me: Me, id: number, notifyMode: "all" | "mentions" | "none", muted: boolean) {
  const ch = db.team.channel(orgId, id);
  if (!ch || !canSee(ch, me.id)) throw new TRPCError({ code: "NOT_FOUND", message: "That channel isn't in this workspace." });
  db.team.setMember(orgId, ch.id, me.id, { notify: notifyMode, muted });
  return { ok: true };
}

/** Public channels the person could join (they left, or never looked). */
export function joinable(orgId: number, me: number) {
  return db.team.channels(orgId).filter((c) => !c.archived && !c.private && !canSee(c, me)).map((c) => ({ id: c.id, name: c.name, purpose: c.purpose }));
}

// ==========================================
// The list
// ==========================================

export async function channels(orgId: number, me: number) {
  markSeen(orgId, me);
  await repairStaff(orgId);
  const list = await people(orgId);
  const others = list.filter((p) => p.userId !== me);
  const rowOf = async (key: string) => {
    const orgs = await scopeOf(orgId, me, key);
    const last = db.team.last(orgs, key);
    const read = db.team.read(orgs, me, key);
    const u = db.team.unread(orgs, me, key, read?.lastReadId ?? 0);
    return { last: last ? { text: last.content || (last.attachments ? "Sent a file" : ""), author: last.authorName, mine: last.userId === me, at: last.createdAt } : null, unread: u.count, mentions: u.mentions };
  };
  const chans = [];
  for (const c of visibleChannels(orgId, me)) {
    const m = memberRow(c.id, me);
    chans.push({ key: c.key, id: c.id, kind: "channel" as const, name: c.name, private: c.private, muted: !!m?.muted, notify: m?.notify ?? "all", ...(await rowOf(c.key)) });
  }
  const dms = [];
  for (const p of others) {
    const key = dmKey(me, p.userId);
    dms.push({ key, kind: "dm" as const, name: p.name || p.email, sub: ROLE[p.role] ?? p.role, userId: p.userId, avatarUrl: p.avatarUrl, online: isOnline(orgId, p.userId), ...(await rowOf(key)) });
  }
  const unread = chans.filter((c) => !c.muted).reduce((n, c) => n + c.unread, 0) + dms.reduce((n, c) => n + c.unread, 0);
  const mentions = chans.reduce((n, c) => n + c.mentions, 0);
  return { channels: chans, dms, counts: { unread, mentions, saved: db.team.saved(orgId, me).length }, joinable: joinable(orgId, me), admin: await isAdmin(orgId, me) };
}

// ==========================================
// Messages
// ==========================================

type Mentions = { users: number[]; employees: number[] };

/** @Name in the text, matched against the people and AI employees who can be mentioned. */
export function findMentions(text: string, who: { users: { id: number; name: string }[]; employees: { id: number; name: string }[] }): Mentions {
  const lower = text.toLowerCase();
  const hit = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    let i = lower.indexOf(`@${n}`);
    while (i >= 0) {
      const after = lower[i + 1 + n.length];
      if (!after || !/[a-z0-9]/.test(after)) return true;
      i = lower.indexOf(`@${n}`, i + 1);
    }
    return false;
  };
  const users = who.users.filter((u) => hit(u.name) || hit(u.name.split(" ")[0])).map((u) => u.id);
  const employees = who.employees.filter((e) => hit(e.name)).map((e) => e.id);
  return { users: Array.from(new Set(users)), employees: Array.from(new Set(employees)) };
}

function parseMentions(raw: string | null): Mentions {
  if (!raw) return { users: [], employees: [] };
  try {
    const m = JSON.parse(raw);
    return { users: m.users ?? [], employees: m.employees ?? [] };
  } catch {
    return { users: [], employees: [] };
  }
}

async function employeesFor(orgId: number) {
  return (await db.listEmployeesByOrg(orgId)).map((e) => ({ id: e.id, name: e.name, roleTitle: e.roleTitle, kind: e.kind, avatar: e.avatar ?? null, status: e.status }));
}

/** A message as the screen shows it: reactions grouped, thread summary, pinned and saved flags. */
function shape(rows: db.TeamMessageRow[], me: number, orgs: number | number[]) {
  const ids = rows.map((r) => r.id);
  const reactions = db.team.reactions(ids);
  const threads = db.team.threadInfo(orgs, ids);
  const saved = db.team.savedIds(me, ids);
  // Link cards: what each link's site said, less the ones someone hid under that message.
  const allUrls = new Set<string>();
  for (const m of rows) if (!m.deletedAt) for (const u of links.urlsIn(m.content)) allUrls.add(u);
  const previews = links.previewsFor(Array.from(allUrls));
  const hidden = (m: db.TeamMessageRow): string[] => {
    try {
      return m.hiddenPreviews ? (JSON.parse(m.hiddenPreviews) as string[]) : [];
    } catch {
      return [];
    }
  };
  return rows.map((m) => {
    const mine = reactions.filter((r) => r.messageId === m.id);
    const grouped = new Map<string, { emoji: string; count: number; me: boolean; names: string[] }>();
    for (const r of mine) {
      const g = grouped.get(r.emoji) ?? { emoji: r.emoji, count: 0, me: false, names: [] };
      g.count += 1;
      if (r.userId === me) g.me = true;
      if (r.authorName) g.names.push(r.authorName);
      grouped.set(r.emoji, g);
    }
    const t = threads.get(m.id);
    return {
      id: m.id,
      channel: m.channel,
      userId: m.userId,
      employeeId: m.employeeId,
      authorName: m.authorName,
      content: m.deletedAt ? "" : m.content,
      attachments: m.deletedAt ? null : m.attachments,
      threadOf: m.threadOf,
      mentions: parseMentions(m.mentions),
      editedAt: m.editedAt,
      deleted: !!m.deletedAt,
      pinned: !!m.pinnedAt,
      saved: saved.has(m.id),
      reactions: Array.from(grouped.values()),
      thread: t ? { count: t.count, lastAt: t.lastAt, who: t.who } : null,
      previews: m.deletedAt ? [] : links.urlsIn(m.content).filter((u) => !hidden(m).includes(u)).map((u) => previews.get(u)).filter((p): p is links.Preview => !!p),
      createdAt: m.createdAt,
    };
  });
}
export type ShapedMessage = ReturnType<typeof shape>[number];

export async function messages(orgId: number, me: number, key: string) {
  markSeen(orgId, me);
  await repairStaff(orgId);
  const where = await channelFor(orgId, me, key);
  const list = await people(orgId);
  const orgs = await scopeOf(orgId, me, key);
  const rows = db.team.messages(orgs, key);
  const read = db.team.read(orgs, me, key);
  // "Seen": the other person has read past my last message.
  let seenAt: Date | null = null;
  if (where.other) {
    const mineLast = [...rows].reverse().find((m) => m.userId === me);
    const theirs = db.team.read(orgs, where.other.userId, key);
    if (mineLast && theirs && theirs.lastReadId >= mineLast.id) seenAt = theirs.readAt ?? null;
  }
  const ch = where.channel;
  const members = ch ? await channelPeople(orgId, ch) : [];
  const m = ch ? memberRow(ch.id, me) : null;
  return {
    channel: key,
    kind: where.kind,
    id: ch?.id ?? null,
    title: where.other ? where.other.name || where.other.email : ch!.name,
    sub: where.other ? `${ROLE[where.other.role] ?? where.other.role}${isOnline(orgId, where.other.userId) ? " · online now" : ""}` : ch!.purpose,
    private: ch?.private ?? false,
    aiAllowed: ch?.aiAllowed ?? false,
    general: ch?.key === EVERYONE,
    createdBy: ch?.createdBy ?? null,
    notify: m?.notify ?? "all",
    muted: !!m?.muted,
    online: where.other ? isOnline(orgId, where.other.userId) : false,
    memberCount: ch ? members.length : 2,
    members: members.slice(0, 6).map((p) => ({ userId: p.userId, name: p.name || p.email, avatarUrl: p.avatarUrl })),
    pinnedCount: ch ? db.team.pinned(orgs, key).length : 0,
    people: list.map((p) => ({ userId: p.userId, name: p.name || p.email, avatarUrl: p.avatarUrl })),
    employees: ch?.aiAllowed && !(await chatOnly(orgId, me)) ? await employeesFor(orgId) : [],
    lastReadId: read?.lastReadId ?? 0,
    messages: shape(rows, me, orgs),
    seenAt,
  };
}

export async function thread(orgId: number, me: number, parentId: number) {
  const parent = db.team.get(await orgsOfMessage(orgId, me, parentId), parentId);
  if (!parent) throw new TRPCError({ code: "NOT_FOUND", message: "That message is gone." });
  await channelFor(orgId, me, parent.channel);
  const orgs = await scopeOf(orgId, me, parent.channel);
  const replies = db.team.replies(orgs, parentId);
  const [p] = shape([parent], me, orgs);
  return { parent: p, replies: shape(replies, me, orgs), channelName: await nameOf(orgId, me, parent.channel) };
}

async function nameOf(orgId: number, me: number, key: string) {
  const other = dmOther(key, me);
  if (other != null) {
    const p = (await people(orgId)).find((x) => x.userId === other);
    return p ? p.name || p.email : "Direct message";
  }
  return db.team.channelByKey(orgId, key)?.name ?? key;
}

/** The workspaces a message could live in: this one, or the shared ones for a DM. */
async function orgsOfMessage(orgId: number, me: number, id: number) {
  const here = db.team.get(orgId, id);
  if (here) return orgId;
  // A DM sent from another shared workspace.
  const list = await people(orgId);
  for (const p of list) if (p.userId !== me) {
    const orgs = await sharedOrgs(orgId, me, p.userId);
    if (db.team.get(orgs, id)) return orgs;
  }
  return orgId;
}

async function messageFor(orgId: number, me: number, id: number) {
  const orgs = await orgsOfMessage(orgId, me, id);
  const m = db.team.get(orgs, id);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That message is gone." });
  await channelFor(orgId, me, m.channel);
  return { m, orgs };
}

// The AI employees' answers run after the message is saved; tests wait on them.
const pending = new Set<Promise<unknown>>();
export async function settled() {
  await links.settled();
  await Promise.all(Array.from(pending));
}

export async function send(orgId: number, me: Me, key: string, content: string, attachmentIds: number[], opts: { threadOf?: number | null; alsoToChannel?: boolean } = {}) {
  await ensureOnTeam(orgId, me.id);
  const where = await channelFor(orgId, me.id, key);
  const text = content.trim().slice(0, 8000);
  const files = db.getChatFiles(orgId, attachmentIds.slice(0, 10)).filter((f) => f.employeeId === 0 && f.userId === me.id && f.messageId == null);
  if (!text && !files.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a message or attach a file." });
  const orgs = await scopeOf(orgId, me.id, key);
  let parent: db.TeamMessageRow | null = null;
  if (opts.threadOf) {
    parent = db.team.get(orgs, opts.threadOf);
    if (!parent || parent.channel !== key) throw new TRPCError({ code: "NOT_FOUND", message: "That thread is gone." });
    if (parent.threadOf) parent = db.team.get(orgs, parent.threadOf) ?? parent;
  }
  const list = await people(orgId);
  const emps = where.channel?.aiAllowed && !(await chatOnly(orgId, me.id)) ? await employeesFor(orgId) : [];
  const mentions = findMentions(text, { users: list.map((p) => ({ id: p.userId, name: p.name || p.email })), employees: emps.filter((e) => e.status !== "paused") });
  const attachments = files.length ? JSON.stringify(files.map((f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, url: f.fileUrl }))) : null;
  const row = { organizationId: orgId, channel: key, userId: me.id, authorName: me.name, content: text, attachments, mentions: mentions.users.length || mentions.employees.length ? JSON.stringify(mentions) : null };
  const msg = db.team.send({ ...row, threadOf: parent?.id ?? null });
  if (parent && opts.alsoToChannel) db.team.send(row);
  links.want(text);
  if (files.length) db.attachChatFiles(orgId, files.map((f) => f.id), -msg.id);
  db.team.markRead(orgId, me.id, key, parent ? db.team.last(orgs, key)?.id ?? msg.id : msg.id);
  markSeen(orgId, me.id);

  // Who hears about it: a DM's other person; a channel's people by their settings; a thread's people.
  const chName = where.channel ? `#${where.channel.name}` : "";
  let to: number[] = [];
  if (where.other) to = [where.other.userId];
  else if (parent) {
    const inThread = new Set<number>([parent.userId, ...db.team.replies(orgs, parent.id).map((r) => r.userId)]);
    to = Array.from(inThread).filter((id) => id > 0);
    for (const id of mentions.users) to.push(id);
  } else {
    const rows = db.team.members(where.channel!.id);
    for (const p of await channelPeople(orgId, where.channel!)) {
      const r = rows.find((x) => x.userId === p.userId);
      if (r?.muted || r?.notify === "none") continue;
      if (r?.notify === "mentions" && !mentions.users.includes(p.userId)) continue;
      to.push(p.userId);
    }
  }
  to = Array.from(new Set(to)).filter((id) => id !== me.id);
  if (to.length) {
    const title = where.other ? me.name : parent ? `${me.name} in a thread in ${chName}` : `${me.name} in ${chName}`;
    const url = parent ? `/chats/team/${key}?thread=${parent.id}` : `/chats/team/${key}`;
    await notify(orgId, "team_message", { title, body: text || "Sent a file", url, tag: `team-${key}` }, { only: to }).catch(() => null);
  }

  // An AI employee mentioned here answers in the thread.
  if (where.channel && mentions.employees.length) {
    const p = answerMentions(orgId, me, where.channel, parent ?? msg, text, mentions.employees.slice(0, 2)).catch((err) => console.warn("[team] AI answer failed:", err instanceof Error ? err.message : err));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  return msg;
}

async function answerMentions(orgId: number, me: Me, ch: db.TeamChannelRow, parent: db.TeamMessageRow, text: string, employeeIds: number[]) {
  const { sendChatMessage } = await import("./employees/chat");
  for (const employeeId of employeeIds) {
    const emp = await db.getEmployeeForOrg(employeeId, orgId);
    if (!emp) continue;
    const r = await sendChatMessage({ organizationId: orgId, employeeId, text: `(In the team channel #${ch.name}) ${text}`, authorName: me.name, userId: me.id });
    const content = r.reply.content.trim();
    if (!content) continue;
    const reply = db.team.send({ organizationId: orgId, channel: ch.key, userId: 0, employeeId, authorName: emp.name, content, threadOf: parent.id });
    await notify(orgId, "team_message", { title: `${emp.name} answered in #${ch.name}`, body: content, url: `/chats/team/${ch.key}?thread=${parent.id}`, tag: `team-${ch.key}` }, { only: [me.id] }).catch(() => null);
    void reply;
  }
}

export async function edit(orgId: number, me: Me, id: number, content: string) {
  const { m } = await messageFor(orgId, me.id, id);
  if (m.userId !== me.id) throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own messages." });
  const text = content.trim().slice(0, 8000);
  if (!text && !m.attachments) throw new TRPCError({ code: "BAD_REQUEST", message: "Write something, or delete the message instead." });
  links.want(text);
  return db.team.update(id, { content: text, editedAt: new Date() });
}

/** Hides a link's card under a message for everyone who sees it; the link itself stays. */
export async function hidePreview(orgId: number, me: Me, id: number, url: string) {
  const { m } = await messageFor(orgId, me.id, id);
  const have = (() => {
    try {
      return m.hiddenPreviews ? (JSON.parse(m.hiddenPreviews) as string[]) : [];
    } catch {
      return [];
    }
  })();
  if (!have.includes(url)) have.push(url);
  db.team.update(id, { hiddenPreviews: JSON.stringify(have) });
  return { ok: true };
}

export async function remove(orgId: number, me: Me, id: number) {
  const { m } = await messageFor(orgId, me.id, id);
  if (m.userId !== me.id && !(await isAdmin(orgId, me.id))) throw new TRPCError({ code: "FORBIDDEN", message: "You can delete your own messages; an admin can delete any." });
  return db.team.update(id, { content: "", attachments: null, deletedAt: new Date(), pinnedAt: null, pinnedBy: null });
}

export async function react(orgId: number, me: Me, id: number, emoji: string) {
  await messageFor(orgId, me.id, id);
  const e = emoji.trim().slice(0, 16);
  if (!e) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick an emoji." });
  return { on: db.team.toggleReaction(orgId, id, me.id, e, me.name) };
}

export async function pin(orgId: number, me: Me, id: number) {
  const { m } = await messageFor(orgId, me.id, id);
  const on = !m.pinnedAt;
  db.team.update(id, on ? { pinnedAt: new Date(), pinnedBy: me.id } : { pinnedAt: null, pinnedBy: null });
  return { on };
}

export async function save(orgId: number, me: Me, id: number) {
  await messageFor(orgId, me.id, id);
  return { on: db.team.toggleSaved(orgId, me.id, id) };
}

export function markRead(orgId: number, me: number, channel: string, lastId: number) {
  db.team.markRead(orgId, me, channel, lastId);
  markSeen(orgId, me);
}

// ==========================================
// Channel details, search, and the Unreads, Mentions and Saved views
// ==========================================

type Att = { id?: number; name: string; size?: number; kind?: string; url?: string | null };
const atts = (raw: string | null): Att[] => {
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
};

export async function details(orgId: number, me: number, key: string) {
  const where = await channelFor(orgId, me, key);
  const orgs = await scopeOf(orgId, me, key);
  const list = await people(orgId);
  const ch = where.channel;
  const members = ch ? await channelPeople(orgId, ch) : list.filter((p) => p.userId === me || p.userId === where.other!.userId);
  const rows = ch ? db.team.members(ch.id) : [];
  const all = db.team.all(orgs, key).filter((m) => !m.deletedAt);
  const files = all
    .flatMap((m) => atts(m.attachments).map((a) => ({ ...a, messageId: m.id, by: m.authorName, at: m.createdAt })))
    .reverse()
    .slice(0, 40);
  const pinned = shape(db.team.pinned(orgs, key), me, orgs);
  const mine = ch ? memberRow(ch.id, me) : null;
  return {
    key,
    kind: where.kind,
    id: ch?.id ?? null,
    name: ch ? ch.name : where.other!.name || where.other!.email,
    purpose: ch?.purpose ?? "",
    private: ch?.private ?? false,
    aiAllowed: ch?.aiAllowed ?? false,
    general: ch?.key === EVERYONE,
    canEdit: !!ch && (ch.createdBy === me || (await isAdmin(orgId, me))),
    notify: mine?.notify ?? "all",
    muted: !!mine?.muted,
    members: members.map((p) => ({ userId: p.userId, name: p.name || p.email, avatarUrl: p.avatarUrl, role: ROLE[p.role] ?? p.role, online: isOnline(orgId, p.userId), notify: rows.find((r) => r.userId === p.userId)?.notify ?? "all" })),
    notIn: ch ? list.filter((p) => !members.some((m) => m.userId === p.userId)).map((p) => ({ userId: p.userId, name: p.name || p.email })) : [],
    pinned,
    files,
  };
}

/** Everything the person can read: their channels and their DMs. */
async function readable(orgId: number, me: number) {
  const chans = visibleChannels(orgId, me).map((c) => c.key);
  const dms = (await people(orgId)).filter((p) => p.userId !== me).map((p) => dmKey(me, p.userId));
  return { chans, dms };
}

async function withNames(orgId: number, me: number, rows: db.TeamMessageRow[]) {
  const orgs = Array.from(new Set([orgId, ...rows.map((r) => r.organizationId)]));
  const names = new Map<string, string>();
  for (const key of Array.from(new Set(rows.map((r) => r.channel)))) names.set(key, await nameOf(orgId, me, key));
  return shape(rows, me, orgs).map((m) => ({ ...m, channelName: names.get(m.channel) ?? m.channel, dm: m.channel.startsWith("dm:") }));
}

export async function search(orgId: number, me: number, q: string, opts: { from?: number | null; in?: string | null; files?: boolean; days?: number | null }) {
  const { chans, dms } = await readable(orgId, me);
  const keys = opts.in ? [opts.in].filter((k) => chans.includes(k) || dms.includes(k)) : [...chans, ...dms];
  const since = opts.days ? new Date(Date.now() - opts.days * 86_400_000) : null;
  const text = q.trim().slice(0, 200);
  if (!text && !opts.files && !opts.from) return { hits: [] };
  const rows = db.team.search(orgId, keys, text, { from: opts.from ?? undefined, files: opts.files, since });
  // DMs from other shared workspaces too.
  const extra: db.TeamMessageRow[] = [];
  for (const key of keys.filter((k) => k.startsWith("dm:"))) {
    const orgs = await scopeOf(orgId, me, key);
    if (Array.isArray(orgs) && orgs.length > 1) extra.push(...db.team.search(orgs.filter((o) => o !== orgId), [key], text, { from: opts.from ?? undefined, files: opts.files, since }));
  }
  const all = [...rows, ...extra].sort((a, b) => b.id - a.id).slice(0, 60);
  return { hits: await withNames(orgId, me, all) };
}

/** Unreads: every message after the person's last read, by channel. */
export async function unreads(orgId: number, me: number) {
  const { chans, dms } = await readable(orgId, me);
  const out: { channel: string; channelName: string; dm: boolean; messages: ShapedMessage[] }[] = [];
  for (const key of [...chans, ...dms]) {
    const orgs = await scopeOf(orgId, me, key);
    const read = db.team.read(orgs, me, key);
    const u = db.team.unread(orgs, me, key, read?.lastReadId ?? 0);
    if (!u.ids.length) continue;
    const rows = u.ids.map((id) => db.team.get(orgs, id)).filter((m): m is db.TeamMessageRow => !!m && !m.threadOf);
    if (!rows.length) continue;
    out.push({ channel: key, channelName: await nameOf(orgId, me, key), dm: key.startsWith("dm:"), messages: shape(rows, me, orgs) });
  }
  return out;
}

export async function mentions(orgId: number, me: number) {
  const { chans } = await readable(orgId, me);
  return withNames(orgId, me, db.team.mentionsOf(orgId, chans, me));
}

export async function saved(orgId: number, me: number) {
  const ids = db.team.saved(orgId, me).map((s) => s.messageId);
  const rows: db.TeamMessageRow[] = [];
  for (const id of ids) {
    const orgs = await orgsOfMessage(orgId, me, id);
    const m = db.team.get(orgs, id);
    if (m && !m.deletedAt) rows.push(m);
  }
  const { chans, dms } = await readable(orgId, me);
  const ok = rows.filter((m) => chans.includes(m.channel) || dms.includes(m.channel));
  return withNames(orgId, me, ok);
}
