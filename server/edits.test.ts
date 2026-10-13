import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

let readOut: any = null;
let translated: any = null;
let clipsOut: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => (opts.schemaName === "video_edit_read" ? readOut : opts.schemaName === "caption_translation" ? translated : opts.schemaName === "short_clips" ? clipsOut : {})),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as hours from "./workHours";
import * as ed from "./employees/editor";
import * as lk from "./employees/editLook";
import * as er from "./employees/editRender";
import { editAss } from "./employees/editCaptions";
import { RECIPES, TRANS_KEYS } from "./employees/transitions";
import * as drama from "./employees/drama";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { brollClips } from "../drizzle/schema";

const ff = () => createRequire(import.meta.url)("ffmpeg-static") as string;
let dir: string;
let talk: string;
let clipMp4: Buffer;
let rgbMp4: Buffer;
let matteMp4: Buffer;
let calls: { url: string; init: any }[] = [];
let models = new Map<string, string>();
let rendered: any[] = [];
const before = { fal: ENV.falKey, aai: ENV.assemblyAiKey, pexels: ENV.pexelsKey, pixabay: ENV.pixabayKey };

/** 12 words over 8 seconds, with a long pause after "today." */
const WORDS = [
  ["Most", 0.2, 0.5], ["therapists", 0.5, 1.0], ["never", 1.0, 1.3], ["market.", 1.3, 1.8],
  ["Here's", 3.4, 3.7], ["what", 3.7, 3.9], ["to", 3.9, 4.0], ["do", 4.0, 4.2], ["today.", 4.2, 4.8],
  ["Open", 5.0, 5.3], ["your", 5.3, 5.5], ["calendar.", 5.5, 6.2],
].map(([text, start, end]) => ({ text, start: Math.round(Number(start) * 1000), end: Math.round(Number(end) * 1000) }));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "edits-t-"));
  talk = path.join(dir, "talk.mp4");
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-f", "lavfi", "-i", "sine=frequency=300", "-t", "8", "-pix_fmt", "yuv420p", "-shortest", talk]);
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "mandelbrot=size=180x320:rate=30", "-t", "2", "-pix_fmt", "yuv420p", path.join(dir, "clip.mp4")]);
  clipMp4 = fs.readFileSync(path.join(dir, "clip.mp4"));
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-t", "8", "-pix_fmt", "yuv420p", path.join(dir, "rgb.mp4")]);
  rgbMp4 = fs.readFileSync(path.join(dir, "rgb.mp4"));
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:size=180x320:rate=30", "-t", "8", "-vf", "geq=lum='if(lt(hypot(X-90,Y-170),70),255,0)':cb=128:cr=128", "-pix_fmt", "yuv420p", path.join(dir, "matte.mp4")]);
  matteMp4 = fs.readFileSync(path.join(dir, "matte.mp4"));
});

