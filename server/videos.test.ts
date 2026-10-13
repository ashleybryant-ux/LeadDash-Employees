import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

let decision: any = null;
let script: any = null;
let scenes: any = null;
let hookOut: any = null;
let setOut: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) =>
      opts.schemaName === "chat_decision" ? decision : opts.schemaName === "video_script" ? script : opts.schemaName === "video_scenes" ? scenes : opts.schemaName === "video_hooks" ? hookOut : opts.schemaName === "broll_set" ? setOut : {}
    ),
  };
});

import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as hours from "./workHours";
import * as vd from "./employees/videos";
import * as br from "./employees/broll";
import * as drama from "./employees/drama";
import { withUsage } from "./usage";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { brollClips } from "../drizzle/schema";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const SCRIPT = {
  title: "Evening hours are here",
  shots: [
    { at: 0, see: "Warm lamp in an empty office at dusk", say: "Evenings, finally.", photo: "", src: "stock", clip: 0, query: "lamp office dusk" },
    { at: 6, see: "A person closing a laptop, coat on", say: "Therapy that fits after work.", photo: "", src: "ai", clip: 0, query: "closing laptop" },
    { at: 14, see: "Answer in five minutes", say: "Sessions until 8 PM, Monday to Thursday.", photo: "", src: "text", clip: 0, query: "" },
    { at: 24, see: "Book a free consult", say: "Book a free consult.", photo: "", src: "logo", clip: 0, query: "" },
  ],
  caption: "Evening sessions are open. Book a free consult.",
};

let calls: { url: string; init: any }[] = [];
let mp3: Buffer;
let png: Buffer;
let mp4: Buffer;
let wav: Buffer;
let longMp4: string;
let rendered: vd.RenderInput[] = [];
let models = new Map<string, string>();
const before = { fal: ENV.falKey, openai: ENV.openAiKey, pexels: ENV.pexelsKey, pixabay: ENV.pixabayKey };
const ff = () => createRequire(import.meta.url)("ffmpeg-static") as string;

