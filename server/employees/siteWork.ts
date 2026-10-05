import * as db from "../db";
import { generateText } from "../_core/llm";
import { storagePut } from "../storage";
import type { AIEmployee, ChatFile } from "../../drizzle/schema";
import { systemPromptAbout, working } from "./tasks";
import { leanHtml, readHtml, readSite, siteBrief, type SiteRead } from "./siteReader";
import { DOCX_MIME, simpleDocx } from "./docWriter";

/**
 * Jordan's work on the owner's existing website: reading it (the real HTML,
 * not clicking around a browser), auditing a page for an audience, and
 * mocking up the new version as a live preview in the chat.
 */

const busy = new Map<number, string>();
export const siteWorkInProgress = (orgId: number) => busy.get(orgId) ?? null;

async function post(emp: AIEmployee, content: string, cards: unknown[] = []) {
  return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: cards.length ? JSON.stringify(cards) : null });
}

function background(emp: AIEmployee, label: string, job: () => Promise<unknown>) {
  const orgId = emp.organizationId;
  busy.set(orgId, label);
  void job()
    .catch(async (err) => {
      await post(emp, `I couldn't finish ${label}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}. Attach the page's HTML file here and I'll read that instead, or send me the page's exact address.`);
    })
    .finally(() => busy.delete(orgId));
}

const fmtDate = (tz: string) => new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: tz });
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The site to read: the address given, else the workspace's website. Empty when there's neither. */
export async function siteAddress(orgId: number, url: string) {
  const u = url.trim();
  if (u) return /^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, "")}`;
  const org = await db.getOrganizationById(orgId);
  const w = (org?.website ?? "").trim();
  return w ? (/^https?:\/\//i.test(w) ? w : `https://${w}`) : "";
}

/** HTML files attached in the chat: the owner's own page code. */
export function htmlFiles(files: Pick<ChatFile, "name" | "text" | "mime">[]) {
  return files.filter((f) => /\.html?$/i.test(f.name) || /text\/html/i.test(f.mime ?? "")).map((f) => ({ name: f.name, html: f.text }));
}

/** The site, from attached HTML files first, else from the web. */
async function gather(url: string, about: string, html: { name: string; html: string }[], max: number): Promise<SiteRead> {
  if (html.length) {
    const base = url || "https://your-site.example/";
    const pages = html.map((f) => readHtml(f.html, new URL(f.name.replace(/[^\w.-]+/g, "-"), base).toString()).page);
    return { start: pages[0].url, pages, links: [] };
  }
  return readSite(url, { max, about });
}

// ==========================================
// The audit
// ==========================================

const AUDIT_RULES = `You audit a page of the owner's website for a specific audience, the way an experienced conversion copywriter and web designer would.
- Read the page you're given: its words, headings, buttons, images, forms and markup. Quote its real words when you point at something ("The headline says: ...").
- Use only what's on the page and what you were told. Never invent statistics, results, testimonials, prices or features. Prices exactly as the page shows them.
- No em dashes or en dashes. Plain, specific, warm.
- Write in this exact format, nothing before the title:
# Website audit: <the page's name>
<the page address> · <the date you're given>
_For: <the audience>_
## The short version
2 to 4 sentences: who the page works for now, what stops the audience from acting, and the three changes that matter most.
## Change
- **<what, where on the page>:** Now: "<its words>". Change to: "<new words>". Why: <one sentence>.
## Add
- **<what>:** <where on the page, the words or element to add, and why>.
## Cut
- **<what>:** "<its words>". Why: <one sentence>.
## Order of the page
- The sections in the order they should run, one line each.
## Images and design
- What the pictures, graphics, colors, type and spacing should do, specific to this page.
## Before it goes live
- Missing facts the owner must fill in (as [THE FACT]), broken links, buttons without a link, forms, page title and meta description.
Each list has 3 to 8 points, most important first.`;

/** Starts the audit in the background; returns what Jordan says now. */
export async function startSiteAudit(emp: AIEmployee, input: { url: string; about: string; audience: string; said: string; html?: { name: string; html: string }[] }) {
  const orgId = emp.organizationId;
  if (busy.has(orgId)) return `I'm still working on ${busy.get(orgId)}. I'll post it here when it's done.`;
  const html = input.html ?? [];
  const url = html.length ? input.url : await siteAddress(orgId, input.url);
  if (!url && !html.length) return "What's the address of the page? Send me the link (or attach the page's HTML file) and I'll read it and write the audit here.";
  const label = `the audit of ${html.length ? html[0].name : hostOf(url) || url}`;
  background(emp, label, () => writeSiteAudit(emp, { ...input, url, html }));
  return `Reading ${html.length ? html.map((f) => f.name).join(", ") : url} now${html.length ? "" : ", the page's real HTML and the pages it links to"}. The audit will show up here as a document you can open right in this chat, with what to change, add and cut.`;
}

