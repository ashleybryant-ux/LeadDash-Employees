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
  /** Room tone and the sounds the action makes. */
  sound?: string;
  /** The owner's character plate for this shot (front, walking, seated, green blazer...). */
  plate?: string;
  /** Brain images shown in the shot (a logo, a screenshot of the product), by title. */
  props?: string[];
  /** Voice-over in the owner's voice over this shot (campaigns). */
  vo?: string;
  voUrl?: string | null;
  /** On-screen caption for this shot (campaigns). */
  caption?: string;
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
export const STYLE = `You work like a creative director, cinematographer and editor together, never "make me a video." You plan the story, the shots, the sound and the cut before anything is generated.
Story:
- Open in the middle of a conflict, never on an introduction. The first 2 seconds are the hook: a reveal, a confrontation or something that shouldn't be there. Raise the stakes every 10 to 15 seconds. End on a cliffhanger (a reveal, a threat or a line that changes everything), then cut to black.
- Show the problem in pictures before anyone explains it. Faces and hands tell the story; dialogue is the last resort.
Shots (the shot list comes first, every time):
- 10 to 16 shots for a 60 to 90 second episode, each 3 to 7 seconds. Mix them like a film: an establishing wide of the place (2 to 3 seconds), medium two-shots, over-the-shoulder shots for conversations, close-ups for emotion, extreme close-up inserts (hands, a phone screen, a file, a door handle) and reaction shots.
- Build depth in every frame: something in the foreground, the subject in the middle, the room behind. Compose for a vertical phone screen, not a cropped wide film.
- Never more than one line in a shot, and never two talking close-ups of the same person in a row.
Camera:
- Every shot moves with purpose, and you name the move and how far: a slow dolly-in of a few inches over the shot, handheld micro-movement for tension, a tracking shot when someone walks, a rack focus to land a look, a static frame only for a held beat.
- 24fps film look, shallow depth of field, a 35mm lens feel for rooms and a 50mm feel for faces.
Light and color:
- Motivated, directional light from real sources: a window, a desk lamp, a monitor, a phone screen. Rim or backlight to separate people from the background. Warm practicals, rich shadows, realistic skin tones, controlled contrast, one consistent color grade for the series, light film grain. Night is moody, never murky.
Sound (planned per shot):
- Room tone always, plus the sounds the action makes: footsteps, a door latch, keyboard taps, a phone vibrating, paper sliding, HVAC hum, rain on a window. A silent beat before a reveal.
- The score: one music cue per episode with a mood, a tempo and the moment it builds or drops out.
Dialogue:
- Short lines, 12 words at most, with subtext. Let silence and looks carry beats. Reactions matter as much as lines.
Character bible:
- Each character keeps the same face, hair, skin tone, wardrobe and jewelry within an episode, and the same lighting treatment. The owner is played by the owner from her own photos.
Never:
- Real clients or client stories, real patient details, real people other than the owner, other companies' logos or brands, on-screen text, captions or watermarks in the picture.`;

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

export function estimateShot(s: Pick<Shot, "seconds" | "line" | "stillUrl">) {
  const secs = Math.max(3, Math.min(10, Math.round(s.seconds || 5)));
  return Math.ceil((s.stillUrl ? 0 : PRICE.still) + secs * (s.line ? PRICE.videoSilentPerSec + PRICE.lipsyncPerSec : PRICE.videoSoundPerSec));
}
export function estimateEpisode(shots: Shot[]) {
  return shots.reduce((sum, s) => sum + (s.clipUrl ? 0 : estimateShot(s)), 0);
}
/** Just the keyframes (what's spent before the owner approves). */
export function estimateStills(shots: Shot[]) {
  return shots.filter((s) => !s.stillUrl).length * PRICE.still;
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
        required: ["title", "logline", "beats", "shots", "music"],
        properties: {
          title: { type: "string" },
          music: { type: "string", description: "The score: genre, mood, tempo, instruments, and where it builds or drops out. Instrumental only" },
          logline: { type: "string", description: "One sentence that makes someone want to watch" },
          beats: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "at", "text"], properties: { label: { type: "string", enum: ["Hook", "Turn", "Spike", "Cliffhanger"] }, at: { type: "string", description: "Like 0:00" }, text: { type: "string" } } } },
          shots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["framing", "move", "action", "setting", "cast", "line_who", "line_text", "seconds", "sound"],
              properties: {
                framing: { type: "string", enum: ["Wide", "Medium", "Two-shot", "Over the shoulder", "Close-up", "Extreme close-up", "Insert", "Reaction"] },
                move: { type: "string", description: "The camera move: slow push-in, handheld, dolly left, static, rack focus..." },
                action: { type: "string", description: "What we see, in one or two sentences, with expressions and body language" },
                setting: { type: "string", description: "The room or place, described the same way every time it returns" },
                cast: { type: "array", items: { type: "string" }, description: "Names of the characters on screen" },
                line_who: { type: "string", description: "Who speaks in this shot, or ''" },
                line_text: { type: "string", description: "The one line spoken, 12 words at most, or ''" },
                seconds: { type: "integer", description: "3 to 7" },
                sound: { type: "string", description: "Room tone and the sounds this shot makes (footsteps, a door latch, a phone buzzing), or a silent beat" },
              },
            },
          },
        },
      },
    },
  },
};

