import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjList, PjTask } from "../../drizzle/schema";
import { generateJson } from "../_core/llm";
import { owners, todayYmd, zoneOf } from "./goals";
import { LEVEL_RANK, levelFor, mustLevel, mustMember, visibleLists, type Viewer } from "./pjAccess";
import { fmtYmd, parse, type Assignee } from "./projects";

/**
 * Portfolios, the way Asana does them: a set of projects (lists) from any
 * folders, or other portfolios, watched together. Each row shows the last
 * status update someone posted (on track, at risk, off track, on hold), the
 * tasks done, the owner, dates and the top priority, all from the tasks. A
 * portfolio has its own status update too, with a summary, accomplishments,
 * blockers and next steps, and Nora can draft it from the tasks.
 */

export type StatusKey = "on" | "risk" | "off" | "hold";
export const STATUS_TEXT: Record<StatusKey, string> = { on: "On track", risk: "At risk", off: "Off track", hold: "On hold" };
export type Highlight = { itemId: number; name: string; status: StatusKey };
export type StatusInput = { status: StatusKey; summary: string; accomplishments?: string; blockers?: string; next?: string; highlights?: Highlight[] };

const who = (t: PjTask) => parse<Assignee[]>(t.assignees, []);
const PRANK: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

function mustPortfolio(orgId: number, id: number) {
  const p = db.work.portfolios.get(orgId, id);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That portfolio isn't in this workspace." });
  return p;
}
function canChange(v: Viewer) {
  mustMember(v);
  if (v.kind === "member" && v.role === "reviewer") throw new TRPCError({ code: "FORBIDDEN", message: "Reviewers can look at portfolios but not change them." });
}

/** The last status update on a project or a portfolio. */
export function latestStatus(orgId: number, kind: "list" | "portfolio", itemId: number) {
  const rows = db.work.statusUpdates.all(orgId).filter((u) => u.kind === kind && u.itemId === itemId);
  const u = rows.sort((a, b) => b.id - a.id)[0];
  return u ? { status: u.status as StatusKey, at: u.createdAt, by: u.authorName, summary: u.summary } : null;
}

/** What a list's tasks say: done of total, overdue, dates, owner and top priority. */
function listFacts(orgId: number, l: PjList, today: string) {
  const tasks = db.work.tasks.where(orgId, "listId", l.id).filter((t) => !t.parentId);
  const open = tasks.filter((t) => !t.closedAt);
  const starts = tasks.map((t) => t.startDate ?? t.dueDate).filter(Boolean) as string[];
  const ends = tasks.map((t) => t.dueDate).filter(Boolean) as string[];
  const n = new Map<string, { a: Assignee; n: number }>();
  for (const t of open) for (const a of who(t)) {
    const k = `${a.type}:${a.id}:${a.name}`;
    n.set(k, { a, n: (n.get(k)?.n ?? 0) + 1 });
  }
  const owner = Array.from(n.values()).sort((x, y) => y.n - x.n)[0]?.a ?? null;
  const priority = open.map((t) => t.priority).filter(Boolean).sort((a, b) => (PRANK[b!] ?? 0) - (PRANK[a!] ?? 0))[0] ?? null;
  return { total: tasks.length, done: tasks.length - open.length, open: open.length, overdue: open.filter((t) => t.dueDate && t.dueDate < today).length, start: starts.length ? starts.sort()[0] : null, end: ends.length ? ends.sort().at(-1)! : null, owner, priority };
}

/** The lists inside a portfolio, through nested portfolios too (each once). */
export function listsIn(orgId: number, portfolioId: number, seen = new Set<number>()): number[] {
  if (seen.has(portfolioId)) return [];
  seen.add(portfolioId);
  const out: number[] = [];
  for (const it of db.work.portfolioItems.where(orgId, "portfolioId", portfolioId)) {
    if (it.kind === "list") out.push(it.itemId);
    else out.push(...listsIn(orgId, it.itemId, seen));
  }
  return Array.from(new Set(out));
}

