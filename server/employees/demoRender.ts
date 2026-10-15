import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Box } from "./browser";
import type { EWord } from "./editLook";

/**
 * The ffmpeg side of Simone's demo videos. Each part becomes its own clip at the video's size,
 * then they're joined and captioned:
 * - card: a title card (or, with an avatar that opens and closes, the avatar full frame) with its line.
 * - step: the screen recording of one step, sped up through waits, zoomed in on each click with a
 *   ring on what was clicked, the voice under it, and the avatar in a corner or a bubble.
 * The screen sits over a soft blurred copy of itself when the shape differs (a 9:16 social video).
 */

const run = promisify(execFile);
const ff = async () => (await import("./drama")).ffmpegPath();
const fail = (what: string) => (e: any) => {
  throw new Error(`${what}: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
};

export type Click = Box & { at: number };
export type Part =
  | { kind: "card"; title: string; sub?: string; audio: string | null; audioSeconds: number; avatar?: string | null; text: string; words?: EWord[] | null }
  | { kind: "step"; clip: string; clipSeconds: number; clicks: Click[]; audio: string | null; audioSeconds: number; avatar?: string | null; bubble?: string | null; text: string; words?: EWord[] | null };
export type DemoRenderInput = {
  w: number;
  h: number;
  /** The recorded screen's size. */
  screen: { w: number; h: number };
  parts: Part[];
  zoom: boolean;
  /** An ASS file's text for the captions, made from the part times this returns; null for none. */
  captions: ((times: { from: number; to: number; text: string; lead: number; audioSeconds: number; words?: EWord[] | null }[]) => string | null) | null;
  logo: { file: string } | null;
  music: { file: string; volume: number } | null;
  brand: string;
  fontsDir?: string;
};

const LEAD = 0.4;
const ZMAX = 1.6;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f3 = (n: number) => n.toFixed(3);

/** How long a step plays, and how much the screen is sped up to fit its line. */
export function stepTiming(clipSeconds: number, audioSeconds: number) {
  const speed = clipSeconds > audioSeconds + 1.6 ? Math.min(3, clipSeconds / (audioSeconds + 1.6)) : 1;
  const shown = clipSeconds / speed;
  return { speed, seconds: Math.max(shown, audioSeconds + LEAD + 0.5, 1.5) };
}
export const cardSeconds = (audioSeconds: number, avatar: boolean) => (avatar ? Math.max(1.5, audioSeconds + LEAD + 0.3) : Math.max(2.5, audioSeconds + LEAD + 0.6));

/**
 * The zoom on each click: in over 0.35 seconds, held, out again; and where it centers.
 * Written for zoompan, which works out the zoom and the window on every frame. A scale
 * and crop pair did not (2026-10-15): the crop read its position once, so every zoom
 * sat in the top left corner while the ring was drawn where the click really was.
 * Time is the frame number over 30, since the clip is at 30 frames a second by then.
 */
export function zoomExpr(clicks: { at: number; cx: number; cy: number }[], sw: number, sh: number) {
  if (!clicks.length) return null;
  const t = "(in/30)";
  const env = (c: { at: number }) => `clip((${t}-${f3(c.at - 0.35)})/0.35,0,1)*clip((${f3(c.at + 1.25)}-${t})/0.35,0,1)`;
  const z = `1+${+(ZMAX - 1).toFixed(3)}*${clicks.reduce((acc, c) => (acc ? `max(${acc},${env(c)})` : env(c)), "")}`;
  // The center of the click being shown (the screen's middle when none is).
  const pick = (k: "cx" | "cy", dflt: number) => clicks.reduceRight((acc, c) => `if(between(${t},${f3(c.at - 0.4)},${f3(c.at + 1.65)}),${Math.round(c[k])},${acc})`, String(dflt));
  const cx = pick("cx", sw / 2);
  const cy = pick("cy", sh / 2);
  // The window's top left, in the screen's own pixels, kept inside the screen.
  const x = `clip((${cx})-iw/zoom/2,0,iw-iw/zoom)`;
  const y = `clip((${cy})-ih/zoom/2,0,ih-ih/zoom)`;
  return { z, cx, cy, filter: `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${sw}x${sh}:fps=30` };
}

async function ringPng(size: number, dir: string, i: number, color: string) {
  const sharp = (await import("sharp")).default;
  const s = Math.max(40, Math.round(size));
  const file = path.join(dir, `ring-${i}.png`);
  const sw = Math.max(4, Math.round(s / 16));
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2 - sw}" fill="none" stroke="${color}" stroke-width="${sw}"/><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2 - sw * 2.4}" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="${sw}"/></svg>`)).png().toFile(file);
  return file;
}