type Written = { title: string; premise: string; look: string; cast: { name: string; role: string; owner: boolean; look: string; voice: string }[]; episodes: { title: string; logline: string; music: string; beats: Beat[]; shots: { framing: string; move: string; action: string; setting: string; cast: string[]; line_who: string; line_text: string; seconds: number; sound: string }[] }[] };

/** Writes episodes (and the series and cast the first time). New episodes continue from the last one. */
export async function writeEpisodes(orgId: number, input: { brief: string; count: number; ownerName: string }) {
  const emp = await elena(orgId);
  const row = db.getDramaSeries(orgId);
  // A row made only to hold studio settings isn't a series yet.
  const series = row?.premise ? row : null;
  const cast = db.listDramaCast(orgId);
  const eps = db.listDramaEpisodes(orgId).filter((e) => e.kind === "drama");
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
      sound: (x.sound ?? "").slice(0, 200),
      status: "todo",
    }));
    if (!shots.length) continue;
    n++;
    made.push(db.createDramaEpisode({ organizationId: orgId, number: n, title: e.title.slice(0, 120), logline: e.logline.slice(0, 400), beats: JSON.stringify((e.beats ?? []).slice(0, 6)), shots: JSON.stringify(shots), music: (e.music ?? "").slice(0, 500), costCents: estimateEpisode(shots) }));
  }
  return { series: s, episodes: made, cast: db.listDramaCast(orgId) };
}

export type Plate = { label: string; url: string };
export type StyleRef = { id: string; name: string; link: string; likes: string[]; words: string };
export type StudioSettings = { ownerPhotoIds?: number[]; plates?: Plate[]; styleRefs?: StyleRef[] };

export function settingsOf(orgId: number): StudioSettings {
  return parse<StudioSettings>(db.getDramaSeries(orgId)?.settings, {});
}
export function saveSettings(orgId: number, patch: Partial<StudioSettings>) {
  const cur = settingsOf(orgId);
  const series = db.getDramaSeries(orgId);
  return db.saveDramaSeries(orgId, { ...(series ? {} : { title: "My videos" }), settings: JSON.stringify({ ...cur, ...patch }) });
}

const NOT_A_FACE = /logo|screen ?shot|screen|product|interface|ui\b|dashboard|banner|flyer|graphic/i;

/** The owner's character pack: the Brain photos she picked as photos of her (or every photo that isn't a logo or screenshot). */
export async function ownerPack(orgId: number) {
  const emp = await elena(orgId);
  const s = avatar.settingsOf(emp);
  const pics = await avatar.photos(orgId);
  const chosen = settingsOf(orgId).ownerPhotoIds;
  const mine = chosen?.length ? pics.filter((p) => chosen.includes(p.id)) : pics.filter((p) => !NOT_A_FACE.test(`${p.title} ${p.note}`));
  return [...mine.filter((p) => p.id === s.imageId), ...mine.filter((p) => p.id !== s.imageId)];
}

/** Every photo of the owner (the one picked under Your avatar first), so her face holds from every angle. */
async function ownerPhotos(orgId: number) {
  return (await ownerPack(orgId)).map((p) => p.url).slice(0, 6);
}

/** Brain images that aren't the owner: logos, screenshots, products a shot can show. */
export async function propImages(orgId: number) {
  const mine = new Set((await ownerPack(orgId)).map((p) => p.id));
  return (await avatar.photos(orgId)).filter((p) => !mine.has(p.id));
}

