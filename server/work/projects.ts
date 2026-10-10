import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjList, PjTask } from "../../drizzle/schema";
import { notify } from "../notify";
import { owners, ownerOf, todayYmd, zoneOf, type Owner } from "./goals";
import { levelFor, visibleLists, type Level, type Viewer } from "./pjAccess";

/**
 * Projects, in place of ClickUp: folders hold lists, docs, whiteboards and
 * forms; lists hold tasks, and tasks hold subtasks, a checklist, comments and
 * attachments. Each list keeps its own statuses and custom fields (and a
 * folder can share fields with all its lists). Tasks can repeat, wait on other
 * tasks, link to them, and carry tracked time. People and AI employees are
 * both assignees: an employee assigned a task starts on it and comments what
 * it did. Each workspace has its own.
 */

export type StatusDef = { name: string; color: string; type: "open" | "active" | "done" | "closed" };
export const FIELD_TYPES = ["text", "number", "money", "date", "checkbox", "dropdown", "labels", "people", "email", "phone", "website", "rating", "progress", "formula", "files", "relationship"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export type FieldDef = {
  id: string;
  name: string;
  type: FieldType;
  options?: { id: string; name: string; color: string }[];
  /** formula: the expression; progress: "subtasks" or "manual"; rating: how many stars; relationship: a list id or "" for any. */
  setup?: string;
  /** Where the field lives: on this list, or on every list in the folder. */
  scope?: "list" | "folder";
};
export type Assignee = { type: "user" | "employee" | "name"; id: number; name: string };
export type CheckItem = { text: string; done: boolean };
export type Repeat = {
  every: number;
  unit: "day" | "week" | "month" | "year";
  /** For weekly: days of the week (0 Sunday to 6 Saturday). */
  days?: number[];
  /** done: the next one is made when this one is done; schedule: on its date, even if this one is open. */
  mode: "done" | "schedule";
  ends: "never" | "date" | "count";
  until?: string;
  count?: number;
  keep: { subtasks: boolean; checklist: boolean; assignees: boolean; comments: boolean };
  /** How many have been made so far, and whether this one already made its next one. */
  made?: number;
  spawned?: boolean;
};

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

/** A list's custom fields: the folder's shared ones first, then its own. */
export function fieldsOf(orgId: number, l: PjList): FieldDef[] {
  const folder = l.folderId ? db.work.folders.get(orgId, l.folderId) : null;
  const shared = folder ? parse<FieldDef[]>(folder.fields, []).map((f) => ({ ...f, scope: "folder" as const })) : [];
  const own = parse<FieldDef[]>(l.fields, []).map((f) => ({ ...f, scope: "list" as const }));
  return [...shared, ...own.filter((f) => !shared.some((s) => s.id === f.id))];
}

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

function archivedCount(orgId: number, v: Viewer) {
  return visibleLists(orgId, v, { archived: true }).filter((x) => x.list.archivedAt).length + db.work.folders.all(orgId).filter((f) => f.archivedAt).length;
}

export function tree(orgId: number, v: Viewer, me?: Assignee) {
  const vis = visibleLists(orgId, v);
  const visIds = new Set(vis.map((x) => x.list.id));
  const member = v.kind !== "guest";
  const folders = db.work.folders.all(orgId).filter((f) => !f.archivedAt).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const lists = vis.map((x) => x.list).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const tasks = db.work.tasks.all(orgId).filter((t) => visIds.has(t.listId));
  const openIn = (l: PjList) => tasks.filter((t) => t.listId === l.id && !t.parentId && !t.closedAt).length;
  const mine = me ? tasks.filter((t) => !t.closedAt && parse<Assignee[]>(t.assignees, []).some((a) => a.type === me.type && a.id === me.id)).length : 0;
  const docs = member ? db.work.docs.all(orgId).filter((d) => !d.parentId) : [];
  const boards = member ? db.work.boards.all(orgId) : [];
  const forms = member ? db.work.forms.all(orgId) : [];
  // Docs and whiteboards made on a list sit under that list; the rest sit under their folder.
  const onList = (listId: number) => [
    ...docs.filter((d) => d.listId === listId).map((d) => ({ kind: "doc" as const, id: d.id, name: d.title, sort: d.sort })),
    ...boards.filter((b) => b.listId === listId).map((b) => ({ kind: "board" as const, id: b.id, name: b.title, sort: b.sort })),
  ];
  const extras = (folderId: number | null) => [
    ...docs.filter((d) => d.folderId === folderId && !d.listId).map((d) => ({ kind: "doc" as const, id: d.id, name: d.title, sort: d.sort })),
    ...boards.filter((b) => b.folderId === folderId && !b.listId).map((b) => ({ kind: "board" as const, id: b.id, name: b.title, sort: b.sort })),
    ...forms.filter((f) => f.folderId === folderId).map((f) => ({ kind: "form" as const, id: f.id, name: f.title, sort: f.sort })),
  ];
  const row = (l: PjList) => ({ id: l.id, name: l.name, open: openIn(l), private: l.private, level: vis.find((x) => x.list.id === l.id)!.level, items: member ? onList(l.id) : [] });
  const inFolder = new Set(folders.map((f) => f.id));
  return {
    folders: folders
      .map((f) => ({ id: f.id, name: f.name, color: f.color, lists: lists.filter((l) => l.folderId === f.id).map(row), items: extras(f.id) }))
      // A guest sees only folders holding a list shared with them.
      .filter((f) => member || f.lists.length > 0),
    loose: lists.filter((l) => !l.folderId || !inFolder.has(l.folderId)).map(row),
    looseItems: extras(null),
    mine,
    guest: !member,
    archived: member ? archivedCount(orgId, v) : 0,
    /** For a guest: the docs shared with them on their own. */
    sharedDocs: member ? [] : db.work.docShares.all(orgId).filter((s) => s.kind === "guest" && v.kind === "guest" && s.userId === v.userId).map((s) => db.work.docs.get(orgId, s.docId)).filter((d): d is NonNullable<typeof d> => !!d && !d.archivedAt).map((d) => ({ id: d.id, name: d.title })),
  };
}

export function saveFolder(orgId: number, input: { id?: number; name: string; color: string }) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the folder." });
  const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : FOLDER_COLORS[0];
  if (input.id) return db.work.folders.update(orgId, input.id, { name, color })!;
  return db.work.folders.insert({ organizationId: orgId, name, color, sort: db.work.folders.all(orgId).length });
}
/** Removing a folder keeps its lists, docs, whiteboards and forms, out of the folder. */
export function removeFolder(orgId: number, id: number) {
  for (const l of db.work.lists.where(orgId, "folderId", id)) db.work.lists.update(orgId, l.id, { folderId: null });
  for (const d of db.work.docs.where(orgId, "folderId", id)) db.work.docs.update(orgId, d.id, { folderId: null });
  for (const b of db.work.boards.where(orgId, "folderId", id)) db.work.boards.update(orgId, b.id, { folderId: null });
  for (const f of db.work.forms.where(orgId, "folderId", id)) db.work.forms.update(orgId, f.id, { folderId: null });
  db.work.folders.remove(orgId, id);
}

