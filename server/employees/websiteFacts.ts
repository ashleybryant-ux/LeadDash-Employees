import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import { readSite, siteBrief } from "./siteReader";

/**
 * "Read my website": the team reads the business's own site, says what it
 * found (what the business does, who it serves, services, booking link,
 * contact details, brand colors, how it sounds, the team) with the page each
 * fact came from, and the owner picks what to keep. Nothing is saved until
 * they do. What they keep goes to the workspace profile and the Brain, so no
 * employee asks for it again.
 */

export const WEBSITE_FIELDS = [
  { key: "description", label: "What you do", where: "Workspace" },
  { key: "audience", label: "Who you serve", where: "Workspace" },
  { key: "services", label: "Services and offers", where: "Brain" },
  { key: "bookingLink", label: "Booking link", where: "Brain" },
  { key: "contact", label: "Contact details", where: "Brain" },
  { key: "brandColors", label: "Brand colors", where: "Workspace" },
  { key: "tone", label: "How the site sounds", where: "Brain" },
  { key: "team", label: "The team", where: "Brain" },
] as const;
export type WebsiteKey = (typeof WEBSITE_FIELDS)[number]["key"];
export type WebsiteFound = { key: WebsiteKey; label: string; value: string; source: string; current: string; where: string };

/** Brain entry titles for the facts that are not workspace fields. */
const ENTRY: Partial<Record<WebsiteKey, { title: string; category: "mission_profile" | "voice_tone" | "services_offers" | "team_bios" }>> = {
  services: { title: "Services and offers", category: "services_offers" },
  bookingLink: { title: "Booking link", category: "services_offers" },
  contact: { title: "Contact details", category: "mission_profile" },
  tone: { title: "Voice and tone", category: "voice_tone" },
  team: { title: "Team", category: "team_bios" },
};

const str = { type: "string" } as const;
const SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: WEBSITE_FIELDS.map((f) => f.key),
  properties: Object.fromEntries(WEBSITE_FIELDS.map((f) => [f.key, { type: "object", additionalProperties: false, required: ["value", "source"], properties: { value: str, source: str } }])),
};

const normUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

/** Reads the site and returns what it found, each fact with the page it came from, next to what the Brain has now. */
export async function readWebsite(orgId: number, url: string): Promise<{ website: string; pages: { url: string; title: string }[]; found: WebsiteFound[] }> {
  const clean = url.trim();
  if (!clean || !/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(clean)) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the website address, like https://example.com." });
  const org = await db.getOrganizationById(orgId);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That workspace isn't here." });
  let site;
  try {
    site = await readSite(clean, { max: 7, about: "about services team contact book appointment pricing" });
  } catch (err) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `I couldn't open ${clean}: ${err instanceof Error ? err.message : String(err)}` });
  }
  const pageUrls = new Set(site.pages.map((p) => normUrl(p.url)));
  const linkUrls = new Set(site.links.map((l) => normUrl(l.url)));
  const r = await generateJson<Record<WebsiteKey, { value: string; source: string }>>({
    system: `You read a business's website and write down the facts about the business for the people who work there, so nobody has to type them in. Plain American English, no em dashes, no hype. Use only what the pages say; when the site does not say something, leave value "". Every fact carries the URL of the page it came from (one of the PAGE urls).
- description: what the business does and where, one or two sentences.
- audience: who it serves, one sentence.
- services: the services or offers, as a short comma list, with prices when the site shows them.
- bookingLink: the URL a client uses to book or request an appointment or consultation, if the site has one (a link on the pages).
- contact: phone, email and address as printed.
- brandColors: the site's main colors as hex codes if the markup shows them (for example "Green #1b6b4a, orange #e88a3a"), otherwise "".
- tone: how the site sounds, in one line (for example "Warm and personal, speaks to the reader as you").
- team: the people named on the site with their titles, as a comma list.`,
    prompt: siteBrief(site, { html: true, textChars: 6000, htmlChars: 8000 }).slice(0, 90_000),
    schemaName: "website_facts",
    schema: SCHEMA,
    maxTokens: 2500,
  });
  const current: Record<WebsiteKey, string> = {
    description: org.description ?? "",
    audience: org.audience ?? "",
    brandColors: org.brandColors ?? "",
    services: "",
    bookingLink: "",
    contact: "",
    tone: "",
    team: "",
  };
  const entries = await db.listKnowledgeByOrg(orgId);
  for (const [k, e] of Object.entries(ENTRY)) {
    const have = entries.find((x) => x.title.trim().toLowerCase() === e.title.toLowerCase());
    if (have) current[k as WebsiteKey] = have.content.trim();
  }
  const found: WebsiteFound[] = [];
  for (const f of WEBSITE_FIELDS) {
    const got = r[f.key] ?? { value: "", source: "" };
    let value = String(got.value ?? "").trim().slice(0, 1200);
    // A booking link counts only when it is a link the site actually has.
    if (f.key === "bookingLink" && value && !linkUrls.has(normUrl(value)) && !pageUrls.has(normUrl(value)) && !site.pages.some((p) => p.html.toLowerCase().includes(value.toLowerCase()))) value = "";
    if (f.key === "brandColors") value = (value.match(/#[0-9a-f]{6}\b/gi) ?? []).length ? value : "";
    if (!value) continue;
    const source = pageUrls.has(normUrl(got.source ?? "")) ? got.source : site.start;
    found.push({ key: f.key, label: f.label, value, source, current: current[f.key].slice(0, 1200), where: f.where });
  }
  return { website: site.start, pages: site.pages.map((p) => ({ url: p.url, title: p.title })), found };
}

/** Saves the facts the owner kept: workspace fields on the workspace, the rest as Brain entries every employee reads. */
export async function applyWebsite(orgId: number, website: string, keep: Partial<Record<WebsiteKey, string>>) {
  const org = await db.getOrganizationById(orgId);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That workspace isn't here." });
  const patch: Record<string, string> = {};
  if (website.trim()) patch.website = website.trim().slice(0, 300);
  const entries = await db.listKnowledgeByOrg(orgId);
  let saved = 0;
  for (const f of WEBSITE_FIELDS) {
    const v = keep[f.key];
    if (typeof v !== "string" || !v.trim()) continue;
    const val = v.trim().slice(0, 2000);
    saved++;
    if (f.key === "description" || f.key === "audience" || f.key === "brandColors") {
      patch[f.key] = val;
      continue;
    }
    const e = ENTRY[f.key]!;
    const have = entries.find((x) => x.title.trim().toLowerCase() === e.title.toLowerCase());
    if (have) await db.updateKnowledgeItem(have.id, orgId, { content: val });
    else await db.createKnowledgeItem({ organizationId: orgId, title: e.title, category: e.category, kind: "fact", content: val });
  }
  if (Object.keys(patch).length) await db.updateOrganization(orgId, patch);
  return { saved };
}
