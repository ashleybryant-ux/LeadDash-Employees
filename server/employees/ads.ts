import { TRPCError } from "@trpc/server";
import JSZip from "jszip";
import * as db from "../db";
import { AD_PLATFORMS, type AdPlatform, type AIEmployee } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import { generateImage, type ImageSize } from "../_core/imageGeneration";
import { ENV } from "../_core/env";
import { storagePut } from "../storage";
import { employeeFor, systemPromptAbout, working, actor } from "./tasks";
import { fetchWebpage } from "./files";

/**
 * Reese, the Ads Manager. One brief (goal, who it is for, the page, the
 * platforms, the budget) becomes one creative set per platform, written to
 * that platform's own specs, one platform at a time: the next set is written
 * only when the owner approves or skips the one in front of them. Reese
 * suggests how to split the budget and what each platform gets per day.
 * Nothing is posted anywhere: the owner copies each approved set into the
 * platform's ads manager.
 */

export type FieldKind = "text" | "long" | "list";
export type Field = { key: string; label: string; kind: FieldKind; limit?: number; count?: [number, number]; hint: string };
export type Spec = {
  name: string;
  /** Where the ad shows, in a few words. */
  where: string;
  fields: Field[];
  /** The picture every set on this platform gets, or null for text-only platforms. */
  image: { size: ImageSize; label: string } | null;
  /** The picture is a cover for a video the owner records or Elena makes. */
  video?: boolean;
  /** The script is read as an audio spot. */
  audio?: boolean;
  /** Reaches people near a place, not a trade: left out of a campaign aimed at business owners. */
  local?: boolean;
  /** Written as a copy of Google Search. */
  copies?: AdPlatform;
};

const SEARCH_FIELDS: Field[] = [
  { key: "headlines", label: "Headlines", kind: "list", limit: 30, count: [3, 15], hint: "Each at most 30 characters. Write 5 to 8 that work in any order; one carries the offer, one the proof, one the call to action." },
  { key: "descriptions", label: "Descriptions", kind: "list", limit: 90, count: [2, 4], hint: "Each at most 90 characters, a full sentence that stands on its own." },
  { key: "keywords", label: "Keywords", kind: "list", count: [5, 15], hint: "Phrases people search when they want this; no competitor brand names unless the owner's guidelines allow them." },
];

