import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { withUsage } from "../usage";
import type { AIEmployee, EmployeeKind } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import { loadBrain } from "./brain";
import { BASE_RULES } from "./roster";
import { partsIn, zonedToUtc } from "./schedule";
import { INTERVIEWS, allQuestions, type BrainNeed, type IQuestion } from "./interview-defs";

/**
 * Onboarding as a new-hire interview, and the Guidelines it fills.
 *
 * - Each employee reaches out first with a chat message and a Start button.
 * - The interview runs on the Onboarding tab (one part at a time) or in chat
 *   (one question at a time). Answers live in ai_employees.onboarding; where the
 *   interview stands lives in ai_employees.interview.
 * - Every answer becomes a numbered line in Guidelines under its question
 *   heading, marked "From your interview". Lines can also come from chat
 *   ("Added in chat"), from your examples ("Learned from 3 examples"), or from
 *   you on the Guidelines tab. Conflicting lines are flagged with fixed choices.
 */

// ==========================================
// Stored shapes
// ==========================================

export type Answer = string | string[];
export type Example = { liked: boolean; text: string };
export type Followup = { q: string; options: string[]; section: string; answer?: string };
export type InterviewState = {
  step: number;
  done: boolean;
  doneAt?: string;
  welcomedAt?: string;
  remindAt?: string;
  samples?: { label: string; text: string }[];
  examples?: Example[];
  followups?: Followup[];
  followupsAsked?: boolean;
  /** "How I will work": answers the employee drafted from the Brain, for the owner to approve instead of the full interview. */
  plan?: Plan;
};
export type Plan = { answers: Record<string, Answer>; guesses: string[]; at: string };

export type GSource = "interview" | "chat" | "learned" | "you" | "settled";
export type GItem = { id: string; text: string; source: GSource; at: string; note?: string };
export type Conflict = { id: string; section: string; text: string; itemIds: string[]; options: { label: string; keep: string }[] };
export type GuidelinesV2 = { v: 2; sections: Record<string, GItem[]>; conflicts: Conflict[]; dismissed: string[] };

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};
const newId = () => crypto.randomBytes(5).toString("hex");
const nowIso = () => new Date().toISOString();

export function readState(emp: Pick<AIEmployee, "interview">): InterviewState {
  const s = parse<Partial<InterviewState>>(emp.interview, {});
  return { step: Number.isInteger(s.step) ? Math.max(0, s.step!) : 0, done: !!s.done, doneAt: s.doneAt, welcomedAt: s.welcomedAt, remindAt: s.remindAt, samples: Array.isArray(s.samples) ? s.samples : undefined, examples: Array.isArray(s.examples) ? s.examples : [], followups: Array.isArray(s.followups) ? s.followups : [], followupsAsked: !!s.followupsAsked, plan: s.plan && typeof s.plan === "object" && s.plan.answers ? s.plan : undefined };
}

