import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENV } from "../_core/env";
import { uploadsRoot } from "../storage";
import type { TransKey } from "./transitions";

/**
 * The sound that goes with each transition: its own sound effect, written for what that transition
 * does on screen (a whip pan's air whip, a flash's camera pop, a paper tear's rip). Each one is made
 * once with ElevenLabs Sound Effects on LeadDash's own account and kept for every workspace, like the
 * format card photos; nothing here is about a workspace. Its loudest moment is found and saved with
 * it, so that moment lands in the middle of the change on screen.
 */

const run = promisify(execFile);

/** What each transition sounds like. A straight cut has none. */
export const SOUND_PROMPT: Record<TransKey, { text: string; seconds: number } | null> = {
  none: null,
  fade: { text: "Very soft, gentle airy swell for a slow cross-fade between two video shots, smooth and subtle, no music", seconds: 1.2 },
  flash: { text: "Camera flash: a bright quick pop with a short high shimmer, as the screen flashes white", seconds: 0.8 },
  black: { text: "Deep cinematic low boom hit that fades into silence, as the screen dips to black", seconds: 1.5 },
  slideup: { text: "Quick clean upward swoosh as a video slides up out of frame", seconds: 0.7 },
  slidedown: { text: "Quick clean downward swoosh as a video slides down out of frame", seconds: 0.7 },
  slideleft: { text: "Quick clean swoosh moving right to left as a video slides sideways", seconds: 0.7 },
  slideright: { text: "Quick clean swoosh moving left to right as a video slides sideways", seconds: 0.7 },
  zoomin: { text: "Fast rising whoosh that rushes forward, a camera zooming in quickly", seconds: 0.9 },
  zoomout: { text: "Reverse whoosh pulling backward and away, a camera zooming out quickly", seconds: 0.9 },
  zoomblur: { text: "Powerful fast whoosh with a blurry rush of air, an energetic zoom blur transition", seconds: 0.9 },
  whip: { text: "Very fast whip pan: a sharp air whip swish, like a camera spun sideways", seconds: 0.6 },
  shake: { text: "Heavy impact thud with a short rumble, like the camera is hit and shakes", seconds: 1.0 },
  glitch: { text: "Digital glitch: a short stuttering electronic burst of data corruption and buzzing", seconds: 0.8 },
  vhs: { text: "VHS tape glitch: a quick tape rewind warble with static hiss", seconds: 0.9 },
  retro: { text: "Old film projector: a mechanical click and short reel rattle, vintage", seconds: 0.9 },
  filmburn: { text: "Old film catching fire: a soft flaring whoosh with light crackle", seconds: 1.1 },
  lightleak: { text: "Warm dreamy shimmer swell, soft and glowing, like light flooding the frame", seconds: 1.2 },
  sweep: { text: "Bright sparkling swish, a beam of light sweeping across the screen", seconds: 0.9 },
  papertear: { text: "A sheet of paper being torn quickly in one rip", seconds: 0.8 },
  firewipe: { text: "Fire whoosh: a burst of flame sweeping across", seconds: 1.0 },
  pixel: { text: "Retro 8-bit video game blips dissolving, a digital pixelate effect", seconds: 0.8 },
  circle: { text: "Soft round whoosh opening up, airy and smooth", seconds: 0.9 },
  comic: { text: "Cartoon comic book pop with a quick bouncy boing", seconds: 0.8 },
};

/** How loud each sits under the voice (0 to 1); every file is evened out to the same peak first. */
export const LEVEL = 0.55;

export const hasSound = (k: TransKey) => !!SOUND_PROMPT[k];
export const soundsReady = () => !!ENV.elevenLabsKey;

const VERSION = "v2";
/** Where the made sounds are kept (outside the served files). */
export const soundDir = () => path.resolve(uploadsRoot(), "..", "ld-sfx");
const dir = soundDir;
const fileOf = (k: TransKey) => path.join(dir(), `${k}-${VERSION}.mp3`);
const metaOf = (k: TransKey) => path.join(dir(), `${k}-${VERSION}.json`);
const pending = new Map<TransKey, Promise<Sound | null>>();

export type Sound = { file: string; peak: number };

/** The second its loudest moment comes (the loudest 50 ms), from the decoded samples. */
export async function peakOf(file: string) {
  const ff = (await import("./drama")).ffmpegPath();
  const { stdout } = await run(ff, ["-loglevel", "error", "-i", file, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024, timeout: 60_000 });
  const buf = stdout as unknown as Buffer;
  const win = 400;
  const n = Math.floor(buf.length / 2);
  let sum = 0;
  let best = -1;
  let at = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(buf.readInt16LE(i * 2));
    if (i >= win) sum -= Math.abs(buf.readInt16LE((i - win) * 2));
    if (sum > best) {
      best = sum;
      at = Math.max(0, i - win / 2);
    }
  }
  return at / 8000;
}

/** The sound if it's already made (no waiting). */
export function madeSound(k: TransKey): Sound | null {
  if (!SOUND_PROMPT[k] || !fs.existsSync(fileOf(k)) || !fs.existsSync(metaOf(k))) return null;
  try {
    return { file: fileOf(k), peak: Number(JSON.parse(fs.readFileSync(metaOf(k), "utf8")).peak) || 0 };
  } catch {
    return null;
  }
}

/** The sound for a transition, made the first time it's needed; null when it can't be made here. */
export function soundFor(k: TransKey): Promise<Sound | null> {
  const p = SOUND_PROMPT[k];
  if (!p) return Promise.resolve(null);
  const made = madeSound(k);
  if (made) return Promise.resolve(made);
  if (!ENV.elevenLabsKey) return Promise.resolve(null);
  const going = pending.get(k);
  if (going) return going;
  const job = (async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "xi-api-key": ENV.elevenLabsKey, "content-type": "application/json" },
      body: JSON.stringify({ text: p.text, duration_seconds: p.seconds, prompt_influence: 0.7, model_id: "eleven_text_to_sound_v2" }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`The ${k} sound didn't come back (${res.status}).`);
    const raw = `${fileOf(k)}.${process.pid}.raw.mp3`;
    const tmp = `${fileOf(k)}.${process.pid}.tmp.mp3`;
    try {
      fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
      const ff = (await import("./drama")).ffmpegPath();
      // Evened out to the same peak (-3 dB), so LEVEL alone sets how loud it sits.
      const probe = await run(ff, ["-i", raw, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 });
      const max = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(String(probe.stderr))?.[1] ?? -3);
      await run(ff, ["-y", "-loglevel", "error", "-i", raw, "-af", `volume=${Math.min(30, -3 - max).toFixed(2)}dB`, "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "160k", tmp], { timeout: 60_000 });
      const peak = await peakOf(tmp);
      fs.renameSync(tmp, fileOf(k));
      fs.writeFileSync(metaOf(k), JSON.stringify({ peak: +peak.toFixed(3), prompt: p.text }));
      return { file: fileOf(k), peak };
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(tmp, { force: true });
    }
  })()
    .catch((err) => {
      console.warn("[transition sounds]", err instanceof Error ? err.message : err);
      return null;
    })
    .finally(() => pending.delete(k));
  pending.set(k, job);
  return job;
}

/** Makes any that are missing, one at a time, in the background (at start-up). */
export async function warmSounds() {
  if (!ENV.elevenLabsKey || process.env.NODE_ENV === "test") return;
  for (const k of Object.keys(SOUND_PROMPT) as TransKey[]) if (SOUND_PROMPT[k]) await soundFor(k);
}
