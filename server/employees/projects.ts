import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { withUsage } from "../usage";
import type { AIEmployee, Launch, LaunchKpi, LaunchTask, KpiSource } from "../../drizzle/schema";
import { KPI_SOURCES } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import { partsIn, zonedToUtc } from "./schedule";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { gate, handoff, logActivity } from "./team";
import { opsFor, saveOps } from "./ops";

/**
 * Nora (Projects).
 * - Plans a launch back from its date: milestones, tasks with one owner each, and KPIs.
 * - Once the plan is approved, creates a ClickUp list for it with every task.
 * - Every morning: reads ClickUp, marks what is done, flags what is behind and
 *   reminds owners. On the report day: the weekly status report.
 * - KPIs count from what the employees already track (demos, outreach, posts...).
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });

const DAY = 86_400_000;

export const KPI_LABELS: Record<KpiSource, string> = {
  demos_booked: "Malik: demos booked",
  new_leads: "Malik: new leads",
  practices_contacted: "Jada: practices contacted",
  reply_rate: "Jada: reply rate",
  posts_published: "Sienna: posts published",
  articles_published: "Theo: articles published",
  tasks_on_time: "ClickUp: tasks done on time",
  manual: "You enter it",
};
const KPI_WHO: Record<KpiSource, string> = { demos_booked: "Malik", new_leads: "Malik", practices_contacted: "Jada", reply_rate: "Jada", posts_published: "Sienna", articles_published: "Theo", tasks_on_time: "ClickUp", manual: "You" };

// ==========================================
// Dates
// ==========================================

/** Noon in the workspace's time zone on a YYYY-MM-DD day, so the date never slips across midnight. */
function dayAt(ymd: string, tz: string, h = 17, mi = 0) {
  const [y, m, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, m, d, h, mi, tz);
}
function ymdIn(d: Date, tz: string) {
  const p = partsIn(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
const fmt = (d: Date | number | string, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });

// ==========================================
// Task state, KPIs and pace
// ==========================================

export type TaskState = { key: "done" | "on_track" | "behind" | "not_started"; label: string };

export function taskState(t: Pick<LaunchTask, "status" | "dueDate">, now = new Date()): TaskState {
  if (t.status === "done") return { key: "done", label: "Done" };
  const days = (new Date(t.dueDate).getTime() - now.getTime()) / DAY;
  if (days < 0 || (t.status === "todo" && days <= 3)) return { key: "behind", label: "Behind" };
  if (t.status === "todo" && days > 7) return { key: "not_started", label: "Not started" };
  return { key: "on_track", label: "On track" };
}

async function kpiValue(orgId: number, launch: Launch, k: LaunchKpi) {
  const since = new Date(launch.approvedAt ?? launch.createdAt);
  const after = (d: Date | null | undefined) => !!d && new Date(d) >= since;
  switch (k.source) {
    case "demos_booked":
      return (await db.listLeads(orgId)).filter((l) => l.bookedFor && after(l.updatedAt)).length;
    case "new_leads":
      return (await db.listLeads(orgId)).filter((l) => after(l.createdAt)).length;
    case "practices_contacted":
      return (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => m.status === "published" && after(m.publishedAt) && JSON.parse(m.metadata || "{}").step === 1).length;
    case "reply_rate": {
      const sent = (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => m.status === "published" && after(m.publishedAt) && JSON.parse(m.metadata || "{}").step === 1);
      const ids = new Set(sent.map((m) => JSON.parse(m.metadata || "{}").prospectId));
      const replied = (await db.listProspects(orgId)).filter((p) => ids.has(p.id) && (p.stage === "replied" || p.stage === "booked")).length;
      return sent.length ? Math.round((replied / sent.length) * 1000) / 10 : 0;
    }
    case "posts_published":
      return (await db.listOutboundItemsByOrg(orgId, "social_post")).filter((m) => m.status === "published" && after(m.publishedAt)).length;
    case "articles_published":
      return (await db.listOutboundItemsByOrg(orgId, "blog_post")).filter((m) => m.status === "published" && after(m.publishedAt)).length;
    case "tasks_on_time": {
      const done = (await db.listLaunchTasks(launch.id, orgId)).filter((t) => t.status === "done" && t.doneAt);
      if (!done.length) return 100;
      return Math.round((done.filter((t) => new Date(t.doneAt!) <= new Date(new Date(t.dueDate).getTime() + DAY)).length / done.length) * 100);
    }
    default:
      return k.manualValue ?? 0;
  }
}

export function pace(k: Pick<LaunchKpi, "target" | "unit" | "byDate">, value: number, start: Date, now = new Date()) {
  if (k.unit === "percent") return value >= k.target * 0.95 ? "on_pace" : "behind";
  if (value >= k.target) return "on_pace";
  const total = new Date(k.byDate).getTime() - start.getTime();
  const share = total > 0 ? Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / total)) : 1;
  return value >= k.target * share * 0.9 ? "on_pace" : "behind";
}