export function readAnswers(emp: Pick<AIEmployee, "onboarding">): Record<string, Answer> {
  const a = parse<Record<string, unknown>>(emp.onboarding, {});
  const out: Record<string, Answer> = {};
  for (const [k, v] of Object.entries(a)) {
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function saveState(emp: AIEmployee, patch: Partial<InterviewState>) {
  const next = { ...readState(emp), ...patch };
  return (await db.updateEmployee(emp.id, emp.organizationId, { interview: JSON.stringify(next) }))!;
}

/** Guidelines in the new shape. Older {focus, avoid, signAs} answers become lines in the first section. */
export function readGuidelines(emp: Pick<AIEmployee, "guidelines" | "kind">): GuidelinesV2 {
  const raw = parse<Record<string, unknown>>(emp.guidelines, {});
  const guides = INTERVIEWS[emp.kind].guides;
  if (raw.v === 2) {
    const sections: Record<string, GItem[]> = {};
    const src = (raw.sections ?? {}) as Record<string, GItem[]>;
    for (const g of guides) sections[g.key] = Array.isArray(src[g.key]) ? src[g.key].filter((i) => i && typeof i.text === "string") : [];
    return { v: 2, sections, conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as Conflict[]) : [], dismissed: Array.isArray(raw.dismissed) ? (raw.dismissed as string[]) : [] };
  }
  const sections: Record<string, GItem[]> = Object.fromEntries(guides.map((g) => [g.key, [] as GItem[]]));
  const first = guides[0].key;
  const rules = guides.find((g) => g.key === "rules")?.key ?? first;
  const at = nowIso();
  if (typeof raw.focus === "string" && raw.focus.trim()) sections[first].push({ id: "legacy-focus", text: raw.focus.trim(), source: "you", at });
  if (typeof raw.avoid === "string" && raw.avoid.trim()) sections[rules].push({ id: "legacy-avoid", text: `Avoid: ${raw.avoid.trim()}`, source: "you", at });
  if (typeof raw.signAs === "string" && raw.signAs.trim()) sections[first].push({ id: "legacy-sign", text: `Sign as: ${raw.signAs.trim()}`, source: "you", at });
  return { v: 2, sections, conflicts: [], dismissed: [] };
}

async function saveGuidelines(emp: AIEmployee, g: GuidelinesV2) {
  return (await db.updateEmployee(emp.id, emp.organizationId, { guidelines: JSON.stringify(g) }))!;
}

// ==========================================
// Answers into guideline lines
// ==========================================

function filled(v: Answer | undefined) {
  return Array.isArray(v) ? v.length > 0 : !!String(v ?? "").trim();
}

function lineFor(q: IQuestion, v: Answer, st: InterviewState) {
  if (q.type === "samples") {
    const s = st.samples?.find((x) => x.label === v);
    return s ? `Sounds like this (${s.label}): "${s.text}"` : `Sounds like: ${v}`;
  }
  const val = Array.isArray(v) ? v.join(", ") : v.trim();
  return `${q.short ?? q.label}: ${val}`;
}

/** Rebuilds the "From your interview" lines from the answers, keeping every other line where it is. */
export function applyAnswers(kind: EmployeeKind, g: GuidelinesV2, answers: Record<string, Answer>, st: InterviewState): GuidelinesV2 {
  const at = nowIso();
  const qs = allQuestions(kind).filter((q) => q.type !== "examples");
  const fresh: Record<string, GItem[]> = Object.fromEntries(Object.keys(g.sections).map((k) => [k, [] as GItem[]]));
  for (const q of qs) {
    const v = answers[q.key];
    if (!filled(v) || !fresh[q.guide]) continue;
    const id = `i:${q.key}`;
    const old = g.sections[q.guide]?.find((i) => i.id === id);
    const text = lineFor(q, v, st);
    fresh[q.guide].push({ id, text, source: "interview", at: old && old.text === text ? old.at : at });
  }
  (st.followups ?? []).forEach((f, i) => {
    if (!f.answer || !fresh[f.section]) return;
    fresh[f.section].push({ id: `f:${i}`, text: `${f.q.replace(/\?$/, "")}: ${f.answer}`, source: "interview", at });
  });
  const sections: Record<string, GItem[]> = {};
  for (const k of Object.keys(g.sections)) sections[k] = [...fresh[k], ...g.sections[k].filter((i) => i.source !== "interview")];
  return { ...g, sections };
}

// ==========================================
// The Brain part
// ==========================================

export async function brainFacts(orgId: number, needs: BrainNeed[]) {
  const brain = await loadBrain(orgId);
  const org = brain.org;
  return needs.map((n) => {
    let value = "";
    let from = "";
    if (n.field && org) {
      value = String((org as Record<string, unknown>)[n.field] ?? "").trim();
      from = n.field === "brandColors" ? "Workspace: Brand" : "Workspace";
    } else if (n.entry) {
      const e = brain.entries.find((x) => x.title.trim().toLowerCase() === n.entry!.toLowerCase());
      value = e?.content.trim() ?? "";
      from = "Brain";
    }
    return { key: n.key, label: n.label, value: value.slice(0, 600), from, missing: !value, placeholder: n.placeholder ?? "" };
  });
}

/** Saves facts to the workspace profile or to a Brain entry, so every employee has them. */
export async function saveBrainFacts(orgId: number, kind: EmployeeKind, facts: Record<string, string>) {
  const needs = INTERVIEWS[kind].brain;
  const orgPatch: Record<string, string> = {};
  const entries = await db.listKnowledgeByOrg(orgId);
  for (const n of needs) {
    const v = facts[n.key];
    if (typeof v !== "string") continue;
    const val = v.trim().slice(0, 2000);
    if (n.field) {
      if (n.field === "name" && !val) continue;
      orgPatch[n.field] = val;
    } else if (n.entry && val) {
      const e = entries.find((x) => x.title.trim().toLowerCase() === n.entry!.toLowerCase());
      if (e) await db.updateKnowledgeItem(e.id, orgId, { content: val });
      else await db.createKnowledgeItem({ organizationId: orgId, title: n.entry, category: n.category ?? "mission_profile", kind: "fact", content: val });
    }
  }
  if (Object.keys(orgPatch).length) await db.updateOrganization(orgId, orgPatch);
}

// ==========================================
// Voice samples and follow-up questions
// ==========================================

const FALLBACK_SAMPLES = (orgName: string) => [
  { label: "Warm and personal", text: `Most people who reach out to ${orgName} aren't in crisis. They're tired of carrying the same thing alone. If that's you, a first conversation is a good place to set it down.` },
  { label: "Expert and direct", text: `People who wait for a crisis usually need more time to recover. Starting earlier works. Here's what the first step at ${orgName} looks like.` },
  { label: "Encouraging and plain", text: `You don't have to have it all figured out to reach out. Come as you are. We'll take it from there together.` },
];

/** Three short samples in different voices, written from the Brain. */
export async function makeSamples(emp: AIEmployee) {
  const def = INTERVIEWS[emp.kind];
  const brain = await loadBrain(emp.organizationId);
  const orgName = brain.org?.name ?? "your business";
  let samples = FALLBACK_SAMPLES(orgName);
  try {
    const out = await generateJson<{ samples: { label: string; text: string }[] }>({
      system: `You write voice samples for ${orgName}, so the owner can pick how they sound. ${BASE_RULES}`,
      prompt: `Write 3 versions of ${def.samplesOf ?? "a short message"} for ${orgName}, each in a clearly different voice. 1 to 3 sentences each, specific to this business, no names of clients. label: 2 to 4 words naming the voice (for example "Warm and personal", "Expert and direct", "Playful").${readState(emp).samples?.length ? ` Do not repeat these voices: ${readState(emp).samples!.map((s) => s.label).join(", ")}.` : ""}\n\n# Brain\n${brain.text.slice(0, 6000)}`,
      schemaName: "voice_samples",
      schema: { type: "object", additionalProperties: false, required: ["samples"], properties: { samples: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } } } } } as JsonSchema,
      maxTokens: 700,
    });
    const got = (out.samples ?? []).filter((s) => s.label && s.text).slice(0, 3).map((s) => ({ label: s.label.slice(0, 40), text: s.text.slice(0, 400) }));
    if (got.length === 3) samples = got;
  } catch {
    // No AI key or a bad reply: the plain samples still let the owner choose.
  }
  await saveState(emp, { samples });
  return samples;
}

