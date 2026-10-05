import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, searchJson, type JsonSchema } from "../_core/llm";
import type { PrecallReport } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { fmtDay, leadView, parse } from "./cold";
import { employeeFor, systemPromptFor } from "./tasks";

/**
 * The Pre-call report: a skill any employee can run before a meeting with a
 * practice. It runs on its own when a lead books, again two hours before the
 * meeting, and on request from any chat ("run a pre-call report on Bayou
 * Family Therapy").
 *
 * Public business information only, every fact with its source, and
 * anything not confirmed marked Likely or Unknown. After the call it is
 * corrected from Avery's meeting notes (when he sat in) or the owner's own notes.
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown): JsonSchema => ({ type: "array", items } as JsonSchema);
const conf = { type: "string", enum: ["verified", "likely", "unknown"] } as const;

export type Report = {
  brief: { person: string; role: string; practice: string; location: string; size: string; currentSystem: string; currentConfidence: "verified" | "likely" | "unknown"; summary: string };
  profile: { background: string; authority: string; publicInfo: string };
  practice: { locations: string; specialties: string; insurance: string; telehealth: string; services: string; hiring: string };
  tech: { job: string; tool: string; confidence: "verified" | "likely" | "unknown"; evidence: string }[];
  costRange: string;
  journey: { steps: string[]; friction: string };
  growth: { stage: string; evidence: string[]; implication: string };
  pains: { evidence: string; hypothesis: string; question: string }[];
  opportunities: string[];
  demo: { leadWith: string; then: string; dontLeadWith: string; order: string[]; opening: string };
  objections: { objection: string; reason: string; response: string }[];
  questions: string[];
  committee: { name: string; role: string; note: string }[];
  risks: string[];
  sources: { title: string; url: string; date: string }[];
};

const REPORT: JsonSchema = obj({
  brief: obj({ person: str, role: str, practice: str, location: str, size: { type: "string", description: "Clinicians and staff, as found" }, currentSystem: { type: "string", description: "Their EHR, or 'Unknown'" }, currentConfidence: conf, summary: { type: "string", description: "Three sentences: the practice, the opportunity, what to lead with" } }),
  profile: obj({ background: { type: "string", description: "Professional background only (practice bio, credentials, talks)" }, authority: { type: "string", description: "Their likely say in buying software" }, publicInfo: str }),
  practice: obj({ locations: str, specialties: str, insurance: str, telehealth: str, services: str, hiring: str }),
  tech: arr(obj({ job: { type: "string", description: "EHR, phones, consult booking, email marketing, website, forms, telehealth, payments" }, tool: str, confidence: conf, evidence: { type: "string", description: "What on which page shows it" } })),
  costRange: { type: "string", description: "A rough monthly range for the tools found, said as a range, or ''" },
  journey: obj({ steps: arr(str), friction: str }),
  growth: obj({ stage: str, evidence: arr(str), implication: str }),
  pains: arr(obj({ evidence: { type: "string", description: "What you observed" }, hypothesis: str, question: { type: "string", description: "A discovery question tied to the evidence, never confronting them with it" } })),
  opportunities: arr(str),
  demo: obj({ leadWith: str, then: str, dontLeadWith: str, order: arr(str), opening: { type: "string", description: "A 30-second opening the owner can say" } }),
  objections: arr(obj({ objection: str, reason: str, response: str })),
  questions: arr(str),
  committee: arr(obj({ name: str, role: str, note: str })),
  risks: arr(str),
  sources: arr(obj({ title: str, url: str, date: { type: "string", description: "The date you read it, Mon D, YYYY" } })),
});

const RULES = `Research rules (strict):
- Use publicly available professional and business information only: the practice website and its pages, Google Business profile, Psychology Today, professional directories and association pages, the person's professional bio, talks and articles.
- Never invent a fact. Separate verified facts from reasonable guesses. Every significant claim needs its source.
- Technology: verified only when the site links straight to the product (a portal or booking link on its domain). Likely when it resembles it. Unknown when there's no evidence. Never say they use a product you only suspect.
- Never collect personal information: no family, home address, personal finances, health, politics, religion or personal social media. Research the person only for their professional role, business and buying context.
- Never impersonate a client or use deception to get information. Never call the practice.
- Reviews are patterns to guide questions, never something to quote back at them.
- Turn what you find into discovery questions, Evidence, Hypothesis, Question, rather than facts to confront them with.
- Prices for their current tools: give a range only, never a number presented as their bill.
- What LeadDash offers comes only from the Brain. Never promise a migration, price or feature the Brain doesn't state.`;

type Input = { leadId?: number | null; person?: string; practice?: string; email?: string; website?: string; meetingAt?: Date | null; runBy: string; employeeKind?: string };

const running = new Set<number>();

/** Starts a report; it runs in the background and posts in chat when ready. */
export async function startPrecall(orgId: number, input: Input) {
  const lead = input.leadId ? db.cold.getLead(input.leadId, orgId) : input.email ? db.cold.leadByEmail(orgId, input.email) : null;
  const person = input.person?.trim() || (lead ? `${lead.firstName} ${lead.lastName}`.trim() : "");
  const practice = input.practice?.trim() || lead?.practice || "";
  if (!person && !practice) throw new TRPCError({ code: "BAD_REQUEST", message: "Say who the meeting is with: a person, a practice, or both." });
  const existing = db.cold.precall.list(orgId).find((r) => (lead && r.leadId === lead.id) || (!lead && r.practice.toLowerCase() === practice.toLowerCase() && r.person.toLowerCase() === person.toLowerCase()));
  const row = existing
    ? db.cold.precall.update(existing.id, orgId, { status: "running", error: null, meetingAt: input.meetingAt ?? existing.meetingAt, runBy: input.runBy })!
    : db.cold.precall.create({ organizationId: orgId, leadId: lead?.id ?? null, person, practice, email: input.email?.trim().toLowerCase() || lead?.email || "", website: input.website?.trim() || lead?.website || "", meetingAt: input.meetingAt ?? lead?.bookedFor ?? null, runBy: input.runBy, status: "running" });
  void runPrecall(orgId, row.id, input.employeeKind ?? "outreach");
  return row;
}

