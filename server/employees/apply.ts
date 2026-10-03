import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, Application, Opportunity, OppKind } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { generateJson, searchJson, type JsonSchema } from "../_core/llm";
import { storagePut } from "../storage";
import { download, fetchWebpage, htmlToText, packageLinks } from "./files";
import { readFile, unsupportedNote, chunkText } from "./docs";
import { findPassages, formatPassages, indexKnowledge } from "./kb";
import { employeeFor, systemPromptFor, working, actor, withRealSource } from "./tasks";
import { googleSearch } from "../_core/google";
import { notify } from "../notify";

/**
 * The applying engine: one workflow for every employee that applies for
 * things. Morgan applies for grants, pitch competitions and accelerators;
 * Taylor applies to speak. The steps are the same:
 *
 *   find -> score Apply or Skip -> download the host's package and read it in
 *   full -> write the application to the host's own questions -> reviewer
 *   check -> the person taps Submit -> track the result.
 */

// ==========================================
// Shapes stored as JSON
// ==========================================

export type Requirements = {
  due: string;
  questions: { text: string; limit: string; maxWords: number }[];
  narrativeLimit: string;
  format: string;
  scoring: { name: string; points: number }[];
  attachments: { name: string; required: boolean; needsSignature: boolean }[];
  eligibility: string;
  aiPolicy: { restricted: boolean; note: string; citation: string };
  channel: "form" | "email" | "grants_gov" | "submittable" | "sessionize" | "portal";
  channelDetail: string;
  submitWhat: string;
  eventDate: string;
  decisionDate: string;
  questionsDue?: string;
  questionsTo?: string;
  contact?: Contact;
  terms?: { label: string; value: string }[];
  videoRequired: boolean;
  videoLimit: string;
  deckLimit: string;
  pages: Record<string, string>;
};

export type Contact = { name: string; title: string; phone: string; email: string };

/** Keeps whatever contact details either source found. */
export function mergeContact(a?: Partial<Contact> | null, b?: Partial<Contact> | null): Contact {
  return { name: a?.name || b?.name || "", title: a?.title || b?.title || "", phone: a?.phone || b?.phone || "", email: a?.email || b?.email || "" };
}

/** The chat card for an opportunity: the facts on the card, the full details one tap away. */
export function oppCardFor(o: Opportunity) {
  const reqs = parse<Partial<Requirements>>(o.requirements, {});
  const c = reqs.contact;
  const who = c && (c.name || c.email || c.phone) ? `Contact: ${[c.name, c.title].filter(Boolean).join(", ")}${c.phone ? ` · ${c.phone}` : ""}${c.email ? ` · ${c.email}` : ""}`.replace("Contact:  · ", "Contact: ") : "";
  return {
    type: "opportunity" as const,
    id: o.id,
    title: o.title,
    subtitle: [o.host, o.amount, `Due ${o.deadline || reqs.due || "not posted"}`].filter(Boolean).join(" · "),
    body: [o.fitReason ?? o.summary ?? "", who].filter(Boolean).join("\n"),
    url: o.sourceUrl,
    call: o.fitCall,
    score: o.fitScore,
  };
}

export type Question = {
  id: string;
  text: string;
  limit: string;
  maxWords: number;
  answer: string;
  outline: string[];
  facts: { text: string; source: string }[];
  sources: string[];
  status: "empty" | "writing" | "done" | "yours";
};

export type Attachment = {
  name: string;
  source: "brain" | "made" | "missing" | "upload" | "host_form";
  required: boolean;
  needsSignature: boolean;
  fileUrl: string | null;
  knowledgeId: number | null;
  content: string | null;
};

export type Extras = {
  deck?: { title: string; bullets: string[] }[];
  videoScript?: string;
  videoUrl?: string | null;
  videoName?: string | null;
  financials?: string;
};

export type Review = {
  score: number;
  total: number;
  criteria: { name: string; points: number; max: number; note: string }[];
  fixes: { id: string; text: string; kind: "question" | "attachment" | "length" | "placeholder" | "video" | "other"; questionId: string; done: boolean }[];
  passed: string[];
  checkedAt: string;
};

export type Award = {
  amount: string;
  period: string;
  restrictions: string;
  letterUrl: string | null;
  spent: number;
  total: number;
  reports: { name: string; due: string; status: "not_due" | "drafting" | "ready" | "sent"; draft: string }[];
};

