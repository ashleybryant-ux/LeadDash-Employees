import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjTask } from "../../drizzle/schema";
import { pageOf } from "./pjDocs";
import { createTask, parse, saveList, statusesOf, addDaysYmd, daysBetween, type Actor, type Assignee, type CheckItem, type FieldDef, type Repeat } from "./projects";

/**
 * Templates: a saved task (with its subtasks and checklist), a whole list
 * (statuses, fields and tasks, with dates kept relative to the start), or a
 * doc. Using one makes a fresh copy.
 */

type TaskSnap = {
  name: string;
  description: string;
  priority: PjTask["priority"];
  timeEstimate: number | null;
  tags: string[];
  assignees: Assignee[];
  watchers: Assignee[];
  fields: Record<string, unknown>;
  checklist: CheckItem[];
  repeat: Repeat | null;
  status: string;
  /** Days from the template's start to this task's start and due dates. */
  startOffset: number | null;
  dueOffset: number | null;
  files: number[];
  comments: { authorName: string; body: string }[];
  subtasks: TaskSnap[];
};

function snapTask(orgId: number, t: PjTask, base: string | null): TaskSnap {
  const off = (d: string | null) => (d && base ? daysBetween(base, d) : null);
  return {
    name: t.name,
    description: t.description,
    priority: t.priority,
    timeEstimate: t.timeEstimate,
    tags: parse<string[]>(t.tags, []),
    assignees: parse<Assignee[]>(t.assignees, []),
    watchers: parse<Assignee[]>(t.watchers, []),
    fields: parse<Record<string, unknown>>(t.fields, {}),
    checklist: parse<CheckItem[]>(t.checklist, []).map((c) => ({ text: c.text, done: false })),
    repeat: t.repeat ? parse<Repeat | null>(t.repeat, null) : null,
    status: t.status,
    startOffset: off(t.startDate),
    dueOffset: off(t.dueDate),
    files: db.work.files.all(orgId).filter((f) => f.itemType === "task" && f.itemId === t.id).map((f) => f.fileId),
    comments: db.work.comments.where(orgId, "taskId", t.id).filter((c) => c.kind === "comment").map((c) => ({ authorName: c.authorName, body: c.body })),
    subtasks: db.work.tasks.where(orgId, "parentId", t.id).map((s) => snapTask(orgId, s, base)),
  };
}

export function templates(orgId: number) {
  return db.work.templates
    .all(orgId)
    .sort((a, b) => b.id - a.id)
    .map((t) => {
      const d = parse<{ tasks?: TaskSnap[]; task?: TaskSnap; list?: { statuses: unknown[]; fields: unknown[] }; doc?: { blocks: unknown[] } }>(t.data, {});
      const summary =
        t.kind === "list"
          ? `${d.tasks?.length ?? 0} tasks · ${d.list?.statuses.length ?? 0} statuses${d.list?.fields.length ? ` · ${d.list.fields.length} fields` : ""}`
          : t.kind === "task"
            ? [d.task?.subtasks.length ? `${d.task.subtasks.length} subtasks` : "", d.task?.checklist.length ? "checklist" : "", d.task?.repeat ? "repeats" : ""].filter(Boolean).join(" · ") || "One task"
            : `${d.doc?.blocks.length ?? 0} blocks`;
      return { id: t.id, kind: t.kind, name: t.name, description: t.description, folderName: t.folderName, summary, createdBy: t.createdBy, createdAt: t.createdAt };
    });
}

