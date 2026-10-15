import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

let decision: any = null;
let season: any = null;
let directions: any = null;
let campaignPlan: any = null;
let sceneOut: any = null;
const prompts: Record<string, string> = {};
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      prompts[opts.schemaName] = `${opts.system}\n${opts.prompt}`;
      return opts.schemaName === "chat_decision" ? decision : opts.schemaName === "scene" ? sceneOut : opts.schemaName === "drama_season" ? season : opts.schemaName === "campaign_directions" ? directions : opts.schemaName === "campaign_plan" ? campaignPlan : {};
    }),
  };
});

import { caller, makeWorkspace as makeCustomer } from "./test/helpers";
import * as db from "./db";

/** LeadDash's own workspace: its videos use the server's ElevenLabs account. */
async function makeWorkspace(slug: string) {
  const w = await makeCustomer(slug);
  await db.updateOrganization(w.orgId, { internal: true });
  return w;
}
import * as drama from "./employees/drama";
import { storagePut } from "./storage";
import { ENV } from "./_core/env";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const shot = (o: any) => ({ framing: "Close-up", move: "Slow push-in", action: "", setting: "A group practice office at night, desk lamp on", cast: [], line_who: "", line_text: "", seconds: 4, ...o });
const SEASON = {
  title: "Session Notes",
  premise: "A new therapist at an Oklahoma City group practice finds a file she was never meant to see. Who wrote it, and why is her name in it?",
  look: "Warm practical light, teal and amber grade, anamorphic 35mm, light grain.",
  cast: [
    { name: "Dr. Ashley Bryant", role: "Practice owner", owner: true, look: "Dark green blazer", voice: "" },
    { name: "Renee Cole", role: "New clinician, the lead", owner: false, look: "Late 20s, curly hair, cream sweater", voice: "Jessa" },
  ],
  episodes: [
    {
      title: "The New Clinician",
      music: "Low pulsing synth, slow build, drops out before the last line",
      logline: "A new therapist's first day ends with a file she was never supposed to see.",
      beats: [{ label: "Hook", at: "0:00", text: "Renee finds a sealed file on her desk." }, { label: "Cliffhanger", at: "0:55", text: "Dr. Bryant: I see you found it." }],
      shots: [
        shot({ framing: "Wide", move: "Slow dolly in", action: "An empty hallway, one office light on.", seconds: 3 }),
        shot({ action: "Renee Cole opens the file and freezes.", cast: ["Renee Cole"] }),
        shot({ action: "Dr. Ashley Bryant in the doorway, calm.", cast: ["Dr. Ashley Bryant"], line_who: "Dr. Ashley Bryant", line_text: "I see you found it." }),
        shot({ action: "A stranger nobody cast.", cast: ["Nobody"], line_who: "Nobody", line_text: "This line is dropped." }),
      ],
    },
  ],
};

let calls: { url: string; init: any }[] = [];
let refuseSeedance = false;
let clip: Buffer;
let mp3: Buffer;
const before = { fal: ENV.falKey, eleven: ENV.elevenLabsKey };

beforeAll(() => {
  // A real 2-second clip with sound, so the episode really gets cut together.
  const ff = createRequire(import.meta.url)("ffmpeg-static") as string;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drama-t-")), "c.mp4");
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=576x1024:rate=24", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "2", "-shortest", out]);
  clip = fs.readFileSync(out);
  const m = path.join(path.dirname(out), "m.mp3");
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220", "-t", "6", m]);
  mp3 = fs.readFileSync(m);
});

