import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { decryptJson, encryptJson } from "../_core/crypto";
import { generateJson, searchJson, type JsonSchema } from "../_core/llm";
import type { ColdCampaign, ColdLead, ColdPlay, ColdSettings } from "../../drizzle/schema";
import { fetchWebpage } from "./files";
import { HUMAN_EMAIL, findTells } from "./human";
import { client, InstantlyError, type IStep } from "./instantly";
import { partsIn } from "./schedule";
import { employeeFor, systemPromptFor, working } from "./tasks";

/**
 * Jada's cold email program.
 *
 * The owner's lead list (up to the whole 90,000) lives here. Jada scores it,
 * researches the best leads a few hundred at a time, writes short 4-email
 * campaigns from a library of angles, and sends each day's batch through
 * Instantly, which owns the warmed inboxes. Replies are read and sorted
 * (coldreply.ts), the inboxes are watched and rested when they look unhealthy,
 * and every Monday she reviews what worked and proposes one change at a time.
 *
 * Pricing and the mailing address come from the owner's website. Nothing is
 * claimed that isn't in the Brain, the playbook or the website.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const bool = { type: "boolean" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: unknown): JsonSchema => ({ type: "array", items } as JsonSchema);

export const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ==========================================
// Settings and plan
// ==========================================

export const PLANS = {
  growth: { name: "Growth", contacts: 1000, emails: 5000 },
  hypergrowth: { name: "Hypergrowth", contacts: 25000, emails: 125000 },
  lightspeed: { name: "Light Speed", contacts: 100000, emails: 500000 },
} as const;
export type PlanKey = keyof typeof PLANS | "custom";

export const LEVEL_TEXT: Record<number, string> = {
  1: "Level 1: you approve every reply.",
  2: "Level 2: she handles not interested, unsubscribes, out of office, wrong person, not now, basic questions and scheduling. You approve objections, pricing and anything unusual.",
  3: "Level 3: she also answers standard objections from your playbook and moves volume between campaigns.",
  4: "Level 4: she runs cold email, including answering interested leads with times. You take the demos.",
};

export function siteOf(s: Pick<ColdSettings, "site">): SiteInfo {
  const v = parse<Partial<SiteInfo>>(s.site, {});
  return { plans: Array.isArray(v.plans) ? v.plans : [], address: v.address ?? "", notes: v.notes ?? "", url: v.url ?? "" };
}

export type SiteInfo = { plans: { name: string; price: string; seats: string; includes: string }[]; address: string; notes: string; url: string };
type Today = { date?: string; added?: number; month?: string; monthSent?: number; week?: string };

export function settingsOf(orgId: number): ColdSettings {
  const s = db.cold.getSettings(orgId);
  if (s) return s;
  const made = db.cold.saveSettings(orgId, { hookToken: crypto.randomBytes(18).toString("base64url") });
  seedPlaybook(orgId);
  return made;
}

function keyOf(s: ColdSettings) {
  return s.keyEncrypted ? (decryptJson<{ key: string }>(s.keyEncrypted)?.key ?? "") : "";
}

/** The Instantly client for a workspace, or a clear message to connect it. */
export function api(orgId: number) {
  const key = keyOf(settingsOf(orgId));
  if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect Instantly first: paste your API key in Cold email settings." });
  return client(key);
}

export async function connect(orgId: number, key: string) {
  const k = key.trim();
  if (k.length < 10) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the whole API key from Instantly." });
  try {
    await client(k).test();
  } catch (err) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Instantly didn't accept that key." });
  }
  settingsOf(orgId);
  db.cold.saveSettings(orgId, { keyEncrypted: encryptJson({ key: k }), keyCheckedAt: new Date(), keyError: null });
  await syncInboxes(orgId).catch(() => null);
  return { connected: true };
}

export function disconnect(orgId: number) {
  settingsOf(orgId);
  db.cold.saveSettings(orgId, { keyEncrypted: null, keyError: null });
}

export type SettingsInput = { level: number; perInbox: number; rampPct: number; bounceRest: number; signature: string; address: string; optOut: string; alwaysNeedsYou: string; plan: PlanKey; contactsLimit?: number; emailsLimit?: number; website: string };