beforeEach(() => {
  calls = [];
  models = new Map();
  rendered = [];
  drama.setPollMs(1);
  (ENV as any).falKey = "fal-test";
  (ENV as any).assemblyAiKey = "aai-test";
  (ENV as any).pexelsKey = "";
  (ENV as any).pixabayKey = "";
  readOut = {
    title: "Market your practice",
    caption: "Most therapists never market. Start today.",
    hook: "Therapists: do this today",
    broll: [
      { line: 2, see: "An open paper calendar on a desk", query: "calendar desk", into: "zoomblur", back: "fade" },
      { line: 3, see: "Hands opening a planner", query: "open planner", into: "lightleak", back: "whip" },
    ],
    zoom: [1],
    emoji: [{ line: 3, name: "calendar" }],
    drop: [],
  };
  ed.setEditRenderer(async (input) => {
    rendered.push(input);
    for (const p of input.pieces) if (p.file) expect(fs.existsSync(p.file)).toBe(true);
    return Buffer.from("mp4-bytes");
  }, async (input) => {
    fs.copyFileSync(input.video === "only" ? path.join(dir, "rgb.mp4") : talk, input.out);
    return input.out;
  });
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === "https://api.assemblyai.com/v2/upload") return Response.json({ upload_url: "https://aai/u1" });
    if (u === "https://api.assemblyai.com/v2/transcript") return Response.json({ id: "t1" });
    if (u === "https://api.assemblyai.com/v2/transcript/t1") return Response.json({ status: "completed", text: WORDS.map((w) => w.text).join(" "), words: WORDS, audio_duration: 8 });
    if (u.startsWith("https://rest.fal.ai/storage/upload/initiate")) return Response.json({ upload_url: "https://fal-up/put1", file_url: "https://fal.media/source.mp4" });
    if (u === "https://fal-up/put1") return new Response("", { status: 200 });
    if (u.startsWith("https://queue.fal.run/") && init.method === "POST") {
      const id = `r${++n}`;
      models.set(id, u.slice("https://queue.fal.run/".length));
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/req/${id}/status`, response_url: `https://queue.fal.run/req/${id}` });
    }
    if (/\/req\/r\d+\/status$/.test(u)) return Response.json({ status: "COMPLETED" });
    const m = u.match(/\/req\/(r\d+)$/);
    if (m) {
      const model = models.get(m[1]) ?? "";
      // The matte comes first here, so the code has to tell which is which.
      if (model.includes("background-removal")) return Response.json({ video: [{ url: "https://fal.media/alpha.mp4", content_type: "video/mp4" }, { url: "https://fal.media/rgb.mp4", content_type: "video/mp4" }] });
      return Response.json({});
    }
    if (u === "https://fal.media/alpha.mp4") return new Response(matteMp4, { status: 200 });
    if (u === "https://fal.media/rgb.mp4") return new Response(rgbMp4, { status: 200 });
    if (u.startsWith("https://pixabay.com/api/videos/")) {
      return Response.json({ hits: [{ pageURL: "https://pixabay.com/videos/planner-1/", duration: 9, user: "Plan Shooter", videos: { large: { url: "https://cdn.pixabay.com/planner.mp4", width: 1080, height: 1920, thumbnail: "https://cdn.pixabay.com/planner.jpg" } } }] });
    }
    if (u === "https://cdn.pixabay.com/planner.mp4") return new Response(clipMp4, { status: 200 });
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  ed.setEditRenderer(null);
  (ENV as any).falKey = before.fal;
  (ENV as any).assemblyAiKey = before.aai;
  (ENV as any).pexelsKey = before.pexels;
  (ENV as any).pixabayKey = before.pixabay;
});

async function libraryClip(orgId: number, title: string, tags: string) {
  const saved = await storagePut(`org-${orgId}/broll/clip.mp4`, clipMp4, "video/mp4");
  return db.getDb().insert(brollClips).values({ organizationId: orgId, title, tags, source: "uploaded", status: "ready", url: saved.url, thumbUrl: null, tenths: 20, width: 180, height: 320 }).returning().get();
}

/** An upload as it lands after the last part: held outside the served files, then prepared. */
async function uploaded(orgId: number, name = "Practice tips.mov") {
  const hold = ed.holdingPath(orgId, "a".repeat(32));
  fs.copyFileSync(talk, hold);
  const row = ed.startFromUpload(orgId, { file: hold, name, by: "Owner" });
  await ed.jobFor(row.id);
  expect(fs.existsSync(hold)).toBe(false);
  return row.id;
}

async function onPlan(slug: string) {
  const w = await makeWorkspace(slug);
  await caller(w.staff).hours.setPlan({ organizationId: w.orgId, plan: "starter" });
  return w;
}