export async function writeSiteAudit(emp: AIEmployee, input: { url: string; about: string; audience: string; said: string; html?: { name: string; html: string }[] }) {
  const orgId = emp.organizationId;
  return working(emp, async () => {
    const site = await gather(input.url, `${input.about} ${input.said}`, input.html ?? [], 3);
    const tz = (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
    const { system } = await systemPromptAbout(emp, `${input.about} ${input.audience} website ${site.pages[0]?.title ?? ""}`, AUDIT_RULES);
    const text = await generateText({
      system,
      prompt: `What the owner asked for: ${input.said || input.about}\nThe page to audit: ${input.about || "the start page"} (when several pages are below, audit the one that matches; the others are for context).\nAudience: ${input.audience || "the audience the owner named, else the page's own audience"}\nToday's date: ${fmtDate(tz)}\n\n${siteBrief(site, { html: true, textChars: 10_000, htmlChars: 25_000 })}`,
      maxTokens: 6000,
      timeoutMs: 240_000,
    });
    const doc = text.replace(/\s*[–—]\s*/g, ", ").replace(/^```\w*\s*|```\s*$/g, "").trim();
    if (!doc.startsWith("# ")) throw new Error("The audit came back in the wrong shape");
    const title = doc.split("\n")[0].replace(/^#\s*/, "").replace(/^Website audit:\s*/i, "").trim() || hostOf(site.start);
    const count = (head: string) => (doc.split(new RegExp(`^## ${head}\\b`, "m"))[1]?.split(/^## /m)[0].match(/^- /gm) ?? []).length;
    const buf = await simpleDocx(doc);
    const name = `${title.replace(/[^\w\s.,()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 70) || "Website"} - website audit.docx`;
    const saved = await storagePut(`org-${orgId}/site/${Date.now()}-${name.replace(/\s+/g, "-")}`, buf, DOCX_MIME);
    const file = db.createChatFile({ organizationId: orgId, employeeId: emp.id, name, mime: DOCX_MIME, size: buf.length, kind: "document", fileUrl: saved.url, text: doc.slice(0, 200_000), pages: null });
    const [c, a, x] = [count("Change"), count("Add"), count("Cut")];
    const msg = await post(
      emp,
      `The audit of ${title} is ready: ${c} ${c === 1 ? "thing" : "things"} to change, ${a} to add and ${x} to cut${input.audience ? ` for ${input.audience}` : ""}. Press Open to read it here. Say "mock it up" and I'll build the new version of the page with these changes, so you can see it before anything goes live.`,
      [{ type: "doc", id: file.id, title: `Website audit: ${title}`, subtitle: `Word document · ${site.pages[0]?.url ?? ""}`.replace(/ · $/, "") }]
    );
    db.attachChatFiles(orgId, [file.id], msg.id);
    return { file, site };
  });
}

/** The newest audit in Jordan's chat, for the mockup. */
export function latestAudit(orgId: number, empId: number) {
  return db.recentChatFiles(orgId, empId, 30).find((f) => / - website audit\.docx$/.test(f.name)) ?? null;
}

// ==========================================
// The mockup
// ==========================================

/**
 * Reads the owner's page and has Jordan rebuild it as a new version: her real
 * words, offer and images, with the audit's changes when there is one. The
 * result is a page with versions, shown live in the chat (desktop or phone,
 * full screen, Copy HTML).
 */
export async function startSiteMockup(emp: AIEmployee, input: { url: string; about: string; said: string; notes: string; pageType: "landing" | "website"; html?: { name: string; html: string }[]; photos?: { url: string; text: string; name: string }[]; useAudit: boolean }) {
  const orgId = emp.organizationId;
  if (busy.has(orgId)) return { text: `I'm still working on ${busy.get(orgId)}. I'll post it here when it's done.`, pageId: null as number | null };
  const html = input.html ?? [];
  const audit = input.useAudit ? latestAudit(orgId, emp.id) : null;
  const url = html.length ? input.url : await siteAddress(orgId, input.url || (audit?.text.split("\n")[1]?.split(" · ")[0] ?? ""));
  if (!url && !html.length) return { text: "Which page should I mock up? Send me the link, or attach the page's HTML file.", pageId: null };
  const site = await gather(url, `${input.about} ${input.said}`, html, 0).catch((err: Error) => {
    throw new Error(`I couldn't read ${url || "the file"}: ${err.message}`);
  });
  const page = site.pages[0];
  const source = [
    `The owner's current page${html.length ? ` (from the attached file ${html[0].name})` : ` at ${page.url}`}. Rebuild it as the new, better version:`,
    "- Keep her real words, offer, prices, names and facts unless the audit or her notes change them. Never invent new ones; use [THE FACT] where something is missing.",
    "- Her own images listed below can be used as they are, with the link as the img src.",
    audit ? `- Make every change in this audit:\n${audit.text.slice(0, 20_000)}` : "",
    siteBrief({ ...site, pages: [page] }, { html: true, textChars: 15_000, htmlChars: 45_000 }),
  ]
    .filter(Boolean)
    .join("\n");
  const pages = await import("./pages");
  const title = (input.about || page.title || hostOf(page.url) || "Your page").replace(/\s+/g, " ").slice(0, 120);
  const p = await pages.startPage(orgId, { title: `${title} (new version)`, pageType: input.pageType, goal: input.notes.slice(0, 400) || "The page's own goal" }, { notes: [input.said, input.notes].filter(Boolean).join("\n\n"), photos: input.photos, source });
  return {
    text: `Building the new version of ${title} now${audit ? ", with the changes from the audit" : ""}, using your real words${page.images.length ? `, your ${page.images.length} images` : ""}, and pictures and graphics I make where the page needs them. It takes a few minutes, and it'll show up here as a live preview you can see on desktop or phone, with the HTML to copy.`,
    pageId: p.id,
  };
}

/** HTML attached in the chat, kept as markup (not stripped to text) so Jordan can read the page's code. */
export function keepHtml(raw: string) {
  return leanHtml(raw).slice(0, 400_000);
}
