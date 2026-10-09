import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { createTask, parse, type Actor } from "./projects";

/**
 * Docs and whiteboards in Projects folders.
 *
 * A doc is a list of blocks (headings, paragraphs, lists, checklists, quotes,
 * tables, images and task links) rather than raw HTML, so nothing anyone types
 * can run as code when someone else opens it. Inline marks are **bold**,
 * *italic* and [words](https://link).
 *
 * A whiteboard is a canvas of sticky notes, shapes, freehand lines, text,
 * arrows between items and task cards; sticky notes can become tasks.
 */

export const BLOCK_TYPES = ["h1", "h2", "p", "bullet", "number", "check", "quote", "table", "image", "task", "divider"] as const;
export type Block = { id: string; type: (typeof BLOCK_TYPES)[number]; text: string; done?: boolean; rows?: string[][]; url?: string; taskId?: number };

const safeUrl = (u: string | undefined) => (u && (/^\/files\//.test(u) || /^https:\/\//.test(u)) ? u.slice(0, 600) : undefined);

export function cleanBlocks(raw: Block[]): Block[] {
  return raw.slice(0, 600).map((b, i) => {
    const type = (BLOCK_TYPES as readonly string[]).includes(b.type) ? b.type : "p";
    return {
      id: String(b.id || `b${i}`).slice(0, 40),
      type,
      text: String(b.text ?? "").slice(0, 8000),
      ...(type === "check" ? { done: !!b.done } : {}),
      ...(type === "table" ? { rows: (b.rows ?? [["", ""], ["", ""]]).slice(0, 30).map((r) => r.slice(0, 10).map((c) => String(c ?? "").slice(0, 500))) } : {}),
      ...(type === "image" ? { url: safeUrl(b.url) } : {}),
      ...(type === "task" && b.taskId ? { taskId: Number(b.taskId) } : {}),
    };
  });
}

function mustDoc(orgId: number, id: number) {
  const d = db.work.docs.get(orgId, id);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That doc isn't in this workspace." });
  return d;
}

export function doc(orgId: number, id: number) {
  const d = mustDoc(orgId, id);
  const folder = d.folderId ? db.work.folders.get(orgId, d.folderId) : null;
  const parent = d.parentId ? db.work.docs.get(orgId, d.parentId) : null;
  const blocks = parse<Block[]>(d.blocks, []);
  const ids = Array.from(new Set([...parse<number[]>(d.taskIds, []), ...blocks.filter((b) => b.type === "task" && b.taskId).map((b) => b.taskId!)]));
  const lists = db.work.lists.all(orgId);
  const tasks = ids.map((tid) => db.work.tasks.get(orgId, tid)).filter((t): t is NonNullable<typeof t> => !!t);
  return {
    doc: { id: d.id, title: d.title, folderId: d.folderId, folderName: folder?.name ?? null, listId: d.listId, parentId: d.parentId, blocks, editedBy: d.editedBy, updatedAt: d.updatedAt, private: d.private, workspaceWide: d.workspaceWide, link: !!d.shareToken, archived: !!d.archivedAt },
    parent: parent ? { id: parent.id, title: parent.title } : null,
    pages: db.work.docs.where(orgId, "parentId", d.id).sort((a, b) => a.sort - b.sort || a.id - b.id).map((p) => ({ id: p.id, title: p.title })),
    linked: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, closed: !!t.closedAt, listName: lists.find((l) => l.id === t.listId)?.name ?? "" })),
    explicit: parse<number[]>(d.taskIds, []),
    comments: db.work.docComments.where(orgId, "docId", d.id).sort((a, b) => a.id - b.id).map((c) => ({ id: c.id, quote: c.quote, body: c.body, authorName: c.authorName, authorId: c.authorId, at: c.createdAt })),
  };
}

