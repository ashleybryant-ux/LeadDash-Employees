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
import { videos, type Video } from "../../drizzle/schema";
import * as avatar from "./avatar";
import { systemPromptFor, working } from "./tasks";

/**
 * Any video Elena makes from instructions, as a finished MP4:
 * - broll: one generated still per shot, each moved with a slow push or pan, under a voice-over,
 * - slideshow: the workspace's own Brain photos with the same motion,
 * - explainer: text cards in the brand colors, one per shot.
 * Talking-to-camera videos are the avatar path (avatar.ts); writeTalking hands off to it.
 *
 * 1. Write: Elena writes a title, a shot list (when, what we see, what's said) and a caption.
 * 2. Make it: the voice-over is read (a standard voice, or the workspace's own avatar voice),
 *    the pictures are made or picked, and ffmpeg cuts them together with captions burned in.
 *    It runs in the background and Elena posts the video in her chat when it's done.
 * Work hours: 8 for each minute of video, counted by the half minute (a 30-second video uses 4).
 */

const run = promisify(execFile);

export type Kind = "broll" | "slideshow" | "explainer";
export type Size = "vertical" | "square" | "wide";
export type VShot = { at: number; see: string; say: string; photo?: string };
export type Script = { shots: VShot[]; caption: string };

export const KINDS: Kind[] = ["broll", "slideshow", "explainer"];
export const KIND_LABEL: Record<Kind | "talking", string> = { broll: "B-roll with voice-over", slideshow: "Slideshow", explainer: "Explainer", talking: "Talking to camera" };
export const SIZES: Record<Size, { w: number; h: number; ratio: string; label: string }> = {
  vertical: { w: 1080, h: 1920, ratio: "9:16", label: "vertical" },
  square: { w: 1080, h: 1080, ratio: "1:1", label: "square" },
  wide: { w: 1920, h: 1080, ratio: "16:9", label: "wide" },
};
/** The voice when the workspace has no avatar voice of its own. */
export const DEFAULT_VOICE = { id: `${avatar.STANDARD}coral`, name: "Coral" };
const STILL_MODEL = "fal-ai/nano-banana-pro";

/** The kind someone asked for, from Elena's words ("b-roll", "slideshow", "me on camera"); null when unclear. */
export function kindFrom(words: string): Kind | "talking" | null {
  const w = words.trim().toLowerCase();
  if (!w) return null;
  if (/talk|camera|avatar|\bme\b|on screen|presenter/.test(w)) return "talking";
  if (/slide|photo/.test(w)) return "slideshow";
  if (/explain|text|card|typograph|kinetic/.test(w)) return "explainer";
  if (/b-?roll|broll|voice|footage|stock|cinematic/.test(w)) return "broll";
  return null;
}

export function sizeFrom(words: string): Size {
  const w = words.trim().toLowerCase();
  if (/square|1:1|feed/.test(w)) return "square";
  if (/wide|landscape|horizontal|16:9|youtube(?! short)/.test(w)) return "wide";
  return "vertical";
}

/** Work hours for a video: 8 for each minute, counted by the half minute. */
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
  return { shots: Array.isArray(s.shots) ? s.shots : [], caption: s.caption ?? "" } as Script;
};
export const voiceOverOf = (v: Pick<Video, "script">) => scriptOf(v).shots.map((s) => s.say.trim()).filter(Boolean).join(" ");

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
export function remove(orgId: number, id: number) {
  const v = get(orgId, id);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
  db.getDb().delete(videos).where(and(eq(videos.id, id), eq(videos.organizationId, orgId))).run();
}

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  return emp;
}

/** The voice for a new video: the workspace's own avatar voice when one is set, else a standard voice. */
async function voiceFor(orgId: number) {
  const s = avatar.settingsOf(await elena(orgId));
  if (s.voiceId && (avatar.isStandard(s.voiceId) || (await avatar.hasElevenLabs(orgId)))) return { id: s.voiceId, name: s.voiceName ?? "Your voice" };
  return DEFAULT_VOICE;
}

// ==========================================
// Writing
// ==========================================