const cleanField = (f: FieldDef): FieldDef => ({
  id: f.id.slice(0, 60),
  name: f.name.trim().slice(0, 80),
  type: (FIELD_TYPES as readonly string[]).includes(f.type) ? f.type : "text",
  ...(f.options?.length ? { options: f.options.slice(0, 50) } : {}),
  ...(f.setup ? { setup: f.setup.slice(0, 300) } : {}),
});

export function saveList(orgId: number, input: { id?: number; name: string; folderId: number | null; description?: string; statuses?: StatusDef[]; fields?: FieldDef[] }) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the list." });
  const statuses = (input.statuses ?? []).filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim().toLowerCase().slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#87909e", type: s.type }));
  if (input.statuses && !statuses.some((s) => s.type === "done" || s.type === "closed")) throw new TRPCError({ code: "BAD_REQUEST", message: "Keep at least one status that means done." });
  const all = (input.fields ?? []).filter((f) => f.name.trim()).slice(0, 40);
  // Fields marked for the folder live on the folder, so every list in it has them.
  const toFolder = input.folderId ? all.filter((f) => f.scope === "folder").map(cleanField) : [];
  const own = all.filter((f) => !input.folderId || f.scope !== "folder").map(cleanField).slice(0, 30);
  if (input.fields && input.folderId) db.work.folders.update(orgId, input.folderId, { fields: JSON.stringify(toFolder.slice(0, 30)) });
  const patch = { name, folderId: input.folderId, ...(input.description !== undefined ? { description: input.description.slice(0, 2000) } : {}), ...(input.statuses ? { statuses: JSON.stringify(statuses) } : {}), ...(input.fields ? { fields: JSON.stringify(own) } : {}) };
  if (input.id) {
    const old = mustList(orgId, input.id);
    const l = db.work.lists.update(orgId, input.id, patch)!;
    // Tasks in a status that was removed move to the first status.
    if (input.statuses) for (const t of db.work.tasks.where(orgId, "listId", old.id)) if (!statuses.some((s) => s.name === t.status)) db.work.tasks.update(orgId, t.id, { status: statuses[0].name });
    return l;
  }
  return db.work.lists.insert({ organizationId: orgId, statuses: JSON.stringify(input.statuses ? statuses : DEFAULT_STATUSES), fields: JSON.stringify(own), sort: db.work.lists.all(orgId).length, ...patch });
}
/** Adds one custom field to a list, or to its folder so every list in the folder gets it. */
export function addField(orgId: number, input: { listId?: number | null; folderId?: number | null; scope: "list" | "folder"; name: string; type: FieldType; options?: string[]; setup?: string }) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the field." });
  const id = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
  const options = input.type === "dropdown" || input.type === "labels" ? (input.options ?? []).map((o, i) => ({ id: `o${i}${Date.now().toString(36)}`, name: o.trim().slice(0, 60), color: ["#1b6b4a", "#2563eb", "#b45309", "#7c3aed", "#c2253c", "#0f766e", "#87909e"][i % 7] })).filter((o) => o.name) : undefined;
  const def: FieldDef = { id, name, type: input.type, ...(options ? { options } : {}), ...(input.setup ? { setup: input.setup.slice(0, 200) } : {}) };
  const list = input.listId ? mustList(orgId, input.listId) : null;
  const folderId = input.scope === "folder" ? (input.folderId ?? list?.folderId ?? null) : null;
  if (input.scope === "folder") {
    if (!folderId) throw new TRPCError({ code: "BAD_REQUEST", message: "This list isn't in a folder." });
    const f = db.work.folders.get(orgId, folderId);
    if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That folder isn't in this workspace." });
    db.work.folders.update(orgId, f.id, { fields: JSON.stringify([...parse<FieldDef[]>(f.fields, []), def]) });
  } else {
    if (!list) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a list." });
    db.work.lists.update(orgId, list.id, { fields: JSON.stringify([...parse<FieldDef[]>(list.fields, []), def]) });
  }
  return { ...def, scope: input.scope };
}

export function removeList(orgId: number, id: number) {
  mustList(orgId, id);
  for (const t of db.work.tasks.where(orgId, "listId", id)) removeTaskRows(orgId, t.id);
  for (const s of db.work.shares.where(orgId, "listId", id)) db.work.shares.remove(orgId, s.id);
  db.work.lists.remove(orgId, id);
}

// ==========================================
// Reading tasks
// ==========================================

type Counts = ReturnType<typeof counts>;
export type TaskRow = ReturnType<typeof taskRow>;
function taskRow(t: PjTask, all: PjTask[], c: Counts, goals: Map<number, string>, listName = "") {
  const subs = all.filter((x) => x.parentId === t.id);
  const checklist = parse<CheckItem[]>(t.checklist, []);
  const waits = c.waits.get(t.id) ?? [];
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
    watchers: parse<Assignee[]>(t.watchers, []),
    fields: parse<Record<string, unknown>>(t.fields, {}),
    goalId: t.goalId,
    goal: t.goalId ? goals.get(t.goalId) ?? null : null,
    closed: !!t.closedAt,
    repeat: t.repeat ? parse<Repeat | null>(t.repeat, null) : null,
    subtasks: subs.length,
    subtasksDone: subs.filter((s) => s.closedAt).length,
    checklist: { done: checklist.filter((x) => x.done).length, total: checklist.length },
    comments: c.comments.get(t.id) ?? 0,
    files: c.files.get(t.id) ?? 0,
    cover: c.covers.get(t.id) ?? null,
    /** Task ids this one waits on, and whether any of them is still open. */
    waitsOn: waits,
    blocked: waits.some((id) => !all.find((x) => x.id === id)?.closedAt),
    minutes: c.minutes.get(t.id) ?? 0,
    sort: t.sort,
  };
}

function counts(orgId: number) {
  const comments = new Map<number, number>();
  for (const x of db.work.comments.all(orgId)) if (x.kind === "comment") comments.set(x.taskId, (comments.get(x.taskId) ?? 0) + 1);
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
  const waits = new Map<number, number[]>();
  for (const l of db.work.links.all(orgId)) if (l.kind === "waits") waits.set(l.taskId, [...(waits.get(l.taskId) ?? []), l.otherId]);
  const minutes = new Map<number, number>();
  for (const e of db.work.time.all(orgId)) {
    const m = e.minutes ?? (e.startedAt ? Math.max(0, Math.round((Date.now() - new Date(e.startedAt).getTime()) / 60000)) : 0);
    minutes.set(e.taskId, (minutes.get(e.taskId) ?? 0) + m);
  }
  return { comments, files, covers, waits, minutes };
}

