import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EditLook, Piece, Range } from "./editLook";
import { MOVES, RECIPES, overlaySvg, type OverlayKind } from "./transitions";

/**
 * The ffmpeg side of Edit my video.
 * 1. cutSource: the upload with silences and bad takes taken out (and the sound cleaned), once per export.
 * 2. renderEdit: one size from that cut: the person (or the person cut out over a background), b-roll
 *    pieces joined with their transitions, the layout (split screen, picture in picture), captions,
 *    emojis, the hook title, the logo and music.
 * Graphs are written to a file, so a 30 minute video with hundreds of changes still fits.
 */

const run = promisify(execFile);

async function ff() {
  return (await import("./drama")).ffmpegPath();
}
const fail = (what: string) => (e: any) => {
  throw new Error(`${what}: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
};

/** ffmpeg's select expression for the kept ranges. */
const keepExpr = (ranges: Range[]) => ranges.map((r) => `between(t,${r.from.toFixed(3)},${r.to.toFixed(3)})`).join("+") || "1";

/** The upload with only the kept parts, 30 frames a second, sound cleaned when asked. Also cuts a green screen cutout the same way. */
export async function cutSource(input: { file: string; ranges: Range[]; cleanAudio: boolean; out: string; video?: "keep" | "only" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-cut-"));
  try {
    const sel = keepExpr(input.ranges);
    const only = input.video === "only";
    const clean = input.cleanAudio ? ",highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11" : "";
    const graph = only
      ? `[0:v]fps=30,select='${sel}',setpts=N/FRAME_RATE/TB,format=yuv420p[v]`
      : `[0:v]fps=30,select='${sel}',setpts=N/FRAME_RATE/TB,format=yuv420p[v];[0:a]aresample=48000,aselect='${sel}',asetpts=N/SR/TB${clean}[a]`;
    const g = path.join(dir, "cut.txt");
    fs.writeFileSync(g, graph);
    const total = input.ranges.reduce((n, r) => n + r.to - r.from, 0);
    const args = ["-y", "-loglevel", "error", "-i", input.file, "-/filter_complex", g, "-map", "[v]", ...(only ? ["-an"] : ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", input.out];
    await run(await ff(), args, { maxBuffer: 20 * 1024 * 1024, timeout: Math.max(10, Math.ceil(total / 60) * 4) * 60_000 }).catch(fail("The cut didn't finish"));
    return input.out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export type Emoji = { file: string; from: number; to: number; x: number; y: number; size: number };
export type RenderPiece = Piece & { file?: string | null };
export type EditRenderInput = {
  w: number;
  h: number;
  /** The cut (picture and voice). */
  you: string;
  /** Green screen: the person cut out (RGB and matte), cut the same way. */
  cutout?: { rgb: string; matte: string } | null;
  total: number;
  pieces: RenderPiece[];
  /** Punch-ins, in the cut's time. */
  zooms: Range[];
  layout: {
    kind: EditLook["layout"]["kind"];
    you: "top" | "bottom";
    when: "whole" | "broll";
    /** Split screen with one clip or a second video in the other half. */
    other?: { file: string } | null;
    /** Green screen background: a picture, a clip or a color. */
    bg?: { file: string; video: boolean } | { color: string } | null;
    corner: "tl" | "tr" | "bl" | "br";
  };
  /** Captions and the hook title, as an ASS file's text. */
  ass: string | null;
  emojis: Emoji[];
  logo: { file: string; corner: "tl" | "tr" | "bl" | "br"; size: "s" | "m" | "l" } | null;
  music: { file: string; volume: number } | null;
  fontsDir?: string;
};

const LOGO_W = { s: 0.14, m: 0.2, l: 0.28 } as const;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const cover = (w: number, h: number, bias = 0.5) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(in_w-out_w)/2:(in_h-out_h)*${bias}`;
const NORM = "fps=30,format=yuv420p,setsar=1,settb=AVTB";

/** Builds the filter graph and inputs for one size. Exported so tests can read the plan without running it. */
export function editGraph(input: EditRenderInput, overlayFiles: Partial<Record<OverlayKind, string>>) {
  const { w: W, h: H, total } = input;
  const wide = W > H;
  const args: string[] = [];
  const parts: string[] = [];
  let n = 0;
  const addInput = (...a: string[]) => {
    args.push(...a);
    return n++;
  };
  const youIn = addInput("-i", input.you);
  const kind = input.layout.kind;

  // Pieces, as the layout needs them.
  let pieces: RenderPiece[] = input.pieces.map((p) => ({ ...p }));
  const split = kind === "split";
  const whole = split && input.layout.when === "whole";
  if (whole) {
    if (input.layout.other) pieces = [{ ...pieces[0], from: 0, to: total, broll: null, file: input.layout.other.file, tr: "none" }];
    else {
      const first = pieces.find((p) => p.file);
      if (first) {
        const merged: RenderPiece[] = [];
        for (const p of pieces) {
          if (!p.file) {
            if (merged.length) merged[merged.length - 1].to = p.to;
            else merged.push({ ...first, from: p.from, to: p.to, tr: "none" });
            continue;
          }
          const last = merged[merged.length - 1];
          if (last && last.file === p.file) last.to = p.to;
          else merged.push({ ...p, tr: merged.length ? p.tr : "none" });
        }
        merged.forEach((p, k) => (p.to = merged[k + 1]?.from ?? total));
        pieces = merged;
      }
    }
  }

  // The person: from the cut, or cut out over the background.
  const halfW = wide ? even(W / 2) : W;
  const halfH = wide ? H : even(H / 2);
  const smallW = even((wide ? 0.26 : 0.36) * W);
  const smallH = even(smallW * (wide ? 9 / 16 : 16 / 9));
  const fullCount = pieces.filter((p) => !p.file).length;
  const halfCount = split ? pieces.filter((p) => !!p.file).length : 0;
  const smallCount = kind === "pip" ? pieces.filter((p) => !!p.file).length : 0;

  let person = `[${youIn}:v]fps=30,setsar=1`;
  if (kind === "green" && input.cutout) {
    const rgb = addInput("-i", input.cutout.rgb);
    const matte = addInput("-i", input.cutout.matte);
    const bg = input.layout.bg;
    let bgLabel: string;
    if (bg && "file" in bg) {
      const bi = bg.video ? addInput("-stream_loop", "-1", "-i", bg.file) : addInput("-loop", "1", "-framerate", "30", "-t", (total + 2).toFixed(3), "-i", bg.file);
      parts.push(`[${bi}:v]${cover(W, H)},fps=30,setsar=1,format=yuv420p,trim=duration=${(total + 1).toFixed(3)},setpts=PTS-STARTPTS[bg]`);
    } else {
      const color = (bg && "color" in bg ? bg.color : "#1B6B4A").replace("#", "0x");
      const ci = addInput("-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=30:d=${(total + 1).toFixed(3)}`);
      parts.push(`[${ci}:v]format=yuv420p,setsar=1[bg]`);
    }
    bgLabel = "[bg]";
    parts.push(`[${rgb}:v]fps=30,${cover(W, H, 0.35)},setsar=1,format=yuv420p[crgb];[${matte}:v]fps=30,${cover(W, H, 0.35)},setsar=1,format=gray[cm];[crgb][cm]alphamerge[cut]`);
    parts.push(`${bgLabel}[cut]overlay=0:0:format=auto:shortest=1,format=yuv420p,setsar=1[personsrc]`);
    person = `[personsrc]null`;
  }
  const variants: string[] = [];
  if (fullCount) variants.push("full");
  if (halfCount) variants.push("half");
  if (smallCount) variants.push("small");
  parts.push(`${person},split=${variants.length}${variants.map((v) => `[p_${v}]`).join("")}`);
  const zoomExpr = input.zooms.length ? `if(${input.zooms.map((z) => `between(t,${z.from.toFixed(3)},${z.to.toFixed(3)})`).join("+")},1.15,1)` : "";
  const zoomF = (w: number, h: number) => (zoomExpr ? `,scale=w='trunc(iw*${zoomExpr}/2)*2':h='trunc(ih*${zoomExpr}/2)*2':eval=frame,crop=${w}:${h}` : "");
  const label: Record<string, string[]> = {};
  const wantCount: Record<string, number> = { full: fullCount, half: halfCount, small: smallCount };
  for (const v of variants) {
    const count = wantCount[v];
    const size = v === "full" ? cover(W, H, 0.35) + zoomF(W, H) : v === "half" ? cover(halfW, halfH, 0.3) + zoomF(halfW, halfH) : cover(smallW, smallH, 0.3);
    const outs = Array.from({ length: count }, (_, i) => `[${v}${i}]`);
    parts.push(`[p_${v}]${size},${NORM}${count > 1 ? `,split=${count}${outs.join("")}` : outs[0]}`);
    label[v] = outs;
  }
  const take = (v: string) => label[v].shift() ?? null;

  // Each piece, a little longer when a transition follows so the two can overlap.
  const lens: number[] = [];
  pieces.forEach((p, k) => {
    const next = pieces[k + 1];
    const ext = next && RECIPES[next.tr].xfade ? next.d : 0;
    const L = Math.max(0.05, p.to - p.from);
    lens.push(L);
    const span = (L + ext).toFixed(3);
    const win = (src: string, from: number) => `${src}trim=start=${from.toFixed(3)}:end=${(from + L + ext).toFixed(3)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${(ext + 0.1).toFixed(3)},trim=duration=${span}`;
    const clip = (w: number, h: number) => {
      const ci = addInput("-stream_loop", "-1", "-i", p.file!);
      return `[${ci}:v]${cover(w, h)},${NORM},trim=duration=${span},setpts=PTS-STARTPTS`;
    };
    const looks: string[] = [];
    if (next && RECIPES[next.tr].out) looks.push(...RECIPES[next.tr].out!(L, next.d, W, H));
    if (k > 0 && RECIPES[p.tr].in) looks.push(...RECIPES[p.tr].in!(p.d, W, H));
    const tail = `${looks.length ? `,${looks.join(",")}` : ""},${NORM}[pc${k}]`;
    if (!p.file) {
      parts.push(`${win(take("full")!, p.from)}${tail}`);
    } else if (split) {
      const youHalf = take("half");
      parts.push(`${clip(halfW, halfH)}[cl${k}]`);
      parts.push(`${win(youHalf!, p.from)}[yh${k}]`);
      const first = input.layout.you === "top" ? `[yh${k}][cl${k}]` : `[cl${k}][yh${k}]`;
      parts.push(`${first}${wide ? "hstack" : "vstack"}=inputs=2,scale=${W}:${H},setsar=1${tail}`);
    } else if (kind === "pip") {
      const m = Math.round(Math.min(W, H) * 0.045);
      const c = input.layout.corner;
      const x = c.endsWith("l") ? `${m}` : `W-w-${m}`;
      const y = c.startsWith("t") ? `${Math.round(m * (H > W ? 2 : 1))}` : `H-h-${Math.round(m * (H > W ? 4 : 1))}`;
      parts.push(`${clip(W, H)}[cl${k}]`);
      parts.push(`${win(take("small")!, p.from)},pad=iw+8:ih+8:4:4:white[ys${k}]`);
      parts.push(`[cl${k}][ys${k}]overlay=${x}:${y}:format=auto${tail}`);
    } else {
      parts.push(`${clip(W, H)}${tail}`);
    }
  });

  // Joined in order: a straight cut, or the two overlapping for the transition.
  let acc = "[pc0]";
  for (let k = 1; k < pieces.length; k++) {
    const p = pieces[k];
    const x = RECIPES[p.tr].xfade;
    const out = `[j${k}]`;
    if (!x) parts.push(`${acc}[pc${k}]concat=n=2:v=1:a=0${out}`);
    else parts.push(`${acc}[pc${k}]xfade=transition=${x}:duration=${p.d.toFixed(3)}:offset=${p.from.toFixed(3)}${out}`);
    acc = out;
  }

  // Light effects laid over the change.
  pieces.forEach((p, k) => {
    const kindO = RECIPES[p.tr].overlay;
    if (!k || !kindO || !RECIPES[p.tr].xfade) return;
    const file = overlayFiles[kindO];
    if (!file) return;
    const d = p.d;
    const T = p.from;
    const oi = addInput("-loop", "1", "-framerate", "30", "-t", d.toFixed(3), "-i", file);
    const move = MOVES[kindO];
    const fades = move === "move" ? "" : `,fade=t=in:st=0:d=${(d / 2).toFixed(3)}:alpha=1,fade=t=out:st=${(d / 2).toFixed(3)}:d=${(d / 2).toFixed(3)}:alpha=1`;
    parts.push(`[${oi}:v]format=rgba${fades},setpts=PTS-STARTPTS+${T.toFixed(3)}/TB[ov${k}]`);
    const xExpr = move === "move" ? `'W*(t-${T.toFixed(3)})/${d.toFixed(3)}-w/2'` : move === "pulse-move" ? `'-W*0.4+W*0.8*(t-${T.toFixed(3)})/${d.toFixed(3)}'` : "0";
    const out = `[o${k}]`;
    parts.push(`${acc}[ov${k}]overlay=x=${xExpr}:y=0:format=auto:eof_action=pass${out}`);
    acc = out;
  });

  // Captions, emojis, the logo.
  let v = acc;
  if (input.ass) {
    const fd = input.fontsDir ? `:fontsdir=${input.fontsDir.replace(/:/g, "\\:")}` : "";
    parts.push(`${v}ass=${"{ASS}"}${fd}[vs]`);
    v = "[vs]";
  }
  input.emojis.forEach((e, i) => {
    const ei = addInput("-loop", "1", "-framerate", "30", "-t", Math.max(0.1, e.to - e.from).toFixed(3), "-i", e.file);
    parts.push(`[${ei}:v]scale=${e.size}:${e.size},format=rgba,fade=t=in:st=0:d=0.12:alpha=1,setpts=PTS-STARTPTS+${e.from.toFixed(3)}/TB[em${i}]`);
    parts.push(`${v}[em${i}]overlay=${Math.round(e.x - e.size / 2)}:${Math.round(e.y - e.size / 2)}:format=auto:eof_action=pass[ve${i}]`);
    v = `[ve${i}]`;
  });
  if (input.logo) {
    const li = addInput("-i", input.logo.file);
    const lw = Math.round(Math.min(W, H) * LOGO_W[input.logo.size] * (wide ? 1.1 : 1));
    const m = Math.round(Math.min(W, H) * 0.045);
    const x = input.logo.corner.endsWith("l") ? `${m}` : `W-w-${m}`;
    const y = input.logo.corner.startsWith("t") ? `${Math.round(m * (H > W ? 1.6 : 1))}` : `H-h-${Math.round(m * (H > W ? 1.6 : 1))}`;
    parts.push(`[${li}:v]scale=${lw}:-1,format=rgba[lg]`);
    parts.push(`${v}[lg]overlay=${x}:${y}:format=auto[vl]`);
    v = "[vl]";
  }
  parts.push(`${v}format=yuv420p,trim=duration=${total.toFixed(3)}[v]`);

  // The voice from the cut, with music low under it.
  const voice = `[${youIn}:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:${total.toFixed(3)}`;
  if (input.music) {
    const mi = addInput("-stream_loop", "-1", "-i", input.music.file);
    const gain = Math.max(0, Math.min(1, input.music.volume / 100));
    parts.push(`${voice}[vo]`);
    parts.push(`[${mi}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${gain.toFixed(2)},atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[mus]`);
    parts.push(`[vo][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`);
  } else parts.push(`${voice}[a]`);
  return { args, graph: parts.join(";\n"), pieces, lens };
}

/** Draws the overlays the transitions need, as PNGs at this size. */
async function overlays(pieces: Piece[], W: number, H: number, dir: string) {
  const sharp = (await import("sharp")).default;
  const out: Partial<Record<OverlayKind, string>> = {};
  for (const p of pieces) {
    const k = RECIPES[p.tr].overlay;
    if (!k || out[k]) continue;
    const { svg } = overlaySvg(k, W, H);
    const file = path.join(dir, `ov-${k}.png`);
    await sharp(Buffer.from(svg)).png().toFile(file);
    out[k] = file;
  }
  return out;
}

/** One size of the edit. */
export async function renderEdit(input: EditRenderInput): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-edit-"));
  try {
    const ov = await overlays(input.pieces, input.w, input.h, dir);
    const { args, graph } = editGraph(input, ov);
    let g = graph;
    if (input.ass) {
      const assFile = path.join(dir, "captions.ass");
      fs.writeFileSync(assFile, input.ass);
      g = g.replace("{ASS}", assFile.replace(/:/g, "\\:"));
    }
    const gf = path.join(dir, "graph.txt");
    fs.writeFileSync(gf, g);
    const out = path.join(dir, "out.mp4");
    const long = input.total > 300;
    const full = ["-y", "-loglevel", "error", ...args, "-/filter_complex", gf, "-map", "[v]", "-map", "[a]", "-t", input.total.toFixed(3), "-c:v", "libx264", "-preset", long ? "veryfast" : "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out];
    await run(await ff(), full, { maxBuffer: 50 * 1024 * 1024, timeout: Math.max(15, Math.ceil(input.total / 60) * 8) * 60_000 }).catch(fail("The edit didn't finish"));
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
