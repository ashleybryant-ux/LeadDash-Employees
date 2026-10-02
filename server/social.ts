import { TRPCError } from "@trpc/server";
import * as db from "./db";
import type { OutboundItem } from "../drizzle/schema";
import * as integrations from "./integrations";
import { hasVideo, isChannel, itemMeta, postChannels, postProblems, postSpec, type MediaMeta, type SocialChannel, type TikTokSettings, DEFAULT_TIKTOK } from "@shared/post-model";
import { partsIn, zonedToUtc } from "./employees/schedule";
import { writeSocialBatch } from "./employees/tasks";

/**
 * Sienna's planner: saving posts from the editor, putting them on the
 * calendar, suggesting times, the "schedule the next 12" plan, and posting
 * approved posts when their time comes.
 */

const NAME: Record<SocialChannel, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", threads: "Threads", x: "X", linkedin: "LinkedIn", google_business: "Google Business Profile" };
export const channelName = (c: string) => NAME[c as SocialChannel] ?? c;

async function tzOf(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "10/06/2026" and "11:30 AM" in the workspace's time zone. */
export function localParts(at: Date, tz: string) {
  const p = partsIn(at, tz);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return { date: `${p2(p.m)}/${p2(p.d)}/${p.y}`, time: `${h12}:${p2(p.mi)} ${p.h >= 12 ? "PM" : "AM"}`, wd: p.wd, y: p.y, m: p.m, d: p.d, h: p.h, mi: p.mi };
}

/** "10/06/2026" + "11:30 AM" (in tz) to the real moment, or null when either is not readable. */
export function parseLocal(date: string, time: string, tz: string): Date | null {
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  const tm = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
  if (!dm || !tm) return null;
  const [m, d, y] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  let h = Number(tm[1]);
  const mi = Number(tm[2]);
  if (h < 1 || h > 12 || mi > 59) return null;
  if (/pm/i.test(tm[3]) && h < 12) h += 12;
  if (/am/i.test(tm[3]) && h === 12) h = 0;
  return zonedToUtc(y, m, d, h, mi, tz);
}

// ==========================================
// Best times
// ==========================================

export type Pattern = { days: number[]; h: number; mi: number };

export const PATTERNS: Record<string, Pattern> = {
  tue_thu_1130: { days: [2, 4], h: 11, mi: 30 },
  tue_wed_0900: { days: [2, 3], h: 9, mi: 0 },
  mon_wed_fri_0900: { days: [1, 3, 5], h: 9, mi: 0 },
  weekdays_1200: { days: [1, 2, 3, 4, 5], h: 12, mi: 0 },
  tue_thu_1830: { days: [2, 4], h: 18, mi: 30 },
};

const DAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function joinAnd(list: string[]) {
  return list.length <= 1 ? list[0] ?? "" : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function clock(h: number, mi: number) {
  return `${h % 12 === 0 ? 12 : h % 12}:${p2(mi)} ${h >= 12 ? "PM" : "AM"}`;
}

export function patternLabel(p: Pattern) {
  const days = p.days.length === 5 && p.days.every((d, i) => d === i + 1) ? "Every weekday" : joinAnd(p.days.map((d) => DAY_PLURAL[d]));
  return `${days} at ${clock(p.h, p.mi)}`;
}

export const PATTERN_CHOICES = Object.entries(PATTERNS).map(([key, p]) => ({ key, label: patternLabel(p) }));

function defaultPatternKey(channel: SocialChannel, type: "post" | "reel") {
  if (type === "reel" || channel === "tiktok") return "tue_thu_1830";
  if (channel === "linkedin") return "tue_wed_0900";
  if (channel === "x") return "weekdays_1200";
  return "tue_thu_1130";
}

/** Which account decides the time when a post goes to several. */
export function primaryChannel(channels: SocialChannel[]): SocialChannel {
  const order: SocialChannel[] = ["facebook", "instagram", "tiktok", "threads", "linkedin", "x", "google_business"];
  return order.find((c) => channels.includes(c)) ?? "facebook";
}

/**
 * The best days and time for an account. Facebook uses the Page's own
 * reactions, comments and shares once it has at least 10 posts; everything
 * else starts from common defaults, and says so.
 */
export async function bestPattern(orgId: number, channel: SocialChannel, type: "post" | "reel") {
  const fallbackKey = defaultPatternKey(channel, type);
  const fallback = { key: fallbackKey, pattern: PATTERNS[fallbackKey], fromData: false, reason: `That is a general starting point for ${type === "reel" && channel !== "tiktok" ? `${channelName(channel)} Reels` : channelName(channel)}.${channel === "facebook" ? " Once your page has more posts, I'll use your own numbers." : ""}` };
  if (channel !== "facebook" || type !== "post") return fallback;
  const history = await integrations.facebookHistory(orgId);
  if (history.length < 10) return fallback;
  const tz = await tzOf(orgId);
  const byDay = new Map<number, number[]>();
  const byHour = new Map<number, number[]>();
  for (const x of history) {
    const p = partsIn(x.at, tz);
    byDay.set(p.wd, [...(byDay.get(p.wd) ?? []), x.score]);
    byHour.set(p.h, [...(byHour.get(p.h) ?? []), x.score]);
  }
  const avg = (l: number[]) => l.reduce((a, b) => a + b, 0) / l.length;
  const days = Array.from(byDay.entries()).filter(([, l]) => l.length >= 2).sort((a, b) => avg(b[1]) - avg(a[1])).slice(0, 2).map(([d]) => d).sort((a, b) => a - b);
  const hour = Array.from(byHour.entries()).filter(([, l]) => l.length >= 2).sort((a, b) => avg(b[1]) - avg(a[1]))[0]?.[0];
  if (days.length < 2 || hour === undefined) return fallback;
  const pattern: Pattern = { days, h: hour, mi: 30 };
  const near = `${hour % 12 === 0 ? 12 : hour % 12} ${hour >= 12 ? "PM" : "AM"}`;
  return {
    key: "data",
    pattern,
    fromData: true,
    reason: `Your last ${history.length} Facebook posts got the most reactions, comments and shares on ${joinAnd(days.map((d) => DAY_PLURAL[d]))} around ${near}.`,
  };
}

/** Days (YYYYMMDD in tz) that already have a post planned for this account. */
async function takenDays(orgId: number, channel: SocialChannel, tz: string, skipIds: number[] = []) {
  const items = await db.listOutboundItemsByOrg(orgId, "social_post");
  const set = new Set<number>();
  for (const i of items) {
    if (!i.scheduledFor || skipIds.includes(i.id) || ["cancelled", "published"].includes(i.status)) continue;
    if (!postChannels(i).includes(channel)) continue;
    const p = partsIn(new Date(i.scheduledFor), tz);
    set.add(p.y * 10000 + p.m * 100 + p.d);
  }
  return set;
}

/** The next `count` times that match the pattern, skipping days already taken. */
export function nextSlots(pattern: Pattern, tz: string, after: Date, count: number, taken: Set<number>) {
  const out: Date[] = [];
  const start = partsIn(after, tz);
  for (let i = 0; i < 800 && out.length < count; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const [y, m, d, wd] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()];
    if (!pattern.days.includes(wd) || taken.has(y * 10000 + m * 100 + d)) continue;
    const at = zonedToUtc(y, m, d, pattern.h, pattern.mi, tz);
    if (at.getTime() > after.getTime() + 15 * 60_000) out.push(at);
  }
  return out;
}

/** Suggest time: the next good day and time for these accounts. */
export async function suggestTime(orgId: number, channels: SocialChannel[], type: "post" | "reel", itemId?: number) {
  const tz = await tzOf(orgId);
  const ch = primaryChannel(channels);
  const best = await bestPattern(orgId, ch, type);
  const taken = await takenDays(orgId, ch, tz, itemId ? [itemId] : []);
  const at = nextSlots(best.pattern, tz, new Date(), 1, taken)[0] ?? nextSlots(best.pattern, tz, new Date(), 1, new Set())[0];
  const l = localParts(at, tz);
  return { date: l.date, time: l.time, at: at.toISOString(), reason: best.reason };
}

// ==========================================
// Saving from the editor
// ==========================================

export type SaveInput = {
  itemId?: number;
  type: "post" | "reel";
  mode: "same" | "different";
  channels: string[];
  text: string;
  imageUrl: string | null;
  imageMeta: MediaMeta | null;
  variants: Record<string, { text: string; imageUrl: string | null; imageMeta?: MediaMeta | null }>;
  videoUrl: string | null;
  videoMeta: MediaMeta | null;
  coverUrl: string | null;
  coverMs: number;
  tiktok: TikTokSettings;
  date: string;
  time: string;
};

function bad(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Files must be ones stored for this workspace (or the one already on the post). */
function checkFile(orgId: number, url: string | null, existing: (string | null | undefined)[]) {
  if (!url) return null;
  if (existing.includes(url)) return url;
  if (!url.startsWith(`/files/org-${orgId}/`)) bad("That file is not in this workspace. Upload it again.");
  return url;
}

function titleFrom(text: string) {
  const first = text.trim().split(/\n|(?<=[.!?])\s/)[0] ?? "";
  const t = first.length > 70 ? `${first.slice(0, 67).replace(/\s+\S*$/, "")}...` : first;
  return t || "New post";
}

export async function savePost(orgId: number, input: SaveInput, who: string) {
  const tz = await tzOf(orgId);
  const existing = input.itemId ? await db.getOutboundItemForOrg(input.itemId, orgId) : null;
  if (input.itemId && (!existing || existing.kind !== "social_post")) throw new TRPCError({ code: "NOT_FOUND", message: "That post is not in this workspace." });
  if (existing?.status === "published") bad("This has already gone out.");
  const oldSpec = existing ? postSpec(existing) : null;
  const oldFiles = [existing?.imageUrl, oldSpec?.videoUrl, oldSpec?.coverUrl, ...Object.values(oldSpec?.variants ?? {}).map((v) => v?.imageUrl)];

  const channels = input.channels.map((c) => c.toLowerCase()).filter(isChannel);
  const variants: Record<string, { text: string; imageUrl: string | null; imageMeta: MediaMeta | null }> = {};
  if (input.mode === "different") {
    for (const c of channels) {
      const v = input.variants[c];
      if (v) variants[c] = { text: v.text, imageUrl: checkFile(orgId, v.imageUrl, oldFiles), imageMeta: v.imageMeta ?? null };
    }
  }

  let scheduledFor: Date | null = null;
  if (input.date.trim() || input.time.trim()) {
    scheduledFor = parseLocal(input.date, input.time, tz);
    if (!scheduledFor) bad("Type the date as MM/DD/YYYY and pick a time.");
    const same = existing?.scheduledFor && new Date(existing.scheduledFor).getTime() === scheduledFor.getTime();
    if (!same && scheduledFor.getTime() < Date.now() + 60_000) bad("Pick a time later than now.");
  }

  const meta = existing ? itemMeta(existing) : {};
  const post = {
    type: input.type,
    mode: input.mode,
    variants,
    imageMeta: input.imageMeta,
    videoUrl: checkFile(orgId, input.videoUrl, oldFiles),
    videoMeta: input.videoMeta,
    coverUrl: checkFile(orgId, input.coverUrl, oldFiles),
    coverMs: Math.max(0, Math.round(input.coverMs || 0)),
    tiktok: { ...DEFAULT_TIKTOK, ...input.tiktok },
  };
  const data = {
    body: input.text,
    imageUrl: checkFile(orgId, input.imageUrl, oldFiles),
    targetChannels: JSON.stringify(channels),
    scheduledFor,
    metadata: JSON.stringify({ ...meta, platforms: channels, xVersion: undefined, post }),
  };

  if (!existing) {
    const sienna = await db.getEmployeeByKind(orgId, "social");
    const created = await db.createOutboundItem({ organizationId: orgId, employeeId: sienna?.id ?? null, kind: "social_post", status: "pending_approval", title: titleFrom(input.text), ...data });
    await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: "Wrote social post", details: `"${created.title}" is waiting for approval.` });
    return created;
  }

  let status = existing.status;
  if (status === "scheduled" && !scheduledFor) status = "approved";
  if (status === "approved" && scheduledFor && !itemMeta(existing).postingSince) status = "scheduled";
  const next = { ...existing, ...data, status };
  if (status === "scheduled") {
    const problems = postProblems(next);
    if (problems.length) bad(`${problems.join(". ")}.`);
  }
  return db.updateOutboundItem(existing.id, orgId, { ...data, status, ...(existing.status === "changes_requested" ? { status: "pending_approval" as const } : {}) });
}

