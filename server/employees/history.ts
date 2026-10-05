import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { StringDecoder } from "node:string_decoder";
import { PassThrough } from "node:stream";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import { ENV } from "../_core/env";
import { KNOWLEDGE_CATEGORIES, type HistoryImport } from "../../drizzle/schema";
import { learnFact } from "./learn";

/**
 * Company history from the owner's own Claude or ChatGPT chats. She downloads
 * her data export (a .zip with conversations.json, or the manifest .json that
 * Claude's newer exports send, whose links the server downloads) and uploads it on the Brain.
 * Each chat is read in order, oldest first so newer statements win, and the
 * lasting facts about this workspace's business are saved to the Brain as
 * "Learned: <topic>". Chats about clients are left out entirely: no client name
 * or health detail is ever saved. The upload is deleted when the import ends.
 */

export type Turn = { who: "owner" | "ai"; text: string };
export type Convo = { title: string; at: Date | null; turns: Turn[] };
export type Saved = { id: number; topic: string; fact: string; from: string };

const MAX_CHATS = 1500;
const BATCH_CHARS = 24_000;
const PER_CHAT_CHARS = 9_000;

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const textOf = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.type === "text" && typeof o.content === "string") return o.content;
  }
  return "";
};

/** Claude's export: [{ name, created_at, chat_messages: [{ sender, text, content }] }]. */
function fromClaude(list: any[]): Convo[] {
  return list.map((c) => ({
    title: String(c.name || c.title || "Untitled chat"),
    at: c.created_at ? new Date(c.created_at) : null,
    turns: (c.chat_messages ?? [])
      .map((m: any) => ({ who: m.sender === "human" ? "owner" : "ai", text: (typeof m.text === "string" && m.text.trim() ? m.text : textOf(m.content)).trim() }) as Turn)
      .filter((t: Turn) => t.text),
  }));
}

/** ChatGPT's export: [{ title, create_time, mapping: { id: { message, parent } }, current_node }], walked back from the last message. */
function fromChatGpt(list: any[]): Convo[] {
  return list.map((c) => {
    const turns: Turn[] = [];
    const mapping = c.mapping ?? {};
    let node = c.current_node ? mapping[c.current_node] : null;
    let guard = 0;
    while (node && guard++ < 5000) {
      const m = node.message;
      const role = m?.author?.role;
      const text = textOf(m?.content?.parts ?? m?.content?.text ?? "").trim();
      if (text && (role === "user" || role === "assistant")) turns.unshift({ who: role === "user" ? "owner" : "ai", text });
      node = node.parent ? mapping[node.parent] : null;
    }
    return { title: String(c.title || "Untitled chat"), at: c.create_time ? new Date(Number(c.create_time) * 1000) : null, turns };
  });
}

/** Claude's newer export: a manifest .json with a download link for each part (conversations, projects, memories). */
type Manifest = { data_files?: { export_url?: string; category?: string; filename?: string }[] };

export function isManifest(buf: Buffer) {
  if (buf.subarray(0, 2).toString() === "PK" || buf.length > 5_000_000) return false;
  try {
    const m = JSON.parse(buf.toString("utf8")) as Manifest;
    return !Array.isArray(m) && Array.isArray(m?.data_files);
  } catch {
    return false;
  }
}

const MAX_PART = 400_000_000;

async function downloadPart(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !/(^|\.)claude\.ai$|(^|\.)anthropic\.com$/.test(u.hostname)) throw new Error("That manifest has a link that isn't from Claude.");
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Claude's export link didn't open (${res.status}). The links expire 24 hours after the export is made and may work only once, so request a new export from Claude and upload the new manifest.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PART) throw new Error("One part of that export is too large to read.");
  return buf;
}

/** Every JSON file in a zip (or the buffer itself, if it's JSON), parsed. */
async function jsonFiles(buf: Buffer, match: RegExp) {
  const out: unknown[] = [];
  if (buf.subarray(0, 2).toString() === "PK") {
    const zip = await JSZip.loadAsync(buf);
    for (const f of Object.values(zip.files)) {
      if (f.dir || !match.test(f.name)) continue;
      try {
        out.push(JSON.parse(await f.async("string")));
      } catch {
        // Not JSON: skipped.
      }
    }
  } else {
    try {
      out.push(JSON.parse(buf.toString("utf8")));
    } catch {
      // Not JSON: skipped.
    }
  }
  return out;
}

