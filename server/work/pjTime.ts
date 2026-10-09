import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjTask, PjTime } from "../../drizzle/schema";
import { owners, todayYmd, zoneOf, addDays, sundayOf } from "./goals";
import { parse, activity, type Assignee } from "./projects";
import { visibleLists, type Viewer } from "./pjAccess";

/**
 * Time on tasks: a start and stop timer (one running per person), time typed
 * in, billable or not; the weekly timesheet; and Workload, which spreads each
 * task's time estimate across its dates to show each person's hours per week
 * against the hours they work.
 */

export type Who = { type: "user" | "employee"; id: number; name: string };

const minutesOf = (e: PjTime) => e.minutes ?? (e.startedAt ? Math.max(0, Math.round((Date.now() - new Date(e.startedAt).getTime()) / 60000)) : 0);

export function runningFor(orgId: number, who: Who) {
  const e = db.work.time.all(orgId).find((x) => x.minutes === null && x.whoType === who.type && x.whoId === who.id);
  if (!e) return null;
  const t = db.work.tasks.get(orgId, e.taskId);
  return { id: e.id, taskId: e.taskId, taskName: t?.name ?? "", startedAt: e.startedAt, note: e.note };
}

export async function startTimer(orgId: number, taskId: number, who: Who, note = "") {
  const t = db.work.tasks.get(orgId, taskId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  // One timer per person: starting this one stops the other.
  stopTimer(orgId, who);
  const day = todayYmd(await zoneOf(orgId));
  return db.work.time.insert({ organizationId: orgId, taskId, whoType: who.type, whoId: who.id, whoName: who.name, day, minutes: null, startedAt: new Date(), note: note.slice(0, 200), billable: true });
}

export function stopTimer(orgId: number, who: Who) {
  const e = db.work.time.all(orgId).find((x) => x.minutes === null && x.whoType === who.type && x.whoId === who.id);
  if (!e) return null;
  const minutes = Math.max(1, minutesOf(e));
  db.work.time.update(orgId, e.id, { minutes });
  activity(orgId, e.taskId, { type: who.type, id: who.id, name: who.name }, `${who.name} tracked ${fmtMin(minutes)}`);
  return { minutes };
}

export function addTime(orgId: number, taskId: number, input: { who: Who; day: string; minutes: number; note: string; billable: boolean }, by: Who) {
  if (!db.work.tasks.get(orgId, taskId)) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the day." });
  if (!(input.minutes > 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "Add how long it took." });
  const e = db.work.time.insert({ organizationId: orgId, taskId, whoType: input.who.type, whoId: input.who.id, whoName: input.who.name, day: input.day, minutes: Math.min(24 * 60, Math.round(input.minutes)), startedAt: null, note: input.note.slice(0, 200), billable: input.billable });
  activity(orgId, taskId, by, `${by.name} added ${fmtMin(e.minutes!)} for ${input.who.name}`);
  return e;
}

export function updateTime(orgId: number, id: number, patch: { minutes?: number; note?: string; billable?: boolean; day?: string }) {
  const e = db.work.time.get(orgId, id);
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "That time isn't here anymore." });
  db.work.time.update(orgId, id, {
    ...(patch.minutes !== undefined && e.minutes !== null ? { minutes: Math.max(1, Math.min(24 * 60, Math.round(patch.minutes))) } : {}),
    ...(patch.note !== undefined ? { note: patch.note.slice(0, 200) } : {}),
    ...(patch.billable !== undefined ? { billable: patch.billable } : {}),
    ...(patch.day && /^\d{4}-\d{2}-\d{2}$/.test(patch.day) ? { day: patch.day } : {}),
  });
}
export function removeTime(orgId: number, id: number) {
  db.work.time.remove(orgId, id);
}