export const parse = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const PLACEHOLDER = /\[[A-Z0-9][A-Z0-9 ,'&/()-]{2,60}\]/g;

// ==========================================
// Which employee applies for what
// ==========================================

export const KINDS_FOR: Record<string, OppKind[]> = {
  grants: ["grant", "pitch", "accelerator", "bid"],
  speaking: ["speaking", "media"],
};

export function employeeKindFor(kind: OppKind) {
  return kind === "speaking" || kind === "media" ? "speaking" : "grants";
}

const KIND_WORDS: Record<OppKind, { thing: string; host: string; amount: string }> = {
  grant: { thing: "grant", host: "funder", amount: "award range" },
  pitch: { thing: "pitch competition", host: "host", amount: "prize" },
  accelerator: { thing: "accelerator program", host: "program", amount: "investment or stipend" },
  speaking: { thing: "speaking opportunity", host: "organizer", amount: "pay or honorarium" },
  bid: { thing: "bid", host: "agency", amount: "contract value" },
  media: { thing: "media opportunity", host: "outlet", amount: "audience" },
};

const DEFAULT_QUESTIONS: Record<OppKind, string[]> = {
  grant: [
    "Describe your organization and the community you serve.",
    "What problem will this funding address, and how do you know it exists?",
    "Describe the program, who will run it, and the timeline.",
    "How will you measure success?",
    "Budget summary and how the funds will be used.",
  ],
  pitch: [
    "What problem are you solving, and for whom?",
    "What is your solution?",
    "What traction do you have?",
    "How big is the market?",
    "What is your business model?",
    "Who are your competitors, and how are you different?",
    "Why is your team the one to build this?",
    "How would you use the prize?",
  ],
  accelerator: [
    "Describe your company in one or two sentences.",
    "What problem do you solve, and how?",
    "What traction do you have?",
    "Why this program, and why now?",
    "Tell us about your team.",
    "What do you want to accomplish during the program?",
  ],
  speaking: ["Session title", "Session description", "Three learning objectives", "Speaker bio", "Audience level and format"],
  media: ["Subject line", "The story angle and why it matters now", "Why this expert is the right source", "Two or three talking points", "Short bio and contact"],
  bid: [
    "Company overview and relevant experience",
    "Understanding of the scope of work",
    "Technical approach: how each requirement is met",
    "Implementation plan and timeline",
    "Staffing and key personnel",
    "References from similar work",
    "Pricing",
  ],
};

// ==========================================
// Small helpers
// ==========================================

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown): JsonSchema => ({ type: "array", items });

function hostOf(url: string | null | undefined) {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function postToChat(emp: AIEmployee, content: string, cards: unknown[] = []) {
  return db.createChatMessage({
    organizationId: emp.organizationId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content,
    cards: cards.length ? JSON.stringify(cards) : null,
  });
}

// One application is written at a time, so the server's memory and AI use stay flat.
let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();
export function enqueue(key: string, job: () => Promise<unknown>) {
  if (queued.has(key)) return false;
  queued.add(key);
  chain = chain
    .then(job)
    .catch((err) => console.error(`[apply] ${key} failed:`, err instanceof Error ? err.message : err))
    .finally(() => queued.delete(key));
  return true;
}
/** For tests: wait until queued work is done. */
export function idle() {
  return chain;
}

// ==========================================
// Finding opportunities
// ==========================================

type Found = {
  foundOn?: string;
  title: string;
  host: string;
  deadline: string;
  amount: string;
  equity: string;
  stage: string;
  eligibility: string;
  location: string;
  eventDate: string;
  audience: string;
  angle: string;
  summary: string;
  sourceUrl: string;
  fitScore: number;
  fitCall: "apply" | "partner" | "skip";
  fitReason: string;
  status: "open" | "forecast" | "closed" | "unclear";
  howToSubmit: string;
  contact: Contact;
};

const CONTACT_SCHEMA = obj({
  name: { type: "string", description: "The contact person or office named for this opportunity, or ''" },
  title: { type: "string", description: "Their title or office, or ''" },
  phone: { type: "string", description: "Phone number as posted, or ''" },
  email: { type: "string", description: "Email address as posted, or ''" },
});

const FOUND_SCHEMA = obj({
  items: arr(
    obj({
      title: str,
      host: { type: "string", description: "Funder, competition host, program or event organizer" },
      deadline: { type: "string", description: "Exact date as Mon D, YYYY, or 'Rolling'" },
      amount: { type: "string", description: "Award range, prize, investment, or what the slot pays" },
      equity: { type: "string", description: "Equity taken, 'No equity', or '' when not relevant" },
      stage: { type: "string", description: "Company stage required, or ''" },
      eligibility: { type: "string", description: "Who can apply, from the host's page" },
      location: str,
      eventDate: { type: "string", description: "Pitch day, program start or event date, or ''" },
      audience: { type: "string", description: "Speaking: who attends. Otherwise ''" },
      angle: { type: "string", description: "Speaking: the session to pitch, in one sentence. Otherwise ''" },
      summary: { type: "string", description: "One sentence on what it funds or offers" },
      sourceUrl: { type: "string", description: "The host's page for this opportunity" },
      foundOn: { type: "string", description: "If you found it listed on another page (a roundup, directory or search result), that page's URL; otherwise ''" },
      fitScore: { type: "integer", description: "0 to 100" },
      fitCall: { type: "string", enum: ["apply", "partner", "skip"] },
      fitReason: { type: "string", description: "One or two sentences: why it fits or why skip. Never tell the person to call, visit, check or confirm anything" },
      status: { type: "string", enum: ["open", "forecast", "closed", "unclear"], description: "open: taking responses now or rolling. forecast: posted with a future open date. closed: deadline passed. unclear: no current window posted" },
      howToSubmit: { type: "string", description: "How responses go in (portal name, email address, mail), or ''" },
      contact: CONTACT_SCHEMA,
    })
  ),
});

/** "Nov 14, 2026" in the past means it closed. Unreadable dates are kept. */
function isPast(date: string, now = new Date()) {
  if (!date || /rolling|continuous|open until/i.test(date)) return false;
  const t = Date.parse(date.replace(/\bat\b.*$/i, "").replace(/(\d)(st|nd|rd|th)\b/g, "$1"));
  if (Number.isNaN(t)) return false;
  return t < now.getTime() - 86_400_000;
}

const FIND_JOB: Record<OppKind, string> = {
  grant: `Your job: find grants and funding RFPs that are open now, from every kind of funder, not only federal listings.
- Search widely, one angle per search, and use the words funders use: grant, RFP, RFA, NOFO, request for applications, funding opportunity, call for proposals.
- Angles to cover: the workspace's state agencies (health, mental health and substance use, Medicaid, workforce, commerce) and the state's procurement or bid portal; counties and cities where the workspace operates; the state's community foundations and health foundations; national private foundations; hospital systems, health plans and corporate giving programs; universities and research partners looking for community partners; and federal programs (the Grants.gov list below is only one source).
- Read the legal entity in the Brain. Most foundation grants fund 501(c)(3) nonprofits only. For a for-profit, mark a nonprofit-only grant "partner" if it allows a nonprofit lead applicant with the business as a partner or contractor, otherwise "skip". Government contracts, state RFPs and small-business programs often accept for-profits.
- SAM.gov registration only matters for federal awards; never skip a state, local or foundation opportunity because of it.
- Leave out anything whose deadline has passed. Prefer funders in the workspace's state, then national programs.`,
  pitch: `Your job: find startup pitch competitions taking applications now that fit this company.
- Search widely, one angle per search: the company's state and city (state innovation agencies, universities, chambers, startup weeks), its region, its sector (health tech, software, SaaS), founder-focused competitions (women founders, Black founders, veteran founders) when the Brain says the founder qualifies, corporate and bank-sponsored competitions, and national virtual competitions.
- Rolling or monthly competitions count. Include ones whose application opens soon if the date is posted.
- Note the prize, whether equity is taken, the company stage required, the region, the entry fee, and pitch day.
- Leave out competitions whose deadline has passed or whose stage or region rules exclude the company.`,
  accelerator: `Your job: find accelerator and incubator programs taking applications now that fit this company.
- Search widely, one angle per search: the company's state and region, its sector (health tech, software, SaaS), founder-focused programs when the Brain says the founder qualifies, corporate programs, and remote national programs.
- Rolling admissions count.
- Note investment or stipend, equity taken, stage required, location, and program dates.
- Leave out programs whose deadline has passed or that exclude the company's stage, sector or region.`,
  bid: `Your job: find government and agency bids (RFPs, RFQs, invitations to bid) open now that the company in the Brain can respond to.
- Search widely, one angle per search: the state's procurement portal, counties and cities where the company works, school districts, universities, tribal health systems, state health and behavioral health agencies, and federal notices that fit.
- Keep only bids for what the company actually provides. Note the due date, how responses are submitted, and the deadline for questions.
- Leave out bids whose due date has passed.`,
  media: `Your job: find media opportunities open now where the expert in the Brain can be quoted, interviewed or published. You are the publicist.
- Search widely, one angle per search: journalist source requests (Qwoted, Featured, Help a B2B Writer, SourceBottle, #journorequest), podcasts in the expert's field that book guests and say how to pitch, reporters and newsletters that covered the expert's topics in the last 90 days, publications that accept contributed articles or op-eds, and local TV and radio segments in the expert's state.
- Keep only what fits the expert's topics and credentials in the Brain. A request with a deadline that has passed is out.
- Note the outlet, the reporter or host by name when public, the deadline, how to pitch (form, email, platform), the audience size or reach when stated, and the angle this expert should take.
- Prefer outlets the expert's buyers and clients read, then national outlets in the field, then general media.`,
  speaking: `Your job: find conferences, summits and events taking speaker proposals now that fit the speaker in the Brain.
- Only events with an open call for proposals, speaker application, or a booking contact. Leave out events whose proposal deadline has passed.
- Note what the slot pays, the audience, location and event date, and the session this speaker should pitch.`,
};

/** "Apply" needs a score of 60 or more, so the label and the number always agree. */
function callFor(call: string, score: number): "apply" | "partner" | "skip" {
  if (call === "skip" || call === "partner") return call;
  return Math.round(score || 0) >= 60 ? "apply" : "skip";
}

/** Federal listings from the Grants.gov search API (no key needed). Failures are ignored. */
async function grantsGovListings(keyword: string) {
  if (process.env.NODE_ENV === "test") return [];
  try {
    const res = await fetch("https://api.grants.gov/v1/api/search2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword, oppStatuses: "forecasted|posted", rows: 12 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const hits: any[] = data?.data?.oppHits ?? data?.data?.hits ?? [];
    return hits.slice(0, 12).map((h) => ({
      title: String(h.title ?? ""),
      agency: String(h.agency ?? h.agencyName ?? h.agencyCode ?? ""),
      number: String(h.number ?? ""),
      closeDate: String(h.closeDate ?? ""),
      status: String(h.oppStatus ?? ""),
      url: `https://www.grants.gov/search-results-detail/${h.id}`,
    }));
  } catch {
    return [];
  }
}

/** The Google searches that widen each kind of opportunity search. */
export function googleQueries(kind: OppKind, state: string, focus?: string) {
  const y = new Date().getFullYear();
  const st = state.trim();
  const f = (focus ?? "").trim();
  const base: Record<OppKind, string[]> = {
    pitch: [`startup pitch competition ${y} ${y + 1} applications open`, `health tech pitch competition ${y + 1}`, `pitch competition for women founders ${y + 1}`, `pitch competition for Black founders ${y + 1}`, `virtual pitch competition startups apply ${y}`, st && `${st} startup pitch competition ${y}`, `SaaS startup pitch competition prize ${y + 1}`, `university business plan competition open to all founders ${y + 1}`],
    grant: [`small business grant ${y} ${y + 1} apply`, `behavioral health grant RFP ${y}`, `mental health funding opportunity ${y}`, st && `${st} small business grant ${y}`, st && `${st} mental health grant RFP ${y}`, `grants for women owned business ${y + 1}`],
    accelerator: [`startup accelerator applications open ${y + 1}`, `health tech accelerator ${y + 1} applications`, `accelerator for women founders ${y + 1}`, st && `${st} startup accelerator ${y}`, `remote accelerator program SaaS ${y + 1}`],
    bid: [st && `${st} RFP behavioral health ${y}`, st && `${st} bid electronic health record ${y}`, `RFP practice management software behavioral health ${y}`, `county RFP mental health services ${y}`],
    speaking: [`call for speakers ${y + 1} mental health conference`, `call for proposals ${y + 1} workplace wellbeing conference`, `HR conference call for speakers ${y + 1}`, `counseling conference call for proposals ${y + 1}`, st && `${st} conference call for speakers ${y + 1}`],
    media: [`podcast guest mental health workplace`, `journalist request therapist expert`, `op-ed submission guidelines mental health`, `podcast seeking guests entrepreneurs ${y}`],
  };
  const list = (base[kind] ?? []).filter(Boolean) as string[];
  return f ? [f + ` ${kind === "speaking" ? "call for speakers" : kind === "media" ? "media" : kind} ${y}`, ...list].slice(0, 9) : list;
}

export async function findOpportunities(orgId: number, empKind: "grants" | "speaking", opts: { kind?: OppKind; focus?: string } = {}) {
  const emp = await employeeFor(orgId, empKind);
  const kind: OppKind = opts.kind && KINDS_FOR[empKind].includes(opts.kind) ? opts.kind : KINDS_FOR[empKind][0];
  return working(emp, async () => {
    const { system, brain } = await systemPromptFor(
      emp,
      `${FIND_JOB[kind]}
- Score each one 0 to 100 for fit (eligibility first, then fit with the workspace's work, award size compared to effort, competition, time left). Mark it "apply" only when the score is 60 or higher. Below 60, mark it "skip", or "partner" when a partner could lead. Say why in one or two sentences.
- A request for "this quarter" or "this month" means deadlines in that window; still include rolling ones.
- Return up to 20, best fit first. Include lower scores too so the person sees what is out there. If you find fewer real ones, return fewer.
- Roundup and directory pages ("pitch competitions in 2026", "grants for women founders") are good leads: open them, then return each listed opportunity that is still open, with its own page as sourceUrl and the roundup as foundOn.
- Only return ones taking responses now, rolling, or posted with a future open date. If you cannot find a current window, mark it "unclear"; it will be left out.
- Record everything the person needs so they never have to open the site: the contact person, phone and email, how responses are submitted, the value or rates. Never tell the person to call, visit, check or confirm anything; if a fact is not posted, leave it "".`
    );
    const federal =
      kind === "grant" ? await grantsGovListings(opts.focus || brain.org?.focusAreas?.split(/[,;\n]/)[0] || brain.org?.description?.slice(0, 60) || "behavioral health") : [];
    const prompt = `Find open ${KIND_WORDS[kind].thing}s for ${brain.org?.name ?? "this workspace"}.${opts.focus ? `\nFocus on: ${opts.focus}` : ""}${
      federal.length
        ? `\n\nOpen federal listings from Grants.gov to check (include any that fit, with this URL as the source):\n${federal.map((f) => `- ${f.title} (${f.agency}, ${f.number}, closes ${f.closeDate || "not listed"}): ${f.url}`).join("\n")}`
        : ""
    }`;
    // Google results widen the net; the employee checks each one.
    const google = await googleSearch(googleQueries(kind, brain.org?.state ?? "", opts.focus));
    const googleList = google.length
      ? `\n\nGoogle results to check (open the promising ones, keep only real opportunities that are open now; use the result's URL as sourceUrl or foundOn):\n${google.slice(0, 60).map((g) => `- ${g.title}: ${g.url}${g.snippet ? ` (${g.snippet})` : ""}`).join("\n")}`
      : "";
    const result = await searchJson<{ items: Found[] }>({ system, prompt: prompt + googleList, schemaName: "opportunities", schema: FOUND_SCHEMA, maxUses: Math.max(ENV.searchMaxUses, 15), maxTokens: 16000 });
    const sources = [...result.sources, ...federal.map((f) => ({ url: f.url, title: f.title })), ...google.map((g) => ({ url: g.url, title: g.title }))];
    const existing = await db.listOpps(orgId);
    const created: Opportunity[] = [];
    for (const f of withRealSource(result.data.items, sources)) {
      if (!f.title || !f.host) continue;
      if (f.status === "closed" || f.status === "unclear" || isPast(f.deadline)) continue;
      if (existing.some((o) => norm(o.title) === norm(f.title) && norm(o.host) === norm(f.host))) continue;
      created.push(
        await db.createOpp({
          organizationId: orgId,
          employeeId: emp.id,
          kind,
          title: f.title.slice(0, 255),
          host: f.host.slice(0, 255),
          sourceUrl: f.sourceUrl,
          source: hostOf(f.sourceUrl),
          deadline: f.deadline || null,
          amount: f.amount || null,
          equity: f.equity || null,
          stage: f.stage || null,
          eligibility: f.eligibility || null,
          location: f.location || null,
          eventDate: f.eventDate || null,
          audience: f.audience || null,
          angle: f.angle || null,
          summary: f.summary || null,
          fitScore: Math.max(0, Math.min(100, Math.round(f.fitScore || 0))),
          fitCall: callFor(f.fitCall, f.fitScore),
          fitReason: f.fitReason || null,
          searchQueries: JSON.stringify(result.queries),
          requirements: JSON.stringify({ contact: mergeContact(f.contact), channelDetail: f.howToSubmit || "" }),
          packageStatus: f.sourceUrl ? "fetching" : "none",
        })
      );
    }
    // Download each one's documents and read what it requires, so every detail is on the row.
    for (const o of created) if (o.sourceUrl) enqueue(`package-${o.id}`, () => fetchPackage(orgId, o.id));
    await db.logAction({
      organizationId: orgId,
      actorType: "employee",
      actorName: actor(emp),
      action: `Searched for ${KIND_WORDS[kind].thing}s`,
      details: `Ran ${result.queries.length} searches and added ${created.length} new.`,
    });
    return { created, queries: result.queries, kind };
  });
}

/** Adds an opportunity the person found: from its page link or the RFP file. */
export async function addOpportunity(
  orgId: number,
  empKind: "grants" | "speaking",
  input: { url?: string; file?: { name: string; buf: Buffer; mime: string } },
  personName: string
) {
  const emp = await employeeFor(orgId, empKind);
  let text = "";
  let sourceUrl: string | null = null;
  if (input.url) {
    const url = /^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
    try {
      const page = await fetchWebpage(url);
      text = page.text;
      sourceUrl = page.url;
    } catch (err) {
      // A direct link to a PDF is not a web page: read it as a file.
      const d = await download(url).catch(() => null);
      if (!d) throw err;
      text = (await readFile(d.buf, d.fileName, d.contentType)).text;
      sourceUrl = d.url;
    }
  } else if (input.file) {
    text = (await readFile(input.file.buf, input.file.name, input.file.mime)).text;
  }
  if (text.trim().length < 40) throw new TRPCError({ code: "BAD_REQUEST", message: "That page or file had no readable text." });

  const { system } = await systemPromptFor(
    emp,
    `Your job now: read the opportunity below (a host's page or RFP) and fill in its details. Then score the fit 0 to 100 and mark it "apply", "partner" or "skip", using the legal entity in the Brain for eligibility.
Use only what the text says; use "" for anything it does not state.`
  );
  const kinds = KINDS_FOR[empKind];
  const details = await generateJson<Found & { kind: OppKind }>({
    system,
    prompt: `${text.slice(0, 60_000)}`,
    schemaName: "opportunity_details",
    schema: obj({ ...((FOUND_SCHEMA.properties as any).items.items.properties as object), kind: { type: "string", enum: kinds } }),
    timeoutMs: 180_000,
  });
  const opp = await db.createOpp({
    organizationId: orgId,
    employeeId: emp.id,
    kind: kinds.includes(details.kind) ? details.kind : kinds[0],
    title: (details.title || input.file?.name || "Opportunity").slice(0, 255),
    host: (details.host || hostOf(sourceUrl) || "Host not listed").slice(0, 255),
    sourceUrl: sourceUrl ?? (/^https?:\/\//.test(details.sourceUrl) ? details.sourceUrl : null),
    source: hostOf(sourceUrl ?? details.sourceUrl),
    deadline: details.deadline || null,
    amount: details.amount || null,
    equity: details.equity || null,
    stage: details.stage || null,
    eligibility: details.eligibility || null,
    location: details.location || null,
    eventDate: details.eventDate || null,
    audience: details.audience || null,
    angle: details.angle || null,
    summary: details.summary || null,
    fitScore: Math.max(0, Math.min(100, Math.round(details.fitScore || 0))),
    fitCall: callFor(details.fitCall, details.fitScore),
    fitReason: details.fitReason || null,
    requirements: JSON.stringify({ contact: mergeContact(details.contact), channelDetail: details.howToSubmit || "" }),
  });
  if (input.file) {
    const saved = await storagePut(`org-${orgId}/packages/${input.file.name}`, input.file.buf, input.file.mime);
    const read = await readFile(input.file.buf, input.file.name, input.file.mime);
    const f = await db.createOppFile({ organizationId: orgId, opportunityId: opp.id, name: input.file.name, fileUrl: saved.url, pages: read.pages, pagesUnit: read.unit, chars: read.text.length, status: "read", note: read.note });
    db.replaceChunks(orgId, "opp_file", f.id, null, chunkText(read.text));
  }
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: personName, action: `Added ${KIND_WORDS[opp.kind].thing}`, details: opp.title });
  enqueue(`package-${opp.id}`, () => fetchPackage(orgId, opp.id));
  return opp;
}

/**
 * An opportunity found by signing in somewhere (BidPrime): the page text and
 * any documents were read in the browser, so nothing is fetched here first.
 * Scores the fit, saves the documents, then reads the package as usual.
 */
export async function addOpportunityFromText(
  orgId: number,
  empKind: "grants" | "speaking",
  input: { text: string; sourceUrl: string | null; source: string; files: { name: string; buf: Buffer; mime: string; url: string }[]; kind?: OppKind },
  personName: string
) {
  const emp = await employeeFor(orgId, empKind);
  const docs: string[] = [];
  for (const f of input.files.slice(0, 8)) {
    try {
      docs.push(`# ${f.name}\n${(await readFile(f.buf, f.name, f.mime)).text.slice(0, 20_000)}`);
    } catch {
      /* a file that cannot be read is still saved below */
    }
  }
  const text = [input.text, ...docs].join("\n\n");
  if (text.trim().length < 40) throw new TRPCError({ code: "BAD_REQUEST", message: "That bid had no readable text." });
  const { system } = await systemPromptFor(
    emp,
    `Your job now: read the opportunity below and fill in its details. Then score the fit 0 to 100 and mark it "apply", "partner" or "skip", using what the company in the Brain actually provides and its legal entity for eligibility.
Use only what the text says; use "" for anything it does not state.`
  );
  const kinds = KINDS_FOR[empKind];
  const details = await generateJson<Found & { kind: OppKind }>({
    system,
    prompt: text.slice(0, 60_000),
    schemaName: "opportunity_details",
    schema: obj({ ...((FOUND_SCHEMA.properties as any).items.items.properties as object), kind: { type: "string", enum: kinds } }),
    timeoutMs: 180_000,
  });
  const kind = input.kind && kinds.includes(input.kind) ? input.kind : kinds.includes(details.kind) ? details.kind : kinds[0];
  const source = input.sourceUrl ?? (/^https?:\/\//.test(details.sourceUrl) ? details.sourceUrl : null);
  const opp = await db.createOpp({
    organizationId: orgId,
    employeeId: emp.id,
    kind,
    title: (details.title || "Opportunity").slice(0, 255),
    host: (details.host || hostOf(source) || "Host not listed").slice(0, 255),
    sourceUrl: source,
    source: input.source,
    deadline: details.deadline || null,
    amount: details.amount || null,
    equity: details.equity || null,
    stage: details.stage || null,
    eligibility: details.eligibility || null,
    location: details.location || null,
    eventDate: details.eventDate || null,
    audience: details.audience || null,
    angle: details.angle || null,
    summary: details.summary || null,
    fitScore: Math.max(0, Math.min(100, Math.round(details.fitScore || 0))),
    fitCall: callFor(details.fitCall, details.fitScore),
    fitReason: details.fitReason || null,
    requirements: JSON.stringify({ contact: mergeContact(details.contact), channelDetail: details.howToSubmit || "" }),
  });
  for (const f of input.files.slice(0, 8)) {
    try {
      const read = await readFile(f.buf, f.name, f.mime);
      const saved = await storagePut(`org-${orgId}/packages/${f.name}`, f.buf, f.mime);
      const row = await db.createOppFile({ organizationId: orgId, opportunityId: opp.id, name: f.name, sourceUrl: f.url, fileUrl: saved.url, pages: read.pages, pagesUnit: read.unit, chars: read.text.length, status: "read", note: read.note });
      db.replaceChunks(orgId, "opp_file", row.id, null, chunkText(read.text));
    } catch {
      const saved = await storagePut(`org-${orgId}/packages/${f.name}`, f.buf, f.mime);
      await db.createOppFile({ organizationId: orgId, opportunityId: opp.id, name: f.name, sourceUrl: f.url, fileUrl: saved.url, status: "failed", note: "Could not read this file" });
    }
  }
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: personName, action: `Added ${KIND_WORDS[opp.kind].thing}`, details: `${opp.title} (from ${input.source})` });
  enqueue(`package-${opp.id}`, () => fetchPackage(orgId, opp.id));
  return opp;
}

// ==========================================
// The host's package
// ==========================================

const REQ_SCHEMA = obj({
  due: { type: "string", description: "Due date and time as written, e.g. Nov 30, 2026 at 5:00 PM CT, or ''" },
  questions: arr(
    obj({
      text: { type: "string", description: "The question or section exactly as the host words it" },
      limit: { type: "string", description: "Its limit as written (250 words, 2 pages, 1,500 characters), or ''" },
      maxWords: { type: "integer", description: "The limit in words if stated or convertible (1 page = 500 words, 1,000 characters = 160 words), else 0" },
    })
  ),
  narrativeLimit: { type: "string", description: "Total narrative limit, e.g. 10 pages, or ''" },
  format: { type: "string", description: "Font, spacing, margins, file type rules, or ''" },
  scoring: arr(obj({ name: str, points: int })),
  attachments: arr(obj({ name: str, required: bool, needsSignature: bool })),
  eligibility: str,
  aiPolicy: obj({
    restricted: { type: "boolean", description: "True only if the host limits or forbids AI-written applications" },
    note: str,
    citation: { type: "string", description: "Where the rule is stated: page, notice number, or link" },
  }),
  channel: { type: "string", enum: ["form", "email", "grants_gov", "submittable", "sessionize", "portal"] },
  channelDetail: { type: "string", description: "The email address, portal name or form link applications go to, or ''" },
  submitWhat: { type: "string", description: "Everything to submit, as a short list in one line" },
  eventDate: { type: "string", description: "Pitch day, program start or event date, or ''" },
  decisionDate: { type: "string", description: "When decisions are announced, or ''" },
  questionsDue: { type: "string", description: "Deadline for questions to the buyer or host, as written, or ''" },
  questionsTo: { type: "string", description: "Where questions go: the buyer's email address or portal, or ''" },
  contact: CONTACT_SCHEMA,
  terms: arr(
    obj({
      label: { type: "string", description: "Short label: Contract term, Rates, Value, Start, Insurance, Licenses, Location, Reporting" },
      value: { type: "string", description: "What the documents say, in one line" },
    })
  ),
  videoRequired: bool,
  videoLimit: { type: "string", description: "Video length limit, or ''" },
  deckLimit: { type: "string", description: "Pitch deck slide limit, or ''" },
  pages: obj({
    due: { type: "string", description: "Where the due date is stated, e.g. 'RFP page 3', or ''" },
    eligibility: str,
    scoring: str,
    limits: str,
  }),
});

/** Downloads the host's page and every document it links to, reads them in full, and pulls out what they require. */
export async function fetchPackage(orgId: number, oppId: number) {
  const opp = await db.getOpp(oppId, orgId);
  if (!opp) return null;
  const emp = (opp.employeeId && (await db.getEmployeeForOrg(opp.employeeId, orgId))) || (await db.getEmployeeByKind(orgId, employeeKindFor(opp.kind)));
  await db.updateOpp(oppId, orgId, { packageStatus: "fetching", packageNote: null });
  const notes: string[] = [];
  const texts: string[] = [];
  try {
    const keep = await db.listOppFiles(orgId, oppId); // files the person uploaded stay
    for (const f of keep) texts.push(`# ${f.name}\n${db.chunksOf(orgId, "opp_file", f.id).map((c) => c.text).join("\n")}`);

    if (opp.sourceUrl) {
      let page: Awaited<ReturnType<typeof download>> | null = null;
      try {
        page = await download(opp.sourceUrl, 5_000_000);
      } catch (err) {
        notes.push(`The page ${(err as Error).message}.`);
      }
      const isFile = page && !/text\/html|xhtml/.test(page.contentType);
      if (page && isFile) {
        await saveHostFile(orgId, oppId, page.buf, page.fileName, page.contentType, page.url, notes, texts);
      } else if (page) {
        const html = page.buf.toString("utf8");
        texts.unshift(`# The host's page (${page.url})\n${htmlToText(html).slice(0, 40_000)}`);
        const links = packageLinks(html, page.url);
        const files = [...links.files];
        for (const sub of links.pages.slice(0, 3)) {
          try {
            const d = await download(sub.url, 3_000_000);
            if (/text\/html|xhtml/.test(d.contentType)) {
              const subHtml = d.buf.toString("utf8");
              texts.push(`# ${sub.label || "Related page"} (${d.url})\n${htmlToText(subHtml).slice(0, 20_000)}`);
              for (const f of packageLinks(subHtml, d.url).files) if (!files.some((x) => x.url === f.url)) files.push(f);
            } else {
              files.push(sub);
            }
          } catch {
            /* a related page that does not load is skipped */
          }
        }
        for (const f of files.slice(0, 8)) {
          if (keep.some((k) => k.sourceUrl === f.url)) continue;
          const old = unsupportedNote(f.url);
          if (old) {
            notes.push(`${f.label || f.url}: ${old}`);
            continue;
          }
          try {
            const d = await download(f.url);
            await saveHostFile(orgId, oppId, d.buf, f.label && f.label.length > 3 ? withExt(f.label, d.fileName) : d.fileName, d.contentType, d.url, notes, texts);
          } catch (err) {
            notes.push(`${f.label || f.url} ${(err as Error).message}.`);
          }
        }
      }
    }

    const all = texts.join("\n\n");
    if (all.trim().length < 200) {
      await db.updateOpp(oppId, orgId, { packageStatus: "failed", packageNote: notes.join(" ") || "Nothing readable was found on the host's page." });
      return db.getOpp(oppId, orgId);
    }

    const { system } = await systemPromptFor(
      emp!,
      `Your job now: read the host's documents below in full and record exactly what the application requires. Copy questions word for word in the order asked. Record the contact person with phone and email, and the key terms (contract term, rates or value, start requirement, insurance, licenses, location) so the person never has to open the documents. Use only what the documents say; "" or [] where they say nothing.`
    );
    const reqs = await generateJson<Requirements>({
      system,
      prompt: `${KIND_WORDS[opp.kind].thing}: ${opp.title} (${opp.host})\n\n${all.slice(0, 320_000)}`,
      schemaName: "requirements",
      schema: REQ_SCHEMA,
      maxTokens: 8000,
      timeoutMs: 300_000,
    });

    // Forms that need a signature are flagged on the file list.
    const sigNames = (reqs.attachments ?? []).filter((a) => a.needsSignature).map((a) => norm(a.name)).filter(Boolean);
    if (sigNames.length) {
      for (const f of await db.listOppFiles(orgId, oppId)) {
        const n = norm(f.name.replace(/\.[a-z0-9]{2,5}$/i, ""));
        if (f.status === "read" && sigNames.some((s) => n.includes(s) || s.includes(n))) await db.setOppFileStatus(orgId, f.id, "needs_signature");
      }
    }

    let funderHistory: { history: string; url: string } | null = null;
    if (opp.kind === "grant" && ENV.anthropicKey) {
      funderHistory = await funderHistoryFor(emp!, opp).catch(() => null);
    }

    const before = parse<Partial<Requirements>>(opp.requirements, {});
    reqs.contact = mergeContact(reqs.contact, before.contact);
    if (!reqs.channelDetail && before.channelDetail) reqs.channelDetail = before.channelDetail;
    await db.updateOpp(oppId, orgId, {
      requirements: JSON.stringify(reqs),
      packageStatus: "ready",
      packageNote: notes.length ? notes.join(" ") : null,
      deadline: opp.deadline || reqs.due || null,
      eventDate: opp.eventDate || reqs.eventDate || null,
      ...(funderHistory?.history ? { funderHistory: funderHistory.history, funderHistoryUrl: funderHistory.url || null } : {}),
    });
    return db.getOpp(oppId, orgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateOpp(oppId, orgId, { packageStatus: "failed", packageNote: [message, ...notes].join(" ").slice(0, 1000) });
    return db.getOpp(oppId, orgId);
  }
}

function withExt(label: string, fileName: string) {
  const ext = fileName.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? "";
  const clean = label.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean.toLowerCase().endsWith(ext.toLowerCase()) ? clean : clean + ext;
}

async function saveHostFile(orgId: number, oppId: number, buf: Buffer, name: string, mime: string, url: string, notes: string[], texts: string[]) {
  try {
    const read = await readFile(buf, name, mime);
    const saved = await storagePut(`org-${orgId}/packages/${name}`, buf, mime);
    const f = await db.createOppFile({
      organizationId: orgId,
      opportunityId: oppId,
      name,
      sourceUrl: url,
      fileUrl: saved.url,
      pages: read.pages,
      pagesUnit: read.unit,
      chars: read.text.length,
      status: "read",
      note: read.note,
    });
    db.replaceChunks(orgId, "opp_file", f.id, null, chunkText(read.text));
    texts.push(`# ${name}\n${read.text}`);
  } catch (err) {
    const saved = await storagePut(`org-${orgId}/packages/${name}`, buf, mime).catch(() => null);
    await db.createOppFile({ organizationId: orgId, opportunityId: oppId, name, sourceUrl: url, fileUrl: saved?.url ?? null, status: "failed", note: (err as Error).message.slice(0, 300) });
    notes.push(`${name}: ${(err as Error).message}`);
  }
}

async function funderHistoryFor(emp: AIEmployee, opp: Opportunity) {
  const { system } = await systemPromptFor(
    emp,
    `Your job now: find who this funder has funded recently and typical award sizes, from the funder's own grantee lists, annual reports, or its IRS Form 990 (for example on ProPublica Nonprofit Explorer or Candid). Say in one or two sentences how many awards went to organizations like this workspace and the typical size, and which year. If you cannot find it, return "".`
  );
  const r = await searchJson<{ history: string; url: string }>({
    system,
    prompt: `Funder: ${opp.host}\nGrant: ${opp.title}${opp.sourceUrl ? `\nFunder page: ${opp.sourceUrl}` : ""}`,
    schemaName: "funder_history",
    schema: obj({ history: str, url: { type: "string", description: "The page this came from" } }),
    maxUses: 3,
    maxTokens: 2000,
  });
  const ok = r.data.url && r.sources.some((s) => hostOf(s.url) === hostOf(r.data.url));
  return { history: r.data.history || "", url: ok ? r.data.url : r.sources[0]?.url ?? "" };
}

// ==========================================
// Writing the application
// ==========================================

export async function startApplication(orgId: number, oppId: number, personName: string | null) {
  const opp = await db.getOpp(oppId, orgId);
  if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
  const existing = await db.getApplicationByOpp(oppId, orgId);
  if (existing) return existing;
  const emp = await employeeFor(orgId, employeeKindFor(opp.kind));
  const app = await db.createApplication({
    organizationId: orgId,
    opportunityId: oppId,
    employeeId: emp.id,
    title: opp.title,
    status: "writing",
    progress: "Reading the host's package",
  });
  await db.updateOpp(oppId, orgId, { status: "applying" });
  await db.logAction({
    organizationId: orgId,
    actorType: personName ? "human_user" : "employee",
    actorName: personName ?? actor(emp),
    action: "Started application",
    details: `${opp.title} (${opp.host})`,
  });
  enqueue(`app-${app.id}`, () => writeApplication(orgId, app.id));
  return app;
}

/** Re-runs writing for an application (after an error, or when asked). */
export async function rewriteApplication(orgId: number, appId: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  if (["submitted", "awarded", "declined", "approved"].includes(app.status)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This application has already been approved." });
  }
  await db.updateApplication(appId, orgId, { status: "writing", progress: "Starting over", errorNote: null });
  enqueue(`app-${appId}`, () => writeApplication(orgId, appId, { fresh: true }));
  return db.getApplication(appId, orgId);
}

async function contextFor(orgId: number, app: Application) {
  const opp = (await db.getOpp(app.opportunityId, orgId))!;
  const emp = (app.employeeId && (await db.getEmployeeForOrg(app.employeeId, orgId))) || (await employeeFor(orgId, employeeKindFor(opp.kind)));
  const reqs = parse<Partial<Requirements>>(opp.requirements, {});
  return { opp, emp, reqs };
}

function hostBrief(opp: Opportunity, reqs: Partial<Requirements>) {
  return [
    `${KIND_WORDS[opp.kind].thing}: ${opp.title}`,
    `${KIND_WORDS[opp.kind].host}: ${opp.host}`,
    opp.amount && `${KIND_WORDS[opp.kind].amount}: ${opp.amount}`,
    (reqs.due || opp.deadline) && `Due: ${reqs.due || opp.deadline}`,
    (reqs.eligibility || opp.eligibility) && `Who can apply: ${reqs.eligibility || opp.eligibility}`,
    reqs.scoring?.length && `Scoring: ${reqs.scoring.map((s) => `${s.name} ${s.points}`).join(", ")}`,
    reqs.narrativeLimit && `Narrative limit: ${reqs.narrativeLimit}`,
    reqs.format && `Format: ${reqs.format}`,
    opp.angle && `Session to pitch: ${opp.angle}`,
    opp.audience && `Audience: ${opp.audience}`,
    opp.sourceUrl && `Host page: ${opp.sourceUrl}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const WRITE_JOB: Record<OppKind, string> = {
  grant: "You are writing a grant application.",
  pitch: "You are writing a pitch competition application for the company in the Brain.",
  accelerator: "You are writing an accelerator application for the company in the Brain.",
  speaking: "You are writing a speaker proposal for the speaker in the Brain.",
  media: "You are the publicist writing a media pitch for the expert in the Brain. Lead with the story and why it matters to this outlet's audience now, then why this expert is the right source, then two or three talking points. Under 200 words unless the outlet asks for more. Never promise exclusives or claim past coverage the Brain does not list.",
  bid: "You are writing a response to a government or agency bid (RFP) for the company in the Brain. Answer each section directly and show how each requirement is met. Never claim a capability the Brain does not support: say \"partly met\" and give the roadmap answer instead. Never invent a price; leave [PRICE] for the person to fill.",
};

async function writeQuestion(orgId: number, ctx: Awaited<ReturnType<typeof contextFor>>, app: Application, q: Question, others: Question[], guidance?: string) {
  const { opp, emp, reqs } = ctx;
  const passages = await findPassages(orgId, `${q.text} ${opp.title}`, { employeeId: emp.id, opportunityId: opp.id, limit: 12 });
  const outline = app.mode === "outline";
  const weight = reqs.scoring?.find((s) => norm(q.text).includes(norm(s.name).split(" ")[0] ?? "") || norm(s.name).includes(norm(q.text).split(" ")[0] ?? ""));
  const { system } = await systemPromptFor(
    emp,
    outline
      ? `${WRITE_JOB[opp.kind]} The host limits AI-written applications, so you do not write the answer. Give the person an outline to write from and the facts with their sources.
- 3 to 6 outline points, in the order a reviewer expects.
- Facts only from the passages and the Brain, each with the document it came from.`
      : `${WRITE_JOB[opp.kind]} Answer one question from the host, in the host's terms, as a subject-matter expert would.
- Ground every claim in the Brain or the passages provided. Where a fact is missing, write a bracketed placeholder like [CLIENTS SERVED IN 2025].
- Stay within the limit${q.maxWords ? ` (${q.maxWords} words at most)` : ""}. Match the reviewer's scoring criteria.${weight ? ` This part is worth ${weight.points} points, so give it depth.` : ""}
- Plain paragraphs. Short headings only where the question has parts.
- In "missing", list up to two facts you had to leave as placeholders that the person can answer with a fixed choice (for example an indirect cost rate: "15% de minimis", "Negotiated rate", "No indirect costs"). Leave it empty when a choice list would not fit.
- In "sources", list the documents you used.`
  );
  const otherText = others
    .filter((o) => o.id !== q.id && o.answer)
    .map((o) => `- ${o.text}: ${o.answer.slice(0, 400)}`)
    .join("\n");
  const prompt = `${hostBrief(opp, reqs)}

Question: ${q.text}${q.limit ? `\nLimit: ${q.limit}` : ""}${guidance ? `\nReviewer guidance: ${guidance}` : ""}${q.answer && guidance ? `\n\nCurrent answer:\n${q.answer}` : ""}

${otherText ? `Other answers already written (stay consistent, do not repeat):\n${otherText}\n\n` : ""}Passages from the Brain, Knowledge and the host's documents:
${formatPassages(passages) || "(none found)"}`;

  if (outline) {
    const r = await generateJson<{ outline: string[]; facts: { text: string; source: string }[] }>({
      system,
      prompt,
      schemaName: "outline",
      schema: obj({ outline: arr(str), facts: arr(obj({ text: str, source: str })) }),
      maxTokens: 2000,
    });
    return { ...q, outline: r.outline ?? [], facts: r.facts ?? [], status: q.answer ? ("yours" as const) : ("empty" as const), sources: Array.from(new Set(passages.map((p) => p.source))) };
  }

  const r = await generateJson<{ answer: string; missing: { label: string; question: string; options: string[]; who: "research" | "person" }[]; sources: string[] }>({
    system,
    prompt,
    schemaName: "answer",
    schema: obj({
      answer: str,
      missing: arr(
        obj({
          label: str,
          question: str,
          options: arr(str),
          who: { type: "string", enum: ["research", "person"], description: "research: a public fact you can look up (a funder's rules, eligibility, deadlines, amounts, a program's history). person: only the person can know or decide it (internal numbers, decisions, signatures)" },
        })
      ),
      sources: arr(str),
    }),
    maxTokens: Math.min(6000, Math.max(1500, (q.maxWords || 600) * 3)),
    timeoutMs: 180_000,
  });
  let answer = (r.answer || "").trim();
  if (q.maxWords && words(answer) > q.maxWords) {
    const short = await generateJson<{ answer: string }>({
      system: "Shorten the text to the word limit without losing facts, numbers or placeholders. Keep the voice. No em dashes.",
      prompt: `Limit: ${q.maxWords} words.\n\n${answer}`,
      schemaName: "shorter",
      schema: obj({ answer: str }),
      maxTokens: 3000,
    });
    if (short.answer && words(short.answer) < words(answer)) answer = short.answer.trim();
  }
  // Public facts are looked up, never asked. Only what the person alone knows becomes a question.
  const found: string[] = [];
  for (const m of (r.missing ?? []).slice(0, 3)) {
    if (!m.question) continue;
    if (m.who === "research") {
      const fact = await researchFact(orgId, emp, ctx.opp, m.question).catch(() => null);
      if (fact) found.push(`${m.label}: ${fact.answer} (source: ${fact.source})`);
      else await askHostByEmail(orgId, ctx.opp, m.question).catch(() => null);
      continue;
    }
    const options = (m.options ?? []).map((o) => o.trim()).filter(Boolean).slice(0, 4);
    if (options.length < 2) continue;
    const already = await db.listOpenQuestions(orgId, app.id);
    if (already.some((x) => norm(x.label) === norm(m.label))) continue;
    await db.createEmployeeQuestion({ organizationId: orgId, employeeId: emp.id, applicationId: app.id, label: m.label.slice(0, 120), question: m.question.slice(0, 300), options: JSON.stringify(options) });
  }
  if (found.length && !guidance?.startsWith("Research found:")) {
    return writeQuestion(orgId, ctx, app, q, others, `Research found: ${found.join(". ")}. Use these facts and fill any placeholder they answer.`);
  }
  const sources = Array.from(new Set([...(r.sources ?? []), ...passages.map((p) => p.source)])).slice(0, 8);
  return { ...q, answer, status: "done" as const, sources };
}

async function buildAttachments(orgId: number, emp: AIEmployee, reqs: Partial<Requirements>, opp: Opportunity, existing: Attachment[]) {
  const list: Attachment[] = [];
  const brain = [...(await db.listKnowledgeByOrg(orgId)), ...(await db.listEmployeeKnowledge(orgId, emp.id))].filter((k) => k.kind === "document" || k.kind === "image");
  const wanted = reqs.attachments?.length ? reqs.attachments : opp.kind === "speaking" ? [{ name: "Headshot", required: false, needsSignature: false }, { name: "Speaker bio", required: false, needsSignature: false }] : [];
  for (const a of wanted) {
    const prev = existing.find((e) => norm(e.name) === norm(a.name));
    if (prev && (prev.source === "upload" || prev.fileUrl)) {
      list.push({ ...prev, required: a.required, needsSignature: a.needsSignature });
      continue;
    }
    const n = norm(a.name);
    const tokens = n.split(" ").filter((t) => t.length > 2 && !["the", "and", "for", "copy", "letter", "proof"].includes(t));
    const match = brain.find((k) => {
      const t = norm(k.title);
      return t.includes(n) || n.includes(t) || (tokens.length > 0 && tokens.every((x) => t.includes(x)));
    });
    if (a.needsSignature) list.push({ name: a.name, source: "host_form", required: a.required, needsSignature: true, fileUrl: null, knowledgeId: null, content: null });
    else if (match) list.push({ name: a.name, source: "brain", required: a.required, needsSignature: false, fileUrl: match.fileUrl, knowledgeId: match.id, content: null });
    else if (/budget|bio|biography|abstract|summary|timeline|logic model|work plan|narrative/.test(n)) list.push({ name: a.name, source: "made", required: a.required, needsSignature: false, fileUrl: null, knowledgeId: null, content: null });
    else list.push({ name: a.name, source: "missing", required: a.required, needsSignature: false, fileUrl: null, knowledgeId: null, content: null });
  }
  return list;
}

async function writeMadeAttachment(orgId: number, ctx: Awaited<ReturnType<typeof contextFor>>, a: Attachment, answers: Question[]) {
  const { opp, emp, reqs } = ctx;
  const passages = await findPassages(orgId, `${a.name} ${opp.title} budget costs staff salary`, { employeeId: emp.id, opportunityId: opp.id, limit: 10 });
  const { system } = await systemPromptFor(
    emp,
    `${WRITE_JOB[opp.kind]} Write the attachment named below. Budgets: a line-item table in plain text (Item | Amount | Justification) that adds up and stays inside the award range, followed by a short justification; follow 2 CFR 200 cost rules for federal awards (the de minimis indirect rate is 15% of modified total direct costs unless a negotiated rate exists). Use bracketed placeholders for figures not in the Brain.`
  );
  return generateJson<{ content: string }>({
    system,
    prompt: `${hostBrief(opp, reqs)}\n\nAttachment: ${a.name}\n\nApplication answers so far:\n${answers.map((q) => `- ${q.text}: ${q.answer.slice(0, 600)}`).join("\n")}\n\nPassages:\n${formatPassages(passages, 8000)}`,
    schemaName: "attachment",
    schema: obj({ content: str }),
    maxTokens: 4000,
  }).then((r) => r.content);
}

async function writePitchExtras(orgId: number, ctx: Awaited<ReturnType<typeof contextFor>>, answers: Question[], prev: Extras): Promise<Extras> {
  const { opp, emp, reqs } = ctx;
  const passages = await findPassages(orgId, `traction revenue customers market model team financials ${opp.title}`, { employeeId: emp.id, opportunityId: opp.id, limit: 10 });
  const { system } = await systemPromptFor(
    emp,
    `${WRITE_JOB[opp.kind]} Build the pitch materials from the application answers: a slide deck (${reqs.deckLimit || "10 to 12 slides"}: title, problem, solution, product, traction, market, business model, competition, team, financials, the ask), a pitch video script the founder reads on camera (${reqs.videoLimit || "2 minutes"}, about 145 spoken words per minute, first person), and a short financial summary. Placeholders for any number not in the Brain.`
  );
  const r = await generateJson<{ deck: { title: string; bullets: string[] }[]; videoScript: string; financials: string }>({
    system,
    prompt: `${hostBrief(opp, reqs)}\n\nAnswers:\n${answers.map((q) => `- ${q.text}: ${q.answer}`).join("\n")}\n\nPassages:\n${formatPassages(passages, 8000)}`,
    schemaName: "pitch_materials",
    schema: obj({ deck: arr(obj({ title: str, bullets: arr(str) })), videoScript: str, financials: str }),
    maxTokens: 5000,
    timeoutMs: 180_000,
  });
  return { ...prev, deck: r.deck ?? [], videoScript: r.videoScript ?? "", financials: r.financials ?? "" };
}

export async function writeApplication(orgId: number, appId: number, opts: { fresh?: boolean } = {}) {
  let app = await db.getApplication(appId, orgId);
  if (!app) return;
  try {
    let ctx = await contextFor(orgId, app);
    if (ctx.opp.packageStatus !== "ready") {
      await db.updateApplication(appId, orgId, { progress: "Downloading and reading the host's package" });
      await fetchPackage(orgId, ctx.opp.id);
      ctx = await contextFor(orgId, app);
    }
    const { opp, emp, reqs } = ctx;
    const mode = reqs.aiPolicy?.restricted ? "outline" : "draft";
    const prevQuestions = parse<Question[]>(app.questions, []);
    const fromHost = (reqs.questions ?? []).filter((q) => q.text?.trim());
    const base = fromHost.length
      ? fromHost.map((q, i) => ({ id: `q${i + 1}`, text: q.text.trim(), limit: q.limit || "", maxWords: q.maxWords > 0 ? q.maxWords : 0 }))
      : DEFAULT_QUESTIONS[opp.kind].map((text, i) => ({ id: `q${i + 1}`, text, limit: "", maxWords: 0 }));
    let questions: Question[] = base.map((b) => {
      const prev = !opts.fresh ? prevQuestions.find((p) => norm(p.text) === norm(b.text)) : undefined;
      return prev ?? { ...b, answer: "", outline: [], facts: [], sources: [], status: "empty" };
    });
    const attachments = await buildAttachments(orgId, emp, reqs, opp, parse<Attachment[]>(app.attachments, []));
    app = (await db.updateApplication(appId, orgId, {
      mode,
      channel: reqs.channel || "form",
      channelDetail: reqs.channelDetail || null,
      decisionExpected: reqs.decisionDate || null,
      questions: JSON.stringify(questions),
      attachments: JSON.stringify(attachments),
    }))!;

    await working(emp, async () => {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (q.status === "done" && q.answer && !opts.fresh) continue;
        await db.updateApplication(appId, orgId, { progress: `${mode === "outline" ? "Outlining" : "Writing"} ${i + 1} of ${questions.length}` });
        questions[i] = await writeQuestion(orgId, ctx, app!, q, questions);
        await db.updateApplication(appId, orgId, { questions: JSON.stringify(questions) });
      }
      if (mode === "draft") {
        for (const a of attachments) {
          if (a.source === "made" && !a.content) {
            await db.updateApplication(appId, orgId, { progress: `Making ${a.name}` });
            a.content = await writeMadeAttachment(orgId, ctx, a, questions);
          }
        }
        await db.updateApplication(appId, orgId, { attachments: JSON.stringify(attachments) });
        if (opp.kind === "pitch" || opp.kind === "accelerator") {
          await db.updateApplication(appId, orgId, { progress: "Building the deck and video script" });
          const extras = await writePitchExtras(orgId, ctx, questions, parse<Extras>(app!.extras, {}));
          await db.updateApplication(appId, orgId, { extras: JSON.stringify(extras) });
        }
      }
    });

    await db.updateApplication(appId, orgId, { progress: "Reviewer check" });
    await reviewApplication(orgId, appId);
    const done = await finishStatus(orgId, appId);
    await announce(orgId, done!);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.updateApplication(appId, orgId, { status: "error", errorNote: message.slice(0, 500), progress: null });
    const fresh = await db.getApplication(appId, orgId);
    const emp = fresh?.employeeId ? await db.getEmployeeForOrg(fresh.employeeId, orgId) : null;
    if (emp) await postToChat(emp, `I couldn't finish the ${fresh!.title} application. ${message}`);
  }
}

/** Sets the status after writing: needs an answer, needs Grants.gov setup, or ready for you. */
async function finishStatus(orgId: number, appId: number) {
  const app = (await db.getApplication(appId, orgId))!;
  const open = await db.listOpenQuestions(orgId, appId);
  let status: Application["status"] = "ready";
  if (open.length) status = "needs_answer";
  if (app.channel === "grants_gov") {
    const regs = await db.listRegistrations(orgId);
    const sam = regs.find((r) => r.kind === "sam");
    const gg = regs.find((r) => r.kind === "grants_gov");
    if (sam?.status !== "active" || !gg || !["active", "set_up"].includes(gg.status)) status = "needs_setup";
  }
  return db.updateApplication(appId, orgId, { status, progress: null, errorNote: null });
}

async function announce(orgId: number, app: Application) {
  const emp = app.employeeId ? await db.getEmployeeForOrg(app.employeeId, orgId) : null;
  if (!emp) return;
  const opp = await db.getOpp(app.opportunityId, orgId);
  const qs = parse<Question[]>(app.questions, []);
  const atts = parse<Attachment[]>(app.attachments, []);
  const open = await db.listOpenQuestions(orgId, app.id);
  const review = parse<Review | null>(app.review, null);
  const cards: unknown[] = [applicationCard(app, opp)];
  for (const q of open) cards.push({ type: "question", id: q.id, title: q.label, body: q.question, options: parse<string[]>(q.options, []) });
  const outline = app.mode === "outline";
  const text = outline
    ? `The ${app.title} host limits AI-written applications, so I outlined the ${qs.length} sections with facts and sources for you to write from.`
    : `I finished the ${app.title} application. It answers ${qs.length === 1 ? "the 1 question" : `all ${qs.length} questions`}${atts.length ? ` and lists ${atts.length} attachment${atts.length === 1 ? "" : "s"}` : ""}.${review ? ` The reviewer check estimates ${review.score} of ${review.total}.` : ""}${open.length ? " I need one answer from you first." : ""}`;
  await postToChat(emp, text, cards);
}

export function applicationCard(app: Application, opp: Opportunity | null) {
  return {
    type: "application",
    id: app.id,
    title: app.title,
    subtitle: [opp?.host, opp?.amount, (opp?.deadline || "") && `Due ${opp?.deadline}`].filter(Boolean).join(" · "),
    body: channelLabel(app.channel, app.channelDetail),
    status: app.status,
  };
}

export function channelLabel(channel: string, detail?: string | null) {
  const map: Record<string, string> = {
    form: "Goes in through the host's online form",
    email: `Goes in by email${detail ? ` to ${detail}` : ""}`,
    grants_gov: "Goes in through Grants.gov",
    submittable: "Goes in through Submittable",
    sessionize: "Goes in through Sessionize",
    portal: `Goes in through ${detail || "the host's portal"}`,
  };
  return map[channel] ?? map.form;
}

/** Rewrites one question, with optional guidance. */
export async function rewriteQuestion(orgId: number, appId: number, questionId: string, guidance?: string, style?: "detailed" | "concise") {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const ctx = await contextFor(orgId, app);
  const qs = parse<Question[]>(app.questions, []);
  const i = qs.findIndex((q) => q.id === questionId);
  if (i === -1) throw new TRPCError({ code: "NOT_FOUND", message: "That question is not on this application." });
  const g = [guidance, style === "detailed" ? "Make it more detailed and specific, using the full limit." : style === "concise" ? "Make it shorter and tighter without losing facts." : null].filter(Boolean).join(" ");
  qs[i] = await writeQuestion(orgId, ctx, app, qs[i], qs, g || undefined);
  return db.updateApplication(appId, orgId, { questions: JSON.stringify(qs) });
}

export async function saveAnswer(orgId: number, appId: number, questionId: string, answer: string) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const qs = parse<Question[]>(app.questions, []);
  const q = qs.find((x) => x.id === questionId);
  if (!q) throw new TRPCError({ code: "NOT_FOUND", message: "That question is not on this application." });
  q.answer = answer;
  q.status = app.mode === "outline" ? "yours" : "done";
  return db.updateApplication(appId, orgId, { questions: JSON.stringify(qs) });
}

// ==========================================
// Reviewer check
// ==========================================

function plainChecks(app: Application, reqs: Partial<Requirements>, opp: Opportunity) {
  const qs = parse<Question[]>(app.questions, []);
  const atts = parse<Attachment[]>(app.attachments, []);
  const extras = parse<Extras>(app.extras, {});
  const fixes: Review["fixes"] = [];
  const passed: string[] = [];
  let id = 0;
  const add = (kind: Review["fixes"][number]["kind"], text: string, questionId = "") => fixes.push({ id: `p${++id}`, kind, text, questionId, done: false });

  const over = qs.filter((q) => q.maxWords && words(q.answer) > q.maxWords);
  for (const q of over) add("length", `"${q.text.slice(0, 70)}" runs ${words(q.answer)} words. The limit is ${q.maxWords}.`, q.id);
  if (app.mode === "draft") {
    if (qs.some((q) => q.maxWords) && over.length === 0) passed.push(`Word limits on all ${qs.filter((q) => q.maxWords).length} limited questions`);
    const empty = qs.filter((q) => !q.answer.trim());
    for (const q of empty) add("question", `"${q.text.slice(0, 70)}" has no answer yet.`, q.id);
    const ph = qs.filter((q) => (q.answer.match(PLACEHOLDER) ?? []).length > 0);
    for (const q of ph) add("placeholder", `"${q.text.slice(0, 60)}" still has ${(q.answer.match(PLACEHOLDER) ?? []).join(", ")}.`, q.id);
    if (ph.length === 0 && empty.length === 0) passed.push("No placeholders left");
  } else {
    const unwritten = qs.filter((q) => !q.answer.trim());
    for (const q of unwritten) add("question", `Write "${q.text.slice(0, 70)}" in your own words.`, q.id);
  }
  const narrativeWords = qs.reduce((n, q) => n + words(q.answer), 0);
  const pageLimit = Number((reqs.narrativeLimit || "").match(/(\d+(?:\.\d+)?)\s*pages?/i)?.[1] || 0);
  if (pageLimit) {
    const perPage = /double/i.test(reqs.format || "") ? 275 : 500;
    const pages = Math.round((narrativeWords / perPage) * 10) / 10;
    if (pages > pageLimit) add("length", `The narrative runs about ${pages} pages. The limit is ${pageLimit}${reqs.pages?.limits ? ` (${reqs.pages.limits})` : ""}.`);
    else passed.push(`Narrative about ${pages} of ${pageLimit} pages`);
  }
  const missing = atts.filter((a) => a.source === "missing" && a.required);
  for (const a of missing) add("attachment", `${a.name} is required and missing.`);
  const sign = atts.filter((a) => a.needsSignature && a.source !== "upload");
  for (const a of sign) add("attachment", `${a.name} needs your signature. Upload the signed copy.`);
  if (atts.length && missing.length === 0 && sign.length === 0) passed.push("Required attachments are in place");
  if ((opp.kind === "pitch" || opp.kind === "accelerator") && reqs.videoRequired && !extras.videoUrl) add("video", "The pitch video is required. Upload yours.");
  if (reqs.aiPolicy && !reqs.aiPolicy.restricted) passed.push("No AI rule in this RFP");
  return { fixes, passed };
}

export async function reviewApplication(orgId: number, appId: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const { opp, reqs } = await contextFor(orgId, app);
  const qs = parse<Question[]>(app.questions, []);
  const plain = plainChecks(app, reqs, opp);
  const criteria = reqs.scoring?.length
    ? reqs.scoring
    : opp.kind === "speaking"
      ? [{ name: "Relevance to the audience", points: 40 }, { name: "Clear takeaways", points: 30 }, { name: "Speaker credibility", points: 30 }]
      : opp.kind === "media"
        ? [{ name: "Newsworthy angle", points: 40 }, { name: "Fit with the outlet's audience", points: 30 }, { name: "Expert credibility", points: 30 }]
      : opp.kind === "grant"
        ? [{ name: "Need", points: 25 }, { name: "Program design", points: 35 }, { name: "Evaluation", points: 20 }, { name: "Budget", points: 20 }]
        : [{ name: "Problem and solution", points: 30 }, { name: "Traction", points: 25 }, { name: "Market and model", points: 25 }, { name: "Team", points: 20 }];

  let scored: { criteria: { name: string; points: number; max: number; note: string }[]; fixes: { text: string; questionNumber: number }[] } = { criteria: [], fixes: [] };
  const anyText = qs.some((q) => q.answer.trim());
  if (anyText) {
    scored = await generateJson({
      system: `You are an experienced reviewer for ${opp.host}, scoring a ${KIND_WORDS[opp.kind].thing} application against the host's rubric. You did not write it. Be strict and specific, the way a real review panel is. Score each criterion out of its points. List up to 4 fixes that would raise the score most, each tied to the question number it concerns (0 if none). Plain language, no em dashes.`,
      prompt: `${hostBrief(opp, reqs)}\n\nRubric:\n${criteria.map((c) => `- ${c.name}: ${c.points} points`).join("\n")}\n\nApplication:\n${qs.map((q, i) => `${i + 1}. ${q.text}${q.limit ? ` (limit ${q.limit})` : ""}\n${q.answer || "(not written yet)"}`).join("\n\n")}`,
      schemaName: "review",
      schema: obj({ criteria: arr(obj({ name: str, points: int, max: int, note: str })), fixes: arr(obj({ text: str, questionNumber: int })) }),
      maxTokens: 3000,
      timeoutMs: 180_000,
    });
  }
  const crit = criteria.map((c) => {
    const s = scored.criteria?.find((x) => norm(x.name) === norm(c.name)) ?? scored.criteria?.find((x) => norm(x.name).includes(norm(c.name).split(" ")[0]));
    return { name: c.name, max: c.points, points: Math.max(0, Math.min(c.points, Math.round(s?.points ?? 0))), note: s?.note ?? "" };
  });
  const total = crit.reduce((n, c) => n + c.max, 0);
  const score = crit.reduce((n, c) => n + c.points, 0);
  const llmFixes: Review["fixes"] = (scored.fixes ?? []).slice(0, 4).map((f, i) => ({
    id: `r${i + 1}`,
    kind: "question",
    text: f.text,
    questionId: qs[f.questionNumber - 1]?.id ?? "",
    done: false,
  }));
  const review: Review = { score, total, criteria: crit, fixes: [...plain.fixes, ...(app.mode === "draft" ? llmFixes : [])], passed: plain.passed, checkedAt: new Date().toISOString() };
  return db.updateApplication(appId, orgId, { review: JSON.stringify(review) });
}

/** One-tap fix from the reviewer check. */
export async function applyFix(orgId: number, appId: number, fixId: string) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const review = parse<Review | null>(app.review, null);
  const fix = review?.fixes.find((f) => f.id === fixId);
  if (!review || !fix) throw new TRPCError({ code: "NOT_FOUND", message: "That fix is no longer on the list." });
  const ctx = await contextFor(orgId, app);
  const qs = parse<Question[]>(app.questions, []);
  if (fix.kind === "length" && !fix.questionId) {
    // Narrative over the page limit: trim the longest answers by about 10%.
    const sorted = [...qs].sort((a, b) => words(b.answer) - words(a.answer)).slice(0, 2);
    for (const q of sorted) {
      const i = qs.findIndex((x) => x.id === q.id);
      qs[i] = await writeQuestion(orgId, ctx, app, { ...q, maxWords: Math.floor(words(q.answer) * 0.88) }, qs, "Cut about 12% without losing facts or scoring points.");
      qs[i].maxWords = q.maxWords;
    }
  } else if (fix.questionId) {
    const i = qs.findIndex((q) => q.id === fix.questionId);
    if (i >= 0) qs[i] = await writeQuestion(orgId, ctx, app, qs[i], qs, fix.text);
  } else {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This one needs you: upload the file it names." });
  }
  fix.done = true;
  await db.updateApplication(appId, orgId, { questions: JSON.stringify(qs), review: JSON.stringify(review) });
  // Refresh the plain checks (word counts, placeholders) without a new panel score.
  const fresh = (await db.getApplication(appId, orgId))!;
  const plain = plainChecks(fresh, ctx.reqs, ctx.opp);
  const kept = review.fixes.filter((f) => f.id.startsWith("r"));
  return db.updateApplication(appId, orgId, { review: JSON.stringify({ ...review, fixes: [...plain.fixes, ...kept], passed: plain.passed }) });
}