/** Two or three questions the answers so far leave open, like a new hire would ask. */
async function makeFollowups(emp: AIEmployee): Promise<Followup[]> {
  const def = INTERVIEWS[emp.kind];
  const answers = readAnswers(emp);
  const lines = allQuestions(emp.kind)
    .filter((q) => q.type !== "examples" && filled(answers[q.key]))
    .map((q) => `${q.label} ${Array.isArray(answers[q.key]) ? (answers[q.key] as string[]).join(", ") : answers[q.key]}`);
  if (lines.length < 3) return [];
  const brain = await loadBrain(emp.organizationId);
  try {
    const out = await generateJson<{ questions: { q: string; options: string[]; section: string }[] }>({
      system: `You are ${emp.name}, the new ${emp.roleTitle} employee for ${brain.org?.name ?? "the business"}, finishing your onboarding. ${BASE_RULES}`,
      prompt: `Ask 2 or 3 follow-up questions that the owner's answers leave unclear or that seem to conflict, the way a careful new hire would. Each question has 2 or 3 short fixed answer options. Mention the answer you are following up on. section: one of ${def.guides.map((g) => g.key).join(", ")}.\n\nAnswers:\n${lines.join("\n")}\n\n# Brain\n${brain.text.slice(0, 4000)}`,
      schemaName: "followups",
      schema: { type: "object", additionalProperties: false, required: ["questions"], properties: { questions: { type: "array", items: { type: "object", additionalProperties: false, required: ["q", "options", "section"], properties: { q: { type: "string" }, options: { type: "array", items: { type: "string" } }, section: { type: "string" } } } } } } as JsonSchema,
      maxTokens: 800,
    });
    const keys = new Set(def.guides.map((g) => g.key));
    return (out.questions ?? [])
      .filter((x) => x.q && Array.isArray(x.options) && x.options.length >= 2)
      .slice(0, 3)
      .map((x) => ({ q: x.q.slice(0, 300), options: x.options.slice(0, 3).map((o) => o.slice(0, 80)), section: keys.has(x.section) ? x.section : "working" }));
  } catch {
    return [];
  }
}

// ==========================================
// Saving parts of the interview
// ==========================================

function cleanAnswer(q: IQuestion, v: unknown): Answer | undefined {
  if (q.type === "multi") return (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && !!q.options?.includes(x));
  if (q.type === "choice") return typeof v === "string" && q.options?.includes(v) ? v : "";
  if (q.type === "examples") return undefined;
  return typeof v === "string" ? v.trim().slice(0, 800) : "";
}

const stepCount = (kind: EmployeeKind) => INTERVIEWS[kind].sections.length;

/** Saves one part's answers. With `advance`, moves to the next part; after the last part the interview is done. */
export async function savePart(emp: AIEmployee, sectionKey: string, input: Record<string, unknown>, advance: boolean) {
  const def = INTERVIEWS[emp.kind];
  const idx = def.sections.findIndex((s) => s.key === sectionKey);
  if (idx < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "That part of onboarding doesn't exist." });
  const section = def.sections[idx];
  const answers = readAnswers(emp);
  for (const q of section.questions) {
    if (!(q.key in input)) continue;
    const v = cleanAnswer(q, input[q.key]);
    if (v !== undefined) answers[q.key] = v;
  }
  let st = readState(emp);
  let next = await db.updateEmployee(emp.id, emp.organizationId, { onboarding: JSON.stringify(answers) });
  if (advance) {
    const step = Math.max(st.step, idx + 1);
    st = { ...st, step: Math.min(step, stepCount(emp.kind)) };
    next = await saveState(next!, { step: st.step });
    // Follow-ups once, after the last part that isn't "Working together".
    if (!st.followupsAsked && idx === def.sections.length - 2) {
      const followups = await makeFollowups(next!);
      next = await saveState(next!, { followups, followupsAsked: true });
      st = readState(next);
    }
    if (st.step >= stepCount(emp.kind) && !st.done) next = await finish(next!);
  }
  return refreshGuidelines(next!);
}

export async function refreshGuidelines(emp: AIEmployee) {
  const g = applyAnswers(emp.kind, readGuidelines(emp), readAnswers(emp), readState(emp));
  return saveGuidelines(emp, g);
}

async function finish(emp: AIEmployee) {
  const next = await saveState(emp, { done: true, doneAt: nowIso(), remindAt: undefined });
  await db.updateEmployee(emp.id, emp.organizationId, { onboardedAt: new Date() });
  const fresh = (await db.getEmployeeForOrg(emp.id, emp.organizationId))!;
  const { writeDayToDay } = await import("./onboarding");
  await writeDayToDay(fresh).catch(() => null);
  void checkConflicts(fresh).catch(() => null);
  return (await db.getEmployeeForOrg(next.id, next.organizationId))!;
}

