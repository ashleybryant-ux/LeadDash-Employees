import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, OutboundItem, SalesLead, SalesProspect } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { generateJson, searchJson, type JsonSchema } from "../_core/llm";
import * as integrations from "../integrations";
import { notify } from "../notify";
import { afterSent, localParts, postNow } from "../social";
import { partsIn, zonedToUtc } from "./schedule";
import { HUMAN_EMAIL, findTells } from "./human";
import { actor, employeeFor, systemPromptAbout, systemPromptFor, withRealSource, working } from "./tasks";
import { gate, handoff, logActivity, workLink } from "./team";
import { NPI_HOST, npiKinds, npiPractices, parseArea, type NpiPractice } from "./npi";

/**
 * The sales team.
 * - Riley finds businesses that fit what the workspace sells (or referral
 *   partners for a practice) and passes good fits to Jada.
 * - Jada writes a 3-email sequence for each and sends it from Gmail. A
 *   sequence stops when they book through the link or someone presses Replied.
 * - Malik answers new leads from the lead form or a LeadDash platform
 *   workflow, offers open times from Google Calendar, and books the meeting.
 *
 * What each one does without asking is set on its Onboarding tab (team.ts).
 * A practice's client inquiries always wait for approval: they can carry
 * health information.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });

// ==========================================
// Settings
// ==========================================

export const PARTNER_TYPES = ["Schools", "Pediatric offices", "Primary care", "Employee assistance programs", "Family law attorneys", "Churches"] as const;

export type SalesSettings = {
  sells: "software" | "therapy";
  partnerTypes: string[];
  area: string;
  token: string;
  meetingMinutes: number;
  hoursFrom: string; // "09:00"
  hoursTo: string; // "16:00"
  days: number[]; // 0-6
  linkedin: LinkedInSettings;
};

/** Jada's LinkedIn step: she finds the owner's profile and writes the note; the owner sends it. */
export type LinkedInSettings = { on: boolean; when: "next_day" | "same_day"; note: boolean };
const LINKEDIN_DEFAULTS: LinkedInSettings = { on: true, when: "next_day", note: true };

const DEFAULTS: Omit<SalesSettings, "token"> = { sells: "therapy", partnerTypes: ["Schools", "Pediatric offices"], area: "", meetingMinutes: 30, hoursFrom: "09:00", hoursTo: "16:00", days: [1, 2, 3, 4, 5], linkedin: LINKEDIN_DEFAULTS };

export function readSales(raw: string | null | undefined): SalesSettings {
  let v: Partial<SalesSettings> = {};
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    v = {};
  }
  return {
    sells: v.sells === "software" ? "software" : DEFAULTS.sells,
    partnerTypes: Array.isArray(v.partnerTypes) ? v.partnerTypes.filter((x) => (PARTNER_TYPES as readonly string[]).includes(x)) : DEFAULTS.partnerTypes,
    area: typeof v.area === "string" ? v.area : DEFAULTS.area,
    token: typeof v.token === "string" ? v.token : "",
    meetingMinutes: [15, 30, 45].includes(Number(v.meetingMinutes)) ? Number(v.meetingMinutes) : DEFAULTS.meetingMinutes,
    hoursFrom: /^\d{2}:\d{2}$/.test(v.hoursFrom ?? "") ? v.hoursFrom! : DEFAULTS.hoursFrom,
    hoursTo: /^\d{2}:\d{2}$/.test(v.hoursTo ?? "") ? v.hoursTo! : DEFAULTS.hoursTo,
    days: Array.isArray(v.days) ? v.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : DEFAULTS.days,
    linkedin: {
      on: typeof v.linkedin?.on === "boolean" ? v.linkedin.on : LINKEDIN_DEFAULTS.on,
      when: v.linkedin?.when === "same_day" ? "same_day" : "next_day",
      note: typeof v.linkedin?.note === "boolean" ? v.linkedin.note : LINKEDIN_DEFAULTS.note,
    },
  };
}

export async function salesSettings(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That workspace was not found." });
  const s = readSales(org.sales);
  if (!s.token) {
    s.token = crypto.randomBytes(18).toString("base64url");
    await db.updateOrganization(orgId, { sales: JSON.stringify(s) });
  }
  return { settings: s, org, tz: org.timezone || "America/Chicago" };
}

export async function saveSalesSettings(orgId: number, input: Partial<Omit<SalesSettings, "token">>) {
  const { settings } = await salesSettings(orgId);
  const next = readSales(JSON.stringify({ ...settings, ...input, token: settings.token }));
  if (input.hoursFrom && input.hoursTo && input.hoursFrom >= input.hoursTo) throw new TRPCError({ code: "BAD_REQUEST", message: "The end time must be after the start time." });
  await db.updateOrganization(orgId, { sales: JSON.stringify(next) });
  return next;
}

export function salesLinks(token: string) {
  return { form: `${ENV.appUrl}/f/${token}`, hook: `${ENV.appUrl}/hooks/leads/${token}`, booking: `${ENV.appUrl}/book/${token}` };
}

// ==========================================
// Riley: find prospects
// ==========================================

type Found = { name: string; city: string; contactName: string; contactTitle: string; email: string; phone: string; website: string; foundOn: string; sourceUrl: string; size: string; partnerType: string; fitScore: number; fitReason: string; linkedin: string };