export const PLATFORM: Record<AdPlatform, Spec> = {
  meta: {
    name: "Meta",
    where: "Facebook and Instagram feeds",
    fields: [
      { key: "primaryText", label: "Primary text", kind: "long", limit: 300, hint: "The first 125 characters show before 'See more', so the point lands there. 2 to 4 short sentences." },
      { key: "headline", label: "Headline", kind: "text", limit: 40, hint: "At most 40 characters; 27 or fewer shows whole on every placement." },
      { key: "description", label: "Description", kind: "text", limit: 30, hint: "At most 30 characters, shown under the headline on some placements." },
      { key: "cta", label: "Call to action", kind: "text", limit: 20, hint: "One of Meta's buttons: Learn more, Sign up, Book now, Get offer, Contact us, Apply now, Get quote." },
      { key: "audience", label: "Audience", kind: "long", limit: 240, hint: "Who to show it to: ages, places, interests or job titles, in one line the owner can set up in Ads Manager." },
    ],
    image: { size: "1024x1024", label: "1080 × 1080 · feed and Instagram" },
  },
  google: { name: "Google Search", where: "Google search results", fields: SEARCH_FIELDS, image: null },
  youtube: {
    name: "YouTube",
    where: "before and during YouTube videos",
    fields: [
      { key: "script", label: "Script", kind: "long", limit: 700, hint: "A 15 second skippable spot with time marks: 0 to 3 seconds earns the stay, 3 to 10 shows the thing, 10 to 15 names the offer and the brand. About 40 words." },
      { key: "companionBanner", label: "Companion banner", kind: "text", limit: 40, hint: "The words on the banner beside the video, at most 40 characters." },
      { key: "audience", label: "Shown to", kind: "long", limit: 240, hint: "Who sees it: what they watched or searched, where, ages." },
    ],
    image: { size: "1536x1024", label: "1920 × 1080 · thumbnail" },
    video: true,
  },
  microsoft: { name: "Microsoft Ads", where: "Bing search results", fields: SEARCH_FIELDS, image: null, copies: "google" },
  linkedin: {
    name: "LinkedIn",
    where: "the LinkedIn feed",
    fields: [
      { key: "introText", label: "Intro text", kind: "long", limit: 600, hint: "The first 150 characters show before 'See more'. Speak to the job, not the person. 2 to 3 sentences." },
      { key: "headline", label: "Headline", kind: "text", limit: 70, hint: "At most 70 characters." },
      { key: "cta", label: "Call to action", kind: "text", limit: 20, hint: "One of LinkedIn's buttons: Learn more, Sign up, Register, Request demo, Download." },
      { key: "audience", label: "Shown to", kind: "long", limit: 240, hint: "Job titles, industries, company sizes and places the owner can set up in Campaign Manager." },
    ],
    image: { size: "1536x1024", label: "1200 × 627 · single image" },
  },
  tiktok: {
    name: "TikTok",
    where: "the For You feed",
    fields: [
      { key: "hook", label: "Hook (first 2 seconds)", kind: "text", limit: 90, hint: "Spoken or on screen in the first two seconds. A line someone would actually say." },
      { key: "script", label: "Script", kind: "long", limit: 700, hint: "15 to 30 seconds. What is on screen and what is said, in order. Native, not polished." },
      { key: "caption", label: "Caption", kind: "text", limit: 100, hint: "At most 100 characters, the ad text under the video." },
      { key: "hashtags", label: "Hashtags", kind: "list", count: [3, 5], hint: "3 to 5, each starting with #." },
    ],
    image: { size: "1024x1536", label: "1080 × 1920 · cover" },
    video: true,
  },
  reddit: {
    name: "Reddit",
    where: "promoted posts in communities",
    fields: [
      { key: "title", label: "Post title", kind: "text", limit: 300, hint: "Reads like a member wrote it, first person, specific. No hype." },
      { key: "body", label: "Post body", kind: "long", limit: 900, hint: "Plain, first person, honest about being the owner; invites questions in the comments." },
      { key: "communities", label: "Communities", kind: "list", count: [2, 5], hint: "Subreddits where this audience talks, each starting with r/." },
    ],
    image: { size: "1536x1024", label: "1200 × 628 · promoted post" },
  },
  spotify: {
    name: "Spotify",
    where: "audio spots between songs and podcasts",
    fields: [
      { key: "audioScript", label: "Audio script", kind: "long", limit: 700, hint: "30 seconds read aloud, about 75 words. Numbers and web addresses written the way they are said ('two ninety-nine', 'LeadDash dot I O')." },
      { key: "voice", label: "Voice", kind: "text", limit: 120, hint: "Who reads it: the owner, or a voice from the library, and the tone." },
      { key: "audience", label: "Shown to", kind: "long", limit: 240, hint: "Listeners of what, where, ages." },
    ],
    image: { size: "1024x1024", label: "640 × 640 · companion image" },
    audio: true,
  },
  nextdoor: {
    name: "Nextdoor",
    where: "neighborhood feeds",
    fields: [
      { key: "headline", label: "Headline", kind: "text", limit: 60, hint: "At most 60 characters, says what and where." },
      { key: "body", label: "Body", kind: "long", limit: 240, hint: "2 to 3 sentences a neighbor would trust: who, hours, insurance, how to book." },
      { key: "areas", label: "Neighborhoods", kind: "text", limit: 200, hint: "Zip codes or neighborhoods to show it in." },
    ],
    image: { size: "1536x1024", label: "1200 × 628 · local ad" },
    local: true,
  },
  yelp: {
    name: "Yelp",
    where: "Yelp search results and business pages",
    fields: [
      { key: "headline", label: "Headline", kind: "text", limit: 50, hint: "At most 50 characters." },
      { key: "body", label: "Text", kind: "long", limit: 240, hint: "2 to 3 plain sentences: who it is for, hours, insurance, how to book." },
      { key: "cta", label: "Call to action", kind: "text", limit: 20, hint: "Book now, Call now, Learn more or Get a quote." },
    ],
    image: { size: "1536x1024", label: "business photo · 4:3" },
    local: true,
  },
};

/** The order Reese writes them in: the widest reach first, tests last. */
export const ORDER: AdPlatform[] = ["meta", "google", "youtube", "microsoft", "linkedin", "tiktok", "reddit", "spotify", "nextdoor", "yelp"];

/** Platform names the way people say them, to the key. */
export function platformFromWords(text: string): AdPlatform[] {
  const t = text.toLowerCase();
  if (/\b(all|every|everything|each)\b/.test(t) && !/\b(except|but not|without)\b/.test(t)) return [...ORDER];
  const out = new Set<AdPlatform>();
  if (/\b(meta|facebook|instagram|fb|ig)\b/.test(t)) out.add("meta");
  if (/\bgoogle\b/.test(t) && !/\bgoogle (ads )?only for youtube\b/.test(t)) out.add("google");
  if (/\byou ?tube\b/.test(t)) out.add("youtube");
  if (/\b(microsoft|bing)\b/.test(t)) out.add("microsoft");
  if (/\blinked ?in\b/.test(t)) out.add("linkedin");
  if (/\btik ?tok\b/.test(t)) out.add("tiktok");
  if (/\breddit\b/.test(t)) out.add("reddit");
  if (/\bspotify\b/.test(t)) out.add("spotify");
  if (/\bnext ?door\b/.test(t)) out.add("nextdoor");
  if (/\byelp\b/.test(t)) out.add("yelp");
  return ORDER.filter((p) => out.has(p));
}

type Content = Record<string, string | string[]>;
type Split = Record<string, { share: number; why: string }>;

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function platformsOf(c: db.AdCampaignRow) {
  return parse<AdPlatform[]>(c.platforms, []).filter((p) => AD_PLATFORMS.includes(p));
}
export function splitOf(c: db.AdCampaignRow): Split {
  return parse<Split>(c.split, {});
}
export function notesOf(c: db.AdCampaignRow) {
  return parse<string[]>(c.notes, []);
}
export function leftOutOf(c: db.AdCampaignRow) {
  return parse<AdPlatform[]>(c.leftOut, []);
}
export function contentOf(s: db.AdSetRow): Content {
  return parse<Content>(s.content, {});
}