// ==========================================
// Planning
// ==========================================

type PlanOut = {
  name: string;
  milestones: { name: string; date: string }[];
  tasks: { title: string; details: string; milestone: number; owner: string; date: string; waitingOn: string }[];
  kpis: { name: string; target: number; unit: "count" | "percent"; source: string }[];
};

/** Nora builds the plan; it waits for approval unless "Creating a launch plan" is set to On its own. */
export async function planLaunch(orgId: number, input: { name?: string; date: string; brief: string }) {
  const nora = await employeeFor(orgId, "projects");
  const { tz } = await opsFor(orgId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TRPCError({ code: "BAD_REQUEST", message: "Tell me the launch date, like Mon, Nov 16, 2026." });
  const launchDate = dayAt(input.date, tz, 9);
  if (launchDate.getTime() < Date.now() + 3 * DAY) throw new TRPCError({ code: "BAD_REQUEST", message: "The launch date needs to be at least 3 days away so there's time to plan." });
  const today = ymdIn(new Date(), tz);
  const emps = (await db.listEmployeesByOrg(orgId)).filter((e) => e.kind !== "projects" && e.kind !== "coo" && e.status !== "paused");
  const people = (await db.listMembers(orgId)).map((m) => m.name || m.email).filter(Boolean);
  const answers = (() => {
    try {
      return JSON.parse(nora.onboarding || "{}") as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  })();
  const plan = await working(nora, async () => {
    const { system } = await systemPromptFor(
      nora,
      `Your job: plan a launch back from its launch date.
- Today is ${today}. The launch date is ${input.date}. Every date you write is YYYY-MM-DD, on a weekday, on or after today and on or before the launch date.
- 4 to 6 milestones in order, the last one is "Launch day" on the launch date.
- 15 to 40 small tasks. Each has exactly one owner and belongs to one milestone (its index, starting at 0). A task is due ${answers.buffer ? answers.buffer : "1 day"} or more before its milestone, except launch-day tasks.
- Owners: give an employee's job key when an employee does that work, otherwise a person's name. Employees (job key: what they do): ${emps.map((e) => `${e.kind} (${e.name}): ${e.roleTitle}`).join("; ")}. People on the team: ${people.join(", ") || "the owner"}. Work only a person can do (pricing decisions, calls, approvals, signing) goes to a person.
- waitingOn: the task that must finish first, or "".
- 3 to 6 KPIs with a whole-number target. source is one of: ${KPI_SOURCES.join(", ")}. Use "manual" for anything the app cannot count (sign-ups, revenue). unit is percent only for reply_rate and tasks_on_time.
- name: a short name for the launch.`
    );
    return generateJson<PlanOut>({
      system,
      prompt: `${input.name ? `Launch: ${input.name}\n` : ""}What the owner asked for: ${input.brief}`,
      schemaName: "launch_plan",
      schema: obj({
        name: str,
        milestones: arr(obj({ name: str, date: str })),
        tasks: arr(obj({ title: str, details: str, milestone: int, owner: str, date: str, waitingOn: str })),
        kpis: arr(obj({ name: str, target: int, unit: { type: "string", enum: ["count", "percent"] }, source: { type: "string", enum: [...KPI_SOURCES] } })),
      }),
      maxTokens: 6000,
    });
  });

  const clamp = (ymd: string) => {
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : input.date;
    return ok < today ? today : ok > input.date ? input.date : ok;
  };
  const launch = await db.createLaunch({ organizationId: orgId, name: (input.name || plan.name || "Launch").slice(0, 160), launchDate, status: "planning", brief: input.brief.slice(0, 2000) });
  const ms = [];
  for (const [i, m] of Array.from((plan.milestones ?? []).slice(0, 8).entries())) {
    ms.push(await db.createMilestone({ organizationId: orgId, launchId: launch.id, name: m.name.slice(0, 160), dueDate: dayAt(clamp(m.date), tz), position: i }));
  }
  if (!ms.length) ms.push(await db.createMilestone({ organizationId: orgId, launchId: launch.id, name: "Launch day", dueDate: launchDate, position: 0 }));
  for (const t of (plan.tasks ?? []).slice(0, 60)) {
    const emp = emps.find((e) => e.kind === t.owner.trim().toLowerCase() || e.name.toLowerCase() === t.owner.trim().toLowerCase());
    const m = ms[Math.max(0, Math.min(ms.length - 1, Number(t.milestone) || 0))];
    await db.createLaunchTask({
      organizationId: orgId,
      launchId: launch.id,
      milestoneId: m.id,
      title: t.title.slice(0, 200),
      details: t.details?.slice(0, 2000) || null,
      ownerType: emp ? "employee" : "person",
      ownerKind: emp?.kind ?? null,
      ownerName: emp ? emp.name : (t.owner || people[0] || "You").slice(0, 120),
      ownerEmail: emp ? null : ((await db.listMembers(orgId)).find((x) => (x.name || x.email).toLowerCase() === t.owner.trim().toLowerCase())?.email ?? null),
      dueDate: dayAt(clamp(t.date), tz),
      waitingOn: t.waitingOn?.slice(0, 200) || null,
    });
  }
  for (const [i, k] of Array.from((plan.kpis ?? []).slice(0, 8).entries())) {
    const source = (KPI_SOURCES as readonly string[]).includes(k.source) ? (k.source as KpiSource) : "manual";
    await db.createKpi({ organizationId: orgId, launchId: launch.id, name: k.name.slice(0, 120), target: Math.max(0, Math.round(k.target)), unit: source === "reply_rate" || source === "tasks_on_time" ? "percent" : k.unit === "percent" ? "percent" : "count", byDate: launchDate, source, position: i });
  }
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: nora.name, action: "Planned a launch", details: launch.name });
  const auto = gate(nora, "create_plan") === "auto";
  if (auto) await approvePlan(orgId, launch.id, `${nora.name} (on her own)`);
  return { launch: (await db.getLaunch(launch.id, orgId))!, auto };
}

