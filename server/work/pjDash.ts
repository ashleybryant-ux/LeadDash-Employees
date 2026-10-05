import { TRPCError } from "@trpc/server";
import { evalFormula } from "@shared/formula";
import * as db from "../db";
import type { PjTask } from "../../drizzle/schema";
import { owners, todayYmd, zoneOf, addDays, sundayOf } from "./goals";
import { fieldsOf, parse, statusesOf, type Assignee } from "./projects";
import { visibleLists, type Viewer } from "./pjAccess";
import { workload } from "./pjTime";

/**
 * Projects dashboards: cards over any list, folder, everything, or just me.
 * Each card's numbers are worked out here from the tasks and tracked time.
 */

export const CARD_TYPES = ["count", "status", "person", "overdue", "time", "workload", "trend", "burndown", "tasks", "goal", "doc", "fieldsum"] as const;
export type Card = {
  id: string;
  type: (typeof CARD_TYPES)[number];
  title: string;
  /** everything, a folder, a list, or my tasks. */
  scope: { kind: "everything" | "folder" | "list" | "me"; id?: number };
  /** count: open, overdue, done this week or all; fieldsum: the field id; goal: goal id; doc: doc id. */
  options?: { which?: "open" | "overdue" | "done" | "all"; field?: string; goalId?: number; docId?: number };
  size?: 1 | 2 | 3;
};

export function dashboards(orgId: number) {
  return db.work.dashboards
    .all(orgId)
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((d) => ({ id: d.id, name: d.name, cards: parse<Card[]>(d.cards, []) }));
}