/** Days from start to end, both included; 0 when a date is missing or wrong. */
export function daysBetween(start: string, end: string) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!start || !end || Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** MM/DD/YYYY or YYYY-MM-DD typed by a person, to YYYY-MM-DD; "" when it isn't a date. */
export function dateIn(raw: string) {
  const t = raw.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  return m ? t : "";
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

// ==========================================
// The view the screens and cards use
// ==========================================

export function campaignView(c: db.AdCampaignRow) {
  const sets = db.ads.sets(c.id);
  const platforms = platformsOf(c);
  const split = splitOf(c);
  const days = daysBetween(c.startDate, c.endDate);
  const leftOut = leftOutOf(c);
  const active = platforms.filter((p) => !leftOut.includes(p));
  const current = (p: AdPlatform) => sets.filter((s) => s.platform === p && s.status !== "replaced").slice(-1)[0] ?? null;
  const rows = platforms.map((p) => {
    const s = current(p);
    const share = split[p]?.share ?? 0;
    const total = Math.round((c.budgetCents * share) / 100);
    return {
      platform: p,
      name: PLATFORM[p].name,
      where: PLATFORM[p].where,
      leftOut: leftOut.includes(p),
      set: s ? setView(s) : null,
      share,
      totalCents: total,
      perDayCents: days ? Math.round(total / days) : 0,
      why: split[p]?.why ?? "",
    };
  });
  const approved = rows.filter((r) => r.set?.status === "approved").length;
  const skipped = rows.filter((r) => r.set?.status === "skipped").length;
  return {
    id: c.id,
    name: c.name,
    goal: c.goal,
    audience: c.audience,
    page: c.page,
    platforms,
    status: c.status,
    currentPlatform: c.currentPlatform as AdPlatform | null,
    budgetCents: c.budgetCents,
    budget: money(c.budgetCents),
    startDate: c.startDate,
    endDate: c.endDate,
    days,
    splitMode: c.splitMode,
    formats: c.formats,
    versions: c.versions,
    mustSay: c.mustSay,
    neverSay: c.neverSay,
    notes: notesOf(c),
    leftOutWhy: c.leftOutWhy,
    rows,
    counts: { platforms: active.length, approved, skipped, open: active.length - approved - skipped },
    perDayCents: days ? Math.round(c.budgetCents / days) : 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
export type CampaignView = ReturnType<typeof campaignView>;

export function setView(s: db.AdSetRow) {
  const spec = PLATFORM[s.platform];
  return {
    id: s.id,
    campaignId: s.campaignId,
    platform: s.platform,
    name: spec.name,
    where: spec.where,
    version: s.version,
    status: s.status,
    content: contentOf(s),
    fields: spec.fields,
    imageLabel: spec.image?.label ?? null,
    video: !!spec.video,
    audio: !!spec.audio,
    copies: spec.copies ? PLATFORM[spec.copies].name : null,
    summary: s.summary,
    imageUrl: s.imageUrl,
    imageError: s.imageError,
    audioUrl: s.audioUrl,
    audioError: s.audioError,
    error: s.error,
    approvedBy: s.approvedBy,
    approvedAt: s.approvedAt,
    createdAt: s.createdAt,
  };
}
export type SetView = ReturnType<typeof setView>;

/** The set as text to paste into the platform. */
export function setText(s: db.AdSetRow, c: db.AdCampaignRow) {
  const spec = PLATFORM[s.platform];
  const content = contentOf(s);
  const lines = [`${c.name} · ${spec.name}`, `Goes to: ${c.page}`, ""];
  for (const f of spec.fields) {
    const v = content[f.key];
    if (v == null || (Array.isArray(v) ? v.length === 0 : !String(v).trim())) continue;
    lines.push(`${f.label}:`);
    if (Array.isArray(v)) for (const x of v) lines.push(`- ${x}`);
    else lines.push(String(v));
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ==========================================
// Chat
// ==========================================

async function reese(orgId: number) {
  return employeeFor(orgId, "ads");
}

async function say(emp: AIEmployee, content: string, cards: { type: string; id: number; title: string }[] = []) {
  return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: cards.length ? JSON.stringify(cards) : null });
}

const budgetCard = (c: db.AdCampaignRow) => ({ type: "ad_budget", id: c.id, title: c.name });
const setCard = (s: db.AdSetRow, c: db.AdCampaignRow) => ({ type: "ad_set", id: s.id, title: `${c.name} · ${PLATFORM[s.platform].name}` });

// ==========================================
// The brief and the split
// ==========================================

export type Brief = {
  name: string;
  goal: string;
  audience: string;
  page: string;
  platforms: AdPlatform[];
  budgetCents: number;
  startDate: string;
  endDate: string;
  formats?: string;
  versions?: number;
  mustSay?: string;
  neverSay?: string;
  splitMode?: "reese" | "even" | "custom";
};

const str = { type: "string" } as const;

/** Reese's split: by where this audience is and what each click costs; local platforms left out when the audience is a trade, not a neighborhood. */
async function suggestSplit(emp: AIEmployee, c: db.AdCampaignRow): Promise<{ split: Split; leftOut: AdPlatform[]; why: string }> {
  const platforms = platformsOf(c);
  const even = (): Split => Object.fromEntries(platforms.map((p, i) => [p, { share: Math.floor(100 / platforms.length) + (i < 100 % platforms.length ? 1 : 0), why: "An even split to start." }]));
  try {
    const { system } = await systemPromptAbout(
      emp,
      `${c.name} ${c.goal} ${c.audience}`,
      `Your job: split an ad budget across platforms for this campaign, and say which platforms do not fit the audience at all.
- Give each platform a whole-number share of 100, all shares adding up to exactly 100, with one short reason each (where this audience is, what a click costs there, what the platform is for).
- A platform that reaches a neighborhood (Nextdoor, Yelp) does not fit a campaign aimed at a trade or profession (practice owners, administrators); leave it out with the reason. A campaign for local clients fits them well.
- Platforms you leave out get share 0 and are listed in leftOut.
- Plain words, no em dashes.`
    );
    const out = await generateJson<{ shares: { platform: string; share: number; why: string }[]; leftOut: string[]; leftOutWhy: string }>({
      system,
      prompt: `Campaign: ${c.name}\nGoal: ${c.goal}\nWho it is for: ${c.audience}\nPage: ${c.page}\nBudget: ${money(c.budgetCents)} from ${c.startDate || "?"} to ${c.endDate || "?"}\nPlatforms: ${platforms.map((p) => `${p} (${PLATFORM[p].name})`).join(", ")}`,
      schemaName: "ad_split",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["shares", "leftOut", "leftOutWhy"],
        properties: {
          shares: { type: "array", items: { type: "object", additionalProperties: false, required: ["platform", "share", "why"], properties: { platform: { type: "string", enum: platforms }, share: { type: "integer" }, why: str } } },
          leftOut: { type: "array", items: { type: "string", enum: platforms } },
          leftOutWhy: str,
        },
      },
    });
    const leftOut = platforms.filter((p) => out.leftOut.includes(p));
    const kept = platforms.filter((p) => !leftOut.includes(p));
    if (!kept.length) return { split: even(), leftOut: [], why: "" };
    let shares = Object.fromEntries(kept.map((p) => [p, Math.max(0, Math.round(out.shares.find((s) => s.platform === p)?.share ?? 0))]));
    let sum = Object.values(shares).reduce((a, b) => a + b, 0);
    if (sum <= 0) shares = Object.fromEntries(kept.map((p) => [p, Math.floor(100 / kept.length)]));
    sum = Object.values(shares).reduce((a, b) => a + b, 0);
    // Whole percents that add up to 100: scale, then give the remainder to the biggest.
    const scaled = Object.fromEntries(kept.map((p) => [p, Math.floor((shares[p] * 100) / sum)]));
    let rest = 100 - Object.values(scaled).reduce((a, b) => a + b, 0);
    for (const p of kept.slice().sort((a, b) => scaled[b] - scaled[a])) {
      if (rest <= 0) break;
      scaled[p] += 1;
      rest -= 1;
    }
    const split: Split = {};
    for (const p of platforms) split[p] = { share: leftOut.includes(p) ? 0 : scaled[p], why: out.shares.find((s) => s.platform === p)?.why?.trim() || (leftOut.includes(p) ? out.leftOutWhy : "") };
    return { split, leftOut, why: out.leftOutWhy?.trim() ?? "" };
  } catch (err) {
    console.warn("[ads] split failed:", err instanceof Error ? err.message : err);
    return { split: even(), leftOut: [], why: "" };
  }
}

function evenSplit(platforms: AdPlatform[], leftOut: AdPlatform[], old: Split): Split {
  const kept = platforms.filter((p) => !leftOut.includes(p));
  const base = kept.length ? Math.floor(100 / kept.length) : 0;
  const extra = kept.length ? 100 % kept.length : 0;
  const split: Split = {};
  platforms.forEach((p) => {
    const i = kept.indexOf(p);
    split[p] = { share: i < 0 ? 0 : base + (i < extra ? 1 : 0), why: i < 0 ? old[p]?.why ?? "" : "The same for every platform." };
  });
  return split;
}

/** A new campaign from the brief; Reese works out the split and posts it in chat as a card. */
export async function createCampaign(orgId: number, me: { id: number; name: string }, brief: Brief, opts: { quiet?: boolean } = {}) {
  const emp = await reese(orgId);
  const platforms = ORDER.filter((p) => brief.platforms.includes(p));
  if (!platforms.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one platform." });
  if (!brief.name.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the campaign a name." });
  let c = db.ads.addCampaign({
    organizationId: orgId,
    name: brief.name.trim().slice(0, 120),
    goal: brief.goal.trim().slice(0, 300),
    audience: brief.audience.trim().slice(0, 500),
    page: brief.page.trim().slice(0, 500),
    platforms: JSON.stringify(platforms),
    budgetCents: Math.max(0, Math.round(brief.budgetCents)),
    startDate: brief.startDate,
    endDate: brief.endDate,
    splitMode: brief.splitMode ?? "reese",
    formats: (brief.formats ?? "any").slice(0, 80),
    versions: Math.min(3, Math.max(1, brief.versions ?? 1)),
    mustSay: (brief.mustSay ?? "").trim().slice(0, 500),
    neverSay: (brief.neverSay ?? "").trim().slice(0, 500),
    status: "budget",
    createdBy: me.id,
  });
  const s = await working(emp, () => suggestSplit(emp, c));
  c = db.ads.updateCampaign(c.id, { split: JSON.stringify(brief.splitMode === "even" ? evenSplit(platforms, s.leftOut, s.split) : s.split), leftOut: JSON.stringify(s.leftOut), leftOutWhy: s.why });
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: me.name, action: "Ad campaign started", details: `${c.name}: ${platforms.length} platforms, ${money(c.budgetCents)}.` });
  if (!opts.quiet) {
    const days = daysBetween(c.startDate, c.endDate);
    const left = s.leftOut.length ? ` ${s.leftOut.map((p) => PLATFORM[p].name).join(" and ")} ${s.leftOut.length === 1 ? "is" : "are"} left out: ${(s.why || "they reach neighbors, not this audience").replace(/\.$/, "")}.` : "";
    await say(emp, `Here is the split for ${money(c.budgetCents)}${days ? ` over ${days} days` : ""}.${left} Use it, change it, or split it evenly, and I start writing.`, [budgetCard(c)]);
  }
  return c;
}

export function saveCampaign(orgId: number, id: number, patch: Partial<Brief>) {
  const c = db.ads.campaign(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
  const next: Partial<typeof c> = {};
  if (patch.name != null) next.name = patch.name.trim().slice(0, 120) || c.name;
  if (patch.goal != null) next.goal = patch.goal.trim().slice(0, 300);
  if (patch.audience != null) next.audience = patch.audience.trim().slice(0, 500);
  if (patch.page != null) next.page = patch.page.trim().slice(0, 500);
  if (patch.mustSay != null) next.mustSay = patch.mustSay.trim().slice(0, 500);
  if (patch.neverSay != null) next.neverSay = patch.neverSay.trim().slice(0, 500);
  if (patch.formats != null) next.formats = patch.formats.slice(0, 80);
  if (patch.versions != null) next.versions = Math.min(3, Math.max(1, patch.versions));
  if (patch.platforms) {
    const platforms = ORDER.filter((p) => patch.platforms!.includes(p));
    if (!platforms.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one platform." });
    next.platforms = JSON.stringify(platforms);
    const old = splitOf(c);
    const leftOut = leftOutOf(c).filter((p) => platforms.includes(p));
    const split: Split = {};
    for (const p of platforms) split[p] = old[p] ?? { share: 0, why: "" };
    next.split = JSON.stringify(split);
    next.leftOut = JSON.stringify(leftOut);
  }
  return db.ads.updateCampaign(id, next);
}

/** The budget: total, dates, and a share per platform that adds up to 100. */
export function saveBudget(orgId: number, id: number, input: { budgetCents: number; startDate: string; endDate: string; shares: Record<string, number>; mode: "reese" | "even" | "custom" }) {
  const c = db.ads.campaign(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
  const platforms = platformsOf(c);
  const leftOut = leftOutOf(c);
  const old = splitOf(c);
  let split: Split;
  if (input.mode === "even") split = evenSplit(platforms, leftOut, old);
  else {
    split = {};
    for (const p of platforms) split[p] = { share: Math.max(0, Math.round(input.shares[p] ?? old[p]?.share ?? 0)), why: old[p]?.why ?? "" };
    const sum = platforms.reduce((n, p) => n + split[p].share, 0);
    if (sum !== 100) throw new TRPCError({ code: "BAD_REQUEST", message: `The shares add up to ${sum}%. They need to add up to 100%.` });
  }
  return db.ads.updateCampaign(id, { budgetCents: Math.max(0, Math.round(input.budgetCents)), startDate: input.startDate, endDate: input.endDate, split: JSON.stringify(split), splitMode: input.mode });
}

/** The owner took a split: Reese starts on the first platform. */
export async function startWriting(orgId: number, me: { id: number; name: string }, id: number, mode: "reese" | "even" | "custom") {
  const c = db.ads.campaign(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
  if (mode === "even") db.ads.updateCampaign(id, { split: JSON.stringify(evenSplit(platformsOf(c), leftOutOf(c), splitOf(c))), splitMode: "even" });
  else if (c.splitMode !== mode) db.ads.updateCampaign(id, { splitMode: mode });
  if (c.status !== "budget") return db.ads.campaign(orgId, id)!;
  await writeNext(orgId, id, { first: true });
  return db.ads.campaign(orgId, id)!;
}

// ==========================================
// Writing, one platform at a time
// ==========================================

const pending = new Set<Promise<unknown>>();
/** Tests wait here for the writing to finish. */
export async function settled() {
  while (pending.size) await Promise.allSettled(Array.from(pending));
}
function job<T>(p: Promise<T>) {
  const q = p.catch((err) => console.warn("[ads]", err instanceof Error ? err.message : err)).finally(() => pending.delete(q));
  pending.add(q);
  return q;
}

/** The next platform without a current set; writes it in the background and posts the card in chat. */
export async function writeNext(orgId: number, id: number, opts: { first?: boolean; lead?: string } = {}) {
  const c = db.ads.campaign(orgId, id);
  if (!c) return;
  const emp = await reese(orgId);
  const sets = db.ads.sets(c.id);
  const leftOut = leftOutOf(c);
  const next = platformsOf(c).find((p) => !leftOut.includes(p) && !sets.some((s) => s.platform === p && s.status !== "replaced"));
  if (!next) {
    const approved = sets.filter((s) => s.status === "approved").length;
    db.ads.updateCampaign(c.id, { status: "done", currentPlatform: null });
    await say(emp, `That is every platform for ${c.name}: ${approved} approved${sets.some((s) => s.status === "skipped") ? `, ${sets.filter((s) => s.status === "skipped").length} skipped` : ""}. Every set is on my Ads tab with Copy text and the downloads, and Download all gets the whole campaign in one zip.`);
    return;
  }
  db.ads.updateCampaign(c.id, { status: "writing", currentPlatform: next });
  const lead = opts.lead ?? (opts.first ? `${PLATFORM[next].name} first. One platform at a time; the next one comes when you approve this one.` : `${PLATFORM[next].name} next.`);
  job(writeSet(orgId, c.id, next, { lead }));
}

const fieldsSchema = (spec: Spec): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: [...spec.fields.map((f) => f.key), "summary", "imagePrompt"],
  properties: {
    ...Object.fromEntries(spec.fields.map((f) => [f.key, f.kind === "list" ? { type: "array", items: str, description: f.hint } : { type: "string", description: f.hint }])),
    summary: { type: "string", description: "The ad in one line for a list: the headline or hook, at most 80 characters." },
    imagePrompt: { type: "string", description: spec.image ? `The picture: a scene only, no words, letters or logos in it, the subject in the middle. ${spec.image.label}.` : "Empty string; this platform has no picture." },
  },
});

/** Trims every field to its limit and count so what the owner pastes is accepted. */
function fit(spec: Spec, raw: Record<string, unknown>): Content {
  const out: Content = {};
  for (const f of spec.fields) {
    const v = raw[f.key];
    if (f.kind === "list") {
      const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n|·|;/) : []).map((x) => String(x).trim()).filter(Boolean);
      const [, max] = f.count ?? [0, 50];
      out[f.key] = list.map((x) => (f.limit ? x.slice(0, f.limit) : x)).slice(0, max);
    } else {
      const text = typeof v === "string" ? v.trim() : "";
      out[f.key] = f.limit && f.kind === "text" ? text.slice(0, f.limit) : text;
    }
  }
  return out;
}

async function pageText(url: string) {
  if (!/^https?:\/\//i.test(url) && !/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(url)) return "";
  try {
    const p = await fetchWebpage(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return `${p.title}\n${p.text.slice(0, 4000)}`;
  } catch {
    return "";
  }
}

/** Writes one platform's set: the copy to the platform's specs, then the picture (and the audio spot for Spotify). Posts the card in chat. */
export async function writeSet(orgId: number, campaignId: number, platform: AdPlatform, opts: { lead?: string; note?: string; version?: number } = {}) {
  const emp = await reese(orgId);
  const c = db.ads.campaign(orgId, campaignId);
  if (!c) return null;
  const spec = PLATFORM[platform];
  const version = opts.version ?? 1;
  const row = db.ads.addSet({ organizationId: orgId, campaignId, platform, version, status: "writing", content: "{}" });
  try {
    const result = await working(emp, async () => {
      const sets = db.ads.sets(campaignId).filter((s) => s.id !== row.id && s.status !== "replaced");
      // Microsoft Ads is Google Search, copied: same headlines, descriptions and keywords.
      if (spec.copies) {
        const src = sets.filter((s) => s.platform === spec.copies && s.status !== "skipped").slice(-1)[0];
        if (src) return { content: contentOf(src), summary: `Copied from ${PLATFORM[spec.copies].name}`, imagePrompt: "" };
      }
      const approvedSoFar = sets
        .filter((s) => s.status === "approved")
        .map((s) => `${PLATFORM[s.platform].name}: ${s.summary}`)
        .join("\n");
      const notes = [...notesOf(c), ...(opts.note ? [opts.note] : [])];
      const page = await pageText(c.page);
      const { system } = await systemPromptAbout(
        emp,
        `${c.name} ${c.goal} ${c.audience} ${platform}`,
        `Your job: write the ad creative for ONE platform, ${spec.name} (${spec.where}), for this campaign, to that platform's specs, so the owner can paste it straight into the platform's ads manager.
- Fields and their limits:
${spec.fields.map((f) => `  - ${f.label} (${f.key}): ${f.hint}${f.limit ? ` Limit ${f.limit} characters.` : ""}${f.count ? ` ${f.count[0]} to ${f.count[1]} items.` : ""}`).join("\n")}
- Say what the offer is in the platform's own idiom: a search ad answers a search; a feed ad earns a stop; a Reddit post reads like a member; an audio spot is said, not read.
- Use only facts from the Brain and the page the ads go to. No invented numbers, awards, results or testimonials. No health claims and no words aimed at a person's condition.
- Every line the owner says it must say appears; nothing the owner says never to say appears.
- Plain American English, no em dashes, no hype words.
${notes.length ? `- Notes from the owner on this campaign, each one a rule for this set:\n${notes.map((n) => `  - ${n}`).join("\n")}\n` : ""}${approvedSoFar ? `- Already approved on other platforms (keep the offer and the facts the same; match the voice):\n${approvedSoFar}\n` : ""}`
      );
      const out = await generateJson<Record<string, unknown>>({
        system,
        prompt: `Campaign: ${c.name}\nGoal: ${c.goal}\nWho it is for: ${c.audience}\nThe ads go to: ${c.page}\nMust say: ${c.mustSay || "(nothing in particular)"}\nNever say: ${c.neverSay || "(nothing in particular)"}\nPlatform: ${spec.name}${version > 1 ? `\nThis is version ${version}: a different angle from the last one.` : ""}${page ? `\n\nThe page the ads go to:\n${page}` : ""}`,
        schemaName: `ad_${platform}`,
        schema: fieldsSchema(spec),
        maxTokens: 2500,
      });
      return { content: fit(spec, out), summary: String(out.summary ?? "").trim().slice(0, 80), imagePrompt: String(out.imagePrompt ?? "").trim() };
    });
    const content = result.content;
    const summary = result.summary || firstLine(spec, content);
    let imageUrl: string | null = null;
    let imageError: string | null = null;
    if (spec.image && result.imagePrompt) {
      try {
        imageUrl = (await generateImage({ prompt: `${result.imagePrompt}. No text, letters or logos in the image.`, size: spec.image.size, folder: `org-${orgId}/ads` })).url;
      } catch (err) {
        imageError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      }
    }
    let audioUrl: string | null = null;
    let audioError: string | null = null;
    if (spec.audio) {
      const script = String(content.audioScript ?? "");
      if (script) {
        try {
          audioUrl = await speakToFile(orgId, script);
        } catch (err) {
          audioError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        }
      }
    }
    const saved = db.ads.updateSet(row.id, { content: JSON.stringify(content), summary, imagePrompt: result.imagePrompt || null, imageUrl, imageError, audioUrl, audioError, status: "review" });
    db.ads.updateCampaign(c.id, { status: "review", currentPlatform: platform });
    const extra = [imageError ? ` I couldn't make the picture: ${imageError}` : "", audioError ? ` I couldn't make the audio: ${audioError}` : ""].join("");
    await say(emp, `${opts.lead ?? `${spec.name} next.`}${extra}`, [setCard(saved, c)]);
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Ad set written", details: `${c.name}: ${spec.name}${version > 1 ? ` (version ${version})` : ""}.` });
    return saved;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    db.ads.updateSet(row.id, { status: "replaced", error: message });
    db.ads.updateCampaign(c.id, { status: "review", currentPlatform: platform });
    await say(emp, `I couldn't write the ${spec.name} set for ${c.name}: ${message} Say "try ${spec.name} again" and I will.`);
    return null;
  }
}

function firstLine(spec: Spec, content: Content) {
  for (const f of spec.fields) {
    const v = content[f.key];
    const s = Array.isArray(v) ? v[0] : v;
    if (s && String(s).trim()) return String(s).trim().slice(0, 80);
  }
  return "";
}

/** The audio spot as an MP3 in the workspace's files, read by an ElevenLabs voice. */
async function speakToFile(orgId: number, text: string) {
  if (process.env.NODE_ENV === "test") throw new Error("Voices are off in tests.");
  if (!ENV.elevenLabsKey) throw new Error("Voices are not set up: ELEVENLABS_API_KEY is missing on the server.");
  const { elevenVoiceFor } = await import("./huddle");
  const voice = await elevenVoiceFor("ads");
  if (!voice) throw new Error("Your ElevenLabs account has no voices to use.");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ENV.elevenLabsKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: text.slice(0, 1500), model_id: ENV.elevenLabsModel }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs didn't make the audio (${res.status}).`);
  const saved = await storagePut(`org-${orgId}/ads/spot.mp3`, Buffer.from(await res.arrayBuffer()), "audio/mpeg");
  return saved.url;
}

// ==========================================
// Approve, edit, another version, skip, notes
// ==========================================

function setAndCampaign(orgId: number, setId: number) {
  const s = db.ads.set(orgId, setId);
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That set is gone." });
  const c = db.ads.campaign(orgId, s.campaignId)!;
  return { s, c };
}

export async function approveSet(orgId: number, me: { id: number; name: string }, setId: number) {
  const { s, c } = setAndCampaign(orgId, setId);
  if (s.status === "approved") return setView(s);
  if (s.status !== "review") throw new TRPCError({ code: "BAD_REQUEST", message: "That set isn't waiting for approval." });
  const saved = db.ads.updateSet(s.id, { status: "approved", approvedBy: me.name, approvedAt: new Date() });
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: me.name, action: "Ad set approved", details: `${c.name}: ${PLATFORM[s.platform].name}.` });
  if (c.currentPlatform === s.platform) await writeNext(orgId, c.id);
  return setView(saved);
}

export async function skipSet(orgId: number, me: { id: number; name: string }, setId: number) {
  const { s, c } = setAndCampaign(orgId, setId);
  if (s.status !== "review") throw new TRPCError({ code: "BAD_REQUEST", message: "Only a set waiting for you can be skipped." });
  const saved = db.ads.updateSet(s.id, { status: "skipped" });
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: me.name, action: "Ad set skipped", details: `${c.name}: ${PLATFORM[s.platform].name}.` });
  if (c.currentPlatform === s.platform) await writeNext(orgId, c.id);
  return setView(saved);
}