// ==========================================
// Calendar moves
// ==========================================

async function socialItem(orgId: number, id: number) {
  const item = await db.getOutboundItemForOrg(id, orgId);
  if (!item || item.kind !== "social_post") throw new TRPCError({ code: "NOT_FOUND", message: "That post is not in this workspace." });
  if (item.status === "published" || item.status === "cancelled") bad("That post can no longer be moved.");
  return item;
}

/** Puts a post on a day (dragged onto the calendar). Keeps its time of day, or uses the suggested time. */
export async function schedulePost(orgId: number, itemId: number, date: string, time: string | null, who: string) {
  const tz = await tzOf(orgId);
  const item = await socialItem(orgId, itemId);
  let t = time;
  if (!t) {
    if (item.scheduledFor) t = localParts(new Date(item.scheduledFor), tz).time;
    else {
      const best = await bestPattern(orgId, primaryChannel(postChannels(item)), postSpec(item).type);
      t = clock(best.pattern.h, best.pattern.mi);
    }
  }
  const at = parseLocal(date, t, tz);
  if (!at) bad("Type the date as MM/DD/YYYY.");
  if (at.getTime() < Date.now() + 60_000) bad("Pick a day and time later than now.");
  const status = item.status === "approved" && !itemMeta(item).postingSince ? "scheduled" : item.status;
  if (status === "scheduled") {
    const problems = postProblems(item);
    if (problems.length) bad(`${problems.join(". ")}.`);
  }
  const updated = await db.updateOutboundItem(item.id, orgId, { scheduledFor: at, status });
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: "Scheduled post", details: `"${item.title}" for ${date} at ${t}${status === "scheduled" ? "" : " (posts once approved)"}.` });
  return updated;
}

