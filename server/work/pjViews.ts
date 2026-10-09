import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjList } from "../../drizzle/schema";
import { fieldsOf, parse, type Assignee, type FieldDef } from "./projects";
import { levelFor, mustMember, visibleLists, type Viewer } from "./pjAccess";
import { docLevel, starsOf } from "./pjDocShare";

/**
 * Saved views, the folder Overview and the Docs page.
 *
 * A saved view is a tab on a list or a folder: a kind (list, board, calendar,
 * gantt, table, workload, timeline, mindmap) with its own filters, grouping,
 * sort and columns. A row with an empty name holds the settings of that
 * kind's built-in tab, so the columns someone picks on "List" stay picked.
 * A view with a userId is private to that person.
 */

export const VIEW_KINDS = ["list", "board", "calendar", "gantt", "table", "workload", "timeline", "mindmap"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];
export type ViewSettings = {
  group?: "status" | "priority" | "assignee" | "project" | "none";
  who?: string;
  priority?: string;
  closed?: boolean;
  q?: string;
  /** Column keys: assignee, due, start, priority, status, estimate, tracked, tags, goal, list, or f:<field id>. */
  columns?: string[];
  sort?: string;
};
export type Target = { listId?: number | null; folderId?: number | null };

/** The tabs every list starts with; the other kinds are added with + View (a built-in row with no name marks an added tab). */
export const DEFAULT_TABS: ViewKind[] = ["list", "board", "calendar"];

const COLUMN_KEYS = ["assignee", "due", "start", "priority", "status", "estimate", "tracked", "tags", "goal", "list"];
export const DEFAULT_COLUMNS: Record<string, string[]> = {
  list: ["assignee", "due", "priority", "status", "goal"],
  table: ["status", "assignee", "start", "due", "priority", "estimate", "tracked", "tags", "goal"],
};

export function cleanSettings(s: ViewSettings, fields: FieldDef[]): ViewSettings {
  const out: ViewSettings = {};
  if (s.group && ["status", "priority", "assignee", "project", "none"].includes(s.group)) out.group = s.group;
  if (s.who) out.who = String(s.who).slice(0, 160);
  if (s.priority) out.priority = String(s.priority).slice(0, 20);
  if (s.closed) out.closed = true;
  if (s.q) out.q = String(s.q).slice(0, 120);
  if (s.sort) out.sort = String(s.sort).slice(0, 40);
  if (Array.isArray(s.columns)) out.columns = s.columns.map(String).filter((k) => COLUMN_KEYS.includes(k) || (k.startsWith("f:") && fields.some((f) => `f:${f.id}` === k))).slice(0, 40);
  return out;
}

function where(orgId: number, v: Viewer, t: Target) {
  if (t.listId) {
    const l = db.work.lists.get(orgId, t.listId);
    if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
    const level = levelFor(orgId, v, l);
    if (!level) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
    return { listId: l.id, folderId: null, level, fields: fieldsOf(orgId, l) };
  }
  if (t.folderId) {
    mustMember(v);
    const f = db.work.folders.get(orgId, t.folderId);
    if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That folder isn't in this workspace." });
    const level = v.kind === "member" && v.role !== "reviewer" ? "full" : "view";
    return { listId: null, folderId: f.id, level, fields: parse<FieldDef[]>(f.fields, []) };
  }
  mustMember(v);
  return { listId: null, folderId: null, level: v.kind === "member" && v.role !== "reviewer" ? "full" : "view", fields: [] as FieldDef[] };
}

const me = (v: Viewer) => (v.kind === "member" || v.kind === "guest" ? v.userId : null);

/** The views on a list, a folder, or Everything (both null): the built-in tabs' settings and the saved views this person can see. */
export function views(orgId: number, v: Viewer, t: Target) {
  const w = where(orgId, v, t);
  const rows = db.work.views.all(orgId).filter((r) => (r.listId ?? null) === w.listId && (r.folderId ?? null) === w.folderId);
  const uid = me(v);
  const builtin: Record<string, ViewSettings> = {};
  for (const r of rows.filter((r) => !r.name)) builtin[r.kind] = parse<ViewSettings>(r.settings, {});
  const saved = rows
    .filter((r) => r.name && (!r.userId || r.userId === uid))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sort - b.sort || a.id - b.id)
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind as ViewKind, settings: parse<ViewSettings>(r.settings, {}), pinned: r.pinned, private: !!r.userId, mine: r.userId === uid || !r.userId, createdBy: r.createdBy }));
  return { builtin, saved, level: w.level, tabs: VIEW_KINDS.filter((k) => DEFAULT_TABS.includes(k) || k in builtin) };
}