export function saveDoc(orgId: number, input: { id?: number; folderId?: number | null; listId?: number | null; parentId?: number | null; title: string; blocks?: Block[] }, by: string, ownerUserId: number | null = null) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the doc." });
  if (input.parentId) mustDoc(orgId, input.parentId);
  if (input.id) {
    mustDoc(orgId, input.id);
    return db.work.docs.update(orgId, input.id, { title, ...(input.blocks ? { blocks: JSON.stringify(cleanBlocks(input.blocks)) } : {}), ...(input.folderId !== undefined ? { folderId: input.folderId } : {}), ...(input.listId !== undefined ? { listId: input.listId } : {}), editedBy: by })!;
  }
  const parent = input.parentId ? db.work.docs.get(orgId, input.parentId) : null;
  // A doc made on a list lives in that list's folder too.
  const onList = input.listId ? db.work.lists.get(orgId, input.listId) : null;
  return db.work.docs.insert({ organizationId: orgId, folderId: parent ? parent.folderId : onList ? onList.folderId : input.folderId ?? null, listId: parent ? parent.listId : input.listId ?? null, parentId: input.parentId ?? null, title, blocks: JSON.stringify(cleanBlocks(input.blocks ?? [{ id: "b0", type: "p", text: "" }])), editedBy: by, sort: db.work.docs.all(orgId).length, ownerUserId: parent ? parent.ownerUserId : ownerUserId, private: parent ? parent.private : false, workspaceWide: parent ? parent.workspaceWide : false });
}

/** Ticking a checklist line works from the read view. */
export function toggleCheck(orgId: number, id: number, blockId: string, done: boolean, by: string) {
  const d = mustDoc(orgId, id);
  const blocks = parse<Block[]>(d.blocks, []).map((b) => (b.id === blockId && b.type === "check" ? { ...b, done } : b));
  db.work.docs.update(orgId, id, { blocks: JSON.stringify(blocks), editedBy: by });
}

export function removeDoc(orgId: number, id: number) {
  mustDoc(orgId, id);
  for (const p of db.work.docs.where(orgId, "parentId", id)) removeDoc(orgId, p.id);
  for (const c of db.work.docComments.where(orgId, "docId", id)) db.work.docComments.remove(orgId, c.id);
  db.work.docs.remove(orgId, id);
}

export function linkTask(orgId: number, docId: number, taskId: number, on: boolean) {
  const d = mustDoc(orgId, docId);
  if (!db.work.tasks.get(orgId, taskId)) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  const ids = parse<number[]>(d.taskIds, []).filter((x) => x !== taskId);
  db.work.docs.update(orgId, docId, { taskIds: JSON.stringify(on ? [...ids, taskId] : ids) });
}

/** Selected words in a doc become a task, linked back to the doc. */
export async function taskFromText(orgId: number, docId: number, input: { text: string; listId: number }, by: Actor) {
  const d = mustDoc(orgId, docId);
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "Select the words for the task first." });
  const t = await createTask(orgId, { listId: input.listId, name: text.slice(0, 120), description: `From the doc "${d.title}":\n\n${text}` }, by);
  linkTask(orgId, docId, t.id, true);
  return t;
}

