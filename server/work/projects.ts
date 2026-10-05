import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjList, PjTask } from "../../drizzle/schema";
import { notify } from "../notify";
import { owners, ownerOf, todayYmd, zoneOf, type Owner } from "./goals";

/**
 * Projects, in place of ClickUp: folders hold lists, lists hold tasks, and
 * tasks hold subtasks, a checklist, comments and attachments. Each list keeps
 * its own statuses and custom fields. People and AI employees are both
 * assignees: an employee assigned a task starts on it and comments what it did.
 * Each workspace has its own.
 */

export type StatusDef = { name: string; color: string; type: "open" | "active" | "done" | "closed" };
export type FieldDef = { id: string; name: string; type: "text" | "number" | "dropdown" | "date" | "money" | "checkbox"; options?: { id: string; name: string; color: string }[] };
export type Assignee = { type: "user" | "employee" | "name"; id: number; name: string };
export type CheckItem = { text: string; done: boolean };

export const DEFAULT_STATUSES: StatusDef[] = [
  { name: "to do", color: "#87909e", type: "open" },
  { name: "in progress", color: "#1090e0", type: "active" },
  { name: "complete", color: "#008844", type: "done" },
];
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export const FOLDER_COLORS = ["#1b6b4a", "#b45309", "#7c3aed", "#2563eb", "#0f766e", "#9a4f2c", "#c2253c", "#4b5563", "#475569", "#155c3e"];

export function parse<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export const statusesOf = (l: Pick<PjList, "statuses">) => {
  const s = parse<StatusDef[]>(l.statuses, []);
  return s.length ? s : DEFAULT_STATUSES;
};
const isClosed = (l: PjList, status: string) => {
  const s = statusesOf(l).find((x) => x.name === status);
  return s?.type === "done" || s?.type === "closed";
};

function mustList(orgId: number, id: number) {
  const l = db.work.lists.get(orgId, id);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  return l;
}
function mustTask(orgId: number, id: number) {
  const t = db.work.tasks.get(orgId, id);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  return t;
}

// ==========================================
// The folder tree
// ==========================================

export function tree(orgId: number, me?: Assignee) {
  const folders = db.work.folders.all(orgId).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const lists = db.work.lists.all(orgId).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const tasks = db.work.tasks.all(orgId);
  const openIn = (l: PjList) => tasks.filter((t) => t.listId === l.id && !t.parentId && !t.closedAt).length;
  const row = (l: PjList) => ({ id: l.id, name: l.name, open: openIn(l) });
  const mine = me ? tasks.filter((t) => !t.closedAt && parse<Assignee[]>(t.assignees, []).some((a) => a.type === me.type && a.id === me.id)).length : 0;
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name, color: f.color, lists: lists.filter((l) => l.folderId === f.id).map(row) })),
    loose: lists.filter((l) => !l.folderId || !folders.some((f) => f.id === l.folderId)).map(row),
    mine,
  };
}

export function saveFolder(orgId: number, input: { id?: number; name: string; color: string }) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the folder." });
  const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : FOLDER_COLORS[0];
  if (input.id) return db.work.folders.update(orgId, input.id, { name, color })!;
  return db.work.folders.insert({ organizationId: orgId, name, color, sort: db.work.folders.all(orgId).length });
}
/** Removing a folder keeps its lists, out of the folder. */
export function removeFolder(orgId: number, id: number) {
  for (const l of db.work.lists.where(orgId, "folderId", id)) db.work.lists.update(orgId, l.id, { folderId: null });
  db.work.folders.remove(orgId, id);
}