export async function approvePlan(orgId: number, launchId: number, who: string) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch) throw new TRPCError({ code: "NOT_FOUND", message: "That launch is not in this workspace." });
  if (launch.status !== "planning") return { launch, clickup: !!launch.clickupListId, error: null as string | null };
  await db.updateLaunch(launch.id, orgId, { status: "active", approvedBy: who, approvedAt: new Date() });
  const nora = await employeeFor(orgId, "projects");
  let error: string | null = null;
  try {
    if (await integrations.clickupSettings(orgId)) await pushToClickup(orgId, launch.id);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const fresh = (await db.getLaunch(launch.id, orgId))!;
  const tasks = await db.listLaunchTasks(launch.id, orgId);
  await logActivity(nora, "done", `Started the ${fresh.name} plan: ${tasks.length} tasks${fresh.clickupListId ? " in ClickUp" : ""}. Launch day ${fmt(fresh.launchDate, (await opsFor(orgId)).tz)}.`, "/chats/projects/work");
  // Each employee with tasks hears about them in their own chat.
  for (const kind of Array.from(new Set(tasks.filter((t) => t.ownerType === "employee" && t.ownerKind).map((t) => t.ownerKind!)))) {
    const mine = tasks.filter((t) => t.ownerKind === kind);
    await handoff(orgId, "projects", kind as AIEmployee["kind"], `${nora.name} added ${mine.length === 1 ? "a task" : `${mine.length} tasks`} for you on the ${fresh.name} launch. First due: ${mine[0].title}, ${fmt(mine[0].dueDate, (await opsFor(orgId)).tz)}.`, "/chats/projects/work");
  }
  return { launch: fresh, clickup: !!fresh.clickupListId, error };
}

export async function dropLaunch(orgId: number, launchId: number) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch) throw new TRPCError({ code: "NOT_FOUND", message: "That launch is not in this workspace." });
  return db.updateLaunch(launch.id, orgId, { status: "dropped" });
}

// ==========================================
// ClickUp
// ==========================================

function clickupMeta(l: Launch) {
  try {
    return JSON.parse(l.clickup || "{}") as { doneStatus?: string; openStatus?: string; syncedAt?: number };
  } catch {
    return {};
  }
}

function describe(t: LaunchTask, milestone: string | undefined) {
  return [t.details, milestone ? `Milestone: ${milestone}` : "", `Owner: ${t.ownerName}${t.ownerType === "employee" ? " (LeadDash Employees)" : ""}`, t.waitingOn ? `Waiting on: ${t.waitingOn}` : ""].filter(Boolean).join("\n");
}

