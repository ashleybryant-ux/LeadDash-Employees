import { describe, it, expect, vi, beforeEach } from "vitest";

/* A model that refuses a temperature setting (2026-11-03): the employee's
 * answer must still come back, sent again without it. */

vi.mock("../usage", () => ({
  SEARCH_PRICE: 0,
  recordSearch: async () => undefined,
  recordTokens: async () => undefined,
  tokenCost: () => 0,
}));

process.env.ASSEMBLYAI_API_KEY = "test-key";
process.env.LLM_MODEL = "model-without-temperature";

describe("gateway temperature", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("retries without temperature when the model refuses it, and remembers", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ("temperature" in body) {
        return new Response(JSON.stringify({ message: "invalid request body", metadata: { errors: ["model the AI model does not support temperature"] } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Notes are ready." } }], usage: {} }), { status: 200 });
    }));
    const { generateText } = await import("./llm");

    expect(await generateText({ system: "s", prompt: "p", temperature: 0.5 })).toBe("Notes are ready.");
    expect(bodies.length).toBe(2);
    expect("temperature" in bodies[0]).toBe(true);
    expect("temperature" in bodies[1]).toBe(false);

    /* The next call for the same model goes straight out without it. */
    expect(await generateText({ system: "s", prompt: "p" })).toBe("Notes are ready.");
    expect(bodies.length).toBe(3);
    expect("temperature" in bodies[2]).toBe(false);
  });

  it("a different 400 is still an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "too long" }), { status: 400 })));
    const { generateText } = await import("./llm");
    await expect(generateText({ system: "s", prompt: "p" })).rejects.toThrow(/AI gateway error 400/);
  });
});
