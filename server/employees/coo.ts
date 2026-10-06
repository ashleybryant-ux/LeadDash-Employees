import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { withUsage } from "../usage";
import type { AIEmployee, Meeting } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import { partsIn, zonedToUtc } from "./schedule";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { gate, handoff, logActivity } from "./team";
import { opsFor, saveOps, type Series } from "./ops";
import { addActionItems, findLaunch, launchView, projectAgenda } from "./projects";
import { cancelAll, notetakerStatus, notetakerTick } from "./notetaker";

/**
 * Simone (COO).
 * - Keeps the repeating meetings on the calendar: each one gets an agenda
 *   built from the week's work, then an invite with a Google Meet or Zoom link.
 * - After a meeting: your notes (or the Zoom transcript) become action items.
 *   Items go to Nora as tasks, and employees hear about theirs in their chat.
 * - The scorecard: each team's numbers this week against last week and the goal.
 * - Project meetings (meetings.launchId set) run through the same engine, but
 *   Nora owns them: she writes the agenda from the project's status, sends the
 *   invite and recap, and their action items go to that project.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const DAY = 86_400_000;

export type AgendaItem = { at: string; item: string; who: string; minutes: number };
export type ActionItem = { text: string; owner: string; ownerKind: string | null; taskId: number | null; status: "in_projects" | "task" | "open" | "done"; due?: string };
export type Attendee = { name: string; email: string };

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const fmtDay = (d: Date | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtTime = (d: Date | number, tz: string) => new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

/** "9:00" style times for each agenda line, from the meeting start. */
function timed(items: { item: string; who: string; minutes: number }[], start: Date, tz: string): AgendaItem[] {
  let t = start.getTime();
  return items.map((i) => {
    const at = new Date(t).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, "");
    t += Math.max(1, i.minutes) * 60_000;
    return { at, item: i.item, who: i.who, minutes: Math.max(1, i.minutes) };
  });
}

async function people(orgId: number) {
  return (await db.listMembers(orgId)).map((m) => ({ name: m.name || m.email, email: m.email }));
}

/** Who runs a meeting: Nora for a project meeting, Simone for the rest. */
async function ownerOf(orgId: number, m: Pick<Meeting, "launchId">) {
  return db.getEmployeeByKind(orgId, m.launchId ? "projects" : "coo");
}
const chatLink = (m: Pick<Meeting, "launchId">) => (m.launchId ? "/chats/projects/work" : "/chats/coo/work");

// ==========================================
// Repeating meetings
// ==========================================

/** The next start of a weekly series after `from`, in the workspace's time zone. */
export function nextStart(s: Series, tz: string, from = new Date()) {
  const [h, mi] = s.time.split(":").map(Number);
  const p = partsIn(from, tz);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i, 12));
    if (day.getUTCDay() !== s.day) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
    if (at.getTime() > from.getTime()) return at;
  }
  return null;
}

/** Makes sure each repeating meeting's next occurrence exists (within 8 days). */
export async function ensureMeetings(orgId: number) {
  const { ops, tz } = await opsFor(orgId);
  const existing = await db.listMeetings(orgId);
  const members = await people(orgId);
  const made: Meeting[] = [];
  const launches = ops.projectRecurring.length ? await db.listLaunches(orgId) : [];
  // A project's weekly meeting stops once the project is done or dropped.
  const live = ops.projectRecurring.filter((s) => launches.some((l) => l.id === s.launchId && (l.status === "active" || l.status === "planning")));
  for (const s of [...ops.recurring.map((x) => ({ ...x, launchId: null as number | null })), ...live]) {
    const at = nextStart(s, tz);
    if (!at) continue;
    if (existing.some((m) => m.seriesId === s.id && Math.abs(new Date(m.startsAt).getTime() - at.getTime()) < 60_000)) continue;
    const attendees = members.filter((m) => s.attendees.includes(m.email));
    made.push(await db.createMeeting({ organizationId: orgId, seriesId: s.id, launchId: s.launchId, title: s.name, startsAt: at, minutes: s.minutes, attendees: JSON.stringify(attendees), updatesFrom: JSON.stringify(s.updatesFrom), linkKind: ops.meetingLink }));
  }
  return made;
}

// ==========================================
// Agendas
// ==========================================