const SCRIPT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "shots", "caption"],
  properties: {
    title: { type: "string", description: "A short title, at most 8 words." },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["at", "see", "say", "photo"],
        properties: {
          at: { type: "integer", description: "When the shot starts, in seconds from the start." },
          see: { type: "string", description: "What we see." },
          say: { type: "string", description: "The voice-over words over this shot." },
          photo: { type: "string", description: "Slideshow only: the title of the Brain photo for this shot. '' otherwise." },
        },
      },
    },
    caption: { type: "string", description: "The caption to post with the video." },
  },
};

const HOW: Record<Kind, string> = {
  broll: `B-roll with a voice-over. "see" is one still, cinematic shot each (a place, an object, hands, a person seen from behind or far away), described so an image model can draw it. Never a readable sign, screen or words in the picture, and never a real client.`,
  slideshow: `A slideshow of the workspace's own photos. For each shot pick the photo that fits best by its title and put that title in "photo"; "see" says what's in it.`,
  explainer: `An explainer made of text cards. "see" is the few words on the card (at most 8 words, the point of the shot), not a picture.`,
};

function cleanShots(raw: unknown, seconds: number): VShot[] {
  const list = (Array.isArray(raw) ? raw : []) as Partial<VShot>[];
  const shots = list
    .map((s) => ({ at: Math.max(0, Math.round(Number(s.at) || 0)), see: String(s.see ?? "").trim().slice(0, 300), say: String(s.say ?? "").trim().slice(0, 400), photo: String(s.photo ?? "").trim().slice(0, 200) }))
    .filter((s) => s.see || s.say)
    .slice(0, 16)
    .sort((a, b) => a.at - b.at);
  if (shots.length) shots[0].at = 0;
  return shots.map((s) => ({ ...s, at: Math.min(s.at, Math.max(0, seconds - 1)), ...(s.photo ? {} : { photo: undefined }) }));
}

async function writeScript(orgId: number, input: { instructions: string; kind: Kind; seconds: number; size: Size; current?: Script & { title: string }; change?: string }) {
  const emp = await elena(orgId);
  const photos = input.kind === "slideshow" ? await avatar.photos(orgId) : [];
  const words = Math.round(input.seconds * 2.4);
  const { system } = await systemPromptFor(
    emp,
    `Write a ${input.seconds}-second ${SIZES[input.size].label} video: ${KIND_LABEL[input.kind]}.
${HOW[input.kind]}
- A shot list: 3 to 8 shots, each with when it starts (seconds), what we see, and the voice-over words over it. The first shot starts at 0 and hooks in the first two seconds. End with the call to action when they gave one.
- The voice-over is read aloud: about ${words} words in all, the way people talk, American English, no em dashes, no stage directions.
- A caption to post with it: one to three short lines.
- Never use a client's name or health information.${photos.length ? `\nThe workspace's photos:\n${photos.map((p) => `- ${p.title}${p.note ? `: ${p.note.slice(0, 120)}` : ""}`).join("\n")}` : ""}`
  );
  const prompt = input.current
    ? `The video so far:\nTitle: ${input.current.title}\n${input.current.shots.map((s) => `${fmtTime(s.at)} We see: ${s.see} | Said: ${s.say}`).join("\n")}\nCaption: ${input.current.caption}\n\nWhat they asked for at first: ${input.instructions}\nChange: ${input.change || "write it again"}\nRewrite it with that change and keep the rest.`
    : `What they asked for: ${input.instructions}`;
  const out = await generateJson<{ title: string; shots: VShot[]; caption: string }>({ system, prompt, schemaName: "video_script", schema: SCRIPT_SCHEMA, maxTokens: 2000 });
  const shots = cleanShots(out?.shots, input.seconds);
  if (!shots.length) throw new Error("I couldn't write the shot list. Tell me a little more about the video.");
  return { title: String(out.title ?? "").trim().slice(0, 120) || "Video", shots, caption: String(out.caption ?? "").trim().slice(0, 600) };
}

