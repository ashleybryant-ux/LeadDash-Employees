import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, NotetakerMeeting, NotetakerStatus } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { gate, handoff, logActivity } from "./team";
import { opsFor, saveOps, skipWordList, type Notetaker } from "./ops";
import { addActionItems } from "./projects";
import { recordMeeting } from "../usage";

/**
 * Simone sits in on your meetings.
 * - Every 10 minutes she reads the next two days of your Google Calendar. Events with a
 *   Zoom or Google Meet link are listed on Meetings, Sitting in. Teams and other links are ignored.
 * - An event whose title, description or place has a never-join word (session, intake, therapy...)
 *   is locked: she never joins it, whatever else is set. Client sessions from the LeadDash EHR
 *   are kept out this way.
 * - For the rest she books a Recall.ai bot that joins a minute early under her name and posts
 *   a note in the meeting chat. After the meeting the recording becomes a transcript, the
 *   transcript becomes notes and action items, items go to Nora, and the recording is deleted
 *   (or kept 7 or 30 days, as set).
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const MIN = 60_000;
const DAY = 86_400_000;
const LEAD = 10 * MIN; // Recall only guarantees on-time joins for bots booked more than 10 minutes ahead.

export type NotesItem = { text: string; owner: string; ownerKind: string | null; taskId: number | null; status: "in_clickup" | "task" | "open" | "done"; due: string | null };
export type NotesSummary = { summary: string; decisions: string[]; questions: string[] };
type Attendee = { name: string; email: string };

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const fmtDay = (d: Date | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtTime = (d: Date | number, tz: string) => new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

const ACTIVE: NotetakerStatus[] = ["scheduled", "joining", "in_call", "processing"];

/** The workspace owner's name, for "notes for Ashley". */
async function ownerOf(orgId: number) {
  const members = await db.listMembers(orgId);
  const owner = members.find((m) => m.role === "owner") ?? members[0];
  const name = owner?.name?.trim() || owner?.email || "the owner";
  return { name, first: name.split(" ")[0], email: owner?.email ?? "" };
}

export async function botNameFor(orgId: number, n: Notetaker) {
  if (n.botName) return n.botName;
  const simone = await db.getEmployeeByKind(orgId, "coo");
  return `${simone?.name ?? "Simone"} (notes for ${(await ownerOf(orgId)).first})`;
}

async function joinMessage(orgId: number) {
  const simone = await db.getEmployeeByKind(orgId, "coo");
  return `I'm ${simone?.name ?? "Simone"}, taking notes for ${(await ownerOf(orgId)).first}. Ask me to leave anytime.`;
}

