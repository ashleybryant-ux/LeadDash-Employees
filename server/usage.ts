import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, gte, lt } from "drizzle-orm";
import * as db from "./db";
import { usageEvents, type EmployeeKind } from "../drizzle/schema";
import { partsIn, zonedToUtc } from "./employees/schedule";

/**
 * Usage: how much time the employees saved and what the AI cost, per
 * workspace and per employee. Work runs inside a usage context (set by
 * working(), the API layer and the background ticks), and every AI call made
 * inside it is recorded against that workspace and employee.
 */

type Ctx = { orgId: number; employeeId?: number | null; kind?: EmployeeKind | null };
const store = new AsyncLocalStorage<Ctx>();

export function withUsage<T>(ctx: Ctx, fn: () => T): T {
  const outer = store.getStore();
  // An inner context that knows the employee wins; otherwise keep what the outer one knew.
  const merged: Ctx = outer && outer.orgId === ctx.orgId ? { ...outer, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null)) } : ctx;
  return store.run(merged, fn);
}

export function usageContext() {
  return store.getStore() ?? null;
}

// ---------- Prices (published list prices, US dollars) ----------

/** Per million tokens: [input, output]. Checked against Anthropic's pricing page on 2026-10-03. */
const TOKEN_PRICES: [RegExp, number, number][] = [
  [/fable|mythos/, 10, 50],
  [/opus-5-5/, 4, 20],
  [/opus-4-1|opus-4(-\d{8})?$/, 15, 75],
  [/opus/, 5, 25],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/haiku-3/, 0.8, 4],
  [/haiku/, 1, 5],
];
export const SEARCH_PRICE = 10 / 1000; // per web search
/** gpt-image-2, medium quality. */
export const IMAGE_PRICE: Record<string, number> = { "1024x1024": 0.053, "1024x1536": 0.041, "1536x1024": 0.041 };
/** Recall.ai: recording plus its own transcription, per hour. */
export const MEETING_PRICE_PER_HOUR = 0.5 + 0.15;

export function tokenCost(model: string, input: number, output: number, cacheRead = 0) {
  const m = model.toLowerCase();
  const row = TOKEN_PRICES.find(([re]) => re.test(m)) ?? TOKEN_PRICES[TOKEN_PRICES.length - 3];
  const [inP, outP] = [row[1], row[2]];
  return (input * inP + cacheRead * inP * 0.1 + output * outP) / 1_000_000;
}

// ---------- Recording ----------

async function employeeIdFor(ctx: Ctx) {
  if (ctx.employeeId) return ctx.employeeId;
  if (!ctx.kind) return null;
  return (await db.getEmployeeByKind(ctx.orgId, ctx.kind))?.id ?? null;
}

async function insert(type: (typeof usageEvents.$inferInsert)["type"], costUsd: number, minutes: number, detail: Record<string, unknown>, ctx = store.getStore()) {
  if (!ctx?.orgId) return;
  try {
    db.getDb()
      .insert(usageEvents)
      .values({ organizationId: ctx.orgId, employeeId: await employeeIdFor(ctx), type, minutes: Math.round(minutes), costMicros: Math.round(costUsd * 1_000_000), detail: JSON.stringify(detail) })
      .run();
  } catch (err) {
    // Usage is bookkeeping: never let it break the work itself.
    console.warn("[usage] could not record:", err instanceof Error ? err.message : err);
  }
}

export function recordTokens(model: string, input: number, output: number, cacheRead = 0) {
  if (!input && !output) return Promise.resolve();
  return insert("writing", tokenCost(model, input, output, cacheRead), 0, { model, input, output, cacheRead });
}

export function recordSearch(model: string, input: number, output: number, searches: number, cacheRead = 0) {
  return insert("search", tokenCost(model, input, output, cacheRead) + searches * SEARCH_PRICE, 0, { model, input, output, cacheRead, searches });
}

