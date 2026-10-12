import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjTask, PjTaskTime } from "../../drizzle/schema";
import { zonedToUtc } from "../employees/schedule";
import { zoneOf } from "./goals";
import { parse, type Assignee } from "./projects";

/**
 * Find time (2026-10-12): a time on a person's calendar to do one of their
 * tasks.
 *
 * - Find time looks inside the person's work hours, around their other task
 *   times and, for the workspace owner, around the calendars connected on
 *   Integrations (those are the owner's calendars). It shows the time before
 *   anything is saved.
 * - A time that ends with the task still open moves to the next open time,
 *   and the row says where it was. After three moves the task goes to Needs
 *   attention so it doesn't slide forever.
 * - Checking the task off (on Home, in a list or on the Calendar) marks the
 *   time done.
 * - "Every new task with a due date" finds a time on its own for each of the
 *   person's open tasks that has a due date and no time yet.
 */

export const WHEN = ["first", "tomorrow", "next_week"] as const;
export type When = (typeof WHEN)[number];
export const LENGTHS = [15, 30, 60, 120] as const;

export type FindSettings = { mode: "ask" | "auto"; minutes: number; from: string; to: string; days: number[] };
export const DEFAULT_SETTINGS: FindSettings = { mode: "ask", minutes: 60, from: "09:00", to: "17:00", days: [1, 2, 3, 4, 5] };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const prefRow = (orgId: number, userId: number) => db.work.prefs.where(orgId, "userId", userId).find((p) => p.key === "findTime") ?? null;

export function settingsFor(orgId: number, userId: number): FindSettings {
  const row = prefRow(orgId, userId);
  const v = row ? parse<Partial<FindSettings>>(row.value, {}) : {};
  const days = Array.isArray(v.days) ? v.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULT_SETTINGS.days;
  return {
    mode: v.mode === "auto" ? "auto" : "ask",
    minutes: (LENGTHS as readonly number[]).includes(Number(v.minutes)) ? Number(v.minutes) : DEFAULT_SETTINGS.minutes,
    from: typeof v.from === "string" && HHMM.test(v.from) ? v.from : DEFAULT_SETTINGS.from,
    to: typeof v.to === "string" && HHMM.test(v.to) ? v.to : DEFAULT_SETTINGS.to,
    days: days.length ? Array.from(new Set(days)).sort() : DEFAULT_SETTINGS.days,
  };
}

export function saveSettings(orgId: number, userId: number, input: FindSettings) {
  if (!HHMM.test(input.from) || !HHMM.test(input.to) || input.from >= input.to) throw new TRPCError({ code: "BAD_REQUEST", message: "Work hours need a start before the end." });
  if (!input.days.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one work day." });
  const clean: FindSettings = { mode: input.mode === "auto" ? "auto" : "ask", minutes: (LENGTHS as readonly number[]).includes(input.minutes) ? input.minutes : 60, from: input.from, to: input.to, days: Array.from(new Set(input.days.filter((d) => d >= 0 && d <= 6))).sort() };
  const row = prefRow(orgId, userId);
  if (row) db.work.prefs.update(orgId, row.id, { value: JSON.stringify(clean) });
  else db.work.prefs.insert({ organizationId: orgId, userId, key: "findTime", value: JSON.stringify(clean) });
  return clean;
}

// ==========================================
// Finding an open time
// ==========================================

type Span = { start: Date; end: Date };
const STEP = 15 * 60_000;
const DAY = 86_400_000;

function partsIn(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d);
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}

/** The work window on the day that holds `at`, in the workspace's zone, or null on a day off. */
function windowOn(at: Date, s: FindSettings, tz: string): Span | null {
  const p = partsIn(at, tz);
  if (!s.days.includes(p.wd)) return null;
  const [fh, fm] = s.from.split(":").map(Number);
  const [th, tm] = s.to.split(":").map(Number);
  return { start: zonedToUtc(p.y, p.m, p.d, fh, fm, tz), end: zonedToUtc(p.y, p.m, p.d, th, tm, tz) };
}

/** Hooks tests use in place of the calendars. */
export const timeTools = {
  /** Busy times on the connected calendars; null when none is connected. */
  calendarBusy: async (orgId: number, from: Date, to: Date): Promise<Span[] | null> => {
    const cal = await import("../employees/calendars");
    const s = await cal.schedule(orgId, from, to);
    if (!s.sources) return null;
    return s.events.filter((e) => !e.allDay).map((e) => ({ start: e.start, end: e.end }));
  },
};

/** The connected calendars are the owner's, so only the owner's times are checked against them. */
async function readsCalendars(orgId: number, userId: number) {
  const m = await db.getOrganizationMembership(orgId, userId);
  return m?.role === "owner";
}