export async function unschedulePost(orgId: number, itemId: number) {
  const item = await socialItem(orgId, itemId);
  return db.updateOutboundItem(item.id, orgId, { scheduledFor: null, status: item.status === "scheduled" ? "approved" : item.status });
}

// ==========================================
// "Schedule the next 12 posts on Facebook"
// ==========================================

export type PlanRow = { itemId: number; title: string; at: string; date: string; time: string; needsApproval: boolean; imageUrl: string | null };
export type Plan = { channel: SocialChannel; account: string; patternKey: string; label: string; reason: string; rows: PlanRow[]; written: number; choices: { key: string; label: string }[] };

function isOpenDraft(i: OutboundItem) {
  const meta = itemMeta(i);
  if (i.status === "approved") return !meta.postingSince && !(Array.isArray(meta.dispatch) && meta.dispatch.length);
  return i.status === "pending_approval";
}

async function accountName(orgId: number, channel: SocialChannel) {
  const provider = channel === "instagram" ? "facebook" : channel;
  const conn = await db.getConnectionByProvider(orgId, provider as never);
  if (!conn || conn.status !== "connected") return "";
  const s = JSON.parse(conn.settings || "{}");
  if (channel === "facebook") return s.pageName ?? conn.accountLabel;
  if (channel === "instagram") return s.igUsername ? `@${s.igUsername}` : "";
  return conn.accountLabel ?? "";
}