export async function answerFollowup(emp: AIEmployee, index: number, answer: string) {
  const st = readState(emp);
  const f = st.followups?.[index];
  if (!f || !f.options.includes(answer)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick one of the answers." });
  const followups = st.followups!.map((x, i) => (i === index ? { ...x, answer } : x));
  return refreshGuidelines(await saveState(emp, { followups }));
}

export async function setExamples(emp: AIEmployee, examples: Example[]) {
  const clean = examples.filter((e) => e && typeof e.text === "string" && e.text.trim()).slice(0, 8).map((e) => ({ liked: !!e.liked, text: e.text.trim().slice(0, 4000) }));
  return saveState(emp, { examples: clean });
}

export async function goTo(emp: AIEmployee, step: number) {
  return saveState(emp, { step: Math.max(0, Math.min(step, stepCount(emp.kind))) });
}

/** Starts the interview over. Answers stay, so each question shows what was said before. */
export async function redo(emp: AIEmployee) {
  return saveState(emp, { step: 0, done: false, doneAt: undefined, followupsAsked: false, followups: [] });
}

// ==========================================
// The view for the Onboarding tab and chat cards
// ==========================================

export async function interviewView(emp: AIEmployee) {
  const def = INTERVIEWS[emp.kind];
  const st = readState(emp);
  return {
    sections: def.sections.map((s) => ({ key: s.key, title: s.title, intro: s.intro, questions: s.questions })),
    brain: await brainFacts(emp.organizationId, def.brain),
    answers: readAnswers(emp),
    state: { step: Math.min(st.step, def.sections.length), done: st.done, doneAt: st.doneAt ?? null, remindAt: st.remindAt ?? null, samples: st.samples ?? [], examples: st.examples ?? [], followups: st.followups ?? [] },
    guides: def.guides,
    tryIt: def.tryIt,
    total: def.sections.length,
    plan: planView(emp),
  };
}


// ==========================================
// "How I will work": the plan drafted from the Brain
// ==========================================

/** The questions a plan answers: everything but voice samples and pasted examples. */
export function planQuestions(kind: EmployeeKind) {
  return allQuestions(kind).filter((q) => q.type === "text" || q.type === "choice" || q.type === "multi");
}

/**
 * The employee answers its own interview from the Brain, the website facts and
 * what its job usually looks like, and says which answers are guesses. The
 * owner reads one card and presses Looks right, or changes a line.
 */
export async function draftPlan(emp: AIEmployee): Promise<Plan> {
  const brain = await loadBrain(emp.organizationId);
  const orgName = brain.org?.name ?? "the business";
  const qs = planQuestions(emp.kind);
  const existing = readAnswers(emp);
  const out = await generateJson<{ answers: { key: string; value: string; values: string[]; guess: boolean }[] }>({
    system: `You are ${emp.name}, the new ${emp.roleTitle} at ${orgName}, filling in your own onboarding from what the company already wrote down, so the owner only has to check it. ${BASE_RULES}
Rules:
- Answer every question. For a choice question pick one of its options exactly; for a multi question pick one to three of its options exactly (in values); for a text question write one or two plain sentences in the owner's voice, specific to ${orgName}.
- Use the Brain first. Where the Brain does not say, answer the way a careful new hire in this job would for a business like this, and mark it guess: true. Never invent a number, a name, a price or a client.
- No em dashes. American English.`,
    prompt: `Questions (key, type, label, options):
${qs.map((q) => `- ${q.key} (${q.type}): ${q.label}${q.options ? ` Options: ${q.options.join(" | ")}` : ""}${q.placeholder ? ` (for example: ${q.placeholder})` : ""}${filled(existing[q.key]) ? ` The owner already said: ${Array.isArray(existing[q.key]) ? (existing[q.key] as string[]).join(", ") : existing[q.key]}` : ""}`).join("\n")}

# Brain
${brain.text.slice(0, 14_000)}`,
    schemaName: "work_plan",
    schema: { type: "object", additionalProperties: false, required: ["answers"], properties: { answers: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "value", "values", "guess"], properties: { key: { type: "string" }, value: { type: "string" }, values: { type: "array", items: { type: "string" } }, guess: { type: "boolean" } } } } } } as JsonSchema,
    maxTokens: 3500,
  });
  const answers: Record<string, Answer> = {};
  const guesses: string[] = [];
  for (const q of qs) {
    const a = (out.answers ?? []).find((x) => x.key === q.key);
    if (!a) continue;
    const v = cleanAnswer(q, q.type === "multi" ? (a.values?.length ? a.values : a.value ? [a.value] : []) : a.value);
    if (v === undefined || !filled(v)) continue;
    answers[q.key] = v;
    if (a.guess && !filled(existing[q.key])) guesses.push(q.key);
  }
  const plan: Plan = { answers, guesses, at: nowIso() };
  await saveState(emp, { plan });
  return plan;
}

/** The plan as rows for the Onboarding tab: label, answer, section, whether it was a guess. */
export function planView(emp: AIEmployee) {
  const st = readState(emp);
  if (!st.plan) return null;
  const def = INTERVIEWS[emp.kind];
  const rows: { key: string; label: string; short: string; section: string; type: IQuestion["type"]; options: string[]; value: Answer; guess: boolean }[] = [];
  for (const s of def.sections) {
    for (const q of s.questions) {
      if (!(q.key in st.plan.answers)) continue;
      rows.push({ key: q.key, label: q.label, short: q.short ?? q.label, section: s.title, type: q.type, options: q.options ?? [], value: st.plan.answers[q.key], guess: st.plan.guesses.includes(q.key) });
    }
  }
  return { rows, at: st.plan.at };
}

/**
 * Looks right: the plan's answers (with the owner's changes) become the
 * interview answers, every part counts as done, and the first assignment is
 * made. The employee starts working from this.
 */
export async function acceptPlan(emp: AIEmployee, changes: Record<string, unknown> = {}) {
  const st = readState(emp);
  if (!st.plan) throw new TRPCError({ code: "BAD_REQUEST", message: "There is no plan to approve yet." });
  const answers = readAnswers(emp);
  for (const q of planQuestions(emp.kind)) {
    const raw = q.key in changes ? changes[q.key] : st.plan.answers[q.key];
    if (raw === undefined) continue;
    const v = cleanAnswer(q, raw);
    if (v !== undefined && filled(v)) answers[q.key] = v;
  }
  let next = await db.updateEmployee(emp.id, emp.organizationId, { onboarding: JSON.stringify(answers) });
  next = await saveState(next!, { step: stepCount(emp.kind), plan: { ...st.plan, answers: Object.fromEntries(Object.entries(answers).filter(([k]) => k in st.plan!.answers)) } });
  if (!readState(next!).done) next = await finish(next!);
  return refreshGuidelines(next!);
}

