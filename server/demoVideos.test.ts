import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// The browser is scripted here: a practice run, then a recorded run with real pictures of the screen.
const browserTasks: any[] = [];
let recordFails = false;
/** A recorded run stopped by the person after step 1 finished (its result was on screen). */
let stopAfterOne = false;
/** A recorded run that has to sign in first: it asks, then waits for the answer like the real browser. */
let askFor: "code" | "email" | null = null;
let answered: string | null = null;
let frameDir = "";
vi.mock("./employees/browser", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    runBrowserTask: vi.fn(async (task: any) => {
      browserTasks.push(task);
      const base = { storageState: null, downloads: [], screenshotUrl: null, helped: [], url: task.startUrl, note: "", result: '{"answer":"recorded"}' };
      if (!task.record) return { ...base, status: "done", log: [{ step: 1, action: "click", detail: "Opened Calendar", url: task.startUrl }], result: '{"answer":"The calendar has a Book anyway button."}' };
      if (recordFails) return { ...base, status: "failed", note: "The Book anyway button wasn't on the screen", log: [] };
      if (stopAfterOne) {
        const rec = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
        const frames = ["red", "green"].map((c, i) => {
          const f = path.join(rec, `${i}.jpg`);
          fs.copyFileSync(path.join(frameDir, `${c}.jpg`), f);
          return { t: i * 2, file: f };
        });
        return { ...base, status: "failed", note: "Stopped by you.", frames, recDir: rec, view: { width: 320, height: 200 }, log: [{ step: 1, action: "click", detail: "Clicked Calendar", url: task.startUrl, at: 0.3, end: 0.8, box: { x: 10, y: 20, w: 60, h: 20 }, plan: 1 }] };
      }
      if (askFor && task.ask) {
        await task.ask.post(askFor, "Enter the code we emailed you");
        for (let i = 0; i < 400 && !answered; i++) {
          answered = task.ask.take(askFor) ?? null;
          if (!answered) await new Promise((r) => setTimeout(r, 25));
        }
        task.ask.done?.();
      }
      // Three moments on screen, one click in each of steps 1 and 2.
      const rec = fs.mkdtempSync(path.join(os.tmpdir(), "rec-"));
      const frames = ["red", "green", "blue"].map((c, i) => {
        const f = path.join(rec, `${i}.jpg`);
        fs.copyFileSync(path.join(frameDir, `${c}.jpg`), f);
        return { t: i * 2, file: f };
      });
      return {
        ...base,
        status: "done",
        frames,
        recDir: rec,
        view: { width: 320, height: 200 },
        log: [
          { step: 1, action: "click", detail: "Clicked Calendar", url: task.startUrl, at: 0.5, end: 1.2, box: { x: 10, y: 20, w: 60, h: 20 }, plan: 1 },
          { step: 2, action: "click", detail: "Clicked Thursday 6 PM", url: task.startUrl, at: 2.6, end: 3.4, box: { x: 200, y: 120, w: 40, h: 30 }, plan: 2 },
        ],
      };
    }),
  };
});

let planOut: any = null;
let decision: any = { reply: "", action: "none" };
let hooksOut: any = { hooks: ["Hey guys, booking after hours takes ten seconds.", "POV: a client wants 6 PM."] };
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => (opts.schemaName === "demo_plan" ? planOut : opts.schemaName === "demo_hooks" ? hooksOut : opts.schemaName === "chat_decision" ? decision : {})),
  };
});