function rowsOf(orgId: number, v: Viewer, p: { id: number }, today: string, vis: ReturnType<typeof visibleLists>) {
  const folders = new Map(db.work.folders.all(orgId).map((f) => [f.id, f]));
  const items = db.work.portfolioItems.where(orgId, "portfolioId", p.id).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const rows = [];
  for (const it of items) {
    if (it.kind === "list") {
      const x = vis.find((y) => y.list.id === it.itemId);
      if (!x) continue;
      const f = listFacts(orgId, x.list, today);
      const folder = x.list.folderId ? folders.get(x.list.folderId) : null;
      rows.push({ itemId: it.id, kind: "list" as const, id: x.list.id, name: x.list.name, folderName: folder?.name ?? null, color: folder?.color ?? "#475569", status: latestStatus(orgId, "list", x.list.id), progress: { done: f.done, total: f.total, pct: f.total ? Math.round((f.done / f.total) * 100) : 0 }, overdue: f.overdue, owner: f.owner, start: f.start, end: f.end, priority: f.priority, level: x.level, lists: 0 });
    } else {
      const sub = db.work.portfolios.get(orgId, it.itemId);
      if (!sub || sub.archivedAt) continue;
      const ids = listsIn(orgId, sub.id);
      const facts = ids.map((id) => vis.find((y) => y.list.id === id)).filter((y): y is NonNullable<typeof y> => !!y).map((y) => listFacts(orgId, y.list, today));
      const total = facts.reduce((s, f) => s + f.total, 0);
      const done = facts.reduce((s, f) => s + f.done, 0);
      const ends = facts.map((f) => f.end).filter(Boolean) as string[];
      const starts = facts.map((f) => f.start).filter(Boolean) as string[];
      rows.push({ itemId: it.id, kind: "portfolio" as const, id: sub.id, name: sub.name, folderName: null, color: sub.color, status: latestStatus(orgId, "portfolio", sub.id), progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 }, overdue: facts.reduce((s, f) => s + f.overdue, 0), owner: sub.ownerId ? ({ type: sub.ownerType as Assignee["type"], id: sub.ownerId, name: sub.ownerName } as Assignee) : null, start: starts.length ? starts.sort()[0] : null, end: ends.length ? ends.sort().at(-1)! : null, priority: null, level: "view" as const, lists: ids.length });
    }
  }
  return rows;
}

/** Every portfolio, with its projects' statuses rolled up. */
export async function list(orgId: number, v: Viewer) {
  mustMember(v);
  const today = todayYmd(await zoneOf(orgId));
  const vis = visibleLists(orgId, v);
  return db.work.portfolios
    .all(orgId)
    .filter((p) => !p.archivedAt)
    .sort((a, b) => a.id - b.id)
    .map((p) => {
      const rows = rowsOf(orgId, v, p, today, vis);
      const count = (k: StatusKey) => rows.filter((r) => r.status?.status === k).length;
      return { id: p.id, name: p.name, color: p.color, owner: p.ownerId ? { type: p.ownerType, id: p.ownerId, name: p.ownerName } : null, projects: rows.filter((r) => r.kind === "list").length, portfolios: rows.filter((r) => r.kind === "portfolio").length, status: latestStatus(orgId, "portfolio", p.id), on: count("on"), risk: count("risk"), off: count("off"), hold: count("hold"), none: rows.filter((r) => !r.status).length };
    });
}

export async function get(orgId: number, v: Viewer, id: number) {
  mustMember(v);
  const p = mustPortfolio(orgId, id);
  const today = todayYmd(await zoneOf(orgId));
  const vis = visibleLists(orgId, v);
  const rows = rowsOf(orgId, v, p, today, vis);
  const inIt = new Set(rows.map((r) => `${r.kind}:${r.id}`));
  const ids = listsIn(orgId, p.id);
  const facts = ids.map((lid) => vis.find((y) => y.list.id === lid)).filter((y): y is NonNullable<typeof y> => !!y).map((y) => listFacts(orgId, y.list, today));
  const total = facts.reduce((s, f) => s + f.total, 0);
  const done = facts.reduce((s, f) => s + f.done, 0);
  const ends = facts.map((f) => f.end).filter(Boolean) as string[];
  const folders = new Map(db.work.folders.all(orgId).map((f) => [f.id, f.name]));
  return {
    portfolio: { id: p.id, name: p.name, description: p.description, color: p.color, owner: p.ownerId ? { type: p.ownerType, id: p.ownerId, name: p.ownerName } : null, startDate: p.startDate, dueDate: p.dueDate, createdBy: p.createdBy },
    status: latestStatus(orgId, "portfolio", p.id),
    rows,
    tiles: { pct: total ? Math.round((done / total) * 100) : 0, done, open: total - done, overdue: facts.reduce((s, f) => s + f.overdue, 0), total, lastDue: ends.length ? ends.sort().at(-1)! : null },
    updates: updates(orgId, "portfolio", p.id),
    /** Projects and portfolios that could be added. */
    canAdd: {
      lists: vis.filter((x) => !inIt.has(`list:${x.list.id}`)).map((x) => ({ id: x.list.id, name: x.list.name, folderName: x.list.folderId ? folders.get(x.list.folderId) ?? null : null })),
      portfolios: db.work.portfolios.all(orgId).filter((x) => x.id !== p.id && !x.archivedAt && !inIt.has(`portfolio:${x.id}`) && !contains(orgId, x.id, p.id)).map((x) => ({ id: x.id, name: x.name })),
    },
    people: await owners(orgId),
    today,
    canEdit: v.kind === "member" && v.role !== "reviewer",
  };
}

