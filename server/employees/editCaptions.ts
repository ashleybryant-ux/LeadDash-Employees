import type { CutLine, EditLook, EWord, CapStyle } from "./editLook";

/**
 * Captions for Edit my video, written as an ASS subtitle file ffmpeg burns in: the 12 styles, word
 * by word with the word being said highlighted, plus the hook title over the first 3 seconds.
 * Also where each emoji sits, since emojis are pictures laid over the video, not font glyphs.
 */

const assTime = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (Math.max(0, t) % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};
/** #RRGGBB as an ASS color (&HAABBGGRR). */
export const assColor = (hex: string, alpha = "00") => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
const clean = (t: string) => t.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");

type Spec = {
  /** Font size as a share of the short side. */
  size: number;
  upper: boolean;
  /** Words on screen at once. */
  per: number;
  font?: string;
  bold: boolean;
  primary: string;
  outlineColor: string;
  box: boolean;
  outline: (size: number) => number;
  shadow: (size: number) => number;
  /** How the word being said stands out. */
  hi: "color" | "color-pop" | "scale" | "fill" | "reveal" | "none";
  prefix?: string;
};

const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";
export const SPECS: Record<CapStyle, Spec> = {
  pop: { size: 0.078, upper: true, per: 3, bold: true, primary: WHITE, outlineColor: BLACK, box: false, outline: (s) => Math.max(3, Math.round(s / 11)), shadow: () => 1, hi: "color-pop" },
  gold: { size: 0.068, upper: true, per: 4, bold: true, primary: WHITE, outlineColor: BLACK, box: false, outline: (s) => Math.max(2, Math.round(s / 15)), shadow: () => 2, hi: "color" },
  boxed: { size: 0.056, upper: true, per: 4, bold: true, primary: WHITE, outlineColor: "&H40000000", box: true, outline: (s) => Math.round(s / 4), shadow: () => 0, hi: "color" },
  clean: { size: 0.052, upper: false, per: 5, bold: false, primary: WHITE, outlineColor: BLACK, box: false, outline: () => 0, shadow: () => 2, hi: "color" },
  neon: { size: 0.066, upper: true, per: 4, bold: true, primary: assColor("#7DFCFF"), outlineColor: assColor("#00B8FF"), box: false, outline: () => 3, shadow: () => 0, hi: "color", prefix: "\\blur4" },
  hook: { size: 0.11, upper: true, per: 2, bold: true, primary: WHITE, outlineColor: BLACK, box: false, outline: (s) => Math.max(4, Math.round(s / 9)), shadow: () => 2, hi: "color-pop" },
  type: { size: 0.056, upper: false, per: 6, font: "DejaVu Sans Mono", bold: true, primary: WHITE, outlineColor: BLACK, box: false, outline: () => 2, shadow: () => 2, hi: "reveal" },
  highlight: { size: 0.06, upper: true, per: 4, bold: true, primary: BLACK, outlineColor: assColor("#D8FF3D"), box: true, outline: (s) => Math.round(s / 5), shadow: () => 0, hi: "scale" },
  outline: { size: 0.075, upper: true, per: 3, bold: true, primary: "&HFFFFFFFF", outlineColor: WHITE, box: false, outline: (s) => Math.max(2, Math.round(s / 16)), shadow: () => 0, hi: "fill" },
  shadow: { size: 0.07, upper: true, per: 3, bold: true, primary: WHITE, outlineColor: BLACK, box: false, outline: () => 0, shadow: (s) => Math.max(3, Math.round(s / 12)), hi: "color" },
  pill: { size: 0.056, upper: false, per: 5, bold: true, primary: BLACK, outlineColor: WHITE, box: true, outline: (s) => Math.round(s / 3.5), shadow: () => 0, hi: "scale" },
  lower: { size: 0.045, upper: false, per: 7, bold: true, primary: WHITE, outlineColor: assColor("#1B6B4A"), box: true, outline: (s) => Math.round(s / 3), shadow: () => 0, hi: "none" },
};

const SIZE_MULT = { s: 0.85, m: 1, l: 1.18 } as const;

export type CaptionPlace = { size: number; y: number };

/** Where captions sit (center line of the text, in pixels) and how big, for emojis placed above. */
export function placeOf(w: number, h: number, look: EditLook): CaptionPlace {
  const tall = h > w;
  const spec = SPECS[look.captions.style];
  const size = Math.round(Math.min(w, h) * spec.size * (tall ? 1 : 0.9) * SIZE_MULT[look.captions.size]);
  if (look.captions.style === "lower") return { size, y: h - Math.round(h * (tall ? 0.14 : 0.1)) };
  const pos = look.captions.position;
  const y = pos === "middle" ? Math.round(h * 0.5) : pos === "top" ? Math.round(h * (tall ? 0.16 : 0.12)) : Math.round(h * (tall ? 0.8 : 0.88));
  return { size, y };
}