/** The owner's portrait: the photo picked under Your avatar, else her first photo in the pack. */
async function ownerPortrait(orgId: number) {
  return (await ownerPack(orgId))[0]?.url ?? null;
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
  if (fileUrl.startsWith("/avatars/")) {
    // Team portraits ship with the app.
    for (const base of [path.resolve(process.cwd(), "dist/public"), path.resolve(process.cwd(), "client/public")]) {
      const p = path.join(base, fileUrl);
      if (fs.existsSync(p)) return fs.promises.readFile(p);
    }
  }
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

type Refs = { name: string; look: string; urls: string[] };
type Prop = { title: string; url: string };

function stillPrompt(s: Shot, look: string, refs: Refs[], props: Prop[] = []) {
  let at = 1;
  const who = refs.map((r) => {
    const from = at;
    at += r.urls.length;
    const which = r.urls.length > 1 ? `reference images ${from} to ${at - 1}, the same person from different angles` : `reference image ${from}`;
    return `${r.name} (the person in ${which}${r.look ? `, ${r.look}` : ""})`;
  });
  const shown = props.map((p) => `reference image ${at++} is ${p.title}: show it exactly as it is`);
  return `A single cinematic film still, vertical 9:16, from a professionally produced commercial or drama. ${s.framing} shot. ${s.action} Setting: ${s.setting}. ${who.length ? `On screen: ${who.join("; ")}. Keep each face exactly like its reference.` : "No people in frame."}${shown.length ? ` ${shown.join("; ")}.` : ""} ${look} Shallow depth of field, motivated light, realistic skin texture, film grain. No added text, captions or watermarks.`;
}

/** The video model moves the camera and the people; it never redesigns them. */
function motionPrompt(s: Shot, refs: Refs[]) {
  const tags = refs.map((r, i) => ({ n: r.name, tag: `@Element${i + 1}` }));
  let action = s.action;
  for (const r of tags) action = action.replace(new RegExp(`\\b${r.n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), r.tag);
  const talk = s.line ? ` ${tags.find((r) => r.n.toLowerCase() === s.line!.who.toLowerCase())?.tag ?? s.line.who} speaks a short line, mouth moving naturally.` : "";
  return `${s.move}. ${action}${talk} Keep every face, outfit and room exactly as in the first frame; only the camera and natural movement change. Restrained, realistic motion: subtle breathing, natural blinks, no surreal body motion, no slow motion, no transformations, no on-screen text.${!s.line && s.sound ? ` Sound: ${s.sound}.` : ""}`;
}

const active = new Set<number>();
const label = (e: Pick<DramaEpisode, "kind" | "number" | "title">) => (e.kind === "campaign" ? `"${e.title}"` : `Episode ${e.number}`);
const planOf = (e: Pick<DramaEpisode, "plan">) => parse<{ approved?: boolean; goal?: string; directions?: Direction[]; chosen?: number; script?: string; cta?: string }>(e.plan, {});
export type Direction = { title: string; hook: string; story: string; metaphor: string; location: string; wardrobe: string; lighting: string; camera: string; ending: string };

/** Starts (or picks up) an episode or campaign in the background: keyframes first, then, once approved, the animation. */
export async function startEpisode(orgId: number, id: number) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep) throw new TRPCError({ code: "NOT_FOUND", message: "That video isn't in this workspace." });
  if (ep.status === "making" && active.has(id)) return ep;
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making videos isn't connected yet: FAL_KEY is missing on the server." });
  const shots = shotsOf(ep);
  if (!shots.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a direction first, so I can plan the shots." });
  const plan = planOf(ep);
  const cast = db.listDramaCast(orgId);
  const emp = await elena(orgId);
  const animating = Boolean(plan.approved);
  if (animating && shots.some((s) => s.line || s.vo) && !ENV.elevenLabsKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Voices aren't connected yet: ELEVENLABS_API_KEY is missing on the server." });
  const needsOwner = shots.some((s) => s.vo || s.cast.some((n) => cast.find((c) => c.name.toLowerCase() === n.toLowerCase())?.kind === "owner"));
  const owner = cast.find((c) => c.kind === "owner");
  if (needsOwner) {
    const pic = await ownerPortrait(orgId);
    if (!pic) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add photos of yourself to the Brain first (attach them here), so you look like you in every shot." });
    if (owner && !owner.photoUrl) db.updateDramaCast(owner.id, orgId, { photoUrl: pic });
  }
  const s0 = avatar.settingsOf(emp);
  const ownVoice = s0.voiceId ? { id: s0.voiceId, name: s0.voiceName } : (await avatar.voices()).find((v) => v.own) ?? null;
  if (owner && !owner.voiceId && ownVoice) db.updateDramaCast(owner.id, orgId, { voiceId: ownVoice.id, voiceName: ownVoice.name ?? null });
  if (animating) {
    for (const s of shots) if (s.line && !db.listDramaCast(orgId).find((c) => c.name.toLowerCase() === s.line!.who.toLowerCase())?.voiceId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${s.line.who} doesn't have a voice yet. Pick one on the Cast tab.` });
    if (shots.some((s) => s.vo) && !ownVoice) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Pick your voice under Your avatar on my Videos tab, so the voice-over is you." });
  }
  const estimate = animating ? estimateEpisode(shots) : estimateStills(shots);
  const limit = s0.limitCents;
  const spent = await spentThisMonth(orgId);
  if (spent + estimate > limit) throw new TRPCError({ code: "BAD_REQUEST", message: `${label(ep)} (about $${(estimate / 100).toFixed(2)} for this step) would go over your $${(limit / 100).toFixed(0)} monthly limit. You've spent $${(spent / 100).toFixed(2)} this month. Raise the limit under Your avatar on the Videos tab.` });
  const next = db.updateDramaEpisode(id, orgId, { status: "making", error: null, madeAt: ep.madeAt ?? new Date(), progress: animating ? `Animating shot ${(shots.filter((x) => x.clipUrl).length || 0) + 1} of ${shots.length}` : `Keyframe 1 of ${shots.length}` })!;
  active.add(id);
  void makeEpisode(orgId, id)
    .catch((err) => fail(orgId, id, err instanceof Error ? err.message : String(err)))
    .finally(() => active.delete(id));
  return next;
}

async function fail(orgId: number, id: number, message: string) {
  const ep = db.updateDramaEpisode(id, orgId, { status: "failed", error: message.slice(0, 400), progress: null });
  const emp = await elena(orgId).catch(() => null);
  if (ep && emp) await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `${label(ep)} stopped: ${message.slice(0, 300).replace(/\.$/, "")}. Everything already made is kept, so Make again picks up where it stopped.`, cards: JSON.stringify([{ type: "drama_episode", id: ep.id, title: ep.title }]) });
}

