import { TRPCError } from "@trpc/server";
import { evalFormula } from "@shared/formula";
import * as db from "../db";
import type { PjDashboard, PjTask } from "../../drizzle/schema";
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

type Loc = { kind: "everything" | "folder" | "list"; id?: number };
const isAdmin = (v: Viewer) => v.kind === "member" && (v.role === "owner" || v.role === "admin");
const uidOf = (v: Viewer) => (v.kind === "member" || v.kind === "guest" ? v.userId : 0);

/** Who may open a dashboard: everyone unless it is private, then its owner, admins and the people it was shared with. */
export function canSee(v: Viewer, d: PjDashboard) {
  if (!d.private) return true;
  if (isAdmin(v)) return true;
  const uid = uidOf(v);
  return d.ownerUserId === uid || parse<number[]>(d.sharedWith, []).includes(uid);
}
/** Who may change or delete it: its owner and admins (a dashboard nobody owns is everyone's). */
export function canEdit(v: Viewer, d: PjDashboard) {
  if (isAdmin(v)) return true;
  return !d.ownerUserId || d.ownerUserId === uidOf(v);
}

/** Where a dashboard mostly looks: the one list or folder its cards share, or everything. */
function locationOf(cards: Card[]): Loc {
  const scopes = cards.filter((c) => c.scope.kind === "list" || c.scope.kind === "folder").map((c) => `${c.scope.kind}:${c.scope.id}`);
  const uniq = Array.from(new Set(scopes));
  if (uniq.length === 1 && scopes.length >= cards.length / 2) {
    const [kind, id] = uniq[0].split(":");
    return { kind: kind as "list" | "folder", id: Number(id) };
  }
  return { kind: "everything" };
}

export const TEMPLATES = ["simple", "ai", "project"] as const;
export type Template = (typeof TEMPLATES)[number];

/** The hub: every dashboard this person can open, with who owns it, where it looks, when they last opened it, and who it is shared with. */
export async function dashboards(orgId: number, v: Viewer) {
  const uid = uidOf(v);
  const members = await db.listMembers(orgId);
  const lists = new Map(db.work.lists.all(orgId).map((l) => [l.id, l.name]));
  const folders = new Map(db.work.folders.all(orgId).map((f) => [f.id, f.name]));
  const stars = new Set(db.work.stars.where(orgId, "userId", uid).filter((s) => s.kind === "dash").map((s) => s.itemId));
  const person = (id: number | null) => {
    const m = id ? members.find((x) => x.userId === id) : null;
    return m ? { id: m.userId, name: m.name || m.email, avatarUrl: m.avatarUrl ?? null } : null;
  };
  const rows = db.work.dashboards
    .all(orgId)
    .filter((d) => canSee(v, d))
    .sort((a, b) => a.sort - b.sort || a.id - b.id)
    .map((d) => {
      const cards = parse<Card[]>(d.cards, []);
      const loc = (parse<Loc | null>(d.location, null) ?? locationOf(cards)) as Loc;
      const locName = loc.kind === "list" ? lists.get(loc.id ?? 0) ?? "A list" : loc.kind === "folder" ? folders.get(loc.id ?? 0) ?? "A folder" : "Everything";
      const seen = parse<Record<string, string>>(d.seen, {});
      const shared = parse<number[]>(d.sharedWith, []).map(person).filter((p): p is NonNullable<typeof p> => !!p);
      const owner = person(d.ownerUserId) ?? (d.ownerName ? { id: 0, name: d.ownerName, avatarUrl: null } : null);
      return {
        id: d.id,
        name: d.name,
        cards,
        owner,
        mine: !!d.ownerUserId && d.ownerUserId === uid,
        private: d.private,
        sharedWithMe: !!uid && d.ownerUserId !== uid && parse<number[]>(d.sharedWith, []).includes(uid),
        shared,
        starred: stars.has(d.id),
        location: { ...loc, name: locName },
        lastViewed: seen[String(uid)] ?? null,
        updatedAt: d.updatedAt && new Date(d.updatedAt).getTime() > 0 ? new Date(d.updatedAt).toISOString() : new Date(d.createdAt).toISOString(),
        canEdit: canEdit(v, d),
      };
    });
  return {
    dashboards: rows,
    counts: { all: rows.length, mine: rows.filter((r) => r.mine).length, shared: rows.filter((r) => r.sharedWithMe).length, private: rows.filter((r) => r.private).length },
    people: members.filter((m) => m.role !== "reviewer" && m.role !== "chat").map((m) => ({ id: m.userId, name: m.name || m.email, avatarUrl: m.avatarUrl ?? null })),
  };
}

