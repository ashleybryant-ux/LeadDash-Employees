import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

let decision: any = null;
let season: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? decision : opts.schemaName === "drama_season" ? season : {})) };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
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
let clip: Buffer;
const before = { fal: ENV.falKey, eleven: ENV.elevenLabsKey };

beforeAll(() => {
  // A real 2-second clip with sound, so the episode really gets cut together.
  const ff = createRequire(import.meta.url)("ffmpeg-static") as string;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "drama-t-")), "c.mp4");
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=576x1024:rate=24", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "2", "-shortest", out]);
  clip = fs.readFileSync(out);
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
    if (u.includes("api.elevenlabs.io/v1/text-to-speech/")) return new Response(Buffer.alloc(32_000), { status: 200 }); // 2 seconds
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
  vi.unstubAllGlobals();
  (ENV as any).falKey = before.fal;
  (ENV as any).elevenLabsKey = before.eleven;
});

const posts = (model: string) => calls.filter((c) => c.init.method === "POST" && c.url === `https://queue.fal.run/${model}`).map((c) => JSON.parse(c.init.body));

async function waitFor(fn: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Elena's mini drama studio", () => {
  it("writes a cinematic season in chat, then makes episode 1 shot by shot and cuts it together", async () => {
    const { orgId, owner } = await makeWorkspace("drama");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley headshot", content: "Front", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });

    season = SEASON;
    decision = { ...blank, action: "write_episodes", notes: "A therapist drama. I play the practice owner.", count: 1 };
    const r = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Write my therapist micro drama. I play the practice owner." });
    expect(r.reply.content).toMatch(/^I wrote an episode of Session Notes\. Each opens on a hook and ends on a cliffhanger, cut from about 4 shots with real camera moves\. You play Dr\. Ashley Bryant, from your photo and your voice\. The other character is made up, and no real clients/);
    expect(JSON.parse(r.reply.cards!)[0].type).toBe("drama_season");
    const st = await c.drama.studio({ organizationId: orgId });
    expect(st.cast.map((x) => [x.name, x.kind, x.photoUrl === pic.url, x.voiceName])).toEqual([["Dr. Ashley Bryant", "owner", true, "Ashley"], ["Renee Cole", "made_up", false, null]]);
    const ep = st.episodes[0];
    // A character nobody cast is dropped from the shot and can't speak.
    expect(ep.shots[3]).toMatchObject({ cast: [], line: null });
    // Renee has no voice, but she has no lines, so the episode can be made.
    db.updateDramaCast(st.cast[1].id, orgId, { voiceId: "voice-jessa", voiceName: "Jessa" });

    decision = { ...blank, action: "make_episode", count: 1 };
    const m = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make episode 1" });
    expect(m.reply.content).toMatch(/^Making episode 1, "The New Clinician\." That's 4 shots, about \$/);
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    const done = (await c.drama.episode({ organizationId: orgId, id: ep.id }))!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(done.videoUrl).toMatch(/^\/files\/org-\d+\/drama\/episode-1-/);

    // Renee got a portrait once; her shot and the owner's are matched to their faces.
    expect(posts(drama.MODELS.portrait).filter((b) => /Cinematic portrait photograph of Renee Cole/.test(b.prompt))).toHaveLength(1);
    const stills = posts(drama.MODELS.still);
    expect(stills).toHaveLength(2);
    expect(stills[1].image_urls[0]).toMatch(/^data:image\/jpeg;base64,/);
    const videos = posts(drama.MODELS.video);
    expect(videos).toHaveLength(4);
    expect(videos[0]).toMatchObject({ generate_audio: true, duration: "3" });
    expect(videos[0].elements).toBeUndefined();
    expect(videos[2]).toMatchObject({ generate_audio: false });
    expect(videos[2].elements[0].frontal_image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(videos[2].prompt).toContain("@Element1");
    // The owner's line is read in her own voice and lip-synced onto the clip.
    expect(calls.some((x) => x.url.includes("text-to-speech/voice-ashley"))).toBe(true);
    const sync = posts(drama.MODELS.lipsync);
    expect(sync).toHaveLength(1);
    expect(sync[0].audio_url).toMatch(/^data:audio\/mpeg;base64,/);
    const msgs = await db.listChatMessages(orgId, elena.id, 10);
    expect(msgs[msgs.length - 1].content).toMatch(/^Episode 1, "The New Clinician," is cut\. 4 shots/);

    // Remake one shot: only that shot is made again, then it's cut again.
    calls = [];
    await c.drama.remakeShot({ organizationId: orgId, id: ep.id, n: 2 });
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    expect(posts(drama.MODELS.video)).toHaveLength(1);
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("ready");
  }, 60_000);

  it("won't start an episode that goes over the monthly limit, or a line with no voice", async () => {
    const { orgId, owner } = await makeWorkspace("drama2");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley", content: "", fileUrl: pic.url });
    season = { ...SEASON, episodes: [{ ...SEASON.episodes[0], shots: [shot({ action: "Renee Cole speaks.", cast: ["Renee Cole"], line_who: "Renee Cole", line_text: "Who wrote this?" })] }] };
    const w = await drama.writeEpisodes(orgId, { brief: "", count: 1, ownerName: "Ashley" });
    void elena;
    await expect(c.drama.make({ organizationId: orgId, id: w.episodes[0].id })).rejects.toThrow(/Renee Cole doesn't have a voice yet/);
    db.updateDramaCast(w.cast.find((x) => x.name === "Renee Cole")!.id, orgId, { voiceId: "v", voiceName: "Jessa" });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 10 });
    await expect(c.drama.make({ organizationId: orgId, id: w.episodes[0].id })).rejects.toThrow(/would go over your \$0 monthly limit/);
  });
});