export async function findProspects(orgId: number, opts: { focus?: string } = {}) {
  const emp = await employeeFor(orgId, "prospecting");
  const { settings } = await salesSettings(orgId);
  const referral = settings.sells === "therapy";
  const result = await working(emp, async () => {
    // Start from licensed practices in the federal NPI Registry when the area names a state.
    const org = await db.getOrganizationById(orgId);
    const places = parseArea(opts.focus || settings.area || (referral ? org?.state ?? "" : ""));
    const known = await db.listProspects(orgId);
    const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const npi: NpiPractice[] = (await npiPractices(places, npiKinds(settings.sells, settings.partnerTypes), 60).catch(() => [] as NpiPractice[]))
      .filter((c) => !known.some((p) => normName(p.name) === normName(c.name)))
      .slice(0, 30);
    const npiList = npi.length
      ? `\n\nStart from these licensed ${referral ? "offices" : "practices"} from the federal NPI Registry (name | city | phone | authorized official | specialty | NPI page). Pick the best fits, find each one's own website, and get the email from it:\n${npi.map((c) => `- ${c.name} | ${c.city} | ${c.phone || "no phone"} | ${[c.official, c.officialTitle].filter(Boolean).join(", ") || "no official listed"} | ${c.specialty} | ${c.url}`).join("\n")}\nIf you cannot find a practice's website, you may still return it with its NPI page as sourceUrl and its NPI phone.`
      : "";
    const { system, brain } = await systemPromptFor(
      emp,
      referral
        ? `Your job: find referral partners for this practice: places whose people could send clients to it (${settings.partnerTypes.join(", ") || "schools, pediatric offices, primary care"}), near the practice.
- Search one angle at a time: school district counseling pages, pediatric and primary care office sites, employee assistance program directories, family law firm sites, church staff pages.
- For each: the organization's name, city, the best person to contact (a counselor, practice manager, office manager or attorney) and their title, a work email and phone only if printed on their own site (otherwise ""), its website, which page you found it on and that page's URL, the partner type, its size if stated, and that person's LinkedIn profile URL (linkedin.com/in/...) only if a search result showed it (otherwise "").
- Score fit 0 to 100: how likely they see people this practice serves. Say why in one sentence using something real from their page.
- Return up to 10, best first.`
        : `Your job: find businesses that could buy what this workspace sells, from its Brain.
- Search one angle at a time: group practice and clinic sites with "Our team" pages, therapist directories, the state licensing board's license lookup (for example the Texas Behavioral Health Executive Council or the Oklahoma LPC board), practices posting job openings.
- Check the owner on the state licensing board's lookup when you can, and say in foundOn which sources you used (for example "NPI Registry, Texas BHEC license lookup, practice website").
- For each: the business name, city, the owner or decision maker and their title, a work email and phone only if printed on their own site or in the NPI Registry (otherwise ""), its website, which page you found it on and that page's URL, its size (how many clinicians) if stated, and the owner's LinkedIn profile URL (linkedin.com/in/...) only if a search result showed it (otherwise "").
- Score fit 0 to 100 against what the workspace sells. Say why in one sentence using something real from their page (books by phone only, hiring, takes insurance...).
- Return up to 10, best first.`
    );
    const prompt = `${referral ? `Area: ${settings.area || brain.org?.state || "near the practice"}` : `Area: ${opts.focus ? "" : settings.area || "the United States"}`}${opts.focus ? `\nFocus on: ${opts.focus}` : ""}${npiList}`;
    const res = await searchJson<{ items: Found[] }>({
      system,
      prompt,
      schemaName: "prospects",
      schema: obj({ items: arr(obj({ name: str, city: str, contactName: str, contactTitle: str, email: str, phone: str, website: str, foundOn: str, sourceUrl: str, size: str, partnerType: str, fitScore: int, fitReason: str, linkedin: str })) }),
      maxUses: Math.max(ENV.searchMaxUses, 10),
    });
    const existing = await db.listProspects(orgId);
    const norm = normName;
    const created: SalesProspect[] = [];
    const sources = npi.length ? [...res.sources, { url: `${NPI_HOST}/` }] : res.sources;
    for (const found of withRealSource(res.data.items, sources)) {
      if (!found.name?.trim() || existing.some((p) => norm(p.name) === norm(found.name))) continue;
      // Fill what the website did not show from the practice's NPI Registry record.
      const n = npi.find((c) => norm(c.name) === norm(found.name) || (found.sourceUrl ?? "").includes(c.npi));
      const f = n
        ? { ...found, city: found.city || n.city, phone: found.phone || n.phone, contactName: found.contactName || n.official, contactTitle: found.contactTitle || n.officialTitle, foundOn: found.foundOn || "NPI Registry" }
        : found;
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email ?? "") ? f.email.trim() : null;
      created.push(
        await db.createProspect({
          organizationId: orgId,
          kind: referral ? "referral" : "practice",
          stage: "new",
          name: f.name.trim().slice(0, 200),
          city: f.city?.slice(0, 120) || null,
          contactName: f.contactName?.slice(0, 160) || null,
          contactTitle: f.contactTitle?.slice(0, 120) || null,
          email,
          phone: f.phone?.slice(0, 40) || null,
          website: f.website?.slice(0, 300) || null,
          foundOn: f.foundOn?.slice(0, 300) || null,
          sourceUrl: f.sourceUrl,
          fitScore: Math.max(0, Math.min(100, Math.round(f.fitScore || 0))),
          fitReason: f.fitReason?.slice(0, 600) || null,
          details: JSON.stringify({ size: f.size || "", partnerType: f.partnerType || "", ...(n ? { npi: n.npi, specialty: n.specialty } : {}), ...(linkedinUrl(f.linkedin) ? { linkedinUrl: linkedinUrl(f.linkedin), linkedinFoundBy: `${emp.name}, while researching the practice` } : {}) }),
        })
      );
    }
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Searched for prospects", details: `Ran ${res.queries.length} searches${npi.length ? ` from ${npi.length} NPI Registry practices` : ""} and added ${created.length}.` });
    return { created: created.sort((a, b) => b.fitScore - a.fitScore), queries: res.queries };
  });

  // Good fits go to Jada on their own unless Riley is set to ask.
  const good = result.created.filter((p) => p.fitScore >= 70 && p.email);
  let passed = 0;
  if (good.length && gate(emp, "pass_to_outreach") === "auto") {
    passed = good.length;
    await passToOutreach(orgId, good.map((p) => p.id), emp);
  }
  return { ...result, passed, good: good.length };
}

