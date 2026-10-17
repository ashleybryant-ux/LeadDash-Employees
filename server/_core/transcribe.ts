import { ENV } from "./env";
import { AiNotConfiguredError } from "./llm";

/**
 * Turns a recorded file into text, with every word timed.
 *
 * The cheapest route first (2026-10-17, the owner's choice): Groq's Whisper large-v3-turbo at
 * $0.04 an hour of audio, against AssemblyAI's Universal-2 at $0.15. Groq has no BAA, so:
 * - Groq only for a workspace that is not a healthcare practice, and only when the caller says
 *   which workspace (orgId); anything that can't say goes to AssemblyAI.
 * - A healthcare practice's recordings always go to AssemblyAI (the same account and BAA DashNotes uses).
 * - Groq down, over its size limit, or not set up (GROQ_API_KEY): AssemblyAI, so nothing stops.
 * Words carry timestamps so captions land on each word and a step can be matched to the moment it was said.
 */

export type Word = { text: string; start: number; end: number };
export type Transcript = { text: string; words: Word[]; seconds: number };

const API = "https://api.assemblyai.com/v2";
const GROQ = "https://api.groq.com/openai/v1/audio/transcriptions";
/** Groq takes files up to 25 MB as an upload; a bigger one goes to AssemblyAI. */
export const GROQ_MAX_BYTES = 24 * 1024 * 1024;

/** Which service a workspace's recording goes to. */
export async function routeFor(orgId: number | null | undefined, bytes: number): Promise<"groq" | "assemblyai"> {
  if (!ENV.groqKey || !orgId || bytes > GROQ_MAX_BYTES) return "assemblyai";
  const db = await import("../db");
  const org = await db.getOrganizationById(orgId);
  if (!org || org.orgType === "healthcare") return "assemblyai";
  return "groq";
}

export async function transcribeFile(buf: Buffer, opts: { timeoutMs?: number; orgId?: number | null } = {}): Promise<Transcript> {
  if ((await routeFor(opts.orgId, buf.length)) === "groq") {
    try {
      return await withGroq(buf, opts.timeoutMs);
    } catch (err) {
      console.warn("[transcribe] Groq didn't transcribe it, using AssemblyAI:", err instanceof Error ? err.message : err);
    }
  }
  return withAssemblyAi(buf, opts);
}

/**
 * Whisper times each word but leaves its punctuation and capitals in the full text, and the editor
 * breaks lines at a period or comma. So each timed word takes its spelling from the text, in order.
 */
export function punctuate(text: string, words: Word[]): Word[] {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, "");
  const toks = text.split(/\s+/).filter(Boolean);
  let at = 0;
  return words.map((w) => {
    const want = plain(w.text);
    for (let k = at; k < Math.min(toks.length, at + 4); k++) {
      if (plain(toks[k]) === want) {
        at = k + 1;
        return { ...w, text: toks[k] };
      }
    }
    return { ...w, text: w.text.trim() };
  });
}

async function withGroq(buf: Buffer, timeoutMs = 20 * 60_000): Promise<Transcript> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/mpeg" }), "audio.mp3");
  form.append("model", process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("language", "en");
  form.append("temperature", "0");
  const res = await fetch(GROQ, { method: "POST", headers: { authorization: `Bearer ${ENV.groqKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Groq transcript failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string; duration?: number; words?: { word: string; start: number; end: number }[] };
  const text = (data.text ?? "").trim();
  const raw = (data.words ?? []).filter((w) => w.word?.trim()).map((w) => ({ text: w.word.trim(), start: Number(w.start), end: Number(w.end) }));
  if (text && !raw.length) throw new Error("Groq returned no word timings");
  const words = punctuate(text, raw);
  return { text, words, seconds: Number(data.duration) || (words.length ? Math.ceil(words[words.length - 1].end) : 0) };
}

async function withAssemblyAi(buf: Buffer, opts: { timeoutMs?: number }): Promise<Transcript> {
  if (!ENV.assemblyAiKey) throw new AiNotConfiguredError("Transcription is not set up yet: ASSEMBLYAI_API_KEY is missing on the server.");
  const headers = { authorization: ENV.assemblyAiKey };
  const up = await fetch(`${API}/upload`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: new Uint8Array(buf), signal: AbortSignal.timeout(10 * 60_000) });
  if (!up.ok) throw new Error(`AssemblyAI upload failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
  const { upload_url } = (await up.json()) as { upload_url: string };
  const start = await fetch(`${API}/transcript`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    // Universal-2 (2026-10-17): $0.15 an hour against $0.21 for Universal-3.5 Pro, the cheapest model under the BAA.
    body: JSON.stringify({ audio_url: upload_url, speech_models: ["universal-2"], language_code: "en", punctuate: true, format_text: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!start.ok) throw new Error(`AssemblyAI transcript failed (${start.status}): ${(await start.text()).slice(0, 200)}`);
  const { id } = (await start.json()) as { id: string };
  const until = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(`${API}/transcript/${id}`, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`AssemblyAI status failed (${res.status})`);
    const data = (await res.json()) as { status: string; error?: string; text?: string; words?: { text: string; start: number; end: number }[]; audio_duration?: number };
    if (data.status === "completed") {
      const words = (data.words ?? []).map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }));
      return { text: (data.text ?? "").trim(), words, seconds: Number(data.audio_duration) || (words.length ? Math.ceil(words[words.length - 1].end) : 0) };
    }
    if (data.status === "error") throw new Error(`AssemblyAI could not transcribe it: ${data.error ?? "unknown error"}`);
  }
  throw new Error("Transcription took too long.");
}
