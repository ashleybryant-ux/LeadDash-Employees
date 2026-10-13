import * as hours from "../workHours";
import type * as broll from "./broll";
import { RECIPES, SPEED_SECONDS, TRANSITIONS, isTrans, type Speed, type TransKey } from "./transitions";

/**
 * Edit my video: the shape of an edit and the plain math behind the cut. Times on lines and words
 * are seconds in the upload; the cut removes silences, bad takes and anything outside a short
 * clip, and everything on screen is placed in the cut's own time.
 */

export type EWord = { text: string; start: number; end: number };
export type BrollSrc = "library" | "stock" | "ai" | "upload";
export type BrollPick = { src: BrollSrc; clipId?: number | null; file: string; thumb?: string | null; name: string; credit?: string | null; page?: string | null };
export type EditLine = {
  from: number;
  to: number;
  text: string;
  words: EWord[];
  /** B-roll over this line (the voice keeps playing under it). */
  broll?: BrollPick | null;
  /** Elena added the b-roll (Redo auto b-roll replaces only hers). */
  auto?: boolean;
  /** The transition into this line's picture, when the picture changes here. */
  tr?: { key: TransKey; auto: boolean } | null;
  /** Elena's picks for the polish tools. */
  emoji?: string | null;
  zoom?: boolean;
  /** A bad take: an earlier try of a line said again. Cut when Remove bad takes is on. */
  drop?: boolean;
  /** The captions in another language (Translate captions). */
  tx?: string | null;
};

export const CAP_STYLES = {
  pop: "Bold pop",
  gold: "Gold word",
  boxed: "Boxed",
  clean: "Clean",
  neon: "Neon",
  hook: "Big hook",
  type: "Typewriter",
  highlight: "Highlight",
  outline: "Outline",
  shadow: "Shadow",
  pill: "Pill",
  lower: "Lower third",
} as const;
export type CapStyle = keyof typeof CAP_STYLES;
export const CAP_KEYS = Object.keys(CAP_STYLES) as CapStyle[];
/** The folder tabs on Style. */
export const CAP_GROUP: Record<CapStyle, "Bold" | "Clean" | "Boxed"> = { pop: "Bold", gold: "Bold", boxed: "Boxed", clean: "Clean", neon: "Bold", hook: "Bold", type: "Clean", highlight: "Boxed", outline: "Bold", shadow: "Bold", pill: "Boxed", lower: "Clean" };

export type Layout = "full" | "split" | "green" | "pip";
export const LAYOUT_LABEL: Record<Layout, string> = { full: "Full screen", split: "Split screen", green: "Green screen", pip: "Picture in picture" };

/** Languages the captions can be translated into (ones the caption font can write). */
export const LANGUAGES = ["Spanish", "French", "Portuguese", "German", "Italian", "Dutch", "Polish", "Romanian", "Swedish", "Norwegian", "Danish", "Finnish", "Czech", "Slovak", "Hungarian", "Croatian", "Slovenian", "Turkish", "Indonesian", "Malay", "Filipino", "Vietnamese", "Swahili", "Haitian Creole", "Russian", "Ukrainian", "Greek", "Bulgarian", "Lithuanian", "Latvian", "Estonian", "Catalan"] as const;

export type EditLook = {
  captions: { on: boolean; style: CapStyle; position: "top" | "middle" | "bottom"; highlight: "gold" | "brand" | "none"; size: "s" | "m" | "l"; emojis: boolean };
  tools: { autoBroll: boolean; transitions: boolean; zooms: boolean; hook: { on: boolean; text: string }; cleanAudio: boolean; silences: boolean; badTakes: boolean; translate: { on: boolean; lang: string } };
  music: { on: boolean; track: broll.TrackKey | "upload"; url?: string | null; name?: string | null; volume: number };
  /** sound: the sound that goes with each transition (a whoosh, a pop...), on or off. */
  transition: { speed: Speed; sound: boolean };
  layout: {
    kind: Layout;
    split: { you: "top" | "bottom"; other: "auto" | "clip" | "video"; when: "whole" | "broll"; clipId?: number | null; videoUrl?: string | null; videoName?: string | null };
    green: { bg: "color" | "clip" | "picture" | "style"; color: string; clipId?: number | null; url?: string | null; style?: string | null; place?: string | null; drawn?: string | null };
    pip: { corner: "tl" | "tr" | "bl" | "br" };
  };
  logo: { on: boolean; corner: "tl" | "tr" | "bl" | "br"; size: "s" | "m" | "l" };
  /** Short clips: the part of the upload this one is cut from. */
  trim?: { from: number; to: number } | null;
};