/** The never-join word an event has, if any. Links to leaddash.io always lock. */
export function lockReasonFor(text: string, words: string[]) {
  const t = text.toLowerCase();
  if (/leaddash\.io/.test(t)) return "Has a LeadDash link";
  const hit = words.find((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(t));
  return hit ? `Has the word "${hit}"` : null;
}

/** Whether Simone should be in this meeting. Locked meetings never. */
export function wantsJoin(m: Pick<NotetakerMeeting, "choice" | "lockReason">, n: Notetaker) {
  if (m.lockReason) return false;
  if (m.choice === "join") return true;
  if (m.choice === "skip") return false;
  return n.joins === "all";
}

// ==========================================
// Reading the calendar and booking bots
// ==========================================

const lastSync = new Map<number, number>();

/** Brings the list in line with the calendar, then books or cancels bots to match. */
export async function syncCalendar(orgId: number, now = new Date(), force = false) {
  if (!force && now.getTime() - (lastSync.get(orgId) ?? 0) < 10 * MIN) return;
  lastSync.set(orgId, now.getTime());
  const { ops } = await opsFor(orgId);
  const n = ops.notetaker;
  const words = skipWordList(n);
  const from = new Date(now.getTime() - 30 * MIN);
  const to = new Date(now.getTime() + 2 * DAY);
  const events = await integrations.calendarMeetings(orgId, from, to);
  const seen = new Set<string>();
  const series = await db.listMeetings(orgId);
  for (const e of events) {
    if (e.declined) continue;
    seen.add(e.eventId);
    const lockReason = lockReasonFor(e.text, words);
    const linked = series.find((s) => s.calendarEventId && s.calendarEventId === e.eventId);
    const fields = { title: e.title, startsAt: e.start, endsAt: e.end, platform: e.platform, meetingUrl: e.url, attendees: JSON.stringify(e.attendees), lockReason, meetingId: linked?.id ?? null };
    const row = await db.getNotetakerByEvent(orgId, e.eventId);
    if (!row) {
      const created = await db.createNotetaker({ organizationId: orgId, eventId: e.eventId, ...fields, status: "skipped" });
      await settle(orgId, created, n, now);
      continue;
    }
    if (!["skipped", "scheduled", "cancelled"].includes(row.status)) continue; // already in the meeting or done
    const moved = row.startsAt.getTime() !== e.start.getTime() || row.meetingUrl !== e.url;
    let next = await db.updateNotetaker(row.id, orgId, { ...fields, status: row.status === "cancelled" ? "skipped" : row.status });
    if (next && moved && next.botId && next.status === "scheduled") {
      await integrations.removeRecallBot(orgId, next.botId).catch(() => null);
      next = await db.updateNotetaker(row.id, orgId, { botId: null, status: "skipped" });
    }
    if (next) await settle(orgId, next, n, now);
  }
  // Events that left the calendar: cancel their bots.
  for (const row of await db.listNotetaker(orgId)) {
    if (row.startsAt < from || row.startsAt > to || seen.has(row.eventId)) continue;
    if (row.status === "scheduled" || row.status === "skipped") {
      if (row.botId) await integrations.removeRecallBot(orgId, row.botId).catch(() => null);
      await db.updateNotetaker(row.id, orgId, { botId: null, status: "cancelled" });
    }
  }
}

/** Books a bot when she should join and none is booked; cancels one when she should not. */
async function settle(orgId: number, row: NotetakerMeeting, n: Notetaker, now: Date) {
  const want = wantsJoin(row, n);
  if (!want) {
    if (row.botId && row.status === "scheduled") {
      await integrations.removeRecallBot(orgId, row.botId).catch(() => null);
      return db.updateNotetaker(row.id, orgId, { botId: null, status: "skipped" });
    }
    return row;
  }
  if (row.botId || row.status !== "skipped" || row.endsAt.getTime() <= now.getTime()) return row;
  const joinAt = new Date(row.startsAt.getTime() - MIN);
  const ahead = joinAt.getTime() - now.getTime();
  // Booked ahead when there is time; otherwise sent in now (only once the meeting is about to start).
  if (ahead <= LEAD + MIN && ahead > 2 * MIN) return row;
  try {
    const botId = await integrations.createRecallBot(orgId, { meetingUrl: row.meetingUrl, joinAt: ahead > LEAD + MIN ? joinAt : null, botName: await botNameFor(orgId, n), message: await joinMessage(orgId) });
    return db.updateNotetaker(row.id, orgId, { botId, status: "scheduled", error: null });
  } catch (err) {
    return db.updateNotetaker(row.id, orgId, { error: err instanceof Error ? err.message.slice(0, 300) : "Could not book the bot." });
  }
}

// ==========================================
// Following the bot, then the notes
// ==========================================

const IN_CALL = ["in_call_not_recording", "in_call_recording", "recording_permission_allowed", "recording_permission_denied"];
const REMOVED_SUB = /kicked|removed|denied|waiting_room_timeout|timeout_exceeded_waiting_room|not_allowed|no_one_joined|left_call/i;

/** Moves each active meeting along: in the meeting, transcript, notes, recording deleted. */
export async function followBots(orgId: number, now = new Date()) {
  const { ops } = await opsFor(orgId);
  for (const row of await db.listNotetaker(orgId)) {
    if (!ACTIVE.includes(row.status) || !row.botId) continue;
    if (row.status === "scheduled" && row.startsAt.getTime() - now.getTime() > 5 * MIN) continue;
    try {
      if (!row.transcriptId) {
        const st = await integrations.recallBotState(orgId, row.botId);
        if (["joining_call", "in_waiting_room"].includes(st.code)) {
          if (row.status !== "joining") await db.updateNotetaker(row.id, orgId, { status: "joining" });
        } else if (IN_CALL.includes(st.code)) {
          if (row.status !== "in_call") await db.updateNotetaker(row.id, orgId, { status: "in_call" });
        } else if (st.code === "fatal") {
          await db.updateNotetaker(row.id, orgId, { status: REMOVED_SUB.test(st.subCode ?? "") ? "removed" : "failed", error: st.subCode ? `Recall.ai: ${st.subCode.replace(/_/g, " ")}` : "The bot could not join." });
        } else if (st.code === "call_ended" || st.code === "done") {
          if (!st.recordingId) {
            if (st.code === "done") await db.updateNotetaker(row.id, orgId, { status: "removed", error: st.subCode ? st.subCode.replace(/_/g, " ") : "Left before anything was recorded." });
            else if (row.status !== "processing") await db.updateNotetaker(row.id, orgId, { status: "processing" });
          } else if (st.recordingDone) {
            const transcriptId = await integrations.recallStartTranscript(orgId, st.recordingId);
            await db.updateNotetaker(row.id, orgId, { status: "processing", recordingId: st.recordingId, transcriptId });
          } else if (row.status !== "processing") {
            await db.updateNotetaker(row.id, orgId, { status: "processing", recordingId: st.recordingId });
          }
        } else if (row.status === "scheduled" && now.getTime() > row.endsAt.getTime() + 60 * MIN) {
          await db.updateNotetaker(row.id, orgId, { status: "failed", error: "The bot never joined." });
        }
        continue;
      }
      const t = await integrations.recallTranscript(orgId, row.transcriptId);
      if (t.state === "failed") {
        await db.updateNotetaker(row.id, orgId, { status: "failed", error: "Recall.ai could not make the transcript." });
      } else if (t.state === "done") {
        await db.updateNotetaker(row.id, orgId, { transcript: t.text, heldMinutes: t.minutes });
        const billed = t.minutes || Math.max(1, Math.round((new Date(row.endsAt).getTime() - new Date(row.startsAt).getTime()) / 60000));
        await recordMeeting(orgId, (await db.getEmployeeByKind(orgId, "coo"))?.id ?? null, billed);
        await writeNotes(orgId, row.id);
        if (ops.notetaker.keep === "delete") await deleteMedia(orgId, row.id);
      }
    } catch (err) {
      console.warn("[notetaker] follow failed:", err instanceof Error ? err.message : err);
    }
  }
  // Recordings kept 7 or 30 days.
  const keepDays = ops.notetaker.keep === "7" ? 7 : ops.notetaker.keep === "30" ? 30 : 0;
  for (const row of await db.listNotetaker(orgId)) {
    if (row.botId && !row.mediaDeletedAt && ["ready", "failed", "removed"].includes(row.status) && row.endsAt.getTime() + keepDays * DAY < now.getTime() && (keepDays > 0 || row.status !== "ready")) {
      await deleteMedia(orgId, row.id).catch(() => null);
    }
  }
}

async function deleteMedia(orgId: number, id: number) {
  const row = await db.getNotetaker(id, orgId);
  if (!row?.botId || row.mediaDeletedAt) return;
  await integrations.recallDeleteMedia(orgId, row.botId);
  await db.updateNotetaker(id, orgId, { mediaDeletedAt: new Date() });
}

/** Transcript to summary, decisions, open questions and action items. Items go to Nora when that is On its own. */
export async function writeNotes(orgId: number, id: number) {
  const row = await db.getNotetaker(id, orgId);
  if (!row?.transcript) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no transcript for this meeting yet." });
  const simone = await employeeFor(orgId, "coo");
  const { tz } = await opsFor(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const attendees = parse<Attendee[]>(row.attendees, []);
  const owner = await ownerOf(orgId);
  const names = Array.from(new Set([owner.name, ...attendees.map((a) => a.name), ...emps.map((e) => e.name)])).join(", ");
  const out = await working(simone, async () => {
    const { system } = await systemPromptFor(
      simone,
      `Write the notes for a meeting you sat in on: "${row.title}", ${fmtDay(row.startsAt, tz)}. Use only what the transcript says.
summary: 2 to 4 plain sentences on what the meeting was about and where things stand, with any dates and numbers said.
decisions: each thing that was agreed, one short sentence each. [] if none.
questions: anything left open or to be found out. [] if none.
items: one per thing someone agreed to do, a short task starting with a verb. owner: the person or employee who will do it, by first name, from: ${names}. If no owner is clear, use ${owner.first}. due: the date it was promised for as MM/DD/YYYY with the year, or "" if no date was said. Today is ${fmtDay(new Date(), tz)}.
Never include a client's name or health details. Your own lines in the transcript (the notetaker) are not part of the meeting.`
    );
    return generateJson<{ summary: string; decisions: string[]; questions: string[]; items: { text: string; owner: string; due: string }[] }>({
      system,
      prompt: row.transcript!.slice(0, 100_000),
      schemaName: "meeting_notes",
      schema: obj({ summary: str, decisions: arr(str), questions: arr(str), items: arr(obj({ text: str, owner: str, due: str })) }),
      maxTokens: 2500,
    });
  });
  const items: NotesItem[] = (out.items ?? []).slice(0, 25).map((i) => {
    const emp = emps.find((e) => e.name.toLowerCase() === i.owner.trim().toLowerCase());
    const due = /^\d{2}\/\d{2}\/\d{4}$/.test(i.due.trim()) ? i.due.trim() : null;
    return { text: i.text.slice(0, 200), owner: emp ? emp.name : i.owner.trim().split(" ")[0] || owner.first, ownerKind: emp?.kind ?? null, taskId: null, status: "open", due };
  });
  const summary: NotesSummary = { summary: String(out.summary ?? "").slice(0, 2000), decisions: (out.decisions ?? []).slice(0, 15).map((d) => d.slice(0, 300)), questions: (out.questions ?? []).slice(0, 15).map((q) => q.slice(0, 300)) };
  await db.updateNotetaker(id, orgId, { summary: JSON.stringify(summary), actionItems: JSON.stringify(items), status: "ready", error: null });
  if (gate(simone, "action_items") === "auto") await sendItems(orgId, id);
  // Simone's own meeting gets the notes on its Past row too.
  if (row.meetingId) {
    const m = await db.getMeeting(row.meetingId, orgId);
    if (m && !m.notes) {
      const fresh = await db.getNotetaker(id, orgId);
      await db.updateMeeting(m.id, orgId, { notes: summary.summary, notesAt: new Date(), status: "held", actionItems: JSON.stringify(parse<NotesItem[]>(fresh?.actionItems, []).map(({ due: _due, ...rest }) => rest)) });
    }
  }
  const mine = items.filter((i) => i.owner.toLowerCase() === owner.first.toLowerCase()).length;
  const emp = items.filter((i) => i.ownerKind).length;
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: simone.id,
    role: "employee",
    authorName: simone.name,
    content: `I sat in on ${row.title} and wrote the notes: ${items.length} action item${items.length === 1 ? "" : "s"}${items.length ? ` (${mine} for you${emp ? `, ${emp} for the team` : ""})` : ""}.${gate(simone, "action_items") === "auto" && items.length ? " I sent the action items to Nora." : ""} The recap is ready when you are.`,
    cards: JSON.stringify([notesCard((await db.getNotetaker(id, orgId))!)]),
  });
  await logActivity(simone, "done", `Sat in on ${row.title} (${fmtDay(row.startsAt, tz)}) and wrote the notes with ${items.length} action item${items.length === 1 ? "" : "s"}.`, "/chats/coo/work?tab=notes");
  return (await db.getNotetaker(id, orgId))!;
}

