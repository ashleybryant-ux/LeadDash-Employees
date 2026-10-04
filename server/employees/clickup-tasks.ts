import * as db from "../db";
import * as integrations from "../integrations";
import { zonedToUtc } from "./schedule";

/**
 * ClickUp for every employee: what's due, finding tasks anywhere in the
 * workspace (by words, list or person), the workspace's Spaces, folders and
 * lists, adding tasks (to a named list, or a "LeadDash Employees tasks" list in
 * the chosen Space), and changing a task (done or another status, due date,
 * assignee, a comment). Nora also keeps her own lists for launches (projects.ts).
 */

const DAY = 86_400_000;
export const AVERY_LIST = "LeadDash Employees tasks";

export type CuTask = { id: string; name: string; due: Date | null; status: string; closed: boolean; list: string; listId: string; folder: string; space: string; assignees: string[]; url: string | null };
type Member = { id: number; email: string; name: string };

async function tz(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}

export function fmtDue(d: Date | null, zone: string) {
  return d ? d.toLocaleDateString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "no due date";
}

async function settings(orgId: number) {
  const cu = await integrations.clickupSettings(orgId);
  if (!cu) throw new Error("ClickUp isn't connected for this workspace. Connect it on Integrations.");
  return cu;
}

function toTask(t: any): CuTask {
  return {
    id: String(t.id),
    name: String(t.name ?? ""),
    due: t.due_date ? new Date(Number(t.due_date)) : null,
    status: String(t.status?.status ?? ""),
    closed: t.status?.type === "closed" || t.status?.type === "done",
    list: String(t.list?.name ?? ""),
    listId: String(t.list?.id ?? ""),
    folder: t.folder?.hidden ? "" : String(t.folder?.name ?? ""),
    space: String(t.space?.name ?? t.space?.id ?? ""),
    assignees: (t.assignees ?? []).map((a: any) => String(a.username || a.email || "")).filter(Boolean),
    url: t.url ?? null,
  };
}

/** Tasks across the whole workspace (up to 500), open only unless includeClosed. */
async function allTasks(orgId: number, query: string, includeClosed = false) {
  const cu = await settings(orgId);
  const out: CuTask[] = [];
  for (let page = 0; page < 5; page++) {
    const data = await integrations.clickup(orgId, `/team/${cu.teamId}/task?include_closed=${includeClosed}&subtasks=true&page=${page}${query}`);
    for (const t of data.tasks ?? []) {
      const task = toTask(t);
      // Tasks carry only the Space's id; show its name.
      task.space = cu.spaces?.find((sp) => sp.id === task.space)?.name ?? task.space;
      out.push(task);
    }
    if (data.last_page !== false || !(data.tasks ?? []).length) break;
  }
  return out;
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
const byDue = (a: CuTask, b: CuTask) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity);

/** Open tasks due within `days` (and anything overdue), soonest first, optionally for one person. */
export async function dueSoon(orgId: number, days = 7, who = "") {
  const until = Date.now() + Math.max(1, Math.min(60, days)) * DAY;
  const list = await allTasks(orgId, `&order_by=due_date&due_date_lt=${until}`);
  const w = who.trim();
  return (w ? list.filter((t) => t.assignees.some((a) => has(a, w))) : list).sort(byDue);
}

