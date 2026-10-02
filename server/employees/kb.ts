import * as db from "../db";
import type { OrganizationKnowledge } from "../../drizzle/schema";
import { chunkText } from "./docs";

/**
 * Knowledge search. Every Brain entry, every employee's Knowledge entry and
 * every file from a host's package is split into passages and indexed, so an
 * employee answering an application question reads the passages that answer
 * it, from documents of any length.
 */

const STOP = new Set(
  "a an and are as at be by can do does for from has have how i if in into is it its may more most of on or our please should that the their them then there these they this to us was we what when where which who why will with you your describe explain provide list include including organization applicant program project proposed".split(" ")
);

/** Turns a question into a full-text query: its distinctive words, any of which may match. */
export function ftsQuery(text: string, max = 24) {
  const words = (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])
    .map((w) => w.replace(/'s$/, "").replace(/^-+|-+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const unique = Array.from(new Set(words)).slice(0, max);
  return unique.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

export function indexKnowledge(item: OrganizationKnowledge) {
  if (item.kind === "image") {
    db.replaceChunks(item.organizationId, "knowledge", item.id, item.employeeId ?? null, [{ heading: item.title, text: `${item.title}. ${item.content}` }]);
    return 1;
  }
  const chunks = chunkText(item.content).map((c) => ({ heading: c.heading ?? item.title, text: c.text }));
  db.replaceChunks(item.organizationId, "knowledge", item.id, item.employeeId ?? null, chunks);
  return chunks.length;
}

/** Indexes any entry saved before passages existed. Runs once at start-up. */
export async function ensureIndexed() {
  let n = 0;
  for (const item of await db.listAllKnowledge()) {
    if (db.countChunks(item.organizationId, "knowledge", item.id) === 0 && item.content.trim()) {
      indexKnowledge(item);
      n++;
    }
  }
  if (n) console.log(`[knowledge] indexed ${n} existing entries`);
}

export type Passage = { source: string; heading: string | null; text: string };

/**
 * The passages that best answer a question, labeled with where each came
 * from. Searches the Brain, the employee's Knowledge and the host's files.
 */
export async function findPassages(
  orgId: number,
  query: string,
  opts: { employeeId?: number | null; opportunityId?: number | null; limit?: number }
): Promise<Passage[]> {
  const files = opts.opportunityId ? await db.listOppFiles(orgId, opts.opportunityId) : [];
  const hits = db.searchChunks(orgId, ftsQuery(query), {
    employeeId: opts.employeeId ?? null,
    opportunityFileIds: files.map((f) => f.id),
    limit: opts.limit ?? 10,
  });
  if (hits.length === 0) return [];
  const knowledgeIds = Array.from(new Set(hits.filter((h) => h.sourceType === "knowledge").map((h) => h.sourceId)));
  const titles = new Map<number, string>();
  for (const id of knowledgeIds) {
    const k = await db.getKnowledgeItem(id, orgId);
    if (k) titles.set(id, k.title);
  }
  return hits.map((h) => ({
    source: h.sourceType === "knowledge" ? titles.get(h.sourceId) ?? "Brain" : `${files.find((f) => f.id === h.sourceId)?.name ?? "Host file"} (host's package)`,
    heading: h.heading,
    text: h.text,
  }));
}

export function formatPassages(passages: Passage[], maxChars = 14_000) {
  let used = 0;
  const out: string[] = [];
  for (const p of passages) {
    const block = `### From "${p.source}"${p.heading ? `, ${p.heading}` : ""}\n${p.text}`;
    if (used + block.length > maxChars) break;
    out.push(block);
    used += block.length;
  }
  return out.join("\n\n");
}
