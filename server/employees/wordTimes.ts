import { ENV } from "../_core/env";
import type { EWord } from "./editLook";

/**
 * When each word of a voice line is spoken (2026-10-15). The captions used to spread
 * the words evenly over the line, so they drifted from the voice whenever it paused or
 * sped up. Now the finished MP3 is listened to (OpenAI transcription with word times)
 * and the script's own words are lined up with what was heard. The script stays the
 * caption text; only the times come from the listening. When the listening fails, the
 * caller falls back to spreading the words.
 */

export type Heard = { word: string; start: number; end: number };

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

/**
 * The script's words with times from the heard words. Words that match line up one to
 * one (longest common run); the rest take the time between their matched neighbors.
 */
export function alignWords(text: string, heard: Heard[], seconds: number): { words: EWord[]; matched: number } {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return { words: [], matched: 0 };
  const a = toks.map(norm);
  const b = heard.map((h) => norm(h.word));
  // Longest common subsequence, so a word said twice or skipped does not throw the rest off.
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const at: (Heard | null)[] = new Array(n).fill(null);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] && a[i] === b[j]) at[i++] = heard[j++];
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  const end = Math.max(seconds, heard[heard.length - 1]?.end ?? 0);
  // Fill the gaps: an unmatched run takes the stretch between its matched neighbors, split by word length.
  const out: EWord[] = new Array(n);
  let i = 0;
  while (i < n) {
    if (at[i]) {
      out[i] = { text: toks[i], start: +at[i]!.start.toFixed(3), end: +Math.max(at[i]!.end, at[i]!.start + 0.05).toFixed(3) };
      i++;
      continue;
    }
    let k = i;
    while (k < n && !at[k]) k++;
    const from = i > 0 ? out[i - 1].end : 0;
    const to = k < n ? at[k]!.start : end;
    const span = Math.max(0.1, to - from);
    const weight = toks.slice(i, k).map((t) => 1 + t.length / 6);
    const total = weight.reduce((x, y) => x + y, 0);
    let cur = from;
    for (let q = i; q < k; q++) {
      const len = (span * weight[q - i]) / total;
      out[q] = { text: toks[q], start: +cur.toFixed(3), end: +(cur + len).toFixed(3) };
      cur += len;
    }
    i = k;
  }
  // Times never run backwards.
  for (let q = 1; q < n; q++) {
    if (out[q].start < out[q - 1].end) out[q].start = out[q - 1].end;
    if (out[q].end < out[q].start + 0.05) out[q].end = +(out[q].start + 0.05).toFixed(3);
  }
  return { words: out, matched: at.filter(Boolean).length };
}

/** Listens to the MP3 and returns when each word was said; null when it cannot. */
export async function hearWords(mp3: Buffer, text: string): Promise<Heard[] | null> {
  if (!ENV.openAiKey) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(mp3)], { type: "audio/mpeg" }), "line.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("language", "en");
    form.append("prompt", text.slice(0, 800));
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${ENV.openAiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      console.warn("[word-times] transcription failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json = (await res.json()) as { words?: { word: string; start: number; end: number }[] };
    const words = (json.words ?? []).filter((w) => typeof w.start === "number" && typeof w.end === "number" && w.word);
    return words.length ? words : null;
  } catch (err) {
    console.warn("[word-times]", (err as Error).message);
    return null;
  }
}

/** The script's words timed to the voice, or null when the voice could not be listened to. */
export async function wordTimes(mp3: Buffer, text: string, seconds: number): Promise<EWord[] | null> {
  const heard = await hearWords(mp3, text);
  if (!heard) return null;
  const { words, matched } = alignWords(text, heard, seconds);
  // Too little lined up means the listening is not to be trusted.
  return words.length && matched >= Math.min(3, words.length) && matched / words.length >= 0.5 ? words : null;
}