/** Saves the built-in tab's settings (columns, grouping) for everyone who opens it. */
export function setBuiltin(orgId: number, v: Viewer, t: Target, kind: ViewKind, settings: ViewSettings) {
  const w = where(orgId, v, t);
  if (w.level === "view" || w.level === "comment") throw new TRPCError({ code: "FORBIDDEN", message: "You can look at this list but not change its views." });
  const clean = cleanSettings(settings, w.fields);
  const have = db.work.views.all(orgId).find((r) => !r.name && r.kind === kind && (r.listId ?? null) === w.listId && (r.folderId ?? null) === w.folderId);
  if (have) return db.work.views.update(orgId, have.id, { settings: JSON.stringify(clean) });
  return db.work.views.insert({ organizationId: orgId, listId: w.listId, folderId: w.folderId, name: "", kind, settings: JSON.stringify(clean), userId: null, pinned: false, sort: 0, createdBy: "" });
}

/** Takes a built-in tab off a list or folder (its columns and grouping go with it). The List, Board and Calendar tabs stay. */
export function removeBuiltin(orgId: number, v: Viewer, t: Target, kind: ViewKind) {
  const w = where(orgId, v, t);
  if (w.level === "view" || w.level === "comment") throw new TRPCError({ code: "FORBIDDEN", message: "You can look at this list but not change its views." });
  if (DEFAULT_TABS.includes(kind)) throw new TRPCError({ code: "BAD_REQUEST", message: "The List, Board and Calendar tabs stay." });
  for (const r of db.work.views.all(orgId).filter((r) => !r.name && r.kind === kind && (r.listId ?? null) === w.listId && (r.folderId ?? null) === w.folderId)) db.work.views.remove(orgId, r.id);
}

