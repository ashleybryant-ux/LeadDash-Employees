import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import { ENV } from "../_core/env";
import { KNOWLEDGE_CATEGORIES, type HistoryImport } from "../../drizzle/schema";
import { learnFact } from "./learn";

/**
 * Company history from the owner's own Claude or ChatGPT chats. She downloads
 * her data export (a .zip with conversations.json) and uploads it on the Brain.
 * Each chat is read in order, oldest first so newer statements win, and the
 * lasting facts about this workspace's business are saved to the Brain as
 * "Learned: <topic>". Chats about clients are left out entirely: no client name
 * or health detail is ever saved. The upload is deleted when the import ends.
 */

export type Turn = { who: "owner" | "ai"; text: string };
export type Convo = { title: string; at: Date | null; turns: Turn[] };
export type Saved = { id: number; topic: string; fact: string; from: string };

const MAX_CHATS = 800;
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

/** Reads an export (zip or bare conversations.json) into chats, and says whose export it is. */
export async function readExport(buf: Buffer): Promise<{ source: "claude" | "chatgpt"; convos: Convo[] }> {
  let json = "";
  if (buf.subarray(0, 2).toString() === "PK") {
    const zip = await JSZip.loadAsync(buf);
    const entry = Object.values(zip.files).find((f) => !f.dir && /(^|\/)conversations\.json$/i.test(f.name));
    if (!entry) throw new Error("That file has no conversations.json inside. Upload the .zip that Claude or ChatGPT emailed you.");
    json = await entry.async("string");
  } else json = buf.toString("utf8");
  let list: any[];
  try {
    list = JSON.parse(json);
  } catch {
    throw new Error("That file isn't a Claude or ChatGPT export.");
  }
  if (!Array.isArray(list)) throw new Error("That file isn't a Claude or ChatGPT export.");
  const sample = list.find(Boolean) ?? {};
  if ("chat_messages" in sample) return { source: "claude", convos: fromClaude(list) };
  if ("mapping" in sample) return { source: "chatgpt", convos: fromChatGpt(list) };
  throw new Error("That file isn't a Claude or ChatGPT export.");
}

/** The most recent chats worth reading, in the order they happened. */
export function pickChats(convos: Convo[]) {
  return convos
    .filter((c) => c.turns.some((t) => t.who === "owner" && t.text.length >= 20))
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, MAX_CHATS)
    .reverse();
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
  const buf = await fs.promises.readFile(imp.filePath);
  const { source, convos } = await readExport(buf);
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
    while (i < chats.length && (batch.length === 0 || size + chatText(chats[i]).length <= BATCH_CHARS) && batch.length < 12) {
      const t = chatText(chats[i]);
      batch.push({ c: chats[i], n: batch.length + 1 });
      size += t.length;
      i++;
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
    let client = 0;
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
