import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as avatar from "./employees/avatar";
import * as huddle from "./employees/huddle";
import { keyFor } from "./elevenlabs";
import { ENV } from "./_core/env";

const before = { eleven: ENV.elevenLabsKey, openai: ENV.openAiKey, fal: ENV.falKey };
let seen: { url: string; key: string }[] = [];

beforeEach(() => {
  seen = [];
  (ENV as any).elevenLabsKey = "el-leaddash-server";
  (ENV as any).openAiKey = "sk-openai-test";
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const key = init.headers?.["xi-api-key"] ?? "";
    seen.push({ url: String(url), key });
    if (String(url) === "https://api.elevenlabs.io/v1/voices") {
      if (key === "bad-key-bad-key-bad-key") return new Response("unauthorized", { status: 401 });
      return Response.json({ voices: [{ voice_id: "v-rivera", name: "Dr. Rivera", category: "cloned" }, { voice_id: "v-rachel", name: "Rachel", category: "premade" }] });
    }
    return new Response("no route", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  (ENV as any).elevenLabsKey = before.eleven;
  (ENV as any).openAiKey = before.openai;
  (ENV as any).falKey = before.fal;
});

describe("Voices outside LeadDash's own workspaces", () => {
  it("never uses LeadDash's ElevenLabs account in a customer workspace: standard voices until it connects its own", async () => {
    const { orgId, owner } = await makeWorkspace("el-customer");
    const c = caller(owner);
    expect(await keyFor(orgId)).toBe("");
    expect(await huddle.providerFor(orgId)).toBe("openai");
    expect((await c.voices.options({ organizationId: orgId })).hasElevenLabs).toBe(false);

    // Elena's voices: only the standard ones, never the clones on LeadDash's account.
    const s = await c.avatar.settings({ organizationId: orgId });
    expect(s.voices.length).toBeGreaterThan(5);
    expect(s.voices.every((v) => v.standard && v.id.startsWith("openai:"))).toBe(true);
    expect(s.ready).toMatchObject({ voice: true, canConnect: true });
    expect((await c.avatar.castVoices({ organizationId: orgId })).every((v) => v.standard)).toBe(true);
    expect(seen.some((x) => x.key === "el-leaddash-server")).toBe(false);

    // A video in an ElevenLabs voice can't be made here.
    const pic = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", category: "mission_profile", title: "Headshot", content: "", fileUrl: "/files/x.jpg" });
    await c.avatar.saveSettings({ organizationId: orgId, imageId: pic.id, voiceId: "v-old-clone", voiceName: "Old clone", quality: "standard", limitCents: 5000 });
    (ENV as any).falKey = "fal-test";
    const v = await avatar.draft(orgId, { title: "Hi", script: "Hello there, this is a short test video." });
    await expect(avatar.make(orgId, v.id)).rejects.toThrow(/Old clone is from ElevenLabs, which isn't connected in this workspace/);
  });

  it("uses the workspace's own ElevenLabs account once it connects one, and LeadDash's own workspaces keep the server's", async () => {
    const { orgId, owner } = await makeWorkspace("el-own");
    const c = caller(owner);
    await expect(c.elevenlabs.connect({ organizationId: orgId, apiKey: "bad-key-bad-key-bad-key" })).rejects.toThrow(/ElevenLabs didn't accept that key/);
    const r = await c.elevenlabs.connect({ organizationId: orgId, apiKey: "sk_customer_own_key_123456" });
    expect(r).toMatchObject({ internal: false, connected: true, voices: 2, own: ["Dr. Rivera"] });
    expect(JSON.stringify(await c.elevenlabs.get({ organizationId: orgId }))).not.toContain("sk_customer");
    // Only Elena's videos use it: the employees' voices stay standard.
    expect(await keyFor(orgId, "video")).toBe("sk_customer_own_key_123456");
    expect(await keyFor(orgId)).toBe("");
    expect(await huddle.providerFor(orgId)).toBe("openai");
    expect((await c.voices.options({ organizationId: orgId })).hasElevenLabs).toBe(false);
    expect((await c.avatar.castVoices({ organizationId: orgId })).map((v) => v.name)[0]).toBe("Rachel"); // stock voices from their account, never their clone
    expect((await c.avatar.settings({ organizationId: orgId })).ready.canConnect).toBe(false);

    await c.elevenlabs.disconnect({ organizationId: orgId });
    expect(await keyFor(orgId, "video")).toBe("");

    const own = await makeWorkspace("el-internal");
    await db.updateOrganization(own.orgId, { internal: true });
    expect(await keyFor(own.orgId)).toBe("el-leaddash-server");
    expect(await keyFor(own.orgId, "video")).toBe("el-leaddash-server");
    expect((await caller(own.owner).avatar.settings({ organizationId: own.orgId })).ready.canConnect).toBe(false);
  });

  it("knows the owner by their own name, not a fixed one, and times MP3 audio from its frames", async () => {
    expect(avatar.isOwner("me")).toBe(true);
    expect(avatar.isOwner("Ashley")).toBe(false);
    expect(avatar.isOwner("Dana", "Dana Whitfield")).toBe(true);
    expect(avatar.isOwner("Maya: a therapist", "Dana Whitfield")).toBe(false);
    // 100 MPEG-1 Layer III frames at 128 kbps, 44.1 kHz: 417 bytes each, 1152 samples.
    const frame = Buffer.alloc(417);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = 0x90;
    expect(avatar.mp3Tenths(Buffer.concat(Array(100).fill(frame)))).toBe(26);
  });
});