export function saveView(orgId: number, v: Viewer, input: { id?: number; listId?: number | null; folderId?: number | null; name: string; kind: ViewKind; settings: ViewSettings; private: boolean; pinned: boolean }, by: string) {
  const w = where(orgId, v, input);
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the view." });
  if (!VIEW_KINDS.includes(input.kind)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a kind of view." });
  const uid = me(v);
  // Anyone who can see the list may keep a private view; a shared view takes edit access.
  if (!input.private && (w.level === "view" || w.level === "comment")) throw new TRPCError({ code: "FORBIDDEN", message: "You can make a view only you see, but not one for everyone." });
  const row = { name, kind: input.kind, settings: JSON.stringify(cleanSettings(input.settings, w.fields)), userId: input.private ? uid : null, pinned: input.pinned };
  if (input.id) {
    const have = db.work.views.get(orgId, input.id);
    if (!have || !have.name) throw new TRPCError({ code: "NOT_FOUND", message: "That view is gone." });
    if (have.userId && have.userId !== uid) throw new TRPCError({ code: "FORBIDDEN", message: "That view is someone else's." });
    return db.work.views.update(orgId, have.id, row)!;
  }
  return db.work.views.insert({ organizationId: orgId, listId: w.listId, folderId: w.folderId, ...row, sort: db.work.views.all(orgId).length, createdBy: by });
}

export function removeView(orgId: number, v: Viewer, id: number) {
  const have = db.work.views.get(orgId, id);
  if (!have || !have.name) throw new TRPCError({ code: "NOT_FOUND", message: "That view is gone." });
  const uid = me(v);
  if (have.userId && have.userId !== uid) throw new TRPCError({ code: "FORBIDDEN", message: "That view is someone else's." });
  if (!have.userId) {
    const w = where(orgId, v, have);
    if (w.level === "view" || w.level === "comment") throw new TRPCError({ code: "FORBIDDEN", message: "You can't remove a shared view here." });
  }
  db.work.views.remove(orgId, id);
}

// ==========================================
// Folder overview
// ==========================================

const fmtWhen = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function overview(orgId: number, v: Viewer, folderId: number) {
  mustMember(v);
  const f = db.work.folders.get(orgId, folderId);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That folder isn't in this workspace." });
  const vis = visibleLists(orgId, v).filter((x) => x.list.folderId === f.id);
  const lists = vis.map((x) => x.list).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const ids = new Set(lists.map((l) => l.id));
  const tasks = db.work.tasks.all(orgId).filter((t) => ids.has(t.listId) && !t.parentId);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const open = tasks.filter((t) => !t.closedAt);
  const people = new Map<string, { name: string; who: Assignee; n: number }>();
  for (const t of open) for (const a of parse<Assignee[]>(t.assignees, [])) {
    const k = `${a.type}:${a.id}:${a.name}`;
    const p = people.get(k) ?? { name: a.name, who: a, n: 0 };
    p.n++;
    people.set(k, p);
  }
  const rank = { urgent: 4, high: 3, normal: 2, low: 1 } as const;
  const listRow = (l: PjList) => {
    const mine = tasks.filter((t) => t.listId === l.id);
    const openMine = mine.filter((t) => !t.closedAt);
    const starts = mine.map((t) => t.startDate ?? t.dueDate).filter(Boolean) as string[];
    const ends = mine.map((t) => t.dueDate).filter(Boolean) as string[];
    const lead = new Map<string, { who: Assignee; n: number }>();
    for (const t of openMine) for (const a of parse<Assignee[]>(t.assignees, [])) {
      const k = `${a.type}:${a.id}:${a.name}`;
      lead.set(k, { who: a, n: (lead.get(k)?.n ?? 0) + 1 });
    }
    const top = Array.from(lead.values()).sort((a, b) => b.n - a.n)[0]?.who ?? null;
    const pr = openMine.map((t) => t.priority).filter(Boolean).sort((a, b) => rank[b as keyof typeof rank] - rank[a as keyof typeof rank])[0] ?? null;
    return { id: l.id, name: l.name, done: mine.length - openMine.length, total: mine.length, start: starts.length ? starts.sort()[0] : null, end: ends.length ? ends.sort().at(-1)! : null, lead: top, priority: pr, level: vis.find((x) => x.list.id === l.id)!.level };
  };
  const docs = db.work.docs.all(orgId).filter((d) => d.folderId === f.id && !d.parentId).map((d) => ({ kind: "doc" as const, id: d.id, name: d.title, at: fmtWhen(d.updatedAt), by: d.editedBy }));
  const boards = db.work.boards.all(orgId).filter((b) => b.folderId === f.id).map((b) => ({ kind: "board" as const, id: b.id, name: b.title, at: fmtWhen(b.updatedAt), by: b.editedBy }));
  const forms = db.work.forms.all(orgId).filter((x) => x.folderId === f.id).map((x) => ({ kind: "form" as const, id: x.id, name: x.title, at: fmtWhen(x.createdAt), by: "" }));
  const items = [...docs, ...boards, ...forms].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  // Recent: the lists and docs changed last.
  const lastTouch = (l: PjList) => tasks.filter((t) => t.listId === l.id).map((t) => fmtWhen(t.updatedAt) ?? "").sort().at(-1) ?? fmtWhen(l.createdAt) ?? "";
  const recent = [...lists.map((l) => ({ kind: "list" as const, id: l.id, name: l.name, at: lastTouch(l) })), ...items.map((i) => ({ kind: i.kind, id: i.id, name: i.name, at: i.at ?? "" }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  const files = db.work.filesFor(orgId, "task", tasks.map((t) => t.id)).map((x) => ({ id: x.file!.id, name: x.file!.name, url: x.file!.fileUrl, kind: x.file!.kind, taskId: x.link.itemId, taskName: tasks.find((t) => t.id === x.link.itemId)?.name ?? "", at: fmtWhen(x.file!.createdAt) }));
  files.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  return {
    folder: { id: f.id, name: f.name, color: f.color },
    totals: { open: open.length, overdue: open.filter((t) => t.dueDate && t.dueDate < today).length, doneThisMonth: tasks.filter((t) => t.closedAt && new Date(t.closedAt).toISOString().slice(0, 10) >= monthStart).length, total: tasks.length },
    recent,
    items,
    lists: lists.map(listRow),
    files: files.slice(0, 12),
    byPerson: [...Array.from(people.values()).sort((a, b) => b.n - a.n).map((p) => ({ name: p.name, who: p.who, n: p.n })), { name: "Unassigned", who: null, n: open.filter((t) => !parse<Assignee[]>(t.assignees, []).length).length }].filter((p) => p.n > 0),
  };
}

// ==========================================
// Docs page
// ==========================================

type Block = { type: string; text?: string; cells?: string[][]; items?: { text: string }[] };
function blockText(blocks: Block[]) {
  return blocks.map((b) => [b.text ?? "", ...(b.cells ?? []).flat(), ...(b.items ?? []).map((i) => i.text)].join(" ")).join("\n").toLowerCase();
}

/** Every doc, whiteboard and form the person can see, with where it lives; `q` searches titles and the text inside docs. */
export function allDocs(orgId: number, v: Viewer, q = "") {
  mustMember(v);
  const words = q.trim().toLowerCase();
  const folders = new Map(db.work.folders.all(orgId).map((f) => [f.id, f.name]));
  const lists = new Map(db.work.lists.all(orgId).map((l) => [l.id, l.name]));
  const place = (folderId: number | null, listId: number | null) => (listId && lists.has(listId) ? { kind: "list" as const, id: listId, name: lists.get(listId)! } : folderId && folders.has(folderId) ? { kind: "folder" as const, id: folderId, name: folders.get(folderId)! } : null);
  const uid = v.kind === "member" ? v.userId : 0;
  const stars = new Set(starsOf(orgId, uid));
  const shares = db.work.docShares.all(orgId);
  const sharedWithMe = new Set(shares.filter((s) => s.kind === "user" && s.userId === uid).map((s) => s.docId));
  const out = [
    ...db.work.docs
      .all(orgId)
      .filter((d) => !d.parentId && docLevel(orgId, v, d))
      .map((d) => ({ kind: "doc" as const, id: d.id, name: d.title, where: place(d.folderId, d.listId), tags: parse<string[]>(d.tags, []), at: fmtWhen(d.updatedAt), by: d.editedBy, text: words ? blockText(parse<Block[]>(d.blocks, [])) : "", pages: db.work.docs.all(orgId).filter((x) => x.parentId === d.id).length, private: d.private, archived: !!d.archivedAt, ownerId: d.ownerUserId, shared: sharedWithMe.has(d.id), link: !!d.shareToken })),
    ...db.work.boards.all(orgId).map((b) => ({ kind: "board" as const, id: b.id, name: b.title, where: place(b.folderId, b.listId), tags: parse<string[]>(b.tags, []), at: fmtWhen(b.updatedAt), by: b.editedBy, text: "", pages: 0, private: false, archived: false, ownerId: null as number | null, shared: false, link: false })),
    ...db.work.forms.all(orgId).map((f) => ({ kind: "form" as const, id: f.id, name: f.title, where: place(f.folderId, f.listId), tags: [] as string[], at: fmtWhen(f.createdAt), by: "", text: "", pages: 0, private: false, archived: false, ownerId: null as number | null, shared: false, link: true })),
  ]
    .filter((d) => !words || d.name.toLowerCase().includes(words) || d.tags.some((t) => t.toLowerCase().includes(words)) || d.text.includes(words))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const myName = v.kind === "member" || v.kind === "guest" ? v.name : "";
  const docs = out.map(({ text, ...d }) => ({ ...d, mine: (d.ownerId !== null && d.ownerId === uid) || (!!d.by && d.by === myName), starred: stars.has(`${d.kind}:${d.id}`) }));
  const live = docs.filter((d) => !d.archived);
  return {
    docs,
    counts: { all: live.length, mine: live.filter((d) => d.mine).length, shared: live.filter((d) => d.shared).length, private: live.filter((d) => d.private).length, boards: live.filter((d) => d.kind === "board").length, forms: live.filter((d) => d.kind === "form").length, archived: docs.filter((d) => d.archived).length },
    tags: Array.from(new Set(docs.flatMap((d) => d.tags))).sort(),
    folders: Array.from(folders.entries()).map(([id, name]) => ({ id, name })),
    lists: Array.from(lists.entries()).map(([id, name]) => ({ id, name })),
  };
}

/** Where a doc or whiteboard lives, and its tags. */
export function placeDoc(orgId: number, v: Viewer, input: { kind: "doc" | "board"; id: number; folderId?: number | null; listId?: number | null; tags?: string[] }) {
  mustMember(v);
  const tags = input.tags?.map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 10);
  const list = input.listId ? db.work.lists.get(orgId, input.listId) : null;
  if (input.listId && !list) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const patch = { ...(input.folderId !== undefined || list ? { folderId: list ? list.folderId : input.folderId ?? null } : {}), ...(input.listId !== undefined ? { listId: input.listId ?? null } : {}), ...(tags ? { tags: JSON.stringify(Array.from(new Set(tags))) } : {}) };
  if (input.kind === "doc") {
    if (!db.work.docs.get(orgId, input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "That doc is gone." });
    return db.work.docs.update(orgId, input.id, patch);
  }
  if (!db.work.boards.get(orgId, input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "That whiteboard is gone." });
  return db.work.boards.update(orgId, input.id, patch);
}


