import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { PressCoverage, PressInterview, PressLibraryItem } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { fetchWebpage } from "./files";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { contactFor, contactsFor, fmtDay, newsroomOrgs, norm, parse, type Article, type Profile } from "./newsroom";
import type { Plan } from "./pitching";

/**
 * Interviews (the briefing before you talk to a reporter), coverage (what ran
 * and what it did) and the library: quote bank, bios, story bank, seasonal
 * calendar, press kits, and approved answers to hard questions.
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown): JsonSchema => ({ type: "array", items });
const DAY = 86_400_000;

// ==========================================
// Interviews
// ==========================================

export type Briefing = { reporter: string; points: string[]; likely: string[]; hard: { q: string; answer: string; approved: boolean }[]; dontClaim: string; where: string; bio: string; after: string };

export async function createInterview(orgId: number, input: { contactId: number | null; title: string; at: Date | null; place: string }) {
  const iv = db.press.interviews.create({ organizationId: orgId, contactId: input.contactId, title: input.title.slice(0, 200), at: input.at, place: input.place.slice(0, 200) });
  if (input.contactId) {
    const c = contactFor(orgId, input.contactId);
    if (c && ["prospect", "contacted"].includes(c.relationship)) db.press.contacts.update(c.id, c.organizationId, { relationship: "engaged" });
  }
  await buildBriefing(orgId, iv.id).catch((err) => console.warn("[press] briefing skipped:", err instanceof Error ? err.message : err));
  return db.press.interviews.get(iv.id, orgId)!;
}

/** The briefing: who you're talking to, three points to land, likely and hard questions with your approved answers, what not to claim, logistics. */
export async function buildBriefing(orgId: number, id: number) {
  const iv = db.press.interviews.get(id, orgId);
  if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "That interview isn't on this desk." });
  const c = iv.contactId ? contactFor(orgId, iv.contactId) : null;
  const emp = await employeeFor(orgId, "speaking");
  const answers = db.press.library.list(orgId).filter((x) => x.kind === "answer" && x.approved);
  const quotes = db.press.library.list(orgId).filter((x) => x.kind === "quote" && x.approved);
  const camp = db.press.campaigns.list(orgId).find((x) => db.press.pitches.list(orgId).some((p) => p.campaignId === x.id && p.contactId === iv.contactId));
  const plan = camp ? parse<Plan>(camp.plan, {} as Plan) : null;
  const r = await working(emp, async () => {
    const { system } = await systemPromptFor(emp, `Your job now: you are the publicist, preparing the owner for an interview. Be specific and short. Hard questions get the owner's approved answer when one fits (copy it word for word and mark it approved); otherwise leave the answer "" for her to write. Never invent facts, numbers or customers.`);
    return generateJson<Briefing & { hardQuestions: { q: string; answerIndex: number }[] }>({
      system,
      prompt: `Interview: ${iv.title}${iv.at ? ` on ${fmtDay(new Date(iv.at))}` : ""}${iv.place ? ` (${iv.place})` : ""}
${c ? `Reporter: ${c.name}, ${c.title ? `${c.title}, ` : ""}${c.outlet}. ${c.why}\nHow they work: ${JSON.stringify(parse<Profile>(c.profile, {}))}\nRecent: ${parse<Article[]>(c.articles, []).slice(0, 4).map((a) => `"${a.title}" (${a.date})`).join("; ")}` : ""}
${plan ? `Campaign: ${camp!.title}. Main story: ${plan.story}. Never say: ${plan.neverSay}` : ""}
Approved answers (number them from 1):\n${answers.map((a, i) => `${i + 1}. Q: ${parse<{ question?: string }>(a.meta, {}).question ?? a.topic} A: ${a.text}`).join("\n") || "none yet"}
Approved quotes: ${quotes.map((q) => `"${q.text}"`).join(" ") || "none yet"}
Return: reporter (who they are and how they write, 2 or 3 sentences), points (3), likely questions (3 to 5), hardQuestions (3 to 6, each with answerIndex of the approved answer that fits or 0), dontClaim, where, bio (which bio to send), after (what to send afterwards).`,
      schemaName: "press_briefing",
      schema: obj({ reporter: str, points: arr(str), likely: arr(str), hardQuestions: arr(obj({ q: str, answerIndex: { type: "integer" } })), dontClaim: str, where: str, bio: str, after: str }),
      maxTokens: 3000,
    });
  });
  const briefing: Briefing = {
    reporter: r.reporter ?? "",
    points: (r.points ?? []).slice(0, 3),
    likely: (r.likely ?? []).slice(0, 6),
    hard: (r.hardQuestions ?? []).slice(0, 6).map((h) => {
      const a = h.answerIndex > 0 ? answers[h.answerIndex - 1] : undefined;
      return { q: h.q, answer: a?.text ?? "", approved: Boolean(a) };
    }),
    dontClaim: r.dontClaim ?? "",
    where: iv.place || r.where || "",
    bio: r.bio ?? "",
    after: r.after ?? "",
  };
  return db.press.interviews.update(id, orgId, { briefing: JSON.stringify(briefing) })!;
}

