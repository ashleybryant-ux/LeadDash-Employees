import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import * as hours from "../workHours";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import { storagePut, uploadsRoot } from "../storage";
import { videos, type AIEmployee, type Video } from "../../drizzle/schema";
import { withUsage } from "../usage";
import * as avatar from "./avatar";
import * as broll from "./broll";
import * as styles from "./styles";
import { systemPromptFor } from "./tasks";

/**
 * Elena's video agent: any video from an idea, a script kept word for word, a link or a recording.
 * Formats: Ad, B-roll story, Explainer, Personal story, Audio to video (and the older Slideshow).
 * Talking to camera is the avatar path (avatar.ts); writeTalking hands off to it.
 *
 * 1. Plan: Elena writes the hook first, then the scenes. Each scene has what we see, the line
 *    that's said, and where its footage comes from, in this order: the b-roll library, licensed
 *    stock (Pexels), a new AI clip that moves (saved to the library), motion text, the logo end card.
 *    Nothing is made until they press Make the video.
 * 2. Make: the voice-over is read (or their recording is cut), new footage is made, and ffmpeg cuts
 *    every size they picked from one job, with word-by-word captions, their logo and music.
 * 3. Edit: captions, logo and music change with a re-render that makes no new footage (no work hours).
 *    Redo a scene makes only that scene's footage again.
 * Work hours: 8 for each minute of video, counted by the half minute, once per video; plus 2 for
 * each 5 seconds of new AI clip. Library and stock clips use none.
 */

const run = promisify(execFile);

export type Kind = "broll" | "slideshow" | "explainer" | "ad" | "story" | "audio";
export type Format = Kind | "talking";
export type Size = "vertical" | "square" | "wide";
export type Source = "idea" | "script" | "link" | "audio";
/** Where a scene's picture comes from. */
export type Src = "library" | "stock" | "ai" | "text" | "logo" | "photo" | "art";
export type StockRef = { url: string; page: string; thumb: string; credit: string };
export type VShot = {
  at: number;
  see: string;
  say: string;
  photo?: string;
  src?: Src;
  /** The library clip used (library), or the AI clip made for it (ai). */
  clipId?: number | null;
  stock?: StockRef | null;
  /** Search words for stock footage. */
  query?: string;
  /** The footage as kept (a library clip, the kept stock clip, a Brain photo, a drawn picture or its animated clip). Empty means it still has to be made. */
  file?: string | null;
  /** Drawn styles: the people in this scene, by name (from the cast). */
  who?: string[];
  /** Drawn styles: the picture drawn for this scene. */
  still?: string | null;
};
export type Script = { shots: VShot[]; caption: string; segment?: { from: number; to: number } | null };
export type Word = { text: string; start: number; end: number };

export type CaptionStyle = "pop" | "clean" | "boxed";
export type CaptionPosition = "top" | "middle" | "bottom";
export type Highlight = "gold" | "brand" | "none";
export type Corner = "tl" | "tr" | "bl" | "br";
export type LogoSize = "s" | "m" | "l";
export type Look = {
  captions: { on: boolean; style: CaptionStyle; position: CaptionPosition; highlight: Highlight };
  logo: { on: boolean; corner: Corner; size: LogoSize };
  music: { track: broll.TrackKey | "upload" | "none"; url?: string | null; name?: string | null; volume: number };
};

export const KINDS: Kind[] = ["ad", "broll", "explainer", "story", "audio", "slideshow"];
export const KIND_LABEL: Record<Format, string> = { ad: "Ad", broll: "B-roll story", explainer: "Explainer", talking: "Talking to camera", story: "Personal story", audio: "Audio to video", slideshow: "Slideshow" };
export const SIZES: Record<Size, { w: number; h: number; ratio: string; label: string }> = {
  vertical: { w: 1080, h: 1920, ratio: "9:16", label: "vertical" },
  square: { w: 1080, h: 1080, ratio: "1:1", label: "square" },
  wide: { w: 1920, h: 1080, ratio: "16:9", label: "wide" },
};
export const SRC_LABEL: Record<Src, string> = { library: "Your b-roll", stock: "Stock clip", ai: "AI shot", text: "Kinetic text", logo: "Logo end", photo: "Your photo", art: "Drawn scene" };
export const CAPTION_LABEL: Record<CaptionStyle, string> = { pop: "Bold pop", clean: "Clean", boxed: "Boxed" };
export const POSITION_LABEL: Record<CaptionPosition, string> = { top: "top", middle: "middle", bottom: "bottom" };
export const HIGHLIGHT_LABEL: Record<Highlight, string> = { gold: "gold highlight", brand: "brand color highlight", none: "no highlight" };
export const CORNER_LABEL: Record<Corner, string> = { tl: "top left", tr: "top right", bl: "bottom left", br: "bottom right" };
export const LOGO_SIZE_LABEL: Record<LogoSize, string> = { s: "small", m: "medium", l: "large" };
const GOLD = "#F5C542";

export const DEFAULT_LOOK: Look = {
  captions: { on: true, style: "pop", position: "middle", highlight: "gold" },
  logo: { on: true, corner: "br", size: "m" },
  music: { track: "calm", volume: 20 },
};

/** The voice when the workspace has no avatar voice of its own. */
export const DEFAULT_VOICE = { id: `${avatar.STANDARD}coral`, name: "Coral" };

/** The kind someone asked for, from Elena's words ("b-roll", "an ad", "me on camera"); null when unclear. */
export function kindFrom(words: string): Format | null {
  const w = words.trim().toLowerCase();
  if (!w) return null;
  if (/talk|camera|avatar|\bme\b|on screen|presenter/.test(w)) return "talking";
  if (/\bads?\b|advert|promo|commercial|sell/.test(w)) return "ad";
  if (/audio|podcast|recording|voice memo/.test(w)) return "audio";
  if (/personal|my story|our story/.test(w)) return "story";
  if (/slide|photo/.test(w)) return "slideshow";
  if (/explain|text|card|typograph|kinetic/.test(w)) return "explainer";
  if (/b-?roll|broll|voice|footage|stock|cinematic|story/.test(w)) return "broll";
  return null;
}

export function sizeFrom(words: string): Size {
  const w = words.trim().toLowerCase();
  if (/square|1:1|feed/.test(w)) return "square";
  if (/wide|landscape|horizontal|16:9|youtube(?! short)/.test(w)) return "wide";
  return "vertical";
}

/** Work hours for a video's length: 8 for each minute, counted by the half minute. */
export const workMinutes = (tenths: number | null | undefined) => (hours.JOBS.video.minutes / 2) * Math.max(1, Math.ceil((tenths ?? 0) / 300));
export const hoursLabel = (minutes: number) => {
  const h = hours.hoursNum(minutes);
  return `${h} work ${h === "1" ? "hour" : "hours"}`;
};

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const scriptOf = (v: Pick<Video, "script">) => {
  const s = parse<Partial<Script>>(v.script, {});
  return { shots: Array.isArray(s.shots) ? s.shots : [], caption: s.caption ?? "", segment: s.segment ?? null } as Script;
};
export const voiceOverOf = (v: Pick<Video, "script">) => scriptOf(v).shots.map((s) => s.say.trim()).filter(Boolean).join(" ");
export const sizesOf = (v: Pick<Video, "size" | "sizes">): Size[] => {
  const list = parse<string[]>(v.sizes, []).filter((s): s is Size => s in SIZES);
  return list.length ? Array.from(new Set(list)) : [v.size];
};
export function lookOf(v: Pick<Video, "look">): Look {
  const l = parse<Partial<Look>>(v.look, {});
  return {
    captions: { ...DEFAULT_LOOK.captions, ...(l.captions ?? {}) },
    logo: { ...DEFAULT_LOOK.logo, ...(l.logo ?? {}) },
    music: { ...DEFAULT_LOOK.music, ...(l.music ?? {}) },
  };
}
const urlsOf = (v: Pick<Video, "videoUrls">) => parse<Partial<Record<Size, string>>>(v.videoUrls, {});

// ==========================================
// Rows (every read and write is by workspace)
// ==========================================

export function get(orgId: number, id: number) {
  return db.getDb().select().from(videos).where(and(eq(videos.id, id), eq(videos.organizationId, orgId))).get() ?? null;
}
export function list(orgId: number) {
  const rows = db.getDb().select().from(videos).where(eq(videos.organizationId, orgId)).orderBy(desc(videos.id)).all();
  // A video left "making" by a restart would sit forever: after 30 minutes with no job running it didn't finish.
  for (const r of rows) {
    if (r.status === "making" && !jobs.has(r.id) && Date.now() - new Date(r.updatedAt).getTime() > 30 * 60_000) {
      Object.assign(r, update(orgId, r.id, { status: "failed", error: "It stopped before it finished. Press Make it to try again." }));
    }
  }
  return rows;
}
function update(orgId: number, id: number, data: Partial<typeof videos.$inferInsert>) {
  db.getDb().update(videos).set(data).where(and(eq(videos.id, id), eq(videos.organizationId, orgId))).run();
  return get(orgId, id)!;
}
function must(orgId: number, id: number) {
  const v = get(orgId, id);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  return v;
}
function notMaking(v: Video) {
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
}
export function remove(orgId: number, id: number) {
  const v = must(orgId, id);
  notMaking(v);
  db.getDb().delete(videos).where(and(eq(videos.id, id), eq(videos.organizationId, orgId))).run();
}

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  return emp;
}

/** The voice for a new video: the one picked, else the workspace's own avatar voice, else a standard voice. */
async function voiceFor(orgId: number, picked?: string | null) {
  if (picked) {
    const found = (await avatar.voices(orgId)).find((x) => x.id === picked);
    if (found) return { id: found.id, name: found.name };
  }
  const s = avatar.settingsOf(await elena(orgId));
  if (s.voiceId && (avatar.isStandard(s.voiceId) || (await avatar.hasElevenLabs(orgId)))) return { id: s.voiceId, name: s.voiceName ?? "Your voice" };
  return DEFAULT_VOICE;
}

async function brand(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const colors = parse<string[]>(org?.brandColors, []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const logo = org?.logoUrl?.startsWith("/files/") && fs.existsSync(broll.localFile(org.logoUrl)) ? broll.localFile(org.logoUrl) : null;
  return { colors, logo, name: org?.name ?? "" };
}

// ==========================================
// Writing the storyboard
// ==========================================

const SRC_ENUM: Src[] = ["library", "stock", "ai", "text", "logo", "photo"];

const SHOT_PROPS = {
  see: { type: "string", description: "What we see: one continuous shot with real motion, or the few words on a motion text card." },
  photo: { type: "string", description: "Personal story or slideshow: the title of the workspace photo for this scene. '' otherwise." },
  src: { type: "string", enum: SRC_ENUM, description: "library: a clip from their b-roll library fits (give its id in clip). stock or ai: real footage of what we see. text: motion text. logo: the closing call to action on their logo. photo: one of their photos." },
  clip: { type: "integer", description: "The b-roll library clip id when src is library, else 0." },
  query: { type: "string", description: "Two to five words to search stock video for this scene, like 'phone ringing front desk'." },
  who: { type: "array", items: { type: "string" }, description: "Drawn styles: the names (from the cast) of the people in this scene. [] when nobody is in it, and always [] for real footage." },
};
const CAST_SCHEMA = { type: "array", description: "Drawn styles only: each person who appears in the story, with a look described so an artist draws them the same every time (age, hair, skin, clothes). [] for real footage. Never a real client.", items: { type: "object", additionalProperties: false, required: ["name", "look"], properties: { name: { type: "string" }, look: { type: "string" } } } };

const SCRIPT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "shots", "caption", "cast"],
  properties: {
    title: { type: "string", description: "A short title, at most 8 words." },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "see", "say", "photo", "src", "clip", "query", "who"],
        properties: {
          at: { type: "integer", description: "When the scene starts, in seconds from the start." },
          see: SHOT_PROPS.see,
          say: { type: "string", description: "The voice-over words over this scene." },
          photo: SHOT_PROPS.photo,
          src: SHOT_PROPS.src,
          clip: SHOT_PROPS.clip,
          query: SHOT_PROPS.query,
          who: SHOT_PROPS.who,
        },
      },
    },
    cast: CAST_SCHEMA,
    caption: { type: "string", description: "The caption to post with the video." },
  },
};

