import crypto from "node:crypto";
import * as db from "../db";

/**
 * Leadership settings, stored as JSON on the workspace (organizations.ops).
 * - Simone (COO): the meeting link, repeating meetings, when agendas go out,
 *   what happens after a meeting, and the scorecard's weekly goals.
 * - Nora (Projects): who gets ClickUp tasks, the morning check time and the report day.
 */

export type Series = { id: string; name: string; day: number; time: string; minutes: number; attendees: string[]; updatesFrom: string[] };

export type Ops = {
  meetingLink: "meet" | "zoom";
  recurring: Series[];
  agendaWhen: "day_before" | "morning_of";
  afterMeeting: "notes" | "zoom";
  goals: Record<string, number>;
  taskOwners: "people" | "employees";
  checkTime: "07:30" | "08:30" | "09:30";
  reportDay: 1 | 5;
  /** Bookkeeping so daily jobs run once a day. */
  lastCheck?: string;
  lastReport?: string;
};

const TIMES = ["07:30", "08:30", "09:30"] as const;
export const MEETING_MINUTES = [15, 30, 45, 60, 90] as const;

export function readOps(raw: string | null | undefined): Ops {
  let v: Partial<Ops> = {};
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    v = {};
  }
  const series = Array.isArray(v.recurring) ? v.recurring : [];
  return {
    meetingLink: v.meetingLink === "zoom" ? "zoom" : "meet",
    recurring: series
      .filter((r) => r && typeof r.name === "string" && r.name.trim())
      .map((r) => ({
        id: typeof r.id === "string" && r.id ? r.id : crypto.randomBytes(5).toString("hex"),
        name: r.name.trim().slice(0, 120),
        day: Number.isInteger(r.day) && r.day >= 0 && r.day <= 6 ? r.day : 1,
        time: /^\d{2}:\d{2}$/.test(r.time ?? "") ? r.time : "09:00",
        minutes: (MEETING_MINUTES as readonly number[]).includes(Number(r.minutes)) ? Number(r.minutes) : 30,
        attendees: Array.isArray(r.attendees) ? r.attendees.filter((x) => typeof x === "string").slice(0, 30) : [],
        updatesFrom: Array.isArray(r.updatesFrom) ? r.updatesFrom.filter((x) => typeof x === "string").slice(0, 20) : [],
      }))
      .slice(0, 12),
    agendaWhen: v.agendaWhen === "morning_of" ? "morning_of" : "day_before",
    afterMeeting: v.afterMeeting === "zoom" ? "zoom" : "notes",
    goals: v.goals && typeof v.goals === "object" ? Object.fromEntries(Object.entries(v.goals).filter(([, n]) => typeof n === "number" && Number.isFinite(n))) : {},
    taskOwners: v.taskOwners === "people" ? "people" : "employees",
    checkTime: (TIMES as readonly string[]).includes(v.checkTime ?? "") ? (v.checkTime as Ops["checkTime"]) : "08:30",
    reportDay: v.reportDay === 1 ? 1 : 5,
    lastCheck: typeof v.lastCheck === "string" ? v.lastCheck : undefined,
    lastReport: typeof v.lastReport === "string" ? v.lastReport : undefined,
  };
}

export async function opsFor(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  return { ops: readOps(org?.ops), org, tz: org?.timezone || "America/Chicago" };
}

export async function saveOps(orgId: number, patch: Partial<Ops>) {
  const { ops } = await opsFor(orgId);
  const next = readOps(JSON.stringify({ ...ops, ...patch }));
  await db.updateOrganization(orgId, { ops: JSON.stringify(next) });
  return next;
}