/** Riley hands prospects to Jada, who writes their sequences in the background. */
export async function passToOutreach(orgId: number, ids: number[], from?: AIEmployee) {
  const riley = from ?? (await employeeFor(orgId, "prospecting"));
  const list = (await Promise.all(ids.map((id) => db.getProspect(id, orgId)))).filter((p): p is SalesProspect => !!p && p.stage === "new");
  if (!list.length) return 0;
  const noEmail = list.filter((p) => !p.email);
  const ready = list.filter((p) => p.email);
  if (ready.length) {
    for (const p of ready) await db.updateProspect(p.id, orgId, { stage: "outreach" });
    const where = Array.from(new Set(ready.map((p) => (p.city ?? "").split(",").pop()?.trim()).filter(Boolean))).slice(0, 2).join(" and ");
    await handoff(orgId, "prospecting", "outreach", `${riley.name} passed you ${ready.length === 1 ? ready[0].name : `${ready.length} prospects${where ? ` in ${where}` : ""}`} with what she found about ${ready.length === 1 ? "it" : "each"}.`);
    void startOutreach(orgId, ready.map((p) => p.id)).catch((err) => console.warn("[sales] outreach failed:", err instanceof Error ? err.message : err));
  }
  return ready.length;
}

// ==========================================
// Jada: email sequences
// ==========================================

/** The next weekday at h:mi in tz, at least `minHours` from now. */
function nextWeekday(tz: string, from: Date, h: number, mi: number, minHours = 12) {
  const p = partsIn(from, tz);
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i, 12));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
    if (at.getTime() > from.getTime() + minHours * 3600_000) return at;
  }
  return new Date(from.getTime() + 86400_000);
}

function addWeekdays(tz: string, at: Date, days: number) {
  const p = partsIn(at, tz);
  let n = 0;
  for (let i = 1; i < 30; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i, 12));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    n++;
    if (n === days) return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), p.h, p.mi, tz);
  }
  return new Date(at.getTime() + days * 86400_000);
}

type Seq = { subject: string; email1: string; email2: string; email3: string; linkedinNote?: string };

// ==========================================
// Jada: LinkedIn step (the owner sends it from their own LinkedIn)
// ==========================================

export type LinkedInStep = { url: string; note: string; due: string; status: "waiting" | "todo" | "done" | "skipped" | "cancelled"; foundBy: string; sequence: string; doneAt?: string };

/** A clean linkedin.com/in/ profile link, or null. */
export function linkedinUrl(raw: string | null | undefined) {
  const m = String(raw ?? "").trim().match(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%]+)\/?/i);
  return m ? `https://www.linkedin.com/in/${m[1]}` : null;
}

const details = (p: SalesProspect) => {
  try {
    return JSON.parse(p.details || "{}") as Record<string, any>;
  } catch {
    return {} as Record<string, any>;
  }
};
const stepOf = (p: SalesProspect): LinkedInStep | null => details(p).linkedin ?? null;
async function setStep(orgId: number, p: SalesProspect, patch: Partial<LinkedInStep> | null) {
  const d = details(p);
  if (patch === null) delete d.linkedin;
  else d.linkedin = { ...(d.linkedin ?? {}), ...patch };
  return db.updateProspect(p.id, orgId, { details: JSON.stringify(d) });
}

/** Trims a note to LinkedIn's 200-character limit for free accounts, at a word. */
export function fitNote(note: string, max = 200) {
  const t = note.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).replace(/[,;:\s]+$/, "");
}

/** Jada looks for the owner's public LinkedIn profile when Riley did not find it. */
async function findLinkedIn(jada: AIEmployee, p: SalesProspect): Promise<{ url: string; foundBy: string } | null> {
  if (!p.contactName) return null;
  try {
    const res = await searchJson<{ url: string; page: string }>({
      system: `Find one person's public LinkedIn profile. Return its linkedin.com/in/ URL only if a search result is clearly that person's profile (same name and the same practice or city). Otherwise return "". In page, say where you found the link, for example "the practice's team page" or "a search result".`,
      prompt: `${p.contactName}${p.contactTitle ? `, ${p.contactTitle}` : ""} at ${p.name}${p.city ? `, ${p.city}` : ""}`,
      schemaName: "linkedin_profile",
      schema: obj({ url: str, page: str }),
      maxUses: 2,
      maxTokens: 800,
    });
    const url = linkedinUrl(res.data.url);
    if (!url) return null;
    return { url, foundBy: `${jada.name}, from ${res.data.page || "a search result"}` };
  } catch {
    return null;
  }
}

type Jada = Awaited<ReturnType<typeof employeeFor>>;