/** Edit: the owner's words replace Reese's; the set still waits for Approve. */
export function saveSet(orgId: number, me: { id: number; name: string }, setId: number, content: Record<string, string | string[]>) {
  const { s } = setAndCampaign(orgId, setId);
  if (s.status !== "review" && s.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "That set can't be changed." });
  const spec = PLATFORM[s.platform];
  const next = fit(spec, { ...contentOf(s), ...content });
  const saved = db.ads.updateSet(s.id, { content: JSON.stringify(next), summary: firstLine(spec, next) });
  void me;
  return setView(saved);
}

/** Another version: the old one is replaced and a new one is written with the owner's note. */
export async function rewriteSet(orgId: number, me: { id: number; name: string }, setId: number, note: string) {
  const { s, c } = setAndCampaign(orgId, setId);
  if (s.status !== "review" && s.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "That set can't be rewritten." });
  db.ads.updateSet(s.id, { status: "replaced" });
  db.ads.updateCampaign(c.id, { status: "writing", currentPlatform: s.platform });
  const n = note.trim();
  job(writeSet(orgId, c.id, s.platform, { version: s.version + 1, note: n || undefined, lead: `Another ${PLATFORM[s.platform].name} version${n ? `, with "${n.slice(0, 80)}"` : ""}.` }));
  void me;
  return { ok: true };
}