// ==========================================
// Questions answered with fixed choices
// ==========================================

/** Looks a public fact up on the web: the host's own pages first. Null when nothing solid is found. */
export async function researchFact(orgId: number, emp: AIEmployee, opp: Opportunity | null, question: string) {
  if (process.env.NODE_ENV === "test" && !(globalThis as any).__allowResearch) return null;
  const { system } = await systemPromptFor(
    emp,
    `Your job now: answer one factual question by searching the web. Use the host's or funder's own pages and documents first (eligibility rules, FAQs, guidelines, 990s, past grantee lists), then reliable sources. Answer only when a source clearly says it. If you cannot find it stated, set found to false.`
  );
  const r = await searchJson<{ found: boolean; answer: string; source: string }>({
    system,
    prompt: `Question: ${question}${opp ? `\nOpportunity: ${opp.title} (${opp.host})${opp.sourceUrl ? `\nHost's page: ${opp.sourceUrl}` : ""}` : ""}`,
    schemaName: "research_fact",
    schema: obj({ found: bool, answer: { type: "string", description: "The answer in one or two sentences, as the source states it" }, source: { type: "string", description: "The page that says it" } }),
    maxUses: 5,
    maxTokens: 1500,
  });
  const real = r.data.source && r.sources.some((x) => hostOf(x.url) === hostOf(r.data.source));
  if (!r.data.found || !r.data.answer || !real) return null;
  const item = await db.createKnowledgeItem({ organizationId: orgId, employeeId: emp.id, folder: "Research", kind: "fact", category: "financial_data", title: question.slice(0, 120), content: `${question} ${r.data.answer} Source: ${r.data.source}`, chars: r.data.answer.length });
  indexKnowledge(item);
  return { answer: r.data.answer, source: r.data.source };
}