/** What is already taken for this person between two times: their other task times and, for the owner, the calendars. */
async function busyFor(orgId: number, userId: number, from: Date, to: Date, skipTaskId: number | null): Promise<{ spans: Span[]; calendars: boolean }> {
  const spans: Span[] = db.work.taskTimes
    .where(orgId, "userId", userId)
    .filter((t) => t.status === "planned" && t.taskId !== skipTaskId && new Date(t.end) > from && new Date(t.start) < to)
    .map((t) => ({ start: new Date(t.start), end: new Date(t.end) }));
  let calendars = false;
  if (await readsCalendars(orgId, userId)) {
    try {
      const got = await timeTools.calendarBusy(orgId, from, to);
      if (got) {
        spans.push(...got);
        calendars = true;
      }
    } catch {
      calendars = false;
    }
  }
  return { spans, calendars };
}

const roundUp = (t: number) => Math.ceil(t / STEP) * STEP;

/** The first open time of this length, searching up to three weeks from a start point. */
export async function findSlot(orgId: number, userId: number, minutes: number, when: When, opts: { now?: Date; after?: Date | null; skipTaskId?: number | null } = {}) {
  const tz = await zoneOf(orgId);
  const s = settingsFor(orgId, userId);
  const now = opts.now ?? new Date();
  let from = roundUp(Math.max(now.getTime(), opts.after ? opts.after.getTime() + STEP : 0));
  if (when === "tomorrow") {
    const p = partsIn(new Date(now.getTime() + DAY), tz);
    from = Math.max(from, zonedToUtc(p.y, p.m, p.d, 0, 0, tz).getTime());
  }
  if (when === "next_week") {
    const p = partsIn(now, tz);
    const toMonday = ((8 - p.wd) % 7) || 7;
    const q = partsIn(new Date(now.getTime() + toMonday * DAY), tz);
    from = Math.max(from, zonedToUtc(q.y, q.m, q.d, 0, 0, tz).getTime());
  }
  const horizon = from + 21 * DAY;
  const { spans, calendars } = await busyFor(orgId, userId, new Date(from), new Date(horizon), opts.skipTaskId ?? null);
  const len = minutes * 60_000;
  for (let day = 0; day < 21; day++) {
    const w = windowOn(new Date(from + day * DAY), s, tz);
    if (!w) continue;
    let t = roundUp(Math.max(w.start.getTime(), from));
    while (t + len <= w.end.getTime()) {
      const clash = spans.find((b) => b.start.getTime() < t + len && b.end.getTime() > t);
      if (!clash) return { start: new Date(t), end: new Date(t + len), calendars, settings: s, tz };
      t = roundUp(clash.end.getTime());
    }
  }
  return null;
}

const fmtTime = (d: Date, tz: string) => d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const fmtDay = (d: Date, tz: string) => d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const hhmm = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export function rangeText(start: Date, end: Date, tz: string) {
  const a = fmtTime(start, tz);
  const b = fmtTime(end, tz);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}

function mustOwn(orgId: number, userId: number, taskId: number): PjTask {
  const t = db.work.tasks.get(orgId, taskId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task is gone." });
  return t;
}

/** A time to show before saving: the first open one, or the next after the one shown ("Another time"). */
export async function suggest(orgId: number, userId: number, input: { taskId: number; minutes: number; when: When; after?: Date | null }) {
  mustOwn(orgId, userId, input.taskId);
  const minutes = (LENGTHS as readonly number[]).includes(input.minutes) ? input.minutes : 60;
  const slot = await findSlot(orgId, userId, minutes, input.when, { after: input.after ?? null, skipTaskId: input.taskId });
  if (!slot) return { found: false as const, text: "No open time in the next three weeks inside your work hours. Change your work hours on My account, or pick a shorter length." };
  const hours = `${hhmm(slot.settings.from)} to ${hhmm(slot.settings.to)}`;
  const why = slot.calendars ? `Open on your calendars and inside your work hours (${hours}).` : `Inside your work hours (${hours}) and clear of your other task times.`;
  return { found: true as const, start: slot.start, end: slot.end, minutes, text: `${fmtDay(slot.start, slot.tz)}, ${rangeText(slot.start, slot.end, slot.tz)}`, why };
}

/** The person's planned time for a task, if any. */
export function timeOf(orgId: number, userId: number, taskId: number): PjTaskTime | null {
  return db.work.taskTimes.where(orgId, "taskId", taskId).find((t) => t.userId === userId && t.status === "planned") ?? null;
}

/** Saves the time shown, replacing any earlier one for this task. */
export function saveTime(orgId: number, userId: number, input: { taskId: number; start: Date; minutes: number }) {
  const t = mustOwn(orgId, userId, input.taskId);
  if (t.closedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "That task is already done." });
  const minutes = Math.max(15, Math.min(480, Math.round(input.minutes)));
  for (const old of db.work.taskTimes.where(orgId, "taskId", input.taskId).filter((x) => x.userId === userId && x.status === "planned")) db.work.taskTimes.update(orgId, old.id, { status: "cancelled", updatedAt: new Date() });
  return db.work.taskTimes.insert({ organizationId: orgId, taskId: input.taskId, userId, start: input.start, end: new Date(input.start.getTime() + minutes * 60_000), minutes, status: "planned" });
}