async function weekFacts(orgId: number, updatesFrom: string[]) {
  const { tz } = await opsFor(orgId);
  const since = new Date(Date.now() - 7 * DAY);
  const emps = await db.listEmployeesByOrg(orgId);
  const act = (await db.listActivity(orgId, 200)).filter((a) => new Date(a.createdAt) > since);
  const lines = [`Activity in the last 7 days (${act.length}):`, ...act.slice(0, 40).map((a) => `- ${emps.find((e) => e.id === a.employeeId)?.name ?? "LeadDash"}: ${a.text}`)];
  const waiting = (await db.listOutboundItemsByOrg(orgId)).filter((i) => i.status === "pending_approval");
  lines.push(`Waiting for the owner's approval: ${waiting.length}`);
  for (const l of (await db.listLaunches(orgId)).filter((x) => x.status === "active")) {
    const v = await launchView(orgId, l.id);
    const rep = v.reports[0];
    lines.push(`Launch ${l.name} (launch day ${fmtDay(l.launchDate, tz)}): ${v.tasks.filter((t) => t.status === "done").length} of ${v.tasks.length} tasks done, ${v.tasks.filter((t) => t.state.key === "behind").length} behind${rep ? `. Nora's latest report: ${rep.body.overall} Behind: ${rep.body.behind}` : ""}`);
  }
  const card = await scorecard(orgId);
  lines.push(`Scorecard this week: ${card.rows.map((r) => `${r.team} ${r.label}: ${r.thisWeek}${r.goal !== null ? ` (goal ${r.goal})` : ""}`).join("; ")}`);
  const topics = (await import("../work/simone")).takeTopics(orgId);
  if (topics.length) lines.push(`Topics the owner added to this meeting (put each on the agenda):\n${topics.map((t) => `- ${t}`).join("\n")}`);
  try {
    const { goalFacts } = await import("../work/simone");
    lines.push((await goalFacts(orgId)).lines.slice(0, 4000));
  } catch {
    // Goals are optional.
  }
  const { factsFor } = await import("./onboarding");
  for (const kind of updatesFrom) {
    const e = emps.find((x) => x.kind === kind);
    if (e) lines.push(`\n${e.name} (${e.roleTitle}) facts:\n${(await factsFor(e)).slice(0, 1500)}`);
  }
  return lines.join("\n");
}

export async function buildAgenda(orgId: number, meetingId: number) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const { tz } = await opsFor(orgId);
  if (m.launchId) {
    const items = await projectAgenda(orgId, m.launchId, m, parse<Attendee[]>(m.attendees, []).map((a) => a.name));
    let used = 0;
    const fit = items.filter((i) => (used += Math.max(1, i.minutes)) <= m.minutes + 15);
    await db.updateMeeting(m.id, orgId, { agenda: JSON.stringify(timed(fit, new Date(m.startsAt), tz)) });
    return (await db.getMeeting(m.id, orgId))!;
  }
  const simone = await employeeFor(orgId, "coo");
  const updatesFrom = parse<string[]>(m.updatesFrom, []);
  const emps = await db.listEmployeesByOrg(orgId);
  const attendees = parse<Attendee[]>(m.attendees, []);
  const answers = parse<Record<string, string>>(simone.onboarding, {});
  const facts = await weekFacts(orgId, updatesFrom);
  const out = await working(simone, async () => {
    const { system } = await systemPromptFor(
      simone,
      `Write the agenda for "${m.title}" on ${fmtDay(m.startsAt, tz)}, ${m.minutes} minutes.
- 3 to 7 items. Minutes add up to ${m.minutes} or less. First item: the numbers for the week (who: ${simone.name}). Last item: decisions and action items (who: ${attendees[0]?.name || "the owner"}).
- In between, what most needs this group, in order of importance: anything behind or blocking a launch first. Name the specific thing and number from the facts in each item.
- who: a person attending (${attendees.map((a) => a.name).join(", ") || "the owner"}) or an employee whose update it is (${updatesFrom.map((k) => emps.find((e) => e.kind === k)?.name).filter(Boolean).join(", ") || "none"}). Two names joined with "and" is fine.
${answers.style ? `- Style: ${answers.style}.` : ""}${answers.always ? `\n- Always include: ${answers.always}.` : ""}`
    );
    return generateJson<{ items: { item: string; who: string; minutes: number }[] }>({ system, prompt: facts, schemaName: "meeting_agenda", schema: obj({ items: arr(obj({ item: str, who: str, minutes: int })) }), maxTokens: 1200 });
  });
  const items = (out.items ?? []).slice(0, 8);
  let total = 0;
  const fit = items.filter((i) => (total += Math.max(1, i.minutes)) <= m.minutes + 15);
  const agenda = timed(fit, new Date(m.startsAt), tz);
  await db.updateMeeting(m.id, orgId, { agenda: JSON.stringify(agenda) });
  return (await db.getMeeting(m.id, orgId))!;
}

export function agendaText(m: Meeting, tz: string) {
  const items = parse<AgendaItem[]>(m.agenda, []);
  return [`${m.title}, ${fmtDay(m.startsAt, tz)} at ${fmtTime(m.startsAt, tz)}`, "", "Agenda", ...items.map((i) => `${i.at}  ${i.item} (${i.who}, ${i.minutes} min)`)].join("\n");
}