async function cardPng(W: number, H: number, title: string, sub: string, brand: string, logo: string | null, dir: string, i: number) {
  const sharp = (await import("sharp")).default;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const size = Math.round(Math.min(W, H) * (W > H ? 0.07 : 0.075));
  // Wrap the title to about 22 characters a line.
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= (W > H ? 30 : 20)) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  const top = H / 2 - (lines.length * size * 1.15) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${brand}"/>${lines.map((l, k) => `<text x="${W / 2}" y="${top + (k + 0.85) * size * 1.15}" font-family="DejaVu Sans" font-weight="bold" font-size="${size}" fill="#ffffff" text-anchor="middle">${esc(l)}</text>`).join("")}${sub ? `<text x="${W / 2}" y="${top + lines.length * size * 1.15 + size * 1.1}" font-family="DejaVu Sans" font-size="${Math.round(size * 0.45)}" fill="#ffffff" fill-opacity=".85" text-anchor="middle">${esc(sub)}</text>` : ""}</svg>`;
  let img = sharp(Buffer.from(svg));
  if (logo && fs.existsSync(logo)) {
    const lw = Math.round(Math.min(W, H) * 0.22);
    const lg = await sharp(logo).resize({ width: lw, height: Math.round(lw / 2), fit: "inside" }).png().toBuffer();
    const meta = await sharp(lg).metadata();
    img = img.composite([{ input: lg, left: Math.round(W / 2 - (meta.width ?? lw) / 2), top: Math.round(H - (meta.height ?? lw / 2) - H * 0.08) }]);
  }
  const file = path.join(dir, `card-${i}.png`);
  await img.png().toFile(file);
  return file;
}

async function bubblePng(still: string, size: number, dir: string) {
  const sharp = (await import("sharp")).default;
  const s = even(size);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}" fill="#fff"/></svg>`);
  const face = await sharp(still).resize(s, s, { fit: "cover", position: "attention" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  const ring = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2 - 4}" fill="none" stroke="#fff" stroke-width="8"/></svg>`);
  const file = path.join(dir, "bubble.png");
  await sharp(face).composite([{ input: ring }]).png().toFile(file);
  return file;
}

/** Fits a stream to W×H over a soft blurred copy of itself. */
const fit = (src: string, W: number, H: number, out: string, n: number) =>
  `${src}split=2[fa${n}][fb${n}];[fa${n}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.08[bg${n}];[fb${n}]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg${n}];[bg${n}][fg${n}]overlay=(W-w)/2:(H-h)/2,setsar=1${out}`;

const ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];