export function recordImage(size: string) {
  return insert("image", IMAGE_PRICE[size] ?? IMAGE_PRICE["1024x1024"], 0, { size, quality: "medium" });
}

export function recordMeeting(orgId: number, employeeId: number | null, minutes: number) {
  return insert("meeting", (minutes / 60) * MEETING_PRICE_PER_HOUR, 0, { minutes }, { orgId, employeeId });
}

/** A finished piece of work and the time it saved. */
export function recordTask(orgId: number, employeeId: number, minutes: number) {
  return insert("task", 0, minutes, {}, { orgId, employeeId });
}

// ---------- Reading ----------

/** Start and end of a calendar month in the workspace's time zone (0 = this month, 1 = last month). */
export function monthRange(tz: string, back = 0, now = new Date()) {
  const p = partsIn(now, tz);
  let y = p.y;
  let m = p.m - back;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  const start = zonedToUtc(y, m, 1, 0, 0, tz);
  const end = m === 12 ? zonedToUtc(y + 1, 1, 1, 0, 0, tz) : zonedToUtc(y, m + 1, 1, 0, 0, tz);
  return { start, end, label: new Date(Date.UTC(y, m - 1, 15)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
}

export async function usageSummary(orgId: number, back = 0) {
  const org = await db.getOrganizationById(orgId);
  const { start, end, label } = monthRange(org?.timezone || "America/Chicago", back);
  const rows = db
    .getDb()
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.organizationId, orgId), gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)))
    .all();
  const emps = await db.listEmployeesByOrg(orgId);
  // Hours saved each day of the month, up to today for this month.
  const tz = org?.timezone || "America/Chicago";
  const lastDay = back === 0 ? partsIn(new Date(), tz).d : partsIn(new Date(end.getTime() - 1000), tz).d;
  const dailyMin = new Array<number>(lastDay).fill(0);
  for (const r of rows) if (r.type === "task") {
    const d = partsIn(new Date(r.createdAt), tz).d;
    if (d >= 1 && d <= lastDay) dailyMin[d - 1] += r.minutes;
  }
  const by = new Map<number | null, { minutes: number; tasks: number; micros: number }>();
  for (const r of rows) {
    const key = r.employeeId && emps.some((e) => e.id === r.employeeId) ? r.employeeId : null;
    const cur = by.get(key) ?? { minutes: 0, tasks: 0, micros: 0 };
    if (r.type === "task") {
      cur.minutes += r.minutes;
      cur.tasks += 1;
    } else cur.micros += r.costMicros;
    by.set(key, cur);
  }
  const total = Array.from(by.values()).reduce((a, b) => ({ minutes: a.minutes + b.minutes, tasks: a.tasks + b.tasks, micros: a.micros + b.micros }), { minutes: 0, tasks: 0, micros: 0 });
  const hours = (min: number) => Math.round((min / 60) * 10) / 10;
  const dollars = (micros: number) => Math.round(micros / 10_000) / 100;
  const employees = emps
    .map((e) => ({ id: e.id, name: e.name, kind: e.kind, roleTitle: e.roleTitle, avatar: e.avatar, ...(by.get(e.id) ?? { minutes: 0, tasks: 0, micros: 0 }) }))
    .map((e) => ({ id: e.id, name: e.name, kind: e.kind, roleTitle: e.roleTitle, avatar: e.avatar, hours: hours(e.minutes), tasks: e.tasks, cost: dollars(e.micros) }))
    .sort((a, b) => b.hours - a.hours || b.cost - a.cost || a.name.localeCompare(b.name));
  const shared = by.get(null);
  return {
    month: label,
    daily: dailyMin.map((m) => Math.round((m / 60) * 10) / 10),
    hours: hours(total.minutes),
    tasks: total.tasks,
    cost: dollars(total.micros),
    employees,
    shared: shared && shared.micros > 0 ? dollars(shared.micros) : 0,
  };
}
