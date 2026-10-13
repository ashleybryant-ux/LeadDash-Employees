import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import * as hours from "../workHours";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import { transcribeFile } from "../_core/transcribe";
import { storagePut, storagePutStream, uploadsRoot } from "../storage";
import { videoEdits, type AIEmployee, type VideoEdit } from "../../drizzle/schema";
import { withUsage } from "../usage";
import * as broll from "./broll";
import * as styles from "./styles";
import { systemPromptFor } from "./tasks";
import { EMOJIS, EMOJI_NAMES, editAss, placeOf } from "./editCaptions";
import { cutSource, renderEdit, type EditRenderInput, type Emoji } from "./editRender";
import {
  CAP_STYLES,
  DEFAULT_EDIT_LOOK,
  LAYOUT_LABEL,
  cutLength,
  cutLines,
  editLookOf,
  editMinutes,
  greenMinutes,
  keepRanges,
  linesFrom,
  linesOf,
  piecesOf,
  spreadWords,
  type BrollPick,
  type EditLine,
  type EditLook,
  type EWord,
} from "./editLook";
import { AUTO_BACK, AUTO_INTO, TRANSITIONS, TRANS_KEYS, isTrans, type TransKey } from "./transitions";

/**
 * Edit my video: someone uploads a video of themselves talking (up to 30 minutes) and Elena edits it.
 * 1. Prepare: made into a plain MP4 and a small preview, captioned word by word (AssemblyAI), split
 *    into lines, and read once by Elena: a title, a post caption, a hook title, b-roll for the lines
 *    that describe something you can show (library first, then stock), a transition at every change,
 *    lines to punch in on, emojis, and earlier takes of a line said again.
 * 2. Edit: every choice changes what the preview shows at once; nothing is cut yet.
 * 3. Export: ffmpeg cuts every size from one job (editRender.ts).
 * Work hours: 2 for each minute of the finished video, once; green screen 2 more for each minute of
 * the upload (fal.ai cuts the person out once); a new AI clip as anywhere else. Library and stock use none.
 */

const run = promisify(execFile);

export const MAX_SECONDS = 30 * 60;
export type ESize = "vertical" | "square" | "wide";
export const SIZES: Record<ESize, { w: number; h: number; ratio: string }> = {
  vertical: { w: 1080, h: 1920, ratio: "9:16" },
  square: { w: 1080, h: 1080, ratio: "1:1" },
  wide: { w: 1920, h: 1080, ratio: "16:9" },
};

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const sizesOf = (e: Pick<VideoEdit, "sizes">): ESize[] => {
  const list = parse<string[]>(e.sizes, []).filter((s): s is ESize => s in SIZES);
  return list.length ? Array.from(new Set(list)) : ["vertical"];
};
const urlsOf = (e: Pick<VideoEdit, "videoUrls">) => parse<Partial<Record<ESize, string>>>(e.videoUrls, {});
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const secondsOf = (e: Pick<VideoEdit, "tenths">) => (e.tenths ?? 0) / 10;
const shapeOf = (w: number, h: number): ESize => (w > h * 1.15 ? "wide" : h > w * 1.15 ? "vertical" : "square");

// ==========================================
// Rows (every read and write is by workspace)
// ==========================================