/** A list's tasks (or Everything, or My work) with what every view needs. */
export async function view(orgId: number, v: Viewer, input: { listId: number | null; folderId?: number | null; portfolioId?: number | null; scope: "list" | "everything" | "mine" | "folder" | "portfolio"; me: Assignee; closed: boolean }) {
  // One list opens even when archived (read only); the wider views leave archived lists out.
  let vis = visibleLists(orgId, v, { archived: input.scope === "list" });
  // A portfolio shows the tasks of every project in it.
  if (input.scope === "portfolio") {
    const ids = new Set((await import("./pjPortfolios")).listsIn(orgId, input.portfolioId ?? 0));
    vis = vis.filter((x) => ids.has(x.list.id));
  }
  // A folder shows every list in it together.
  const folderRow = input.scope === "folder" ? db.work.folders.get(orgId, input.folderId ?? 0) : null;
  if (input.scope === "folder") {
    if (!folderRow) throw new TRPCError({ code: "NOT_FOUND", message: "That folder isn't in this workspace." });
    vis = vis.filter((x) => x.list.folderId === folderRow.id);
  }
  const visIds = new Set(vis.map((x) => x.list.id));
  const people = v.kind === "guest" ? [] : await owners(orgId);
  const all = db.work.tasks.all(orgId).filter((t) => visIds.has(t.listId));
  const lists = vis.map((x) => x.list);
  const goals = new Map(v.kind === "guest" ? [] : db.work.goals.all(orgId).filter((g) => g.state === "active").map((g) => [g.id, g.title] as [number, string]));
  const c = counts(orgId);
  let pick: PjTask[];
  let list: PjList | null = null;
  if (input.scope === "list") {
    list = lists.find((l) => l.id === input.listId) ?? null;
    if (!list) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
    pick = all.filter((t) => t.listId === list!.id && !t.parentId);
  } else if (input.scope === "mine") pick = all.filter((t) => parse<Assignee[]>(t.assignees, []).some((a) => a.type === input.me.type && a.id === input.me.id));
  else pick = all.filter((t) => !t.parentId);
  // Done tasks older than two weeks stay out unless asked for; an archived list shows everything it had.
  if (!input.closed && !list?.archivedAt) pick = pick.filter((t) => !t.closedAt || Date.now() - new Date(t.closedAt).getTime() < 14 * 86_400_000);
  const folder = list?.folderId ? db.work.folders.get(orgId, list.folderId) : null;
  const statuses = list ? statusesOf(list) : mergedStatuses(lists);
  const pickIds = new Set(pick.map((t) => t.id));
  // Fields shown as columns: the list's own (with the folder's), or across a folder its shared ones, or across everything the fields every list shares.
  const fields = list ? fieldsOf(orgId, list) : folderRow ? parse<FieldDef[]>(folderRow.fields, []).map((f) => ({ ...f, scope: "folder" as const })) : [];
  return {
    list: list ? { id: list.id, name: list.name, description: list.description, folderId: list.folderId, folderName: folder?.name ?? null, statuses, fields, private: list.private, adminsOnly: list.adminsOnly, archivedAt: list.archivedAt, archivedBy: list.archivedBy, status: (await import("./pjPortfolios")).latestStatus(orgId, "list", list.id), level: vis.find((x) => x.list.id === list!.id)!.level } : null,
    folder: folderRow ? { id: folderRow.id, name: folderRow.name, color: folderRow.color, fields, level: (vis.some((x) => x.level === "full") || (v.kind === "member" && v.role !== "reviewer") ? "full" : vis.some((x) => x.level === "edit") ? "edit" : "view") as Level } : null,
    fields,
    statuses,
    tasks: pick.sort((a, b) => a.sort - b.sort || a.id - b.id).map((t) => taskRow(t, all, c, goals, lists.find((l) => l.id === t.listId)?.name ?? "")),
    /** Subtasks of the shown tasks, for the Mind map and Timeline. */
    subtasks: all.filter((t) => t.parentId && pickIds.has(t.parentId)).map((t) => taskRow(t, all, c, goals, lists.find((l) => l.id === t.listId)?.name ?? "")),
    /** Waits-on links among these tasks, for the Gantt arrows. */
    links: db.work.links.all(orgId).filter((l) => l.kind === "waits" && pickIds.has(l.taskId) && pickIds.has(l.otherId)).map((l) => ({ from: l.otherId, to: l.taskId })),
    people,
    goals: Array.from(goals.entries()).map(([id, title]) => ({ id, title })),
    lists: lists.map((l) => {
      const f = l.folderId ? folderRow && folderRow.id === l.folderId ? folderRow : db.work.folders.get(orgId, l.folderId) : null;
      return { id: l.id, name: l.name, statuses: statusesOf(l), level: vis.find((x) => x.list.id === l.id)!.level, folderId: f?.id ?? null, folderName: f?.name ?? null, folderColor: f?.color ?? null, sort: l.sort };
    }),
    levels: Object.fromEntries(vis.map((x) => [x.list.id, x.level])) as Record<number, Level>,
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

export async function detail(orgId: number, v: Viewer, id: number) {
  const t = mustTask(orgId, id);
  const list = mustList(orgId, t.listId);
  const level = levelFor(orgId, v, list);
  if (!level) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  const all = db.work.tasks.all(orgId);
  const goals = new Map(db.work.goals.all(orgId).filter((g) => g.state === "active").map((g) => [g.id, g.title]));
  const c = counts(orgId);
  const comments = db.work.comments.where(orgId, "taskId", id).sort((a, b) => a.id - b.id);
  const commentFiles = db.work.filesFor(orgId, "comment", comments.map((x) => x.id));
  const files = db.work.filesFor(orgId, "task", [id]);
  const folder = list.folderId ? db.work.folders.get(orgId, list.folderId) : null;
  const parent = t.parentId ? db.work.tasks.get(orgId, t.parentId) : null;
  const lists = db.work.lists.all(orgId);
  const brief = (x: PjTask) => ({ id: x.id, name: x.name, status: x.status, closed: !!x.closedAt, dueDate: x.dueDate, assignees: parse<Assignee[]>(x.assignees, []), listName: lists.find((l) => l.id === x.listId)?.name ?? "" });
  const links = db.work.links.all(orgId).filter((l) => l.taskId === id || l.otherId === id);
  const other = (tid: number) => all.find((x) => x.id === tid);
  const entries = db.work.time.where(orgId, "taskId", id).sort((a, b) => b.id - a.id);
  return {
    task: { ...taskRow(t, all, c, goals, list.name), description: t.description, checklistItems: parse<CheckItem[]>(t.checklist, []), createdBy: t.createdBy, createdAt: t.createdAt },
    parent: parent ? { id: parent.id, name: parent.name } : null,
    list: { id: list.id, name: list.name, folderName: folder?.name ?? null, statuses: statusesOf(list), fields: fieldsOf(orgId, list) },
    level,
    subtasks: all.filter((x) => x.parentId === id).sort((a, b) => a.sort - b.sort || a.id - b.id).map((s) => taskRow(s, all, c, goals, list.name)),
    comments: comments.map((x) => ({ id: x.id, kind: x.kind, authorType: x.authorType, authorId: x.authorId, authorName: x.authorName, body: x.body, at: x.createdAt, files: commentFiles.filter((f) => f.link.itemId === x.id).map((f) => ({ id: f.file!.id, name: f.file!.name, url: f.file!.fileUrl, kind: f.file!.kind })) })),
    files: files.map((f) => ({ linkId: f.link.id, id: f.file!.id, name: f.file!.name, url: f.file!.fileUrl, kind: f.file!.kind, size: f.file!.size, mime: f.file!.mime })),
    links: {
      waitingOn: links.filter((l) => l.kind === "waits" && l.taskId === id && other(l.otherId)).map((l) => ({ linkId: l.id, ...brief(other(l.otherId)!) })),
      blocking: links.filter((l) => l.kind === "waits" && l.otherId === id && other(l.taskId)).map((l) => ({ linkId: l.id, ...brief(other(l.taskId)!) })),
      linked: links.filter((l) => l.kind === "link" && other(l.taskId === id ? l.otherId : l.taskId)).map((l) => ({ linkId: l.id, ...brief(other(l.taskId === id ? l.otherId : l.taskId)!) })),
    },
    time: {
      entries: entries.map((e) => ({ id: e.id, whoType: e.whoType, whoId: e.whoId, whoName: e.whoName, day: e.day, minutes: e.minutes, running: e.minutes === null, startedAt: e.startedAt, note: e.note, billable: e.billable })),
      total: c.minutes.get(id) ?? 0,
    },
    today: todayYmd(await zoneOf(orgId)),
    /** Tasks this one could wait on or link to (same workspace, not itself). */
    pickable: all.filter((x) => x.id !== id && !x.parentId).slice(0, 400).map((x) => ({ id: x.id, name: x.name, listName: lists.find((l) => l.id === x.listId)?.name ?? "" })),
    people: v.kind === "guest" ? [] : await owners(orgId),
    goals: v.kind === "guest" ? [] : Array.from(goals.entries()).map(([gid, title]) => ({ id: gid, title })),
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
  watchers?: Assignee[];
  fields?: Record<string, unknown>;
  checklist?: CheckItem[];
  goalId?: number | null;
  listId?: number;
  sort?: number;
  repeat?: Repeat | null;
  /** Makes it a subtask of another task in the same list (null: a task again). */
  parentId?: number | null;
};

const ymd = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

const cleanRepeat = (r: Repeat | null | undefined): string => {
  if (!r) return "";
  const every = Math.max(1, Math.min(365, Math.round(r.every || 1)));
  return JSON.stringify({
    every,
    unit: ["day", "week", "month", "year"].includes(r.unit) ? r.unit : "week",
    ...(r.unit === "week" && r.days?.length ? { days: Array.from(new Set(r.days.filter((d) => d >= 0 && d <= 6))).sort() } : {}),
    mode: r.mode === "schedule" ? "schedule" : "done",
    ends: ["never", "date", "count"].includes(r.ends) ? r.ends : "never",
    ...(r.ends === "date" && ymd(r.until) ? { until: r.until } : {}),
    ...(r.ends === "count" && r.count ? { count: Math.max(1, Math.min(1000, Math.round(r.count))) } : {}),
    keep: { subtasks: !!r.keep?.subtasks, checklist: !!r.keep?.checklist, assignees: r.keep?.assignees !== false, comments: !!r.keep?.comments },
    made: r.made ?? 1,
    spawned: !!r.spawned,
  });
};

export async function createTask(orgId: number, input: TaskInput & { listId: number; parentId?: number | null; name: string }, by: Actor, opts: { quiet?: boolean } = {}) {
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
    watchers: JSON.stringify(input.watchers ?? []),
    fields: JSON.stringify(input.fields ?? {}),
    checklist: JSON.stringify(input.checklist ?? []),
    goalId: input.goalId ?? null,
    repeat: cleanRepeat(input.repeat),
    sort: input.sort ?? Date.now() % 1_000_000_000,
    closedAt: isClosed(list, status) ? new Date() : null,
    createdBy: by.name,
  });
  if (!opts.quiet) activity(orgId, t.id, by, `${by.name} created this task`);
  await runAutomations(orgId, t, { on: "created" });
  await assigned(orgId, t, [], input.assignees ?? [], by);
  return db.work.tasks.get(orgId, t.id)!;
}

export function activity(orgId: number, taskId: number, by: Actor, body: string) {
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
  if (patch.parentId !== undefined && patch.parentId !== t.parentId) {
    if (patch.parentId !== null) {
      const p = mustTask(orgId, patch.parentId);
      if (p.id === t.id || p.parentId === t.id) throw new TRPCError({ code: "BAD_REQUEST", message: "A task can't go under itself." });
      if (db.work.tasks.where(orgId, "parentId", t.id).length) throw new TRPCError({ code: "BAD_REQUEST", message: "A task with its own subtasks can't become a subtask." });
      set.parentId = p.id;
      set.listId = p.listId;
      said.push(`made this a subtask of "${p.name}"`);
    } else {
      set.parentId = null;
      said.push("made this its own task");
    }
  }
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
  const fieldChanges: { id: string; value: unknown }[] = [];
  if (patch.fields !== undefined) {
    const old = parse<Record<string, unknown>>(t.fields, {});
    for (const [k, val] of Object.entries(patch.fields)) if (JSON.stringify(old[k] ?? null) !== JSON.stringify(val ?? null)) fieldChanges.push({ id: k, value: val });
    set.fields = JSON.stringify(patch.fields);
  }
  if (patch.checklist !== undefined) set.checklist = JSON.stringify(patch.checklist.filter((x) => x.text.trim()).slice(0, 100));
  if (patch.goalId !== undefined) set.goalId = patch.goalId;
  if (patch.sort !== undefined) set.sort = patch.sort;
  if (patch.repeat !== undefined) {
    const next = cleanRepeat(patch.repeat);
    if (next !== t.repeat) {
      set.repeat = next;
      said.push(patch.repeat ? `set this to repeat ${repeatText(patch.repeat)}` : "stopped this repeating");
    }
  }
  if (patch.watchers !== undefined) {
    const before = parse<Assignee[]>(t.watchers, []);
    set.watchers = JSON.stringify(patch.watchers.slice(0, 30));
    const added = patch.watchers.filter((a) => !before.some((b) => b.type === a.type && b.id === a.id));
    if (added.length) said.push(`added ${added.map((a) => a.name).join(", ")} as watcher${added.length === 1 ? "" : "s"}`);
  }
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
  // Moving the due date moves the tasks waiting on this one by the same days.
  if (set.dueDate && t.dueDate && set.dueDate !== t.dueDate) shiftDependents(orgId, id, daysBetween(t.dueDate, set.dueDate), by);
  if (set.status !== undefined) {
    await runAutomations(orgId, next, { on: "status", to: set.status });
    if (set.status !== t.status) await tellWatchers(orgId, next, by, `${by.name} moved "${next.name}" to ${set.status}`);
    if (set.closedAt && !t.closedAt) await closed(orgId, next, by);
  }
  for (const f of fieldChanges) await runAutomations(orgId, next, { on: "field", field: f.id, to: typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? "") });
  if (patch.assignees !== undefined) await assigned(orgId, next, before, patch.assignees, by);
  return db.work.tasks.get(orgId, id)!;
}

