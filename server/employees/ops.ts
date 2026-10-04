import crypto from "node:crypto";
import * as db from "../db";

/**
 * Leadership settings, stored as JSON on the workspace (organizations.ops).
 * - Simone (COO): the meeting link, repeating meetings, when agendas go out,
 *   what happens after a meeting, and the scorecard's weekly goals.
 * - Nora (Projects): who gets ClickUp tasks, the morning check time, the report day,
 *   and her repeating project meetings (one per project, kept apart from Simone's).
 * - Simone's notetaker: which meetings she sits in on, the words that keep her out,
 *   her name in the meeting, who gets the notes, and how long the recording is kept.
 */

export type Series = { id: string; name: string; day: number; time: string; minutes: number; attendees: string[]; updatesFrom: string[] };
/** A repeating project meeting Nora runs for one launch. */
export type ProjectSeries = Series & { launchId: number };

export type Notetaker = {
  joins: "all" | "picked";
  /** Comma-separated words. An event whose title, description or place has one is never joined. */
  skipWords: string;
  /** Name shown in the meeting. Empty means "Simone (notes for <owner first name>)". */
  botName: string;
  notesTo: "me" | "everyone";
  keep: "delete" | "7" | "30";
};

export const DEFAULT_SKIP_WORDS = "session, intake, therapy, telehealth, assessment, client";

export type Ops = {
  meetingLink: "meet" | "zoom";
  recurring: Series[];
  projectRecurring: ProjectSeries[];
  agendaWhen: "day_before" | "morning_of";
  afterMeeting: "notes" | "zoom";
  goals: Record<string, number>;
  taskOwners: "people" | "employees";
  checkTime: "07:30" | "08:30" | "09:30";
  reportDay: 1 | 5;
  notetaker: Notetaker;
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
  const projectSeries = Array.isArray(v.projectRecurring) ? v.projectRecurring : [];
  return {
    meetingLink: v.meetingLink === "zoom" ? "zoom" : "meet",
    recurring: series
      .filter((r) => r && typeof r.name === "string" && r.name.trim())
      .map(readSeries)
      .slice(0, 12),
    projectRecurring: projectSeries
      .filter((r) => r && typeof r.name === "string" && r.name.trim() && Number.isInteger(r.launchId))
      .map((r) => ({ ...readSeries(r), launchId: r.launchId }))
      .slice(0, 20),
    agendaWhen: v.agendaWhen === "morning_of" ? "morning_of" : "day_before",
    afterMeeting: v.afterMeeting === "zoom" ? "zoom" : "notes",
    goals: v.goals && typeof v.goals === "object" ? Object.fromEntries(Object.entries(v.goals).filter(([, n]) => typeof n === "number" && Number.isFinite(n))) : {},
    taskOwners: v.taskOwners === "people" ? "people" : "employees",
    checkTime: (TIMES as readonly string[]).includes(v.checkTime ?? "") ? (v.checkTime as Ops["checkTime"]) : "08:30",
    reportDay: v.reportDay === 1 ? 1 : 5,
    notetaker: readNotetaker(v.notetaker),
    lastCheck: typeof v.lastCheck === "string" ? v.lastCheck : undefined,
    lastReport: typeof v.lastReport === "string" ? v.lastReport : undefined,
  };
}

function readSeries(r: Series): Series {
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomBytes(5).toString("hex"),
    name: r.name.trim().slice(0, 120),
    day: Number.isInteger(r.day) && r.day >= 0 && r.day <= 6 ? r.day : 1,
    time: /^\d{2}:\d{2}$/.test(r.time ?? "") ? r.time : "09:00",
    minutes: (MEETING_MINUTES as readonly number[]).includes(Number(r.minutes)) ? Number(r.minutes) : 30,
    attendees: Array.isArray(r.attendees) ? r.attendees.filter((x) => typeof x === "string").slice(0, 30) : [],
    updatesFrom: Array.isArray(r.updatesFrom) ? r.updatesFrom.filter((x) => typeof x === "string").slice(0, 20) : [],
  };
}

function readNotetaker(raw: Partial<Notetaker> | undefined): Notetaker {
  const n = raw && typeof raw === "object" ? raw : {};
  return {
    joins: n.joins === "picked" ? "picked" : "all",
    skipWords: typeof n.skipWords === "string" ? n.skipWords.slice(0, 500) : DEFAULT_SKIP_WORDS,
    botName: typeof n.botName === "string" ? n.botName.trim().slice(0, 60) : "",
    notesTo: n.notesTo === "everyone" ? "everyone" : "me",
    keep: n.keep === "7" || n.keep === "30" ? n.keep : "delete",
  };
}

/** The never-join words as a clean lowercase list. */
export function skipWordList(n: Notetaker) {
  return n.skipWords
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 40);
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
