import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let decision: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? decision : {})) };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as avatar from "./employees/avatar";
import { storagePut } from "./storage";
import { ENV } from "./_core/env";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const SCRIPT = "If you run a group practice, you've done this. A new client calls, and someone types their name, phone and insurance into your marketing system. Then they open your EHR and type all of it again. I did that for years. So I built LeadDash: one place where the client goes in once and shows up everywhere.";

let calls: { url: string; init: any }[] = [];
let falStatus = "IN_PROGRESS";
const before = { fal: ENV.falKey, eleven: ENV.elevenLabsKey };

beforeEach(() => {
  calls = [];
  falStatus = "IN_PROGRESS";
  (ENV as any).falKey = "fal-test";
  (ENV as any).elevenLabsKey = "el-test";
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    // 40 seconds of 128 kbps MP3.
    if (u.includes("api.elevenlabs.io/v1/text-to-speech/")) return new Response(Buffer.alloc(640_000), { status: 200 });
    if (u === "https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard") return Response.json({ request_id: "r1", status_url: "https://queue.fal.run/fal-ai/kling-video/requests/r1/status", response_url: "https://queue.fal.run/fal-ai/kling-video/requests/r1" });
    if (u.endsWith("/requests/r1/status")) return Response.json({ status: falStatus });
    if (u.endsWith("/requests/r1")) return Response.json({ video: { url: "https://v3.fal.media/files/out.mp4" } });
    if (u === "https://v3.fal.media/files/out.mp4") return new Response(Buffer.from("mp4-bytes"), { status: 200 });
    // A made-up person's portrait (Elena's casting tools) and the stock voices on the account.
    if (u === "https://queue.fal.run/fal-ai/nano-banana-pro") return Response.json({ request_id: "p1", status_url: "https://queue.fal.run/req/p1/status", response_url: "https://queue.fal.run/req/p1" });
    if (u.endsWith("/req/p1/status")) return Response.json({ status: "COMPLETED" });
    if (u.endsWith("/req/p1")) return Response.json({ images: [{ url: "https://fal.media/maya.png" }] });
    if (u === "https://fal.media/maya.png") return new Response(Buffer.from("png-bytes"), { status: 200 });
    if (u === "https://api.elevenlabs.io/v1/voices") return Response.json({ voices: [{ voice_id: "v-ashley", name: "Ashley", category: "cloned", labels: { gender: "female" } }, { voice_id: "v-brian", name: "Brian", category: "premade", labels: { gender: "male" } }, { voice_id: "v-rachel", name: "Rachel", category: "premade", labels: { gender: "female" } }] });
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  (ENV as any).falKey = before.fal;
  (ENV as any).elevenLabsKey = before.eleven;
});

