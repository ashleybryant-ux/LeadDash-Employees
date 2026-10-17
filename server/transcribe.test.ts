import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { ENV } from "./_core/env";
import { punctuate, routeFor, transcribeFile, GROQ_MAX_BYTES } from "./_core/transcribe";

const before = { groq: ENV.groqKey, aai: ENV.assemblyAiKey };
let calls: { url: string; body: any }[] = [];
let groqDown = false;

beforeEach(() => {
  calls = [];
  groqDown = false;
  (ENV as any).groqKey = "gsk-test";
  (ENV as any).assemblyAiKey = "aai-test";
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body });
    if (u.startsWith("https://api.groq.com/")) {
      if (groqDown) return new Response("busy", { status: 503 });
      return Response.json({ text: "Hello there, Maya. Let's begin.", duration: 2.4, words: [{ word: "Hello", start: 0, end: 0.4 }, { word: "there", start: 0.4, end: 0.8 }, { word: "Maya", start: 0.9, end: 1.3 }, { word: "Let's", start: 1.5, end: 1.8 }, { word: "begin", start: 1.8, end: 2.3 }] });
    }
    if (u.endsWith("/v2/upload")) return Response.json({ upload_url: "https://cdn.assemblyai.test/a" });
    if (u.endsWith("/v2/transcript")) return Response.json({ id: "t1" });
    if (u.includes("/v2/transcript/t1")) return Response.json({ status: "completed", text: "Hello there.", audio_duration: 1, words: [{ text: "Hello", start: 0, end: 400 }, { text: "there.", start: 400, end: 800 }] });
    return new Response("no route", { status: 500 });
  });
  vi.useFakeTimers({ toFake: ["setTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (ENV as any).groqKey = before.groq;
  (ENV as any).assemblyAiKey = before.aai;
});

const run = <T,>(p: Promise<T>) => (vi.advanceTimersByTimeAsync(5000), p);

describe("Captions on the cheapest route (2026-10-17)", () => {
  it("uses Groq for a business workspace, with every word timed and punctuated from the text", async () => {
    const { orgId } = await makeWorkspace("tx-business");
    const t = await run(transcribeFile(Buffer.from("audio"), { orgId }));
    expect(calls.map((c) => c.url)).toEqual(["https://api.groq.com/openai/v1/audio/transcriptions"]);
    const form = calls[0].body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.getAll("timestamp_granularities[]")).toContain("word");
    expect(t.words.map((w) => w.text)).toEqual(["Hello", "there,", "Maya.", "Let's", "begin."]);
    expect(t.words[2]).toMatchObject({ start: 0.9, end: 1.3 });
    expect(t.seconds).toBe(2.4);
  });

  it("never sends a healthcare practice's recording to Groq: AssemblyAI's Universal-2, under the BAA", async () => {
    const { orgId } = await makeWorkspace("tx-practice");
    await db.updateOrganization(orgId, { orgType: "healthcare" });
    expect(await routeFor(orgId, 100)).toBe("assemblyai");
    const t = await run(transcribeFile(Buffer.from("audio"), { orgId }));
    expect(calls.some((c) => c.url.includes("groq"))).toBe(false);
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/v2/transcript"))!.body).speech_models).toEqual(["universal-2"]);
    expect(t.text).toBe("Hello there.");
  });

  it("falls back to AssemblyAI when Groq is down, too big, not set up, or the workspace isn't named", async () => {
    const { orgId } = await makeWorkspace("tx-fallback");
    groqDown = true;
    const t = await run(transcribeFile(Buffer.from("audio"), { orgId }));
    expect(calls[0].url).toContain("groq");
    expect(t.text).toBe("Hello there.");
    expect(await routeFor(orgId, GROQ_MAX_BYTES + 1)).toBe("assemblyai");
    expect(await routeFor(null, 100)).toBe("assemblyai");
    (ENV as any).groqKey = "";
    expect(await routeFor(orgId, 100)).toBe("assemblyai");
  });

  it("keeps a word as heard when the text doesn't line up", () => {
    expect(punctuate("Okay so, um.", [{ text: "Okay", start: 0, end: 1 }, { text: "uh", start: 1, end: 2 }, { text: "so", start: 2, end: 3 }]).map((w) => w.text)).toEqual(["Okay", "uh", "so,"]);
  });
});