const HOW: Record<Kind, string> = {
  ad: `An ad that sells one offer. The hook names the problem or the result in the first two seconds, then the offer, proof, and a clear call to action on the logo end card. Real footage scenes ("see" is one continuous shot with real motion: a place, an object, hands, a person seen from behind or far away).`,
  broll: `A b-roll story under a voice-over. Real footage scenes ("see" is one continuous shot with real motion: a place, an object, hands, a person seen from behind or far away). One motion text scene is fine for the key point.`,
  explainer: `An explainer that teaches one idea with motion text. Most scenes are src "text": "see" is the few words on the card (at most 8 words, the point of the scene). A real footage scene is fine for the hook.`,
  story: `A personal story told in the first person. Use their photos (src "photo", the photo's title in "photo") where they fit, real footage scenes for the rest.`,
  audio: `Pictures for a recording that's already said. Real footage scenes.`,
  slideshow: `A slideshow of the workspace's own photos. For each scene pick the photo that fits best by its title, put that title in "photo" and src "photo".`,
};

const RULES = `- The first scene is the hook: it starts at 0 and stops the scroll in the first two seconds.
- Never a readable sign, screen or words in footage, and never a real client.
- Use a library clip (src "library" with its id) whenever one fits the scene; otherwise "stock" for ordinary real-world footage, or "ai" for something specific stock won't have.
- End with the call to action as src "logo" when they gave one.`;

/** How many scenes a video this long can have: about one every 5 seconds, at least 16. */
export const maxScenes = (seconds: number) => Math.min(120, Math.max(16, Math.ceil(seconds / 5)));
const ALL_SRC: Src[] = [...SRC_ENUM, "art"];

function cleanShots(raw: unknown, seconds: number): VShot[] {
  const list = (Array.isArray(raw) ? raw : []) as Partial<VShot & { clip: number }>[];
  const shots = list
    .map((s) => ({
      at: Math.max(0, Math.round(Number(s.at) || 0)),
      see: String(s.see ?? "").trim().slice(0, 300),
      say: String(s.say ?? "").trim().slice(0, 400),
      photo: String(s.photo ?? "").trim().slice(0, 200),
      src: ALL_SRC.includes(s.src as Src) ? (s.src as Src) : undefined,
      clipId: Number(s.clipId ?? s.clip) > 0 ? Number(s.clipId ?? s.clip) : null,
      query: String(s.query ?? "").trim().slice(0, 100),
      stock: s.stock ?? null,
      file: s.file ?? null,
      who: Array.isArray(s.who) ? s.who.map((w) => String(w).trim().slice(0, 60)).filter(Boolean).slice(0, 4) : [],
      still: s.still ?? null,
    }))
    .filter((s) => s.see || s.say)
    .slice(0, maxScenes(seconds))
    .sort((a, b) => a.at - b.at);
  if (shots.length) shots[0].at = 0;
  return shots.map((s) => {
    const out: VShot = { at: Math.min(s.at, Math.max(0, seconds - 1)), see: s.see, say: s.say };
    if (s.photo) out.photo = s.photo;
    if (s.src) out.src = s.src;
    if (s.clipId) out.clipId = s.clipId;
    if (s.query) out.query = s.query;
    if (s.stock) out.stock = s.stock;
    if (s.file) out.file = s.file;
    if (s.who.length) out.who = s.who;
    if (s.still) out.still = s.still;
    return out;
  });
}

/** The cast as Elena wrote it: names and looks, a few people at most. */
function cleanCast(raw: unknown): styles.CastMember[] {
  const list = (Array.isArray(raw) ? raw : []) as Partial<styles.CastMember>[];
  const seen = new Set<string>();
  return list
    .map((c) => ({ name: String(c.name ?? "").trim().slice(0, 60), look: String(c.look ?? "").trim().slice(0, 300) }))
    .filter((c) => c.name && c.look && !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase()))
    .slice(0, 4);
}

/** How a drawn style changes what Elena writes. */
const drawnHow = (label: string) => `This video is drawn in a style (${label}), not filmed: every scene is one picture of one moment, with the people in it by name in "who". Describe the cast once (age, hair, skin, clothes) so they're drawn the same in every scene. src is "art" for every scene except motion text ("text") and the closing logo card ("logo"). Never a real client.`;
const sceneCount = (seconds: number) => (seconds <= 30 ? "3 to 8" : seconds <= 90 ? "6 to 16" : `${Math.max(12, Math.round(seconds / 8))} to ${maxScenes(seconds)}`);

/** What Elena knows to pick from: their library and their photos. */
async function materials(orgId: number, kind: Kind) {
  const clips = broll.readyClips(orgId).slice(0, 40);
  const photos = kind === "story" || kind === "slideshow" ? await avatar.photos(orgId) : [];
  const lines: string[] = [];
  if (clips.length) lines.push(`Their b-roll library (id: title, tags):\n${clips.map((c) => `- ${c.id}: ${c.title}${c.tags ? ` (${c.tags.slice(0, 100)})` : ""}`).join("\n")}`);
  if (photos.length) lines.push(`Their photos:\n${photos.map((p) => `- ${p.title}${p.note ? `: ${p.note.slice(0, 120)}` : ""}`).join("\n")}`);
  return lines.join("\n");
}

/**
 * Where each scene's footage comes from, in order: the library clip Elena picked (or the closest
 * match), their photo, licensed stock, then a new AI clip. Motion text and the logo card stay as they are.
 */
export async function assignSources(orgId: number, kind: Kind, size: Size, shots: VShot[], keep = false, drawn = false): Promise<VShot[]> {
  // A drawn style: every scene is drawn (motion text and the logo card stay), so nothing clashes with the look.
  if (drawn) {
    return shots.map((s) => {
      if (s.src === "text" || s.src === "logo") return { ...s, file: null };
      if (keep && s.src === "art") return s;
      return { at: s.at, see: s.see, say: s.say, src: "art" as const, ...(s.who?.length ? { who: s.who } : {}) };
    });
  }
  const clips = broll.readyClips(orgId);
  const photos = kind === "story" || kind === "slideshow" ? await avatar.photos(orgId) : [];
  // Clips Elena named are kept for their own scenes; the rest of the library is matched by words.
  const named = new Set<number>(shots.filter((s) => s.src === "library" && s.clipId).map((s) => s.clipId!));
  const used = new Set<number>();
  const out: VShot[] = [];
  for (const s0 of shots) {
    const s: VShot = { ...s0 };
    if (keep && s.src && (s.file || s.src === "text" || s.src === "logo" || (s.src === "stock" && s.stock) || s.src === "ai")) {
      out.push(s);
      continue;
    }
    // An explainer is motion text (a library clip Elena named is fine, it's free).
    if (kind === "explainer" && s.src !== "logo" && s.src !== "library") s.src = "text";
    if (kind === "slideshow") s.src = "photo";
    if (s.src === "text" || s.src === "logo") {
      s.file = null;
      out.push(s);
      continue;
    }
    if (s.src === "photo" || (s.photo && photos.length)) {
      const t = (s.photo ?? "").trim().toLowerCase();
      const pick = (t ? photos.find((p) => p.title.toLowerCase() === t) ?? photos.find((p) => p.title.toLowerCase().includes(t) || t.includes(p.title.toLowerCase())) : null) ?? (kind === "slideshow" ? photos[out.length % Math.max(1, photos.length)] : null);
      if (pick) {
        out.push({ ...s, src: "photo", photo: pick.title, file: pick.url, clipId: null, stock: null });
        continue;
      }
    }
    // A library clip: the one Elena named, else the closest match.
    const mine = s.src === "library" && s.clipId ? clips.find((c) => c.id === s.clipId && !used.has(c.id)) : null;
    const lib = mine ?? (kind === "explainer" ? null : broll.bestClip(clips, `${s.see} ${s.query ?? ""}`, size, new Set([...Array.from(used), ...Array.from(named)])));
    if (lib) {
      used.add(lib.id);
      out.push({ ...s, src: "library", clipId: lib.id, file: lib.url, stock: null });
      continue;
    }
    if (kind === "explainer") {
      out.push({ ...s, src: "text", clipId: null, file: null, stock: null });
      continue;
    }
    if (s.src !== "ai") {
      const st = await broll.stockFor(s.query || s.see, size);
      if (st) {
        out.push({ ...s, src: "stock", clipId: null, file: null, stock: { url: st.url, page: st.page, thumb: st.thumb, credit: st.credit } });
        continue;
      }
    }
    out.push({ ...s, src: "ai", clipId: null, file: null, stock: null });
  }
  // The closing call to action is a logo card when nothing else was picked for it.
  return out;
}

type Written = { title: string; shots: VShot[]; caption: string; cast?: styles.CastMember[] };

async function writeIdea(orgId: number, input: { instructions: string; kind: Kind; seconds: number; size: Size; current?: Written; change?: string; drawn?: string | null }) {
  const emp = await elena(orgId);
  const words = Math.round(input.seconds * 2.4);
  const extra = await materials(orgId, input.kind);
  const { system } = await systemPromptFor(
    emp,
    `Write a ${input.seconds}-second ${SIZES[input.size].label} video: ${KIND_LABEL[input.kind]}.
${HOW[input.kind]}${input.drawn ? `\n${drawnHow(input.drawn)}` : ""}
- A storyboard: ${sceneCount(input.seconds)} scenes, each with when it starts (seconds), what we see, the voice-over words over it, and where the footage comes from.
${RULES}
- The voice-over is read aloud: about ${words} words in all, the way people talk, American English, no em dashes, no stage directions.
- A caption to post with it: one to three short lines.
- Never use a client's name or health information.${extra ? `\n${extra}` : ""}`
  );
  const prompt = input.current
    ? `The video so far:\nTitle: ${input.current.title}\n${input.current.shots.map((s) => `${fmtTime(s.at)} We see: ${s.see} | Said: ${s.say}`).join("\n")}\nCaption: ${input.current.caption}\n\nWhat they asked for at first: ${input.instructions}\nChange: ${input.change || "write it again"}\nRewrite it with that change and keep the rest.`
    : `What they asked for: ${input.instructions}`;
  const out = await generateJson<{ title: string; shots: VShot[]; caption: string; cast?: styles.CastMember[] }>({ system, prompt, schemaName: "video_script", schema: SCRIPT_SCHEMA, maxTokens: input.seconds > 90 ? 12000 : 3000 });
  const shots = cleanShots(out?.shots, input.seconds);
  if (!shots.length) throw new Error("I couldn't write the storyboard. Tell me a little more about the video.");
  return { title: String(out.title ?? "").trim().slice(0, 120) || "Video", shots, caption: String(out.caption ?? "").trim().slice(0, 600), cast: cleanCast(out?.cast) };
}

