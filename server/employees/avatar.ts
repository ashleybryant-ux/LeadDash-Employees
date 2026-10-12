import { TRPCError } from "@trpc/server";
import * as hours from "../workHours";
import * as db from "../db";
import { ENV } from "../_core/env";
import type { AIEmployee, AvatarVideo } from "../../drizzle/schema";

/**
 * Videos of the owner made by AI from her photo and her own voice (Elena).
 * 1. Elena writes the words; a draft holds the script, the photo and the voice.
 * 2. Make it: the voice reads the script (ElevenLabs for LeadDash's own workspaces and
 *    workspaces that connected their own ElevenLabs account for videos, else a standard voice), then fal.ai's
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
const PROMPT = "A natural talking-head video. The person speaks straight to the camera like they're talking to a colleague, with warm expressions, small natural head movements and the occasional hand gesture. Steady camera.";
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

export type VideoVoice = { id: string; name: string; own: boolean; standard: boolean };

/** Standard voices are saved with this in front of their id, so a video knows which service reads it. */
export const STANDARD = "openai:";
export const isStandard = (voiceId: string | null | undefined) => !!voiceId && voiceId.startsWith(STANDARD);

/** The standard voices every workspace can use, with no account of its own. */
export async function standardVoices() {
  const { OPENAI_VOICES } = await import("./huddle");
  return OPENAI_VOICES.map((v) => ({ id: `${STANDARD}${v.id}`, name: v.name, note: v.note }));
}

/** This workspace's ElevenLabs key: LeadDash's own workspaces use the server's account, others only their own. */
const elevenKey = (orgId: number) => import("../elevenlabs").then((m) => m.keyFor(orgId, "video"));

/**
 * The voices for this workspace's videos: its ElevenLabs account's voices (the owner's own cloned
 * voices first) when it has one, then the standard voices.
 */
export async function voices(orgId: number): Promise<VideoVoice[]> {
  const standard = (await standardVoices()).map((v) => ({ id: v.id, name: v.name, own: false, standard: true }));
  const key = await elevenKey(orgId);
  if (!key || process.env.NODE_ENV === "test") return standard;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return standard;
  const data = (await res.json()) as { voices?: { voice_id: string; name: string; category?: string }[] };
  const list = (data.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, own: ["cloned", "professional", "generated"].includes(v.category ?? ""), standard: false }));
  return [...list.sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name)), ...standard];
}

/** Whether this workspace has its own voices (LeadDash's account, or its own connected ElevenLabs). */
export async function hasElevenLabs(orgId: number) {
  return !!(await elevenKey(orgId));
}

/**
 * The script read aloud, as MP3: a standard voice, or an ElevenLabs voice on this workspace's
 * own account. A workspace never uses LeadDash's ElevenLabs account unless it is LeadDash's own.
 */
export async function speech(orgId: number, voiceId: string, text: string): Promise<Buffer> {
  if (isStandard(voiceId)) {
    const huddle = await import("./huddle");
    const buf = await huddle.openAiAudio({ voice: voiceId.slice(STANDARD.length) }, text, "Speak straight to the camera like a real person talking to a friend: natural pace, warm, conversational, never robotic.");
    if (!buf) throw new Error(huddle.lastSpeechError() ?? "The voice didn't come back.");
    return buf;
  }
  const key = await elevenKey(orgId);
  if (!key) throw new Error("That voice is from ElevenLabs, which isn't connected in this workspace. Connect it under Integrations, or pick a standard voice.");
  return tts(key, voiceId, text);
}

/** How long an MP3 plays, in tenths of a second, from its frames (128 kbps if it can't be read). */
export function mp3Tenths(buf: Buffer) {
  const KBPS = [
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ];
  const RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
  let i = 0;
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") i = 10 + ((buf[6] & 0x7f) << 21) + ((buf[7] & 0x7f) << 14) + ((buf[8] & 0x7f) << 7) + (buf[9] & 0x7f);
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const ver = (buf[i + 1] >> 3) & 3; // 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
    const bIdx = buf[i + 2] >> 4;
    const rIdx = (buf[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bIdx === 0 || bIdx === 15 || rIdx === 3) {
      i++;
      continue;
    }
    const v1 = ver === 3;
    const rate = RATES[v1 ? 0 : ver === 2 ? 1 : 2][rIdx];
    const kbps = KBPS[v1 ? 0 : 1][bIdx];
    const pad = (buf[i + 2] >> 1) & 1;
    const len = Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + pad;
    if (len < 4) break;
    seconds += (v1 ? 1152 : 576) / rate;
    frames++;
    i += len;
  }
  return frames > 10 ? Math.max(10, Math.round(seconds * 10)) : Math.max(10, Math.round(((buf.length * 8) / 128_000) * 10));
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

/** Whether "who" means the owner: no one named, a word for them, or their own name (the workspace's signer). */
export const isOwner = (who?: string | null, ownerName?: string | null) => {
  if (!who) return true;
  const w = who.trim().toLowerCase();
  if (/^(me|myself|the owner|owner|you|her|him|them)$/.test(w)) return true;
  const name = (ownerName ?? "").trim().toLowerCase();
  return !!name && (w === name || w === name.split(/\s+/)[0]);
};

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
  if (!isOwner(input.who, (await db.getOrganizationById(orgId))?.signerName)) {
    const drama = await import("./drama");
    const cast = await drama.castFromDescription(orgId, input.who!);
    // Their portrait is made now, so the card shows who is on camera before anything is animated.
    if (!cast.photoUrl && ENV.falKey) await drama.portraitFor(orgId, cast, "").catch((err) => console.warn(`[avatar] portrait for ${cast.name}:`, err instanceof Error ? err.message : err));
    return db.createAvatarVideo({ organizationId: orgId, employeeId: emp.id, title, script, imageId: null, castId: cast.id, voiceId: cast.voiceId, voiceName: cast.voiceName, quality: s.quality, costCents: costFor(tenths, s.quality), tenths: null });
  }
  const pics = await photos(orgId);
  const imageId = s.imageId && pics.some((p) => p.id === s.imageId) ? s.imageId : pics[0]?.id ?? null;
  return db.createAvatarVideo({ organizationId: orgId, employeeId: emp.id, title, script, imageId, voiceId: s.voiceId, voiceName: s.voiceName, quality: s.quality, costCents: costFor(tenths, s.quality), tenths: null });
}

