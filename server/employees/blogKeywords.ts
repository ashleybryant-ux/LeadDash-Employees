import type { AIEmployee } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import { readAnswers } from "./interview";

/**
 * Theo's main keywords. Every article ranks for one search term: the person
 * names it, or Theo asks with their saved search terms (from his Onboarding
 * answer "Search terms to rank for") and two he suggests.
 */

export const NO_KEYWORD = "No keyword";
export const KEYWORD_QUESTION = "Which search term should this rank for?";

/** The workspace's saved search terms: Theo's onboarding answer, split on commas, semicolons or lines. */
export function savedSearchTerms(emp: Pick<AIEmployee, "onboarding">): string[] {
  const raw = readAnswers(emp).keywords;
  const parts = (Array.isArray(raw) ? raw : [raw ?? ""]).flatMap((s) => s.split(/[,;\n]+/));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const term = p.replace(/^[-*\d.\s]+/, "").replace(/^["']|["']$/g, "").trim();
    if (!term || term.length > 80 || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out.slice(0, 30);
}

/** "No keyword" (or "none") as the answer means the article is written without one. */
export function isNoKeyword(v: string | undefined) {
  return /^\s*(no keyword|no|none|skip)\.?\s*$/i.test(v ?? "");
}

/** A keyword as given: one line, no quotes, at most 80 characters. */
export function cleanKeyword(v: string | undefined) {
  if (isNoKeyword(v)) return "";
  return (v ?? "").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim().slice(0, 80);
}

/**
 * Up to 2 saved search terms that fit the topic, then Theo's own
 * suggestions, as 3 terms in all. Suggestions are real phrases people type
 * for this business's area and service; never a search volume.
 */
export async function keywordChoices(emp: AIEmployee, topic: string): Promise<{ saved: string[]; suggested: string[] }> {
  const saved = savedSearchTerms(emp);
  const { systemPromptAbout } = await import("./tasks");
  const { system } = await systemPromptAbout(
    emp,
    topic,
    `Your job: pick the main search term (keyword) a blog article should rank for.
- fitting: up to 2 of the owner's saved search terms that fit this article's topic, copied exactly. [] when none fit.
- suggested: 2 more search terms you suggest for this topic: real phrases people type into Google, in their own words, for this business's area and service (add the city or region when the business serves a local area). 2 to 6 words each, lowercase except names. Never repeat a saved term.
- Never state or guess a search volume, ranking or traffic number.`
  );
  const out = await generateJson<{ fitting?: string[]; suggested?: string[] }>({
    system,
    prompt: `Article topic: ${topic}\n\nSaved search terms:\n${saved.length ? saved.map((s) => `- ${s}`).join("\n") : "(none saved)"}`,
    schemaName: "blog_keywords",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["fitting", "suggested"],
      properties: { fitting: { type: "array", items: { type: "string" } }, suggested: { type: "array", items: { type: "string" } } },
    } as JsonSchema,
    maxTokens: 400,
    temperature: 0.3,
  }).catch(() => ({ fitting: [], suggested: [] }));
  const byLower = new Map(saved.map((s) => [s.toLowerCase(), s]));
  const fitting = Array.from(new Set((out?.fitting ?? []).map((s) => byLower.get(s.trim().toLowerCase())).filter((s): s is string => !!s))).slice(0, 2);
  const taken = new Set(fitting.map((s) => s.toLowerCase()));
  const suggested: string[] = [];
  for (const s of out?.suggested ?? []) {
    const k = cleanKeyword(s);
    if (!k || k.length > 60 || isNoKeyword(k) || taken.has(k.toLowerCase())) continue;
    taken.add(k.toLowerCase());
    suggested.push(k);
  }
  return { saved: fitting, suggested: suggested.slice(0, Math.max(0, 3 - fitting.length)) };
}

/** The tap-to-answer choices for the question: the terms, then "No keyword". */
export function keywordQuestionChoices(c: { saved: string[]; suggested: string[] }) {
  return [...c.saved, ...c.suggested].slice(0, 3).concat(NO_KEYWORD);
}

/** A 150 to 160 character meta description, cut at a word when the model ran long. */
export function fitMetaDescription(v: string | undefined) {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= 160) return s;
  const cut = s.slice(0, 160);
  const at = cut.lastIndexOf(" ");
  return `${(at > 120 ? cut.slice(0, at) : cut.slice(0, 159)).replace(/[,;:\s]+$/, "")}.`.slice(0, 160);
}