function chunks(words: EWord[], per: number) {
  const out: EWord[][] = [];
  let cur: EWord[] = [];
  for (const wd of words) {
    cur.push(wd);
    if (cur.length >= per || /[.!?,;:]["')\]]*$/.test(wd.text)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The ASS file: caption style, word-by-word events, and the hook title. Null when there's nothing to show. */
export function editAss(w: number, h: number, cut: CutLine[], look: EditLook, colors: { brand: string | null }) {
  const caps = look.captions;
  const hook = look.tools.hook.on && look.tools.hook.text.trim() ? look.tools.hook.text.trim() : "";
  if (!caps.on && !hook) return null;
  const tall = h > w;
  const spec = SPECS[caps.style];
  const place = placeOf(w, h, look);
  const size = place.size;
  const brand = colors.brand && /^#[0-9a-f]{6}$/i.test(colors.brand) ? colors.brand : null;
  const hiHex = caps.highlight === "none" ? null : caps.highlight === "brand" ? brand ?? "#F5C542" : "#F5C542";
  const lower = caps.style === "lower";
  const align = lower ? 1 : caps.position === "top" ? 8 : caps.position === "middle" ? 5 : 2;
  const marginV = lower ? Math.round(h * (tall ? 0.12 : 0.08)) : caps.position === "middle" ? 0 : Math.round(h * (caps.position === "top" ? 0.11 : tall ? 0.17 : 0.09));
  const marginL = lower ? Math.round(w * 0.06) : Math.round(w * 0.08);
  const outlineColor = lower && brand ? assColor(brand) : spec.outlineColor;
  const styles = [
    `Style: Cap,${spec.font ?? "DejaVu Sans"},${size},${spec.primary},${WHITE},${outlineColor},&H80000000,${spec.bold ? 1 : 0},0,0,0,100,100,0,0,${spec.box ? 3 : 1},${spec.outline(size)},${spec.shadow(size)},${align},${marginL},${Math.round(w * 0.08)},${marginV},1`,
  ];
  const hookSize = Math.round(Math.min(w, h) * (tall ? 0.072 : 0.06));
  if (hook) styles.push(`Style: Hook,DejaVu Sans,${hookSize},${WHITE},${WHITE},${assColor(brand ?? "#111111")},&H80000000,1,0,0,0,100,100,0,0,3,${Math.round(hookSize / 3)},0,8,${Math.round(w * 0.08)},${Math.round(w * 0.08)},${Math.round(h * (tall ? 0.09 : 0.07))},1`);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join("\n")}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events: string[] = [];
  if (hook) events.push(`Dialogue: 1,${assTime(0)},${assTime(3)},Hook,,0,0,0,,{\\fad(150,250)}${clean(hook.toUpperCase())}`);
  if (caps.on) {
    const pre = spec.prefix ? `{${spec.prefix}}` : "";
    const shown = (t: string) => clean(spec.upper ? t.toUpperCase() : t);
    for (const line of cut) {
      const cs = chunks(line.words, tall ? spec.per : spec.per + 1);
      cs.forEach((c, ci) => {
        const nextStart = cs[ci + 1]?.[0]?.start ?? Math.max(line.to, c[c.length - 1].end) + 0.25;
        const end = Math.min(nextStart, c[c.length - 1].end + 0.6);
        if (spec.hi === "none" || (!hiHex && (spec.hi === "color" || spec.hi === "color-pop" || spec.hi === "fill"))) {
          events.push(`Dialogue: 0,${assTime(c[0].start)},${assTime(end)},Cap,,0,0,0,,${pre}${shown(c.map((x) => x.text).join(" "))}`);
          return;
        }
        c.forEach((wd, k) => {
          const from = k === 0 ? c[0].start : wd.start;
          const to = k + 1 < c.length ? c[k + 1].start : end;
          let text: string;
          if (spec.hi === "reveal") text = c.slice(0, k + 1).map((x) => shown(x.text)).join(" ");
          else
            text = c
              .map((x, j) => {
                if (j !== k) return shown(x.text);
                const tag =
                  spec.hi === "scale" ? "\\fscx115\\fscy115" : spec.hi === "fill" ? `\\1a&H00&\\c${assColor(hiHex!)}&` : spec.hi === "color-pop" ? `\\c${assColor(hiHex!)}&\\fscx110\\fscy110` : `\\c${assColor(hiHex!)}&`;
                return `{${tag}}${shown(x.text)}{\\r}${spec.prefix ? `{${spec.prefix}}` : ""}`;
              })
              .join(" ");
          events.push(`Dialogue: 0,${assTime(from)},${assTime(Math.max(from + 0.05, to))},Cap,,0,0,0,,${pre}${text}`);
        });
      });
    }
  }
  return head + events.join("\n") + "\n";
}

/** The emojis Elena can add, by name, as Twemoji pictures (CC-BY 4.0, Twitter). */
export const EMOJIS: Record<string, string> = {
  fire: "1f525", rocket: "1f680", star: "2b50", sparkles: "2728", heart: "2764", check: "2705", cross: "274c", warning: "26a0",
  idea: "1f4a1", money: "1f4b0", chart: "1f4c8", target: "1f3af", clock: "23f0", calendar: "1f4c5", phone: "1f4f1", laptop: "1f4bb",
  thinking: "1f914", mindblown: "1f92f", laugh: "1f602", smile: "1f60a", eyes: "1f440", clap: "1f44f", thumbsup: "1f44d", muscle: "1f4aa",
  pray: "1f64f", wave: "1f44b", point: "1f449", hundred: "1f4af", trophy: "1f3c6", gift: "1f381", house: "1f3e0", brain: "1f9e0",
  key: "1f511", lock: "1f512", mail: "1f4e7", megaphone: "1f4e3", question: "2753", exclamation: "2757", party: "1f389", coffee: "2615",
};
export const EMOJI_NAMES = Object.keys(EMOJIS);