/** A different portrait for the made-up person on camera (their description stays). */
export async function newLook(orgId: number, id: number) {
  const v = db.getAvatarVideo(id, orgId);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  const cast = castOf(v);
  if (!cast) throw new TRPCError({ code: "BAD_REQUEST", message: "This video is of you; change your photo under Your avatar." });
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
  db.updateDramaCast(cast.id, orgId, { photoUrl: null });
  await (await import("./drama")).portraitFor(orgId, { ...cast, photoUrl: null }, "");
  return v;
}

/**
 * The voices a made-up person can use, with a sample to play: the stock voices on this workspace's
 * ElevenLabs account (never anyone's own cloned voice), then the standard voices.
 */
export async function castVoices(orgId: number) {
  const standard = (await standardVoices()).map((v) => ({ id: v.id, name: v.name, gender: "", accent: "", description: v.note, previewUrl: null as string | null, standard: true }));
  const key = await elevenKey(orgId);
  if (!key) return standard;
  try {
    const stock = (await (await import("./huddle")).listVoices(key)).filter((v) => !v.own).map((v) => ({ id: v.id, name: v.name, gender: v.gender, accent: v.accent, description: v.description, previewUrl: v.previewUrl, standard: false }));
    return [...stock, ...standard];
  } catch {
    return standard;
  }
}

/** A different voice for the made-up person on camera: the cast member keeps it for every video they are in. */
export async function setCastVoice(orgId: number, id: number, voiceId: string) {
  const v = db.getAvatarVideo(id, orgId);
  if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  const cast = castOf(v);
  if (!cast) throw new TRPCError({ code: "BAD_REQUEST", message: "This video is in your own voice; change it under Your avatar." });
  if (v.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
  const voice = (await castVoices(orgId)).find((x) => x.id === voiceId);
  if (!voice) throw new TRPCError({ code: "NOT_FOUND", message: "That voice isn't available in this workspace." });
  db.updateDramaCast(cast.id, orgId, { voiceId: voice.id, voiceName: voice.name });
  return db.updateAvatarVideo(id, orgId, { voiceId: voice.id, voiceName: voice.name })!;
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

async function tts(key: string, voiceId: string, text: string) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
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
      const stock = (await voices(orgId)).find((x) => !x.own);
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
      const own = (await voices(orgId)).find((x) => x.own);
      if (!own) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Pick your voice under Your avatar on Elena's Videos tab first." });
      voiceId = own.id;
      voiceName = own.name;
    }
  }
  if (!isStandard(voiceId) && !(await hasElevenLabs(orgId))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${voiceName ?? "That voice"} is from ElevenLabs, which isn't connected in this workspace. Pick a standard voice${cast ? ` for ${cast.name}` : " under Your avatar"}, or connect ElevenLabs under Integrations.` });
  if (isStandard(voiceId) && !ENV.openAiKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Standard voices aren't set up on the server yet." });
  const quality = (v.quality as Quality) ?? s.quality;
  const estimate = costFor(estimateTenths(v.script), quality);
  const metered = hours.meteredSync(orgId);
  if (metered) await hours.gate(orgId);
  const spent = metered ? 0 : await spentThisMonth(orgId);
  if (!metered && spent + estimate > s.limitCents) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `This one (about $${(estimate / 100).toFixed(2)}) would go over your $${(s.limitCents / 100).toFixed(0)} monthly limit. You've spent $${(spent / 100).toFixed(2)} this month. Raise the limit under Your avatar.` });
  }
  db.updateAvatarVideo(id, orgId, { status: "making", error: null, imageId: photo.id, voiceId, voiceName, quality, costCents: estimate, madeAt: new Date() });
  try {
    const audio = await speech(orgId, voiceId, v.script);
    // The length of the audio is the length of the video, and what fal bills.
    const tenths = mp3Tenths(audio);
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
  const metered = hours.meteredSync(v.organizationId);
  const minutes = hours.videoMinutes(done.tenths, done.quality);
  if (videoUrl) await hours.charge(v.organizationId, emp?.id ?? null, "video", minutes / hours.JOBS.video.minutes, done.title).catch(() => 0);
  else await hours.skipped(v.organizationId, emp?.id ?? null, "video", minutes / hours.JOBS.video.minutes, done.title).catch(() => null);
  if (emp) {
    const content = videoUrl
      ? `Your video "${done.title}" is ready. It came out at ${fmtLength(done.tenths)} and ${metered ? `used ${hours.hoursText(minutes)} of work` : `cost $${(done.costCents / 100).toFixed(2)}`}. It's saved on my Videos tab.`
      : `"${done.title}" didn't finish: ${done.error} ${metered ? "It used no work hours." : "You weren't charged for it."}`;
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
    cost: hours.meteredSync(v.organizationId)
      ? v.status === "failed"
        ? "Not charged"
        : `${v.status === "ready" ? "" : "about "}${hours.hoursText(hours.videoMinutes(v.tenths ?? estimateTenths(v.script), v.quality))}`
      : `${v.status === "ready" || v.status === "failed" ? "" : "about "}$${(v.costCents / 100).toFixed(2)}`,
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
