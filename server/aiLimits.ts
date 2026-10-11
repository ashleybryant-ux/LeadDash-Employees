import { and, eq, gte, isNull, lt } from "drizzle-orm";
import * as db from "./db";
import { chatMessages, usageEvents } from "../drizzle/schema";
import { monthRange } from "./usage";
import { hoursNum, minutesByPerson } from "./workHours";

/**
 * Work-hour limits per person. Every job's work hours are saved with the
 * person whose request started it (scheduled work has no person). Each person
 * has a monthly limit in work hours: the workspace's, their own, or none.
 * Near the limit they get a heads-up; at the limit the employees stop starting
 * new work for them (or keep going and only tell the owner, if the workspace
 * chose that). AI costs from before per-person tracking began are matched
 * afterward to the chat message that started them and marked estimated.
 */

export type AiLimits = {
  /** The workspace limit in work-hour minutes a month; null means no limit. */
  defaultMinutes: number | null;
  /** Owners and admins have no limit. */
  ownersExempt: boolean;
  /** Heads-up at this share of the limit (80 or 90), or 0 for none. */
  warnPct: 0 | 80 | 90;
  /** At the limit: stop new work for that person, or keep working and only tell the owner. */
  atLimit: "stop" | "warn";
  /** Notices already sent this month, so each goes once: "userId:YYYY-MM:warn|reached". */
  sent?: string[];
  /** When old costs were matched to people. */
  backfilledAt?: string | null;
};

const DEFAULTS: AiLimits = { defaultMinutes: null, ownersExempt: true, warnPct: 80, atLimit: "stop", sent: [], backfilledAt: null };