export function saveSettings(orgId: number, input: SettingsInput) {
  settingsOf(orgId);
  if (!/^https?:\/\/[^\s]+\.[a-z]{2,}/i.test(input.website.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the website address, starting with https://" });
  if (!input.optOut.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Every cold email needs a way to opt out. Keep the opt-out line." });
  const plan = input.plan in PLANS ? PLANS[input.plan as keyof typeof PLANS] : null;
  return db.cold.saveSettings(orgId, {
    level: Math.min(4, Math.max(1, Math.round(input.level))),
    perInbox: Math.min(50, Math.max(1, Math.round(input.perInbox))),
    rampPct: Math.min(50, Math.max(0, Math.round(input.rampPct))),
    bounceRest: Math.min(20, Math.max(1, Math.round(input.bounceRest))),
    signature: input.signature.trim().slice(0, 200),
    address: input.address.trim().slice(0, 300),
    optOut: input.optOut.trim().slice(0, 300),
    alwaysNeedsYou: input.alwaysNeedsYou.trim().slice(0, 500),
    plan: input.plan,
    contactsLimit: plan ? plan.contacts : Math.max(100, Math.round(input.contactsLimit ?? 1000)),
    emailsLimit: plan ? plan.emails : Math.max(500, Math.round(input.emailsLimit ?? 5000)),
    website: input.website.trim().replace(/\/+$/, ""),
  });
}

export function setPaused(orgId: number, paused: boolean) {
  settingsOf(orgId);
  db.cold.saveSettings(orgId, { paused });
}

/** The address every email carries: the one typed in settings, else the one on the website. */
export function addressOf(s: ColdSettings) {
  return s.address.trim() || siteOf(s).address.trim();
}

/** The lines under every cold email: who it's from, the mailing address and the opt-out. */
export async function footerFor(orgId: number, s = settingsOf(orgId)) {
  const org = await db.getOrganizationById(orgId);
  const name = s.signature.trim() || org?.name || "";
  const addr = addressOf(s);
  return [name, `${org?.name ?? ""}${addr ? `, ${addr}` : ""}`.replace(/^, /, ""), s.optOut.trim()].filter(Boolean).join("\n");
}

// ==========================================
// Pricing and address from the website
// ==========================================

const SITE: JsonSchema = obj({
  plans: arr(obj({ name: str, price: { type: "string", description: "Exactly as written on the page, like '$99 per month'" }, seats: str, includes: str })),
  address: { type: "string", description: "The business mailing address exactly as written on the page, or ''" },
  notes: { type: "string", description: "Pricing rules on the page (contracts, trials, add-ons), or ''" },
});

/** Visible text of a page, rendered in the server's browser when the plain page has no prices (built with JavaScript). */
async function pageText(url: string) {
  let text = "";
  try {
    text = (await fetchWebpage(url)).text;
  } catch {
    text = "";
  }
  if (/\$\s?\d/.test(text) && text.length > 400) return text;
  try {
    const { renderText } = await import("./browser");
    const rendered = await renderText(url);
    if (rendered.length > text.length) text = rendered;
  } catch {
    // No browser on this machine: keep what the plain fetch returned.
  }
  return text;
}

/** Reads the plans, prices and mailing address from the website. Nothing is filled in that isn't on the page. */
export async function refreshSite(orgId: number) {
  const s = settingsOf(orgId);
  const base = s.website.replace(/\/+$/, "");
  const [pricing, home] = await Promise.all([pageText(`${base}/pricing`), pageText(base)]);
  const text = `PRICING PAGE (${base}/pricing):\n${pricing.slice(0, 30_000)}\n\nHOME PAGE (${base}):\n${home.slice(0, 15_000)}`;
  if (!/\$\s?\d/.test(text)) {
    db.cold.saveSettings(orgId, { siteCheckedAt: new Date(), siteError: `No prices were found on ${base}/pricing.` });
    return null;
  }
  const r = await generateJson<Omit<SiteInfo, "url">>({
    system: "You copy a company's pricing and mailing address from its website text. Copy only what the text says, word for word for prices. Never guess or fill in a plan, price or address that isn't in the text. If something isn't there, leave it out.",
    prompt: text,
    schemaName: "cold_site",
    schema: SITE,
    maxTokens: 3000,
  });
  // Only prices that really appear on the page are kept.
  const plans = (r.plans ?? []).filter((p) => p.name?.trim() && p.price?.trim() && text.replace(/\s+/g, " ").includes(p.price.replace(/\s+/g, " ").match(/\$\s?[\d,.]+/)?.[0] ?? "@@"));
  const address = r.address?.trim() && text.replace(/\s+/g, " ").includes(r.address.trim().split(",")[0].trim()) ? r.address.trim() : "";
  const site: SiteInfo = { plans, address, notes: r.notes ?? "", url: `${base}/pricing` };
  db.cold.saveSettings(orgId, { site: JSON.stringify(site), siteCheckedAt: new Date(), siteError: plans.length ? null : `No prices were found on ${base}/pricing.` });
  return site;
}

export function pricingText(s: ColdSettings) {
  const site = siteOf(s);
  if (!site.plans.length) return "Pricing: not read from the website yet. Don't quote a price; say you'll send it.";
  return `Pricing, from ${site.url}${s.siteCheckedAt ? ` (checked ${fmtDay(s.siteCheckedAt)})` : ""}. Quote only these:\n${site.plans.map((p) => `- ${p.name}: ${p.price}${p.seats ? `, ${p.seats}` : ""}${p.includes ? `. ${p.includes}` : ""}`).join("\n")}${site.notes ? `\n${site.notes}` : ""}`;
}

// ==========================================
// The lead list
// ==========================================

/** Splits CSV text into rows (quotes, commas and line breaks inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const COLUMNS: { key: keyof Mapped; re: RegExp }[] = [
  { key: "email", re: /e-?mail/i },
  { key: "firstName", re: /^(first|first ?name|fname|given)/i },
  { key: "lastName", re: /^(last|last ?name|lname|surname|family)/i },
  { key: "name", re: /^(name|full ?name|licensee|contact ?name|provider ?name)$/i },
  { key: "licenseNumber", re: /licen[sc]e ?(no|num|number|#)/i },
  { key: "licenseStatus", re: /status/i },
  { key: "license", re: /licen[sc]e ?(type)?$|credential|profession|^type$/i },
  { key: "state", re: /^state$|state ?code|^st$/i },
  { key: "city", re: /^city$|town/i },
  { key: "phone", re: /phone|tel/i },
  { key: "practice", re: /practice|company|business|organi[sz]ation|employer/i },
  { key: "website", re: /web|url|site/i },
];
type Mapped = { email: string; firstName: string; lastName: string; name: string; licenseNumber: string; licenseStatus: string; license: string; state: string; city: string; phone: string; practice: string; website: string };

/** Which column holds which field, from the header row. */
export function mapColumns(header: string[]) {
  const used = new Set<number>();
  const map: Partial<Record<keyof Mapped, number>> = {};
  for (const { key, re } of COLUMNS) {
    const i = header.findIndex((h, idx) => !used.has(idx) && re.test(h.trim()));
    if (i >= 0) {
      map[key] = i;
      used.add(i);
    }
  }
  return map;
}

const INACTIVE = /inactive|expired|lapsed|revoked|suspend|surrender|deceased|cancel|retired|probation/i;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

export type ImportResult = { rows: number; added: number; duplicates: number; noEmail: number; doNotContact: number; inactive: number; columns: string[] };

/** Adds a CSV of leads (a state license list, a LeadDash platform export). Emails already on the list are skipped. */
export function importCsv(orgId: number, fileName: string, text: string): ImportResult {
  settingsOf(orgId);
  const rows = parseCsv(text);
  if (rows.length < 2) throw new TRPCError({ code: "BAD_REQUEST", message: "That file has no rows under the header." });
  const header = rows[0];
  const m = mapColumns(header);
  if (m.email === undefined) throw new TRPCError({ code: "BAD_REQUEST", message: "There's no email column in that file. Jada can only add leads with an email address." });
  const dnc = db.cold.suppressedSet(orgId);
  const seen = new Set<string>();
  const out: Parameters<typeof db.cold.insertLeads>[0] = [];
  let noEmail = 0;
  let suppressed = 0;
  let inactive = 0;
  const get = (r: string[], k: keyof Mapped) => (m[k] === undefined ? "" : (r[m[k]!] ?? "").trim());
  for (const r of rows.slice(1)) {
    const email = get(r, "email").toLowerCase().replace(/^mailto:/, "");
    if (!EMAIL.test(email)) {
      noEmail++;
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    let first = get(r, "firstName");
    let last = get(r, "lastName");
    if (!first && !last && get(r, "name")) {
      const n = get(r, "name").replace(/,.*$/, (x) => (x.split(" ").length > 2 ? "" : x));
      const parts = n.includes(",") ? n.split(",").map((x) => x.trim()).reverse().join(" ").split(/\s+/) : n.split(/\s+/);
      first = parts[0] ?? "";
      last = parts.slice(1).join(" ");
    }
    const status = get(r, "licenseStatus");
    const isDnc = dnc.has(email);
    const isInactive = !!status && INACTIVE.test(status);
    if (isDnc) suppressed++;
    if (isInactive) inactive++;
    const website = get(r, "website");
    out.push({
      organizationId: orgId,
      email,
      firstName: cap(first).slice(0, 80),
      lastName: cap(last).slice(0, 80),
      license: get(r, "license").slice(0, 60),
      licenseNumber: get(r, "licenseNumber").slice(0, 60),
      licenseStatus: status.slice(0, 60),
      state: get(r, "state").slice(0, 30),
      city: cap(get(r, "city")).slice(0, 80),
      phone: get(r, "phone").slice(0, 40),
      practice: get(r, "practice").slice(0, 200),
      website: website && !/^https?:\/\//i.test(website) && /\./.test(website) ? `https://${website}` : website.slice(0, 300),
      source: fileName.slice(0, 120),
      stage: isDnc ? "dnc" : isInactive ? "not_fit" : "new",
      fit: isInactive ? 0 : null,
      fitWhy: isInactive ? JSON.stringify([{ label: "License not active", points: -100 }]) : "[]",
      notFitReason: isInactive ? `License status: ${status}` : null,
    });
  }
  const added = db.cold.insertLeads(out);
  return { rows: rows.length - 1, added, duplicates: out.length - added, noEmail, doNotContact: suppressed, inactive, columns: Object.keys(m) };
}

function cap(s: string) {
  if (!s) return s;
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (x) => x.toUpperCase());
}

/** Pulls the leads already in the owner's Instantly workspace onto the list. */
export async function importFromInstantly(orgId: number) {
  const leads = await api(orgId).listLeads(5000);
  const dnc = db.cold.suppressedSet(orgId);
  const rows = leads
    .filter((l) => l.email && EMAIL.test(l.email))
    .map((l) => ({ organizationId: orgId, email: l.email.toLowerCase(), firstName: l.first_name ?? "", lastName: l.last_name ?? "", practice: l.company_name ?? "", website: l.website ?? "", phone: l.phone ?? "", source: "Instantly", stage: dnc.has(l.email.toLowerCase()) ? ("dnc" as const) : ("new" as const) }));
  const added = db.cold.insertLeads(rows);
  return { rows: leads.length, added, duplicates: rows.length - added, noEmail: leads.length - rows.length, doNotContact: rows.filter((r) => r.stage === "dnc").length, inactive: 0, columns: ["email", "firstName", "lastName", "practice", "website", "phone"] };
}

// ==========================================
// Research and the fit score
// ==========================================

export type Signals = {
  practice: string;
  website: string;
  ownerRole: "owner" | "employee" | "unknown";
  clinicians: number;
  locations: number;
  hiringClinicians: boolean;
  hiringAdmin: boolean;
  onlineBooking: boolean;
  telehealth: boolean;
  insurance: "yes" | "no" | "unknown";
  ehr: { name: string; confidence: "verified" | "likely" | "unknown"; evidence: string };
  hospitalSystem: boolean;
  recentlyOpened: boolean;
  independentFound: boolean;
  specialties: string[];
  summary: string;
  sources: string[];
};

const SIGNAL_PROPS = {
  practice: { type: "string", description: "The practice's name, or ''" },
  website: { type: "string", description: "The practice website URL, or ''" },
  ownerRole: { type: "string", enum: ["owner", "employee", "unknown"], description: "owner: the page names this person as owner, founder or director of the practice" },
  clinicians: { type: "integer", description: "Clinicians listed on the team page; 1 for a solo practice; 0 when unknown" },
  locations: { type: "integer", description: "Office locations; 0 when unknown" },
  hiringClinicians: bool,
  hiringAdmin: bool,
  onlineBooking: bool,
  telehealth: bool,
  insurance: { type: "string", enum: ["yes", "no", "unknown"] },
  ehr: obj({ name: { type: "string", description: "SimplePractice, TherapyNotes, Jane, TherapyAppointment, Carepatron or another EHR, or ''" }, confidence: { type: "string", enum: ["verified", "likely", "unknown"], description: "verified: the site links straight to it (a client portal or booking link on that product's domain). likely: it resembles it. unknown: no evidence" }, evidence: str }),
  hospitalSystem: { type: "boolean", description: "Works only for a hospital, health system or agency, with no practice of their own" },
  recentlyOpened: { type: "boolean", description: "The practice opened in the last two years" },
  independentFound: { type: "boolean", description: "An independent private practice for this person was found" },
  specialties: arr(str),
  summary: { type: "string", description: "One business-relevant sentence. Never personal details" },
  sources: arr({ type: "string", description: "URL" }),
};
const SIGNALS: JsonSchema = obj(SIGNAL_PROPS);

const RESEARCH_RULES = `Research rules:
- Public business information only: the practice website, its team, careers and contact pages, its booking or portal links, Psychology Today and professional directories.
- Never personal details: no home address, family, health, finances, politics, social life or anything unrelated to the practice.
- Never guess. Unknown stays unknown. Every fact must come from a page you read.`;

/** The LeadDash Fit Score: points for each signal, from 0 to 100. */
export function scoreOf(sig: Partial<Signals>, lead: Pick<ColdLead, "licenseStatus">) {
  const why: { label: string; points: number }[] = [];
  const add = (label: string, points: number) => why.push({ label, points });
  if (lead.licenseStatus && INACTIVE.test(lead.licenseStatus)) add("License not active", -100);
  if (sig.ownerRole === "owner") add("Practice owner", 20);
  const n = sig.clinicians ?? 0;
  if (n >= 2) add(`Group practice (${n} clinicians)`, 20);
  if (n >= 3 && n <= 20) add("3 to 20 clinicians", 15);
  if (sig.onlineBooking) add("Online booking", 5);
  if (sig.telehealth) add("Telehealth", 5);
  if (sig.hiringAdmin || sig.hiringClinicians) add(sig.hiringAdmin ? "Hiring office staff" : "Hiring a clinician", 10);
  if (sig.ehr?.name && sig.ehr.confidence !== "unknown") add(`Uses another EHR (${sig.ehr.name}, ${sig.ehr.confidence})`, 10);
  if ((sig.locations ?? 0) >= 2) add("Multiple locations", 5);
  if (sig.website) add("Active website", 5);
  if (sig.recentlyOpened) add("Recently opened", 5);
  if (sig.independentFound === false) add("No independent practice found", -25);
  if (sig.hospitalSystem) add("Works for a hospital or system", -30);
  const fit = Math.max(0, Math.min(100, why.reduce((a, b) => a + b.points, 0)));
  return { fit, why };
}

export function segmentsOf(sig: Partial<Signals>, lead: Pick<ColdLead, "license">) {
  const s = new Set<string>();
  const n = sig.clinicians ?? 0;
  if (sig.ownerRole === "owner") s.add(n >= 2 ? "group_owner" : "solo_owner");
  if (n >= 3 && n <= 15) s.add("size_3_15");
  if (n > 15) s.add("size_16_plus");
  if (sig.hiringClinicians || sig.hiringAdmin) s.add("hiring");
  if (sig.telehealth) s.add("telehealth");
  if (sig.onlineBooking) s.add("online_booking");
  if (sig.insurance === "yes") s.add("insurance");
  if (sig.insurance === "no") s.add("cash_pay");
  if ((sig.locations ?? 0) >= 2) s.add("multi_location");
  if (sig.ehr?.name && sig.ehr.confidence !== "unknown") s.add(`ehr_${sig.ehr.name.toLowerCase().replace(/[^a-z]+/g, "")}`);
  if (!sig.website) s.add("no_website");
  if (sig.independentFound === false) s.add("no_practice");
  const lic = (lead.license || "").toUpperCase();
  for (const l of ["LPC", "LCSW", "LMFT", "LMHC", "PSYCHOLOGIST", "PHD", "PSYD"]) if (lic.includes(l)) s.add(`lic_${l.toLowerCase()}`);
  return Array.from(s);
}

export const SEGMENT_LABEL: Record<string, string> = {
  group_owner: "Group owner",
  solo_owner: "Solo owner",
  size_3_15: "3 to 15 clinicians",
  size_16_plus: "16 or more clinicians",
  hiring: "Hiring",
  telehealth: "Telehealth",
  online_booking: "Online booking",
  insurance: "Takes insurance",
  cash_pay: "Cash pay",
  multi_location: "Multiple locations",
  ehr_simplepractice: "Likely SimplePractice",
  ehr_therapynotes: "Likely TherapyNotes",
  ehr_jane: "Likely Jane",
  ehr_therapyappointment: "Likely TherapyAppointment",
  ehr_carepatron: "Likely Carepatron",
  no_website: "No website",
  no_practice: "No practice found",
};
export const segmentLabel = (k: string) => SEGMENT_LABEL[k] ?? (k.startsWith("ehr_") ? `Likely ${k.slice(4)}` : k.startsWith("lic_") ? k.slice(4).toUpperCase() : k);

function saveResearch(orgId: number, lead: ColdLead, sig: Signals, depth: ColdLead["depth"]) {
  const { fit, why } = scoreOf(sig, lead);
  const segs = segmentsOf(sig, lead);
  const notFit = fit < 40 ? (sig.hospitalSystem ? "Works for a hospital or system" : sig.independentFound === false ? "No independent practice found" : null) : null;
  return db.cold.updateLead(lead.id, orgId, {
    practice: sig.practice || lead.practice,
    website: sig.website || lead.website,
    research: JSON.stringify({ ...parse<Record<string, unknown>>(lead.research, {}), signals: sig }),
    researchedAt: new Date(),
    depth,
    fit,
    fitWhy: JSON.stringify(why),
    segments: JSON.stringify(segs),
    ...(notFit && lead.stage === "new" ? { stage: "not_fit" as const, notFitReason: notFit } : {}),
  });
}

/** Research from the practice's own website (cheap: no web search). */
async function researchFromSite(orgId: number, lead: ColdLead): Promise<Signals | null> {
  if (!lead.website) return null;
  let text = "";
  try {
    const home = await fetchWebpage(lead.website);
    text = `${home.url}\n${home.text.slice(0, 14_000)}`;
  } catch {
    return null;
  }
  const emp = await employeeFor(orgId, "outreach");
  const { system } = await systemPromptFor(emp, `Your job now: read one therapy practice's website and fill in the facts below about the practice and this clinician.\n${RESEARCH_RULES}`);
  const sig = await generateJson<Signals>({ system, prompt: `Clinician: ${lead.firstName} ${lead.lastName}, ${lead.license} ${lead.state}\n\nWEBSITE TEXT:\n${text}`, schemaName: "cold_signals", schema: SIGNALS, maxTokens: 2000 });
  return { ...sig, website: sig.website || lead.website, sources: (sig.sources ?? []).length ? sig.sources : [lead.website] };
}

/** Research by web search, five leads at a time. */
async function researchBySearch(orgId: number, leads: ColdLead[]) {
  const emp = await employeeFor(orgId, "outreach");
  const { system } = await systemPromptFor(emp, `Your job now: for each licensed clinician below, find their private practice (if they have one) and fill in the facts about it.\n${RESEARCH_RULES}\n- Match the person by name, license and state. If you can't find a practice for someone, set independentFound false and leave the rest unknown.`);
  const schema: JsonSchema = obj({ leads: arr(obj({ index: int, ...SIGNAL_PROPS })) });
  const prompt = leads.map((l, i) => `${i}. ${l.firstName} ${l.lastName}, ${l.license || "therapist"}${l.city ? `, ${l.city}` : ""}${l.state ? `, ${l.state}` : ""}${l.practice ? `, practice: ${l.practice}` : ""}`).join("\n");
  const r = await searchJson<{ leads: (Signals & { index: number })[] }>({ system, prompt, schemaName: "cold_research", schema, maxUses: Math.min(12, leads.length * 2 + 2), maxTokens: 6000 });
  const found = new Set((r.sources ?? []).map((s) => host(s.url)));
  return (r.data?.leads ?? []).map((x) => {
    // A source that wasn't in the search results doesn't count.
    const sources = (x.sources ?? []).filter((u) => found.has(host(u)));
    return { index: x.index, sig: { ...x, sources, website: x.website && (found.has(host(x.website)) || sources.length) ? x.website : "" } as Signals };
  });
}

function host(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const researching = new Set<number>();
export const isResearching = (orgId: number) => researching.has(orgId);

/** Researches the next best leads (progressive enrichment: a few hundred at a time, best first). */
export async function research(orgId: number, count: number, filter: db.ColdLeadFilter = {}) {
  if (researching.has(orgId)) return { done: 0, scored: 0 };
  researching.add(orgId);
  const emp = await employeeFor(orgId, "outreach");
  let done = 0;
  try {
    await working(emp, async () => {
      const leads = db.cold.toResearch(orgId, Math.min(1000, Math.max(1, count)), filter);
      const noSite: ColdLead[] = [];
      for (const l of leads) {
        try {
          const sig = await researchFromSite(orgId, l);
          if (sig) {
            saveResearch(orgId, l, sig, "researched");
            done++;
          } else noSite.push(l);
        } catch (err) {
          console.warn("[cold] site research skipped:", err instanceof Error ? err.message : err);
          noSite.push(l);
        }
      }
      for (let i = 0; i < noSite.length; i += 5) {
        const group = noSite.slice(i, i + 5);
        try {
          const found = await researchBySearch(orgId, group);
          for (const f of found) {
            const l = group[f.index];
            if (!l) continue;
            saveResearch(orgId, l, f.sig, "researched");
            done++;
          }
        } catch (err) {
          console.warn("[cold] search research skipped:", err instanceof Error ? err.message : err);
        }
      }
    });
  } finally {
    researching.delete(orgId);
  }
  return { done };
}

/** Moderate research when someone replies with interest: their site read again. */
export async function researchOne(orgId: number, leadId: number) {
  const l = db.cold.getLead(leadId, orgId);
  if (!l) return null;
  const sig = (await researchFromSite(orgId, l).catch(() => null)) ?? (await researchBySearch(orgId, [l]).catch(() => []))[0]?.sig ?? null;
  return sig ? saveResearch(orgId, l, sig, "moderate") : l;
}

// ==========================================
// Campaigns
// ==========================================

export const ANGLES = [
  { key: "switcher", name: "EHR switchers", idea: "They likely use another EHR that only runs the clinical side. LeadDash puts the EHR and the growth side (leads, phones, follow-up, the 24/7 receptionist) in one system. Ask if a comparison would help.", who: { segments: ["ehr_simplepractice"], minFit: 60 } },
  { key: "missed_calls", name: "Missed calls after hours", idea: "What happens when someone calls the practice after hours or during a session. Answering, booking and following up.", who: { segments: ["solo_owner"], minFit: 60 } },
  { key: "too_many", name: "Too many systems", idea: "An EHR plus separate phone, CRM, forms, scheduling and email tools. LeadDash puts the practice workflow together.", who: { segments: [], minFit: 60 } },
  { key: "group_ops", name: "Group practice operations", idea: "Once a practice adds clinicians, keeping up with inquiries, follow-up and operations gets messy fast.", who: { segments: ["group_owner"], minFit: 60 } },
  { key: "growing", name: "Growing team, same back office", idea: "They're hiring. They're already investing in growth; can the back office keep up?", who: { segments: ["hiring"], minFit: 60 } },
  { key: "owner_time", name: "Owner time", idea: "Practice owners shouldn't have to be receptionist, marketer, intake coordinator and clinician.", who: { segments: ["solo_owner"], minFit: 50 } },
] as const;
export type AngleKey = (typeof ANGLES)[number]["key"];

export type Who = { segments: string[]; minFit: number; states: string[]; licenses: string[] };
export function whoOf(c: Pick<ColdCampaign, "who">): Who {
  const v = parse<Partial<Who>>(c.who, {});
  return { segments: Array.isArray(v.segments) ? v.segments : [], minFit: typeof v.minFit === "number" ? v.minFit : 60, states: Array.isArray(v.states) ? v.states : [], licenses: Array.isArray(v.licenses) ? v.licenses : [] };
}

export type Step = { day: number; subject: string; subjectB: string; body: string };
export type Test = { variable?: "subject"; winner?: "a" | "b" | null };
export type CampaignStats = { added?: number; sent?: number; bounced?: number; unsubscribed?: number; replies?: number; positive?: number; demos?: number; a?: { replies: number; positive: number }; b?: { replies: number; positive: number }; at?: string };

const DAYS = [1, 4, 8, 13];

const SEQ: JsonSchema = obj({
  name: str,
  offer: { type: "string", description: "The offer, only if one is in the approved facts or the Brain; otherwise ''" },
  ask: { type: "string", description: "The low-pressure question at the end of email 1" },
  emails: arr(obj({ subject: str, subjectB: { type: "string", description: "Email 1 only: a second subject line to test against the first. '' for emails 2 to 4" }, body: { type: "string", description: "The email body: greeting, short paragraphs, the ask. No signature, address or opt-out line (added for you)" } })),
});

function playbookText(orgId: number) {
  const plays = db.cold.playbook.list(orgId);
  const facts = plays.filter((p) => p.kind === "fact").map((p) => `- ${p.title}: ${parse<{ text?: string }>(p.body, {}).text ?? ""}`);
  const never = plays.filter((p) => p.kind === "never").map((p) => `- ${p.title}`);
  return `Approved facts you may state:\n${facts.join("\n") || "- (none yet: use only what the Brain states)"}\nNever say:\n${never.join("\n") || "- (none listed)"}`;
}

const SEQ_JOB = (angle: (typeof ANGLES)[number], who: Who) => `Your job now: write a 4-email cold sequence to licensed therapists who own practices, for the angle below. Jada sends it through Instantly.
Angle: ${angle.name}. ${angle.idea}
Who gets it: ${who.segments.map(segmentLabel).join(", ") || "any researched practice owner"}, fit ${who.minFit}+.
The four emails:
- Email 1 (day 1): the problem, why it's relevant to them, one simple question. The first goal is only to find out if they're the right person or open to a comparison. No calendar link, no feature list, no fake praise.
- Email 2 (day 4): a different angle, never "just following up".
- Email 3 (day 8): the difference or proof, one concrete thing.
- Email 4 (day 13): a short, low-pressure close.
- Each under 90 words. One business owner emailing another. Personalize only with business facts: [first name] and [practice name] are filled in for you. Never personal details.
- Write email 1 a second subject line to test (subjectB). Same body.
- Never claim a price, discount, migration offer, number or result that isn't in the approved facts or the Brain.
${HUMAN_EMAIL}`;

export async function writeCampaign(orgId: number, angleKey: AngleKey, opts: { who?: Partial<Who>; guidance?: string } = {}) {
  settingsOf(orgId);
  const angle = ANGLES.find((a) => a.key === angleKey) ?? ANGLES[0];
  const who: Who = { segments: [...(opts.who?.segments ?? angle.who.segments)], minFit: opts.who?.minFit ?? angle.who.minFit, states: opts.who?.states ?? [], licenses: opts.who?.licenses ?? [] };
  const emp = await employeeFor(orgId, "outreach");
  const { system } = await systemPromptFor(emp, `${SEQ_JOB(angle, who)}\n\n${playbookText(orgId)}\n\n${pricingText(settingsOf(orgId))}`);
  let r = await generateJson<{ name: string; offer: string; ask: string; emails: { subject: string; subjectB: string; body: string }[] }>({ system, prompt: opts.guidance ? `Write it. Also: ${opts.guidance}` : "Write it.", schemaName: "cold_sequence", schema: SEQ, maxTokens: 4000 });
  const tells = findTells(...(r.emails ?? []).flatMap((e) => [e.subject, e.subjectB, e.body]));
  if (tells.length) {
    r = await generateJson({ system, prompt: `Rewrite it. These give it away as written by AI, take every one out: ${tells.join(", ")}.\n\n${JSON.stringify(r)}`, schemaName: "cold_sequence", schema: SEQ, maxTokens: 4000 });
  }
  const emails = (r.emails ?? []).slice(0, 4);
  while (emails.length < 4) emails.push({ subject: "", subjectB: "", body: "" });
  const steps: Step[] = emails.map((e, i) => ({ day: DAYS[i], subject: i === 0 ? e.subject : e.subject || "", subjectB: i === 0 ? e.subjectB || "" : "", body: e.body }));
  const existing = db.cold.campaigns.list(orgId).filter((c) => c.status === "sending").length;
  return db.cold.campaigns.create({
    organizationId: orgId,
    name: (r.name || angle.name).slice(0, 120),
    angle: angle.key,
    who: JSON.stringify(who),
    offer: r.offer ?? "",
    ask: r.ask ?? "",
    steps: JSON.stringify(steps),
    test: JSON.stringify({ variable: steps[0].subjectB ? "subject" : undefined, winner: null } satisfies Test),
    share: existing ? 25 : 100,
    status: "draft",
  });
}

function stepsFor(c: ColdCampaign, footer: string): IStep[] {
  const steps = parse<Step[]>(c.steps, []);
  const test = parse<Test>(c.test, {});
  return steps.map((s, i) => ({
    subject: i === 0 ? s.subject : s.subject || "",
    subjectB: i === 0 && s.subjectB && !test.winner ? s.subjectB : undefined,
    body: `${s.body.trim()}\n\n${footer}`,
    delayDays: i < steps.length - 1 ? Math.max(1, (steps[i + 1].day ?? DAYS[i + 1]) - (s.day ?? DAYS[i])) : 0,
  }));
}

function healthyInboxes(orgId: number) {
  return db.cold.inboxes.list(orgId).filter((i) => i.status === "healthy").map((i) => i.email);
}

/** Starts a campaign in Instantly: the schedule, the 4 emails with the address and opt-out, the healthy inboxes, no tracking. */
export async function startCampaign(orgId: number, id: number) {
  const c = db.cold.campaigns.get(id, orgId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't here." });
  const s = settingsOf(orgId);
  if (!addressOf(s)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Every cold email has to carry your mailing address. Add it in Cold email settings, or check the website, first." });
  const ia = api(orgId);
  if (!db.cold.inboxes.list(orgId).length) await syncInboxes(orgId);
  const inboxes = healthyInboxes(orgId);
  if (!inboxes.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "None of your Instantly inboxes are healthy right now, so nothing can send." });
  const steps = parse<Step[]>(c.steps, []);
  if (steps.some((x, i) => !x.body.trim() || (i === 0 && !x.subject.trim()))) throw new TRPCError({ code: "BAD_REQUEST", message: "Every email needs a body, and email 1 needs a subject." });
  const footer = await footerFor(orgId, s);
  if (c.instantlyId) {
    await ia.patchCampaign(c.instantlyId, { steps: stepsFor(c, footer), inboxes, dailyLimit: inboxes.length * s.perInbox * 2 });
    await ia.activate(c.instantlyId);
  } else {
    const { settings: sales, tz } = await (await import("./sales")).salesSettings(orgId);
    const made = await ia.createCampaign({ name: `${c.name} (Jada)`, tz, from: "08:00", to: "17:00", days: sales.days.length ? sales.days : [1, 2, 3, 4, 5], steps: stepsFor(c, footer), inboxes, dailyLimit: inboxes.length * s.perInbox * 2 });
    await ia.activate(made.id);
    db.cold.campaigns.update(id, orgId, { instantlyId: made.id });
  }
  db.cold.campaigns.update(id, orgId, { status: "sending" });
  normalizeShares(orgId);
  return db.cold.campaigns.get(id, orgId)!;
}

export async function pauseCampaign(orgId: number, id: number) {
  const c = db.cold.campaigns.get(id, orgId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't here." });
  if (c.instantlyId) await api(orgId).pause(c.instantlyId);
  db.cold.campaigns.update(id, orgId, { status: "paused" });
  normalizeShares(orgId);
  return db.cold.campaigns.get(id, orgId)!;
}

/** Shares of the sending campaigns add up to 100. */
function normalizeShares(orgId: number) {
  const sending = db.cold.campaigns.list(orgId).filter((c) => c.status === "sending");
  const total = sending.reduce((a, c) => a + Math.max(0, c.share), 0);
  if (!sending.length || total === 100) return;
  for (const c of sending) db.cold.campaigns.update(c.id, orgId, { share: total ? Math.round((Math.max(0, c.share) / total) * 100) : Math.round(100 / sending.length) });
}

export async function saveCampaign(orgId: number, id: number, input: { name: string; steps: Step[]; who: Who; share: number; offer: string; ask: string }) {
  const c = db.cold.campaigns.get(id, orgId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't here." });
  const steps = input.steps.slice(0, 4).map((x, i) => ({ day: DAYS[i], subject: x.subject.slice(0, 200), subjectB: i === 0 ? x.subjectB.slice(0, 200) : "", body: x.body.slice(0, 4000) }));
  const updated = db.cold.campaigns.update(id, orgId, {
    name: input.name.trim().slice(0, 120) || c.name,
    steps: JSON.stringify(steps),
    who: JSON.stringify({ segments: input.who.segments.slice(0, 6), minFit: Math.min(100, Math.max(0, Math.round(input.who.minFit))), states: input.who.states.slice(0, 20), licenses: input.who.licenses.slice(0, 10) }),
    share: Math.min(100, Math.max(0, Math.round(input.share))),
    offer: input.offer.slice(0, 500),
    ask: input.ask.slice(0, 300),
  })!;
  if (updated.instantlyId && updated.status === "sending") {
    await api(orgId).patchCampaign(updated.instantlyId, { steps: stepsFor(updated, await footerFor(orgId)) });
  }
  normalizeShares(orgId);
  return db.cold.campaigns.get(id, orgId)!;
}

export function removeCampaign(orgId: number, id: number) {
  const c = db.cold.campaigns.get(id, orgId);
  if (!c) return;
  if (c.status === "sending") throw new TRPCError({ code: "BAD_REQUEST", message: "Pause the campaign before removing it." });
  db.cold.campaigns.remove(id, orgId);
}

/** Keeps the winning subject line: the other one is turned off in Instantly. */
export async function pickWinner(orgId: number, id: number, version: "a" | "b") {
  const c = db.cold.campaigns.get(id, orgId);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't here." });
  const steps = parse<Step[]>(c.steps, []);
  if (!steps[0]?.subjectB) throw new TRPCError({ code: "BAD_REQUEST", message: "This campaign has no subject line test." });
  if (version === "b") steps[0] = { ...steps[0], subject: steps[0].subjectB };
  const winnerSubject = steps[0].subject;
  steps[0] = { ...steps[0], subjectB: "" };
  const test = { ...parse<Test>(c.test, {}), winner: version, kept: winnerSubject };
  const updated = db.cold.campaigns.update(id, orgId, { steps: JSON.stringify(steps), test: JSON.stringify(test) })!;
  if (updated.instantlyId) await api(orgId).patchCampaign(updated.instantlyId, { steps: stepsFor(updated, await footerFor(orgId)) });
  return updated;
}

// ==========================================
// Inboxes and the health governor
// ==========================================

const ymd = (d: Date, tz: string) => {
  const p = partsIn(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

async function tzOf(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}

/** Reads the inboxes and their last 7 days from Instantly, and rests any that look unhealthy. */
export async function syncInboxes(orgId: number) {
  const s = settingsOf(orgId);
  const ia = api(orgId);
  const tz = await tzOf(orgId);
  const now = new Date();
  const accounts = await ia.accounts();
  const today = ymd(now, tz);
  const weekAgo = ymd(new Date(now.getTime() - 6 * 86_400_000), tz);
  const p = partsIn(now, tz);
  const monthStart = `${p.y}-${String(p.m).padStart(2, "0")}-01`;
  const daily = await ia.daily(monthStart < weekAgo ? monthStart : weekAgo, today).catch(() => []);
  const existing = new Map(db.cold.inboxes.list(orgId).map((i) => [i.email, i]));
  const changed: { email: string; status: string; reason: string }[] = [];
  for (const a of accounts) {
    const email = a.email.toLowerCase();
    const mine = daily.filter((d) => d.email_account?.toLowerCase() === email);
    const week = mine.filter((d) => d.date >= weekAgo);
    const sent7 = week.reduce((x, d) => x + (d.sent || 0), 0);
    const bounced7 = week.reduce((x, d) => x + (d.bounced || 0), 0);
    const replies7 = week.reduce((x, d) => x + (d.unique_replies ?? d.replies ?? 0), 0);
    const sentToday = mine.filter((d) => d.date === today).reduce((x, d) => x + (d.sent || 0), 0);
    const old = existing.get(email);
    let status = old?.status ?? "healthy";
    let reason = old?.reason ?? null;
    let restedAt = old?.restedAt ?? null;
    if (a.status < 0 || a.status === 2 || a.status === 3) {
      status = "error";
      reason = a.status === -1 ? "Instantly can't connect to this inbox" : a.status === -2 ? "Soft bounces in Instantly" : a.status === -3 ? "Sending error in Instantly" : a.status === 2 ? "Paused in Instantly" : "Under maintenance in Instantly";
    } else if (sent7 >= 20 && (bounced7 / sent7) * 100 > s.bounceRest) {
      if (status !== "resting") restedAt = now;
      status = "resting";
      reason = `Bounces at ${((bounced7 / sent7) * 100).toFixed(1)}%, over your ${s.bounceRest}% limit`;
    } else if (status === "error") {
      status = "healthy";
      reason = null;
    }
    if (old && old.status !== status && status !== "healthy") changed.push({ email, status, reason: reason ?? "" });
    const row = { accountStatus: a.status, warmupScore: a.stat_warmup_score ?? null, sentToday, sent7, bounced7, replies7, status: status as "healthy" | "resting" | "error", reason, restedAt, updatedAt: now };
    if (old) db.cold.inboxes.update(old.id, orgId, row);
    else db.cold.inboxes.create({ organizationId: orgId, email, ...row });
  }
  const monthSent = daily.filter((d) => d.date >= monthStart).reduce((x, d) => x + (d.sent || 0), 0);
  const t = parse<Today>(s.today, {});
  db.cold.saveSettings(orgId, { lastInboxCheckAt: now, keyError: null, today: JSON.stringify({ ...t, month: monthStart, monthSent }) });
  if (changed.length) {
    await useInboxes(orgId);
    const emp = await employeeFor(orgId, "outreach");
    await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `I took ${changed.length === 1 ? "an inbox" : `${changed.length} inboxes`} out of rotation: ${changed.map((c) => `${c.email} (${c.reason})`).join("; ")}. The others keep sending. You can put ${changed.length === 1 ? "it" : "them"} back on the Cold email tab.` });
  }
  return db.cold.inboxes.list(orgId);
}

/** Sending campaigns use only the healthy inboxes. */
async function useInboxes(orgId: number) {
  const s = settingsOf(orgId);
  const inboxes = healthyInboxes(orgId);
  if (!inboxes.length) return;
  for (const c of db.cold.campaigns.list(orgId).filter((x) => x.status === "sending" && x.instantlyId)) {
    await api(orgId).patchCampaign(c.instantlyId!, { inboxes, dailyLimit: inboxes.length * s.perInbox * 2 }).catch((err) => console.warn("[cold] inbox update failed:", err instanceof Error ? err.message : err));
  }
}

export async function resumeInbox(orgId: number, id: number) {
  const i = db.cold.inboxes.get(id, orgId);
  if (!i) throw new TRPCError({ code: "NOT_FOUND", message: "That inbox isn't here." });
  db.cold.inboxes.update(id, orgId, { status: "healthy", reason: null, restedAt: null, bounced7: 0 });
  await useInboxes(orgId);
}

export async function restInbox(orgId: number, id: number) {
  const i = db.cold.inboxes.get(id, orgId);
  if (!i) throw new TRPCError({ code: "NOT_FOUND", message: "That inbox isn't here." });
  db.cold.inboxes.update(id, orgId, { status: "resting", reason: "Rested by you", restedAt: new Date() });
  await useInboxes(orgId);
}

// ==========================================
// Each day's batch
// ==========================================

function weekdaysLeft(now: Date, tz: string) {
  const p = partsIn(now, tz);
  const last = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
  let n = 0;
  for (let d = p.d; d <= last; d++) {
    const wd = new Date(Date.UTC(p.y, p.m - 1, d)).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return Math.max(1, n);
}

const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-${Math.ceil(((t.getTime() - y.getTime()) / 86_400_000 + 1) / 7)}`;
};

/** How many new leads can go to Instantly today, and what limits it. */
export async function budget(orgId: number, now = new Date()) {
  const s = settingsOf(orgId);
  const tz = await tzOf(orgId);
  const t = parse<Today>(s.today, {});
  const healthy = healthyInboxes(orgId).length;
  const counts = db.cold.leadCounts(orgId);
  const monthSent = t.month === `${partsIn(now, tz).y}-${String(partsIn(now, tz).m).padStart(2, "0")}-01` ? (t.monthSent ?? 0) : 0;
  const emailsLeft = Math.max(0, s.emailsLimit - monthSent);
  // Each new lead gets up to 4 emails over 13 days.
  const byPlan = Math.floor(emailsLeft / weekdaysLeft(now, tz) / 4);
  const byInboxes = healthy * s.perInbox;
  const byContacts = Math.max(0, Math.min(s.contactsLimit - counts.inInstantly, s.remainingInPlan ?? Number.MAX_SAFE_INTEGER));
  const ramp = s.dailyNew > 0 ? s.dailyNew : Math.ceil(byInboxes / 2);
  const today = ymd(now, tz);
  const addedToday = t.date === today ? (t.added ?? 0) : 0;
  const cap = Math.min(byPlan, byInboxes, byContacts, ramp);
  const limitedBy = cap === byContacts ? "contacts" : cap === byPlan ? "plan" : cap === byInboxes ? "inboxes" : "ramp";
  return { cap, left: Math.max(0, cap - addedToday), addedToday, byPlan, byInboxes, byContacts, ramp, healthy, monthSent, emailsLeft, limitedBy, inboxCapacityMonth: healthy * s.perInbox * 22 * 2 };
}

/** Sends today's new leads to Instantly, split across the sending campaigns by share. */
export async function feed(orgId: number, now = new Date()) {
  const s = settingsOf(orgId);
  if (s.paused || !keyOf(s)) return { added: 0 };
  const tz = await tzOf(orgId);
  // The ramp moves up once a week while every inbox stays healthy.
  const t = parse<Today>(s.today, {});
  const week = isoWeek(now);
  if (t.week !== week) {
    const inboxes = db.cold.inboxes.list(orgId);
    const healthyAll = inboxes.length > 0 && inboxes.every((i) => i.status === "healthy");
    const base = s.dailyNew > 0 ? s.dailyNew : Math.ceil((healthyInboxes(orgId).length * s.perInbox) / 2);
    const next = t.week && healthyAll ? Math.ceil(base * (1 + s.rampPct / 100)) : base;
    db.cold.saveSettings(orgId, { dailyNew: next, today: JSON.stringify({ ...t, week }) });
  }
  const b = await budget(orgId, now);
  if (b.left <= 0) return { added: 0 };
  const sending = db.cold.campaigns.list(orgId).filter((c) => c.status === "sending" && c.instantlyId);
  if (!sending.length) return { added: 0 };
  const ia = api(orgId);
  let added = 0;
  const totalShare = sending.reduce((a, c) => a + Math.max(0, c.share), 0) || 1;
  for (const c of sending) {
    const n = Math.floor((b.left * Math.max(0, c.share)) / totalShare);
    if (n <= 0) continue;
    const who = whoOf(c);
    // The first segment filters in the database; the rest here.
    const pool = db.cold.readyFor(orgId, who.minFit, { segment: who.segments[0], state: who.states.length === 1 ? who.states[0] : undefined }, n * 3);
    const picked = pool.filter((l) => {
      const segs = parse<string[]>(l.segments, []);
      return who.segments.slice(1).every((x) => segs.includes(x)) && (!who.states.length || who.states.map((x) => x.toUpperCase()).includes(l.state.toUpperCase())) && (!who.licenses.length || who.licenses.some((x) => l.license.toUpperCase().includes(x.toUpperCase())));
    }).slice(0, n);
    for (let i = 0; i < picked.length; i += 1000) {
      const chunk = picked.slice(i, i + 1000);
      const res = await ia.addLeads(c.instantlyId!, chunk.map((l) => ({ email: l.email, first_name: l.firstName, last_name: l.lastName, company_name: l.practice || undefined, website: l.website || undefined, custom_variables: { city: l.city || null, fit: l.fit ?? null } })));
      const ids = new Map((res.created_leads ?? []).map((x) => [(x.email ?? "").toLowerCase(), x.id]));
      for (const l of chunk) {
        const id = ids.get(l.email);
        if (id || !res.created_leads) {
          db.cold.updateLead(l.id, orgId, { stage: "in_campaign", campaignId: c.id, instantlyLeadId: id ?? null, addedAt: now });
          added++;
        } else {
          db.cold.updateLead(l.id, orgId, { stage: "finished", campaignId: c.id, finishedAt: now, notFitReason: "Instantly skipped it: already in your Instantly workspace or block list" });
        }
      }
      if (typeof res.remaining_in_plan === "number") db.cold.saveSettings(orgId, { remainingInPlan: res.remaining_in_plan });
    }
  }
  const today = ymd(now, tz);
  const t2 = parse<Today>(settingsOf(orgId).today, {});
  db.cold.saveSettings(orgId, { lastFeedAt: now, today: JSON.stringify({ ...t2, date: today, added: (t2.date === today ? (t2.added ?? 0) : 0) + added }) });
  return { added };
}

/** Finished sequences come out of Instantly so their contact slots free up for new leads. */
export async function cleanup(orgId: number, now = new Date()) {
  const s = settingsOf(orgId);
  if (!keyOf(s)) return { removed: 0 };
  const ia = api(orgId);
  let removed = 0;
  const done = db.cold.finishedInInstantly(orgId, new Date(now.getTime() - 18 * 86_400_000));
  for (const l of done) {
    if (l.instantlyLeadId) await ia.deleteLead(l.instantlyLeadId).catch((err) => console.warn("[cold] delete lead failed:", err instanceof Error ? err.message : err));
    db.cold.updateLead(l.id, orgId, { stage: "finished", finishedAt: now, instantlyLeadId: null });
    removed++;
  }
  // Replied and do-not-contact leads come out two weeks after their last reply was handled.
  for (const stage of ["replied", "dnc", "booked"] as const) {
    for (const l of db.cold.leadsByStage(orgId, stage)) {
      if (!l.instantlyLeadId || !l.updatedAt || l.updatedAt.getTime() > now.getTime() - 14 * 86_400_000) continue;
      await ia.deleteLead(l.instantlyLeadId).catch(() => null);
      db.cold.updateLead(l.id, orgId, { instantlyLeadId: null });
      removed++;
    }
  }
  return { removed };
}

export async function stopLead(orgId: number, leadId: number) {
  const l = db.cold.getLead(leadId, orgId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That lead isn't on the list." });
  if (l.instantlyLeadId) await api(orgId).deleteLead(l.instantlyLeadId).catch(() => null);
  return db.cold.updateLead(leadId, orgId, { stage: "finished", finishedAt: new Date(), instantlyLeadId: null, notFitReason: "Stopped by you" });
}

/** Do not contact: here, in every campaign, and on Instantly's block list. */
export async function doNotContact(orgId: number, email: string, reason: string) {
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e)) throw new TRPCError({ code: "BAD_REQUEST", message: `"${email}" isn't an email address.` });
  const l = db.cold.leadByEmail(orgId, e);
  db.cold.suppress(orgId, e, reason);
  const s = settingsOf(orgId);
  if (keyOf(s)) {
    const ia = api(orgId);
    await ia.block(e).catch((err) => console.warn("[cold] block failed:", err instanceof Error ? err.message : err));
    if (l?.instantlyLeadId) await ia.deleteLead(l.instantlyLeadId).catch(() => null);
  }
  if (l) db.cold.updateLead(l.id, orgId, { stage: "dnc", instantlyLeadId: null });
}

// ==========================================
// The weekly review
// ==========================================

export type Change = { kind: "share" | "pause" | "winner"; campaignId: number; share?: number; version?: "a" | "b"; why: string };

/** Stats per campaign from the list and replies, plus Instantly's sent and bounce counts. */
export async function refreshStats(orgId: number) {
  const camps = db.cold.campaigns.list(orgId);
  const replies = db.cold.replies.list(orgId);
  const counts = new Map(db.cold.campaignLeadCounts(orgId).map((r) => [r.campaignId, r.n]));
  const analytics = keyOf(settingsOf(orgId)) ? await api(orgId).campaignAnalytics().catch(() => []) : [];
  const booked = db.cold.leadsByStage(orgId, "booked", 5000);
  const positive = (k: string) => k === "hot" || k === "interested" || k === "demo";
  for (const c of camps) {
    const mine = replies.filter((r) => r.campaignId === c.id && r.kind !== "ooo");
    const a = analytics.find((x) => x.campaign_id === c.instantlyId);
    const v = (x: "a" | "b") => ({ replies: mine.filter((r) => r.variant === x).length, positive: mine.filter((r) => r.variant === x && positive(r.kind)).length });
    const stats: CampaignStats = {
      added: counts.get(c.id) ?? 0,
      sent: a?.emails_sent_count ?? 0,
      bounced: a?.bounced_count ?? 0,
      unsubscribed: a?.unsubscribed_count ?? 0,
      replies: mine.length,
      positive: mine.filter((r) => positive(r.kind)).length,
      demos: booked.filter((l) => l.campaignId === c.id).length,
      a: v("a"),
      b: v("b"),
      at: new Date().toISOString(),
    };
    db.cold.campaigns.update(c.id, orgId, { stats: JSON.stringify(stats) });
  }
  return db.cold.campaigns.list(orgId);
}

function segmentStats(orgId: number) {
  const rows = db.cold.segmentCounts(orgId);
  const out = new Map<string, { added: number; replies: number; positive: number; booked: number }>();
  for (const r of rows) {
    for (const seg of parse<string[]>(r.segments, [])) {
      const x = out.get(seg) ?? { added: 0, replies: 0, positive: 0, booked: 0 };
      x.added++;
      if (r.lastReplyKind && r.lastReplyKind !== "ooo") x.replies++;
      if (r.lastReplyKind && ["hot", "interested", "demo"].includes(r.lastReplyKind)) x.positive++;
      if (r.stage === "booked") x.booked++;
      out.set(seg, x);
    }
  }
  return Array.from(out.entries()).filter(([, x]) => x.added >= 20).map(([seg, x]) => ({ segment: segmentLabel(seg), ...x }));
}

const REVIEW: JsonSchema = obj({
  points: arr({ type: "string", description: "One observation, with the numbers behind it" }),
  changes: arr(obj({ kind: { type: "string", enum: ["share", "pause", "winner"] }, campaignId: int, share: { type: "integer", description: "share only: the new percent of daily new emails" }, version: { type: "string", enum: ["a", "b", ""], description: "winner only" }, why: str })),
});

/** Monday: what worked, with the numbers, and at most a few changes, one variable at a time. */
export async function weeklyReview(orgId: number) {
  const camps = (await refreshStats(orgId)).filter((c) => c.status !== "draft");
  if (!camps.some((c) => (parse<CampaignStats>(c.stats, {}).added ?? 0) > 0)) return null;
  const emp = await employeeFor(orgId, "outreach");
  const data = {
    campaigns: camps.map((c) => ({ id: c.id, name: c.name, status: c.status, share: c.share, who: whoOf(c).segments.map(segmentLabel), test: parse<Step[]>(c.steps, [])[0]?.subjectB ? { a: parse<Step[]>(c.steps, [])[0].subject, b: parse<Step[]>(c.steps, [])[0].subjectB } : null, ...parse<CampaignStats>(c.stats, {}) })),
    segments: segmentStats(orgId),
  };
  const { system } = await systemPromptFor(
    emp,
    `Your job now: the weekly cold email review, like a sales manager reading the numbers.
- 3 to 5 points. Each states a finding with its numbers (replies, positive replies, demos, per campaign, per segment, per subject line). Never a number that isn't in the data.
- Then at most 3 changes. share: move volume toward what books demos (shares of sending campaigns add to 100). pause: a campaign with 400+ added and almost no positive replies. winner: a subject line test only when both versions have about 500 sends (the campaign has 1,000+ added), keeping the one with more positive replies.
- Change one thing at a time so the results stay readable. If there isn't enough data yet, say so and propose no changes.`
  );
  const r = await generateJson<{ points: string[]; changes: Change[] }>({ system, prompt: JSON.stringify(data), schemaName: "cold_review", schema: REVIEW, maxTokens: 2500 });
  const ids = new Set(camps.map((c) => c.id));
  const changes = (r.changes ?? [])
    .filter((x) => ids.has(x.campaignId))
    .filter((x) => x.kind !== "winner" || ((parse<CampaignStats>(camps.find((c) => c.id === x.campaignId)!.stats, {}).added ?? 0) >= 1000 && !!parse<Step[]>(camps.find((c) => c.id === x.campaignId)!.steps, [])[0]?.subjectB && (x.version === "a" || x.version === "b")))
    .slice(0, 3)
    .map((x) => ({ kind: x.kind, campaignId: x.campaignId, why: x.why, ...(x.kind === "share" ? { share: Math.min(100, Math.max(0, x.share ?? 0)) } : {}), ...(x.kind === "winner" ? { version: x.version } : {}) }));
  const review = db.cold.reviews.create({ organizationId: orgId, points: JSON.stringify((r.points ?? []).slice(0, 5)), changes: JSON.stringify(changes), status: changes.length ? "waiting" : "applied" });
  db.cold.saveSettings(orgId, { lastReviewAt: new Date() });
  const auto = settingsOf(orgId).level >= 3 && changes.length > 0;
  if (auto) await applyReview(orgId, review.id);
  await db.createChatMessage({
    organizationId: orgId,
    employeeId: emp.id,
    role: "employee",
    authorName: emp.name,
    content: changes.length ? (auto ? "Weekly review is up. At your level I made the changes; they're listed below and on the Cold email tab." : "Weekly review is up. Approve the changes on the card or on the Cold email tab, or tell me no.") : "Weekly review is up. Not enough has changed to move anything yet.",
    cards: JSON.stringify([{ type: "cold_review", id: review.id, title: "Weekly review" }]),
  });
  return db.cold.reviews.get(review.id, orgId);
}

export async function applyReview(orgId: number, id: number) {
  const r = db.cold.reviews.get(id, orgId);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That review isn't here." });
  for (const ch of parse<Change[]>(r.changes, [])) {
    const c = db.cold.campaigns.get(ch.campaignId, orgId);
    if (!c) continue;
    if (ch.kind === "share" && typeof ch.share === "number") db.cold.campaigns.update(c.id, orgId, { share: ch.share });
    if (ch.kind === "pause" && c.status === "sending") await pauseCampaign(orgId, c.id).catch(() => null);
    if (ch.kind === "winner" && ch.version) await pickWinner(orgId, c.id, ch.version).catch(() => null);
  }
  normalizeShares(orgId);
  db.cold.reviews.update(id, orgId, { status: "applied" });
}

export function dismissReview(orgId: number, id: number) {
  db.cold.reviews.update(id, orgId, { status: "dismissed" });
}

// ==========================================
// The playbook
// ==========================================

type ObjectionBody = { meaning: string; goal: string; facts: string; never: string; escalate: string; example: string; level?: number };
type BattleBody = { doesWell: string; differs: string; dontClaim: string; whySwitch: string; questions: string };

const OBJECTIONS: [string, ObjectionBody][] = [
  ["We already use SimplePractice", { meaning: "Not a no. They think they already have the core tool.", goal: "Don't knock SimplePractice. Show LeadDash covers what happens outside the clinical record.", facts: "The EHR, lead follow-up, phones and the 24/7 receptionist live in one system with one login.", never: "Never say LeadDash is better than SimplePractice. No claims about their price or features.", escalate: "They ask for a feature comparison in writing, or mention a contract end date.", example: "Totally fair. Most practices we talk to already have an EHR. The difference with LeadDash is that the EHR, lead follow-up, phones and the 24/7 receptionist live together. If SimplePractice handles everything you need, switching probably wouldn't make sense. If you're still paying for other tools around it, that's where the comparison gets interesting." }],
  ["How much does it cost?", { meaning: "A buying signal.", goal: "Give the price from the website, then offer to compare it against their whole stack.", facts: "Prices come from the website only.", never: "Don't hide the price behind a call. No discounts unless the owner approves.", escalate: "More than 20 clinicians, or they ask for a discount.", example: "For a practice your size it's [the plan and price from the website]. Most practices compare it against everything it replaces, not just the EHR. Want me to send that side by side?" }],
  ["Not interested", { meaning: "Respect it.", goal: "Close the loop in one line. They go on do not contact.", facts: "", never: "Never argue or ask why.", escalate: "", example: "No problem, I'll close the loop. Thanks for letting me know." }],
  ["We're happy with what we have", { meaning: "No pain felt right now.", goal: "Agree, and leave one question about the tools around their EHR.", facts: "", never: "Never push.", escalate: "", example: "Makes sense. If it's doing what you need, switching for the sake of switching wouldn't be worth it. The practices that usually talk to us are juggling a few other systems around the EHR. If that isn't you, you're in good shape." }],
  ["Switching sounds like a nightmare", { meaning: "Fear of migration.", goal: "Say plainly what LeadDash does to move them, from the Brain only.", facts: "", never: "No promises of a timeline or a free migration unless the Brain or playbook states it.", escalate: "They ask what it costs to move.", example: "That's the most common worry we hear. Want me to walk you through exactly what moving looks like for a practice like yours?" }],
  ["My team won't learn a new system", { meaning: "Adoption worry.", goal: "Offer training and show role-based views on a call.", facts: "", never: "", escalate: "", example: "Fair concern. Each person only sees what their role needs, and we train the team. Want to see what your front desk would see?" }],
  ["Is it HIPAA compliant?", { meaning: "A real question that needs an exact answer.", goal: "Answer only from the Brain. Anything about a BAA goes to the owner.", facts: "", never: "No compliance claims beyond what the Brain states.", escalate: "Always, when they ask about a BAA, security review or audit.", example: "" }],
  ["We're too busy right now", { meaning: "Timing, not a no.", goal: "Ask when would be better and follow up then.", facts: "", never: "", escalate: "", example: "Totally get it. When would be a better time to look at this? I'll check back then." }],
  ["We're changing systems next year", { meaning: "Not now, with a date.", goal: "Get the month and follow up then.", facts: "", never: "", escalate: "", example: "Good to know. What month are you starting to look? I'll reach back out then." }],
  ["No budget", { meaning: "Price compared to the EHR line only.", goal: "Offer the total-stack comparison, once.", facts: "", never: "No discounts.", escalate: "", example: "Understood. If it helps later, I can show what LeadDash would replace so you can compare the whole cost, not just the EHR." }],
];

const BATTLES: [string, BattleBody][] = [
  ["SimplePractice", { doesWell: "A widely used clinical EHR for private practice.", differs: "LeadDash keeps the EHR and the growth side (leads, phones, follow-up, the 24/7 receptionist) in one system.", dontClaim: "Their prices, missing features, or anything not confirmed from their own site.", whySwitch: "Paying for separate tools around the EHR, or leads falling through between them.", questions: "What do you use besides SimplePractice for calls, leads and follow-up?" }],
  ["TherapyNotes", { doesWell: "A widely used clinical EHR with billing.", differs: "The growth side lives in LeadDash too: leads, phones and follow-up.", dontClaim: "Their prices or missing features.", whySwitch: "Separate tools for phones and leads.", questions: "How do new inquiries get from your phone or website into TherapyNotes?" }],
  ["Jane", { doesWell: "Scheduling and practice management across health professions.", differs: "LeadDash is built for behavioral health, with lead follow-up and phones in the same place.", dontClaim: "Their prices or missing features.", whySwitch: "Wanting a system made for therapy practices.", questions: "What happens to people who inquire but don't book right away?" }],
  ["TherapyAppointment", { doesWell: "A therapy EHR with scheduling and billing.", differs: "The marketing and lead side are in LeadDash too.", dontClaim: "Their prices or missing features.", whySwitch: "Separate marketing and phone tools.", questions: "How are you following up with new inquiries today?" }],
  ["Carepatron", { doesWell: "Practice management with a client portal.", differs: "LeadDash adds the 24/7 receptionist, phones and lead follow-up in one login.", dontClaim: "Their prices or missing features.", whySwitch: "Calls and leads handled outside the EHR.", questions: "When someone calls after hours, what happens now?" }],
];

const NEVER = ["I hope this message finds you well", "I came across your impressive practice", "I wanted to reach out because", "Anything about the prospect's personal life, family or social media", "Insulting or comparing down a competitor", "A price, discount, result or statistic that isn't in the playbook, the Brain or the website", "Anything about a client or patient"];

export function seedPlaybook(orgId: number) {
  if (db.cold.playbook.list(orgId).length) return;
  for (const [title, body] of OBJECTIONS) db.cold.playbook.create({ organizationId: orgId, kind: "objection", title, body: JSON.stringify(body) });
  for (const [title, body] of BATTLES) db.cold.playbook.create({ organizationId: orgId, kind: "battle", title, body: JSON.stringify(body) });
  for (const title of NEVER) db.cold.playbook.create({ organizationId: orgId, kind: "never", title, body: "{}" });
}

export function savePlay(orgId: number, input: { id?: number; kind: ColdPlay["kind"]; title: string; body: Record<string, unknown> }) {
  settingsOf(orgId);
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Give it a title." });
  const body = JSON.stringify(input.body);
  if (input.id) {
    const p = db.cold.playbook.get(input.id, orgId);
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That isn't in the playbook." });
    return db.cold.playbook.update(input.id, orgId, { title, body })!;
  }
  return db.cold.playbook.create({ organizationId: orgId, kind: input.kind, title, body });
}

export function removePlay(orgId: number, id: number) {
  db.cold.playbook.remove(id, orgId);
}

export function playbookView(orgId: number) {
  settingsOf(orgId);
  return db.cold.playbook.list(orgId).sort((a, b) => a.id - b.id).map((p) => ({ id: p.id, kind: p.kind, title: p.title, body: parse<Record<string, string>>(p.body, {}) }));
}

// ==========================================
// Views
// ==========================================

export const fmtDay = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export async function overview(orgId: number) {
  const s = settingsOf(orgId);
  const connected = !!keyOf(s);
  const counts = db.cold.leadCounts(orgId);
  const b = connected ? await budget(orgId) : null;
  const replies = db.cold.replies.list(orgId);
  const tz = await tzOf(orgId);
  const p = partsIn(new Date(), tz);
  const monthStart = new Date(Date.UTC(p.y, p.m - 1, 1));
  const booked = db.cold.leadsByStage(orgId, "booked", 5000).filter((l) => l.bookedFor && l.bookedFor >= monthStart);
  const site = siteOf(s);
  const review = db.cold.reviews.list(orgId)[0] ?? null;
  const { ENV } = await import("../_core/env");
  return {
    connected,
    keyError: s.keyError,
    paused: s.paused,
    plan: { key: s.plan as PlanKey, name: s.plan in PLANS ? PLANS[s.plan as keyof typeof PLANS].name : "Custom", contacts: s.contactsLimit, emails: s.emailsLimit },
    inInstantly: counts.inInstantly,
    budget: b,
    followUpsToday: db.cold.inboxes.list(orgId).reduce((a, i) => a + i.sentToday, 0),
    repliesOpen: replies.filter((r) => r.status === "open").length,
    hotOpen: replies.filter((r) => r.status === "open" && (r.kind === "hot" || r.kind === "demo")).length,
    bookedThisMonth: booked.length,
    precallReady: db.cold.precall.list(orgId).filter((r) => r.status === "ready").length,
    inboxes: db.cold.inboxes.list(orgId).sort((a, b2) => (a.status === b2.status ? a.email.localeCompare(b2.email) : a.status === "healthy" ? 1 : -1)),
    review: review ? { id: review.id, at: review.createdAt, points: parse<string[]>(review.points, []), changes: parse<Change[]>(review.changes, []).map((c) => ({ ...c, campaign: db.cold.campaigns.get(c.campaignId, orgId)?.name ?? "" })), status: review.status } : null,
    settings: {
      level: s.level,
      levelText: LEVEL_TEXT[s.level],
      perInbox: s.perInbox,
      rampPct: s.rampPct,
      bounceRest: s.bounceRest,
      signature: s.signature,
      address: s.address,
      addressUsed: addressOf(s),
      optOut: s.optOut,
      alwaysNeedsYou: s.alwaysNeedsYou,
      website: s.website,
      site,
      siteCheckedAt: s.siteCheckedAt,
      siteError: s.siteError,
      hookUrl: s.hookToken ? `${ENV.appUrl}/hooks/instantly/${s.hookToken}` : "",
    },
    suppress: db.cold.suppressCount(orgId),
    lastInboxCheckAt: s.lastInboxCheckAt,
    researching: researching.has(orgId),
  };
}

export function leadView(l: ColdLead) {
  const research = parse<{ signals?: Signals }>(l.research, {});
  return {
    id: l.id,
    name: `${l.firstName} ${l.lastName}`.trim() || l.email,
    firstName: l.firstName,
    email: l.email,
    license: l.license,
    licenseStatus: l.licenseStatus,
    state: l.state,
    city: l.city,
    practice: l.practice,
    website: l.website,
    source: l.source,
    fit: l.fit,
    fitWhy: parse<{ label: string; points: number }[]>(l.fitWhy, []),
    segments: parse<string[]>(l.segments, []).map((k) => ({ key: k, label: segmentLabel(k) })),
    depth: l.depth,
    researchedAt: l.researchedAt,
    signals: research.signals ?? null,
    stage: l.stage,
    notFitReason: l.notFitReason,
    campaignId: l.campaignId,
    campaign: l.campaignId ? (db.cold.campaigns.get(l.campaignId, l.organizationId)?.name ?? "") : "",
    addedAt: l.addedAt,
    lastReplyKind: l.lastReplyKind,
    followUpAt: l.followUpAt,
    followUpNote: l.followUpNote,
    bookedFor: l.bookedFor,
  };
}

export function leadsView(orgId: number, f: db.ColdLeadFilter, page: number) {
  settingsOf(orgId);
  const size = 50;
  return { counts: db.cold.leadCounts(orgId), total: db.cold.countLeads(orgId, f), page, size, rows: db.cold.pageLeads(orgId, f, size, page * size).map(leadView), suppress: db.cold.suppressCount(orgId) };
}

export function campaignView(c: ColdCampaign) {
  return {
    id: c.id,
    name: c.name,
    angle: c.angle,
    angleName: ANGLES.find((a) => a.key === c.angle)?.name ?? c.angle,
    who: whoOf(c),
    whoText: (() => {
      const w = whoOf(c);
      return [w.segments.map(segmentLabel).join(", ") || "Any owner", `fit ${w.minFit}+`, w.states.join(", ")].filter(Boolean).join(", ");
    })(),
    offer: c.offer,
    ask: c.ask,
    steps: parse<Step[]>(c.steps, []),
    test: parse<Test & { kept?: string }>(c.test, {}),
    share: c.share,
    status: c.status,
    inInstantly: !!c.instantlyId,
    stats: parse<CampaignStats>(c.stats, {}),
    createdAt: c.createdAt,
  };
}

export function campaignsView(orgId: number) {
  settingsOf(orgId);
  const counts = new Map(db.cold.campaignLeadCounts(orgId).map((r) => [r.campaignId, r.n]));
  const rank = { sending: 0, paused: 1, draft: 2, done: 3 } as const;
  return db.cold.campaigns
    .list(orgId)
    .sort((a, b) => rank[a.status] - rank[b.status] || a.id - b.id)
    .map((c) => {
      const v = campaignView(c);
      return { ...v, stats: { ...v.stats, added: Math.max(counts.get(c.id) ?? 0, v.stats.added ?? 0) } };
    });
}

/** Facts for Jada's chat. */
export async function coldFacts(orgId: number) {
  const s = db.cold.getSettings(orgId);
  if (!s) return "\nCold email: not set up yet. The owner connects Instantly with an API key in Cold email settings and adds her lead list on the Lead list tab.";
  const c = db.cold.leadCounts(orgId);
  const camps = campaignsView(orgId);
  const open = db.cold.replies.list(orgId).filter((r) => r.status === "open");
  return `\nCold email (Instantly ${keyOf(s) ? "connected" : "not connected"}, ${LEVEL_TEXT[s.level]}${s.paused ? " Sending is paused." : ""}):
- Lead list: ${c.total} leads; fit 80+: ${c.top}; 60 to 79: ${c.mid}; 40 to 59: ${c.test}; under 40 or unscored: ${c.low}; do not contact: ${c.dnc}; in Instantly now: ${c.inInstantly}; not researched yet: ${c.unresearched}.
- Plan: ${s.plan}, ${s.contactsLimit} contacts and ${s.emailsLimit} emails a month.
- Campaigns: ${camps.map((x) => `${x.name} (${x.status}, ${x.share}% share, ${x.stats.added ?? 0} added, ${x.stats.replies ?? 0} replies, ${x.stats.positive ?? 0} positive, ${x.stats.demos ?? 0} demos)`).join("; ") || "none yet"}.
- Replies waiting for the owner: ${open.length}.
${pricingText(s)}
Angles you can write a campaign for: ${ANGLES.map((a) => `${a.key} (${a.name})`).join(", ")}.`;
}

// ==========================================
// The clock
// ==========================================

const jobs = new Set<string>();
/** Runs a job in the background once at a time per key. */
export function job(key: string, fn: () => Promise<unknown>) {
  if (jobs.has(key)) return false;
  jobs.add(key);
  void fn()
    .catch((err) => console.warn(`[cold] ${key} failed:`, err instanceof Error ? err.message : err))
    .finally(() => jobs.delete(key));
  return true;
}

let lastReplies = 0;
let lastHourly = 0;

/** Called every minute by the runner. */
export async function coldTicks(now = new Date()) {
  const replies = now.getTime() - lastReplies >= 5 * 60_000;
  const hourly = now.getTime() - lastHourly >= 60 * 60_000;
  if (!replies && !hourly) return;
  if (replies) lastReplies = now.getTime();
  if (hourly) lastHourly = now.getTime();
  for (const orgId of db.cold.orgsWithKey()) {
    const s = settingsOf(orgId);
    const tz = await tzOf(orgId);
    const p = partsIn(now, tz);
    const today = ymd(now, tz);
    if (replies) job(`replies-${orgId}`, async () => (await import("./coldreply")).checkReplies(orgId));
    if (!hourly) continue;
    job(`inboxes-${orgId}`, async () => {
      await syncInboxes(orgId);
      await cleanup(orgId, now);
    });
    job(`precall-${orgId}`, async () => (await import("./precall")).refreshDue(orgId, now));
    const weekday = p.wd >= 1 && p.wd <= 5;
    if (weekday && p.h >= 8 && (!s.lastFeedAt || ymd(s.lastFeedAt, tz) !== today)) job(`feed-${orgId}`, () => feed(orgId, now));
    if (p.h >= 9 && p.h < 17) job(`followups-${orgId}`, async () => (await import("./coldreply")).followUpsDue(orgId, now));
    if (p.wd === 1 && p.h >= 8 && (!s.lastReviewAt || now.getTime() - s.lastReviewAt.getTime() > 5 * 86_400_000)) job(`review-${orgId}`, () => weeklyReview(orgId));
    if (!s.siteCheckedAt || (p.wd === 1 && now.getTime() - s.siteCheckedAt.getTime() > 5 * 86_400_000)) job(`site-${orgId}`, () => refreshSite(orgId));
  }
}
