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
  developer: "echo",
  onboarding: "shimmer",
  platform: "sage",
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
  developer: "male",
  onboarding: "female",
  platform: "female",
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

export async function elevenVoiceFor(kind: string) {
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
    body: JSON.stringify({ text: text.slice(0, 1600), model_id: ENV.elevenLabsModel }),
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
    throw new Error(outOfCredits(body) ? ELEVEN_EMPTY : `ElevenLabs didn't make the voice (${res.status}): ${msg}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export const ELEVEN_EMPTY = "ElevenLabs is out of voice credits. Add credits or move up a plan at elevenlabs.io/app/subscription, and the voices come back on the next answer.";
export const OPENAI_EMPTY = "OpenAI is out of credits. Add credits at platform.openai.com/settings/organization/billing.";
/** The voice service's answer says the account has no credits left. */
export function outOfCredits(body: string) {
  return /quota_exceeded|insufficient_quota|exceeds your quota|credits? (remaining|left)|out of credits|exceeded your current quota/i.test(body);
}

/**
 * The words as they should sound: web addresses are said the way people say them
 * ("leaddash.io" is "LeadDash dot I O"), using the company's own spelling of its name.
 */
export function speakable(text: string, company = "") {
  const name = company.replace(/[^A-Za-z0-9 ]/g, "").trim();
  const spoken = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return text
    .replace(/\bhttps?:\/\//gi, "")
    .replace(/\bwww\./gi, "")
    .replace(/\b([a-z0-9-]+)\.(io|ai|com|org|net|co|app)\b(\/[^\s,]*)?/gi, (_m, label: string, tld: string) => {
      const said = name && label.toLowerCase() === name.replace(/\s+/g, "").toLowerCase() ? spoken : label;
      const end = { io: "I O", ai: "A I", co: "co", app: "app" }[tld.toLowerCase()] ?? tld.toLowerCase();
      return `${said} dot ${end}`;
    });
}

/** One answer in the employee's voice, as MP3. Returns null when speech is not set up, so the words still show. */
export async function speak(kind: string, words: string, company = ""): Promise<string | null> {
  if (process.env.NODE_ENV === "test") return null;
  const text = speakable(words, company);
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
        input: text.slice(0, 1600),
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
      speechError = outOfCredits(body) ? OPENAI_EMPTY : `OpenAI didn't make the voice (${res.status}): ${msg}`.slice(0, 300);
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
  const known = brain.entries
    .filter((e) => e.title.startsWith("Learned: "))
    .map((e) => `- ${e.title.slice("Learned: ".length)}: ${e.content.split("\n(")[0].slice(0, 200)}`)
    .slice(0, 80)
    .join("\n");
  const out = await generateJson<{ facts: { topic: string; fact: string; category: string }[] }>({
    system: `From a team huddle transcript, list the lasting facts and decisions about the business that people stated or agreed on: an offer, price or deadline, a launch date, a title, who the customers are, a person on the team (with the exact spelling of their name), a tool the team uses or stopped using, how the whole team should work. Not small tasks, not opinions, not anything only the employees said. Never client names or anything about a client's health, passwords or codes.
When a decision changes or ends something already known (below), reuse that exact topic so the old fact is replaced, and say what is true now (for example topic "Founding member offer", fact "The founding member offer is removed from the site as of Oct 8, 2026; it is no longer offered.").
topic: 2 to 5 words. fact: one or two plain sentences with full dates, including the year. category: one of ${KNOWLEDGE_CATEGORIES.join(", ")}. At most 12; [] when there are none.
Already known:
${known || "nothing yet."}`,
    prompt: lines.map((l) => `${l.who}${l.kind ? " (employee)" : ""}: ${l.text}`).join("\n").slice(0, 60_000),
    schemaName: "huddle_facts",
    schema: obj({ facts: { type: "array", items: obj({ topic: str, fact: str, category: str }) } }),
    maxTokens: 2000,
  });
  const { learnFact } = await import("./learn");
  const saved = [];
  for (const f of (out.facts ?? []).slice(0, 12)) {
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
    if (emp.kind === "coo") text = `${text}\n${(await (await import("./coo")).cooStatus(emp.organizationId)).slice(0, 1600)}\n${await busyLine(emp.organizationId)}`;
  } catch {
    text = text || "No facts available right now.";
  }
  factsCache.set(key, { text, at: Date.now() });
  return text;
}

/** The owner's calendar for the next 7 days, so Simone never offers a time that's taken. */
export async function busyLine(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const google = await db.getConnectionByProvider(orgId, "google_workspace");
  const linked = db.listAccountLinks(orgId, "calendar").length > 0;
  if (google?.status !== "connected" && !linked) return "The owner's calendar: not connected, so you can't see it. Say so if a time comes up, and offer to check once Google is connected on Integrations.";
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86400_000);
  const busy = linked ? await (await import("./calendars")).busyAll(orgId, from, to).catch(() => null) : await integrations.calendarBusy(orgId, from, to).catch(() => null);
  if (!busy) return "The owner's calendar: connected, but it didn't load just now. Say you'll check it right after the huddle.";
  const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const rows = busy
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, 60)
    .map((b) => (b.end.getTime() - b.start.getTime() >= 20 * 3600_000 ? `${day(b.start)}: busy all day` : `${day(b.start)}: busy ${time(b.start)} to ${time(b.end)}`));
  return `The owner's calendar for the next 7 days (you can see it; never say you can't). Busy times:\n${rows.length ? rows.join("\n") : "nothing booked."}\nOnly suggest a meeting time that is open here, inside working hours.`;
}

