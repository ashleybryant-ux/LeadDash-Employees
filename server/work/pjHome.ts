import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjList, PjTask } from "../../drizzle/schema";
import { owners, todayYmd, zoneOf } from "./goals";
import { LEVEL_RANK, levelFor, mustMember, visibleLists, type Viewer } from "./pjAccess";
import { activity, addDaysYmd, fmtYmd, parse, statusesOf, updateTask, removeTask, type Actor, type Assignee, type TaskInput } from "./projects";

/**
 * The Projects Home page, and the pieces that keep a workspace groomed:
 *
 * - Needs attention: open tasks with no date, no owner, or a date that has
 *   passed. Each comes with Nora's suggestion (an owner, a date), which the
 *   person applies one at a time, or all at once ("Let Nora fix these").
 * - Home: those, then the open tasks by when (today, this week, later), what
 *   each AI employee did last, and each project's health.
 * - Bulk changes to many tasks at once, and reordering the rows in a group.
 */

export type Health = "on" | "risk" | "off" | "done";
export const HEALTH_TEXT: Record<Health, string> = { on: "On track", risk: "At risk", off: "Off track", done: "Done" };

/** A project's health from its open tasks: off track when a third or more are late, at risk when any is. */
export function healthOf(open: number, overdue: number): Health {
  if (!open) return "done";
  if (overdue && overdue / open >= 1 / 3) return "off";
  return overdue ? "risk" : "on";
}

type Reason = "owner" | "date" | "overdue";
const REASON_TEXT: Record<Reason, string> = { owner: "No owner", date: "No date", overdue: "Overdue" };

const who = (t: PjTask) => parse<Assignee[]>(t.assignees, []);

/** The person (or employee) who holds the most open tasks in a list, so a new task goes to whoever runs that project. */
function leadOf(tasks: PjTask[]): Assignee | null {
  const n = new Map<string, { a: Assignee; n: number }>();
  for (const t of tasks) for (const a of who(t)) {
    const k = `${a.type}:${a.id}:${a.name}`;
    n.set(k, { a, n: (n.get(k)?.n ?? 0) + 1 });
  }
  return Array.from(n.values()).sort((x, y) => y.n - x.n)[0]?.a ?? null;
}

/** The next weekday on or after a day (a task is never due on a weekend). */
export function nextWeekday(ymd: string) {
  let d = ymd;
  for (let i = 0; i < 3; i++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) return d;
    d = addDaysYmd(d, 1);
  }
  return d;
}

export type Suggestion = { say: string; patch: TaskInput };

/** Nora's fix for a task that needs attention: an owner, a date, or a new date. */
export function suggestFor(t: PjTask, reasons: Reason[], siblings: PjTask[], today: string, fallback: Assignee | null): Suggestion | null {
  const patch: TaskInput = {};
  const parts: string[] = [];
  if (reasons.includes("owner")) {
    const lead = leadOf(siblings.filter((s) => s.id !== t.id && !s.closedAt)) ?? fallback;
    if (lead) {
      patch.assignees = [lead];
      parts.push(`give it to ${lead.name}`);
    }
  }
  if (reasons.includes("date")) {
    // The soonest open due date in the same list that is still ahead, else a week from today.
    const ahead = siblings.filter((s) => s.id !== t.id && !s.closedAt && s.dueDate && s.dueDate >= today).map((s) => s.dueDate!).sort()[0];
    const due = nextWeekday(ahead ?? addDaysYmd(today, 7));
    patch.dueDate = due;
    parts.push(`due ${fmtYmd(due)}`);
  } else if (reasons.includes("overdue")) {
    const due = nextWeekday(today);
    patch.dueDate = due;
    parts.push(`move it to ${due === today ? "today" : fmtYmd(due)}`);
  }
  if (!parts.length) return null;
  return { say: parts.join(", "), patch };
}

export type Attention = ReturnType<typeof attention>["tasks"][number];

