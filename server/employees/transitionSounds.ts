import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { uploadsRoot } from "../storage";
import type { TransKey } from "./transitions";

/**
 * The sound that goes with each transition (whoosh, swish, pop, boom, glitch, shutter, paper tear,
 * fire, shimmer). Each is made here by ffmpeg from noise and tones, so nothing is licensed, and kept
 * as a WAV the first time it's needed. Edit my video lays them under the voice at each change when
 * Sound is on; the transition picker plays them from /api/transition-sounds/<kind>.wav.
 */

const run = promisify(execFile);

export const SOUND_KINDS = ["soft", "whoosh", "swish", "pop", "boom", "glitch", "shutter", "tear", "fire", "shimmer"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];
export const isSoundKind = (k: unknown): k is SoundKind => typeof k === "string" && (SOUND_KINDS as readonly string[]).includes(k);

/** Which sound each transition makes; a straight cut makes none. */
export const SOUND: Record<TransKey, SoundKind | null> = {
  none: null,
  fade: "soft",
  flash: "pop",
  black: "boom",
  slideup: "swish",
  slidedown: "swish",
  slideleft: "swish",
  slideright: "swish",
  zoomin: "whoosh",
  zoomout: "whoosh",
  zoomblur: "whoosh",
  whip: "swish",
  shake: "boom",
  glitch: "glitch",
  vhs: "glitch",
  retro: "shutter",
  filmburn: "fire",
  lightleak: "shimmer",
  sweep: "shimmer",
  papertear: "tear",
  firewipe: "fire",
  pixel: "glitch",
  circle: "whoosh",
  comic: "pop",
};

/** Seconds into each sound where it's loudest, so that lands in the middle of the change. */
export const PEAK: Record<SoundKind, number> = { soft: 0.3, whoosh: 0.32, swish: 0.14, pop: 0.02, boom: 0.03, glitch: 0.05, shutter: 0.01, tear: 0.08, fire: 0.25, shimmer: 0.08 };

/** How loud each sits under the voice (0 to 1). */
export const LEVEL: Record<SoundKind, number> = { soft: 0.35, whoosh: 0.6, swish: 0.55, pop: 0.5, boom: 0.65, glitch: 0.25, shutter: 0.5, tear: 0.5, fire: 0.5, shimmer: 0.35 };

const SR = 44100;
/** The ffmpeg graph that makes each one, ending in [s]. */
const GRAPH: Record<SoundKind, string> = {
  soft: `anoisesrc=color=pink:amplitude=1:d=0.6:r=${SR},highpass=f=250,lowpass=f=1800,afade=t=in:d=0.3:curve=qsin,afade=t=out:st=0.3:d=0.3:curve=qsin[s]`,
  whoosh: `anoisesrc=color=pink:amplitude=0.9:d=0.7:r=${SR},highpass=f=180,lowpass=f=2400,afade=t=in:d=0.32:curve=exp,afade=t=out:st=0.32:d=0.38:curve=qsin,aecho=0.6:0.4:25:0.3[s]`,
  swish: `anoisesrc=color=white:amplitude=0.8:d=0.36:r=${SR},highpass=f=1600,lowpass=f=7500,afade=t=in:d=0.14:curve=exp,afade=t=out:st=0.14:d=0.22:curve=qsin[s]`,
  pop: `aevalsrc='0.9*sin(2*PI*(1100-700*t/0.18)*t)*exp(-22*t)+0.3*(random(0)*2-1)*exp(-120*t)':s=${SR}:d=0.3[s]`,
  boom: `aevalsrc='0.95*sin(2*PI*(72-34*t)*t)*exp(-4.5*t)+0.25*(random(0)*2-1)*exp(-14*t)':s=${SR}:d=0.9,lowpass=f=900[s]`,
  glitch: `aevalsrc='0.45*sgn(sin(2*PI*(260+220*floor(mod(t*33,1)*9))*t))*lt(mod(t,0.055),0.034)+0.2*(random(0)*2-1)*lt(mod(t*7,1),0.3)':s=${SR}:d=0.42,afade=t=out:st=0.3:d=0.12[s]`,
  shutter: `aevalsrc='(lt(t,0.014)*0.9+between(t,0.085,0.097)*0.7)*(random(0)*2-1)':s=${SR}:d=0.2,highpass=f=900,aecho=0.5:0.3:12:0.25[s]`,
  tear: `aevalsrc='(random(0)*2-1)*0.75*(0.55+0.45*sin(2*PI*46*t))*min(1,t/0.03)*exp(-3.2*t)':s=${SR}:d=0.55,highpass=f=1700,lowpass=f=9000[s]`,
  fire: `anoisesrc=color=brown:amplitude=0.9:d=0.75:r=${SR},lowpass=f=1100,afade=t=in:d=0.25:curve=exp,afade=t=out:st=0.3:d=0.45,volume=1.4[b];aevalsrc='gt(random(0),0.9965)*(random(1)*2-1)*0.9':s=${SR}:d=0.75,highpass=f=2500[c];[b][c]amix=inputs=2:normalize=0[s]`,
  shimmer: `aevalsrc='0.22*(sin(2*PI*1760*t)+sin(2*PI*2637*t)+0.8*sin(2*PI*3520*t)+0.6*sin(2*PI*4186*t))*min(1,t/0.06)*exp(-3.6*t)':s=${SR}:d=0.9,aecho=0.7:0.5:60|110:0.35|0.2[s]`,
};

const dir = () => path.join(uploadsRoot(), "..", "ld-sfx");
const pending = new Map<SoundKind, Promise<string>>();

/** The sound as a WAV on disk, made the first time. */
export function soundFile(kind: SoundKind): Promise<string> {
  const file = path.join(dir(), `${kind}-v1.wav`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  const going = pending.get(kind);
  if (going) return going;
  const p = (async () => {
    fs.mkdirSync(dir(), { recursive: true });
    const ff = (await import("./drama")).ffmpegPath();
    const raw = `${file}.${process.pid}.raw.wav`;
    const tmp = `${file}.${process.pid}.tmp.wav`;
    try {
      await run(ff, ["-y", "-loglevel", "error", "-filter_complex", GRAPH[kind], "-map", "[s]", "-ac", "2", "-ar", String(SR), "-c:a", "pcm_s16le", raw], { timeout: 60_000 });
      // Every sound peaks at the same level (-3 dB), so LEVEL alone sets how loud each sits.
      const probe = await run(ff, ["-i", raw, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 });
      const max = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(String(probe.stderr))?.[1] ?? -3);
      const gain = Math.min(40, -3 - max);
      await run(ff, ["-y", "-loglevel", "error", "-i", raw, "-af", `volume=${gain.toFixed(2)}dB`, "-c:a", "pcm_s16le", tmp], { timeout: 60_000 });
      fs.renameSync(tmp, file);
      return file;
    } finally {
      fs.rmSync(raw, { force: true });
      fs.rmSync(tmp, { force: true });
    }
  })().finally(() => pending.delete(kind));
  pending.set(kind, p);
  return p;
}
