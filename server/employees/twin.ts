import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import * as db from "../db";
import * as hours from "../workHours";
import { ENV } from "../_core/env";
import { transcribeFile } from "../_core/transcribe";
import { storagePut, storagePutStream, uploadsRoot } from "../storage";
import { twinLooks, twins, type Twin, type TwinLook } from "../../drizzle/schema";
import { withUsage } from "../usage";
import * as broll from "./broll";
import * as styles from "./styles";

/**
 * My twin: someone's own video and voice, so avatar videos look and sound like them.
 * 1. They upload (or record) about 2 minutes of themselves talking to the camera.
 * 2. They record one consent line. It is transcribed and checked: the words, and (when photos can be
 *    read here) that it's the same person as the video. Nothing is made until consent is in.
 * 3. Their voice is cloned from the video on the workspace's ElevenLabs account.
 * 4. Looks: the same person in other clothes (redrawn by fal.ai's Kling O1 video edit from a
 *    10-second piece) or another place (cut out with VEED's background removal and put over a
 *    picture, color, clip or drawn style). Only looks they save are used.
 * 5. Talking: the voice reads a script, and Sync Lipsync 2.0 Pro moves their real mouth to it over the look's video.
 */

const run = promisify(execFile);
const ff = async () => (await import("./drama")).ffmpegPath();
const LIPSYNC = "fal-ai/sync-lipsync/v2/pro";
const OUTFIT = "fal-ai/kling-video/o1/video-to-video/edit";
const CUTOUT = "veed/video-background-removal";
export const MAX_SECONDS = 5 * 60;
export const MIN_SECONDS = 30;

export function consentLine(name: string) {
  return `I'm ${name.trim() || "[your name]"}, and I agree to LeadDash making videos of me with my face and voice.`;
}

// ==========================================
// Rows
// ==========================================

export function list(orgId: number) {
  return db.getDb().select().from(twins).where(eq(twins.organizationId, orgId)).orderBy(desc(twins.id)).all();
}
export function get(orgId: number, id: number) {
  return db.getDb().select().from(twins).where(and(eq(twins.id, id), eq(twins.organizationId, orgId))).get() ?? null;
}
function must(orgId: number, id: number) {
  const t = get(orgId, id);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That twin is not in this workspace." });
  return t;
}
function update(orgId: number, id: number, data: Partial<typeof twins.$inferInsert>) {
  db.getDb().update(twins).set({ ...data, updatedAt: new Date() }).where(and(eq(twins.id, id), eq(twins.organizationId, orgId))).run();
  return get(orgId, id)!;
}
export function looks(orgId: number, twinId: number) {
  return db.getDb().select().from(twinLooks).where(and(eq(twinLooks.organizationId, orgId), eq(twinLooks.twinId, twinId))).orderBy(twinLooks.id).all();
}
export function getLook(orgId: number, id: number) {
  return db.getDb().select().from(twinLooks).where(and(eq(twinLooks.id, id), eq(twinLooks.organizationId, orgId))).get() ?? null;
}
function updateLook(orgId: number, id: number, data: Partial<typeof twinLooks.$inferInsert>) {
  db.getDb().update(twinLooks).set({ ...data, updatedAt: new Date() }).where(and(eq(twinLooks.id, id), eq(twinLooks.organizationId, orgId))).run();
  return getLook(orgId, id)!;
}
export function remove(orgId: number, id: number) {
  must(orgId, id);
  db.getDb().delete(twinLooks).where(and(eq(twinLooks.organizationId, orgId), eq(twinLooks.twinId, id))).run();
  db.getDb().delete(twins).where(and(eq(twins.id, id), eq(twins.organizationId, orgId))).run();
}
/** The name in the consent line; it can change only until consent is given. */
export function rename(orgId: number, id: number, name: string) {
  const t = must(orgId, id);
  if (t.consent === "ok" || t.consent === "checking") throw new TRPCError({ code: "BAD_REQUEST", message: "The name is in your consent line, so it can't change now. Make a new twin to use another name." });
  return update(orgId, id, { name: name.trim().slice(0, 80) || t.name });
}
/** A twin that may be used in videos: video in, consent checked. */
export const usable = (t: Twin | null | undefined): t is Twin => !!t && t.status === "ready" && t.consent === "ok" && !!t.sourceUrl;