beforeAll(() => {
  // Built-in music is made once and kept; start without it so the test sees it made.
  fs.rmSync(path.join(path.resolve(ENV.uploadsDir), "..", "ld-music"), { recursive: true, force: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videos-t-"));
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220", "-t", "6", path.join(dir, "vo.mp3")]);
  mp3 = fs.readFileSync(path.join(dir, "vo.mp3"));
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", path.join(dir, "s.png")]);
  png = fs.readFileSync(path.join(dir, "s.png"));
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=180x320:rate=30", "-t", "2", "-pix_fmt", "yuv420p", path.join(dir, "c.mp4")]);
  mp4 = fs.readFileSync(path.join(dir, "c.mp4"));
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", path.join(dir, "m.wav")]);
  wav = fs.readFileSync(path.join(dir, "m.wav"));
  longMp4 = path.join(dir, "long.mp4");
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:size=64x64:rate=5", "-t", "62", "-pix_fmt", "yuv420p", longMp4]);
});

beforeEach(() => {
  calls = [];
  rendered = [];
  models = new Map();
  script = SCRIPT;
  scenes = null;
  drama.setPollMs(1);
  (ENV as any).falKey = "fal-test";
  (ENV as any).openAiKey = "sk-test";
  (ENV as any).pexelsKey = "";
  (ENV as any).pixabayKey = "";
  // The cut itself is checked in its own test below; here it records what it was asked to cut.
  vd.setRenderer(async (input) => {
    rendered.push(input);
    for (const c of input.clips) expect(fs.existsSync(c.file)).toBe(true);
    return Buffer.from("mp4-bytes");
  });
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === "https://api.openai.com/v1/audio/speech") return new Response(mp3, { status: 200 });
    if (u.startsWith("https://queue.fal.run/") && init.method === "POST") {
      const id = `r${++n}`;
      models.set(id, u.slice("https://queue.fal.run/".length));
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/req/${id}/status`, response_url: `https://queue.fal.run/req/${id}` });
    }
    if (/\/req\/r\d+\/status$/.test(u)) return Response.json({ status: "COMPLETED" });
    const m = u.match(/\/req\/(r\d+)$/);
    if (m) {
      const model = models.get(m[1]) ?? "";
      if (model.includes("kling")) return Response.json({ video: { url: "https://fal.media/clip.mp4" } });
      if (model.includes("lyria")) return Response.json({ audio: { url: "https://fal.media/music.wav" } });
      return Response.json({ images: [{ url: "https://fal.media/still.png" }] });
    }
    if (u === "https://fal.media/still.png") return new Response(png, { status: 200 });
    if (u === "https://fal.media/clip.mp4" || u === "https://videos.pexels.com/stock.mp4") return new Response(mp4, { status: 200 });
    if (u === "https://fal.media/music.wav") return new Response(wav, { status: 200 });
    if (u.startsWith("https://pixabay.com/api/videos/")) {
      return Response.json({ hits: [
        { pageURL: "https://pixabay.com/videos/wide-1/", duration: 12, user: "Wide Shooter", videos: { large: { url: "https://cdn.pixabay.com/wide.mp4", width: 1920, height: 1080, thumbnail: "https://cdn.pixabay.com/wide.jpg" } } },
        { pageURL: "https://pixabay.com/videos/tall-2/", duration: 9, user: "Tall Shooter", videos: { large: { url: "https://cdn.pixabay.com/tall.mp4", width: 1080, height: 1920, thumbnail: "https://cdn.pixabay.com/tall.jpg" }, small: { url: "https://cdn.pixabay.com/tall-s.mp4", width: 360, height: 640, thumbnail: "https://cdn.pixabay.com/tall-s.jpg" } } },
      ] });
    }
    if (u.startsWith("https://api.pexels.com/v1/videos/search")) {
      return Response.json({ videos: [{ url: "https://www.pexels.com/video/1/", image: "https://images.pexels.com/1.jpg", duration: 9, user: { name: "Ana Lee" }, video_files: [{ link: "https://videos.pexels.com/stock.mp4", width: 1080, height: 1920, file_type: "video/mp4", quality: "hd" }] }] });
    }
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vd.setRenderer(null);
  (ENV as any).falKey = before.fal;
  (ENV as any).openAiKey = before.openai;
  (ENV as any).pexelsKey = before.pexels;
  (ENV as any).pixabayKey = before.pixabay;
});

async function onPlan(slug: string) {
  const w = await makeWorkspace(slug);
  const staff = (await db.getUserByEmail("staff@leaddash.io")) ?? (await makeUser("staff@leaddash.io", "admin"));
  await caller(staff).hours.setPlan({ organizationId: w.orgId, plan: "starter" });
  return w;
}

const posted = (u: string) => calls.filter((c) => c.url === `https://queue.fal.run/${u}` && c.init.method === "POST").map((c) => JSON.parse(c.init.body));

/** A ready library clip, as if uploaded. */
async function libraryClip(orgId: number, title: string, tags: string) {
  const saved = await storagePut(`org-${orgId}/broll/lib.mp4`, mp4, "video/mp4");
  return db.getDb().insert(brollClips).values({ organizationId: orgId, title, tags, source: "uploaded", status: "ready", url: saved.url, tenths: 20, width: 180, height: 320 }).returning().get();
}

describe("Elena's video agent", () => {
  it("shows the Make a video card when the format isn't clear", async () => {
    const { orgId, owner } = await makeWorkspace("vid-ask");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    decision = { ...blank, action: "make_video_script", notes: "A 30-second Instagram video about our new evening hours", focus: "" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make a 30-second Instagram video about our new evening hours" });
    expect(r.reply.content).toBe("What are we making? Pick a format and give me an idea, a script, a link or an audio file. I'll show you the storyboard before I make anything.");
    expect(JSON.parse(r.reply.cards!)).toEqual([expect.objectContaining({ type: "video_maker", title: "A 30-second Instagram video about our new evening hours" })]);
    expect(vd.list(orgId)).toHaveLength(0);
  });

  it("writes the storyboard with the hook first and a source for every scene; nothing is made yet", async () => {
    const { orgId, owner } = await makeWorkspace("vid-write");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    decision = { ...blank, action: "make_video_script", notes: "Our new evening hours. Calm, cozy office at night, end with Book a free consult.", focus: "broll" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "B-roll story" });
    // No library and no stock on this server: the footage scenes are new AI clips (2 work hours for each 5 seconds; these scenes run 6 and 8 seconds).
    expect(r.reply.content).toBe("Here's the storyboard (4 scenes, 30 seconds, 9:16). The hook is up front. Change any scene, then press Make the video. It uses 12 work hours when it's done.");
    const cards = JSON.parse(r.reply.cards!);
    expect(cards[0]).toMatchObject({ type: "made_video", title: "Evening hours are here" });
    const v = vd.get(orgId, cards[0].id)!;
    expect(v).toMatchObject({ kind: "broll", size: "vertical", seconds: 30, status: "draft", source: "idea", voiceId: "openai:coral", voiceName: "Coral" });
    expect(vd.scriptOf(v).shots.map((s) => s.src)).toEqual(["ai", "ai", "text", "logo"]);
    const view = (await caller(owner).videos.get({ organizationId: orgId, id: v.id }))!;
    expect(view).toMatchObject({ kindLabel: "B-roll story", length: "0:30", statusLabel: "Storyboard", hours: "12 work hours", newClips: 2, ratios: ["9:16"], voiceName: "Coral" });
    expect(view.shots.map((s) => [s.srcLabel, s.hook])).toEqual([["AI shot", true], ["AI shot", false], ["Kinetic text", false], ["Logo end", false]]);
    // Defaults for the look: bold captions in the middle with gold, music low; no logo uploaded, so the logo is off.
    expect(view.lookText).toEqual({ captions: "On, Bold pop, middle, gold highlight", logo: "Off", music: "Calm pulse, volume 20" });

    // Another workspace never sees it.
    const other = await makeWorkspace("vid-write-2");
    expect(await caller(other.owner).videos.list({ organizationId: other.orgId })).toEqual([]);
    expect(await caller(other.owner).videos.get({ organizationId: other.orgId, id: v.id })).toBeNull();
    await expect(caller(other.owner).videos.make({ organizationId: other.orgId, id: v.id })).rejects.toThrow(/not in this workspace/);
    await expect(caller(other.owner).videos.restyle({ organizationId: other.orgId, id: v.id, logo: { on: false, corner: "br", size: "m" } })).rejects.toThrow(/not in this workspace/);

    // Rewrite line and Change shot on the storyboard.
    const line = await caller(owner).videos.saveLine({ organizationId: orgId, id: v.id, n: 1, say: "Therapy after work." });
    expect(line.shots[1].say).toBe("Therapy after work.");
    const lib = await libraryClip(orgId, "Laptop closing", "laptop desk evening");
    const changed = await caller(owner).videos.changeShot({ organizationId: orgId, id: v.id, n: 1, src: "library", clipId: lib.id });
    expect(changed.shots[1]).toMatchObject({ src: "library", srcLabel: "Your b-roll", clipId: lib.id, made: true });
    expect(changed.hours).toBe("8 work hours");
    // Stock isn't set up here, so it says so.
    await expect(caller(owner).videos.changeShot({ organizationId: orgId, id: v.id, n: 0, src: "stock" })).rejects.toThrow(/Stock footage isn't set up/);
  });

  it("uses the b-roll library first, then stock, then a new AI clip", async () => {
    const { orgId } = await makeWorkspace("vid-sources");
    (ENV as any).pexelsKey = "px-test";
    const lamp = await libraryClip(orgId, "Lamp at dusk", "warm lamp empty office dusk evening");
    const desk = await libraryClip(orgId, "Front desk", "front desk phone");
    script = { ...SCRIPT, shots: [{ ...SCRIPT.shots[0], src: "library", clip: desk.id }, SCRIPT.shots[1], { ...SCRIPT.shots[2], src: "stock", see: "Rain on a window", query: "rain window" }, SCRIPT.shots[3]] };
    const v = await vd.writeVideo(orgId, { instructions: "Evening hours", kind: "ad", sizes: ["vertical", "square"] });
    const shots = vd.scriptOf(v).shots;
    // Elena named the desk clip; she asked for a new AI clip for the laptop scene; the stock scene found stock.
    expect(shots.map((s) => s.src)).toEqual(["library", "ai", "stock", "logo"]);
    expect(shots[0].clipId).toBe(desk.id);
    expect(shots[2].stock).toMatchObject({ credit: "Ana Lee on Pexels", page: "https://www.pexels.com/video/1/" });
    const search = calls.find((c) => c.url.startsWith("https://api.pexels.com/"))!;
    expect(search.init.headers).toMatchObject({ Authorization: "px-test" });
    expect(new URL(search.url).searchParams.get("orientation")).toBe("portrait");
    // A scene the library fits by its words gets the library clip even when Elena didn't name it.
    const planned = await vd.assignSources(orgId, "broll", "vertical", [{ at: 0, see: "A warm lamp in the empty office", say: "Hi." }]);
    expect(planned[0]).toMatchObject({ src: "library", clipId: lamp.id });
    expect(vd.view(v).sizes).toEqual(["vertical", "square"]);
    expect(vd.view(v).hours).toBe("8 work hours");
  });

  it("uses Pixabay when Pexels isn't set up: the clip in the video's shape, credited, and each search kept for a day", async () => {
    (ENV as any).pixabayKey = "pb-test";
    const tall = await br.stockFor("rain window", "vertical");
    expect(tall).toMatchObject({ url: "https://cdn.pixabay.com/tall.mp4", credit: "Tall Shooter on Pixabay", page: "https://pixabay.com/videos/tall-2/", width: 1080, height: 1920 });
    const wide = await br.stockFor("rain window", "wide");
    expect(wide).toMatchObject({ url: "https://cdn.pixabay.com/wide.mp4", credit: "Wide Shooter on Pixabay" });
    // The same words were asked once.
    expect(calls.filter((c) => c.url.startsWith("https://pixabay.com/api/videos/"))).toHaveLength(1);
    expect(new URL(calls.find((c) => c.url.startsWith("https://pixabay.com/"))!.url).searchParams.get("key")).toBe("pb-test");
    expect(br.hasStock()).toBe(true);
  });

  it("makes every size from one job: voice-over, new AI clips saved to the library, captions, logo and music", async () => {
    const { orgId, owner } = await onPlan("vid-make");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const logo = await storagePut(`org-${orgId}/brand/logo.png`, png, "image/png");
    await db.updateOrganization(orgId, { logoUrl: logo.url, brandColors: JSON.stringify(["#123456", "#abcdef"]) });
    const v = await vd.writeVideo(orgId, { instructions: "Our new evening hours", sizes: ["vertical", "square"] });
    expect(vd.lookOf(v).logo).toEqual({ on: true, corner: "br", size: "m" });
    decision = { ...blank, action: "make_video" };
    // On a plan, a job this big asks first.
    const ask = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make it" });
    expect(ask.reply.content).toMatch(/^Before I start:/);
    const go = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Go ahead" });
    expect(go.reply.content).toMatch(/^Making "Evening hours are here" now\./);
    await vd.jobFor(v.id);

    const done = vd.get(orgId, v.id)!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(JSON.parse(done.videoUrls)).toEqual({ vertical: expect.stringMatching(/9x16/), square: expect.stringMatching(/1x1/) });
    expect(done.videoUrl).toBe(JSON.parse(done.videoUrls).vertical);
    // The voice-over is every scene's words, read once.
    const speech = calls.filter((c) => c.url === "https://api.openai.com/v1/audio/speech");
    expect(speech).toHaveLength(1);
    expect(JSON.parse(speech[0].init.body)).toMatchObject({ voice: "coral", input: "Evenings, finally. Therapy that fits after work. Sessions until 8 PM, Monday to Thursday. Book a free consult." });
    // Two new AI clips: a still, then the still brought to life (5 seconds or 10, no sound).
    expect(posted("fal-ai/nano-banana-pro")).toHaveLength(2);
    const moved = posted("fal-ai/kling-video/v3/pro/image-to-video");
    expect(moved).toHaveLength(2);
    expect(moved[0]).toMatchObject({ start_image_url: "https://fal.media/still.png", generate_audio: false });
    expect(["5", "10"]).toContain(moved[0].duration);
    // Each is saved to the b-roll library for every video after this one.
    const lib = br.listClips(orgId);
    expect(lib.filter((c) => c.source === "made" && c.status === "ready")).toHaveLength(2);
    expect(vd.scriptOf(done).shots.slice(0, 2).every((s) => s.src === "ai" && s.clipId && s.file)).toBe(true);
    // One cut per size, the same scenes: clips that move, then the text and logo cards.
    expect(rendered.map((r) => [r.w, r.h])).toEqual([[1080, 1920], [1080, 1080]]);
    const cut = rendered[0];
    expect(cut.clips.map((c) => !!c.video)).toEqual([true, true, false, false]);
    expect(cut.clips.reduce((n, c) => n + c.seconds, 0)).toBeCloseTo(cut.total, 1);
    expect(cut.words!.map((w) => w.text).join(" ")).toBe("Evenings, finally. Therapy that fits after work. Sessions until 8 PM, Monday to Thursday. Book a free consult.");
    expect(cut.caps).toMatchObject({ on: true, style: "pop", position: "middle", color: "#F5C542" });
    expect(cut.logo).toMatchObject({ corner: "br", size: "m" });
    expect(cut.music!.volume).toBe(20);
    expect(posted("fal-ai/lyria2")).toHaveLength(1);
    // 4 work hours for the length, and 2 for each new clip.
    expect((await hours.balance(orgId)).usedMinutes).toBe(240 + 2 * 120);
    const last = (await db.listChatMessages(orgId, elena.id)).at(-1)!;
    expect(last.content).toMatch(/^Your video "Evening hours are here" is ready: 0:0\d, 9:16 and 1:1\./);

    // Edit: captions, logo and music change with a new cut, no new footage, no voice read again, no work hours.
    calls = [];
    rendered = [];
    await caller(owner).videos.restyle({ organizationId: orgId, id: v.id, captions: { on: true, style: "boxed", position: "top", highlight: "brand" }, logo: { on: false, corner: "tl", size: "s" }, music: { track: "none", volume: 0 } });
    await vd.jobFor(v.id);
    expect(vd.get(orgId, v.id)!.status).toBe("ready");
    expect(calls.filter((c) => c.url.includes("fal") || c.url.includes("openai"))).toEqual([]);
    expect(rendered[0]).toMatchObject({ logo: null, music: null, caps: { style: "boxed", position: "top", color: "#abcdef" } });
    expect((await hours.balance(orgId)).usedMinutes).toBe(480);
    expect((await db.listChatMessages(orgId, elena.id)).at(-1)!.content).toBe('I saved your changes to "Evening hours are here". No new footage, so it used no work hours.');

    // Redo a scene: one new clip for that scene only.
    calls = [];
    await caller(owner).videos.changeShot({ organizationId: orgId, id: v.id, n: 0, src: "ai", see: "Sunset over a quiet street", redo: true });
    await vd.jobFor(v.id);
    expect(posted("fal-ai/kling-video/v3/pro/image-to-video")).toHaveLength(1);
    expect((await hours.balance(orgId)).usedMinutes).toBe(480 + 120);

    // Send to Sienna: a Reel draft with the caption, waiting for approval.
    await caller(owner).videos.toSienna({ organizationId: orgId, id: v.id });
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const post = (await db.listOutboundItemsByOrg(orgId, "social_post")).at(-1)!;
    expect(post).toMatchObject({ employeeId: sienna.id, status: "pending_approval", body: SCRIPT.caption });
    expect(JSON.parse(post.metadata!).post).toMatchObject({ type: "reel", videoUrl: JSON.parse(vd.get(orgId, v.id)!.videoUrls).vertical });
  });

  it("won't start when the workspace is out of work hours, and a failed cut uses none", async () => {
    const { orgId } = await onPlan("vid-gate");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const v = await vd.writeVideo(orgId, { instructions: "Our new evening hours", kind: "explainer", size: "wide" });
    await withUsage({ orgId }, () => hours.charge(orgId, elena.id, "doc", 50));
    await expect(vd.makeVideo(orgId, v.id)).rejects.toThrow(/out of work hours/);
    expect(vd.get(orgId, v.id)!.status).toBe("draft");

    const fresh = await onPlan("vid-fail");
    const v2 = await vd.writeVideo(fresh.orgId, { instructions: "Our new evening hours", kind: "explainer", size: "wide", look: { music: { track: "none" } } });
    expect(vd.scriptOf(v2).shots.map((s) => s.src)).toEqual(["text", "text", "text", "logo"]);
    vd.setRenderer(async (input) => {
      // Explainer cards are drawn here, fitted into the wide frame on their own background.
      expect(input.clips.every((c) => c.fit === "contain" && c.motion === "push")).toBe(true);
      expect([input.w, input.h]).toEqual([1920, 1080]);
      throw new Error("The cut didn't finish: test");
    });
    await vd.makeVideo(fresh.orgId, v2.id);
    await vd.jobFor(v2.id);
    expect(vd.get(fresh.orgId, v2.id)).toMatchObject({ status: "failed", error: "The cut didn't finish: test" });
    expect((await hours.balance(fresh.orgId)).usedMinutes).toBe(0);
    expect(calls.some((c) => c.url.startsWith("https://queue.fal.run/"))).toBe(false);
  });

  it("keeps their script word for word, one scene per line or two", async () => {
    const { orgId } = await makeWorkspace("vid-script");
    const words = "Half the people who call your practice will book somewhere else by Friday. It's not your clinicians. It's the wait between the call and the first answer. Answer in five minutes, and offer two times. Book a call at the link in our bio.";
    scenes = { title: "Why new clients disappear", caption: "Answer fast.", scenes: [{ see: "Phone on an empty desk", photo: "", src: "ai", clip: 0, query: "phone desk" }, { see: "Lobby", photo: "", src: "ai", clip: 0, query: "" }, { see: "Answer in 5 minutes", photo: "", src: "text", clip: 0, query: "" }, { see: "Book a call", photo: "", src: "logo", clip: 0, query: "" }] };
    const v = await vd.writeVideo(orgId, { instructions: words, kind: "broll", source: "script", seconds: 30 });
    const shots = vd.scriptOf(v).shots;
    expect(shots.map((s) => s.say).join(" ")).toBe(words);
    expect(shots[0]).toMatchObject({ at: 0, see: "Phone on an empty desk" });
    expect(v.title).toBe("Why new clients disappear");
    await expect(vd.rewriteVideo(orgId, v.id, "shorter")).rejects.toThrow(/The words are yours/);
    expect(vd.splitScript("One. Two three. Four five six.", 15).join(" ")).toBe("One. Two three. Four five six.");
  });

  it("writes a new hook, and three ad versions with different hooks", async () => {
    const { orgId } = await makeWorkspace("vid-hooks");
    const v = await vd.writeVideo(orgId, { instructions: "Evening hours", kind: "ad" });
    hookOut = { hooks: [{ say: "Still waiting for a callback?", see: "Phone ringing", query: "phone ringing" }, { say: "Two times, five minutes.", see: "Clock", query: "clock" }, { say: "Your next client is calling.", see: "Hand on phone", query: "phone" }] };
    const h = await vd.newHook(orgId, v.id);
    expect(vd.scriptOf(h).shots[0]).toMatchObject({ say: "Still waiting for a callback?", see: "Phone ringing" });
    expect(vd.scriptOf(h).shots.slice(1).map((s) => s.say)).toEqual(SCRIPT.shots.slice(1).map((s) => s.say));
    const versions = await vd.adVersions(orgId, v.id);
    expect(versions.map((x) => x.title)).toEqual(["Evening hours are here (version A)", "Evening hours are here (version B)", "Evening hours are here (version C)"]);
    expect(versions.map((x) => vd.scriptOf(x).shots[0].say)).toEqual(hookOut.hooks.map((x: any) => x.say));
    expect(versions.every((x) => x.status === "draft" && !x.paidAt)).toBe(true);
  });

  it("makes a Video plan from trends into a b-roll video, and Recreate keeps a format's structure", async () => {
    const { orgId, owner } = await makeWorkspace("vid-plan");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const plan = await db.createWorkItem({
      organizationId: orgId,
      employeeId: elena.id,
      kind: "video_plan",
      status: "drafted",
      title: "Three signs you need a break",
      sourceUrl: "https://example.com/trend",
      data: JSON.stringify({ trend: { name: "3 mistakes countdown", whyItWorks: "Lists hold attention", sourceUrl: "https://example.com/trend" }, plan: { title: "Three signs you need a break", platform: "Instagram Reels", lengthSeconds: 20, hook: "Tired all the time?", shots: [{ time: "0:00-0:03", shot: "Coffee cup on a desk", say: "Tired all the time?" }, { time: "0:03-0:12", shot: "Window with rain", say: "Here are three signs." }, { time: "0:12", shot: "Calendar", say: "Book a session." }], caption: "Save this." } }),
    });
    const made = await caller(owner).video.makeIt({ organizationId: orgId, id: plan.id });
    expect(made).toMatchObject({ kind: "broll", size: "vertical", seconds: 20, status: "making", planId: plan.id, caption: "Save this." });
    expect(made.shots.map((s) => [s.at, s.see, s.say])).toEqual([[0, "Coffee cup on a desk", "Tired all the time?"], [3, "Window with rain", "Here are three signs."], [12, "Calendar", "Book a session."]]);
    await vd.jobFor(made.id);
    expect(vd.get(orgId, made.id)!.status).toBe("ready");
    await caller(owner).video.makeIt({ organizationId: orgId, id: plan.id });
    expect(vd.list(orgId)).toHaveLength(1);

    const f = await caller(owner).videos.formats({ organizationId: orgId });
    expect(f[0]).toMatchObject({ id: plan.id, name: "3 mistakes countdown", structure: "Hook, 3 beats, 20 seconds" });
    const re = await caller(owner).videos.recreate({ organizationId: orgId, planId: plan.id });
    expect(re.status).toBe("draft");
    const { generateJson } = await import("./_core/llm");
    const asked = (generateJson as any).mock.calls.filter((c: any) => c[0].schemaName === "video_script").at(-1)[0];
    expect(asked.prompt).toMatch(/Recreate this format with our business[\s\S]*3 mistakes countdown[\s\S]*Coffee cup on a desk/);
    expect(JSON.parse((await db.listChatMessages(orgId, elena.id)).at(-1)!.cards!)[0]).toMatchObject({ type: "made_video", id: re.id });
  });

  it("word-by-word captions: a few words at a time, the word being said highlighted", () => {
    const words = vd.estimateWords("Half the people who call will book somewhere else.", 3);
    expect(words).toHaveLength(9);
    expect(words[8].end).toBeLessThanOrEqual(3);
    const ass = vd.wordCaptions(1080, 1920, words, { on: true, style: "pop", position: "top", highlight: "gold", color: "#F5C542" }, 0.3);
    expect(ass).toMatch(/Style: Cap,DejaVu Sans,\d+,.*,8,\d+,\d+,\d+,1/);
    const lines = ass.split("\n").filter((l) => l.startsWith("Dialogue"));
    expect(lines).toHaveLength(9);
    expect(lines[0]).toContain("{\\c&H0042C5F5&\\fscx110\\fscy110}HALF{\\r} THE PEOPLE");
    expect(lines[3]).toContain("{\\c&H0042C5F5&\\fscx110\\fscy110}WHO{\\r} CALL WILL");
    const plain = vd.wordCaptions(1920, 1080, words, { on: true, style: "clean", position: "bottom", highlight: "none", color: "#F5C542" }, 0);
    expect(plain.split("\n").filter((l) => l.startsWith("Dialogue")).map((l) => l.split(",,0,0,0,,")[1])).toEqual(["Half the people who call", "will book somewhere else."]);
    const times = vd.sceneTimes([{ say: "Half the people" }, { say: "who call will book somewhere else." }], words, 4, 0.3);
    expect(times.reduce((a, b) => a + b, 0)).toBeCloseTo(4, 1);
    expect(times[0]).toBeGreaterThan(0.5);
  });

  it("cuts moving clips and stills into an MP4 with ffmpeg: captions, logo and music", async () => {
    vd.setRenderer(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videos-cut-"));
    const img = path.join(dir, "a.png");
    fs.writeFileSync(img, png);
    const clip = path.join(dir, "c.mp4");
    fs.writeFileSync(clip, mp4);
    const music = path.join(dir, "m.wav");
    fs.writeFileSync(music, wav);
    const audio = path.join(dir, "vo.mp3");
    fs.writeFileSync(audio, mp3.subarray(0, Math.floor(mp3.length / 4)));
    const words = vd.estimateWords("One two three four five.", 1.2);
    const total = 2.2;
    const out = await vd.render({
      w: 180,
      h: 320,
      audio,
      delay: 0.3,
      total,
      captions: [],
      words,
      caps: { on: true, style: "pop", position: "middle", highlight: "gold", color: "#F5C542" },
      logo: { file: img, corner: "br", size: "m" },
      music: { file: music, volume: 20 },
      // A clip shorter than its scene is looped.
      clips: [{ file: clip, seconds: 1.4, fit: "cover", pad: "#000000", motion: "push", video: true }, { file: img, seconds: 0.8, fit: "contain", pad: "#0d3b2e", motion: "right" }],
    });
    const file = path.join(dir, "out.mp4");
    fs.writeFileSync(file, out);
    const p = await drama.probe(file);
    expect(p.audio).toBe(true);
    expect(Math.abs(p.duration - total)).toBeLessThan(0.25);
  });
});

describe("Story videos in a drawn style", () => {
  const STORY = {
    title: "His evenings back",
    caption: "He used to finish notes at 11 PM.",
    cast: [{ name: "Marcus", look: "a therapist in his 30s, short dark hair, blue scrubs" }],
    shots: [
      { at: 0, see: "Marcus at his desk late at night, rubbing his eyes", say: "It was 11 PM, and Marcus had four notes left.", photo: "", src: "art", clip: 0, query: "", who: ["Marcus"] },
      { at: 6, see: "An empty clinic hallway at sunrise", say: "He loved his clients.", photo: "", src: "art", clip: 0, query: "", who: [] },
      { at: 12, see: "Notes done", say: "Now his notes are done before his last client leaves.", photo: "", src: "text", clip: 0, query: "", who: [] },
      { at: 20, see: "Try it free", say: "Try it free this week.", photo: "", src: "logo", clip: 0, query: "", who: [] },
    ],
  };

  it("writes the story with its cast, draws each person once, then every scene with them, and makes it with moving pictures for no extra hours", async () => {
    const { orgId, owner } = await onPlan("vid-drawn");
    script = STORY;
    const v = await vd.writeVideo(orgId, { instructions: "A therapist gets his evenings back", style: "claymation", motion: "pictures" });
    // Every scene is drawn in the style: a motion text scene is drawn from what's said over it, never a word card.
    expect(v).toMatchObject({ style: "claymation", motion: "pictures", drawing: "0/3" });
    expect(vd.scriptOf(v).shots.map((s) => s.src)).toEqual(["art", "art", "art", "logo"]);
    expect(vd.scriptOf(v).shots[2].see).toBe("Now his notes are done before his last client leaves.");
    const { generateJson } = await import("./_core/llm");
    const asked = (generateJson as any).mock.calls.filter((c: any) => c[0].schemaName === "video_script").at(-1)[0];
    expect(asked.system).toMatch(/no motion text cards and no word cards/);
    await vd.drawJobFor(v.id);
    const drawn = vd.get(orgId, v.id)!;
    expect(drawn.drawing).toBeNull();
    expect(vd.scriptOf(drawn).shots.slice(0, 3).every((s) => s.still)).toBe(true);
    // Marcus's portrait first, in the style; then his scene drawn from that portrait so he looks the same.
    const plain = posted("fal-ai/nano-banana-pro");
    const edits = posted("fal-ai/nano-banana-pro/edit");
    expect(plain[0].prompt).toMatch(/^Claymation stop-motion look.*character reference portrait of Marcus: a therapist in his 30s/);
    expect(edits).toHaveLength(1);
    expect(edits[0].image_urls[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(edits[0].prompt).toMatch(/Marcus at his desk late at night.*look exactly like their reference portraits: Marcus/);
    // The hallway has nobody in it, so it needs no reference.
    expect(plain[1].prompt).toMatch(/An empty clinic hallway at sunrise/);
    expect(plain[2].prompt).toMatch(/Now his notes are done before his last client leaves/);
    expect(vd.castOf(drawn)[0].portrait).toMatch(/^\/files\/org-\d+\/videos\/cast-/);
    const view = (await caller(owner).videos.get({ organizationId: orgId, id: v.id }))!;
    expect(view).toMatchObject({ style: "claymation", styleLabel: "Claymation", motion: "pictures", drawing: null, hours: "4 work hours" });
    expect(view.shots[0]).toMatchObject({ srcLabel: "Claymation", made: true, who: ["Marcus"] });
    expect(view.shots[0].thumb).toMatch(/scene-/);
    expect(view.cast).toEqual([expect.objectContaining({ name: "Marcus", portrait: expect.stringMatching(/cast-/) })]);

    // Made with moving pictures: no animation, only the length's work hours.
    calls = [];
    await vd.makeVideo(orgId, v.id);
    await vd.jobFor(v.id);
    expect(vd.get(orgId, v.id)!.status).toBe("ready");
    expect(posted("fal-ai/kling-video/v3/pro/image-to-video")).toHaveLength(0);
    expect(rendered[0].clips.map((c) => !!c.video)).toEqual([false, false, false, false]);
    expect((await hours.balance(orgId)).usedMinutes).toBe(240);

    // Change look: Marcus and his scene are drawn again; the empty hallway isn't.
    calls = [];
    await caller(owner).videos.changeLook({ organizationId: orgId, id: v.id, index: 0, look: "a therapist in his 30s with a beard" });
    await vd.drawJobFor(v.id);
    expect(posted("fal-ai/nano-banana-pro")).toHaveLength(1);
    expect(posted("fal-ai/nano-banana-pro/edit")).toHaveLength(1);
    expect(vd.castOf(vd.get(orgId, v.id)!)[0].look).toBe("a therapist in his 30s with a beard");

    // Change style: everything is drawn again in the new look.
    calls = [];
    const w = await caller(owner).videos.changeStyle({ organizationId: orgId, id: v.id, style: "watercolor" });
    expect(w.styleLabel).toBe("Watercolor");
    await vd.drawJobFor(v.id);
    expect(posted("fal-ai/nano-banana-pro").concat(posted("fal-ai/nano-banana-pro/edit")).every((b) => /^Loose watercolor illustration/.test(b.prompt))).toBe(true);
    expect(posted("fal-ai/nano-banana-pro").concat(posted("fal-ai/nano-banana-pro/edit"))).toHaveLength(4);
  });

  it("animates each drawn scene with Animated clips, for 2 work hours each 5 seconds", async () => {
    const { orgId } = await onPlan("vid-anim");
    script = STORY;
    const v = await vd.writeVideo(orgId, { instructions: "A therapist gets his evenings back", style: "animation", motion: "clips" });
    await vd.drawJobFor(v.id);
    expect(vd.view(vd.get(orgId, v.id)!).newClips).toBe(3);
    await vd.makeVideo(orgId, v.id);
    await vd.jobFor(v.id);
    const done = vd.get(orgId, v.id)!;
    expect(done.status).toBe("ready");
    const moved = posted("fal-ai/kling-video/v3/pro/image-to-video");
    expect(moved).toHaveLength(3);
    expect(moved[0].start_image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(rendered[0].clips.map((c) => !!c.video)).toEqual([true, true, true, false]);
    expect((await hours.balance(orgId)).usedMinutes).toBe(240 + 3 * 120);
    // Drawn clips stay with the video, not in the b-roll library.
    expect(br.listClips(orgId)).toHaveLength(0);
  });

  it("goes up to 10 minutes with moving pictures; real footage stays at 2 minutes; Auto picks a style", async () => {
    const { orgId } = await makeWorkspace("vid-long");
    script = STORY;
    const long = await vd.writeVideo(orgId, { instructions: "Our story", style: "watercolor", motion: "clips", seconds: 600 });
    expect(long).toMatchObject({ seconds: 600, motion: "pictures" });
    const { generateJson } = await import("./_core/llm");
    const asked = (generateJson as any).mock.calls.filter((c: any) => c[0].schemaName === "video_script").at(-1)[0];
    expect(asked.system).toMatch(/A storyboard: 75 to 120 scenes/);
    expect(asked.maxTokens).toBe(12000);
    const real = await vd.writeVideo(orgId, { instructions: "Our story", seconds: 600 });
    expect(real.seconds).toBe(120);
    const auto = await vd.writeVideo(orgId, { instructions: "Our story", style: "auto" });
    expect(auto.style).toBe("animation");
    // A drawn video up to 90 seconds moves like a short film unless Moving pictures is picked.
    expect(auto.motion).toBe("clips");
    expect(real.motion).toBe("pictures");
    // Real footage changed to a drawn style moves too; over 90 seconds it stays moving pictures.
    const short = await vd.writeVideo(orgId, { instructions: "Our story", seconds: 30 });
    expect((await vd.changeStyle(orgId, short.id, "claymation"))!.motion).toBe("clips");
    expect((await vd.changeStyle(orgId, real.id, "claymation"))!.motion).toBe("pictures");
    await expect(vd.writeVideo(orgId, { instructions: "Our story", style: "custom:999" })).rejects.toThrow(/isn't in this workspace/);
    await Promise.all([long, auto].map((x) => vd.drawJobFor(x.id)));
  });

  it("Add style: a look from their own pictures, used as the reference for every scene", async () => {
    const { orgId, owner } = await makeWorkspace("vid-custom");
    const ref = await storagePut(`org-${orgId}/styles/look.png`, png, "image/png");
    await expect(caller(owner).videos.addStyle({ organizationId: orgId, name: "Print look", refs: ["/files/org-999/styles/x.png"] })).rejects.toThrow(/Upload at least one picture/);
    const st = await caller(owner).videos.addStyle({ organizationId: orgId, name: "Print look", refs: [ref.url] });
    expect(st).toMatchObject({ label: "Print look", image: ref.url });
    const picker = await caller(owner).videos.styles({ organizationId: orgId });
    expect(picker.custom.map((c) => c.label)).toEqual(["Print look"]);
    expect(picker.presets).toHaveLength(17);
    const other = await makeWorkspace("vid-custom-2");
    expect((await caller(other.owner).videos.styles({ organizationId: other.orgId })).custom).toEqual([]);
    script = { ...STORY, cast: [], shots: STORY.shots.map((s) => ({ ...s, who: [] })) };
    const v = await vd.writeVideo(orgId, { instructions: "Our story", style: st.key });
    await vd.drawJobFor(v.id);
    const edits = posted("fal-ai/nano-banana-pro/edit");
    expect(edits).toHaveLength(3);
    expect(edits.every((b) => b.image_urls.length === 1 && /same art style/.test(b.prompt))).toBe(true);
    expect(vd.view(vd.get(orgId, v.id)!).styleLabel).toBe("Print look");
  });
});

describe("Format card photos", () => {
  it("are made once with the image model, kept, and sized for the card", async () => {
    const fp = await import("./employees/formatPictures");
    fs.rmSync(fp.pictureDir(), { recursive: true, force: true });
    const file = await fp.makePicture("talking");
    expect(file).toBe(fp.pictureFile("talking"));
    const sharp = (await import("sharp")).default;
    expect(await sharp(file!).metadata()).toMatchObject({ width: 360, height: 640, format: "webp" });
    const asked = posted("fal-ai/nano-banana-pro")[0];
    expect(asked).toMatchObject({ aspect_ratio: "9:16" });
    expect(asked.prompt).toMatch(/vertical selfie-style phone video frame.*No text, letters, words, captions, logos or watermarks/);
    // Already made: nothing is asked again.
    calls = [];
    expect(await fp.makePicture("talking")).toBe(file);
    expect(calls).toEqual([]);
  });
});

describe("The b-roll library", () => {
  it("takes uploads up to 60 seconds, tagged, and makes sets of AI clips that use their work hours", async () => {
    const { orgId, owner } = await onPlan("broll-lib");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broll-up-"));
    const file = path.join(dir, "IMG_2231.MOV");
    fs.writeFileSync(file, mp4);
    const c = await br.saveUpload(orgId, { file, name: "Lobby, morning light.mov", by: "Ashley", describe: false });
    expect(c).toMatchObject({ title: "Lobby, morning light", source: "uploaded", status: "ready", width: 180, height: 320 });
    expect(c.url).toMatch(/^\/files\/org-\d+\/broll\/.+\.mp4$/);
    expect(c.thumbUrl).toMatch(/\.jpg$/);
    expect(br.clipView(c)).toMatchObject({ sourceLabel: "Uploaded", length: "0:02", fits: ["9:16", "1:1"] });
    await expect(br.saveUpload(orgId, { file: longMp4, name: "long.mp4", by: "Ashley", describe: false })).rejects.toThrow("Clips can be up to 60 seconds. This one is 62.");

    // Favorites and Delete, only in this workspace.
    expect((await caller(owner).broll.favorite({ organizationId: orgId, id: c.id, favorite: true })).favorite).toBe(true);
    const other = await makeWorkspace("broll-lib-2");
    await expect(caller(other.owner).broll.remove({ organizationId: other.orgId, id: c.id })).rejects.toThrow(/not in this workspace/);
    expect((await caller(other.owner).broll.list({ organizationId: other.orgId })).clips).toEqual([]);

    // Make clips: Elena plans the set and makes each one.
    setOut = { clips: [{ title: "Calm office", tags: "office calm morning", prompt: "A calm therapy office in morning light" }, { title: "Plants", tags: "plants chairs", prompt: "Plants and soft chairs, slow pan" }] };
    const rows = await caller(owner).broll.make({ organizationId: orgId, ask: "2 clips of a calm therapy office", count: 2, size: "vertical", seconds: 5 });
    expect(rows.map((r) => r.status)).toEqual(["making", "making"]);
    await br.setJob(orgId);
    const list = (await caller(owner).broll.list({ organizationId: orgId })).clips;
    expect(list.filter((x) => x.sourceLabel === "AI clip").map((x) => [x.title, x.status])).toEqual([["Plants", "ready"], ["Calm office", "ready"]]);
    expect((await hours.balance(orgId)).usedMinutes).toBe(2 * 120);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    expect((await db.listChatMessages(orgId, elena.id)).at(-1)!.content).toBe("2 new clips are in your b-roll library. I'll use them in every video after this one.");
    await caller(owner).broll.remove({ organizationId: orgId, id: c.id });
    expect(br.getClip(orgId, c.id)).toBeNull();
  });
});