/** Writes the 3 emails (and the LinkedIn note) for one prospect, then fixes anything that still reads like AI. */
async function writeSequence(jada: Jada, p: SalesProspect, o: { booking: string; signer: string; noteWanted: boolean; guidance?: string }): Promise<Seq> {
  return working(jada, async () => {
    const { system } = await systemPromptAbout(
      jada,
      `${p.kind === "referral" ? "referral partner" : "prospect"} offer outreach email sequence follow up`,
      `Your job: write a 3-email sequence to one ${p.kind === "referral" ? "possible referral partner" : "prospect"}, from the owner.
- Email 1: 3 to 5 short sentences. Say why you're writing to them using one real thing from the research, say in one sentence what ${p.kind === "referral" ? "the practice offers the people they see" : "the workspace offers"} that fits it, then ask for ${p.kind === "referral" ? "a short call or a time to drop off information" : "a short call"} and give the booking link. Sign with the signer given.
- Email 2 (3 business days later, only if no reply): 2 or 3 sentences that add one new, specific fact and the link.
- Email 3 (5 business days after that): 1 or 2 sentences that close politely and leave the link open.
- A subject line under 6 words. Plain text, no bullet points, no markdown.${o.noteWanted ? `
- linkedinNote: a LinkedIn connection note from the owner, under 190 characters, first name greeting, one real reason to connect in a full sentence, no link, no pitch, no "happy to connect", signed with the owner's first name.` : ""}

${HUMAN_EMAIL}`
    );
    const schema = o.noteWanted ? obj({ subject: str, email1: str, email2: str, email3: str, linkedinNote: str }) : obj({ subject: str, email1: str, email2: str, email3: str });
    const prompt = `To: ${p.contactName ?? "the owner"}${p.contactTitle ? `, ${p.contactTitle}` : ""} at ${p.name}${p.city ? `, ${p.city}` : ""}
Research: ${p.fitReason ?? ""}
Found on: ${p.foundOn ?? p.sourceUrl ?? ""}
Booking link: ${o.booking}
Signer:
${o.signer}${o.guidance ? `\nThe owner asked for this change: ${o.guidance}` : ""}`;
    let seq = await generateJson<Seq>({ system, prompt, schemaName: "outreach_sequence", schema, maxTokens: 1500 });
    // The signature (with its street address) is the owner's own; only the writing is checked.
    const body = (t: string) => (t ?? "").replace(o.signer, "");
    const tells = findTells(seq.subject, body(seq.email1), body(seq.email2), body(seq.email3), seq.linkedinNote ?? "");
    if (tells.length) {
      const fixed = await generateJson<Seq>({
        system,
        prompt: `${prompt}

Your draft:
${JSON.stringify(seq)}

These parts read like AI wrote them: ${tells.join("; ")}. Rewrite every field so it sounds like the owner typed it herself. Keep the facts, the booking link and the signature exactly.`,
        schemaName: "outreach_sequence",
        schema,
        maxTokens: 1500,
      }).catch(() => null);
      if (fixed?.email1) seq = fixed;
    }
    return seq;
  });
}

/** Rewrites every sequence still waiting for approval with the current writing rules. Returns how many. */
export async function rewriteWaiting(orgId: number, guidance?: string) {
  const jada = await employeeFor(orgId, "outreach");
  const { settings, org } = await salesSettings(orgId);
  const links = salesLinks(settings.token);
  const signer = [org.signerName, org.name].filter(Boolean).join("\n") || "[YOUR NAME]";
  const items = (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => m.status === "pending_approval" || m.status === "changes_requested");
  const bySeq = new Map<string, OutboundItem[]>();
  for (const m of items) {
    const key = JSON.parse(m.metadata || "{}").sequence as string | undefined;
    if (key) bySeq.set(key, [...(bySeq.get(key) ?? []), m]);
  }
  let done = 0;
  for (const [sequence, steps] of Array.from(bySeq.entries())) {
    const p = await db.getProspect(JSON.parse(steps[0].metadata || "{}").prospectId, orgId);
    if (!p) continue;
    const step = details(p).linkedin as LinkedInStep | undefined;
    const noteWanted = settings.linkedin.on && settings.linkedin.note && step?.sequence === sequence && step.status === "waiting";
    const seq = await writeSequence(jada, p, { booking: links.booking, signer, noteWanted, guidance });
    for (const m of steps) {
      const n = JSON.parse(m.metadata || "{}").step as number;
      const body = n === 1 ? seq.email1 : n === 2 ? seq.email2 : seq.email3;
      await db.updateOutboundItem(m.id, orgId, { title: (n === 1 ? seq.subject : `Re: ${seq.subject}`).slice(0, 255), body, status: "pending_approval" });
    }
    if (noteWanted && seq.linkedinNote) await setStep(orgId, p, { note: fitNote(seq.linkedinNote) });
    done++;
  }
  if (done) await logActivity(jada, "done", `Rewrote ${done} waiting email sequence${done === 1 ? "" : "s"}.`);
  return done;
}

export async function startOutreach(orgId: number, ids: number[]) {
  const jada = await employeeFor(orgId, "outreach");
  const { settings, org, tz } = await salesSettings(orgId);
  const links = salesLinks(settings.token);
  const signer = [org.signerName, org.name].filter(Boolean).join("\n") || "[YOUR NAME]";
  let made = 0;
  let firstSend = null as Date | null;
  const first = nextWeekday(tz, new Date(), 9, 10);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const p = await db.getProspect(id, orgId);
    if (!p || !p.email) continue;
    const already = (await db.listOutboundItemsByOrg(orgId, "outreach_email")).some((m) => JSON.parse(m.metadata || "{}").prospectId === p.id && m.status !== "cancelled");
    if (already) continue;
    const noteWanted = settings.linkedin.on && settings.linkedin.note;
    const seq = await writeSequence(jada, p, { booking: links.booking, signer, noteWanted });
    const send1 = new Date(first.getTime() + i * 3 * 60_000);
    const send2 = addWeekdays(tz, send1, 3);
    const send3 = addWeekdays(tz, send2, 5);
    if (!firstSend || send1 < firstSend) firstSend = send1;
    const sequence = crypto.randomBytes(8).toString("hex");
    const firstAuto = gate(jada, "first_email") === "auto";
    const followAuto = firstAuto && gate(jada, "follow_up") === "auto";
    const base = { organizationId: orgId, employeeId: jada.id, kind: "outreach_email" as const, targetChannels: JSON.stringify(["Gmail"]) };
    const steps: [number, string, string, Date, boolean][] = [
      [1, seq.subject, seq.email1, send1, firstAuto],
      [2, `Re: ${seq.subject}`, seq.email2, send2, followAuto],
      [3, `Re: ${seq.subject}`, seq.email3, send3, followAuto],
    ];
    for (const [step, title, body, at, auto] of steps) {
      await db.createOutboundItem({
        ...base,
        status: auto ? "scheduled" : "pending_approval",
        title: title.slice(0, 255),
        body,
        scheduledFor: at,
        ...(auto ? { approvedBy: `${jada.name} (on her own)`, approvedAt: new Date() } : {}),
        metadata: JSON.stringify({ prospectId: p.id, step, sequence, email: p.email, recipient: p.contactName ?? p.name, rule: step === 1 ? "first_email" : "follow_up" }),
      });
    }
    if (settings.linkedin.on) {
      const known = linkedinUrl(details(p).linkedinUrl);
      const found = known ? { url: known, foundBy: details(p).linkedinFoundBy || `${jada.name}, from the practice's research` } : await findLinkedIn(jada, p);
      if (found) {
        const due = settings.linkedin.when === "same_day" ? send1 : addWeekdays(tz, send1, 1);
        const fresh = (await db.getProspect(p.id, orgId)) ?? p;
        await setStep(orgId, fresh, { url: found.url, note: noteWanted ? fitNote(seq.linkedinNote ?? "") : "", due: due.toISOString(), status: firstAuto ? "todo" : "waiting", foundBy: found.foundBy, sequence });
      }
    }
    made++;
  }
  if (made) {
    const when = firstSend ? localParts(firstSend, tz) : null;
    const anyWaiting = gate(jada, "first_email") !== "auto";
    await logActivity(jada, "sent", `${anyWaiting ? "Wrote" : "Started"} ${made} email sequence${made === 1 ? "" : "s"}.${when ? ` First emails ${anyWaiting ? "are set for" : "go out"} ${when.date} at ${when.time}${anyWaiting ? " once you approve" : ""}.` : ""}`);
    await db.createChatMessage({ organizationId: orgId, employeeId: jada.id, role: "employee", authorName: jada.name, content: anyWaiting ? `I wrote ${made} email sequence${made === 1 ? "" : "s"}. They're on my Outreach tab waiting for your approval. Each stops when they book or reply.` : `I started ${made} email sequence${made === 1 ? "" : "s"}.${when ? ` First emails go out ${when.date} at ${when.time}.` : ""} Each one stops when they book or reply, and anyone who replies goes to Malik.` });
  }
  return made;
}

const isOpen = (m: OutboundItem) => ["pending_approval", "scheduled", "changes_requested"].includes(m.status) || (m.status === "approved" && !JSON.parse(m.metadata || "{}").dispatch);

/** Cancels every step of a prospect's sequence that has not gone out. */
export async function stopSequence(orgId: number, prospectId: number) {
  const mails = (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => JSON.parse(m.metadata || "{}").prospectId === prospectId && isOpen(m));
  for (const m of mails) await db.updateOutboundItem(m.id, orgId, { status: "cancelled", scheduledFor: null });
  const p = await db.getProspect(prospectId, orgId);
  const st = p ? stepOf(p) : null;
  if (p && st && (st.status === "waiting" || st.status === "todo")) await setStep(orgId, p, { status: "cancelled" });
  return mails.length;
}

/** Approve all 3: the sequence's waiting steps are scheduled at their times. */
export async function approveSequence(orgId: number, sequence: string, who: string) {
  const mails = (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => JSON.parse(m.metadata || "{}").sequence === sequence && m.status === "pending_approval");
  if (!mails.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing in this sequence is waiting." });
  const { noteApproval } = await import("./team");
  for (const m of mails) {
    const at = m.scheduledFor && new Date(m.scheduledFor).getTime() > Date.now() + 60_000 ? m.scheduledFor : new Date(Date.now() + 60_000);
    await db.updateOutboundItem(m.id, orgId, { status: "scheduled", scheduledFor: at, approvedBy: who, approvedAt: new Date() });
  }
  const step1 = mails.find((m) => JSON.parse(m.metadata || "{}").step === 1);
  if (step1) await noteApproval(step1);
  const pid = JSON.parse(mails[0].metadata || "{}").prospectId;
  const p = pid ? await db.getProspect(pid, orgId) : null;
  if (p && stepOf(p)?.status === "waiting") await setStep(orgId, p, { status: "todo" });
  return mails.length;
}

export async function skipProspect(orgId: number, prospectId: number) {
  await stopSequence(orgId, prospectId);
  return db.updateProspect(prospectId, orgId, { stage: "not_fit" });
}

/** Someone replied by email: stop the sequence and pass them to Malik. */
export async function markReplied(orgId: number, prospectId: number) {
  const p = await db.getProspect(prospectId, orgId);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That prospect is not in this workspace." });
  await stopSequence(orgId, p.id);
  await db.updateProspect(p.id, orgId, { stage: "replied" });
  const jada = await db.getEmployeeByKind(orgId, "outreach");
  const lead = await db.createLead({ organizationId: orgId, status: "replied", name: p.contactName || p.name, email: p.email, phone: p.phone, company: p.name, source: "Reply to outreach", prospectId: p.id, repliedAt: new Date(), message: "Replied to an outreach email." });
  if (jada && gate(jada, "pass_replies") === "auto") await handoff(orgId, "outreach", "leads", `${p.contactName || p.name} at ${p.name} replied. ${jada.name} passed them to you.`);
  return lead;
}

/** Sequences for Jada's Outreach tab, one row per prospect. */
export async function listSequences(orgId: number) {
  const mails = (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => m.status !== "cancelled" || JSON.parse(m.metadata || "{}").step === 1);
  const prospects = await db.listProspects(orgId);
  const bySeq = new Map<string, OutboundItem[]>();
  for (const m of mails) {
    const s = JSON.parse(m.metadata || "{}").sequence;
    if (!s) continue;
    bySeq.set(s, [...(bySeq.get(s) ?? []), m]);
  }
  const all = await db.listOutboundItemsByOrg(orgId, "outreach_email");
  return Array.from(bySeq.entries()).map(([sequence, items]) => {
    const full = all.filter((m) => JSON.parse(m.metadata || "{}").sequence === sequence).sort((a, b) => JSON.parse(a.metadata || "{}").step - JSON.parse(b.metadata || "{}").step);
    const pid = JSON.parse(full[0]?.metadata || "{}").prospectId;
    const p = prospects.find((x) => x.id === pid) ?? null;
    const waiting = full.some((m) => m.status === "pending_approval");
    const sent = full.filter((m) => m.status === "published").length;
    const open = full.filter(isOpen).length;
    const tab = p?.stage === "booked" ? "booked" : p?.stage === "replied" ? "replied" : waiting ? "waiting" : open ? "sending" : "finished";
    return {
      sequence,
      tab,
      prospect: p ? { id: p.id, name: p.name, contactName: p.contactName, contactTitle: p.contactTitle, city: p.city, fitScore: p.fitScore, email: p.email, stage: p.stage } : null,
      linkedin: p && stepOf(p)?.sequence === sequence ? stepOf(p) : null,
      sent,
      steps: full.map((m) => ({ id: m.id, step: JSON.parse(m.metadata || "{}").step as number, title: m.title, body: m.body ?? "", status: m.status, scheduledFor: m.scheduledFor, publishedAt: m.publishedAt })),
      createdAt: full[0]?.createdAt ?? items[0].createdAt,
    };
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function updateStep(orgId: number, itemId: number, title: string, body: string) {
  const m = await db.getOutboundItemForOrg(itemId, orgId);
  if (!m || m.kind !== "outreach_email") throw new TRPCError({ code: "NOT_FOUND", message: "That email is not in this workspace." });
  if (!isOpen(m)) throw new TRPCError({ code: "BAD_REQUEST", message: "This email has already gone out." });
  return db.updateOutboundItem(m.id, orgId, { title: title.slice(0, 255), body });
}

/** The LinkedIn tab: requests to send, soonest first. */
export async function listLinkedIn(orgId: number) {
  const prospects = await db.listProspects(orgId);
  const mails = await db.listOutboundItemsByOrg(orgId, "outreach_email");
  return prospects
    .map((p) => ({ p, st: stepOf(p) }))
    .filter((x): x is { p: SalesProspect; st: LinkedInStep } => !!x.st && x.st.status === "todo")
    .map(({ p, st }) => {
      const first = mails.find((m) => { const md = JSON.parse(m.metadata || "{}"); return md.sequence === st.sequence && md.step === 1; });
      return { prospectId: p.id, name: p.name, contactName: p.contactName, contactTitle: p.contactTitle, ...st, email1: first ? { status: first.status, publishedAt: first.publishedAt, scheduledFor: first.scheduledFor } : null };
    })
    .sort((a, b) => a.due.localeCompare(b.due));
}

export async function linkedinAction(orgId: number, prospectId: number, action: "done" | "skip") {
  const p = await db.getProspect(prospectId, orgId);
  const st = p ? stepOf(p) : null;
  if (!p || !st) throw new TRPCError({ code: "NOT_FOUND", message: "That LinkedIn step is not in this workspace." });
  await setStep(orgId, p, action === "done" ? { status: "done", doneAt: new Date().toISOString() } : { status: "skipped" });
  return { ok: true };
}

export async function updateLinkedInNote(orgId: number, prospectId: number, note: string) {
  const p = await db.getProspect(prospectId, orgId);
  const st = p ? stepOf(p) : null;
  if (!p || !st) throw new TRPCError({ code: "NOT_FOUND", message: "That LinkedIn step is not in this workspace." });
  if (note.trim().length > 300) throw new TRPCError({ code: "BAD_REQUEST", message: "LinkedIn notes can be up to 300 characters with Premium, 200 without." });
  await setStep(orgId, p, { note: note.replace(/\s+/g, " ").trim() });
  return { ok: true };
}

// ==========================================
// Malik: open times, leads and booking
// ==========================================

/** Open meeting times in the next 14 days from Google Calendar, within the workspace's hours. */
export async function openTimes(orgId: number, limit = 40) {
  const { settings, tz } = await salesSettings(orgId);
  const google = await db.getConnectionByProvider(orgId, "google_workspace");
  if (google?.status !== "connected") return { ready: false as const, times: [] as Date[] };
  const now = new Date();
  const end = new Date(now.getTime() + 14 * 86400_000);
  const busy = await integrations.calendarBusy(orgId, now, end).catch(() => null);
  if (!busy) return { ready: false as const, times: [] as Date[] };
  const len = settings.meetingMinutes * 60_000;
  const [fh, fm] = settings.hoursFrom.split(":").map(Number);
  const [th, tm] = settings.hoursTo.split(":").map(Number);
  const p = partsIn(now, tz);
  const out: Date[] = [];
  for (let i = 0; i < 15 && out.length < limit; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i, 12));
    if (!settings.days.includes(day.getUTCDay())) continue;
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    for (let mins = fh * 60 + fm; mins + settings.meetingMinutes <= th * 60 + tm; mins += 30) {
      const at = zonedToUtc(y, m, d, Math.floor(mins / 60), mins % 60, tz);
      if (at.getTime() < now.getTime() + 3 * 3600_000) continue;
      const clash = busy.some((b) => at < b.end && new Date(at.getTime() + len) > b.start);
      if (!clash) out.push(at);
      if (out.length >= limit) break;
    }
  }
  return { ready: true as const, times: out };
}

/** Three times on different days, for a reply. */
function pickThree(times: Date[], tz: string) {
  const picked: Date[] = [];
  const days = new Set<string>();
  for (const t of times) {
    const k = localParts(t, tz).date;
    if (days.has(k)) continue;
    days.add(k);
    picked.push(t);
    if (picked.length === 3) break;
  }
  return picked;
}

export function whenText(at: Date, tz: string) {
  return at.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/, (\d{1,2}:\d{2})/, " at $1");
}

export type LeadInput = { name: string; email?: string | null; phone?: string | null; company?: string | null; message?: string | null; source: string };

/** A new lead came in: save it, link it to a prospect, and have Malik reply. */
export async function newLead(orgId: number, input: LeadInput) {
  const email = input.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ? input.email.trim().toLowerCase() : null;
  const prospect = email ? (await db.listProspects(orgId)).find((p) => p.email?.toLowerCase() === email) ?? null : null;
  const lead = await db.createLead({
    organizationId: orgId,
    status: "new",
    name: input.name.trim().slice(0, 160) || "New lead",
    email,
    phone: input.phone?.trim().slice(0, 40) || null,
    company: input.company?.trim().slice(0, 200) || null,
    message: input.message?.trim().slice(0, 4000) || null,
    source: input.source,
    prospectId: prospect?.id ?? null,
  });
  if (prospect && ["outreach", "new"].includes(prospect.stage)) {
    await stopSequence(orgId, prospect.id);
    await db.updateProspect(prospect.id, orgId, { stage: "replied" });
    await handoff(orgId, "outreach", "leads", `${lead.name} at ${prospect.name} wrote in. Jada stopped her emails and passed them to you.`);
  }
  await replyToLead(orgId, lead.id).catch((err) => console.warn("[sales] lead reply failed:", err instanceof Error ? err.message : err));
  return db.getLead(lead.id, orgId);
}

export async function replyToLead(orgId: number, leadId: number) {
  const lead = await db.getLead(leadId, orgId);
  if (!lead || !lead.email) return null;
  const malik = await employeeFor(orgId, "leads");
  const { settings, tz } = await salesSettings(orgId);
  const links = salesLinks(settings.token);
  const open = await openTimes(orgId);
  const three = pickThree(open.times, tz);
  const therapy = settings.sells === "therapy";
  const out = await working(malik, async () => {
    const { system } = await systemPromptAbout(
      malik,
      `${lead.message ?? ""} lead reply book meeting`,
      `Your job: reply to a new ${therapy ? "inquiry from someone looking for care" : "lead"} within minutes, from the owner.
- 3 to 6 short lines. Thank them, answer what they asked only if the Brain has the answer, then offer the meeting times given (one per line, exactly as written) and the booking link.
- If no times are given, ask which days and times work for them and include the booking link if one is given.
- ${therapy ? "Never ask about symptoms or diagnoses and never give clinical advice. If they describe a crisis, tell them to call or text 988, or 911 for an emergency." : "Never quote prices that are not in the Brain."}
- Plain text. A subject line under 8 words.`
    );
    return generateJson<{ subject: string; body: string }>({
      system,
      prompt: `From: ${lead.name}${lead.company ? ` at ${lead.company}` : ""}
Came from: ${lead.source}
They wrote: ${therapy ? "(an inquiry; details are kept out of this message)" : lead.message || "(no message)"}
Meeting length: ${settings.meetingMinutes} minutes
Times to offer:
${three.map((t) => whenText(t, tz)).join("\n") || "(none)"}
Booking link: ${open.ready ? links.booking : "(none yet)"}`,
      schemaName: "lead_reply",
      schema: obj({ subject: str, body: str }),
      maxTokens: 800,
    });
  });
  // A practice's client inquiries always wait: they can carry health information.
  const auto = !therapy && gate(malik, "reply") === "auto";
  const item = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: malik.id,
    kind: "lead_reply",
    status: "pending_approval",
    title: out.subject.slice(0, 255) || `Re: your message`,
    body: out.body,
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ leadId: lead.id, email: lead.email, recipient: lead.name, rule: "reply", offered: three.map((t) => t.toISOString()) }),
  });
  await db.updateLead(lead.id, orgId, { meta: JSON.stringify({ replyItemId: item.id, offered: three.map((t) => t.toISOString()) }) });
  if (auto) {
    const hour = partsIn(new Date(), tz).h;
    if (hour >= 8 && hour < 20) {
      await postNow(item, `${malik.name} (on his own)`, "system", "Replied to a lead", { approvedBy: `${malik.name} (on his own)`, approvedAt: new Date() });
    } else {
      const p = partsIn(new Date(), tz);
      const day = new Date(Date.UTC(p.y, p.m - 1, p.d + (hour >= 20 ? 1 : 0), 12));
      const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 8, 0, tz);
      await db.updateOutboundItem(item.id, orgId, { status: "scheduled", scheduledFor: at, approvedBy: `${malik.name} (on his own)`, approvedAt: new Date() });
    }
  }
  return db.getOutboundItemForOrg(item.id, orgId);
}