/** When the web doesn't say, the question goes to the host as an email draft in Approvals, never to the person. */
async function askHostByEmail(orgId: number, opp: Opportunity | null, question: string) {
  if (!opp) return null;
  const { askQuestion } = await import("./bids");
  return askQuestion(orgId, opp.id, question);
}

/** "Look it up" on a question an employee asked: research it, answer it, or email the host. */
export async function researchQuestion(orgId: number, questionId: number) {
  const q = await db.getEmployeeQuestion(questionId, orgId);
  if (!q) throw new TRPCError({ code: "NOT_FOUND", message: "That question is not in this workspace." });
  if (q.answeredAt) return { status: "answered" as const, answer: q.answer ?? "" };
  const emp = (q.employeeId && (await db.getEmployeeForOrg(q.employeeId, orgId))) || (await employeeFor(orgId, "grants"));
  const app = q.applicationId ? await db.getApplication(q.applicationId, orgId) : null;
  const opp = app ? await db.getOpp(app.opportunityId, orgId) : null;
  const fact = await researchFact(orgId, emp, opp ?? null, q.question);
  if (fact) {
    await answerQuestion(orgId, questionId, `${fact.answer} (source: ${fact.source})`, emp.name);
    return { status: "found" as const, answer: fact.answer, source: fact.source };
  }
  const draft = await askHostByEmail(orgId, opp ?? null, q.question).catch(() => null);
  if (draft) {
    await answerQuestion(orgId, questionId, `Not stated publicly. ${emp.name} drafted an email asking ${opp?.host ?? "the host"}; it's waiting in Approvals`, emp.name);
    return { status: "emailed" as const, answer: "" };
  }
  return { status: "not_found" as const, answer: "" };
}

