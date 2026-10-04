import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import { storagePut, uploadsRoot } from "../storage";
import type { DramaCastMember, DramaEpisode } from "../../drizzle/schema";
import * as avatar from "./avatar";

/**
 * Elena's mini drama studio: cinematic vertical micro dramas, not a talking photo.
 *
 * 1. Write: Elena writes the season. Each episode is a hook, a turn, a spike and
 *    a cliffhanger, broken into 10 to 16 shots with framing, camera movement,
 *    action and at most one short line each.
 * 2. Make, shot by shot:
 *    - a film still for the shot, matched to each character's portrait (the
 *      owner's own photo for her),
 *    - Kling 3.0 animates it with the camera move (native sound for shots with
 *      no lines),
 *    - a spoken line is read in that character's ElevenLabs voice (the owner's
 *      own voice for her) and lip-synced onto the clip,
 * 3. The shots are cut together into one 9:16 episode and posted in chat.
 *
 * Every step is paid per use on fal.ai and ElevenLabs. Shots already made are
 * kept, so Make again (or a restart) picks up where it stopped.
 */

const run = promisify(execFile);

export const MODELS = {
  still: "fal-ai/nano-banana-pro/edit",
  portrait: "fal-ai/nano-banana-pro",
  video: "fal-ai/kling-video/v3/pro/image-to-video",
  lipsync: "fal-ai/sync-lipsync/v2",
};

/** Cents, from fal.ai's price pages (October 2026). */
export const PRICE = { still: 15, portrait: 15, videoSilentPerSec: 11.2, videoSoundPerSec: 16.8, lipsyncPerSec: 5 };

export type Shot = {
  n: number;
  framing: string;
  move: string;
  action: string;
  setting: string;
  cast: string[];
  line: { who: string; text: string } | null;
  seconds: number;
  stillUrl?: string | null;
  clipUrl?: string | null;
  status?: "todo" | "making" | "done" | "failed";
  error?: string | null;
  costCents?: number;
};
export type Beat = { label: string; at: string; text: string };

/**
 * How Elena shoots. Cinematic vertical micro drama: a story told in shots, the
 * way short-form drama studios do it, never one person talking at the camera.
 */
export const STYLE = `How you make a micro drama (cinematic, vertical 9:16, built for TikTok and Reels):
- Story: open in the middle of a conflict, never on an introduction. The first 2 seconds are the hook: a reveal, a confrontation or something that shouldn't be there. Raise the stakes every 10 to 15 seconds. End on a cliffhanger: a reveal, a threat or a line that changes everything, then cut to black.
- Shots: 10 to 16 shots for a 60 to 90 second episode, each 3 to 7 seconds. Mix them like a film: an establishing wide of the place (2 to 3 seconds), medium two-shots, over-the-shoulder shots for conversations, close-ups for emotion, extreme close-up inserts (hands, a phone screen, a file, a door handle), and reaction shots. Never more than one line in a shot, and never two talking close-ups of the same person in a row.
- Camera: every shot moves with purpose. Slow push-in on a reveal, handheld for tension, a dolly or tracking shot when someone walks, a rack focus to land a look. Name the move.
- Light and color: a real film look, shallow depth of field, motivated light (windows, desk lamps, monitors), one consistent color grade for the series, 35mm or anamorphic lens feel, light film grain. Night scenes are moody, not dark.
- Dialogue: short lines, 12 words at most, with subtext. Let silence and looks carry beats. Reactions matter as much as lines.
- Continuity: the same wardrobe, hair and room for a character within an episode. Describe the setting the same way each time it returns.
- Never: real clients or client stories, real patient details, real people other than the owner, brand logos, on-screen text, captions or watermarks in the picture.`;

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const shotsOf = (e: Pick<DramaEpisode, "shots">) => parse<Shot[]>(e.shots, []);
export const beatsOf = (e: Pick<DramaEpisode, "beats">) => parse<Beat[]>(e.beats, []);

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  return emp;
}

// ==========================================
// Estimates and the monthly limit
// ==========================================

export function estimateShot(s: Pick<Shot, "seconds" | "line">) {
  const secs = Math.max(3, Math.min(10, Math.round(s.seconds || 5)));
  return Math.ceil(PRICE.still + secs * (s.line ? PRICE.videoSilentPerSec + PRICE.lipsyncPerSec : PRICE.videoSoundPerSec));
}
export function estimateEpisode(shots: Shot[]) {
  return shots.reduce((sum, s) => sum + (s.clipUrl ? 0 : estimateShot(s)), 0);
}