export function saveTaskTemplate(orgId: number, taskId: number, input: { name: string; description: string }, by: string) {
  const t = db.work.tasks.get(orgId, taskId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  const list = db.work.lists.get(orgId, t.listId);
  const folder = list?.folderId ? db.work.folders.get(orgId, list.folderId) : null;
  const base = t.startDate ?? t.dueDate;
  return db.work.templates.insert({ organizationId: orgId, kind: "task", name: (input.name.trim() || t.name).slice(0, 120), description: input.description.slice(0, 500), folderName: folder?.name ?? list?.name ?? "", data: JSON.stringify({ task: snapTask(orgId, t, base) }), createdBy: by });
}

export function saveListTemplate(orgId: number, listId: number, input: { name: string; description: string }, by: string) {
  const l = db.work.lists.get(orgId, listId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const folder = l.folderId ? db.work.folders.get(orgId, l.folderId) : null;
  const tasks = db.work.tasks.where(orgId, "listId", l.id).filter((t) => !t.parentId);
  const dates = tasks.flatMap((t) => [t.startDate, t.dueDate]).filter((d): d is string => !!d).sort();
  const base = dates[0] ?? null;
  return db.work.templates.insert({
    organizationId: orgId,
    kind: "list",
    name: (input.name.trim() || l.name).slice(0, 120),
    description: input.description.slice(0, 500),
    folderName: folder?.name ?? "",
    data: JSON.stringify({ list: { name: l.name, description: l.description, statuses: statusesOf(l), fields: parse<FieldDef[]>(l.fields, []) }, tasks: tasks.map((t) => snapTask(orgId, t, base)) }),
    createdBy: by,
  });
}

export function saveDocTemplate(orgId: number, docId: number, input: { name: string; description: string }, by: string) {
  const d = db.work.docs.get(orgId, docId);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That doc isn't in this workspace." });
  const folder = d.folderId ? db.work.folders.get(orgId, d.folderId) : null;
  return db.work.templates.insert({ organizationId: orgId, kind: "doc", name: (input.name.trim() || d.title).slice(0, 120), description: input.description.slice(0, 500), folderName: folder?.name ?? "", data: JSON.stringify({ doc: { title: d.title, blocks: parse<unknown[]>(d.blocks, []), html: pageOf(orgId, d) } }), createdBy: by });
}

export function updateTemplate(orgId: number, id: number, input: { name: string; description: string }) {
  if (!db.work.templates.get(orgId, id)) throw new TRPCError({ code: "NOT_FOUND", message: "That template isn't here anymore." });
  if (!input.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the template." });
  db.work.templates.update(orgId, id, { name: input.name.trim().slice(0, 120), description: input.description.slice(0, 500) });
}
export function removeTemplate(orgId: number, id: number) {
  db.work.templates.remove(orgId, id);
}

type Keep = { assignees: boolean; dates: boolean; attachments: boolean; comments: boolean };
const ALL: Keep = { assignees: true, dates: true, attachments: true, comments: false };

async function makeFrom(orgId: number, s: TaskSnap, listId: number, parentId: number | null, start: string | null, keep: Keep, by: Actor, name?: string) {
  const list = db.work.lists.get(orgId, listId)!;
  const at = (o: number | null) => (keep.dates && start && o !== null ? addDaysYmd(start, o) : null);
  const t = await createTask(
    orgId,
    {
      listId,
      parentId,
      name: name ?? s.name,
      description: s.description,
      priority: s.priority,
      timeEstimate: s.timeEstimate,
      tags: s.tags,
      assignees: keep.assignees ? s.assignees : [],
      watchers: s.watchers,
      fields: s.fields,
      checklist: s.checklist,
      repeat: s.repeat ? { ...s.repeat, made: 1, spawned: false } : null,
      status: statusesOf(list).some((x) => x.name === s.status) && statusesOf(list).find((x) => x.name === s.status)?.type !== "done" ? s.status : statusesOf(list)[0].name,
      startDate: at(s.startOffset),
      dueDate: at(s.dueOffset),
    },
    by
  );
  if (keep.attachments) for (const f of db.getChatFiles(orgId, s.files)) db.work.files.insert({ organizationId: orgId, itemType: "task", itemId: t.id, fileId: f.id, addedBy: by.name });
  if (keep.comments) for (const c of s.comments) db.work.comments.insert({ organizationId: orgId, taskId: t.id, kind: "comment", authorType: "system", authorId: null, authorName: c.authorName, body: c.body });
  for (const sub of s.subtasks) await makeFrom(orgId, sub, listId, t.id, start, keep, by);
  return t;
}

/** Makes a task from a task template in a list; its dates count from today (or the given day). */
export async function useTaskTemplate(orgId: number, id: number, input: { listId: number; name?: string; startDate?: string | null }, by: Actor) {
  const tp = db.work.templates.get(orgId, id);
  if (!tp || tp.kind !== "task") throw new TRPCError({ code: "NOT_FOUND", message: "That template isn't here anymore." });
  if (!db.work.lists.get(orgId, input.listId)) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const s = parse<{ task: TaskSnap }>(tp.data, { task: null as unknown as TaskSnap }).task;
  const { todayYmd, zoneOf } = await import("./goals");
  const start = input.startDate ?? todayYmd(await zoneOf(orgId));
  return makeFrom(orgId, s, input.listId, null, start, ALL, by, input.name);
}

/** Makes a new list from a list template, with every date moved to count from the start date. */
export async function useListTemplate(orgId: number, id: number, input: { name: string; folderId: number | null; startDate: string | null; keep: Keep }, by: Actor) {
  const tp = db.work.templates.get(orgId, id);
  if (!tp || tp.kind !== "list") throw new TRPCError({ code: "NOT_FOUND", message: "That template isn't here anymore." });
  const d = parse<{ list: { name: string; description: string; statuses: ReturnType<typeof statusesOf>; fields: FieldDef[] }; tasks: TaskSnap[] }>(tp.data, { list: { name: "", description: "", statuses: [], fields: [] }, tasks: [] });
  const l = saveList(orgId, { name: input.name.trim() || d.list.name, folderId: input.folderId, description: d.list.description, statuses: d.list.statuses, fields: d.list.fields });
  for (const s of d.tasks) await makeFrom(orgId, s, l.id, null, input.startDate, input.keep, by);
  return l;
}

export function useDocTemplate(orgId: number, id: number, input: { title: string; folderId: number | null }, by: string) {
  const tp = db.work.templates.get(orgId, id);
  if (!tp || tp.kind !== "doc") throw new TRPCError({ code: "NOT_FOUND", message: "That template isn't here anymore." });
  const d = parse<{ doc: { title: string; blocks: unknown[]; html?: string } }>(tp.data, { doc: { title: "", blocks: [] } }).doc;
  return db.work.docs.insert({ organizationId: orgId, folderId: input.folderId, title: (input.title.trim() || d.title).slice(0, 200), blocks: JSON.stringify(d.blocks), html: d.html ?? "", editedBy: by });
}