export type Reply = { kind: string; name: string; text: string; audioId: string | null; index: number };

const turns = new Map<number, Promise<unknown>>();
const waiting = new Map<number, number>();

/** Someone said something. The right employees (often none) answer out loud, one turn at a time so nobody talks over anyone. */
export function say(orgId: number, id: number, who: string, text: string): Promise<{ huddle: Huddle; replies: Reply[] }> {
  const prev = turns.get(id) ?? Promise.resolve();
  waiting.set(id, (waiting.get(id) ?? 0) + 1);
  const run = prev.catch(() => null).then(() => {
    const left = (waiting.get(id) ?? 1) - 1;
    waiting.set(id, left);
    // More lines came in while the last answer was being made: this line goes in the transcript and the newest line gets the answer, with all of it in view.
    return sayNow(orgId, id, who, text, left === 0);
  });
  const tail = run.catch(() => null);
  turns.set(id, tail);
  void tail.finally(() => {
    if (turns.get(id) === tail) turns.delete(id);
  });
  return run;
}

/** Same words, ignoring case and punctuation. */
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function sayNow(orgId: number, id: number, who: string, text: string, answer = true): Promise<{ huddle: Huddle; replies: Reply[] }> {
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
  if (!answer) return { huddle: h, replies: [] };

  const emps = await members(orgId, parse<string[]>(h.kinds, []));
  if (!emps.length) return { huddle: h, replies: [] };
  const brain = await loadBrain(orgId);
  const people = (await db.listMembers(orgId)).map((m) => m.name).filter((n): n is string => !!n && !!n.trim());
  // The opening is where the person says what the meeting is about and how it should go; it stays in view all meeting.
  const opening = lines.length > 50 ? lines.slice(0, 10) : [];
  const recent = lines.slice(opening.length ? -40 : -50);
  const facts = await Promise.all(emps.map(async (e) => `## ${e.name} (job key: ${e.kind}, ${e.roleTitle})\n${await factsOf(e)}`));
  const org = await db.getOrganizationById(orgId);
  const now = new Date().toLocaleString("en-US", { timeZone: org?.timezone || "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

  let out: { replies: { kind: string; say: string; do: string }[] };
  try {
    out = await generateJson<{ replies: { kind: string; say: string; do: string }[] }>({
      system: `You are the voices of ${brain.org?.name ?? "the company"}'s AI employees in a live team huddle, spoken out loud. Right now it is ${now}.
Who speaks after the latest line:
- An employee answers only when they are named, when a question is put to them or to the whole team, or when the person is answering something that employee just said. Otherwise nobody answers (replies is []): people talking to each other, thinking out loud, half-finished sentences, "okay", "thanks", "let me see" and the like need no answer. When in doubt, stay quiet; a person can always say a name.
- One employee answers unless the whole team was asked; at most 2, and the second only adds something new. Never two employees saying the same thing, and never repeat what you or a teammate already said in this huddle unless someone asks for it again.
- When asked to repeat something, say it once, word for word, and stop.
The meeting:
- Stay on what this meeting is about. The people say it, usually at the start ("this meeting is about..."); follow it, and follow any instruction they gave about how the meeting should go for the rest of it. Never bring up other topics (approvals waiting, other meetings, other projects) unless a person asks.
- Share in the meeting. When asked for something you can say (a title, ideas, a plan, numbers, a short draft, a decision), say it now, out loud, in full. Never answer with "I'll post it in my chat" or "I'll send it after": that defeats the point of the meeting. For a long piece (a full page, an email, a document), say the main points now; the full piece also goes in your chat.
- Tasks and projects live in this app's Projects tab. Never mention or point anyone to an outside task tool (ClickUp, Asana, Trello, Monday) unless a person asks about it by name.
- Before suggesting a meeting time, check the owner's calendar in Simone's facts and suggest only open times.
How they speak:
- Like a colleague in a meeting: 1 to 3 short spoken sentences for a quick answer; up to 8 when sharing what was asked for. No headings, no markdown, no emojis, no em dashes. Several items are said as a short spoken run ("First... Second...").
- Use only each employee's facts below and what was said in this meeting; a decision made in this meeting replaces older facts. Say dates the way people say them ("Friday, November 6"). If they don't know, they say so and offer to check right after the huddle.
- Spell people's names exactly as they are written here.${people.length ? ` People on the team: ${people.join(", ")}.` : ""}
- Never say a client's name or anything about a client's health.
- When asked to make or do something, the employee starts it now, during the huddle: put the request, as a complete instruction they can act on alone, in "do" (for example "Write the November 10 webinar follow-up email to all registrants"). In "say" they share what they can right now, per the rule above. "do" is "" when nothing was asked of them.

${BASE_RULES}

The employees in this huddle and what each one knows:
${facts.join("\n\n")}`,
      prompt: `${opening.length ? `How the meeting opened:\n${opening.map((l) => `${l.who}: ${l.text}`).join("\n")}\n...\n\n` : ""}Transcript so far (latest last):\n${recent.map((l) => `${l.who}: ${l.text}`).join("\n")}`,
      schemaName: "huddle_turn",
      schema: obj({ replies: { type: "array", items: obj({ kind: str, say: str, do: str }) } }),
      maxTokens: 1400,
    });
  } catch (err) {
    console.warn("[huddle] turn failed:", err instanceof Error ? err.message : err);
    return { huddle: h, replies: [] };
  }

  const picked = (out.replies ?? [])
    .map((r) => ({ emp: emps.find((e) => e.kind === r.kind || e.name.toLowerCase() === r.kind.toLowerCase()), say: (r.say ?? "").replace(/\s*[—–]\s*/g, ", ").trim(), do: (r.do ?? "").trim() }))
    .filter((r): r is { emp: AIEmployee; say: string; do: string } => !!r.emp && !!r.say)
    // The same words twice is never an answer (unless they were asked to say it again).
    .filter((r, i, all) => all.findIndex((x) => norm(x.say) === norm(r.say)) === i)
    .filter((r) => /\b(repeat|again|one more time|say that)\b/i.test(said) || !lines.slice(-12).some((l) => l.kind && norm(l.text) === norm(r.say)))
    .filter((r, i, all) => all.findIndex((x) => x.emp.id === r.emp.id) === i)
    .slice(0, 2);
  if (!picked.length) return { huddle: h, replies: [] };
  // Work asked for in the huddle starts now, in that employee's own chat, not after the huddle ends.
  for (const r of picked) if (r.do) startWork(orgId, r.emp, who, r.do);

  const clips = await Promise.all(picked.map((r) => speak(r.emp.kind, r.say, brain.org?.name ?? "")));
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

const working = new Set<Promise<unknown>>();
/** Tests wait on work started from a huddle. */
export async function settled() {
  await Promise.all(Array.from(working));
}

/** The request goes through the employee's chat as if the person had typed it there, so the action runs and the result lands in that chat. */
function startWork(orgId: number, emp: AIEmployee, who: string, ask: string) {
  const p = (async () => {
    const { sendChatMessage } = await import("./chat");
    await sendChatMessage({ organizationId: orgId, employeeId: emp.id, text: ask, authorName: `${who} (in the huddle)`, userId: null });
  })().catch((err) => console.warn(`[huddle] ${emp.name} could not start work:`, err instanceof Error ? err.message : err));
  working.add(p);
  void p.finally(() => working.delete(p));
}

// ==========================================
// Someone is talking: the employees stop
// ==========================================

/** When a person last spoke, by huddle. The bot page stops playing while a person is talking. */
const talking = new Map<number, number>();
const HUSH_MS = 2500;

export function personTalking(huddleId: number) {
  talking.set(huddleId, Date.now());
}

export function hushed(huddleId: number) {
  return Date.now() - (talking.get(huddleId) ?? 0) < HUSH_MS;
}

// ==========================================
// The meeting bot
// ==========================================

/** Recall's webhook: a finished line someone said in the meeting. */
export async function botHeard(token: string, payload: unknown) {
  const h = db.huddleByToken(token);
  if (!h || h.status !== "live") return { ok: false };
  const p = payload as { event?: string; data?: { data?: { words?: { text?: string }[]; participant?: { name?: string | null } } } };
  const d = p?.data?.data;
  const name = (d?.participant?.name ?? "").trim() || "Someone";
  const text = (d?.words ?? []).map((w) => w.text ?? "").join(" ").replace(/\s+/g, " ").trim();
  // A person has started talking (a partial line): the employees go quiet at once. A single
  // sound ("mm") doesn't count, and neither does the team's own voice coming back through
  // someone's speakers into their microphone.
  if (p?.event === "transcript.partial_data") {
    if (name !== BOT_NAME && text.split(" ").length >= 2 && !isEcho(h, text)) personTalking(h.id);
    return { ok: true };
  }
  if (p?.event && p.event !== "transcript.data") return { ok: true };
  if (!text || name === BOT_NAME) return { ok: true };
  if (isEcho(h, text)) {
    console.warn(`[huddle] ignored ${name}'s line: it was the team's own voice coming back through their speakers.`);
    return { ok: true };
  }
  personTalking(h.id);
  await say(h.organizationId, h.id, name, text).catch((err) => console.warn("[huddle] bot turn failed:", err instanceof Error ? err.message : err));
  return { ok: true };
}

/** The words are what an employee just said out loud, picked up again by a person's microphone. */
export function isEcho(h: Pick<Huddle, "transcript">, text: string) {
  const said = norm(text);
  const words = said.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  const recent = linesOf(h).filter((l) => l.kind && Date.now() - l.at < 90_000);
  return recent.some((l) => {
    const line = norm(l.text);
    if (line.includes(said)) return true;
    const have = new Set(line.split(" "));
    return words.length >= 4 && words.filter((w) => have.has(w)).length / words.length >= 0.8;
  });
}

/** What the bot's page plays next: employee lines after the given index, with their audio; hush while a person is talking. */
export function botNext(token: string, after: number) {
  const h = db.huddleByToken(token);
  if (!h) return { live: false, hush: false, lines: [] as { index: number; kind: string; name: string; text: string; audioId: string | null; age: number }[] };
  const lines = linesOf(h)
    .map((l, index) => ({ ...l, index }))
    .filter((l) => l.index > after && l.kind)
    .map((l) => ({ index: l.index, kind: l.kind!, name: l.who, text: l.text, audioId: clipFor(h.id, l.index), age: Math.max(0, Date.now() - l.at) }));
  return { live: h.status === "live", hush: hushed(h.id), lines };
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