/** Picks drafts for the account (approved first, oldest first), writes more if there are too few, and lays them on the best days. */
export async function planSchedule(orgId: number, channel: SocialChannel, count: number, opts: { patternKey?: string; itemIds?: number[]; writeMore?: boolean } = {}): Promise<Plan> {
  const tz = await tzOf(orgId);
  const n = Math.max(1, Math.min(30, Math.round(count)));
  const all = await db.listOutboundItemsByOrg(orgId, "social_post");
  let drafts: OutboundItem[];
  let written = 0;
  if (opts.itemIds?.length) {
    drafts = opts.itemIds.map((id) => all.find((i) => i.id === id)).filter((i): i is OutboundItem => !!i && isOpenDraft(i));
  } else {
    drafts = all
      .filter((i) => isOpenDraft(i) && !i.scheduledFor && postChannels(i).includes(channel) && postProblems(i).length === 0)
      .sort((a, b) => (a.status === "approved" ? 0 : 1) - (b.status === "approved" ? 0 : 1) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, n);
    if (drafts.length < n && opts.writeMore !== false) {
      const avoid = all.filter((i) => i.status !== "cancelled").slice(0, 40).map((i) => i.title);
      const fresh = await writeSocialBatch(orgId, channel, n - drafts.length, avoid);
      written = fresh.length;
      drafts = [...drafts, ...fresh];
    }
  }
  const best = opts.patternKey && PATTERNS[opts.patternKey] ? { key: opts.patternKey, pattern: PATTERNS[opts.patternKey], reason: "" } : await bestPattern(orgId, channel, "post");
  const slots = nextSlots(best.pattern, tz, new Date(), drafts.length, await takenDays(orgId, channel, tz, drafts.map((d) => d.id)));
  const rows: PlanRow[] = drafts.slice(0, slots.length).map((d, i) => {
    const l = localParts(slots[i], tz);
    return { itemId: d.id, title: d.title, at: slots[i].toISOString(), date: l.date, time: l.time, needsApproval: d.status !== "approved", imageUrl: d.imageUrl };
  });
  return { channel, account: await accountName(orgId, channel), patternKey: best.key, label: patternLabel(best.pattern), reason: best.reason, rows, written, choices: PATTERN_CHOICES };
}