/** Action items to Nora as tasks, and a line in each employee's chat for theirs. */
export async function sendItems(orgId: number, id: number) {
  const row = await db.getNotetaker(id, orgId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const items = parse<NotesItem[]>(row.actionItems, []);
  const open = items.filter((i) => i.status === "open");
  if (!open.length) return items;
  const toDate = (mdy: string | null) => {
    const m = mdy?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 17)) : undefined;
  };
  const r = await addActionItems(orgId, open.map((i) => ({ text: i.text, owner: i.owner, due: toDate(i.due) })), `notes:${row.id}`);
  const inClickup = !!r.launch?.clickupListId;
  open.forEach((it, idx) => {
    const t = r.tasks[idx];
    if (t) {
      it.taskId = t.id;
      it.status = inClickup ? "in_clickup" : "task";
    }
  });
  for (const it of open.filter((i) => i.ownerKind && i.ownerKind !== "coo")) {
    await handoff(orgId, "coo", it.ownerKind as AIEmployee["kind"], `From ${row.title}: ${it.text}`, "/chats/coo/work").catch(() => null);
  }
  await db.updateNotetaker(id, orgId, { actionItems: JSON.stringify(items) });
  return items;
}

/** Emails the notes to you, or to everyone invited, as set on Onboarding. */
export async function sendRecap(orgId: number, id: number, who: { name: string; email: string }) {
  const row = await db.getNotetaker(id, orgId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  if (row.status !== "ready") throw new TRPCError({ code: "BAD_REQUEST", message: "The notes aren't ready yet." });
  if (!(await integrations.channelState(orgId)).gmail) throw new TRPCError({ code: "BAD_REQUEST", message: "Connect Google on Integrations so Simone can email the recap." });
  const { ops, tz } = await opsFor(orgId);
  const s = parse<NotesSummary>(row.summary, { summary: "", decisions: [], questions: [] });
  const items = parse<NotesItem[]>(row.actionItems, []);
  const attendees = parse<Attendee[]>(row.attendees, []);
  const to = ops.notetaker.notesTo === "everyone" && attendees.length ? Array.from(new Set([who.email, ...attendees.map((a) => a.email)].filter(Boolean))) : [who.email].filter(Boolean);
  if (!to.length) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no email address to send the recap to." });
  const subject = `Notes: ${row.title}, ${fmtDay(row.startsAt, tz)}`;
  const body = [
    subject,
    "",
    s.summary,
    "",
    "Decisions",
    ...(s.decisions.length ? s.decisions.map((d) => `- ${d}`) : ["- None"]),
    "",
    "Action items",
    ...(items.length ? items.map((i) => `- ${i.text} (${i.owner}${i.due ? `, by ${i.due}` : ""})`) : ["- None"]),
    ...(s.questions.length ? ["", "Open questions", ...s.questions.map((q) => `- ${q}`)] : []),
  ].join("\n");
  await integrations.sendGmail(orgId, to.join(", "), subject, body);
  await db.updateNotetaker(id, orgId, { recapSentAt: new Date() });
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who.name, action: "Sent meeting notes", details: `${row.title} to ${to.length} ${to.length === 1 ? "person" : "people"}` });
  return (await db.getNotetaker(id, orgId))!;
}

