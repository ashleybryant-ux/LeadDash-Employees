import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as db from "../db";
import * as hours from "../workHours";
import { ENV } from "../_core/env";
import { describeImage, generateJson } from "../_core/llm";
import { storagePut, uploadsRoot } from "../storage";
import { brollClips, type BrollClip } from "../../drizzle/schema";
import { withUsage } from "../usage";

/**
 * Elena's b-roll library, licensed stock video and the music under her videos.
 * - Library: AI clips Elena made (each saved here for every video after) and clips people uploaded
 *   (MP4 or MOV, up to 60 seconds). Reusing a clip uses no work hours.
 * - Stock: Pexels video, when the server has a Pexels key.
 * - AI clip: a still made with an image model, then moved with an image-to-video model (5 or 10 seconds).
 * - Music: a few built-in instrumental tracks (made once with an AI music model and kept), or a track they upload.
 */

const run = promisify(execFile);

export type Size = "vertical" | "square" | "wide";
export const RATIO: Record<Size, string> = { vertical: "9:16", square: "1:1", wide: "16:9" };
export const MAX_UPLOAD_SECONDS = 60;
const STILL_MODEL = "fal-ai/nano-banana-pro";
const CLIP_MODEL = "fal-ai/kling-video/v3/pro/image-to-video";
const MUSIC_MODEL = "fal-ai/lyria2";

// ==========================================
// Rows
// ==========================================