/** Saves the owner's edits to a briefing; her answers to hard questions go into the library as approved answers. */
export function saveBriefing(orgId: number, id: number, input: { title: string; at: Date | null; place: string; briefing: Briefing }) {
  const iv = db.press.interviews.get(id, orgId);
  if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "That interview isn't on this desk." });
  const lib = db.press.library.list(orgId).filter((x) => x.kind === "answer");
  const hard = input.briefing.hard.map((h) => {
    if (h.answer.trim() && !h.approved) {
      const same = lib.find((x) => norm(parse<{ question?: string }>(x.meta, {}).question) === norm(h.q));
      if (same) db.press.library.update(same.id, orgId, { text: h.answer.trim(), approved: true });
      else db.press.library.create({ organizationId: orgId, kind: "answer", topic: h.q.slice(0, 120), text: h.answer.trim(), meta: JSON.stringify({ question: h.q }), approved: true });
      return { ...h, approved: true };
    }
    return h;
  });
  return db.press.interviews.update(id, orgId, { title: input.title.slice(0, 200), at: input.at, place: input.place.slice(0, 200), briefing: JSON.stringify({ ...input.briefing, hard }) })!;
}

export function finishInterview(orgId: number, id: number) {
  const iv = db.press.interviews.get(id, orgId);
  if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "That interview isn't on this desk." });
  if (iv.contactId) {
    const c = contactFor(orgId, iv.contactId);
    if (c && ["prospect", "contacted", "engaged"].includes(c.relationship)) db.press.contacts.update(c.id, c.organizationId, { relationship: "source" });
  }
  return db.press.interviews.update(id, orgId, { status: "done" })!;
}

export async function briefingDocx(orgId: number, id: number) {
  const iv = db.press.interviews.get(id, orgId);
  if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "That interview isn't on this desk." });
  const b = parse<Briefing>(iv.briefing, {} as Briefing);
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const p = (t: string) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun(t)] });
  const h = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
  const li = (t: string) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(t)] });
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(`Interview: ${iv.title}`)] }),
    p(`${iv.at ? fmtDay(new Date(iv.at)) : "Time not set"}${iv.place ? ` · ${iv.place}` : ""}`),
    h("Who you're talking to"),
    p(b.reporter || ""),
    h("Three points to land"),
    ...(b.points ?? []).map(li),
    h("Likely questions"),
    ...(b.likely ?? []).map(li),
    h("Hard questions and your approved answers"),
    ...(b.hard ?? []).flatMap((x) => [new Paragraph({ children: [new TextRun({ text: x.q, bold: true })] }), p(x.answer || "[Your approved answer]")]),
    h("Don't claim"),
    p(b.dontClaim || ""),
    h("Logistics"),
    p(`Where: ${b.where || ""}`),
    p(`Bio to send: ${b.bio || ""}`),
    p(`After: ${b.after || ""}`),
  ];
  const doc = new Document({ styles: { default: { document: { run: { font: "Calibri", size: 24 } } } }, sections: [{ children }] });
  const name = `Interview briefing ${iv.title}`.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80);
  const saved = await storagePut(`org-${orgId}/downloads/${name}.docx`, await Packer.toBuffer(doc));
  return { url: saved.url, name: `${name}.docx` };
}