let heard = "I'm Ashley Bryant, and I agree to LeadDash making videos of me with my face and voice.";
vi.mock("./_core/transcribe", async (orig) => {
  const actual: any = await orig();
  return { ...actual, transcribeFile: vi.fn(async () => ({ text: heard, words: [], seconds: 6 })) };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as hours from "./workHours";
import * as dv from "./employees/demoVideos";
import * as tw from "./employees/twin";
import * as drama from "./employees/drama";
import { renderDemo, clipFromFrames, stepTiming, zoomExpr, type DemoRenderInput } from "./employees/demoRender";
import { probe } from "./employees/broll";
import { ENV } from "./_core/env";
import { storagePut } from "./storage";
import { twins, twinLooks, outboundItems } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";

const ff = () => createRequire(import.meta.url)("ffmpeg-static") as string;
let dir: string;
let mp3: Buffer;
let talkMp4: Buffer;
let calls: { url: string; init: any }[] = [];
let models = new Map<string, string>();
let rendered: DemoRenderInput[] = [];
const before = { fal: ENV.falKey, openai: ENV.openAiKey };

const PLAN = {
  title: "Booking outside a clinician's availability",
  questionText: "",
  questionOptions: [],
  startsOn: "Calendar, Dr. Rivera's week",
  needs: ["A demo clinician with hours set"],
  doneWhen: "The session shows on Thursday at 6 PM",
  intro: "Here's how to book a session outside a clinician's hours.",
  outro: "That's it. Check with the clinician first.",
  steps: [
    { do: "Click Calendar", say: "Open the calendar.", expect: "The week view" },
    { do: "Click Thursday at 6 PM", say: "Click the time you want, even outside her hours.", expect: "The new appointment form" },
  ],
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-t-"));
  frameDir = dir;
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220", "-t", "2", path.join(dir, "vo.mp3")]);
  mp3 = fs.readFileSync(path.join(dir, "vo.mp3"));
  for (const c of ["red", "green", "blue"]) execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c}:size=320x200`, "-frames:v", "1", path.join(dir, `${c}.jpg`)]);
  execFileSync(ff(), ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-f", "lavfi", "-i", "sine=frequency=300", "-t", "3", "-pix_fmt", "yuv420p", "-shortest", path.join(dir, "talk.mp4")]);
  talkMp4 = fs.readFileSync(path.join(dir, "talk.mp4"));
});

beforeEach(() => {
  calls = [];
  models = new Map();
  rendered = [];
  browserTasks.length = 0;
  recordFails = false;
  stopAfterOne = false;
  askFor = null;
  answered = null;
  planOut = PLAN;
  drama.setPollMs(1);
  (ENV as any).falKey = "fal-test";
  (ENV as any).openAiKey = "sk-test";
  dv.setDemoRenderer(async (input) => {
    rendered.push(input);
    for (const p of input.parts) {
      if (p.kind === "step") expect(fs.existsSync(p.clip)).toBe(true);
      if (p.audio) expect(fs.existsSync(p.audio)).toBe(true);
      if (p.avatar) expect(fs.existsSync(p.avatar)).toBe(true);
    }
    return Buffer.from("mp4-bytes");
  });
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === "https://api.openai.com/v1/audio/speech") return new Response(mp3, { status: 200 });
    if (u.startsWith("https://rest.fal.ai/storage/upload/initiate")) return Response.json({ upload_url: "https://fal-up/put1", file_url: "https://fal.media/source" });
    if (u === "https://fal-up/put1") return new Response("", { status: 200 });
    if (u.startsWith("https://queue.fal.run/") && init.method === "POST") {
      const id = `r${++n}`;
      models.set(id, u.slice("https://queue.fal.run/".length));
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/req/${id}/status`, response_url: `https://queue.fal.run/req/${id}` });
    }
    if (/\/req\/r\d+\/status$/.test(u)) return Response.json({ status: "COMPLETED" });
    if (/\/req\/r\d+$/.test(u)) return Response.json({ video: { url: "https://fal.media/talk.mp4" } });
    if (u === "https://fal.media/talk.mp4") return new Response(talkMp4, { status: 200 });
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  dv.setDemoRenderer(null);
  (ENV as any).falKey = before.fal;
  (ENV as any).openAiKey = before.openai;
});

async function onPlan(slug: string) {
  const w = await makeWorkspace(slug);
  await caller(w.staff).hours.setPlan({ organizationId: w.orgId, plan: "starter" });
  return w;
}
const settle = async (orgId: number, id: number) => {
  for (let i = 0; i < 200; i++) {
    const job = dv.jobFor(id);
    if (!job) break;
    await job;
  }
  return dv.get(orgId, id)!;
};
const DEMO_URL = "https://demo.leaddash.io/calendar";

/** A twin that's ready: its video in, consent heard. */
async function readyTwin(orgId: number) {
  const saved = await storagePut(`org-${orgId}/twin/twin.mp4`, talkMp4, "video/mp4");
  return db.getDb().insert(twins).values({ organizationId: orgId, name: "Ashley Bryant", sourceUrl: saved.url, tenths: 30, status: "ready", consent: "ok", consentUrl: saved.url, voiceId: "openai:sage", voiceName: "Ashley's voice", createdBy: "Owner" }).returning().get();
}

