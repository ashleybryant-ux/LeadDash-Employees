import { TRPCError } from "@trpc/server";
import * as db from "../db";
import * as integrations from "../integrations";
import { storagePut } from "../storage";
import { partsIn } from "../employees/schedule";
import type { Goal, PjList } from "../../drizzle/schema";
import { DEFAULT_STATUSES, FOLDER_COLORS, type Assignee, type CheckItem, type FieldDef, type StatusDef } from "./projects";
import { COLORS, sundayOf } from "./goals";

/**
 * Moving from ClickUp: the owner picks Spaces and the workspace each one goes
 * to. Folders, lists (with their own statuses and custom fields), tasks and
 * subtasks, assignees (matched to the team), dates, priorities, tags,
 * checklists, comments and attachments come over. A Space of goals (the 12
 * Week Year) also becomes goals and the weekly execution score. Nothing in
 * ClickUp changes. Running it again updates what came over before instead of
 * copying it twice, so an interrupted import is finished by running it again.
 */

export type Pick = { spaceId: string; name: string; orgId: number; mode: "projects" | "goals" };

const MAX_FILE = 25 * 1024 * 1024;
let last = 0;

/** ClickUp allows about 100 calls a minute: calls are spaced out, and a "too many" answer waits a minute. */
async function cu(orgId: number, path: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = last + (process.env.NODE_ENV === "test" ? 0 : 650) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      return await integrations.clickup(orgId, path);
    } catch (err) {
      const msg = (err as Error).message;
      if (/^429/.test(msg)) {
        await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 1 : 60_000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("ClickUp kept saying to slow down. Run the import again in a few minutes; it picks up where it stopped.");
}

/** The Spaces in the connected ClickUp, with how much is in each. */
export async function spaces(orgId: number) {
  const s = await integrations.clickupSettings(orgId);
  if (!s) throw new TRPCError({ code: "BAD_REQUEST", message: "Connect ClickUp on Integrations first." });
  const data = await cu(orgId, `/team/${s.teamId}/space?archived=false`);
  const out = [];
  for (const sp of data.spaces ?? []) {
    const folders = (await cu(orgId, `/space/${sp.id}/folder?archived=false`)).folders ?? [];
    const loose = (await cu(orgId, `/space/${sp.id}/list?archived=false`)).lists ?? [];
    const lists = folders.reduce((n: number, f: any) => n + (f.lists ?? []).length, 0) + loose.length;
    const goalsLike = folders.some((f: any) => /12 week|cycle|annual|goal/i.test(f.name)) || /annual planning|goals/i.test(sp.name);
    out.push({ id: String(sp.id), name: String(sp.name), folders: folders.length, lists, goalsLike });
  }
  return out;
}

export function latestImport(orgId: number) {
  return db.work.imports.all(orgId).sort((a, b) => b.id - a.id)[0] ?? null;
}

const running = new Set<number>();

/**
 * The workspace whose ClickUp connection to read from: this one when it has
 * ClickUp connected, otherwise the first of the person's other workspaces
 * (where they're an owner or admin) that does. So the import works from any
 * workspace once ClickUp is connected in one of them.
 */
export async function clickupSource(orgId: number, adminOrgs: number[]) {
  if (await integrations.clickupSettings(orgId)) return orgId;
  for (const id of adminOrgs) if (id !== orgId && (await integrations.clickupSettings(id))) return id;
  return null;
}

/** Starts an import. Progress is kept on this workspace (orgId); ClickUp is read through the source workspace's connection. */
export function startImport(orgId: number, picks: Pick[], by: { id: number; name: string }, src = orgId) {
  if (running.has(orgId)) throw new TRPCError({ code: "BAD_REQUEST", message: "An import is already running." });
  if (!picks.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one Space." });
  const row = db.work.imports.insert({ organizationId: orgId, picks: JSON.stringify(picks), startedBy: by.name, progress: "Starting" });
  running.add(orgId);
  void run(src, row.id, picks, by, orgId)
    .catch((err) => db.work.imports.update(orgId, row.id, { status: "failed", error: (err as Error).message.slice(0, 500), finishedAt: new Date() }))
    .finally(() => running.delete(orgId));
  return row;
}

/** Imports that were running when the server restarted say so; running again finishes them. */
export function failInterrupted() {
  for (const org of db.listAllImportsRunning()) db.work.imports.update(org.organizationId, org.id, { status: "failed", error: "The server restarted during the import. Run it again; it picks up where it stopped.", finishedAt: new Date() });
}

type Counts = { folders: number; lists: number; tasks: number; comments: number; files: number; goals: number };

async function run(srcOrg: number, importId: number, picks: Pick[], by: { id: number; name: string }, statusOrg = srcOrg) {
  const counts: Counts = { folders: 0, lists: 0, tasks: 0, comments: 0, files: 0, goals: 0 };
  const say = (progress: string) => db.work.imports.update(statusOrg, importId, { progress: progress.slice(0, 300), counts: JSON.stringify(counts) });
  for (const pick of picks) {
    say(`Reading ${pick.name}`);
    const org = await db.getOrganizationById(pick.orgId);
    if (!org) continue;
    const tz = org.timezone || "America/Chicago";
    const team = (await db.listMembers(pick.orgId)).filter((m) => m.role !== "reviewer");
    const toAssignee = (u: any): Assignee => {
      const email = String(u?.email ?? "").toLowerCase();
      const name = String(u?.username ?? u?.email ?? "Someone");
      const first = name.split(/\s+/)[0].toLowerCase();
      const m = team.find((p) => p.email.toLowerCase() === email) ?? team.find((p) => (p.name ?? "").toLowerCase().split(/\s+/)[0] === first);
      return m ? { type: "user", id: m.userId, name: m.name || m.email } : { type: "name", id: 0, name };
    };
    const ymd = (ms: unknown) => {
      if (!ms) return null;
      const p = partsIn(new Date(Number(ms)), tz);
      return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    };
    const folders = (await cu(srcOrg, `/space/${pick.spaceId}/folder?archived=false`)).folders ?? [];
    const loose = (await cu(srcOrg, `/space/${pick.spaceId}/list?archived=false`)).lists ?? [];
    // The first Space going to a workspace keeps its folders as they are (the one named like the workspace first);
    // another Space's folders carry its name.
    const toHere = picks.filter((p) => p.orgId === pick.orgId && p.mode === "projects");
    const named = toHere.find((p) => org.name.toLowerCase().includes(p.name.toLowerCase().replace(/,? inc\.?$/, "").trim()) || p.name.toLowerCase().includes(org.name.toLowerCase()));
    const main = pick.mode === "projects" && (named ?? toHere[0])?.spaceId === pick.spaceId;
    const folderName = (n: string) => (main ? n : `${pick.name}: ${n}`);
    const jobs: { list: any; folderId: number | null; cycle?: { name: string; start: string | null; end: string | null } }[] = [];
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      const folder = upsertFolder(pick.orgId, String(f.id), folderName(String(f.name)), FOLDER_COLORS[i % FOLDER_COLORS.length], counts);
      for (const l of f.lists ?? []) jobs.push({ list: l, folderId: folder.id, cycle: pick.mode === "goals" ? cycleOf(String(f.name)) : undefined });
    }
    if (loose.length) {
      const holder = main ? null : upsertFolder(pick.orgId, `space-${pick.spaceId}`, pick.name, FOLDER_COLORS[folders.length % FOLDER_COLORS.length], counts);
      for (const l of loose) jobs.push({ list: l, folderId: holder?.id ?? null });
    }
    for (const job of jobs) {
      const full = await cu(srcOrg, `/list/${job.list.id}`);
      const fieldsRaw = (await cu(srcOrg, `/list/${job.list.id}/field`)).fields ?? [];
      const fields = fieldsRaw.map(toField);
      const statuses: StatusDef[] = (full.statuses ?? []).map((s: any) => ({ name: String(s.status).toLowerCase(), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#87909e", type: s.type === "open" ? "open" : s.type === "done" ? "done" : s.type === "closed" ? "closed" : "active" }));
      const list = upsertList(pick.orgId, String(job.list.id), String(job.list.name), job.folderId, String(full.content ?? ""), statuses.length ? statuses : DEFAULT_STATUSES, fields, counts);
      const tasks: any[] = [];
      for (let page = 0; page < 50; page++) {
        const d = await cu(srcOrg, `/list/${job.list.id}/task?include_closed=true&subtasks=true&archived=false&page=${page}`);
        tasks.push(...(d.tasks ?? []));
        if (d.last_page !== false || !(d.tasks ?? []).length) break;
      }
      // Parents before subtasks.
      tasks.sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
      const goalIds = new Map<string, number>();
      for (let n = 0; n < tasks.length; n++) {
        const t = tasks[n];
        say(`${pick.name} · ${job.list.name}: task ${n + 1} of ${tasks.length}`);
        const one = await cu(srcOrg, `/task/${t.id}?include_markdown_description=true`).catch(() => t);
        const id = upsertTask(pick.orgId, list, one, fieldsRaw, toAssignee, ymd, counts);
        // The 12 Week Year: goals in the Goals list become goals, scores become the execution score.
        if (pick.mode === "goals" && job.cycle && /goal/i.test(job.list.name) && isGoalTask(one)) {
          const gid = upsertGoal(pick.orgId, one, job.cycle, ymd, counts);
          goalIds.set(String(one.id), gid);
          db.work.tasks.update(pick.orgId, id, { goalId: gid });
        }
        if (pick.mode === "goals" && /execution score|score/i.test(job.list.name)) scoreValue(pick.orgId, one, ymd);
        for (const a of one.attachments ?? []) await saveAttachment(pick.orgId, id, a, by, counts);
        const comments = (await cu(srcOrg, `/task/${t.id}/comment`).catch(() => ({ comments: [] }))).comments ?? [];
        for (const c of comments.reverse()) upsertComment(pick.orgId, id, c, toAssignee, counts);
      }
    }
  }
  db.work.imports.update(statusOrg, importId, { status: "done", progress: "Done", counts: JSON.stringify(counts), finishedAt: new Date() });
}

function byClickup<T extends { clickupId: string | null }>(rows: T[], id: string) {
  return rows.find((r) => r.clickupId === id) ?? null;
}

function upsertFolder(orgId: number, cuId: string, name: string, color: string, counts: Counts) {
  const have = byClickup(db.work.folders.all(orgId), cuId);
  if (have) return db.work.folders.update(orgId, have.id, { name: name.slice(0, 80) })!;
  counts.folders++;
  return db.work.folders.insert({ organizationId: orgId, name: name.slice(0, 80), color, clickupId: cuId, sort: db.work.folders.all(orgId).length });
}

function upsertList(orgId: number, cuId: string, name: string, folderId: number | null, description: string, statuses: StatusDef[], fields: FieldDef[], counts: Counts) {
  const have = byClickup(db.work.lists.all(orgId), cuId);
  const row = { name: name.slice(0, 120), folderId, description: description.slice(0, 2000), statuses: JSON.stringify(statuses), fields: JSON.stringify(fields) };
  if (have) return db.work.lists.update(orgId, have.id, row)!;
  counts.lists++;
  return db.work.lists.insert({ organizationId: orgId, clickupId: cuId, sort: db.work.lists.all(orgId).length, ...row });
}

function toField(f: any): FieldDef {
  const type: FieldDef["type"] = f.type === "drop_down" || f.type === "labels" ? "dropdown" : f.type === "number" ? "number" : f.type === "currency" ? "money" : f.type === "date" ? "date" : f.type === "checkbox" ? "checkbox" : "text";
  const options = type === "dropdown" ? (f.type_config?.options ?? []).map((o: any) => ({ id: String(o.id), name: String(o.name ?? o.label ?? ""), color: /^#[0-9a-f]{6}$/i.test(o.color ?? "") ? o.color : "#87909e", orderindex: o.orderindex })) : undefined;
  return { id: String(f.id), name: String(f.name), type, ...(options ? { options: options.map(({ id, name, color }: any) => ({ id, name, color })) } : {}) };
}

function fieldValues(task: any, defs: any[], ymd: (ms: unknown) => string | null) {
  const out: Record<string, unknown> = {};
  for (const cf of task.custom_fields ?? []) {
    if (cf.value === undefined || cf.value === null || cf.value === "") continue;
    const def = defs.find((d) => String(d.id) === String(cf.id));
    if (!def) continue;
    if (def.type === "drop_down") {
      const o = (def.type_config?.options ?? []).find((x: any) => x.orderindex === cf.value || String(x.id) === String(cf.value) || Number(x.orderindex) === Number(cf.value));
      if (o) out[String(cf.id)] = String(o.id);
    } else if (def.type === "labels") {
      const first = Array.isArray(cf.value) ? cf.value[0] : null;
      if (first) out[String(cf.id)] = String(first);
    } else if (def.type === "date") out[String(cf.id)] = ymd(cf.value);
    else if (def.type === "checkbox") out[String(cf.id)] = cf.value === true || cf.value === "true";
    else if (def.type === "number" || def.type === "currency") out[String(cf.id)] = Number(cf.value);
    else out[String(cf.id)] = String(cf.value).slice(0, 2000);
  }
  return out;
}

function upsertTask(orgId: number, list: PjList, t: any, defs: any[], toAssignee: (u: any) => Assignee, ymd: (ms: unknown) => string | null, counts: Counts) {
  const statuses = JSON.parse(list.statuses) as StatusDef[];
  const status = String(t.status?.status ?? statuses[0].name).toLowerCase();
  const checklist: CheckItem[] = (t.checklists ?? []).flatMap((c: any) => (c.items ?? []).map((i: any) => ({ text: (t.checklists.length > 1 ? `${c.name}: ` : "") + String(i.name ?? ""), done: !!i.resolved })));
  const parent = t.parent ? byClickup(db.work.tasks.all(orgId), String(t.parent)) : null;
  const closed = t.date_closed ? new Date(Number(t.date_closed)) : statuses.find((s) => s.name === status && (s.type === "done" || s.type === "closed")) ? new Date(Number(t.date_updated ?? Date.now())) : null;
  const pr = String(t.priority?.priority ?? "").toLowerCase();
  const row = {
    listId: list.id,
    parentId: parent?.id ?? null,
    name: String(t.name ?? "Untitled").slice(0, 300),
    description: String(t.markdown_description ?? t.text_content ?? t.description ?? "").slice(0, 20_000),
    status: statuses.some((s) => s.name === status) ? status : statuses[0].name,
    priority: (["urgent", "high", "normal", "low"].includes(pr) ? pr : null) as "urgent" | "high" | "normal" | "low" | null,
    startDate: ymd(t.start_date),
    dueDate: ymd(t.due_date),
    timeEstimate: t.time_estimate ? Math.round(Number(t.time_estimate) / 60_000) : null,
    tags: JSON.stringify((t.tags ?? []).map((x: any) => String(x.name).toLowerCase()).slice(0, 20)),
    assignees: JSON.stringify((t.assignees ?? []).map(toAssignee)),
    fields: JSON.stringify(fieldValues(t, defs, ymd)),
    checklist: JSON.stringify(checklist.slice(0, 100)),
    closedAt: closed,
    createdBy: String(t.creator?.username ?? "ClickUp"),
  };
  const have = byClickup(db.work.tasks.all(orgId), String(t.id));
  if (have) {
    db.work.tasks.update(orgId, have.id, row);
    return have.id;
  }
  counts.tasks++;
  return db.work.tasks.insert({ organizationId: orgId, clickupId: String(t.id), sort: Number(t.orderindex ?? 0) || Number(t.date_created ?? 0) % 1_000_000_000, ...row }).id;
}

function upsertComment(orgId: number, taskId: number, c: any, toAssignee: (u: any) => Assignee, counts: Counts) {
  const text = String(c.comment_text ?? "").trim();
  if (!text) return;
  const cuId = `c${c.id}`;
  const have = db.work.comments.where(orgId, "taskId", taskId).find((x) => x.body.endsWith(`​${cuId}`) || x.body === text);
  if (have) return;
  const who = toAssignee(c.user);
  counts.comments++;
  db.work.comments.insert({ organizationId: orgId, taskId, kind: "comment", authorType: "user", authorId: who.type === "user" ? who.id : null, authorName: who.name, body: text.slice(0, 10_000), createdAt: c.date ? new Date(Number(c.date)) : new Date() });
}

async function saveAttachment(orgId: number, taskId: number, a: any, by: { id: number; name: string }, counts: Counts) {
  const name = String(a.title ?? a.name ?? "file").slice(0, 200);
  const have = db.work.filesFor(orgId, "task", [taskId]).some((f) => f.file!.name === name);
  if (have || !a.url) return;
  try {
    const res = await fetch(String(a.url), { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_FILE) return;
    const mime = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const saved = await storagePut(`org-${orgId}/projects/${name.replace(/[^\w.-]+/g, "_")}`, buf, mime);
    const image = /^image\/(png|jpe?g|webp|gif)$/.test(mime);
    const f = db.createChatFile({ organizationId: orgId, employeeId: 0, userId: by.id, name, mime, size: buf.length, kind: image ? "image" : "document", fileUrl: saved.url, text: "", pages: null });
    db.work.files.insert({ organizationId: orgId, itemType: "task", itemId: taskId, fileId: f.id, addedBy: "ClickUp" });
    counts.files++;
  } catch {
    // A file that won't download is skipped; the task still comes over.
  }
}

// ==========================================
// The 12 Week Year
// ==========================================

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)" gives the cycle's name and dates. */
export function cycleOf(name: string) {
  const m = name.match(/\(([A-Za-z]{3})[a-z]*\.? (\d{1,2})\s*[–-]\s*([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})\)/);
  const cyc = name.match(/cycle\s*(\d+)/i);
  if (!m) return { name: cyc ? `Cycle ${cyc[1]}` : name.slice(0, 40), start: null, end: null };
  const y = Number(m[5]);
  const mo = (s: string) => MONTHS.indexOf(s.toLowerCase()) + 1;
  const sm = mo(m[1]);
  const em = mo(m[3]);
  const sy = sm > em ? y - 1 : y;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { name: `${cyc ? `Cycle ${cyc[1]}` : "Cycle"}, ${y}`, start: `${sy}-${pad(sm)}-${pad(Number(m[2]))}`, end: `${y}-${pad(em)}-${pad(Number(m[4]))}` };
}

/** A goal in the Goals list: marked with a colored circle, or a task that has subtasks. */
export function isGoalTask(t: any) {
  return /^\s*(\uD83D\uDFE2|\uD83D\uDFE1|\uD83D\uDD34|\uD83C\uDFAF|\u2B50)/.test(String(t.name ?? "")) || (t.subtasks ?? []).length > 0 || /\bby (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d/i.test(String(t.name ?? ""));
}

function upsertGoal(orgId: number, t: any, cycle: { name: string; start: string | null; end: string | null }, ymd: (ms: unknown) => string | null, counts: Counts) {
  const raw = String(t.name ?? "");
  const status: Goal["status"] = raw.includes("🟢") ? "on" : raw.includes("🟡") ? "risk" : raw.includes("🔴") ? "off" : null;
  const title = raw.replace(/^\s*(\uD83D\uDFE2|\uD83D\uDFE1|\uD83D\uDD34|\uD83C\uDFAF|\u2B50)\s*/, "").trim().slice(0, 200);
  const st = String(t.status?.status ?? "").toLowerCase();
  const state: Goal["state"] = /cancel/.test(st) ? "archived" : t.status?.type === "done" || t.status?.type === "closed" || /complete|done/.test(st) ? "done" : "active";
  const due = cycle.end ?? ymd(t.due_date) ?? new Date().toISOString().slice(0, 10);
  const start = cycle.start ?? ymd(t.start_date) ?? due;
  const row = { title, level: "cycle" as const, period: cycle.name, startDate: start <= due ? start : due, dueDate: due, status, state, description: String(t.text_content ?? "").slice(0, 4000), color: COLORS[1], setBy: "Imported from ClickUp" };
  const have = byClickup(db.work.goals.all(orgId), String(t.id));
  if (have) return db.work.goals.update(orgId, have.id, row)!.id;
  counts.goals++;
  return db.work.goals.insert({ organizationId: orgId, clickupId: String(t.id), ...row }).id;
}

/** "Week 3: 82%" in the execution score list becomes that week's score. */
function scoreValue(orgId: number, t: any, ymd: (ms: unknown) => string | null) {
  const pct = String(t.name ?? "").match(/(\d{1,3})\s*%/) ?? String(t.text_content ?? "").match(/(\d{1,3})\s*%/);
  const when = ymd(t.due_date) ?? ymd(t.date_created);
  if (!pct || !when) return;
  let m = db.work.measures.all(orgId).find((x) => x.active && /execution score/i.test(x.name));
  if (!m) m = db.work.measures.insert({ organizationId: orgId, name: "Weekly execution score", unit: "percent", direction: "up", kind: "leading", source: "manual", weeklyGoal: 85, sort: 0 });
  db.work.setValue(orgId, m.id, sundayOf(when), Math.min(100, Number(pct[1])), "ClickUp");
}

// ==========================================
// From a ClickUp CSV export (Workspace settings, Import/Export, Export)
// ==========================================

/**
 * The same import from the file ClickUp exports, for when the live
 * connection isn't wanted or everything lives in one ClickUp Workspace: each
 * Space in the file goes to the workspace the owner picks. Folders, lists,
 * tasks, subtasks, assignees, dates, priorities, checklists, comments and
 * attachments come over the same way, and the 12 Week Year becomes goals.
 * Running it again updates what came over before.
 */

/** A small CSV reader: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = ""; rows.push(row); row = [];
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() ?? []).map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const REQUIRED = ["Task ID", "Task Name", "Status", "List Name", "Space Name"];
const j = <T,>(raw: string, fallback: T): T => {
  if (!raw || raw === "null" || raw === "NaN") return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};
const num = (raw: string) => (raw && raw !== "null" && raw !== "NaN" && Number.isFinite(Number(raw)) ? Number(raw) : null);

export type CsvRow = Record<string, string>;

/** ClickUp writes people and tags as "[Ashley Bryant, Caroline Jones]" (no quotes), sometimes as real JSON. */
export function nameList(raw: string): string[] {
  const asJson = j<unknown>(raw, null);
  if (Array.isArray(asJson)) return asJson.map((x) => String(typeof x === "object" && x ? ((x as any).username ?? (x as any).name ?? "") : x).trim()).filter(Boolean);
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((x) => x.trim()).filter(Boolean);
}

/** What's in the file: each Space with its folders and lists, the way the live import lists them. */
export function csvSpaces(text: string) {
  const rows = parseCsv(text);
  const missing = REQUIRED.filter((k) => !(k in (rows[0] ?? {})));
  if (!rows.length || missing.length) throw new TRPCError({ code: "BAD_REQUEST", message: `That doesn't look like a ClickUp task export. Export it from ClickUp under Workspace settings, Import/Export, as CSV.${missing.length ? ` Missing columns: ${missing.join(", ")}.` : ""}` });
  const spaces = new Map<string, { folders: Set<string>; lists: Set<string>; tasks: number }>();
  for (const r of rows) {
    const sp = spaces.get(r["Space Name"]) ?? { folders: new Set<string>(), lists: new Set<string>(), tasks: 0 };
    const folder = j<string[]>(r["Folder Name/Path"], [])[0];
    if (folder) sp.folders.add(folder);
    sp.lists.add(`${folder ?? ""}/${r["List Name"]}`);
    sp.tasks++;
    spaces.set(r["Space Name"], sp);
  }
  return {
    rows: rows.length,
    spaces: Array.from(spaces.entries()).map(([name, sp]) => ({
      id: `csv:${name}`,
      name,
      folders: sp.folders.size,
      lists: sp.lists.size,
      tasks: sp.tasks,
      goalsLike: Array.from(sp.folders).some((f) => /12 week|cycle|annual|goal/i.test(f)) || /annual planning|goals/i.test(name),
    })),
  };
}

export function startCsvImport(orgId: number, text: string, picks: Pick[], by: { id: number; name: string }) {
  if (running.has(orgId)) throw new TRPCError({ code: "BAD_REQUEST", message: "An import is already running." });
  if (!picks.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one Space." });
  const rows = parseCsv(text);
  const row = db.work.imports.insert({ organizationId: orgId, picks: JSON.stringify(picks.map((p) => ({ ...p, from: "csv" }))), startedBy: by.name, progress: "Starting" });
  running.add(orgId);
  void runCsv(orgId, row.id, rows, picks, by)
    .catch((err) => db.work.imports.update(orgId, row.id, { status: "failed", error: (err as Error).message.slice(0, 500), finishedAt: new Date() }))
    .finally(() => running.delete(orgId));
  return row;
}

/** Statuses for one list, from the statuses its tasks use, in ClickUp's usual order. */
function csvStatuses(names: string[]): StatusDef[] {
  const kind = (n: string): StatusDef["type"] => (/^(complete|completed|done|published|closed|joined|approved)$/.test(n) ? "done" : /cancel|skipped|rejected/.test(n) ? "closed" : /^(to do|todo|open|idea|backlog|not started)$/.test(n) ? "open" : "active");
  const color = (n: string, t: StatusDef["type"]) => (t === "done" ? "#008844" : t === "closed" ? "#87909e" : t === "open" ? (n === "idea" ? "#b5bcc2" : "#87909e") : /review/.test(n) ? "#f8ae00" : /scheduled/.test(n) ? "#7c3aed" : "#1090e0");
  const rank = { open: 0, active: 1, done: 2, closed: 3 } as const;
  const uniq = Array.from(new Set(names.map((n) => n.toLowerCase().trim()).filter(Boolean)));
  if (!uniq.includes("to do")) uniq.unshift("to do");
  return uniq.map((n) => ({ name: n, color: color(n, kind(n)), type: kind(n) })).sort((a, b) => rank[a.type] - rank[b.type]);
}

async function runCsv(orgId: number, importId: number, rows: CsvRow[], picks: Pick[], by: { id: number; name: string }) {
  const counts: Counts = { folders: 0, lists: 0, tasks: 0, comments: 0, files: 0, goals: 0 };
  const say = (progress: string) => db.work.imports.update(orgId, importId, { progress: progress.slice(0, 300), counts: JSON.stringify(counts) });
  const PRIORITY: Record<string, string> = { "1": "urgent", "2": "high", "3": "normal", "4": "low" };
  for (const pick of picks) {
    say(`Reading ${pick.name}`);
    const org = await db.getOrganizationById(pick.orgId);
    if (!org) continue;
    const tz = org.timezone || "America/Chicago";
    const team = (await db.listMembers(pick.orgId)).filter((m) => m.role !== "reviewer");
    const toAssignee = (u: any): Assignee => {
      const raw = String(u?.username ?? u?.email ?? u ?? "Someone").trim();
      const email = raw.includes("@") ? raw.toLowerCase() : "";
      const name = raw;
      // "Dr. Ashley Bryant" and "Ashley Bryant, PhD" are the same person.
      const plain = (n: string) => n.toLowerCase().replace(/\b(dr|mr|mrs|ms|phd|lpc|crc)\.?/g, "").replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
      const first = plain(name).split(" ")[0];
      const m = (email && team.find((p) => p.email.toLowerCase() === email)) || team.find((p) => plain(p.name ?? "") === plain(name)) || (first && team.find((p) => plain(p.name ?? "").split(" ")[0] === first)) || (email ? team.find((p) => p.email.toLowerCase().split("@")[0] === email.split("@")[0]) : null);
      return m ? { type: "user", id: m.userId, name: m.name || m.email } : { type: "name", id: 0, name: email ? email.split("@")[0] : name };
    };
    const ymd = (ms: unknown) => {
      const n = num(String(ms ?? ""));
      if (!n) return null;
      const p = partsIn(new Date(n), tz);
      return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
    };
    const mine = rows.filter((r) => r["Space Name"] === pick.name);
    // Folders and lists in this Space, in the order they first appear.
    const toHere = picks.filter((p) => p.orgId === pick.orgId && p.mode === "projects");
    const named = toHere.find((p) => org.name.toLowerCase().includes(p.name.toLowerCase().replace(/,? inc\.?$/, "").trim()) || p.name.toLowerCase().includes(org.name.toLowerCase().replace(/,? inc\.?$/, "").trim()));
    const main = pick.mode === "projects" && (named ?? toHere[0])?.spaceId === pick.spaceId;
    const folderName = (n: string) => (main ? n : `${pick.name}: ${n}`);
    const folderIds = new Map<string, number | null>();
    const listIds = new Map<string, PjList>();
    let fi = 0;
    for (const r of mine) {
      const folder = j<string[]>(r["Folder Name/Path"], [])[0] ?? "";
      const listKey = `${folder}/${r["List Name"]}`;
      if (listIds.has(listKey)) continue;
      if (!folderIds.has(folder)) {
        if (folder) folderIds.set(folder, upsertFolder(pick.orgId, `csv:${pick.spaceId}:${folder}`, folderName(folder), FOLDER_COLORS[fi++ % FOLDER_COLORS.length], counts).id);
        else folderIds.set(folder, main ? null : upsertFolder(pick.orgId, `space-${pick.spaceId}`, pick.name, FOLDER_COLORS[fi++ % FOLDER_COLORS.length], counts).id);
      }
      const inList = mine.filter((x) => (j<string[]>(x["Folder Name/Path"], [])[0] ?? "") === folder && x["List Name"] === r["List Name"]);
      const listCuId = r["Home Location ID"] && r["Home Location ID"] !== "null" ? r["Home Location ID"] : `csv:${pick.spaceId}:${listKey}`;
      listIds.set(listKey, upsertList(pick.orgId, listCuId, r["List Name"], folderIds.get(folder) ?? null, "", csvStatuses(inList.map((x) => x["Status"])), [], counts));
    }
    // Parents before subtasks, then in creation order.
    const sorted = [...mine].sort((a, b) => (a["Parent ID"] && a["Parent ID"] !== "null" ? 1 : 0) - (b["Parent ID"] && b["Parent ID"] !== "null" ? 1 : 0) || (num(a["Date Created"]) ?? 0) - (num(b["Date Created"]) ?? 0));
    for (let n = 0; n < sorted.length; n++) {
      const r = sorted[n];
      if (n % 25 === 0) say(`${pick.name}: ${n + 1} of ${sorted.length} tasks`);
      const folder = j<string[]>(r["Folder Name/Path"], [])[0] ?? "";
      const list = listIds.get(`${folder}/${r["List Name"]}`)!;
      const folderLabel = folder;
      const cycle = pick.mode === "goals" ? cycleOf(folderLabel || list.name) : undefined;
      const status = r["Status"].toLowerCase();
      const sts = JSON.parse(list.statuses) as StatusDef[];
      const done = sts.find((s) => s.name === status && (s.type === "done" || s.type === "closed"));
      const checklists = Object.entries(j<Record<string, string[]>>(r["Checklists"], {})).map(([name, items]) => ({ name, items: (Array.isArray(items) ? items : []).map((i) => ({ name: String(i), resolved: false })) }));
      const t = {
        id: r["Task ID"],
        name: r["Task Name"],
        markdown_description: r["Task Content"],
        status: { status, type: done?.type ?? "open" },
        priority: PRIORITY[r["Priority"]] ? { priority: PRIORITY[r["Priority"]] } : null,
        due_date: num(r["Due Date"]),
        start_date: num(r["Start Date"]),
        date_created: num(r["Date Created"]),
        date_updated: num(r["Due Date"]) ?? num(r["Date Created"]),
        date_closed: done ? (num(r["Due Date"]) ?? num(r["Date Created"])) : null,
        parent: r["Parent ID"] && r["Parent ID"] !== "null" ? r["Parent ID"] : null,
        subtasks: r["Subtasks IDs"] && r["Subtasks IDs"] !== "null" ? [1] : [],
        assignees: nameList(r["Assignees"]).map((name) => ({ username: name })),
        tags: nameList(r["Tags"]).map((name) => ({ name })),
        time_estimate: num(r["Time Estimated"]),
        checklists,
        custom_fields: [],
        text_content: r["Task Content"],
        creator: { username: "ClickUp" },
        orderindex: n,
      };
      const id = upsertTask(pick.orgId, list, t, [], toAssignee, ymd, counts);
      if (pick.mode === "goals" && cycle && /goal/i.test(list.name) && isGoalTask(t)) {
        const gid = upsertGoal(pick.orgId, t, cycle, ymd, counts);
        db.work.tasks.update(pick.orgId, id, { goalId: gid });
      }
      if (pick.mode === "goals" && /execution score|score/i.test(list.name)) scoreValue(pick.orgId, t, ymd);
      for (const a of j<{ title: string; url: string }[]>(r["Attachments"], [])) await saveAttachment(pick.orgId, id, a, by, counts);
      const comments = j<{ text: string; by: string; date: string }[]>(r["Comments"], []);
      for (const c of comments) {
        const when = Date.parse(String(c.date ?? "").replace(/ [A-Z]{3,4}$/, ""));
        upsertComment(pick.orgId, id, { id: `${r["Task ID"]}:${when || comments.indexOf(c)}`, comment_text: c.text, user: { username: c.by, email: c.by }, date: Number.isFinite(when) ? when : null }, toAssignee, counts);
      }
    }
  }
  db.work.imports.update(orgId, importId, { status: "done", progress: "Done", counts: JSON.stringify(counts), finishedAt: new Date() });
}