export function interviewView(orgId: number, i: PressInterview) {
  const c = i.contactId ? contactFor(orgId, i.contactId) : null;
  return { id: i.id, title: i.title, at: i.at, place: i.place, status: i.status, contactId: i.contactId, name: c?.name ?? "", outlet: c?.outlet ?? "", briefing: parse<Briefing>(i.briefing, { reporter: "", points: [], likely: [], hard: [], dontClaim: "", where: "", bio: "", after: "" }) };
}

// ==========================================
// Coverage
// ==========================================

export type CoverageDetails = { author?: string; quotesUsed?: string; messagesIn?: string; messagesMissed?: string; backlink?: boolean; visits?: number; demos?: number };

/** A story that ran: read the page, find the reporter, the quotes used and which messages made it in. */
export async function addCoverage(orgId: number, url: string) {
  const emp = await employeeFor(orgId, "speaking");
  const page = await fetchWebpage(url);
  const org = await db.getOrganizationById(orgId);
  const camps = db.press.campaigns.list(orgId);
  const r = await working(emp, async () => {
    const { system } = await systemPromptFor(emp, "Your job now: you are the publicist, logging coverage that ran. Use only what the article says.");
    return generateJson<{ headline: string; outlet: string; author: string; ranOn: string; quotesUsed: string; messagesIn: string; messagesMissed: string; backlink: boolean; campaign: string }>({
      system,
      prompt: `Article (${page.url}):\n${page.text.slice(0, 30_000)}\n\nThe owner: ${org?.signerName ?? ""}, ${org?.name ?? ""}.\nCampaigns and their main stories: ${camps.map((c) => `${c.title}: ${parse<Plan>(c.plan, {} as Plan).story}`).join("; ") || "none"}\nReturn the headline, outlet, author, date run (Mon D, YYYY), how many of the owner's quotes were used ("2 of 3" if you can tell, or the count), which campaign messages made it in and which were missed, whether it links to the owner's site, and the campaign title it belongs to or "".`,
      schemaName: "press_coverage",
      schema: obj({ headline: str, outlet: str, author: str, ranOn: str, quotesUsed: str, messagesIn: str, messagesMissed: str, backlink: { type: "boolean" }, campaign: str }),
      maxTokens: 1500,
    });
  });
  const author = contactsFor(orgId).find((c) => norm(c.name) === norm(r.author));
  const camp = camps.find((c) => norm(c.title) === norm(r.campaign));
  const row = db.press.coverage.create({
    organizationId: orgId,
    contactId: author?.id ?? null,
    campaignId: camp?.id ?? null,
    headline: (r.headline || page.title).slice(0, 255),
    outlet: (r.outlet ?? "").slice(0, 160),
    url: page.url,
    ranOn: (r.ranOn ?? "").slice(0, 40),
    details: JSON.stringify({ author: r.author, quotesUsed: r.quotesUsed, messagesIn: r.messagesIn, messagesMissed: r.messagesMissed, backlink: Boolean(r.backlink), visits: 0, demos: 0 } satisfies CoverageDetails),
  });
  if (author) {
    const count = newsroomOrgs(orgId).flatMap((o) => db.press.coverage.list(o)).filter((x) => x.contactId === author.id).length;
    db.press.contacts.update(author.id, author.organizationId, { relationship: count >= 3 ? "advocate" : "warm" });
  }
  return row;
}

export function saveCoverage(orgId: number, id: number, input: { headline: string; outlet: string; ranOn: string; details: CoverageDetails }) {
  const cv = db.press.coverage.get(id, orgId);
  if (!cv) throw new TRPCError({ code: "NOT_FOUND", message: "That story isn't on this desk." });
  return db.press.coverage.update(id, orgId, { headline: input.headline.slice(0, 255), outlet: input.outlet.slice(0, 160), ranOn: input.ranOn.slice(0, 40), details: JSON.stringify({ ...parse<CoverageDetails>(cv.details, {}), ...input.details }) })!;
}

export function removeCoverage(orgId: number, id: number) {
  db.press.coverage.remove(id, orgId);
}