export function docComment(orgId: number, docId: number, input: { quote: string; body: string }, by: { id: number; name: string }) {
  mustDoc(orgId, docId);
  if (!input.body.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a comment." });
  return db.work.docComments.insert({ organizationId: orgId, docId, quote: input.quote.slice(0, 500), body: input.body.trim().slice(0, 4000), authorName: by.name, authorId: by.id });
}
export function removeDocComment(orgId: number, id: number) {
  db.work.docComments.remove(orgId, id);
}

// ==========================================
// Whiteboards
// ==========================================

export const ITEM_KINDS = ["sticky", "rect", "circle", "text", "pen", "arrow", "task", "frame"] as const;
export type Item = { id: string; kind: (typeof ITEM_KINDS)[number]; x: number; y: number; w: number; h: number; color?: string; text?: string; from?: string; to?: string; taskId?: number; path?: string; z?: number };

const num = (n: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export function cleanItems(raw: Item[]): Item[] {
  return raw.slice(0, 800).map((it, i) => ({
    id: String(it.id || `i${i}`).slice(0, 40),
    kind: (ITEM_KINDS as readonly string[]).includes(it.kind) ? it.kind : "sticky",
    x: num(it.x, -5000, 20000),
    y: num(it.y, -5000, 20000),
    w: num(it.w, 0, 5000),
    h: num(it.h, 0, 5000),
    ...(it.color && /^#[0-9a-f]{6}$/i.test(it.color) ? { color: it.color } : {}),
    ...(it.text ? { text: String(it.text).slice(0, 2000) } : {}),
    ...(it.from ? { from: String(it.from).slice(0, 40) } : {}),
    ...(it.to ? { to: String(it.to).slice(0, 40) } : {}),
    ...(it.taskId ? { taskId: Number(it.taskId) } : {}),
    // A freehand line: "M x y L x y ..." numbers only.
    ...(it.path && /^[ML\d\s.-]+$/.test(it.path) ? { path: it.path.slice(0, 20000) } : {}),
    ...(it.z !== undefined ? { z: num(it.z, -1000, 100000) } : {}),
  }));
}

function mustBoard(orgId: number, id: number) {
  const b = db.work.boards.get(orgId, id);
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "That whiteboard isn't in this workspace." });
  return b;
}

export function board(orgId: number, id: number) {
  const b = mustBoard(orgId, id);
  const items = parse<Item[]>(b.items, []);
  const folder = b.folderId ? db.work.folders.get(orgId, b.folderId) : null;
  const lists = db.work.lists.all(orgId);
  const tasks = items.filter((i) => i.kind === "task" && i.taskId).map((i) => db.work.tasks.get(orgId, i.taskId!)).filter((t): t is NonNullable<typeof t> => !!t);
  return {
    board: { id: b.id, title: b.title, folderId: b.folderId, folderName: folder?.name ?? null, items, editedBy: b.editedBy, updatedAt: b.updatedAt },
    tasks: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, closed: !!t.closedAt, dueDate: t.dueDate, assignees: parse<{ name: string }[]>(t.assignees, []).map((a) => a.name), listName: lists.find((l) => l.id === t.listId)?.name ?? "" })),
  };
}

export function saveBoard(orgId: number, input: { id?: number; folderId?: number | null; listId?: number | null; title: string }, by: string) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the whiteboard." });
  if (input.id) {
    mustBoard(orgId, input.id);
    return db.work.boards.update(orgId, input.id, { title, ...(input.folderId !== undefined ? { folderId: input.folderId } : {}), ...(input.listId !== undefined ? { listId: input.listId } : {}), editedBy: by })!;
  }
  const onList = input.listId ? db.work.lists.get(orgId, input.listId) : null;
  return db.work.boards.insert({ organizationId: orgId, folderId: onList ? onList.folderId : input.folderId ?? null, listId: input.listId ?? null, title, items: "[]", editedBy: by, sort: db.work.boards.all(orgId).length });
}
export function saveItems(orgId: number, id: number, items: Item[], by: string) {
  mustBoard(orgId, id);
  db.work.boards.update(orgId, id, { items: JSON.stringify(cleanItems(items)), editedBy: by });
}
export function removeBoard(orgId: number, id: number) {
  mustBoard(orgId, id);
  db.work.boards.remove(orgId, id);
}

/** The picked sticky notes (and text) become tasks in a list, and turn into task cards where they were. */
export async function makeTasks(orgId: number, id: number, input: { itemIds: string[]; listId: number }, by: Actor) {
  const b = mustBoard(orgId, id);
  const items = parse<Item[]>(b.items, []);
  const made: number[] = [];
  const next: Item[] = [];
  for (const it of items) {
    if (input.itemIds.includes(it.id) && (it.kind === "sticky" || it.kind === "text" || it.kind === "rect" || it.kind === "circle") && it.text?.trim()) {
      const t = await createTask(orgId, { listId: input.listId, name: it.text.replace(/\s+/g, " ").trim().slice(0, 300), description: `From the whiteboard "${b.title}".` }, by);
      made.push(t.id);
      next.push({ id: it.id, kind: "task", x: it.x, y: it.y, w: Math.max(it.w, 220), h: 64, taskId: t.id, z: it.z });
    } else next.push(it);
  }
  db.work.boards.update(orgId, id, { items: JSON.stringify(next), editedBy: by.name });
  return { made: made.length };
}
