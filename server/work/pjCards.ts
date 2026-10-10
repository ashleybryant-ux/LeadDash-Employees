import * as db from "../db";
import type { PjTask } from "../../drizzle/schema";
import { generateText } from "../_core/llm";
import { addDays, owners, sundayOf, todayYmd, zoneOf } from "./goals";
import { fieldsOf, fmtYmd, parse, statusesOf, type Assignee } from "./projects";
import type { Viewer } from "./pjAccess";
import { timesheet } from "./pjTime";
import { latestStatus } from "./pjPortfolios";

/**
 * The card library's newer cards, the way ClickUp's dashboard library works:
 * any chart (line, bar, pie, donut, battery, number) over any measure split
 * any way; AI cards Nora writes from the tasks; notes; embeds; and tables.
 * pjDash works out the older cards and hands these here.
 */

export const CHARTS = ["line", "bar", "pie", "donut", "battery", "number"] as const;
export const MEASURES = ["count", "time", "estimate", "sum", "avg"] as const;
export const WHICH = ["open", "overdue", "done", "all", "active", "closed", "unassigned", "assigned", "urgent", "high", "normal", "low", "none"] as const;
export const PERIODS = ["week", "month", "quarter", "all"] as const;
export const AI_KINDS = ["team", "standup", "project", "summary", "brain"] as const;
export const EMBEDS = ["url", "doc", "board", "form", "gdoc", "gsheet", "gslides", "youtube", "calendar"] as const;
export const TABLES = ["tasks", "overdue", "soon", "milestones", "completed", "workedon", "behind", "activity", "newcontent", "portfolio", "timereport", "timesheet", "billable", "estimates", "priority", "instatus"] as const;

export type CardOptions = {
  which?: (typeof WHICH)[number];
  field?: string;
  goalId?: number;
  docId?: number;
  chart?: (typeof CHARTS)[number];
  measure?: (typeof MEASURES)[number];
  /** status, assignee, priority, tag, list, f:<field id>, or none. */
  by?: string;
  period?: (typeof PERIODS)[number];
  ai?: (typeof AI_KINDS)[number];
  prompt?: string;
  text?: string;
  url?: string;
  embed?: (typeof EMBEDS)[number];
  boardId?: number;
  formId?: number;
  table?: (typeof TABLES)[number];
  limit?: number;
};
export type LibCard = { id: string; type: string; title: string; scope: { kind: "everything" | "folder" | "list" | "me"; id?: number }; options?: CardOptions; size?: 1 | 2 | 3 };

export type Ctx = {
  orgId: number;
  v: Viewer;
  dashId: number;
  today: string;
  tz: string;
  lists: { id: number; name: string; folderId: number | null; statuses: string }[];
  folders: { id: number; name: string; color: string }[];
  people: Awaited<ReturnType<typeof owners>>;
  /** The tasks the card looks at (its scope), top level only. */
  tasks: PjTask[];
  /** Every task the viewer can see, for lookups. */
  all: PjTask[];
  scopeName: string;
  dayOf: (d: Date | null) => string | null;
};

