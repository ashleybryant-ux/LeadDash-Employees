import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { withUsage } from "../usage";
import type { AIEmployee, Launch, LaunchKpi, LaunchTask, KpiSource, ProjectNoteKind } from "../../drizzle/schema";
import { KPI_SOURCES } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import { partsIn, zonedToUtc } from "./schedule";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { gate, handoff, logActivity } from "./team";
import { opsFor, saveOps } from "./ops";

/**
 * Nora (Projects), the project manager.
 * - Plans a launch back from its date: milestones, tasks with one owner and a
 *   definition of done each, and KPIs.
 * - Once the plan is approved, creates a ClickUp list for it with every task.
 * - Starts each employee on their ready task (one at a time per employee), then
 *   checks the result against the definition of done. Work waiting for the
 *   owner's approval is not done until they approve it.
 * - Every morning: reads ClickUp, marks what is done, flags what is behind and
 *   reminds owners. On the report day: the weekly status report, rated green,
 *   amber or red.
 * - Keeps a running list: ideas, and each project's risks, blockers and decisions.
 * - Runs project meetings (agenda before, recap and action items after; see coo.ts).
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

/** What the Tasks list shows: work waiting on the owner says so instead of "On track". */
export function shownState(t: Pick<LaunchTask, "status" | "dueDate" | "work">, now = new Date()): { key: string; label: string } {
  if (t.status !== "done") {
    const w = readWork(t);
    if (w?.state === "waiting") return { key: "waiting", label: "Waiting for you" };
    if (w?.state === "needs_person") return { key: "waiting", label: "Needs a person" };
  }
  return taskState(t, now);
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
  tasks: { title: string; details: string; doneWhen: string; milestone: number; owner: string; date: string; waitingOn: string }[];
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
- doneWhen: what will exist when the task is finished, in a few plain words ("Article approved and published", "Pricing decided and written in the Brain"). Never "work on" something.
- details: what to make and for whom, enough for the owner to do it without asking.
- waitingOn: the exact title of the task that must finish first, or "".
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
        tasks: arr(obj({ title: str, details: str, doneWhen: str, milestone: int, owner: str, date: str, waitingOn: str })),
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
      doneWhen: t.doneWhen?.slice(0, 300) || null,
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
  // Employees whose first task is ready start on it now, not tomorrow morning.
  await startReadyTasks(orgId).catch((err) => console.warn("[projects] start failed:", err instanceof Error ? err.message : err));
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
  return [t.details, t.doneWhen ? `Done when: ${t.doneWhen}` : "", milestone ? `Milestone: ${milestone}` : "", `Owner: ${t.ownerName}${t.ownerType === "employee" ? " (LeadDash Employees)" : ""}`, t.waitingOn ? `Waiting on: ${t.waitingOn}` : ""].filter(Boolean).join("\n");
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

export async function updateTask(orgId: number, taskId: number, input: { title?: string; details?: string; doneWhen?: string; owner?: string; due?: string }) {
  const t = await db.getLaunchTask(taskId, orgId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task is not in this workspace." });
  const { tz } = await opsFor(orgId);
  const patch: Partial<LaunchTask> = {};
  if (input.title?.trim()) patch.title = input.title.trim().slice(0, 200);
  if (input.details !== undefined) patch.details = input.details.trim().slice(0, 2000) || null;
  if (input.doneWhen !== undefined) patch.doneWhen = input.doneWhen.trim().slice(0, 300) || null;
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
// Getting the work done: employees do their tasks, Nora checks them
// ==========================================

/** Where an employee's output lives, so Nora can tell when it is approved or finished. */
export type WorkRef = { kind: "outbound" | "page" | "application"; id: number };
export type WorkState = "running" | "in_progress" | "waiting" | "done" | "sent_back" | "needs_person" | "failed";
export type TaskWork = { state: WorkState; startedAt: number; action?: string; summary?: string; review?: string; refs?: WorkRef[]; tries?: number };

/** An employee starts a task this many days before it is due. */
export const START_WINDOW_DAYS = 10;
const MAX_TRIES = 2;

export function readWork(t: Pick<LaunchTask, "work">): TaskWork | null {
  if (!t.work) return null;
  try {
    const w = JSON.parse(t.work) as TaskWork;
    return w && typeof w.state === "string" ? w : null;
  } catch {
    return null;
  }
}

/** True when the task this one waits on is done (or can't be found by its title). */
export function waitingDone(t: Pick<LaunchTask, "waitingOn">, siblings: Pick<LaunchTask, "title" | "status">[]) {
  const w = (t.waitingOn ?? "").trim().toLowerCase();
  if (!w) return true;
  const dep = siblings.find((x) => x.title.trim().toLowerCase() === w) ?? siblings.find((x) => x.title.toLowerCase().includes(w) || w.includes(x.title.toLowerCase()));
  return !dep || dep.status === "done";
}

/**
 * Which employee tasks start now: owned by an active employee, not done, not
 * started (or sent back with tries left), due within the start window, and not
 * waiting on an unfinished task. One task at a time per employee, earliest due first.
 */
export function pickReady(tasks: LaunchTask[], activeKinds: Set<string>, now = Date.now()) {
  const busy = new Set<string>();
  for (const t of tasks) {
    const w = readWork(t);
    if (t.ownerKind && t.status !== "done" && w && (w.state === "running" || w.state === "in_progress")) busy.add(t.ownerKind);
  }
  const ready: LaunchTask[] = [];
  const open = tasks
    .filter((t) => t.ownerType === "employee" && t.ownerKind && activeKinds.has(t.ownerKind) && t.status !== "done")
    .filter((t) => {
      const w = readWork(t);
      return !w || (w.state === "sent_back" && (w.tries ?? 0) < MAX_TRIES) || (w.state === "failed" && (w.tries ?? 0) < MAX_TRIES);
    })
    .filter((t) => new Date(t.dueDate).getTime() - now <= START_WINDOW_DAYS * DAY)
    .filter((t) => waitingDone(t, tasks.filter((x) => x.launchId === t.launchId && x.id !== t.id)))
    .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  for (const t of open) {
    if (busy.has(t.ownerKind!)) continue;
    busy.add(t.ownerKind!);
    ready.push(t);
  }
  return ready;
}

/** Starts every employee whose next task is ready. Runs the work in the background unless `wait` is set. */
export async function startReadyTasks(orgId: number, opts: { wait?: boolean } = {}) {
  const nora = await db.getEmployeeByKind(orgId, "projects");
  if (!nora || nora.status === "paused" || gate(nora, "assign_work") !== "auto") return [] as LaunchTask[];
  const active = (await db.listLaunches(orgId)).filter((l) => l.status === "active");
  if (!active.length) return [] as LaunchTask[];
  const kinds = new Set((await db.listEmployeesByOrg(orgId)).filter((e) => e.status !== "paused" && e.kind !== "projects").map((e) => e.kind as string));
  const all: LaunchTask[] = [];
  for (const l of active) all.push(...(await db.listLaunchTasks(l.id, orgId)));
  const ready = pickReady(all, kinds);
  // Claim them first so a second call never starts the same task twice.
  for (const t of ready) {
    const w = readWork(t);
    await db.updateLaunchTask(t.id, orgId, { status: "in_progress", work: JSON.stringify({ ...(w ?? {}), state: "running", startedAt: Date.now(), tries: w?.tries ?? 0 }), note: `${t.ownerName} is working on it.` });
  }
  const run = () => Promise.all(ready.map((t) => executeTask(orgId, t.id).catch((err) => console.warn("[projects] task failed:", err instanceof Error ? err.message : err))));
  if (opts.wait) await run();
  else void run();
  return ready;
}

/** Starts one task now, by name, when the owner asks ("have Theo start the launch article"). */
export async function startTaskByName(orgId: number, target: string) {
  const t0 = target.trim().toLowerCase();
  const all = (await db.listOrgLaunchTasks(orgId)).filter((t) => t.status !== "done" && t.ownerType === "employee");
  const t = (t0 && (all.find((x) => x.title.toLowerCase() === t0) ?? all.find((x) => x.title.toLowerCase().includes(t0) || t0.includes(x.title.toLowerCase())))) || null;
  if (!t) return { task: null, started: false, why: "I couldn't find an open employee task by that name." };
  const w = readWork(t);
  if (w && (w.state === "running" || w.state === "in_progress")) return { task: t, started: false, why: `${t.ownerName} is already working on it.` };
  await db.updateLaunchTask(t.id, orgId, { status: "in_progress", work: JSON.stringify({ state: "running", startedAt: Date.now(), tries: 0 }), note: `${t.ownerName} is working on it.` });
  void executeTask(orgId, t.id).catch((err) => console.warn("[projects] task failed:", err instanceof Error ? err.message : err));
  return { task: t, started: true, why: "" };
}

async function saveWork(orgId: number, t: LaunchTask, w: TaskWork, patch: Partial<LaunchTask> = {}) {
  return db.updateLaunchTask(t.id, orgId, { work: JSON.stringify(w), ...patch });
}

const WHERE: Record<WorkRef["kind"], string> = { outbound: "Approvals", page: "the Pages tab", application: "Applications" };

/** Where the employee's output stands: still being made, waiting for the owner, finished, or rejected. */
export async function refState(orgId: number, refs: WorkRef[]): Promise<{ state: "in_progress" | "waiting" | "done" | "sent_back"; where: string; text: string }> {
  const states: string[] = [];
  const texts: string[] = [];
  let where = "";
  for (const r of refs) {
    if (r.kind === "outbound") {
      const o = await db.getOutboundItemForOrg(r.id, orgId);
      if (!o) continue;
      states.push(o.status === "published" ? "done" : o.status === "cancelled" || o.status === "changes_requested" ? "sent_back" : o.status === "drafting" ? "in_progress" : "waiting");
      texts.push(`${o.title}\n${(o.body ?? "").slice(0, 3000)}`);
    } else if (r.kind === "page") {
      const p = db.getSitePage(r.id, orgId);
      if (!p) continue;
      states.push(p.status === "approved" ? "done" : p.status === "building" ? "in_progress" : p.status === "failed" ? "sent_back" : "waiting");
      texts.push(`Page: ${p.title}. Goal: ${p.goal}.`);
    } else {
      const a = await db.getApplication(r.id, orgId);
      if (!a) continue;
      states.push(["approved", "submitted", "awarded", "declined"].includes(a.status) ? "done" : a.status === "writing" ? "in_progress" : a.status === "error" ? "sent_back" : "waiting");
      texts.push(`Application: ${a.title} (${a.status}).`);
    }
    if (!where && states[states.length - 1] === "waiting") where = WHERE[r.kind];
  }
  const state = states.includes("sent_back") ? "sent_back" : states.includes("in_progress") ? "in_progress" : states.includes("waiting") ? "waiting" : "done";
  return { state, where, text: texts.join("\n\n") };
}

/** Nora checks the work against the task's definition of done. */
async function review(nora: AIEmployee, t: LaunchTask, ownerName: string, output: string) {
  return working(nora, async () => {
    const { system } = await systemPromptFor(nora, `Check ${ownerName}'s work on a task against its definition of done. meets: true when the work matches what the task asked for (approval by the owner comes later and does not count against it). missing: when it does not meet it, exactly what is missing or wrong in one or two sentences ${ownerName} can act on; otherwise "".`);
    return generateJson<{ meets: boolean; missing: string }>({
      system,
      prompt: `Task: ${t.title}\nDetails: ${t.details ?? "none"}\nDone when: ${t.doneWhen ?? "the task is finished"}\n\n${ownerName}'s work:\n${output.slice(0, 8000) || "(nothing)"}`,
      schemaName: "task_review",
      schema: obj({ meets: { type: "boolean" }, missing: str }),
      maxTokens: 500,
    });
  });
}

/** The employee does the task with their own tools; Nora checks it and sends it back once if it misses. */
export async function executeTask(orgId: number, taskId: number, feedback = ""): Promise<LaunchTask | null> {
  let t = await db.getLaunchTask(taskId, orgId);
  if (!t || t.status === "done" || !t.ownerKind) return null;
  const launch = await db.getLaunch(t.launchId, orgId);
  const nora = await db.getEmployeeByKind(orgId, "projects");
  const emp = await db.getEmployeeByKind(orgId, t.ownerKind as AIEmployee["kind"]);
  if (!launch || !nora) return null;
  const { tz } = await opsFor(orgId);
  const prev = readWork(t);
  const tries = (prev?.tries ?? 0) + 1;
  if (!emp || emp.status === "paused") {
    return saveWork(orgId, t, { state: "needs_person", startedAt: Date.now(), tries }, { status: "todo", note: `${t.ownerName} is ${emp ? "paused" : "not in this workspace"}, so a person needs to do this or reassign it.` });
  }
  const sentBack = feedback || (prev?.state === "sent_back" ? prev.review ?? "" : "");
  await handoff(
    orgId,
    "projects",
    emp.kind,
    `${sentBack ? "Sending this back" : "Task"} for the ${launch.name} launch: ${t.title}.${t.details ? ` ${t.details}` : ""}${t.doneWhen ? ` Done when: ${t.doneWhen}.` : ""} Due ${fmt(t.dueDate, tz)}.${sentBack ? ` What's missing: ${sentBack}` : ""}`,
    "/chats/projects/work"
  );
  const { doTask } = await import("./chat");
  let r: Awaited<ReturnType<typeof doTask>>;
  try {
    r = await doTask(emp, { title: t.title, details: t.details ?? "", doneWhen: t.doneWhen ?? "", project: launch.name, due: fmt(t.dueDate, tz), feedback: sentBack, from: nora.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return saveWork(orgId, t, { state: "failed", startedAt: Date.now(), tries, summary: msg }, { status: "todo", note: `${emp.name} couldn't do it: ${msg}${tries < MAX_TRIES ? " I'll have them try again tomorrow." : " A person needs to look at it."}` });
  }
  if (r.action === "none") {
    t = (await saveWork(orgId, t, { state: "needs_person", startedAt: Date.now(), tries, summary: r.text }, { status: "todo", note: `${emp.name} can't do this with their own tools. ${r.text}`.trim() }))!;
    await db.createChatMessage({ organizationId: orgId, employeeId: nora.id, role: "employee", authorName: nora.name, content: `"${t.title}" on ${launch.name} needs a person: ${emp.name} can't do it with their own tools. Tell me who should own it and I'll reassign it.` });
    return t;
  }
  const work: TaskWork = { state: "in_progress", startedAt: Date.now(), action: r.action, summary: r.text.slice(0, 1000), refs: r.refs, tries };
  return settle(orgId, t, emp, nora, work, `${r.text}\n\n${r.cards.map((c) => [c.title, c.subtitle, c.body].filter(Boolean).join("\n")).join("\n\n")}`);
}

/** Decides where a task stands once the employee has produced something. */
async function settle(orgId: number, t: LaunchTask, emp: AIEmployee, nora: AIEmployee, work: TaskWork, said: string): Promise<LaunchTask | null> {
  const refs = work.refs ?? [];
  const where = refs.length ? await refState(orgId, refs) : { state: "done" as const, where: "", text: "" };
  if (where.state === "in_progress") return saveWork(orgId, t, { ...work, state: "in_progress" }, { status: "in_progress", note: `${emp.name} is working on it.` });
  if (where.state === "sent_back") return sendBack(orgId, t, emp, work, "The owner sent it back or it did not finish.");
  const check = await review(nora, t, emp.name, [where.text, said].filter(Boolean).join("\n\n")).catch(() => ({ meets: true, missing: "" }));
  if (!check.meets && check.missing.trim()) return sendBack(orgId, t, emp, work, check.missing.trim());
  if (where.state === "waiting") {
    return saveWork(orgId, t, { ...work, state: "waiting", review: "" }, { status: "in_progress", note: `${emp.name} finished it and I checked it. It's waiting for your approval in ${where.where || "Approvals"}.` });
  }
  await saveWork(orgId, t, { ...work, state: "done", review: "" }, { note: `${emp.name} finished it and I checked it against the definition of done.` });
  await logActivity(nora, "done", `Checked and closed "${t.title}" (${emp.name}).`, "/chats/projects/work");
  return markTaskDone(orgId, t.id, true);
}

async function sendBack(orgId: number, t: LaunchTask, emp: AIEmployee, work: TaskWork, missing: string): Promise<LaunchTask | null> {
  const tries = work.tries ?? 1;
  if (tries >= MAX_TRIES) {
    const nora = await db.getEmployeeByKind(orgId, "projects");
    const out = await saveWork(orgId, t, { ...work, state: "needs_person", review: missing }, { status: "todo", note: `I sent this back to ${emp.name} and it still misses: ${missing} A person needs to look at it.` });
    if (nora) await db.createChatMessage({ organizationId: orgId, employeeId: nora.id, role: "employee", authorName: nora.name, content: `"${t.title}" still isn't done after ${emp.name}'s second try. What's missing: ${missing} Want me to reassign it?` });
    return out;
  }
  await saveWork(orgId, t, { ...work, state: "sent_back", review: missing }, { status: "in_progress", note: `I sent it back to ${emp.name}: ${missing}` });
  return executeTask(orgId, t.id, missing);
}

/**
 * Every couple of minutes: work that was still being made (a page building, an
 * application being written) gets checked once it's ready, and work waiting for
 * the owner closes the moment they approve it.
 */
export async function followUpWork(orgId: number) {
  const nora = await db.getEmployeeByKind(orgId, "projects");
  if (!nora || nora.status === "paused") return 0;
  let changed = 0;
  for (const t of await db.listOrgLaunchTasks(orgId)) {
    if (t.status === "done" || !t.ownerKind) continue;
    const w = readWork(t);
    if (!w || (w.state !== "in_progress" && w.state !== "waiting") || !w.refs?.length) continue;
    const r = await refState(orgId, w.refs);
    if (r.state === w.state) continue;
    const emp = await db.getEmployeeByKind(orgId, t.ownerKind as AIEmployee["kind"]);
    if (!emp) continue;
    changed++;
    if (w.state === "in_progress") {
      await settle(orgId, t, emp, nora, w, w.summary ?? "");
    } else if (r.state === "done") {
      await saveWork(orgId, t, { ...w, state: "done" }, { note: `You approved ${emp.name}'s work, so it's done.` });
      await markTaskDone(orgId, t.id, true);
    } else if (r.state === "sent_back") {
      await saveWork(orgId, t, { ...w, state: "sent_back", review: "You asked for changes." }, { status: "in_progress", note: `You asked for changes, so ${emp.name} has it again.` });
    }
  }
  return changed;
}

export async function followUps() {
  for (const orgId of await db.listAllOrganizationIds()) {
    await withUsage({ orgId, kind: "projects" }, () => followUpWork(orgId)).catch((err) => console.warn("[projects] follow-up failed:", err instanceof Error ? err.message : err));
  }
}

// ==========================================
// Ideas, risks, blockers and decisions
// ==========================================

export const NOTE_LABELS: Record<ProjectNoteKind, string> = { idea: "Idea", risk: "Risk", blocker: "Blocker", decision: "Decision" };

/** Captures one line. Ideas stand alone until the owner says to plan them; the rest belong to a project. */
export async function addNote(orgId: number, input: { kind: ProjectNoteKind; text: string; project?: string; who: string }) {
  const text = input.text.trim().slice(0, 500);
  if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "What should I write down?" });
  const launch = input.kind === "idea" ? null : await findLaunch(orgId, input.project ?? "");
  const note = db.createProjectNote({ organizationId: orgId, launchId: launch?.id ?? null, kind: input.kind, text, createdBy: input.who.slice(0, 120), status: input.kind === "decision" ? "closed" : "open", closedAt: input.kind === "decision" ? new Date() : null });
  return { note, launch };
}

/** Closes the open risk, blocker or idea that best matches the words given. */
export async function closeNote(orgId: number, words: string) {
  const w = words.trim().toLowerCase();
  const open = db.listProjectNotes(orgId).filter((n) => n.status === "open");
  const hit = (w && (open.find((n) => n.text.toLowerCase().includes(w)) ?? open.find((n) => w.split(/\s+/).filter((x) => x.length > 3).every((x) => n.text.toLowerCase().includes(x))))) || null;
  if (!hit) return null;
  return db.updateProjectNote(hit.id, orgId, { status: "closed", closedAt: new Date() });
}

function notesFacts(orgId: number, launchId: number | null) {
  const all = db.listProjectNotes(orgId).filter((n) => n.launchId === launchId);
  const open = all.filter((n) => n.status === "open" && n.kind !== "decision");
  const decisions = all.filter((n) => n.kind === "decision").slice(0, 8);
  return { open, decisions };
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
    tasks: tasks.map((t) => ({ ...t, state: taskState(t, now), shown: shownState(t, now) })),
    kpis,
    reports: (await db.listLaunchReports(launch.id, orgId)).map((r) => ({ ...r, body: JSON.parse(r.body) as ReportBody })),
    kpiSources: KPI_SOURCES.map((s) => ({ key: s, label: KPI_LABELS[s] })),
  };
}

// ==========================================
// Morning check and the weekly report
// ==========================================

export type Rating = "green" | "amber" | "red";
export type ReportBody = { overall: string; done: string; behind: string; next: string; needsYou: string; rating?: Rating; risks?: string };
export const RATING_LABELS: Record<Rating, string> = { green: "On track", amber: "At risk", red: "Off track" };

function workLine(t: LaunchTask) {
  const w = readWork(t);
  if (!w) return "";
  return { running: "being worked on now", in_progress: "being worked on now", waiting: "finished, waiting for the owner's approval", done: "", sent_back: "sent back for changes", needs_person: "needs a person", failed: "the employee hit an error" }[w.state] ?? "";
}

async function launchFacts(orgId: number, launch: Launch) {
  const { tz } = await opsFor(orgId);
  const view = await launchView(orgId, launch.id);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const inWeek = new Date(now.getTime() + 7 * DAY);
  const t = view.tasks;
  const notes = notesFacts(orgId, launch.id);
  return [
    `Launch: ${launch.name}, launch day ${fmt(launch.launchDate, tz)}. ${t.filter((x) => x.status === "done").length} of ${t.length} tasks done.`,
    `Milestones: ${view.milestones.map((m) => `${m.name} (${fmt(m.dueDate, tz)}): ${m.done} of ${m.total} done${m.behind ? `, ${m.behind} behind` : ""}`).join("; ")}`,
    `Done in the last 7 days: ${t.filter((x) => x.doneAt && new Date(x.doneAt) > weekAgo).map((x) => `${x.title} (${x.ownerName})`).join("; ") || "nothing"}`,
    `Behind: ${t.filter((x) => x.state.key === "behind").map((x) => `${x.title} (${x.ownerName}, due ${fmt(x.dueDate, tz)}${x.waitingOn ? `, waiting on ${x.waitingOn}` : ""})`).join("; ") || "nothing"}`,
    `Due in the next 7 days: ${t.filter((x) => x.status !== "done" && new Date(x.dueDate) <= inWeek && new Date(x.dueDate) >= now).map((x) => `${x.title} (${x.ownerName}, ${fmt(x.dueDate, tz)})`).join("; ") || "nothing"}`,
    `KPIs: ${view.kpis.map((k) => `${k.name}: ${k.value}${k.unit === "percent" ? "%" : ""} of ${k.target}${k.unit === "percent" ? "%" : ""} (${k.pace === "on_pace" ? "on pace" : "behind"})`).join("; ") || "none"}`,
    `Employee work: ${t.filter((x) => x.status !== "done" && workLine(x)).map((x) => `${x.title} (${x.ownerName}): ${workLine(x)}`).join("; ") || "nothing in progress"}`,
    `Open risks and blockers: ${notes.open.map((n) => `${NOTE_LABELS[n.kind]}: ${n.text}`).join("; ") || "none"}`,
    `Decisions made: ${notes.decisions.map((n) => `${n.text} (${fmt(n.createdAt, tz)})`).join("; ") || "none recorded"}`,
  ].join("\n");
}

export async function weeklyReport(orgId: number, launchId: number) {
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch || launch.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an active launch gets a status report." });
  const nora = await employeeFor(orgId, "projects");
  const facts = await launchFacts(orgId, launch);
  const view = await launchView(orgId, launch.id);
  const late = view.tasks.some((t) => t.state.key === "behind") || view.kpis.some((k) => k.pace === "behind");
  const start = new Date(launch.approvedAt ?? launch.createdAt).getTime();
  const weeks = Math.max(1, Math.ceil((new Date(launch.launchDate).getTime() - start) / (7 * DAY)));
  const week = Math.min(weeks, Math.max(1, Math.ceil((Date.now() - start) / (7 * DAY))));
  const body = await working(nora, async () => {
    const { system } = await systemPromptFor(nora, `Write the weekly launch status report from the facts only. Each field is 1 to 3 plain sentences with dates and numbers from the facts.
- rating: green when work is on schedule and launch day holds; amber when something is late or blocked but launch day can still hold with action this week; red when launch day or a key result will be missed without a decision from the owner. ${late ? "Something is late, so it is amber or red." : ""} Never soften a red to amber.
- overall: the rating in words and whether launch day still holds and what it depends on.
- done: what finished. behind: what is late, why if the facts say, and what is being done about it. next: what is due next week.
- risks: open risks and blockers and what is being done, or "None open.".
- needsYou: only decisions or approvals the owner must make (including work waiting for their approval), or "Nothing this week.".`);
    return generateJson<ReportBody>({ system, prompt: facts, schemaName: "launch_report", schema: obj({ rating: { type: "string", enum: ["green", "amber", "red"] }, overall: str, done: str, behind: str, next: str, risks: str, needsYou: str }), maxTokens: 1400 });
  });
  const rating: Rating = body.rating === "red" || body.rating === "amber" || body.rating === "green" ? (late && body.rating === "green" ? "amber" : body.rating) : late ? "amber" : "green";
  body.rating = rating;
  const report = await db.createLaunchReport({ organizationId: orgId, launchId: launch.id, week, weeks, status: rating === "green" ? "on_track" : "behind", body: JSON.stringify(body) });
  await db.createChatMessage({ organizationId: orgId, employeeId: nora.id, role: "employee", authorName: nora.name, content: `Week ${week} of ${weeks} on ${launch.name}: ${RATING_LABELS[rating].toLowerCase()} (${rating}). ${body.overall} ${body.needsYou && !/^nothing/i.test(body.needsYou) ? `Needs you: ${body.needsYou}` : ""}`.trim() });
  await logActivity(nora, "done", `Sent the week ${week} status report for ${launch.name}: ${RATING_LABELS[rating].toLowerCase()}.`, "/chats/projects/work");
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
    const waiting = tasks.filter((t) => t.status !== "done" && readWork(t)?.state === "waiting");
    const needPerson = tasks.filter((t) => t.status !== "done" && readWork(t)?.state === "needs_person");
    for (const t of behind) {
      // An employee already on it, or work waiting for the owner, is not chased.
      const w = readWork(t);
      if (w && (w.state === "running" || w.state === "in_progress" || w.state === "waiting")) continue;
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
    if (waiting.length) lines.push(`Waiting for your approval: ${waiting.slice(0, 4).map((t) => t.title).join("; ")}${waiting.length > 4 ? "; and more" : ""}.`);
    if (needPerson.length) lines.push(`Needs a person: ${needPerson.slice(0, 3).map((t) => t.title).join("; ")}.`);
    if (p.wd === ops.reportDay && ops.lastReport !== today) {
      await weeklyReport(orgId, launch.id).catch((err) => console.warn("[projects] report failed:", err instanceof Error ? err.message : err));
    }
  }
  if (p.wd === ops.reportDay) await saveOps(orgId, { lastReport: today });
  // Employees whose next task is ready start on it.
  await startReadyTasks(orgId).catch((err) => console.warn("[projects] start failed:", err instanceof Error ? err.message : err));
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

export const TEAM_ITEMS = "Team action items";

/** The standing list for meeting action items that don't belong to a project. Kept open; its date moves forward. */
async function teamItemsList(orgId: number) {
  const ahead = new Date(Date.now() + 90 * DAY);
  const have = (await db.listLaunches(orgId)).find((l) => l.name === TEAM_ITEMS && l.status !== "dropped");
  if (have) {
    if (have.status !== "active" || new Date(have.launchDate) < new Date(Date.now() + 30 * DAY)) await db.updateLaunch(have.id, orgId, { status: "active", launchDate: ahead });
    return (await db.getLaunch(have.id, orgId))!;
  }
  return db.createLaunch({ organizationId: orgId, name: TEAM_ITEMS, launchDate: ahead, status: "active", brief: "Action items from meetings and huddles that don't belong to a project.", approvedBy: "Nora", approvedAt: new Date() });
}

export async function addActionItems(orgId: number, items: { text: string; owner: string; due?: Date }[], source: string, launchId?: number | null) {
  const fromMeeting = launchId ? await db.getLaunch(launchId, orgId) : null;
  let launch = (fromMeeting && fromMeeting.status === "active" ? fromMeeting : null) ?? (await db.listLaunches(orgId)).filter((l) => l.status === "active").sort((a, b) => new Date(a.launchDate).getTime() - new Date(b.launchDate).getTime())[0];
  // No project running: items still get an owner, a due date and tracking, under a standing list.
  if (!launch) launch = await teamItemsList(orgId);
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
  await startReadyTasks(orgId).catch(() => null);
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
  const ideas = db.listProjectNotes(orgId).filter((n) => n.kind === "idea" && n.status === "open");
  const ideaLine = ideas.length ? `Ideas not planned yet: ${ideas.slice(0, 10).map((n) => n.text).join("; ")}.` : "";
  if (!active.length) return ["There's no launch planned yet. Tell me what you're launching and the date.", ideaLine].filter(Boolean).join("\n\n");
  const parts = [];
  for (const l of active) parts.push(await launchFacts(orgId, l));
  if (ideaLine) parts.push(ideaLine);
  return parts.join("\n\n");
}

// ==========================================
// Project meetings (Simone's meeting engine schedules and sends; Nora writes them)
// ==========================================

/** Nora's agenda for a project meeting, built from the project's real status. */
export async function projectAgenda(orgId: number, launchId: number, m: { title: string; startsAt: Date; minutes: number }, attendees: string[]) {
  const nora = await employeeFor(orgId, "projects");
  const launch = await db.getLaunch(launchId, orgId);
  if (!launch) throw new TRPCError({ code: "NOT_FOUND", message: "That project is not in this workspace." });
  const { tz } = await opsFor(orgId);
  const facts = await launchFacts(orgId, launch);
  const out = await working(nora, async () => {
    const { system } = await systemPromptFor(
      nora,
      `Write the agenda for the project meeting "${m.title}" on ${fmt(m.startsAt, tz)}, ${m.minutes} minutes, for the ${launch.name} launch.
- 3 to 6 items. Minutes add up to ${m.minutes} or less.
- First item: where the project stands in numbers and its rating, ending with the meeting's purpose in a few words (who: ${nora.name}).
- Then what is late or blocked, by name, each with who owns it; then the decisions the group must make. Name the real task, date and number from the facts in each item.
- Last item: decisions and action items, with owners and due dates (who: ${attendees[0] || "the owner"}).
- who: one person attending (${attendees.join(", ") || "the owner"}), ${nora.name}, or the employee whose task it is. No item without a reason to discuss it.`
    );
    return generateJson<{ items: { item: string; who: string; minutes: number }[] }>({ system, prompt: facts, schemaName: "meeting_agenda", schema: obj({ items: arr(obj({ item: str, who: str, minutes: int })) }), maxTokens: 1200 });
  });
  return (out.items ?? []).slice(0, 8);
}

export async function findLaunch(orgId: number, target: string) {
  const all = (await db.listLaunches(orgId)).filter((l) => l.status === "active" || l.status === "planning");
  const t = target.trim().toLowerCase();
  return (t && all.find((l) => l.name.toLowerCase().includes(t) || t.includes(l.name.toLowerCase()))) || all.sort((a, b) => new Date(a.launchDate).getTime() - new Date(b.launchDate).getTime())[0] || null;
}
