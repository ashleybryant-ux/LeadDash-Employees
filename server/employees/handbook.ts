import { z } from "zod";
import * as db from "../db";
import { DEFAULT_HANDBOOK, type HandbookPart } from "./handbook-default";

/**
 * The handbook every employee reads on every task: the LeadDash base (the
 * text in handbook-default.ts, with any part LeadDash staff edited), plus the
 * workspace's own additions under each part. Additions win where they
 * disagree with the base.
 */

const MAX_RULE = 2000;

export const partSchema = z.object({
  title: z.string().trim().min(1).max(200),
  lead: z.string().trim().max(1000),
  sections: z
    .array(
      z.object({
        title: z.string().trim().max(300),
        rules: z.array(z.string().trim().min(1).max(MAX_RULE)).max(60),
        table: z
          .object({
            columns: z.array(z.string().trim().max(100)).min(1).max(6),
            rows: z.array(z.array(z.string().trim().max(600)).max(6)).max(40),
          })
          .nullable()
          .optional(),
      })
    )
    .min(1)
    .max(20),
});

export const additionsSchema = z.array(z.string().trim().min(1).max(MAX_RULE)).max(40);

let baseCache: HandbookPart[] | null = null;
const textCache = new Map<number, string>();

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The base handbook, in order, with staff edits applied. */
export function baseHandbook(): (HandbookPart & { updatedBy: string | null; updatedAt: Date | null })[] {
  const rows = new Map(db.listHandbookParts().map((r) => [r.key, r]));
  const parts = DEFAULT_HANDBOOK.map((d) => {
    const row = rows.get(d.key);
    if (!row) return { ...d, updatedBy: null, updatedAt: null };
    const saved = parse<Partial<HandbookPart>>(row.content, {});
    const ok = partSchema.safeParse(saved);
    return ok.success ? { ...ok.data, sections: ok.data.sections.map((sec) => ({ ...sec, table: sec.table ?? null })), key: d.key, updatedBy: row.updatedBy, updatedAt: row.updatedAt } : { ...d, updatedBy: null, updatedAt: null };
  });
  baseCache = parts;
  return parts;
}

export function additionsFor(organizationId: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of db.listHandbookAdditions(organizationId)) {
    const rules = parse<string[]>(r.rules, []).filter((x) => typeof x === "string" && x.trim());
    if (rules.length) out[r.partKey] = rules;
  }
  return out;
}

export function ruleCount(p: HandbookPart) {
  return p.sections.reduce((n, sec) => n + sec.rules.length + (sec.table?.rows.length ?? 0), 0);
}

function renderPart(p: HandbookPart, extra: string[] | undefined) {
  const lines: string[] = [`## ${p.title}`];
  if (p.lead) lines.push(p.lead);
  for (const sec of p.sections) {
    if (sec.title) lines.push("", `### ${sec.title}`);
    for (const r of sec.rules) lines.push(r.includes("\n") ? `\n${r}\n` : `- ${r}`);
    if (sec.table && sec.table.rows.length) {
      lines.push(`| ${sec.table.columns.join(" | ")} |`, `| ${sec.table.columns.map(() => "---").join(" | ")} |`);
      for (const row of sec.table.rows) lines.push(`| ${sec.table.columns.map((_, i) => (row[i] ?? "").replace(/\|/g, "/")).join(" | ")} |`);
    }
  }
  if (extra?.length) {
    lines.push("", "### This workspace's additions to this part (these win where they differ from the base)");
    for (const r of extra) lines.push(`- ${r}`);
  }
  return lines.join("\n");
}

/** The whole handbook as text for an employee's instructions. Cached per workspace until someone edits it. */
export function handbookText(organizationId: number) {
  const hit = textCache.get(organizationId);
  if (hit) return hit;
  const base = baseCache ?? baseHandbook();
  const extra = additionsFor(organizationId);
  const text = ["# LeadDash Employees Handbook (follow it on every task)", ...base.map((p) => renderPart(p, extra[p.key]))].join("\n\n");
  textCache.set(organizationId, text);
  return text;
}

function forgetText(organizationId?: number) {
  if (organizationId === undefined) textCache.clear();
  else textCache.delete(organizationId);
}

/** What changed between two versions, in a few words, for the Changes list. */
function changeSummary(before: HandbookPart, after: HandbookPart) {
  const b = ruleCount(before);
  const a = ruleCount(after);
  const bits: string[] = [];
  if (before.title !== after.title) bits.push("renamed");
  if (before.lead !== after.lead) bits.push("opening line edited");
  if (a > b) bits.push(`${a - b} rule${a - b === 1 ? "" : "s"} added`);
  if (a < b) bits.push(`${b - a} rule${b - a === 1 ? "" : "s"} removed`);
  if (before.sections.length !== after.sections.length) bits.push(`${after.sections.length} sections`);
  if (!bits.length) bits.push("rules edited");
  return bits.join(", ");
}

export function saveBasePart(key: string, part: z.infer<typeof partSchema>, actorName: string) {
  const before = (baseCache ?? baseHandbook()).find((p) => p.key === key);
  if (!before) throw new Error("That part of the handbook does not exist.");
  const clean: HandbookPart = { key, title: part.title, lead: part.lead, sections: part.sections.map((sec) => ({ title: sec.title, rules: sec.rules, table: sec.table && sec.table.rows.length ? sec.table : null })) };
  db.saveHandbookPart(key, JSON.stringify(clean), actorName);
  db.logHandbookChange({ organizationId: null, partKey: key, actorName, summary: changeSummary(before, clean) });
  baseCache = null;
  forgetText();
  return baseHandbook().find((p) => p.key === key)!;
}

export function resetBasePart(key: string, actorName: string) {
  if (!DEFAULT_HANDBOOK.some((p) => p.key === key)) throw new Error("That part of the handbook does not exist.");
  db.deleteHandbookPart(key);
  db.logHandbookChange({ organizationId: null, partKey: key, actorName, summary: "back to the original text" });
  baseCache = null;
  forgetText();
}

export function saveAdditions(organizationId: number, key: string, rules: string[], actorName: string) {
  if (!DEFAULT_HANDBOOK.some((p) => p.key === key)) throw new Error("That part of the handbook does not exist.");
  const before = additionsFor(organizationId)[key] ?? [];
  db.saveHandbookAddition(organizationId, key, JSON.stringify(rules), actorName);
  const d = rules.length - before.length;
  db.logHandbookChange({ organizationId, partKey: key, actorName, summary: d > 0 ? `${d} addition${d === 1 ? "" : "s"} added` : d < 0 ? `${-d} addition${d === -1 ? "" : "s"} removed` : "additions edited" });
  forgetText(organizationId);
  return rules;
}

export function partTitle(key: string) {
  return (baseCache ?? baseHandbook()).find((p) => p.key === key)?.title ?? key;
}