export function saveList(orgId: number, input: { id?: number; name: string; folderId: number | null; description?: string; statuses?: StatusDef[]; fields?: FieldDef[] }) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the list." });
  const statuses = (input.statuses ?? []).filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim().toLowerCase().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#87909e", type: s.type }));
  if (input.statuses && !statuses.some((s) => s.type === "done" || s.type === "closed")) throw new TRPCError({ code: "BAD_REQUEST", message: "Keep at least one status that means done." });
  const fields = (input.fields ?? []).filter((f) => f.name.trim()).slice(0, 30);
  const patch = { name, folderId: input.folderId, ...(input.description !== undefined ? { description: input.description.slice(0, 2000) } : {}), ...(input.statuses ? { statuses: JSON.stringify(statuses) } : {}), ...(input.fields ? { fields: JSON.stringify(fields) } : {}) };
  if (input.id) {
    const old = mustList(orgId, input.id);
    const l = db.work.lists.update(orgId, input.id, patch)!;
    // Tasks in a status that was removed move to the first status.
    if (input.statuses) for (const t of db.work.tasks.where(orgId, "listId", old.id)) if (!statuses.some((s) => s.name === t.status)) db.work.tasks.update(orgId, t.id, { status: statuses[0].name });
    return l;
  }
  return db.work.lists.insert({ organizationId: orgId, statuses: JSON.stringify(input.statuses ? statuses : DEFAULT_STATUSES), fields: JSON.stringify(fields), sort: db.work.lists.all(orgId).length, ...patch });
}
export function removeList(orgId: number, id: number) {
  mustList(orgId, id);
  for (const t of db.work.tasks.where(orgId, "listId", id)) removeTaskRows(orgId, t.id);
  db.work.lists.remove(orgId, id);
}

// ==========================================
// Reading tasks
// ==========================================

export type TaskRow = ReturnType<typeof taskRow>;
function taskRow(t: PjTask, all: PjTask[], counts: { comments: Map<number, number>; files: Map<number, number>; covers: Map<number, string> }, goals: Map<number, string>, listName = "") {
  const subs = all.filter((x) => x.parentId === t.id);
  const checklist = parse<CheckItem[]>(t.checklist, []);
  return {
    id: t.id,
    listId: t.listId,
    listName,
    parentId: t.parentId,
    name: t.name,
    status: t.status,
    priority: t.priority,
    startDate: t.startDate,
    dueDate: t.dueDate,
    timeEstimate: t.timeEstimate,
    tags: parse<string[]>(t.tags, []),
    assignees: parse<Assignee[]>(t.assignees, []),
    fields: parse<Record<string, unknown>>(t.fields, {}),
    goalId: t.goalId,
    goal: t.goalId ? goals.get(t.goalId) ?? null : null,
    closed: !!t.closedAt,
    subtasks: subs.length,
    subtasksDone: subs.filter((s) => s.closedAt).length,
    checklist: { done: checklist.filter((c) => c.done).length, total: checklist.length },
    comments: counts.comments.get(t.id) ?? 0,
    files: counts.files.get(t.id) ?? 0,
    cover: counts.covers.get(t.id) ?? null,
    sort: t.sort,
  };
}

function counts(orgId: number) {
  const comments = new Map<number, number>();
  for (const c of db.work.comments.all(orgId)) if (c.kind === "comment") comments.set(c.taskId, (comments.get(c.taskId) ?? 0) + 1);
  const files = new Map<number, number>();
  const links = db.work.files.all(orgId).filter((f) => f.itemType === "task");
  for (const f of links) files.set(f.itemId, (files.get(f.itemId) ?? 0) + 1);
  // The first picture on a task is its card cover on the Board.
  const pics = db.getChatFiles(orgId, links.map((l) => l.fileId)).filter((f) => f.kind === "image");
  const covers = new Map<number, string>();
  for (const l of links.sort((a, b) => a.id - b.id)) {
    const p = pics.find((x) => x.id === l.fileId);
    if (p && !covers.has(l.itemId)) covers.set(l.itemId, p.fileUrl);
  }
  return { comments, files, covers };
}