async function assigneesFor(orgId: number, t: LaunchTask, members: { id: number; email: string }[], ownerId: number | null) {
  const ops = (await opsFor(orgId)).ops;
  if (t.ownerType === "person") {
    const m = t.ownerEmail ? members.find((x) => x.email === t.ownerEmail!.toLowerCase()) : null;
    return m ? [m.id] : ownerId ? [ownerId] : [];
  }
  return ops.taskOwners === "employees" && ownerId ? [ownerId] : [];
}

async function createClickupTask(orgId: number, launch: Launch, t: LaunchTask, milestone: string | undefined, members: { id: number; email: string }[], ownerId: number | null) {
  const data = await integrations.clickup(orgId, `/list/${launch.clickupListId}/task`, {
    method: "POST",
    body: { name: t.title, description: describe(t, milestone), due_date: new Date(t.dueDate).getTime(), due_date_time: false, assignees: await assigneesFor(orgId, t, members, ownerId), tags: t.ownerType === "employee" ? [t.ownerName.toLowerCase()] : [] },
  });
  await db.updateLaunchTask(t.id, orgId, { clickupTaskId: String(data.id), clickupUrl: data.url ?? null, clickupStatus: data.status?.status ?? null });
}

/** Creates the launch's list in the chosen Space and adds every task. */
export async function pushToClickup(orgId: number, launchId: number) {
  const launch = await db.getLaunch(launchId, orgId);
  const cu = await integrations.clickupSettings(orgId);
  if (!launch || !cu) return null;
  if (!cu.spaceId) throw new Error("Choose a ClickUp Space on Nora's Onboarding tab");
  let listId = launch.clickupListId;
  if (!listId) {
    const list = await integrations.clickup(orgId, `/space/${cu.spaceId}/list`, { method: "POST", body: { name: launch.name.slice(0, 100), due_date: new Date(launch.launchDate).getTime(), due_date_time: false } });
    listId = String(list.id);
    const full = await integrations.clickup(orgId, `/list/${listId}`);
    const statuses: { status: string; type: string }[] = full.statuses ?? list.statuses ?? [];
    await db.updateLaunch(launch.id, orgId, {
      clickupListId: listId,
      clickupListUrl: `https://app.clickup.com/${cu.teamId}/v/li/${listId}`,
      clickup: JSON.stringify({ doneStatus: statuses.find((x) => x.type === "closed")?.status ?? "complete", openStatus: statuses.find((x) => x.type === "open")?.status ?? "to do", syncedAt: 0 }),
    });
  }
  const fresh = (await db.getLaunch(launch.id, orgId))!;
  const members = await integrations.clickupMembers(orgId).catch(() => []);
  const ownerId = cu.userId ? Number(cu.userId) : null;
  const ms = await db.listMilestones(launch.id, orgId);
  for (const t of await db.listLaunchTasks(launch.id, orgId)) {
    if (t.clickupTaskId) continue;
    await createClickupTask(orgId, fresh, t, ms.find((m) => m.id === t.milestoneId)?.name, members, ownerId);
  }
  return fresh;
}

/** Reads every task's status from ClickUp. Skips when it synced in the last 2 minutes unless forced. */
export async function syncClickup(orgId: number, launchId: number, force = false) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch?.clickupListId || !(await integrations.clickupSettings(orgId))) return false;
  const meta = clickupMeta(launch);
  if (!force && meta.syncedAt && Date.now() - meta.syncedAt < 120_000) return false;
  const tasks = await db.listLaunchTasks(launch.id, orgId);
  const byId = new Map(tasks.filter((t) => t.clickupTaskId).map((t) => [t.clickupTaskId!, t]));
  for (let page = 0; page < 5; page++) {
    const data = await integrations.clickup(orgId, `/list/${launch.clickupListId}/task?include_closed=true&subtasks=false&page=${page}`);
    for (const ct of data.tasks ?? []) {
      const t = byId.get(String(ct.id));
      if (!t) continue;
      const type = ct.status?.type;
      const status = type === "closed" || type === "done" ? "done" : String(ct.status?.status ?? "").toLowerCase() === (meta.openStatus ?? "to do").toLowerCase() ? "todo" : "in_progress";
      if (status !== t.status || ct.status?.status !== t.clickupStatus) {
        await db.updateLaunchTask(t.id, orgId, { status, clickupStatus: ct.status?.status ?? null, doneAt: status === "done" ? (t.doneAt ?? (ct.date_closed ? new Date(Number(ct.date_closed)) : new Date())) : null });
      }
    }
    if (data.last_page !== false) break;
  }
  await db.updateLaunch(launch.id, orgId, { clickup: JSON.stringify({ ...meta, syncedAt: Date.now() }) });
  return true;
}