export const DEFAULT_EDIT_LOOK: EditLook = {
  captions: { on: true, style: "pop", position: "middle", highlight: "gold", size: "m", emojis: false },
  tools: { autoBroll: true, transitions: true, zooms: true, hook: { on: false, text: "" }, cleanAudio: false, silences: true, badTakes: false, translate: { on: false, lang: "Spanish" } },
  music: { on: false, track: "calm", volume: 15 },
  transition: { speed: "normal", sound: true },
  layout: {
    kind: "full",
    split: { you: "top", other: "auto", when: "whole" },
    green: { bg: "color", color: "#1B6B4A" },
    pip: { corner: "br" },
  },
  logo: { on: true, corner: "br", size: "m" },
};

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** A stored look, with anything missing filled from the defaults. */
export function editLookOf(raw: string | null | undefined): EditLook {
  const l = parse<Partial<EditLook>>(raw, {});
  const d = DEFAULT_EDIT_LOOK;
  const t = (l.tools ?? {}) as Partial<EditLook["tools"]>;
  const lay = (l.layout ?? {}) as Partial<EditLook["layout"]>;
  return {
    captions: { ...d.captions, ...(l.captions ?? {}) },
    tools: { ...d.tools, ...t, hook: { ...d.tools.hook, ...(t.hook ?? {}) }, translate: { ...d.tools.translate, ...(t.translate ?? {}) } },
    music: { ...d.music, ...(l.music ?? {}) },
    transition: { ...d.transition, ...(l.transition ?? {}) },
    layout: { kind: lay.kind ?? d.layout.kind, split: { ...d.layout.split, ...(lay.split ?? {}) }, green: { ...d.layout.green, ...(lay.green ?? {}) }, pip: { ...d.layout.pip, ...(lay.pip ?? {}) } },
    logo: { ...d.logo, ...(l.logo ?? {}) },
    trim: l.trim ?? null,
  };
}
export const linesOf = (raw: string | null | undefined) => parse<EditLine[]>(raw, []).filter((x) => x && typeof x.from === "number" && Array.isArray(x.words));

// ==========================================
// Lines from the transcript
// ==========================================

/** Words grouped into caption lines: a sentence or a breath, about 3 to 4 seconds, at most 12 words. */
export function linesFrom(words: EWord[]): EditLine[] {
  const out: EditLine[] = [];
  let cur: EWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ from: cur[0].start, to: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" "), words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    const next = words[i + 1];
    cur.push(w);
    const len = w.end - cur[0].start;
    const pause = next ? next.start - w.end : 0;
    if (!next || cur.length >= 12 || (/[.!?]["')\]]*$/.test(w.text) && len > 1.2) || (/[,;:]["')\]]*$/.test(w.text) && len > 2.6) || pause > 0.7 || len > 4.2) flush();
  });
  flush();
  return out;
}

/** New words for a line someone fixed: spread across the line's time, longer words a little longer. */
export function spreadWords(text: string, from: number, to: number): EWord[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const weight = toks.map((t) => 1 + t.length / 6);
  const total = weight.reduce((a, b) => a + b, 0);
  const span = Math.max(0.2, to - from);
  let at = from;
  return toks.map((t, i) => {
    const len = (span * weight[i]) / total;
    const w = { text: t, start: +at.toFixed(3), end: +(at + len).toFixed(3) };
    at += len;
    return w;
  });
}

// ==========================================
// The cut: what's kept, and where things land
// ==========================================

export type Range = { from: number; to: number };

/** The parts of the upload that stay in: inside a short clip's trim, without bad takes, and with long pauses cut down. */
export function keepRanges(lines: EditLine[], look: EditLook, seconds: number): Range[] {
  const a = Math.max(0, look.trim?.from ?? 0);
  const b = Math.min(seconds, look.trim?.to ?? seconds);
  if (b <= a) return [];
  const dropped = (l: EditLine) => look.tools.badTakes && !!l.drop;
  let ranges: Range[];
  if (look.tools.silences) {
    // Each run of words with pauses under half a second stays together, with a little air on each side.
    const pad = 0.15;
    const words = lines.filter((l) => !dropped(l)).flatMap((l) => l.words).sort((x, y) => x.start - y.start);
    ranges = [];
    for (const w of words) {
      const last = ranges[ranges.length - 1];
      if (last && w.start - pad <= last.to + 0.2) last.to = Math.max(last.to, w.end + pad);
      else ranges.push({ from: w.start - pad, to: w.end + pad });
    }
    if (!words.length) ranges = [{ from: a, to: b }];
  } else {
    ranges = [{ from: a, to: b }];
    for (const l of lines.filter(dropped)) ranges = subtract(ranges, { from: l.from - 0.05, to: l.to + 0.05 });
  }
  const out = ranges.map((r) => ({ from: Math.max(a, r.from), to: Math.min(b, r.to) })).filter((r) => r.to - r.from >= 0.08);
  return out.map((r) => ({ from: +r.from.toFixed(3), to: +r.to.toFixed(3) }));
}