// After a lead reply or an outreach email goes out.
afterSent.push(async (item, status) => {
  if (status !== "published") return;
  const meta = JSON.parse(item.metadata || "{}");
  if (item.kind === "lead_reply" && meta.leadId) {
    const lead = await db.getLead(meta.leadId, item.organizationId);
    if (!lead) return;
    const created = new Date(lead.createdAt).getTime();
    if (lead.status === "new") await db.updateLead(lead.id, item.organizationId, { status: "replied", repliedAt: new Date() });
    const malik = item.employeeId ? await db.getEmployeeForOrg(item.employeeId, item.organizationId) : null;
    const mins = Math.max(1, Math.round((Date.now() - created) / 60_000));
    await logActivity(malik, "sent", `Replied to ${lead.name}${lead.company ? ` (${lead.company})` : ""}${mins <= 120 ? ` ${mins} minute${mins === 1 ? "" : "s"} after they wrote` : ""}.`, workLink("leads"), item.organizationId);
  }
});

/** Books a time from the booking page. */
export async function book(orgId: number, input: { at: string; name: string; email: string; company?: string; note?: string }) {
  const { settings, tz, org } = await salesSettings(orgId);
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) throw new Error("Pick a time.");
  const open = await openTimes(orgId, 200);
  if (!open.ready) throw new Error("Booking is not open right now.");
  if (!open.times.some((t) => t.getTime() === at.getTime())) throw new Error("That time was just taken. Pick another one.");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email.");
  const name = input.name.trim().slice(0, 160);
  if (!name) throw new Error("Enter your name.");
  const end = new Date(at.getTime() + settings.meetingMinutes * 60_000);
  const eventUrl = await integrations.bookCalendarEvent(orgId, {
    summary: `${org.name}: meeting with ${name}${input.company ? ` (${input.company.trim()})` : ""}`,
    description: `Booked through the ${org.name} booking page.${input.note ? `\n\nNote: ${input.note.trim().slice(0, 1000)}` : ""}`,
    start: at,
    end,
    attendeeEmail: email,
    tz,
  });
  const leads = await db.listLeads(orgId);
  let lead = leads.find((l) => l.email === email && l.status !== "closed") ?? null;
  const prospect = (await db.listProspects(orgId)).find((p) => p.email?.toLowerCase() === email) ?? null;
  if (lead) lead = await db.updateLead(lead.id, orgId, { status: "booked", bookedFor: at, meta: JSON.stringify({ ...JSON.parse(lead.meta || "{}"), eventUrl }) });
  else lead = await db.createLead({ organizationId: orgId, status: "booked", name, email, company: input.company?.trim() || prospect?.name || null, message: input.note?.trim() || null, source: prospect ? "Reply to outreach" : "Booking page", prospectId: prospect?.id ?? null, bookedFor: at, meta: JSON.stringify({ eventUrl }) });
  if (prospect) {
    await stopSequence(orgId, prospect.id);
    await db.updateProspect(prospect.id, orgId, { stage: "booked" });
  }
  const malik = await db.getEmployeeByKind(orgId, "leads");
  const when = whenText(at, tz);
  await logActivity(malik, "sent", `${name}${input.company || prospect ? ` (${input.company?.trim() || prospect?.name})` : ""} booked ${when}. It's on your Google Calendar.`, workLink("leads"), orgId);
  await notify(orgId, "report", { title: `Meeting booked: ${when}`, body: `${initialsOf(name)}${input.company ? ` from ${input.company.trim()}` : ""} booked through your booking page.`, url: "/chats/leads/work", tag: `booked-${lead?.id}` }).catch(() => {});
  return { lead, when };
}