const PALETTE = ["#1b6b4a", "#2563eb", "#d97706", "#7c3aed", "#0f766e", "#c2253c", "#9a4f2c", "#4b5563", "#0ea5e9", "#be185d"];
const PRIORITY_COLOR: Record<string, string> = { urgent: "#c2253c", high: "#d97706", normal: "#2563eb", low: "#9aa8a2", none: "#87909e" };
const PRIORITY_TEXT: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low", none: "No priority" };
const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`);
const minutesOf = (e: { minutes: number | null; startedAt: Date | null }) => e.minutes ?? (e.startedAt ? Math.round((Date.now() - new Date(e.startedAt).getTime()) / 60000) : 0);
const assigneesOf = (t: PjTask) => parse<Assignee[]>(t.assignees, []);

/** The tasks a card counts: open, overdue, done this week, all, active, closed, unassigned, assigned, or one priority. */
export function pickWhich(c: Ctx, ts: PjTask[], which: CardOptions["which"] = "open") {
  const week = sundayOf(c.today);
  const weekEnd = addDays(week, 6);
  const overdue = (t: PjTask) => !t.closedAt && !!t.dueDate && t.dueDate < c.today;
  const typeOf = (t: PjTask) => statusesOf(c.lists.find((l) => l.id === t.listId) ?? { statuses: "[]" }).find((s) => s.name === t.status)?.type ?? "open";
  switch (which) {
    case "all":
      return ts;
    case "overdue":
      return ts.filter(overdue);
    case "done":
      return ts.filter((t) => { const x = c.dayOf(t.closedAt); return !!x && x >= week && x <= weekEnd; });
    case "active":
      return ts.filter((t) => !t.closedAt && typeOf(t) === "active");
    case "closed":
      return ts.filter((t) => !!t.closedAt);
    case "unassigned":
      return ts.filter((t) => !t.closedAt && !assigneesOf(t).length);
    case "assigned":
      return ts.filter((t) => !t.closedAt && assigneesOf(t).length > 0);
    case "urgent":
    case "high":
    case "normal":
    case "low":
      return ts.filter((t) => !t.closedAt && t.priority === which);
    case "none":
      return ts.filter((t) => !t.closedAt && !t.priority);
    default:
      return ts.filter((t) => !t.closedAt);
  }
}

/** The days a period covers, ending today. */
function periodStart(c: Ctx, period: CardOptions["period"] = "all") {
  if (period === "week") return sundayOf(c.today);
  if (period === "month") return addDays(c.today, -29);
  if (period === "quarter") return addDays(c.today, -89);
  return null;
}

/** A task's number for the measure: 1, minutes tracked, minutes estimated, or a field's value. */
function measureOf(c: Ctx, t: PjTask, measure: CardOptions["measure"] = "count", field: string | undefined, from: string | null) {
  if (measure === "count") return 1;
  if (measure === "estimate") return t.timeEstimate ?? 0;
  if (measure === "time") return db.work.time.where(c.orgId, "taskId", t.id).filter((e) => !from || e.day >= from).reduce((s, e) => s + minutesOf(e), 0);
  const v = parse<Record<string, unknown>>(t.fields, {})[field ?? ""];
  return typeof v === "number" ? v : v ? Number(v) || 0 : 0;
}

/** The buckets a card splits tasks into, with a color each. */
function bucketsOf(c: Ctx, ts: PjTask[], by: string | undefined, scopeKind: string, scopeId?: number): { label: string; color: string; has: (t: PjTask) => boolean }[] {
  if (!by || by === "none") return [{ label: "All", color: PALETTE[0], has: () => true }];
  if (by === "status") {
    const sts = scopeKind === "list" ? statusesOf(c.lists.find((l) => l.id === scopeId) ?? c.lists[0] ?? { statuses: "[]" }) : Array.from(new Map(c.lists.flatMap((l) => statusesOf(l)).map((s) => [s.name, s])).values());
    return sts.map((s) => ({ label: s.name, color: s.color, has: (t) => t.status === s.name }));
  }
  if (by === "priority") return ["urgent", "high", "normal", "low", "none"].map((p) => ({ label: PRIORITY_TEXT[p], color: PRIORITY_COLOR[p], has: (t) => (t.priority ?? "none") === p }));
  if (by === "assignee") {
    const names = Array.from(new Map(ts.flatMap((t) => assigneesOf(t).map((a) => [`${a.type}:${a.id}`, a] as const))).values());
    return [...names.map((a, i) => ({ label: a.name, color: PALETTE[i % PALETTE.length], has: (t: PjTask) => assigneesOf(t).some((x) => x.type === a.type && x.id === a.id) })), { label: "Unassigned", color: "#87909e", has: (t) => !assigneesOf(t).length }];
  }
  if (by === "tag") {
    const tags = Array.from(new Set(ts.flatMap((t) => parse<string[]>(t.tags, [])))).sort();
    return [...tags.map((g, i) => ({ label: g, color: PALETTE[i % PALETTE.length], has: (t: PjTask) => parse<string[]>(t.tags, []).includes(g) })), { label: "No tags", color: "#87909e", has: (t) => !parse<string[]>(t.tags, []).length }];
  }
  if (by === "list") return c.lists.map((l, i) => ({ label: l.name, color: c.folders.find((f) => f.id === l.folderId)?.color ?? PALETTE[i % PALETTE.length], has: (t) => t.listId === l.id }));
  if (by.startsWith("f:")) {
    const fid = by.slice(2);
    const valOf = (t: PjTask): string[] => {
      const v = parse<Record<string, unknown>>(t.fields, {})[fid];
      if (v === undefined || v === null || v === "") return [];
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x && "name" in x ? String((x as { name: string }).name) : String(x)));
      if (typeof v === "boolean") return [v ? "Yes" : "No"];
      if (typeof v === "object") return ["name" in v ? String((v as { name: string }).name) : JSON.stringify(v)];
      return [String(v)];
    };
    const vals = Array.from(new Set(ts.flatMap(valOf))).sort();
    const fname = c.lists.map((l) => fieldsOf(c.orgId, l as never).find((f) => f.id === fid)?.name).find(Boolean) ?? "it";
    return [...vals.map((x, i) => ({ label: x, color: PALETTE[i % PALETTE.length], has: (t: PjTask) => valOf(t).includes(x) })), { label: `No ${fname}`, color: "#87909e", has: (t) => !valOf(t).length }];
  }
  return [{ label: "All", color: PALETTE[0], has: () => true }];
}

/** chart: series for a pie, donut, battery, bar or number; weeks and lines for a line chart. */
export function chart(c: Ctx, card: LibCard) {
  const o = card.options ?? {};
  const from = periodStart(c, o.period);
  const ts = pickWhich(c, c.tasks, o.which ?? (o.measure === "time" || o.measure === "estimate" ? "all" : "open")).filter((t) => !from || o.measure === "time" || (c.dayOf(t.createdAt) ?? "") >= from || !t.closedAt);
  const measure = o.measure ?? "count";
  const unit = measure === "time" || measure === "estimate" ? "minutes" : measure === "count" ? "tasks" : "value";
  const buckets = bucketsOf(c, ts, o.by, card.scope.kind, card.scope.id);
  const value = (list: PjTask[]) => {
    const nums = list.map((t) => measureOf(c, t, measure, o.field, from));
    const total = nums.reduce((s, n) => s + n, 0);
    return measure === "avg" ? (nums.length ? Math.round((total / nums.length) * 100) / 100 : 0) : Math.round(total * 100) / 100;
  };
  if (o.chart === "line") {
    const n = o.period === "week" ? 1 : o.period === "month" ? 5 : o.period === "quarter" ? 13 : 8;
    const weeks = Array.from({ length: n }, (_, i) => addDays(sundayOf(c.today), (i - (n - 1)) * 7));
    const inWeek = (t: PjTask, w: string) => {
      const made = c.dayOf(t.createdAt) ?? "";
      const closed = c.dayOf(t.closedAt);
      return made <= addDays(w, 6) && (!closed || closed > w);
    };
    const lines = buckets.map((b) => ({ label: b.label, color: b.color, values: weeks.map((w) => value(ts.filter((t) => b.has(t) && inWeek(t, w)))) })).filter((l) => l.values.some((x) => x > 0));
    return { weeks, lines, unit, total: value(ts) };
  }
  const series = buckets.map((b) => ({ label: b.label, color: b.color, value: value(ts.filter(b.has)) })).filter((s) => s.value > 0 || (o.by === "status" && card.scope.kind === "list"));
  return { series, unit, total: value(ts), sub: measure === "time" || measure === "estimate" ? fmtMin(value(ts)) : "" };
}

/** A text table: columns and rows. Each row may link to a task. */
export async function table(c: Ctx, card: LibCard) {
  const o = card.options ?? {};
  const limit = Math.min(50, Math.max(3, o.limit ?? 10));
  const week = sundayOf(c.today);
  const weekEnd = addDays(week, 6);
  const overdue = (t: PjTask) => !t.closedAt && !!t.dueDate && t.dueDate < c.today;
  const listName = (t: PjTask) => c.lists.find((l) => l.id === t.listId)?.name ?? "";
  const who = (t: PjTask) => assigneesOf(t).map((a) => a.name).join(", ");
  const day = (d: string | null | undefined) => (d ? fmtYmd(d) : "");
  const taskRows = (list: PjTask[], extra: (t: PjTask) => string = (t) => day(t.dueDate)) => list.slice(0, limit).map((t) => ({ taskId: t.id, cells: [t.name, listName(t), who(t), extra(t)] }));
  const open = c.tasks.filter((t) => !t.closedAt);
  const kind = o.table ?? "tasks";
  if (kind === "tasks") return { columns: ["Task", "List", "Who", "Due"], rows: taskRows([...open].sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))) };
  if (kind === "overdue") return { columns: ["Task", "List", "Who", "Due"], rows: taskRows(open.filter(overdue).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))) };
  if (kind === "soon") return { columns: ["Task", "List", "Who", "Due"], rows: taskRows(open.filter((t) => t.dueDate && t.dueDate >= c.today && t.dueDate <= addDays(c.today, 14)).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))) };
  if (kind === "priority") return { columns: ["Task", "List", "Who", "Priority"], rows: taskRows(open.filter((t) => t.priority === "urgent" || t.priority === "high").sort((a, b) => (a.priority === "urgent" ? 0 : 1) - (b.priority === "urgent" ? 0 : 1)), (t) => PRIORITY_TEXT[t.priority ?? "none"]) };
  if (kind === "milestones") return { columns: ["Milestone", "List", "Who", "Due"], rows: taskRows(c.tasks.filter((t) => parse<string[]>(t.tags, []).some((g) => g.toLowerCase() === "milestone")).sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999")), (t) => (t.closedAt ? "Done" : day(t.dueDate))) };
  if (kind === "instatus") return { columns: ["Task", "List", "Status", "Since"], rows: open.slice(0, limit).map((t) => ({ taskId: t.id, cells: [t.name, listName(t), t.status, day(c.dayOf(t.updatedAt))] })) };
  if (kind === "completed") {
    const done = c.tasks.filter((t) => { const x = c.dayOf(t.closedAt); return !!x && x >= addDays(c.today, -29); });
    const rows = c.people.map((p) => ({ cells: [p.name, String(done.filter((t) => assigneesOf(t).some((a) => a.type === p.type && a.id === p.id)).length)] })).filter((r) => r.cells[1] !== "0").sort((a, b) => Number(b.cells[1]) - Number(a.cells[1]));
    return { columns: ["Person", "Done, last 30 days"], rows };
  }
  if (kind === "workedon") {
    const since = addDays(c.today, -6);
    const ids = new Set(c.tasks.map((t) => t.id));
    const touched = db.work.comments.all(c.orgId).filter((x) => ids.has(x.taskId) && (c.dayOf(x.createdAt) ?? "") >= since);
    const rows = c.people.map((p) => {
      const mine = touched.filter((x) => x.authorType === p.type && x.authorId === p.id);
      return { cells: [p.name, String(new Set(mine.map((x) => x.taskId)).size), String(mine.filter((x) => x.kind === "comment").length)] };
    }).filter((r) => r.cells[1] !== "0").sort((a, b) => Number(b.cells[1]) - Number(a.cells[1]));
    return { columns: ["Person", "Tasks touched, 7 days", "Comments"], rows };
  }
  if (kind === "behind") {
    const rows = c.people.map((p) => {
      const mine = open.filter((t) => assigneesOf(t).some((a) => a.type === p.type && a.id === p.id));
      return { cells: [p.name, String(mine.filter(overdue).length), String(mine.filter((t) => t.dueDate && t.dueDate >= c.today && t.dueDate <= weekEnd).length)] };
    }).filter((r) => r.cells[1] !== "0" || r.cells[2] !== "0").sort((a, b) => Number(b.cells[1]) - Number(a.cells[1]));
    return { columns: ["Person", "Overdue", "Due this week"], rows };
  }
  if (kind === "activity") {
    const ids = new Set(c.tasks.map((t) => t.id));
    const rows = db.work.comments.all(c.orgId).filter((x) => ids.has(x.taskId)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit).map((x) => ({ taskId: x.taskId, cells: [x.body.slice(0, 120), c.all.find((t) => t.id === x.taskId)?.name ?? "", day(c.dayOf(x.createdAt))] }));
    return { columns: ["What happened", "Task", "When"], rows };
  }
  if (kind === "newcontent") {
    const items = [
      ...db.work.docs.all(c.orgId).filter((d) => !d.parentId && !d.archivedAt).map((d) => ({ kind: "Doc", name: d.title, at: new Date(d.createdAt), link: `/projects?page=doc&id=${d.id}` })),
      ...db.work.boards.all(c.orgId).map((b) => ({ kind: "Whiteboard", name: b.title, at: new Date(b.createdAt), link: `/projects?page=board&id=${b.id}` })),
      ...db.work.forms.all(c.orgId).map((f) => ({ kind: "Form", name: f.title, at: new Date(f.createdAt), link: `/projects?page=form&id=${f.id}` })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
    return { columns: ["Name", "Kind", "Made"], rows: items.map((i) => ({ link: i.link, cells: [i.name, i.kind, day(c.dayOf(i.at))] })) };
  }
  if (kind === "portfolio") {
    const rows = c.lists
      .filter((l) => card.scope.kind !== "list" || l.id === card.scope.id)
      .filter((l) => card.scope.kind !== "folder" || l.folderId === card.scope.id)
      .map((l) => {
        const mine = c.all.filter((t) => t.listId === l.id && !t.parentId);
        const done = mine.filter((t) => t.closedAt).length;
        const st = latestStatus(c.orgId, "list", l.id);
        return { link: `/projects?list=${l.id}`, cells: [l.name, c.folders.find((f) => f.id === l.folderId)?.name ?? "", st ? { on: "On track", risk: "At risk", off: "Off track", hold: "On hold" }[st.status] ?? "" : "No status", `${done} of ${mine.length}`, mine.length ? `${Math.round((done / mine.length) * 100)}%` : "0%"] };
      });
    return { columns: ["Project", "Folder", "Status", "Done", "Progress"], rows };
  }
  if (kind === "timereport" || kind === "timesheet" || kind === "billable" || kind === "estimates") {
    const sheet = await timesheet(c.orgId, c.v, { weekStart: c.today, billable: kind === "billable" ? "yes" : "any" });
    const ids = new Set(c.tasks.map((t) => t.id));
    const rows = sheet.rows.filter((r) => ids.has(r.taskId));
    if (kind === "timesheet") return { columns: ["Person", ...sheet.days.map((d) => d.slice(5)), "Total"], rows: c.people.map((p) => { const mine = rows.filter((r) => r.whoType === p.type && r.whoId === p.id); return { cells: [p.name, ...sheet.days.map((_, i) => fmtMin(mine.reduce((s, r) => s + r.byDay[i], 0))), fmtMin(mine.reduce((s, r) => s + r.total, 0))] }; }).filter((r) => r.cells[r.cells.length - 1] !== "0 m") };
    if (kind === "estimates") return { columns: ["Task", "Who", "Estimated", "Tracked", "Left"], rows: rows.slice(0, limit).map((r) => { const t = c.all.find((x) => x.id === r.taskId); const est = t?.timeEstimate ?? 0; const all = db.work.time.where(c.orgId, "taskId", r.taskId).reduce((s, e) => s + minutesOf(e), 0); return { taskId: r.taskId, cells: [r.taskName, r.whoName, est ? fmtMin(est) : "", fmtMin(all), est ? fmtMin(Math.max(0, est - all)) : ""] }; }) };
    return { columns: ["Task", "Who", kind === "billable" ? "Billable this week" : "Tracked this week"], rows: rows.slice(0, limit).map((r) => ({ taskId: r.taskId, cells: [r.taskName, r.whoName, fmtMin(kind === "billable" ? r.billable : r.total)] })) };
  }
  return { columns: ["Task", "List", "Who", "Due"], rows: taskRows(open) };
}

/** embed: what the card shows: an outside page in a frame, a doc's lines, a whiteboard or form link, or this week's tasks on a calendar. */
export function embed(c: Ctx, card: LibCard) {
  const o = card.options ?? {};
  const kind = o.embed ?? "url";
  const url = (o.url ?? "").trim();
  if (kind === "youtube") {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,})/);
    return { kind, frame: m ? `https://www.youtube.com/embed/${m[1]}` : "", url };
  }
  if (kind === "gdoc" || kind === "gsheet" || kind === "gslides") {
    const m = url.match(/\/d\/([\w-]+)/);
    const base = kind === "gdoc" ? "document" : kind === "gsheet" ? "spreadsheets" : "presentation";
    return { kind, frame: m ? `https://docs.google.com/${base}/d/${m[1]}/preview` : "", url };
  }
  if (kind === "doc") {
    const d = o.docId ? db.work.docs.get(c.orgId, o.docId) : null;
    const blocks = d ? parse<{ type: string; text: string }[]>(d.blocks, []) : [];
    return { kind, doc: d ? { id: d.id, title: d.title, lines: blocks.filter((b) => b.text?.trim()).slice(0, 8).map((b) => b.text) } : null };
  }
  if (kind === "board") {
    const b = o.boardId ? db.work.boards.get(c.orgId, o.boardId) : null;
    return { kind, item: b ? { id: b.id, title: b.title, link: `/projects?page=board&id=${b.id}` } : null };
  }
  if (kind === "form") {
    const f = o.formId ? db.work.forms.get(c.orgId, o.formId) : null;
    const answers = f ? db.work.answers.all(c.orgId).filter((a) => a.formId === f.id).length : 0;
    return { kind, item: f ? { id: f.id, title: f.title, link: `/projects?page=form&id=${f.id}`, note: `${answers} answer${answers === 1 ? "" : "s"}` } : null };
  }
  if (kind === "calendar") {
    const start = sundayOf(c.today);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    return { kind, days, byDay: days.map((d) => c.tasks.filter((t) => !t.closedAt && t.dueDate === d).slice(0, 6).map((t) => ({ id: t.id, name: t.name }))) };
  }
  return { kind: "url" as const, frame: /^https?:\/\//.test(url) ? url : "", url };
}