/** Sends the calendar invite with the meeting link to every attendee. Re-sending updates the same event. */
export async function sendInvite(orgId: number, meetingId: number, who: string) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const owner = await ownerOf(orgId, m);
  if ((await db.getConnectionByProvider(orgId, "google_workspace"))?.status !== "connected") throw new TRPCError({ code: "BAD_REQUEST", message: `Connect Google on Integrations so ${owner?.name ?? "I"} can send invites from your calendar.` });
  const { tz } = await opsFor(orgId);
  const attendees = parse<Attendee[]>(m.attendees, []);
  let zoomUrl: string | null = m.linkKind === "zoom" ? m.link : null;
  let zoomId = m.zoomMeetingId;
  if (m.linkKind === "zoom" && !zoomUrl) {
    if ((await db.getConnectionByProvider(orgId, "zoom"))?.status !== "connected") throw new TRPCError({ code: "BAD_REQUEST", message: "Connect Zoom on Integrations, or switch the meeting link to Google Meet on Simone's Onboarding tab." });
    const z = await integrations.createZoomMeeting(orgId, { topic: m.title, start: new Date(m.startsAt), minutes: m.minutes, tz, agenda: agendaText(m, tz) });
    zoomUrl = z.joinUrl;
    zoomId = z.id;
  }
  const ev = await integrations.inviteMeeting(orgId, { eventId: m.calendarEventId, summary: m.title, description: agendaText(m, tz), start: new Date(m.startsAt), minutes: m.minutes, tz, attendees: attendees.map((a) => a.email), zoomUrl });
  await db.updateMeeting(m.id, orgId, { status: "invited", calendarEventId: ev.eventId, eventUrl: ev.eventUrl, link: ev.link, zoomMeetingId: zoomId, inviteSentAt: new Date() });
  await logActivity(owner, "sent", `Sent the invite and agenda for ${m.title}, ${fmtDay(m.startsAt, tz)} at ${fmtTime(m.startsAt, tz)}, to ${attendees.length} ${attendees.length === 1 ? "person" : "people"}.`, chatLink(m), orgId);
  await db.logAction({ organizationId: orgId, actorType: who.includes("on her own") ? "employee" : "human_user", actorName: who, action: "Sent a meeting invite", details: m.title });
  return (await db.getMeeting(m.id, orgId))!;
}

export async function editMeeting(orgId: number, meetingId: number, input: { title?: string; date?: string; time?: string; minutes?: number; agenda?: { item: string; who: string; minutes: number }[]; attendees?: string[] }) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const { tz } = await opsFor(orgId);
  const patch: Partial<Meeting> = {};
  if (input.title?.trim()) patch.title = input.title.trim().slice(0, 160);
  if (input.minutes) patch.minutes = input.minutes;
  let start = new Date(m.startsAt);
  if (input.date || input.time) {
    const dm = (input.date ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const tm = (input.time ?? "").match(/^(\d{2}):(\d{2})$/);
    const cur = partsIn(start, tz);
    const y = dm ? +dm[3] : cur.y, mo = dm ? +dm[1] : cur.m, d = dm ? +dm[2] : cur.d;
    if (input.date && !dm) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the date as MM/DD/YYYY." });
    start = zonedToUtc(y, mo, d, tm ? +tm[1] : cur.h, tm ? +tm[2] : cur.mi, tz);
    patch.startsAt = start;
  }
  if (input.attendees) {
    const members = await people(orgId);
    patch.attendees = JSON.stringify(members.filter((p) => input.attendees!.includes(p.email)));
  }
  if (input.agenda) patch.agenda = JSON.stringify(timed(input.agenda.filter((a) => a.item.trim()), start, tz));
  else if (patch.startsAt) patch.agenda = JSON.stringify(timed(parse<AgendaItem[]>(m.agenda, []), start, tz));
  const next = (await db.updateMeeting(m.id, orgId, patch))!;
  if (next.status === "invited" && next.calendarEventId) {
    await integrations.inviteMeeting(orgId, { eventId: next.calendarEventId, summary: next.title, description: agendaText(next, tz), start: new Date(next.startsAt), minutes: next.minutes, tz, attendees: parse<Attendee[]>(next.attendees, []).map((a) => a.email), zoomUrl: next.linkKind === "zoom" ? next.link : null }).catch(() => null);
  }
  return next;
}

export async function cancelMeeting(orgId: number, meetingId: number) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  if (m.calendarEventId) await integrations.cancelCalendarEvent(orgId, m.calendarEventId).catch(() => null);
  return db.updateMeeting(m.id, orgId, { status: "cancelled" });
}