describe("Edit my video: the cut math", () => {
  const line = (from: number, to: number, text: string, extra: Partial<lk.EditLine> = {}): lk.EditLine => ({ from, to, text, words: lk.spreadWords(text, from, to), ...extra });

  it("splits words into caption lines at sentences and pauses", () => {
    const lines = lk.linesFrom(WORDS.map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 })));
    expect(lines.map((l) => l.text)).toEqual(["Most therapists never market.", "Here's what to do today.", "Open your calendar."]);
    expect(lines[1]).toMatchObject({ from: 3.4, to: 4.8 });
  });

  it("cuts long pauses and bad takes, and maps the rest into the cut's time", () => {
    const lines = [line(0.2, 1.8, "Most therapists never market."), line(3.4, 4.8, "Here's what to do today.", { drop: true }), line(5, 6.2, "Open your calendar.")];
    const look = lk.editLookOf(null);
    const keep = lk.keepRanges(lines, look, 8);
    // The 1.6 second pause is cut down; the pause under half a second stays.
    expect(keep).toEqual([{ from: 0.05, to: 1.95 }, { from: 3.25, to: 6.35 }]);
    expect(lk.mapTime(keep, 3.4)).toBeCloseTo(2.05, 3);
    expect(lk.cutLength(keep)).toBeCloseTo(5, 3);
    // Remove bad takes on: the dropped line goes too.
    const noTakes = lk.keepRanges(lines, { ...look, tools: { ...look.tools, badTakes: true } }, 8);
    expect(noTakes).toEqual([{ from: 0.05, to: 1.95 }, { from: 4.85, to: 6.35 }]);
    // Silences off: everything but the dropped line, from start to end.
    expect(lk.keepRanges(lines, { ...look, tools: { ...look.tools, silences: false, badTakes: true } }, 8)).toEqual([{ from: 0, to: 3.35 }, { from: 4.85, to: 8 }]);
    // A short clip keeps only its part.
    expect(lk.keepRanges(lines, { ...look, trim: { from: 3, to: 7 } }, 8)).toEqual([{ from: 3.25, to: 6.35 }]);
  });

  it("starts a new picture where b-roll comes and goes, each with its transition", () => {
    const pick = { src: "library" as const, clipId: 1, file: "/files/x.mp4", name: "Calendar" };
    const lines = [line(0, 2, "One two three."), line(2, 4, "Four five six.", { broll: pick, tr: { key: "glitch", auto: true } }), line(4, 6, "Seven eight nine."), line(6, 8, "Ten eleven twelve.")];
    const look = { ...lk.editLookOf(null), tools: { ...lk.editLookOf(null).tools, silences: false } };
    const keep = lk.keepRanges(lines, look, 8);
    const pieces = lk.piecesOf(lk.cutLines(lines, look, keep), look, lk.cutLength(keep));
    expect(pieces.map((p) => [p.from, p.to, !!p.broll, p.tr])).toEqual([[0, 2, false, "none"], [2, 4, true, "glitch"], [4, 8, false, "fade"]]);
    expect(pieces[1].d).toBe(0.5);
    // Transitions off: straight cuts.
    const off = lk.piecesOf(lk.cutLines(lines, { ...look, tools: { ...look.tools, transitions: false } }, keep), { ...look, tools: { ...look.tools, transitions: false } }, 8);
    expect(off.map((p) => p.tr)).toEqual(["none", "none", "none"]);
  });

  it("has 24 transitions, each with a way to make it", () => {
    expect(TRANS_KEYS).toHaveLength(24);
    for (const k of TRANS_KEYS) expect(RECIPES[k]).toBeDefined();
    expect(RECIPES.none.xfade).toBeNull();
    expect(RECIPES.filmburn).toMatchObject({ xfade: "fadewhite", overlay: "burn" });
  });

  it("writes word-by-word captions in each of the 12 styles, and the hook title", () => {
    const look = lk.editLookOf(null);
    const cut: lk.CutLine[] = [{ i: 0, from: 0, to: 1.5, words: lk.spreadWords("Most therapists never market.", 0, 1.5), line: line(0, 1.5, "Most therapists never market.") }];
    for (const style of lk.CAP_KEYS) {
      const ass = editAss(1080, 1920, cut, { ...look, captions: { ...look.captions, style } }, { brand: "#1B6B4A" })!;
      expect(ass).toContain("Style: Cap,");
      expect(ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,")).length).toBeGreaterThan(0);
    }
    const pop = editAss(1080, 1920, cut, { ...look, tools: { ...look.tools, hook: { on: true, text: "Do this today" } } }, { brand: null })!;
    expect(pop).toContain("{\\c&H0042C5F5&\\fscx110\\fscy110}MOST{\\r} THERAPISTS NEVER");
    expect(pop).toContain("Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,{\\fad(150,250)}DO THIS TODAY");
    expect(editAss(1080, 1920, cut, { ...look, captions: { ...look.captions, on: false } }, { brand: null })).toBeNull();
  });
});