function subtract(ranges: Range[], cut: Range) {
  const out: Range[] = [];
  for (const r of ranges) {
    if (cut.to <= r.from || cut.from >= r.to) out.push(r);
    else {
      if (cut.from > r.from) out.push({ from: r.from, to: cut.from });
      if (cut.to < r.to) out.push({ from: cut.to, to: r.to });
    }
  }
  return out;
}

export const cutLength = (ranges: Range[]) => ranges.reduce((n, r) => n + (r.to - r.from), 0);

/** A moment in the upload as a moment in the cut (a moment that was cut out lands where the cut picks up). */
export function mapTime(ranges: Range[], t: number) {
  let out = 0;
  for (const r of ranges) {
    if (t < r.from) return out;
    if (t <= r.to) return out + (t - r.from);
    out += r.to - r.from;
  }
  return out;
}

export type CutLine = { i: number; from: number; to: number; words: EWord[]; line: EditLine };

/** The lines that stay in, in the cut's time, with captions in the language picked. */
export function cutLines(lines: EditLine[], look: EditLook, ranges: Range[]): CutLine[] {
  const total = cutLength(ranges);
  const out: CutLine[] = [];
  lines.forEach((line, i) => {
    if (look.tools.badTakes && line.drop) return;
    const inside = line.words.filter((w) => ranges.some((r) => w.end > r.from && w.start < r.to));
    if (!inside.length) return;
    const from = mapTime(ranges, inside[0].start);
    const to = Math.min(total, Math.max(from + 0.2, mapTime(ranges, inside[inside.length - 1].end)));
    const translated = look.tools.translate.on && line.tx?.trim();
    const words = translated ? spreadWords(line.tx!, from, to) : inside.map((w) => ({ text: w.text, start: mapTime(ranges, w.start), end: Math.max(mapTime(ranges, w.start) + 0.05, mapTime(ranges, w.end)) }));
    out.push({ i, from, to, words, line });
  });
  return out;
}

export type Piece = { from: number; to: number; broll: BrollPick | null; line: number; tr: TransKey; d: number };

/**
 * The pictures in order: the person, or b-roll over a line. A new piece starts wherever the picture
 * changes, with the transition into it; b-roll stays up until the next line starts.
 */
export function piecesOf(cut: CutLine[], look: EditLook, total: number): Piece[] {
  if (total <= 0) return [];
  const speed = SPEED_SECONDS[look.transition.speed] ?? 0.5;
  const pieces: Piece[] = [];
  const keyOf = (p: BrollPick | null | undefined) => (p ? `${p.src}:${p.clipId ?? ""}:${p.file}` : "you");
  cut.forEach((c, k) => {
    const pick = c.line.broll ?? null;
    const from = k === 0 ? 0 : c.from;
    const last = pieces[pieces.length - 1];
    if (last && keyOf(last.broll) === keyOf(pick)) return;
    if (last) last.to = from;
    const tr: TransKey = !look.tools.transitions || !last ? "none" : c.line.tr && isTrans(c.line.tr.key) ? c.line.tr.key : pick ? "zoomblur" : "fade";
    pieces.push({ from, to: total, broll: pick, line: c.i, tr, d: speed });
  });
  if (!pieces.length) pieces.push({ from: 0, to: total, broll: null, line: 0, tr: "none", d: speed });
  // A transition never takes more than a third of either side.
  pieces.forEach((p, k) => {
    const prev = pieces[k - 1];
    if (!prev || RECIPES[p.tr].xfade === null) {
      p.tr = prev ? p.tr : "none";
      return;
    }
    p.d = +Math.max(0.12, Math.min(p.d, (p.to - p.from) / 3, (prev.to - prev.from) / 3)).toFixed(3);
  });
  return pieces.filter((p) => p.to - p.from > 0.04);
}

export const transLabel = (k: TransKey) => TRANSITIONS[k].label;

/** Work hours to export: 2 for each minute of the finished video, once. */
export const editMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60)) * hours.JOBS.edit.minutes;
/** Green screen: 2 more for each minute of the upload (the whole upload is cut out once). */
export const greenMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60)) * hours.JOBS.green.minutes;