export async function markTaskDone(orgId: number, taskId: number, done = true) {
  const t = await db.getLaunchTask(taskId, orgId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task is not in this workspace." });
  await db.updateLaunchTask(t.id, orgId, { status: done ? "done" : "todo", doneAt: done ? new Date() : null });
  const launch = await db.getLaunch(t.launchId, orgId);
  if (launch && t.clickupTaskId && (await integrations.clickupSettings(orgId))) {
    const meta = clickupMeta(launch);
    await integrations.clickup(orgId, `/task/${t.clickupTaskId}`, { method: "PUT", body: { status: done ? meta.doneStatus ?? "complete" : meta.openStatus ?? "to do" } }).catch(() => null);
  }
  return db.getLaunchTask(t.id, orgId);
}

export async function updateTask(orgId: number, taskId: number, input: { title?: string; details?: string; owner?: string; due?: string }) {
  const t = await db.getLaunchTask(taskId, orgId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task is not in this workspace." });
  const { tz } = await opsFor(orgId);
  const patch: Partial<LaunchTask> = {};
  if (input.title?.trim()) patch.title = input.title.trim().slice(0, 200);
  if (input.details !== undefined) patch.details = input.details.trim().slice(0, 2000) || null;
  if (input.due) {
    const m = input.due.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the due date as MM/DD/YYYY." });
    patch.dueDate = dayAt(`${m[3]}-${m[1]}-${m[2]}`, tz);
  }
  if (input.owner?.trim()) {
    const o = input.owner.trim();
    const emp = (await db.listEmployeesByOrg(orgId)).find((e) => e.name.toLowerCase() === o.toLowerCase());
    const member = (await db.listMembers(orgId)).find((x) => (x.name || x.email).toLowerCase() === o.toLowerCase());
    Object.assign(patch, emp ? { ownerType: "employee", ownerKind: emp.kind, ownerName: emp.name, ownerEmail: null } : { ownerType: "person", ownerKind: null, ownerName: member ? member.name || member.email : o.slice(0, 120), ownerEmail: member?.email ?? null });
  }
  const next = (await db.updateLaunchTask(t.id, orgId, patch))!;
  if (next.clickupTaskId && (await integrations.clickupSettings(orgId))) {
    const ms = await db.listMilestones(next.launchId, orgId);
    await integrations.clickup(orgId, `/task/${next.clickupTaskId}`, { method: "PUT", body: { name: next.title, description: describe(next, ms.find((m) => m.id === next.milestoneId)?.name), due_date: new Date(next.dueDate).getTime(), due_date_time: false } }).catch(() => null);
  }
  return next;
}

/** Moves launch day and every milestone and open task by the same number of days. */
export async function moveLaunch(orgId: number, launchId: number, newDate: string) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch) throw new TRPCError({ code: "NOT_FOUND", message: "That launch is not in this workspace." });
  const { tz } = await opsFor(orgId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw new TRPCError({ code: "BAD_REQUEST", message: "Tell me the new launch date." });
  const to = dayAt(newDate, tz, 9);
  const shift = Math.round((to.getTime() - new Date(launch.launchDate).getTime()) / DAY) * DAY;
  await db.updateLaunch(launch.id, orgId, { launchDate: to });
  for (const m of await db.listMilestones(launch.id, orgId)) await db.updateMilestone(m.id, orgId, { dueDate: new Date(new Date(m.dueDate).getTime() + shift) });
  for (const k of await db.listKpis(launch.id, orgId)) await db.updateKpi(k.id, orgId, { byDate: new Date(new Date(k.byDate).getTime() + shift) });
  let moved = 0;
  const cu = !!launch.clickupListId && !!(await integrations.clickupSettings(orgId));
  for (const t of await db.listLaunchTasks(launch.id, orgId)) {
    if (t.status === "done") continue;
    const due = new Date(new Date(t.dueDate).getTime() + shift);
    await db.updateLaunchTask(t.id, orgId, { dueDate: due });
    if (cu && t.clickupTaskId) await integrations.clickup(orgId, `/task/${t.clickupTaskId}`, { method: "PUT", body: { due_date: due.getTime(), due_date_time: false } }).catch(() => null);
    moved++;
  }
  if (cu) await integrations.clickup(orgId, `/list/${launch.clickupListId}`, { method: "PUT", body: { due_date: to.getTime(), due_date_time: false } }).catch(() => null);
  return { launch: (await db.getLaunch(launch.id, orgId))!, moved, days: Math.round(shift / DAY) };
}

// ==========================================
// KPIs
// ==========================================

export async function saveKpi(orgId: number, input: { id?: number; launchId: number; name: string; target: number; by: string; source: KpiSource; manualValue?: number | null }) {
  const launch = await db.getLaunch(input.launchId, orgId);
  if (!launch) throw new TRPCError({ code: "NOT_FOUND", message: "That launch is not in this workspace." });
  const { tz } = await opsFor(orgId);
  const m = input.by.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the date as MM/DD/YYYY." });
  const row = { name: input.name.trim().slice(0, 120) || "KPI", target: Math.max(0, Math.round(input.target)), byDate: dayAt(`${m[3]}-${m[1]}-${m[2]}`, tz), source: input.source, unit: (input.source === "reply_rate" || input.source === "tasks_on_time" ? "percent" : "count") as "percent" | "count", manualValue: input.source === "manual" ? input.manualValue ?? null : null };
  if (input.id) {
    const k = await db.getKpi(input.id, orgId);
    if (!k || k.launchId !== launch.id) throw new TRPCError({ code: "NOT_FOUND", message: "That KPI is not in this launch." });
    return db.updateKpi(k.id, orgId, row);
  }
  return db.createKpi({ organizationId: orgId, launchId: launch.id, position: (await db.listKpis(launch.id, orgId)).length, ...row });
}

// ==========================================
// The Launches tab
// ==========================================

export async function launchView(orgId: number, launchId: number) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch) throw new TRPCError({ code: "NOT_FOUND", message: "That launch is not in this workspace." });
  await syncClickup(orgId, launch.id).catch(() => false);
  const now = new Date();
  const ms = await db.listMilestones(launch.id, orgId);
  const tasks = await db.listLaunchTasks(launch.id, orgId);
  const start = new Date(launch.approvedAt ?? launch.createdAt);
  const kpis = [];
  for (const k of await db.listKpis(launch.id, orgId)) {
    const value = await kpiValue(orgId, launch, k);
    kpis.push({ ...k, value, pace: pace(k, value, start, now), counted: KPI_LABELS[k.source], who: KPI_WHO[k.source] });
  }
  return {
    launch,
    milestones: ms.map((m) => {
      const mine = tasks.filter((t) => t.milestoneId === m.id);
      return { ...m, total: mine.length, done: mine.filter((t) => t.status === "done").length, behind: mine.filter((t) => taskState(t, now).key === "behind").length };
    }),
    tasks: tasks.map((t) => ({ ...t, state: taskState(t, now) })),
    kpis,
    reports: (await db.listLaunchReports(launch.id, orgId)).map((r) => ({ ...r, body: JSON.parse(r.body) as ReportBody })),
    kpiSources: KPI_SOURCES.map((s) => ({ key: s, label: KPI_LABELS[s] })),
  };
}

