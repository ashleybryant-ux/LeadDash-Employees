import { TRPCError } from "@trpc/server";
import { ENV } from "./env";
import { SEARCH_PRICE, recordSearch, recordTokens, tokenCost } from "../usage";

/**
 * Two routes to the model:
 *
 * 1. Writing (drafts, proposals, posts, replies) goes through the AssemblyAI
 *    LLM Gateway: the same key, endpoint and BAA DashNotes already uses. It is
 *    OpenAI-compatible and supports JSON-schema structured output.
 *
 * 2. Finding things on the web (grants, speaking events, video trends) needs a
 *    server-side web search tool. SEARCH_PROVIDER picks OpenAI's (the default,
 *    Responses API) or Anthropic's. Nothing from a client chart is ever sent
 *    on this route.
 */

/** A setup problem, not a crash: shown to the person as-is. */
export class AiNotConfiguredError extends TRPCError {
  constructor(message: string) {
    super({ code: "PRECONDITION_FAILED", message });
  }
}

export type JsonSchema = Record<string, unknown>;

type GatewayMessage = { role: "system" | "user" | "assistant"; content: string };

async function callGateway(body: Record<string, unknown>, timeoutMs = 120_000) {
  if (!ENV.assemblyAiKey) {
    throw new AiNotConfiguredError("Writing is not set up yet: ASSEMBLYAI_API_KEY is missing on the server.");
  }
  const res = await fetch(ENV.llmGatewayUrl, {
    method: "POST",
    headers: { authorization: ENV.assemblyAiKey, "content-type": "application/json" },
    body: JSON.stringify({ model: ENV.llmModel, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text);
  if (data.request_id) console.log(`[ai] gateway request ${data.request_id} (${ENV.llmModel})`);
  const u = data?.usage ?? {};
  await recordTokens(String(data?.model || ENV.llmModel), Number(u.prompt_tokens) || 0, Number(u.completion_tokens) || 0);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => p?.text ?? "").join("");
  throw new Error("AI gateway returned no text");
}

/** Plain text (markdown allowed). */
export async function generateText(opts: {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  const messages: GatewayMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];
  const out = await callGateway(
    {
      messages,
      max_tokens: opts.maxTokens ?? 3000,
      temperature: opts.temperature ?? 0.5,
    },
    opts.timeoutMs
  );
  return out.trim();
}

/** Output constrained to a JSON schema. */
export async function generateJson<T>(opts: {
  system: string;
  prompt: string;
  schemaName: string;
  schema: JsonSchema;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<T> {
  const messages: GatewayMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];
  const ask = (maxTokens: number) =>
    callGateway(
      {
        messages,
        max_tokens: maxTokens,
        temperature: opts.temperature ?? 0.4,
        response_format: {
          type: "json_schema",
          json_schema: { name: opts.schemaName, schema: opts.schema, strict: true },
        },
      },
      opts.timeoutMs
    );
  const first = opts.maxTokens ?? 4000;
  let parsed = extractJson(await ask(first));
  // Cut off before the JSON closed (the answer ran past the token limit): ask once more with room to finish.
  if (parsed === undefined) parsed = extractJson(await ask(Math.min(32_000, Math.max(first * 3, 4000))));
  if (parsed === undefined) throw new Error("AI returned something that was not valid JSON");
  return parsed as T;
}

/** Finds the first complete JSON object or array in a string. */
export function extractJson(text: string): unknown {
  const tagged = text.match(/<json>([\s\S]*?)<\/json>/i);
  const candidates = [tagged?.[1], text];
  for (const raw of candidates) {
    if (!raw) continue;
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try {
      return JSON.parse(trimmed);
    } catch {
      /* keep looking */
    }
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

export type SearchResult<T> = {
  data: T;
  /** The searches the model actually ran. */
  queries: string[];
  /** Every page the search returned or the answer cited. */
  sources: { url: string; title: string }[];
  /** What this search cost in dollars (searches plus reading), estimated from the published prices. */
  costUsd: number;
};

/**
 * Headers for a direct Anthropic call. Works with a classic key (sk-ant-api03-)
 * and a personal or service account key (sk-ant-usr-). A personal key that is
 * not scoped to one workspace also needs ANTHROPIC_WORKSPACE_ID.
 */
export function anthropicHeaders(): Record<string, string> {
  const h: Record<string, string> = { "anthropic-version": "2023-06-01", "content-type": "application/json" };
  if (ENV.anthropicKey.startsWith("sk-ant-api")) h["x-api-key"] = ENV.anthropicKey;
  else h.authorization = `Bearer ${ENV.anthropicKey}`;
  if (ENV.anthropicWorkspaceId) h["anthropic-workspace-id"] = ENV.anthropicWorkspaceId;
  return h;
}

/** True when the chosen search provider has its key. */
export function searchReady() {
  return ENV.searchProvider === "anthropic" ? Boolean(ENV.anthropicKey) : Boolean(ENV.openAiKey);
}

/** The model web searches run on, for usage records. */
export function searchModel() {
  return ENV.searchProvider === "anthropic" ? ENV.anthropicModel : ENV.openAiSearchModel;
}

type SearchOpts = {
  system: string;
  prompt: string;
  schemaName: string;
  schema: JsonSchema;
  maxUses?: number;
  maxTokens?: number;
};

type Found = { text: string; queries: string[]; sources: Map<string, string>; used: { input: number; output: number; cacheRead: number; searches: number } };

/**
 * Runs a web-search turn on the chosen provider, then returns structured
 * output. The model is told to answer only from what it found, and the parsed
 * result is converted to the schema through the gateway if the model's own
 * JSON is malformed.
 */
export async function searchJson<T>(opts: SearchOpts): Promise<SearchResult<T>> {
  if (!searchReady()) {
    throw new AiNotConfiguredError(
      ENV.searchProvider === "anthropic"
        ? "Web search is not set up yet: ANTHROPIC_API_KEY is missing on the server."
        : "Web search is not set up yet: OPENAI_API_KEY is missing on the server."
    );
  }
  const maxUses = opts.maxUses ?? ENV.searchMaxUses;
  const system =
    opts.system +
    `\n\nToday's date is ${new Date().toISOString().slice(0, 10)}.` +
    `\nUse web search, at most ${maxUses} searches. Describe only what you found in search results, never from memory. Every item must carry the exact URL of the page it came from.` +
    "\nWhen you are done searching, reply with one JSON object that matches this schema, wrapped in <json></json> tags, and nothing after it:\n" +
    JSON.stringify(opts.schema);

  const found = ENV.searchProvider === "anthropic" ? await searchAnthropic(system, opts, maxUses) : await searchOpenAi(system, opts);
  const model = searchModel();
  const { used } = found;
  await recordSearch(model, used.input, used.output, used.searches, used.cacheRead);

  let parsed = extractJson(found.text);
  if (parsed === undefined) {
    // Let the gateway restructure the findings rather than failing the whole run.
    parsed = await generateJson<T>({
      system: "Convert the research notes into the JSON schema exactly. Do not add facts that are not in the notes.",
      prompt: found.text,
      schemaName: opts.schemaName,
      schema: opts.schema,
    });
  }

  return {
    data: parsed as T,
    queries: found.queries,
    sources: Array.from(found.sources, ([url, title]) => ({ url, title })),
    costUsd: tokenCost(model, used.input, used.output, used.cacheRead) + used.searches * SEARCH_PRICE,
  };
}

/** OpenAI Responses API with its web_search tool. One request; the tool runs server-side. */
async function searchOpenAi(system: string, opts: SearchOpts): Promise<Found> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${ENV.openAiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: ENV.openAiSearchModel,
      instructions: system,
      input: opts.prompt,
      max_output_tokens: opts.maxTokens ?? 8000,
      tools: [{ type: "web_search", search_context_size: "medium" }],
      include: ["web_search_call.action.sources"],
      store: false,
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Web search error ${res.status}: ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw);
  if (data.error) throw new Error(`Web search error: ${String(data.error.message ?? data.error).slice(0, 300)}`);
  const queries: string[] = [];
  const sources = new Map<string, string>();
  let text = "";
  let searches = 0;
  for (const item of data.output ?? []) {
    if (item.type === "web_search_call") {
      searches++;
      const a = item.action ?? {};
      if (a.type === "search" && a.query) queries.push(String(a.query));
      for (const s of a.sources ?? []) if (s?.url) sources.set(s.url, s.title || s.url);
    } else if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type !== "output_text") continue;
        text += c.text ?? "";
        for (const an of c.annotations ?? []) if (an?.type === "url_citation" && an.url) sources.set(an.url, an.title || an.url);
      }
    }
  }
  const u = data.usage ?? {};
  const cacheRead = Number(u.input_tokens_details?.cached_tokens) || 0;
  return {
    text,
    queries,
    sources,
    used: { input: Math.max(0, (Number(u.input_tokens) || 0) - cacheRead), output: Number(u.output_tokens) || 0, cacheRead, searches },
  };
}

/** Anthropic Messages API with its web search tool. pause_turn means a long search was paused; the turn is sent back to resume it. */
async function searchAnthropic(system: string, opts: SearchOpts, maxUses: number): Promise<Found> {
  const messages: any[] = [{ role: "user", content: opts.prompt }];
  const queries: string[] = [];
  const sources = new Map<string, string>();
  let text = "";
  const used = { input: 0, output: 0, cacheRead: 0, searches: 0 };

  for (let round = 0; round < 4; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: ENV.anthropicModel,
        max_tokens: opts.maxTokens ?? 8000,
        system,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }],
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Web search error ${res.status}: ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw);
    used.input += Number(data.usage?.input_tokens) || 0;
    used.output += Number(data.usage?.output_tokens) || 0;
    used.cacheRead += Number(data.usage?.cache_read_input_tokens) || 0;
    used.searches += Number(data.usage?.server_tool_use?.web_search_requests) || 0;

    for (const block of data.content ?? []) {
      if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
        queries.push(String(block.input.query));
      } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r?.url) sources.set(r.url, r.title || r.url);
        }
      } else if (block.type === "text") {
        text += block.text;
        for (const c of block.citations ?? []) {
          if (c?.url) sources.set(c.url, c.title || c.url);
        }
      }
    }

    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    break;
  }
  return { text, queries, sources, used };
}

/**
 * One or two sentences describing a photo for the team that picks images:
 * setting, outfit, pose, expression, framing and what it suits (headshot,
 * website banner, speaker one-sheet, social post). Empty when the Anthropic key is off.
 */
export async function describeImage(buf: Buffer, mime: string): Promise<string> {
  if (!ENV.anthropicKey || process.env.NODE_ENV === "test") return "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: ENV.anthropicModel,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } },
            {
              type: "text",
              text: "Describe this photo in one or two plain sentences for a marketing team choosing images: the setting, what the person is wearing, pose and expression, portrait or landscape framing, and what it suits best (headshot, website banner, speaker one-sheet, social post, video thumbnail). Refer to them as \"the person\". No em dashes.",
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return "";
  const data: any = await res.json();
  await recordTokens(ENV.anthropicModel, Number(data.usage?.input_tokens) || 0, Number(data.usage?.output_tokens) || 0);
  return String((data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")).trim().slice(0, 1000);
}

export function aiStatus() {
  return {
    writing: Boolean(ENV.assemblyAiKey),
    webSearch: searchReady(),
    google: Boolean(ENV.serperKey),
    images: Boolean(ENV.openAiKey),
  };
}