export async function answerQuestion(orgId: number, questionId: number, answer: string, personName: string) {
  const q = await db.getEmployeeQuestion(questionId, orgId);
  if (!q) throw new TRPCError({ code: "NOT_FOUND", message: "That question is not in this workspace." });
  if (q.answeredAt) return q;
  answer = answer.trim();
  if (answer.length < 2) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a choice or type an answer." });
  await db.answerEmployeeQuestion(questionId, orgId, answer, personName);
  const item = await db.createKnowledgeItem({
    organizationId: orgId,
    employeeId: q.employeeId,
    folder: "Answers",
    kind: "fact",
    category: "financial_data",
    title: q.label,
    content: `${q.question} ${answer}.`,
    chars: answer.length,
  });
  indexKnowledge(item);
  if (q.applicationId) {
    enqueue(`answer-${q.id}`, async () => {
      const app = await db.getApplication(q.applicationId!, orgId);
      if (!app) return;
      const qs = parse<Question[]>(app.questions, []);
      const ctx = await contextFor(orgId, app);
      for (let i = 0; i < qs.length; i++) {
        if ((qs[i].answer.match(PLACEHOLDER) ?? []).length) qs[i] = await writeQuestion(orgId, ctx, app, qs[i], qs, `The person answered: ${q.label}: ${answer}. Fill any placeholder this answers.`);
      }
      await db.updateApplication(app.id, orgId, { questions: JSON.stringify(qs) });
      if (app.status === "needs_answer") await finishStatus(orgId, app.id);
      await reviewApplication(orgId, app.id).catch(() => null);
    });
  }
  return db.getEmployeeQuestion(questionId, orgId);
}