// ==========================================
// Morning check and the weekly report
// ==========================================

export type ReportBody = { overall: string; done: string; behind: string; next: string; needsYou: string };

async function launchFacts(orgId: number, launch: Launch) {
  const { tz } = await opsFor(orgId);
  const view = await launchView(orgId, launch.id);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const inWeek = new Date(now.getTime() + 7 * DAY);
  const t = view.tasks;
  return [
    `Launch: ${launch.name}, launch day ${fmt(launch.launchDate, tz)}. ${t.filter((x) => x.status === "done").length} of ${t.length} tasks done.`,
    `Milestones: ${view.milestones.map((m) => `${m.name} (${fmt(m.dueDate, tz)}): ${m.done} of ${m.total} done${m.behind ? `, ${m.behind} behind` : ""}`).join("; ")}`,
    `Done in the last 7 days: ${t.filter((x) => x.doneAt && new Date(x.doneAt) > weekAgo).map((x) => `${x.title} (${x.ownerName})`).join("; ") || "nothing"}`,
    `Behind: ${t.filter((x) => x.state.key === "behind").map((x) => `${x.title} (${x.ownerName}, due ${fmt(x.dueDate, tz)}${x.waitingOn ? `, waiting on ${x.waitingOn}` : ""})`).join("; ") || "nothing"}`,
    `Due in the next 7 days: ${t.filter((x) => x.status !== "done" && new Date(x.dueDate) <= inWeek && new Date(x.dueDate) >= now).map((x) => `${x.title} (${x.ownerName}, ${fmt(x.dueDate, tz)})`).join("; ") || "nothing"}`,
    `KPIs: ${view.kpis.map((k) => `${k.name}: ${k.value}${k.unit === "percent" ? "%" : ""} of ${k.target}${k.unit === "percent" ? "%" : ""} (${k.pace === "on_pace" ? "on pace" : "behind"})`).join("; ") || "none"}`,
  ].join("\n");
}