/** Edit the notes by hand: summary, decisions, questions and items. */
export async function editNotes(orgId: number, id: number, input: { summary: string; decisions: string[]; questions: string[]; items: { text: string; owner: string; due: string }[] }) {
  const row = await db.getNotetaker(id, orgId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  const emps = await db.listEmployeesByOrg(orgId);
  const before = parse<NotesItem[]>(row.actionItems, []);
  const items: NotesItem[] = input.items
    .filter((i) => i.text.trim())
    .slice(0, 25)
    .map((i) => {
      const prev = before.find((b) => b.text === i.text.trim() && b.owner === i.owner.trim());
      const emp = emps.find((e) => e.name.toLowerCase() === i.owner.trim().toLowerCase());
      const due = i.due.trim();
      if (due && !/^\d{2}\/\d{2}\/\d{4}$/.test(due)) throw new TRPCError({ code: "BAD_REQUEST", message: "Type due dates as MM/DD/YYYY." });
      return prev ? { ...prev, due: due || null } : { text: i.text.trim().slice(0, 200), owner: i.owner.trim().slice(0, 60) || "Owner", ownerKind: emp?.kind ?? null, taskId: null, status: "open" as const, due: due || null };
    });
  const summary: NotesSummary = { summary: input.summary.trim().slice(0, 2000), decisions: input.decisions.map((d) => d.trim()).filter(Boolean).slice(0, 15), questions: input.questions.map((q) => q.trim()).filter(Boolean).slice(0, 15) };
  return db.updateNotetaker(id, orgId, { summary: JSON.stringify(summary), actionItems: JSON.stringify(items) });
}

/** Join or Skip for one meeting. Books or cancels the bot right away. */
export async function setChoice(orgId: number, id: number, choice: "join" | "skip") {
  const row = await db.getNotetaker(id, orgId);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  if (row.lockReason && choice === "join") throw new TRPCError({ code: "BAD_REQUEST", message: `${row.lockReason}, so Simone never joins it. Change the never-join words on her Onboarding tab if this is wrong.` });
  if (!["skipped", "scheduled", "cancelled", "joining", "in_call"].includes(row.status)) throw new TRPCError({ code: "BAD_REQUEST", message: "That meeting is already over." });
  const { ops } = await opsFor(orgId);
  let next = (await db.updateNotetaker(id, orgId, { choice }))!;
  // Skip while she's in the meeting: she leaves now.
  if (choice === "skip" && next.botId && (next.status === "joining" || next.status === "in_call")) {
    await integrations.removeRecallBot(orgId, next.botId).catch(() => null);
    return (await db.updateNotetaker(id, orgId, { botId: null, status: "skipped" }))!;
  }
  if (next.status === "cancelled") next = (await db.updateNotetaker(id, orgId, { status: "skipped" }))!;
  return (await settle(orgId, next, ops.notetaker, new Date()))!;
}

/** Cancels every booked bot (Recall.ai disconnected, or the settings changed). */
export async function cancelAll(orgId: number) {
  for (const row of await db.listNotetaker(orgId)) {
    if (row.botId && row.status === "scheduled") {
      await integrations.removeRecallBot(orgId, row.botId).catch(() => null);
      await db.updateNotetaker(row.id, orgId, { botId: null, status: "skipped" });
    }
  }
}

// ==========================================
// Settings, lists, cards
// ==========================================

export async function notetakerSettings(orgId: number) {
  const { ops } = await opsFor(orgId);
  const conns = await db.listConnectionsByOrg(orgId);
  return {
    ...ops.notetaker,
    botNameShown: await botNameFor(orgId, ops.notetaker),
    joinMessage: await joinMessage(orgId),
    recall: conns.some((c) => c.provider === "recall" && c.status === "connected"),
    google: conns.some((c) => c.provider === "google_workspace" && c.status === "connected"),
  };
}

export async function saveNotetaker(orgId: number, patch: Partial<Notetaker>) {
  const { ops } = await opsFor(orgId);
  const next = await saveOps(orgId, { notetaker: { ...ops.notetaker, ...patch } });
  // Words and the join rule decide who is locked or booked: re-read the calendar now.
  if (await integrations.recallConnected(orgId)) {
    lastSync.delete(orgId);
    await syncCalendar(orgId, new Date(), true).catch((err) => console.warn("[notetaker] sync failed:", err instanceof Error ? err.message : err));
  }
  return notetakerSettings(orgId);
}

export async function notetakerTick(orgId: number, now = new Date()) {
  if (!(await integrations.recallConnected(orgId))) return;
  if (!(await integrations.channelState(orgId)).calendar) return;
  await syncCalendar(orgId, now).catch((err) => console.warn("[notetaker] sync failed:", err instanceof Error ? err.message : err));
  await bookDue(orgId, now);
  await followBots(orgId, now);
}

/** Meetings starting in the next few minutes that still need a bot sent in (too close to book ahead). */
async function bookDue(orgId: number, now: Date) {
  const { ops } = await opsFor(orgId);
  for (const row of await db.listNotetaker(orgId)) {
    if (row.status !== "skipped" || row.botId || row.endsAt.getTime() <= now.getTime() || row.startsAt.getTime() - now.getTime() > LEAD + 2 * MIN) continue;
    if (wantsJoin(row, ops.notetaker)) await settle(orgId, row, ops.notetaker, now);
  }
}

export function notesCard(r: Pick<NotetakerMeeting, "id" | "title" | "status">) {
  return { type: "meeting_notes" as const, id: r.id, title: r.title, status: r.status };
}

function viewOf(r: NotetakerMeeting) {
  const { transcript, ...rest } = r;
  return {
    ...rest,
    hasTranscript: !!transcript,
    attendees: parse<Attendee[]>(r.attendees, []),
    summary: parse<NotesSummary | null>(r.summary, null),
    actionItems: parse<NotesItem[]>(r.actionItems, []),
  };
}

export async function notetakerView(orgId: number) {
  const now = Date.now();
  const all = await db.listNotetaker(orgId);
  const upcoming = all.filter((r) => r.endsAt.getTime() > now && ["skipped", "scheduled", "joining", "in_call"].includes(r.status));
  const notes = all
    .filter((r) => ["processing", "ready", "failed", "removed"].includes(r.status))
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, 60);
  return { upcoming: upcoming.map(viewOf), notes: notes.map(viewOf) };
}

