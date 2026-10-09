import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { ENV } from "../_core/env";
import type { AIEmployee, AvatarVideo } from "../../drizzle/schema";

/**
 * Videos of the owner made by AI from her photo and her own voice (Elena).
 * 1. Elena writes the words; a draft holds the script, the photo and the voice.
 * 2. Make it: ElevenLabs reads the script in the owner's voice, then fal.ai's
 *    Kling talking-avatar model animates her photo to that audio. fal bills per
 *    second of video with no subscription.
 * 3. The finished MP4 is saved on this server (fal's links expire) and Elena
 *    posts it in the chat.
 * A monthly limit stops any video that would go over it.
 */

export type Quality = "standard" | "pro";
export type AvatarSettings = { imageId: number | null; voiceId: string | null; voiceName: string | null; quality: Quality; limitCents: number };

/** fal.ai's price per second of video, in cents. */
export const RATE_CENTS: Record<Quality, number> = { standard: 5.62, pro: 11.5 };
export const MODEL: Record<Quality, string> = {
  standard: "fal-ai/kling-video/ai-avatar/v2/standard",
  pro: "fal-ai/kling-video/ai-avatar/v2/pro",
};
const WORDS_PER_SECOND = 2.5;
const PROMPT = "A natural talking-head video. She speaks straight to the camera like she's talking to a colleague, with warm expressions, small natural head movements and the occasional hand gesture. Steady camera.";
const PROMPT_CAST = "A natural talking-to-camera video, the kind a real person films on their phone. They speak straight to the camera like they're talking to a friend, with real expressions, small natural head movements and the occasional hand gesture. Steady handheld camera.";

export function settingsOf(emp: Pick<AIEmployee, "studio">): AvatarSettings {
  let s: Partial<AvatarSettings> = {};
  try {
    s = emp.studio ? JSON.parse(emp.studio) : {};
  } catch {
    s = {};
  }
  return { imageId: s.imageId ?? null, voiceId: s.voiceId ?? null, voiceName: s.voiceName ?? null, quality: s.quality === "pro" ? "pro" : "standard", limitCents: Number.isFinite(s.limitCents) ? Number(s.limitCents) : 5000 };
}

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  return emp;
}

export async function saveSettings(orgId: number, input: Partial<AvatarSettings>) {
  const emp = await elena(orgId);
  const next = { ...settingsOf(emp), ...input };
  next.limitCents = Math.max(0, Math.min(1_000_000, Math.round(next.limitCents)));
  await db.updateEmployee(emp.id, orgId, { studio: JSON.stringify(next) });
  return next;
}

/** The owner's photos: every image in the Brain. */
export async function photos(orgId: number) {
  return (await db.listKnowledgeByOrg(orgId)).filter((k) => k.kind === "image" && k.fileUrl).map((k) => ({ id: k.id, title: k.title, url: k.fileUrl!, note: k.content || "" }));
}

/** The ElevenLabs voices on the account, the owner's own (cloned) voices first. */
export async function voices() {
  if (!ENV.elevenLabsKey || process.env.NODE_ENV === "test") return [] as { id: string; name: string; own: boolean }[];
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ENV.elevenLabsKey }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { voices?: { voice_id: string; name: string; category?: string }[] };
  const list = (data.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, own: ["cloned", "professional", "generated"].includes(v.category ?? "") }));
  return list.sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
}

export const estimateTenths = (script: string) => Math.max(30, Math.round((script.trim().split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND) * 10));
export const costFor = (tenths: number, quality: Quality) => Math.ceil((tenths / 10) * RATE_CENTS[quality]);