/** Their script, kept word for word: split into scenes of a sentence or two each. */
export function splitScript(text: string, seconds: number) {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const total = sentences.reduce((n, s) => n + s.split(" ").length, 0) || 1;
  const target = Math.max(8, Math.round(total / Math.min(maxScenes(seconds) / 2, Math.max(3, Math.round(seconds / 5)))));
  const scenes: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + " " + s).split(" ").length > target * 1.4) {
      scenes.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) scenes.push(cur);
  return scenes.slice(0, maxScenes(seconds));
}

const SCENES_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "scenes", "caption", "cast"],
  properties: {
    title: { type: "string" },
    scenes: { type: "array", items: { type: "object", additionalProperties: false, required: ["see", "photo", "src", "clip", "query", "who"], properties: SHOT_PROPS } },
    caption: { type: "string" },
    cast: CAST_SCHEMA,
  },
};

/** The pictures for lines that are already written (their script, or a recording): one scene per line. */
async function writeScenes(orgId: number, input: { lines: string[]; kind: Kind; size: Size; seconds: number; about: string; drawn?: string | null }) {
  const emp = await elena(orgId);
  const extra = await materials(orgId, input.kind);
  const { system } = await systemPromptFor(
    emp,
    `Plan the pictures for a ${input.seconds}-second ${SIZES[input.size].label} video: ${KIND_LABEL[input.kind]}. The words are already written and stay exactly as they are.
${HOW[input.kind]}${input.drawn ? `\n${drawnHow(input.drawn)}` : ""}
- One scene for each line, in order: what we see and where the footage comes from.
${RULES}
- A title, and a caption to post with it: one to three short lines, American English, no em dashes.
- Never use a client's name or health information.${extra ? `\n${extra}` : ""}`
  );
  const out = await generateJson<{ title: string; scenes: { see: string; photo: string; src: Src; clip: number; query: string; who?: string[] }[]; caption: string; cast?: styles.CastMember[] }>({
    system,
    prompt: `${input.about ? `About: ${input.about}\n` : ""}The lines:\n${input.lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`,
    schemaName: "video_scenes",
    schema: SCENES_SCHEMA,
    maxTokens: input.lines.length > 16 ? 12000 : 3000,
  });
  const scenes = Array.isArray(out?.scenes) ? out.scenes : [];
  const total = input.lines.reduce((n, l) => n + l.split(/\s+/).length, 0) || 1;
  let words = 0;
  const shots: VShot[] = input.lines.map((say, i) => {
    const s = scenes[i] ?? { see: say, photo: "", src: "stock" as Src, clip: 0, query: "", who: [] };
    const at = Math.round((words / total) * input.seconds);
    words += say.split(/\s+/).length;
    return cleanShots([{ at, see: s.see || say, say, photo: s.photo, src: s.src, clip: s.clip, query: s.query, who: s.who }], input.seconds)[0];
  });
  shots[0].at = 0;
  return { title: String(out?.title ?? "").trim().slice(0, 120) || "Video", shots, caption: String(out?.caption ?? "").trim().slice(0, 600), cast: cleanCast(out?.cast) };
}

/** The best stretch of a recording for a video this long: Elena picks where it starts and ends. */
async function pickSegment(orgId: number, words: Word[], seconds: number) {
  const sentences: { text: string; start: number; end: number; from: number; to: number }[] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    if (/[.!?]["')\]]*$/.test(w.text) || i === words.length - 1) {
      sentences.push({ text: cur.map((x) => x.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end, from: i - cur.length + 1, to: i });
      cur = [];
    }
  });
  if (!sentences.length) throw new Error("I couldn't hear any words in that recording.");
  const recordingEnd = words[words.length - 1].end;
  let first = 0;
  if (recordingEnd > seconds + 2 && sentences.length > 2) {
    const emp = await elena(orgId);
    const { system } = await systemPromptFor(emp, `Pick the best ${seconds} seconds of this recording for a short social video: a stretch that makes sense on its own and opens with a strong first line.`);
    const out = await generateJson<{ start: number }>({
      system,
      prompt: sentences.map((s, i) => `${i + 1}. [${fmtTime(s.start)}] ${s.text}`).join("\n"),
      schemaName: "audio_pick",
      schema: { type: "object", additionalProperties: false, required: ["start"], properties: { start: { type: "integer", description: "The number of the sentence the video starts on." } } },
      maxTokens: 200,
    });
    first = Math.max(0, Math.min(sentences.length - 1, Math.round(Number(out?.start) || 1) - 1));
  }
  const picked: typeof sentences = [];
  for (const s of sentences.slice(first)) {
    if (picked.length && s.end - sentences[first].start > seconds + 1.5) break;
    picked.push(s);
  }
  const from = Math.max(0, picked[0].start - 0.15);
  const to = Math.min(recordingEnd + 0.3, picked[picked.length - 1].end + 0.3);
  const kept = words.slice(picked[0].from, picked[picked.length - 1].to + 1).map((w) => ({ text: w.text, start: Math.max(0, w.start - from), end: Math.max(0, w.end - from) }));
  return { from, to, words: kept, lines: picked.map((s) => s.text) };
}

/** Words of a page someone linked: what the article says, for the video. */
async function linkText(url: string) {
  if (!/^https?:\/\/\S+$/i.test(url.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the full link, starting with https://." });
  const { readPage } = await import("./siteReader");
  const r = await readPage(url.trim()).catch(() => null);
  const text = [r?.page.title, r?.page.description, r?.page.text].filter(Boolean).join("\n").trim();
  if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "I couldn't read that page. Paste the words instead, or try another link." });
  return text.slice(0, 8000);
}

export type WriteInput = {
  instructions: string;
  kind?: Kind;
  size?: Size;
  sizes?: Size[];
  seconds?: number;
  source?: Source;
  sourceUrl?: string | null;
  voiceId?: string | null;
  look?: Partial<{ logo: Partial<Look["logo"]>; music: Partial<Look["music"]>; captions: Partial<Look["captions"]> }>;
  planId?: number | null;
  /** "real", "auto", a preset style key or "custom:<id>". */
  style?: string | null;
  motion?: "pictures" | "clips";
};

/** Auto: Elena picks the drawn style that fits the story. */
async function pickStyle(orgId: number, about: string) {
  const out = await generateJson<{ style: string }>({
    system: "You pick the visual style for a short story video for a small business. Pick the one that fits the subject and audience best.",
    prompt: `The video: ${about.slice(0, 1500)}\nStyles: ${styles.PRESET_KEYS.map((k) => `${k} (${styles.PRESETS[k].label})`).join(", ")}`,
    schemaName: "video_style",
    schema: { type: "object", additionalProperties: false, required: ["style"], properties: { style: { type: "string", enum: styles.PRESET_KEYS } } },
    maxTokens: 100,
  }).catch(() => null);
  return out?.style && styles.isPreset(out.style) ? out.style : "animation";
}

/** Elena writes the storyboard and saves it as a draft. Nothing is made yet. */
export async function writeVideo(orgId: number, input: WriteInput) {
  const emp = await elena(orgId);
  const kind = input.kind && KINDS.includes(input.kind) ? input.kind : "broll";
  const sizes = (input.sizes?.length ? input.sizes : [input.size ?? "vertical"]).filter((s): s is Size => s in SIZES);
  const size = sizes[0] ?? "vertical";
  const source: Source = kind === "audio" ? "audio" : input.source ?? "idea";
  let instructions = input.instructions.trim().slice(0, 6000);
  // Auto picks a drawn style for the story; a custom style must be this workspace's.
  let style = input.style && input.style !== "real" ? input.style : "real";
  if (style === "auto") style = await pickStyle(orgId, instructions || input.sourceUrl || "");
  if (style !== "real" && !styles.isPreset(style) && styles.resolve(orgId, style).key === "real") throw new TRPCError({ code: "BAD_REQUEST", message: "That style isn't in this workspace. Pick another." });
  const drawn = styles.isDrawn(style) ? styles.resolve(orgId, style) : null;
  // Over 90 seconds is drawn with moving pictures (or your recording over pictures).
  const seconds = Math.max(10, Math.min(drawn ? 600 : 120, Math.round(input.seconds || 30)));
  const motion = drawn && seconds <= 90 && input.motion === "clips" ? "clips" : "pictures";
  let words: Word[] | null = null;
  let segment: Script["segment"] = null;
  let s: Written;
  if (source === "audio") {
    if (!input.sourceUrl?.startsWith(`/files/org-${orgId}/`)) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload the recording first." });
    const { transcribeFile } = await import("../_core/transcribe");
    const t = await transcribeFile(fs.readFileSync(broll.localFile(input.sourceUrl)));
    if (!t.words.length) throw new TRPCError({ code: "BAD_REQUEST", message: "I couldn't hear any words in that recording." });
    const pick = await pickSegment(orgId, t.words, seconds);
    words = pick.words;
    segment = { from: pick.from, to: pick.to };
    instructions = instructions || pick.lines.join(" ").slice(0, 2000);
    s = await writeScenes(orgId, { lines: groupLines(pick.lines, seconds), kind, size, seconds: Math.round(pick.to - pick.from), about: input.instructions, drawn: drawn?.label });
  } else if (source === "script") {
    if (!instructions) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste your script." });
    s = await writeScenes(orgId, { lines: splitScript(instructions, seconds), kind, size, seconds, about: "", drawn: drawn?.label });
  } else {
    if (source === "link") {
      const page = await linkText(input.sourceUrl || instructions);
      instructions = `${instructions && instructions !== input.sourceUrl ? `${instructions}\n\n` : ""}Make it from this article (${input.sourceUrl || "link"}):\n${page}`;
    }
    if (!instructions) throw new TRPCError({ code: "BAD_REQUEST", message: "Tell me what the video is about." });
    s = await writeIdea(orgId, { instructions, kind, seconds, size, drawn: drawn?.label });
  }
  const shots = await assignSources(orgId, kind, size, s.shots, false, !!drawn);
  const voice = source === "audio" ? { id: null as string | null, name: "Your recording" } : await voiceFor(orgId, input.voiceId);
  const b = await brand(orgId);
  const look: Look = {
    captions: { ...DEFAULT_LOOK.captions, ...(input.look?.captions ?? {}) },
    logo: { ...DEFAULT_LOOK.logo, on: !!b.logo, ...(input.look?.logo ?? {}) },
    music: { ...DEFAULT_LOOK.music, ...(input.look?.music ?? {}) },
  };
  const row = db
    .getDb()
    .insert(videos)
    .values({
      organizationId: orgId,
      employeeId: emp.id,
      title: s.title,
      kind,
      size,
      sizes: JSON.stringify(sizes),
      seconds: segment ? Math.max(1, Math.round(segment.to - segment.from)) : seconds,
      source,
      sourceUrl: source === "link" ? input.sourceUrl || null : source === "audio" ? input.sourceUrl : null,
      instructions: instructions.slice(0, 2000),
      script: JSON.stringify({ shots, caption: s.caption, segment }),
      voiceId: voice.id,
      voiceName: voice.name,
      look: JSON.stringify(look),
      words: words ? JSON.stringify({ text: "", words }) : null,
      planId: input.planId ?? null,
      style,
      motion,
      cast: JSON.stringify(drawn ? s.cast ?? [] : []),
      drawing: drawn ? `0/${shots.filter((x) => x.src === "art").length}` : null,
    })
    .returning()
    .get();
  if (drawn) startDrawing(orgId, row.id);
  return row;
}

/** A recording's sentences grouped into scenes of about 4 to 7 seconds. */
function groupLines(lines: string[], seconds: number) {
  const per = Math.max(1, Math.round(lines.length / Math.min(maxScenes(seconds), Math.max(3, Math.round(seconds / 6)))));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per).join(" "));
  return out.slice(0, maxScenes(seconds));
}