export function get(orgId: number, id: number) {
  return db.getDb().select().from(videoEdits).where(and(eq(videoEdits.id, id), eq(videoEdits.organizationId, orgId))).get() ?? null;
}
export function list(orgId: number) {
  const rows = db.getDb().select().from(videoEdits).where(eq(videoEdits.organizationId, orgId)).orderBy(desc(videoEdits.id)).all();
  // A job a restart stopped would sit forever: after 45 minutes with nothing running it didn't finish.
  for (const r of rows) {
    const stale = Date.now() - new Date(r.updatedAt).getTime() > 45 * 60_000;
    if ((r.status === "preparing" || r.status === "making") && !jobs.has(r.id) && stale) {
      Object.assign(r, update(orgId, r.id, { status: r.status === "making" ? "draft" : "failed", step: null, error: r.status === "making" ? "The export stopped before it finished. Press Export to try again." : "It stopped before the video was ready. Upload it again." }));
    } else if (r.step && r.status === "draft" && !jobs.has(r.id) && stale) Object.assign(r, update(orgId, r.id, { step: null }));
  }
  return rows;
}
function update(orgId: number, id: number, data: Partial<typeof videoEdits.$inferInsert>) {
  db.getDb().update(videoEdits).set({ ...data, updatedAt: new Date() }).where(and(eq(videoEdits.id, id), eq(videoEdits.organizationId, orgId))).run();
  return get(orgId, id)!;
}
function must(orgId: number, id: number) {
  const e = get(orgId, id);
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "That video is not in this workspace." });
  return e;
}
function editable(e: VideoEdit) {
  if (e.status === "preparing") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the video is ready to edit." });
  if (e.status === "making") throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the export finishes." });
  if (e.step) throw new TRPCError({ code: "BAD_REQUEST", message: `Wait a moment: ${e.step.toLowerCase()}.` });
}
export function remove(orgId: number, id: number) {
  const e = must(orgId, id);
  if (e.status === "making" || jobs.has(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until it finishes." });
  db.getDb().delete(videoEdits).where(and(eq(videoEdits.id, id), eq(videoEdits.organizationId, orgId))).run();
}
const saveLines = (orgId: number, id: number, lines: EditLine[]) => update(orgId, id, { lines: JSON.stringify(lines) });
const saveLook = (orgId: number, id: number, look: EditLook) => update(orgId, id, { look: JSON.stringify(look) });

async function elena(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Elena is not in this workspace." });
  return emp;
}
async function brand(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const colors = parse<string[]>(org?.brandColors, []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const logo = org?.logoUrl?.startsWith("/files/") && fs.existsSync(broll.localFile(org.logoUrl)) ? broll.localFile(org.logoUrl) : null;
  return { color: colors[0] ?? null, logo };
}
async function chargeNow(orgId: number, emp: { id: number; kind: AIEmployee["kind"] }, job: hours.JobKey, count: number, label: string) {
  if (count <= 0) return 0;
  return withUsage({ orgId, employeeId: emp.id, kind: emp.kind }, async () => {
    const minutes = await hours.charge(orgId, emp.id, job, count, label);
    if (minutes > 0) await db.recordEmployeeTask(emp.id, orgId, minutes);
    return minutes;
  });
}
async function say(orgId: number, content: string, cards: unknown[] = []) {
  const emp = await db.getEmployeeByKind(orgId, "video");
  if (!emp) return;
  await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: JSON.stringify(cards) });
}

const jobs = new Map<number, Promise<unknown>>();
/** The background job for an edit, if one is running (tests wait on it). */
export const jobFor = (id: number) => jobs.get(id) ?? null;
function background(id: number, fn: () => Promise<unknown>) {
  const job = fn().finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}

/** A short job (Elena reading, translating, finding clips) that shows its step on the editor while it runs. */
function busy(orgId: number, id: number, step: string, fn: () => Promise<void>) {
  update(orgId, id, { step, error: null });
  void background(id, async () => {
    try {
      await fn();
      update(orgId, id, { step: null });
    } catch (err) {
      update(orgId, id, { step: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  });
  return get(orgId, id)!;
}

// ==========================================
// 1. Upload and prepare
// ==========================================

/** Where a large upload is held while it arrives in parts (outside the served files). */
export function holdingPath(orgId: number, uploadId: string) {
  const dir = path.join(uploadsRoot(), "..", "ld-edit-uploads");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `org-${orgId}-${uploadId}.part`);
}

const cleanName = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** The whole upload arrived: a new edit, prepared in the background. */
export function startFromUpload(orgId: number, input: { file: string; name: string; by: string }) {
  const row = db
    .getDb()
    .insert(videoEdits)
    .values({ organizationId: orgId, title: cleanName(input.name).slice(0, 80) || "My video", status: "preparing", step: "Reading your video", look: JSON.stringify(DEFAULT_EDIT_LOOK), createdBy: input.by })
    .returning()
    .get();
  void background(row.id, () => prepare(orgId, row.id, input.file));
  return row;
}

async function storeFile(relKey: string, file: string) {
  return storagePutStream(relKey, fs.createReadStream(file), 5_000_000_000);
}

/** Made playable, captioned and read by Elena; the editor opens ready. */
async function prepare(orgId: number, id: number, raw: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-prep-"));
  const ff = (await import("./drama")).ffmpegPath();
  try {
    const p = await broll.probe(raw);
    if (!p.video) throw new Error("Upload an MP4 or MOV video.");
    if (!p.audio) throw new Error("That video has no sound. Upload a video of you talking.");
    if (p.seconds > MAX_SECONDS + 1) throw new Error(`Videos can be up to 30 minutes. This one is ${fmtTime(p.seconds)}.`);
    const long = Math.max(10, Math.ceil(p.seconds / 60) * 3) * 60_000;
    update(orgId, id, { step: "Getting it ready to play" });
    const mp4 = path.join(dir, "source.mp4");
    await run(ff, ["-y", "-loglevel", "error", "-i", raw, "-vf", "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)',fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", mp4], { maxBuffer: 20 * 1024 * 1024, timeout: long }).catch((e) => {
      throw new Error(`That video couldn't be read: ${String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(-1)[0].slice(0, 200)}`);
    });
    const preview = path.join(dir, "preview.mp4");
    await run(ff, ["-y", "-loglevel", "error", "-i", mp4, "-vf", "scale='if(gt(iw,ih),-2,min(480,iw))':'if(gt(iw,ih),min(480,ih),-2)'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", preview], { maxBuffer: 20 * 1024 * 1024, timeout: long });
    const thumb = path.join(dir, "thumb.jpg");
    await run(ff, ["-y", "-loglevel", "error", "-ss", String(Math.min(1, p.seconds / 2)), "-i", mp4, "-frames:v", "1", "-vf", "scale=360:-2", thumb], { timeout: 60_000 }).catch(() => null);
    const out = await broll.probe(mp4);
    const source = await storeFile(`org-${orgId}/edits/source.mp4`, mp4);
    const prev = await storeFile(`org-${orgId}/edits/preview.mp4`, preview);
    const still = fs.existsSync(thumb) ? await storagePut(`org-${orgId}/edits/thumb.jpg`, fs.readFileSync(thumb), "image/jpeg") : null;
    const shape = shapeOf(out.width, out.height);
    update(orgId, id, { sourceUrl: source.url, previewUrl: prev.url, thumbUrl: still?.url ?? null, width: out.width, height: out.height, tenths: Math.round(out.seconds * 10), sizes: JSON.stringify([shape]), step: "Writing captions" });

    const audio = path.join(dir, "voice.mp3");
    await run(ff, ["-y", "-loglevel", "error", "-i", mp4, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio], { timeout: long });
    const t = await transcribeFile(fs.readFileSync(audio), { timeoutMs: Math.max(20, Math.ceil(out.seconds / 60) * 2) * 60_000 });
    if (!t.words.length) throw new Error("I couldn't hear any words in that video. Edit my video is for videos of you talking.");
    const lines = linesFrom(t.words.map((w) => ({ text: w.text, start: +w.start.toFixed(3), end: +w.end.toFixed(3) })));
    saveLines(orgId, id, lines);

    update(orgId, id, { step: "Elena is picking b-roll and transitions" });
    const e = get(orgId, id)!;
    await readVideo(orgId, e, { first: true });
    update(orgId, id, { status: "draft", step: null, error: null });
    const done = get(orgId, id)!;
    const look = editLookOf(done.look);
    const used = linesOf(done.lines).filter((l) => l.broll).length;
    await say(orgId, `"${done.title}" is ready to edit: ${fmtTime(secondsOf(done))}, ${linesOf(done.lines).length} lines, captions in ${CAP_STYLES[look.captions.style]}. ${used ? `I added b-roll to ${used} lines with a transition at every change` : "I kept you on screen the whole way (no b-roll matched yet)"}, and cut the long pauses. Open it on my Videos tab to change anything, then press Export.`, [{ type: "video_edit", id, title: done.title }]);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    update(orgId, id, { status: "failed", step: null, error: msg });
    await say(orgId, `I couldn't get your video ready: ${msg}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(raw, { force: true });
  }
}

// ==========================================
// Elena reads the video
// ==========================================

const numbered = (lines: EditLine[]) => lines.map((l, i) => `${i + 1}. [${fmtTime(l.from)}] ${l.text}`).join("\n");
const lineNo = { type: "integer", description: "The number of the line." } as const;
const READ_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "caption", "hook", "broll", "zoom", "emoji", "drop"],
  properties: {
    title: { type: "string", description: "A short name for the video, at most 6 words." },
    caption: { type: "string", description: "The post caption: one or two plain sentences and up to 3 hashtags." },
    hook: { type: "string", description: "A bold hook title for the first 3 seconds, at most 7 words, that makes someone stop scrolling." },
    broll: {
      type: "array",
      description: "Lines that describe something you can show, for b-roll over the line.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["line", "see", "query", "into", "back"],
        properties: {
          line: lineNo,
          see: { type: "string", description: "What the footage shows, concrete and visual, no readable words or screens, never a real client." },
          query: { type: "string", description: "2 to 4 words to search stock footage." },
          into: { type: "string", enum: TRANS_KEYS, description: "The transition from the speaker into the b-roll." },
          back: { type: "string", enum: TRANS_KEYS, description: "The transition from the b-roll back to the speaker." },
        },
      },
    },
    zoom: { type: "array", items: lineNo, description: "Lines with a key point to punch in on (about one in four)." },
    emoji: { type: "array", items: { type: "object", additionalProperties: false, required: ["line", "name"], properties: { line: lineNo, name: { type: "string", enum: EMOJI_NAMES } } }, description: "About one line in five gets an emoji that fits it." },
    drop: { type: "array", items: lineNo, description: "Bad takes: an earlier try of a line the speaker says again right after, or a false start. Never a line said only once." },
  },
};

type ReadOut = { title: string; caption: string; hook: string; broll: { line: number; see: string; query: string; into: string; back: string }[]; zoom: number[]; emoji: { line: number; name: string }[]; drop: number[] };

/** How many b-roll lines fit: about one in three, at most one every 8 seconds. */
const brollTarget = (lines: EditLine[]) => {
  const span = lines.length ? lines[lines.length - 1].to - lines[0].from : 0;
  return Math.max(1, Math.min(Math.round(lines.length / 3), Math.floor(span / 8)));
};

/** Elena reads the transcript once: title, caption, hook, b-roll, zooms, emojis and bad takes. Only b-roll when `brollOnly`. */
async function readVideo(orgId: number, e: VideoEdit, opts: { first?: boolean; brollOnly?: boolean } = {}) {
  const lines = linesOf(e.lines);
  if (!lines.length) return;
  const emp = await elena(orgId);
  const target = brollTarget(lines);
  const { system } = await systemPromptFor(emp, `Edit a talking video like a social media editor. Choose about ${target} lines for b-roll (never line 1, the hook stays on the speaker), spread through the video, only lines that describe something you can show. For each, pick the transition into it and back that fits the moment (energetic lines: zoomblur, whip, glitch; calm lines: fade, lightleak, slide).`);
  const out = await generateJson<ReadOut>({ system, prompt: numbered(lines), schemaName: "video_edit_read", schema: READ_SCHEMA, maxTokens: Math.min(32000, 3000 + lines.length * 40), timeoutMs: 5 * 60_000 });
  const fresh = linesOf(get(orgId, e.id)!.lines);
  const at = (n: number) => (Number.isInteger(n) && n >= 1 && n <= fresh.length ? n - 1 : -1);
  if (!opts.brollOnly) {
    const zoom = new Set((out.zoom ?? []).map(at));
    const emoji = new Map((out.emoji ?? []).filter((x) => x.name in EMOJIS).map((x) => [at(x.line), x.name] as const));
    const drop = new Set((out.drop ?? []).map(at));
    fresh.forEach((l, i) => {
      l.zoom = zoom.has(i);
      l.emoji = emoji.get(i) ?? null;
      l.drop = drop.has(i) && i < fresh.length - 1;
    });
  }
  // Elena's b-roll replaces only hers; b-roll someone picked stays.
  fresh.forEach((l) => {
    if (l.auto) {
      l.broll = null;
      l.auto = false;
    }
    if (l.tr?.auto) l.tr = null;
  });
  const look = editLookOf(get(orgId, e.id)!.look);
  if (look.tools.autoBroll) await fillBroll(orgId, e, fresh, (out.broll ?? []).slice(0, target + 2).map((b) => ({ ...b, i: at(b.line) })).filter((b) => b.i > 0));
  saveLines(orgId, e.id, fresh);
  if (opts.first) {
    look.tools.hook.text = (out.hook ?? "").trim().slice(0, 80);
    saveLook(orgId, e.id, look);
    update(orgId, e.id, { caption: (out.caption ?? "").trim().slice(0, 600), title: e.title && e.title !== "My video" && !/^(img|vid|mov|pxl|dsc)\s?\d/i.test(e.title) ? e.title : (out.title ?? "").trim().slice(0, 80) || e.title });
  }
}

/** B-roll for the lines Elena picked: the library first, then stock. A line nothing fits stays on the speaker. */
async function fillBroll(orgId: number, e: VideoEdit, lines: EditLine[], picks: { i: number; see: string; query: string; into: string; back: string }[]) {
  const size = sizesOf(e)[0];
  const clips = broll.readyClips(orgId);
  const used = new Set<number>();
  const want = picks.filter((p) => p.i >= 0 && p.i < lines.length && !lines[p.i].broll);
  const found: { p: (typeof want)[number]; pick: BrollPick | null }[] = want.map((p) => {
    const c = broll.bestClip(clips, `${p.see} ${p.query}`, size, used);
    if (c) {
      used.add(c.id);
      return { p, pick: { src: "library", clipId: c.id, file: c.url!, thumb: c.thumbUrl, name: c.title } as BrollPick };
    }
    return { p, pick: null };
  });
  // Stock, four at a time.
  const need = found.filter((f) => !f.pick);
  const seen = new Set<string>();
  for (let k = 0; k < need.length && broll.hasStock(); k += 4) {
    await Promise.all(
      need.slice(k, k + 4).map(async (f) => {
        const list = await broll.stockList(f.p.query || f.p.see, size, 4).catch(() => []);
        const s = list.find((x) => !seen.has(x.url));
        if (!s) return;
        seen.add(s.url);
        const file = await broll.keepStock(orgId, e.id, s).catch(() => null);
        if (file) f.pick = { src: "stock", file, thumb: s.thumb, name: f.p.query || "Stock clip", credit: s.credit, page: s.page };
      })
    );
  }
  for (const f of found) {
    if (!f.pick) continue;
    const l = lines[f.p.i];
    l.broll = f.pick;
    l.auto = true;
    l.tr = { key: isTrans(f.p.into) ? f.p.into : AUTO_INTO[f.p.i % AUTO_INTO.length], auto: true };
    const next = lines[f.p.i + 1];
    if (next && !next.broll && !next.tr) next.tr = { key: isTrans(f.p.back) ? f.p.back : AUTO_BACK[f.p.i % AUTO_BACK.length], auto: true };
  }
  const ids = found.map((f) => f.pick?.clipId).filter((x): x is number => typeof x === "number");
  if (ids.length) broll.markUsed(orgId, ids);
}

/** Redo auto b-roll: Elena picks again (b-roll someone chose stays). */
export function redoAutoBroll(orgId: number, id: number) {
  const e = must(orgId, id);
  editable(e);
  return busy(orgId, id, "Elena is picking b-roll", () => readVideo(orgId, e, { brollOnly: true }));
}

// ==========================================
// 2. Editing
// ==========================================

export type LookPatch = {
  captions?: Partial<EditLook["captions"]>;
  tools?: Partial<Omit<EditLook["tools"], "hook" | "translate">> & { hook?: Partial<EditLook["tools"]["hook"]>; translate?: Partial<EditLook["tools"]["translate"]> };
  music?: Partial<EditLook["music"]>;
  transition?: Partial<EditLook["transition"]>;
  layout?: { kind?: EditLook["layout"]["kind"]; split?: Partial<EditLook["layout"]["split"]>; green?: Partial<EditLook["layout"]["green"]>; pip?: Partial<EditLook["layout"]["pip"]> };
  logo?: Partial<EditLook["logo"]>;
};

/** Saves a change to the look. Turning a tool on that needs Elena (auto b-roll, translate) runs it in the background. */
export async function changeLook(orgId: number, id: number, patch: LookPatch) {
  const e = must(orgId, id);
  editable(e);
  const old = editLookOf(e.look);
  const next: EditLook = {
    ...old,
    captions: { ...old.captions, ...(patch.captions ?? {}) },
    tools: { ...old.tools, ...(patch.tools ?? {}), hook: { ...old.tools.hook, ...(patch.tools?.hook ?? {}) }, translate: { ...old.tools.translate, ...(patch.tools?.translate ?? {}) } },
    music: { ...old.music, ...(patch.music ?? {}) },
    transition: { ...old.transition, ...(patch.transition ?? {}) },
    layout: { kind: patch.layout?.kind ?? old.layout.kind, split: { ...old.layout.split, ...(patch.layout?.split ?? {}) }, green: { ...old.layout.green, ...(patch.layout?.green ?? {}) }, pip: { ...old.layout.pip, ...(patch.layout?.pip ?? {}) } },
    logo: { ...old.logo, ...(patch.logo ?? {}) },
  };
  if (next.music.track === "upload" && !next.music.url) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload a track first." });
  if (next.layout.split.other === "clip" && !next.layout.split.clipId && next.layout.kind === "split") throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the clip for the other half." });
  if (next.layout.split.other === "video" && !next.layout.split.videoUrl && next.layout.kind === "split") throw new TRPCError({ code: "BAD_REQUEST", message: "Upload your second video first." });
  if (next.layout.kind === "green") {
    const g = next.layout.green;
    if (g.bg === "clip" && !g.clipId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the clip to put behind you." });
    if (g.bg === "picture" && !g.url) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload the picture to put behind you." });
    if (g.bg === "color" && !/^#[0-9a-f]{6}$/i.test(g.color)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a color." });
    if (g.bg === "style" && (g.style !== old.layout.green.style || (g.place ?? "") !== (old.layout.green.place ?? ""))) g.drawn = null;
  }
  let saved = saveLook(orgId, id, next);
  const lines = linesOf(saved.lines);
  // Auto b-roll off: Elena's b-roll comes out (b-roll someone chose stays). On: she picks again.
  if (old.tools.autoBroll && !next.tools.autoBroll) {
    lines.forEach((l) => {
      if (l.auto) {
        l.broll = null;
        l.auto = false;
      }
      if (l.tr?.auto && !l.broll) l.tr = null;
    });
    saved = saveLines(orgId, id, lines);
  }
  if (!old.tools.autoBroll && next.tools.autoBroll) return busy(orgId, id, "Elena is picking b-roll", () => readVideo(orgId, saved, { brollOnly: true }));
  if (next.tools.translate.on && (!old.tools.translate.on || old.tools.translate.lang !== next.tools.translate.lang || lines.some((l) => !l.tx))) return busy(orgId, id, `Translating captions into ${next.tools.translate.lang}`, () => translate(orgId, id, next.tools.translate.lang));
  if (next.layout.kind === "green" && next.layout.green.bg === "style" && !next.layout.green.drawn) return busy(orgId, id, "Drawing the background", () => drawBackground(orgId, id));
  if (next.layout.kind === "green" && !saved.cutoutUrl && !cutting.has(id)) startCutout(orgId, id);
  return get(orgId, id)!;
}

/** Fix a line's words (what Elena heard wrong). The voice doesn't change. */
export function saveLine(orgId: number, id: number, n: number, text: string) {
  const e = must(orgId, id);
  editable(e);
  const lines = linesOf(e.lines);
  const l = lines[n];
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That line is not in this video." });
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "A line needs words. To cut it, turn on Remove bad takes or trim the video." });
  if (t !== l.text) {
    l.text = t.slice(0, 400);
    l.words = spreadWords(l.text, l.from, l.to);
    l.tx = null;
  }
  return saveLines(orgId, id, lines);
}

export type BrollInput = { src: "library"; clipId: number } | { src: "stock"; url: string; page: string; thumb: string; credit: string; query: string } | { src: "none" };

/** Put b-roll over a line, change it, or take it off. */
export async function setBroll(orgId: number, id: number, n: number, input: BrollInput) {
  const e = must(orgId, id);
  editable(e);
  const lines = linesOf(e.lines);
  const l = lines[n];
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That line is not in this video." });
  if (input.src === "none") {
    l.broll = null;
    l.auto = false;
    if (l.tr?.auto) l.tr = null;
    const next = lines[n + 1];
    if (next?.tr?.auto && !next.broll) next.tr = null;
  } else if (input.src === "library") {
    const c = broll.getClip(orgId, input.clipId);
    if (!c || c.status !== "ready" || !c.url) throw new TRPCError({ code: "NOT_FOUND", message: "That clip is not in your b-roll library." });
    l.broll = { src: "library", clipId: c.id, file: c.url, thumb: c.thumbUrl, name: c.title };
    broll.markUsed(orgId, [c.id]);
  } else {
    if (!/^https:\/\//.test(input.url)) throw new TRPCError({ code: "BAD_REQUEST", message: "That stock clip is not valid." });
    const file = await broll.keepStock(orgId, id, { url: input.url, page: input.page, thumb: input.thumb, credit: input.credit, seconds: 0, width: 0, height: 0 });
    l.broll = { src: "stock", file, thumb: input.thumb, name: input.query.slice(0, 60) || "Stock clip", credit: input.credit, page: input.page };
  }
  if (input.src !== "none") {
    l.auto = false;
    const look = editLookOf(e.look);
    if (!l.tr) l.tr = { key: AUTO_INTO[n % AUTO_INTO.length], auto: true };
    const next = lines[n + 1];
    if (next && !next.broll && !next.tr && look.tools.transitions) next.tr = { key: AUTO_BACK[n % AUTO_BACK.length], auto: true };
  }
  return saveLines(orgId, id, lines);
}

/** A new AI clip for a line: made in the background and saved to the b-roll library (2 work hours for each 5 seconds). */
export async function aiClip(orgId: number, id: number, n: number, see: string, by: string) {
  const e = must(orgId, id);
  editable(e);
  const l = linesOf(e.lines)[n];
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That line is not in this video." });
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Making AI clips isn't set up on the server yet. LeadDash support can turn it on." });
  await hours.gate(orgId);
  const seconds: 5 | 10 = l.to - l.from > 5.5 ? 10 : 5;
  const emp = await elena(orgId);
  const prompt = see.trim() || l.text;
  return busy(orgId, id, "Making a new AI clip", async () => {
    const clip = await broll.makeClip(orgId, { prompt, title: prompt.split(/[.,;]/)[0].slice(0, 60), tags: prompt, size: sizesOf(e)[0], seconds, by });
    await chargeNow(orgId, emp, "clip", broll.clipUnits(seconds), `AI clip for "${e.title}"`);
    const lines = linesOf(get(orgId, id)!.lines);
    if (lines[n]) {
      lines[n].broll = { src: "ai", clipId: clip.id, file: clip.url!, thumb: clip.thumbUrl, name: clip.title };
      lines[n].auto = false;
      if (!lines[n].tr) lines[n].tr = { key: AUTO_INTO[n % AUTO_INTO.length], auto: true };
      saveLines(orgId, id, lines);
    }
  });
}

/** Change the transition at one change, or use it at every change. */
export function setTransition(orgId: number, id: number, n: number, key: TransKey, opts: { every?: boolean; speed?: EditLook["transition"]["speed"] } = {}) {
  const e = must(orgId, id);
  editable(e);
  if (!isTrans(key)) throw new TRPCError({ code: "BAD_REQUEST", message: "That transition is not one we have." });
  const lines = linesOf(e.lines);
  if (!lines[n]) throw new TRPCError({ code: "NOT_FOUND", message: "That line is not in this video." });
  const look = editLookOf(e.look);
  if (opts.every) {
    for (const i of changesOf(lines, look, secondsOf(e))) lines[i].tr = { key, auto: false };
  } else lines[n].tr = { key, auto: false };
  if (opts.speed) saveLook(orgId, id, { ...look, transition: { ...look.transition, speed: opts.speed } });
  return saveLines(orgId, id, lines);
}

/** The lines where the picture changes (where a transition plays). */
export function changesOf(lines: EditLine[], look: EditLook, seconds: number) {
  const ranges = keepRanges(lines, look, seconds);
  const cut = cutLines(lines, look, ranges);
  return piecesOf(cut, { ...look, tools: { ...look.tools, transitions: true } }, cutLength(ranges)).slice(1).map((p) => p.line);
}

export function rename(orgId: number, id: number, input: { title?: string; caption?: string }) {
  const e = must(orgId, id);
  return update(orgId, id, { title: input.title?.trim().slice(0, 80) || e.title, caption: input.caption != null ? input.caption.trim().slice(0, 1000) : e.caption });
}

const TRANSLATE_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, required: ["lines"], properties: { lines: { type: "array", items: { type: "string" }, description: "Every line translated, in the same order, one for one." } } };

async function translate(orgId: number, id: number, lang: string) {
  const lines = linesOf(get(orgId, id)!.lines);
  const out: string[] = [];
  // In parts of 120 lines, so a 30 minute video still fits.
  for (let k = 0; k < lines.length; k += 120) {
    const part = lines.slice(k, k + 120);
    const r = await generateJson<{ lines: string[] }>({
      system: `Translate on-screen captions into ${lang}. Keep each line short and natural for captions, the same meaning, one translated line for each line given, in order. Return exactly ${part.length} lines.`,
      prompt: part.map((l, i) => `${i + 1}. ${l.text}`).join("\n"),
      schemaName: "caption_translation",
      schema: TRANSLATE_SCHEMA,
      maxTokens: 200 + part.length * 60,
      timeoutMs: 4 * 60_000,
    });
    part.forEach((l, i) => out.push((r.lines?.[i] ?? "").replace(/^\d+\.\s*/, "").trim() || l.text));
  }
  const fresh = linesOf(get(orgId, id)!.lines);
  fresh.forEach((l, i) => (l.tx = out[i] ?? null));
  saveLines(orgId, id, fresh);
}

async function drawBackground(orgId: number, id: number) {
  const e = get(orgId, id)!;
  const look = editLookOf(e.look);
  const g = look.layout.green;
  const st = styles.resolve(orgId, g.style || "studio");
  const ratio = styles.RATIO[sizesOf(e)[0]];
  const url = await styles.draw(orgId, { prompt: `${st.prompt || "Realistic photo"}. An empty background behind a person on camera: ${g.place?.trim() || "a bright modern office"}. No people. Soft depth of field. No text, letters, words, logos or watermarks anywhere.`, ratio, refs: st.refs, name: "background" });
  const fresh = editLookOf(get(orgId, id)!.look);
  fresh.layout.green.drawn = url;
  saveLook(orgId, id, fresh);
}

// ==========================================
// Green screen (fal.ai cuts the person out)
// ==========================================

const cutting = new Map<number, Promise<void>>();
export const cutoutJobFor = (id: number) => cutting.get(id) ?? null;
const CUTOUT_MODEL = "veed/video-background-removal";

/** A file on this server uploaded to fal.ai's storage, for models that read long videos. */
export async function falUpload(file: string, contentType: string) {
  const size = fs.statSync(file).size;
  const auth = { authorization: `Key ${ENV.falKey}` };
  const multipart = size > 90 * 1024 * 1024;
  const init = await fetch(`https://rest.fal.ai/storage/upload/${multipart ? "initiate-multipart" : "initiate"}?storage_type=fal-cdn-v3`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ content_type: contentType, file_name: path.basename(file) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!init.ok) throw new Error(`fal.ai upload didn't start (${init.status})`);
  const { upload_url, file_url } = (await init.json()) as { upload_url: string; file_url: string };
  if (!multipart) {
    const put = await fetch(upload_url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(fs.readFileSync(file)), signal: AbortSignal.timeout(15 * 60_000) });
    if (!put.ok) throw new Error(`fal.ai upload failed (${put.status})`);
    return file_url;
  }
  const u = new URL(upload_url);
  const chunk = 10 * 1024 * 1024;
  const fd = fs.openSync(file, "r");
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let i = 0, off = 0; off < size; i++, off += chunk) {
      const buf = Buffer.alloc(Math.min(chunk, size - off));
      fs.readSync(fd, buf, 0, buf.length, off);
      let ok: { partNumber: number; etag: string } | null = null;
      for (let tries = 0; tries < 3 && !ok; tries++) {
        const r = await fetch(`${u.origin}${u.pathname}/${i + 1}${u.search}`, { method: "PUT", body: new Uint8Array(buf), signal: AbortSignal.timeout(5 * 60_000) }).catch(() => null);
        if (r?.ok) ok = (await r.json()) as { partNumber: number; etag: string };
      }
      if (!ok) throw new Error("fal.ai upload failed partway.");
      parts.push(ok);
    }
  } finally {
    fs.closeSync(fd);
  }
  const done = await fetch(`${u.origin}${u.pathname}/complete${u.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }), signal: AbortSignal.timeout(120_000) });
  if (!done.ok) throw new Error(`fal.ai upload didn't finish (${done.status})`);
  return file_url;
}

/** Whether a video is a black and white matte (no color at all), from one frame. */
export async function isMatte(file: string) {
  const ff = (await import("./drama")).ffmpegPath();
  const { stderr } = await run(ff, ["-hide_banner", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", "signalstats,metadata=print:key=lavfi.signalstats.SATAVG", "-f", "null", "-"], { timeout: 60_000 }).catch((e) => ({ stderr: String(e.stderr ?? "") }));
  const m = stderr.match(/SATAVG=([\d.]+)/);
  return m ? Number(m[1]) < 1.5 : false;
}

/** Cuts the person out of the whole upload once (green screen). Work hours are used when it's done. */
export function startCutout(orgId: number, id: number) {
  const e = must(orgId, id);
  if (!e.sourceUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the video is ready." });
  if (e.cutoutUrl || cutting.has(id)) return e;
  if (!ENV.falKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Green screen isn't set up on the server yet. LeadDash support can turn it on." });
  const job = (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-cutout-"));
    try {
      await hours.gate(orgId);
      const emp = await elena(orgId);
      const drama = await import("./drama");
      const url = await falUpload(broll.localFile(e.sourceUrl!), "video/mp4");
      const r = await drama.falRun(CUTOUT_MODEL, { video_url: url, output_codec: "h264", refine_foreground_edges: true, subject_is_person: true }, 180);
      const files = ((r?.video ?? []) as { url: string }[]).map((f) => f.url).filter(Boolean);
      if (files.length < 2) throw new Error("The cutout didn't come back.");
      const local: string[] = [];
      for (let k = 0; k < 2; k++) {
        const u = files[k];
        const res = await fetch(u, { signal: AbortSignal.timeout(20 * 60_000) });
        if (!res.ok) throw new Error(`Couldn't download the cutout (${res.status}).`);
        const f = path.join(dir, `part${k}.mp4`);
        fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
        local.push(f);
      }
      const [rgb, matte] = (await isMatte(local[0])) ? [local[1], local[0]] : [local[0], local[1]];
      // A preview with a see-through background, for the editor.
      const ff = drama.ffmpegPath();
      const prev = path.join(dir, "preview.webm");
      await run(ff, ["-y", "-loglevel", "error", "-i", rgb, "-i", matte, "-filter_complex", "[0:v]format=yuv420p[c];[1:v]format=gray[m];[c][m]alphamerge,scale='if(gt(iw,ih),-2,min(480,iw))':'if(gt(iw,ih),min(480,ih),-2)',format=yuva420p[v]", "-map", "[v]", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "38", "-deadline", "realtime", "-cpu-used", "8", "-an", prev], { maxBuffer: 20 * 1024 * 1024, timeout: 60 * 60_000 }).catch(() => null);
      const sRgb = await storeFile(`org-${orgId}/edits/cutout.mp4`, rgb);
      const sMatte = await storeFile(`org-${orgId}/edits/matte.mp4`, matte);
      const sPrev = fs.existsSync(prev) ? await storeFile(`org-${orgId}/edits/cutout.webm`, prev) : null;
      update(orgId, id, { cutoutUrl: sRgb.url, matteUrl: sMatte.url, cutoutPreviewUrl: sPrev?.url ?? null });
      await chargeNow(orgId, emp, "green", greenMinutes(secondsOf(e)) / hours.JOBS.green.minutes, `Green screen for "${e.title}"`);
      const look = editLookOf(get(orgId, id)!.look);
      delete (look.layout.green as { error?: string }).error;
      saveLook(orgId, id, look);
    } catch (err) {
      const look = editLookOf(get(orgId, id)!.look);
      (look.layout.green as { error?: string }).error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      saveLook(orgId, id, look);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      cutting.delete(id);
    }
  })();
  cutting.set(id, job);
  return get(orgId, id)!;
}

// ==========================================
// Short clips
// ==========================================

const CLIPS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["first", "last", "title", "hook"],
        properties: { first: lineNo, last: lineNo, title: { type: "string", description: "At most 6 words." }, hook: { type: "string", description: "A hook title for its first 3 seconds, at most 7 words." } },
      },
    },
  },
};

/** Short clips: Elena finds the best 30 to 60 seconds (up to 3) and makes each its own video to edit and export. */
export function shortClips(orgId: number, id: number) {
  const e = must(orgId, id);
  editable(e);
  const lines = linesOf(e.lines);
  if (secondsOf(e) < 45) throw new TRPCError({ code: "BAD_REQUEST", message: "This video is already short. Short clips are for videos over 45 seconds." });
  return busy(orgId, id, "Elena is finding short clips", async () => {
    const emp = await elena(orgId);
    const { system } = await systemPromptFor(emp, "Find up to 3 parts of this talking video that work as short social clips on their own: 30 to 60 seconds each, opening with a strong line, ending on a finished thought. They may not overlap.");
    const out = await generateJson<{ clips: { first: number; last: number; title: string; hook: string }[] }>({ system, prompt: numbered(lines), schemaName: "short_clips", schema: CLIPS_SCHEMA, maxTokens: 1500, timeoutMs: 3 * 60_000 });
    const look = editLookOf(e.look);
    const made: string[] = [];
    for (const c of (out.clips ?? []).slice(0, 3)) {
      const a = Math.max(0, Math.min(lines.length - 1, Math.round(c.first) - 1));
      const b = Math.max(a, Math.min(lines.length - 1, Math.round(c.last) - 1));
      const from = Math.max(0, lines[a].from - 0.2);
      const to = Math.min(secondsOf(e), lines[b].to + 0.4);
      if (to - from < 10) continue;
      const child: EditLook = { ...look, trim: { from, to }, tools: { ...look.tools, hook: { on: true, text: (c.hook || "").trim().slice(0, 80) } } };
      db.getDb()
        .insert(videoEdits)
        .values({ organizationId: orgId, title: (c.title || "").trim().slice(0, 80) || `${e.title} clip`, status: "draft", sourceUrl: e.sourceUrl, previewUrl: e.previewUrl, thumbUrl: e.thumbUrl, width: e.width, height: e.height, tenths: e.tenths, lines: e.lines, look: JSON.stringify(child), cutoutUrl: e.cutoutUrl, matteUrl: e.matteUrl, cutoutPreviewUrl: e.cutoutPreviewUrl, sizes: e.sizes, caption: e.caption, parentId: e.id, createdBy: e.createdBy })
        .run();
      made.push(`"${(c.title || "").trim() || "Clip"}" (${fmtTime(to - from)})`);
    }
    if (!made.length) throw new Error("I didn't find a part that works on its own. Try a longer video.");
    await say(orgId, `I found ${made.length} short ${made.length === 1 ? "clip" : "clips"} in "${e.title}": ${made.join(", ")}. Each one is its own video on my Videos tab, with the same edits. Export each when it looks right.`);
  });
}

// ==========================================
// 3. Export
// ==========================================

let renderer: (input: EditRenderInput) => Promise<Buffer> = renderEdit;
let cutter: typeof cutSource = cutSource;
/** Tests swap in their own cut so they can check the plan without running ffmpeg. */
export function setEditRenderer(fn: ((input: EditRenderInput) => Promise<Buffer>) | null, cut?: typeof cutSource | null) {
  renderer = fn ?? renderEdit;
  cutter = cut ?? cutSource;
}

/** The finished length in seconds, as it stands now. */
export function outSeconds(e: VideoEdit) {
  return cutLength(keepRanges(linesOf(e.lines), editLookOf(e.look), secondsOf(e)));
}
/** Work minutes an export uses now: its length, less what was already used. */
export const minutesToExport = (e: VideoEdit) => Math.max(0, editMinutes(outSeconds(e)) - e.paidMinutes);

/** Everything one size needs, in the cut's time. */
export async function planRender(e: VideoEdit, size: ESize, files: { you: string; cutout: { rgb: string; matte: string } | null }, tmp: string): Promise<EditRenderInput> {
  const look = editLookOf(e.look);
  const lines = linesOf(e.lines);
  const ranges = keepRanges(lines, look, secondsOf(e));
  const total = cutLength(ranges);
  const cut = cutLines(lines, look, ranges);
  const { w, h } = SIZES[size];
  const pieces = piecesOf(cut, look, total).map((p) => ({ ...p, file: p.broll?.file ? broll.localFile(p.broll.file) : null }));
  const zooms = look.tools.zooms ? cut.filter((c) => c.line.zoom && !c.line.broll).map((c) => ({ from: c.from, to: c.to })) : [];
  const b = await brand(e.organizationId);
  const ass = editAss(w, h, cut, look, { brand: b.color });
  const emojis: Emoji[] = [];
  if (look.captions.on && look.captions.emojis) {
    const sharp = (await import("sharp")).default;
    const place = placeOf(w, h, look);
    const size = Math.round(place.size * 1.5);
    const made = new Map<string, string>();
    for (const c of cut) {
      const name = c.line.emoji;
      if (!name || !EMOJIS[name]) continue;
      if (!made.has(name)) {
        const svg = path.join(path.dirname(createRequire(import.meta.url).resolve("@twemoji/svg/package.json")), `${EMOJIS[name]}.svg`);
        const png = path.join(tmp, `emoji-${name}.png`);
        await sharp(fs.readFileSync(svg), { density: 300 }).resize(size, size).png().toFile(png);
        made.set(name, png);
      }
      const above = look.captions.style === "lower" || look.captions.position !== "top";
      emojis.push({ file: made.get(name)!, from: c.from, to: c.to, x: look.captions.style === "lower" ? Math.round(w * 0.06 + size / 2) : Math.round(w / 2), y: Math.round(above ? place.y - place.size * 1.9 : place.y + place.size * 1.9), size });
    }
  }
  const lay = look.layout;
  let other: { file: string } | null = null;
  if (lay.kind === "split" && lay.split.other === "clip" && lay.split.clipId) {
    const c = broll.getClip(e.organizationId, lay.split.clipId);
    if (c?.url) other = { file: broll.localFile(c.url) };
  }
  if (lay.kind === "split" && lay.split.other === "video" && lay.split.videoUrl) other = { file: broll.localFile(lay.split.videoUrl) };
  let bg: EditRenderInput["layout"]["bg"] = null;
  if (lay.kind === "green") {
    const g = lay.green;
    if (g.bg === "clip" && g.clipId) {
      const c = broll.getClip(e.organizationId, g.clipId);
      if (c?.url) bg = { file: broll.localFile(c.url), video: true };
    } else if (g.bg === "picture" && g.url) bg = { file: broll.localFile(g.url), video: false };
    else if (g.bg === "style" && g.drawn) bg = { file: broll.localFile(g.drawn), video: false };
    else bg = { color: g.color || "#1B6B4A" };
  }
  let music: EditRenderInput["music"] = null;
  if (look.music.on) {
    const file = look.music.track === "upload" ? (look.music.url ? broll.localFile(look.music.url) : null) : await broll.trackFile(look.music.track).catch(() => null);
    if (file) music = { file, volume: look.music.volume };
  }
  return {
    w,
    h,
    you: files.you,
    cutout: lay.kind === "green" ? files.cutout : null,
    total,
    pieces,
    zooms,
    layout: { kind: lay.kind === "green" && !files.cutout ? "full" : lay.kind, you: lay.split.you, when: lay.split.when, other, bg, corner: lay.pip.corner },
    ass,
    emojis,
    logo: look.logo.on && b.logo ? { file: b.logo, corner: look.logo.corner, size: look.logo.size } : null,
    music,
    sounds: look.tools.transitions && look.transition.sound,
    fontsDir: (await import("./drama")).fontsDir() || undefined,
  };
}

/** Export: every size from one job, in the background. Elena posts it when it's done. */
export async function exportEdit(orgId: number, id: number, sizes: ESize[]) {
  const e = must(orgId, id);
  editable(e);
  if (!e.sourceUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Wait until the video is ready." });
  const look = editLookOf(e.look);
  if (look.layout.kind === "green" && !e.cutoutUrl) throw new TRPCError({ code: "BAD_REQUEST", message: cutting.has(id) ? "Wait until Elena finishes cutting you out for the green screen." : "Save the green screen layout first, so Elena can cut you out." });
  if (outSeconds(e) < 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing is left to export. Turn off Remove bad takes or Remove silences." });
  const picked = Array.from(new Set(sizes)).filter((s) => s in SIZES);
  if (!picked.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one size." });
  const need = minutesToExport(e);
  if (need > 0) await hours.gate(orgId);
  const emp = await elena(orgId);
  const started = update(orgId, id, { status: "making", step: "Cutting your video", sizes: JSON.stringify(picked), error: null });
  void background(id, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ld-export-"));
    try {
      const ranges = keepRanges(linesOf(started.lines), look, secondsOf(started));
      const you = await cutter({ file: broll.localFile(started.sourceUrl!), ranges, cleanAudio: look.tools.cleanAudio, out: path.join(tmp, "you.mp4") });
      let cutout: { rgb: string; matte: string } | null = null;
      if (look.layout.kind === "green" && started.cutoutUrl && started.matteUrl) {
        update(orgId, id, { step: "Putting you over the background" });
        cutout = {
          rgb: await cutter({ file: broll.localFile(started.cutoutUrl), ranges, cleanAudio: false, out: path.join(tmp, "rgb.mp4"), video: "only" }),
          matte: await cutter({ file: broll.localFile(started.matteUrl), ranges, cleanAudio: false, out: path.join(tmp, "matte.mp4"), video: "only" }),
        };
      }
      const urls: Partial<Record<ESize, string>> = {};
      let total = 0;
      for (let k = 0; k < picked.length; k++) {
        const size = picked[k];
        update(orgId, id, { step: picked.length > 1 ? `Making ${SIZES[size].ratio} (${k + 1} of ${picked.length})` : `Making ${SIZES[size].ratio}` });
        const plan = await planRender(get(orgId, id)!, size, { you, cutout }, tmp);
        total = plan.total;
        const buf = await renderer(plan);
        urls[size] = (await storagePut(`org-${orgId}/edits/${size}.mp4`, buf, "video/mp4")).url;
      }
      let done = update(orgId, id, { status: "ready", step: null, videoUrls: JSON.stringify(urls), videoUrl: urls[picked[0]] ?? null, outTenths: Math.round(total * 10), error: null });
      const owe = Math.max(0, editMinutes(total) - done.paidMinutes);
      if (owe > 0) {
        await chargeNow(orgId, emp, "edit", owe / hours.JOBS.edit.minutes, done.title);
        done = update(orgId, id, { paidMinutes: done.paidMinutes + owe });
      }
      await say(orgId, `"${done.title}" is exported: ${fmtTime(total)}, ${picked.map((s) => SIZES[s].ratio).join(" and ")}. It's here and on my Videos tab. Send to Sienna puts it in her drafts as a Reel.`, [{ type: "video_edit", id, title: done.title }]);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      const prev = get(orgId, id)!;
      update(orgId, id, { status: Object.keys(urlsOf(prev)).length ? "ready" : "draft", step: null, error: msg });
      await say(orgId, `"${prev.title}" didn't export: ${msg} Your edits are kept. Press Export to try again.`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  return started;
}

/** Send to Sienna: the finished video as a Reel draft, with the caption, waiting for approval. */
export async function toSienna(orgId: number, id: number, by: string) {
  const e = must(orgId, id);
  const urls = urlsOf(e);
  const size: ESize | undefined = urls.vertical ? "vertical" : urls.square ? "square" : urls.wide ? "wide" : undefined;
  if (!size || !urls[size]) throw new TRPCError({ code: "BAD_REQUEST", message: "Export the video first." });
  const sienna = await db.getEmployeeByKind(orgId, "social");
  if (!sienna || sienna.status === "paused") throw new TRPCError({ code: "BAD_REQUEST", message: "Sienna isn't on your team. Bring her on from the bench to post videos." });
  const channels = size === "vertical" ? ["instagram", "tiktok", "facebook"] : ["instagram", "facebook", "linkedin"];
  const post = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: sienna.id,
    kind: "social_post",
    status: "pending_approval",
    title: e.title,
    body: e.caption || e.title,
    targetChannels: JSON.stringify(channels),
    metadata: JSON.stringify({ platforms: channels, topic: e.title, headline: e.title, rule: "posts", fromEdit: e.id, post: { type: "reel", mode: "same", variants: {}, videoUrl: urls[size], videoMeta: { w: SIZES[size].w, h: SIZES[size].h, seconds: Math.round((e.outTenths ?? 0) / 10) }, coverUrl: null, coverMs: 1000 } }),
  });
  const names: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", linkedin: "LinkedIn" };
  await db.createChatMessage({ organizationId: orgId, employeeId: sienna.id, role: "employee", authorName: sienna.name, content: `${by} sent me Elena's edit of "${e.title}". It's in my drafts as a Reel for ${channels.map((c) => names[c]).join(", ")}, with the caption. Pick a time and approve it, and I'll post it.` });
  return post;
}

// ==========================================
// What the screens show
// ==========================================

const STATUS: Record<VideoEdit["status"], string> = { preparing: "Getting ready", draft: "Editing", making: "Exporting", ready: "Ready", failed: "Didn't finish" };
const hoursText = (minutes: number) => {
  const h = hours.hoursNum(minutes);
  return `${h} work ${h === "1" ? "hour" : "hours"}`;
};

export function view(e: VideoEdit) {
  const look = editLookOf(e.look);
  const lines = linesOf(e.lines);
  const seconds = secondsOf(e);
  const ranges = keepRanges(lines, look, seconds);
  const out = cutLength(ranges);
  const changes = new Set(changesOf(lines, look, seconds));
  const urls = urlsOf(e);
  const g = look.layout.green as EditLook["layout"]["green"] & { error?: string };
  return {
    id: e.id,
    title: e.title,
    status: e.status,
    statusLabel: e.step && e.status !== "preparing" && e.status !== "making" ? "Working" : STATUS[e.status],
    step: e.step,
    error: e.error,
    previewUrl: e.previewUrl,
    thumbUrl: e.thumbUrl,
    width: e.width ?? 0,
    height: e.height ?? 0,
    shape: shapeOf(e.width ?? 9, e.height ?? 16),
    seconds,
    length: fmtTime(seconds),
    outSeconds: out,
    outLength: fmtTime(out),
    sizes: sizesOf(e),
    ratios: sizesOf(e).map((s) => SIZES[s].ratio),
    videoUrls: urls,
    videoUrl: e.videoUrl,
    caption: e.caption,
    look,
    layoutLabel: LAYOUT_LABEL[look.layout.kind],
    ranges,
    lines: lines.map((l, i) => ({
      i,
      from: l.from,
      to: l.to,
      time: `${fmtTime(l.from)} - ${fmtTime(l.to)}`,
      text: l.text,
      tx: l.tx ?? null,
      words: l.words,
      broll: l.broll ?? null,
      auto: !!l.auto,
      change: changes.has(i),
      tr: changes.has(i) ? { key: (l.tr?.key ?? (l.broll ? "zoomblur" : "fade")) as TransKey, label: TRANSITIONS[(l.tr?.key ?? (l.broll ? "zoomblur" : "fade")) as TransKey].label, auto: l.tr ? l.tr.auto : true } : null,
      emoji: l.emoji ?? null,
      zoom: !!l.zoom,
      drop: !!l.drop,
    })),
    brollCount: lines.filter((l) => l.broll).length,
    autoCount: lines.filter((l) => l.broll && l.auto).length,
    dropCount: lines.filter((l) => l.drop).length,
    hoursToExport: hoursText(minutesToExport(e)),
    exportMinutes: minutesToExport(e),
    greenHours: hoursText(greenMinutes(seconds)),
    cutout: { ready: !!e.cutoutUrl, previewUrl: e.cutoutPreviewUrl, cutting: cutting.has(e.id), error: g.error ?? null },
    parentId: e.parentId,
    updatedAt: e.updatedAt,
  };
}
export type EditView = ReturnType<typeof view>;

/** A line for Elena's chat about an edit. */
export const summary = (e: VideoEdit) => `${fmtTime(secondsOf(e))}, ${linesOf(e.lines).length} lines, ${STATUS[e.status].toLowerCase()}`;