export function coverageView(orgId: number, cv: PressCoverage) {
  const c = cv.contactId ? contactFor(orgId, cv.contactId) : null;
  const camp = cv.campaignId ? db.press.campaigns.get(cv.campaignId, orgId) : null;
  return { id: cv.id, headline: cv.headline, outlet: cv.outlet, url: cv.url, ranOn: cv.ranOn, reporter: c ? `${c.name} (now ${c.relationship[0].toUpperCase()}${c.relationship.slice(1)})` : parse<CoverageDetails>(cv.details, {}).author ?? "", campaign: camp?.title ?? "", details: parse<CoverageDetails>(cv.details, {}) };
}

export function coverageStats(orgId: number) {
  const cov = db.press.coverage.list(orgId);
  const pitches = db.press.pitches.list(orgId).filter((p) => p.sentAt);
  const replies = db.press.replies.list(orgId).filter((r) => r.kind !== "ooo" && r.kind !== "crisis");
  return {
    placements: cov.length,
    interviews: db.press.interviews.list(orgId).length,
    replyRate: pitches.length ? Math.round((Math.min(replies.length, pitches.length) / pitches.length) * 100) : 0,
    warm: contactsFor(orgId).filter((c) => ["source", "warm", "advocate"].includes(c.relationship)).length,
    demos: cov.reduce((t, x) => t + Number(parse<CoverageDetails>(x.details, {}).demos ?? 0), 0),
  };
}

// ==========================================
// Library
// ==========================================

export type LibKind = PressLibraryItem["kind"];

export function libraryView(i: PressLibraryItem) {
  return { id: i.id, kind: i.kind, topic: i.topic, text: i.text, meta: parse<Record<string, unknown>>(i.meta, {}), approved: i.approved, updatedAt: i.updatedAt ?? i.createdAt };
}