/** What videos made or being made this calendar month cost, in cents. */
export async function spentThisMonth(orgId: number) {
  const tz = (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
  const month = (d: Date) => d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit" });
  const now = month(new Date());
  return db
    .listAvatarVideos(orgId, 500)
    .filter((v) => (v.status === "ready" || v.status === "making") && month(new Date(v.madeAt ?? v.createdAt)) === now)
    .reduce((sum, v) => sum + v.costCents, 0);
}

/** Elena's script becomes a draft with the current photo and voice. */
/** Whether "who" means the owner herself. */
export const isOwner = (who?: string | null) => !who || /^(me|myself|the owner|owner|you|her|ashley)$/i.test(who.trim());

/**
 * A script to make. On camera: the owner (her photo and her cloned voice), or a made-up person
 * named or described in `who`, cast through Elena's own casting tools (a portrait and a stock voice).
 */
export async function draft(orgId: number, input: { title: string; script: string; who?: string | null }) {
  const emp = await elena(orgId);
  const s = settingsOf(emp);
  const script = input.script.trim().slice(0, 2400);
  const tenths = estimateTenths(script);
  const title = input.title.trim().slice(0, 120) || "Video";
  if (!isOwner(input.who)) {
    const cast = await (await import("./drama")).castFromDescription(orgId, input.who!);
    return db.createAvatarVideo({ organizationId: orgId, employeeId: emp.id, title, script, imageId: null, castId: cast.id, voiceId: cast.voiceId, voiceName: cast.voiceName, quality: s.quality, costCents: costFor(tenths, s.quality), tenths: null });
  }
  const pics = await photos(orgId);
  const imageId = s.imageId && pics.some((p) => p.id === s.imageId) ? s.imageId : pics[0]?.id ?? null;
  return db.createAvatarVideo({ organizationId: orgId, employeeId: emp.id, title, script, imageId, voiceId: s.voiceId, voiceName: s.voiceName, quality: s.quality, costCents: costFor(tenths, s.quality), tenths: null });
}

/** Who is on camera in a video: the owner, or the made-up person it was cast with. */
export function castOf(v: Pick<AvatarVideo, "organizationId" | "castId">) {
  return v.castId ? db.getDramaCast(v.castId, v.organizationId) : null;
}

export async function updateScript(orgId: number, id: number, input: { title?: string; script?: string }) {
  const v = db.getAvatarVideo(id, orgId);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes, then change the script." });
  const script = (input.script ?? v.script).trim().slice(0, 2400);
  return db.updateAvatarVideo(id, orgId, { title: (input.title ?? v.title).trim().slice(0, 120) || v.title, script, costCents: costFor(estimateTenths(script), v.quality as Quality), ...(v.status === "failed" ? { status: "draft", error: null } : {}) })!;
}

function dataUri(buf: Buffer, mime: string) {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function mimeOf(url: string) {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

async function readStored(fileUrl: string) {
  const { uploadsRoot } = await import("../storage");
  const fs = await import("node:fs");
  const path = await import("node:path");
  return fs.promises.readFile(path.join(uploadsRoot(), fileUrl.replace(/^\/files\//, "")));
}

async function tts(voiceId: string, text: string) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ENV.elevenLabsKey, "content-type": "application/json", accept: "audio/mpeg" },
    // The multilingual model sounds most like a cloned voice.
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_AVATAR_MODEL || "eleven_multilingual_v2" }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = j?.detail?.message ?? (typeof j?.detail === "string" ? j.detail : body);
    } catch {
      /* not JSON */
    }
    throw new Error(`ElevenLabs didn't make your voice (${res.status}): ${msg}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fal(url: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Key ${ENV.falKey}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok && res.status !== 202) {
    const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((d: any) => d.msg ?? JSON.stringify(d)).join("; ") : data.raw ?? text.slice(0, 300);
    throw new Error(`fal.ai said no (${res.status}): ${detail}`);
  }
  return data;
}

/** Starts making a video. Checks the limit first; the voice is made here and the video on fal.ai. */
export async function make(orgId: number, id: number): Promise<AvatarVideo> {
  const v = db.getAvatarVideo(id, orgId);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  if (v.status === "making") return v;
  if (v.status === "ready") return again(orgId, id);
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making videos isn't connected yet: FAL_KEY is missing on the server." });
  if (!ENV.elevenLabsKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your voice isn't connected yet: ELEVENLABS_API_KEY is missing on the server." });
  const emp = await elena(orgId);
  const s = settingsOf(emp);
  const cast = castOf(v);
  let photo: { id: number | null; url: string } | undefined;
  let voiceId = v.voiceId ?? (cast ? cast.voiceId : s.voiceId);
  let voiceName = v.voiceName ?? (cast ? cast.voiceName : s.voiceName);
  if (cast) {
    // A made-up person: their portrait (made once from their description) and a stock voice.
    const drama = await import("./drama");
    photo = { id: null, url: await drama.portraitFor(orgId, cast, "") };
    if (!voiceId) {
      const stock = (await voices()).find((x) => !x.own);
      if (!stock) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `No stock voice is available for ${cast.name}.` });
      voiceId = stock.id;
      voiceName = stock.name;
      db.updateDramaCast(cast.id, orgId, { voiceId, voiceName });
    }
  } else {
    const pics = await photos(orgId);
    photo = pics.find((p) => p.id === v.imageId) ?? pics.find((p) => p.id === s.imageId) ?? pics[0];
    if (!photo) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add a photo of yourself to the Brain (or attach one in Elena's chat) first." });
    if (!voiceId) {
      const own = (await voices()).find((x) => x.own);
      if (!own) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Pick your voice under Your avatar on Elena's Videos tab first." });
      voiceId = own.id;
      voiceName = own.name;
    }
  }
  const quality = (v.quality as Quality) ?? s.quality;
  const estimate = costFor(estimateTenths(v.script), quality);
  const spent = await spentThisMonth(orgId);
  if (spent + estimate > s.limitCents) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `This one (about $${(estimate / 100).toFixed(2)}) would go over your $${(s.limitCents / 100).toFixed(0)} monthly limit. You've spent $${(spent / 100).toFixed(2)} this month. Raise the limit under Your avatar.` });
  }
  db.updateAvatarVideo(id, orgId, { status: "making", error: null, imageId: photo.id, voiceId, voiceName, quality, costCents: estimate, madeAt: new Date() });
  try {
    const audio = await tts(voiceId, v.script);
    // MP3 at 128 kbps: the length of the audio is the length of the video, and what fal bills.
    const tenths = Math.max(10, Math.round((audio.length * 8) / 128_000 * 10));
    const image = await readStored(photo.url);
    const sub = await fal(`https://queue.fal.run/${MODEL[quality]}`, { method: "POST", body: { image_url: dataUri(image, mimeOf(photo.url)), audio_url: dataUri(audio, "audio/mpeg"), prompt: cast ? PROMPT_CAST : PROMPT } });
    if (!sub.request_id) throw new Error("fal.ai didn't start the video.");
    const job = JSON.stringify({ id: sub.request_id, status: sub.status_url, result: sub.response_url });
    const out = db.updateAvatarVideo(id, orgId, { requestId: job, tenths, costCents: costFor(tenths, quality) })!;
    watch(orgId, id);
    return out;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    db.updateAvatarVideo(id, orgId, { status: "failed", error: msg, costCents: estimate });
    throw new TRPCError({ code: "BAD_GATEWAY", message: msg });
  }
}

/** Make again: a fresh copy of the script, made with the current photo and voice. */
export async function again(orgId: number, id: number): Promise<AvatarVideo> {
  const v = db.getAvatarVideo(id, orgId);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  const cast = castOf(v);
  const copy = await draft(orgId, { title: v.title, script: v.script, who: cast ? cast.name : null });
  return make(orgId, copy.id);
}

const watching = new Set<number>();

/** Checks a video every 15 seconds until fal.ai is done (the scheduler also checks every minute). */
function watch(orgId: number, id: number) {
  if (watching.has(id) || process.env.NODE_ENV === "test") return;
  watching.add(id);
  const loop = async (n: number) => {
    const v = db.getAvatarVideo(id, orgId);
    if (!v || v.status !== "making" || n > 160) {
      watching.delete(id);
      return;
    }
    await check(v).catch(() => null);
    setTimeout(() => void loop(n + 1), 15_000).unref();
  };
  setTimeout(() => void loop(0), 15_000).unref();
}

/** One look at a video being made: saves it and tells the owner when it's done. */
export async function check(v: AvatarVideo) {
  if (v.status !== "making" || !v.requestId) return v;
  let job: { id: string; status: string; result: string };
  try {
    job = JSON.parse(v.requestId);
  } catch {
    return v;
  }
  const st = await fal(job.status);
  if (st.status === "IN_QUEUE" || st.status === "IN_PROGRESS") {
    // Give up after an hour so a stuck job doesn't sit forever.
    if (v.madeAt && Date.now() - new Date(v.madeAt).getTime() > 60 * 60_000) return finish(v, null, "fal.ai took more than an hour. Press Try again.");
    return v;
  }
  let result: any;
  try {
    result = await fal(job.result);
  } catch (err) {
    return finish(v, null, err instanceof Error ? err.message : String(err));
  }
  const url = result?.video?.url as string | undefined;
  if (!url) return finish(v, null, "fal.ai finished without a video. Press Try again.");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) return finish(v, null, `Couldn't download the finished video (${res.status}).`);
  const { storagePut } = await import("../storage");
  const saved = await storagePut(`org-${v.organizationId}/videos/avatar-${v.id}.mp4`, Buffer.from(await res.arrayBuffer()), "video/mp4");
  return finish(v, saved.url, null);
}

async function finish(v: AvatarVideo, videoUrl: string | null, error: string | null) {
  const done = db.updateAvatarVideo(v.id, v.organizationId, videoUrl ? { status: "ready", videoUrl, error: null } : { status: "failed", error: error?.slice(0, 400) ?? "Something went wrong.", costCents: 0 })!;
  const emp = await db.getEmployeeForOrg(v.employeeId, v.organizationId);
  if (emp) {
    const content = videoUrl
      ? `Your video "${done.title}" is ready. It came out at ${fmtLength(done.tenths)} and cost $${(done.costCents / 100).toFixed(2)}. It's saved on my Videos tab.`
      : `"${done.title}" didn't finish: ${done.error} You weren't charged for it.`;
    await db.createChatMessage({
      organizationId: v.organizationId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content,
      cards: JSON.stringify([{ type: "avatar_video", id: done.id, title: done.title }, { type: "choices", id: Date.now(), title: "", options: videoUrl ? ["Make a shorter one", "Write 3 more scripts", "Use a different photo"] : ["Try again"] }]),
    });
  }
  return done;
}

export function fmtLength(tenths: number | null | undefined) {
  if (!tenths) return "";
  const s = Math.round(tenths / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The scheduler's minute check, so videos still finish after a restart. */
export async function avatarTicks() {
  for (const v of db.listMakingAvatarVideos()) await check(v).catch((err) => console.warn("[avatar] check failed:", err instanceof Error ? err.message : err));
}

/** What a card or row shows. */
export function view(v: AvatarVideo, photoTitle?: string) {
  const cast = castOf(v);
  return {
    id: v.id,
    title: v.title,
    script: v.script,
    status: v.status,
    length: fmtLength(v.tenths ?? (v.status === "ready" ? null : estimateTenths(v.script))),
    cost: `${v.status === "ready" || v.status === "failed" ? "" : "about "}$${(v.costCents / 100).toFixed(2)}`,
    quality: v.quality,
    voiceName: v.voiceName,
    /** Who is on camera: the owner (null) or a made-up person from the cast. */
    who: cast ? { id: cast.id, name: cast.name, look: cast.look, photoUrl: cast.photoUrl } : null,
    photoTitle: cast ? `${cast.name} (made up)` : photoTitle ?? null,
    imageId: v.imageId,
    videoUrl: v.videoUrl,
    error: v.error,
    madeAt: v.madeAt,
    createdAt: v.createdAt,
  };
}
