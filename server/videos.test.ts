import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

let decision: any = null;
let script: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? decision : opts.schemaName === "video_script" ? script : {})) };
});

import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as hours from "./workHours";
import * as vd from "./employees/videos";
import * as drama from "./employees/drama";
import { withUsage } from "./usage";
import { ENV } from "./_core/env";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const SCRIPT = {
  title: "Evening hours are here",
  shots: [
    { at: 0, see: "Warm lamp in an empty office at dusk", say: "Evenings, finally.", photo: "" },
    { at: 6, see: "A person closing a laptop, coat on", say: "Therapy that fits after work.", photo: "" },
    { at: 14, see: "Two chairs, soft light", say: "Sessions until 8 PM, Monday to Thursday.", photo: "" },
    { at: 24, see: "Logo and button", say: "Book a free consult.", photo: "" },
  ],
  caption: "Evening sessions are open. Book a free consult.",
};

let calls: { url: string; init: any }[] = [];
let mp3: Buffer;
let png: Buffer;
let rendered: vd.RenderInput[] = [];
const before = { fal: ENV.falKey, openai: ENV.openAiKey };

beforeAll(() => {
  const ff = createRequire(import.meta.url)("ffmpeg-static") as string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videos-t-"));
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220", "-t", "6", path.join(dir, "vo.mp3")]);
  mp3 = fs.readFileSync(path.join(dir, "vo.mp3"));
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", path.join(dir, "s.png")]);
  png = fs.readFileSync(path.join(dir, "s.png"));
});

beforeEach(() => {
  calls = [];
  rendered = [];
  script = SCRIPT;
  drama.setPollMs(1);
  (ENV as any).falKey = "fal-test";
  (ENV as any).openAiKey = "sk-test";
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
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/req/${id}/status`, response_url: `https://queue.fal.run/req/${id}` });
    }
    if (/\/req\/r\d+\/status$/.test(u)) return Response.json({ status: "COMPLETED" });
    if (/\/req\/r\d+$/.test(u)) return Response.json({ images: [{ url: "https://fal.media/still.png" }] });
    if (u === "https://fal.media/still.png") return new Response(png, { status: 200 });
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vd.setRenderer(null);
  (ENV as any).falKey = before.fal;
  (ENV as any).openAiKey = before.openai;
});

async function onPlan(slug: string) {
  const w = await makeWorkspace(slug);
  const staff = (await db.getUserByEmail("staff@leaddash.io")) ?? (await makeUser("staff@leaddash.io", "admin"));
  await caller(staff).hours.setPlan({ organizationId: w.orgId, plan: "starter" });
  return w;
}