/** Strings worth reading inside any JSON value (memory text, project instructions and documents). */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.join("").length > 200_000) return out;
  if (typeof v === "string") {
    if (v.trim().length >= 20 && !/^[\w-]{8,}$/.test(v.trim()) && !/^\d{4}-\d{2}-\d{2}T/.test(v)) out.push(v.trim());
  } else if (Array.isArray(v)) v.forEach((x) => strings(x, out, depth + 1));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!/uuid|id$|_at$|url|account/i.test(k)) strings(x, out, depth + 1);
  return out;
}

/**
 * Downloads every part a manifest links to and turns it into one Claude
 * conversations list: the chats, plus each project's instructions and
 * documents and the saved memories as chats of the owner's own words.
 */
export async function expandManifest(buf: Buffer) {
  const m = JSON.parse(buf.toString("utf8")) as Manifest;
  const files = (m.data_files ?? []).filter((f) => f.export_url && ["conversations", "projects", "memories"].includes(String(f.category)));
  if (!files.some((f) => f.category === "conversations")) throw new Error("That manifest has no conversations part.");
  const chats: any[] = [];
  for (const f of files) {
    const part = await downloadPart(f.export_url!);
    chats.push(...JSON.parse((await partToChats(part, f.category as "conversations" | "projects" | "memories")).toString("utf8")));
  }
  return Buffer.from(JSON.stringify(chats), "utf8");
}

/** Long text (a memory, a project's documents) split into chats of about 8,000 characters, in turns the reader keeps whole. */
function asChats(title: string, at: string | null, text: string) {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += 2400) pieces.push(text.slice(i, i + 2400));
  const out: { name: string; created_at: string | null; chat_messages: { sender: string; text: string }[] }[] = [];
  for (let i = 0; i < pieces.length; i += 3) {
    const n = Math.floor(i / 3) + 1;
    out.push({ name: pieces.length > 3 ? `${title} (part ${n})` : title, created_at: at, chat_messages: pieces.slice(i, i + 3).map((t) => ({ sender: "human", text: t })) });
  }
  return out;
}

/** One part of Claude's newer export as a Claude conversations list. */
export async function partToChats(part: Buffer, category: "conversations" | "projects" | "memories") {
  const chats: any[] = [];
  {
    const f = { category };
    if (f.category === "conversations") {
      chats.push(...convosToClaude((await readExport(part)).convos));
    } else if (f.category === "projects") {
      for (const j of await jsonFiles(part, /\.json$/i)) {
        for (const p of Array.isArray(j) ? j : [j]) {
          if (!p || typeof p !== "object") continue;
          const o = p as Record<string, unknown>;
          const text = strings({ description: o.description, instructions: o.prompt_template ?? o.instructions, docs: o.docs }).join("\n\n").slice(0, 60_000);
          if (text) chats.push(...asChats(`Project: ${String(o.name ?? "Untitled")}`, (o.updated_at ?? o.created_at ?? null) as string | null, text));
        }
      }
    } else {
      const text = (await jsonFiles(part, /\.json$/i)).flatMap((j) => strings(j)).join("\n\n").slice(0, 400_000);
      if (text) chats.push(...asChats("Claude memory", new Date().toISOString(), text));
    }
  }
  return Buffer.from(JSON.stringify(chats), "utf8");
}

/**
 * Calls onItem for each element of a top-level JSON array, read as a stream.
 * A Claude export's conversations.json can be close to a gigabyte, more than
 * one JavaScript string can hold, so it is never read whole.
 */