/** "Change the script": Elena rewrites it with the change asked for. */
export async function rewriteVideo(orgId: number, id: number, change: string) {
  const v = must(orgId, id);
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes, then change the script." });
  if (v.source === "audio" || v.source === "script") throw new TRPCError({ code: "BAD_REQUEST", message: "The words are yours, so I keep them as they are. Change a line or a shot on the storyboard instead." });
  const drawn = styles.isDrawn(v.style) ? styles.resolve(orgId, v.style) : null;
  const s = await writeIdea(orgId, { instructions: v.instructions, kind: v.kind, seconds: v.seconds, size: v.size, current: { title: v.title, ...scriptOf(v) }, change, drawn: drawn?.label });
  const shots = await assignSources(orgId, v.kind, v.size, s.shots, false, !!drawn);
  const out = update(orgId, id, { title: s.title, script: JSON.stringify({ ...scriptOf(v), shots, caption: s.caption }), ...(drawn ? { cast: JSON.stringify(mergeCast(castOf(v), s.cast ?? [])) } : {}), status: "draft", error: null });
  return drawn ? startDrawing(orgId, id) ?? out : out;
}

/** Edit script on the Videos tab: the scenes and caption as typed. A scene whose words or picture changed is planned again. */
export async function saveScript(orgId: number, id: number, input: { title?: string; shots: VShot[]; caption?: string }) {
  const v = must(orgId, id);
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes, then change the script." });
  const shots = cleanShots(input.shots, v.seconds);
  if (!shots.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Keep at least one shot." });
  const old = scriptOf(v);
  const kept = shots.map((s, i) => {
    const o = old.shots[i];
    if (!o) return s;
    // Same picture: keep where it comes from and what was made for it.
    return o.see === s.see ? { ...o, at: s.at, say: s.say } : { ...s, src: o.src === "text" || o.src === "logo" ? o.src : undefined };
  });
  const planned = await assignSources(orgId, v.kind, v.size, kept, true, styles.isDrawn(v.style));
  const out = update(orgId, id, { title: input.title?.trim().slice(0, 120) || v.title, script: JSON.stringify({ ...old, shots: planned, caption: input.caption ?? old.caption }), status: v.status === "ready" ? "ready" : "draft", error: null });
  return styles.isDrawn(v.style) && v.status !== "ready" ? startDrawing(orgId, id) ?? out : out;
}

/** Rewrite line: one scene's words as typed. */
export function saveLine(orgId: number, id: number, n: number, say: string) {
  const v = must(orgId, id);
  notMaking(v);
  if (v.source === "audio") throw new TRPCError({ code: "BAD_REQUEST", message: "These are the words from your recording, so they stay as they are." });
  const s = scriptOf(v);
  if (!s.shots[n]) throw new TRPCError({ code: "NOT_FOUND", message: "That scene isn't in this video." });
  s.shots[n] = { ...s.shots[n], say: say.trim().slice(0, 400) };
  return update(orgId, id, { script: JSON.stringify(s), error: null });
}

/**
 * Change shot: what we see in one scene and where it comes from. The footage is made when
 * the video is made (or remade for this scene only, on a finished video).
 */
export async function changeShot(orgId: number, id: number, n: number, input: { src: Src; see?: string; clipId?: number | null }, opts: { draw?: boolean } = {}) {
  const v = must(orgId, id);
  notMaking(v);
  const s = scriptOf(v);
  const cur = s.shots[n];
  if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "That scene isn't in this video." });
  const see = (input.see ?? cur.see).trim().slice(0, 300) || cur.see;
  let next: VShot = { at: cur.at, say: cur.say, see, src: input.src, ...(cur.photo ? { photo: cur.photo } : {}) };
  if (input.src === "library") {
    const c = input.clipId ? broll.getClip(orgId, input.clipId) : null;
    if (!c || c.status !== "ready" || !c.url) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a clip from your b-roll library." });
    next = { ...next, clipId: c.id, file: c.url };
  } else if (input.src === "stock") {
    const st = await broll.stockFor(see, v.size);
    if (!st) throw new TRPCError({ code: "BAD_REQUEST", message: ENV.pexelsKey ? "I didn't find stock footage for that. Try other words, or pick a new AI clip." : "Stock footage isn't set up on the server yet. Pick your b-roll or a new AI clip." });
    next = { ...next, stock: { url: st.url, page: st.page, thumb: st.thumb, credit: st.credit } };
  } else if (input.src === "photo") {
    const [p] = await assignSources(orgId, "story", v.size, [{ ...next, src: "photo", photo: see }]);
    if (p.src !== "photo") throw new TRPCError({ code: "BAD_REQUEST", message: "I didn't find that photo in the Brain." });
    next = p;
  } else if (input.src === "art") {
    if (!styles.isDrawn(v.style)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a drawn style for this video first." });
    // Drawn again from the new words; the same people stay in it unless the words name others.
    const cast = castOf(v);
    const named = cast.filter((c) => see.toLowerCase().includes(c.name.toLowerCase().split(" ")[0])).map((c) => c.name);
    next = { ...next, who: named.length ? named : cur.who ?? [] };
  }
  s.shots[n] = next;
  const out = update(orgId, id, { script: JSON.stringify(s), error: null });
  // On the storyboard the new picture is drawn right away; a redo draws it while the video is made.
  return input.src === "art" && opts.draw !== false ? startDrawing(orgId, id) ?? out : out;
}

// ==========================================
// Drawn styles
// ==========================================

export const castOf = (v: Pick<Video, "cast">) => parse<styles.CastMember[]>(v.cast, []).filter((c) => c && c.name);
/** Rewrites keep the portraits already drawn for people who are still in the story. */
function mergeCast(old: styles.CastMember[], next: styles.CastMember[]) {
  return next.map((c) => {
    const o = old.find((x) => x.name.toLowerCase() === c.name.toLowerCase() && x.look === c.look);
    return o?.portrait ? { ...c, portrait: o.portrait } : c;
  });
}

const drawJobs = new Map<number, Promise<void>>();
/** The background job drawing a video's pictures, if one is running (tests wait on it). */
export const drawJobFor = (id: number) => drawJobs.get(id) ?? null;

/** The people in one scene, from the cast. */
const peopleIn = (cast: styles.CastMember[], shot: VShot) => cast.filter((c) => (shot.who ?? []).some((w) => w.toLowerCase() === c.name.toLowerCase()));

/** Draws what a drawn-style scene needs: the portraits of its people first (once), then the scene. Returns the picture. */
async function drawScene(v: Video, shot: VShot, n: number) {
  const style = styles.resolve(v.organizationId, v.style);
  const cast = castOf(v);
  const people = peopleIn(cast, shot);
  let changed = false;
  for (const c of people) {
    if (c.portrait) continue;
    c.portrait = await styles.draw(v.organizationId, { prompt: styles.portraitPrompt(style, c), ratio: "3:4", refs: style.refs, name: `cast-${v.id}` });
    changed = true;
  }
  if (changed) update(v.organizationId, v.id, { cast: JSON.stringify(cast) });
  const refs = [...people.map((c) => c.portrait!).filter(Boolean), ...style.refs].slice(0, 5);
  const still = await styles.draw(v.organizationId, { prompt: styles.scenePrompt(style, shot.see || shot.say, people), ratio: SIZES[v.size].ratio, refs, name: `scene-${v.id}-${n + 1}` });
  return { still, cast };
}

/**
 * Draws every scene picture a drawn-style video is missing, in the background, three at a time,
 * keeping each as it's done. The storyboard fills in as they come. Null when nothing needs drawing.
 */
export function startDrawing(orgId: number, id: number): Video | null {
  const v = get(orgId, id);
  if (!v || !styles.isDrawn(v.style)) return null;
  if (drawJobs.has(id)) return v;
  const todo = scriptOf(v).shots.map((s, i) => ({ s, i })).filter(({ s }) => s.src === "art" && !s.still);
  const total = scriptOf(v).shots.filter((s) => s.src === "art").length;
  if (!todo.length) return v.drawing ? update(orgId, id, { drawing: null }) : v;
  if (!ENV.falKey) return update(orgId, id, { drawing: null, error: "Drawing scenes isn't set up on the server yet. LeadDash support can turn it on." });
  let done = total - todo.length;
  const started = update(orgId, id, { drawing: `${done}/${total}`, error: null });
  const job = (async () => {
    try {
      // The first scene alone, so each person's portrait is drawn once before the rest use it.
      for (let k = 0; k < todo.length; k += k === 0 ? 1 : 3) {
        const batch = todo.slice(k, k === 0 ? 1 : k + 3);
        const results = await Promise.all(batch.map(async ({ s, i }) => ({ i, see: s.see, ...(await drawScene(get(orgId, id)!, s, i)) })));
        const fresh = get(orgId, id);
        if (!fresh) return;
        const script = scriptOf(fresh);
        for (const r of results) {
          // Kept only if the scene wasn't changed again while it was being drawn.
          if (script.shots[r.i]?.see === r.see && script.shots[r.i].src === "art") script.shots[r.i] = { ...script.shots[r.i], still: r.still, file: null };
        }
        done += results.length;
        update(orgId, id, { script: JSON.stringify(script), drawing: `${Math.min(done, total)}/${total}` });
      }
      update(orgId, id, { drawing: null });
      // Anything changed while drawing is drawn next.
      const after = get(orgId, id);
      if (after && scriptOf(after).shots.some((s) => s.src === "art" && !s.still)) queueMicrotask(() => startDrawing(orgId, id));
    } catch (err) {
      update(orgId, id, { drawing: null, error: `Some scenes weren't drawn: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)} Press Change shot on one to try again.` });
    } finally {
      drawJobs.delete(id);
    }
  })();
  drawJobs.set(id, job);
  return started;
}