export function readLimits(raw: string | null | undefined): AiLimits {
  try {
    const v = raw ? JSON.parse(raw) : {};
    // A limit saved in dollars before work hours: $1 of AI cost is about 3 work hours.
    const minutes = typeof v.defaultMinutes === "number" && v.defaultMinutes >= 0 ? Math.round(v.defaultMinutes) : v.defaultMinutes === undefined && typeof v.defaultMicros === "number" && v.defaultMicros >= 0 ? Math.round((v.defaultMicros * 180) / 1_000_000) : null;
    return {
      defaultMinutes: minutes,
      ownersExempt: v.ownersExempt !== false,
      warnPct: v.warnPct === 0 || v.warnPct === 90 ? v.warnPct : 80,
      atLimit: v.atLimit === "warn" ? "warn" : "stop",
      sent: Array.isArray(v.sent) ? v.sent.filter((x: unknown) => typeof x === "string").slice(-400) : [],
      backfilledAt: typeof v.backfilledAt === "string" ? v.backfilledAt : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function limitsFor(orgId: number) {
  return readLimits((await db.getOrganizationById(orgId))?.aiLimits);
}

export async function saveLimits(orgId: number, patch: Partial<AiLimits>) {
  const next = { ...(await limitsFor(orgId)), ...patch };
  await db.updateOrganization(orgId, { aiLimits: JSON.stringify(next) });
  return next;
}

export const dollars = (micros: number) => `$${(micros / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "12 work hours" or "12.5 work hours". */
export const workHours = (minutes: number) => `${hoursNum(minutes)} work hour${minutes === 60 ? "" : "s"}`;

async function month(orgId: number, back = 0) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const r = monthRange(tz, back);
  const nextStart = new Date(r.end);
  return { ...r, tz, key: r.start.toISOString().slice(0, 7), resetLabel: nextStart.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }) };
}

/** AI cost for each person this month (or last), plus scheduled work under the key 0. */
export async function costsByPerson(orgId: number, back = 0) {
  const { start, end } = await month(orgId, back);
  const rows = db
    .getDb()
    .select({ userId: usageEvents.userId, costMicros: usageEvents.costMicros, estimated: usageEvents.estimated })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, orgId), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)))
    .all();
  const by = new Map<number, { micros: number; estimatedMicros: number }>();
  for (const r of rows) {
    const k = r.userId ?? 0;
    const cur = by.get(k) ?? { micros: 0, estimatedMicros: 0 };
    cur.micros += r.costMicros;
    if (r.estimated) cur.estimatedMicros += r.costMicros;
    by.set(k, cur);
  }
  return by;
}

type Member = Awaited<ReturnType<typeof db.listMembers>>[number];

/** The limit that applies to one member, in work-hour minutes: their own, the workspace's, or none. */
export function limitOf(m: Pick<Member, "role" | "aiLimitMode" | "aiLimitMinutes">, s: AiLimits): { minutes: number | null; source: "own" | "workspace" | "none" | "exempt" | "chat" } {
  if (m.role === "chat") return { minutes: null, source: "chat" };
  if (m.aiLimitMode === "none") return { minutes: null, source: "none" };
  if (m.aiLimitMode === "custom" && typeof m.aiLimitMinutes === "number") return { minutes: m.aiLimitMinutes, source: "own" };
  if (s.ownersExempt && (m.role === "owner" || m.role === "admin")) return { minutes: null, source: "exempt" };
  return s.defaultMinutes == null ? { minutes: null, source: "none" } : { minutes: s.defaultMinutes, source: "workspace" };
}

/** Work-hour minutes each person used this month (or last), with scheduled work under the key 0. */
async function minutesByPersonNow(orgId: number, back = 0) {
  const { start, end } = await month(orgId, back);
  return minutesByPerson(orgId, start, end);
}

/** Where one person stands this month. Null for LeadDash staff and anyone not on the team. */
export async function personStatus(orgId: number, userId: number) {
  const user = (await db.getUsersByIds([userId]))[0];
  if (!user || user.role === "admin") return null;
  const m = (await db.listMembers(orgId)).find((x) => x.userId === userId);
  if (!m) return null;
  const s = await limitsFor(orgId);
  const lim = limitOf(m, s);
  const used = (await minutesByPersonNow(orgId)).get(userId) ?? 0;
  const pct = lim.minutes ? Math.round((used / lim.minutes) * 100) : 0;
  return { member: m, settings: s, used, limit: lim.minutes, source: lim.source, pct, reached: lim.minutes != null && used >= lim.minutes };
}

async function ownerIds(orgId: number) {
  return (await db.listMembers(orgId)).filter((m) => m.role === "owner").map((m) => m.userId);
}

export async function ownerFirstName(orgId: number) {
  const o = (await db.listMembers(orgId)).find((m) => m.role === "owner");
  return (o?.name?.trim().split(/\s+/)[0] || "the owner").replace(/^Dr\.?$/i, "the owner");
}

async function sendOnce(orgId: number, key: string, fn: () => Promise<unknown>) {
  const s = await limitsFor(orgId);
  if (s.sent?.includes(key)) return false;
  await saveLimits(orgId, { sent: [...(s.sent ?? []), key] });
  await fn().catch((err) => console.warn("[ai limits] notice failed:", err instanceof Error ? err.message : err));
  return true;
}

/**
 * Before an employee starts work for a person. Returns the reply to give
 * instead of working, or null to go ahead.
 */
export async function blockFor(orgId: number, userId: number | null | undefined, said: string) {
  if (!userId) return null;
  const st = await personStatus(orgId, userId);
  if (!st || !st.reached) return null;
  const { label, key, resetLabel } = await month(orgId);
  const name = st.member.name?.trim() || st.member.email;
  const owner = await ownerFirstName(orgId);
  // Over the limit with "keep working": tell the owners once, then go ahead.
  if (st.settings.atLimit === "warn") {
    await sendOnce(orgId, `${userId}:${key}:reached`, () => notifyOwners(orgId, `${name} reached their work-hour limit`, `${name} used ${hoursNum(st.used)} of ${workHours(st.limit!)} for ${label}. The employees keep working for them.`));
    return null;
  }
  if (/\bask\b.*\braise\b/i.test(said)) {
    await notifyOwners(orgId, `${name} asked for a higher work-hour limit`, `${name} used ${hoursNum(st.used)} of ${workHours(st.limit!)} for ${label}. You can raise it on the Team page.`);
    return { text: `I asked ${owner} to raise your limit. I'll pick this back up as soon as it's raised.`, choices: [] as string[] };
  }
  await sendOnce(orgId, `${userId}:${key}:reached`, () => notifyOwners(orgId, `${name} reached their work-hour limit`, `${name} used ${hoursNum(st.used)} of ${workHours(st.limit!)} for ${label}. The employees won't start new work for them until ${resetLabel} unless you raise it on the Team page.`));
  return {
    text: `You've used your ${workHours(st.limit!)} for ${label}, so I can't start new work for you until ${resetLabel}. ${owner === "the owner" ? "The owner" : owner} can raise your limit on the Team page.`,
    choices: [`Ask ${owner === "the owner" ? "the owner" : owner} to raise it`],
  };
}

/**
 * After work for a person: the heads-up line to show under the reply when this
 * work carried them past the heads-up point (or to the limit), or null.
 */
export async function noteAfter(orgId: number, userId: number | null | undefined, usedBefore: number) {
  if (!userId) return null;
  const st = await personStatus(orgId, userId);
  if (!st || st.limit == null || st.limit <= 0) return null;
  const { label, key } = await month(orgId);
  const warnAt = st.settings.warnPct ? (st.limit * st.settings.warnPct) / 100 : Infinity;
  const crossedWarn = usedBefore < warnAt && st.used >= warnAt;
  const crossedLimit = usedBefore < st.limit && st.used >= st.limit;
  if (!crossedWarn && !crossedLimit) return null;
  const name = st.member.name?.trim() || st.member.email;
  if (crossedLimit) {
    await sendOnce(orgId, `${userId}:${key}:reached`, () => notifyOwners(orgId, `${name} reached their work-hour limit`, `${name} used ${hoursNum(st.used)} of ${workHours(st.limit!)} for ${label}.`));
  } else {
    await sendOnce(orgId, `${userId}:${key}:warn`, () => notifyOwners(orgId, `${name} is near their work-hour limit`, `${name} used ${hoursNum(st.used)} of ${workHours(st.limit!)} for ${label}.`));
  }
  return `You've used ${hoursNum(Math.min(st.used, st.limit))} of your ${workHours(st.limit)} for ${label}.`;
}

export async function usedNow(orgId: number, userId: number | null | undefined) {
  if (!userId) return 0;
  return (await minutesByPersonNow(orgId)).get(userId) ?? 0;
}

async function notifyOwners(orgId: number, title: string, body: string) {
  const { notify } = await import("./notify");
  await notify(orgId, "ai_limit", { title, body, url: "/team" }, { only: await ownerIds(orgId) });
}

/** Each person's work hours this month (or last) against their limit, with scheduled work on its own row. */
export async function byPerson(orgId: number, back = 0) {
  const [{ label }, members, s, used] = await Promise.all([month(orgId, back), db.listMembers(orgId), limitsFor(orgId), minutesByPersonNow(orgId, back)]);
  const rows = members
    .filter((m) => m.role !== "chat" || (used.get(m.userId) ?? 0) > 0)
    .map((m) => {
      const u = used.get(m.userId) ?? 0;
      const lim = limitOf(m, s);
      return {
        userId: m.userId,
        name: m.name?.trim() || m.email,
        avatarUrl: m.avatarUrl,
        role: m.role,
        hours: Number(hoursNum(u)),
        limit: lim.minutes == null ? null : Number(hoursNum(lim.minutes)),
        source: lim.source,
        pct: lim.minutes ? Math.round((u / lim.minutes) * 100) : null,
      };
    })
    .sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));
  // Work for people no longer on the team counts with scheduled work so the totals still add up.
  const known = new Set(members.map((m) => m.userId));
  let scheduled = 0;
  used.forEach((v, k) => {
    if (k === 0 || !known.has(k)) scheduled += v;
  });
  const people = rows.reduce((n, p) => n + p.hours, 0);
  return { month: label, total: Number(hoursNum(people * 60 + scheduled)), people: Number(hoursNum(people * 60)), scheduled: Number(hoursNum(scheduled)), rows };
}