// ==========================================
// Reaching out first, reminders, and the interview in chat
// ==========================================

async function ownerFirst(orgId: number) {
  const members = await db.listMembers(orgId);
  const owner = members.find((m) => m.role === "owner") ?? members[0];
  return (owner?.name || "").trim().replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "").split(" ")[0] || "there";
}

const HELLO: Record<EmployeeKind, string> = {
  coo: "Before I set up your meetings and scorecard, I'd like to learn how you run things.",
  projects: "Before I plan your next launch, I'd like to learn how you like plans built and who owns what.",
  grants: "Before I apply for anything, I need the facts every funder asks for and a sense of what's worth your time.",
  speaking: "Before I pitch you anywhere, I'd like to learn your talks, your fee and where you'll travel.",
  prospecting: "Before I go looking, I'd like to learn exactly who a great fit is, and who to skip.",
  outreach: "Before I write to anyone, I'd like to learn your offer, what's true to say, and how you sound.",
  leads: "Before I answer anyone, I'd like to learn what I can tell people, who to book, and what to hand to you.",
  social: "Before I write anything, I'd like to learn how you want to sound and what you never want posted.",
  blog: "Before I write an article, I'd like to learn who reads the blog and how you want it to sound.",
  website: "Before I plan a page, I'd like to learn what the site needs to do and what sets you apart.",
  video: "Before I plan a video, I'd like to learn who's on camera, what can't be filmed, and your style.",
  inbox: "Before I draft a reply, I'd like to learn who matters most, what's urgent, and how you write.",
  hiring: "Before I post a job or reach out to anyone, I'd like to learn who you hire and how interviews work.",
  developer: "Before I touch any code, I'd like to learn what I can work on and what I should never change on my own.",
  onboarding: "Before I onboard a customer, I'd like to learn your steps from signed to live and how you want them to feel.",
  platform: "Before I open anything in the LeadDash platform, I'd like to learn which workflows matter most and what I should never touch.",
  ads: "Before I write an ad, I'd like to learn what you sell, who buys it, where you already run ads and what must never show up in one.",
  billing: "Before I read a single claim, I'd like to learn who works the billing here, which payers you bill most, and what I must never do on my own.",
  compliance: "Before I track anything, I'd like to learn your clinicians, their licenses and payers, and the documentation rules you hold the team to.",
  custom: "Before I start, I'd like to learn what you need from me.",
};

const ROLE: Record<EmployeeKind, string> = {
  coo: "COO",
  projects: "project manager",
  grants: "grant writer",
  speaking: "speaking agent",
  prospecting: "prospector",
  outreach: "outreach writer",
  leads: "new-leads assistant",
  social: "social media manager",
  blog: "blog writer",
  website: "website planner",
  video: "video producer",
  inbox: "inbox and calendar assistant",
  hiring: "HR director",
  developer: "developer",
  onboarding: "onboarding specialist",
  platform: "platform specialist",
  ads: "ads manager",
  billing: "billing specialist",
  compliance: "compliance coordinator",
  custom: "",
};

export function onboardingCard(emp: AIEmployee) {
  return { type: "onboarding" as const, id: emp.id, title: `${emp.name}'s onboarding` };
}

/** The first message: who the employee is and a Start button. Posted once. */
export async function welcome(emp: AIEmployee) {
  const st = readState(emp);
  if (st.welcomedAt || st.done) return null;
  const first = await ownerFirst(emp.organizationId);
  const msg = await db.createChatMessage({
    organizationId: emp.organizationId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `Hi ${first}, I'm ${emp.name}, your ${ROLE[emp.kind] || emp.roleTitle.toLowerCase()}. Glad to be on the team.\n\n${HELLO[emp.kind]} It works like a new hire's first week: I already read your Brain, so I'll only ask what's missing.`,
    cards: JSON.stringify([onboardingCard(emp)]),
  });
  await saveState(emp, { welcomedAt: nowIso() });
  return msg;
}

/** Later: remind tomorrow at 9:00 AM in the workspace's time zone. */
export async function later(emp: AIEmployee) {
  const org = await db.getOrganizationById(emp.organizationId);
  const tz = org?.timezone || "America/Chicago";
  const p = partsIn(new Date(Date.now() + 86_400_000), tz);
  const at = zonedToUtc(p.y, p.m, p.d, 9, 0, tz);
  return saveState(emp, { remindAt: at.toISOString() });
}

/** Welcomes employees that haven't reached out yet and sends reminders that are due. */
export async function interviewTick(orgId: number, now = new Date()) {
  for (const emp of await db.listEmployeesByOrg(orgId)) {
    if (emp.status === "paused") continue;
    const st = readState(emp);
    if (st.done) continue;
    if (!st.welcomedAt) {
      await welcome(emp).catch(() => null);
      continue;
    }
    if (st.remindAt && new Date(st.remindAt) <= now) {
      await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `Ready to pick up my onboarding? We're at part ${Math.min(st.step + 1, stepCount(emp.kind))} of ${stepCount(emp.kind)}.`, cards: JSON.stringify([onboardingCard(emp)]) });
      await saveState(emp, { remindAt: undefined });
    }
  }
}

export async function interviewTicks() {
  for (const orgId of await db.listAllOrganizationIds()) await withUsage({ orgId }, () => interviewTick(orgId)).catch((err) => console.warn("[interview] tick failed:", err instanceof Error ? err.message : err));
}

/** The question card in chat: which part and question it is. */
export function questionCard(emp: AIEmployee, key: string) {
  return { type: "onboarding_q" as const, id: emp.id, title: key };
}