/** Elena writes the video from instructions and saves it as a draft. */
export async function writeVideo(orgId: number, input: { instructions: string; kind?: Kind; size?: Size; seconds?: number; planId?: number | null }) {
  const emp = await elena(orgId);
  const kind = input.kind && KINDS.includes(input.kind) ? input.kind : "broll";
  const size = input.size && input.size in SIZES ? input.size : "vertical";
  const seconds = Math.max(10, Math.min(120, Math.round(input.seconds || 30)));
  const instructions = input.instructions.trim().slice(0, 2000);
  if (!instructions) throw new TRPCError({ code: "BAD_REQUEST", message: "Tell me what the video is about." });
  const s = await writeScript(orgId, { instructions, kind, seconds, size });
  const voice = await voiceFor(orgId);
  return db
    .getDb()
    .insert(videos)
    .values({ organizationId: orgId, employeeId: emp.id, title: s.title, kind, size, seconds, instructions, script: JSON.stringify({ shots: s.shots, caption: s.caption }), voiceId: voice.id, voiceName: voice.name, planId: input.planId ?? null })
    .returning()
    .get();
}

/** "Change the script": Elena rewrites it with the change asked for. */
export async function rewriteVideo(orgId: number, id: number, change: string) {
  const v = get(orgId, id);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes, then change the script." });
  const s = await writeScript(orgId, { instructions: v.instructions, kind: v.kind, seconds: v.seconds, size: v.size, current: { title: v.title, ...scriptOf(v) }, change });
  return update(orgId, id, { title: s.title, script: JSON.stringify({ shots: s.shots, caption: s.caption }), status: "draft", error: null });
}