export function getClip(orgId: number, id: number) {
  return db.getDb().select().from(brollClips).where(and(eq(brollClips.id, id), eq(brollClips.organizationId, orgId))).get() ?? null;
}
export function listClips(orgId: number) {
  return db.getDb().select().from(brollClips).where(eq(brollClips.organizationId, orgId)).orderBy(desc(brollClips.id)).all();
}
export const readyClips = (orgId: number) => listClips(orgId).filter((c) => c.status === "ready" && c.url);
function updateClip(orgId: number, id: number, data: Partial<typeof brollClips.$inferInsert>) {
  db.getDb().update(brollClips).set(data).where(and(eq(brollClips.id, id), eq(brollClips.organizationId, orgId))).run();
  return getClip(orgId, id)!;
}
export function setFavorite(orgId: number, id: number, favorite: boolean) {
  if (!getClip(orgId, id)) throw new TRPCError({ code: "NOT_FOUND", message: "That clip is not in this workspace." });
  return updateClip(orgId, id, { favorite });
}
export function removeClip(orgId: number, id: number) {
  const c = getClip(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That clip is not in this workspace." });
  if (c.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this clip is made." });
  // Videos that used it keep their own copy of what they need.
  db.getDb().delete(brollClips).where(and(eq(brollClips.id, id), eq(brollClips.organizationId, orgId))).run();
}
export function markUsed(orgId: number, ids: number[]) {
  if (!ids.length) return;
  db.getDb().update(brollClips).set({ uses: sql`${brollClips.uses} + 1` }).where(and(eq(brollClips.organizationId, orgId), inArray(brollClips.id, ids))).run();
}

/** Which sizes a clip fits without much cropping, by its shape. */
export function fitsOf(c: Pick<BrollClip, "width" | "height">): Size[] {
  const w = c.width ?? 0;
  const h = c.height ?? 0;
  if (!w || !h) return ["vertical"];
  const r = w / h;
  if (r < 0.8) return ["vertical", "square"];
  if (r > 1.25) return ["wide", "square"];
  return ["square", "vertical", "wide"];
}

export function clipView(c: BrollClip) {
  return {
    id: c.id,
    title: c.title,
    tags: c.tags,
    source: c.source,
    sourceLabel: c.source === "made" ? "AI clip" : "Uploaded",
    status: c.status,
    url: c.url,
    thumbUrl: c.thumbUrl,
    length: (() => {
      const secs = Math.round((c.tenths ?? 0) / 10);
      return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    })(),
    fits: fitsOf(c).map((s) => RATIO[s]),
    w: c.width,
    h: c.height,
    seconds: Math.round((c.tenths ?? 0) / 10),
    favorite: c.favorite,
    uses: c.uses,
    error: c.error,
    createdAt: c.createdAt,
  };
}

// ==========================================
// Files
// ==========================================

export const localFile = (fileUrl: string) => path.join(uploadsRoot(), fileUrl.replace(/^\/files\//, ""));

/** Length, size and whether it has sound. */
export async function probe(file: string) {
  const ff = (await import("./drama")).ffmpegPath();
  const { stderr } = await run(ff, ["-hide_banner", "-i", file], { timeout: 30_000 }).catch((e) => ({ stderr: String(e.stderr ?? "") }));
  const d = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const v = stderr.match(/Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/);
  // A phone clip filmed upright is stored sideways with a rotation flag.
  const rotated = /rotate\s*:\s*-?(90|270)|displaymatrix: rotation of -?90/.test(stderr);
  const w = v ? Number(v[1]) : 0;
  const h = v ? Number(v[2]) : 0;
  return { seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0, width: rotated ? h : w, height: rotated ? w : h, video: !!v, audio: /Stream #\d+:\d+.*Audio:/.test(stderr) };
}

/** A still from the clip, for the library. */
async function thumbOf(file: string, dir: string) {
  const ff = (await import("./drama")).ffmpegPath();
  const out = path.join(dir, "thumb.jpg");
  await run(ff, ["-y", "-loglevel", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", out], { timeout: 60_000 }).catch(() => run(ff, ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", out], { timeout: 60_000 }));
  return fs.existsSync(out) ? fs.readFileSync(out) : null;
}

/** Any clip as a plain H.264 MP4 with no sound (MOV, HEVC from a phone), at most 1080 on its short side. */
async function normalize(file: string, dir: string) {
  const ff = (await import("./drama")).ffmpegPath();
  const out = path.join(dir, "clip.mp4");
  await run(ff, ["-y", "-loglevel", "error", "-i", file, "-an", "-vf", "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)',fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-movflags", "+faststart", out], { maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60_000 }).catch((e) => {
    throw new Error(`That clip couldn't be read: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-1)[0].slice(0, 200)}`);
  });
  return out;
}

const cameraName = (name: string) => /^(img|vid|mov|dsc|dji|gopr|pxl|mvi|video|clip|screen)[\s_-]?\d/i.test(name) || /^\d[\d\s_-]+$/.test(name);
const cleanName = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A clip someone uploaded: checked (up to 60 seconds), made into a plain MP4, given a still,
 * and tagged so Elena can find it (from a look at the still, when photos may be read here).
 */
export async function saveUpload(orgId: number, input: { file: string; name: string; by: string; describe: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-broll-"));
  try {
    const p = await probe(input.file);
    if (!p.video) throw new Error("Upload an MP4 or MOV video.");
    if (p.seconds > MAX_UPLOAD_SECONDS + 0.5) throw new Error(`Clips can be up to ${MAX_UPLOAD_SECONDS} seconds. This one is ${Math.round(p.seconds)}.`);
    const mp4 = await normalize(input.file, dir);
    const out = await probe(mp4);
    const thumb = await thumbOf(mp4, dir);
    const saved = await storagePut(`org-${orgId}/broll/upload.mp4`, fs.readFileSync(mp4), "video/mp4");
    const still = thumb ? await storagePut(`org-${orgId}/broll/upload.jpg`, thumb, "image/jpeg") : null;
    const seen = thumb && input.describe ? (await describeImage(thumb, "image/jpeg").catch(() => "")).trim() : "";
    const base = cleanName(input.name);
    const title = (!base || cameraName(base) ? seen.split(/[.;]/)[0] : base).slice(0, 80) || "Uploaded clip";
    return db
      .getDb()
      .insert(brollClips)
      .values({ organizationId: orgId, title, tags: [base, seen].filter(Boolean).join(". ").slice(0, 600), source: "uploaded", status: "ready", url: saved.url, thumbUrl: still?.url ?? null, tenths: Math.round(out.seconds * 10), width: out.width, height: out.height, createdBy: input.by })
      .returning()
      .get();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ==========================================
// AI clips
// ==========================================

/** fal.ai's price per clip, in cents (October 2026): one still, then image-to-video with no sound. */
export const clipCents = (seconds: 5 | 10) => (seconds === 10 ? 127 : 71);
/** Work hours for new AI clips: 2 hours for each 5 seconds. */
export const clipUnits = (seconds: number) => (seconds > 5.5 ? 2 : 1);

async function download(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Couldn't download it (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/** One new clip that moves: a still first, then the still brought to life. Saved to the library. */
export async function makeClip(orgId: number, input: { prompt: string; title: string; tags: string; size: Size; seconds: 5 | 10; by: string; rowId?: number }) {
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making AI clips isn't set up on the server yet. LeadDash support can turn it on." });
  const drama = await import("./drama");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-clip-"));
  try {
    const still = await drama.falRun(STILL_MODEL, { prompt: `A still frame of b-roll footage: ${input.prompt}. Real, natural light, shot on a cinema camera, shallow depth of field, muted natural color. No text, letters, signs, screens with words, logos or watermarks.`, aspect_ratio: RATIO[input.size], num_images: 1, output_format: "png" }, 5);
    const stillUrl = still?.images?.[0]?.url as string | undefined;
    if (!stillUrl) throw new Error("The picture for the clip didn't come back.");
    const stillBuf = await download(stillUrl);
    const moved = await drama.falRun(CLIP_MODEL, {
      start_image_url: stillUrl,
      prompt: `${input.prompt}. Slow, steady, natural camera movement, real life motion, b-roll.`,
      duration: String(input.seconds),
      generate_audio: false,
      negative_prompt: "blur, distortion, low quality, on-screen text, captions, watermark, extra fingers, distorted hands, warped faces, morphing, surreal motion",
    }, 25);
    const clipUrl = moved?.video?.url as string | undefined;
    if (!clipUrl) throw new Error("The clip didn't come back.");
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, await download(clipUrl));
    const p = await probe(file);
    const saved = await storagePut(`org-${orgId}/broll/clip.mp4`, fs.readFileSync(file), "video/mp4");
    const thumb = await storagePut(`org-${orgId}/broll/clip.png`, stillBuf, "image/png");
    const data = { title: input.title.slice(0, 80) || "AI clip", tags: input.tags.slice(0, 600), prompt: input.prompt.slice(0, 600), source: "made" as const, status: "ready" as const, url: saved.url, thumbUrl: thumb.url, tenths: Math.round((p.seconds || input.seconds) * 10), width: p.width || null, height: p.height || null, error: null, createdBy: input.by };
    if (input.rowId) return updateClip(orgId, input.rowId, data);
    return db.getDb().insert(brollClips).values({ organizationId: orgId, ...data }).returning().get();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "tags", "prompt"],
        properties: {
          title: { type: "string", description: "A short name for the clip, at most 6 words." },
          tags: { type: "string", description: "Words to find it by: subject, place, mood, light, motion." },
          prompt: { type: "string", description: "What we see and how it moves, for a video model. No readable words, signs or screens, never a real client." },
        },
      },
    },
  },
} as const;

const jobs = new Map<number, Promise<void>>();
/** The background job making a set of clips (tests wait on it). */
export const setJob = (orgId: number) => jobs.get(orgId) ?? null;

/**
 * "Make clips": Elena writes a set of distinct shots from what they asked for and makes each one.
 * Each finished clip uses its work hours; one that fails uses none.
 */
export async function makeSet(orgId: number, input: { ask: string; count: number; size: Size; seconds: 5 | 10; by: string }) {
  const ask = input.ask.trim().slice(0, 1000);
  if (!ask) throw new TRPCError({ code: "BAD_REQUEST", message: "Tell me what the clips should show." });
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making AI clips isn't set up on the server yet. LeadDash support can turn it on." });
  if (jobs.has(orgId)) throw new TRPCError({ code: "BAD_REQUEST", message: "I'm still making the last set. I'll post here when it's done." });
  const count = Math.max(1, Math.min(10, Math.round(input.count || 4)));
  await hours.gate(orgId);
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  const out = await generateJson<{ clips: { title: string; tags: string; prompt: string }[] }>({
    system: "You plan b-roll clips for a small business's videos. Each clip is one continuous shot with gentle real motion. Every clip is different (angle, subject or moment). American English, no em dashes. Never a client's name or health information.",
    prompt: `Plan ${count} b-roll clips, ${input.seconds} seconds each, ${RATIO[input.size]}: ${ask}`,
    schemaName: "broll_set",
    schema: SET_SCHEMA as never,
    maxTokens: 1500,
  });
  const plan = (out?.clips ?? []).filter((c) => c?.prompt?.trim()).slice(0, count);
  if (!plan.length) throw new TRPCError({ code: "BAD_REQUEST", message: "I couldn't plan those clips. Tell me a little more about what they should show." });
  const rows = plan.map((c) => db.getDb().insert(brollClips).values({ organizationId: orgId, title: c.title.trim().slice(0, 80) || "AI clip", tags: c.tags.slice(0, 600), prompt: c.prompt.slice(0, 600), source: "made", status: "making", createdBy: input.by }).returning().get());
  const job = (async () => {
    let made = 0;
    try {
      for (let i = 0; i < rows.length; i += 2) {
        await Promise.all(
          rows.slice(i, i + 2).map(async (r) => {
            try {
              await makeClip(orgId, { prompt: r.prompt!, title: r.title, tags: r.tags, size: input.size, seconds: input.seconds, by: input.by, rowId: r.id });
              await withUsage({ orgId, employeeId: emp.id, kind: emp.kind }, async () => {
                const minutes = await hours.charge(orgId, emp.id, "clip", clipUnits(input.seconds), r.title);
                if (minutes > 0) await db.recordEmployeeTask(emp.id, orgId, minutes);
              });
              made++;
            } catch (err) {
              updateClip(orgId, r.id, { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
            }
          })
        );
      }
    } finally {
      jobs.delete(orgId);
      const failed = rows.length - made;
      await db.createChatMessage({
        organizationId: orgId,
        employeeId: emp.id,
        role: "employee",
        authorName: emp.name,
        content: made ? `${made} new ${made === 1 ? "clip is" : "clips are"} in your b-roll library${failed ? `, and ${failed} didn't finish (those used no work hours)` : ""}. I'll use them in every video after this one.` : "None of the clips finished, so they used no work hours. Try again in a few minutes.",
        cards: JSON.stringify([{ type: "choices", id: Date.now(), title: "", options: ["Open my b-roll", "Make a video with them"] }]),
      });
    }
  })();
  jobs.set(orgId, job);
  return rows;
}

// ==========================================
// Matching a scene to the library
// ==========================================

const STOP = new Set("a an the and or of in on at to with for from by is are into over under your our their this that its it as".split(" "));
const termsOf = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** The library clip that best fits what a scene shows, or null when none is close. */
export function bestClip(clips: BrollClip[], see: string, size: Size, skip: Set<number>) {
  const want = termsOf(see);
  if (!want.size) return null;
  let best: { c: BrollClip; score: number } | null = null;
  for (const c of clips) {
    if (skip.has(c.id) || c.status !== "ready" || !c.url) continue;
    const have = termsOf(`${c.title} ${c.tags}`);
    let hit = 0;
    want.forEach((w) => {
      if (have.has(w)) hit++;
    });
    const score = hit / want.size + (fitsOf(c)[0] === size ? 0.1 : 0) + (c.favorite ? 0.05 : 0);
    if (hit >= 2 && score >= 0.34 && (!best || score > best.score)) best = { c, score };
  }
  return best?.c ?? null;
}

// ==========================================
// Stock (Pexels)
// ==========================================

export type Stock = { url: string; page: string; thumb: string; credit: string; seconds: number; width: number; height: number };

/** One licensed stock clip for the words, in the shape of the video, or null (no key, no match, or Pexels is down). */
export async function stockFor(query: string, size: Size): Promise<Stock | null> {
  if (!ENV.pexelsKey || !query.trim()) return null;
  const orientation = size === "vertical" ? "portrait" : size === "wide" ? "landscape" : "square";
  const q = new URLSearchParams({ query: query.trim().slice(0, 100), orientation, size: "medium", per_page: "8" });
  const res = await fetch(`https://api.pexels.com/v1/videos/search?${q}`, { headers: { Authorization: ENV.pexelsKey }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { videos?: { url: string; image: string; duration: number; user?: { name?: string }; video_files?: { link: string; width: number | null; height: number | null; file_type: string; quality: string }[] }[] };
  const target = size === "wide" ? 1080 : 1920;
  for (const v of data.videos ?? []) {
    if ((v.duration ?? 0) < 3) continue;
    const files = (v.video_files ?? []).filter((f) => f.file_type === "video/mp4" && f.width && f.height && f.quality !== "hls");
    if (!files.length) continue;
    // The file closest to full HD on its long side, without going far over.
    const pick = files.sort((a, b) => Math.abs(Math.max(a.width!, a.height!) - target) - Math.abs(Math.max(b.width!, b.height!) - target))[0];
    return { url: pick.link, page: v.url, thumb: v.image, credit: v.user?.name ? `${v.user.name} on Pexels` : "Pexels", seconds: v.duration, width: pick.width!, height: pick.height! };
  }
  return null;
}

/** A stock clip kept with the video (only that video uses it), so Edit and redos don't fetch it again. */
export async function keepStock(orgId: number, videoId: number, s: Stock) {
  const buf = await download(s.url);
  return (await storagePut(`org-${orgId}/videos/stock-${videoId}.mp4`, buf, "video/mp4")).url;
}

// ==========================================
// Music
// ==========================================

export const TRACKS = {
  calm: { name: "Calm pulse", prompt: "Calm modern background music for a short business video: soft steady pulse, warm synth pads, light percussion, 90 BPM, hopeful, instrumental, no vocals." },
  upbeat: { name: "Upbeat", prompt: "Upbeat bright background music for a social media video: clean electric guitar, claps, bouncy bass, 118 BPM, positive, instrumental, no vocals." },
  piano: { name: "Warm piano", prompt: "Warm gentle solo piano with soft strings for a heartfelt story video, 76 BPM, intimate, instrumental, no vocals." },
} as const;
export type TrackKey = keyof typeof TRACKS;
export const TRACK_KEYS = Object.keys(TRACKS) as TrackKey[];

const making = new Map<TrackKey, Promise<string>>();
/** The built-in track as a file: made once with the music model and kept for every workspace. */
export async function trackFile(key: TrackKey): Promise<string> {
  const dir = path.join(uploadsRoot(), "..", "ld-music");
  const file = path.join(dir, `${key}.mp3`);
  if (fs.existsSync(file)) return file;
  if (!making.has(key)) {
    making.set(
      key,
      (async () => {
        if (!ENV.falKey) throw new Error("Music isn't set up on the server yet.");
        const drama = await import("./drama");
        const r = await drama.falRun(MUSIC_MODEL, { prompt: TRACKS[key].prompt, negative_prompt: "vocals, singing, speech, low quality" }, 5);
        const url = r?.audio?.url as string | undefined;
        if (!url) throw new Error("The music didn't come back.");
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ld-music-"));
        try {
          const wav = path.join(tmp, "in.wav");
          fs.writeFileSync(wav, await download(url));
          fs.mkdirSync(dir, { recursive: true });
          await run(drama.ffmpegPath(), ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libmp3lame", "-b:a", "160k", file], { timeout: 120_000 });
          return file;
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      })().finally(() => making.delete(key))
    );
  }
  return making.get(key)!;
}

/** A track someone uploaded for their videos. */
export async function saveMusic(orgId: number, file: string, name: string) {
  const p = await probe(file);
  if (!p.audio) throw new Error("Upload an MP3, M4A or WAV file.");
  const ff = (await import("./drama")).ffmpegPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-music-up-"));
  try {
    const out = path.join(dir, "track.mp3");
    await run(ff, ["-y", "-loglevel", "error", "-i", file, "-vn", "-t", "600", "-c:a", "libmp3lame", "-b:a", "160k", out], { timeout: 5 * 60_000 });
    const saved = await storagePut(`org-${orgId}/music/track.mp3`, fs.readFileSync(out), "audio/mpeg");
    return { url: saved.url, name: cleanName(name).slice(0, 60) || "My track" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