export async function runPrecall(orgId: number, id: number, employeeKind = "outreach", quiet = false) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const r = db.cold.precall.get(id, orgId);
    if (!r) return;
    const lead = r.leadId ? db.cold.getLead(r.leadId, orgId) : null;
    const lv = lead ? leadView(lead) : null;
    const replies = lead ? db.cold.replies.list(orgId).filter((x) => x.leadId === lead.id).slice(0, 5) : [];
    const battles = db.cold.playbook.list(orgId).filter((p) => p.kind === "battle").map((p) => p.title);
    const emp = await employeeFor(orgId, "outreach");
    const { system } = await systemPromptFor(
      emp,
      `Your job now: the Pre-call report for a meeting with a therapy practice. It should be a 2 to 4 minute read, and the top readable in 15 seconds.
${RULES}
- Tie the demo plan to what you found: lead with what fits them, and say what not to lead with (for example claims for a cash-pay practice).
- Likely objections come from what you found, with a response. Battle cards on file: ${battles.join(", ") || "none"}.
- 5 to 10 discovery questions, each tied to something you found.`
    );
    const prompt = `Meeting with: ${r.person || "(person unknown)"}${r.practice ? `, ${r.practice}` : ""}${r.website ? `, website ${r.website}` : ""}${r.email ? `, email ${r.email}` : ""}.
${r.meetingAt ? `Meeting: ${new Date(r.meetingAt).toUTCString()}` : ""}
${lv ? `What's on the lead list: ${lv.license} ${lv.licenseStatus} ${lv.city} ${lv.state}. Fit ${lv.fit ?? "not scored"}: ${lv.fitWhy.map((x) => x.label).join(", ")}. Earlier research: ${lv.signals?.summary ?? "none"}.` : ""}
${replies.length ? `What they wrote to us:\n${replies.map((x) => `- ${x.text.slice(0, 600)}`).join("\n")}` : ""}`;
    const out = await searchJson<Report>({ system, prompt, schemaName: "precall_report", schema: REPORT, maxUses: 15, maxTokens: 12000 });
    const report = cleanReport(out.data, out.sources ?? []);
    db.cold.precall.update(id, orgId, { report: JSON.stringify(report), status: "ready", error: null, refreshedAt: new Date() });
    if (lead) db.cold.updateLead(lead.id, orgId, { depth: "full" });
    if (!quiet) {
      const poster = (await db.getEmployeeByKind(orgId, employeeKind as never)) ?? emp;
      await db.createChatMessage({ organizationId: orgId, employeeId: poster.id, role: "employee", authorName: poster.name, content: `The pre-call report for ${r.person || r.practice} is ready${r.meetingAt ? ` for ${fmtDay(r.meetingAt)}` : ""}. Lead with ${report.demo.leadWith || "what fits them"}.${r.meetingAt ? " I'll refresh it 2 hours before." : ""}`, cards: JSON.stringify([{ type: "precall", id, title: r.person || r.practice }]) });
    }
  } catch (err) {
    db.cold.precall.update(id, orgId, { status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 400) });
  } finally {
    running.delete(id);
  }
}

function host(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Only sources the search really returned are kept; with none, nothing can stay Verified. */
export function cleanReport(r: Report, found: { url: string; title: string }[]): Report {
  const hosts = new Set(found.map((s) => host(s.url)));
  const sources = (r.sources ?? []).filter((s) => hosts.has(host(s.url)));
  const tech = (r.tech ?? []).map((t) => (t.confidence === "verified" && !sources.length ? { ...t, confidence: "likely" as const } : t));
  return {
    ...r,
    brief: { ...r.brief, currentConfidence: r.brief?.currentConfidence === "verified" && !sources.length ? "likely" : (r.brief?.currentConfidence ?? "unknown") },
    tech,
    pains: (r.pains ?? []).slice(0, 6),
    questions: (r.questions ?? []).slice(0, 10),
    sources: sources.length ? sources : found.slice(0, 8).map((s) => ({ title: s.title, url: s.url, date: fmtDay(new Date()) })),
  };
}

/** Two hours before each meeting, the report is read again. */
export async function refreshDue(orgId: number, now = new Date()) {
  for (const r of db.cold.precall.list(orgId)) {
    if (r.status !== "ready" || !r.meetingAt) continue;
    const at = new Date(r.meetingAt).getTime();
    if (at < now.getTime() || at - now.getTime() > 2 * 3600_000) continue;
    if (r.refreshedAt && at - new Date(r.refreshedAt).getTime() <= 2.5 * 3600_000) continue;
    await runPrecall(orgId, r.id, "outreach", true);
  }
}

// ==========================================
// After the call
// ==========================================

type After = { changes: { what: string; before: string; after: string }[]; nextStep: string; notesFrom: string };

/** Avery's notes from the meeting, when he sat in on it. */
async function simoneNotes(orgId: number, r: PrecallReport) {
  if (!r.email) return null;
  const list = await db.listNotetaker(orgId);
  const near = list.filter((m) => m.status === "ready" && (m.transcript || m.summary) && parse<{ email?: string }[]>(m.attendees, []).some((a) => (a.email ?? "").toLowerCase() === r.email.toLowerCase()));
  const pick = near.sort((a, b) => Math.abs(a.startsAt.getTime() - (r.meetingAt ? new Date(r.meetingAt).getTime() : Date.now())) - Math.abs(b.startsAt.getTime() - (r.meetingAt ? new Date(r.meetingAt).getTime() : Date.now())))[0];
  if (!pick) return null;
  const sum = parse<{ summary?: string; decisions?: string[] }>(pick.summary, {});
  return `${sum.summary ?? ""}\n${(sum.decisions ?? []).join("\n")}\n${(pick.transcript ?? "").slice(0, 30_000)}`;
}

export async function afterCall(orgId: number, id: number, notes: string) {
  const r = db.cold.precall.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That report isn't here." });
  const fromSimone = notes.trim() ? null : await simoneNotes(orgId, r);
  const text = notes.trim() || fromSimone;
  if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "Avery didn't sit in on this one. Type what you learned on the call." });
  const emp = await employeeFor(orgId, "outreach");
  const { system } = await systemPromptFor(emp, "Your job now: compare the pre-call report with what was learned on the call. List only what the call confirmed or corrected (size, systems, problems, decision makers, timing), the next step with a date if one was agreed, and nothing that wasn't said.");
  const out = await generateJson<Omit<After, "notesFrom">>({
    system,
    prompt: `PRE-CALL REPORT:\n${r.report.slice(0, 20_000)}\n\nFROM THE CALL:\n${text.slice(0, 30_000)}`,
    schemaName: "precall_after",
    schema: obj({ changes: arr(obj({ what: str, before: str, after: str })), nextStep: str }),
    maxTokens: 2000,
  });
  const after: After = { changes: (out.changes ?? []).slice(0, 12), nextStep: out.nextStep ?? "", notesFrom: fromSimone ? "Avery's meeting notes" : "Your notes" };
  return db.cold.precall.update(id, orgId, { after: JSON.stringify(after) })!;
}

/** The call's corrections are saved to the lead, for the next report and the weekly review. */
export function approveAfter(orgId: number, id: number) {
  const r = db.cold.precall.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That report isn't here." });
  const after = parse<After | null>(r.after, null);
  if (!after) throw new TRPCError({ code: "BAD_REQUEST", message: "Add what you learned on the call first." });
  if (r.leadId) {
    const l = db.cold.getLead(r.leadId, orgId);
    if (l) db.cold.updateLead(l.id, orgId, { research: JSON.stringify({ ...parse<Record<string, unknown>>(l.research, {}), afterCall: { at: new Date().toISOString(), ...after } }) });
  }
  return db.cold.precall.update(id, orgId, { status: "done" })!;
}

export function saveAfter(orgId: number, id: number, after: After) {
  if (!db.cold.precall.get(id, orgId)) throw new TRPCError({ code: "NOT_FOUND", message: "That report isn't here." });
  return db.cold.precall.update(id, orgId, { after: JSON.stringify({ ...after, changes: after.changes.slice(0, 20) }) })!;
}

export function removePrecall(orgId: number, id: number) {
  db.cold.precall.remove(id, orgId);
}

// ==========================================
// Views and download
// ==========================================

const EMPTY: Report = {
  brief: { person: "", role: "", practice: "", location: "", size: "", currentSystem: "", currentConfidence: "unknown", summary: "" },
  profile: { background: "", authority: "", publicInfo: "" },
  practice: { locations: "", specialties: "", insurance: "", telehealth: "", services: "", hiring: "" },
  tech: [],
  costRange: "",
  journey: { steps: [], friction: "" },
  growth: { stage: "", evidence: [], implication: "" },
  pains: [],
  opportunities: [],
  demo: { leadWith: "", then: "", dontLeadWith: "", order: [], opening: "" },
  objections: [],
  questions: [],
  committee: [],
  risks: [],
  sources: [],
};

export function precallView(orgId: number, r: PrecallReport) {
  const report = { ...EMPTY, ...parse<Partial<Report>>(r.report, {}) } as Report;
  const ehr = (report.tech.find((t) => /ehr/i.test(t.job))?.tool || report.brief.currentSystem || "").toLowerCase();
  const battle = ehr ? db.cold.playbook.list(orgId).find((p) => p.kind === "battle" && ehr.includes(p.title.toLowerCase())) : null;
  const lead = r.leadId ? db.cold.getLead(r.leadId, orgId) : null;
  return {
    id: r.id,
    person: r.person,
    practice: r.practice,
    email: r.email,
    website: r.website,
    meetingAt: r.meetingAt,
    runBy: r.runBy,
    status: r.status,
    error: r.error,
    refreshedAt: r.refreshedAt,
    createdAt: r.createdAt,
    fit: lead?.fit ?? null,
    report,
    battle: battle ? { title: battle.title, body: parse<Record<string, string>>(battle.body, {}) } : null,
    after: parse<After | null>(r.after, null),
  };
}

export function precallsView(orgId: number) {
  return db.cold.precall.list(orgId).sort((a, b) => (a.meetingAt && b.meetingAt ? new Date(a.meetingAt).getTime() - new Date(b.meetingAt).getTime() : b.id - a.id)).map((r) => precallView(orgId, r));
}

export async function precallDocx(orgId: number, id: number) {
  const r = db.cold.precall.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That report isn't here." });
  const v = precallView(orgId, r);
  const rep = v.report;
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const p = (t: string) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun(t)] });
  const kv = (k: string, t: string) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `${k}: `, bold: true }), new TextRun(t)] });
  const h = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
  const li = (t: string) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(t)] });
  const label = (c: string) => (c === "verified" ? "Verified" : c === "likely" ? "Likely" : "Unknown");
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(`Pre-call report: ${v.person || v.practice}`)] }),
    p(`${v.practice}${v.meetingAt ? ` · ${fmtDay(v.meetingAt)}` : ""}`),
    h("30-second brief"),
    kv("Prospect", `${rep.brief.person}${rep.brief.role ? `, ${rep.brief.role}` : ""}`),
    kv("Practice", `${rep.brief.practice}${rep.brief.location ? `, ${rep.brief.location}` : ""}${rep.brief.size ? `. ${rep.brief.size}` : ""}`),
    kv("Current system", `${rep.brief.currentSystem || "Unknown"} (${label(rep.brief.currentConfidence)})`),
    ...(v.fit != null ? [kv("Fit", `${v.fit} of 100`)] : []),
    p(rep.brief.summary),
    h("Prospect"),
    p(rep.profile.background),
    kv("Decision authority", rep.profile.authority),
    h("Practice"),
    kv("Locations", rep.practice.locations),
    kv("Specialties", rep.practice.specialties),
    kv("Insurance", rep.practice.insurance),
    kv("Telehealth", rep.practice.telehealth),
    kv("Hiring", rep.practice.hiring),
    h("Technology"),
    ...rep.tech.map((t) => li(`${t.job}: ${t.tool} (${label(t.confidence)}). ${t.evidence}`)),
    ...(rep.costRange ? [p(`Rough cost of these tools: ${rep.costRange}. A range, not their bill.`)] : []),
    h("How a new client gets in"),
    ...rep.journey.steps.map(li),
    kv("Friction", rep.journey.friction),
    h("Growth"),
    kv(rep.growth.stage || "Stage", `${rep.growth.evidence.join("; ")}. ${rep.growth.implication}`),
    h("Pain points"),
    ...rep.pains.flatMap((x) => [kv("Evidence", x.evidence), kv("Hypothesis", x.hypothesis), kv("Ask", x.question)]),
    h("Demo plan"),
    kv("Lead with", rep.demo.leadWith),
    kv("Then", rep.demo.then),
    kv("Don't lead with", rep.demo.dontLeadWith),
    ...rep.demo.order.map(li),
    kv("Opening", rep.demo.opening),
    h("Likely objections"),
    ...rep.objections.map((o) => li(`${o.objection}: ${o.reason} ${o.response}`)),
    h("Discovery questions"),
    ...rep.questions.map(li),
    h("Who decides"),
    ...rep.committee.map((c) => li(`${c.name}: ${c.role}. ${c.note}`)),
    ...(rep.risks.length ? [h("Risks"), ...rep.risks.map(li)] : []),
    h("Sources"),
    ...rep.sources.map((s) => li(`${s.title}: ${s.url} (${s.date})`)),
  ];
  const doc = new Document({ styles: { default: { document: { run: { font: "Calibri", size: 22 } } } }, sections: [{ children }] });
  const name = `Pre-call report ${v.person || v.practice}`.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80);
  const saved = await storagePut(`org-${orgId}/downloads/${name}.docx`, await Packer.toBuffer(doc));
  return { url: saved.url, name: `${name}.docx` };
}