/** Open tasks that need a person: no owner, no date, or a date that has passed. Subtasks are their parent's business. */
export function attention(orgId: number, v: Viewer, today: string, fallback: Assignee | null) {
  const vis = visibleLists(orgId, v);
  const lists = new Map(vis.map((x) => [x.list.id, x]));
  const all = db.work.tasks.all(orgId);
  const folders = new Map(db.work.folders.all(orgId).map((f) => [f.id, f]));
  const out = all
    .filter((t) => !t.closedAt && !t.parentId && lists.has(t.listId))
    .map((t) => {
      const reasons: Reason[] = [];
      if (!who(t).length) reasons.push("owner");
      if (!t.dueDate) reasons.push("date");
      else if (t.dueDate < today) reasons.push("overdue");
      return { t, reasons };
    })
    .filter((x) => x.reasons.length)
    .sort((a, b) => (a.t.dueDate ?? "9999").localeCompare(b.t.dueDate ?? "9999") || a.t.id - b.t.id)
    .map(({ t, reasons }) => {
      const l = lists.get(t.listId)!;
      const suggestion = LEVEL_RANK[l.level] >= LEVEL_RANK.edit ? suggestFor(t, reasons, all.filter((s) => s.listId === t.listId && !s.parentId), today, fallback) : null;
      return {
        id: t.id,
        name: t.name,
        listId: t.listId,
        listName: l.list.name,
        folderName: l.list.folderId ? folders.get(l.list.folderId)?.name ?? null : null,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        assignees: who(t),
        reasons,
        why: reasons.map((r) => REASON_TEXT[r]).join(", "),
        suggestion,
      };
    });
  return { tasks: out, total: out.length };
}

/** Nora applies her suggestions: to the tasks named, or to every task that needs attention. */
export async function fixAttention(orgId: number, v: Viewer, ids: number[] | null, by: Actor) {
  mustMember(v);
  const today = todayYmd(await zoneOf(orgId));
  const fallback = v.kind === "member" ? { type: "user" as const, id: v.userId, name: v.name } : null;
  const nora = await db.getEmployeeByKind(orgId, "projects");
  const actor: Actor = nora ? { type: "employee", id: nora.id, name: nora.name } : by;
  let fixed = 0;
  const said: string[] = [];
  for (const a of attention(orgId, v, today, fallback).tasks) {
    if (ids && !ids.includes(a.id)) continue;
    if (!a.suggestion) continue;
    await updateTask(orgId, a.id, a.suggestion.patch, actor, { quiet: true });
    activity(orgId, a.id, actor, `${actor.name} ${a.suggestion.say.replace(/^give it to/, "gave this to").replace(/^due /, "set the due date to ").replace(/^move it to/, "moved the due date to")}`);
    fixed++;
    if (a.suggestion.patch.dueDate) said.push("date");
    if (a.suggestion.patch.assignees) said.push("owner");
  }
  if (fixed) {
    const dates = said.filter((s) => s === "date").length;
    const ownersSet = said.filter((s) => s === "owner").length;
    const bits = [dates ? `dates on ${dates}` : "", ownersSet ? `owners on ${ownersSet}` : ""].filter(Boolean).join(", ");
    await db.addActivity({ organizationId: orgId, employeeId: nora?.id ?? null, kind: "done", text: `Groomed ${fixed} task${fixed === 1 ? "" : "s"} in Projects: ${bits}.`, link: "/projects" });
  }
  return { fixed };
}

// ==========================================
// Home
// ==========================================