/** The facts Nora writes an AI card from: the scope's tasks, who has what, what moved lately, what is late. */
function facts(c: Ctx, scopeName: string) {
  const open = c.tasks.filter((t) => !t.closedAt);
  const since = addDays(c.today, -6);
  const doneLately = c.tasks.filter((t) => (c.dayOf(t.closedAt) ?? "") >= since);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < c.today);
  const ids = new Set(c.tasks.map((t) => t.id));
  const comments = db.work.comments.all(c.orgId).filter((x) => ids.has(x.taskId) && (c.dayOf(x.createdAt) ?? "") >= since).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 40);
  const line = (t: PjTask) => `- ${t.name} (${c.lists.find((l) => l.id === t.listId)?.name ?? ""}; ${t.status}; ${assigneesOf(t).map((a) => a.name).join(", ") || "nobody"}; due ${t.dueDate ?? "no date"}${t.priority ? `; ${t.priority}` : ""})`;
  return [
    `Place: ${scopeName}. Today: ${c.today}.`,
    `Open tasks (${open.length}):`,
    ...open.slice(0, 60).map(line),
    `Done in the last 7 days (${doneLately.length}):`,
    ...doneLately.slice(0, 30).map(line),
    `Overdue (${overdue.length}):`,
    ...overdue.slice(0, 30).map(line),
    "Recent activity and comments:",
    ...comments.map((x) => `- ${c.dayOf(x.createdAt)} ${x.authorName}: ${x.body.slice(0, 200)}`),
  ].join("\n");
}