/** Change style: every drawn scene (and the cast) is drawn again in the new look; Real footage goes back to footage. */
export async function changeStyle(orgId: number, id: number, style: string, motion?: "pictures" | "clips") {
  const v = must(orgId, id);
  notMaking(v);
  if (drawJobs.has(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the scene pictures are drawn." });
  let next = style === "auto" ? await pickStyle(orgId, `${v.title}. ${v.instructions}`) : style;
  if (next !== "real" && styles.resolve(orgId, next).key === "real") throw new TRPCError({ code: "BAD_REQUEST", message: "That style isn't in this workspace. Pick another." });
  if (next === "real" && v.seconds > 120) throw new TRPCError({ code: "BAD_REQUEST", message: "Real footage goes up to 2 minutes. Pick a drawn style for a video this long." });
  const drawn = styles.isDrawn(next);
  const sc = scriptOf(v);
  const cleared = sc.shots.map((s) => ({ ...s, still: null, file: s.src === "text" || s.src === "logo" ? null : s.src === "art" ? null : s.file, ...(s.src === "art" && !drawn ? { src: undefined } : {}) }));
  const shots = await assignSources(orgId, v.kind, v.size, cleared, !drawn, drawn);
  // The people are drawn again in the new look.
  const cast = castOf(v).map((c) => ({ name: c.name, look: c.look }));
  const nextMotion = !drawn ? "pictures" : motion === "clips" && v.seconds <= 90 ? "clips" : motion === "pictures" ? "pictures" : v.motion;
  update(orgId, id, { style: next, motion: nextMotion, cast: JSON.stringify(drawn ? cast : []), script: JSON.stringify({ ...sc, shots }), status: v.status === "ready" ? "ready" : "draft", error: null });
  return drawn ? startDrawing(orgId, id)! : must(orgId, id);
}

/** Change look: one person is drawn again, and every scene they're in with them. */
export function changeLook(orgId: number, id: number, index: number, look?: string) {
  const v = must(orgId, id);
  notMaking(v);
  if (drawJobs.has(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the scene pictures are drawn." });
  const cast = castOf(v);
  const c = cast[index];
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That person isn't in this video." });
  cast[index] = { name: c.name, look: (look ?? c.look).trim().slice(0, 300) || c.look, portrait: null };
  const sc = scriptOf(v);
  sc.shots = sc.shots.map((s) => ((s.who ?? []).some((w) => w.toLowerCase() === c.name.toLowerCase()) ? { ...s, still: null, file: null } : s));
  update(orgId, id, { cast: JSON.stringify(cast), script: JSON.stringify(sc), error: null });
  return startDrawing(orgId, id)!;
}

/** New hook: Elena writes a different first scene and keeps the rest. */
export async function newHook(orgId: number, id: number) {
  const v = must(orgId, id);
  notMaking(v);
  if (v.source === "audio") throw new TRPCError({ code: "BAD_REQUEST", message: "The hook is the first line of your recording." });
  const s = scriptOf(v);
  const [hook] = await hooks(orgId, v, 1);
  s.shots[0] = { ...s.shots[0], say: v.source === "script" ? s.shots[0].say : hook.say, see: hook.see, query: hook.query, src: undefined, file: null, clipId: null, stock: null };
  s.shots = await assignSources(orgId, v.kind, v.size, s.shots, true, styles.isDrawn(v.style));
  const out = update(orgId, id, { script: JSON.stringify(s), error: null });
  return styles.isDrawn(v.style) ? startDrawing(orgId, id) ?? out : out;
}

async function hooks(orgId: number, v: Video, count: number) {
  const emp = await elena(orgId);
  const s = scriptOf(v);
  const { system } = await systemPromptFor(emp, `Write ${count} different hooks for this video: the first scene, what's said in the first two seconds and what we see. Each one a different angle (a question, a bold claim, a surprising number, the result). The rest of the video stays the same. American English, no em dashes, never a client's name or health information.`);
  const out = await generateJson<{ hooks: { say: string; see: string; query: string }[] }>({
    system,
    prompt: `The video, "${v.title}":\n${s.shots.map((x, i) => `${i === 0 ? "Hook" : `Scene ${i + 1}`}: We see: ${x.see} | Said: ${x.say}`).join("\n")}`,
    schemaName: "video_hooks",
    schema: { type: "object", additionalProperties: false, required: ["hooks"], properties: { hooks: { type: "array", items: { type: "object", additionalProperties: false, required: ["say", "see", "query"], properties: { say: { type: "string" }, see: { type: "string" }, query: { type: "string" } } } } } },
    maxTokens: 1200,
  });
  const list = (out?.hooks ?? []).filter((h) => h?.say?.trim()).slice(0, count);
  if (!list.length) throw new Error("I couldn't write a new hook. Try again.");
  return list.map((h) => ({ say: h.say.trim().slice(0, 400), see: h.see.trim().slice(0, 300) || s.shots[0].see, query: (h.query ?? "").trim().slice(0, 100) }));
}

/** Make 3 ad versions: the same video with three different hooks, as drafts to make and test. */
export async function adVersions(orgId: number, id: number) {
  const v = must(orgId, id);
  if (v.source === "audio") throw new TRPCError({ code: "BAD_REQUEST", message: "Versions need new first lines, and these words are from your recording." });
  const list = await hooks(orgId, v, 3);
  const s = scriptOf(v);
  const made: Video[] = [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    const shots = await assignSources(orgId, v.kind, v.size, [{ ...s.shots[0], say: h.say, see: h.see, query: h.query, src: undefined, file: null, clipId: null, stock: null, still: null }, ...s.shots.slice(1)], true, styles.isDrawn(v.style));
    made.push(
      db
        .getDb()
        .insert(videos)
        .values({ organizationId: orgId, employeeId: v.employeeId, title: `${v.title} (version ${String.fromCharCode(65 + i)})`.slice(0, 120), kind: v.kind, size: v.size, sizes: v.sizes, seconds: v.seconds, source: v.source, instructions: v.instructions, script: JSON.stringify({ ...s, shots }), voiceId: v.voiceId, voiceName: v.voiceName, look: v.look, style: v.style, motion: v.motion, cast: v.cast, drawing: styles.isDrawn(v.style) ? "0/1" : null })
        .returning()
        .get()
    );
  }
  // Each version's new hook is drawn in the same style, with the same people.
  for (const m of made) if (styles.isDrawn(m.style)) startDrawing(orgId, m.id);
  return made;
}

/** A talking-to-camera video: Elena writes the words, then it's the avatar path from here. */
export async function writeTalking(orgId: number, input: { instructions: string; seconds?: number; who?: string | null; script?: boolean }) {
  const emp = await elena(orgId);
  const seconds = Math.max(10, Math.min(120, Math.round(input.seconds || 30)));
  if (input.script) return avatar.draft(orgId, { title: input.instructions.split(/[.!?\n]/)[0].slice(0, 60) || "Video", script: input.instructions.trim().slice(0, 4000), who: input.who || null });
  const { system } = await systemPromptFor(emp, `Write the words for a ${seconds}-second talking-to-camera video, about ${Math.round(seconds * 2.5)} words, the way people talk out loud. No stage directions or labels, only the words. American English, no em dashes. Never use a client's name or health information.`);
  const out = await generateJson<{ title: string; words: string }>({
    system,
    prompt: `What they asked for: ${input.instructions}`,
    schemaName: "talking_script",
    schema: { type: "object", additionalProperties: false, required: ["title", "words"], properties: { title: { type: "string" }, words: { type: "string" } } },
    maxTokens: 1200,
  });
  if (!out?.words?.trim()) throw new Error("I couldn't write it. Tell me a little more about what to say.");
  return avatar.draft(orgId, { title: out.title || "Video", script: out.words, who: input.who || null });
}

type PlanData = { trend?: { name?: string; whyItWorks?: string; sourceUrl?: string }; plan?: { title?: string; platform?: string; lengthSeconds?: number; hook?: string; shots?: { time?: string; shot?: string; say?: string }[]; caption?: string } };

/** Video plans from trends: their shot list becomes a b-roll video. */
export async function fromPlan(orgId: number, planId: number) {
  const item = await db.getWorkItemForOrg(planId, orgId);
  if (!item || item.kind !== "video_plan") throw new TRPCError({ code: "NOT_FOUND", message: "That video plan is not in this workspace." });
  const existing = db.getDb().select().from(videos).where(and(eq(videos.organizationId, orgId), eq(videos.planId, planId))).orderBy(desc(videos.id)).get();
  if (existing) return existing;
  const data = parse<PlanData>(item.data, {});
  const p = data.plan ?? {};
  const seconds = Math.max(10, Math.min(120, Math.round(p.lengthSeconds || 30)));
  const raw = cleanShots((p.shots ?? []).map((s) => ({ at: secondsOf(s.time ?? ""), see: s.shot ?? "", say: s.say ?? "" })), seconds);
  if (!raw.length) throw new TRPCError({ code: "BAD_REQUEST", message: "That plan has no shots to make." });
  const shots = await assignSources(orgId, "broll", "vertical", raw);
  const emp = await elena(orgId);
  const voice = await voiceFor(orgId);
  const b = await brand(orgId);
  return db
    .getDb()
    .insert(videos)
    .values({ organizationId: orgId, employeeId: emp.id, title: (p.title || item.title).slice(0, 120), kind: "broll", size: "vertical", sizes: JSON.stringify(["vertical"]), seconds, instructions: [p.title, p.hook].filter(Boolean).join(". ").slice(0, 2000) || item.title, script: JSON.stringify({ shots, caption: p.caption ?? "" }), voiceId: voice.id, voiceName: voice.name, look: JSON.stringify({ ...DEFAULT_LOOK, logo: { ...DEFAULT_LOOK.logo, on: !!b.logo } }), planId })
    .returning()
    .get();
}

/** "Formats that work now": the trends Elena found, each one a structure to recreate with their business. */
export async function formats(orgId: number) {
  const items = (await db.listWorkItems(orgId, "video_plan")).filter((p) => p.status !== "dismissed");
  return items.map((item) => {
    const d = parse<PlanData>(item.data, {});
    const shots = d.plan?.shots ?? [];
    return {
      id: item.id,
      name: d.trend?.name || d.plan?.title || item.title,
      title: d.plan?.title || item.title,
      why: d.trend?.whyItWorks ?? "",
      structure: [d.plan?.hook ? "Hook" : "", shots.length ? `${shots.length} ${shots.length === 1 ? "beat" : "beats"}` : "", d.plan?.lengthSeconds ? `${d.plan.lengthSeconds} seconds` : ""].filter(Boolean).join(", "),
      platform: d.plan?.platform ?? "",
      sourceUrl: d.trend?.sourceUrl || item.sourceUrl || null,
    };
  });
}

/** Recreate: the format's structure and pacing, filled with their business. */
export async function recreate(orgId: number, planId: number, size: Size = "vertical") {
  const item = await db.getWorkItemForOrg(planId, orgId);
  if (!item || item.kind !== "video_plan") throw new TRPCError({ code: "NOT_FOUND", message: "That format is not in this workspace." });
  const d = parse<PlanData>(item.data, {});
  const p = d.plan ?? {};
  const beats = (p.shots ?? []).map((s, i) => `${i + 1}. ${s.time ?? ""} ${s.shot ?? ""}${s.say ? ` (said: ${s.say})` : ""}`).join("\n");
  const instructions = `Recreate this format with our business. Keep its structure and pacing, and fill it with what we do.
Format: ${d.trend?.name || item.title}${d.trend?.whyItWorks ? `\nWhy it works: ${d.trend.whyItWorks}` : ""}${p.hook ? `\nIts hook: ${p.hook}` : ""}${beats ? `\nIts beats:\n${beats}` : ""}`;
  return writeVideo(orgId, { instructions, kind: "broll", sizes: [size], seconds: p.lengthSeconds || 30, source: "idea" });
}

/** "0:03", "0:03-0:06", "3s" or "3-6s": where a plan's shot starts, in seconds. */
export function secondsOf(time: string) {
  const mm = time.match(/(\d+):(\d{1,2})/);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
  const s = time.match(/(\d+(?:\.\d+)?)/);
  return s ? Math.round(Number(s[1])) : 0;
}

/** Send to Sienna: the finished video as a Reel draft on her calendar, with the caption, waiting for approval. */
export async function toSienna(orgId: number, id: number, by: string) {
  const v = must(orgId, id);
  const urls = urlsOf(v);
  const url = urls.vertical ?? urls.square ?? urls.wide ?? v.videoUrl;
  if (v.status !== "ready" || !url) throw new TRPCError({ code: "BAD_REQUEST", message: "Make the video first." });
  const sienna = await db.getEmployeeByKind(orgId, "social");
  if (!sienna || sienna.status === "paused") throw new TRPCError({ code: "BAD_REQUEST", message: "Sienna isn't on your team. Bring her on from the bench to post videos." });
  const size = urls.vertical ? "vertical" : urls.square ? "square" : "wide";
  const channels = size === "vertical" ? ["instagram", "tiktok", "facebook"] : ["instagram", "facebook", "linkedin"];
  const caption = scriptOf(v).caption || v.title;
  const post = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: sienna.id,
    kind: "social_post",
    status: "pending_approval",
    title: v.title,
    body: caption,
    targetChannels: JSON.stringify(channels),
    metadata: JSON.stringify({ platforms: channels, topic: v.title, headline: v.title, rule: "posts", fromVideo: v.id, post: { type: "reel", mode: "same", variants: {}, videoUrl: url, videoMeta: { w: SIZES[size].w, h: SIZES[size].h, seconds: Math.round((v.tenths ?? v.seconds * 10) / 10) }, coverUrl: null, coverMs: 1000 } }),
  });
  const names: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", linkedin: "LinkedIn" };
  await db.createChatMessage({ organizationId: orgId, employeeId: sienna.id, role: "employee", authorName: sienna.name, content: `${by} sent me Elena's video "${v.title}". It's in my drafts as a Reel for ${channels.map((c) => names[c]).join(", ")}, with the caption. Pick a time and approve it, and I'll post it.` });
  return post;
}

// ==========================================
// Making
// ==========================================

export type Motion = "push" | "pull" | "right" | "left";
export type Clip = { file: string; seconds: number; fit: "cover" | "contain"; pad: string; motion: Motion; video?: boolean };
export type Caption = { from: number; to: number; text: string };
export type RenderInput = {
  w: number;
  h: number;
  clips: Clip[];
  audio: string;
  delay: number;
  total: number;
  captions: Caption[];
  /** Word-by-word captions in the video's caption style (instead of `captions`). */
  words?: Word[] | null;
  caps?: (Look["captions"] & { color: string }) | null;
  logo?: { file: string; corner: Corner; size: LogoSize } | null;
  music?: { file: string; volume: number } | null;
};

const MOTIONS: Motion[] = ["push", "right", "pull", "left"];
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * How the cut is laid out once the voice-over's length is known: each shot gets time in
 * proportion to the words said over it (so the pictures change with the voice), and the
 * spoken words become captions of a few words at a time.
 */
export function planCut(shots: Pick<VShot, "say">[], audioSeconds: number, delay = 0.3, tail = 0.7) {
  const total = Math.round((audioSeconds + delay + tail) * 30) / 30;
  const weights = shots.map((s) => Math.max(2, wordCount(s.say)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const frames = weights.map((w) => Math.max(15, Math.round((w / sum) * total * 30)));
  frames[frames.length - 1] += Math.round(total * 30) - frames.reduce((a, b) => a + b, 0);
  if (frames[frames.length - 1] < 15) frames[frames.length - 1] = 15;
  const durations = frames.map((f) => f / 30);
  const starts = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));
  // Captions follow the voice: the words are spread over the voice-over's own length.
  const allWords = shots.reduce((n, s) => n + wordCount(s.say), 0) || 1;
  const perWord = audioSeconds / allWords;
  const captions: Caption[] = [];
  let t = delay;
  for (const s of shots) {
    const w = s.say.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < w.length; i += 6) {
      const chunk = w.slice(i, i + 6);
      captions.push({ from: t, to: t + chunk.length * perWord, text: chunk.join(" ") });
      t += chunk.length * perWord;
    }
  }
  return { total: durations.reduce((a, b) => a + b, 0), durations, starts, captions, motions: shots.map((_, i) => MOTIONS[i % MOTIONS.length]) };
}

/** Word times when the voice-over couldn't be listened to: spread by each word's length over the audio. */
export function estimateWords(text: string, seconds: number): Word[] {
  const list = text.trim().split(/\s+/).filter(Boolean);
  const weight = list.map((w) => w.replace(/[^a-z0-9]/gi, "").length + 2 + (/[.!?,;:]$/.test(w) ? 3 : 0));
  const sum = weight.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return list.map((w, i) => {
    const d = (weight[i] / sum) * seconds;
    const out = { text: w, start: t, end: t + d * 0.9 };
    t += d;
    return out;
  });
}

/**
 * The scene lengths from the words: each scene starts when its first word is said (the
 * first at 0) and the last runs to the end. Scene words are matched to the heard words by count.
 */
export function sceneTimes(shots: Pick<VShot, "say">[], words: Word[], total: number, delay: number) {
  const counts = shots.map((s) => wordCount(s.say));
  const all = counts.reduce((a, b) => a + b, 0) || 1;
  const starts: number[] = [];
  let cum = 0;
  counts.forEach((c, i) => {
    const idx = Math.min(words.length - 1, Math.round((cum / all) * words.length));
    starts.push(i === 0 || !words.length ? (i === 0 ? 0 : (cum / all) * total) : words[idx].start + delay - 0.1);
    cum += c;
  });
  // Every scene gets at least half a second, in order.
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 0.5);
  const frames = starts.map((s, i) => Math.round(((i + 1 < starts.length ? starts[i + 1] : total) - s) * 30));
  frames[frames.length - 1] = Math.max(15, Math.round(total * 30) - frames.slice(0, -1).reduce((a, b) => a + b, 0));
  return frames.map((f) => Math.max(1, f) / 30);
}