const jobs = new Map<string, Promise<unknown>>();
export const jobFor = (key: string) => jobs.get(key) ?? null;
function background(key: string, fn: () => Promise<unknown>) {
  const p = fn()
    .catch((err) => console.error(`[twin] ${key}:`, err instanceof Error ? err.message : err))
    .finally(() => jobs.delete(key));
  jobs.set(key, p);
  return p;
}

async function chargeNow(orgId: number, job: hours.JobKey, count: number, label: string) {
  if (count <= 0) return;
  const emp = await db.getEmployeeByKind(orgId, "video");
  await withUsage({ orgId, employeeId: emp?.id ?? null, kind: "video" }, async () => {
    const minutes = await hours.charge(orgId, emp?.id ?? null, job, count, label);
    if (minutes > 0 && emp) await db.recordEmployeeTask(emp.id, orgId, minutes);
  });
}

// ==========================================
// 1. The video
// ==========================================

export function holdingPath(orgId: number, uploadId: string) {
  const dir = path.join(uploadsRoot(), "..", "ld-twin-uploads");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `org-${orgId}-${uploadId}.part`);
}

/** A twin video arrived: a new twin (or a new video for one), read in the background. */
export function startFromUpload(orgId: number, input: { file: string; name: string; by: string; twinId?: number | null }) {
  const row = input.twinId
    ? update(orgId, must(orgId, input.twinId).id, { status: "preparing", error: null })
    : db.getDb().insert(twins).values({ organizationId: orgId, name: input.name.trim().slice(0, 80) || "Me", status: "preparing", createdBy: input.by }).returning().get();
  void background(`twin-${row.id}`, () => prepare(orgId, row.id, input.file));
  return row;
}

