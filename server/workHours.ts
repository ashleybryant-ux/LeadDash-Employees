import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import * as db from "./db";
import { aiEmployees, hourPacks, organizations, usageEvents, type Organization } from "../drizzle/schema";
import { monthRange, recordSkipped, recordTask, usageContext } from "./usage";

/**
 * Work hours: what a workspace's plan includes and what each job uses.
 *
 * A work hour is a unit of work, not time on a clock: every finished job uses
 * the fixed amount in JOBS, every time. Chat is free. The plan's hours reset
 * on the 1st of each month in the workspace's time zone; hours bought on top
 * (packs) are used after the plan's, oldest first, and last 12 months. A job
 * that fails uses nothing. With no plan set, work is counted but not limited
 * (LeadDash's own workspaces).
 */

export const JOBS = {
  email: { label: "Email or reply written", minutes: 10 },
  lead: { label: "Lead or reporter found, with contact info", minutes: 10 },
  ehr: { label: "Answer from LeadDash EHR", minutes: 10 },
  post: { label: "Social post with picture", minutes: 30 },
  task: { label: "Task finished in Projects", minutes: 30 },
  doc: { label: "Blog post, doc, page or deck", minutes: 60 },
  search: { label: "Search for grants, events or prospects", minutes: 60 },
  research: { label: "Cold leads researched, per 25 leads", minutes: 60 },
  meeting: { label: "Meeting notes, per meeting hour", minutes: 60 },
  website: { label: "Work done on a website for you", minutes: 60 },
  portal: { label: "Application portal filled out", minutes: 180 },
  application: { label: "Speaking, pitch or accelerator application", minutes: 180 },
  grant: { label: "Full grant application", minutes: 480 },
  video: { label: "Talking video, per minute (Pro quality: 16 hr)", minutes: 480 },
} as const;
export type JobKey = keyof typeof JOBS;

/** Jobs this size or bigger ask first. */
export const ASK_FIRST_MINUTES = 180;

export const PLANS = {
  starter: { name: "Starter", hours: 50, monthly: 49, yearly: 42, healthcare: false },
  growth: { name: "Growth", hours: 120, monthly: 99, yearly: 84, healthcare: false },
  pro: { name: "Pro", hours: 200, monthly: 199, yearly: 169, healthcare: false },
  practice_starter: { name: "Practice Starter", hours: 50, monthly: 99, yearly: 99, healthcare: true },
  practice_growth: { name: "Practice Growth", hours: 120, monthly: 199, yearly: 199, healthcare: true },
  practice_pro: { name: "Practice Pro", hours: 300, monthly: 349, yearly: 349, healthcare: true },
} as const;
export type PlanKey = keyof typeof PLANS;
export const PLAN_KEYS = Object.keys(PLANS) as PlanKey[];

export const TOPUPS = {
  business: [
    { hours: 10, price: 10 },
    { hours: 50, price: 45 },
  ],
  healthcare: [
    { hours: 10, price: 15 },
    { hours: 50, price: 65 },
  ],
} as const;

/** Where the "Add hours" buttons go: the pricing page, where top-ups are bought. */
export const PRICING_URL = "https://leaddash.io/employees";

export type WorkHoursSettings = { plan: PlanKey | null };

export function settingsOf(org: Pick<Organization, "workHours"> | null | undefined): WorkHoursSettings {
  try {
    const v = org?.workHours ? JSON.parse(org.workHours) : {};
    return { plan: PLAN_KEYS.includes(v.plan) ? v.plan : null };
  } catch {
    return { plan: null };
  }
}