describe("Elena makes videos of the owner from her photo and voice", () => {
  it("writes the script in chat, makes it with her photo and voice on fal.ai, saves the video and posts it", async () => {
    const { orgId, owner } = await makeWorkspace("avatar");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg-bytes"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Ashley headshot, front.jpg", content: "Front-facing headshot", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "voice-ashley", voiceName: "Ashley", quality: "standard", limitCents: 5000 });

    decision = { ...blank, action: "avatar_script", title: "Typing every client in twice", message: SCRIPT };
    const r = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make a video of me talking to therapists about double entry" });
    expect(r.reply.content).toMatch(/^Here's the script\. It's about \d+ seconds in your voice, using "Ashley headshot, front\.jpg" from the Brain\./);
    const card = JSON.parse(r.reply.cards!)[0];
    expect(card.type).toBe("avatar_video");
    const draft = (await c.avatar.get({ organizationId: orgId, id: card.id }))!;
    expect(draft).toMatchObject({ status: "draft", script: SCRIPT, photoTitle: "Ashley headshot, front.jpg" });
    expect(draft.cost).toMatch(/^about \$\d+\.\d\d$/);

    decision = { ...blank, action: "make_avatar" };
    const made = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make it" });
    expect(made.reply.content).toBe('Making "Typing every client in twice" now. It usually takes 3 to 8 minutes, and I\'ll post it here when it\'s done.');
    const tts = calls.find((x) => x.url.includes("text-to-speech/voice-ashley"))!;
    expect(JSON.parse(tts.init.body).text).toBe(SCRIPT);
    const sub = calls.find((x) => x.url === "https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard")!;
    expect(sub.init.headers.authorization).toBe("Key fal-test");
    const body = JSON.parse(sub.init.body);
    expect(body.image_url).toBe(`data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}`);
    expect(body.audio_url.startsWith("data:audio/mpeg;base64,")).toBe(true);
    let v = db.getAvatarVideo(card.id, orgId)!;
    expect(v.status).toBe("making");
    expect(v.tenths).toBe(400);
    expect(v.costCents).toBe(225); // 40 seconds at $0.0562

    // Still making: nothing changes.
    await avatar.avatarTicks();
    expect(db.getAvatarVideo(card.id, orgId)!.status).toBe("making");
    falStatus = "COMPLETED";
    await avatar.avatarTicks();
    v = db.getAvatarVideo(card.id, orgId)!;
    expect(v.status).toBe("ready");
    expect(v.videoUrl).toMatch(/^\/files\/org-\d+\/videos\/avatar-\d+_[0-9a-f]+\.mp4$/);
    const last = (await db.listChatMessages(orgId, elena.id)).at(-1)!;
    expect(last.content).toBe('Your video "Typing every client in twice" is ready. It came out at 0:40 and cost $2.25. It\'s saved on my Videos tab.');
    expect(JSON.parse(last.cards!)[0]).toMatchObject({ type: "avatar_video", id: v.id });
    expect((await c.avatar.settings({ organizationId: orgId })).spentCents).toBe(225);
    expect((await c.avatar.list({ organizationId: orgId })).map((x) => x.status)).toEqual(["ready"]);
  });

  it("puts a made-up person on camera when asked: cast from the description, portrait made once, a fitting stock voice", async () => {
    const { orgId, owner } = await makeWorkspace("avatar-cast");
    const c = caller(owner);
    const elena = (await db.getEmployeeByKind(orgId, "video"))!;
    decision = { ...blank, action: "avatar_script", title: "Finally on time", message: SCRIPT, from: "Maya: a therapist in her 40s, braids, cardigan, warm and a little tired" };
    const r = await c.chat.send({ organizationId: orgId, employeeId: elena.id, text: "Make a 30 second UGC about a therapist finishing notes on time, not me this time" });
    expect(r.reply.content).toMatch(/Maya is on camera: a therapist in her 40s/);
    const card = JSON.parse(r.reply.cards!)[0];
    const draft = (await c.avatar.get({ organizationId: orgId, id: card.id }))!;
    expect(draft.who).toMatchObject({ name: "Maya", look: "a therapist in her 40s, braids, cardigan, warm and a little tired" });
    expect(draft.photoTitle).toBe("Maya (made up)");
    expect(draft.voiceName).toBe("Rachel");

    // Make it: the portrait is made from her description, then the talking video from that portrait and her voice.
    const made = await c.avatar.make({ organizationId: orgId, id: card.id });
    expect(made.status).toBe("making");
    const portrait = calls.find((x) => x.url === "https://queue.fal.run/fal-ai/nano-banana-pro");
    expect(JSON.parse(portrait!.init.body).prompt).toMatch(/Candid portrait photograph of Maya, a therapist in her 40s/);
    const tts = calls.find((x) => x.url.includes("/v1/text-to-speech/"));
    expect(tts!.url).toContain("/v1/text-to-speech/v-rachel");
    const video = calls.find((x) => x.url === "https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard");
    expect(JSON.parse(video!.init.body).prompt).toMatch(/the kind a real person films on their phone/);
    expect(db.listDramaCast(orgId).find((x) => x.name === "Maya")?.photoUrl).toMatch(/\/files\//);

    // The same name again reuses her, portrait and all.
    const d2 = await avatar.draft(orgId, { title: "Again", script: SCRIPT, who: "Maya" });
    expect(d2.castId).toBe(draft.who!.id);
    expect(db.listDramaCast(orgId).filter((x) => x.name === "Maya")).toHaveLength(1);
    // "me" is still the owner.
    const d3 = await avatar.draft(orgId, { title: "Me", script: SCRIPT, who: "me" });
    expect(d3.castId).toBeNull();
  });

  it("won't start a video that would go over the monthly limit, and says what's missing", async () => {
    const { orgId, owner } = await makeWorkspace("avatar-limit");
    const c = caller(owner);
    const pic = await storagePut(`org-${orgId}/brain/front.jpg`, Buffer.from("jpeg"), "image/jpeg");
    const img = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "front.jpg", content: "", fileUrl: pic.url });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "v1", voiceName: "Ashley", quality: "pro", limitCents: 100 });
    const d = await avatar.draft(orgId, { title: "Too long", script: SCRIPT });
    await expect(c.avatar.make({ organizationId: orgId, id: d.id })).rejects.toThrow(/would go over your \$1 monthly limit/);
    expect(db.getAvatarVideo(d.id, orgId)!.status).toBe("draft");

    (ENV as any).falKey = "";
    await c.avatar.saveSettings({ organizationId: orgId, imageId: img.id, voiceId: "v1", voiceName: "Ashley", quality: "pro", limitCents: 5000 });
    await expect(c.avatar.make({ organizationId: orgId, id: d.id })).rejects.toThrow(/FAL_KEY is missing/);
  });
});