export async function spentThisMonth(orgId: number) {
  const tz = (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
  const month = (d: Date) => d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit" });
  const now = month(new Date());
  const drama = db.listDramaEpisodes(orgId).filter((e) => e.madeAt && month(new Date(e.madeAt)) === now).reduce((s, e) => s + e.costCents, 0);
  return drama + (await avatar.spentThisMonth(orgId));
}

// ==========================================
// Writing the season
// ==========================================

const SEASON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "premise", "look", "cast", "episodes"],
  properties: {
    title: { type: "string" },
    premise: { type: "string", description: "Two sentences: the world and the season's question" },
    look: { type: "string", description: "The series' visual look in one sentence: setting, light, color grade, lens" },
    cast: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "owner", "look", "voice"],
        properties: {
          name: { type: "string" },
          role: { type: "string", description: "Their part in the story, a few words" },
          owner: { type: "boolean", description: "True only for the character the owner plays herself" },
          look: { type: "string", description: "Age, build, hair, skin tone, wardrobe; for the owner, wardrobe only" },
          voice: { type: "string", description: "The name of the voice from the voice list that fits, or ''" },
        },
      },
    },
    episodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "logline", "beats", "shots"],
        properties: {
          title: { type: "string" },
          logline: { type: "string", description: "One sentence that makes someone want to watch" },
          beats: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "at", "text"], properties: { label: { type: "string", enum: ["Hook", "Turn", "Spike", "Cliffhanger"] }, at: { type: "string", description: "Like 0:00" }, text: { type: "string" } } } },
          shots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["framing", "move", "action", "setting", "cast", "line_who", "line_text", "seconds"],
              properties: {
                framing: { type: "string", enum: ["Wide", "Medium", "Two-shot", "Over the shoulder", "Close-up", "Extreme close-up", "Insert", "Reaction"] },
                move: { type: "string", description: "The camera move: slow push-in, handheld, dolly left, static, rack focus..." },
                action: { type: "string", description: "What we see, in one or two sentences, with expressions and body language" },
                setting: { type: "string", description: "The room or place, described the same way every time it returns" },
                cast: { type: "array", items: { type: "string" }, description: "Names of the characters on screen" },
                line_who: { type: "string", description: "Who speaks in this shot, or ''" },
                line_text: { type: "string", description: "The one line spoken, 12 words at most, or ''" },
                seconds: { type: "integer", description: "3 to 7" },
              },
            },
          },
        },
      },
    },
  },
};

type Written = { title: string; premise: string; look: string; cast: { name: string; role: string; owner: boolean; look: string; voice: string }[]; episodes: { title: string; logline: string; beats: Beat[]; shots: { framing: string; move: string; action: string; setting: string; cast: string[]; line_who: string; line_text: string; seconds: number }[] }[] };