/** A list's tasks (or Everything, or My work) with what every view needs. */
export async function view(orgId: number, input: { listId: number | null; scope: "list" | "everything" | "mine"; me: Assignee; closed: boolean }) {
  const people = await owners(orgId);
  const all = db.work.tasks.all(orgId);
  const lists = db.work.lists.all(orgId);
  const goals = new Map(db.work.goals.all(orgId).filter((g) => g.state === "active").map((g) => [g.id, g.title]));
  const c = counts(orgId);
  let pick: PjTask[];
  let list: PjList | null = null;
  if (input.scope === "list") {
    list = mustList(orgId, input.listId ?? 0);
    pick = all.filter((t) => t.listId === list!.id && !t.parentId);
  } else if (input.scope === "mine") pick = all.filter((t) => parse<Assignee[]>(t.assignees, []).some((a) => a.type === input.me.type && a.id === input.me.id));
  else pick = all.filter((t) => !t.parentId);
  if (!input.closed) pick = pick.filter((t) => !t.closedAt || (Date.now() - new Date(t.closedAt).getTime()) < 14 * 86_400_000);
  const folder = list?.folderId ? db.work.folders.get(orgId, list.folderId) : null;
  const statuses = list ? statusesOf(list) : mergedStatuses(lists);
  return {
    list: list ? { id: list.id, name: list.name, description: list.description, folderId: list.folderId, folderName: folder?.name ?? null, statuses, fields: parse<FieldDef[]>(list.fields, []) } : null,
    statuses,
    tasks: pick.sort((a, b) => a.sort - b.sort || a.id - b.id).map((t) => taskRow(t, all, c, goals, lists.find((l) => l.id === t.listId)?.name ?? "")),
    people,
    goals: Array.from(goals.entries()).map(([id, title]) => ({ id, title })),
    lists: lists.map((l) => ({ id: l.id, name: l.name, statuses: statusesOf(l) })),
    today: todayYmd(await zoneOf(orgId)),
  };
}

/** Everything and My work show tasks from many lists: their statuses, merged by name. */
function mergedStatuses(lists: PjList[]) {
  const out: StatusDef[] = [];
  for (const l of lists) for (const s of statusesOf(l)) if (!out.some((x) => x.name === s.name)) out.push(s);
  const rank = { open: 0, active: 1, done: 2, closed: 3 } as const;
  return (out.length ? out : DEFAULT_STATUSES).sort((a, b) => rank[a.type] - rank[b.type]);
}

export async function detail(orgId: number, id: number) {
  const t = mustTask(orgId, id);
  const list = mustList(orgId, t.listId);
  const all = db.work.tasks.all(orgId);
  const goals = new Map(db.work.goals.all(orgId).filter((g) => g.state === "active").map((g) => [g.id, g.title]));
  const c = counts(orgId);
  const comments = db.work.comments.where(orgId, "taskId", id).sort((a, b) => a.id - b.id);
  const commentFiles = db.work.filesFor(orgId, "comment", comments.map((x) => x.id));
  const files = db.work.filesFor(orgId, "task", [id]);
  const folder = list.folderId ? db.work.folders.get(orgId, list.folderId) : null;
  const parent = t.parentId ? db.work.tasks.get(orgId, t.parentId) : null;
  return {
    task: { ...taskRow(t, all, c, goals, list.name), description: t.description, checklistItems: parse<CheckItem[]>(t.checklist, []), createdBy: t.createdBy, createdAt: t.createdAt },
    parent: parent ? { id: parent.id, name: parent.name } : null,
    list: { id: list.id, name: list.name, folderName: folder?.name ?? null, statuses: statusesOf(list), fields: parse<FieldDef[]>(list.fields, []) },
    subtasks: all.filter((x) => x.parentId === id).sort((a, b) => a.sort - b.sort || a.id - b.id).map((s) => taskRow(s, all, c, goals, list.name)),
    comments: comments.map((x) => ({ id: x.id, kind: x.kind, authorType: x.authorType, authorId: x.authorId, authorName: x.authorName, body: x.body, at: x.createdAt, files: commentFiles.filter((f) => f.link.itemId === x.id).map((f) => ({ id: f.file!.id, name: f.file!.name, url: f.file!.fileUrl, kind: f.file!.kind })) })),
    files: files.map((f) => ({ linkId: f.link.id, id: f.file!.id, name: f.file!.name, url: f.file!.fileUrl, kind: f.file!.kind, size: f.file!.size, mime: f.file!.mime })),
    people: await owners(orgId),
    goals: Array.from(goals.entries()).map(([gid, title]) => ({ id: gid, title })),
  };
}

