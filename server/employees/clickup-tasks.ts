import * as db from "../db";
import * as integrations from "../integrations";
import { zonedToUtc } from "./schedule";

/**
 * ClickUp for the Executive Assistant (Avery): what's due across the workspace,
 * and new tasks added to a "LeadDash Employees tasks" list in the chosen Space.
 * Nora keeps her own lists for launches (projects.ts).
 */

const DAY = 86_400_000;
export const AVERY_LIST = "LeadDash Employees tasks";

export type DueTask = { name: string; due: Date | null; status: string; list: string; assignees: string[]; url: string | null };

async function tz(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}

export function fmtDue(d: Date | null, zone: string) {
  return d ? d.toLocaleDateString("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "no due date";
}

/** Open tasks due within `days` (and anything overdue), soonest first, optionally for one person. */
export async function dueSoon(orgId: number, days = 7, who = "") {
  const cu = await integrations.clickupSettings(orgId);
  if (!cu) throw new Error("ClickUp isn't connected for this workspace. Connect it on Integrations.");
  const until = Date.now() + Math.max(1, Math.min(60, days)) * DAY;
  const out: DueTask[] = [];
  for (let page = 0; page < 3; page++) {
    const data = await integrations.clickup(orgId, `/team/${cu.teamId}/task?include_closed=false&subtasks=true&order_by=due_date&due_date_lt=${until}&page=${page}`);
    for (const t of data.tasks ?? []) {
      out.push({
        name: String(t.name ?? ""),
        due: t.due_date ? new Date(Number(t.due_date)) : null,
        status: String(t.status?.status ?? ""),
        list: String(t.list?.name ?? ""),
        assignees: (t.assignees ?? []).map((a: any) => String(a.username || a.email || "")).filter(Boolean),
        url: t.url ?? null,
      });
    }
    if (data.last_page !== false) break;
  }
  const w = who.trim().toLowerCase();
  const mine = w ? out.filter((t) => t.assignees.some((a) => a.toLowerCase().includes(w))) : out;
  return mine.sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
}

async function averyList(orgId: number) {
  const cu = await integrations.clickupSettings(orgId);
  if (!cu) throw new Error("ClickUp isn't connected for this workspace. Connect it on Integrations.");
  const spaceId = cu.spaceId || cu.spaces?.[0]?.id;
  if (!spaceId) throw new Error("Choose a ClickUp Space on Nora's Onboarding tab first.");
  const lists = await integrations.clickup(orgId, `/space/${spaceId}/list?archived=false`);
  const have = (lists.lists ?? []).find((l: any) => l.name === AVERY_LIST);
  if (have) return String(have.id);
  const made = await integrations.clickup(orgId, `/space/${spaceId}/list`, { method: "POST", body: { name: AVERY_LIST } });
  return String(made.id);
}

/** Adds a task. `due` is YYYY-MM-DD; `assignee` is a ClickUp member's name or email. */
export async function addTask(orgId: number, input: { name: string; details?: string; due?: string; assignee?: string }) {
  const zone = await tz(orgId);
  const listId = await averyList(orgId);
  const members: { id: number; email: string; name: string }[] = await integrations.clickupMembers(orgId).catch(() => []);
  const a = (input.assignee ?? "").trim().toLowerCase();
  const member = a ? members.find((m) => m.email === a || m.name.toLowerCase() === a || m.name.toLowerCase().split(" ")[0] === a.split(" ")[0]) : undefined;
  let due: number | undefined;
  if (input.due && /^\d{4}-\d{2}-\d{2}$/.test(input.due)) {
    const [y, mo, d] = input.due.split("-").map(Number);
    due = zonedToUtc(y, mo, d, 17, 0, zone).getTime();
  }
  const t = await integrations.clickup(orgId, `/list/${listId}/task`, {
    method: "POST",
    body: { name: input.name.slice(0, 200), description: (input.details ?? "").slice(0, 4000), ...(due ? { due_date: due, due_date_time: false } : {}), assignees: member ? [member.id] : [] },
  });
  return { url: (t.url as string) ?? null, due: due ? new Date(due) : null, assignee: member?.name || member?.email || null, list: AVERY_LIST };
}