export function saveDashboard(orgId: number, input: { id?: number; name: string; cards?: Card[] }) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the dashboard." });
  const cards = input.cards?.slice(0, 40).map((c, i) => ({
    id: String(c.id || `c${i}`).slice(0, 40),
    type: (CARD_TYPES as readonly string[]).includes(c.type) ? c.type : "count",
    title: c.title.trim().slice(0, 80) || "Card",
    scope: { kind: ["everything", "folder", "list", "me"].includes(c.scope?.kind) ? c.scope.kind : "everything", ...(c.scope?.id ? { id: Number(c.scope.id) } : {}) },
    ...(c.options ? { options: c.options } : {}),
    size: ([1, 2, 3] as const).includes(c.size as 1) ? c.size : 1,
  }));
  if (input.id) {
    if (!db.work.dashboards.get(orgId, input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
    return db.work.dashboards.update(orgId, input.id, { name, ...(cards ? { cards: JSON.stringify(cards) } : {}) })!;
  }
  return db.work.dashboards.insert({ organizationId: orgId, name, cards: JSON.stringify(cards ?? defaultCards()), sort: db.work.dashboards.all(orgId).length });
}
export function removeDashboard(orgId: number, id: number) {
  db.work.dashboards.remove(orgId, id);
}

/** A new dashboard starts with the cards most people want. */
function defaultCards(): Card[] {
  return [
    { id: "c1", type: "count", title: "Open tasks", scope: { kind: "everything" }, options: { which: "open" }, size: 1 },
    { id: "c2", type: "count", title: "Done this week", scope: { kind: "everything" }, options: { which: "done" }, size: 1 },
    { id: "c3", type: "time", title: "Time tracked", scope: { kind: "everything" }, size: 1 },
    { id: "c4", type: "overdue", title: "Overdue by person", scope: { kind: "everything" }, size: 1 },
    { id: "c5", type: "workload", title: "Workload this week", scope: { kind: "everything" }, size: 1 },
    { id: "c6", type: "tasks", title: "Due this week", scope: { kind: "me" }, size: 1 },
    { id: "c7", type: "trend", title: "Done vs. added", scope: { kind: "everything" }, size: 2 },
  ];
}

export async function data(orgId: number, v: Viewer, id: number, me: Assignee) {
  const d = db.work.dashboards.get(orgId, id);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
  const tz = await zoneOf(orgId);
  const today = todayYmd(tz);
  const week = sundayOf(today);
  const weekEnd = addDays(week, 6);
  const vis = visibleLists(orgId, v);
  const lists = vis.map((x) => x.list);
  const all = db.work.tasks.all(orgId).filter((t) => lists.some((l) => l.id === t.listId));
  const folders = db.work.folders.all(orgId);
  const people = await owners(orgId);
  const dayOf = (at: Date | null) => (at ? todayYmd(tz, new Date(at)) : null);
  const scoped = (c: Card): PjTask[] => {
    if (c.scope.kind === "list") return all.filter((t) => t.listId === c.scope.id);
    if (c.scope.kind === "folder") return all.filter((t) => lists.find((l) => l.id === t.listId)?.folderId === c.scope.id);
    if (c.scope.kind === "me") return all.filter((t) => parse<Assignee[]>(t.assignees, []).some((a) => a.type === me.type && a.id === me.id));
    return all;
  };
  const scopeName = (c: Card) => (c.scope.kind === "list" ? lists.find((l) => l.id === c.scope.id)?.name ?? "A list" : c.scope.kind === "folder" ? folders.find((f) => f.id === c.scope.id)?.name ?? "A folder" : c.scope.kind === "me" ? "Me" : "Everything");
  const overdue = (t: PjTask) => !t.closedAt && !!t.dueDate && t.dueDate < today;
  const cards = await Promise.all(
    parse<Card[]>(d.cards, []).map(async (c) => {
      const ts = scoped(c).filter((t) => !t.parentId);
      const base = { ...c, scopeName: scopeName(c) };
      if (c.type === "count") {
        const which = c.options?.which ?? "open";
        const pick = which === "open" ? ts.filter((t) => !t.closedAt) : which === "overdue" ? ts.filter(overdue) : which === "done" ? ts.filter((t) => { const x = dayOf(t.closedAt); return !!x && x >= week && x <= weekEnd; }) : ts;
        const sub = which === "open" ? `${ts.filter(overdue).length} overdue` : which === "done" ? `${pick.filter((t) => parse<Assignee[]>(t.assignees, []).some((a) => a.type === "employee")).length} by employees, ${pick.filter((t) => !parse<Assignee[]>(t.assignees, []).some((a) => a.type === "employee")).length} by people` : "";
        return { ...base, number: pick.length, sub };
      }
      if (c.type === "status") {
        const sts = c.scope.kind === "list" ? statusesOf(lists.find((l) => l.id === c.scope.id) ?? lists[0] ?? { statuses: "[]" }) : Array.from(new Map(lists.flatMap((l) => statusesOf(l)).map((s) => [s.name, s])).values());
        return { ...base, bars: sts.map((s) => ({ label: s.name, color: s.color, value: ts.filter((t) => t.status === s.name).length })).filter((b) => b.value > 0 || c.scope.kind === "list") };
      }
      if (c.type === "person" || c.type === "overdue") {
        const pick = c.type === "overdue" ? ts.filter(overdue) : ts.filter((t) => !t.closedAt);
        const rows = people.map((p) => ({ label: p.name, value: pick.filter((t) => parse<Assignee[]>(t.assignees, []).some((a) => a.type === p.type && a.id === p.id)).length })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
        return { ...base, bars: rows.map((r) => ({ ...r, color: c.type === "overdue" ? "#c2253c" : "#1b6b4a" })) };
      }
      if (c.type === "time") {
        const ids = new Set(ts.map((t) => t.id));
        const es = db.work.time.all(orgId).filter((e) => ids.has(e.taskId) && e.day >= week && e.day <= weekEnd);
        const mins = (e: (typeof es)[number]) => e.minutes ?? (e.startedAt ? Math.round((Date.now() - new Date(e.startedAt).getTime()) / 60000) : 0);
        const total = es.reduce((s, e) => s + mins(e), 0);
        const bill = es.filter((e) => e.billable).reduce((s, e) => s + mins(e), 0);
        return { ...base, minutes: total, sub: `${fmt(bill)} billable` };
      }
      if (c.type === "workload") {
        const w = await workload(orgId, v, { start: week, weeks: 1, listId: c.scope.kind === "list" ? c.scope.id : null });
        return { ...base, bars: w.rows.filter((r) => r.cells[0].minutes > 0).map((r) => ({ label: r.name, value: Math.round(r.cells[0].minutes / 60), max: r.hours, color: r.hours && r.cells[0].minutes / 60 > r.hours ? "#c2253c" : r.hours && r.cells[0].minutes / 60 >= r.hours * 0.9 ? "#d97706" : "#1b6b4a" })) };
      }
      if (c.type === "trend") {
        const weeks = Array.from({ length: 8 }, (_, i) => addDays(week, (i - 7) * 7));
        return {
          ...base,
          weeks,
          done: weeks.map((w) => ts.filter((t) => { const x = dayOf(t.closedAt); return !!x && x >= w && x <= addDays(w, 6); }).length),
          added: weeks.map((w) => ts.filter((t) => { const x = dayOf(t.createdAt); return !!x && x >= w && x <= addDays(w, 6); }).length),
        };
      }
      if (c.type === "burndown") {
        const days = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
        return { ...base, days, open: days.map((d0) => ts.filter((t) => (dayOf(t.createdAt) ?? "") <= d0 && (!t.closedAt || (dayOf(t.closedAt) ?? "") > d0)).length) };
      }
      if (c.type === "tasks") {
        const pick = ts.filter((t) => !t.closedAt && t.dueDate && t.dueDate <= weekEnd).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")).slice(0, 8);
        return { ...base, tasks: pick.map((t) => ({ id: t.id, name: t.name, dueDate: t.dueDate, overdue: overdue(t) })) };
      }
      if (c.type === "goal") {
        const { overview } = await import("./goals");
        const ov = await overview(orgId);
        const g = ov.goals.find((x) => x.goal.id === c.options?.goalId);
        return { ...base, goal: g ? { title: g.goal.title, progress: g.progress, status: g.status } : null };
      }
      if (c.type === "doc") {
        const doc = c.options?.docId ? db.work.docs.get(orgId, c.options.docId) : null;
        const blocks = doc ? parse<{ type: string; text: string }[]>(doc.blocks, []) : [];
        return { ...base, doc: doc ? { id: doc.id, title: doc.title, lines: blocks.filter((b) => b.text.trim()).slice(0, 6).map((b) => b.text) } : null };
      }
      // fieldsum: total of a number, money or formula field.
      const fid = c.options?.field;
      let total = 0;
      let fieldName = "";
      let money = false;
      for (const t of ts) {
        const l = lists.find((x) => x.id === t.listId);
        if (!l) continue;
        const fds = fieldsOf(orgId, l);
        const fd = fds.find((x) => x.id === fid);
        if (!fd) continue;
        fieldName = fd.name;
        const vals = parse<Record<string, unknown>>(t.fields, {});
        if (fd.type === "money") money = true;
        if (fd.type === "formula") {
          const named: Record<string, number | null> = {};
          for (const x of fds) if (x.type === "number" || x.type === "money") named[x.name] = typeof vals[x.id] === "number" ? (vals[x.id] as number) : vals[x.id] ? Number(vals[x.id]) : null;
          total += evalFormula(fd.setup ?? "", named) ?? 0;
        } else total += Number(vals[fd.id] ?? 0) || 0;
      }
      return { ...base, number: Math.round(total * 100) / 100, money, sub: fieldName ? `Total of ${fieldName}` : "Pick a field" };
    })
  );
  return { id: d.id, name: d.name, cards, today };
}

const fmt = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`);

/** What a card can point at, for the card editor. */
export async function cardChoices(orgId: number, v: Viewer) {
  const vis = visibleLists(orgId, v);
  const fields: { id: string; name: string; listName: string }[] = [];
  for (const { list } of vis) for (const f of fieldsOf(orgId, list)) if (["number", "money", "formula", "rating"].includes(f.type) && !fields.some((x) => x.id === f.id)) fields.push({ id: f.id, name: f.name, listName: list.name });
  return {
    lists: vis.map((x) => ({ id: x.list.id, name: x.list.name })),
    folders: db.work.folders.all(orgId).map((f) => ({ id: f.id, name: f.name })),
    fields,
    goals: db.work.goals.all(orgId).filter((g) => g.state === "active").map((g) => ({ id: g.id, title: g.title })),
    docs: db.work.docs.all(orgId).map((d) => ({ id: d.id, title: d.title })),
  };
}