export async function eachArrayItem(stream: AsyncIterable<Buffer | string>, onItem: (v: unknown) => void) {
  const dec = new StringDecoder("utf8");
  let depth = 0;
  let inStr = false;
  let esc = false;
  let capturing = false;
  let parts: string[] = [];
  let sawArray = false;
  const feed = (chunk: string) => {
    let seg = capturing ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;
        else if (c === 34) inStr = false;
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 91 || c === 123) {
        depth++;
        if (depth === 1 && c === 91) sawArray = true;
        if (depth === 2 && c === 123 && !capturing) {
          capturing = true;
          seg = i;
          parts = [];
        }
      } else if (c === 93 || c === 125) {
        if (depth === 2 && c === 125 && capturing) {
          parts.push(chunk.slice(seg, i + 1));
          onItem(JSON.parse(parts.join("")));
          parts = [];
          capturing = false;
          seg = -1;
        }
        depth--;
      }
    }
    if (capturing && seg >= 0) parts.push(chunk.slice(seg));
  };
  for await (const chunk of stream) feed(typeof chunk === "string" ? chunk : dec.write(chunk));
  feed(dec.end());
  return sawArray;
}

/** Only what's read later is kept for each chat: the owner's words (up to 2,500 characters a turn) and short AI answers, about 12,000 characters a chat. */
function slim(c: Convo): Convo {
  const turns: Turn[] = [];
  let size = 0;
  for (const t of c.turns) {
    const text = t.text.slice(0, t.who === "owner" ? 2500 : 500);
    if (size + text.length > 12_000) break;
    turns.push({ who: t.who, text });
    size += text.length;
  }
  return { title: c.title.slice(0, 200), at: c.at, turns };
}

/** Back to Claude's shape, so a slimmed history can be saved and read again. */
export function convosToClaude(convos: Convo[]) {
  return convos.map((c) => ({ name: c.title, created_at: c.at ? c.at.toISOString() : null, chat_messages: c.turns.map((t) => ({ sender: t.who === "owner" ? "human" : "assistant", text: t.text })) }));
}

/** Reads an export (a zip, a bare conversations.json, or a file on disk) into chats, and says whose export it is. */
export async function readExport(input: Buffer | string): Promise<{ source: "claude" | "chatgpt"; convos: Convo[] }> {
  const buf = typeof input === "string" ? null : input;
  const head = buf ? buf.subarray(0, 2).toString() : await fs.promises.open(input as string, "r").then(async (fh) => {
    const b = Buffer.alloc(2);
    await fh.read(b, 0, 2, 0);
    await fh.close();
    return b.toString();
  });
  const streams: (() => AsyncIterable<Buffer | string>)[] = [];
  const extra: Convo[] = [];
  if (head === "PK") {
    const zip = await JSZip.loadAsync(buf ?? (await fs.promises.readFile(input as string)));
    const files = Object.values(zip.files).filter((f) => !f.dir);
    const names = files.map((f) => f.name);
    const convs = files.filter((f) => /(^|\/)conversations[^/]*\.json$/i.test(f.name));
    if (convs.length) {
      // Claude's newer exports can split chats over several files: they're all read.
      // JSZip's stream is an old-style one; piping it through a PassThrough makes it async iterable.
      for (const f of convs) streams.push(() => (f.nodeStream("nodebuffer") as unknown as NodeJS.ReadableStream).pipe(new PassThrough()));
    } else if (names.some((n) => /(^|\/)(projects|memories)(\/[^/]+|[^/]*)\.json$/i.test(n))) {
      // A projects or memories part from Claude's newer export, uploaded on its own.
      const raw = JSON.parse((await partToChats(buf ?? (await fs.promises.readFile(input as string)), names.some((n) => /projects/i.test(n)) ? "projects" : "memories")).toString("utf8"));
      extra.push(...fromClaude(raw).map(slim));
    } else if (names.some((n) => /users\.json|login_history\.json/i.test(n))) {
      throw new Error("That's the account part of Claude's export (your name and sign-ins), with no chats in it. Upload the conversations part (conversations-000.zip) or the manifest .json.");
    } else throw new Error("That file has no conversations inside. Upload the .zip that Claude or ChatGPT sent you, or Claude's manifest .json.");
  } else if (buf) streams.push(async function* () {
    yield buf;
  });
  else streams.push(() => fs.createReadStream(input as string));

  let source: "claude" | "chatgpt" | null = extra.length ? "claude" : null;
  const convos: Convo[] = [...extra];
  let bad = false;
  for (const open of streams) {
    let ok = false;
    try {
      ok = await eachArrayItem(open(), (item) => {
        if (!item || typeof item !== "object") return;
        const o = item as Record<string, unknown>;
        if ("chat_messages" in o) {
          source ??= "claude";
          convos.push(slim(fromClaude([o])[0]));
        } else if ("mapping" in o) {
          source ??= "chatgpt";
          convos.push(slim(fromChatGpt([o])[0]));
        } else bad = true;
      });
    } catch {
      ok = false;
    }
    if (!ok) bad = true;
  }
  if (!source || (bad && !convos.length)) throw new Error("That file isn't a Claude or ChatGPT export.");
  return { source, convos };
}