/** The next question still to answer, from the part the interview is on. "brain" for the Brain part. */
export function nextQuestion(emp: AIEmployee): string | null {
  const def = INTERVIEWS[emp.kind];
  const st = readState(emp);
  if (st.done) return null;
  if (st.step === 0) return "brain";
  const answers = readAnswers(emp);
  for (let i = st.step; i < def.sections.length; i++) {
    for (const q of def.sections[i].questions) {
      if (q.type === "examples") {
        if (!(st.examples ?? []).length && answers.__examplesSkipped !== "yes") return q.key;
      } else if (!filled(answers[q.key]) && answers[`__skip_${q.key}`] !== "yes") return q.key;
    }
  }
  return null;
}

function where(kind: EmployeeKind, key: string) {
  const def = INTERVIEWS[kind];
  const si = def.sections.findIndex((s) => s.questions.some((q) => q.key === key));
  return { si, section: def.sections[si], qi: si >= 0 ? def.sections[si].questions.findIndex((q) => q.key === key) : -1 };
}

/** Posts the next question (or the wrap-up) in chat, moving the interview to the right part. */
async function postNext(emp: AIEmployee, lead?: string) {
  const def = INTERVIEWS[emp.kind];
  let cur = emp;
  const key = nextQuestion(cur);
  if (!key) {
    const st = readState(cur);
    if (!st.done) {
      cur = await saveState(cur, { step: def.sections.length });
      cur = await finish(cur);
      cur = await refreshGuidelines(cur);
    }
    return db.createChatMessage({ organizationId: cur.organizationId, employeeId: cur.id, role: "employee", authorName: cur.name, content: `${lead ? `${lead}\n\n` : ""}That's everything. Thank you. I wrote it all into my Guidelines, and you can change any line there. I'm ready to start.`, cards: JSON.stringify([onboardingCard(cur)]) });
  }
  if (key === "brain") return null;
  const w = where(cur.kind, key);
  const st = readState(cur);
  if (w.si > st.step) {
    // Every question in the parts before this one is answered: move forward.
    cur = await saveState(cur, { step: w.si });
    if (!st.followupsAsked && w.si === def.sections.length - 1) {
      const followups = await makeFollowups(cur);
      cur = await saveState(cur, { followups, followupsAsked: true });
    }
    cur = await refreshGuidelines(cur);
  }
  const fresh = readState(cur);
  const head = w.qi === 0 ? `Part ${w.si + 1} of ${def.sections.length}: ${w.section.title}. ${w.section.intro}` : "";
  const pendingFollowup = (fresh.followups ?? []).findIndex((f) => !f.answer);
  if (w.si === def.sections.length - 1 && w.qi === 0 && pendingFollowup >= 0) {
    return db.createChatMessage({ organizationId: cur.organizationId, employeeId: cur.id, role: "employee", authorName: cur.name, content: [lead, "Before the last part, a few follow-up questions from your answers."].filter(Boolean).join("\n\n"), cards: JSON.stringify([{ type: "onboarding_q", id: cur.id, title: `followup:${pendingFollowup}` }]) });
  }
  return db.createChatMessage({ organizationId: cur.organizationId, employeeId: cur.id, role: "employee", authorName: cur.name, content: [lead, head].filter(Boolean).join("\n\n"), cards: JSON.stringify([questionCard(cur, key)]) });
}

/** Start in chat: the owner's "Start my onboarding", what's in the Brain, then the first question. */
export async function startInChat(emp: AIEmployee, person: { name: string; userId: number }) {
  await db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "user", authorName: person.name, userId: person.userId, content: "Start my onboarding" });
  const st = readState(emp);
  if (st.step === 0) {
    const facts = await brainFacts(emp.organizationId, INTERVIEWS[emp.kind].brain);
    const have = facts.filter((f) => !f.missing).map((f) => f.label.toLowerCase());
    const miss = facts.filter((f) => f.missing).map((f) => f.label.toLowerCase());
    return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `Part 1 of ${stepCount(emp.kind)}: From your Brain. I already have your ${have.join(", ") || "workspace name"}.${miss.length ? ` Missing: ${miss.join(", ")}. Fill in what you can, fix anything wrong, then press Looks right.` : " Check it, then press Looks right."}`, cards: JSON.stringify([questionCard(emp, "brain")]) });
  }
  return postNext(emp, `Picking up where we left off.`);
}