/** Schedule all: puts every row on the calendar. Approved posts become Scheduled; the rest post once approved. */
export async function applyPlan(orgId: number, rows: { itemId: number; at: string }[], who: string) {
  let scheduled = 0;
  let waiting = 0;
  for (const r of rows) {
    const item = await db.getOutboundItemForOrg(r.itemId, orgId);
    if (!item || item.kind !== "social_post" || !isOpenDraft(item)) continue;
    const at = new Date(r.at);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) continue;
    const ready = item.status === "approved" && postProblems(item).length === 0;
    await db.updateOutboundItem(item.id, orgId, { scheduledFor: at, status: ready ? "scheduled" : item.status });
    if (ready) scheduled++;
    else waiting++;
  }
  if (scheduled + waiting) await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: "Scheduled posts", details: `${scheduled + waiting} posts put on the calendar${waiting ? `; ${waiting} post once approved` : ""}.` });
  return { scheduled, waiting };
}

// ==========================================
// Posting (now, on approval, or when the scheduled time comes)
// ==========================================

const posting = new Set<number>();

async function dispatchAndRecord(item: OutboundItem, actorName: string, actorType: "human_user" | "system", action: string, notes?: string) {
  posting.add(item.id);
  try {
    const { status, results } = await integrations.dispatch(item);
    const fresh = (await db.getOutboundItemForOrg(item.id, item.organizationId)) ?? item;
    const meta = itemMeta(fresh);
    delete meta.postingSince;
    const updated = await db.updateOutboundItem(item.id, item.organizationId, {
      status,
      reviewerNotes: notes ?? fresh.reviewerNotes ?? null,
      metadata: JSON.stringify({ ...meta, dispatch: results }),
      ...(status === "published" ? { publishedAt: new Date(), externalReference: results.find((r) => r.url)?.url ?? null } : {}),
    });
    const ok = results.filter((r) => r.ok).map((r) => integrations.channelLabel(r.channel));
    const failed = results.filter((r) => !r.ok).map((r) => `${integrations.channelLabel(r.channel)} (${r.error})`);
    await db.logAction({
      organizationId: item.organizationId,
      actorType,
      actorName,
      action,
      details: `"${item.title}". ${ok.length ? `Went out on ${ok.join(", ")}.` : ""}${failed.length ? ` Not sent: ${failed.join("; ")}.` : ""}${results.length === 0 ? "Held: nothing connected can send this yet." : ""}`.trim(),
    });
    return updated;
  } finally {
    posting.delete(item.id);
  }
}

/**
 * Sends an approved item now. Videos take minutes to upload and process, so
 * they go in the background and the item shows "Posting" until they finish.
 */
export async function postNow(item: OutboundItem, actorName: string, actorType: "human_user" | "system", action: string, extra: Partial<OutboundItem> = {}, notes?: string) {
  if (posting.has(item.id)) bad("This is already posting.");
  if (hasVideo(item)) {
    const meta = itemMeta(item);
    const marked = await db.updateOutboundItem(item.id, item.organizationId, { ...extra, status: "approved", metadata: JSON.stringify({ ...meta, postingSince: new Date().toISOString() }) });
    posting.add(item.id);
    void dispatchAndRecord(marked!, actorName, actorType, action, notes).catch((err) => {
      posting.delete(item.id);
      console.error("[social] background post failed:", err);
    });
    return marked;
  }
  if (Object.keys(extra).length) item = (await db.updateOutboundItem(item.id, item.organizationId, extra))!;
  return dispatchAndRecord(item, actorName, actorType, action, notes);
}

/** Runner tick: posts every scheduled item whose time has come. */
export async function postDue(now = new Date()) {
  const due = await db.dueScheduledPosts(now);
  for (const item of due) {
    if (posting.has(item.id)) continue;
    // Mark it first so the next tick never picks it up again.
    const meta = itemMeta(item);
    const marked = await db.updateOutboundItem(item.id, item.organizationId, { status: "approved", metadata: JSON.stringify({ ...meta, postingSince: new Date().toISOString() }) });
    posting.add(item.id);
    void dispatchAndRecord(marked!, "Scheduled post", "system", "Posted on schedule").catch((err) => {
      posting.delete(item.id);
      console.error("[social] scheduled post failed:", err);
    });
  }
  return due.length;
}

/** Test hook: waits until background posts finish. */
export async function settled() {
  for (let i = 0; i < 200 && posting.size; i++) await new Promise((r) => setTimeout(r, 10));
}