/** Finds tasks by words in the task, list, folder or Space name, and/or by person. */
export async function findTasks(orgId: number, input: { words?: string; who?: string; includeDone?: boolean }) {
  const words = (input.words ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const list = await allTasks(orgId, "&order_by=due_date", !!input.includeDone);
  return list
    .filter((t) => !words.length || words.every((w) => has(`${t.name} ${t.list} ${t.folder} ${t.space}`, w)))
    .filter((t) => !input.who?.trim() || t.assignees.some((a) => has(a, input.who!.trim())))
    .sort(byDue);
}

/** The workspace's Spaces, folders and lists, so employees know where things live. */
export async function workspaceMap(orgId: number) {
  const cu = await settings(orgId);
  const spaces = (await integrations.clickup(orgId, `/team/${cu.teamId}/space?archived=false`)).spaces ?? [];
  const out: { space: string; spaceId: string; lists: { id: string; name: string; folder: string }[] }[] = [];
  for (const s of spaces.slice(0, 20)) {
    const lists: { id: string; name: string; folder: string }[] = [];
    const folders = (await integrations.clickup(orgId, `/space/${s.id}/folder?archived=false`)).folders ?? [];
    for (const f of folders) for (const l of f.lists ?? []) lists.push({ id: String(l.id), name: String(l.name), folder: String(f.name) });
    for (const l of (await integrations.clickup(orgId, `/space/${s.id}/list?archived=false`)).lists ?? []) lists.push({ id: String(l.id), name: String(l.name), folder: "" });
    out.push({ space: String(s.name), spaceId: String(s.id), lists });
  }
  return out;
}

async function defaultList(orgId: number) {
  const cu = await settings(orgId);
  const spaceId = cu.spaceId || cu.spaces?.[0]?.id;
  if (!spaceId) throw new Error("Choose a ClickUp Space on Nora's Onboarding tab first.");
  const lists = await integrations.clickup(orgId, `/space/${spaceId}/list?archived=false`);
  const have = (lists.lists ?? []).find((l: any) => l.name === AVERY_LIST);
  if (have) return { id: String(have.id), name: AVERY_LIST };
  const made = await integrations.clickup(orgId, `/space/${spaceId}/list`, { method: "POST", body: { name: AVERY_LIST } });
  return { id: String(made.id), name: AVERY_LIST };
}

async function memberFor(orgId: number, who: string) {
  const a = who.trim().toLowerCase();
  if (!a) return undefined;
  const members: Member[] = await integrations.clickupMembers(orgId).catch(() => []);
  return members.find((m) => m.email === a || m.name.toLowerCase() === a || m.name.toLowerCase().split(" ")[0] === a.split(" ")[0]);
}

async function dueMs(orgId: number, ymd?: string) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined;
  const [y, mo, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, mo, d, 17, 0, await tz(orgId)).getTime();
}

/** Adds a task to a named list (when one matches) or the LeadDash Employees tasks list. `due` is YYYY-MM-DD. */
export async function addTask(orgId: number, input: { name: string; details?: string; due?: string; assignee?: string; list?: string }) {
  let target: { id: string; name: string } | null = null;
  if (input.list?.trim()) {
    const all = (await workspaceMap(orgId)).flatMap((s) => s.lists);
    const hit = all.find((l) => l.name.toLowerCase() === input.list!.trim().toLowerCase()) ?? all.find((l) => has(l.name, input.list!.trim()));
    if (hit) target = { id: hit.id, name: hit.name };
  }
  target = target ?? (await defaultList(orgId));
  const member = await memberFor(orgId, input.assignee ?? "");
  const due = await dueMs(orgId, input.due);
  const t = await integrations.clickup(orgId, `/list/${target.id}/task`, {
    method: "POST",
    body: { name: input.name.slice(0, 200), description: (input.details ?? "").slice(0, 4000), ...(due ? { due_date: due, due_date_time: false } : {}), assignees: member ? [member.id] : [] },
  });
  return { url: (t.url as string) ?? null, due: due ? new Date(due) : null, assignee: member?.name || member?.email || null, list: target.name };
}

type Status = { status: string; type: string };

/** The list's status that matches what the person said ("done" is the list's closed status). */
async function statusFor(orgId: number, listId: string, want: string, cache = new Map<string, Status[]>()) {
  let statuses = cache.get(listId);
  if (!statuses) {
    statuses = ((await withRetry(() => integrations.clickup(orgId, `/list/${listId}`))).statuses ?? []) as Status[];
    cache.set(listId, statuses);
  }
  const done = ["done", "complete", "completed", "finished", "closed", "close"].includes(want);
  const open = ["open", "to do", "todo", "reopen"].includes(want);
  return done ? statuses.find((s) => s.type === "closed") ?? statuses.find((s) => s.type === "done") : open ? statuses.find((s) => s.type === "open") : statuses.find((s) => s.status.toLowerCase() === want) ?? statuses.find((s) => has(s.status, want));
}