// ==========================================
// Submit, results, reports
// ==========================================

/** What still blocks Submit, in plain words. Empty when it can go. */
export async function blockers(orgId: number, app: Application) {
  const out: string[] = [];
  const opp = await db.getOpp(app.opportunityId, orgId);
  const reqs = parse<Partial<Requirements>>(opp?.requirements, {});
  const qs = parse<Question[]>(app.questions, []);
  const atts = parse<Attachment[]>(app.attachments, []);
  const extras = parse<Extras>(app.extras, {});
  if (app.status === "writing") out.push("Still being written");
  if (qs.some((q) => !q.answer.trim())) out.push(app.mode === "outline" ? "Your sections are not all written" : "Some questions have no answer");
  if (app.mode === "draft" && qs.some((q) => (q.answer.match(PLACEHOLDER) ?? []).length)) out.push("Placeholders are left to fill");
  if (atts.some((a) => a.required && a.source === "missing")) out.push("A required attachment is missing");
  if (atts.some((a) => a.needsSignature && a.source !== "upload")) out.push("A form needs your signature");
  if ((opp?.kind === "pitch" || opp?.kind === "accelerator") && reqs.videoRequired && !extras.videoUrl) out.push("Needs your video");
  if ((await db.listOpenQuestions(orgId, app.id)).length) out.push("Needs an answer from you");
  if (app.status === "needs_setup") out.push("Grants.gov setup is not finished");
  return out;
}