// ==========================================
// Changing tasks
// ==========================================

export type Actor = { type: "user" | "employee" | "system"; id: number | null; name: string };

export type TaskInput = {
  name?: string;
  description?: string;
  status?: string;
  priority?: PjTask["priority"];
  startDate?: string | null;
  dueDate?: string | null;
  timeEstimate?: number | null;
  tags?: string[];
  assignees?: Assignee[];
  fields?: Record<string, unknown>;
  checklist?: CheckItem[];
  goalId?: number | null;
  listId?: number;
  sort?: number;
};

const ymd = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export async function createTask(orgId: number, input: TaskInput & { listId: number; parentId?: number | null; name: string }, by: Actor) {
  const list = mustList(orgId, input.listId);
  const name = input.name.trim().slice(0, 300);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the task." });
  if (input.parentId) mustTask(orgId, input.parentId);
  const statuses = statusesOf(list);
  const status = input.status && statuses.some((s) => s.name === input.status) ? input.status : statuses[0].name;
  const t = db.work.tasks.insert({
    organizationId: orgId,
    listId: list.id,
    parentId: input.parentId ?? null,
    name,
    description: (input.description ?? "").slice(0, 20_000),
    status,
    priority: input.priority ?? null,
    startDate: ymd(input.startDate),
    dueDate: ymd(input.dueDate),
    timeEstimate: input.timeEstimate ?? null,
    tags: JSON.stringify((input.tags ?? []).slice(0, 20)),
    assignees: JSON.stringify(input.assignees ?? []),
    fields: JSON.stringify(input.fields ?? {}),
    checklist: JSON.stringify(input.checklist ?? []),
    goalId: input.goalId ?? null,
    sort: input.sort ?? Date.now() % 1_000_000_000,
    closedAt: isClosed(list, status) ? new Date() : null,
    createdBy: by.name,
  });
  activity(orgId, t.id, by, `${by.name} created this task`);
  await runAutomations(orgId, t, { on: "created" });
  await assigned(orgId, t, [], input.assignees ?? [], by);
  return db.work.tasks.get(orgId, t.id)!;
}

function activity(orgId: number, taskId: number, by: Actor, body: string) {
  db.work.comments.insert({ organizationId: orgId, taskId, kind: "activity", authorType: by.type, authorId: by.id, authorName: by.name, body });
}