/** A note the owner gives along the way ("make the headline shorter"): kept, and applied to every set written after. */
export function addNote(orgId: number, id: number, note: string) {
  const c = db.ads.campaign(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
  const n = note.trim().slice(0, 300);
  if (!n) return c;
  return db.ads.updateCampaign(id, { notes: JSON.stringify([...notesOf(c), n]) });
}

/** Try a platform again after a failure, or write one that was left out. */
export async function writePlatform(orgId: number, id: number, platform: AdPlatform) {
  const c = db.ads.campaign(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
  const leftOut = leftOutOf(c);
  if (leftOut.includes(platform)) db.ads.updateCampaign(id, { leftOut: JSON.stringify(leftOut.filter((p) => p !== platform)) });
  const have = db.ads.sets(id).filter((s) => s.platform === platform && s.status !== "replaced");
  if (have.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${PLATFORM[platform].name} already has a set. Ask for another version instead.` });
  db.ads.updateCampaign(id, { status: "writing", currentPlatform: platform });
  job(writeSet(orgId, id, platform, { lead: `${PLATFORM[platform].name}, as asked.` }));
  return { ok: true };
}

/** The campaign the owner most likely means in chat: the newest one with a set waiting, else the newest. */
export function currentCampaign(orgId: number) {
  const all = db.ads.campaigns(orgId);
  return all.find((c) => c.status === "review" || c.status === "writing" || c.status === "budget") ?? all[0] ?? null;
}

/** Download all: every set's text and pictures in one zip, saved to the workspace's files. */
export async function zipCampaign(orgId: number, id: number) {
  const c = db.ads.campaign(orgId, id);
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
  const zip = new JSZip();
  const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "campaign";
  const v = campaignView(c);
  const budget = [`${c.name} · budget ${v.budget}${v.days ? ` · ${c.startDate} to ${c.endDate} (${v.days} days)` : ""}`, ""];
  for (const r of v.rows) if (!r.leftOut) budget.push(`${r.name}: ${r.share}% · ${money(r.totalCents)} total · ${money(r.perDayCents)} per day${r.why ? ` · ${r.why}` : ""}`);
  zip.file(`${slug}/budget.txt`, budget.join("\n"));
  const { uploadsRoot } = await import("../storage");
  const fs = await import("node:fs");
  const path = await import("node:path");
  for (const s of db.ads.sets(id)) {
    if (s.status !== "approved" && s.status !== "review") continue;
    const name = `${slug}/${s.platform}`;
    zip.file(`${name}.txt`, setText(s, c));
    for (const [url, ext] of [[s.imageUrl, ""], [s.audioUrl, ""]] as const) {
      if (!url || !url.startsWith("/files/")) continue;
      const file = path.join(uploadsRoot(), url.slice("/files/".length));
      if (fs.existsSync(file)) zip.file(`${name}${ext}${path.extname(file)}`, fs.readFileSync(file));
    }
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const saved = await storagePut(`org-${orgId}/ads/${slug}.zip`, buf, "application/zip");
  return { url: saved.url };
}

export const _test = { fit, evenSplit, fieldsSchema };