describe("Simone's demo videos", { timeout: 60_000 }, () => {
  it("records LeadDash EHR only in the demo practice: the browser demo, or Maple Crest Counseling in the live app with a sign-in", () => {
    expect(() => dv.checkWhere("https://app.leaddash.io/calendar")).toThrow(/demo practice/);
    expect(() => dv.checkWhere("https://demo.leaddash.io/calendar")).not.toThrow();
    expect(() => dv.checkWhere("https://ehr.leaddash.io/calendar-view", { loginName: null, email: null })).toThrow(/Maple Crest Counseling team/);
    expect(() => dv.checkWhere("https://ehr.leaddash.io/calendar-view", { loginName: null, email: "sarah@example.com" })).not.toThrow();
    expect(dv.demoPracticeRule("https://ehr.leaddash.io/calendar-view")).toMatch(/must say "Maple Crest Counseling"/);
    expect(dv.demoPracticeRule("https://demo.leaddash.io/calendar")).toBe("");
    expect(dv.stepsDone({ frames: [{ t: 0, file: "" }, { t: 2, file: "" }], log: [{ at: 0.3, end: 0.8, plan: 1 } as any] }, 2)).toBe(1);
    expect(dv.stepsDone({ frames: [{ t: 0, file: "" }, { t: 1, file: "" }], log: [{ at: 0.3, end: 0.8, plan: 1 } as any] }, 2)).toBe(0);
    expect(dv.stepsDone({ frames: [{ t: 0, file: "" }, { t: 9, file: "" }], log: [{ at: 0.3, end: 0.8, plan: 1 } as any, { at: 2, end: 2.5, plan: 2 } as any] }, 2)).toBe(2);
    expect(() => dv.checkWhere(DEMO_URL)).not.toThrow();
    expect(() => dv.checkWhere("https://events.leaddash.io/admin")).not.toThrow();
  });

  it("plans first (a practice run when there's no guide), and records nothing until Record it", async () => {
    const w = await onPlan("demo-plan");
    const c = caller(w.owner);
    const made = await c.demo.create({ organizationId: w.orgId, ask: "Book a session outside a clinician's availability", kind: "training", presenter: "screen", url: DEMO_URL, audience: "Front desk" });
    expect(made.status).toBe("planning");
    const d = await settle(w.orgId, made.id);
    expect(d.status).toBe("plan");
    expect(d.title).toBe(PLAN.title);
    // The practice run never presses a button that changes anything.
    expect(browserTasks).toHaveLength(1);
    expect(browserTasks[0]).toMatchObject({ record: false, allowSubmit: false });
    const v = await c.demo.get({ organizationId: w.orgId, id: d.id });
    expect(v!.plan.steps.map((s) => s.do)).toEqual(["Click Calendar", "Click Thursday at 6 PM"]);
    expect(v!.lines.map((l) => l.label)).toEqual(["Opening", "1", "2", "Closing"]);
    // 2 work hours for each started minute of screen time.
    expect(v!.hours).toBe("2 work hours");
    // Edit a step in place.
    const saved = await c.demo.saveStep({ organizationId: w.orgId, id: d.id, n: 1, do: "Click Thursday at 6:00 PM", say: "Click the time you want." });
    expect(saved.plan.steps[1]).toMatchObject({ do: "Click Thursday at 6:00 PM", say: "Click the time you want." });
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(0);
  });

  it("asks first when the ask could mean two things, then plans with the choice", async () => {
    const w = await onPlan("demo-ask");
    planOut = { ...PLAN, questionText: "Which insurance payment?", questionOptions: ["A client copay", "An insurance check", "Both, as two videos"], steps: [] };
    const made = await dv.create(w.orgId, { ask: "How to take an insurance payment", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    let d = await settle(w.orgId, made.id);
    expect(d.status).toBe("asking");
    await expect(dv.record(w.orgId, d.id, "Owner")).rejects.toThrow(/Answer the question/);
    planOut = PLAN;
    dv.answer(w.orgId, d.id, "An insurance check");
    d = await settle(w.orgId, d.id);
    expect(d.status).toBe("plan");
  });

  it("records the plan, cuts each step with its clicks, reads the lines and makes the video and the SOP", async () => {
    const w = await onPlan("demo-rec");
    const made = await dv.create(w.orgId, { ask: "Book a late session", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    await settle(w.orgId, made.id);
    await dv.record(w.orgId, made.id, "Owner");
    const d = await settle(w.orgId, made.id);
    expect(d.error).toBeNull();
    expect(d.status).toBe("ready");
    // The recorded run: allowed to press buttons only because it's the EHR demo practice.
    const rec = browserTasks.find((t) => t.record);
    expect(rec).toMatchObject({ allowSubmit: true, startUrl: DEMO_URL });
    expect(rec.goal).toContain("1. Do: Click Calendar");
    // Each step is its own clip, with its click where it landed.
    const take = dv.takeOf(d);
    expect(take.steps).toHaveLength(2);
    expect(take.steps[0].clicks).toEqual([expect.objectContaining({ x: 10, y: 20, w: 60, h: 20 })]);
    expect(take.steps[1].clicks).toEqual([expect.objectContaining({ x: 200, y: 120 })]);
    expect(take.screen).toEqual({ w: 320, h: 200 });
    // Every line read once: opening, 2 steps, closing.
    expect(calls.filter((c) => c.url === "https://api.openai.com/v1/audio/speech")).toHaveLength(4);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].parts.map((p) => p.kind)).toEqual(["card", "step", "step", "card"]);
    expect(rendered[0]).toMatchObject({ w: 1920, h: 1080, zoom: true });
    // The written SOP from the same steps, a screenshot under each.
    const sop = db.sops.get(w.orgId, d.sopId!)!;
    expect(sop.title).toBe(d.title);
    expect(JSON.parse(sop.steps).map((s: any) => s.title)).toEqual(["Click Calendar", "Click Thursday at 6 PM"]);
    expect(JSON.parse(sop.steps).every((s: any) => s.imageUrl)).toBe(true);
    // Simone posts it with a card.
    const simone = (await db.getEmployeeByKind(w.orgId, "coo"))!;
    const msgs = await db.listChatMessages(w.orgId, simone.id);
    expect(JSON.parse(msgs[msgs.length - 1].cards ?? "[]")).toEqual([{ type: "demo_video", id: d.id, title: d.title }]);
    // Screen time once: 2 work hours for the first minute.
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(120);

    // Edit line: only that line is read again, cut again, no more hours.
    calls = [];
    dv.editLine(w.orgId, d.id, "s1", "Click Thursday at six.", "Owner");
    const after = await settle(w.orgId, d.id);
    expect(after.status).toBe("ready");
    expect(calls.filter((c) => c.url === "https://api.openai.com/v1/audio/speech")).toHaveLength(1);
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(120);
    // A new size is cut from the same recording, no hours.
    dv.setSizes(w.orgId, d.id, ["wide", "vertical"], "Owner");
    const both = await settle(w.orgId, d.id);
    expect(Object.keys(JSON.parse(both.videoUrls)).sort()).toEqual(["vertical", "wide"]);
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(120);
  });

  it("stops the take instead of improvising when the screen doesn't match, and keeps the plan", async () => {
    const w = await onPlan("demo-stop");
    const made = await dv.create(w.orgId, { ask: "Book a late session", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    await settle(w.orgId, made.id);
    recordFails = true;
    await dv.record(w.orgId, made.id, "Owner");
    const d = await settle(w.orgId, made.id);
    expect(d.status).toBe("plan");
    expect(d.error).toMatch(/Book anyway button/);
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(0);
  });

  it("a stopped recording keeps the steps that finished: keep going records the rest, or stop and build makes the video from them", async () => {
    const w = await onPlan("demo-keep");
    const made = await dv.create(w.orgId, { ask: "Book a late session", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    await settle(w.orgId, made.id);
    stopAfterOne = true;
    await dv.record(w.orgId, made.id, "Owner");
    let d = await settle(w.orgId, made.id);
    expect(d.status).toBe("plan");
    expect(d.error).toMatch(/Stopped by you\. Steps 1 to 1 of 2 are recorded\. Keep going from step 2/);
    expect(dv.takeOf(d).steps).toHaveLength(1);
    expect(dv.takeOf(d).steps[0].shot).toBeTruthy();
    expect((await dv.view(d)).recordedUpTo).toBe(1);
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(0);
    // Keep going: the browser is told steps 1 to 1 are done; step 1's clip is the kept one.
    stopAfterOne = false;
    const kept = dv.takeOf(d).steps[0].clip;
    await dv.record(w.orgId, made.id, "Owner", { from: 1 });
    d = await settle(w.orgId, made.id);
    expect(d.status).toBe("ready");
    expect(browserTasks[browserTasks.length - 1].goal).toContain("Steps 1 to 1 are recorded already");
    expect(dv.takeOf(d).steps).toHaveLength(2);
    expect(dv.takeOf(d).steps[0].clip).toBe(kept);
    expect((await dv.view(d)).recordedUpTo).toBe(0);

    // Stop and build: the video is made from step 1 alone, and the plan is cut to it.
    const w2 = await onPlan("demo-build");
    const m2 = await dv.create(w2.orgId, { ask: "Book a late session", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    await settle(w2.orgId, m2.id);
    stopAfterOne = true;
    await dv.record(w2.orgId, m2.id, "Owner");
    await settle(w2.orgId, m2.id);
    rendered = [];
    await dv.buildRecorded(w2.orgId, m2.id, "Owner");
    const b = await settle(w2.orgId, m2.id);
    expect(b.status).toBe("ready");
    expect(dv.planOf(b).steps).toHaveLength(1);
    expect(dv.planOf(b).doneWhen).toBe("The week view");
    expect(rendered[0].parts.map((p) => p.kind)).toEqual(["card", "step", "card"]);
    await expect(dv.record(w2.orgId, m2.id, "Owner", { from: 1 })).rejects.toThrow(/Nothing is recorded yet|Record it/);
  });

  it("makes the avatar say every line in the corner, in the twin's look and voice, and counts avatar time by the half minute", async () => {
    const w = await onPlan("demo-corner");
    const t = await readyTwin(w.orgId);
    const made = await dv.create(w.orgId, { ask: "Book a late session", kind: "training", presenter: "corner", avatar: { type: "twin", twinId: t.id }, url: DEMO_URL, by: "Owner" });
    expect(made.voiceId).toBe("openai:sage");
    await settle(w.orgId, made.id);
    await dv.record(w.orgId, made.id, "Owner");
    const d = await settle(w.orgId, made.id);
    expect(d.error).toBeNull();
    // Sync Lipsync on the twin's own video for each of the 4 lines.
    expect(Array.from(models.values()).filter((m) => m.includes("sync-lipsync"))).toHaveLength(4);
    const steps = rendered[0].parts.filter((p) => p.kind === "step");
    expect(steps.every((p) => !!p.avatar)).toBe(true);
    // 4 lines of 2 seconds: 8 seconds of avatar time is one started half minute (4 hours), plus 2 for screen time.
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(240 + 120);
  });

  it("refuses an avatar presenter without an avatar, and a twin that hasn't given consent", async () => {
    const w = await onPlan("demo-noav");
    await expect(dv.create(w.orgId, { ask: "x", kind: "training", presenter: "corner", url: DEMO_URL, by: "Owner" })).rejects.toThrow(/Pick the avatar/);
    const t = await readyTwin(w.orgId);
    db.getDb().update(twins).set({ consent: "needed" }).where(eq(twins.id, t.id)).run();
    await expect(tw.talk(w.orgId, t.id, null, path.join(dir, "vo.mp3"), path.join(dir, "out.mp4"))).rejects.toThrow(/consent/);
  });

  it("makes social videos: avatar hook and ending, the screen with a bubble, new hooks, 3 versions, and Send to Sienna", async () => {
    const w = await onPlan("demo-social");
    const t = await readyTwin(w.orgId);
    const made = await dv.create(w.orgId, { ask: "Come with me while I book a late session", kind: "social", presenter: "screen", avatar: { type: "twin", twinId: t.id }, socialStyle: "come", url: DEMO_URL, by: "Owner" });
    expect(made).toMatchObject({ presenter: "bookends" });
    expect(dv.sizesOf(made)).toEqual(["vertical"]);
    await settle(w.orgId, made.id);
    await dv.record(w.orgId, made.id, "Owner");
    const d = await settle(w.orgId, made.id);
    expect(d.status).toBe("ready");
    expect(rendered[0]).toMatchObject({ w: 1080, h: 1920 });
    const [hook, s1, , end] = rendered[0].parts;
    expect(hook).toMatchObject({ kind: "card" });
    expect((hook as any).avatar).toBeTruthy();
    expect((end as any).avatar).toBeTruthy();
    // The screen parts carry the presenter in a bubble, never the full avatar.
    expect((s1 as any).bubble).toBeTruthy();
    expect((s1 as any).avatar).toBeNull();
    const v = await dv.view(d);
    expect(v.lines.map((l) => l.label)).toEqual(["Hook", "1", "2", "Ending"]);
    expect(v.clips.intro).toBeTruthy();

    // 3 versions: two more from the same recording with other hooks.
    const more = await dv.versions(w.orgId, d.id, "Owner");
    expect(more).toHaveLength(2);
    for (const m of more) {
      const x = await settle(w.orgId, m.id);
      expect(x.status).toBe("ready");
      expect(dv.planOf(x).intro).toMatch(/booking after hours|6 PM/);
    }
    // No new screen recording for the versions.
    expect(browserTasks.filter((b) => b.record)).toHaveLength(1);

    const post = await dv.toSienna(w.orgId, d.id, "Owner");
    const row = db.getDb().select().from(outboundItems).where(eq(outboundItems.id, post.id)).get()!;
    expect(row).toMatchObject({ kind: "social_post", status: "pending_approval" });
    expect(JSON.parse(row.metadata ?? "{}").post).toMatchObject({ type: "reel" });
  });

  it("makes an SOP's video from its steps, recorded where it was walked", async () => {
    const w = await onPlan("demo-sop");
    const sops = await import("./employees/sops");
    const s = sops.create(w.orgId, { title: "Adding availability", area: "admin", steps: [{ title: "Open Settings", detail: "", imageUrl: null }] }, "Owner", { kind: "site", note: "Walked", url: DEMO_URL });
    const c = caller(w.owner);
    const v0 = await c.sops.video({ organizationId: w.orgId, id: s.id });
    expect(v0).toMatchObject({ ready: null, latest: null, site: DEMO_URL, steps: 1 });
    const { id } = await c.sops.makeVideo({ organizationId: w.orgId, id: s.id });
    const d = await settle(w.orgId, id);
    expect(d).toMatchObject({ fromSopId: s.id, sopId: s.id, makeSop: false, url: DEMO_URL });
    // A screen recording has no site to record on: it needs a saved login.
    const r = sops.create(w.orgId, { title: "From my recording", area: "admin", steps: [{ title: "One", detail: "", imageUrl: null }] }, "Owner", { kind: "record", note: "Mine", url: "/files/org-1/sops/rec.webm" });
    await expect(c.sops.makeVideo({ organizationId: w.orgId, id: r.id })).rejects.toThrow(/Pick where to record/);
  });

  it("lets Simone start one from chat, and shows the plan before recording", async () => {
    const w = await onPlan("demo-chat");
    const simone = (await db.getEmployeeByKind(w.orgId, "coo"))!;
    decision = { reply: "", action: "demo_video", title: "Taking a copay", url: DEMO_URL, target: "", focus: "training", to: "", notes: "Front desk", goal: "", message: "" };
    const r = await caller(w.owner).chat.send({ organizationId: w.orgId, employeeId: simone.id, text: "Make a training video on taking a copay in the EHR demo" });
    const cards = JSON.parse(r.reply.cards ?? "[]");
    expect(cards[0]).toMatchObject({ type: "demo_video" });
    const d = await settle(w.orgId, cards[0].id);
    expect(d).toMatchObject({ status: "plan", presenter: "screen", audience: "Front desk" });
    expect(browserTasks.filter((b) => b.record)).toHaveLength(0);
  });
});

describe("Signing Simone in", { timeout: 60_000 }, () => {
  it("adds https:// to a bare web address, so the browser can open it", async () => {
    const w = await onPlan("demo-url");
    const d = await dv.create(w.orgId, { ask: "Write a note", kind: "training", presenter: "screen", url: "demo.leaddash.io", signInEmail: "Demo@LeadDash.io", by: "Owner" });
    expect(d).toMatchObject({ url: "https://demo.leaddash.io", signInEmail: "demo@leaddash.io" });
    await settle(w.orgId, d.id);
    // Rows saved before this keep working too.
    expect(dv.fullUrl("demo.leaddash.io")).toBe("https://demo.leaddash.io");
    expect(browserTasks[0]).toMatchObject({ startUrl: "https://demo.leaddash.io" });
    expect(browserTasks[0].secrets.email).toBe("demo@leaddash.io");
  });

  it("waits on the same page for the code the site sent, asked in chat and on the Videos tab", async () => {
    const w = await onPlan("demo-code");
    const c = caller(w.owner);
    const made = await dv.create(w.orgId, { ask: "Book a late session", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    await settle(w.orgId, made.id);
    askFor = "code";
    await c.demo.record({ organizationId: w.orgId, id: made.id });
    let v = await c.demo.get({ organizationId: w.orgId, id: made.id });
    for (let i = 0; i < 100 && v?.asking !== "code"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      v = await c.demo.get({ organizationId: w.orgId, id: made.id });
    }
    expect(v).toMatchObject({ asking: "code", step: "Waiting for the sign-in code" });
    const simone = (await db.getEmployeeByKind(w.orgId, "coo"))!;
    const msgs = await db.listChatMessages(w.orgId, simone.id);
    const last = msgs[msgs.length - 1];
    expect(last.content).toMatch(/sent a sign-in code/);
    expect(JSON.parse(last.cards ?? "[]")[0]).toMatchObject({ type: "demo_signin", id: made.id });
    await expect(c.demo.signIn({ organizationId: w.orgId, id: made.id, code: "no" })).rejects.toThrow(/exactly as the site sent it/);
    await c.demo.signIn({ organizationId: w.orgId, id: made.id, code: "482910" });
    const d = await settle(w.orgId, made.id);
    expect(answered).toBe("482910");
    expect(d).toMatchObject({ status: "ready", asking: null });
  });

  it("takes the email in Simone's chat when the site needs one", async () => {
    const w = await onPlan("demo-email");
    const made = await dv.create(w.orgId, { ask: "Book a late session", kind: "training", presenter: "screen", url: DEMO_URL, by: "Owner" });
    await settle(w.orgId, made.id);
    askFor = "email";
    await dv.record(w.orgId, made.id, "Owner");
    for (let i = 0; i < 100 && !dv.waitingSignIn(w.orgId); i++) await new Promise((r) => setTimeout(r, 20));
    const simone = (await db.getEmployeeByKind(w.orgId, "coo"))!;
    decision = { reply: "", action: "demo_signin", notes: "", to: "", title: "", url: "", target: "", focus: "", goal: "", message: "" };
    const r = await caller(w.owner).chat.send({ organizationId: w.orgId, employeeId: simone.id, text: "use demo@leaddash.io" });
    expect(r.reply.content).toMatch(/Signing in with that email/);
    const d = await settle(w.orgId, made.id);
    expect(answered).toBe("demo@leaddash.io");
    expect(d).toMatchObject({ status: "ready", signInEmail: "demo@leaddash.io", asking: null });
  });
});

describe("My twin", { timeout: 60_000 }, () => {
  it("checks the consent line's words, then makes the voice", async () => {
    expect(tw.consentScore("I'm Ashley Bryant and I agree to LeadDash making videos of me with my face and voice", tw.consentLine("Ashley Bryant"))).toBe(1);
    expect(tw.consentScore("hello there", tw.consentLine("Ashley Bryant"))).toBeLessThan(0.7);
    const w = await onPlan("twin-consent");
    const t = await readyTwin(w.orgId);
    db.getDb().update(twins).set({ consent: "needed", consentUrl: null, voiceId: null, voiceName: null }).where(eq(twins.id, t.id)).run();
    const rec = await storagePut(`org-${w.orgId}/twin/consent.mp4`, talkMp4, "video/mp4");
    heard = "something else entirely";
    expect((await tw.checkConsent(w.orgId, t.id)).consent).toBe("needed");
    tw.setConsent(w.orgId, t.id, rec.url);
    await tw.jobFor(`consent-${t.id}`);
    expect(tw.get(w.orgId, t.id)!.consent).toBe("failed");
    heard = tw.consentLine("Ashley Bryant");
    tw.setConsent(w.orgId, t.id, rec.url);
    await tw.jobFor(`consent-${t.id}`);
    const ok = tw.get(w.orgId, t.id)!;
    expect(ok.consent).toBe("ok");
    // No ElevenLabs on this workspace: it says so, and a standard voice can be picked.
    expect(ok.voiceNote).toMatch(/Connect ElevenLabs/);
    expect(() => tw.setConsent(w.orgId, t.id, "/files/org-999/x.mp4")).toThrow(/not in this workspace/);
    expect(() => tw.rename(w.orgId, t.id, "Someone else")).toThrow(/consent line/);
  });

  it("prices a look: an outfit is one 10-second AI clip, a background is green screen by the minute", () => {
    const t = { tenths: 1250 };
    expect(tw.lookMinutes(t, { outfit: "describe", background: { type: "room" } })).toBe(240);
    expect(tw.lookMinutes(t, { outfit: "keep", background: { type: "color" } })).toBe(3 * 120);
    expect(tw.lookMinutes(t, { outfit: "photo", background: { type: "color" } })).toBe(240 + 120);
  });

  it("makes a new place behind the twin, previews it, and only saved looks are used", async () => {
    const w = await onPlan("twin-look");
    const t = await readyTwin(w.orgId);
    // The cutout comes back as the picture and the matte.
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.startsWith("https://rest.fal.ai/storage/upload/initiate")) return Response.json({ upload_url: "https://fal-up/put1", file_url: "https://fal.media/source" });
      if (u === "https://fal-up/put1") return new Response("", { status: 200 });
      if (u.startsWith("https://queue.fal.run/") && init.method === "POST") return Response.json({ request_id: "c1", status_url: "https://queue.fal.run/req/c1/status", response_url: "https://queue.fal.run/req/c1" });
      if (u.endsWith("/req/c1/status")) return Response.json({ status: "COMPLETED" });
      if (u.endsWith("/req/c1")) return Response.json({ video: [{ url: "https://fal.media/rgb.mp4" }, { url: "https://fal.media/rgb2.mp4" }] });
      if (u.startsWith("https://fal.media/")) return new Response(talkMp4, { status: 200 });
      return new Response("no route", { status: 500 });
    });
    const l = await tw.newLook(w.orgId, t.id, { name: "Brand green", outfit: "keep", background: { type: "color", color: "#1B6B4A" } });
    await tw.jobFor(`look-${l.id}`);
    const made = tw.getLook(w.orgId, l.id)!;
    expect(made.error).toBeNull();
    expect(made.status).toBe("preview");
    expect(made.baseUrl).toMatch(/^\/files\//);
    // A preview can't be used yet.
    const o1 = await (await import("./employees/presenters")).options(w.orgId);
    expect(o1.twins[0].looks).toEqual([]);
    tw.saveLook(w.orgId, l.id);
    const o2 = await (await import("./employees/presenters")).options(w.orgId);
    expect(o2.twins[0].looks).toEqual([{ id: l.id, name: "Brand green", thumbUrl: expect.any(String) }]);
    // Green screen for the 3-second video: one minute.
    expect((await hours.balance(w.orgId)).usedMinutes).toBe(120);
    expect(db.getDb().select().from(twinLooks).where(and(eq(twinLooks.organizationId, w.orgId))).all()).toHaveLength(1);
  });
});

describe("The demo cut (real ffmpeg)", { timeout: 180_000 }, () => {
  it("speeds through waits but always plays the whole line, and zooms in on clicks", () => {
    expect(stepTiming(10, 2).seconds).toBeLessThan(10);
    expect(stepTiming(1, 4).seconds).toBeGreaterThanOrEqual(4.9);
    expect(zoomExpr([], 320, 200)).toBeNull();
    const z = zoomExpr([{ at: 1, cx: 160, cy: 100 }], 320, 200)!;
    expect(z.z).toMatch(/^1\+0\.6\*/);
    expect(z.cx).toContain("160");
  });

  async function parts(mode: "screen" | "corner" | "bookends" | "social", w: number, h: number) {
    const frames = ["red", "green", "blue"].map((c, i) => ({ t: i, file: path.join(dir, `${c}.jpg`) }));
    const clip = path.join(dir, `clip-${mode}.mp4`);
    await clipFromFrames(frames, [{ from: 0, to: 3 }], clip);
    const talk = path.join(dir, "talk.mp4");
    const vo = path.join(dir, "vo.mp3");
    const bubble = path.join(dir, "red.jpg");
    const avatarCard = mode === "bookends" || mode === "social" || mode === "corner";
    const input: DemoRenderInput = {
      w,
      h,
      screen: { w: 320, h: 200 },
      parts: [
        { kind: "card", title: "Booking a late session", audio: vo, audioSeconds: 2, avatar: avatarCard ? talk : null, text: "Here's how." },
        { kind: "step", clip, clipSeconds: 3, clicks: [{ at: 0.5, x: 10, y: 20, w: 60, h: 20 }], audio: vo, audioSeconds: 2, avatar: mode === "corner" ? talk : null, bubble: mode === "social" ? bubble : null, text: "Click Calendar." },
        { kind: "card", title: "", audio: vo, audioSeconds: 2, avatar: avatarCard ? talk : null, text: "That's it." },
      ],
      zoom: true,
      captions: null,
      logo: { file: path.join(dir, "blue.jpg") },
      music: null,
      brand: "#1B6B4A",
    };
    const buf = await renderDemo(input);
    const out = path.join(dir, `out-${mode}.mp4`);
    fs.writeFileSync(out, buf);
    return probe(out);
  }

  it("cuts screen only, avatar in the corner, avatar opens and closes, and the social bubble, in every size", async () => {
    for (const [mode, w, h] of [["screen", 640, 360], ["corner", 640, 360], ["bookends", 360, 360], ["social", 360, 640]] as const) {
      const p = await parts(mode, w, h);
      expect(p.video).toBe(true);
      expect(p.audio).toBe(true);
      expect([p.width, p.height]).toEqual([w, h]);
      expect(p.seconds).toBeGreaterThan(6);
    }
  });
});