/** An answer from a chat card: saved, echoed as the owner's message, then the next question. */
export async function answerInChat(emp: AIEmployee, person: { name: string; userId: number }, key: string, value: unknown) {
  const def = INTERVIEWS[emp.kind];
  let cur = emp;
  let echo = "";
  if (key === "brain") {
    await saveBrainFacts(emp.organizationId, emp.kind, (value && typeof value === "object" ? value : {}) as Record<string, string>);
    cur = await saveState(cur, { step: Math.max(readState(cur).step, 1) });
    echo = "Looks right.";
  } else if (key.startsWith("followup:")) {
    const i = Number(key.split(":")[1]);
    cur = await answerFollowup(cur, i, String(value ?? ""));
    echo = String(value ?? "");
  } else {
    const w = where(cur.kind, key);
    if (w.si < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "That question isn't in this onboarding." });
    const q = w.section.questions[w.qi];
    const answers = readAnswers(cur);
    if (value === "__skip") {
      answers[q.type === "examples" ? "__examplesSkipped" : `__skip_${q.key}`] = "yes";
      cur = (await db.updateEmployee(cur.id, cur.organizationId, { onboarding: JSON.stringify(answers) }))!;
      echo = "Skip this one.";
    } else if (q.type === "examples") {
      const list = Array.isArray(value) ? (value as Example[]) : [];
      cur = await setExamples(cur, list);
      if (!list.length) {
        answers.__examplesSkipped = "yes";
        cur = (await db.updateEmployee(cur.id, cur.organizationId, { onboarding: JSON.stringify(answers) }))!;
      }
      echo = list.length ? `Here ${list.length === 1 ? "is 1 example" : `are ${list.length} examples`}.` : "No examples for now.";
    } else {
      const v = cleanAnswer(q, value);
      if (v === undefined || !filled(v)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick or type an answer, or press Skip." });
      answers[q.key] = v;
      cur = (await db.updateEmployee(cur.id, cur.organizationId, { onboarding: JSON.stringify(answers) }))!;
      if (q.type === "samples") {
        const s = readState(cur).samples?.find((x) => x.label === v);
        echo = s ? `${s.label}: "${s.text}"` : String(v);
      } else echo = Array.isArray(v) ? v.join(", ") : v;
    }
    cur = await refreshGuidelines(cur);
  }
  await db.createChatMessage({ organizationId: cur.organizationId, employeeId: cur.id, role: "user", authorName: person.name, userId: person.userId, content: echo.slice(0, 2000) });
  void def;
  return postNext((await db.getEmployeeForOrg(cur.id, cur.organizationId))!);
}

// ==========================================
// Guidelines: edit, add from chat, learn from examples, conflicts
// ==========================================

export function guidelinesView(emp: AIEmployee) {
  const def = INTERVIEWS[emp.kind];
  const g = readGuidelines(emp);
  const st = readState(emp);
  return {
    sections: def.guides.map((s) => ({ key: s.key, title: s.title, items: g.sections[s.key] ?? [] })),
    conflicts: g.conflicts,
    examples: (st.examples ?? []).length,
    canLearn: (st.examples ?? []).length > 0,
  };
}

/** The Guidelines as prompt text. */
export function guidelinesText(emp: AIEmployee) {
  const def = INTERVIEWS[emp.kind];
  const g = readGuidelines(emp);
  const st = readState(emp);
  const parts: string[] = [];
  for (const s of def.guides) {
    const items = g.sections[s.key] ?? [];
    if (items.length) parts.push(`### ${s.title}\n${items.map((i, n) => `${n + 1}. ${i.text}`).join("\n")}`);
  }
  const liked = (st.examples ?? []).filter((e) => e.liked).slice(0, 2);
  const disliked = (st.examples ?? []).filter((e) => !e.liked).slice(0, 1);
  if (liked.length) parts.push(`### Examples the owner liked (match this voice; never copy them)\n${liked.map((e) => `"""${e.text.slice(0, 700)}"""`).join("\n")}`);
  if (disliked.length) parts.push(`### An example the owner did not like (do not write like this)\n${disliked.map((e) => `"""${e.text.slice(0, 500)}"""`).join("\n")}`);
  return parts.join("\n\n");
}

/** Saves one section from the Guidelines tab's Edit. Unchanged lines keep where they came from. */
export async function saveGuideSection(emp: AIEmployee, sectionKey: string, lines: { id?: string; text: string }[]) {
  const g = readGuidelines(emp);
  if (!(sectionKey in g.sections)) throw new TRPCError({ code: "BAD_REQUEST", message: "That section doesn't exist." });
  const old = g.sections[sectionKey];
  const at = nowIso();
  g.sections[sectionKey] = lines
    .map((l) => ({ ...l, text: l.text.trim().slice(0, 1500) }))
    .filter((l) => l.text)
    .slice(0, 40)
    .map((l) => {
      const prev = l.id ? old.find((o) => o.id === l.id) : undefined;
      if (prev && prev.text === l.text) return prev;
      // An edited interview line becomes yours, so a later interview save doesn't overwrite it.
      return { id: prev && prev.source !== "interview" ? prev.id : newId(), text: l.text, source: "you" as const, at };
    });
  // An interview answer whose line was removed or rewritten here is cleared too.
  const answers = readAnswers(emp);
  let changed = false;
  for (const o of old.filter((i) => i.source === "interview" && i.id.startsWith("i:"))) {
    if (!g.sections[sectionKey].some((i) => i.id === o.id)) {
      answers[o.id.slice(2)] = Array.isArray(answers[o.id.slice(2)]) ? [] : "";
      changed = true;
    }
  }
  let next = await saveGuidelines(emp, g);
  if (changed) next = (await db.updateEmployee(emp.id, emp.organizationId, { onboarding: JSON.stringify(answers) }))!;
  void checkConflicts(next).catch(() => null);
  return next;
}

/** "From now on..." in chat becomes a line, marked Added in chat. */
export async function addGuideline(emp: AIEmployee, sectionHint: string, text: string, source: GSource = "chat") {
  const def = INTERVIEWS[emp.kind];
  const g = readGuidelines(emp);
  const hint = sectionHint.trim().toLowerCase();
  const key = def.guides.find((s) => s.key === hint || s.title.toLowerCase() === hint)?.key ?? def.guides.find((s) => hint && (s.title.toLowerCase().includes(hint) || hint.includes(s.key)))?.key ?? def.guides.find((s) => s.key === "rules")?.key ?? def.guides[0].key;
  const clean = text.trim().slice(0, 1500);
  if (!clean) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no guideline to add." });
  g.sections[key] = [...(g.sections[key] ?? []), { id: newId(), text: clean, source, at: nowIso() }];
  const next = await saveGuidelines(emp, g);
  void checkConflicts(next).catch(() => null);
  return { emp: next, section: def.guides.find((s) => s.key === key)!.title };
}