const assTime = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (Math.max(0, t) % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};
/** #RRGGBB as an ASS color (&HBBGGRR). */
const assColor = (hex: string, alpha = "00") => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
const assText = (t: string) => t.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ");

function assHeader(w: number, h: number, style: string) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

function captionsFile(dir: string, w: number, h: number, caps: Caption[]) {
  if (!caps.length) return null;
  const size = Math.round(Math.min(w, h) * (h > w ? 0.058 : 0.05));
  const margin = Math.round(h * (h > w ? 0.17 : 0.09));
  const file = path.join(dir, "captions.ass");
  fs.writeFileSync(
    file,
    assHeader(w, h, `Style: Cap,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,1,0,0,0,100,100,0,0,1,${Math.round(size / 18)},1,2,${Math.round(w * 0.08)},${Math.round(w * 0.08)},${margin},1`) +
      caps.map((c) => `Dialogue: 0,${assTime(c.from)},${assTime(c.to)},Cap,,0,0,0,,${assText(c.text)}`).join("\n") +
      "\n"
  );
  return file;
}

/** Word-by-word captions: a few words at a time, the word being said in the highlight color. */
export function wordCaptions(w: number, h: number, words: Word[], caps: NonNullable<RenderInput["caps"]>, delay: number) {
  const tall = h > w;
  const style = caps.style;
  const size = Math.round(Math.min(w, h) * (style === "pop" ? (tall ? 0.078 : 0.07) : tall ? 0.056 : 0.05));
  const align = caps.position === "top" ? 8 : caps.position === "middle" ? 5 : 2;
  const marginV = caps.position === "middle" ? 0 : Math.round(h * (caps.position === "top" ? 0.11 : tall ? 0.17 : 0.09));
  const outline = style === "boxed" ? Math.round(size / 4) : style === "pop" ? Math.max(3, Math.round(size / 11)) : 2;
  const line = `Style: Cap,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,${style === "boxed" ? "&H40000000" : "&H00000000"},&H80000000,${style === "clean" ? 0 : 1},0,0,0,100,100,0,0,${style === "boxed" ? 3 : 1},${outline},${style === "clean" ? 2 : 1},${align},${Math.round(w * 0.08)},${Math.round(w * 0.08)},${marginV},1`;
  const per = style === "pop" ? (tall ? 3 : 4) : 5;
  const chunks: Word[][] = [];
  let cur: Word[] = [];
  for (const wd of words) {
    cur.push(wd);
    if (cur.length >= per || /[.!?,;:]["')\]]*$/.test(wd.text)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  const hi = caps.highlight === "none" ? null : assColor(caps.color);
  const events: string[] = [];
  chunks.forEach((c, ci) => {
    const nextStart = chunks[ci + 1]?.[0]?.start ?? c[c.length - 1].end + 0.6;
    const chunkEnd = Math.min(nextStart, c[c.length - 1].end + 0.6);
    const shown = (txt: string) => (style === "pop" ? txt.toUpperCase() : txt);
    if (!hi) {
      events.push(`Dialogue: 0,${assTime(c[0].start + delay)},${assTime(chunkEnd + delay)},Cap,,0,0,0,,${assText(shown(c.map((x) => x.text).join(" ")))}`);
      return;
    }
    c.forEach((wd, k) => {
      const from = k === 0 ? c[0].start : wd.start;
      const to = k + 1 < c.length ? c[k + 1].start : chunkEnd;
      const text = c.map((x, j) => (j === k ? `{\\c${hi}&${style === "pop" ? "\\fscx110\\fscy110" : ""}}${assText(shown(x.text))}{\\r}` : assText(shown(x.text)))).join(" ");
      events.push(`Dialogue: 0,${assTime(from + delay)},${assTime(Math.max(from + 0.05, to) + delay)},Cap,,0,0,0,,${text}`);
    });
  });
  return assHeader(w, h, line) + events.join("\n") + "\n";
}

/** The zoompan move for one still: a slow push in, pull out, or pan. */
function moveFilter(m: Motion, frames: number) {
  const mid = "y='ih/2-(ih/zoom/2)'";
  if (m === "push") return `z='1+0.1*on/${frames}':x='iw/2-(iw/zoom/2)':${mid}`;
  if (m === "pull") return `z='1.1-0.1*on/${frames}':x='iw/2-(iw/zoom/2)':${mid}`;
  if (m === "right") return `z='1.1':x='(iw-iw/zoom)*on/${frames}':${mid}`;
  return `z='1.1':x='(iw-iw/zoom)*(1-on/${frames})':${mid}`;
}

const LOGO_W: Record<LogoSize, number> = { s: 0.14, m: 0.2, l: 0.28 };

/**
 * The ffmpeg cut for one size: every scene sized to the format (clips that move are looped if short,
 * stills moved with a slow push or pan), joined, captions burned in, the logo on top, the voice-over
 * with music low under it.
 */
export async function render(input: RenderInput): Promise<Buffer> {
  const drama = await import("./drama");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-video-"));
  try {
    const { w, h } = input;
    // Stills are moved at twice the size for smooth motion; long videos use less so the cut stays quick.
    const k = input.clips.length > 20 ? 1.25 : 2;
    const W2 = Math.round((w * k) / 2) * 2;
    const H2 = Math.round((h * k) / 2) * 2;
    const args = ["-y"];
    input.clips.forEach((c) => (c.video ? args.push("-stream_loop", "-1", "-i", c.file) : args.push("-i", c.file)));
    let next = input.clips.length;
    const voIn = next++;
    args.push("-i", input.audio);
    let musicIn = -1;
    if (input.music) {
      musicIn = next++;
      args.push("-stream_loop", "-1", "-i", input.music.file);
    }
    let logoIn = -1;
    if (input.logo) {
      logoIn = next++;
      args.push("-i", input.logo.file);
    }
    const parts: string[] = [];
    input.clips.forEach((c, i) => {
      const frames = Math.max(1, Math.round(c.seconds * 30));
      if (c.video) {
        const fit = c.fit === "cover" ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${c.pad.replace("#", "0x")}`;
        parts.push(`[${i}:v]fps=30,${fit},setsar=1,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
        return;
      }
      const fit = c.fit === "cover" ? `scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2}` : `scale=${W2}:${H2}:force_original_aspect_ratio=decrease,pad=${W2}:${H2}:(ow-iw)/2:(oh-ih)/2:color=${c.pad.replace("#", "0x")}`;
      parts.push(`[${i}:v]${fit},setsar=1,zoompan=${moveFilter(c.motion, frames)}:d=${frames}:s=${w}x${h}:fps=30,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${i}]`);
    });
    parts.push(`${input.clips.map((_, i) => `[v${i}]`).join("")}concat=n=${input.clips.length}:v=1:a=0[vc]`);
    let caps: string | null = null;
    if (input.words && input.caps) {
      if (input.caps.on && input.words.length) {
        caps = path.join(dir, "captions.ass");
        fs.writeFileSync(caps, wordCaptions(w, h, input.words, input.caps, input.delay));
      }
    } else caps = captionsFile(dir, w, h, input.captions);
    const fd = drama.fontsDir();
    const vOut = input.logo ? "vt" : "v";
    parts.push(caps ? `[vc]ass=${caps.replace(/:/g, "\\:")}${fd ? `:fontsdir=${fd.replace(/:/g, "\\:")}` : ""}[${vOut}]` : `[vc]null[${vOut}]`);
    if (input.logo) {
      const lw = Math.round(Math.min(w, h) * LOGO_W[input.logo.size] * (w > h ? 1.1 : 1));
      const m = Math.round(Math.min(w, h) * 0.045);
      const x = input.logo.corner.endsWith("l") ? `${m}` : `W-w-${m}`;
      const y = input.logo.corner.startsWith("t") ? `${Math.round(m * (h > w ? 1.6 : 1))}` : `H-h-${Math.round(m * (h > w ? 1.6 : 1))}`;
      parts.push(`[${logoIn}:v]scale=${lw}:-1,format=rgba[lg]`);
      parts.push(`[vt][lg]overlay=${x}:${y}:format=auto,format=yuv420p[v]`);
    }
    const ms = Math.round(input.delay * 1000);
    const vo = `[${voIn}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms},apad,atrim=0:${input.total.toFixed(3)},afade=t=out:st=${Math.max(0, input.total - 0.4).toFixed(3)}:d=0.4`;
    if (input.music) {
      parts.push(`${vo}[vo]`);
      const gain = Math.max(0, Math.min(1, input.music.volume / 100));
      parts.push(`[${musicIn}:a]aresample=44100,aformat=channel_layouts=stereo,volume=${gain.toFixed(2)},atrim=0:${input.total.toFixed(3)},asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, input.total - 1.5).toFixed(3)}:d=1.5[mus]`);
      parts.push(`[vo][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`);
    } else parts.push(`${vo}[a]`);
    const out = path.join(dir, "out.mp4");
    args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]", "-t", input.total.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out);
    await run(drama.ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024, timeout: Math.max(15, Math.ceil(input.total / 60) * 6) * 60_000 }).catch((e) => {
      throw new Error(`The cut didn't finish: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let renderer: (input: RenderInput) => Promise<Buffer> = render;
/** Tests swap in their own cut so they can check the plan without running ffmpeg. */
export function setRenderer(fn: ((input: RenderInput) => Promise<Buffer>) | null) {
  renderer = fn ?? render;
}

const jobs = new Map<number, Promise<void>>();
/** The background job for a video, if one is running (tests wait on it). */
export const jobFor = (id: number) => jobs.get(id) ?? null;

/** New AI clips this video still needs, and their work hours. */
/** Scenes that still need a new moving clip: AI footage, or a drawn scene when the video uses Animated clips. */
function pendingShots(v: Video) {
  const shots = scriptOf(v).shots;
  return shots
    .map((s, i) => ({ s, len: (shots[i + 1]?.at ?? v.seconds) - s.at }))
    .filter(({ s }) => (s.src === "ai" && !s.file) || (s.src === "art" && v.motion === "clips" && !(s.file && /\.mp4$/i.test(s.file))));
}
export const pendingClips = (v: Video) => pendingShots(v).length;
/** Work hours to make it now: its length (once per video) and each new clip (2 for each 5 seconds). Drawn pictures that pan or zoom use none. */
export function minutesToMake(v: Video) {
  const base = v.paidAt ? 0 : workMinutes(v.tenths && v.status === "ready" ? v.tenths : v.seconds * 10);
  return base + pendingShots(v).reduce((n, x) => n + broll.clipUnits(x.len) * hours.JOBS.clip.minutes, 0);
}

async function chargeNow(orgId: number, emp: { id: number; kind: AIEmployee["kind"] }, job: hours.JobKey, count: number, label: string) {
  if (count <= 0) return;
  await withUsage({ orgId, employeeId: emp.id, kind: emp.kind }, async () => {
    const minutes = await hours.charge(orgId, emp.id, job, count, label);
    if (minutes > 0) await db.recordEmployeeTask(emp.id, orgId, minutes);
  });
}

/**
 * Starts making a video (or making it again after a change). It runs in the background;
 * Elena posts it in her chat when it's done. `restyle` re-renders with no new footage.
 */
export async function makeVideo(orgId: number, id: number, opts: { restyle?: boolean } = {}): Promise<Video> {
  const v = must(orgId, id);
  if (v.status === "making") return v;
  if (v.drawing || drawJobs.has(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the scene pictures are drawn, then make the video." });
  const shots = scriptOf(v).shots;
  if (!shots.length) throw new TRPCError({ code: "BAD_REQUEST", message: "This video has no shots yet." });
  const voiceId = v.source === "audio" ? null : v.voiceId || DEFAULT_VOICE.id;
  // Older drafts were written before scenes had sources: they're planned now.
  if (shots.some((s) => !s.src)) {
    const planned = await assignSources(orgId, v.kind, v.size, shots, true, styles.isDrawn(v.style));
    Object.assign(v, update(orgId, id, { script: JSON.stringify({ ...scriptOf(v), shots: planned }) }));
  }
  if (!opts.restyle && pendingClips(v) && !ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making AI clips isn't set up on the server yet. LeadDash support can turn it on." });
  if (voiceId && avatar.isStandard(voiceId) && !ENV.openAiKey && !v.voUrl) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Voices aren't set up on the server yet. LeadDash support can turn them on." });
  if (scriptOf(v).shots.some((s) => s.src === "photo" && !s.file)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add your photos to the Brain first (or attach them in Elena's chat), then press Make it." });
  // Out of work hours means it doesn't start (an Edit re-render uses none, so it always can).
  if (!opts.restyle && minutesToMake(v) > 0) await hours.gate(orgId);
  const emp = await elena(orgId);
  const started = update(orgId, id, { status: "making", error: null, voiceId, voiceName: v.voiceName || (voiceId ? DEFAULT_VOICE.name : "Your recording") });
  const job = (async () => {
    try {
      const r = await cut(started, emp, !!opts.restyle);
      let done = update(orgId, id, { status: "ready", videoUrl: r.urls[sizesOf(started)[0]] ?? Object.values(r.urls)[0], videoUrls: JSON.stringify(r.urls), tenths: r.tenths, error: null });
      if (!done.paidAt) {
        await chargeNow(orgId, emp, "video", workMinutes(r.tenths) / hours.JOBS.video.minutes, done.title);
        done = update(orgId, id, { paidAt: new Date() });
      }
      await finish(done, null, opts.restyle ? "edit" : "made");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      await finish(update(orgId, id, { status: "failed", error: msg }), msg, opts.restyle ? "edit" : "made");
    } finally {
      jobs.delete(id);
    }
  })();
  jobs.set(id, job);
  return started;
}

/** The voice-over file and its words: kept from last time when the words didn't change. */
async function voiceOver(v: Video, dir: string) {
  const file = path.join(dir, "vo.mp3");
  const s = scriptOf(v);
  const ff = (await import("./drama")).ffmpegPath();
  if (v.source === "audio") {
    if (!v.sourceUrl) throw new Error("The recording is missing. Upload it again.");
    const seg = s.segment ?? { from: 0, to: v.seconds };
    await run(ff, ["-y", "-loglevel", "error", "-ss", seg.from.toFixed(3), "-to", seg.to.toFixed(3), "-i", broll.localFile(v.sourceUrl), "-vn", "-c:a", "libmp3lame", "-b:a", "160k", file], { timeout: 5 * 60_000 });
    const words = parse<{ words?: Word[] }>(v.words, {}).words ?? [];
    return { file, seconds: seg.to - seg.from, words, url: v.sourceUrl, changed: false };
  }
  const text = voiceOverOf(v) || v.title;
  const kept = parse<{ text?: string; words?: Word[]; tenths?: number }>(v.words, {});
  if (v.voUrl && kept.text === text && fs.existsSync(broll.localFile(v.voUrl))) {
    fs.copyFileSync(broll.localFile(v.voUrl), file);
    return { file, seconds: (kept.tenths ?? avatar.mp3Tenths(fs.readFileSync(file))) / 10, words: kept.words ?? [], url: v.voUrl, changed: false };
  }
  const audio = await avatar.speech(v.organizationId, v.voiceId || DEFAULT_VOICE.id, text);
  fs.writeFileSync(file, audio);
  const tenths = avatar.mp3Tenths(audio);
  // The words as they were actually said, for captions that land on each word; an estimate when that isn't set up.
  let words: Word[] = [];
  if (ENV.assemblyAiKey && process.env.NODE_ENV !== "test") {
    const { transcribeFile } = await import("../_core/transcribe");
    words = await transcribeFile(audio, { timeoutMs: 5 * 60_000 }).then((t) => t.words).catch(() => []);
  }
  if (!words.length) words = estimateWords(text, tenths / 10);
  const saved = await storagePut(`org-${v.organizationId}/videos/vo-${v.id}.mp3`, audio, "audio/mpeg");
  update(v.organizationId, v.id, { voUrl: saved.url, words: JSON.stringify({ text, words, tenths }) });
  return { file, seconds: tenths / 10, words, url: saved.url, changed: true };
}

/** Footage for every scene that doesn't have it yet. New AI clips go to the library and use their work hours. */
async function footage(v: Video, durations: number[], emp: AIEmployee, restyle: boolean) {
  const s = scriptOf(v);
  let made = 0;
  for (let i = 0; i < s.shots.length; i++) {
    const shot = s.shots[i];
    if (shot.src === "art") {
      const wantClip = v.motion === "clips";
      if (shot.file && (!wantClip || /\.mp4$/i.test(shot.file))) continue;
      if (restyle && (!shot.still || wantClip)) throw new Error("A scene needs new footage. Press Make it to make it.");
      let still = shot.still;
      // A scene changed by Redo is drawn now, in the same style and with the same people.
      if (!still) still = (await drawScene(get(v.organizationId, v.id)!, shot, i)).still;
      let file = still;
      if (wantClip) {
        const secs: 5 | 10 = durations[i] > 5.5 ? 10 : 5;
        file = await styles.animate(v.organizationId, { still, see: shot.see, seconds: secs, name: `scene-${v.id}-${i + 1}` });
        await chargeNow(v.organizationId, emp, "clip", broll.clipUnits(secs), `${v.title}, scene ${i + 1}`);
        made++;
      }
      s.shots[i] = { ...shot, still, file };
      update(v.organizationId, v.id, { script: JSON.stringify(s) });
      continue;
    }
    if (shot.file || shot.src === "text" || shot.src === "logo") continue;
    if (restyle) throw new Error("A scene needs new footage. Press Make it to make it.");
    if (shot.src === "library" && shot.clipId) {
      const c = broll.getClip(v.organizationId, shot.clipId);
      if (c?.url) {
        s.shots[i] = { ...shot, file: c.url };
        continue;
      }
    }
    if (shot.src === "stock" && shot.stock) {
      const url = await broll.keepStock(v.organizationId, v.id, { ...shot.stock, seconds: 0, width: 0, height: 0 }).catch(() => null);
      if (url) {
        s.shots[i] = { ...shot, file: url };
        update(v.organizationId, v.id, { script: JSON.stringify(s) });
        continue;
      }
    }
    // A new AI clip: 10 seconds when the scene is longer than 5.
    const secs: 5 | 10 = durations[i] > 5.5 ? 10 : 5;
    const clip = await broll.makeClip(v.organizationId, { prompt: shot.see, title: shot.see.split(/[,.;]/)[0].slice(0, 60), tags: `${shot.see} ${shot.query ?? ""}`.trim(), size: v.size, seconds: secs, by: `${emp.name} for "${v.title}"` });
    await chargeNow(v.organizationId, emp, "clip", broll.clipUnits(secs), clip.title);
    made++;
    s.shots[i] = { ...shot, src: "ai", clipId: clip.id, file: clip.url };
    // Kept right away, so a later failure never makes (or charges for) the same clip twice.
    update(v.organizationId, v.id, { script: JSON.stringify(s) });
  }
  broll.markUsed(v.organizationId, s.shots.filter((x) => x.src === "library" && x.clipId).map((x) => x.clipId!));
  return { shots: s.shots, made };
}

async function cardFor(spec: { headline: string; background: string; accent: string }, size: Size, logo: string | null, dir: string, name: string) {
  const graphic = await import("./graphic");
  const png = await graphic.renderCard({ headline: spec.headline, emphasis: "", subline: "", background: spec.background, accent: spec.accent, text: "#ffffff", subtext: "#efe7d6", strip: spec.background, stripText: "#ffffff" }, size === "vertical" ? "story" : "square", logo);
  const file = path.join(dir, `${name}.png`);
  fs.writeFileSync(file, png);
  return file;
}

/** Edit: captions, logo and music. A finished video is cut again with the same footage, so it uses no work hours. */
export async function restyle(orgId: number, id: number, patch: { captions?: Partial<Look["captions"]>; logo?: Partial<Look["logo"]>; music?: Partial<Look["music"]> }) {
  const v = must(orgId, id);
  notMaking(v);
  const cur = lookOf(v);
  const next: Look = { captions: { ...cur.captions, ...(patch.captions ?? {}) }, logo: { ...cur.logo, ...(patch.logo ?? {}) }, music: { ...cur.music, ...(patch.music ?? {}) } };
  next.music.volume = Math.max(0, Math.min(100, Math.round(next.music.volume)));
  if (next.music.track === "upload" && !next.music.url) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload your track first." });
  if (next.music.track === "upload" && !next.music.url!.startsWith(`/files/org-${orgId}/`)) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload your track first." });
  const saved = update(orgId, id, { look: JSON.stringify(next) });
  if (v.status !== "ready") return saved;
  return makeVideo(orgId, id, { restyle: true });
}

/** Redo a scene on a finished video: new footage for that scene only (its own work hours, if it's a new AI clip), then the cut again. */
export async function redoScene(orgId: number, id: number, n: number, input: { src: Src; see?: string; clipId?: number | null }) {
  await changeShot(orgId, id, n, input, { draw: false });
  const v = must(orgId, id);
  if (v.status !== "ready") return v;
  return makeVideo(orgId, id);
}

/** Voice-over, footage, and the cut in every size, saved as MP4s. */
async function cut(v: Video, emp: AIEmployee, restyle: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-video-in-"));
  try {
    const delay = v.source === "audio" ? 0 : 0.3;
    const vo = await voiceOver(v, dir);
    const fresh = get(v.organizationId, v.id)!;
    const shots0 = scriptOf(fresh).shots;
    const total = Math.round((vo.seconds + delay + 0.7) * 30) / 30;
    const durations = sceneTimes(shots0, vo.words, total, delay);
    const { shots, made } = await footage(fresh, durations, emp, restyle);
    const look = lookOf(fresh);
    const b = await brand(v.organizationId);
    const bg = b.colors[0] ?? "#0d3b2e";
    const accent = b.colors[1] ?? "#d6a74a";
    // The logo as a PNG, whatever it was uploaded as.
    let logoPng: string | null = null;
    if (b.logo) {
      const sharp = (await import("sharp")).default;
      logoPng = path.join(dir, "logo.png");
      await sharp(b.logo).resize({ width: 800, withoutEnlargement: true }).png().toFile(logoPng).catch(() => (logoPng = null));
    }
    let music: RenderInput["music"] = null;
    if (look.music.track === "upload" && look.music.url && fs.existsSync(broll.localFile(look.music.url))) music = { file: broll.localFile(look.music.url), volume: look.music.volume };
    else if (look.music.track !== "none" && look.music.track !== "upload" && look.music.track in broll.TRACKS) {
      const file = await broll.trackFile(look.music.track).catch((err) => (console.warn("[videos] music skipped:", err instanceof Error ? err.message : err), null));
      if (file) music = { file, volume: look.music.volume };
    }
    const urls: Partial<Record<Size, string>> = {};
    for (const size of sizesOf(fresh)) {
      const { w, h } = SIZES[size];
      const clips: Clip[] = [];
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        if (s.src === "text" || s.src === "logo") {
          const file = await cardFor({ headline: s.src === "logo" ? s.see || s.say : s.see || s.say, background: bg, accent }, size, s.src === "logo" ? logoPng : null, dir, `card${i}-${size}`);
          clips.push({ file, seconds: durations[i], fit: size === "wide" ? "contain" : "cover", pad: bg, motion: "push" });
          continue;
        }
        const file = broll.localFile(s.file!);
        if (!fs.existsSync(file)) throw new Error(`The footage for scene ${i + 1} is missing. Press Change shot on it, then make it again.`);
        const video = /\.(mp4|mov|m4v|webm)$/i.test(file);
        clips.push({ file, seconds: durations[i], fit: "cover", pad: "#000000", motion: MOTIONS[i % MOTIONS.length], video });
      }
      const mp4 = await renderer({
        w,
        h,
        audio: vo.file,
        delay,
        total,
        captions: [],
        words: vo.words,
        caps: { ...look.captions, color: look.captions.highlight === "brand" ? accent : GOLD },
        logo: look.logo.on && logoPng ? { file: logoPng, corner: look.logo.corner, size: look.logo.size } : null,
        music,
        clips,
      });
      urls[size] = (await storagePut(`org-${v.organizationId}/videos/video-${v.id}-${SIZES[size].ratio.replace(":", "x")}.mp4`, mp4, "video/mp4")).url;
    }
    return { urls, tenths: Math.round(total * 10), clips: made };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function finish(v: Video, error: string | null, what: "made" | "edit") {
  const emp = await db.getEmployeeForOrg(v.employeeId, v.organizationId);
  if (!emp) return;
  const ratios = sizesOf(v).map((s) => SIZES[s].ratio);
  const content = error
    ? `"${v.title}" didn't finish: ${error} ${what === "edit" ? "Edits use no work hours." : "Scenes already made are kept, so trying again doesn't make them twice."}`
    : what === "edit"
      ? `I saved your changes to "${v.title}". No new footage, so it used no work hours.`
      : `Your video "${v.title}" is ready: ${fmtTime(Math.round((v.tenths ?? 0) / 10))}, ${ratios.join(" and ")}. It's here and on my Videos tab.`;
  await db.createChatMessage({
    organizationId: v.organizationId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content,
    cards: JSON.stringify([{ type: "made_video", id: v.id, title: v.title }, ...(error ? [{ type: "choices", id: Date.now(), title: "", options: ["Try again"] }] : [])]),
  });
}

// ==========================================
// What the screens show
// ==========================================

const STATUS: Record<Video["status"], string> = { draft: "Storyboard", making: "Making", ready: "Ready", failed: "Didn't finish" };

export function lookText(l: Look) {
  return {
    captions: l.captions.on ? `On, ${CAPTION_LABEL[l.captions.style]}, ${POSITION_LABEL[l.captions.position]}, ${HIGHLIGHT_LABEL[l.captions.highlight]}` : "Off",
    logo: l.logo.on ? `On, ${CORNER_LABEL[l.logo.corner]}, ${LOGO_SIZE_LABEL[l.logo.size]}` : "Off",
    music: l.music.track === "none" ? "No music" : `${l.music.track === "upload" ? l.music.name || "My track" : broll.TRACKS[l.music.track].name}, volume ${l.music.volume}`,
  };
}

export function view(v: Video) {
  const s = scriptOf(v);
  const tenths = v.status === "ready" && v.tenths ? v.tenths : v.seconds * 10;
  const look = lookOf(v);
  const urls = urlsOf(v);
  const clipThumbs = new Map(broll.listClips(v.organizationId).map((c) => [c.id, c.thumbUrl]));
  const make = minutesToMake(v);
  const st = styles.resolve(v.organizationId, v.style);
  const drawing = v.drawing && drawJobs.has(v.id) ? v.drawing : null;
  return {
    id: v.id,
    style: styles.isDrawn(v.style) ? st.key : "real",
    styleLabel: st.label,
    motion: v.motion,
    cast: castOf(v).map((c) => ({ name: c.name, look: c.look, portrait: c.portrait ?? null })),
    drawing,
    title: v.title,
    kind: v.kind,
    kindLabel: KIND_LABEL[v.kind],
    size: v.size,
    sizeLabel: SIZES[v.size].label,
    sizes: sizesOf(v),
    ratios: sizesOf(v).map((x) => SIZES[x].ratio),
    source: v.source,
    sourceUrl: v.sourceUrl,
    seconds: v.seconds,
    length: fmtTime(Math.round(tenths / 10)),
    status: v.status,
    statusLabel: STATUS[v.status],
    shots: s.shots.map((x, i) => ({
      n: i,
      at: x.at,
      time: fmtTime(x.at),
      see: x.see,
      say: x.say,
      photo: x.photo ?? "",
      src: (x.src ?? "ai") as Src,
      srcLabel: x.src === "art" ? st.label : SRC_LABEL[x.src ?? "ai"],
      hook: i === 0,
      made: x.src === "art" ? !!x.still && (v.motion !== "clips" || !!(x.file && /\.mp4$/i.test(x.file))) : !!x.file || x.src === "text" || x.src === "logo",
      thumb: x.src === "art" ? x.still ?? null : x.src === "stock" ? x.stock?.thumb ?? null : x.clipId ? clipThumbs.get(x.clipId) ?? null : x.src === "photo" ? x.file ?? null : null,
      who: x.who ?? [],
      credit: x.src === "stock" ? x.stock?.credit ?? null : null,
      creditUrl: x.src === "stock" ? x.stock?.page ?? null : null,
      clipId: x.clipId ?? null,
    })),
    caption: s.caption,
    voiceName: v.voiceName ?? (v.source === "audio" ? "Your recording" : DEFAULT_VOICE.name),
    voiceStandard: avatar.isStandard(v.voiceId ?? DEFAULT_VOICE.id),
    look,
    lookText: lookText(look),
    /** What making it now uses, and what the whole video used or will use. */
    hours: hoursLabel(make || workMinutes(tenths)),
    makeMinutes: make,
    newClips: pendingClips(v),
    paid: !!v.paidAt,
    videoUrl: v.videoUrl,
    videoUrls: Object.fromEntries(sizesOf(v).filter((x) => urls[x]).map((x) => [SIZES[x].ratio, urls[x]!])) as Record<string, string>,
    error: v.error,
    planId: v.planId,
    createdAt: v.createdAt,
  };
}

/** One line for chat: "4 scenes, 30 seconds, 9:16 and 1:1". */
export const summary = (v: Video) => `${scriptOf(v).shots.length} scenes, ${v.seconds > 90 ? `${Math.round(v.seconds / 60)} minutes` : `${v.seconds} seconds`}, ${styles.isDrawn(v.style) ? `${styles.resolve(v.organizationId, v.style).label}, ` : ""}${sizesOf(v).map((s) => SIZES[s].ratio).join(" and ")}`;
