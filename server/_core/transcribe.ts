import { ENV } from "./env";
import { AiNotConfiguredError } from "./llm";

/**
 * Turns a recorded file into text with AssemblyAI (the same account and BAA
 * DashNotes uses): upload the audio, ask for a transcript, wait for it.
 * Words carry timestamps so a step can be matched to the moment it was said.
 */

export type Word = { text: string; start: number; end: number };
export type Transcript = { text: string; words: Word[]; seconds: number };

const API = "https://api.assemblyai.com/v2";

export async function transcribeFile(buf: Buffer, opts: { timeoutMs?: number } = {}): Promise<Transcript> {
  if (!ENV.assemblyAiKey) throw new AiNotConfiguredError("Transcription is not set up yet: ASSEMBLYAI_API_KEY is missing on the server.");
  const headers = { authorization: ENV.assemblyAiKey };
  const up = await fetch(`${API}/upload`, { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: new Uint8Array(buf), signal: AbortSignal.timeout(10 * 60_000) });
  if (!up.ok) throw new Error(`AssemblyAI upload failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
  const { upload_url } = (await up.json()) as { upload_url: string };
  const start = await fetch(`${API}/transcript`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, speech_model: "universal", language_code: "en", punctuate: true, format_text: true }),
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