export function saveLibrary(orgId: number, input: { id?: number; kind: LibKind; topic: string; text: string; meta: Record<string, unknown>; approved: boolean }) {
  const row = { topic: input.topic.trim().slice(0, 200), text: input.text.trim().slice(0, 8000), meta: JSON.stringify(input.meta ?? {}), approved: input.approved };
  if (input.id) {
    if (!db.press.library.get(input.id, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That isn't in this desk's library." });
    return db.press.library.update(input.id, orgId, row)!;
  }
  return db.press.library.create({ organizationId: orgId, kind: input.kind, ...row });
}

export function removeLibrary(orgId: number, id: number) {
  db.press.library.remove(id, orgId);
}

const LENGTHS = ["25", "50", "100", "150", "full"] as const;
const BIO_ANGLES = ["Founder", "Clinical", "Relationships", "Workplace", "Tech"] as const;

/** Taylor drafts library items from the Brain: bios, the story bank or the seasonal calendar. Drafts wait for the owner's approval. */
export async function fillLibrary(orgId: number, what: "bios" | "stories" | "calendar") {
  const emp = await employeeFor(orgId, "speaking");
  const existing = db.press.library.list(orgId);
  return working(emp, async () => {
    if (what === "bios") {
      const { system } = await systemPromptFor(emp, "Your job now: you are the publicist, writing the owner's bios from the Brain. Only facts in the Brain. Third person. Each length is a hard limit in words; full is up to 300 words.");
      const r = await generateJson<{ bios: { angle: string; length: string; text: string }[] }>({
        system,
        prompt: `Write a bio for each angle (${BIO_ANGLES.join(", ")}) at each length (25, 50, 100, 150, full). Founder: building her companies. Clinical: her clinical credentials and practice. Relationships: couples and communication. Workplace: workplace mental health, disability inclusion, her research and workforce background. Tech: the technology company and clinician-built software. Skip an angle the Brain doesn't support.`,
        schemaName: "press_bios",
        schema: obj({ bios: arr(obj({ angle: str, length: str, text: str })) }),
        maxTokens: 12000,
        timeoutMs: 300_000,
      });
      let n = 0;
      for (const b of r.bios ?? []) {
        if (!(BIO_ANGLES as readonly string[]).includes(b.angle) || !(LENGTHS as readonly string[]).includes(b.length) || !b.text?.trim()) continue;
        const same = existing.find((x) => x.kind === "bio" && x.topic === b.angle && parse<{ length?: string }>(x.meta, {}).length === b.length);
        if (same?.approved) continue;
        if (same) db.press.library.update(same.id, orgId, { text: b.text.trim() });
        else db.press.library.create({ organizationId: orgId, kind: "bio", topic: b.angle, text: b.text.trim(), meta: JSON.stringify({ length: b.length }) });
        n++;
      }
      return n;
    }
    if (what === "stories") {
      const { system } = await systemPromptFor(emp, "Your job now: you are the publicist, stocking the story bank: stories this desk could pitch any time, each bigger than the company, with the owner as the expert or the example. Only what the Brain supports.");
      const r = await generateJson<{ stories: { title: string; angle: string }[] }>({ system, prompt: "Write 12 to 18 story ideas, each a headline a reporter would write and one sentence on the angle.", schemaName: "press_story_bank", schema: obj({ stories: arr(obj({ title: str, angle: str })) }), maxTokens: 4000 });
      let n = 0;
      for (const s of r.stories ?? []) {
        if (!s.title?.trim() || existing.some((x) => x.kind === "story" && norm(x.topic) === norm(s.title))) continue;
        db.press.library.create({ organizationId: orgId, kind: "story", topic: s.title.slice(0, 200), text: (s.angle ?? "").slice(0, 600) });
        n++;
      }
      return n;
    }
    const { system } = await systemPromptFor(emp, "Your job now: you are the publicist, building the seasonal calendar for this desk: recurring moments reporters plan around (awareness months, holidays, back to school, Valentine's Day, Women's History Month, Black History Month, Small Business Week, industry conference seasons, award nomination windows, annual issues). For each, the pitch-by date: about 6 to 10 weeks ahead for online and TV (short lead), 3 to 5 months ahead for print, annual issues and awards (long lead). Only real, recurring moments; dates as Mon D, YYYY in the next 12 months.");
    const today = fmtDay(new Date());
    const r = await generateJson<{ moments: { title: string; date: string; pitchBy: string; lead: string; angle: string }[] }>({ system, prompt: `Today is ${today}. List 10 to 16 moments for the next 12 months that fit this desk.`, schemaName: "press_calendar", schema: obj({ moments: arr(obj({ title: str, date: str, pitchBy: str, lead: { type: "string", enum: ["short", "long"] }, angle: str })) }), maxTokens: 4000 });
    let n = 0;
    for (const m of r.moments ?? []) {
      if (!m.title?.trim() || !Number.isFinite(Date.parse(m.pitchBy)) || existing.some((x) => x.kind === "moment" && norm(x.topic) === norm(m.title))) continue;
      db.press.library.create({ organizationId: orgId, kind: "moment", topic: m.title.slice(0, 200), text: (m.angle ?? "").slice(0, 600), meta: JSON.stringify({ date: m.date, pitchBy: m.pitchBy, lead: m.lead === "long" ? "long" : "short" }), approved: true });
      n++;
    }
    return n;
  });
}

/** A press kit for a campaign: release, company description, bio, key facts, approved quotes, FAQ, contact. */
export async function makeKit(orgId: number, campaignId: number) {
  const camp = db.press.campaigns.get(campaignId, orgId);
  if (!camp) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't on this desk." });
  const emp = await employeeFor(orgId, "speaking");
  const plan = parse<Plan>(camp.plan, {} as Plan);
  const lib = db.press.library.list(orgId);
  const bio = lib.find((x) => x.kind === "bio" && x.approved && parse<{ length?: string }>(x.meta, {}).length === "100") ?? lib.find((x) => x.kind === "bio" && parse<{ length?: string }>(x.meta, {}).length === "100");
  const quotes = lib.filter((x) => x.kind === "quote" && x.approved);
  const r = await working(emp, async () => {
    const { system } = await systemPromptFor(emp, "Your job now: you are the publicist, writing a campaign press kit. Only facts in the Brain; mark anything the owner must supply as [WHAT'S NEEDED]. Quotes only from the approved list, word for word.");
    return generateJson<{ release: string; company: string; facts: string[]; faq: { q: string; a: string }[] }>({
      system,
      prompt: `Campaign: ${camp.title}\nMain story: ${plan.story}\nProof: ${plan.proof}\nNever say: ${plan.neverSay}\nApproved quotes: ${quotes.map((q) => `"${q.text}"`).join(" ") || "none"}\nWrite the press release (headline, dateline, 300 to 450 words), a short company description (50 words), 5 to 8 key facts, and a 4 to 6 question FAQ.`,
      schemaName: "press_kit",
      schema: obj({ release: str, company: str, facts: arr(str), faq: arr(obj({ q: str, a: str })) }),
      maxTokens: 5000,
    });
  });
  const org = await db.getOrganizationById(orgId);
  const text = `# ${camp.title}: press kit\n\n## Press release\n${r.release}\n\n## About ${org?.name ?? "us"}\n${r.company}\n\n## Founder bio\n${bio?.text ?? "[Founder bio, 100 words]"}\n\n## Key facts\n${(r.facts ?? []).map((f) => `- ${f}`).join("\n")}\n\n## Approved quotes\n${quotes.map((q) => `- "${q.text}"`).join("\n") || "- [Approve a quote in the Quote bank]"}\n\n## FAQ\n${(r.faq ?? []).map((f) => `**${f.q}**\n${f.a}`).join("\n\n")}\n\n## Media contact\n${org?.signerName ?? ""}${org?.signerTitle ? `, ${org.signerTitle}` : ""}`;
  const old = lib.find((x) => x.kind === "kit" && parse<{ campaignId?: number }>(x.meta, {}).campaignId === campaignId);
  if (old) return db.press.library.update(old.id, orgId, { text, approved: false })!;
  return db.press.library.create({ organizationId: orgId, kind: "kit", topic: camp.title.slice(0, 200), text, meta: JSON.stringify({ campaignId }) });
}

export async function kitDocx(orgId: number, id: number) {
  const k = db.press.library.get(id, orgId);
  if (!k || k.kind !== "kit") throw new TRPCError({ code: "NOT_FOUND", message: "That press kit isn't on this desk." });
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const children = k.text.split("\n").filter((l) => l.trim()).map((l) => {
    if (l.startsWith("# ")) return new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(l.slice(2))] });
    if (l.startsWith("## ")) return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(l.slice(3))] });
    if (l.startsWith("- ")) return new Paragraph({ bullet: { level: 0 }, children: [new TextRun(l.slice(2))] });
    if (/^\*\*.+\*\*$/.test(l)) return new Paragraph({ children: [new TextRun({ text: l.replace(/\*\*/g, ""), bold: true })] });
    return new Paragraph({ spacing: { after: 120 }, children: [new TextRun(l)] });
  });
  const doc = new Document({ styles: { default: { document: { run: { font: "Calibri", size: 24 } } } }, sections: [{ children }] });
  const name = `${k.topic} press kit`.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80);
  const saved = await storagePut(`org-${orgId}/downloads/${name}.docx`, await Packer.toBuffer(doc));
  return { url: saved.url, name: `${name}.docx` };
}

/** Six weeks before a moment's pitch-by date, Taylor says so once. */
export async function seasonalAlerts(orgId: number) {
  const soon = db.press.library.list(orgId).filter((x) => {
    if (x.kind !== "moment") return false;
    const m = parse<{ pitchBy?: string; alerted?: boolean }>(x.meta, {});
    const t = Date.parse(m.pitchBy ?? "");
    return !m.alerted && Number.isFinite(t) && t - Date.now() <= 42 * DAY && t > Date.now();
  });
  if (!soon.length) return 0;
  const emp = await employeeFor(orgId, "speaking");
  for (const x of soon) db.press.library.update(x.id, orgId, { meta: JSON.stringify({ ...parse<Record<string, unknown>>(x.meta, {}), alerted: true }) });
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: `Coming up on the press calendar: ${soon.map((x) => `${x.topic} (pitch by ${parse<{ pitchBy?: string }>(x.meta, {}).pitchBy})`).join("; ")}. Press Plan on my Library calendar and I'll build the campaign.`,
  });
  return soon.length;
}