function cleanCards(cards: Card[]) {
  return cards.slice(0, 40).map((c, i) => ({
    id: String(c.id || `c${i}`).slice(0, 40),
    type: (CARD_TYPES as readonly string[]).includes(c.type) ? c.type : "count",
    title: c.title.trim().slice(0, 80) || "Card",
    scope: { kind: ["everything", "folder", "list", "me"].includes(c.scope?.kind) ? c.scope.kind : "everything", ...(c.scope?.id ? { id: Number(c.scope.id) } : {}) },
    ...(c.options ? { options: c.options } : {}),
    size: ([1, 2, 3] as const).includes(c.size as 1) ? c.size : 1,
  }));
}

export function saveDashboard(orgId: number, v: Viewer, input: { id?: number; name: string; cards?: Card[]; template?: Template; location?: Loc | null }, by: { id: number; name: string }) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the dashboard." });
  const cards = input.cards ? cleanCards(input.cards) : undefined;
  if (input.id) {
    const have = db.work.dashboards.get(orgId, input.id);
    if (!have || !canSee(v, have)) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
    if (!canEdit(v, have)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who made this dashboard, or an admin, can change it." });
    return db.work.dashboards.update(orgId, input.id, { name, ...(cards ? { cards: JSON.stringify(cards) } : {}), ...(input.location !== undefined ? { location: JSON.stringify(input.location) } : {}), updatedAt: new Date() })!;
  }
  const loc = input.location ?? null;
  const starter = cards ?? templateCards(input.template ?? "simple", loc);
  return db.work.dashboards.insert({ organizationId: orgId, name, cards: JSON.stringify(starter), sort: db.work.dashboards.all(orgId).length, ownerUserId: by.id, ownerName: by.name, private: false, sharedWith: "[]", seen: "{}", location: JSON.stringify(loc ?? {}), updatedAt: new Date() });
}
export function removeDashboard(orgId: number, v: Viewer, id: number) {
  const have = db.work.dashboards.get(orgId, id);
  if (!have || !canSee(v, have)) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
  if (!canEdit(v, have)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who made this dashboard, or an admin, can delete it." });
  db.work.dashboards.remove(orgId, id);
  for (const s of db.work.stars.all(orgId).filter((s) => s.kind === "dash" && s.itemId === id)) db.work.stars.remove(orgId, s.id);
}

/** A copy of a dashboard, owned by whoever copied it. */
export function duplicateDashboard(orgId: number, v: Viewer, id: number, by: { id: number; name: string }) {
  const have = db.work.dashboards.get(orgId, id);
  if (!have || !canSee(v, have)) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
  return db.work.dashboards.insert({ organizationId: orgId, name: `${have.name} (copy)`.slice(0, 120), cards: have.cards, sort: db.work.dashboards.all(orgId).length, ownerUserId: by.id, ownerName: by.name, private: have.private, sharedWith: "[]", seen: "{}", location: have.location, updatedAt: new Date() });
}

/** Private (only the owner, admins and the people below), and who it is shared with. */
export function setDashboardSharing(orgId: number, v: Viewer, input: { id: number; private?: boolean; add?: number[]; remove?: number[] }) {
  const have = db.work.dashboards.get(orgId, input.id);
  if (!have || !canSee(v, have)) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
  if (!canEdit(v, have)) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who made this dashboard, or an admin, can share it." });
  let shared = parse<number[]>(have.sharedWith, []);
  for (const id of input.add ?? []) if (!shared.includes(id) && id !== have.ownerUserId) shared.push(id);
  if (input.remove?.length) shared = shared.filter((id) => !input.remove!.includes(id));
  return db.work.dashboards.update(orgId, have.id, { ...(input.private !== undefined ? { private: input.private } : {}), sharedWith: JSON.stringify(shared) })!;
}

/** Remembers that this person opened the dashboard now (Last viewed on the hub). */
export function markSeen(orgId: number, v: Viewer, id: number) {
  const have = db.work.dashboards.get(orgId, id);
  const uid = uidOf(v);
  if (!have || !uid) return;
  const seen = parse<Record<string, string>>(have.seen, {});
  seen[String(uid)] = new Date().toISOString();
  db.work.dashboards.update(orgId, have.id, { seen: JSON.stringify(seen) });
}

/** Favorite: the dashboard shows under Favorites in the sidebar. */
export function starDashboard(orgId: number, v: Viewer, id: number, on: boolean) {
  const uid = uidOf(v);
  const have = db.work.dashboards.get(orgId, id);
  if (!have || !canSee(v, have) || !uid) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
  const star = db.work.stars.where(orgId, "userId", uid).find((s) => s.kind === "dash" && s.itemId === id);
  if (on && !star) db.work.stars.insert({ organizationId: orgId, userId: uid, kind: "dash", itemId: id });
  if (!on && star) db.work.stars.remove(orgId, star.id);
  return { on };
}

/** The cards a template starts with. Simple: the week at a glance. AI team center: what each employee did. Project management: progress, overdue, burndown, workload. */
export function templateCards(t: Template, loc: Loc | null): Card[] {
  const scope: Card["scope"] = loc && loc.kind !== "everything" && loc.id ? { kind: loc.kind, id: loc.id } : { kind: "everything" };
  if (t === "ai")
    return [
      { id: "c1", type: "count", title: "Done this week", scope, options: { which: "done" }, size: 1 },
      { id: "c2", type: "person", title: "Open tasks by person", scope, size: 1 },
      { id: "c3", type: "time", title: "Time tracked", scope, size: 1 },
      { id: "c4", type: "workload", title: "Workload this week", scope, size: 1 },
      { id: "c5", type: "overdue", title: "Overdue by person", scope, size: 1 },
      { id: "c6", type: "tasks", title: "Due this week", scope, size: 1 },
      { id: "c7", type: "trend", title: "Done vs. added", scope, size: 3 },
    ];
  if (t === "project")
    return [
      { id: "c1", type: "count", title: "Open tasks", scope, options: { which: "open" }, size: 1 },
      { id: "c2", type: "count", title: "Overdue", scope, options: { which: "overdue" }, size: 1 },
      { id: "c3", type: "count", title: "Done this week", scope, options: { which: "done" }, size: 1 },
      { id: "c4", type: "status", title: "Tasks by status", scope, size: 1 },
      { id: "c5", type: "burndown", title: "Burndown", scope, size: 2 },
      { id: "c6", type: "workload", title: "Workload this week", scope, size: 1 },
      { id: "c7", type: "overdue", title: "Overdue by person", scope, size: 1 },
      { id: "c8", type: "trend", title: "Done vs. added", scope, size: 2 },
    ];
  return [
    { id: "c1", type: "count", title: "Open tasks", scope, options: { which: "open" }, size: 1 },
    { id: "c2", type: "count", title: "Done this week", scope, options: { which: "done" }, size: 1 },
    { id: "c3", type: "time", title: "Time tracked", scope, size: 1 },
    { id: "c4", type: "overdue", title: "Overdue by person", scope, size: 1 },
    { id: "c5", type: "workload", title: "Workload this week", scope, size: 1 },
    { id: "c6", type: "tasks", title: "Due this week", scope: { kind: "me" }, size: 1 },
    { id: "c7", type: "trend", title: "Done vs. added", scope, size: 2 },
  ];
}

export async function data(orgId: number, v: Viewer, id: number, me: Assignee) {
  const d = db.work.dashboards.get(orgId, id);
  if (!d || !canSee(v, d)) throw new TRPCError({ code: "NOT_FOUND", message: "That dashboard isn't here anymore." });
  markSeen(orgId, v, id);
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
  return { id: d.id, name: d.name, cards, today, canEdit: canEdit(v, d), private: d.private, starred: !!db.work.stars.where(orgId, "userId", uidOf(v)).find((s) => s.kind === "dash" && s.itemId === d.id) };
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