export const fmtYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
export const addDaysYmd = (s: string, n: number) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function repeatText(r: Repeat) {
  const base = r.unit === "week" && r.days?.length ? `every ${r.every > 1 ? `${r.every} weeks on ` : ""}${r.days.map((d) => DAY[d]).join(", ")}` : `every ${r.every > 1 ? `${r.every} ${r.unit}s` : r.unit}`;
  return base;
}

/** Moves every date of a task (dragging a bar on the Gantt), and the tasks waiting on it by the same days. */
export function shiftDates(orgId: number, id: number, startDate: string | null, dueDate: string | null, by: Actor) {
  const t = mustTask(orgId, id);
  const s = ymd(startDate);
  const d = ymd(dueDate);
  if (s && d && d < s) throw new TRPCError({ code: "BAD_REQUEST", message: "The due date can't be before the start date." });
  db.work.tasks.update(orgId, id, { startDate: s, dueDate: d });
  if (d !== t.dueDate) activity(orgId, id, by, `${by.name} moved the dates to ${s ? `${fmtYmd(s)} to ` : ""}${d ? fmtYmd(d) : "no due date"}`);
  if (d && t.dueDate && d !== t.dueDate) shiftDependents(orgId, id, daysBetween(t.dueDate, d), by);
}

function shiftDependents(orgId: number, id: number, days: number, by: Actor, seen = new Set<number>([id])) {
  if (!days) return;
  for (const l of db.work.links.where(orgId, "otherId", id)) {
    if (l.kind !== "waits" || seen.has(l.taskId)) continue;
    seen.add(l.taskId);
    const w = db.work.tasks.get(orgId, l.taskId);
    if (!w || w.closedAt || (!w.startDate && !w.dueDate)) continue;
    db.work.tasks.update(orgId, w.id, { startDate: w.startDate ? addDaysYmd(w.startDate, days) : null, dueDate: w.dueDate ? addDaysYmd(w.dueDate, days) : null });
    activity(orgId, w.id, by, `Dates moved ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "later" : "earlier"} because a task it waits on moved`);
    shiftDependents(orgId, w.id, days, by, seen);
  }
}