beforeEach(() => {
  calls = [];
  drama.setPollMs(1);
  (ENV as any).falKey = "fal-test";
  (ENV as any).elevenLabsKey = "el-test";
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("api.elevenlabs.io/v1/text-to-speech/")) return new Response(mp3, { status: 200 }); // a real MP3
    if (u.startsWith("https://api.elevenlabs.io/v1/music")) return new Response(mp3, { status: 200 });
    if (u.startsWith("https://api.elevenlabs.io/v1/sound-generation")) return new Response(mp3, { status: 200 });
    if (refuseSeedance && u.startsWith("https://queue.fal.run/bytedance/seedance") && init.method === "POST") {
      return Response.json({ detail: [{ msg: "The images or videos provided may contain likenesses of real people or other private information that cannot be processed." }] }, { status: 422 });
    }
    if (u.startsWith("https://queue.fal.run/") && init.method === "POST") {
      const id = `r${++n}`;
      const model = u.replace("https://queue.fal.run/", "");
      return Response.json({ request_id: id, status_url: `https://queue.fal.run/req/${id}/status?m=${encodeURIComponent(model)}`, response_url: `https://queue.fal.run/req/${id}?m=${encodeURIComponent(model)}` });
    }
    if (/\/req\/r\d+\/status/.test(u)) return Response.json({ status: "COMPLETED" });
    if (/\/req\/r\d+\?m=/.test(u)) {
      const model = decodeURIComponent(u.split("?m=")[1]);
      if (model.includes("nano-banana")) return Response.json({ images: [{ url: "https://fal.media/still.png" }] });
      return Response.json({ video: { url: "https://fal.media/clip.mp4" } });
    }
    if (u === "https://fal.media/still.png") return new Response(Buffer.from("png-bytes"), { status: 200 });
    if (u === "https://fal.media/clip.mp4") return new Response(clip, { status: 200 });
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  refuseSeedance = false;
  vi.unstubAllGlobals();
  (ENV as any).falKey = before.fal;
  (ENV as any).elevenLabsKey = before.eleven;
});

const posts = (model: string) => calls.filter((c) => c.init.method === "POST" && c.url === `https://queue.fal.run/${model}`).map((c) => JSON.parse(c.init.body));

async function waitFor(fn: () => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}


const SCENE = {
  title: "Notes Before Five",
  logline: "A therapist buried in notes learns her coworker's trick.",
  music: "Light, warm pizzicato, builds when the note writes itself",
  cast: [
    { name: "Ashley", role: "Therapist", look: "Woman in her 40s, dark green blazer", owner: true, gender: "female" },
    { name: "Maya", role: "Coworker", look: "Woman in her 30s, braids, mustard cardigan", owner: false, gender: "female" },
  ],
  shots: [
    { scene: 1, flow: "cut", framing: "Close-up", move: "Slow push-in", action: "Ashley at her desk rubbing her eyes, laptop glow", setting: "A therapy office at dusk", cast: ["Ashley"], line_who: "Ashley", line_text: "Four notes left, and it's already six.", seconds: 4, sound: "keyboard taps" },
    { scene: 1, flow: "cut", framing: "Medium", move: "Static", action: "Maya leans in the doorway holding a coffee", setting: "A therapy office at dusk", cast: ["Maya"], line_who: "Maya", line_text: "You're still typing them?", seconds: 4, sound: "door creak" },
    { scene: 1, flow: "cut", framing: "Wide", move: "Slow pull-out", action: "Ashley closes the laptop and smiles", setting: "A therapy office at dusk", cast: ["Ashley"], line_who: "", line_text: "", seconds: 3, sound: "laptop click" },
  ],
};