// Each test prepares a real upload (ffmpeg, plus the transcript wait), which takes about 5 seconds on the server.
describe("Edit my video", { timeout: 60_000 }, () => {
  it("prepares an upload: plays, captioned, and Elena adds b-roll, transitions, zooms, an emoji and a hook", async () => {
    const { orgId, owner } = await makeWorkspace("edit-prep");
    (ENV as any).pixabayKey = "pb-test";
    const lib = await libraryClip(orgId, "Paper calendar", "open paper calendar desk planner");
    const id = await uploaded(orgId);
    // AssemblyAI's current models (speech_model was retired).
    expect(JSON.parse(calls.find((c) => c.url === "https://api.assemblyai.com/v2/transcript")!.init.body)).toMatchObject({ speech_models: ["universal-3-5-pro", "universal-2"] });
    const v = (await caller(owner).edits.get({ organizationId: orgId, id }))!;
    expect(v).toMatchObject({ status: "draft", statusLabel: "Editing", title: "Practice tips", shape: "vertical", length: "0:08", ratios: ["9:16"], caption: "Most therapists never market. Start today.", step: null, error: null });
    expect(v.previewUrl).toMatch(/^\/files\/org-\d+\/edits\/preview_/);
    expect(v.lines.map((l) => l.text)).toEqual(["Most therapists never market.", "Here's what to do today.", "Open your calendar."]);
    // Line 2: the library clip that fits; line 3: stock (no second library match), each with Elena's transition.
    expect(v.lines[1]).toMatchObject({ auto: true, broll: { src: "library", clipId: lib.id, name: "Paper calendar" }, change: true, tr: { key: "zoomblur", label: "Zoom blur", auto: true } });
    expect(v.lines[2]).toMatchObject({ auto: true, broll: { src: "stock", credit: "Plan Shooter on Pixabay", page: "https://pixabay.com/videos/planner-1/" }, change: true, tr: { key: "lightleak", label: "Light leak" } });
    expect(v.lines[0]).toMatchObject({ zoom: true, change: false, tr: null });
    expect(v.lines[2].emoji).toBe("calendar");
    expect(v.autoCount).toBe(2);
    expect(v.look.tools.hook).toEqual({ on: false, text: "Therapists: do this today" });
    // The long pause is cut: 8 seconds becomes 5.
    expect(v.outSeconds).toBeCloseTo(5, 2);
    expect(v.hoursToExport).toBe("2 work hours");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const msgs = await db.listChatMessages(orgId, elena.id);
    const last = msgs[msgs.length - 1];
    expect(last.content).toBe('"Practice tips" is ready to edit: 0:08, 3 lines, captions in Bold pop. I added b-roll to 2 lines with a transition at every change, and cut the long pauses. Open it on my Videos tab to change anything, then press Export.');
    expect(JSON.parse(last.cards!)).toEqual([{ type: "video_edit", id, title: "Practice tips" }]);

    // Another workspace never sees it.
    const other = await makeWorkspace("edit-prep-2");
    expect(await caller(other.owner).edits.get({ organizationId: other.orgId, id })).toBeNull();
    expect(await caller(other.owner).edits.list({ organizationId: other.orgId })).toEqual([]);
    await expect(caller(other.owner).edits.saveLine({ organizationId: other.orgId, id, n: 0, text: "Hi" })).rejects.toThrow(/not in this workspace/);
    await expect(caller(other.owner).edits.export({ organizationId: other.orgId, id, sizes: ["vertical"] })).rejects.toThrow(/not in this workspace/);
  });

  it("fixes a word, changes b-roll and transitions, and turns tools on and off", async () => {
    const { orgId, owner, reviewer } = await makeWorkspace("edit-change");
    const lib = await libraryClip(orgId, "Paper calendar", "open paper calendar desk planner");
    const id = await uploaded(orgId);
    const c = caller(owner);
    const o = { organizationId: orgId, id };

    const fixed = await c.edits.saveLine({ ...o, n: 0, text: "Most therapists never market online." });
    expect(fixed.lines[0].text).toBe("Most therapists never market online.");
    expect(fixed.lines[0].words.map((w) => w.text)).toEqual(["Most", "therapists", "never", "market", "online."]);
    expect(fixed.lines[0].words[0].start).toBeCloseTo(0.2, 3);
    expect(fixed.lines[0].words[4].end).toBeCloseTo(1.8, 3);
    await expect(caller(reviewer).edits.saveLine({ ...o, n: 0, text: "x" })).rejects.toThrow();

    // B-roll on the first line from the library, then off again.
    const on = await c.edits.setBroll({ ...o, n: 0, pick: { src: "library", clipId: lib.id } });
    expect(on.lines[0]).toMatchObject({ broll: { src: "library", clipId: lib.id }, auto: false });
    const off = await c.edits.setBroll({ ...o, n: 0, pick: { src: "none" } });
    expect(off.lines[0].broll).toBeNull();

    // One transition, then the same at every change.
    const one = await c.edits.setTransition({ ...o, n: 1, key: "papertear" });
    expect(one.lines[1].tr).toEqual({ key: "papertear", label: "Paper tear", auto: false });
    const every = await c.edits.setTransition({ ...o, n: 1, key: "vhs", every: true, speed: "slow" });
    // Into the b-roll on line 2 and back to the speaker on line 3.
    expect(every.lines.filter((l) => l.tr).map((l) => [l.i, l.tr!.key])).toEqual([[1, "vhs"], [2, "vhs"]]);
    expect(every.look.transition.speed).toBe("slow");
    await expect(c.edits.setTransition({ ...o, n: 1, key: "explode" })).rejects.toThrow(/not one we have/);

    // Caption style and settings.
    const styled = await c.edits.changeLook({ ...o, captions: { style: "neon", position: "bottom", emojis: true } });
    expect(styled.look.captions).toMatchObject({ style: "neon", position: "bottom", emojis: true, highlight: "gold" });

    // Auto b-roll off takes Elena's b-roll out; b-roll someone picked stays.
    await c.edits.setBroll({ ...o, n: 0, pick: { src: "library", clipId: lib.id } });
    const noAuto = await c.edits.changeLook({ ...o, tools: { autoBroll: false } });
    expect(noAuto.lines.map((l) => !!l.broll)).toEqual([true, false, false]);
    expect(noAuto.autoCount).toBe(0);

    // Translate runs in the background and shows its step.
    translated = { lines: ["La mayoría nunca hace marketing.", "Esto es lo que hay que hacer hoy.", "Abre tu calendario."] };
    const tr = await c.edits.changeLook({ ...o, tools: { translate: { on: true, lang: "Spanish" } } });
    expect(tr.step).toBe("Translating captions into Spanish");
    await ed.jobFor(id);
    const done = (await c.edits.get(o))!;
    expect(done.step).toBeNull();
    expect(done.lines.map((l) => l.tx)).toEqual(translated.lines);
    await expect(c.edits.changeLook({ ...o, tools: { translate: { on: true, lang: "Klingon" } } })).rejects.toThrow(/Pick a language/);

    // Files from another workspace can't be used.
    await expect(c.edits.changeLook({ ...o, music: { on: true, track: "upload", url: "/files/org-999/music/x.mp3" } })).rejects.toThrow(/not in this workspace/);
  });

  it("exports every size from one job, charges 2 work hours a minute once, and sends to Sienna", async () => {
    const { orgId, owner } = await onPlan("edit-export");
    await libraryClip(orgId, "Paper calendar", "open paper calendar desk planner");
    const id = await uploaded(orgId);
    const c = caller(owner);
    const o = { organizationId: orgId, id };
    await c.edits.changeLook({ ...o, tools: { hook: { on: true, text: "Do this today" } }, captions: { emojis: true } });
    const started = await c.edits.export({ ...o, sizes: ["vertical", "square"] });
    expect(started).toMatchObject({ status: "making", step: "Cutting your video" });
    await ed.jobFor(id);
    const v = (await c.edits.get(o))!;
    expect(v).toMatchObject({ status: "ready", ratios: ["9:16", "1:1"], hoursToExport: "0 work hours", exportMinutes: 0 });
    expect(Object.keys(v.videoUrls)).toEqual(["vertical", "square"]);
    expect(rendered.map((r) => [r.w, r.h])).toEqual([[1080, 1920], [1080, 1080]]);
    const plan = rendered[0];
    expect(plan.pieces.map((p: any) => [!!p.file, p.tr])).toEqual([[false, "none"], [true, "zoomblur"], [false, "fade"]]);
    expect(plan.ass).toContain("Hook,,0,0,0,,{\\fad(150,250)}DO THIS TODAY");
    expect(plan.zooms).toHaveLength(1);
    expect(plan.emojis).toHaveLength(1);
    expect(fs.existsSync(plan.emojis[0].file)).toBe(false); // made for the job, then cleaned up
    expect((await hours.balance(orgId)).usedMinutes).toBe(120);

    // Export again after a change: no more hours.
    await c.edits.changeLook({ ...o, captions: { style: "boxed" } });
    await c.edits.export({ ...o, sizes: ["vertical"] });
    await ed.jobFor(id);
    expect((await hours.balance(orgId)).usedMinutes).toBe(120);

    // Sienna gets it as a Reel draft with the caption.
    await c.edits.toSienna(o);
    const drafts = await db.listOutboundItemsByOrg(orgId, "social_post");
    expect(drafts[0]).toMatchObject({ status: "pending_approval", body: "Most therapists never market. Start today." });
    expect(JSON.parse(drafts[0].metadata!).post).toMatchObject({ type: "reel", videoUrl: (await c.edits.get(o))!.videoUrls.vertical });
  });

  it("green screen: Elena cuts the person out once on fal.ai, then the export puts them over the background", async () => {
    const { orgId, owner } = await onPlan("edit-green");
    const id = await uploaded(orgId);
    const c = caller(owner);
    const o = { organizationId: orgId, id };
    await expect(c.edits.changeLook({ ...o, layout: { kind: "green", green: { bg: "picture" } } })).rejects.toThrow(/Upload the picture/);
    const saved = await c.edits.changeLook({ ...o, layout: { kind: "green", green: { bg: "color", color: "#224466" } } });
    expect(saved.cutout.cutting).toBe(true);
    await expect(c.edits.export({ ...o, sizes: ["vertical"] })).rejects.toThrow(/Wait until Elena finishes cutting you out/);
    await ed.cutoutJobFor(id);
    const v = (await c.edits.get(o))!;
    expect(v.cutout).toMatchObject({ ready: true, cutting: false, error: null });
    expect(v.cutout.previewUrl).toMatch(/\.webm$/);
    const sent = calls.find((x) => x.url === "https://queue.fal.run/veed/video-background-removal");
    expect(JSON.parse(sent!.init.body)).toEqual({ video_url: "https://fal.media/source.mp4", output_codec: "h264", refine_foreground_edges: true, subject_is_person: true });
    // 2 work hours for each minute of the upload (8 seconds counts as one minute).
    expect((await hours.balance(orgId)).usedMinutes).toBe(120);
    // The matte came first from fal.ai; it's kept as the matte, not the picture.
    const row = ed.get(orgId, id)!;
    expect(row.matteUrl).toMatch(/matte_/);
    await c.edits.export({ ...o, sizes: ["vertical"] });
    await ed.jobFor(id);
    expect(rendered[0].layout).toMatchObject({ kind: "green", bg: { color: "#224466" } });
    expect(rendered[0].cutout).toMatchObject({ rgb: expect.stringMatching(/rgb\.mp4$/), matte: expect.stringMatching(/matte\.mp4$/) });
  });

  it("short clips: Elena finds the best parts and makes each its own video with a hook", async () => {
    const { orgId, owner } = await makeWorkspace("edit-clips");
    const id = await uploaded(orgId);
    // Too short for clips.
    await expect(caller(owner).edits.shortClips({ organizationId: orgId, id })).rejects.toThrow(/already short/);
    // Pretend it's a long talk: the same lines, five times as slow.
    const slow = lk.linesFrom(WORDS.map((w) => ({ text: w.text, start: (w.start / 1000) * 5, end: (w.end / 1000) * 5 })));
    db.getDb().update((await import("../drizzle/schema")).videoEdits).set({ tenths: 1600, lines: JSON.stringify(slow) }).run();
    clipsOut = { clips: [{ first: 1, last: 3, title: "Start marketing", hook: "Stop waiting" }] };
    await caller(owner).edits.shortClips({ organizationId: orgId, id });
    await ed.jobFor(id);
    const all = await caller(owner).edits.list({ organizationId: orgId });
    const child = all.find((e) => e.parentId === id)!;
    expect(child).toMatchObject({ title: "Start marketing", status: "draft", look: { trim: { from: 0.8, to: 24.4 }, tools: { hook: { on: true, text: "Stop waiting" } } } });
  });
});