/** Writes episodes (and the series and cast the first time). New episodes continue from the last one. */
export async function writeEpisodes(orgId: number, input: { brief: string; count: number; ownerName: string }) {
  const emp = await elena(orgId);
  const series = db.getDramaSeries(orgId);
  const cast = db.listDramaCast(orgId);
  const eps = db.listDramaEpisodes(orgId);
  const voiceList = await avatar.voices();
  const count = Math.max(1, Math.min(10, input.count || 3));
  const sys = await (await import("./tasks")).systemPromptAbout(emp, input.brief, `You are ${emp.name}, the owner's video producer and showrunner. You write cinematic micro dramas.\n${STYLE}`);
  const out = await generateJson<Written>({
    system: sys.system,
    prompt: `${series ? `The series: ${series.title}. ${series.premise}\nLook: ${series.look}\nCast:\n${cast.map((c) => `- ${c.name} (${c.kind === "owner" ? "played by the owner" : "made up"}): ${c.role}. ${c.look}`).join("\n")}\nEpisodes so far:\n${eps.map((e) => `${e.number}. ${e.title}: ${e.logline}`).join("\n") || "none"}\nKeep the same title, premise, look and cast (add a character only if the story needs one).` : `This is a new series. The owner plays one character herself (${input.ownerName}): mark that character owner. Make up the rest of the cast (2 to 4 characters), all fictional.`}
What the owner asked for: ${input.brief || "the next episodes"}
Write ${count} new episode${count === 1 ? "" : "s"}${eps.length ? `, starting at episode ${eps.length + 1}` : ""}, each 60 to 90 seconds. Each one works on its own and ends on a cliffhanger that leads into the next.
Voices you can cast (ElevenLabs): ${voiceList.filter((v) => !v.own).map((v) => v.name).slice(0, 60).join(", ") || "none listed; leave voice ''"}. The owner's character always uses her own voice: leave voice '' for her.`,
    schemaName: "drama_season",
    schema: SEASON_SCHEMA,
    maxTokens: 12000,
    timeoutMs: 240_000,
  });
  const s = db.saveDramaSeries(orgId, series ? {} : { title: out.title.slice(0, 120), premise: out.premise.slice(0, 1000), look: out.look.slice(0, 500) });
  // Cast: keep existing characters; add new ones.
  const ownerPhoto = await ownerPortrait(orgId);
  const ownerVoice = avatar.settingsOf(emp);
  for (const c of out.cast ?? []) {
    const name = c.name.trim().slice(0, 80);
    if (!name || db.listDramaCast(orgId).some((x) => x.name.toLowerCase() === name.toLowerCase() || (c.owner && x.kind === "owner"))) continue;
    const v = voiceList.find((x) => x.name.toLowerCase() === (c.voice || "").toLowerCase());
    db.createDramaCast({ organizationId: orgId, name, role: c.role.slice(0, 120), kind: c.owner ? "owner" : "made_up", look: c.look.slice(0, 500), photoUrl: c.owner ? ownerPhoto : null, voiceId: c.owner ? ownerVoice.voiceId : v?.id ?? null, voiceName: c.owner ? ownerVoice.voiceName : v?.name ?? null });
  }
  const names = new Set(db.listDramaCast(orgId).map((c) => c.name.toLowerCase()));
  const made: DramaEpisode[] = [];
  let n = eps.length;
  for (const e of (out.episodes ?? []).slice(0, count)) {
    const shots: Shot[] = (e.shots ?? []).slice(0, 18).map((x, i) => ({
      n: i + 1,
      framing: x.framing,
      move: x.move.slice(0, 120),
      action: x.action.slice(0, 600),
      setting: x.setting.slice(0, 300),
      cast: (x.cast ?? []).filter((c) => names.has(c.toLowerCase())).slice(0, 3),
      line: x.line_text?.trim() && names.has((x.line_who || "").toLowerCase()) ? { who: x.line_who, text: x.line_text.trim().slice(0, 140) } : null,
      seconds: Math.max(3, Math.min(7, Math.round(x.seconds || 5))),
      status: "todo",
    }));
    if (!shots.length) continue;
    n++;
    made.push(db.createDramaEpisode({ organizationId: orgId, number: n, title: e.title.slice(0, 120), logline: e.logline.slice(0, 400), beats: JSON.stringify((e.beats ?? []).slice(0, 6)), shots: JSON.stringify(shots), costCents: estimateEpisode(shots) }));
  }
  return { series: s, episodes: made, cast: db.listDramaCast(orgId) };
}

/** The owner's portrait: the photo picked under Your avatar, else her first photo in the Brain. */
async function ownerPortrait(orgId: number) {
  const emp = await elena(orgId);
  const s = avatar.settingsOf(emp);
  const pics = await avatar.photos(orgId);
  return (pics.find((p) => p.id === s.imageId) ?? pics[0])?.url ?? null;
}

// ==========================================
// fal.ai and ElevenLabs
// ==========================================