describe("Scenes: characters talking to each other, lip synced", () => {
  it("writes a claymation scene with its own cast, draws the pictures, then animates and lip syncs every line", async () => {
    const { orgId, owner } = await makeWorkspace("scene");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley headshot", content: "Front", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });
    expect((await c.videos.options({ organizationId: orgId })).scenes).toBe(true);

    sceneOut = SCENE;
    const v = await c.scenes.write({ organizationId: orgId, what: "I'm stressed about notes and my coworker shows me LeadDash", style: "claymation", me: true, seconds: 15 });
    expect(v).toMatchObject({ kind: "scene", title: "Notes Before Five" });
    expect(v.scene).toMatchObject({ style: "claymation", styleLabel: "Claymation", me: true });
    expect(v.scene!.cast.map((x) => [x.name, x.owner, x.voiceName])).toEqual([["Ashley", true, "Ashley"], ["Maya", false, expect.anything()]]);
    expect(v.shots.map((s) => s.line?.who ?? null)).toEqual(["Ashley", "Maya", null]);
    // Characters talk to each other: no narrator, and the writer was told so.
    expect(prompts.scene).toMatch(/There is no narrator or voice-over track/);
    expect(prompts.scene).toMatch(/drawn in Claymation/);
    const posted = (await db.listChatMessages(orgId, elena.id, 5)).pop()!;
    expect(JSON.parse(posted.cards!)[0]).toMatchObject({ type: "scene", id: v.id });

    // The pictures are drawn first, in the style, and wait for her.
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    expect(db.getDramaEpisode(v.id, orgId)!.status).toBe("keyframes");
    const stills = posts(drama.MODELS.still);
    expect(stills).toHaveLength(3);
    expect(stills.every((b) => /^Claymation stop-motion look.*animated short film/.test(b.prompt))).toBe(true);
    expect(stills[0].prompt).not.toMatch(/2026 streaming drama/);
    // Maya's portrait is drawn once in the same style and kept with the scene, not added to the series cast.
    const portraits = posts("fal-ai/nano-banana-pro").filter((b) => /character reference portrait of Maya/.test(b.prompt));
    expect(portraits).toHaveLength(1);
    expect(portraits[0].prompt).toMatch(/^Claymation stop-motion look/);
    expect(db.listDramaCast(orgId)).toHaveLength(0);
    const drawn = (await c.scenes.get({ organizationId: orgId, id: v.id }))!;
    expect(drawn.scene!.cast[1].portrait).toMatch(/^\/files\/org-\d+\/videos\/scene-/);
    expect(drawn.scene!.pct).toBe(30);
    expect(posts(drama.MODELS.video)).toHaveLength(0);

    // A new line keeps the picture; a new voice for Maya is used for her line.
    let after = await c.scenes.saveShot({ organizationId: orgId, id: v.id, n: 2, who: "Maya", line: "Still typing them? Watch this.", see: drawn.shots[1].action });
    expect(after.shots[1]).toMatchObject({ line: { who: "Maya", text: "Still typing them? Watch this." } });
    expect(after.shots[1].stillUrl).toBeTruthy();
    expect(after.status).toBe("keyframes");
    after = await c.scenes.saveCast({ organizationId: orgId, id: v.id, index: 1, name: "Maya", look: SCENE.cast[1].look, voiceId: "voice-jessa", voiceName: "Jessa" });
    expect(after.scene!.cast[1]).toMatchObject({ voiceId: "voice-jessa", voiceName: "Jessa" });
    await expect(c.scenes.saveShot({ organizationId: orgId, id: v.id, n: 1, who: "Nobody", line: "x", see: "y" })).rejects.toThrow(/Pick someone in the cast/);

    // Make the scene: every shot moves in the same art style and every line is lip synced.
    calls = [];
    await c.scenes.make({ organizationId: orgId, id: v.id });
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    const done = (await c.scenes.get({ organizationId: orgId, id: v.id }))!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(done.videoUrl).toMatch(/^\/files\/org-\d+\/drama\/scene-\d+-9x16-/);
    const moved = posts(drama.MODELS.video);
    expect(moved).toHaveLength(3);
    expect(moved.every((b) => /same art style as the first frame/.test(b.prompt))).toBe(true);
    expect(posts(drama.MODELS.lipsync)).toHaveLength(2);
    expect(calls.some((x) => x.url.includes("text-to-speech/voice-ashley"))).toBe(true);
    expect(calls.some((x) => x.url.includes("text-to-speech/voice-jessa"))).toBe(true);
    expect(done.scene!.pct).toBe(100);
    const last = (await db.listChatMessages(orgId, elena.id, 5)).pop()!;
    expect(last.content).toMatch(/^"Notes Before Five" is made: 3 shots/);
    expect(JSON.parse(last.cards!)[0]).toMatchObject({ type: "scene", id: v.id });
    // It's listed on the Videos tab, and not in the drama series.
    expect((await c.scenes.list({ organizationId: orgId })).map((x) => x.id)).toEqual([v.id]);
    expect((await c.drama.studio({ organizationId: orgId })).episodes).toHaveLength(0);

    // Change style: everyone and every picture is made again in the new look.
    calls = [];
    const w = await c.scenes.setStyle({ organizationId: orgId, id: v.id, style: "real" });
    expect(w.scene!.styleLabel).toBe("Cinematic");
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    expect(posts(drama.MODELS.still).every((b) => /2026 streaming drama/.test(b.prompt))).toBe(true);
    expect(posts(drama.MODELS.portrait).filter((b) => /Candid portrait photograph of Maya/.test(b.prompt))).toHaveLength(1);
  }, 240_000);

  it("Elena writes a Scene, not a narrated video, when characters should talk; work-hour plans don't offer it", async () => {
    const { orgId, owner, staff } = await makeWorkspace("scene-chat");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    sceneOut = { ...SCENE, cast: SCENE.cast.map((x) => ({ ...x, owner: false })), shots: SCENE.shots.map((s) => ({ ...s, cast: s.cast.map((n) => (n === "Ashley" ? "Ashley" : n)) })) };
    decision = { ...blank, action: "make_scene", notes: "Two therapists talking about notes", focus: "3D animation", from: "", count: 30 };
    const r = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make a 3D animated video of two therapists talking about notes" });
    expect(r.reply.content).toMatch(/^Here's "Notes Before Five": 3 shots, 3D animation, where the characters talk to each other/);
    const card = JSON.parse(r.reply.cards!)[0];
    expect(card.type).toBe("scene");
    expect(db.getDramaEpisode(card.id, orgId)!.kind).toBe("scene");
    await waitFor(() => db.getDramaEpisode(card.id, orgId)!.status !== "making");

    await caller(staff).hours.setPlan({ organizationId: orgId, plan: "starter" });
    expect((await c.videos.options({ organizationId: orgId })).scenes).toBe(false);
    await expect(c.scenes.write({ organizationId: orgId, what: "Two people talk", style: "real" })).rejects.toThrow(/work-hour plans/);
  }, 240_000);
  it("the AI team plays themselves: their own portraits and voices, never a made-up face, and the scene comes in every size", async () => {
    const { orgId, owner } = await makeWorkspace("scene-team");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley headshot", content: "Front", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    // Each speaks in the voice they use in huddles.
    await db.updateEmployee(nora.id, orgId, { voiceProvider: "elevenlabs", voiceId: "voice-nora", voiceName: "Nora's voice" });
    await db.updateEmployee(simone.id, orgId, { voiceProvider: "elevenlabs", voiceId: "voice-simone", voiceName: "Simone's voice" });
    sceneOut = {
      title: "On Pace",
      logline: "A therapist asks if the week is on pace; her AI team answers and hands off the follow-up.",
      music: "Warm, light pulse",
      cast: [
        { name: "Ashley", role: "Therapist", look: "Woman in her 40s, dark green blazer", owner: true, gender: "female" },
        { name: simone.name, role: "Made-up role", look: "Woman in her 30s", owner: false, gender: "female" },
        { name: nora.name, role: "Made-up role", look: "Woman in her 30s", owner: false, gender: "female" },
      ],
      shots: [
        { scene: 1, flow: "cut", framing: "Medium", move: "Static", action: "Ashley at her desk", setting: "A therapy office", cast: ["Ashley"], line_who: "Ashley", line_text: "Are we on pace this week?", seconds: 4, sound: "" },
        { scene: 1, flow: "cut", framing: "Close-up", move: "Push-in", action: `${simone.name} checks the numbers`, setting: "A therapy office", cast: [simone.name], line_who: simone.name, line_text: "On track. Three invoices are overdue.", seconds: 4, sound: "" },
        { scene: 1, flow: "cut", framing: "Medium", move: "Static", action: `${nora.name} nods`, setting: "A therapy office", cast: [nora.name], line_who: nora.name, line_text: "Noted. Adding it to the plan.", seconds: 4, sound: "" },
      ],
    };
    const v = await c.scenes.write({ organizationId: orgId, what: "Ask the AI team if we're on pace for revenue", style: "real", me: true, seconds: 15 });
    // The writer is told who on the team can play themselves.
    expect(prompts.scene).toContain(`${nora.name} (${nora.roleTitle})`);
    // LeadDash's own workspace can cast anyone on the roster, and never makes up a coworker.
    expect(prompts.scene).toContain("Harper (Billing Specialist)");
    expect(prompts.scene).toMatch(/never make up a coworker/);
    const cast = v.scene!.cast;
    expect(cast.map((x) => [x.name, x.owner, x.team])).toEqual([["Ashley", true, false], [simone.name, false, true], [nora.name, false, true]]);
    // Their real role and their own portrait, not one made up from the description.
    expect(cast[2]).toMatchObject({ role: nora.roleTitle, portrait: "/avatars/projects.webp" });
    expect(cast[2]).toMatchObject({ voiceId: "voice-nora", voiceName: "Nora's voice" });
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    expect(posts(drama.MODELS.portrait).filter((b) => /Candid portrait photograph/.test(b.prompt))).toHaveLength(0);

    // A new look can't swap a team member's face, and they keep their name.
    const kept = await c.scenes.saveCast({ organizationId: orgId, id: v.id, index: 2, name: "Someone Else", look: "A man in his 60s", voiceId: cast[2].voiceId, voiceName: cast[2].voiceName });
    expect(kept.scene!.cast[2]).toMatchObject({ name: nora.name, portrait: "/avatars/projects.webp" });

    // Made: vertical, square and wide, so it fits a website pop-up and a social post alike.
    await c.scenes.make({ organizationId: orgId, id: v.id });
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    const done = (await c.scenes.get({ organizationId: orgId, id: v.id }))!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(Object.keys(done.versions).sort()).toEqual(["16:9", "1:1", "9:16"]);
    expect(calls.some((x) => x.url.includes("text-to-speech/voice-nora"))).toBe(true);
    expect(calls.some((x) => x.url.includes("text-to-speech/voice-simone"))).toBe(true);
    expect(elena.id).toBeTruthy();
  }, 240_000);

  it("a two-person shot Seedance refuses for real faces moves with Kling instead of stopping the scene", async () => {
    const { orgId, owner } = await makeWorkspace("scene-faces");
    const c = caller(owner);
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley headshot", content: "Front", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });
    sceneOut = {
      ...SCENE,
      shots: [{ scene: 1, flow: "cut", framing: "Two-shot", move: "Static", action: "Ashley and Maya talk", setting: "A therapy office", cast: ["Ashley", "Maya"], line_who: "Ashley", line_text: "Four notes left, and it's already six.", seconds: 5, sound: "" }],
    };
    const v = await c.scenes.write({ organizationId: orgId, what: "Two coworkers talk", style: "real", me: true, seconds: 10 });
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    refuseSeedance = true;
    calls = [];
    await c.scenes.make({ organizationId: orgId, id: v.id });
    await waitFor(() => db.getDramaEpisode(v.id, orgId)!.status !== "making");
    const done = (await c.scenes.get({ organizationId: orgId, id: v.id }))!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(posts(drama.MODELS.video)).toHaveLength(1);
    expect(done.shots[0].engine).toBe("kling");
    expect(drama.refusesFaces(new Error("fal.ai said no (500): busy"))).toBe(false);
  }, 240_000);

  it("small team portraits are enlarged before they're sent, since Kling refuses references under 300 pixels", async () => {
    const sharp = (await import("sharp")).default;
    const small = await sharp({ create: { width: 256, height: 256, channels: 3, background: "#336655" } }).webp().toBuffer();
    const out = await drama.bigEnough(small, "image/webp");
    const meta = await sharp(out.buf).metadata();
    expect([meta.width, meta.height, out.mime]).toEqual([512, 512, "image/png"]);
    const big = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#336655" } }).png().toBuffer();
    expect((await drama.bigEnough(big, "image/png")).buf).toBe(big);
  }, 240_000);
});