/** A one-time meeting from chat. It gets an agenda right away and waits for Send invite unless invites are set to On its own. */
export async function scheduleMeeting(orgId: number, input: { title: string; date: string; time: string; minutes: number; attendees: string; updatesFrom: string[] }) {
  const { ops, tz } = await opsFor(orgId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TRPCError({ code: "BAD_REQUEST", message: "What day should it be? Tell me the date and time." });
  const tm = (input.time || "9:00 AM").match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  let h = tm ? +tm[1] : 9;
  const mi = tm?.[2] ? +tm[2] : 0;
  if (tm?.[3]?.toLowerCase() === "pm" && h < 12) h += 12;
  if (tm?.[3]?.toLowerCase() === "am" && h === 12) h = 0;
  const [y, mo, d] = input.date.split("-").map(Number);
  const start = zonedToUtc(y, mo, d, h, mi, tz);
  const members = await people(orgId);
  const asked = input.attendees.toLowerCase();
  const attendees = asked.trim() ? members.filter((p) => asked.includes(p.email.toLowerCase()) || (p.name && asked.includes(p.name.toLowerCase().split(" ")[0]))) : members;
  const m = await db.createMeeting({ organizationId: orgId, title: input.title.slice(0, 160) || "Meeting", startsAt: start, minutes: [15, 30, 45, 60, 90].includes(input.minutes) ? input.minutes : 30, attendees: JSON.stringify(attendees.length ? attendees : members.slice(0, 1)), updatesFrom: JSON.stringify(input.updatesFrom), linkKind: ops.meetingLink });
  return buildAgenda(orgId, m.id);
}

/** Nora's project meeting: one time, or weekly on the same day and time until the project ends. Gets its agenda right away. */
export async function scheduleProjectMeeting(orgId: number, input: { title: string; project: string; date: string; time: string; minutes: number; attendees: string; weekly: boolean }) {
  const launch = await findLaunch(orgId, input.project);
  if (!launch) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no active project to meet about yet. Tell me what you're launching and the date first." });
  const { ops, tz } = await opsFor(orgId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new TRPCError({ code: "BAD_REQUEST", message: "What day should it be? Tell me the date and time." });
  const tm = (input.time || "9:00 AM").match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  let h = tm ? +tm[1] : 9;
  const mi = tm?.[2] ? +tm[2] : 0;
  if (tm?.[3]?.toLowerCase() === "pm" && h < 12) h += 12;
  if (tm?.[3]?.toLowerCase() === "am" && h === 12) h = 0;
  const [y, mo, d] = input.date.split("-").map(Number);
  const start = zonedToUtc(y, mo, d, h, mi, tz);
  const members = await people(orgId);
  const asked = input.attendees.toLowerCase();
  const picked = asked.trim() ? members.filter((p) => asked.includes(p.email.toLowerCase()) || (p.name && asked.includes(p.name.toLowerCase().split(" ")[0]))) : members;
  const attendees = picked.length ? picked : members.slice(0, 1);
  const minutes = [15, 30, 45, 60, 90].includes(input.minutes) ? input.minutes : 30;
  const title = (input.title || `${launch.name} project meeting`).slice(0, 160);
  let seriesId: string | null = null;
  if (input.weekly) {
    seriesId = `p${launch.id}-${Date.now().toString(36)}`;
    const series = { id: seriesId, name: title, day: new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay(), time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, minutes, attendees: attendees.map((a) => a.email), updatesFrom: [], launchId: launch.id };
    await saveOps(orgId, { projectRecurring: [...ops.projectRecurring, series] });
  }
  const m = await db.createMeeting({ organizationId: orgId, seriesId, launchId: launch.id, title, startsAt: start, minutes, attendees: JSON.stringify(attendees), updatesFrom: "[]", linkKind: ops.meetingLink });
  return buildAgenda(orgId, m.id);
}

// ==========================================
// After the meeting
// ==========================================

/** Turns notes into action items. Items go to Nora (and to each employee's chat) when "Action items to Nora" is On its own. */
export async function saveNotes(orgId: number, meetingId: number, notes: string, from: "notes" | "transcript" = "notes") {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  if (!notes.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste your notes first." });
  const simone = await employeeFor(orgId, m.launchId ? "projects" : "coo");
  const { tz } = await opsFor(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const attendees = parse<Attendee[]>(m.attendees, []);
  const out = await working(simone, async () => {
    const { system } = await systemPromptFor(simone, `Pull the action items out of these meeting ${from === "transcript" ? "transcript lines" : "notes"}. One item per thing someone agreed to do, written as a short task starting with a verb. owner: the person or employee who will do it, by first name, from: ${[...attendees.map((a) => a.name), ...emps.map((e) => e.name)].join(", ")}. If no owner is clear, use ${attendees[0]?.name.split(" ")[0] || "the owner"}. Skip discussion with no action. Never include a client's name.`);
    return generateJson<{ items: { text: string; owner: string }[] }>({ system, prompt: notes.slice(0, 30_000), schemaName: "action_items", schema: obj({ items: arr(obj({ text: str, owner: str })) }), maxTokens: 1500 });
  });
  let items: ActionItem[] = (out.items ?? []).slice(0, 20).map((i) => {
    const emp = emps.find((e) => e.name.toLowerCase() === i.owner.trim().toLowerCase());
    return { text: i.text.slice(0, 200), owner: emp ? emp.name : i.owner.trim().split(" ")[0] || "Owner", ownerKind: emp?.kind ?? null, taskId: null, status: "open" };
  });
  await db.updateMeeting(m.id, orgId, { notes: notes.slice(0, 30_000), notesAt: new Date(), status: "held", actionItems: JSON.stringify(items) });
  // Nora always tracks her own project's action items; Simone follows her settings.
  if (m.launchId || gate(simone, "action_items") === "auto") items = await sendItems(orgId, m.id);
  if (gate(simone, m.launchId ? "meetings" : "recap") === "auto" && attendees.length) await sendRecap(orgId, m.id, `${simone.name} (on her own)`).catch(() => null);
  await logActivity(simone, "done", `Turned the ${m.title} notes from ${fmtDay(m.startsAt, tz)} into ${items.length} action item${items.length === 1 ? "" : "s"}.`, chatLink(m));
  return (await db.getMeeting(m.id, orgId))!;
}

/** Action items to Nora as tasks, and a line in each employee's chat for theirs. */
export async function sendItems(orgId: number, meetingId: number) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const items = parse<ActionItem[]>(m.actionItems, []);
  const open = items.filter((i) => i.status === "open");
  if (!open.length) return items;
  const { tz } = await opsFor(orgId);
  const dueOf = (ymd?: string) => {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined;
    const [y, mo, d] = ymd.split("-").map(Number);
    return zonedToUtc(y, mo, d, 17, 0, tz);
  };
  const r = await addActionItems(orgId, open.map((i) => ({ text: i.text, owner: i.owner, due: dueOf(i.due) })), `meeting:${m.id}`, m.launchId);
  const inProjects = !!r.launch?.pjListId;
  open.forEach((it, idx) => {
    const t = r.tasks[idx];
    if (t) {
      it.taskId = t.id;
      it.status = inProjects ? "in_projects" : "task";
    }
  });
  for (const it of open.filter((i) => i.ownerKind)) {
    await handoff(orgId, m.launchId ? "projects" : "coo", it.ownerKind as AIEmployee["kind"], `From ${m.title}: ${it.text}`, chatLink(m)).catch(() => null);
  }
  await db.updateMeeting(m.id, orgId, { actionItems: JSON.stringify(items) });
  return items;
}

/**
 * Gives every action item from a meeting (or huddle) a due date, makes sure each is a
 * tracked task with an owner, and tells each employee theirs. Dates follow the
 * person's guidance ("by Friday"), otherwise a sensible date for each item.
 */
export async function setDeadlines(orgId: number, meetingId: number, guidance: string) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const items = parse<ActionItem[]>(m.actionItems, []);
  if (!items.length) return items;
  const simone = await employeeFor(orgId, m.launchId ? "projects" : "coo");
  const { tz } = await opsFor(orgId);
  const p = partsIn(new Date(), tz);
  const today = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const out = await working(simone, async () => {
    const { system } = await systemPromptFor(simone, `Give each action item a due date. Today is ${today} (${fmtDay(new Date(), tz)}). Dates are YYYY-MM-DD, on a weekday, after today. Follow the person's guidance when they gave it; otherwise pick a realistic date for the size of each item (small things in 2 to 3 business days, bigger ones within 2 weeks). Return the items in the same order.`);
    return generateJson<{ dates: string[] }>({ system, prompt: `Guidance: ${guidance || "none"}\n\nItems:\n${items.map((i, n) => `${n + 1}. ${i.text} (owner: ${i.owner})`).join("\n")}`, schemaName: "item_dates", schema: obj({ dates: arr(str) }), maxTokens: 600 });
  });
  const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d > today;
  items.forEach((it, i) => {
    const d = out.dates?.[i] ?? "";
    it.due = ok(d) ? d : it.due ?? today;
  });
  await db.updateMeeting(m.id, orgId, { actionItems: JSON.stringify(items) });
  // Items that never became tasks become tasks now, with their dates.
  if (items.some((i) => i.status === "open")) await sendItems(orgId, m.id);
  const fresh = parse<ActionItem[]>((await db.getMeeting(m.id, orgId))!.actionItems, []);
  const { updateTask } = await import("./projects");
  for (const it of fresh) {
    if (!it.taskId || !it.due) continue;
    const [y, mo, d] = it.due.split("-");
    await updateTask(orgId, it.taskId, { due: `${mo}/${d}/${y}` }).catch(() => null);
  }
  for (const it of fresh.filter((i) => i.ownerKind && i.due)) {
    const [y, mo, d] = it.due!.split("-").map(Number);
    await handoff(orgId, m.launchId ? "projects" : "coo", it.ownerKind as AIEmployee["kind"], `Due ${fmtDay(zonedToUtc(y, mo, d, 12, 0, tz), tz)}: ${it.text} (from ${m.title})`, chatLink(m)).catch(() => null);
  }
  await logActivity(simone, "done", `Set due dates for ${fresh.length} action item${fresh.length === 1 ? "" : "s"} from ${m.title}.`, chatLink(m));
  return fresh;
}

/** What Simone and Nora know about recent meetings and huddles, so they can answer and act on them in chat. */
export async function recentMeetingsFacts(orgId: number) {
  const { tz } = await opsFor(orgId);
  const held = (await db.listMeetings(orgId)).filter((m) => m.status === "held" || m.notes).sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime()).slice(0, 4);
  if (!held.length) return "Recent meetings: none with notes yet.";
  return [
    "Recent meetings and huddles (newest first). You have their notes and action items:",
    ...held.map((m) => {
      const items = parse<ActionItem[]>(m.actionItems, []);
      const lines = items.map((i) => {
        const [y, mo, d] = (i.due ?? "").split("-").map(Number);
        return `  - ${i.text} (owner: ${i.owner}; ${i.due ? `due ${fmtDay(zonedToUtc(y, mo, d, 12, 0, tz), tz)}` : "no due date"}; ${i.status === "open" ? "not a task yet" : i.status === "done" ? "done" : "tracked as a task"})`;
      });
      const when = fmtDay(m.startsAt, tz);
      return `- ${m.title.includes(when) ? m.title : `${m.title}, ${when}`}: ${items.length} action item${items.length === 1 ? "" : "s"}${lines.length ? `\n${lines.join("\n")}` : ""}${m.notes ? `\n  Notes excerpt: ${m.notes.slice(0, 600).replace(/\n/g, " / ")}` : ""}`;
    }),
  ].join("\n");
}

export async function sendRecap(orgId: number, meetingId: number, who: string) {
  const m = await db.getMeeting(meetingId, orgId);
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  if ((await db.getConnectionByProvider(orgId, "google_workspace"))?.status !== "connected") throw new TRPCError({ code: "BAD_REQUEST", message: `Connect Google on Integrations so ${(await ownerOf(orgId, m))?.name ?? "I"} can email the recap.` });
  const { tz } = await opsFor(orgId);
  const items = parse<ActionItem[]>(m.actionItems, []);
  const attendees = parse<Attendee[]>(m.attendees, []);
  if (!attendees.length) throw new TRPCError({ code: "BAD_REQUEST", message: "This meeting has no attendees to send the recap to." });
  const due = new Map<number, Date>();
  for (const i of items) if (i.taskId) {
    const t = await db.getLaunchTask(i.taskId, orgId);
    if (t) due.set(i.taskId, new Date(t.dueDate));
  }
  const body = [`Recap: ${m.title}, ${fmtDay(m.startsAt, tz)}`, "", "Action items", ...(items.length ? items.map((i) => `- ${i.text} (${i.owner}${i.taskId && due.get(i.taskId) ? `, due ${fmtDay(due.get(i.taskId)!, tz)}` : ""})`) : ["- None"]), "", "Agenda", ...parse<AgendaItem[]>(m.agenda, []).map((a) => `- ${a.item}`)].join("\n");
  await integrations.sendGmail(orgId, attendees.map((a) => a.email).join(", "), `Recap: ${m.title}, ${fmtDay(m.startsAt, tz)}`, body);
  await db.updateMeeting(m.id, orgId, { recapSentAt: new Date() });
  await db.logAction({ organizationId: orgId, actorType: who.includes("on her own") ? "employee" : "human_user", actorName: who, action: "Sent a meeting recap", details: m.title });
  return (await db.getMeeting(m.id, orgId))!;
}

// ==========================================
// The scorecard
// ==========================================

export const SCORE_ROWS = [
  { key: "practices_contacted", team: "Sales", label: "Practices contacted", lowerIsBetter: false, unit: "" },
  { key: "demos_booked", team: "Sales", label: "Demos booked", lowerIsBetter: false, unit: "" },
  { key: "reply_minutes", team: "Sales", label: "Malik's reply time", lowerIsBetter: true, unit: " min" },
  { key: "posts_published", team: "Marketing", label: "Posts published", lowerIsBetter: false, unit: "" },
  { key: "articles_published", team: "Marketing", label: "Articles published", lowerIsBetter: false, unit: "" },
  { key: "grant_apps_sent", team: "Revenue", label: "Grant applications sent", lowerIsBetter: false, unit: "" },
  { key: "tasks_on_time", team: "Operations", label: "Tasks done on time", lowerIsBetter: false, unit: "%" },
  { key: "approvals_waiting", team: "Operations", label: "Approvals waiting over 2 days", lowerIsBetter: true, unit: "" },
] as const;

/** Monday 00:00 of the week holding `d`, in the workspace's time zone. */
function weekStart(d: Date, tz: string) {
  const p = partsIn(d, tz);
  const back = (p.wd + 6) % 7;
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d - back, 12));
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, tz);
}