/** The most recent chats worth reading, in the order they happened. */
export function pickChats(convos: Convo[]) {
  return convos
    .filter((c) => c.turns.some((t) => t.who === "owner" && t.text.length >= 20))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, MAX_CHATS)
    .reverse();
}

/**
 * Chats that look like they hold a real client's details never leave the
 * server, not even to be sorted by the AI: they're counted as client chats and
 * skipped. This is a first screen; the AI's own check still runs on the rest.
 */
const CLINICAL = [
  /\b(DOB|D\.O\.B\.?|date of birth)\b/i,
  /\b[FZ]\d{2}\.\d{1,2}\b/, // ICD-10 codes like F41.1
  /\b(mental status exam|MSE\b|chief complaint|presenting problem|biopsychosocial|history of present illness)/i,
  /\b(suicid\w*|homicid\w*|SI\/HI|self[- ]harm)\b/i,
  /\b(Medicaid|member|subscriber|policy) (ID|number|#)\s*[:#]?\s*[A-Z0-9]{5,}/i,
  /\b(my|the|this|a) (client|patient)('s)? (name is|named|who|with|reported|presents|presented|stated|disclosed|was diagnosed)\b/i,
  /\b(session|progress|intake|psychotherapy) note (for|about) (my|a|the|this) (client|patient)\b/i,
  /\b(clinical evaluation|psychological evaluation|diagnostic assessment) (for|of) [A-Z][a-z]+/,
];
export function looksClinical(c: Convo) {
  const text = `${c.title}\n${c.turns.filter((t) => t.who === "owner").map((t) => t.text).join("\n")}`;
  return CLINICAL.some((re) => re.test(text));
}

/** One chat as text: the owner's words in full (they're the source), the AI's answers shortened. */
export function chatText(c: Convo) {
  let out = `### ${c.title}${c.at ? ` (${fmtDay(c.at)})` : ""}\n`;
  for (const t of c.turns) {
    const line = t.who === "owner" ? `Owner: ${t.text.slice(0, 2500)}` : `AI: ${t.text.slice(0, 500)}`;
    if (out.length + line.length > PER_CHAT_CHARS) break;
    out += `${line}\n`;
  }
  return out;
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

const running = new Set<number>();

/** Starts (or picks back up) an import in the background. */
export function run(imp: HistoryImport) {
  if (running.has(imp.id)) return;
  running.add(imp.id);
  void work(imp.id, imp.organizationId)
    .catch((err) => {
      db.updateHistoryImport(imp.id, imp.organizationId, { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 400), finishedAt: new Date() });
    })
    .finally(() => {
      running.delete(imp.id);
      const now = db.getHistoryImport(imp.id, imp.organizationId);
      if (now && ["done", "stopped", "failed"].includes(now.status)) fs.promises.unlink(now.filePath).catch(() => null);
    });
}

async function work(id: number, orgId: number) {
  let imp = db.getHistoryImport(id, orgId)!;
  const size = (await fs.promises.stat(imp.filePath)).size;
  let buf = size <= 5_000_000 ? await fs.promises.readFile(imp.filePath) : Buffer.alloc(0);
  // A manifest's links work once and expire: everything is downloaded now and kept, so a restart reads the saved copy.
  // The same manifest uploaded to a second workspace reuses the first download, for 3 days.
  if (isManifest(buf)) {
    const crypto = await import("node:crypto");
    const dir = path.dirname(imp.filePath);
    const cache = path.join(dir, `manifest-${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32)}.json`);
    for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (!f.startsWith("manifest-")) continue;
      const st = await fs.promises.stat(path.join(dir, f)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3 * 86_400_000) await fs.promises.unlink(path.join(dir, f)).catch(() => null);
    }
    if (fs.existsSync(cache)) buf = await fs.promises.readFile(cache);
    else {
      buf = await expandManifest(buf);
      await fs.promises.writeFile(cache, buf);
    }
    await fs.promises.writeFile(imp.filePath, buf);
  }
  const { source, convos } = await readExport(buf.length ? buf : imp.filePath);
  const chats = pickChats(convos);
  imp = db.updateHistoryImport(id, orgId, { source, total: chats.length, status: "running" })!;
  const org = await db.getOrganizationById(orgId);
  const name = source === "claude" ? "Claude" : "ChatGPT";
  const about = [org?.name, org?.description].filter(Boolean).join(": ");

  let i = imp.done;
  while (i < chats.length) {
    const fresh = db.getHistoryImport(id, orgId);
    if (!fresh || fresh.status === "stopped") return;
    // Several short chats go in one read; a long one goes alone.
    const batch: { c: Convo; n: number }[] = [];
    let size = 0;
    let screened = 0;
    while (i < chats.length && (batch.length === 0 || size + chatText(chats[i]).length <= BATCH_CHARS) && batch.length < 12) {
      if (looksClinical(chats[i])) {
        screened++;
        i++;
        continue;
      }
      const t = chatText(chats[i]);
      batch.push({ c: chats[i], n: batch.length + 1 });
      size += t.length;
      i++;
    }
    if (!batch.length) {
      const cur = db.getHistoryImport(id, orgId)!;
      db.updateHistoryImport(id, orgId, { done: i, skippedClient: cur.skippedClient + screened });
      continue;
    }
    const known = (await db.listKnowledgeByOrg(orgId)).filter((k) => k.title.startsWith("Learned: ")).map((k) => k.title.slice(9)).slice(-200).join("; ");
    const out = await generateJson<{ chats: { n: number; about_business: boolean; client_details: boolean; facts: { topic: string; fact: string; category: string }[] }[] }>({
      system: `You read the owner's past chats with an AI assistant and keep only lasting facts about her business, ${about || "this workspace"}, so her AI employees know them without being told again.
Keep: what the business is and sells, offers and prices, who the customers are, the team and roles, tools and vendors, brand and voice, important dates and deadlines, decisions she made, and how she wants work done.
Never keep: anything about a client or patient (names, stories, symptoms, diagnoses, treatment, notes, sessions), passwords, codes, account numbers, or personal matters unrelated to the business. A chat about clinical work or a client is client_details true, and you save nothing from it.
Leave out one-off tasks, drafts, brainstorming she didn't settle on, and anything the AI said that she didn't confirm. When a later chat changes a fact (a new price), the later one is right.
For each chat: about_business says whether it's about this business at all. facts: each with a 2 to 5 word topic, one plain sentence, and a category from ${KNOWLEDGE_CATEGORIES.join(", ")}. Reuse a known topic's exact name when the fact is about it. At most 6 facts per chat.
Known topics: ${known || "none yet"}.`,
      prompt: batch.map((b) => `## Chat ${b.n}\n${chatText(b.c)}`).join("\n\n"),
      schemaName: "history_facts",
      schema: obj({ chats: { type: "array", items: obj({ n: { type: "integer" }, about_business: { type: "boolean" }, client_details: { type: "boolean" }, facts: { type: "array", items: obj({ topic: str, fact: str, category: str }) } }) } }),
      maxTokens: 3000,
    });
    const items = parse<Saved[]>(db.getHistoryImport(id, orgId)!.items, []);
    let client = screened;
    let other = 0;
    for (const b of batch) {
      const r = (out.chats ?? []).find((x) => x.n === b.n);
      if (!r || r.client_details) {
        if (r?.client_details) client++;
        else other++;
        continue;
      }
      if (!r.about_business || !r.facts?.length) {
        other++;
        continue;
      }
      const from = `${name}${b.c.at ? `, ${fmtDay(b.c.at)}` : ""}`;
      for (const f of r.facts.slice(0, 6)) {
        const saved = await learnFact(orgId, { topic: f.topic, fact: f.fact, category: f.category, who: imp.who, via: `${name} in a chat`, when: b.c.at ? fmtDay(b.c.at) : undefined });
        if (!saved) continue;
        const at = items.findIndex((x) => x.id === saved.item.id);
        const row = { id: saved.item.id, topic: f.topic.trim(), fact: saved.fact, from };
        if (at >= 0) items[at] = row;
        else items.push(row);
      }
    }
    const cur = db.getHistoryImport(id, orgId)!;
    db.updateHistoryImport(id, orgId, { done: i, items: JSON.stringify(items.slice(-1000)), skippedClient: cur.skippedClient + client, skippedOther: cur.skippedOther + other });
  }
  db.updateHistoryImport(id, orgId, { status: "done", finishedAt: new Date() });
}

/** Saves an uploaded export and starts reading it. */
export async function start(orgId: number, user: { id: number; name: string }, fileName: string, filePath: string) {
  const busy = db.listHistoryImports(orgId, 5).find((h) => h.status === "reading" || h.status === "running");
  if (busy) {
    await fs.promises.unlink(filePath).catch(() => null);
    throw new TRPCError({ code: "BAD_REQUEST", message: "An import is already running. Stop it or wait for it to finish." });
  }
  const imp = db.createHistoryImport({ organizationId: orgId, userId: user.id, who: user.name, fileName: fileName.slice(0, 200), filePath });
  run(imp);
  return imp;
}

/** One upload covers every workspace the person runs (owner or admin): each keeps only the facts about its own business. */
export async function startEverywhere(orgId: number, user: { id: number; name: string }, fileName: string, filePath: string) {
  const imp = await start(orgId, user, fileName, filePath);
  const also: string[] = [];
  for (const o of await db.listOrganizationsForUser(user.id)) {
    if (o.id === orgId) continue;
    const m = await db.getOrganizationMembership(o.id, user.id);
    if (!m || (m.role !== "owner" && m.role !== "admin")) continue;
    const copy = holdingPath(o.id);
    try {
      await fs.promises.link(filePath, copy).catch(() => fs.promises.copyFile(filePath, copy));
      await start(o.id, user, fileName, copy);
      also.push(o.name);
    } catch (err) {
      console.warn(`[history] not started in workspace ${o.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { imp, also };
}

export function stop(orgId: number, id: number) {
  const imp = db.getHistoryImport(id, orgId);
  if (!imp) throw new TRPCError({ code: "NOT_FOUND", message: "That import is not in this workspace." });
  if (imp.status === "reading" || imp.status === "running") db.updateHistoryImport(id, orgId, { status: "stopped", finishedAt: new Date() });
  if (!running.has(id)) fs.promises.unlink(imp.filePath).catch(() => null);
  return db.getHistoryImport(id, orgId)!;
}

/** Takes one saved fact back out of the Brain. */
export async function removeFact(orgId: number, importId: number, knowledgeId: number) {
  const imp = db.getHistoryImport(importId, orgId);
  if (!imp) throw new TRPCError({ code: "NOT_FOUND", message: "That import is not in this workspace." });
  const items = parse<Saved[]>(imp.items, []);
  if (!items.some((x) => x.id === knowledgeId)) throw new TRPCError({ code: "NOT_FOUND", message: "That fact didn't come from this import." });
  await db.deleteKnowledgeItem(knowledgeId, orgId);
  return db.updateHistoryImport(importId, orgId, { items: JSON.stringify(items.filter((x) => x.id !== knowledgeId)) })!;
}

/** Picks imports back up after a restart. */
export function resumeImports() {
  for (const imp of db.listRunningHistoryImports()) {
    if (fs.existsSync(imp.filePath)) run(imp);
    else db.updateHistoryImport(imp.id, imp.organizationId, { status: "failed", error: "The uploaded file was lost when the server restarted. Upload it again.", finishedAt: new Date() });
  }
}

export function view(imp: HistoryImport) {
  return {
    id: imp.id,
    fileName: imp.fileName,
    source: imp.source,
    status: imp.status,
    total: imp.total,
    done: imp.done,
    skippedClient: imp.skippedClient,
    skippedOther: imp.skippedOther,
    items: parse<Saved[]>(imp.items, []).slice().reverse(),
    error: imp.error,
    createdAt: imp.createdAt,
    finishedAt: imp.finishedAt,
  };
}

/** Where uploads wait while they're read: next to the database, outside the served files folder. */
export function holdingPath(orgId: number) {
  const dir = path.join(path.dirname(path.resolve(ENV.databasePath)), "imports");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `org-${orgId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.upload`);
}