/** Edit script on the Videos tab: the shots and caption as typed. */
export function saveScript(orgId: number, id: number, input: { title?: string; shots: VShot[]; caption?: string }) {
  const v = get(orgId, id);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes, then change the script." });
  const shots = cleanShots(input.shots, v.seconds);
  if (!shots.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Keep at least one shot." });
  const old = scriptOf(v);
  const kept = shots.map((s, i) => ({ ...s, ...(old.shots[i]?.photo && !s.photo ? { photo: old.shots[i].photo } : {}) }));
  return update(orgId, id, { title: input.title?.trim().slice(0, 120) || v.title, script: JSON.stringify({ shots: kept, caption: input.caption ?? old.caption }), status: "draft", error: null });
}

/** A talking-to-camera video: Elena writes the words, then it's the avatar path from here. */
export async function writeTalking(orgId: number, input: { instructions: string; seconds?: number; who?: string | null }) {
  const emp = await elena(orgId);
  const seconds = Math.max(10, Math.min(120, Math.round(input.seconds || 30)));
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

/** Video plans from trends: their shot list becomes a b-roll video. */
export async function fromPlan(orgId: number, planId: number) {
  const item = await db.getWorkItemForOrg(planId, orgId);
  if (!item || item.kind !== "video_plan") throw new TRPCError({ code: "NOT_FOUND", message: "That video plan is not in this workspace." });
  const existing = db.getDb().select().from(videos).where(and(eq(videos.organizationId, orgId), eq(videos.planId, planId))).orderBy(desc(videos.id)).get();
  if (existing) return existing;
  const data = parse<{ plan?: { title?: string; lengthSeconds?: number; hook?: string; shots?: { time?: string; shot?: string; say?: string }[]; caption?: string } }>(item.data, {});
  const p = data.plan ?? {};
  const seconds = Math.max(10, Math.min(120, Math.round(p.lengthSeconds || 30)));
  const shots = cleanShots((p.shots ?? []).map((s) => ({ at: secondsOf(s.time ?? ""), see: s.shot ?? "", say: s.say ?? "" })), seconds);
  if (!shots.length) throw new TRPCError({ code: "BAD_REQUEST", message: "That plan has no shots to make." });
  const emp = await elena(orgId);
  const voice = await voiceFor(orgId);
  return db
    .getDb()
    .insert(videos)
    .values({ organizationId: orgId, employeeId: emp.id, title: (p.title || item.title).slice(0, 120), kind: "broll", size: "vertical", seconds, instructions: [p.title, p.hook].filter(Boolean).join(". ").slice(0, 2000) || item.title, script: JSON.stringify({ shots, caption: p.caption ?? "" }), voiceId: voice.id, voiceName: voice.name, planId })
    .returning()
    .get();
}

/** "0:03", "0:03-0:06", "3s" or "3-6s": where a plan's shot starts, in seconds. */
export function secondsOf(time: string) {
  const mm = time.match(/(\d+):(\d{1,2})/);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
  const s = time.match(/(\d+(?:\.\d+)?)/);
  return s ? Math.round(Number(s[1])) : 0;
}

// ==========================================
// Making
// ==========================================

export type Motion = "push" | "pull" | "right" | "left";
export type Clip = { file: string; seconds: number; fit: "cover" | "contain"; pad: string; motion: Motion };
export type Caption = { from: number; to: number; text: string };
export type RenderInput = { w: number; h: number; clips: Clip[]; audio: string; delay: number; total: number; captions: Caption[] };

const MOTIONS: Motion[] = ["push", "right", "pull", "left"];
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * How the cut is laid out once the voice-over's length is known: each shot gets time in
 * proportion to the words said over it (so the pictures change with the voice), and the
 * spoken words become captions of a few words at a time.
 */
export function planCut(shots: Pick<VShot, "say">[], audioSeconds: number, delay = 0.3, tail = 0.7) {
  const total = Math.round((audioSeconds + delay + tail) * 30) / 30;
  const weights = shots.map((s) => Math.max(2, words(s.say)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const frames = weights.map((w) => Math.max(15, Math.round((w / sum) * total * 30)));
  frames[frames.length - 1] += Math.round(total * 30) - frames.reduce((a, b) => a + b, 0);
  if (frames[frames.length - 1] < 15) frames[frames.length - 1] = 15;
  const durations = frames.map((f) => f / 30);
  const starts = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));
  // Captions follow the voice: the words are spread over the voice-over's own length.
  const allWords = shots.reduce((n, s) => n + words(s.say), 0) || 1;
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

const assTime = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};

function captionsFile(dir: string, w: number, h: number, caps: Caption[]) {
  if (!caps.length) return null;
  const size = Math.round(Math.min(w, h) * (h > w ? 0.058 : 0.05));
  const margin = Math.round(h * (h > w ? 0.17 : 0.09));
  const file = path.join(dir, "captions.ass");
  fs.writeFileSync(
    file,
    `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,1,0,0,0,100,100,0,0,1,${Math.round(size / 18)},1,2,${Math.round(w * 0.08)},${Math.round(w * 0.08)},${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${caps.map((c) => `Dialogue: 0,${assTime(c.from)},${assTime(c.to)},Cap,,0,0,0,,${c.text.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ")}`).join("\n")}
`
  );
  return file;
}

/** The zoompan move for one still: a slow push in, pull out, or pan. */
function moveFilter(m: Motion, frames: number) {
  const mid = "y='ih/2-(ih/zoom/2)'";
  if (m === "push") return `z='1+0.1*on/${frames}':x='iw/2-(iw/zoom/2)':${mid}`;
  if (m === "pull") return `z='1.1-0.1*on/${frames}':x='iw/2-(iw/zoom/2)':${mid}`;
  if (m === "right") return `z='1.1':x='(iw-iw/zoom)*on/${frames}':${mid}`;
  return `z='1.1':x='(iw-iw/zoom)*(1-on/${frames})':${mid}`;
}

/** The ffmpeg cut: every still moved and sized to the format, joined, captions burned in, the voice-over under it. */
export async function render(input: RenderInput): Promise<Buffer> {
  const drama = await import("./drama");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-video-"));
  try {
    const { w, h } = input;
    // Moving a still at twice the size keeps the motion smooth.
    const W2 = w * 2;
    const H2 = h * 2;
    const args = ["-y"];
    input.clips.forEach((c) => args.push("-i", c.file));
    args.push("-i", input.audio);
    const parts: string[] = [];
    input.clips.forEach((c, i) => {
      const frames = Math.max(1, Math.round(c.seconds * 30));
      const fit = c.fit === "cover" ? `scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2}` : `scale=${W2}:${H2}:force_original_aspect_ratio=decrease,pad=${W2}:${H2}:(ow-iw)/2:(oh-ih)/2:color=${c.pad.replace("#", "0x")}`;
      parts.push(`[${i}:v]${fit},setsar=1,zoompan=${moveFilter(c.motion, frames)}:d=${frames}:s=${w}x${h}:fps=30,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${i}]`);
    });
    parts.push(`${input.clips.map((_, i) => `[v${i}]`).join("")}concat=n=${input.clips.length}:v=1:a=0[vc]`);
    const caps = captionsFile(dir, w, h, input.captions);
    const fd = drama.fontsDir();
    parts.push(caps ? `[vc]ass=${caps.replace(/:/g, "\\:")}${fd ? `:fontsdir=${fd.replace(/:/g, "\\:")}` : ""}[v]` : "[vc]null[v]");
    const ms = Math.round(input.delay * 1000);
    parts.push(`[${input.clips.length}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${ms}|${ms},apad,atrim=0:${input.total.toFixed(3)},afade=t=out:st=${Math.max(0, input.total - 0.4).toFixed(3)}:d=0.4[a]`);
    const out = path.join(dir, "out.mp4");
    args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]", "-t", input.total.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out);
    await run(drama.ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 }).catch((e) => {
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

/** Starts making a video. It runs in the background; Elena posts it in her chat when it's done. */
export async function makeVideo(orgId: number, id: number): Promise<Video> {
  const v = get(orgId, id);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  if (v.status === "making") return v;
  if (!scriptOf(v).shots.length) throw new TRPCError({ code: "BAD_REQUEST", message: "This video has no shots yet." });
  const voiceId = v.voiceId || DEFAULT_VOICE.id;
  if (v.kind === "broll" && !ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making b-roll isn't set up on the server yet. LeadDash support can turn it on." });
  if (avatar.isStandard(voiceId) && !ENV.openAiKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Voices aren't set up on the server yet. LeadDash support can turn them on." });
  if (v.kind === "slideshow" && !(await avatar.photos(orgId)).length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add your photos to the Brain first (or attach them in Elena's chat), then press Make it." });
  // Out of work hours means it doesn't start.
  await hours.gate(orgId);
  const emp = await elena(orgId);
  const started = update(orgId, id, { status: "making", error: null, voiceId, voiceName: v.voiceName || DEFAULT_VOICE.name });
  const job = (async () => {
    try {
      const r = await working(emp, () => cut(started), { job: "video", count: (x) => workMinutes(x.tenths) / hours.JOBS.video.minutes, label: started.title });
      await finish(update(orgId, id, { status: "ready", videoUrl: r.url, tenths: r.tenths, error: null }), null);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      await finish(update(orgId, id, { status: "failed", error: msg }), msg);
    } finally {
      jobs.delete(id);
    }
  })();
  jobs.set(id, job);
  return started;
}

/** The pictures for each shot, as files on disk. */
async function pictures(v: Video, shots: VShot[], dir: string): Promise<{ file: string; fit: "cover" | "contain"; pad: string }[]> {
  const size = SIZES[v.size];
  if (v.kind === "slideshow") {
    const photos = await avatar.photos(v.organizationId);
    const used = new Set<number>();
    return shots.map((s, i) => {
      const t = (s.photo ?? "").trim().toLowerCase();
      const pick = (t ? photos.find((p) => p.title.toLowerCase() === t) ?? photos.find((p) => p.title.toLowerCase().includes(t) || t.includes(p.title.toLowerCase())) : null) ?? photos.find((p) => !used.has(p.id)) ?? photos[i % photos.length];
      used.add(pick.id);
      return { file: path.join(uploadsRoot(), pick.url.replace(/^\/files\//, "")), fit: "cover" as const, pad: "#000000" };
    });
  }
  if (v.kind === "explainer") {
    const graphic = await import("./graphic");
    const org = await db.getOrganizationById(v.organizationId);
    const colors = parse<string[]>(org?.brandColors, []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
    const spec = { emphasis: "", subline: "", background: colors[0] ?? "#0d3b2e", accent: colors[1] ?? "#d6a74a", text: "#ffffff", subtext: "#efe7d6", strip: colors[0] ?? "#0d3b2e", stripText: "#ffffff" };
    const logo = org?.logoUrl?.startsWith("/files/") ? path.join(uploadsRoot(), org.logoUrl.slice("/files/".length)) : null;
    const shape = v.size === "vertical" ? "story" : "square";
    return Promise.all(
      shots.map(async (s, i) => {
        const png = await graphic.renderCard({ ...spec, headline: s.see || s.say }, shape, logo && fs.existsSync(logo) ? logo : null);
        const file = path.join(dir, `card${i}.png`);
        fs.writeFileSync(file, png);
        return { file, fit: v.size === "wide" ? ("contain" as const) : ("cover" as const), pad: spec.background };
      })
    );
  }
  // B-roll: one still per shot, three at a time.
  const drama = await import("./drama");
  const out: { file: string; fit: "cover"; pad: string }[] = [];
  for (let i = 0; i < shots.length; i += 3) {
    const batch = await Promise.all(
      shots.slice(i, i + 3).map(async (s, j) => {
        const r = await drama.falRun(STILL_MODEL, { prompt: `A still frame of b-roll footage: ${s.see}. Real, natural light, shot on a cinema camera, shallow depth of field, muted natural color. No text, letters, signs, screens with words, logos or watermarks.`, aspect_ratio: size.ratio, num_images: 1, output_format: "png" }, 5);
        const url = r?.images?.[0]?.url as string | undefined;
        if (!url) throw new Error(`The picture for shot ${i + j + 1} didn't come back.`);
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`Couldn't download the picture for shot ${i + j + 1} (${res.status}).`);
        const file = path.join(dir, `still${i + j}.png`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        return { file, fit: "cover" as const, pad: "#000000" };
      })
    );
    out.push(...batch);
  }
  return out;
}