export const hoursText = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hr`;
};
/** "82" or "82.5": hours as a plain number. */
export const hoursNum = (minutes: number) => {
  const h = Math.max(0, minutes) / 60;
  return Number.isInteger(h) ? `${h}` : h.toFixed(1);
};

const dayText = (d: Date, tz: string) => d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });

function activePacks(orgId: number, now = new Date()) {
  return db
    .getDb()
    .select()
    .from(hourPacks)
    .where(and(eq(hourPacks.organizationId, orgId), gt(hourPacks.expiresAt, now), gt(hourPacks.remaining, 0)))
    .orderBy(asc(hourPacks.expiresAt))
    .all();
}

function minutesUsed(orgId: number, start: Date, end: Date) {
  return db
    .getDb()
    .select({ minutes: usageEvents.minutes })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, orgId), eq(usageEvents.type, "task"), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)))
    .all()
    .reduce((n, r) => n + r.minutes, 0);
}

/** Where a workspace stands this month. */
export async function balance(orgId: number, now = new Date()) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const s = settingsOf(org);
  const plan = s.plan ? PLANS[s.plan] : null;
  const { start, end, label } = monthRange(tz, 0, now);
  const used = minutesUsed(orgId, start, end);
  const packs = activePacks(orgId, now);
  const packMinutes = packs.reduce((n, p) => n + p.remaining, 0);
  const planMinutes = plan ? plan.hours * 60 : null;
  const planLeft = planMinutes == null ? null : Math.max(0, planMinutes - used);
  const left = planLeft == null ? null : planLeft + packMinutes;
  const lastPack = packs.length ? packs[packs.length - 1].expiresAt : null;
  return {
    metered: !!plan,
    plan: s.plan,
    planName: plan?.name ?? null,
    healthcare: plan ? plan.healthcare : org?.orgType === "healthcare",
    planMinutes,
    usedMinutes: used,
    planLeftMinutes: planLeft,
    packMinutes,
    packsGoodThrough: lastPack ? dayText(lastPack, tz) : null,
    leftMinutes: left,
    out: left != null && left <= 0,
    month: label,
    resetsOn: dayText(end, tz),
    pricingUrl: PRICING_URL,
    topUps: plan?.healthcare || (!plan && org?.orgType === "healthcare") ? TOPUPS.healthcare : TOPUPS.business,
  };
}

export type Job<T = unknown> = {
  job: JobKey;
  /** How many of the job (posts written, leads found, meeting hours). Defaults to 1; 0 uses nothing. */
  count?: number | ((r: T) => number);
  /** What the recent-jobs list shows, after the job's own name. */
  label?: string | ((r: T) => string);
  /** False when the work came back without the result (a browser task that failed): it uses nothing. */
  done?: (r: T) => boolean;
};

export function minutesFor(job: JobKey, count = 1) {
  return JOBS[job].minutes * Math.max(0, count);
}

/**
 * Before a job starts: out of hours, or past this person's own monthly limit
 * when the workspace stops work at the limit, means it doesn't start.
 */
export async function gate(orgId: number) {
  const b = await balance(orgId);
  if (b.out) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This workspace is out of work hours, so the employees are paused until ${b.resetsOn}. Chat still works. An owner or admin can add hours on the Workspace page.` });
  }
  const userId = usageContext()?.userId;
  if (userId) {
    const lim = await import("./aiLimits");
    const st = await lim.personStatus(orgId, userId).catch(() => null);
    if (st?.reached && st.settings.atLimit === "stop") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `You've used your ${hoursText(st.limit!)} of work for ${b.month}, so I can't start new work for you until ${b.resetsOn}. The owner can raise your limit on the Team page.` });
    }
  }
}

/** A finished job: records the hours it used, taking the plan's hours first and then bought hours, oldest first. */
export async function charge(orgId: number, employeeId: number | null, job: JobKey, count = 1, label = "") {
  const minutes = minutesFor(job, count);
  if (minutes <= 0) return 0;
  const b = await balance(orgId);
  if (b.metered) {
    let overflow = Math.max(0, minutes - (b.planLeftMinutes ?? 0));
    for (const p of activePacks(orgId)) {
      if (overflow <= 0) break;
      const take = Math.min(p.remaining, overflow);
      db.getDb().update(hourPacks).set({ remaining: p.remaining - take }).where(eq(hourPacks.id, p.id)).run();
      overflow -= take;
    }
  }
  await recordTask(orgId, employeeId, minutes, { job, count, label: label.slice(0, 160) }, usageContext()?.userId ?? null);
  return minutes;
}

/** A job that came back without its result: shown in recent jobs as not charged. Only jobs of an hour or more are worth listing. */
export async function skipped(orgId: number, employeeId: number | null, job: JobKey, count = 1, label = "") {
  const minutes = minutesFor(job, count);
  if (minutes < 60) return;
  await recordSkipped(orgId, employeeId, { job, count, minutes, label: label.slice(0, 160) }, usageContext()?.userId ?? null);
}

/** Recent jobs this month, newest first: what each used, or that it wasn't charged. */
export async function recentJobs(orgId: number, limit = 30) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const { start } = monthRange(tz);
  const rows = db
    .getDb()
    .select({ id: usageEvents.id, type: usageEvents.type, minutes: usageEvents.minutes, detail: usageEvents.detail, employeeId: usageEvents.employeeId, createdAt: usageEvents.createdAt })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, orgId), inArray(usageEvents.type, ["task", "skipped"]), gte(usageEvents.createdAt, start)))
    .orderBy(desc(usageEvents.createdAt), desc(usageEvents.id))
    .limit(limit)
    .all();
  const emps = db.getDb().select({ id: aiEmployees.id, name: aiEmployees.name, kind: aiEmployees.kind, avatar: aiEmployees.avatar }).from(aiEmployees).where(eq(aiEmployees.organizationId, orgId)).all();
  return rows.map((r) => {
    let d: { job?: string; label?: string; minutes?: number; count?: number } = {};
    try {
      d = r.detail ? JSON.parse(r.detail) : {};
    } catch {}
    const e = emps.find((x) => x.id === r.employeeId) ?? null;
    const base = d.job && d.job in JOBS ? JOBS[d.job as JobKey].label : "Job finished";
    const name = d.count && d.count > 1 && d.job !== "video" ? `${base} (${d.count})` : base;
    return {
      id: r.id,
      employee: e,
      what: d.label ? `${name}: ${d.label}` : name,
      minutes: r.type === "skipped" ? d.minutes ?? 0 : r.minutes,
      charged: r.type === "task",
      at: dayText(new Date(r.createdAt), tz),
    };
  });
}

