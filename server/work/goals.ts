import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { Goal, GoalTarget, Measure, PjTask } from "../../drizzle/schema";
import { partsIn, zonedToUtc } from "../employees/schedule";
import { SCORE_ROWS, scoreCounter } from "../employees/coo";

/**
 * Goals: each workspace's own. Year goals roll up to company goals, quarter
 * (or 12-week cycle) goals roll up to year goals, and every goal can count
 * targets (a number, money, done or not, tasks, or a scorecard measure). The
 * weekly scorecard holds the measures, each with an owner and a weekly goal,
 * typed in or counted by the app. Goals are set by the owner and Simone
 * together: Simone suggests and drafts, the owner approves.
 */

const DAY = 86_400_000;
export type Owner = { type: "user" | "employee"; id: number; name: string; avatarUrl: string | null; kind?: string };
export type Status = "on" | "risk" | "off" | "done";

export const COLORS = ["#1b6b4a", "#2563eb", "#7c3aed", "#d97706", "#c2253c", "#0f766e", "#9a4f2c", "#475569"];

// ==========================================
// Dates (weeks start on Sunday)
// ==========================================

export async function zoneOf(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}
export function todayYmd(tz: string, at = new Date()) {
  const p = partsIn(at, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
export function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return t.toISOString().slice(0, 10);
}
/** The Sunday that starts the week holding `ymd`. */
export function sundayOf(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return addDays(ymd, -wd);
}
export function fmtDay(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

/** A period's dates and label: "2026", "Q4 2026", or a 12-week cycle from a start date. */
export function periodFor(level: Goal["level"], year: number, quarter = 1, cycleStart?: string, cycleNo = 1) {
  if (level === "quarter") {
    const sm = (quarter - 1) * 3 + 1;
    const start = `${year}-${String(sm).padStart(2, "0")}-01`;
    const end = addDays(`${sm + 3 > 12 ? year + 1 : year}-${String(sm + 3 > 12 ? 1 : sm + 3).padStart(2, "0")}-01`, -1);
    return { period: `Q${quarter} ${year}`, startDate: start, dueDate: end };
  }
  if (level === "cycle" && cycleStart && ymdOk(cycleStart)) return { period: `Cycle ${cycleNo}, ${cycleStart.slice(0, 4)}`, startDate: cycleStart, dueDate: addDays(cycleStart, 83) };
  return { period: String(year), startDate: `${year}-01-01`, dueDate: `${year}-12-31` };
}

// ==========================================
// Who can own a goal or a measure: people and employees
// ==========================================

export async function owners(orgId: number): Promise<Owner[]> {
  const people = (await db.listMembers(orgId)).filter((m) => m.role !== "reviewer");
  const emps = await db.listEmployeesByOrg(orgId);
  return [
    ...people.map((p) => ({ type: "user" as const, id: p.userId, name: p.name || p.email, avatarUrl: p.avatarUrl })),
    ...emps.map((e) => ({ type: "employee" as const, id: e.id, name: e.name, avatarUrl: e.avatar ?? null, kind: e.kind })),
  ];
}
export function ownerOf(list: Owner[], type: string | null, id: number | null) {
  return list.find((o) => o.type === type && o.id === id) ?? null;
}

// ==========================================
// Measures and the weekly scorecard
// ==========================================

export const SOURCES: { key: string; label: string; unit: Measure["unit"]; direction: Measure["direction"] }[] = [
  { key: "manual", label: "Typed in each week", unit: "number", direction: "up" },
  ...SCORE_ROWS.map((r) => ({ key: r.key, label: `Counted: ${r.label}`, unit: (r.unit === "%" ? "percent" : r.unit.trim() === "min" ? "number" : "number") as Measure["unit"], direction: (r.lowerIsBetter ? "down" : "up") as Measure["direction"] })),
  { key: "project_tasks_done", label: "Counted: Projects tasks done", unit: "number", direction: "up" },
];

export function measureStatus(value: number | null, goal: number | null, direction: Measure["direction"], recent: (number | null)[] = []): Status | null {
  if (value === null || goal === null) return null;
  const met = (v: number) => (direction === "up" ? v >= goal : v <= goal);
  if (met(value)) return "on";
  // Three weeks in a row under goal is off track, however close.
  const last3 = [...recent.slice(-2), value];
  if (last3.length === 3 && last3.every((v) => v !== null && !met(v))) return "off";
  const close = direction === "up" ? value >= goal * 0.9 : value <= goal * 1.1;
  return close ? "risk" : "off";
}

/** Each measure's numbers for the last `weeks` weeks (oldest first), with this week's status. */
export async function scorecard(orgId: number, weeks = 13) {
  const tz = await zoneOf(orgId);
  const thisWeek = sundayOf(todayYmd(tz));
  const starts = Array.from({ length: weeks }, (_, i) => addDays(thisWeek, -7 * (weeks - 1 - i)));
  const list = db.work.measures.all(orgId).filter((m) => m.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const stored = db.work.values.all(orgId);
  const needsCount = list.some((m) => m.source !== "manual");
  const counter = needsCount ? await scoreCounter(orgId) : null;
  const tasks = list.some((m) => m.source === "project_tasks_done") ? db.work.tasks.all(orgId) : [];
  const at = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return zonedToUtc(y, m, d, 0, 0, tz);
  };
  const rows = list.map((m) => {
    const values = starts.map((w): number | null => {
      if (m.source === "manual") return stored.find((v) => v.measureId === m.id && v.weekStart === w)?.value ?? null;
      const a = at(w);
      const b = at(addDays(w, 7));
      if (a.getTime() > Date.now()) return null;
      if (m.source === "project_tasks_done") return tasks.filter((t) => t.closedAt && new Date(t.closedAt) >= a && new Date(t.closedAt) < b).length;
      return counter ? counter(m.source, a, b) : null;
    });
    const value = values[values.length - 1];
    const status = measureStatus(value, m.weeklyGoal, m.direction, values.slice(0, -1));
    const hit = values.filter((v) => v !== null && m.weeklyGoal !== null && (m.direction === "up" ? v >= m.weeklyGoal : v <= m.weeklyGoal)).length;
    const counted = values.filter((v) => v !== null).length;
    return { measure: m, values, value, status, hit, counted, sourceLabel: SOURCES.find((s) => s.key === m.source)?.label ?? "Typed in each week" };
  });
  return { thisWeek, weeks: starts, rows };
}

export async function setMeasureValue(orgId: number, measureId: number, weekStart: string, value: number | null, by: string) {
  const m = db.work.measures.get(orgId, measureId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That measure isn't on the scorecard." });
  if (m.source !== "manual") throw new TRPCError({ code: "BAD_REQUEST", message: "The app counts this number itself." });
  if (!ymdOk(weekStart)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a week." });
  db.work.setValue(orgId, measureId, sundayOf(weekStart), value, by);
}

export type MeasureInput = { id?: number; name: string; ownerType: "user" | "employee" | null; ownerId: number | null; weeklyGoal: number | null; unit: Measure["unit"]; direction: Measure["direction"]; kind: Measure["kind"]; source: string; goalId: number | null };

/** Saves the whole scorecard from Edit: changed rows, new rows, and removed rows (left out). */
export function saveScorecard(orgId: number, rows: MeasureInput[]) {
  const have = db.work.measures.all(orgId).filter((m) => m.active);
  const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
  for (const m of have) if (!keep.has(m.id)) db.work.measures.update(orgId, m.id, { active: false });
  rows.forEach((r, i) => {
    const name = r.name.trim().slice(0, 120);
    if (!name) return;
    const source = SOURCES.some((s) => s.key === r.source) ? r.source : "manual";
    const row = { name, ownerType: r.ownerType, ownerId: r.ownerId, weeklyGoal: r.weeklyGoal, unit: r.unit, direction: r.direction, kind: r.kind, source, goalId: r.goalId, sort: i };
    if (r.id && have.some((m) => m.id === r.id)) db.work.measures.update(orgId, r.id, row);
    else db.work.measures.insert({ organizationId: orgId, ...row });
  });
}

// ==========================================
// Goal progress, pace and status
// ==========================================

type Ctx = { tasks: PjTask[]; targets: GoalTarget[]; goals: Goal[]; latest: Map<number, number | null> };

function targetProgress(t: GoalTarget, goal: Goal, c: Ctx): number {
  switch (t.kind) {
    case "boolean":
      return t.done ? 1 : 0;
    case "tasks": {
      const list = c.tasks.filter((x) => !x.parentId && (t.listId ? x.listId === t.listId : x.goalId === goal.id));
      return list.length ? list.filter((x) => x.closedAt).length / list.length : 0;
    }
    case "measure": {
      const v = t.measureId ? c.latest.get(t.measureId) ?? null : null;
      return v === null || !t.targetValue ? 0 : Math.max(0, Math.min(1, v / t.targetValue));
    }
    default: {
      const span = t.targetValue - t.startValue;
      if (span === 0) return t.currentValue >= t.targetValue ? 1 : 0;
      return Math.max(0, Math.min(1, (t.currentValue - t.startValue) / span));
    }
  }
}

/** Progress from 0 to 100: the targets' average, else the sub-goals' average, else what the owner set. */
export function progressOf(goal: Goal, c: Ctx, depth = 0): number {
  const ts = c.targets.filter((t) => t.goalId === goal.id);
  if (ts.length) return Math.round((ts.reduce((s, t) => s + targetProgress(t, goal, c), 0) / ts.length) * 100);
  const kids = c.goals.filter((g) => g.parentId === goal.id && g.state === "active");
  if (kids.length && depth < 4) return Math.round(kids.reduce((s, g) => s + progressOf(g, c, depth + 1), 0) / kids.length);
  return goal.manualProgress ?? 0;
}

/** Where the goal should be by now, from 0 to 100. */
export function expectedOf(goal: Goal, today: string) {
  const total = daysBetween(goal.startDate, goal.dueDate);
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((daysBetween(goal.startDate, today) / total) * 100)));
}

export function statusOf(goal: Goal, progress: number, today: string, lastUpdate: Status | null): Status {
  if (goal.state === "done" || progress >= 100) return "done";
  if (goal.status) return goal.status;
  if (lastUpdate) return lastUpdate;
  const expected = expectedOf(goal, today);
  if (expected <= 5 || progress >= expected - 5) return "on";
  if (progress >= expected * 0.75) return "risk";
  return "off";
}

/** The money or number target's line over time, the pace to the goal, and where it lands at this pace. */
export function forecastOf(goal: Goal, t: GoalTarget | undefined, today: string) {
  if (!t || (t.kind !== "currency" && t.kind !== "number")) return null;
  let hist: { d: string; v: number }[] = [];
  try {
    hist = JSON.parse(t.history || "[]");
  } catch {
    hist = [];
  }
  hist = hist.filter((h) => ymdOk(h.d) && Number.isFinite(h.v)).sort((a, b) => a.d.localeCompare(b.d));
  if (!hist.length || hist[0].d > goal.startDate) hist.unshift({ d: goal.startDate, v: t.startValue });
  if (hist[hist.length - 1].d < today && today <= goal.dueDate) hist.push({ d: today, v: t.currentValue });
  const elapsed = Math.max(1, daysBetween(goal.startDate, today));
  const left = Math.max(0, daysBetween(today, goal.dueDate));
  const rate = (t.currentValue - t.startValue) / elapsed;
  const landing = Math.round(t.currentValue + rate * left);
  return { kind: t.kind, start: goal.startDate, end: goal.dueDate, today, startValue: t.startValue, target: t.targetValue, current: t.currentValue, landing, history: hist, perDayNeeded: left ? Math.round((t.targetValue - t.currentValue) / left) : 0 };
}

// ==========================================
// Everything the Goals page shows
// ==========================================

export async function overview(orgId: number) {
  const tz = await zoneOf(orgId);
  const today = todayYmd(tz);
  const people = await owners(orgId);
  const goals = db.work.goals.all(orgId).filter((g) => g.state !== "dismissed" && g.state !== "archived");
  const targets = db.work.targets.all(orgId);
  const tasks = db.work.tasks.all(orgId);
  const updates = db.work.updates.all(orgId).sort((a, b) => b.id - a.id);
  const card = await scorecard(orgId);
  const latest = new Map(card.rows.map((r) => [r.measure.id, r.value]));
  const c: Ctx = { tasks, targets, goals, latest };
  const files = db.work.filesFor(orgId, "goal", goals.map((g) => g.id));
  const rows = goals
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((g) => {
      const progress = progressOf(g, c);
      const last = updates.find((u) => u.goalId === g.id) ?? null;
      const ts = targets.filter((t) => t.goalId === g.id).sort((a, b) => a.sort - b.sort || a.id - b.id);
      const support = tasks.filter((t) => t.goalId === g.id && !t.parentId);
      return {
        goal: g,
        owner: ownerOf(people, g.ownerType, g.ownerId),
        progress,
        expected: expectedOf(g, today),
        status: g.state === "active" || g.state === "done" ? statusOf(g, progress, today, (last?.status as Status) ?? null) : null,
        lastUpdate: last ? { author: last.authorName, at: last.createdAt, status: last.status, body: last.body } : null,
        targets: ts.map((t) => ({ ...t, progress: Math.round(targetProgress(t, g, c) * 100), tasksDone: t.kind === "tasks" ? tasks.filter((x) => !x.parentId && (t.listId ? x.listId === t.listId : x.goalId === g.id) && x.closedAt).length : null, tasksTotal: t.kind === "tasks" ? tasks.filter((x) => !x.parentId && (t.listId ? x.listId === t.listId : x.goalId === g.id)).length : null, measureValue: t.measureId ? latest.get(t.measureId) ?? null : null })),
        forecast: forecastOf(g, ts.find((t) => t.kind === "currency") ?? ts.find((t) => t.kind === "number"), today),
        supporting: support.length + goals.filter((x) => x.parentId === g.id && x.state === "active").length,
        tasks: support.map((t) => ({ id: t.id, name: t.name, status: t.status, done: !!t.closedAt, dueDate: t.dueDate, assignees: parseJson<{ name: string }[]>(t.assignees, []).map((a) => a.name) })),
        files: files.filter((f) => f.link.itemId === g.id).map((f) => ({ linkId: f.link.id, id: f.file!.id, name: f.file!.name, url: f.file!.fileUrl, kind: f.file!.kind, size: f.file!.size })),
      };
    });
  const read = db.work.reads.all(orgId).filter((r) => r.weekStart !== "layout").sort((a, b) => b.id - a.id)[0] ?? null;
  const layoutRow = db.work.reads.all(orgId).find((r) => r.weekStart === "layout") ?? null;
  return {
    today,
    people,
    folders: db.work.goalFolders.all(orgId).sort((a, b) => a.sort - b.sort || a.id - b.id),
    goals: rows,
    scorecard: { ...card, rows: card.rows.map((r) => ({ ...r, owner: ownerOf(people, r.measure.ownerType, r.measure.ownerId), goal: goals.find((g) => g.id === r.measure.goalId)?.title ?? null })) },
    read: read ? { weekStart: read.weekStart, note: read.note, items: parseJson<ReadItem[]>(read.items, []), at: read.createdAt } : null,
    layout: layoutRow ? parseJson<DashCard[]>(layoutRow.items, DEFAULT_LAYOUT) : DEFAULT_LAYOUT,
    sources: SOURCES,
    today_: todayWork(orgId, today, tasks, goals, people),
    team: teamStats(orgId, today, people, rows, card, tasks),
  };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export type ReadItem = { status: Status; text: string; action: string; goalId?: number | null; measureId?: number | null };
export type DashCard = { id: string; type: "revenue" | "measure" | "goals" | "scorecard" | "chart" | "read" | "donut" | "bars" | "funnel"; span: 3 | 4 | 6 | 8 | 12; goalId?: number | null; measureIds?: number[]; title?: string };
export const DEFAULT_LAYOUT: DashCard[] = [
  { id: "c1", type: "revenue", span: 3 },
  { id: "c2", type: "measure", span: 3, measureIds: [] },
  { id: "c3", type: "goals", span: 3 },
  { id: "c4", type: "scorecard", span: 3 },
  { id: "c5", type: "chart", span: 8 },
  { id: "c6", type: "read", span: 4 },
  { id: "c7", type: "donut", span: 4, measureIds: [] },
  { id: "c8", type: "bars", span: 4, measureIds: [] },
  { id: "c9", type: "funnel", span: 4, measureIds: [] },
];

/** Today: open tasks due today or late, and tasks finished today, each with the goal it moves. */
function todayWork(orgId: number, today: string, tasks: PjTask[], goals: Goal[], people: Owner[]) {
  const lists = db.work.lists.all(orgId);
  const doneToday = (t: PjTask) => !!t.closedAt && todayYmdUtc(t.closedAt) === today;
  return tasks
    .filter((t) => (!t.closedAt && t.dueDate && t.dueDate <= today) || doneToday(t))
    .sort((a, b) => (a.closedAt ? 1 : 0) - (b.closedAt ? 1 : 0) || (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    .slice(0, 80)
    .map((t) => {
      const as = parseJson<{ type: string; id: number; name: string }[]>(t.assignees, []);
      const list = lists.find((l) => l.id === t.listId);
      const statuses = parseJson<{ name: string; type: string }[]>(list?.statuses, []);
      return {
        id: t.id,
        name: t.name,
        listName: list?.name ?? "",
        dueDate: t.dueDate,
        late: !t.closedAt && !!t.dueDate && t.dueDate < today,
        done: !!t.closedAt,
        status: t.status,
        waiting: /review|ok|approv/i.test(t.status) && statuses.find((s) => s.name === t.status)?.type !== "done",
        who: as.map((a) => ownerOf(people, a.type, a.id) ?? { type: "user" as const, id: 0, name: a.name, avatarUrl: null }),
        goal: goals.find((g) => g.id === t.goalId)?.title ?? null,
      };
    });
}
function todayYmdUtc(d: Date) {
  return new Date(d).toISOString().slice(0, 10);
}

/** People: each person's and employee's goals, how often they hit their measures, and what they moved this week. */
function teamStats(orgId: number, today: string, people: Owner[], rows: { goal: Goal; status: Status | null; owner: Owner | null }[], card: Awaited<ReturnType<typeof scorecard>>, tasks: PjTask[]) {
  const weekStart = sundayOf(today);
  const closedThisWeek = tasks.filter((t) => t.closedAt && todayYmdUtc(t.closedAt) >= weekStart);
  const out = people.map((p) => {
    const mine = rows.filter((r) => r.goal.state === "active" && r.owner?.type === p.type && r.owner.id === p.id);
    const ms = card.rows.filter((r) => r.measure.ownerType === p.type && r.measure.ownerId === p.id);
    const done = closedThisWeek.filter((t) => parseJson<{ type: string; id: number }[]>(t.assignees, []).some((a) => a.type === p.type && a.id === p.id));
    const updates = db.work.updates.all(orgId).filter((u) => u.authorType === p.type && u.authorId === p.id && todayYmdUtc(u.createdAt) >= weekStart);
    return {
      owner: p,
      goals: mine.length,
      goalsOn: mine.filter((r) => r.status === "on" || r.status === "done").length,
      hit: ms.reduce((s, r) => s + r.hit, 0),
      counted: ms.reduce((s, r) => s + r.counted, 0),
      moved: [...done.slice(0, 4).map((t) => t.name), ...updates.slice(0, 2).map((u) => `Update: ${u.body.slice(0, 80)}`)],
      tasksDone: done.length,
    };
  });
  const empDone = closedThisWeek.filter((t) => parseJson<{ type: string }[]>(t.assignees, []).some((a) => a.type === "employee"));
  return { people: out.filter((x) => x.goals || x.counted || x.tasksDone || x.owner.type === "user"), employeeTasks: empDone.length, employeeTasksOnGoals: empDone.filter((t) => t.goalId).length };
}

// ==========================================
// Changing goals
// ==========================================

export type GoalInput = {
  id?: number;
  title: string;
  description: string;
  level: Goal["level"];
  parentId: number | null;
  folderId: number | null;
  ownerType: "user" | "employee" | null;
  ownerId: number | null;
  startDate: string;
  dueDate: string;
  period: string;
  color: string;
  status: Status | null;
  manualProgress: number | null;
  targets?: { id?: number; kind: GoalTarget["kind"]; name: string; startValue: number; currentValue: number; targetValue: number; done: boolean; listId: number | null; measureId: number | null }[];
};

export function saveGoal(orgId: number, input: GoalInput, by: string) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the goal a name." });
  if (!ymdOk(input.startDate) || !ymdOk(input.dueDate) || input.dueDate < input.startDate) throw new TRPCError({ code: "BAD_REQUEST", message: "Check the start and due dates." });
  if (input.parentId && input.parentId === input.id) throw new TRPCError({ code: "BAD_REQUEST", message: "A goal can't roll up to itself." });
  const row = {
    title,
    description: input.description.slice(0, 4000),
    level: input.level,
    parentId: input.parentId,
    folderId: input.folderId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    startDate: input.startDate,
    dueDate: input.dueDate,
    period: input.period.slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : COLORS[0],
    status: input.status,
    manualProgress: input.manualProgress === null ? null : Math.max(0, Math.min(100, Math.round(input.manualProgress))),
  };
  let goal: Goal;
  if (input.id) {
    const have = db.work.goals.get(orgId, input.id);
    if (!have) throw new TRPCError({ code: "NOT_FOUND", message: "That goal isn't in this workspace." });
    goal = db.work.goals.update(orgId, input.id, row)!;
  } else goal = db.work.goals.insert({ organizationId: orgId, ...row, setBy: by, state: "active" });
  if (input.targets) saveTargets(orgId, goal.id, input.targets);
  return goal;
}

function saveTargets(orgId: number, goalId: number, list: NonNullable<GoalInput["targets"]>) {
  const have = db.work.targets.where(orgId, "goalId", goalId);
  const keep = new Set(list.filter((t) => t.id).map((t) => t.id));
  for (const t of have) if (!keep.has(t.id)) db.work.targets.remove(orgId, t.id);
  const today = new Date().toISOString().slice(0, 10);
  list.forEach((t, i) => {
    const name = t.name.trim().slice(0, 120);
    if (!name) return;
    const row = { kind: t.kind, name, startValue: Math.round(t.startValue), currentValue: Math.round(t.currentValue), targetValue: Math.round(t.targetValue), done: t.done, listId: t.listId, measureId: t.measureId, sort: i };
    const old = t.id ? have.find((x) => x.id === t.id) : null;
    if (old) {
      const history = old.currentValue !== row.currentValue ? addHistory(old.history, today, row.currentValue) : old.history;
      db.work.targets.update(orgId, old.id, { ...row, history });
    } else db.work.targets.insert({ organizationId: orgId, goalId, ...row, history: JSON.stringify([{ d: today, v: row.currentValue }]) });
  });
}

function addHistory(raw: string, d: string, v: number) {
  const h = parseJson<{ d: string; v: number }[]>(raw, []).filter((x) => x.d !== d);
  h.push({ d, v });
  return JSON.stringify(h.sort((a, b) => a.d.localeCompare(b.d)).slice(-400));
}

/** A new current value for a target (from the side panel, or an employee's update). */
export function setTargetValue(orgId: number, targetId: number, value: number | null, done?: boolean) {
  const t = db.work.targets.get(orgId, targetId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That target isn't in this workspace." });
  const patch: Partial<GoalTarget> = {};
  if (done !== undefined) patch.done = done;
  if (value !== null && Number.isFinite(value)) {
    patch.currentValue = Math.round(value);
    patch.history = addHistory(t.history, new Date().toISOString().slice(0, 10), Math.round(value));
  }
  return db.work.targets.update(orgId, targetId, patch);
}

export function removeGoal(orgId: number, id: number) {
  const g = db.work.goals.get(orgId, id);
  if (!g) throw new TRPCError({ code: "NOT_FOUND", message: "That goal isn't in this workspace." });
  for (const kid of db.work.goals.where(orgId, "parentId", id)) db.work.goals.update(orgId, kid.id, { parentId: g.parentId });
  db.work.goals.update(orgId, id, { state: "archived" });
}

/** The owner approves a goal Simone suggested or drafted. */
export function approveGoal(orgId: number, id: number, who: string) {
  const g = db.work.goals.get(orgId, id);
  if (!g || (g.state !== "suggested" && g.state !== "draft")) throw new TRPCError({ code: "NOT_FOUND", message: "That goal isn't waiting for you." });
  return db.work.goals.update(orgId, id, { state: "active", agreedBy: who, agreedAt: new Date() });
}
export function dismissGoal(orgId: number, id: number) {
  const g = db.work.goals.get(orgId, id);
  if (!g || (g.state !== "suggested" && g.state !== "draft")) throw new TRPCError({ code: "NOT_FOUND", message: "That goal isn't waiting for you." });
  db.work.goals.update(orgId, id, { state: "dismissed" });
}

export function addUpdate(orgId: number, goalId: number, input: { authorType: "user" | "employee"; authorId: number | null; authorName: string; status: Status | null; body: string }) {
  const g = db.work.goals.get(orgId, goalId);
  if (!g) throw new TRPCError({ code: "NOT_FOUND", message: "That goal isn't in this workspace." });
  const body = input.body.trim().slice(0, 4000);
  if (!body) throw new TRPCError({ code: "BAD_REQUEST", message: "Write the update." });
  return db.work.updates.insert({ organizationId: orgId, goalId, ...input, body });
}

export function goalUpdates(orgId: number, goalId: number) {
  const list = db.work.updates.where(orgId, "goalId", goalId).sort((a, b) => b.id - a.id).slice(0, 50);
  const files = db.work.filesFor(orgId, "update", list.map((u) => u.id));
  return list.map((u) => ({ ...u, files: files.filter((f) => f.link.itemId === u.id).map((f) => ({ id: f.file!.id, name: f.file!.name, url: f.file!.fileUrl, kind: f.file!.kind })) }));
}

export function saveFolder(orgId: number, input: { id?: number; name: string; color: string; parentId: number | null }) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the folder." });
  const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : COLORS[0];
  if (input.id) return db.work.goalFolders.update(orgId, input.id, { name, color, parentId: input.parentId });
  return db.work.goalFolders.insert({ organizationId: orgId, name, color, parentId: input.parentId, sort: db.work.goalFolders.all(orgId).length });
}
export function removeFolder(orgId: number, id: number) {
  for (const g of db.work.goals.where(orgId, "folderId", id)) db.work.goals.update(orgId, g.id, { folderId: null });
  for (const f of db.work.goalFolders.where(orgId, "parentId", id)) db.work.goalFolders.update(orgId, f.id, { parentId: null });
  db.work.goalFolders.remove(orgId, id);
}

export function saveLayout(orgId: number, cards: DashCard[]) {
  const row = db.work.reads.all(orgId).find((r) => r.weekStart === "layout");
  const items = JSON.stringify(cards.slice(0, 30));
  if (row) db.work.reads.update(orgId, row.id, { items });
  else db.work.reads.insert({ organizationId: orgId, weekStart: "layout", items });
}

// ==========================================
// Attachments on goals, updates, tasks and comments
// ==========================================

export function attach(orgId: number, itemType: "goal" | "task" | "comment" | "update", itemId: number, fileIds: number[], by: string) {
  const files = db.getChatFiles(orgId, fileIds);
  for (const f of files) db.work.files.insert({ organizationId: orgId, itemType, itemId, fileId: f.id, addedBy: by });
  return files.length;
}
export function detach(orgId: number, linkId: number) {
  db.work.files.remove(orgId, linkId);
}