/** Voice-over, pictures and the cut, saved as an MP4. */
async function cut(v: Video) {
  const shots = scriptOf(v).shots;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-video-in-"));
  try {
    const audio = await avatar.speech(v.organizationId, v.voiceId || DEFAULT_VOICE.id, voiceOverOf(v) || v.title);
    const tenths = avatar.mp3Tenths(audio);
    const audioFile = path.join(dir, "vo.mp3");
    fs.writeFileSync(audioFile, audio);
    const pics = await pictures(v, shots, dir);
    const plan = planCut(shots, tenths / 10);
    const { w, h } = SIZES[v.size];
    const mp4 = await renderer({ w, h, audio: audioFile, delay: 0.3, total: plan.total, captions: plan.captions, clips: pics.map((p, i) => ({ ...p, seconds: plan.durations[i], motion: v.kind === "explainer" ? "push" : plan.motions[i] })) });
    const saved = await storagePut(`org-${v.organizationId}/videos/video-${v.id}.mp4`, mp4, "video/mp4");
    return { url: saved.url, tenths: Math.round(plan.total * 10) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function finish(v: Video, error: string | null) {
  const emp = await db.getEmployeeForOrg(v.employeeId, v.organizationId);
  if (!emp) return;
  const content = error ? `"${v.title}" didn't finish: ${error} It used no work hours.` : `Your video "${v.title}" is ready. It came out at ${fmtTime(Math.round((v.tenths ?? 0) / 10))} and used ${hoursLabel(workMinutes(v.tenths))}. It's on my Videos tab.`;
  await db.createChatMessage({
    organizationId: v.organizationId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content,
    cards: JSON.stringify([{ type: "made_video", id: v.id, title: v.title }, { type: "choices", id: Date.now(), title: "", options: error ? ["Try again"] : ["Make a shorter one", "Change the script", "Make another"] }]),
  });
}

// ==========================================
// What the screens show
// ==========================================

const STATUS: Record<Video["status"], string> = { draft: "Script ready", making: "Making", ready: "Ready", failed: "Didn't finish" };

export function view(v: Video) {
  const s = scriptOf(v);
  const tenths = v.status === "ready" && v.tenths ? v.tenths : v.seconds * 10;
  return {
    id: v.id,
    title: v.title,
    kind: v.kind,
    kindLabel: KIND_LABEL[v.kind],
    size: v.size,
    sizeLabel: SIZES[v.size].label,
    seconds: v.seconds,
    length: fmtTime(Math.round(tenths / 10)),
    status: v.status,
    statusLabel: STATUS[v.status],
    shots: s.shots.map((x) => ({ at: x.at, time: fmtTime(x.at), see: x.see, say: x.say, photo: x.photo ?? "" })),
    caption: s.caption,
    voiceName: v.voiceName ?? DEFAULT_VOICE.name,
    voiceStandard: avatar.isStandard(v.voiceId ?? DEFAULT_VOICE.id),
    hours: hoursLabel(workMinutes(tenths)),
    videoUrl: v.videoUrl,
    error: v.error,
    planId: v.planId,
    createdAt: v.createdAt,
  };
}

/** One line for chat: "4 shots, 30 seconds, vertical". */
export const summary = (v: Video) => `${scriptOf(v).shots.length} shots, ${v.seconds} seconds, ${SIZES[v.size].label}`;