const fmtWhen = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The Home page: what needs a person, the open tasks by when, what the AI team is on, and each project's health. */
export async function home(orgId: number, v: Viewer) {
  mustMember(v);
  const tz = await zoneOf(orgId);
  const today = todayYmd(tz);
  const me: Assignee | null = v.kind === "member" ? { type: "user", id: v.userId, name: v.name } : null;
  const vis = visibleLists(orgId, v);
  const visIds = new Set(vis.map((x) => x.list.id));
  const folders = new Map(db.work.folders.all(orgId).map((f) => [f.id, f]));
  const all = db.work.tasks.all(orgId).filter((t) => visIds.has(t.listId));
  const open = all.filter((t) => !t.closedAt && !t.parentId);
  const manager = v.kind === "member" && (v.role === "owner" || v.role === "admin");
  // Owners and admins see everyone's work by when; everyone else sees their own.
  const mine = manager ? open : open.filter((t) => me && who(t).some((a) => a.type === me.type && a.id === me.id));
  const weekEnd = addDaysYmd(today, 7);
  const row = (t: PjTask) => {
    const l = vis.find((x) => x.list.id === t.listId)!.list;
    return { id: t.id, name: t.name, listId: t.listId, listName: l.name, status: t.status, priority: t.priority, dueDate: t.dueDate, assignees: who(t), closed: !!t.closedAt };
  };
  const byDue = (a: PjTask, b: PjTask) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.id - b.id;
  const need = attention(orgId, v, today, me);
  const shownNeed = new Set(need.tasks.slice(0, 8).map((t) => t.id));
  const dated = mine.filter((t) => t.dueDate).sort(byDue);
  // Today holds what is due today and anything late that Needs attention above did not already show.
  const todayRows = dated.filter((t) => t.dueDate! <= today && !shownNeed.has(t.id));
  const weekRows = dated.filter((t) => t.dueDate! > today && t.dueDate! <= weekEnd);
  const laterRows = dated.filter((t) => t.dueDate! > weekEnd);
  // What each employee did last, and whether it is on something now.
  const emps = await db.listEmployeesByOrg(orgId);
  const acts = await db.listActivity(orgId, 300);
  const team = emps
    .filter((e) => e.status !== "paused")
    .map((e) => {
      const last = acts.find((a) => a.employeeId === e.id && a.kind !== "handoff");
      const on = open.find((t) => t.status !== statusesOf(vis.find((x) => x.list.id === t.listId)!.list)[0].name && who(t).some((a) => a.type === "employee" && a.id === e.id));
      const recent = !!last && Date.now() - new Date(last.createdAt).getTime() < 36 * 3_600_000;
      return { id: e.id, name: e.name, kind: e.kind, avatar: e.avatar ?? null, working: e.status === "working", active: e.status === "working" || !!on || recent, line: e.status === "working" && on ? `Working on "${on.name}".` : recent ? last!.text : on ? `On "${on.name}".` : "Nothing yet today.", at: e.status === "working" ? null : recent ? fmtWhen(last!.createdAt) : null, taskId: on?.id ?? null };
    })
    .sort((a, b) => Number(b.active) - Number(a.active));
  // Projects: every list with open tasks, its progress, its last date and its health.
  const projects = vis
    .map((x) => x.list)
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((l: PjList) => {
      const ts = all.filter((t) => t.listId === l.id && !t.parentId);
      const op = ts.filter((t) => !t.closedAt);
      const overdue = op.filter((t) => t.dueDate && t.dueDate < today).length;
      const ends = ts.map((t) => t.dueDate).filter(Boolean) as string[];
      return { id: l.id, name: l.name, folderName: l.folderId ? folders.get(l.folderId)?.name ?? null : null, folderColor: l.folderId ? folders.get(l.folderId)?.color ?? null : null, open: op.length, done: ts.length - op.length, total: ts.length, overdue, due: ends.length ? ends.sort().at(-1)! : null, health: healthOf(op.length, overdue) };
    })
    .filter((p) => p.total > 0);
  return {
    today,
    attention: need.tasks.slice(0, 8),
    attentionTotal: need.total,
    todayTasks: todayRows.map(row),
    week: weekRows.map(row),
    later: laterRows.map(row),
    undated: mine.filter((t) => !t.dueDate).length,
    team,
    projects,
    people: await owners(orgId),
    lists: vis.map((x) => ({ id: x.list.id, name: x.list.name, statuses: statusesOf(x.list), level: x.level })),
    mineOnly: !manager,
  };
}

// ==========================================
// Many tasks at once
// ==========================================

export type BulkPatch = { status?: string; priority?: PjTask["priority"]; dueDate?: string | null; startDate?: string | null; assign?: Assignee[]; unassign?: Assignee[]; listId?: number; tags?: string[] };