/** ClickUp allows about 100 requests a minute; wait and try again when it says slow down. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 4 || !/429|rate limit|too many/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 1 : 20_000 * (attempt + 1)));
    }
  }
}

export type Pick = { overdue?: boolean; dueBefore?: string; words?: string; who?: string; ids?: string[] };

/** The open tasks a bulk change is about: overdue, due before a date, by words or person, or exact ids (to undo). */
export async function pickTasks(orgId: number, pick: Pick) {
  if (pick.ids?.length) {
    const want = new Set(pick.ids);
    return (await allTasks(orgId, "&order_by=due_date", true)).filter((t) => want.has(t.id));
  }
  const now = Date.now();
  const before = await dueMs(orgId, pick.dueBefore);
  return (await findTasks(orgId, { words: pick.words, who: pick.who })).filter((t) => (!pick.overdue || (t.due && t.due.getTime() < now)) && (!before || (t.due && t.due.getTime() < before)));
}

/** Changes many tasks at once: a status (done, open...) and/or a new due date. Returns what changed and what didn't. */
export async function changeMany(orgId: number, tasks: CuTask[], change: { status?: string; due?: string }) {
  const cache = new Map<string, Status[]>();
  const due = await dueMs(orgId, change.due);
  const want = (change.status ?? "").trim().toLowerCase();
  const changed: CuTask[] = [];
  const failed: { task: CuTask; why: string }[] = [];
  for (const t of tasks) {
    try {
      const body: Record<string, unknown> = {};
      if (want) {
        const st = await statusFor(orgId, t.listId, want, cache);
        if (!st) throw new Error(`${t.list} has no status called "${change.status}"`);
        body.status = st.status;
      }
      if (due) {
        body.due_date = due;
        body.due_date_time = false;
      }
      if (!Object.keys(body).length) continue;
      await withRetry(() => integrations.clickup(orgId, `/task/${t.id}`, { method: "PUT", body }));
      changed.push(t);
    } catch (err) {
      failed.push({ task: t, why: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
    }
  }
  return { changed, failed };
}

/**
 * Changes one task found by its words: mark done (or any status the list has),
 * new due date, add an assignee, and/or a comment. Returns the task and what changed,
 * or the close matches when the words fit more than one task.
 */
export async function changeTask(orgId: number, input: { task: string; status?: string; due?: string; assignee?: string; comment?: string; who: string }) {
  const matches = await findTasks(orgId, { words: input.task, includeDone: true });
  const exact = matches.filter((t) => t.name.toLowerCase() === input.task.trim().toLowerCase());
  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (!pick) return { task: null, changed: [] as string[], matches: matches.slice(0, 5) };
  const changed: string[] = [];
  const body: Record<string, unknown> = {};
  const want = (input.status ?? "").trim().toLowerCase();
  if (want) {
    const st = await statusFor(orgId, pick.listId, want);
    if (st) {
      body.status = st.status;
      changed.push(`status ${st.status}`);
    } else changed.push(`no status called "${input.status}" on ${pick.list}`);
  }
  const due = await dueMs(orgId, input.due);
  if (due) {
    body.due_date = due;
    body.due_date_time = false;
    changed.push(`due ${fmtDue(new Date(due), await tz(orgId))}`);
  }
  const member = await memberFor(orgId, input.assignee ?? "");
  if (member) {
    body.assignees = { add: [member.id], rem: [] };
    changed.push(`assigned to ${member.name || member.email}`);
  } else if (input.assignee?.trim()) changed.push(`couldn't find ${input.assignee} in ClickUp`);
  if (Object.keys(body).length) await integrations.clickup(orgId, `/task/${pick.id}`, { method: "PUT", body });
  if (input.comment?.trim()) {
    await integrations.clickup(orgId, `/task/${pick.id}/comment`, { method: "POST", body: { comment_text: `${input.comment.trim()} (from ${input.who}, LeadDash Employees)`, notify_all: true } });
    changed.push("comment added");
  }
  return { task: pick, changed, matches: [] as CuTask[] };
}