/** Counts one scorecard number over a span of time. Loads the workspace's data once, so it can be asked for many weeks. */
export async function scoreCounter(orgId: number) {
  const inRange = (d: Date | null | undefined, a: Date, b: Date) => !!d && new Date(d) >= a && new Date(d) < b;
  const out = await db.listOutboundItemsByOrg(orgId);
  const leads = await db.listLeads(orgId);
  const apps = await db.listApplications(orgId);
  const tasks = await db.listOrgLaunchTasks(orgId);
  const value = (key: string, a: Date, b: Date): number | null => {
    switch (key) {
      case "practices_contacted":
        return out.filter((m) => m.kind === "outreach_email" && m.status === "published" && inRange(m.publishedAt, a, b) && JSON.parse(m.metadata || "{}").step === 1).length;
      case "demos_booked":
        return leads.filter((l) => l.status === "booked" && inRange(l.updatedAt, a, b)).length;
      case "reply_minutes": {
        const replies = out.filter((m) => m.kind === "lead_reply" && m.status === "published" && inRange(m.publishedAt, a, b));
        const mins = replies
          .map((r) => {
            const lead = leads.find((l) => JSON.parse(l.meta || "{}").replyItemId === r.id);
            return lead ? (new Date(r.publishedAt!).getTime() - new Date(lead.createdAt).getTime()) / 60_000 : null;
          })
          .filter((x): x is number => x !== null && x >= 0);
        return mins.length ? Math.round(mins.reduce((s, x) => s + x, 0) / mins.length) : null;
      }
      case "posts_published":
        return out.filter((m) => m.kind === "social_post" && m.status === "published" && inRange(m.publishedAt, a, b)).length;
      case "articles_published":
        return out.filter((m) => m.kind === "blog_post" && m.status === "published" && inRange(m.publishedAt, a, b)).length;
      case "grant_apps_sent":
        return apps.filter((x) => ["submitted", "awarded", "declined"].includes(x.status) && inRange(x.updatedAt, a, b)).length;
      case "tasks_on_time": {
        const done = tasks.filter((t) => t.status === "done" && inRange(t.doneAt, a, b));
        return done.length ? Math.round((done.filter((t) => new Date(t.doneAt!) <= new Date(new Date(t.dueDate).getTime() + DAY)).length / done.length) * 100) : null;
      }
      case "approvals_waiting":
        return b.getTime() > Date.now() ? out.filter((i) => i.status === "pending_approval" && Date.now() - new Date(i.createdAt).getTime() > 2 * DAY).length : null;
      default:
        return null;
    }
  };
  return value;
}