/** Writes the writing-style lines from the examples the owner gave. */
export async function learnFromExamples(emp: AIEmployee) {
  const def = INTERVIEWS[emp.kind];
  const st = readState(emp);
  const ex = st.examples ?? [];
  if (!ex.length) throw new TRPCError({ code: "BAD_REQUEST", message: `Add examples in ${emp.name}'s onboarding first.` });
  const target = def.guides.find((s) => ["writing", "voice", "style", "pitch"].includes(s.key))?.key ?? def.guides[0].key;
  const out = await generateJson<{ lines: string[] }>({
    system: `You study writing samples and describe the writer's style as guidelines another writer can follow. ${BASE_RULES}`,
    prompt: `Write 3 to 6 short guideline lines describing the style of the examples the owner liked (tone, sentence length, structure, how they open and close, word choices), and 1 line on what to avoid based on the one they didn't like. Plain sentences, no headings.\n\nLiked:\n${ex.filter((e) => e.liked).map((e) => `"""${e.text.slice(0, 2500)}"""`).join("\n") || "(none)"}\n\nDidn't like:\n${ex.filter((e) => !e.liked).map((e) => `"""${e.text.slice(0, 1500)}"""`).join("\n") || "(none)"}`,
    schemaName: "style_lines",
    schema: { type: "object", additionalProperties: false, required: ["lines"], properties: { lines: { type: "array", items: { type: "string" } } } } as JsonSchema,
    maxTokens: 700,
  });
  const g = readGuidelines(emp);
  const at = nowIso();
  const note = `Learned from ${ex.length} example${ex.length === 1 ? "" : "s"}`;
  g.sections[target] = [...(g.sections[target] ?? []).filter((i) => i.source !== "learned"), ...(out.lines ?? []).slice(0, 7).map((t) => ({ id: newId(), text: t.slice(0, 600), source: "learned" as const, at, note }))];
  const next = await saveGuidelines(emp, g);
  void checkConflicts(next).catch(() => null);
  return next;
}

/** Finds guideline lines that disagree and offers fixed ways to settle each. */
export async function checkConflicts(emp: AIEmployee) {
  const def = INTERVIEWS[emp.kind];
  const g = readGuidelines(emp);
  const all = def.guides.flatMap((s) => (g.sections[s.key] ?? []).map((i) => ({ ...i, section: s.key, title: s.title })));
  if (all.length < 2) return emp;
  const out = await generateJson<{ conflicts: { text: string; itemIds: string[]; options: { label: string; keep: string }[] }[] }>({
    system: "You check a list of work guidelines for direct contradictions. Only real contradictions (two lines that cannot both be followed), not small overlaps.",
    prompt: `Lines (id: section: text):\n${all.map((i) => `${i.id}: ${i.title}: ${i.text}`).join("\n")}\n\nFor each contradiction: text (one sentence naming both lines plainly), itemIds (the ids involved), options (2 or 3 ways to settle it: label of 2 to 6 words, keep = the one guideline line that replaces the conflicting lines). Return [] if there are none.`,
    schemaName: "conflicts",
    schema: { type: "object", additionalProperties: false, required: ["conflicts"], properties: { conflicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "itemIds", "options"], properties: { text: { type: "string" }, itemIds: { type: "array", items: { type: "string" } }, options: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "keep"], properties: { label: { type: "string" }, keep: { type: "string" } } } } } } } } } as JsonSchema,
    maxTokens: 900,
  });
  const ids = new Set(all.map((i) => i.id));
  const fresh = (await db.getEmployeeForOrg(emp.id, emp.organizationId))!;
  const cur = readGuidelines(fresh);
  cur.conflicts = (out.conflicts ?? [])
    .map((c) => ({ ...c, itemIds: c.itemIds.filter((x) => ids.has(x)) }))
    .filter((c) => c.itemIds.length >= 2 && c.options.length >= 2)
    .filter((c) => !cur.dismissed.includes([...c.itemIds].sort().join("|")))
    .slice(0, 5)
    .map((c) => ({ id: newId(), section: all.find((i) => i.id === c.itemIds[0])!.section, text: c.text.slice(0, 400), itemIds: c.itemIds, options: c.options.slice(0, 3).map((o) => ({ label: o.label.slice(0, 60), keep: o.keep.slice(0, 600) })) }));
  return saveGuidelines(fresh, cur);
}

/** Settles a conflict with one of its options, or dismisses it (option -1). */
export async function resolveConflict(emp: AIEmployee, conflictId: string, option: number) {
  const g = readGuidelines(emp);
  const c = g.conflicts.find((x) => x.id === conflictId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That conflict was already settled." });
  g.conflicts = g.conflicts.filter((x) => x.id !== conflictId);
  if (option < 0) {
    g.dismissed = [...g.dismissed, [...c.itemIds].sort().join("|")].slice(-50);
    return saveGuidelines(emp, g);
  }
  const pick = c.options[option];
  if (!pick) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick one of the choices." });
  const answers = readAnswers(emp);
  let answersChanged = false;
  for (const k of Object.keys(g.sections)) {
    for (const i of g.sections[k].filter((x) => c.itemIds.includes(x.id) && x.id.startsWith("i:"))) {
      const q = i.id.slice(2);
      answers[q] = Array.isArray(answers[q]) ? [] : "";
      answersChanged = true;
    }
    g.sections[k] = g.sections[k].filter((x) => !c.itemIds.includes(x.id));
  }
  g.sections[c.section] = [...(g.sections[c.section] ?? []), { id: newId(), text: pick.keep, source: "settled", at: nowIso() }];
  let next = await saveGuidelines(emp, g);
  if (answersChanged) next = (await db.updateEmployee(emp.id, emp.organizationId, { onboarding: JSON.stringify(answers) }))!;
  return next;
}