const initialsOf = (name: string) => name.trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join(". ") + ".";

export async function closeLead(orgId: number, leadId: number) {
  return db.updateLead(leadId, orgId, { status: "closed" });
}

// ==========================================
// Chat helpers
// ==========================================

export function prospectCard(p: SalesProspect) {
  const d = JSON.parse(p.details || "{}");
  return {
    type: "prospect_sales" as const,
    id: p.id,
    title: p.name,
    subtitle: [p.city, d.size ? `${d.size}` : null, p.contactName ? `${p.kind === "referral" ? "Contact" : "Owner"}: ${p.contactName}${p.contactTitle ? `, ${p.contactTitle}` : ""}` : null].filter(Boolean).join(" · "),
    body: p.fitReason ?? "",
    score: p.fitScore,
    status: p.stage,
    url: p.sourceUrl,
  };
}

export async function salesStatus(orgId: number, kind: "prospecting" | "outreach" | "leads") {
  const ps = await db.listProspects(orgId);
  const c = (s: string) => ps.filter((p) => p.stage === s).length;
  if (kind === "prospecting") return `Here's where things stand: ${c("new")} new prospects, ${c("outreach")} in outreach, ${c("replied")} replied, ${c("booked")} booked and ${c("not_fit")} not a fit.`;
  if (kind === "outreach") {
    const seqs = await listSequences(orgId);
    const t = (k: string) => seqs.filter((s) => s.tab === k).length;
    return `Here's where things stand: ${t("waiting")} sequences waiting for you, ${t("sending")} sending, ${t("replied")} replied, ${t("booked")} booked and ${t("finished")} finished.`;
  }
  const leads = await db.listLeads(orgId);
  const { tz } = await salesSettings(orgId);
  const soon = leads.filter((l) => l.bookedFor && new Date(l.bookedFor) > new Date() && new Date(l.bookedFor).getTime() < Date.now() + 7 * 86400_000);
  return `Here's where things stand: ${leads.filter((l) => l.status === "new").length} new leads, ${leads.filter((l) => l.status === "replied").length} replied and ${soon.length} meeting${soon.length === 1 ? "" : "s"} in the next 7 days${soon.length ? `: ${soon.map((l) => `${l.company || l.name} (${whenText(new Date(l.bookedFor!), tz)})`).join("; ")}` : ""}.`;
}

export type { SalesLead };