export async function submitApplication(orgId: number, appId: number, personName: string) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  if (["approved", "submitted", "awarded", "declined"].includes(app.status)) return app;
  const block = await blockers(orgId, app);
  if (block.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${block.join(". ")}.` });
  const updated = await db.updateApplication(appId, orgId, { status: "approved", certifiedBy: personName, certifiedAt: new Date() });
  // Morgan sends it now if she can (email or a saved portal sign-in); otherwise she says what still needs a person.
  enqueue(`submit-${appId}`, async () => (await import("./bids")).autoSubmit(orgId, appId));
  await db.logAction({
    organizationId: orgId,
    actorType: "human_user",
    actorName: personName,
    action: "Approved application to submit",
    details: `${app.title}. ${personName} certified it is true and complete. ${channelLabel(app.channel, app.channelDetail)}.`,
  });
  return updated;
}

export async function markSubmitted(orgId: number, appId: number, confirmation: string, personName: string) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  if (!["approved", "ready", "needs_answer", "needs_setup"].includes(app.status)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Only an approved application can be marked submitted." });
  }
  const updated = await db.updateApplication(appId, orgId, {
    status: "submitted",
    submittedAt: new Date(),
    confirmation: confirmation.trim() || null,
    certifiedBy: app.certifiedBy ?? personName,
    certifiedAt: app.certifiedAt ?? new Date(),
  });
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: personName, action: "Marked application submitted", details: `${app.title}${confirmation ? `, confirmation ${confirmation}` : ""}` });
  const emp = app.employeeId ? await db.getEmployeeForOrg(app.employeeId, orgId) : null;
  if (emp) {
    await postToChat(emp, `${app.title} is in.${app.decisionExpected ? ` The host lists decisions ${app.decisionExpected}.` : ""}`, [
      { type: "submitted", id: app.id, title: app.title, subtitle: [confirmation && `Confirmation ${confirmation}`, `Submitted ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`].filter(Boolean).join(" · ") },
    ]);
  }
  return updated;
}

export async function recordDecision(
  orgId: number,
  appId: number,
  input: { result: "awarded" | "declined"; amount?: string; period?: string; restrictions?: string; total?: number; reports?: { name: string; due: string }[]; reapplyDate?: string; comments?: string },
  personName: string
) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  if (input.result === "awarded") {
    const award: Award = {
      amount: input.amount ?? "",
      period: input.period ?? "",
      restrictions: input.restrictions ?? "",
      letterUrl: parse<Award | null>(app.award, null)?.letterUrl ?? null,
      spent: parse<Award | null>(app.award, null)?.spent ?? 0,
      total: input.total ?? (Number((input.amount ?? "").replace(/[^0-9.]/g, "")) || 0),
      reports: (input.reports ?? []).map((r) => ({ name: r.name, due: r.due, status: "not_due", draft: "" })),
    };
    await db.updateApplication(appId, orgId, { status: "awarded", award: JSON.stringify(award) });
  } else {
    await db.updateApplication(appId, orgId, { status: "declined", reviewerComments: input.comments ?? null, reapplyDate: input.reapplyDate ?? null });
    if (input.comments?.trim()) {
      const item = await db.createKnowledgeItem({
        organizationId: orgId,
        employeeId: app.employeeId,
        folder: "Reviewer comments",
        kind: "fact",
        category: "past_performance",
        title: `Reviewer comments: ${app.title}`.slice(0, 255),
        content: input.comments.trim(),
        chars: input.comments.length,
      });
      indexKnowledge(item);
    }
  }
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: personName, action: input.result === "awarded" ? "Recorded award" : "Recorded decline", details: app.title });
  return db.getApplication(appId, orgId);
}

export async function updateAward(orgId: number, appId: number, patch: Partial<Award>) {
  const app = await db.getApplication(appId, orgId);
  if (!app || app.status !== "awarded") throw new TRPCError({ code: "NOT_FOUND", message: "That award is not in this workspace." });
  const award = { ...parse<Award>(app.award, { amount: "", period: "", restrictions: "", letterUrl: null, spent: 0, total: 0, reports: [] }), ...patch };
  return db.updateApplication(appId, orgId, { award: JSON.stringify(award) });
}

export async function draftReport(orgId: number, appId: number, index: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app || app.status !== "awarded") throw new TRPCError({ code: "NOT_FOUND", message: "That award is not in this workspace." });
  const award = parse<Award>(app.award, { amount: "", period: "", restrictions: "", letterUrl: null, spent: 0, total: 0, reports: [] });
  const report = award.reports[index];
  if (!report) throw new TRPCError({ code: "NOT_FOUND", message: "That report is not on this award." });
  const ctx = await contextFor(orgId, app);
  report.status = "drafting";
  await db.updateApplication(appId, orgId, { award: JSON.stringify(award) });
  const passages = await findPassages(orgId, `${report.name} outcomes results served progress ${app.title}`, { employeeId: ctx.emp.id, limit: 10 });
  const { system } = await systemPromptFor(
    ctx.emp,
    `Your job now: draft a grant report for an award the workspace won. Report progress against what the application promised, with numbers from the Brain and Knowledge; placeholders for anything missing. Include spending to date against the award.`
  );
  const r = await generateJson<{ draft: string }>({
    system,
    prompt: `Award: ${app.title} from ${ctx.opp.host}\nAmount: ${award.amount}\nPeriod: ${award.period}\nRestricted to: ${award.restrictions}\nSpent so far: $${award.spent.toLocaleString("en-US")} of $${award.total.toLocaleString("en-US")}\nReport: ${report.name}, due ${report.due}\n\nWhat the application promised:\n${parse<Question[]>(app.questions, []).map((q) => `- ${q.text}: ${q.answer.slice(0, 500)}`).join("\n")}\n\nPassages:\n${formatPassages(passages, 8000)}`,
    schemaName: "report",
    schema: obj({ draft: str }),
    maxTokens: 4000,
    timeoutMs: 180_000,
  });
  report.draft = r.draft;
  report.status = "ready";
  return db.updateApplication(appId, orgId, { award: JSON.stringify(award) });
}

// ==========================================
// Expiry reminders for registrations
// ==========================================

let lastReminderDay = "";
export async function remindRegistrations(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (day === lastReminderDay) return 0;
  lastReminderDay = day;
  let sent = 0;
  for (const r of await db.listAllRegistrations()) {
    const m = (r.expires || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const expires = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const days = Math.ceil((expires.getTime() - now.getTime()) / 86400_000);
    const details = parse<Record<string, unknown>>(r.details, {});
    const mark = days <= 0 ? "expired" : days <= 30 ? "30" : null;
    if (!mark || details.reminded === `${r.expires}-${mark}`) continue;
    const emp = await db.getEmployeeByKind(r.organizationId, "grants");
    if (!emp) continue;
    const name = { sam: "SAM.gov", grants_gov: "Grants.gov", login_gov: "Login.gov", sbir: "SBIR.gov", state_supplier: "the state supplier portal", candid: "Candid" }[r.kind];
    const text = days <= 0 ? `Your ${name} registration expired on ${r.expires}. Federal applications cannot go in until it is renewed.` : `Your ${name} registration expires ${r.expires}, in ${days} days. Renewal can take a few weeks, so start it now.`;
    await postToChat(emp, text);
    await notify(r.organizationId, "deadline", { title: `${name} registration ${days <= 0 ? "expired" : "expires soon"}`, body: text, url: "/workspace", tag: `reg-${r.id}` }).catch(() => {});
    await db.upsertRegistration(r.organizationId, r.kind, { details: JSON.stringify({ ...details, reminded: `${r.expires}-${mark}` }), ...(days <= 0 ? { status: "expired" } : {}) });
    sent++;
  }
  return sent;
}