export async function updateTask(orgId: number, id: number, patch: TaskInput, by: Actor, opts: { quiet?: boolean } = {}) {
  const t = mustTask(orgId, id);
  let list = mustList(orgId, t.listId);
  const set: Partial<PjTask> = {};
  const said: string[] = [];
  if (patch.listId !== undefined && patch.listId !== t.listId) {
    list = mustList(orgId, patch.listId);
    set.listId = list.id;
    if (!statusesOf(list).some((s) => s.name === (patch.status ?? t.status))) set.status = statusesOf(list)[0].name;
    said.push(`moved this to ${list.name}`);
    for (const s of db.work.tasks.where(orgId, "parentId", id)) db.work.tasks.update(orgId, s.id, { listId: list.id });
  }
  if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== t.name) {
    set.name = patch.name.trim().slice(0, 300);
    said.push("renamed this task");
  }
  if (patch.description !== undefined) set.description = patch.description.slice(0, 20_000);
  if (patch.status !== undefined && patch.status !== t.status) {
    if (!statusesOf(list).some((s) => s.name === patch.status)) throw new TRPCError({ code: "BAD_REQUEST", message: `"${patch.status}" isn't a status in ${list.name}.` });
    set.status = patch.status;
    said.push(`moved this from ${t.status} to ${patch.status}`);
  }
  if (set.status !== undefined) set.closedAt = isClosed(list, set.status) ? t.closedAt ?? new Date() : null;
  if (patch.priority !== undefined && patch.priority !== t.priority) {
    set.priority = patch.priority;
    said.push(patch.priority ? `set the priority to ${patch.priority}` : "cleared the priority");
  }
  if (patch.startDate !== undefined) set.startDate = ymd(patch.startDate);
  if (patch.dueDate !== undefined && ymd(patch.dueDate) !== t.dueDate) {
    set.dueDate = ymd(patch.dueDate);
    said.push(set.dueDate ? `set the due date to ${fmtYmd(set.dueDate)}` : "cleared the due date");
  }
  if (patch.timeEstimate !== undefined) set.timeEstimate = patch.timeEstimate;
  if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags.map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 20));
  if (patch.fields !== undefined) set.fields = JSON.stringify(patch.fields);
  if (patch.checklist !== undefined) set.checklist = JSON.stringify(patch.checklist.filter((c) => c.text.trim()).slice(0, 100));
  if (patch.goalId !== undefined) set.goalId = patch.goalId;
  if (patch.sort !== undefined) set.sort = patch.sort;
  const before = parse<Assignee[]>(t.assignees, []);
  if (patch.assignees !== undefined) {
    set.assignees = JSON.stringify(patch.assignees.slice(0, 20));
    const added = patch.assignees.filter((a) => !before.some((b) => b.type === a.type && b.id === a.id && b.name === a.name));
    const removed = before.filter((b) => !patch.assignees!.some((a) => a.type === b.type && a.id === b.id && a.name === b.name));
    if (added.length) said.push(`assigned ${added.map((a) => a.name).join(", ")}`);
    if (removed.length) said.push(`unassigned ${removed.map((a) => a.name).join(", ")}`);
  }
  const next = db.work.tasks.update(orgId, id, set)!;
  if (said.length && !opts.quiet) activity(orgId, id, by, `${by.name} ${said.join(", ")}`);
  if (set.status !== undefined) await runAutomations(orgId, next, { on: "status", to: set.status });
  if (patch.assignees !== undefined) await assigned(orgId, next, before, patch.assignees, by);
  return db.work.tasks.get(orgId, id)!;
}

const fmtYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/** Moves every date of a task by the same number of days (dragging a bar on the Gantt). */
export function shiftDates(orgId: number, id: number, startDate: string | null, dueDate: string | null, by: Actor) {
  const t = mustTask(orgId, id);
  const s = ymd(startDate);
  const d = ymd(dueDate);
  if (s && d && d < s) throw new TRPCError({ code: "BAD_REQUEST", message: "The due date can't be before the start date." });
  db.work.tasks.update(orgId, id, { startDate: s, dueDate: d });
  if (d !== t.dueDate) activity(orgId, id, by, `${by.name} moved the dates to ${s ? `${fmtYmd(s)} to ` : ""}${d ? fmtYmd(d) : "no due date"}`);
}

function removeTaskRows(orgId: number, id: number) {
  for (const s of db.work.tasks.where(orgId, "parentId", id)) removeTaskRows(orgId, s.id);
  for (const c of db.work.comments.where(orgId, "taskId", id)) db.work.comments.remove(orgId, c.id);
  for (const f of db.work.files.all(orgId).filter((x) => x.itemType === "task" && x.itemId === id)) db.work.files.remove(orgId, f.id);
  db.work.tasks.remove(orgId, id);
}
export function removeTask(orgId: number, id: number) {
  mustTask(orgId, id);
  removeTaskRows(orgId, id);
}