export async function scorecard(orgId: number, weekOf?: Date) {
  const { ops, tz } = await opsFor(orgId);
  const start = weekStart(weekOf ?? new Date(), tz);
  const end = new Date(start.getTime() + 7 * DAY);
  const prev = new Date(start.getTime() - 7 * DAY);
  const isCurrent = end.getTime() > Date.now();
  const value = await scoreCounter(orgId);
  const rows = SCORE_ROWS.map((r) => {
    const thisWeek = value(r.key, start, end);
    const lastWeek = r.key === "approvals_waiting" ? null : value(r.key, prev, start);
    const goal = ops.goals[r.key] ?? null;
    const met = goal === null || thisWeek === null ? null : r.lowerIsBetter ? thisWeek <= goal : thisWeek >= goal;
    return { key: r.key, team: r.team, label: r.label, unit: r.unit, thisWeek, lastWeek, goal, met };
  });
  const label = `${new Date(start).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })} to ${new Date(end.getTime() - DAY).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" })}`;
  return { weekStart: start, label, isCurrent, rows };
}

export async function setGoal(orgId: number, key: string, goal: number | null) {
  const row = SCORE_ROWS.find((r) => r.key === key);
  if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "That number isn't on the scorecard." });
  const { ops } = await opsFor(orgId);
  const goals = { ...ops.goals };
  if (goal === null) delete goals[key];
  else goals[key] = Math.max(0, Math.round(goal));
  await saveOps(orgId, { goals });
  return row;
}