/** Whether portfolio a holds portfolio b somewhere inside (so b can't hold a). */
function contains(orgId: number, a: number, b: number, seen = new Set<number>()): boolean {
  if (seen.has(a)) return false;
  seen.add(a);
  for (const it of db.work.portfolioItems.where(orgId, "portfolioId", a)) if (it.kind === "portfolio" && (it.itemId === b || contains(orgId, it.itemId, b, seen))) return true;
  return false;
}

export function save(orgId: number, v: Viewer, input: { id?: number; name: string; description?: string; color?: string; owner?: Assignee | null; startDate?: string | null; dueDate?: string | null }, by: string) {
  canChange(v);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the portfolio." });
  const row = { name, ...(input.description !== undefined ? { description: input.description.slice(0, 2000) } : {}), ...(input.color ? { color: input.color.slice(0, 9) } : {}), ...(input.owner !== undefined ? { ownerType: input.owner?.type ?? "user", ownerId: input.owner?.id ?? null, ownerName: input.owner?.name ?? "" } : {}), ...(input.startDate !== undefined ? { startDate: input.startDate } : {}), ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}) };
  if (input.id) {
    mustPortfolio(orgId, input.id);
    return db.work.portfolios.update(orgId, input.id, row)!;
  }
  return db.work.portfolios.insert({ organizationId: orgId, ...row, createdBy: by });
}

export function archive(orgId: number, v: Viewer, id: number, on: boolean) {
  canChange(v);
  mustPortfolio(orgId, id);
  db.work.portfolios.update(orgId, id, { archivedAt: on ? new Date() : null });
}

export function remove(orgId: number, v: Viewer, id: number) {
  canChange(v);
  mustPortfolio(orgId, id);
  for (const it of db.work.portfolioItems.where(orgId, "portfolioId", id)) db.work.portfolioItems.remove(orgId, it.id);
  for (const it of db.work.portfolioItems.all(orgId).filter((x) => x.kind === "portfolio" && x.itemId === id)) db.work.portfolioItems.remove(orgId, it.id);
  db.work.portfolios.remove(orgId, id);
}

export function addWork(orgId: number, v: Viewer, portfolioId: number, kind: "list" | "portfolio", itemId: number) {
  canChange(v);
  mustPortfolio(orgId, portfolioId);
  if (kind === "list") {
    const l = db.work.lists.get(orgId, itemId);
    if (!l || !levelFor(orgId, v, l)) throw new TRPCError({ code: "NOT_FOUND", message: "That project isn't in this workspace." });
  } else {
    if (itemId === portfolioId || contains(orgId, itemId, portfolioId)) throw new TRPCError({ code: "BAD_REQUEST", message: "A portfolio can't hold itself." });
    mustPortfolio(orgId, itemId);
  }
  const have = db.work.portfolioItems.where(orgId, "portfolioId", portfolioId);
  if (have.some((x) => x.kind === kind && x.itemId === itemId)) return { ok: true };
  db.work.portfolioItems.insert({ organizationId: orgId, portfolioId, kind, itemId, sort: have.length });
  return { ok: true };
}

export function removeWork(orgId: number, v: Viewer, portfolioId: number, rowId: number) {
  canChange(v);
  const it = db.work.portfolioItems.get(orgId, rowId);
  if (it && it.portfolioId === portfolioId) db.work.portfolioItems.remove(orgId, rowId);
  return { ok: true };
}

// ==========================================
// Status updates
// ==========================================

export function updates(orgId: number, kind: "list" | "portfolio", itemId: number) {
  return db.work.statusUpdates
    .all(orgId)
    .filter((u) => u.kind === kind && u.itemId === itemId)
    .sort((a, b) => b.id - a.id)
    .map((u) => ({ id: u.id, status: u.status as StatusKey, summary: u.summary, accomplishments: u.accomplishments, blockers: u.blockers, next: u.next, highlights: parse<Highlight[]>(u.highlights, []), authorType: u.authorType, authorId: u.authorId, authorName: u.authorName, at: u.createdAt }));
}