/** The Team page's column: each member's work hours this month and their limit. */
export async function teamColumn(orgId: number) {
  const { label } = await month(orgId);
  const members = await db.listMembers(orgId);
  const s = await limitsFor(orgId);
  const used = await minutesByPersonNow(orgId);
  return members.map((m) => {
    const lim = limitOf(m, s);
    return { userId: m.userId, used: Number(hoursNum(used.get(m.userId) ?? 0)), limit: lim.minutes == null ? null : Number(hoursNum(lim.minutes)), source: lim.source, mode: m.aiLimitMode, own: m.aiLimitMinutes == null ? null : Number(hoursNum(m.aiLimitMinutes)), month: label };
  });
}

/**
 * Matches AI costs saved before per-person tracking to the person whose chat
 * message started them: the latest message a person sent that employee in the
 * 30 minutes before the cost. Costs with no such message stay scheduled work.
 * Runs once per workspace and covers this month and last month.
 */
export async function backfill(orgId: number) {
  const s = await limitsFor(orgId);
  if (s.backfilledAt) return { matched: 0, skipped: true };
  const { start } = await month(orgId, 1);
  const events = db
    .getDb()
    .select({ id: usageEvents.id, employeeId: usageEvents.employeeId, createdAt: usageEvents.createdAt })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, orgId), isNull(usageEvents.userId), gte(usageEvents.createdAt, start)))
    .all()
    .filter((e) => e.employeeId != null);
  const msgs = db
    .getDb()
    .select({ employeeId: chatMessages.employeeId, userId: chatMessages.userId, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.organizationId, orgId), eq(chatMessages.role, "user"), gte(chatMessages.createdAt, new Date(start.getTime() - 30 * 60_000))))
    .all()
    .filter((m) => m.userId != null)
    .sort((a, b) => +a.createdAt - +b.createdAt);
  const byEmp = new Map<number, typeof msgs>();
  for (const m of msgs) byEmp.set(m.employeeId, [...(byEmp.get(m.employeeId) ?? []), m]);
  let matched = 0;
  for (const e of events) {
    const list = byEmp.get(e.employeeId!) ?? [];
    const t = +e.createdAt;
    let pick: (typeof msgs)[number] | null = null;
    for (const m of list) {
      if (+m.createdAt > t + 1000) break;
      if (t - +m.createdAt <= 30 * 60_000) pick = m;
    }
    if (!pick) continue;
    db.getDb().update(usageEvents).set({ userId: pick.userId, estimated: true }).where(eq(usageEvents.id, e.id)).run();
    matched++;
  }
  await saveLimits(orgId, { backfilledAt: new Date().toISOString() });
  return { matched, skipped: false };
}

/** Runs the one-time match for every workspace that hasn't had it. */
export async function backfillAll() {
  for (const org of await db.listOrganizations()) {
    const r = await backfill(org.id).catch((err) => {
      console.warn(`[ai limits] back-count failed for workspace ${org.id}:`, err instanceof Error ? err.message : err);
      return null;
    });
    if (r && !r.skipped) console.log(`[ai limits] ${org.name}: matched ${r.matched} earlier AI costs to people`);
  }
}