export async function notesOne(orgId: number, id: number) {
  const r = await db.getNotetaker(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  return viewOf(r);
}

export async function transcriptOf(orgId: number, id: number) {
  const r = await db.getNotetaker(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
  return { title: r.title, transcript: r.transcript ?? "" };
}

// ==========================================
// Chat helpers
// ==========================================

/** The meeting someone means by a name or a time ("my 4:00"), among upcoming or finished ones. */
export async function findMeeting(orgId: number, target: string, which: "upcoming" | "notes") {
  const { tz } = await opsFor(orgId);
  const v = await notetakerView(orgId);
  const list = which === "upcoming" ? v.upcoming : v.notes.filter((r) => r.status === "ready");
  const t = target.trim().toLowerCase();
  if (!t) return list[0] ?? null;
  const byTitle = list.find((r) => r.title.toLowerCase().includes(t) || r.attendees.some((a) => a.name.toLowerCase().includes(t)));
  if (byTitle) return byTitle;
  const clock = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (clock) {
    const h = Number(clock[1]);
    const mm = clock[2] ?? "00";
    return list.find((r) => {
      const at = fmtTime(r.startsAt, tz).toLowerCase(); // "4:00 pm"
      return at.startsWith(`${h}:${mm}`) && (!clock[3] || at.endsWith(clock[3]));
    }) ?? null;
  }
  return null;
}

/** Plain-text notes for answering questions in chat. */
export function notesText(r: ReturnType<typeof viewOf>, tz: string) {
  const s = r.summary;
  return [
    `${r.title}, ${fmtDay(r.startsAt, tz)}.`,
    s?.summary ?? "",
    s?.decisions.length ? `Decisions: ${s.decisions.join("; ")}` : "",
    s?.questions.length ? `Open questions: ${s.questions.join("; ")}` : "",
    r.actionItems.length ? `Action items: ${r.actionItems.map((i) => `${i.text} (${i.owner}${i.due ? `, by ${i.due}` : ""})`).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function notetakerStatus(orgId: number) {
  const { tz } = await opsFor(orgId);
  if (!(await integrations.recallConnected(orgId))) return "Sitting in: Recall.ai is not connected, so I'm not joining meetings.";
  const v = await notetakerView(orgId);
  const joining = v.upcoming.filter((r) => r.status === "scheduled" || r.status === "joining" || r.status === "in_call").slice(0, 4);
  const recent = v.notes.filter((r) => r.status === "ready").slice(0, 3);
  return [
    `Sitting in next: ${joining.map((r) => `${r.title} (${fmtDay(r.startsAt, tz)} at ${fmtTime(r.startsAt, tz)})`).join("; ") || "nothing booked"}.`,
    `Recent notes: ${recent.map((r) => r.title).join("; ") || "none yet"}.`,
  ].join("\n");
}
