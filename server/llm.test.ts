import { afterEach, describe, expect, it, vi } from "vitest";

process.env.ASSEMBLYAI_API_KEY = "test-aai";
process.env.ANTHROPIC_API_KEY = "test-anthropic";
process.env.OPENAI_API_KEY = "test-openai";

const { ENV } = await import("./_core/env");
const { generateJson, searchJson, searchReady, extractJson } = await import("./_core/llm");

afterEach(() => {
  vi.unstubAllGlobals();
  ENV.searchProvider = "anthropic";
  ENV.openAiKey = "test-openai";
  ENV.anthropicKey = "test-anthropic";
});

describe("AI request plumbing", () => {
  it("sends the gateway request the way DashNotes does and parses structured output", async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      return new Response(JSON.stringify({ request_id: "r1", choices: [{ message: { content: '{"subject":"Hi","body":"There"}' } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await generateJson<{ subject: string }>({ system: "s", prompt: "p", schemaName: "x", schema: { type: "object" } });
    expect(out.subject).toBe("Hi");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://llm-gateway.assemblyai.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("test-aai");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.response_format.type).toBe("json_schema");
  });

  it("with SEARCH_PROVIDER=openai, runs the search on OpenAI and collects the queries, sources and tagged JSON", async () => {
    ENV.searchProvider = "openai";
    const response = {
      output: [
        { type: "web_search_call", status: "completed", action: { type: "search", query: "grants oklahoma", sources: [{ url: "https://a.org/g", title: "A" }] } },
        { type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://a.org/g" } },
        { type: "web_search_call", status: "completed", action: { type: "search", query: "grants 2027", sources: [] } },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: 'Found one. <json>{"opportunities":[{"title":"G"}]}</json>', annotations: [{ type: "url_citation", url: "https://b.org", title: "B", start_index: 0, end_index: 10 }] }],
        },
      ],
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300 },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await searchJson<{ opportunities: { title: string }[] }>({ system: "s", prompt: "p", schemaName: "g", schema: { type: "object" }, maxUses: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers.authorization).toBe("Bearer test-openai");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.tools[0].type).toBe("web_search");
    expect(body.instructions).toContain("at most 4 searches");
    expect(body.input).toBe("p");
    expect(out.queries).toEqual(["grants oklahoma", "grants 2027"]);
    expect(out.sources.map((s) => s.url)).toEqual(["https://a.org/g", "https://b.org"]);
    expect(out.data.opportunities[0].title).toBe("G");
    // 3 tool calls at $10 per 1,000, plus 1,000 fresh and 200 cached input tokens and 300 output tokens at gpt-6.1-sol prices
    expect(out.costUsd).toBeCloseTo(0.03 + (1000 * 2 + 200 * 0.2 + 300 * 10) / 1_000_000, 6);
  });

  it("says which key is missing for the chosen search provider", async () => {
    expect(ENV.searchProvider).toBe("anthropic");
    ENV.anthropicKey = "";
    expect(searchReady()).toBe(false);
    await expect(searchJson({ system: "s", prompt: "p", schemaName: "g", schema: {} })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    ENV.searchProvider = "openai";
    expect(searchReady()).toBe(true);
    ENV.openAiKey = "";
    await expect(searchJson({ system: "s", prompt: "p", schemaName: "g", schema: {} })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("collects search queries and sources, resumes a paused turn, and reads the tagged JSON", async () => {
    const responses = [
      {
        stop_reason: "pause_turn",
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "grants oklahoma" } },
          { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://a.org/g", title: "A" }] },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", name: "web_search", input: { query: "grants 2027" } },
          { type: "text", text: 'Found one. <json>{"opportunities":[{"title":"G"}]}</json>', citations: [{ url: "https://b.org", title: "B" }] },
        ],
      },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await searchJson<{ opportunities: { title: string }[] }>({ system: "s", prompt: "p", schemaName: "g", schema: { type: "object" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.queries).toEqual(["grants oklahoma", "grants 2027"]);
    expect(out.sources.map((s) => s.url)).toEqual(["https://a.org/g", "https://b.org"]);
    expect(out.data.opportunities[0].title).toBe("G");
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.tools[0].type).toBe("web_search_20250305");
    // the paused assistant turn is sent back unchanged
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body).messages[1].role).toBe("assistant");
  });

  it("finds JSON inside prose or code fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('text {"a":{"b":"}"}} more')).toEqual({ a: { b: "}" } });
    expect(extractJson("no json here")).toBeUndefined();
  });
});
