import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import type { AIEmployee, Huddle, HuddleLine } from "../../drizzle/schema";
import { loadBrain } from "./brain";
import { BASE_RULES } from "./roster";

/**
 * Team huddles: you talk, the employees answer out loud.
 * - In the app, the browser streams your microphone to AssemblyAI for live
 *   transcription (a short-lived token from here, so the key never leaves the
 *   server) and sends each finished sentence to say().
 * - In a Zoom or Meet, a Recall.ai bot joins as "LeadDash Team (AI)": Recall sends
 *   each finished line people say to our webhook, and the bot's camera is the
 *   huddle page, which plays each answer into the meeting.
 * - Each answer comes from the employee's own facts, is spoken in that employee's
 *   own voice (OpenAI text to speech), and is added to the transcript. When the
 *   huddle ends, Simone turns the transcript into notes and action items for Nora.
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const BOT_NAME = "LeadDash Team (AI)";
const MAX_MINUTES = 120;
const MAX_LINES = 400;

/** Each employee's own voice. Stock voices only; none imitates a real person. */
export const VOICES: Record<string, string> = {
  coo: "coral",
  projects: "sage",
  grants: "marin",
  speaking: "cedar",
  prospecting: "echo",
  outreach: "shimmer",
  leads: "onyx",
  social: "nova",
  blog: "verse",
  website: "alloy",
  video: "ballad",
  inbox: "fable",
  hiring: "ash",
  custom: "alloy",
};

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function linesOf(h: Pick<Huddle, "transcript">) {
  return parse<HuddleLine[]>(h.transcript, []);
}

// ==========================================
// Spoken audio, kept in memory for a few minutes
// ==========================================

const audio = new Map<string, { buf: Buffer; at: number }>();
const AUDIO_TTL = 15 * 60_000;

export function audioClip(id: string) {
  const hit = audio.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > AUDIO_TTL) {
    audio.delete(id);
    return null;
  }
  return hit.buf;
}

function keepAudio(buf: Buffer) {
  for (const [k, v] of Array.from(audio.entries())) if (Date.now() - v.at > AUDIO_TTL) audio.delete(k);
  const id = crypto.randomBytes(16).toString("hex");
  audio.set(id, { buf, at: Date.now() });
  return id;
}