async function falCall(url: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Key ${ENV.falKey}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : Array.isArray(data?.detail) ? data.detail.map((d: any) => d?.msg).filter(Boolean).join("; ") : data?.raw?.slice?.(0, 200) || "";
    throw new Error(`fal.ai said no (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

let pollMs = 5000;
export function setPollMs(ms: number) {
  pollMs = ms;
}

/** Runs one fal.ai model through its queue and returns the result. */
export async function falRun(model: string, input: unknown, maxMinutes = 20) {
  const sub = await falCall(`https://queue.fal.run/${model}`, { method: "POST", body: input });
  if (!sub.request_id) throw new Error("fal.ai didn't start it.");
  const until = Date.now() + maxMinutes * 60_000;
  for (;;) {
    const st = await falCall(sub.status_url);
    if (st.status === "COMPLETED") break;
    if (st.status && st.status !== "IN_QUEUE" && st.status !== "IN_PROGRESS") throw new Error(`fal.ai stopped: ${st.status}`);
    if (Date.now() > until) throw new Error(`fal.ai took more than ${maxMinutes} minutes`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return falCall(sub.response_url);
}

function dataUri(buf: Buffer, mime: string) {
  return `data:${mime};base64,${buf.toString("base64")}`;
}
function mimeOf(url: string) {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}
async function readStored(fileUrl: string) {
  return fs.promises.readFile(path.join(uploadsRoot(), fileUrl.replace(/^\/files\//, "")));
}
/** A stored file as something fal.ai can read. */
async function asInput(fileUrl: string) {
  if (/^https?:/i.test(fileUrl)) return fileUrl;
  return dataUri(await readStored(fileUrl), mimeOf(fileUrl));
}
async function download(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Couldn't download from fal.ai (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function speak(voiceId: string, text: string) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ENV.elevenLabsKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_AVATAR_MODEL || "eleven_multilingual_v2" }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs didn't read the line (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ==========================================
// Making an episode
// ==========================================

/** A made-up character needs a portrait before their first shot, so they look the same in every shot. */
async function portraitFor(orgId: number, c: DramaCastMember, look: string) {
  if (c.photoUrl) return c.photoUrl;
  const r = await falRun(MODELS.portrait, { prompt: `Cinematic portrait photograph of ${c.name}, ${c.look}. Head and shoulders, facing the camera, neutral expression, soft natural light, plain background, 35mm film look. ${look}`, aspect_ratio: "3:4", num_images: 1, output_format: "png" }, 5);
  const url = r?.images?.[0]?.url;
  if (!url) throw new Error(`No portrait came back for ${c.name}`);
  const saved = await storagePut(`org-${orgId}/drama/cast-${c.id}.png`, await download(url), "image/png");
  db.updateDramaCast(c.id, orgId, { photoUrl: saved.url });
  return saved.url;
}

function stillPrompt(s: Shot, look: string, cast: DramaCastMember[]) {
  const who = s.cast.map((n, i) => {
    const c = cast.find((x) => x.name.toLowerCase() === n.toLowerCase());
    return `${n} (the person in reference image ${i + 1}${c?.look ? `, ${c.look}` : ""})`;
  });
  return `A single cinematic film still, vertical 9:16, from a scripted drama. ${s.framing} shot. ${s.action} Setting: ${s.setting}. ${who.length ? `On screen: ${who.join("; ")}. Keep each face exactly like its reference.` : "No people in frame."} ${look} Shallow depth of field, motivated light, film grain. No text, captions, logos or watermarks.`;
}

function motionPrompt(s: Shot, cast: DramaCastMember[]) {
  const refs = s.cast.map((n, i) => ({ n, tag: `@Element${i + 1}` }));
  let action = s.action;
  for (const r of refs) action = action.replace(new RegExp(`\\b${r.n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), r.tag);
  const talk = s.line ? ` ${refs.find((r) => r.n.toLowerCase() === s.line!.who.toLowerCase())?.tag ?? s.line.who} speaks a short line, mouth moving naturally.` : "";
  void cast;
  return `${s.move}. ${action}${talk} Cinematic, realistic motion, subtle natural expressions, no on-screen text.`;
}

const active = new Set<number>();

/** Starts (or picks up) making an episode in the background. */
export async function startEpisode(orgId: number, id: number) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep) throw new TRPCError({ code: "NOT_FOUND", message: "That episode isn't in this workspace." });
  if (ep.status === "making" && active.has(id)) return ep;
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making videos isn't connected yet: FAL_KEY is missing on the server." });
  const shots = shotsOf(ep);
  const cast = db.listDramaCast(orgId);
  const emp = await elena(orgId);
  if (shots.some((s) => s.line) && !ENV.elevenLabsKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Voices aren't connected yet: ELEVENLABS_API_KEY is missing on the server." });
  const owner = cast.find((c) => c.kind === "owner");
  if (owner && !owner.photoUrl) {
    const pic = await ownerPortrait(orgId);
    if (!pic) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add a photo of yourself to the Brain first (attach one here), so you look like you in every shot." });
    db.updateDramaCast(owner.id, orgId, { photoUrl: pic });
  }
  if (owner && !owner.voiceId) {
    const s = avatar.settingsOf(emp);
    const own = s.voiceId ? { id: s.voiceId, name: s.voiceName } : (await avatar.voices()).find((v) => v.own);
    if (own) db.updateDramaCast(owner.id, orgId, { voiceId: own.id, voiceName: own.name ?? null });
  }
  for (const s of shots) if (s.line && !db.listDramaCast(orgId).find((c) => c.name.toLowerCase() === s.line!.who.toLowerCase())?.voiceId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${s.line.who} doesn't have a voice yet. Pick one on the Cast tab.` });
  const estimate = estimateEpisode(shots);
  const limit = avatar.settingsOf(emp).limitCents;
  const spent = await spentThisMonth(orgId);
  if (spent + estimate > limit) throw new TRPCError({ code: "BAD_REQUEST", message: `Episode ${ep.number} (about $${(estimate / 100).toFixed(2)}) would go over your $${(limit / 100).toFixed(0)} monthly limit. You've spent $${(spent / 100).toFixed(2)} this month. Raise the limit under Your avatar on the Videos tab.` });
  const done = shots.filter((s) => s.clipUrl).length;
  const next = db.updateDramaEpisode(id, orgId, { status: "making", error: null, madeAt: ep.madeAt ?? new Date(), progress: done ? `Picking up at shot ${done + 1} of ${shots.length}` : `Shot 1 of ${shots.length}` })!;
  active.add(id);
  void makeEpisode(orgId, id)
    .catch((err) => fail(orgId, id, err instanceof Error ? err.message : String(err)))
    .finally(() => active.delete(id));
  return next;
}

async function fail(orgId: number, id: number, message: string) {
  const ep = db.updateDramaEpisode(id, orgId, { status: "failed", error: message.slice(0, 400), progress: null });
  const emp = await elena(orgId).catch(() => null);
  if (ep && emp) await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `Episode ${ep.number} stopped: ${message.slice(0, 300).replace(/\.$/, "")}. The shots already made are kept, so Make again picks up where it stopped.`, cards: JSON.stringify([{ type: "drama_episode", id: ep.id, title: ep.title }]) });
}

export async function makeEpisode(orgId: number, id: number) {
  const series = db.getDramaSeries(orgId);
  const look = series?.look ?? "";
  let ep = db.getDramaEpisode(id, orgId)!;
  const shots = shotsOf(ep);
  const save = (progress: string) => {
    ep = db.updateDramaEpisode(id, orgId, { shots: JSON.stringify(shots), progress, costCents: shots.reduce((s, x) => s + (x.costCents ?? 0), 0) + shots.filter((x) => !x.clipUrl).reduce((s, x) => s + estimateShot(x), 0) })!;
  };
  for (const s of shots) {
    if (s.clipUrl) continue;
    const cast = db.listDramaCast(orgId);
    const inShot = s.cast.map((n) => cast.find((c) => c.name.toLowerCase() === n.toLowerCase())).filter((c): c is DramaCastMember => Boolean(c));
    s.status = "making";
    s.error = null;
    s.costCents = 0;
    save(`Shot ${s.n} of ${shots.length}: ${s.framing.toLowerCase()}, ${s.action.slice(0, 80)}`);
    // 1. The film still, matched to each character's portrait.
    const portraits: string[] = [];
    for (const c of inShot) {
      if (!c.photoUrl) s.costCents += PRICE.portrait;
      portraits.push(await portraitFor(orgId, c, look));
    }
    const stillRes = portraits.length
      ? await falRun(MODELS.still, { prompt: stillPrompt(s, look, cast), image_urls: await Promise.all(portraits.map(asInput)), aspect_ratio: "9:16", num_images: 1, output_format: "png" }, 5)
      : await falRun(MODELS.portrait, { prompt: stillPrompt(s, look, cast), aspect_ratio: "9:16", num_images: 1, output_format: "png" }, 5);
    const still = stillRes?.images?.[0]?.url as string | undefined;
    if (!still) throw new Error(`No picture came back for shot ${s.n}`);
    s.stillUrl = (await storagePut(`org-${orgId}/drama/ep${ep.number}-shot${s.n}.png`, await download(still), "image/png")).url;
    s.costCents += PRICE.still;
    // 2. The line, so the shot is as long as it needs to be.
    let audio: Buffer | null = null;
    let seconds = s.seconds;
    if (s.line) {
      const voice = cast.find((c) => c.name.toLowerCase() === s.line!.who.toLowerCase())?.voiceId;
      if (!voice) throw new Error(`${s.line.who} doesn't have a voice yet`);
      audio = await speak(voice, s.line.text);
      seconds = Math.max(seconds, Math.ceil((audio.length * 8) / 128_000) + 1);
    }
    seconds = Math.max(3, Math.min(10, seconds));
    // 3. Kling animates the still with the camera move. Sound only when no one speaks.
    const clipRes = await falRun(MODELS.video, {
      start_image_url: still,
      prompt: motionPrompt(s, cast),
      duration: String(seconds),
      generate_audio: !s.line,
      negative_prompt: "blur, distortion, low quality, on-screen text, captions, watermark, extra fingers, warped faces",
      ...(portraits.length ? { elements: await Promise.all(portraits.map(async (p) => ({ frontal_image_url: await asInput(p), reference_image_urls: [await asInput(p)] }))) } : {}),
    }, 25);
    let clip = clipRes?.video?.url as string | undefined;
    if (!clip) throw new Error(`No video came back for shot ${s.n}`);
    s.costCents += Math.ceil(seconds * (s.line ? PRICE.videoSilentPerSec : PRICE.videoSoundPerSec));
    // 4. The line, lip-synced onto the clip.
    if (audio) {
      const synced = await falRun(MODELS.lipsync, { video_url: clip, audio_url: dataUri(audio, "audio/mpeg"), sync_mode: "cut_off" }, 15);
      clip = synced?.video?.url as string | undefined;
      if (!clip) throw new Error(`The lip sync for shot ${s.n} didn't come back`);
      s.costCents += Math.ceil(seconds * PRICE.lipsyncPerSec);
    }
    s.clipUrl = (await storagePut(`org-${orgId}/drama/ep${ep.number}-shot${s.n}.mp4`, await download(clip), "video/mp4")).url;
    s.seconds = seconds;
    s.status = "done";
    save(`Shot ${s.n} of ${shots.length} done`);
  }
  save("Cutting the episode together");
  const out = await stitch(orgId, ep.number, shots.map((s) => s.clipUrl!));
  ep = db.updateDramaEpisode(id, orgId, { status: "ready", videoUrl: out, progress: null, error: null, costCents: shots.reduce((s, x) => s + (x.costCents ?? 0), 0) })!;
  const emp = await elena(orgId);
  const secs = shots.reduce((s, x) => s + x.seconds, 0);
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `Episode ${ep.number}, "${ep.title}," is cut. ${shots.length} shots, ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} long, and it cost $${(ep.costCents / 100).toFixed(2)}. Watch it below. If a shot isn't right, open it on my Episodes tab and press Remake on that shot.`,
    cards: JSON.stringify([{ type: "drama_episode", id: ep.id, title: ep.title }, { type: "choices", id: Date.now(), title: "", options: [`Make episode ${ep.number + 1}`, "Write the next 3 episodes", "How much have I spent?"] }]),
  });
}

function ffmpegPath() {
  try {
    // Shipped with the app, so the server needs nothing installed.
    const p = createRequire(import.meta.url)("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* fall back to the system's */
  }
  return "ffmpeg";
}

/** Every shot cut together as one 1080x1920 episode, each with sound (silence where a shot has none). */
export async function stitch(orgId: number, number: number, clips: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-drama-"));
  try {
    const files = clips.map((c, i) => {
      const p = path.join(dir, `${i}.mp4`);
      fs.copyFileSync(path.join(uploadsRoot(), c.replace(/^\/files\//, "")), p);
      return p;
    });
    const parts: string[] = [];
    const args: string[] = ["-y"];
    files.forEach((f) => args.push("-i", f));
    const probes = await Promise.all(files.map((f) => probe(f)));
    files.forEach((_, i) => {
      const d = probes[i].duration.toFixed(3);
      parts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setsar=1[v${i}]`);
      // Every shot gets sound exactly as long as its picture: its own, padded or trimmed, or silence.
      parts.push(probes[i].audio ? `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:${d},asetpts=N/SR/TB[a${i}]` : `anullsrc=r=44100:cl=stereo,atrim=0:${d},asetpts=N/SR/TB[a${i}]`);
    });
    parts.push(`${files.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${files.length}:v=1:a=1[v][a]`);
    const out = path.join(dir, "episode.mp4");
    args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out);
    await run(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 });
    const saved = await storagePut(`org-${orgId}/drama/episode-${number}-${Date.now()}.mp4`, fs.readFileSync(out), "video/mp4");
    return saved.url;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether a clip has sound, and how long it is. */
export async function probe(file: string) {
  const { stderr } = await run(ffmpegPath(), ["-hide_banner", "-i", file], { timeout: 30_000 }).catch((e) => ({ stderr: String(e.stderr ?? "") }));
  const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 5;
  return { audio: /Stream #\d+:\d+.*Audio:/.test(stderr), duration: Math.max(0.5, duration) };
}

/** Remake one shot: it's cleared and the episode is made again (only that shot is new). */
export async function remakeShot(orgId: number, id: number, n: number) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep) throw new TRPCError({ code: "NOT_FOUND", message: "That episode isn't in this workspace." });
  if (ep.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this episode finishes." });
  const shots = shotsOf(ep).map((s) => (s.n === n ? { ...s, clipUrl: null, stillUrl: null, status: "todo" as const, costCents: 0 } : s));
  db.updateDramaEpisode(id, orgId, { shots: JSON.stringify(shots) });
  return startEpisode(orgId, id);
}

/** After a restart: episodes that were being made pick up where they stopped. */
export async function resumeDrama() {
  for (const e of db.listMakingDramaEpisodes()) {
    if (active.has(e.id)) continue;
    await startEpisode(e.organizationId, e.id).catch((err) => fail(e.organizationId, e.id, err instanceof Error ? err.message : String(err)));
  }
}

// ==========================================
// For the screens and chat
// ==========================================

export function episodeView(e: DramaEpisode) {
  const shots = shotsOf(e);
  const secs = shots.reduce((s, x) => s + (x.seconds || 0), 0);
  return {
    id: e.id,
    number: e.number,
    title: e.title,
    logline: e.logline,
    beats: beatsOf(e),
    shots,
    status: e.status,
    progress: e.progress,
    videoUrl: e.videoUrl,
    error: e.error,
    length: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
    cost: `${e.status === "ready" ? "" : "about "}$${(e.costCents / 100).toFixed(2)}`,
    done: shots.filter((s) => s.clipUrl).length,
  };
}

export async function studio(orgId: number) {
  const series = db.getDramaSeries(orgId);
  const emp = await db.getEmployeeByKind(orgId, "video");
  return {
    series: series ? { title: series.title, premise: series.premise, look: series.look } : null,
    episodes: db.listDramaEpisodes(orgId).map(episodeView),
    cast: db.listDramaCast(orgId).map((c) => ({ id: c.id, name: c.name, role: c.role, kind: c.kind, look: c.look, photoUrl: c.photoUrl, voiceId: c.voiceId, voiceName: c.voiceName })),
    spentCents: await spentThisMonth(orgId),
    limitCents: emp ? avatar.settingsOf(emp).limitCents : 5000,
  };
}

export function saveCast(orgId: number, id: number, input: { name: string; role: string; look: string; voiceId: string | null; voiceName: string | null }) {
  const c = db.listDramaCast(orgId).find((x) => x.id === id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That character isn't in this series." });
  // A new look means a new portrait the next time they're in a shot.
  const changedLook = c.kind === "made_up" && input.look.trim() !== c.look;
  return db.updateDramaCast(id, orgId, { name: input.name.trim() || c.name, role: input.role.trim(), look: input.look.trim(), voiceId: input.voiceId, voiceName: input.voiceName, ...(changedLook ? { photoUrl: null } : {}) });
}

export async function dramaFacts(orgId: number) {
  const st = await studio(orgId);
  if (!st.series) return "\nMini drama studio: no series yet. When the owner asks for a drama, micro drama, series or episodes, use write_episodes.";
  return `\nMini drama studio. Series: ${st.series.title}. ${st.series.premise}
Cast: ${st.cast.map((c) => `${c.name} (${c.kind === "owner" ? "the owner" : "made up"}, ${c.role}, voice ${c.voiceName ?? "not picked"})`).join("; ")}
Episodes: ${st.episodes.map((e) => `${e.number}. ${e.title} (${e.status}${e.status === "making" ? `, ${e.progress ?? ""}` : ""}, ${e.cost})`).join("; ") || "none"}
Spent this month on video: $${(st.spentCents / 100).toFixed(2)} of $${(st.limitCents / 100).toFixed(0)}.`;
}