// ==========================================
// The minute job
// ==========================================

/** Agenda time for a meeting: the day before at 4:00 PM, or the morning of at 7:00 AM. */
function agendaDue(m: Meeting, when: "day_before" | "morning_of", tz: string) {
  const p = partsIn(new Date(m.startsAt), tz);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d - (when === "day_before" ? 1 : 0), 12));
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), when === "day_before" ? 16 : 7, 0, tz);
}

export async function cooTick(orgId: number, now = new Date()) {
  const simone = await db.getEmployeeByKind(orgId, "coo");
  const nora = await db.getEmployeeByKind(orgId, "projects");
  const runs = (e: AIEmployee | null) => !!e && e.status !== "paused";
  // Avery sits in on meetings: paused, no bots join for him. Simone and Nora's meetings still run.
  const avery = await db.getEmployeeByKind(orgId, "inbox");
  if (avery?.status === "paused") await cancelAll(orgId).catch(() => null);
  if (runs(avery)) await notetakerTick(orgId, now).catch((err) => console.warn("[coo] notetaker failed:", err instanceof Error ? err.message : err));
  if (!runs(simone) && !runs(nora)) return;
  const { ops, tz } = await opsFor(orgId);
  if (ops.recurring.length || ops.projectRecurring.length) await ensureMeetings(orgId);
  for (const m of await db.listMeetings(orgId)) {
    const owner = m.launchId ? nora : simone;
    if (!owner || !runs(owner)) continue;
    const ended = new Date(m.startsAt).getTime() + m.minutes * 60_000;
    // Agenda and invite.
    if (m.status === "draft" && !m.agenda && new Date(m.startsAt) > now && agendaDue(m, ops.agendaWhen, tz) <= now) {
      const withAgenda = await buildAgenda(orgId, m.id).catch(() => null);
      if (!withAgenda) continue;
      if (gate(owner, m.launchId ? "meetings" : "invites") === "auto") await sendInvite(orgId, m.id, `${owner.name} (on her own)`).catch((err) => console.warn("[coo] invite failed:", err instanceof Error ? err.message : err));
      else await db.createChatMessage({ organizationId: orgId, employeeId: owner.id, role: "employee", authorName: owner.name, content: `Here's the agenda for ${m.title}, ${fmtDay(m.startsAt, tz)} at ${fmtTime(m.startsAt, tz)}. Press Send invite and it goes out with the meeting link.`, cards: JSON.stringify([meetingCard(withAgenda)]) });
    }
    // Zoom transcript after the meeting.
    if (m.status === "invited" && ended < now.getTime() - 30 * 60_000 && ended > now.getTime() - 3 * DAY && !m.notes && ops.afterMeeting === "zoom" && m.zoomMeetingId) {
      const text = await integrations.zoomTranscript(orgId, m.zoomMeetingId).catch(() => null);
      if (text) await saveNotes(orgId, m.id, text, "transcript").catch(() => null);
    }
  }
}