async function renderPart(p: Part, i: number, input: DemoRenderInput, dir: string): Promise<{ file: string; seconds: number }> {
  const { w: W, h: H } = input;
  const out = path.join(dir, `part-${String(i).padStart(3, "0")}.mp4`);
  const args = ["-y", "-loglevel", "error"];
  const g: string[] = [];
  let n = 0;
  const add = (...a: string[]) => (args.push(...a), n++);
  const audioIn = p.audio ? add("-i", p.audio) : add("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  const voice = (T: number) => `[${audioIn}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},apad,atrim=0:${f3(T)}[a]`;
  if (p.kind === "card") {
    const T = cardSeconds(p.audioSeconds, !!p.avatar);
    if (p.avatar) {
      const ai = add("-i", p.avatar);
      g.push(`[${ai}:v]fps=30,setpts=PTS-STARTPTS+${LEAD}/TB,tpad=start_mode=clone:start_duration=${LEAD}:stop_mode=clone:stop_duration=2,trim=duration=${f3(T)},setpts=PTS-STARTPTS[av]`);
      g.push(fit("[av]", W, H, "[v]", 0));
    } else {
      const png = await cardPng(W, H, p.title, p.sub ?? "", input.brand, input.logo?.file ?? null, dir, i);
      const ci = add("-loop", "1", "-framerate", "30", "-t", f3(T), "-i", png);
      g.push(`[${ci}:v]format=yuv420p,setsar=1,fade=t=in:st=0:d=0.3[v]`);
    }
    g.push(voice(T));
    args.push("-filter_complex", g.join(";"), "-map", "[v]", "-map", "[a]", "-t", f3(T), ...ENC, out);
    await run(await ff(), args, { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000 }).catch(fail("A title card didn't finish"));
    return { file: out, seconds: T };
  }
  const { speed, seconds: T } = stepTiming(p.clipSeconds, p.audioSeconds);
  const { w: sw, h: sh } = input.screen;
  const ci = add("-i", p.clip);
  const clicks = p.clicks.map((c) => ({ ...c, at: c.at / speed, cx: c.x + c.w / 2, cy: c.y + c.h / 2 }));
  let chain = `[${ci}:v]setpts=PTS/${speed.toFixed(4)},fps=30,scale=${sw}:${sh},setsar=1,tpad=stop_mode=clone:stop_duration=${f3(T + 1)},trim=duration=${f3(T)},setpts=PTS-STARTPTS`;
  const zx = input.zoom ? zoomExpr(clicks, sw, sh) : null;
  if (zx) chain += `,${zx.filter},setpts=PTS-STARTPTS`;
  g.push(`${chain}[scr0]`);
  let cur = "[scr0]";
  // A ring on what was clicked, while the zoom holds on it.
  for (let k = 0; k < clicks.length; k++) {
    const c = clicks[k];
    const z = zx ? ZMAX : 1;
    const size = (Math.max(c.w, c.h) + 36) * z;
    const ri = add("-loop", "1", "-framerate", "30", "-t", f3(T), "-i", await ringPng(size, dir, i * 100 + k, "#F5C542"));
    const x0 = zx ? Math.min(Math.max(c.cx * z - sw / 2, 0), sw * z - sw) : 0;
    const y0 = zx ? Math.min(Math.max(c.cy * z - sh / 2, 0), sh * z - sh) : 0;
    const x = Math.round(c.cx * z - x0 - size / 2);
    const y = Math.round(c.cy * z - y0 - size / 2);
    g.push(`${cur}[${ri}:v]overlay=${x}:${y}:enable='between(t,${f3(c.at)},${f3(c.at + 0.9)})'[scr${k + 1}]`);
    cur = `[scr${k + 1}]`;
  }
  g.push(fit(cur, W, H, "[fitted]", 1));
  cur = "[fitted]";
  if (p.avatar) {
    const ai = add("-i", p.avatar);
    const aw = even(Math.min(W, H) * (W > H ? 0.26 : 0.34));
    const m = Math.round(Math.min(W, H) * 0.035);
    g.push(`[${ai}:v]fps=30,scale=${aw}:-2,setsar=1,setpts=PTS-STARTPTS+${LEAD}/TB,tpad=start_mode=clone:start_duration=${LEAD}:stop_mode=clone:stop_duration=${f3(T)},trim=duration=${f3(T)},pad=iw+8:ih+8:4:4:white[av]`);
    g.push(`${cur}[av]overlay=W-w-${m}:H-h-${Math.round(m * (H > W ? 3.2 : 1.6))}[withav]`);
    cur = "[withav]";
  }
  if (p.bubble) {
    const size = even(Math.min(W, H) * 0.22);
    const bi = add("-loop", "1", "-framerate", "30", "-t", f3(T), "-i", await bubblePng(p.bubble, size, dir));
    const m = Math.round(Math.min(W, H) * 0.05);
    g.push(`${cur}[${bi}:v]overlay=W-w-${m}:${Math.round(m * 2.2)}[withb]`);
    cur = "[withb]";
  }
  g.push(`${cur}format=yuv420p[v]`);
  g.push(voice(T));
  const gf = path.join(dir, `g-${i}.txt`);
  fs.writeFileSync(gf, g.join(";\n"));
  args.push("-/filter_complex", gf, "-map", "[v]", "-map", "[a]", "-t", f3(T), ...ENC, out);
  await run(await ff(), args, { maxBuffer: 20 * 1024 * 1024, timeout: 20 * 60_000 }).catch(fail(`Step ${i} didn't finish`));
  return { file: out, seconds: T };
}

/** One size of the video. */
export async function renderDemo(input: DemoRenderInput): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-demo-"));
  try {
    const made: { file: string; seconds: number }[] = [];
    for (let i = 0; i < input.parts.length; i++) made.push(await renderPart(input.parts[i], i, input, dir));
    const list = path.join(dir, "list.txt");
    fs.writeFileSync(list, made.map((m) => `file '${m.file}'`).join("\n"));
    const joined = path.join(dir, "joined.mp4");
    await run(await ff(), ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined], { timeout: 10 * 60_000 }).catch(fail("Joining the parts didn't finish"));
    const total = made.reduce((a, m) => a + m.seconds, 0);
    let at = 0;
    const times = input.parts.map((p, i) => {
      const t = { from: at, to: at + made[i].seconds, text: p.text, lead: LEAD, audioSeconds: p.audioSeconds, words: p.words ?? null };
      at += made[i].seconds;
      return t;
    });
    const ass = input.captions ? input.captions(times) : null;
    const args = ["-y", "-loglevel", "error", "-i", joined];
    const g: string[] = [];
    let v = "[0:v]";
    let n = 1;
    if (ass) {
      const af = path.join(dir, "captions.ass");
      fs.writeFileSync(af, ass);
      const fd = input.fontsDir ? `:fontsdir=${input.fontsDir.replace(/:/g, "\\:")}` : "";
      g.push(`${v}ass=${af.replace(/:/g, "\\:")}${fd}[vs]`);
      v = "[vs]";
    }
    if (input.logo) {
      const li = n++;
      args.push("-i", input.logo.file);
      const lw = Math.round(Math.min(input.w, input.h) * 0.16);
      const m = Math.round(Math.min(input.w, input.h) * 0.04);
      g.push(`[${li}:v]scale=${lw}:-1,format=rgba[lg]`);
      g.push(`${v}[lg]overlay=W-w-${m}:${m}:format=auto[vl]`);
      v = "[vl]";
    }
    g.push(`${v}format=yuv420p[v]`);
    if (input.music) {
      const mi = n++;
      args.push("-stream_loop", "-1", "-i", input.music.file);
      g.push(`[${mi}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${(input.music.volume / 100).toFixed(2)},atrim=0:${f3(total)},asetpts=N/SR/TB,afade=t=in:d=0.6,afade=t=out:st=${f3(Math.max(0, total - 1.5))}:d=1.5[mus]`);
      g.push(`[0:a][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`);
    } else g.push(`[0:a]anull[a]`);
    const out = path.join(dir, "out.mp4");
    args.push("-filter_complex", g.join(";"), "-map", "[v]", "-map", "[a]", "-t", f3(total), "-c:v", "libx264", "-preset", total > 300 ? "veryfast" : "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out);
    await run(await ff(), args, { maxBuffer: 20 * 1024 * 1024, timeout: Math.max(15, Math.ceil(total / 60) * 8) * 60_000 }).catch(fail("The video didn't finish"));
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A recorded run's pictures as a clip: only the moments listed, back to back (the waits between actions are left out). */
export async function clipFromFrames(frames: { t: number; file: string }[], windows: { from: number; to: number }[], out: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-frames-"));
  try {
    const lines: string[] = [];
    let last = "";
    for (const w of windows) {
      const len = Math.max(0.1, w.to - w.from);
      const inWin = frames.filter((f) => f.t > w.from && f.t < w.to);
      const before = [...frames].reverse().find((f) => f.t <= w.from) ?? frames[0];
      const seq = [{ t: w.from, file: before?.file ?? inWin[0]?.file }, ...inWin].filter((f) => f.file);
      seq.forEach((f, k) => {
        const end = k + 1 < seq.length ? seq[k + 1].t : w.from + len;
        const d = Math.max(1 / 30, end - f.t);
        lines.push(`file '${f.file}'`, `duration ${d.toFixed(3)}`);
        last = f.file;
      });
    }
    if (!last) throw new Error("Nothing was recorded for this step.");
    lines.push(`file '${last}'`);
    const list = path.join(dir, "frames.txt");
    fs.writeFileSync(list, lines.join("\n"));
    await run(await ff(), ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", out], { timeout: 10 * 60_000 }).catch(fail("The step's recording didn't finish"));
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