describe("Edit my video: the real cut", () => {
  it("cuts the upload, then renders every transition, captions, an emoji, split screen and green screen with ffmpeg", async () => {
    ed.setEditRenderer(null);
    const out = path.join(dir, "cut.mp4");
    await er.cutSource({ file: talk, ranges: [{ from: 0, to: 1.5 }, { from: 3, to: 4.5 }], cleanAudio: true, out });
    const p = await drama.probe(out);
    expect(Math.abs(p.duration - 3)).toBeLessThan(0.15);
    expect(p.audio).toBe(true);

    const clip = path.join(dir, "clip.mp4");
    const look = lk.editLookOf(null);
    const cut: lk.CutLine[] = [{ i: 0, from: 0, to: 2.5, words: lk.spreadWords("Here is what to do.", 0, 2.5), line: { from: 0, to: 2.5, text: "Here is what to do.", words: [] } }];
    const emoji = path.join(dir, "e.png");
    execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=40x40", "-frames:v", "1", emoji]);
    // Every transition, at a quick speed, alternating the person and b-roll.
    const keys = TRANS_KEYS.slice(1, 9);
    const L = 0.6;
    const pieces = [{ from: 0, to: L, broll: null, line: 0, tr: "none" as const, d: 0.2, file: null }, ...keys.map((k, i) => ({ from: (i + 1) * L, to: (i + 2) * L, broll: null, line: i + 1, tr: k, d: 0.2, file: i % 2 ? null : clip }))];
    const total = (keys.length + 1) * L;
    for (const [kind, extra] of [["full", {}], ["split", { when: "whole" }], ["pip", {}], ["green", {}]] as const) {
      const buf = await er.renderEdit({
        w: 180,
        h: 320,
        you: talk,
        cutout: kind === "green" ? { rgb: path.join(dir, "rgb.mp4"), matte: path.join(dir, "matte.mp4") } : null,
        total,
        pieces: pieces as any,
        zooms: [{ from: 0, to: 0.6 }],
        layout: { kind, you: "top", when: "broll", corner: "br", bg: kind === "green" ? { color: "#1B6B4A" } : null, other: null, ...extra },
        ass: editAss(180, 320, cut, look, { brand: null }),
        emojis: [{ file: emoji, from: 0.2, to: 1, x: 90, y: 100, size: 30 }],
        logo: null,
        music: null,
        fontsDir: drama.fontsDir() || undefined,
      });
      const f = path.join(dir, `edit-${kind}.mp4`);
      fs.writeFileSync(f, buf);
      const q = await drama.probe(f);
      expect(q.audio).toBe(true);
      expect(Math.abs(q.duration - total)).toBeLessThan(0.2);
    }
    // The rest of the transitions, including the drawn overlays.
    const rest = TRANS_KEYS.slice(9);
    const more = [{ from: 0, to: L, broll: null, line: 0, tr: "none" as const, d: 0.2, file: null }, ...rest.map((k, i) => ({ from: (i + 1) * L, to: (i + 2) * L, broll: null, line: i + 1, tr: k, d: 0.2, file: i % 2 ? null : clip }))];
    const total2 = (rest.length + 1) * L;
    const buf = await er.renderEdit({ w: 180, h: 320, you: talk, cutout: null, total: total2, pieces: more as any, zooms: [], layout: { kind: "full", you: "top", when: "broll", corner: "br" }, ass: null, emojis: [], logo: null, music: null });
    const f = path.join(dir, "edit-rest.mp4");
    fs.writeFileSync(f, buf);
    expect(Math.abs((await drama.probe(f)).duration - total2)).toBeLessThan(0.2);
  }, 240_000);
});