/** Work hours each person asked for this month, by user id (0 = scheduled work). */
export function minutesByPerson(orgId: number, start: Date, end: Date) {
  const rows = db
    .getDb()
    .select({ userId: usageEvents.userId, minutes: usageEvents.minutes })
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, orgId), eq(usageEvents.type, "task"), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)))
    .all();
  const by = new Map<number, number>();
  for (const r of rows) by.set(r.userId ?? 0, (by.get(r.userId ?? 0) ?? 0) + r.minutes);
  return by;
}

// ---------- Asking before big jobs in chat ----------

type Pending = { decision: unknown; at: number; text: string };
const pending = new Map<string, Pending>();
const keyOf = (orgId: number, employeeId: number) => `${orgId}:${employeeId}`;

/** The question an employee asks before a job of 3 hours or more, with the hours left. */
export async function askText(orgId: number, what: string) {
  const b = await balance(orgId);
  return `Before I start: ${what}. You have ${hoursText(b.leftMinutes ?? 0)} left.`;
}

export function setPending(orgId: number, employeeId: number, decision: unknown, text: string) {
  pending.set(keyOf(orgId, employeeId), { decision, at: Date.now(), text });
}

/** "Go ahead" returns the job asked about (once); "Not now" drops it. Asks older than an hour are forgotten. */
export function answerPending(orgId: number, employeeId: number, said: string): { go: unknown } | { no: true } | null {
  const k = keyOf(orgId, employeeId);
  const p = pending.get(k);
  if (!p) return null;
  if (Date.now() - p.at > 60 * 60_000) {
    pending.delete(k);
    return null;
  }
  const s = said.trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(go ahead|yes|yes,? go ahead|do it|start it|ok,? go ahead)$/.test(s)) {
    pending.delete(k);
    return { go: p.decision };
  }
  if (/^(not now|no|cancel|don't|do not)$/.test(s)) {
    pending.delete(k);
    return { no: true };
  }
  return null;
}

export function clearPending(orgId: number, employeeId: number) {
  pending.delete(keyOf(orgId, employeeId));
}

// ---------- LeadDash staff ----------

export async function setPlan(orgId: number, plan: PlanKey | null) {
  await db.updateOrganization(orgId, { workHours: JSON.stringify({ plan }) });
  return balance(orgId);
}

export async function addPack(orgId: number, hours: number, note: string, by: string, now = new Date()) {
  const minutes = Math.round(hours * 60);
  if (minutes <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Add at least a few minutes." });
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  db.getDb().insert(hourPacks).values({ organizationId: orgId, minutes, remaining: minutes, note: note.trim().slice(0, 200) || null, addedBy: by, expiresAt }).run();
  return balance(orgId);
}

export function packsFor(orgId: number) {
  return db.getDb().select().from(hourPacks).where(eq(hourPacks.organizationId, orgId)).orderBy(desc(hourPacks.createdAt)).all();
}

/** Every workspace: its plan, hours this month, AI cost this month and the margin on the plan's price. */
export async function staffList() {
  const orgs = await db.listOrganizations();
  const out = [];
  for (const o of orgs) {
    const b = await balance(o.id);
    const tz = o.timezone || "America/Chicago";
    const { start, end } = monthRange(tz);
    const micros = db
      .getDb()
      .select({ c: usageEvents.costMicros, type: usageEvents.type })
      .from(usageEvents)
      .where(and(eq(usageEvents.organizationId, o.id), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)))
      .all()
      .reduce((n, r) => n + (r.type === "task" || r.type === "skipped" ? 0 : r.c), 0);
    const cost = micros / 1_000_000;
    const price = b.plan ? PLANS[b.plan].monthly : null;
    const packs = packsFor(o.id).map((p) => ({ id: p.id, hours: hoursNum(p.minutes), left: hoursNum(p.remaining), note: p.note, addedBy: p.addedBy, added: dayText(new Date(p.createdAt), tz), expires: dayText(new Date(p.expiresAt), tz) }));
    out.push({
      id: o.id,
      name: o.name,
      orgType: o.orgType,
      internal: !!o.internal,
      plan: b.plan,
      planName: b.planName,
      usedHours: hoursNum(b.usedMinutes),
      leftHours: b.leftMinutes == null ? null : hoursNum(b.leftMinutes),
      planHours: b.planMinutes == null ? null : hoursNum(b.planMinutes),
      cost: Math.round(cost * 100) / 100,
      margin: price ? Math.round(((price - cost) / price) * 100) : null,
      packs,
    });
  }
  return out.sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

// ---------- Videos ----------

/** Whether a workspace is on a plan, read straight from the database (for views that can't wait). */
export function meteredSync(orgId: number) {
  const row = db.getDb().select({ workHours: organizations.workHours }).from(organizations).where(eq(organizations.id, orgId)).get();
  return !!settingsOf(row).plan;
}

/** A talking video uses 8 work hours for each minute, rounded up (16 in Pro quality). */
export const videoMinutes = (tenths: number | null | undefined, quality?: string | null) => JOBS.video.minutes * Math.max(1, Math.ceil((tenths ?? 0) / 600)) * (quality === "pro" ? 2 : 1);