export async function weeklyReport(orgId: number, launchId: number) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch || launch.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an active launch gets a status report." });
  const nora = await employeeFor(orgId, "projects");
  const facts = await launchFacts(orgId, launch);
  const view = await launchView(orgId, launch.id);
  const behind = view.tasks.some((t) => t.state.key === "behind") || view.kpis.some((k) => k.pace === "behind");
  const start = new Date(launch.approvedAt ?? launch.createdAt).getTime();
  const weeks = Math.max(1, Math.ceil((new Date(launch.launchDate).getTime() - start) / (7 * DAY)));
  const week = Math.min(weeks, Math.max(1, Math.ceil((Date.now() - start) / (7 * DAY))));
  const body = await working(nora, async () => {
    const { system } = await systemPromptFor(nora, `Write the weekly launch status report from the facts only. Each field is 1 to 3 plain sentences with dates and numbers from the facts. overall: on track or behind, and whether launch day still holds and what it depends on. done: what finished. behind: what is late, why if the facts say, and what is being done. next: what is due next week. needsYou: only decisions or approvals the owner must make, or "Nothing this week.".`);
    return generateJson<ReportBody>({ system, prompt: facts, schemaName: "launch_report", schema: obj({ overall: str, done: str, behind: str, next: str, needsYou: str }), maxTokens: 1200 });
  });
  const report = await db.createLaunchReport({ organizationId: orgId, launchId: launch.id, week, weeks, status: behind ? "behind" : "on_track", body: JSON.stringify(body) });
  await db.createChatMessage({ organizationId: orgId, employeeId: nora.id, role: "employee", authorName: nora.name, content: `Week ${week} of ${weeks} on ${launch.name}: ${behind ? "behind" : "on track"}. ${body.overall} ${body.needsYou && !/^nothing/i.test(body.needsYou) ? `Needs you: ${body.needsYou}` : ""}`.trim() });
  await logActivity(nora, "done", `Sent the week ${week} status report for ${launch.name}: ${behind ? "behind" : "on track"}.`, "/chats/projects/work");
  return report;
}