function removeTaskRows(orgId: number, id: number) {
  for (const s of db.work.tasks.where(orgId, "parentId", id)) removeTaskRows(orgId, s.id);
  for (const x of db.work.comments.where(orgId, "taskId", id)) db.work.comments.remove(orgId, x.id);
  for (const f of db.work.files.all(orgId).filter((x) => x.itemType === "task" && x.itemId === id)) db.work.files.remove(orgId, f.id);
  for (const l of db.work.links.all(orgId).filter((x) => x.taskId === id || x.otherId === id)) db.work.links.remove(orgId, l.id);
  for (const e of db.work.time.where(orgId, "taskId", id)) db.work.time.remove(orgId, e.id);
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
  await tellWatchers(orgId, t, by, `${by.name} on "${t.name}": ${text.slice(0, 140)}`, users);
  await runAutomations(orgId, t, { on: "comment" });
  return c;
}

/** Watchers hear about status changes and comments (except from themselves). */
async function tellWatchers(orgId: number, t: PjTask, by: Actor, body: string, skip: number[] = []) {
  const ids = parse<Assignee[]>(t.watchers, [])
    .filter((w) => w.type === "user" && !(by.type === "user" && by.id === w.id) && !skip.includes(w.id))
    .map((w) => w.id);
  if (ids.length) await notify(orgId, "task_assigned", { title: "A task you watch changed", body, url: `/projects?task=${t.id}` }, { only: ids }).catch(() => null);
}

// ==========================================
// Done: repeats, unblocking, subtasks
// ==========================================

async function closed(orgId: number, t: PjTask, by: Actor) {
  // A task that repeats when done makes its next one.
  const r = t.repeat ? parse<Repeat | null>(t.repeat, null) : null;
  if (r && r.mode === "done" && !r.spawned) await spawnNext(orgId, t, by);
  // Tasks waiting on this one may be free now.
  for (const l of db.work.links.where(orgId, "otherId", t.id)) {
    if (l.kind !== "waits") continue;
    const w = db.work.tasks.get(orgId, l.taskId);
    if (!w || w.closedAt) continue;
    const still = db.work.links.where(orgId, "taskId", w.id).filter((x) => x.kind === "waits").some((x) => !db.work.tasks.get(orgId, x.otherId)?.closedAt);
    if (still) continue;
    activity(orgId, w.id, { type: "system", id: null, name: "Projects" }, `No longer waiting: "${t.name}" is done`);
    const users = parse<Assignee[]>(w.assignees, []).filter((a) => a.type === "user").map((a) => a.id);
    if (users.length) await notify(orgId, "task_assigned", { title: "A task you're on can start", body: `"${t.name}" is done, so "${w.name}" isn't waiting anymore.`, url: `/projects?task=${w.id}` }, { only: users }).catch(() => null);
    await runAutomations(orgId, w, { on: "unblocked" });
  }
  // The last subtask done.
  if (t.parentId) {
    const sibs = db.work.tasks.where(orgId, "parentId", t.parentId);
    const parent = db.work.tasks.get(orgId, t.parentId);
    if (parent && sibs.every((s) => s.closedAt)) await runAutomations(orgId, parent, { on: "subtasks" });
  }
}