/** One answer in the employee's voice, as MP3. Returns null when speech is not set up, so the words still show. */
export async function speak(kind: string, text: string): Promise<string | null> {
  if (!ENV.openAiKey || process.env.NODE_ENV === "test") return null;
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${ENV.openAiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: VOICES[kind] ?? "alloy",
        input: text.slice(0, 1200),
        instructions: "Speak like a warm, confident colleague in a team meeting: natural pace, conversational, never robotic.",
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn("[huddle] speech failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    return keepAudio(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.warn("[huddle] speech failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** A short-lived AssemblyAI token so the browser can stream the microphone without the key. */
export async function listenToken() {
  if (!ENV.assemblyAiKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Listening is not set up yet: ASSEMBLYAI_API_KEY is missing on the server." });
  const res = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=600", { headers: { authorization: ENV.assemblyAiKey }, signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) throw new TRPCError({ code: "BAD_GATEWAY", message: `AssemblyAI didn't give a listening token${data.error ? `: ${data.error}` : ""}.` });
  return { token: data.token, url: "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le&format_turns=true" };
}

// ==========================================
// Starting and ending
// ==========================================

async function members(orgId: number, kinds: string[]) {
  const all = (await db.listEmployeesByOrg(orgId)).filter((e) => e.status !== "paused");
  return kinds.length ? all.filter((e) => kinds.includes(e.kind)) : all;
}

export async function startHuddle(orgId: number, who: { id: number | null; name: string }, kinds: string[] = []) {
  const live = db.listHuddles(orgId, 5).find((h) => h.status === "live");
  if (live) return live;
  const emps = await members(orgId, kinds);
  if (!emps.length) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no active employee to huddle with. Resume someone first." });
  return db.createHuddle({ organizationId: orgId, startedBy: who.id, startedByName: who.name, kinds: JSON.stringify(emps.map((e) => e.kind)), token: crypto.randomBytes(24).toString("hex") });
}

export function setMembers(orgId: number, id: number, kinds: string[]) {
  const h = db.getHuddle(id, orgId);
  if (!h || h.status !== "live") throw new TRPCError({ code: "NOT_FOUND", message: "That huddle has ended." });
  return db.updateHuddle(id, orgId, { kinds: JSON.stringify(Array.from(new Set(kinds)).slice(0, 20)) });
}

function appUrl() {
  return (ENV.appUrl || "").replace(/\/$/, "");
}

/** Sends the team into a Zoom or Meet now. */
export async function bringToMeeting(orgId: number, id: number, meetingUrl: string) {
  const h = db.getHuddle(id, orgId);
  if (!h || h.status !== "live") throw new TRPCError({ code: "NOT_FOUND", message: "Start a huddle first." });
  if (!/^https:\/\/([a-z0-9-]+\.)*(zoom\.us|zoom\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com)\//i.test(meetingUrl.trim())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Paste a Zoom, Google Meet, Teams or Webex meeting link." });
  }
  if (!/^https:\/\//.test(appUrl())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "APP_URL must be the app's public https address so the meeting bot can reach it." });
  if (h.botId) await integrations.removeRecallBot(orgId, h.botId).catch(() => null);
  const botId = await integrations.createRecallTeamBot(orgId, {
    meetingUrl: meetingUrl.trim(),
    botName: BOT_NAME,
    pageUrl: `${appUrl()}/voice/bot/${h.token}`,
    webhookUrl: `${appUrl()}/api/voice/bot/${h.token}/transcript`,
    message: `Hi, this is the LeadDash Team: AI employees for ${h.startedByName.split(" ")[0]}. We're listening to this meeting and may answer out loud. Say a name (like Simone or Nora) to ask one of us directly.`,
  });
  return db.updateHuddle(id, orgId, { meetingUrl: meetingUrl.trim(), botId });
}

export async function takeOut(orgId: number, id: number) {
  const h = db.getHuddle(id, orgId);
  if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "That huddle is not in this workspace." });
  if (h.botId) await integrations.removeRecallBot(orgId, h.botId).catch(() => null);
  return db.updateHuddle(id, orgId, { botId: null });
}

/** Ends the huddle; Simone turns the transcript into notes and action items (Nora gets the items). */
export async function endHuddle(orgId: number, id: number) {
  const h = db.getHuddle(id, orgId);
  if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "That huddle is not in this workspace." });
  if (h.status === "ended") return h;
  if (h.botId) await integrations.removeRecallBot(orgId, h.botId).catch(() => null);
  let ended = db.updateHuddle(id, orgId, { status: "ended", endedAt: new Date(), botId: null })!;
  const lines = linesOf(h);
  if (lines.filter((l) => !l.kind).length >= 1 && lines.length >= 2) {
    try {
      const org = await db.getOrganizationById(orgId);
      const tz = org?.timezone || "America/Chicago";
      const owner = (await db.listMembers(orgId)).find((m) => m.name === h.startedByName || m.userId === h.startedBy);
      const startedAt = new Date(h.createdAt);
      const m = await db.createMeeting({
        organizationId: orgId,
        title: `Team huddle, ${startedAt.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" })}`,
        startsAt: startedAt,
        minutes: Math.max(5, Math.round((Date.now() - startedAt.getTime()) / 60_000)),
        attendees: JSON.stringify(owner ? [{ name: owner.name || owner.email, email: owner.email }] : []),
        updatesFrom: JSON.stringify(parse<string[]>(h.kinds, [])),
        status: "held",
        linkKind: "meet",
      });
      ended = db.updateHuddle(id, orgId, { meetingId: m.id })!;
      const { saveNotes } = await import("./coo");
      await saveNotes(orgId, m.id, lines.map((l) => `${l.who}: ${l.text}`).join("\n"), "transcript");
    } catch (err) {
      console.warn("[huddle] notes failed:", err instanceof Error ? err.message : err);
    }
  }
  return db.getHuddle(id, orgId)!;
}

// ==========================================
// Talking
// ==========================================

const factsCache = new Map<string, { text: string; at: number }>();

async function factsOf(emp: AIEmployee) {
  const key = `${emp.organizationId}:${emp.id}`;
  const hit = factsCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.text;
  const { factsFor } = await import("./onboarding");
  let text = "";
  try {
    text = (await factsFor(emp)).slice(0, 1600);
    if (emp.kind === "projects") text = `${text}\n${(await (await import("./projects")).projectsStatus(emp.organizationId)).slice(0, 1600)}`;
    if (emp.kind === "coo") text = `${text}\n${(await (await import("./coo")).cooStatus(emp.organizationId)).slice(0, 1600)}`;
  } catch {
    text = text || "No facts available right now.";
  }
  factsCache.set(key, { text, at: Date.now() });
  return text;
}

export type Reply = { kind: string; name: string; text: string; audioId: string | null; index: number };

/** Someone said something. The right employees (often none) answer out loud. */
export async function say(orgId: number, id: number, who: string, text: string): Promise<{ huddle: Huddle; replies: Reply[] }> {
  let h = db.getHuddle(id, orgId);
  if (!h || h.status !== "live") throw new TRPCError({ code: "BAD_REQUEST", message: "This huddle has ended." });
  if (Date.now() - new Date(h.createdAt).getTime() > MAX_MINUTES * 60_000) {
    await endHuddle(orgId, id);
    throw new TRPCError({ code: "BAD_REQUEST", message: `Huddles end after ${MAX_MINUTES} minutes. Start a new one to keep going.` });
  }
  const said = text.trim().slice(0, 2000);
  if (!said) return { huddle: h, replies: [] };
  const lines = [...linesOf(h), { who: who.slice(0, 80), kind: null, text: said, at: Date.now() }].slice(-MAX_LINES);
  h = db.updateHuddle(id, orgId, { transcript: JSON.stringify(lines) })!;

  const emps = await members(orgId, parse<string[]>(h.kinds, []));
  if (!emps.length) return { huddle: h, replies: [] };
  const brain = await loadBrain(orgId);
  const facts = await Promise.all(emps.map(async (e) => `## ${e.name} (job key: ${e.kind}, ${e.roleTitle})\n${await factsOf(e)}`));
  const org = await db.getOrganizationById(orgId);
  const now = new Date().toLocaleString("en-US", { timeZone: org?.timezone || "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

  let out: { replies: { kind: string; say: string }[] };
  try {
    out = await generateJson<{ replies: { kind: string; say: string }[] }>({
      system: `You are the voices of ${brain.org?.name ?? "the company"}'s AI employees in a live team huddle, spoken out loud. Right now it is ${now}.
Who speaks after the latest line:
- An employee answers when they are named, when the question is clearly about their work, or when the speaker asks the whole team. Otherwise nobody answers (replies is []): people talking to each other, thinking out loud or saying thanks need no answer.
- At most 2 employees answer, the most relevant first. Never two employees saying the same thing.
- If an employee just spoke and the person is answering them, that employee can follow up.
How they speak:
- 1 to 3 short spoken sentences each, like a colleague in a meeting. No lists, no headings, no markdown, no emojis, no em dashes.
- Use only each employee's facts below. Say dates the way people say them ("Friday, November 6"). If they don't know, they say so and offer to check after the huddle.
- Never say a client's name or anything about a client's health.
- When asked to do something, they say they'll do it after the huddle (Simone's notes turn it into a task).

${BASE_RULES}

The employees in this huddle and what each one knows:
${facts.join("\n\n")}`,
      prompt: `Transcript so far (latest last):\n${lines.slice(-30).map((l) => `${l.who}: ${l.text}`).join("\n")}`,
      schemaName: "huddle_turn",
      schema: obj({ replies: { type: "array", items: obj({ kind: str, say: str }) } }),
      maxTokens: 700,
    });
  } catch (err) {
    console.warn("[huddle] turn failed:", err instanceof Error ? err.message : err);
    return { huddle: h, replies: [] };
  }

  const picked = (out.replies ?? [])
    .map((r) => ({ emp: emps.find((e) => e.kind === r.kind || e.name.toLowerCase() === r.kind.toLowerCase()), say: (r.say ?? "").replace(/\s*[—–]\s*/g, ", ").trim() }))
    .filter((r): r is { emp: AIEmployee; say: string } => !!r.emp && !!r.say)
    .slice(0, 2);
  if (!picked.length) return { huddle: h, replies: [] };

  const clips = await Promise.all(picked.map((r) => speak(r.emp.kind, r.say)));
  const fresh = db.getHuddle(id, orgId)!;
  const all = linesOf(fresh);
  const replies: Reply[] = picked.map((r, i) => {
    all.push({ who: r.emp.name, kind: r.emp.kind, text: r.say, at: Date.now() + i });
    return { kind: r.emp.kind, name: r.emp.name, text: r.say, audioId: clips[i], index: all.length - 1 };
  });
  h = db.updateHuddle(id, orgId, { transcript: JSON.stringify(all.slice(-MAX_LINES)) })!;
  rememberClips(id, replies);
  return { huddle: h, replies };
}

// ==========================================
// The meeting bot
// ==========================================

/** Recall's webhook: a finished line someone said in the meeting. */
export async function botHeard(token: string, payload: unknown) {
  const h = db.huddleByToken(token);
  if (!h || h.status !== "live") return { ok: false };
  const p = payload as { event?: string; data?: { data?: { words?: { text?: string }[]; participant?: { name?: string | null } } } };
  if (p?.event && p.event !== "transcript.data") return { ok: true };
  const d = p?.data?.data;
  const text = (d?.words ?? []).map((w) => w.text ?? "").join(" ").replace(/\s+/g, " ").trim();
  const name = (d?.participant?.name ?? "").trim() || "Someone";
  if (!text || name === BOT_NAME) return { ok: true };
  await say(h.organizationId, h.id, name, text).catch((err) => console.warn("[huddle] bot turn failed:", err instanceof Error ? err.message : err));
  return { ok: true };
}

/** What the bot's page plays next: employee lines after the given index, with their audio. */
export function botNext(token: string, after: number) {
  const h = db.huddleByToken(token);
  if (!h) return { live: false, lines: [] as { index: number; kind: string; name: string; text: string; audioId: string | null }[] };
  const lines = linesOf(h)
    .map((l, index) => ({ ...l, index }))
    .filter((l) => l.index > after && l.kind)
    .map((l) => ({ index: l.index, kind: l.kind!, name: l.who, text: l.text, audioId: clipFor(h.id, l.index) }));
  return { live: h.status === "live", lines };
}

// Lines spoken by an employee keep a pointer to their clip so the bot page can play them.
const clipIndex = new Map<string, string>();
export function rememberClips(huddleId: number, replies: Reply[]) {
  for (const r of replies) if (r.audioId) clipIndex.set(`${huddleId}:${r.index}`, r.audioId);
}
function clipFor(huddleId: number, index: number) {
  return clipIndex.get(`${huddleId}:${index}`) ?? null;
}

export async function botPageData(token: string) {
  const h = db.huddleByToken(token);
  if (!h) return null;
  const emps = await members(h.organizationId, parse<string[]>(h.kinds, []));
  return { emps: emps.map((e) => ({ kind: e.kind, name: e.name, role: e.roleTitle })), lastIndex: linesOf(h).length - 1 };
}

export function huddleView(h: Huddle) {
  const { token: _t, ...rest } = h;
  return { ...rest, kinds: parse<string[]>(h.kinds, []), lines: linesOf(h), inMeeting: !!h.botId };
}
