import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { ENV } from "./_core/env";
import { EVERYONE, ensureGeneral, people as teamPeople, findMentions } from "./team";

/**
 * Import from Slack: the workspace export zip (Slack: Workspace settings,
 * Import/Export data, Export) read into team chat. Channels become channels
 * (general becomes this workspace's general), people match by email, and
 * messages keep their dates, @mentions, reactions, threads, pins and edits.
 * Files Slack hosted can't be pulled from the export, so they show by name.
 * Running the same export again updates messages instead of copying them.
 */

type SlackUser = { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string; real_name?: string; display_name?: string } };
type SlackChannel = { id: string; name: string; is_archived?: boolean; is_general?: boolean; is_private?: boolean; purpose?: { value?: string }; topic?: { value?: string }; members?: string[] };
type SlackFile = { id?: string; name?: string; title?: string; size?: number; mimetype?: string; url_private?: string; permalink?: string; mode?: string };
type SlackMessage = {
  type?: string;
  subtype?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: { name: string; users?: string[]; count?: number }[];
  files?: SlackFile[];
  attachments?: { title?: string; title_link?: string; from_url?: string; original_url?: string }[];
  user_profile?: { real_name?: string; display_name?: string };
  edited?: { ts?: string };
  pinned_to?: string[];
  bot_id?: string;
  username?: string;
};

type Parsed = { users: SlackUser[]; channels: SlackChannel[]; messages: Map<string, SlackMessage[]> };

const KEEP = new Set(["", "thread_broadcast", "file_share", "me_message"]);

async function readZip(file: string): Promise<Parsed> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(file));
  const files = Object.values(zip.files).filter((f) => !f.dir);
  // The export may be nested one folder deep.
  const at = (name: string) => files.find((f) => f.name === name || f.name.endsWith(`/${name}`));
  const usersFile = at("users.json");
  const channelsFile = at("channels.json");
  if (!usersFile || !channelsFile) throw new Error("That zip isn't a Slack export: it has no channels.json and users.json. In Slack go to Workspace settings, Import/Export data, Export.");
  const base = usersFile.name.slice(0, usersFile.name.length - "users.json".length);
  const users = JSON.parse(await usersFile.async("string")) as SlackUser[];
  const channels = JSON.parse(await channelsFile.async("string")) as SlackChannel[];
  const messages = new Map<string, SlackMessage[]>();
  for (const f of files) {
    if (!f.name.startsWith(base)) continue;
    const rel = f.name.slice(base.length);
    const m = /^([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/.exec(rel);
    if (!m) continue;
    let rows: SlackMessage[] = [];
    try {
      rows = JSON.parse(await f.async("string"));
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    const list = messages.get(m[1]) ?? [];
    list.push(...rows.filter((r) => r && r.type === "message" && typeof r.ts === "string"));
    messages.set(m[1], list);
  }
  for (const list of Array.from(messages.values())) list.sort((a: SlackMessage, b: SlackMessage) => Number(a.ts) - Number(b.ts));
  return { users, channels, messages };
}

const EMOJI: Record<string, string> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", heart: "❤️", heavy_check_mark: "✅", white_check_mark: "✅", tada: "🎉", clap: "👏", raised_hands: "🙌", pray: "🙏", fire: "🔥",
  eyes: "👀", smile: "😊", grinning: "😀", joy: "😂", laughing: "😆", sob: "😭", cry: "😢", thinking_face: "🤔", 100: "💯", star: "⭐", sparkles: "✨", muscle: "💪", ok_hand: "👌",
  wave: "👋", rocket: "🚀", point_up: "☝️", pushpin: "📌", memo: "📝", calendar: "📅", bell: "🔔", heart_eyes: "😍", blush: "😊", wink: "😉", sunglasses: "😎", partying_face: "🥳",
  slightly_smiling_face: "🙂", upside_down_face: "🙃", confused: "😕", disappointed: "😞", scream: "😱", skull: "💀", hugging_face: "🤗", face_with_hand_over_mouth: "🤭", pleading_face: "🥺",
  purple_heart: "💜", blue_heart: "💙", green_heart: "💚", yellow_heart: "💛", black_heart: "🖤", orange_heart: "🧡", two_hearts: "💕", sparkling_heart: "💖", heavy_plus_sign: "➕", question: "❓",
  exclamation: "❗", warning: "⚠️", x: "❌", no_entry_sign: "🚫", hourglass: "⏳", alarm_clock: "⏰", coffee: "☕", cake: "🎂", gift: "🎁", balloon: "🎈", trophy: "🏆", medal: "🏅",
  dancer: "💃", man_dancing: "🕺", woman_raising_hand: "🙋‍♀️", raising_hand: "🙋", handshake: "🤝", saluting_face: "🫡", melting_face: "🫠", relieved: "😌", yum: "😋", star_struck: "🤩",
};

function emojiOf(name: string) {
  const base = name.replace(/::skin-tone-\d$/, "");
  return EMOJI[base] ?? `:${base}:`;
}

const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Slack's markup into ours: <@U..> to @Name, <#C..|name> to #name, links to plain links, *bold* to **bold**. */
function convertText(raw: string, nameOf: (uid: string) => string) {
  let t = raw ?? "";
  t = t.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, uid) => `@${nameOf(uid)}`);
  t = t.replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name) => `#${name}`);
  t = t.replace(/<!(channel|here|everyone)>/g, "@$1");
  t = t.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, label) => (label.trim() === url ? url : `${label.trim()} (${url})`));
  t = t.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  t = t.replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1");
  t = unescape(t);
  // *bold* in Slack is **bold** here; _italic_ and ~strike~ are the same.
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?;:)])/g, "$1**$2**");
  return t.trim();
}