/** Every morning at the check time: sync ClickUp, flag what is behind, remind owners. On the report day, the report. */
export async function morningCheck(orgId: number, opts: { force?: boolean } = {}) {
  const nora = await db.getEmployeeByKind(orgId, "projects");
  if (!nora || nora.status === "paused") return null;
  const { ops, tz } = await opsFor(orgId);
  const now = new Date();
  const today = ymdIn(now, tz);
  const p = partsIn(now, tz);
  const [ch, cm] = ops.checkTime.split(":").map(Number);
  if (!opts.force && (ops.lastCheck === today || p.h * 60 + p.mi < ch * 60 + cm)) return null;
  await saveOps(orgId, { lastCheck: today });
  const lines: string[] = [];
  for (const launch of (await db.listLaunches(orgId)).filter((l) => l.status === "active")) {
    if (new Date(launch.launchDate).getTime() < now.getTime() - 2 * DAY) {
      await db.updateLaunch(launch.id, orgId, { status: "done" });
      continue;
    }
    await syncClickup(orgId, launch.id, true).catch(() => false);
    const tasks = await db.listLaunchTasks(launch.id, orgId);
    const behind = tasks.filter((t) => taskState(t, now).key === "behind");
    const cu = !!launch.clickupListId && !!(await integrations.clickupSettings(orgId));
    for (const t of behind) {
      const days = Math.round((new Date(t.dueDate).getTime() - now.getTime()) / DAY);
      const when = days < 0 ? `${-days} day${days === -1 ? "" : "s"} late` : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`;
      let note = `${when[0].toUpperCase()}${when.slice(1)} and ${t.status === "todo" ? "not started" : "not done"}.`;
      const remindedToday = t.remindedAt && ymdIn(new Date(t.remindedAt), tz) === today;
      if (!remindedToday && gate(nora, "remind") === "auto") {
        if (cu && t.clickupTaskId) {
          await integrations.clickup(orgId, `/task/${t.clickupTaskId}/comment`, { method: "POST", body: { comment_text: `Reminder from ${nora.name}: "${t.title}" is ${when}.`, notify_all: true } }).catch(() => null);
          note += ` I reminded ${t.ownerName} in ClickUp this morning.`;
        } else if (t.ownerType === "employee" && t.ownerKind) {
          await handoff(orgId, "projects", t.ownerKind as AIEmployee["kind"], `Reminder: "${t.title}" for the ${launch.name} launch is ${when}.`, "/chats/projects/work");
          note += ` I reminded ${t.ownerName} this morning.`;
        }
        await db.updateLaunchTask(t.id, orgId, { remindedAt: now, note });
      } else await db.updateLaunchTask(t.id, orgId, { note });
    }
    if (behind.length) lines.push(`${launch.name}: ${behind.length} task${behind.length === 1 ? "" : "s"} behind (${behind.slice(0, 3).map((t) => `${t.title}, ${t.ownerName}`).join("; ")}${behind.length > 3 ? "; and more" : ""}).`);
    if (p.wd === ops.reportDay && ops.lastReport !== today) {
      await weeklyReport(orgId, launch.id).catch((err) => console.warn("[projects] report failed:", err instanceof Error ? err.message : err));
    }
  }
  if (p.wd === ops.reportDay) await saveOps(orgId, { lastReport: today });
  if (lines.length) await db.createChatMessage({ organizationId: orgId, employeeId: nora.id, role: "employee", authorName: nora.name, content: `Morning check: ${lines.join(" ")} The Tasks tab shows each one.` });
  return lines;
}

export async function morningChecks() {
  for (const orgId of await db.listAllOrganizationIds()) {
    await withUsage({ orgId, kind: "projects" }, () => morningCheck(orgId)).catch((err) => console.warn("[projects] morning check failed:", err instanceof Error ? err.message : err));
  }
}

// ==========================================
// From Simone: action items become tasks
// ==========================================

export async function addActionItems(orgId: number, items: { text: string; owner: string; due?: Date }[], source: string) {
  const launch = (await db.listLaunches(orgId)).filter((l) => l.status === "active").sort((a, b) => new Date(a.launchDate).getTime() - new Date(b.launchDate).getTime())[0];
  if (!launch) return { launch: null, tasks: [] as LaunchTask[] };
  const emps = await db.listEmployeesByOrg(orgId);
  const members = await db.listMembers(orgId);
  const out: LaunchTask[] = [];
  for (const it of items) {
    const o = it.owner.trim().toLowerCase();
    const emp = emps.find((e) => e.name.toLowerCase() === o || e.kind === o);
    const member = members.find((m) => (m.name || "").toLowerCase().split(" ")[0] === o.split(" ")[0] || m.email.toLowerCase() === o);
    out.push(
      await db.createLaunchTask({
        organizationId: orgId,
        launchId: launch.id,
        milestoneId: null,
        title: it.text.slice(0, 200),
        ownerType: emp ? "employee" : "person",
        ownerKind: emp?.kind ?? null,
        ownerName: emp ? emp.name : member ? member.name || member.email : it.owner.slice(0, 120) || "You",
        ownerEmail: emp ? null : member?.email ?? null,
        dueDate: it.due ?? new Date(Date.now() + 7 * DAY),
        source,
      })
    );
  }
  if (launch.clickupListId && (await integrations.clickupSettings(orgId))) await pushToClickup(orgId, launch.id).catch(() => null);
  return { launch, tasks: out };
}

// ==========================================
// Chat and facts
// ==========================================

export function planCard(l: Launch, counts: { milestones: number; tasks: number; owners: number }) {
  return { type: "launch_plan" as const, id: l.id, title: l.name, subtitle: `${counts.milestones} milestones · ${counts.tasks} tasks · ${counts.owners} owners`, status: l.status };
}

export async function planCounts(orgId: number, launchId: number) {
  const ms = await db.listMilestones(launchId, orgId);
  const tasks = await db.listLaunchTasks(launchId, orgId);
  return { milestones: ms.length, tasks: tasks.length, owners: new Set(tasks.map((t) => t.ownerName)).size };
}

export async function projectsStatus(orgId: number) {
  const active = (await db.listLaunches(orgId)).filter((l) => l.status === "active" || l.status === "planning");
  if (!active.length) return "There's no launch planned yet. Tell me what you're launching and the date.";
  const parts = [];
  for (const l of active) parts.push(await launchFacts(orgId, l));
  return parts.join("\n\n");
}

export async function findLaunch(orgId: number, target: string) {
  const all = (await db.listLaunches(orgId)).filter((l) => l.status === "active" || l.status === "planning");
  const t = target.trim().toLowerCase();
  return (t && all.find((l) => l.name.toLowerCase().includes(t) || t.includes(l.name.toLowerCase()))) || all.sort((a, b) => new Date(a.launchDate).getTime() - new Date(b.launchDate).getTime())[0] || null;
}