async function prepare(orgId: number, id: number, raw: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-twin-"));
  try {
    const p = await broll.probe(raw);
    if (!p.video) throw new Error("Upload an MP4 or MOV video.");
    if (!p.audio) throw new Error("That video has no sound. Upload one of you talking.");
    if (p.seconds < MIN_SECONDS - 1) throw new Error(`The video needs at least ${MIN_SECONDS} seconds of you talking. This one is ${Math.round(p.seconds)}.`);
    if (p.seconds > MAX_SECONDS + 1) throw new Error("Videos can be up to 5 minutes.");
    const mp4 = path.join(dir, "twin.mp4");
    // At least 720 on the short side (the outfit model's minimum), at most 1080.
    await run(await ff(), ["-y", "-loglevel", "error", "-i", raw, "-vf", "scale='if(gt(iw,ih),-2,min(1080,max(720,iw)))':'if(gt(iw,ih),min(1080,max(720,ih)),-2)',fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", mp4], { maxBuffer: 20 * 1024 * 1024, timeout: 30 * 60_000 }).catch((e) => {
      throw new Error(`That video couldn't be read: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-1)[0].slice(0, 200)}`);
    });
    const thumb = path.join(dir, "thumb.jpg");
    await run(await ff(), ["-y", "-loglevel", "error", "-ss", "2", "-i", mp4, "-frames:v", "1", "-vf", "scale=360:-2", thumb], { timeout: 60_000 }).catch(() => null);
    const out = await broll.probe(mp4);
    const saved = await storagePutStream(`org-${orgId}/twin/twin.mp4`, fs.createReadStream(mp4), 3_000_000_000);
    const still = fs.existsSync(thumb) ? await storagePut(`org-${orgId}/twin/thumb.jpg`, fs.readFileSync(thumb), "image/jpeg") : null;
    const t = update(orgId, id, { sourceUrl: saved.url, thumbUrl: still?.url ?? null, tenths: Math.round(out.seconds * 10), status: "ready", error: null });
    // A new video needs its consent checked against it again.
    if (t.consentUrl) await checkConsent(orgId, id);
  } catch (err) {
    update(orgId, id, { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(raw, { force: true });
  }
}

// ==========================================
// 2. Consent
// ==========================================

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
/** How much of the consent line was said (share of its words heard, in order-free terms). */
export function consentScore(heard: string, line: string) {
  const want = norm(line);
  const got = new Set(norm(heard));
  return want.length ? want.filter((w) => got.has(w)).length / want.length : 0;
}

/** The consent recording arrived (a file already stored for this workspace). */
export function setConsent(orgId: number, id: number, url: string) {
  const t = must(orgId, id);
  if (!url.startsWith(`/files/org-${orgId}/`)) throw new TRPCError({ code: "BAD_REQUEST", message: "That file is not in this workspace." });
  update(orgId, t.id, { consentUrl: url, consent: "checking", consentNote: null });
  void background(`consent-${id}`, () => checkConsent(orgId, id));
  return get(orgId, id)!;
}

/** Same person in both videos, from a still of each (when photos can be read here). Null when it can't be checked. */
async function samePerson(a: Buffer, b: Buffer): Promise<boolean | null> {
  if (!ENV.anthropicKey || process.env.NODE_ENV === "test") return null;
  const { compareFaces } = await import("../_core/llm");
  return compareFaces(a, b);
}

async function stillOf(file: string, at: number, dir: string, name: string) {
  const out = path.join(dir, `${name}.jpg`);
  await run(await ff(), ["-y", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=512:-2", out], { timeout: 60_000 }).catch(() => null);
  return fs.existsSync(out) ? fs.readFileSync(out) : null;
}

export async function checkConsent(orgId: number, id: number) {
  const t = must(orgId, id);
  if (!t.consentUrl) return t;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-consent-"));
  try {
    update(orgId, id, { consent: "checking", consentNote: null });
    const file = broll.localFile(t.consentUrl);
    const audio = path.join(dir, "c.mp3");
    await run(await ff(), ["-y", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio], { timeout: 120_000 });
    const heard = (await transcribeFile(fs.readFileSync(audio), { timeoutMs: 5 * 60_000 })).text;
    const score = consentScore(heard, consentLine(t.name));
    if (score < 0.7) {
      return update(orgId, id, { consent: "failed", consentNote: `I heard: "${heard.slice(0, 200)}". Say the whole line as written, then upload it again.` });
    }
    if (t.sourceUrl) {
      const [a, b] = [await stillOf(broll.localFile(t.sourceUrl), 2, dir, "a"), await stillOf(file, 1, dir, "b")];
      const same = a && b ? await samePerson(a, b) : null;
      if (same === false) return update(orgId, id, { consent: "failed", consentNote: "The person saying the line doesn't look like the person in the video. Only the person in the video can give consent." });
    }
    const ok = update(orgId, id, { consent: "ok", consentNote: `Heard on ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` });
    if (!ok.voiceId) await makeVoice(orgId, id).catch((err) => update(orgId, id, { voiceNote: (err instanceof Error ? err.message : String(err)).slice(0, 300) }));
    return get(orgId, id)!;
  } catch (err) {
    return update(orgId, id, { consent: "failed", consentNote: `It couldn't be checked: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ==========================================
// 3. The voice
// ==========================================

/** The voice cloned from the twin's video, on the workspace's ElevenLabs account. */
export async function makeVoice(orgId: number, id: number) {
  const t = must(orgId, id);
  if (t.consent !== "ok") throw new TRPCError({ code: "BAD_REQUEST", message: "Record your consent line first." });
  if (!t.sourceUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload your video first." });
  const key = await (await import("../elevenlabs")).keyFor(orgId, "video");
  if (!key) {
    return update(orgId, id, { voiceNote: "Connect ElevenLabs under Integrations to make your voice. Until then, pick a voice for your twin." });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-voice-"));
  try {
    const audio = path.join(dir, "voice.mp3");
    await run(await ff(), ["-y", "-loglevel", "error", "-i", broll.localFile(t.sourceUrl), "-vn", "-t", "180", "-ac", "1", "-ar", "44100", "-b:a", "128k", audio], { timeout: 5 * 60_000 });
    const form = new FormData();
    form.append("name", `${t.name} (LeadDash twin)`.slice(0, 80));
    form.append("remove_background_noise", "true");
    form.append("files", new Blob([new Uint8Array(fs.readFileSync(audio))], { type: "audio/mpeg" }), "voice.mp3");
    const res = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(180_000) });
    const data = (await res.json().catch(() => ({}))) as { voice_id?: string; detail?: { message?: string } | string };
    if (!res.ok || !data.voice_id) {
      const why = typeof data.detail === "string" ? data.detail : data.detail?.message ?? `ElevenLabs said no (${res.status})`;
      return update(orgId, id, { voiceNote: `Your voice couldn't be made: ${why}`.slice(0, 300) });
    }
    return update(orgId, id, { voiceId: data.voice_id, voiceName: `${t.name}'s voice`, voiceNote: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Use another voice for the twin (before or instead of a cloned one). */
export async function pickVoice(orgId: number, id: number, voiceId: string) {
  must(orgId, id);
  const avatar = await import("./avatar");
  const v = (await avatar.voices(orgId)).find((x) => x.id === voiceId);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That voice isn't available in this workspace." });
  return update(orgId, id, { voiceId: v.id, voiceName: v.name });
}

// ==========================================
// 4. Looks
// ==========================================

export type Background = { type: "room" | "picture" | "color" | "clip" | "style"; color?: string | null; url?: string | null; clipId?: number | null; style?: string | null; place?: string | null; drawn?: string | null };
export const bgOf = (l: Pick<TwinLook, "background">): Background => {
  try {
    const b = JSON.parse(l.background) as Background;
    return b && b.type ? b : { type: "room" };
  } catch {
    return { type: "room" };
  }
};

/** Work minutes a look uses: a new outfit is one AI clip of 10 seconds; a new background on the whole video is green screen by the minute. */
export function lookMinutes(t: Pick<Twin, "tenths">, input: { outfit: string; background: Background }) {
  const outfit = input.outfit !== "keep";
  const clip = outfit ? broll.clipUnits(10) * hours.JOBS.clip.minutes : 0;
  const secs = outfit ? 10 : (t.tenths ?? 0) / 10;
  const bg = input.background.type !== "room" ? Math.max(1, Math.ceil(secs / 60)) * hours.JOBS.green.minutes : 0;
  return clip + bg;
}

export async function newLook(orgId: number, twinId: number, input: { name: string; outfit: "keep" | "describe" | "photo"; outfitText?: string | null; outfitPhoto?: string | null; background: Background }) {
  const t = must(orgId, twinId);
  if (!usable(t)) throw new TRPCError({ code: "BAD_REQUEST", message: "Finish your twin first: the video and your consent." });
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Looks aren't set up on the server yet. LeadDash support can turn them on." });
  if (input.outfit === "keep" && input.background.type === "room") throw new TRPCError({ code: "BAD_REQUEST", message: "Change the outfit or the background, or both." });
  if (input.outfit === "describe" && !input.outfitText?.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Describe the outfit." });
  if (input.outfit === "photo" && !input.outfitPhoto?.startsWith(`/files/org-${orgId}/`)) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload a photo of the outfit." });
  const b = input.background;
  if (b.type === "picture" && !b.url?.startsWith(`/files/org-${orgId}/`)) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload the picture to put behind you." });
  if (b.type === "color" && !/^#[0-9a-f]{6}$/i.test(b.color ?? "")) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a color." });
  if (b.type === "clip" && !b.clipId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a b-roll clip." });
  if (lookMinutes(t, input) > 0) await hours.gate(orgId);
  const row = db
    .getDb()
    .insert(twinLooks)
    .values({ organizationId: orgId, twinId, name: input.name.trim().slice(0, 60) || "New look", outfit: input.outfit, outfitText: input.outfitText?.trim().slice(0, 400) || null, outfitPhoto: input.outfitPhoto || null, background: JSON.stringify(b), status: "making" })
    .returning()
    .get();
  void background(`look-${row.id}`, () => makeLook(orgId, row.id));
  return row;
}

/** Try again: the same look made again. */
export async function retryLook(orgId: number, id: number) {
  const l = getLook(orgId, id);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That look is not in this workspace." });
  if (l.status === "making") return l;
  await hours.gate(orgId);
  updateLook(orgId, id, { status: "making", error: null });
  void background(`look-${id}`, () => makeLook(orgId, id));
  return getLook(orgId, id)!;
}
export function saveLook(orgId: number, id: number) {
  const l = getLook(orgId, id);
  if (!l || l.status !== "preview") throw new TRPCError({ code: "BAD_REQUEST", message: "That look isn't ready to save." });
  return updateLook(orgId, id, { status: "saved" });
}
export function removeLook(orgId: number, id: number) {
  const l = getLook(orgId, id);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That look is not in this workspace." });
  db.getDb().delete(twinLooks).where(and(eq(twinLooks.id, id), eq(twinLooks.organizationId, orgId))).run();
}

async function fetchTo(url: string, file: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok) throw new Error(`Couldn't download it (${res.status}).`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function makeLook(orgId: number, id: number) {
  const l = getLook(orgId, id)!;
  const t = must(orgId, l.twinId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-look-"));
  try {
    const drama = await import("./drama");
    const { falUpload } = await import("./editor");
    const src = broll.localFile(t.sourceUrl!);
    const secs = (t.tenths ?? 0) / 10;
    let base = src;
    // A new outfit: a 10-second piece from a third of the way in, redrawn.
    if (l.outfit !== "keep") {
      const piece = path.join(dir, "piece.mp4");
      const from = Math.max(0, Math.min(secs - 10, secs / 3));
      await run(await ff(), ["-y", "-loglevel", "error", "-ss", from.toFixed(2), "-i", src, "-t", "10", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", "30", piece], { timeout: 5 * 60_000 });
      const pieceUrl = await falUpload(piece, "video/mp4");
      const photo = l.outfit === "photo" && l.outfitPhoto ? [await falUpload(broll.localFile(l.outfitPhoto), "image/jpeg")] : [];
      const want = l.outfit === "photo" ? "the outfit in @Image1" : (l.outfitText ?? "").trim();
      const r = await drama.falRun(OUTFIT, { prompt: `Change only the person's clothes to ${want}. Keep the person's face, hair, skin, body, expressions, mouth, hand and head movements, the camera and the background exactly the same.`, video_url: pieceUrl, keep_audio: false, ...(photo.length ? { image_urls: photo } : {}) }, 30);
      const out = r?.video?.url as string | undefined;
      if (!out) throw new Error("The new outfit didn't come back.");
      base = await fetchTo(out, path.join(dir, "outfit.mp4"));
      await chargeNow(orgId, "clip", broll.clipUnits(10), `Twin look: ${l.name}`);
    }
    // A new place: cut out and put over the background.
    const b = bgOf(l);
    if (b.type !== "room") {
      const r = await drama.falRun(CUTOUT, { video_url: await falUpload(base, "video/mp4"), output_codec: "h264", refine_foreground_edges: true, subject_is_person: true }, 120);
      const files = ((r?.video ?? []) as { url: string }[]).map((f) => f.url).filter(Boolean);
      if (files.length < 2) throw new Error("The cutout didn't come back.");
      const a = await fetchTo(files[0], path.join(dir, "c0.mp4"));
      const c = await fetchTo(files[1], path.join(dir, "c1.mp4"));
      const { isMatte } = await import("./editor");
      const [rgb, matte] = (await isMatte(a)) ? [c, a] : [a, c];
      const p = await broll.probe(base);
      const W = Math.round((p.width || 1080) / 2) * 2;
      const H = Math.round((p.height || 1920) / 2) * 2;
      const len = p.seconds || 10;
      let bgArgs: string[];
      if (b.type === "color") bgArgs = ["-f", "lavfi", "-i", `color=c=${(b.color ?? "#1B6B4A").replace("#", "0x")}:s=${W}x${H}:r=30:d=${(len + 1).toFixed(2)}`];
      else if (b.type === "clip") {
        const clip = b.clipId ? broll.getClip(orgId, b.clipId) : null;
        if (!clip?.url) throw new Error("That b-roll clip is gone.");
        bgArgs = ["-stream_loop", "-1", "-i", broll.localFile(clip.url)];
      } else {
        let pic = b.url ?? null;
        if (b.type === "style") {
          const st = styles.resolve(orgId, b.style || "studio");
          pic = await styles.draw(orgId, { prompt: `${st.prompt || "Realistic photo"}. An empty background behind a person on camera: ${b.place?.trim() || "a bright modern office"}. No people. Soft depth of field. No text, letters, words, logos or watermarks anywhere.`, ratio: W > H ? "16:9" : "9:16", refs: st.refs, name: "twin-background" });
          updateLook(orgId, id, { background: JSON.stringify({ ...b, drawn: pic }) });
        }
        if (!pic) throw new Error("The background picture is missing.");
        bgArgs = ["-loop", "1", "-framerate", "30", "-t", (len + 1).toFixed(2), "-i", broll.localFile(pic)];
      }
      const out = path.join(dir, "placed.mp4");
      await run(await ff(), ["-y", "-loglevel", "error", "-i", rgb, "-i", matte, ...bgArgs, "-filter_complex", `[0:v]scale=${W}:${H},fps=30,format=yuv420p[c];[1:v]scale=${W}:${H},fps=30,format=gray[m];[c][m]alphamerge[cut];[2:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,format=yuv420p[bg];[bg][cut]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]`, "-map", "[v]", "-t", len.toFixed(2), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", out], { maxBuffer: 20 * 1024 * 1024, timeout: 60 * 60_000 });
      base = out;
      await chargeNow(orgId, "green", Math.max(1, Math.ceil(len / 60)), `Twin look: ${l.name}`);
    }
    const thumb = path.join(dir, "thumb.jpg");
    await run(await ff(), ["-y", "-loglevel", "error", "-ss", "1", "-i", base, "-frames:v", "1", "-vf", "scale=360:-2", thumb], { timeout: 60_000 }).catch(() => null);
    const saved = await storagePutStream(`org-${orgId}/twin/look.mp4`, fs.createReadStream(base), 3_000_000_000);
    const still = fs.existsSync(thumb) ? await storagePut(`org-${orgId}/twin/look.jpg`, fs.readFileSync(thumb), "image/jpeg") : null;
    updateLook(orgId, id, { baseUrl: saved.url, thumbUrl: still?.url ?? null, status: "preview", error: null });
  } catch (err) {
    updateLook(orgId, id, { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ==========================================
// 5. Talking
// ==========================================

/** The twin saying an audio file, in a saved look (or the original video). Returns a local MP4. */
export async function talk(orgId: number, twinId: number, lookId: number | null | undefined, audioFile: string, outFile: string) {
  const t = must(orgId, twinId);
  if (!usable(t)) throw new Error("Your twin isn't ready: finish the video and your consent first.");
  const look = lookId ? getLook(orgId, lookId) : null;
  if (lookId && (!look || look.status !== "saved" || !look.baseUrl)) throw new Error("That look isn't saved.");
  const base = broll.localFile(look?.baseUrl ?? t.sourceUrl!);
  const drama = await import("./drama");
  const { falUpload } = await import("./editor");
  // The base without its own sound, so only the new voice is heard.
  const silent = path.join(path.dirname(outFile), `base-${Date.now()}.mp4`);
  await run(await ff(), ["-y", "-loglevel", "error", "-i", base, "-an", "-c:v", "copy", silent], { timeout: 5 * 60_000 });
  const [video_url, audio_url] = [await falUpload(silent, "video/mp4"), await falUpload(audioFile, "audio/mpeg")];
  fs.rmSync(silent, { force: true });
  const r = await drama.falRun(LIPSYNC, { video_url, audio_url, sync_mode: "bounce" }, 30);
  const url = r?.video?.url as string | undefined;
  if (!url) throw new Error("Your twin's video didn't come back.");
  return fetchTo(url, outFile);
}

// ==========================================
// What the screen shows
// ==========================================

export function view(t: Twin) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    error: t.error,
    sourceUrl: t.sourceUrl,
    thumbUrl: t.thumbUrl,
    length: t.tenths ? `${Math.floor(t.tenths / 600)}:${String(Math.floor((t.tenths / 10) % 60)).padStart(2, "0")}` : null,
    updatedAt: t.updatedAt,
    consent: t.consent,
    consentNote: t.consentNote,
    consentLine: consentLine(t.name),
    consentUrl: t.consentUrl,
    voiceId: t.voiceId,
    voiceName: t.voiceName,
    voiceNote: t.voiceNote,
    usable: usable(t),
    step: t.status !== "ready" || !t.sourceUrl ? 1 : t.consent !== "ok" ? 2 : !t.voiceId ? 3 : 4,
    looks: looks(t.organizationId, t.id).map((l) => ({ id: l.id, name: l.name, status: l.status, error: l.error, baseUrl: l.baseUrl, thumbUrl: l.thumbUrl, outfit: l.outfit, outfitText: l.outfitText, background: bgOf(l) })),
  };
}
export type TwinView = ReturnType<typeof view>;