/** One change on many tasks: status, priority, dates, people added or removed, a move to another list, or delete. Tasks the person can't change are skipped, as is a status a task's list doesn't have. */
export async function bulk(orgId: number, v: Viewer, ids: number[], change: { action: "update"; patch: BulkPatch } | { action: "remove" }, by: Actor) {
  const uniq = Array.from(new Set(ids)).slice(0, 200);
  let changed = 0;
  let skipped = 0;
  for (const id of uniq) {
    const t = db.work.tasks.get(orgId, id);
    const list = t ? db.work.lists.get(orgId, t.listId) : null;
    const level = t && list ? levelFor(orgId, v, list) : null;
    if (!t || !list || !level || LEVEL_RANK[level] < LEVEL_RANK.edit) {
      skipped++;
      continue;
    }
    if (change.action === "remove") {
      removeTask(orgId, id);
      changed++;
      continue;
    }
    const p = change.patch;
    const patch: TaskInput = {};
    if (p.status !== undefined) {
      const target = p.listId ? db.work.lists.get(orgId, p.listId) : list;
      if (!target || !statusesOf(target).some((s) => s.name === p.status)) {
        skipped++;
        continue;
      }
      patch.status = p.status;
    }
    if (p.priority !== undefined) patch.priority = p.priority;
    if (p.dueDate !== undefined) patch.dueDate = p.dueDate;
    if (p.startDate !== undefined) patch.startDate = p.startDate;
    if (p.tags !== undefined) patch.tags = p.tags;
    if (p.listId !== undefined && p.listId !== t.listId) {
      const target = db.work.lists.get(orgId, p.listId);
      const lvl = target ? levelFor(orgId, v, target) : null;
      if (!target || !lvl || LEVEL_RANK[lvl] < LEVEL_RANK.edit) {
        skipped++;
        continue;
      }
      patch.listId = p.listId;
    }
    if (p.assign || p.unassign) {
      let people = who(t);
      for (const a of p.assign ?? []) if (!people.some((b) => b.type === a.type && b.id === a.id && b.name === a.name)) people = [...people, a];
      if (p.unassign) people = people.filter((b) => !p.unassign!.some((a) => a.type === b.type && a.id === b.id && a.name === b.name));
      patch.assignees = people;
    }
    if (!Object.keys(patch).length) {
      skipped++;
      continue;
    }
    await updateTask(orgId, id, patch, by);
    changed++;
  }
  if (!changed && skipped) throw new TRPCError({ code: "FORBIDDEN", message: "None of those tasks could be changed." });
  return { changed, skipped };
}

/** The rows of a group in the order the person dragged them: each task's sort follows its place. */
export function reorder(orgId: number, v: Viewer, ids: number[]) {
  const tasks = ids.map((id) => db.work.tasks.get(orgId, id)).filter((t): t is PjTask => !!t);
  if (!tasks.length) return { ok: true };
  for (const t of tasks) {
    const list = db.work.lists.get(orgId, t.listId);
    const level = list ? levelFor(orgId, v, list) : null;
    if (!level || LEVEL_RANK[level] < LEVEL_RANK.edit) throw new TRPCError({ code: "FORBIDDEN", message: `You can't change ${list?.name ?? "that list"}.` });
  }
  // The group keeps its place among the other rows: its new sorts start at its smallest old one.
  const base = Math.min(...tasks.map((t) => t.sort));
  tasks.forEach((t, i) => db.work.tasks.update(orgId, t.id, { sort: base + i }));
  return { ok: true };
}

/** For the morning check: how many tasks need a person, in a line for the chat. */
export async function attentionLine(orgId: number) {
  const n = attention(orgId, { kind: "system" }, todayYmd(await zoneOf(orgId)), null).total;
  if (!n) return "";
  return `${n} task${n === 1 ? "" : "s"} in Projects need${n === 1 ? "s" : ""} a person: no date, no owner, or overdue. Home shows them with my suggested fixes.`;
}