/** The references for the people in a shot: the owner's plate and photos, a team member's portrait, a made-up character's portrait. */
async function refsFor(orgId: number, s: Shot, look: string) {
  const cast = db.listDramaCast(orgId);
  const plates = settingsOf(orgId).plates ?? [];
  const refs: Refs[] = [];
  let extra = 0;
  for (const n of s.cast) {
    const c = cast.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!c) continue;
    if (c.kind === "owner") {
      const plate = plates.find((p) => p.label.toLowerCase() === (s.plate ?? "").toLowerCase());
      const photos = await ownerPhotos(orgId);
      refs.push({ name: c.name, look: c.look, urls: [...(plate ? [plate.url] : []), ...photos].slice(0, 6) });
    } else {
      if (!c.photoUrl) extra += PRICE.portrait;
      refs.push({ name: c.name, look: c.look, urls: [await portraitFor(orgId, c, look)] });
    }
  }
  return { refs, extra };
}

export async function makeEpisode(orgId: number, id: number) {
  const series = db.getDramaSeries(orgId);
  const look = series?.look ?? "";
  let ep = db.getDramaEpisode(id, orgId)!;
  const shots = shotsOf(ep);
  const plan = planOf(ep);
  const emp = await elena(orgId);
  const save = (progress: string) => {
    ep = db.updateDramaEpisode(id, orgId, { shots: JSON.stringify(shots), progress, costCents: shots.reduce((t, x) => t + (x.costCents ?? 0), 0) + shots.filter((x) => !x.clipUrl).reduce((t, x) => t + estimateShot(x), 0) })!;
  };
  const props = await propImages(orgId);

  // 1. Keyframes: a still for every shot (the image model decides who is in it and how it looks).
  for (const s of shots) {
    if (s.stillUrl) continue;
    s.status = "making";
    s.error = null;
    save(`Keyframe ${s.n} of ${shots.length}: ${s.framing.toLowerCase()}, ${s.action.slice(0, 80)}`);
    const { refs, extra } = await refsFor(orgId, s, look);
    const shown = (s.props ?? []).map((t) => props.find((p) => p.title.toLowerCase() === t.toLowerCase())).filter((p): p is (typeof props)[number] => Boolean(p)).slice(0, 2);
    const all = [...refs.flatMap((r) => r.urls), ...shown.map((p) => p.url)].slice(0, 14);
    const res = all.length
      ? await falRun(MODELS.still, { prompt: stillPrompt(s, look, refs, shown), image_urls: await Promise.all(all.map(asInput)), aspect_ratio: "9:16", num_images: 1, output_format: "png" }, 5)
      : await falRun(MODELS.portrait, { prompt: stillPrompt(s, look, refs), aspect_ratio: "9:16", num_images: 1, output_format: "png" }, 5);
    const still = res?.images?.[0]?.url as string | undefined;
    if (!still) throw new Error(`No picture came back for shot ${s.n}`);
    s.stillUrl = (await storagePut(`org-${orgId}/drama/${ep.kind}${ep.id}-shot${s.n}-${Date.now()}.png`, await download(still), "image/png")).url;
    s.costCents = (s.costCents ?? 0) + PRICE.still + extra;
    s.status = s.clipUrl ? "done" : "todo";
    save(`Keyframe ${s.n} of ${shots.length} done`);
  }

  // 2. Human approval: nothing is animated until the owner approves the keyframes.
  if (!plan.approved) {
    ep = db.updateDramaEpisode(id, orgId, { status: "keyframes", progress: null })!;
    const est = estimateEpisode(shots);
    await db.createChatMessage({
      organizationId: orgId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: `The keyframes for ${label(ep)} are ready: one still for each of the ${shots.length} shots. Look them over. Redo any that aren't right, then press Animate it (about $${(est / 100).toFixed(2)} more). Nothing is animated until you approve.`,
      cards: JSON.stringify([{ type: "drama_keyframes", id: ep.id, title: ep.title }]),
    });
    return;
  }

  // 3. Animation, voice-over and lip sync, shot by shot (the video model moves the camera and the people, nothing else).
  const cast = db.listDramaCast(orgId);
  const ownerVoice = cast.find((c) => c.kind === "owner")?.voiceId ?? avatar.settingsOf(emp).voiceId ?? (await avatar.voices()).find((v) => v.own)?.id ?? null;
  for (const s of shots) {
    if (s.clipUrl) continue;
    s.status = "making";
    s.error = null;
    save(`Animating shot ${s.n} of ${shots.length}: ${s.move.toLowerCase()}`);
    const { refs } = await refsFor(orgId, s, look);
    let audio: Buffer | null = null;
    let seconds = s.seconds;
    if (s.line) {
      const voice = cast.find((c) => c.name.toLowerCase() === s.line!.who.toLowerCase())?.voiceId;
      if (!voice) throw new Error(`${s.line.who} doesn't have a voice yet`);
      audio = await speak(voice, s.line.text);
      seconds = Math.max(seconds, Math.ceil((audio.length * 8) / 128_000) + 1);
    }
    if (s.vo) {
      if (!ownerVoice) throw new Error("Pick your voice under Your avatar first");
      const vo = await speak(ownerVoice, s.vo);
      s.voUrl = (await storagePut(`org-${orgId}/drama/${ep.kind}${ep.id}-vo${s.n}.mp3`, vo, "audio/mpeg")).url;
      seconds = Math.max(seconds, Math.ceil((vo.length * 8) / 128_000) + 1);
    }
    seconds = Math.max(3, Math.min(10, seconds));
    const clipRes = await falRun(MODELS.video, {
      start_image_url: await asInput(s.stillUrl!),
      prompt: motionPrompt(s, refs),
      duration: String(seconds),
      generate_audio: !s.line,
      negative_prompt: "blur, distortion, low quality, on-screen text, captions, watermark, extra fingers, distorted hands, warped faces, morphing, surreal motion, slow motion",
      ...(refs.length ? { elements: await Promise.all(refs.map(async (r) => ({ frontal_image_url: await asInput(r.urls[0]), reference_image_urls: await Promise.all((r.urls.length > 1 ? r.urls.slice(1, 4) : r.urls).map(asInput)) }))) } : {}),
    }, 25);
    let clip = clipRes?.video?.url as string | undefined;
    if (!clip) throw new Error(`No video came back for shot ${s.n}`);
    s.costCents = (s.costCents ?? 0) + Math.ceil(seconds * (s.line ? PRICE.videoSilentPerSec : PRICE.videoSoundPerSec));
    if (audio) {
      const synced = await falRun(MODELS.lipsync, { video_url: clip, audio_url: dataUri(audio, "audio/mpeg"), sync_mode: "cut_off" }, 15);
      clip = synced?.video?.url as string | undefined;
      if (!clip) throw new Error(`The lip sync for shot ${s.n} didn't come back`);
      s.costCents += Math.ceil(seconds * PRICE.lipsyncPerSec);
    }
    s.clipUrl = (await storagePut(`org-${orgId}/drama/${ep.kind}${ep.id}-shot${s.n}.mp4`, await download(clip), "video/mp4")).url;
    s.seconds = seconds;
    s.status = "done";
    save(`Shot ${s.n} of ${shots.length} done`);
  }

  // 4. Music, sound, the cut, captions, the call to action, and the export versions.
  save("Scoring, cutting and captioning");
  const total = shots.reduce((t, x) => t + x.seconds, 0);
  const music = ep.music ? await score(ep.music, total).catch((err) => (console.warn("[drama] score skipped:", err instanceof Error ? err.message : err), null)) : null;
  const versions = await stitch(orgId, `${ep.kind}-${ep.id}`, shots, { music, cta: ep.kind === "campaign" ? plan.cta ?? "" : "", versions: ep.kind === "campaign" });
  ep = db.updateDramaEpisode(id, orgId, { status: "ready", videoUrl: versions["9:16"], versions: JSON.stringify(versions), progress: null, error: null, costCents: shots.reduce((t, x) => t + (x.costCents ?? 0), 0) })!;
  const secs = total;
  const len = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: ep.kind === "campaign"
      ? `${label(ep)} is finished: ${shots.length} shots, ${len}, $${(ep.costCents / 100).toFixed(2)}. It comes in three versions: vertical for TikTok, Reels and Shorts, square for the feed, and wide for YouTube and your site. If a shot isn't right, press Remake on it in my Campaigns tab.`
      : `Episode ${ep.number}, "${ep.title}," is cut. ${shots.length} shots, ${len} long, and it cost $${(ep.costCents / 100).toFixed(2)}. Watch it below. If a shot isn't right, open it on my Episodes tab and press Remake on that shot.`,
    cards: JSON.stringify([{ type: "drama_episode", id: ep.id, title: ep.title }, { type: "choices", id: Date.now(), title: "", options: ep.kind === "campaign" ? ["Make another campaign", "Shorter version", "How much have I spent?"] : [`Make episode ${ep.number + 1}`, "Write the next 3 episodes", "How much have I spent?"] }]),
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

function fontsDir() {
  try {
    const pkg = createRequire(import.meta.url).resolve("dejavu-fonts-ttf/package.json");
    return path.join(path.dirname(pkg), "ttf");
  } catch {
    return "";
  }
}

/** The episode's score from ElevenLabs Music, instrumental, as long as the episode. */
async function score(prompt: string, seconds: number) {
  if (!ENV.elevenLabsKey) return null;
  const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": ENV.elevenLabsKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ prompt: `${prompt}. Cinematic film score under dialogue, instrumental, no vocals.`.slice(0, 4000), music_length_ms: Math.max(10_000, Math.min(180_000, Math.round(seconds * 1000))), force_instrumental: true }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs music (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

const assTime = (t: number) => {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
};
const assText = (t: string) => t.replace(/[{}\\]/g, "").replace(/\r?\n/g, " ").trim();

/** Captions per shot and the call to action at the end, as subtitles burned into the picture. */
function captionsFile(dir: string, shots: Pick<Shot, "caption">[], durations: number[], cta: string) {
  const lines: string[] = [];
  let t = 0;
  shots.forEach((s, i) => {
    if (s.caption?.trim()) lines.push(`Dialogue: 0,${assTime(t + 0.1)},${assTime(t + durations[i] - 0.1)},Cap,,0,0,0,,${assText(s.caption)}`);
    t += durations[i];
  });
  if (cta.trim()) lines.push(`Dialogue: 1,${assTime(Math.max(0, t - 2.8))},${assTime(t)},Cta,,0,0,0,,${assText(cta)}`);
  if (!lines.length) return null;
  const file = path.join(dir, "captions.ass");
  fs.writeFileSync(file, `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,58,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,1,0,0,0,100,100,0,0,1,3,1,2,90,90,300,1
Style: Cta,DejaVu Sans,76,&H00FFFFFF,&H00FFFFFF,&H004A6B1B,&H99000000,1,0,0,0,100,100,0,0,3,18,0,5,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`);
  return file;
}

/**
 * Every shot cut together as one 1080x1920 video: each shot's sound (silence
 * where it has none), the voice-over over its shot, the score low underneath,
 * captions and the call to action burned in. Campaigns also export square and
 * wide versions.
 */
export async function stitch(orgId: number, name: string, shots: Pick<Shot, "clipUrl" | "voUrl" | "caption">[], opts: { music?: Buffer | null; cta?: string; versions?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-drama-"));
  try {
    const files = shots.map((s, i) => {
      const p = path.join(dir, `${i}.mp4`);
      fs.copyFileSync(path.join(uploadsRoot(), s.clipUrl!.replace(/^\/files\//, "")), p);
      return p;
    });
    const args: string[] = ["-y"];
    files.forEach((f) => args.push("-i", f));
    let next = files.length;
    const voIn: Record<number, number> = {};
    shots.forEach((s, i) => {
      if (!s.voUrl) return;
      const vp = path.join(dir, `vo${i}.mp3`);
      fs.copyFileSync(path.join(uploadsRoot(), s.voUrl.replace(/^\/files\//, "")), vp);
      args.push("-i", vp);
      voIn[i] = next++;
    });
    let musicIn = -1;
    if (opts.music) {
      const mp = path.join(dir, "score.mp3");
      fs.writeFileSync(mp, opts.music);
      args.push("-i", mp);
      musicIn = next++;
    }
    const probes = await Promise.all(files.map((f) => probe(f)));
    const parts: string[] = [];
    files.forEach((_, i) => {
      const d = probes[i].duration.toFixed(3);
      parts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,format=yuv420p,setsar=1[v${i}]`);
      // Every shot gets sound exactly as long as its picture: its own, padded or trimmed, or silence.
      const base = probes[i].audio ? `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=0:${d},asetpts=N/SR/TB` : `anullsrc=r=44100:cl=stereo,atrim=0:${d},asetpts=N/SR/TB`;
      if (voIn[i] !== undefined) {
        // The voice-over sits on top; the shot's own sound drops under it.
        parts.push(`${base},volume=0.45[b${i}]`);
        parts.push(`[${voIn[i]}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=300|300,apad,atrim=0:${d},asetpts=N/SR/TB[o${i}]`);
        parts.push(`[b${i}][o${i}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a${i}]`);
      } else parts.push(`${base}[a${i}]`);
    });
    const total = probes.reduce((t, p) => t + p.duration, 0);
    const cat = `${files.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${files.length}:v=1:a=1[vc][sfx]`;
    parts.push(cat);
    const caps = captionsFile(dir, shots, probes.map((p) => p.duration), opts.cta ?? "");
    const fd = fontsDir();
    parts.push(caps ? `[vc]ass=${caps.replace(/:/g, "\\:")}${fd ? `:fontsdir=${fd.replace(/:/g, "\\:")}` : ""}[v]` : `[vc]null[v]`);
    if (musicIn >= 0) {
      // The score sits low under the dialogue and room sound, and fades out at the end.
      parts.push(`[${musicIn}:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.22,atrim=0:${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[mus]`);
      parts.push(`[sfx][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`);
    } else parts.push(`[sfx]anull[a]`);
    const out = path.join(dir, "vertical.mp4");
    args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out);
    await run(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 }).catch((e) => {
      throw new Error(`The cut didn't finish: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
    });
    const stamp = Date.now();
    const result: Record<string, string> = { "9:16": (await storagePut(`org-${orgId}/drama/${name}-9x16-${stamp}.mp4`, fs.readFileSync(out), "video/mp4")).url };
    if (opts.versions) {
      // Square: the middle of the frame. Wide: the vertical video centered on a soft blurred copy of itself.
      const sq = path.join(dir, "square.mp4");
      await run(ffmpegPath(), ["-y", "-i", out, "-vf", "crop=1080:1080:0:(ih-1080)/2", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", sq], { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 });
      result["1:1"] = (await storagePut(`org-${orgId}/drama/${name}-1x1-${stamp}.mp4`, fs.readFileSync(sq), "video/mp4")).url;
      const wide = path.join(dir, "wide.mp4");
      await run(ffmpegPath(), ["-y", "-i", out, "-filter_complex", "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=30:3,eq=brightness=-0.08[bg];[0:v]scale=-2:1080[fg];[bg][fg]overlay=(W-w)/2:0,format=yuv420p[v]", "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", wide], { maxBuffer: 20 * 1024 * 1024, timeout: 15 * 60_000 });
      result["16:9"] = (await storagePut(`org-${orgId}/drama/${name}-16x9-${stamp}.mp4`, fs.readFileSync(wide), "video/mp4")).url;
    }
    return result;
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

/** Approve the keyframes: the animation starts. */
export async function approveKeyframes(orgId: number, id: number) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep) throw new TRPCError({ code: "NOT_FOUND", message: "That video isn't in this workspace." });
  if (ep.status !== "keyframes") throw new TRPCError({ code: "BAD_REQUEST", message: "The keyframes aren't ready for approval." });
  db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...planOf(ep), approved: true }) });
  try {
    return await startEpisode(orgId, id);
  } catch (err) {
    // Not started (a missing voice, the monthly limit): it still waits for approval.
    db.updateDramaEpisode(id, orgId, { plan: JSON.stringify({ ...planOf(ep), approved: false }), status: "keyframes" });
    throw err;
  }
}

/** Redo one keyframe (before approval) or remake one shot (after): it's cleared and made again. */
export async function remakeShot(orgId: number, id: number, n: number) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep) throw new TRPCError({ code: "NOT_FOUND", message: "That video isn't in this workspace." });
  if (ep.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
  const shots = shotsOf(ep).map((s) => (s.n === n ? { ...s, clipUrl: null, stillUrl: null, voUrl: null, status: "todo" as const, costCents: 0 } : s));
  db.updateDramaEpisode(id, orgId, { shots: JSON.stringify(shots) });
  return startEpisode(orgId, id);
}

/** Edit the script: each shot's voice-over and caption, and the call to action. Changed voice-over is read again next time. */
export function saveScript(orgId: number, id: number, input: { cta: string; shots: { n: number; vo: string; caption: string }[] }) {
  const ep = db.getDramaEpisode(id, orgId);
  if (!ep) throw new TRPCError({ code: "NOT_FOUND", message: "That video isn't in this workspace." });
  if (ep.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until this one finishes." });
  let changed = false;
  const shots = shotsOf(ep).map((s) => {
    const e = input.shots.find((x) => x.n === s.n);
    if (!e) return s;
    const vo = e.vo.trim().slice(0, 300);
    const caption = e.caption.trim().slice(0, 120);
    if (vo !== (s.vo ?? "")) {
      changed = true;
      // New words need a new read, and a clip long enough for them.
      return { ...s, vo, caption, voUrl: null, clipUrl: null, status: "todo" as const };
    }
    if (caption !== (s.caption ?? "")) changed = true;
    return { ...s, caption };
  });
  const plan = planOf(ep);
  const ctaChanged = input.cta.trim() !== (plan.cta ?? "");
  return db.updateDramaEpisode(id, orgId, { shots: JSON.stringify(shots), plan: JSON.stringify({ ...plan, cta: input.cta.trim().slice(0, 80) }), ...(ep.status === "ready" && (changed || ctaChanged) ? { status: "failed", error: "The script changed. Press Make again to cut the new version." } : {}) })!;
}

/** After a restart: videos that were being made pick up where they stopped. */
export async function resumeDrama() {
  for (const e of db.listMakingDramaEpisodes()) {
    if (active.has(e.id)) continue;
    await startEpisode(e.organizationId, e.id).catch((err) => fail(e.organizationId, e.id, err instanceof Error ? err.message : String(err)));
  }
}

// ==========================================
// Character plates
// ==========================================

export const PLATES = ["Front, standing", "Walking", "Seated at a desk", "Side profile", "Waist-up", "Full body", "Green blazer", "Black suit", "Evening attire"];

/** Standard images of the owner made from her photos, so her face holds across long campaigns. */
export async function makePlates(orgId: number) {
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making images isn't connected yet: FAL_KEY is missing on the server." });
  const photos = await ownerPhotos(orgId);
  if (!photos.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add photos of yourself to the Brain first: front, both three-quarter angles, full body, seated and standing work best." });
  const emp = await elena(orgId);
  const cost = PLATES.length * PRICE.still;
  const spent = await spentThisMonth(orgId);
  if (spent + cost > avatar.settingsOf(emp).limitCents) throw new TRPCError({ code: "BAD_REQUEST", message: `The plates (about $${(cost / 100).toFixed(2)}) would go over your monthly limit.` });
  const refs = await Promise.all(photos.map(asInput));
  const plates: Plate[] = [];
  for (const p of PLATES) {
    const r = await falRun(MODELS.still, { prompt: `A clean character reference photo of the person in the reference images (the same person, same face, same skin tone, same hair): ${p}. Plain light gray studio background, soft even light, neutral expression, realistic skin texture, vertical photo. Keep the face exactly like the references.`, image_urls: refs, aspect_ratio: "3:4", num_images: 1, output_format: "png" }, 5);
    const url = r?.images?.[0]?.url;
    if (!url) continue;
    plates.push({ label: p, url: (await storagePut(`org-${orgId}/drama/plate-${plates.length + 1}-${Date.now()}.png`, await download(url), "image/png")).url });
  }
  saveSettings(orgId, { plates });
  // Plates count toward the month like any video.
  db.createDramaEpisode({ organizationId: orgId, number: 0, kind: "campaign", title: "Character plates", status: "ready", costCents: plates.length * PRICE.still, madeAt: new Date(), plan: JSON.stringify({ hidden: true }) });
  return plates;
}

// ==========================================
// For the screens and chat
// ==========================================

export function episodeView(e: DramaEpisode) {
  const shots = shotsOf(e);
  const secs = shots.reduce((t, x) => t + (x.seconds || 0), 0);
  const plan = planOf(e);
  return {
    id: e.id,
    kind: e.kind,
    number: e.number,
    title: e.title,
    logline: e.logline,
    beats: beatsOf(e),
    shots,
    status: e.status,
    progress: e.progress,
    videoUrl: e.videoUrl,
    versions: parse<Record<string, string>>(e.versions, {}),
    error: e.error,
    length: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
    cost: `${e.status === "ready" ? "" : "about "}$${(e.costCents / 100).toFixed(2)}`,
    animateCost: `about $${(estimateEpisode(shots) / 100).toFixed(2)}`,
    done: shots.filter((s) => s.clipUrl).length,
    stills: shots.filter((s) => s.stillUrl).length,
    plan: { goal: plan.goal ?? "", directions: plan.directions ?? [], chosen: plan.chosen ?? null, script: plan.script ?? "", cta: plan.cta ?? "", approved: Boolean(plan.approved) },
  };
}

const visible = (e: DramaEpisode) => !parse<{ hidden?: boolean }>(e.plan, {}).hidden;

export async function studio(orgId: number) {
  const series = db.getDramaSeries(orgId);
  const emp = await db.getEmployeeByKind(orgId, "video");
  const all = db.listDramaEpisodes(orgId).filter(visible);
  const st = settingsOf(orgId);
  const pics = await avatar.photos(orgId);
  const pack = new Set((await ownerPack(orgId)).map((p) => p.id));
  return {
    series: series && series.premise ? { title: series.title, premise: series.premise, look: series.look } : null,
    episodes: all.filter((e) => e.kind === "drama").map(episodeView),
    campaigns: all.filter((e) => e.kind === "campaign").map(episodeView),
    cast: db.listDramaCast(orgId).map((c) => ({ id: c.id, name: c.name, role: c.role, kind: c.kind, look: c.look, photoUrl: c.photoUrl, voiceId: c.voiceId, voiceName: c.voiceName })),
    photos: pics.map((p) => ({ id: p.id, title: p.title, url: p.url, mine: pack.has(p.id) })),
    plates: st.plates ?? [],
    styleRefs: st.styleRefs ?? [],
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

export async function savePack(orgId: number, ids: number[]) {
  const pics = await avatar.photos(orgId);
  saveSettings(orgId, { ownerPhotoIds: ids.filter((i) => pics.some((p) => p.id === i)) });
}

export function saveStyleRef(orgId: number, input: { id?: string; name: string; link: string; likes: string[]; words: string }) {
  const refs = settingsOf(orgId).styleRefs ?? [];
  const row: StyleRef = { id: input.id || Math.random().toString(36).slice(2, 10), name: input.name.trim().slice(0, 100), link: input.link.trim().slice(0, 500), likes: input.likes.slice(0, 8), words: input.words.trim().slice(0, 300) };
  const next = input.id && refs.some((r) => r.id === input.id) ? refs.map((r) => (r.id === input.id ? row : r)) : [...refs, row].slice(0, 40);
  saveSettings(orgId, { styleRefs: next });
  return row;
}
export function removeStyleRef(orgId: number, id: string) {
  saveSettings(orgId, { styleRefs: (settingsOf(orgId).styleRefs ?? []).filter((r) => r.id !== id) });
}

/** The owner's style references, as words for a plan. */
export function styleText(orgId: number) {
  const refs = settingsOf(orgId).styleRefs ?? [];
  if (!refs.length) return "";
  return `\nVideos the owner likes (match these qualities, never copy the videos):\n${refs.map((r) => `- ${r.name}${r.likes.length ? ` (${r.likes.join(", ")})` : ""}${r.words ? `: ${r.words}` : ""}`).join("\n")}`;
}

export async function dramaFacts(orgId: number) {
  const st = await studio(orgId);
  const camp = st.campaigns.map((c) => `"${c.title}" (${c.status}${c.status === "making" ? `, ${c.progress ?? ""}` : ""}, ${c.cost})`).join("; ");
  return `${st.series ? `\nMini drama series: ${st.series.title}. ${st.series.premise}
Cast: ${st.cast.map((c) => `${c.name} (${c.kind === "owner" ? "the owner" : c.kind === "team" ? "a LeadDash Employees team member" : "made up"}, ${c.role}, voice ${c.voiceName ?? "not picked"})`).join("; ")}
Episodes: ${st.episodes.map((e) => `${e.number}. ${e.title} (${e.status}${e.status === "making" ? `, ${e.progress ?? ""}` : ""}, ${e.cost})`).join("; ") || "none"}` : "\nNo drama series yet."}
Campaigns: ${camp || "none"}.
Character plates of the owner: ${st.plates.map((p) => p.label).join(", ") || "none yet (make_plates makes them)"}.
Spent this month on video: $${(st.spentCents / 100).toFixed(2)} of $${(st.limitCents / 100).toFixed(0)}.${styleText(orgId)}`;
}
