import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import { KNOWLEDGE_CATEGORIES, type AIEmployee, type Huddle, type HuddleLine } from "../../drizzle/schema";
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
 *   own voice (ElevenLabs when ELEVENLABS_API_KEY is set, otherwise OpenAI text to
 *   speech), and is added to the transcript. When the
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

/** Why the last answer had no voice, shown on the Huddle screen so it can be fixed. */
let speechError: string | null = null;
export function lastSpeechError() {
  return speechError;
}

// ==========================================
// ElevenLabs voices
// ==========================================

/** How each employee sounds, so ElevenLabs voices are matched to them. */
const VOICE_STYLE: Record<string, "female" | "male"> = {
  coo: "female",
  projects: "female",
  grants: "female",
  speaking: "male",
  prospecting: "male",
  outreach: "female",
  leads: "male",
  social: "female",
  blog: "male",
  website: "female",
  video: "female",
  inbox: "male",
  hiring: "female",
};
const KIND_ORDER = Object.keys(VOICE_STYLE);

export type ElevenVoice = { voice_id: string; name: string; category?: string; labels?: Record<string, string> };

/**
 * Gives each employee a different ElevenLabs voice from the account's own voice list:
 * women's voices for the women, men's for the men, American accents first.
 * ELEVENLABS_VOICES (JSON, like {"coo":"<voice id>"}) picks a voice for anyone.
 */
export function assignVoices(voices: ElevenVoice[], overrides: Record<string, string> = {}) {
  const usable = voices.filter((v) => v.voice_id);
  const rank = (v: ElevenVoice) => ((v.labels?.accent ?? "").toLowerCase().includes("american") ? 0 : 1) + (v.category === "premade" ? 0 : 0.5);
  const pool = (g: string) => usable.filter((v) => (v.labels?.gender ?? "").toLowerCase() === g).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const lists: Record<string, ElevenVoice[]> = { female: pool("female"), male: pool("male") };
  const used = new Set(Object.values(overrides));
  const out: Record<string, string> = { ...overrides };
  for (const kind of KIND_ORDER) {
    if (out[kind]) continue;
    const list = lists[VOICE_STYLE[kind]].length ? lists[VOICE_STYLE[kind]] : usable;
    const pick = list.find((v) => !used.has(v.voice_id)) ?? list[0];
    if (pick) {
      out[kind] = pick.voice_id;
      used.add(pick.voice_id);
    }
  }
  if (!out.custom && usable[0]) out.custom = usable[0].voice_id;
  return out;
}

let elevenCache: { at: number; map: Record<string, string> } | null = null;

async function elevenVoiceFor(kind: string) {
  if (!elevenCache || Date.now() - elevenCache.at > 60 * 60_000) {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ENV.elevenLabsKey }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ElevenLabs didn't list voices (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { voices?: ElevenVoice[] };
    let overrides: Record<string, string> = {};
    try {
      overrides = JSON.parse(process.env.ELEVENLABS_VOICES || "{}");
    } catch {
      overrides = {};
    }
    elevenCache = { at: Date.now(), map: assignVoices(data.voices ?? [], overrides) };
  }
  return elevenCache.map[kind] ?? elevenCache.map.custom ?? null;
}

async function elevenSpeak(kind: string, text: string) {
  const voice = await elevenVoiceFor(kind);
  if (!voice) throw new Error("Your ElevenLabs account has no voices to use. Add voices in ElevenLabs, My Voices.");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ENV.elevenLabsKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: text.slice(0, 1200), model_id: ENV.elevenLabsModel }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = j?.detail?.message ?? (typeof j?.detail === "string" ? j.detail : body);
    } catch {
      /* not JSON */
    }
    throw new Error(`ElevenLabs didn't make the voice (${res.status}): ${msg}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** One answer in the employee's voice, as MP3. Returns null when speech is not set up, so the words still show. */
export async function speak(kind: string, text: string): Promise<string | null> {
  if (process.env.NODE_ENV === "test") return null;
  if (ENV.elevenLabsKey) {
    try {
      const id = keepAudio(await elevenSpeak(kind, text));
      speechError = null;
      return id;
    } catch (err) {
      speechError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      console.warn("[huddle] ElevenLabs failed:", speechError);
      // Out of credits or a key problem: keep talking with OpenAI's voices when that key is set.
      if (!ENV.openAiKey) return null;
      const fallback = speechError;
      const id = await openAiSpeak(kind, text);
      if (id) speechError = null;
      else speechError = `${fallback} OpenAI's voices didn't work either: ${speechError ?? "unknown error"}`.slice(0, 400);
      return id;
    }
  }
  return openAiSpeak(kind, text);
}

async function openAiSpeak(kind: string, text: string): Promise<string | null> {
  if (!ENV.openAiKey) {
    speechError = "Voices are not set up: OPENAI_API_KEY is missing on the server.";
    return null;
  }
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
      const body = (await res.text()).slice(0, 300);
      let msg = body;
      try {
        msg = JSON.parse(body)?.error?.message ?? body;
      } catch {
        /* not JSON */
      }
      speechError = `OpenAI didn't make the voice (${res.status}): ${msg}`.slice(0, 300);
      console.warn("[huddle] speech failed:", res.status, body);
      return null;
    }
    speechError = null;
    return keepAudio(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    speechError = `The voice didn't come back in time: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
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
    await learnFromHuddle(orgId, h, lines).catch((err) => console.warn("[huddle] learning failed:", err instanceof Error ? err.message : err));
  }
  return db.getHuddle(id, orgId)!;
}

/** New lasting facts people said in the huddle go to the Brain, so nobody repeats them. */
async function learnFromHuddle(orgId: number, h: Huddle, lines: HuddleLine[]) {
  const said = lines.filter((l) => !l.kind);
  if (!said.length) return [];
  const brain = await loadBrain(orgId);
  const known = brain.entries.filter((e) => e.title.startsWith("Learned: ") || e.title.startsWith("Company training: ")).map((e) => e.title).join("; ");
  const out = await generateJson<{ facts: { topic: string; fact: string; category: string }[] }>({
    system: `From a team huddle transcript, list only new, lasting facts about the business that people stated (an offer or price, who the customers are, a person on the team, a tool, an important date, how the whole team should work). Not tasks, not opinions, not one-off plans, not anything the employees said. Never client names or anything about a client's health, passwords or codes. topic: 2 to 5 words. fact: one plain sentence. category: one of ${KNOWLEDGE_CATEGORIES.join(", ")}. At most 5; [] when there are none. Already known topics: ${known || "none"}.`,
    prompt: lines.map((l) => `${l.who}${l.kind ? " (employee)" : ""}: ${l.text}`).join("\n").slice(0, 30_000),
    schemaName: "huddle_facts",
    schema: obj({ facts: { type: "array", items: obj({ topic: str, fact: str, category: str }) } }),
    maxTokens: 800,
  });
  const { learnFact } = await import("./learn");
  const saved = [];
  for (const f of (out.facts ?? []).slice(0, 5)) {
    const r = await learnFact(orgId, { topic: f.topic, fact: f.fact, category: f.category, who: h.startedByName, via: "the team huddle" });
    if (r) saved.push(r);
  }
  return saved;
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