export function clearTime(orgId: number, userId: number, taskId: number) {
  for (const old of db.work.taskTimes.where(orgId, "taskId", taskId).filter((x) => x.userId === userId && x.status === "planned")) db.work.taskTimes.update(orgId, old.id, { status: "cancelled", updatedAt: new Date() });
  return { ok: true };
}

/** What Home shows for each of the person's tasks. */
export async function timesFor(orgId: number, userId: number, taskIds: number[]) {
  const tz = await zoneOf(orgId);
  const ids = new Set(taskIds);
  const out = new Map<number, { start: string; end: string; text: string; day: string; moves: number; movedFrom: string | null }>();
  for (const t of db.work.taskTimes.where(orgId, "userId", userId)) {
    if (t.status !== "planned" || !ids.has(t.taskId)) continue;
    const start = new Date(t.start);
    const end = new Date(t.end);
    out.set(t.taskId, { start: start.toISOString(), end: end.toISOString(), text: rangeText(start, end, tz), day: localYmd(start, tz), moves: t.moves, movedFrom: t.movedFrom ? `${fmtDay(new Date(t.movedFrom), tz)}, ${fmtTime(new Date(t.movedFrom), tz)}` : null });
  }
  return out;
}

function localYmd(d: Date, tz: string) {
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

/** A person's planned and done task times between two instants, for the Calendar. */
export function timesBetween(orgId: number, userId: number, from: Date, to: Date) {
  return db.work.taskTimes.where(orgId, "userId", userId).filter((t) => t.status !== "cancelled" && new Date(t.end) > from && new Date(t.start) < to);
}

// ==========================================
// Moving times that ended, and finding time on its own
// ==========================================

const isMine = (t: PjTask, userId: number) => parse<Assignee[]>(t.assignees, []).some((a) => a.type === "user" && a.id === userId);

/** Every few minutes: times that ended move on or close; people set to "Every new task" get times for new tasks. */
export async function taskTimesTick(now = new Date()) {
  let moved = 0;
  for (const tt of db.taskTimesEnded(now)) {
    const task = db.work.tasks.get(tt.organizationId, tt.taskId);
    if (!task || task.closedAt) {
      db.work.taskTimes.update(tt.organizationId, tt.id, { status: task ? "done" : "cancelled", updatedAt: now });
      continue;
    }
    const slot = await findSlot(tt.organizationId, tt.userId, tt.minutes, "first", { now, skipTaskId: tt.taskId });
    if (!slot) continue;
    db.work.taskTimes.update(tt.organizationId, tt.id, { start: slot.start, end: slot.end, moves: tt.moves + 1, movedFrom: tt.start, updatedAt: now });
    moved++;
  }
  let placed = 0;
  for (const pref of db.findTimePrefs()) {
    const s = settingsFor(pref.organizationId, pref.userId);
    if (s.mode !== "auto") continue;
    const open = db.work.tasks.all(pref.organizationId).filter((t) => !t.closedAt && !t.parentId && t.dueDate && isMine(t, pref.userId));
    const has = new Set(db.work.taskTimes.where(pref.organizationId, "userId", pref.userId).map((x) => x.taskId));
    for (const t of open.filter((x) => !has.has(x.id)).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 20)) {
      const slot = await findSlot(pref.organizationId, pref.userId, s.minutes, "first", { now, skipTaskId: t.id });
      if (!slot) break;
      saveTime(pref.organizationId, pref.userId, { taskId: t.id, start: slot.start, minutes: s.minutes });
      placed++;
    }
  }
  return { moved, placed };
}

/** A task checked off: its planned times are done. */
export function markDone(orgId: number, taskId: number) {
  for (const t of db.work.taskTimes.where(orgId, "taskId", taskId)) if (t.status === "planned") db.work.taskTimes.update(orgId, t.id, { status: "done", updatedAt: new Date() });
}
