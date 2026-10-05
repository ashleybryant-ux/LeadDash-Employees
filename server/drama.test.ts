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
const prompts: Record<string, string> = {};
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      prompts[opts.schemaName] = `${opts.system}\n${opts.prompt}`;
      return opts.schemaName === "chat_decision" ? decision : opts.schemaName === "drama_season" ? season : opts.schemaName === "campaign_directions" ? directions : opts.schemaName === "campaign_plan" ? campaignPlan : {};
    }),
  };
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

async function waitFor(fn: () => boolean, ms = 180_000) {
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
    const side = await storagePut(`org-${orgId}/brain/side.png`, Buffer.from("png-side"), "image/png");
    await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley side", content: "", fileUrl: side.url });

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
    expect(m.reply.content).toMatch(/^Making the keyframes for episode 1, "The New Clinician": one still for each of the 4 shots\. You'll approve them before anything is animated\./);
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    // Keyframes only: nothing animated until the owner approves.
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("keyframes");
    expect(posts(drama.MODELS.video)).toHaveLength(0);
    const kmsg = (await db.listChatMessages(orgId, elena.id, 10)).pop()!;
    expect(kmsg.content).toMatch(/^The keyframes for Episode 1 are ready/);
    expect(JSON.parse(kmsg.cards!)[0].type).toBe("drama_keyframes");
    await c.drama.approveKeyframes({ organizationId: orgId, id: ep.id });
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    const done = (await c.drama.episode({ organizationId: orgId, id: ep.id }))!;
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(done.videoUrl).toMatch(/^\/files\/org-\d+\/drama\/drama-\d+-9x16-/);
    // Cut again: a finished episode is cut over from the clips it already has, nothing is animated again.
    const clipsBefore = posts(drama.MODELS.video).length;
    await new Promise((r) => setTimeout(r, 5));
    const recut = await c.drama.make({ organizationId: orgId, id: ep.id });
    expect(recut.progress).toBe("Cutting it together");
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    const again = db.getDramaEpisode(ep.id, orgId)!;
    expect(again.status).toBe("ready");
    expect(again.videoUrl).not.toBe(done.videoUrl);
    expect(posts(drama.MODELS.video)).toHaveLength(clipsBefore);

    // Renee got a portrait once; her shot and the owner's are matched to their faces.
    expect(posts(drama.MODELS.portrait).filter((b) => /Cinematic portrait photograph of Renee Cole/.test(b.prompt))).toHaveLength(1);
    // Every shot after the first in a scene also sees the shot before it, so the room and light carry over.
    const stills = posts(drama.MODELS.still);
    expect(stills).toHaveLength(3);
    expect(stills[1].image_urls[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(stills[1].prompt).toContain("the shot just before this one in the same scene");
    const videos = posts(drama.MODELS.video);
    expect(videos).toHaveLength(4);
    expect(videos[0]).toMatchObject({ generate_audio: true, duration: "3" });
    expect(videos[0].elements).toBeUndefined();
    expect(videos[2]).toMatchObject({ generate_audio: false });
    expect(videos[2].elements[0].frontal_image_url).toMatch(/^data:image\/jpeg;base64,/);
    // Every photo of the owner is used, so her face holds from every angle.
    expect(videos[2].elements[0].reference_image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(stills[1].image_urls).toHaveLength(3);
    expect(stills[1].prompt).toContain("reference images 1 to 2, the same person from different angles");
    // The score is made for the episode's length, instrumental.
    const music = calls.find((x) => x.url.startsWith("https://api.elevenlabs.io/v1/music"))!;
    expect(JSON.parse(music.init.body)).toMatchObject({ force_instrumental: true });
    expect(JSON.parse(music.init.body).prompt).toContain("Low pulsing synth");
    expect(videos[2].prompt).toContain("@Element1");
    // The owner's line is read in her own voice and lip-synced onto the clip.
    expect(calls.some((x) => x.url.includes("text-to-speech/voice-ashley"))).toBe(true);
    const sync = posts(drama.MODELS.lipsync);
    expect(sync).toHaveLength(1);
    expect(sync[0].audio_url).toMatch(/^data:audio\/mpeg;base64,/);
    const msgs = await db.listChatMessages(orgId, elena.id, 10);
    expect(msgs[msgs.length - 1].content).toMatch(/^Episode 1, "The New Clinician," is cut\. 4 shots/);

    // Remake one shot: its new keyframe goes back to the owner first, then only that shot is animated and it's cut again.
    calls = [];
    await c.drama.remakeShot({ organizationId: orgId, id: ep.id, n: 2 });
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("keyframes");
    expect(posts(drama.MODELS.video)).toHaveLength(0);
    // Asking to see them never approves them.
    decision = { ...blank, action: "approve_keyframes" };
    const look = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "show me the images" });
    expect(look.reply.content).toMatch(/^Here are the keyframes for episode 1/);
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("keyframes");
    const yes = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Approved, animate it" });
    expect(yes.reply.content).toMatch(/^Animating/);
    await waitFor(() => db.getDramaEpisode(ep.id, orgId)!.status !== "making");
    expect(posts(drama.MODELS.video)).toHaveLength(1);
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("ready");
  }, 400_000);

  it("won't start an episode that goes over the monthly limit, or a line with no voice", async () => {
    const { orgId, owner } = await makeWorkspace("drama2");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley", content: "", fileUrl: pic.url });
    season = { ...SEASON, episodes: [{ ...SEASON.episodes[0], shots: [shot({ action: "Renee Cole speaks.", cast: ["Renee Cole"], line_who: "Renee Cole", line_text: "Who wrote this?" })] }] };
    const w = await drama.writeEpisodes(orgId, { brief: "", count: 1, ownerName: "Ashley" });
    void elena;
    const id = w.episodes[0].id;
    // Keyframes don't need voices; animating does.
    await c.drama.make({ organizationId: orgId, id });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status === "keyframes");
    await expect(c.drama.approveKeyframes({ organizationId: orgId, id })).rejects.toThrow(/Renee Cole doesn't have a voice yet/);
    db.updateDramaCast(w.cast.find((x) => x.name === "Renee Cole")!.id, orgId, { voiceId: "v", voiceName: "Jessa" });
    expect(db.getDramaEpisode(id, orgId)!.status).toBe("keyframes");
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 10 });
    await expect(c.drama.approveKeyframes({ organizationId: orgId, id })).rejects.toThrow(/would go over your \$0 monthly limit/);
  }, 400_000);

  it("plans a branded campaign: three directions, then the shot list with the owner, a team member and the logo, keyframes for approval, then voice-over, captions and three versions", async () => {
    const { orgId, owner } = await makeWorkspace("campaign");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley headshot", content: "Front", fileUrl: pic.url });
    const logo = await storagePut(`org-${orgId}/brain/logo.png`, Buffer.from("logo-bytes"), "image/png");
    await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "LeadDash logo", content: "", fileUrl: logo.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });
    await c.drama.saveStyleRef({ organizationId: orgId, name: "Founder walk-in", link: "https://www.tiktok.com/@x/video/1", likes: ["Camera", "Lighting"], words: "the slow walk toward camera" });
    const malik = (await db.getEmployeeByKind(orgId, "leads"))!;
    const ownerName = (await db.getOrganizationById(orgId))?.signerName || owner.name!;

    // Character plates from her photos (the logo isn't a photo of her).
    const plates = await c.drama.makePlates({ organizationId: orgId });
    expect(plates).toHaveLength(9);
    expect(posts(drama.MODELS.still).every((b) => b.image_urls.length === 1)).toBe(true);

    const dir = (t: string) => ({ title: t, hook: "A phone buzzes at 9:47 PM.", story: "Late nights, then one screen.", metaphor: "Two screens become one", location: "Home office", wardrobe: "Green blazer", lighting: "Desk lamp", camera: "Slow push-ins", ending: "One login. Everything." });
    directions = { title: "Double entry ad", goal: "Practice owners feel seen and book a demo.", directions: [dir("The 9:47 PM Desk"), dir("Two Front Doors"), dir("Monday")] };
    decision = { ...blank, action: "write_campaign", notes: "A 30-second LeadDash ad about double entry" };
    const r1 = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make a 30-second LeadDash ad about double entry" });
    expect(JSON.parse(r1.reply.cards!)[0].type).toBe("campaign_directions");
    // Her style references are in every plan.
    expect(prompts.campaign_directions).toContain("Founder walk-in (Camera, Lighting): the slow walk toward camera");
    expect(posts(drama.MODELS.video)).toHaveLength(0);

    const shot = (o: any) => ({ framing: "Close-up", move: "Slow dolly-in of a few inches", action: "", setting: "Home office at night", cast: [], plate: "", props: [], vo: "", caption: "", seconds: 3, sound: "Room tone", ...o });
    campaignPlan = {
      title: "The 9:47 PM Desk",
      script: "It's 9:47. Same client. Second system. One login. Everything.",
      music: "Soft piano, builds into the reveal",
      cta: "Book a demo",
      cast: [ownerName, malik.name],
      shots: [
        shot({ action: `${ownerName} types at a laptop, tired.`, cast: [ownerName], plate: "Seated at a desk", vo: "It's 9:47.", caption: "It's 9:47." }),
        shot({ framing: "Medium", action: `${malik.name} answers a new lead on a headset.`, cast: [malik.name], caption: "Leads answered" }),
        shot({ framing: "Insert", action: "The LeadDash logo on a laptop lid.", props: ["LeadDash logo", "Made-up interface"], vo: "One login. Everything." }),
      ],
    };
    decision = { ...blank, action: "pick_direction", count: 1 };
    const r2 = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Use the first one" });
    expect(r2.reply.content).toMatch(/^"The 9:47 PM Desk" is planned: 3 shots/);
    const camp = (await c.drama.studio({ organizationId: orgId })).campaigns[0];
    await waitFor(() => db.getDramaEpisode(camp.id, orgId)!.status !== "making");
    expect(db.getDramaEpisode(camp.id, orgId)!.status).toBe("keyframes");
    const v = drama.episodeView(db.getDramaEpisode(camp.id, orgId)!);
    // The owner's shot uses her plate first, then her photo; the logo only where named; an invented interface is dropped.
    expect(v.shots[2].props).toEqual(["LeadDash logo"]);
    const stills = posts(drama.MODELS.still).slice(9);
    expect(stills).toHaveLength(3);
    expect(stills[0].image_urls).toHaveLength(2);
    expect(stills[1].image_urls).toHaveLength(2); // Malik's own portrait
    expect(stills[2].prompt).toContain("reference image 1 is LeadDash logo");
    expect((await c.drama.studio({ organizationId: orgId })).cast.find((x) => x.name === malik.name)).toMatchObject({ kind: "team" });

    await c.drama.approveKeyframes({ organizationId: orgId, id: camp.id });
    await waitFor(() => db.getDramaEpisode(camp.id, orgId)!.status !== "making");
    const done = drama.episodeView(db.getDramaEpisode(camp.id, orgId)!);
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    expect(Object.keys(done.versions).sort()).toEqual(["16:9", "1:1", "9:16"]);
    // Voice-over in her voice for the two shots that have it; no lip sync (nobody speaks on camera).
    expect(calls.filter((x) => x.url.includes("text-to-speech/voice-ashley"))).toHaveLength(2);
    expect(posts(drama.MODELS.lipsync)).toHaveLength(0);
    expect(posts(drama.MODELS.video).slice(-3).every((b) => b.generate_audio === true)).toBe(true);
    expect((await db.listChatMessages(orgId, elena.id, 10)).pop()!.content).toMatch(/three versions: vertical/);

    // Editing a caption needs only a new cut; nothing is animated again.
    const before = posts(drama.MODELS.video).length;
    await c.drama.saveScript({ organizationId: orgId, id: camp.id, cta: "Book your demo", shots: done.shots.map((x) => ({ n: x.n, vo: x.vo ?? "", caption: x.n === 2 ? "Every lead answered" : x.caption ?? "" })) });
    await c.drama.make({ organizationId: orgId, id: camp.id });
    await waitFor(() => db.getDramaEpisode(camp.id, orgId)!.status !== "making");
    expect(db.getDramaEpisode(camp.id, orgId)!.status).toBe("ready");
    expect(posts(drama.MODELS.video).length).toBe(before);
  }, 400_000);

  it("uses Seedance for two people, the owner's own take for her line, and Redo with the other model", async () => {
    const { orgId, owner } = await makeWorkspace("takes");
    const c = caller(owner);
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley", content: "", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });
    season = { ...SEASON, episodes: [{ ...SEASON.episodes[0], shots: [
      shot({ framing: "Medium two-shot", action: "Dr. Ashley Bryant hands Renee Cole the file.", cast: ["Dr. Ashley Bryant", "Renee Cole"], seconds: 5 }),
      shot({ action: "Dr. Ashley Bryant leans in.", cast: ["Dr. Ashley Bryant"], line_who: "Dr. Ashley Bryant", line_text: "I see you found it." }),
    ] }] };
    const w = await drama.writeEpisodes(orgId, { brief: "", count: 1, ownerName: "Ashley" });
    const id = w.episodes[0].id;
    let v = drama.episodeView(db.getDramaEpisode(id, orgId)!);
    expect(v.shots.map((x) => x.engine)).toEqual(["seedance", "kling"]);
    await c.drama.make({ organizationId: orgId, id });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status === "keyframes");

    // Her take for the line: a phone clip, trimmed and kept with its sound.
    await expect(drama.saveTake(orgId, id, 2, Buffer.from("not a video"))).rejects.toThrow(/isn't a video I can read/);
    const before = drama.estimateEpisode(drama.shotsOf(db.getDramaEpisode(id, orgId)!));
    await drama.saveTake(orgId, id, 2, clip);
    v = drama.episodeView(db.getDramaEpisode(id, orgId)!);
    expect(v.shots[1]).toMatchObject({ takeSeconds: 3 });
    expect(v.status).toBe("keyframes");
    expect(drama.estimateEpisode(drama.shotsOf(db.getDramaEpisode(id, orgId)!))).not.toBe(before);

    calls = [];
    await c.drama.approveKeyframes({ organizationId: orgId, id });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status !== "making");
    const done = drama.episodeView(db.getDramaEpisode(id, orgId)!);
    expect(done.error).toBeNull();
    expect(done.status).toBe("ready");
    // Two people: Seedance, with the keyframe first and both faces after it.
    const sd = posts(drama.MODELS.seedance);
    expect(sd).toHaveLength(1);
    expect(sd[0]).toMatchObject({ aspect_ratio: "9:16", resolution: "720p", duration: "5", generate_audio: true });
    expect(sd[0].image_urls.length).toBeGreaterThanOrEqual(3);
    expect(sd[0].prompt).toContain("@Image1 is the first frame");
    expect(sd[0].prompt).toContain("Renee Cole is the person in @Image3");
    // Her take: her movement and voice on the keyframe; no reading, no lip sync.
    const pf = posts(drama.MODELS.perform);
    expect(pf).toHaveLength(1);
    expect(pf[0]).toMatchObject({ character_orientation: "image", keep_original_sound: true });
    expect(pf[0].video_url).toMatch(/^data:video\/mp4;base64,/);
    expect(posts(drama.MODELS.video)).toHaveLength(0);
    expect(posts(drama.MODELS.lipsync)).toHaveLength(0);
    expect(calls.some((x) => x.url.includes("text-to-speech"))).toBe(false);

    // Redo with Kling: only that shot is animated again, from the same keyframe.
    calls = [];
    await c.drama.animateWith({ organizationId: orgId, id, n: 1, engine: "kling" });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status !== "making");
    expect(posts(drama.MODELS.video)).toHaveLength(1);
    expect(posts(drama.MODELS.still)).toHaveLength(0);
    expect(posts(drama.MODELS.seedance)).toHaveLength(0);
    expect(drama.episodeView(db.getDramaEpisode(id, orgId)!).shots[0].engine).toBe("kling");

    // Removing the take sends that shot back to the keyframe alone.
    drama.clearTake(orgId, id, 2);
    expect(drama.shotsOf(db.getDramaEpisode(id, orgId)!)[1]).toMatchObject({ takeUrl: null, clipUrl: null });
    expect(db.getDramaEpisode(id, orgId)!.status).toBe("failed");
  }, 400_000);

  it("casts the owner as herself under any name she's written as, gives her lines and voice-over, and keeps her photos", async () => {
    const { orgId, owner } = await makeWorkspace("drama9");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/desk.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    // Her photo's description mentions a screen behind her: it's still her.
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "At my desk", content: "A woman smiling at her desk with a laptop screen behind her", fileUrl: pic.url });
    const logo = await storagePut(`org-${orgId}/brain/logo.png`, Buffer.from("png"), "image/png");
    await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "LeadDash logo", content: "Logo", fileUrl: logo.url });
    expect((await drama.ownerPack(orgId)).map((p) => p.id)).toEqual([img.id]);
    // An owner character already exists under another name.
    db.createDramaCast({ organizationId: orgId, name: "Ashley", role: "Therapist", kind: "owner", look: "", photoUrl: pic.url, voiceId: "voice-ashley", voiceName: "Ashley" });
    season = {
      ...SEASON,
      cast: [{ name: "Dr. Ashley Bryant", role: "Therapist", owner: true, look: "", voice: "" }],
      episodes: [{ ...SEASON.episodes[0], title: "Already Done", shots: [
        shot({ action: "Ashley closes her laptop.", cast: [], voice_over: "Another night of notes I shouldn't have to write." }),
        shot({ action: "Dr. Ashley Bryant looks up.", cast: ["Dr. Ashley Bryant"], line_who: "Dr. Ashley Bryant", line_text: "It's already done." }),
      ] }],
    };
    const r = await drama.writeEpisodes(orgId, { brief: "I'm the therapist and I talk", count: 1, ownerName: "Dr. Ashley Bryant" });
    expect(prompts.drama_season).toMatch(/she is never played by anyone else/);
    const shots = drama.shotsOf(r.episodes[0]);
    expect(shots[0]).toMatchObject({ cast: ["Ashley"], vo: "Another night of notes I shouldn't have to write." });
    expect(shots[1]).toMatchObject({ cast: ["Ashley"], line: { who: "Ashley", text: "It's already done." } });
    expect(db.listDramaCast(orgId).filter((x) => x.kind === "owner")).toHaveLength(1);

    // Rewrite in place from chat: same episode number, new shots, approval cleared.
    decision = { ...blank, action: "rewrite_episode", count: 1, notes: "Use me as the therapist and I should be talking" };
    const rw = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "use me as the therapist and I should be talking" });
    expect(rw.reply.content).toMatch(/^I rewrote episode 1, "Already Done\." You play Ashley in 2 of the 2 shots, from your photos, and you speak in your own voice: 1 spoken line lip synced to your face and 1 voice-over line\./);
    expect(db.listDramaEpisodes(orgId).filter((e) => e.kind === "drama")).toHaveLength(1);
  });

  it("cuts scenes together like a film: soft cuts inside a scene, a dip to black between scenes, continuous moves ending on the next keyframe", async () => {
    expect(drama.transitionFor({ scene: 1, setting: "x", flow: "cut" }, { scene: 1, setting: "x" })).toEqual({ kind: "fade", seconds: 0.12 });
    expect(drama.transitionFor({ scene: 1, setting: "x", flow: "continue" }, { scene: 1, setting: "x" })).toEqual({ kind: "dissolve", seconds: 0.3 });
    expect(drama.transitionFor({ scene: 1, setting: "x", flow: "cut" }, { scene: 2, setting: "y" }).kind).toBe("fadeblack");
    // Campaign shots without scene numbers: a new setting is a new scene.
    expect(drama.transitionFor({ setting: "Office", flow: "cut" }, { setting: "Lobby" }).kind).toBe("fadeblack");
    const { orgId } = await makeWorkspace("drama10");
    const saved = await Promise.all([0, 1, 2].map((i) => storagePut(`org-${orgId}/drama/c${i}.mp4`, clip, "video/mp4")));
    const shots = [
      { clipUrl: saved[0].url, voUrl: null, caption: "", scene: 1, setting: "Office", flow: "continue" as const },
      { clipUrl: saved[1].url, voUrl: null, caption: "", scene: 1, setting: "Office", flow: "cut" as const },
      { clipUrl: saved[2].url, voUrl: null, caption: "", scene: 2, setting: "Hall", flow: "cut" as const },
    ];
    const out = await drama.stitch(orgId, "flow", shots, { beds: { "scene-1": mp3, "scene-2": mp3 } });
    const file = path.join(process.env.UPLOADS_DIR || "uploads", out["9:16"].replace(/^\/files\//, ""));
    const p = await drama.probe(fs.existsSync(file) ? file : path.resolve("uploads", out["9:16"].replace(/^\/files\//, "")));
    // Three 2-second clips, a tenth trimmed off shots 2 and 3, overlapped by 0.3 and 0.5 seconds.
    expect(p.duration).toBeGreaterThan(4.6);
    expect(p.duration).toBeLessThan(5.3);
    expect(p.audio).toBe(true);
  }, 120_000);
  it("keeps every scene in the cut when a clip's picture ends before its sound, as lip sync clips often do", async () => {
    const ff = createRequire(import.meta.url)("ffmpeg-static") as string;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drama-short-"));
    const short = path.join(dir, "s.mp4");
    execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=576x1024:rate=24:duration=1.2", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:v", "libx264", "-c:a", "aac", short]);
    const { orgId } = await makeWorkspace("drama11");
    const a = await storagePut(`org-${orgId}/drama/s0.mp4`, fs.readFileSync(short), "video/mp4");
    const saved = await Promise.all([1, 2].map((i) => storagePut(`org-${orgId}/drama/s${i}.mp4`, clip, "video/mp4")));
    const shots = [
      { clipUrl: a.url, voUrl: null, caption: "", scene: 1, setting: "Office", flow: "cut" as const },
      { clipUrl: saved[0].url, voUrl: null, caption: "", scene: 1, setting: "Office", flow: "cut" as const },
      { clipUrl: saved[1].url, voUrl: null, caption: "", scene: 2, setting: "Hall", flow: "cut" as const },
    ];
    const out = await drama.stitch(orgId, "short", shots);
    const rel = out["9:16"].replace(/^\/files\//, "");
    const file = [path.join(process.env.UPLOADS_DIR || "uploads", rel), path.resolve("uploads", rel)].find((f) => fs.existsSync(f))!;
    // How long the picture itself runs, not just the sound.
    const log = String(spawnSync(ff, ["-hide_banner", "-i", file, "-map", "0:v", "-f", "null", "-"]).stderr);
    const t = [...log.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop()!;
    const picture = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    // 2 + 1.9 + 1.9 seconds, less a 0.12 and a 0.5 second overlap.
    expect(picture).toBeGreaterThan(4.8);
  }, 120_000);
  it("says what fal.ai is doing while it waits, stops when asked, and picks up an episode nothing is working on", async () => {
    const real = globalThis.fetch;
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      if (/\/status/.test(String(url)) && polls < 3) {
        polls++;
        return Response.json({ status: polls === 1 ? "IN_QUEUE" : "IN_PROGRESS" });
      }
      return real(url, init);
    });
    const seen: string[] = [];
    await drama.falRun("fal-ai/kling-video/v3/pro/image-to-video", { prompt: "x" }, 20, { onWait: (_m, st) => seen.push(st) });
    expect(seen).toEqual(["IN_QUEUE", "IN_PROGRESS"]);
    await expect(drama.falRun("fal-ai/kling-video/v3/pro/image-to-video", { prompt: "x" }, 20, { stop: () => true })).rejects.toThrow(drama.STOPPED);

    // An episode left "making" with nothing working on it (a restart mid-shot) is picked back up after 10 quiet minutes.
    const { orgId } = await makeWorkspace("drama12");
    const ep = db.createDramaEpisode({ organizationId: orgId, number: 9, kind: "drama", title: "Left behind", status: "making", costCents: 0, madeAt: new Date(), shots: "[]", plan: "{}" });
    await drama.dramaTicks(Date.now());
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("making");
    await drama.dramaTicks(Date.now() + 11 * 60_000);
    // No shots, so picking it up ends right away with a clear reason instead of hanging.
    expect(db.getDramaEpisode(ep.id, orgId)!.status).toBe("failed");
    expect(drama.stopEpisode(orgId, ep.id).status).toBe("failed");
  });
  it("moves to a backup lip sync when sync.so is down, and never pays to animate a shot twice", async () => {
    const { orgId, owner } = await makeWorkspace("lipsync");
    const c = caller(owner);
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley", content: "", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });
    season = { ...SEASON, episodes: [{ ...SEASON.episodes[0], shots: [shot({ action: "Dr. Ashley Bryant speaks into her phone.", cast: ["Dr. Ashley Bryant"], line_who: "Dr. Ashley Bryant", line_text: "Session ran long. She made a real connection today." })] }] };
    const w = await drama.writeEpisodes(orgId, { brief: "", count: 1, ownerName: "Ashley" });
    const id = w.episodes[0].id;
    await c.drama.make({ organizationId: orgId, id });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status === "keyframes");

    const real = globalThis.fetch;
    let down = new Set(["fal-ai/sync-lipsync/v2"]);
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const u = String(url);
      if (/\/req\/r\d+\?m=/.test(u) && down.has(decodeURIComponent(u.split("?m=")[1]))) {
        calls.push({ url: u, init });
        return Response.json({ detail: "Downstream service unavailable" }, { status: 504 });
      }
      return real(url, init);
    });
    calls = [];
    await c.drama.approveKeyframes({ organizationId: orgId, id });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status !== "making");
    expect(db.getDramaEpisode(id, orgId)!.status).toBe("ready");
    expect(posts(drama.MODELS.video)).toHaveLength(1);
    expect(posts(drama.MODELS.lipsync).length).toBeGreaterThan(0);
    expect(posts(drama.MODELS.lipsyncKling)).toHaveLength(1);

    // Every lip-sync service down: it stops, the animated clip is kept, and Make again only redoes the lip sync.
    await c.drama.remakeShot({ organizationId: orgId, id, n: 1 });
    await waitFor(() => !["making"].includes(db.getDramaEpisode(id, orgId)!.status));
    if (db.getDramaEpisode(id, orgId)!.status === "keyframes") await c.drama.approveKeyframes({ organizationId: orgId, id });
    down = new Set(["fal-ai/sync-lipsync/v2", "fal-ai/kling-video/lipsync/audio-to-video", "fal-ai/latentsync"]);
    calls = [];
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status === "failed", 60_000);
    const failed = drama.shotsOf(db.getDramaEpisode(id, orgId)!)[0];
    expect(failed.rawClipUrl).toBeTruthy();
    expect(db.getDramaEpisode(id, orgId)!.error).toMatch(/animated clip is saved/);
    const animatedOnce = posts(drama.MODELS.video).length;
    down = new Set();
    await c.drama.make({ organizationId: orgId, id });
    await waitFor(() => db.getDramaEpisode(id, orgId)!.status !== "making");
    expect(db.getDramaEpisode(id, orgId)!.status).toBe("ready");
    expect(posts(drama.MODELS.video)).toHaveLength(animatedOnce);
  }, 120_000);
  it("waits out fal.ai's temporary outages instead of stopping, but stops on a real error", async () => {
    const real = globalThis.fetch;
    let downs = 2;
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      if (String(url).includes("/status") && downs > 0) {
        downs--;
        return Response.json({ detail: "Downstream service unavailable" }, { status: 504 });
      }
      return real(url, init);
    });
    const out = await drama.falRun("fal-ai/kling-video/v3/pro/image-to-video", { prompt: "x" });
    expect(out.video.url).toBe("https://fal.media/clip.mp4");
    expect(downs).toBe(0);
    expect(drama.TRANSIENT.test("fal.ai said no (504): Downstream service unavailable")).toBe(true);
    expect(drama.TRANSIENT.test("fal.ai said no (422): image too small")).toBe(false);
  });
});