export const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`);

/** A week of tracked time (Sunday to Saturday) by task and person. */
export async function timesheet(orgId: number, v: Viewer, input: { weekStart?: string; whoType?: "user" | "employee"; whoId?: number; billable?: "any" | "yes" | "no" }) {
  const tz = await zoneOf(orgId);
  const today = todayYmd(tz);
  const start = sundayOf(input.weekStart ?? today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const visIds = new Set(visibleLists(orgId, v).map((x) => x.list.id));
  const tasks = db.work.tasks.all(orgId).filter((t) => visIds.has(t.listId));
  const lists = db.work.lists.all(orgId);
  const entries = db.work.time
    .all(orgId)
    .filter((e) => days.includes(e.day) && tasks.some((t) => t.id === e.taskId))
    .filter((e) => !input.whoType || (e.whoType === input.whoType && e.whoId === input.whoId))
    .filter((e) => !input.billable || input.billable === "any" || (input.billable === "yes" ? e.billable : !e.billable));
  const rows = new Map<string, { taskId: number; taskName: string; listName: string; whoType: string; whoId: number; whoName: string; byDay: number[]; total: number; billable: number; running: boolean }>();
  for (const e of entries) {
    const key = `${e.taskId}:${e.whoType}:${e.whoId}`;
    const t = tasks.find((x) => x.id === e.taskId)!;
    const r = rows.get(key) ?? { taskId: t.id, taskName: t.name, listName: lists.find((l) => l.id === t.listId)?.name ?? "", whoType: e.whoType, whoId: e.whoId, whoName: e.whoName, byDay: [0, 0, 0, 0, 0, 0, 0], total: 0, billable: 0, running: false };
    const m = minutesOf(e);
    r.byDay[days.indexOf(e.day)] += m;
    r.total += m;
    if (e.billable) r.billable += m;
    if (e.minutes === null) r.running = true;
    rows.set(key, r);
  }
  const list = Array.from(rows.values()).sort((a, b) => a.whoName.localeCompare(b.whoName) || b.total - a.total);
  // Estimate vs. actual: tasks done this week that had an estimate.
  const doneThisWeek = tasks.filter((t) => t.closedAt && t.timeEstimate && days.includes(todayYmd(tz, new Date(t.closedAt))));
  const est = doneThisWeek.reduce((s, t) => s + (t.timeEstimate ?? 0), 0);
  const act = doneThisWeek.reduce((s, t) => s + db.work.time.where(orgId, "taskId", t.id).reduce((x, e) => x + minutesOf(e), 0), 0);
  const running = db.work.time
    .all(orgId)
    .filter((e) => e.minutes === null && tasks.some((t) => t.id === e.taskId))
    .map((e) => ({ id: e.id, whoName: e.whoName, taskId: e.taskId, taskName: tasks.find((t) => t.id === e.taskId)?.name ?? "", startedAt: e.startedAt }));
  return {
    start,
    days,
    rows: list,
    totals: days.map((_, i) => list.reduce((s, r) => s + r.byDay[i], 0)),
    total: list.reduce((s, r) => s + r.total, 0),
    billable: list.reduce((s, r) => s + r.billable, 0),
    estimateUse: est ? Math.round((act / est) * 100) : null,
    running,
    people: v.kind === "guest" ? [] : (await owners(orgId)).map((o) => ({ type: o.type, id: o.id, name: o.name })),
    today,
  };
}

// ==========================================
// Workload
// ==========================================

/** Weekly hours a person works; employees have no limit. */
export function hoursFor(orgId: number, type: "user" | "employee", id: number) {
  const v = db.work.setting(orgId, `hours:${type}:${id}`);
  if (v !== null) return v === "" ? null : Number(v);
  return type === "user" ? 40 : null;
}
export function setHours(orgId: number, type: "user" | "employee", id: number, hours: number | null) {
  db.work.setSetting(orgId, `hours:${type}:${id}`, hours === null ? "" : String(Math.max(0, Math.min(100, hours))));
}

const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Spreads a task's estimate over its working days (Monday to Friday) between start and due. */
function spread(t: PjTask) {
  if (!t.timeEstimate) return [] as { day: string; minutes: number }[];
  const end = t.dueDate ?? t.startDate;
  if (!end) return [];
  const start = t.startDate && t.startDate <= end ? t.startDate : end;
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 400; d = addDays(d, 1)) if (weekday(d) !== 0 && weekday(d) !== 6) days.push(d);
  if (!days.length) days.push(end);
  return days.map((day) => ({ day, minutes: t.timeEstimate! / days.length }));
}

export async function workload(orgId: number, v: Viewer, input: { start?: string; weeks: number; listId?: number | null; portfolioId?: number | null }) {
  const tz = await zoneOf(orgId);
  const start = sundayOf(input.start ?? todayYmd(tz));
  const weeks = Array.from({ length: Math.max(1, Math.min(12, input.weeks)) }, (_, i) => addDays(start, i * 7));
  const end = addDays(weeks[weeks.length - 1], 6);
  const inPortfolio = input.portfolioId ? new Set((await import("./pjPortfolios")).listsIn(orgId, input.portfolioId)) : null;
  const visIds = new Set(visibleLists(orgId, v).filter((x) => !inPortfolio || inPortfolio.has(x.list.id)).map((x) => x.list.id));
  const tasks = db.work.tasks.all(orgId).filter((t) => visIds.has(t.listId) && !t.closedAt && (!input.listId || t.listId === input.listId));
  const people = await owners(orgId);
  const lists = db.work.lists.all(orgId);
  const rows = people.map((p) => {
    const cells = weeks.map((w) => ({ week: w, minutes: 0, tasks: [] as { id: number; name: string; listName: string; minutes: number; startDate: string | null; dueDate: string | null }[] }));
    for (const t of tasks) {
      const as = parse<Assignee[]>(t.assignees, []);
      if (!as.some((a) => a.type === p.type && a.id === p.id)) continue;
      const share = 1 / Math.max(1, as.length);
      const byWeek = new Map<number, number>();
      for (const s of spread(t)) {
        if (s.day < start || s.day > end) continue;
        const i = Math.floor((Date.parse(`${s.day}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / (7 * 86_400_000));
        byWeek.set(i, (byWeek.get(i) ?? 0) + s.minutes * share);
      }
      // Tasks with no estimate still show in their due week.
      if (!t.timeEstimate && t.dueDate && t.dueDate >= start && t.dueDate <= end) byWeek.set(Math.floor((Date.parse(`${t.dueDate}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / (7 * 86_400_000)), 0);
      for (const [i, m] of Array.from(byWeek.entries())) {
        cells[i].minutes += m;
        cells[i].tasks.push({ id: t.id, name: t.name, listName: lists.find((l) => l.id === t.listId)?.name ?? "", minutes: Math.round(m), startDate: t.startDate, dueDate: t.dueDate });
      }
    }
    return { type: p.type, id: p.id, name: p.name, avatarUrl: p.avatarUrl, kind: "kind" in p ? (p as { kind?: string }).kind ?? null : null, hours: hoursFor(orgId, p.type, p.id), cells: cells.map((c) => ({ ...c, minutes: Math.round(c.minutes) })) };
  });
  return { weeks, rows, today: todayYmd(tz) };
}