export async function cooTicks() {
  for (const orgId of await db.listAllOrganizationIds()) {
    await withUsage({ orgId, kind: "coo" }, () => cooTick(orgId)).catch((err) => console.warn("[coo] tick failed:", err instanceof Error ? err.message : err));
  }
}

// ==========================================
// Lists, cards, chat
// ==========================================

export function meetingState(m: Meeting, now = new Date()) {
  const ended = new Date(m.startsAt).getTime() + m.minutes * 60_000;
  if (m.status === "cancelled") return "cancelled" as const;
  if (ended < now.getTime() || m.status === "held") return "past" as const;
  return "upcoming" as const;
}

export async function meetingsView(orgId: number) {
  const now = new Date();
  const all = (await db.listMeetings(orgId)).filter((m) => m.status !== "cancelled");
  const view = (m: Meeting) => ({ ...m, state: meetingState(m, now), attendees: parse<Attendee[]>(m.attendees, []), updatesFrom: parse<string[]>(m.updatesFrom, []), agenda: parse<AgendaItem[]>(m.agenda, []), actionItems: parse<ActionItem[]>(m.actionItems, []) });
  return {
    upcoming: all.filter((m) => meetingState(m, now) === "upcoming").map(view),
    past: all.filter((m) => meetingState(m, now) === "past").sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime()).slice(0, 40).map(view),
  };
}

export function meetingCard(m: Meeting) {
  return { type: "meeting_agenda" as const, id: m.id, title: m.title, status: m.status };
}

export async function cooStatus(orgId: number) {
  const { tz } = await opsFor(orgId);
  const card = await scorecard(orgId);
  const v = await meetingsView(orgId);
  const next = v.upcoming.slice(0, 3).map((m) => `${m.title} (${fmtDay(m.startsAt, tz)} at ${fmtTime(m.startsAt, tz)}${m.status === "invited" ? ", invites sent" : ", invite not sent"})`);
  const open = v.past.flatMap((m) => m.actionItems.filter((i) => i.status !== "done").map((i) => `${i.text} (${i.owner})`)).slice(0, 8);
  return [
    `Scorecard ${card.label}: ${card.rows.map((r) => `${r.label} ${r.thisWeek ?? "no data"}${r.unit}${r.goal !== null ? ` against ${r.goal}${r.unit}` : ""}`).join("; ")}.`,
    `Coming up: ${next.join("; ") || "no meetings scheduled"}.`,
    `Open action items: ${open.join("; ") || "none"}.`,
    await notetakerStatus(orgId),
  ].join("\n");
}

type Which = "all" | "project";
const keep = (which: Which) => (m: { launchId: number | null }) => which === "all" || !!m.launchId;

export async function nextMeetingFor(orgId: number, target: string, which: Which = "all") {
  const v = await meetingsView(orgId);
  const list = v.upcoming.filter(keep(which));
  const t = target.trim().toLowerCase();
  return (t && list.find((m) => m.title.toLowerCase().includes(t) || t.includes(m.title.toLowerCase()))) || list[0] || null;
}

export async function lastMeetingFor(orgId: number, target: string, which: Which = "all") {
  const v = await meetingsView(orgId);
  const list = v.past.filter(keep(which));
  const t = target.trim().toLowerCase();
  return (t && list.find((m) => m.title.toLowerCase().includes(t))) || list[0] || null;
}