export function postStatus(orgId: number, v: Viewer, kind: "list" | "portfolio", itemId: number, input: StatusInput, by: { type: "user" | "employee" | "system"; id: number | null; name: string }) {
  if (kind === "list") mustLevel(orgId, v, itemId, "edit");
  else {
    canChange(v);
    mustPortfolio(orgId, itemId);
  }
  if (!["on", "risk", "off", "hold"].includes(input.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a status." });
  const summary = input.summary.trim().slice(0, 4000);
  if (!summary) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a line or two for the summary." });
  return db.work.statusUpdates.insert({
    organizationId: orgId,
    kind,
    itemId,
    status: input.status,
    summary,
    accomplishments: (input.accomplishments ?? "").trim().slice(0, 4000),
    blockers: (input.blockers ?? "").trim().slice(0, 4000),
    next: (input.next ?? "").trim().slice(0, 4000),
    highlights: JSON.stringify((input.highlights ?? []).slice(0, 30)),
    authorType: by.type,
    authorId: by.id,
    authorName: by.name,
  });
}

/** Nora drafts a status update from the tasks: what got done, what is late, what is next. */
export async function draftStatus(orgId: number, v: Viewer, kind: "list" | "portfolio", itemId: number): Promise<StatusInput> {
  mustMember(v);
  const today = todayYmd(await zoneOf(orgId));
  const vis = visibleLists(orgId, v);
  const ids = kind === "list" ? [itemId] : listsIn(orgId, itemId);
  const name = kind === "list" ? db.work.lists.get(orgId, itemId)?.name ?? "the project" : mustPortfolio(orgId, itemId).name;
  const lines: string[] = [];
  const highlights: Highlight[] = [];
  for (const lid of ids) {
    const x = vis.find((y) => y.list.id === lid);
    if (!x) continue;
    const tasks = db.work.tasks.where(orgId, "listId", lid).filter((t) => !t.parentId);
    const f = listFacts(orgId, x.list, today);
    const recent = tasks.filter((t) => t.closedAt && Date.now() - new Date(t.closedAt).getTime() < 7 * 86_400_000).map((t) => t.name);
    const late = tasks.filter((t) => !t.closedAt && t.dueDate && t.dueDate < today).map((t) => `${t.name} (due ${fmtYmd(t.dueDate!)})`);
    const next = tasks.filter((t) => !t.closedAt && t.dueDate && t.dueDate >= today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 4).map((t) => `${t.name} (${fmtYmd(t.dueDate!)}${who(t)[0] ? `, ${who(t)[0].name}` : ""})`);
    lines.push(`${x.list.name}: ${f.done} of ${f.total} done, ${f.overdue} late. Done this week: ${recent.join("; ") || "nothing"}. Late: ${late.join("; ") || "nothing"}. Next: ${next.join("; ") || "nothing dated"}.`);
    const st = latestStatus(orgId, "list", lid)?.status ?? (f.open && f.overdue / f.open >= 1 / 3 ? "off" : f.overdue ? "risk" : "on");
    if (kind === "portfolio") highlights.push({ itemId: lid, name: x.list.name, status: st });
  }
  const str = { type: "string" } as const;
  const out = await generateJson<{ status: string; summary: string; accomplishments: string; blockers: string; next: string }>({
    system: "You are Nora, the project manager. Write a short, plain status update for a business owner. American English, no em dashes, no hype, specific task names and dates. Each field is one to three sentences.",
    prompt: `Draft the status update for "${name}" as of ${fmtYmd(today)}.\n\n${lines.join("\n")}\n\nstatus is one of: on (on track), risk (at risk), off (off track), hold (on hold).`,
    schemaName: "status_update",
    schema: { type: "object", additionalProperties: false, required: ["status", "summary", "accomplishments", "blockers", "next"], properties: { status: str, summary: str, accomplishments: str, blockers: str, next: str } },
    maxTokens: 700,
  });
  const status = (["on", "risk", "off", "hold"] as const).includes(out.status as StatusKey) ? (out.status as StatusKey) : "on";
  return { status, summary: out.summary, accomplishments: out.accomplishments, blockers: out.blockers, next: out.next, highlights };
}

/** Lists a viewer may change inside a portfolio, for the Workload and Dashboard tabs. */
export function visibleIn(orgId: number, v: Viewer, portfolioId: number) {
  const ids = new Set(listsIn(orgId, portfolioId));
  return visibleLists(orgId, v).filter((x) => ids.has(x.list.id) && LEVEL_RANK[x.level] >= LEVEL_RANK.view);
}