/** The next date a repeating task lands on, after `from`. */
export function nextDate(from: string, r: Repeat) {
  if (r.unit === "day") return addDaysYmd(from, r.every);
  if (r.unit === "week") {
    if (!r.days?.length) return addDaysYmd(from, 7 * r.every);
    const dow = new Date(`${from}T12:00:00Z`).getUTCDay();
    const later = r.days.filter((d) => d > dow);
    if (later.length) return addDaysYmd(from, later[0] - dow);
    return addDaysYmd(from, 7 * (r.every - 1) + 7 - dow + r.days[0]);
  }
  const [y, m, d] = from.split("-").map(Number);
  const months = r.unit === "month" ? r.every : 12 * r.every;
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Makes the next task of a repeating one, with its dates moved to the next time. */
export async function spawnNext(orgId: number, t: PjTask, by: Actor) {
  const r = parse<Repeat | null>(t.repeat, null);
  if (!r || r.spawned) return null;
  db.work.tasks.update(orgId, t.id, { repeat: JSON.stringify({ ...r, spawned: true }) });
  const made = (r.made ?? 1) + 1;
  const tz = await zoneOf(orgId);
  const anchor = t.dueDate ?? t.startDate ?? todayYmd(tz);
  const due = nextDate(anchor, r);
  if (r.ends === "date" && r.until && due > r.until) return null;
  if (r.ends === "count" && r.count && made > r.count) return null;
  const span = t.startDate && t.dueDate ? daysBetween(t.startDate, t.dueDate) : null;
  const list = mustList(orgId, t.listId);
  const next = await createTask(
    orgId,
    {
      listId: t.listId,
      name: t.name,
      description: t.description,
      priority: t.priority,
      startDate: span !== null ? addDaysYmd(due, -span) : null,
      dueDate: t.dueDate ? due : null,
      timeEstimate: t.timeEstimate,
      tags: parse<string[]>(t.tags, []),
      assignees: r.keep.assignees ? parse<Assignee[]>(t.assignees, []) : [],
      watchers: parse<Assignee[]>(t.watchers, []),
      fields: parse<Record<string, unknown>>(t.fields, {}),
      checklist: r.keep.checklist ? parse<CheckItem[]>(t.checklist, []).map((x) => ({ text: x.text, done: false })) : [],
      goalId: t.goalId,
      status: statusesOf(list)[0].name,
      repeat: { ...r, made, spawned: false },
    },
    by,
    { quiet: true }
  );
  activity(orgId, next.id, { type: "system", id: null, name: "Projects" }, `Made from the last "${t.name}" (repeats ${repeatText(r)})`);
  if (r.keep.subtasks)
    for (const s of db.work.tasks.where(orgId, "parentId", t.id))
      await createTask(orgId, { listId: t.listId, parentId: next.id, name: s.name, description: s.description, assignees: r.keep.assignees ? parse<Assignee[]>(s.assignees, []) : [], dueDate: s.dueDate && t.dueDate ? addDaysYmd(s.dueDate, daysBetween(t.dueDate, due)) : null }, by, { quiet: true });
  if (r.keep.comments)
    for (const x of db.work.comments.where(orgId, "taskId", t.id).filter((x) => x.kind === "comment"))
      db.work.comments.insert({ organizationId: orgId, taskId: next.id, kind: "comment", authorType: x.authorType, authorId: x.authorId, authorName: x.authorName, body: x.body });
  return next;
}

// ==========================================
// Waiting on, blocking and linked tasks
// ==========================================

/** kind "waits": taskId waits on otherId; "blocks": taskId blocks otherId; "link": related. */
export function addLink(orgId: number, taskId: number, otherId: number, kind: "waits" | "blocks" | "link", by: Actor) {
  if (taskId === otherId) throw new TRPCError({ code: "BAD_REQUEST", message: "A task can't wait on itself." });
  const a = mustTask(orgId, taskId);
  const b = mustTask(orgId, otherId);
  const [waiter, blocker] = kind === "blocks" ? [b, a] : [a, b];
  const all = db.work.links.all(orgId);
  if (kind === "link") {
    if (all.some((l) => l.kind === "link" && ((l.taskId === a.id && l.otherId === b.id) || (l.taskId === b.id && l.otherId === a.id)))) return;
    db.work.links.insert({ organizationId: orgId, taskId: a.id, otherId: b.id, kind: "link" });
    activity(orgId, a.id, by, `${by.name} linked "${b.name}"`);
    return;
  }
  if (all.some((l) => l.kind === "waits" && l.taskId === waiter.id && l.otherId === blocker.id)) return;
  // No loops: the blocker can't already wait (directly or not) on the waiter.
  const waitsOn = (from: number, seen = new Set<number>()): boolean => {
    if (from === waiter.id) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return all.filter((l) => l.kind === "waits" && l.taskId === from).some((l) => waitsOn(l.otherId, seen));
  };
  if (waitsOn(blocker.id)) throw new TRPCError({ code: "BAD_REQUEST", message: `"${blocker.name}" already waits on "${waiter.name}", so that would be a loop.` });
  db.work.links.insert({ organizationId: orgId, taskId: waiter.id, otherId: blocker.id, kind: "waits" });
  activity(orgId, waiter.id, by, `${by.name} set this to wait on "${blocker.name}"`);
}
export function removeLink(orgId: number, linkId: number) {
  db.work.links.remove(orgId, linkId);
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
  await runAutomations(orgId, t, { on: "assigned" });
}

/** What an employee made, worded for the task's comment: each card's title, what it says, and where it is. */
export function workText(cards: { type: string; title: string; subtitle?: string; body?: string; url?: string | null }[]) {
  const skip = new Set(["choices", "browser_live", "limit_note", "question", "onboarding_q", "layout_choice"]);
  return cards
    .filter((c) => !skip.has(c.type) && (c.title || c.body))
    .map((c) => [c.title ? `${c.title}${c.subtitle ? ` (${c.subtitle})` : ""}` : "", c.body?.trim() ?? "", c.url ? c.url : ""].filter(Boolean).join("\n"))
    .join("\n\n")
    .slice(0, 9000);
}

/**
 * An employee works on a task it was given (or answers an @mention) with its
 * own actions, right away, and posts what it made on the task: the task's
 * activity says it started, the comment holds the result (the draft, the
 * report, the links), and the task moves to an active status.
 */
export async function askEmployee(orgId: number, t: PjTask, e: Owner, said: string) {
  try {
    const emp = await db.getEmployeeForOrg(e.id, orgId);
    if (!emp || emp.status === "paused") return;
    const list = db.work.lists.get(orgId, t.listId);
    const by: Actor = { type: "employee", id: emp.id, name: emp.name };
    activity(orgId, t.id, by, `${emp.name} started on it`);
    if (list) {
      const active = statusesOf(list).find((s) => s.type === "active");
      const cur = db.work.tasks.get(orgId, t.id);
      if (active && cur && statusesOf(list).find((s) => s.name === cur.status)?.type === "open") await updateTask(orgId, t.id, { status: active.name }, by);
    }
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
    const made = workText(r.cards);
    const text = r.action === "none" ? `I can't do this one with what I have${r.text ? `: ${r.text}` : "."}` : [r.text || "Done. Here is what I made.", made].filter(Boolean).join("\n\n");
    await comment(orgId, t.id, text, by);
    if (r.action === "none" && list) {
      // Back to open so a person picks it up.
      const open = statusesOf(list).find((s) => s.type === "open");
      const cur = db.work.tasks.get(orgId, t.id);
      if (open && cur && statusesOf(list).find((s) => s.name === cur.status)?.type === "active") await updateTask(orgId, t.id, { status: open.name }, by);
    }
  } catch (err) {
    console.warn("[projects] employee task failed:", err instanceof Error ? err.message : err);
    try {
      const emp = await db.getEmployeeForOrg(e.id, orgId);
      if (emp) await comment(orgId, t.id, `I hit a problem and couldn't finish this: ${err instanceof Error ? err.message : String(err)}`, { type: "employee", id: emp.id, name: emp.name });
    } catch {
      /* the task keeps going without the note */
    }
  }
}

// ==========================================
// Automations
// ==========================================

export const TRIGGERS = ["created", "status", "due", "overdue", "field", "assigned", "comment", "subtasks", "unblocked", "form", "schedule"] as const;
export const ACTIONS = ["assign", "priority", "status", "field", "watcher", "comment", "task", "move", "ask", "notify", "chat", "email", "meeting"] as const;
export type Trigger = {
  on: (typeof TRIGGERS)[number];
  /** status: the status it moves to; field: the value it changes to ("" for any change). */
  to?: string;
  field?: string;
  formId?: number;
  /** schedule: every day, weekday, or a day of the week, at a time (HH:MM in the workspace's zone). */
  every?: "day" | "weekday" | "week";
  day?: number;
  time?: string;
};
export type Action = {
  do: (typeof ACTIONS)[number];
  /** assign/watcher/ask/notify: "user:5" or "employee:3"; priority/status: the name; comment/chat/email/meeting: the words; field: the value; move: a list id; task: the task's name. */
  value: string;
  field?: string;
  listId?: number;
  templateId?: number;
  /** email: who it goes to ("assignees" or an address). */
  to?: string;
};

export function automations(orgId: number, scope: { listId: number | null; folderId?: number | null; all?: boolean }) {
  return db.work.automations
    .all(orgId)
    .filter((a) => scope.all || (a.listId === scope.listId && (scope.listId !== null || (a.folderId ?? null) === (scope.folderId ?? null))))
    .map((a) => ({ id: a.id, listId: a.listId, folderId: a.folderId, active: a.active, trigger: parse<Trigger>(a.trigger, { on: "created" }), action: parse<Action>(a.action, { do: "comment", value: "" }) }));
}
export function saveAutomation(orgId: number, input: { id?: number; listId: number | null; folderId?: number | null; trigger: Trigger; action: Action; active: boolean }) {
  if (input.listId) mustList(orgId, input.listId);
  if (!input.action.value.trim() && input.action.do !== "meeting" && !(input.action.do === "task" && input.action.templateId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick what the automation does." });
  if (input.trigger.on === "schedule" && !["task", "chat", "notify", "email", "meeting"].includes(input.action.do)) throw new TRPCError({ code: "BAD_REQUEST", message: "A scheduled automation can make a task, post in the Team chat, notify someone, send an email or add a meeting topic." });
  if (input.trigger.on === "schedule" && input.trigger.time && !/^\d{2}:\d{2}$/.test(input.trigger.time)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a time." });
  const row = { listId: input.listId, folderId: input.listId ? null : input.folderId ?? null, trigger: JSON.stringify(input.trigger), action: JSON.stringify({ ...input.action, value: input.action.value.slice(0, 500) }), active: input.active };
  if (input.id) return db.work.automations.update(orgId, input.id, row);
  return db.work.automations.insert({ organizationId: orgId, ...row });
}
export function removeAutomation(orgId: number, id: number) {
  db.work.automations.remove(orgId, id);
}

/** Rules that cover a list: its own, its folder's, and every-list ones. */
function rulesFor(orgId: number, listId: number) {
  const list = db.work.lists.get(orgId, listId);
  return db.work.automations.all(orgId).filter((a) => a.active && (a.listId === listId || (a.listId === null && (a.folderId === null || a.folderId === list?.folderId))));
}

const fill = (s: string, t: PjTask) => {
  const list = db.work.lists.get(t.organizationId, t.listId);
  return s
    .replace(/\{task\}/g, t.name)
    .replace(/\{assignees\}/g, parse<Assignee[]>(t.assignees, []).map((a) => a.name).join(", ") || "no one")
    .replace(/\{list\}/g, list?.name ?? "")
    .replace(/\{due\}/g, t.dueDate ? fmtYmd(t.dueDate) : "no due date");
};

export async function runAutomations(orgId: number, t: PjTask, event: Trigger, depth = 0, onlyRule?: number) {
  if (depth > 2) return;
  const rules = rulesFor(orgId, t.listId).filter((r) => onlyRule === undefined || r.id === onlyRule);
  for (const r of rules) {
    const tr = parse<Trigger>(r.trigger, { on: "created" });
    if (tr.on !== event.on) continue;
    if (tr.on === "status" && tr.to && tr.to !== event.to) continue;
    if (tr.on === "field" && (tr.field !== event.field || (tr.to && tr.to !== event.to))) continue;
    if (tr.on === "form" && tr.formId && tr.formId !== event.formId) continue;
    await doAction(orgId, t, parse<Action>(r.action, { do: "comment", value: "" }), depth);
  }
}

const SYS: Actor = { type: "system", id: null, name: "Automation" };

async function who(orgId: number, value: string) {
  const [type, idStr] = value.split(":");
  return ownerOf(await owners(orgId), type, Number(idStr));
}

/** One automation action on a task (or with no task, for scheduled rules). */
export async function doAction(orgId: number, t: PjTask | null, a: Action, depth = 0) {
  const cur = t ? db.work.tasks.get(orgId, t.id) : null;
  if (t && !cur) return;
  const words = (s: string) => (cur ? fill(s, cur) : s);
  if (a.do === "chat") {
    const msg = db.team.send({ organizationId: orgId, channel: "everyone", userId: 0, authorName: "Projects", content: words(a.value).slice(0, 2000), attachments: null });
    const { people } = await import("../team");
    const ids = (await people(orgId)).map((p: { userId: number }) => p.userId);
    if (ids.length) await notify(orgId, "team_message", { title: "Projects in Everyone", body: words(a.value).slice(0, 200), url: "/chats/team/everyone", tag: "team-everyone" }, { only: ids }).catch(() => null);
    return msg;
  }
  if (a.do === "meeting") {
    const { addTopic } = await import("./simone");
    addTopic(orgId, words(a.value || (cur ? `${cur.name}` : "")), "Automation");
    return;
  }
  if (a.do === "notify") {
    const o = await who(orgId, a.value.split("|")[0]);
    const text = a.value.split("|")[1] ?? (cur ? `"${cur.name}" needs a look` : "");
    if (o?.type === "user") await notify(orgId, "task_assigned", { title: "Projects automation", body: words(text), url: cur ? `/projects?task=${cur.id}` : "/projects" }, { only: [o.id] }).catch(() => null);
    return;
  }
  if (a.do === "email") {
    const { sendEmail } = await import("../_core/email");
    const to: string[] = [];
    if (!a.to || a.to === "assignees") {
      const ids = cur ? parse<Assignee[]>(cur.assignees, []).filter((x) => x.type === "user").map((x) => x.id) : [];
      for (const u of await db.getUsersByIds(ids)) if (u.email) to.push(u.email);
    } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.to)) to.push(a.to);
    for (const addr of to) await sendEmail(addr, cur ? `About "${cur.name}"` : "From Projects", words(a.value)).catch(() => null);
    return;
  }
  if (a.do === "task") {
    const listId = a.listId ?? cur?.listId;
    if (!listId || !db.work.lists.get(orgId, listId)) return;
    if (a.templateId) {
      const { useTaskTemplate } = await import("./pjTemplates");
      await useTaskTemplate(orgId, a.templateId, { listId, name: a.value ? words(a.value) : undefined }, SYS);
    } else await createTask(orgId, { listId, name: words(a.value) }, SYS);
    return;
  }
  if (!cur) return;
  if (a.do === "comment") activity(orgId, cur.id, SYS, words(a.value));
  else if (a.do === "priority" && (PRIORITIES as readonly string[]).includes(a.value)) db.work.tasks.update(orgId, cur.id, { priority: a.value as PjTask["priority"] });
  else if (a.do === "status") {
    const list = db.work.lists.get(orgId, cur.listId);
    if (list && statusesOf(list).some((s) => s.name === a.value) && cur.status !== a.value) {
      const wasOpen = !cur.closedAt;
      db.work.tasks.update(orgId, cur.id, { status: a.value, closedAt: isClosed(list, a.value) ? new Date() : null });
      activity(orgId, cur.id, SYS, `Automation moved this to ${a.value}`);
      const after = db.work.tasks.get(orgId, cur.id)!;
      await runAutomations(orgId, after, { on: "status", to: a.value }, depth + 1);
      if (wasOpen && after.closedAt) await closed(orgId, after, SYS);
    }
  } else if (a.do === "field" && a.field) {
    const f = parse<Record<string, unknown>>(cur.fields, {});
    db.work.tasks.update(orgId, cur.id, { fields: JSON.stringify({ ...f, [a.field]: a.value }) });
    activity(orgId, cur.id, SYS, `Automation set a field to ${a.value}`);
  } else if (a.do === "move" && a.listId) {
    const to = db.work.lists.get(orgId, a.listId);
    if (to && to.id !== cur.listId) {
      db.work.tasks.update(orgId, cur.id, { listId: to.id, status: statusesOf(to).some((s) => s.name === cur.status) ? cur.status : statusesOf(to)[0].name });
      activity(orgId, cur.id, SYS, `Automation moved this to ${to.name}`);
    }
  } else if (a.do === "assign" || a.do === "watcher" || a.do === "ask") {
    const o = await who(orgId, a.value);
    if (!o) return;
    if (a.do === "ask") {
      if (o.type === "employee") void askEmployee(orgId, cur, o, "");
      return;
    }
    const key = a.do === "assign" ? "assignees" : "watchers";
    const before = parse<Assignee[]>(cur[key], []);
    if (before.some((b) => b.type === o.type && b.id === o.id)) return;
    const after = [...before, { type: o.type, id: o.id, name: o.name }];
    db.work.tasks.update(orgId, cur.id, { [key]: JSON.stringify(after) });
    activity(orgId, cur.id, SYS, `Automation ${a.do === "assign" ? "assigned" : "added as a watcher"} ${o.name}`);
    if (a.do === "assign") await assigned(orgId, db.work.tasks.get(orgId, cur.id)!, before, after, SYS);
  }
}

// ==========================================
// For employees in chat
// ==========================================

/** Finds tasks by words, person, or what's due (in the lists this viewer can see). */
export function find(orgId: number, input: { words?: string; who?: string; dueBy?: string; includeDone?: boolean }, v: Viewer = { kind: "system" }) {
  const words = (input.words ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const lists = visibleLists(orgId, v).map((x) => x.list);
  const ids = new Set(lists.map((l) => l.id));
  return db.work.tasks
    .all(orgId)
    .filter((t) => ids.has(t.listId))
    .filter((t) => input.includeDone || !t.closedAt)
    .filter((t) => !words.length || words.every((w) => `${t.name} ${lists.find((l) => l.id === t.listId)?.name ?? ""}`.toLowerCase().includes(w)))
    .filter((t) => !input.who || parse<Assignee[]>(t.assignees, []).some((a) => a.name.toLowerCase().includes(input.who!.toLowerCase())))
    .filter((t) => !input.dueBy || (t.dueDate && t.dueDate <= input.dueBy))
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))
    .slice(0, 40)
    .map((t) => ({ id: t.id, name: t.name, list: lists.find((l) => l.id === t.listId)?.name ?? "", status: t.status, due: t.dueDate ? fmtYmd(t.dueDate) : "no due date", assignees: parse<Assignee[]>(t.assignees, []).map((a) => a.name) }));
}

/** The list a name points to (among lists this viewer can see), else null. */
export function listNamed(orgId: number, name: string, v: Viewer = { kind: "system" }) {
  const lists = visibleLists(orgId, v).map((x) => x.list);
  const n = name.trim().toLowerCase();
  return (n && (lists.find((l) => l.name.toLowerCase() === n) ?? lists.find((l) => l.name.toLowerCase().includes(n)))) || null;
}