export async function comment(orgId: number, taskId: number, body: string, by: Actor, fileIds: number[] = []) {
  const t = mustTask(orgId, taskId);
  const text = body.trim().slice(0, 10_000);
  if (!text && !fileIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a comment." });
  const c = db.work.comments.insert({ organizationId: orgId, taskId, kind: "comment", authorType: by.type, authorId: by.id, authorName: by.name, body: text });
  for (const f of db.getChatFiles(orgId, fileIds)) db.work.files.insert({ organizationId: orgId, itemType: "comment", itemId: c.id, fileId: f.id, addedBy: by.name });
  // @mentions: people get a notice; an employee gets the comment in its chat and answers on the task.
  const people = await owners(orgId);
  const mentioned = people.filter((p) => new RegExp(`@${p.name.split(/\s+/)[0]}\\b`, "i").test(text));
  const users = mentioned.filter((p) => p.type === "user" && p.id !== by.id).map((p) => p.id);
  if (users.length) await notify(orgId, "task_assigned", { title: `${by.name} mentioned you on a task`, body: `${t.name}: ${text.slice(0, 160)}`, url: `/projects?task=${t.id}` }, { only: users }).catch(() => null);
  for (const e of mentioned.filter((p) => p.type === "employee" && !(by.type === "employee" && by.id === p.id))) void askEmployee(orgId, t, e, `${by.name} on the task "${t.name}": ${text}`);
  return c;
}

// ==========================================
// Assigning people and employees
// ==========================================

async function assigned(orgId: number, t: PjTask, before: Assignee[], after: Assignee[], by: Actor) {
  const added = after.filter((a) => !before.some((b) => b.type === a.type && b.id === a.id));
  if (!added.length || t.closedAt) return;
  const users = added.filter((a) => a.type === "user" && !(by.type === "user" && by.id === a.id)).map((a) => a.id);
  if (users.length) await notify(orgId, "task_assigned", { title: `${by.name} assigned you a task`, body: `${t.name}${t.dueDate ? `, due ${fmtYmd(t.dueDate)}` : ""}`, url: `/projects?task=${t.id}` }, { only: users }).catch(() => null);
  const people = await owners(orgId);
  // An employee someone else assigned starts on it; one that assigned itself is already working.
  for (const a of added.filter((x) => x.type === "employee" && !(by.type === "employee" && by.id === x.id))) {
    const o = ownerOf(people, "employee", a.id);
    if (o) void askEmployee(orgId, t, o, "");
  }
}

/** An employee works on a task it was given (or answers an @mention) with its own actions, and comments on the task. */
async function askEmployee(orgId: number, t: PjTask, e: Owner, said: string) {
  try {
    const emp = await db.getEmployeeForOrg(e.id, orgId);
    if (!emp || emp.status === "paused") return;
    const list = db.work.lists.get(orgId, t.listId);
    const { doTask } = await import("../employees/chat");
    const r = await doTask(emp, {
      title: t.name,
      details: [t.description, said].filter(Boolean).join("\n\n").slice(0, 6000),
      doneWhen: "",
      project: list?.name ?? "Projects",
      due: t.dueDate ? fmtYmd(t.dueDate) : "no due date",
      feedback: "",
      from: "Projects",
    });
    const by: Actor = { type: "employee", id: emp.id, name: emp.name };
    const text = r.action === "none" ? `I can't do this one with what I have${r.text ? `: ${r.text}` : "."}` : r.text || "Started on it. What I made is in my chat.";
    await comment(orgId, t.id, text, by);
    if (r.action !== "none" && list) {
      const active = statusesOf(list).find((s) => s.type === "active");
      const cur = db.work.tasks.get(orgId, t.id);
      if (active && cur && statusesOf(list).find((s) => s.name === cur.status)?.type === "open") await updateTask(orgId, t.id, { status: active.name }, by);
    }
  } catch (err) {
    console.warn("[projects] employee task failed:", err instanceof Error ? err.message : err);
  }
}

// ==========================================
// Automations
// ==========================================

export type Trigger = { on: "created" | "status"; to?: string };
export type Action = { do: "assign" | "priority" | "status" | "comment"; value: string };

export function automations(orgId: number, listId: number | null) {
  return db.work.automations
    .all(orgId)
    .filter((a) => a.listId === listId)
    .map((a) => ({ id: a.id, listId: a.listId, active: a.active, trigger: parse<Trigger>(a.trigger, { on: "created" }), action: parse<Action>(a.action, { do: "comment", value: "" }) }));
}
export function saveAutomation(orgId: number, input: { id?: number; listId: number | null; trigger: Trigger; action: Action; active: boolean }) {
  if (input.listId) mustList(orgId, input.listId);
  if (!input.action.value.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick what the automation does." });
  const row = { listId: input.listId, trigger: JSON.stringify(input.trigger), action: JSON.stringify({ ...input.action, value: input.action.value.slice(0, 500) }), active: input.active };
  if (input.id) return db.work.automations.update(orgId, input.id, row);
  return db.work.automations.insert({ organizationId: orgId, ...row });
}
export function removeAutomation(orgId: number, id: number) {
  db.work.automations.remove(orgId, id);
}

async function runAutomations(orgId: number, t: PjTask, event: Trigger, depth = 0) {
  if (depth > 2) return;
  const rules = db.work.automations.all(orgId).filter((a) => a.active && (a.listId === null || a.listId === t.listId));
  const by: Actor = { type: "system", id: null, name: "Automation" };
  for (const r of rules) {
    const tr = parse<Trigger>(r.trigger, { on: "created" });
    if (tr.on !== event.on || (tr.on === "status" && tr.to && tr.to !== event.to)) continue;
    const a = parse<Action>(r.action, { do: "comment", value: "" });
    const cur = db.work.tasks.get(orgId, t.id);
    if (!cur) return;
    if (a.do === "comment") activity(orgId, t.id, by, a.value);
    else if (a.do === "priority" && (PRIORITIES as readonly string[]).includes(a.value)) db.work.tasks.update(orgId, t.id, { priority: a.value as PjTask["priority"] });
    else if (a.do === "status") {
      const list = db.work.lists.get(orgId, cur.listId);
      if (list && statusesOf(list).some((s) => s.name === a.value) && cur.status !== a.value) {
        db.work.tasks.update(orgId, t.id, { status: a.value, closedAt: isClosed(list, a.value) ? new Date() : null });
        activity(orgId, t.id, by, `Automation moved this to ${a.value}`);
        await runAutomations(orgId, db.work.tasks.get(orgId, t.id)!, { on: "status", to: a.value }, depth + 1);
      }
    } else if (a.do === "assign") {
      const [type, idStr] = a.value.split(":");
      const people = await owners(orgId);
      const o = ownerOf(people, type, Number(idStr));
      const before = parse<Assignee[]>(cur.assignees, []);
      if (o && !before.some((b) => b.type === o.type && b.id === o.id)) {
        const after = [...before, { type: o.type, id: o.id, name: o.name }];
        db.work.tasks.update(orgId, t.id, { assignees: JSON.stringify(after) });
        activity(orgId, t.id, by, `Automation assigned ${o.name}`);
        await assigned(orgId, db.work.tasks.get(orgId, t.id)!, before, after, by);
      }
    }
  }
}

// ==========================================
// For employees in chat
// ==========================================

/** Finds tasks by words, person, or what's due. */
export function find(orgId: number, input: { words?: string; who?: string; dueBy?: string; includeDone?: boolean }) {
  const words = (input.words ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const lists = db.work.lists.all(orgId);
  return db.work.tasks
    .all(orgId)
    .filter((t) => input.includeDone || !t.closedAt)
    .filter((t) => !words.length || words.every((w) => `${t.name} ${lists.find((l) => l.id === t.listId)?.name ?? ""}`.toLowerCase().includes(w)))
    .filter((t) => !input.who || parse<Assignee[]>(t.assignees, []).some((a) => a.name.toLowerCase().includes(input.who!.toLowerCase())))
    .filter((t) => !input.dueBy || (t.dueDate && t.dueDate <= input.dueBy))
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))
    .slice(0, 40)
    .map((t) => ({ id: t.id, name: t.name, list: lists.find((l) => l.id === t.listId)?.name ?? "", status: t.status, due: t.dueDate ? fmtYmd(t.dueDate) : "no due date", assignees: parse<Assignee[]>(t.assignees, []).map((a) => a.name) }));
}

/** The list a name points to, else the newest list. */
export function listNamed(orgId: number, name: string) {
  const lists = db.work.lists.all(orgId);
  const n = name.trim().toLowerCase();
  return (n && (lists.find((l) => l.name.toLowerCase() === n) ?? lists.find((l) => l.name.toLowerCase().includes(n)))) || null;
}
