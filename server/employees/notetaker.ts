import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, NotetakerMeeting, NotetakerStatus } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import * as calendars from "./calendars";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { gate, handoff, logActivity } from "./team";
import { opsFor, saveOps, skipWordList, type Notetaker } from "./ops";
import { addActionItems } from "./projects";
import { recordMeeting } from "../usage";

/**
 * Avery sits in on your meetings and sends the notes to Simone, who runs the follow-up.
 * - Every 10 minutes he reads the next two days of every calendar connected on Integrations
 *   (the main Google account, extra Google accounts, Outlook or iCloud links). Events with a
 *   Zoom or Google Meet link are listed on Meetings, Sitting in. Teams and other links are ignored.
 *   A calendar set to busy times only hides its links, so he can't join meetings on it.
 * - An event whose title, description or place has a never-join word (session, intake, therapy...)
 *   is locked: she never joins it, whatever else is set. Client sessions from the LeadDash EHR
 *   are kept out this way.
 * - For the rest she books a Recall.ai bot that joins a minute early under her name and posts
 *   a note in the meeting chat. After the meeting the recording becomes a transcript, the
 *   transcript becomes Avery's notes and action items, the notes go to Simone (her Meetings tab
 *   and chat), items go to Nora, and the recording is deleted (or kept 7 or 30 days, as set).
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const MIN = 60_000;
const DAY = 86_400_000;
const LEAD = 10 * MIN; // Recall only guarantees on-time joins for bots booked more than 10 minutes ahead.

export type NotesItem = { text: string; owner: string; ownerKind: string | null; taskId: number | null; status: "in_projects" | "task" | "open" | "done"; due: string | null };
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
  const avery = await db.getEmployeeByKind(orgId, "inbox");
  return `${avery?.name ?? "Avery"} (notes for ${(await ownerOf(orgId)).first})`;
}

async function joinMessage(orgId: number) {
  const avery = await db.getEmployeeByKind(orgId, "inbox");
  return `I'm ${avery?.name ?? "Avery"}, taking notes for ${(await ownerOf(orgId)).first}. Ask me to leave anytime.`;
}

/** The never-join word an event has, if any. Links to leaddash.io always lock. */
export function lockReasonFor(text: string, words: string[]) {
  const t = text.toLowerCase();
  if (/leaddash\.io/.test(t)) return "Has a LeadDash link";
  const hit = words.find((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(t));
  return hit ? `Has the word "${hit}"` : null;
}

/** Whether Avery should be in this meeting. Locked meetings never. */
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
/** What the last read of the calendars found that is worth telling: calendars hiding their links, calendars that failed. */
const lastRead = new Map<number, { hidden: string[]; failed: string[]; sources: number; at: number }>();

/** Whether there is any calendar for Avery to read. */
export async function hasCalendar(orgId: number) {
  return !!(await integrations.mainGoogleToken(orgId)) || db.listAccountLinks(orgId, "calendar").length > 0;
}

/** Brings the list in line with every calendar Avery checks, then books or cancels bots to match. */
export async function syncCalendar(orgId: number, now = new Date(), force = false) {
  if (!force && now.getTime() - (lastSync.get(orgId) ?? 0) < 10 * MIN) return;
  lastSync.set(orgId, now.getTime());
  const { ops } = await opsFor(orgId);
  const n = ops.notetaker;
  const words = skipWordList(n);
  const from = new Date(now.getTime() - 30 * MIN);
  const to = new Date(now.getTime() + 2 * DAY);
  const read = await calendars.notetakerMeetings(orgId, from, to);
  lastRead.set(orgId, { hidden: read.hidden, failed: read.failed, sources: read.sources, at: now.getTime() });
  const events = read.meetings;
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
        await recordMeeting(orgId, (await db.getEmployeeByKind(orgId, "inbox"))?.id ?? null, billed);
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

/** Avery writes the notes (summary, decisions, open questions, action items) and sends them to Simone. Items go to Nora when Simone's setting is On its own. */
export async function writeNotes(orgId: number, id: number) {
  const row = await db.getNotetaker(id, orgId);
  if (!row?.transcript) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no transcript for this meeting yet." });
  const simone = await employeeFor(orgId, "coo");
  const avery = (await db.getEmployeeByKind(orgId, "inbox")) ?? simone;
  const { tz } = await opsFor(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const attendees = parse<Attendee[]>(row.attendees, []);
  const owner = await ownerOf(orgId);
  const names = Array.from(new Set([owner.name, ...attendees.map((a) => a.name), ...emps.map((e) => e.name)])).join(", ");
  const out = await working(avery, async () => {
    const { system } = await systemPromptFor(
      avery,
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
  const count = `${items.length} action item${items.length === 1 ? "" : "s"}${items.length ? ` (${mine} for you${emp ? `, ${emp} for the team` : ""})` : ""}`;
  const card = JSON.stringify([notesCard((await db.getNotetaker(id, orgId))!)]);
  const sameOne = avery.id === simone.id;
  // Simone gets the notes: her chat carries the card, the recap and what went to Nora.
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: simone.id,
    role: "employee",
    authorName: simone.name,
    content: `${sameOne ? `I sat in on ${row.title} and wrote the notes` : `${avery.name} sat in on ${row.title} and sent me the notes`}: ${count}.${gate(simone, "action_items") === "auto" && items.length ? " I sent the action items to Nora." : ""} The recap is ready when you are.`,
    cards: card,
  });
  // Avery says he was there and where the notes went.
  if (!sameOne) {
    await db.createChatMessage({
      organizationId: orgId,
      employeeId: avery.id,
      role: "employee",
      authorName: avery.name,
      content: `I sat in on ${row.title} and sent the notes to ${simone.name}: ${count}.`,
      cards: card,
    });
  }
  await logActivity(avery, "done", `Sat in on ${row.title} (${fmtDay(row.startsAt, tz)}) and sent the notes to ${simone.name}, with ${items.length} action item${items.length === 1 ? "" : "s"}.`, "/chats/coo/work?tab=notes");
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
  open.forEach((it, idx) => {
    const t = r.tasks[idx];
    if (t) {
      it.taskId = t.id;
      it.status = r.launchOf(t)?.pjListId ? "in_projects" : "task";
    } else it.status = "done"; // said the same thing as another item: already tracked
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
  if (row.lockReason && choice === "join") throw new TRPCError({ code: "BAD_REQUEST", message: `${row.lockReason}, so Avery never joins it. Change the never-join words on Avery's Onboarding tab if this is wrong.` });
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
  if (!(await hasCalendar(orgId))) return;
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
  if (!(await integrations.recallConnected(orgId))) return "Sitting in: Recall.ai is not connected on Integrations, so Avery is not joining any meetings.";
  if (!(await hasCalendar(orgId))) return "Sitting in: no calendar is connected on Integrations, so Avery has no meetings to join.";
  const v = await notetakerView(orgId);
  const joining = v.upcoming.filter((r) => r.status === "scheduled" || r.status === "joining" || r.status === "in_call").slice(0, 4);
  const recent = v.notes.filter((r) => r.status === "ready").slice(0, 3);
  const read = lastRead.get(orgId);
  return [
    `Sitting in next: ${joining.map((r) => `${r.title} (${fmtDay(r.startsAt, tz)} at ${fmtTime(r.startsAt, tz)})`).join("; ") || "nothing booked"}. Avery joins meetings with a Zoom or Google Meet link on the calendars connected on Integrations.`,
    read?.hidden.length ? `${read.hidden.join(" and ")} ${read.hidden.length === 1 ? "is" : "are"} set to busy times only, which hides meeting links, so Avery can't join meetings there.` : "",
    read?.failed.length ? `Couldn't read ${read.failed.join(" and ")}; reconnect on Integrations.` : "",
    `Recent notes: ${recent.map((r) => r.title).join("; ") || "none yet"}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The clock time someone typed ("11am", "4:00 PM"), as hour and minute, or null. */
function clockOf(t: string) {
  const m = t.toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return { h, mm: Number(m[2] ?? "0"), text: `${m[1]}:${m[2] ?? "00"}${m[3] ? ` ${m[3].toUpperCase()}` : ""}` };
}

/** Who is talking: Avery about herself, or a teammate (Simone) about Avery. */
export type Voice = "me" | "avery";
function voiceOf(who: Voice) {
  const first = who === "me";
  return {
    I: first ? "I" : "Avery",
    Im: first ? "I'm" : "Avery is",
    Ill: first ? "I'll" : "Avery will",
    my: first ? "my" : "Avery's",
    me: first ? "me" : "Avery",
    have: first ? "have" : "has",
    dont: first ? "don't" : "doesn't",
    s: (verb: string) => (first ? verb : `${verb}s`),
  };
}

/**
 * Why Avery isn't on a meeting someone named: in plain words, from the calendars themselves.
 * Reads the calendars again first, so a meeting added in the last few minutes is found.
 */
export async function explainMissing(orgId: number, target: string, who: Voice = "me"): Promise<string> {
  const V = voiceOf(who);
  const { ops, tz } = await opsFor(orgId);
  if (!(await integrations.recallConnected(orgId))) return `${V.Im} not joining any meetings right now: Recall.ai isn't connected on Integrations. Connect it there and ${V.Ill} start sitting in.`;
  if (!(await hasCalendar(orgId))) return `${V.I} ${V.have} no calendar to read yet. Connect Google on Integrations, or add your calendars under Calendars, and ${V.Ill} start sitting in.`;
  await syncCalendar(orgId, new Date(), true).catch(() => null);
  const again = await findMeeting(orgId, target, "upcoming");
  if (again) return sittingInLine(again, ops.notetaker, tz, who);
  const now = Date.now();
  const s = await calendars.schedule(orgId, new Date(now - 30 * MIN), new Date(now + 2 * DAY));
  const t = target.trim().toLowerCase();
  const clock = clockOf(t);
  const hits = s.events.filter((e) => {
    if (e.allDay) return false;
    if (t && e.title.toLowerCase().includes(t)) return true;
    if (!clock) return false;
    const at = new Date(e.start.toLocaleString("en-US", { timeZone: tz }));
    const sameHalf = !/am|pm/.test(t) || (clock.h < 12) === (at.getHours() < 12);
    return at.getHours() % 12 === clock.h % 12 && at.getMinutes() === clock.mm && sameHalf;
  });
  const read = lastRead.get(orgId);
  const where = read?.hidden.length ? ` ${read.hidden.join(" and ")} ${read.hidden.length === 1 ? "is" : "are"} set to busy times only on Integrations, which hides meeting links from ${V.me}; switch ${read.hidden.length === 1 ? "it" : "them"} to full details if the meeting is there.` : "";
  const failedNames = Array.from(new Set([...(read?.failed ?? []), ...s.failed]));
  const failed = failedNames.length ? ` ${V.I} also couldn't read ${failedNames.join(" and ")}; reconnect on Integrations.` : "";
  if (!hits.length) return `${V.I} ${V.dont} see ${clock ? `anything at ${clock.text}` : `a meeting like "${target.trim()}"`} in the next two days on the calendars ${V.I} ${V.s("check")} (${Array.from(new Set(s.events.map((e) => e.calendar))).join(", ") || "none read"}).${where}${failed}`;
  const e = hits[0];
  const when = `${fmtDay(e.start, tz)} at ${fmtTime(e.start, tz)}`;
  if (e.title === "Busy") return `Your ${when} is on ${e.calendar}, which is set to busy times only, so ${V.I} can only see that you're booked, not the meeting or its link. Switch ${e.calendar} to full details on Integrations and ${V.Ill} join it if it has a Zoom or Google Meet link.`;
  const lock = lockReasonFor(`${e.title} ${e.extra?.location ?? ""}`, skipWordList(ops.notetaker));
  if (lock) return `${e.title} (${when}) ${lock.toLowerCase()}, so ${V.I} never ${V.s("join")} it. Change the never-join words on ${V.my} Onboarding tab if that's wrong.`;
  if (!e.extra?.meeting) return `${e.title} (${when}, on ${e.calendar}) has no Zoom or Google Meet link, so ${V.I} can't join it. Add the link to the event and ${V.Ill} pick it up within 10 minutes.${failed}`;
  return `${e.title} (${when}, on ${e.calendar}) has a ${e.extra.meeting.platform === "zoom" ? "Zoom" : "Google Meet"} link but isn't on ${V.my} list yet. ${V.Ill} read the calendar again at the next check.${failed}`;
}

/** One line on where Avery stands with a meeting on the list. */
export function sittingInLine(r: ReturnType<typeof viewOf>, n: Notetaker, tz: string, who: Voice = "me") {
  const V = voiceOf(who);
  const when = `${fmtDay(r.startsAt, tz)} at ${fmtTime(r.startsAt, tz)}`;
  if (r.status === "in_call") return `${V.Im} in ${r.title} now, taking notes.`;
  if (r.status === "joining") return `${V.Im} joining ${r.title} now.`;
  if (r.status === "scheduled") return `Yes. ${V.I} ${V.s("join")} ${r.title} (${when}) a minute before it starts and ${V.s("send")} the notes to Simone after.`;
  if (r.lockReason) return `No. ${r.title} (${when}) ${r.lockReason.toLowerCase()}, so ${V.I} never ${V.s("join")} it. Change the never-join words on ${V.my} Onboarding tab if that's wrong.`;
  if (r.choice === "skip") return `No. ${r.title} (${when}) is marked Skip. Say "join it" and ${V.Ill} book it.`;
  if (r.error) return `${V.I} tried to book ${r.title} (${when}) and couldn't: ${r.error}`;
  if (n.joins === "picked" && r.choice !== "join") return `Not unless you say so. ${V.I} only ${V.s("join")} meetings you pick; say "join it" for ${r.title} (${when}) and ${V.Ill} book it.`;
  return `Yes. ${V.Ill} join ${r.title} (${when}) once it's close enough to book.`;
}

/** Whether Avery is joining a meeting, by name or time, in plain words. */
export async function sittingInReply(orgId: number, target: string, who: Voice = "me") {
  const { ops, tz } = await opsFor(orgId);
  const r = await findMeeting(orgId, target, "upcoming");
  if (r) return sittingInLine(r, ops.notetaker, tz, who);
  return explainMissing(orgId, target, who);
}