describe("Elena makes any video you describe", () => {
  it("asks what kind when it isn't clear, with tap-to-answer choices", async () => {
    const { orgId, owner } = await makeWorkspace("vid-ask");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    decision = { ...blank, action: "make_video_script", notes: "A 30-second Instagram video about our new evening hours", focus: "" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make a 30-second Instagram video about our new evening hours" });
    expect(r.reply.content).toBe("Should someone be on camera, or b-roll with a voice-over?");
    expect(JSON.parse(r.reply.cards!)).toEqual([expect.objectContaining({ type: "choices", options: ["B-roll with voice-over", "Me on camera", "Slideshow of our photos"] })]);
    expect(vd.list(orgId)).toHaveLength(0);
  });

  it("writes the shot list in chat with the defaults: b-roll, vertical, 30 seconds, a standard voice", async () => {
    const { orgId, owner } = await makeWorkspace("vid-write");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    decision = { ...blank, action: "make_video_script", notes: "Our new evening hours. Calm, cozy office at night, end with Book a free consult.", focus: "broll" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "B-roll with voice-over" });
    expect(r.reply.content).toBe("Here's the shot list (4 shots, 30 seconds, vertical). It uses 4 work hours to make.");
    const cards = JSON.parse(r.reply.cards!);
    expect(cards[0]).toMatchObject({ type: "made_video", title: "Evening hours are here" });
    expect(cards[1]).toMatchObject({ type: "choices", options: ["Make it", "Change the script"] });
    const v = vd.get(orgId, cards[0].id)!;
    expect(v).toMatchObject({ kind: "broll", size: "vertical", seconds: 30, status: "draft", voiceId: "openai:coral", voiceName: "Coral" });
    expect(vd.scriptOf(v).shots.map((s) => [s.at, s.see, s.say])).toEqual(SCRIPT.shots.map((s) => [s.at, s.see, s.say]));
    expect(vd.scriptOf(v).caption).toBe(SCRIPT.caption);
    const view = (await caller(owner).videos.get({ organizationId: orgId, id: v.id }))!;
    expect(view).toMatchObject({ kindLabel: "B-roll with voice-over", length: "0:30", statusLabel: "Script ready", hours: "4 work hours", voiceName: "Coral", voiceStandard: true });
    expect(view.shots[1]).toEqual({ at: 6, time: "0:06", see: "A person closing a laptop, coat on", say: "Therapy that fits after work.", photo: "" });

    // Another workspace never sees it.
    const other = await makeWorkspace("vid-write-2");
    expect(await caller(other.owner).videos.list({ organizationId: other.orgId })).toEqual([]);
    expect(await caller(other.owner).videos.get({ organizationId: other.orgId, id: v.id })).toBeNull();
    await expect(caller(other.owner).videos.make({ organizationId: other.orgId, id: v.id })).rejects.toThrow(/not in this workspace/);

    // Edit script: the shots as typed, back to a draft.
    const saved = await caller(owner).videos.saveScript({ organizationId: orgId, id: v.id, shots: [{ at: 0, see: "Lamp", say: "Evenings." }, { at: 10, see: "Chairs", say: "Book now." }] });
    expect(saved.shots.map((s) => s.see)).toEqual(["Lamp", "Chairs"]);
    expect(saved.caption).toBe(SCRIPT.caption);
  });

  it("makes it on a work-hour plan: voice-over, a still per shot, the cut, and 4 work hours for 30 seconds or less", async () => {
    const { orgId, owner } = await onPlan("vid-make");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const v = await vd.writeVideo(orgId, { instructions: "Our new evening hours" });
    decision = { ...blank, action: "make_video" };
    // On a plan, a job this big asks first.
    const ask = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make it" });
    expect(ask.reply.content).toMatch(/^Before I start: a video uses 8 work hours for each minute of video \(4 for 30 seconds\)\. You have 50 hr left\./);
    const go = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Go ahead" });
    expect(go.reply.content).toBe('Making "Evening hours are here" now. It usually takes a few minutes, and I\'ll post it here when it\'s done.');
    expect(vd.get(orgId, v.id)!.status).toBe("making");
    await vd.jobFor(v.id);

    const done = vd.get(orgId, v.id)!;
    expect(done.status).toBe("ready");
    expect(done.videoUrl).toMatch(/^\/files\/org-\d+\/videos\/video-\d+_[0-9a-f]+\.mp4$/);
    // The voice-over is every shot's words, read in the standard voice.
    const speech = calls.find((c) => c.url === "https://api.openai.com/v1/audio/speech")!;
    expect(JSON.parse(speech.init.body)).toMatchObject({ voice: "coral", input: "Evenings, finally. Therapy that fits after work. Sessions until 8 PM, Monday to Thursday. Book a free consult." });
    // One still per shot, vertical, with no words in the picture.
    const stills = calls.filter((c) => c.url === "https://queue.fal.run/fal-ai/nano-banana-pro" && c.init.method === "POST").map((c) => JSON.parse(c.init.body));
    expect(stills).toHaveLength(4);
    expect(stills[0]).toMatchObject({ aspect_ratio: "9:16", num_images: 1 });
    expect(stills[0].prompt).toMatch(/^A still frame of b-roll footage: Warm lamp in an empty office at dusk\..*No text/);
    // The cut: four clips with alternating moves, as long as the voice plus a short tail, captions from the words.
    const cut = rendered[0];
    expect([cut.w, cut.h]).toEqual([1080, 1920]);
    expect(cut.clips.map((c) => c.motion)).toEqual(["push", "right", "pull", "left"]);
    expect(cut.clips.reduce((n, c) => n + c.seconds, 0)).toBeCloseTo(cut.total, 3);
    expect(cut.total).toBeGreaterThan(6.5);
    expect(cut.captions[0]).toMatchObject({ text: "Evenings, finally." });
    expect(cut.captions.every((c) => c.text.split(" ").length <= 6)).toBe(true);
    expect(done.tenths).toBe(Math.round(cut.total * 10));
    // 8 work hours a minute, by the half minute: a 7-second video uses 4.
    const b = await hours.balance(orgId);
    expect(b.usedMinutes).toBe(240);
    const last = (await db.listChatMessages(orgId, elena.id)).at(-1)!;
    expect(last.content).toMatch(/^Your video "Evening hours are here" is ready\. It came out at 0:0\d and used 4 work hours\. It's on my Videos tab\.$/);
    expect(JSON.parse(last.cards!)[0]).toMatchObject({ type: "made_video", id: v.id });
    expect((await caller(owner).videos.get({ organizationId: orgId, id: v.id }))!.statusLabel).toBe("Ready");
  });

  it("won't start when the workspace is out of work hours, and a failed cut uses none", async () => {
    const { orgId } = await onPlan("vid-gate");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const v = await vd.writeVideo(orgId, { instructions: "Our new evening hours", kind: "explainer", size: "wide" });
    await withUsage({ orgId }, () => hours.charge(orgId, elena.id, "doc", 50));
    await expect(vd.makeVideo(orgId, v.id)).rejects.toThrow(/out of work hours/);
    expect(vd.get(orgId, v.id)!.status).toBe("draft");

    const fresh = await onPlan("vid-fail");
    const v2 = await vd.writeVideo(fresh.orgId, { instructions: "Our new evening hours", kind: "explainer", size: "wide" });
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

  it("makes a Video plan from trends into a b-roll video with Make it", async () => {
    const { orgId, owner } = await makeWorkspace("vid-plan");
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const plan = await db.createWorkItem({
      organizationId: orgId,
      employeeId: elena.id,
      kind: "video_plan",
      status: "drafted",
      title: "Three signs you need a break",
      sourceUrl: "https://example.com/trend",
      data: JSON.stringify({ trend: { name: "Three signs", whyItWorks: "Lists hold attention", sourceUrl: "https://example.com/trend" }, plan: { title: "Three signs you need a break", platform: "Instagram Reels", lengthSeconds: 20, hook: "Tired all the time?", shots: [{ time: "0:00-0:03", shot: "Coffee cup on a desk", say: "Tired all the time?" }, { time: "0:03-0:12", shot: "Window with rain", say: "Here are three signs." }, { time: "0:12", shot: "Calendar", say: "Book a session." }], caption: "Save this." } }),
    });
    const made = await caller(owner).video.makeIt({ organizationId: orgId, id: plan.id });
    expect(made).toMatchObject({ kind: "broll", size: "vertical", seconds: 20, status: "making", planId: plan.id, caption: "Save this." });
    expect(made.shots.map((s) => [s.at, s.see, s.say])).toEqual([[0, "Coffee cup on a desk", "Tired all the time?"], [3, "Window with rain", "Here are three signs."], [12, "Calendar", "Book a session."]]);
    await vd.jobFor(made.id);
    expect(vd.get(orgId, made.id)!.status).toBe("ready");
    // Pressing it again returns the same video, not a second one.
    await caller(owner).video.makeIt({ organizationId: orgId, id: plan.id });
    expect(vd.list(orgId)).toHaveLength(1);

    // In chat, "make the three signs one" finds the plan by its title.
    const p2 = await db.createWorkItem({ organizationId: orgId, employeeId: elena.id, kind: "video_plan", status: "drafted", title: "Morning routine for therapists", sourceUrl: "https://example.com/t2", data: JSON.stringify({ plan: { title: "Morning routine for therapists", lengthSeconds: 15, shots: [{ time: "0:00", shot: "Sunrise", say: "Start slow." }] } }) });
    decision = { ...blank, action: "make_video", target: "morning routine" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make the morning routine one" });
    expect(r.reply.content).toMatch(/^Making "Morning routine for therapists" now\./);
    const v = vd.list(orgId).find((x) => x.planId === p2.id)!;
    await vd.jobFor(v.id);
    expect(vd.get(orgId, v.id)!.status).toBe("ready");
  });

  it("cuts real stills into an MP4 with ffmpeg: moves, captions and the voice-over", async () => {
    vd.setRenderer(null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videos-cut-"));
    const img = path.join(dir, "a.png");
    fs.writeFileSync(img, png);
    const audio = path.join(dir, "vo.mp3");
    fs.writeFileSync(audio, mp3.subarray(0, Math.floor(mp3.length / 4)));
    const plan = vd.planCut([{ say: "One two three." }, { say: "Four five." }], 1.2);
    const out = await vd.render({ w: 180, h: 320, audio, delay: 0.3, total: plan.total, captions: plan.captions, clips: [{ file: img, seconds: plan.durations[0], fit: "cover", pad: "#000000", motion: "push" }, { file: img, seconds: plan.durations[1], fit: "contain", pad: "#0d3b2e", motion: "right" }] });
    const file = path.join(dir, "out.mp4");
    fs.writeFileSync(file, out);
    const p = await drama.probe(file);
    expect(p.audio).toBe(true);
    expect(Math.abs(p.duration - plan.total)).toBeLessThan(0.25);
  });
});