const AI_ASK: Record<(typeof AI_KINDS)[number], string> = {
  team: "Write a team update: what each person and AI employee did this week, what is in flight, and any handoffs waiting. One short paragraph per person who did anything, people first then AI employees.",
  standup: "Write a daily standup: Done yesterday, Doing today, Stuck. Three short bulleted sections, plain words, task names included.",
  project: "Write a project update: where it stands, what moved lately, what is late and why it matters, and what is next. Four short paragraphs at most.",
  summary: "Write an executive summary a business owner reads in thirty seconds: progress, risks, and the one decision they need to make. Three short paragraphs.",
  brain: "Answer the owner's prompt from the facts below. Be specific and short.",
};

/** ai: Nora writes the card from the tasks; the words are kept for six hours (or until Refresh) so the dashboard opens fast. */
export async function ai(c: Ctx, card: LibCard, force = false) {
  const o = card.options ?? {};
  const kind = o.ai ?? "summary";
  const key = `dashai:${c.dashId}:${card.id}`;
  const have = parse<{ text: string; at: string; sig: string } | null>(db.work.setting(c.orgId, key) ?? "null", null);
  const sig = `${kind}|${o.prompt ?? ""}|${c.tasks.length}|${c.tasks.filter((t) => t.closedAt).length}`;
  if (have && !force && have.sig === sig && Date.now() - new Date(have.at).getTime() < 6 * 3600_000) return { kind, text: have.text, at: have.at, stale: false };
  if (!c.tasks.length) return { kind, text: "Nothing in this place yet.", at: new Date().toISOString(), stale: false };
  try {
    const text = await generateText({
      system: "You are Nora, the project manager. American English, no em dashes, no hype, no headings with colons at the start of every line. Use task names and dates from the facts only; never invent work. Keep it under 160 words.",
      prompt: `${AI_ASK[kind]}${kind === "brain" ? `\nPrompt: ${o.prompt ?? ""}` : ""}\n\nFacts:\n${facts(c, c.scopeName)}`,
      maxTokens: 600,
      temperature: 0.3,
    });
    const at = new Date().toISOString();
    db.work.setSetting(c.orgId, key, JSON.stringify({ text: text.trim(), at, sig }));
    return { kind, text: text.trim(), at, stale: false };
  } catch (err) {
    return { kind, text: have?.text ?? `Nora couldn't write this right now: ${err instanceof Error ? err.message : String(err)}`, at: have?.at ?? new Date().toISOString(), stale: true };
  }
}

/** Builds the context the cards need once per dashboard. */
export async function contextFor(orgId: number, v: Viewer, dashId: number, lists: Ctx["lists"], all: PjTask[]): Promise<Omit<Ctx, "tasks" | "scopeName">> {
  const tz = await zoneOf(orgId);
  return {
    orgId,
    v,
    dashId,
    today: todayYmd(tz),
    tz,
    lists,
    folders: db.work.folders.all(orgId).map((f) => ({ id: f.id, name: f.name, color: f.color })),
    people: await owners(orgId),
    all,
    dayOf: (at) => (at ? todayYmd(tz, new Date(at)) : null),
  };
}