function displayName(u: SlackUser | undefined, fallback = "Someone") {
  if (!u) return fallback;
  return (u.real_name || u.profile?.real_name || u.profile?.display_name || u.name || fallback).trim();
}

const keep = (m: SlackMessage) => KEEP.has(m.subtype ?? "") && !m.bot_id && (!!(m.text ?? "").trim() || !!m.files?.length);

// Uploaded exports waiting to be run, by token (in memory: an import is one sitting).
const holding = new Map<string, { orgId: number; file: string; name: string; at: number }>();

export function holdingPath(orgId: number) {
  const dir = path.join(path.dirname(path.resolve(ENV.databasePath)), "imports");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `slack-${orgId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
}

/** Keeps an uploaded export and reads it into a plan the person can adjust. */
export async function hold(orgId: number, name: string, file: string) {
  for (const [k, v] of Array.from(holding.entries())) if (Date.now() - v.at > 6 * 3_600_000) {
    holding.delete(k);
    fs.promises.unlink(v.file).catch(() => null);
  }
  const token = crypto.randomBytes(12).toString("hex");
  try {
    await readZip(file);
  } catch (err) {
    fs.promises.unlink(file).catch(() => null);
    throw err;
  }
  holding.set(token, { orgId, file, name, at: Date.now() });
  return { token, ...(await plan(orgId, token)) };
}

export async function plan(orgId: number, token: string) {
  const h = holding.get(token);
  if (!h || h.orgId !== orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Upload the export again; that one is no longer held." });
  const data = await readZip(h.file);
  const members = await teamPeople(orgId);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  ensureGeneral(orgId);
  const existing = db.team.channels(orgId);
  let messages = 0;
  let reactions = 0;
  let replies = 0;
  let files = 0;
  const counts = new Map<string, number>();
  const channels = data.channels.map((c) => {
    const rows = (data.messages.get(c.name) ?? []).filter(keep);
    messages += rows.length;
    for (const r of rows) {
      reactions += (r.reactions ?? []).reduce((n, x) => n + (x.count ?? x.users?.length ?? 0), 0);
      if (r.thread_ts && r.thread_ts !== r.ts) replies += 1;
      files += r.files?.length ?? 0;
      if (r.user) counts.set(r.user, (counts.get(r.user) ?? 0) + 1);
    }
    const general = !!c.is_general || c.name === "general";
    const have = general ? existing.find((e) => e.key === EVERYONE) : existing.find((e) => e.importedId === c.id) ?? existing.find((e) => e.name === c.name && !e.archived);
    return { id: c.id, name: c.name, messages: rows.length, archived: !!c.is_archived, general, private: !!c.is_private, members: c.members?.length ?? 0, purpose: c.purpose?.value ?? "", becomes: general ? "general" : have ? have.name : c.name, existing: !!have, take: !c.is_archived };
  });
  channels.sort((a, b) => Number(b.general) - Number(a.general) || Number(a.archived) - Number(b.archived) || b.messages - a.messages || a.name.localeCompare(b.name));
  const people = data.users
    .filter((u) => !u.is_bot && u.id !== "USLACKBOT")
    .map((u) => {
      const email = (u.profile?.email ?? "").toLowerCase();
      const match = email ? byEmail.get(email) : undefined;
      return { id: u.id, name: displayName(u), email: u.profile?.email ?? "", left: !!u.deleted, messages: counts.get(u.id) ?? 0, userId: match?.userId ?? null, matched: match ? "email" : u.deleted ? "left" : "none" };
    })
    .filter((p) => p.messages > 0 || !p.left)
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
  return {
    file: h.name,
    channels,
    people,
    members: members.map((m) => ({ userId: m.userId, name: m.name || m.email })),
    counts: { channels: data.channels.length, messages, reactions, replies, files, active: people.filter((p) => !p.left).length, left: data.users.filter((u) => u.deleted && !u.is_bot).length },
  };
}

type Pick = { id: string; take: boolean; name: string };
type PersonPick = { id: string; userId: number | null };

export async function run(orgId: number, me: { id: number; name: string }, token: string, picks: Pick[], personPicks: PersonPick[]) {
  const h = holding.get(token);
  if (!h || h.orgId !== orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Upload the export again; that one is no longer held." });
  const data = await readZip(h.file);
  const members = await teamPeople(orgId);
  const memberById = new Map(members.map((m) => [m.userId, m]));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m]));
  const users = new Map(data.users.map((u) => [u.id, u]));
  // Who each Slack person is here: the pick, else the email match, else nobody (name only).
  const userIdOf = (uid: string | undefined) => {
    if (!uid) return 0;
    const pick = personPicks.find((p) => p.id === uid);
    if (pick && pick.userId && memberById.has(pick.userId)) return pick.userId;
    const u = users.get(uid);
    const email = (u?.profile?.email ?? "").toLowerCase();
    return (email && byEmail.get(email)?.userId) || 0;
  };
  const nameOf = (uid: string) => {
    const id = userIdOf(uid);
    if (id) {
      const m = memberById.get(id)!;
      return m.name || m.email;
    }
    return displayName(users.get(uid), "someone");
  };
  const mentionable = { users: members.map((m) => ({ id: m.userId, name: m.name || m.email })), employees: [] as { id: number; name: string }[] };
  ensureGeneral(orgId);
  let made = 0;
  let added = 0;
  let updated = 0;
  let reactions = 0;
  let files = 0;
  const log: string[] = [];
  for (const c of data.channels) {
    const pick = picks.find((p) => p.id === c.id);
    if (!pick || !pick.take) continue;
    const general = !!c.is_general || c.name === "general";
    let ch: db.TeamChannelRow | null = general ? db.team.channelByKey(orgId, EVERYONE) : db.team.channelByImportedId(orgId, c.id);
    if (!ch && !general) {
      const name = (pick.name || c.name)
        .toLowerCase()
        .replace(/[\s_]+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 60) || c.name;
      ch = db.team.channels(orgId).find((e) => e.name === name && !e.archived) ?? null;
      if (ch) ch = db.team.updateChannel(orgId, ch.id, { importedId: c.id, purpose: ch.purpose || c.purpose?.value || "" });
      else {
        ch = db.team.addChannel({ organizationId: orgId, name, purpose: (c.purpose?.value ?? "").slice(0, 300), private: !!c.is_private, aiAllowed: true, createdBy: me.id, importedId: c.id });
        made += 1;
        if (c.is_private) {
          db.team.setMember(orgId, ch.id, me.id, {});
          for (const uid of c.members ?? []) {
            const id = userIdOf(uid);
            if (id) db.team.setMember(orgId, ch.id, id, {});
          }
        }
      }
    }
    if (!ch) continue;
    const rows = (data.messages.get(c.name) ?? []).filter(keep);
    const idOfTs = new Map<string, number>();
    let newest = 0;
    for (const r of rows) {
      const author = userIdOf(r.user);
      const authorName = r.user ? nameOf(r.user) : (r.username ?? r.user_profile?.real_name ?? "Someone");
      const content = convertText(r.text ?? "", nameOf);
      const parentTs = r.thread_ts && r.thread_ts !== r.ts ? r.thread_ts : null;
      const threadOf = parentTs ? idOfTs.get(parentTs) ?? db.team.byImportedId(orgId, ch.key, parentTs)?.id ?? null : null;
      const fileList = (r.files ?? [])
        .filter((f) => f.mode !== "tombstone" && f.mode !== "hidden_by_limit")
        .map((f) => ({ name: f.name || f.title || "file", size: f.size ?? 0, kind: /^image\//.test(f.mimetype ?? "") ? "image" : "document", url: null, note: "Stored in Slack" }));
      files += fileList.length;
      const mentions = findMentions(content, mentionable);
      const patch = {
        organizationId: orgId,
        channel: ch.key,
        userId: author,
        authorName,
        content,
        attachments: fileList.length ? JSON.stringify(fileList) : null,
        threadOf,
        mentions: mentions.users.length ? JSON.stringify(mentions) : null,
        editedAt: r.edited?.ts ? new Date(Number(r.edited.ts) * 1000) : null,
        pinnedAt: r.pinned_to?.length ? new Date(Number(r.ts) * 1000) : null,
        pinnedBy: r.pinned_to?.length ? me.id : null,
        importedId: r.ts,
        createdAt: new Date(Number(r.ts) * 1000),
      };
      const have = db.team.byImportedId(orgId, ch.key, r.ts);
      let msg: db.TeamMessageRow;
      if (have) {
        msg = db.team.update(have.id, { content, attachments: patch.attachments, threadOf: patch.threadOf ?? have.threadOf, mentions: patch.mentions, editedAt: patch.editedAt, pinnedAt: patch.pinnedAt, pinnedBy: patch.pinnedBy });
        updated += 1;
      } else {
        msg = db.team.send(patch);
        added += 1;
      }
      idOfTs.set(r.ts, msg.id);
      newest = Math.max(newest, msg.id);
      // Reactions by the people who gave them (name only when they left Slack).
      const existing = db.team.reactions([msg.id]);
      for (const rx of r.reactions ?? []) {
        const emoji = emojiOf(rx.name);
        for (const uid of rx.users ?? []) {
          const id = userIdOf(uid);
          const who = nameOf(uid);
          if (existing.some((e) => e.emoji === emoji && (id ? e.userId === id : e.authorName === who))) continue;
          db.team.toggleReaction(orgId, msg.id, id, emoji, who);
          reactions += 1;
        }
      }
    }
    // History isn't "unread": everyone starts caught up on what came over.
    if (newest) for (const m of members) if ((db.team.read(orgId, m.userId, ch.key)?.lastReadId ?? 0) < newest) db.team.markRead(orgId, m.userId, ch.key, newest);
    log.push(`#${ch.name}: ${rows.length} messages`);
  }
  holding.delete(token);
  fs.promises.unlink(h.file).catch(() => null);
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: me.name, action: "Imported Slack", details: `${added} messages added, ${updated} updated, ${made} channels made` });
  return { channelsMade: made, added, updated, reactions, files, log };
}

export const _test = { convertText, emojiOf, keep };
