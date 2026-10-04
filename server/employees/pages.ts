import crypto from "node:crypto";
import path from "node:path";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateText } from "../_core/llm";
import { generateImage } from "../_core/imageGeneration";
import type { AIEmployee, SitePage } from "../../drizzle/schema";
import { employeeFor, systemPromptAbout, working, actor } from "./tasks";

/**
 * Jordan builds landing and website pages as one piece of HTML the owner can
 * paste into a custom code element on the LeadDash platform: a fonts link, one
 * style block scoped to the page's own wrapper class (so the page builder's
 * styles cannot change it), and the markup. Photos from the Brain and
 * generated stock images get public links so the pasted page shows them.
 * Every build and change is saved as a version.
 */

const MAX_STOCK = 3;

export const PAGE_DESIGN = `How to build the page (follow every point):
- Output ONLY an HTML fragment: optionally one Google Fonts <link>, then one <style> block, then one <div class="{WRAP}"> holding the whole page. No <html>, <head>, <body> or <script>. Every CSS selector starts with .{WRAP} so nothing leaks in or out. Reset margins inside the wrapper and set the font, colors and box-sizing on it.
- Design to the standard of a top product studio: a modern, image-led layout with clear hierarchy and generous whitespace. Typical order for a landing page: slim header (brand name and one button), split hero (eyebrow, headline, one-line subhead, primary button, small trust line beside a strong image), press or proof strip, 3 benefit cards with simple inline SVG icons, how it works in 3 steps, a section that alternates image and text, honest proof (only real numbers, real press, real permitted quotes), FAQ using <details>, a full-width closing call to action, a small footer. A website page follows the same craft with sections that fit its purpose.
- Layout: max content width about 1120px, CSS grid and flex, section padding about 96px on desktop and 56px on phone, one breakpoint at 768px where columns stack. Buttons at least 44px tall with clear hover states. Rounded corners 12 to 20px, soft shadows used sparingly.
- Type: one display font and one body font from Google Fonts (from the brand guide when the Brain has one). Headlines about 48 to 60px on desktop and 32 to 38px on phone; body 17 to 18px with line height about 1.6.
- Color: the workspace's brand colors from the Brain or company training. One accent color for buttons and highlights. Text contrast at least 4.5:1.
- Images: every page has at least one strong image. For pages about the owner or the company, use the owner's photos from the Brain with {{photo:ID}}. For other images, write {{stock:a specific description of a realistic photo}} (at most ${MAX_STOCK}); describe real-looking people and settings that match the audience, never people in distress, never clinical stereotypes. Every <img> has alt text and object-fit: cover.
- The main button links to {{button_url}}. Where a form belongs, put {{form}} on its own line inside a section.
- Never: walls of text, everything centered, generic purple gradients, emoji, clip art, lorem ipsum, invented testimonials, invented statistics, invented logos. Placeholders like [YOUR PRICE] where a fact is missing.`;

function wrapClass(pageId: number) {
  return `ldp-${pageId}`;
}

function clean(html: string) {
  return html
    .replace(/^[\s\S]*?```(?:html)?\s*/i, (m) => (m.includes("```") ? "" : m))
    .replace(/```\s*$/i, "")
    .replace(/—|–/g, ", ")
    .trim();
}

/** A public link for a stored file, made once and reused. */
export function publicLink(orgId: number, fileUrl: string) {
  const key = fileUrl.replace(/^\/files\//, "");
  const row = db.publicFileByKey(key) ?? db.createPublicFile({ token: crypto.randomBytes(12).toString("hex"), organizationId: orgId, fileKey: key });
  return `${ENV.appUrl}/pub/${row!.token}${path.extname(key)}`;
}

async function photosOnFile(orgId: number) {
  return (await db.listKnowledgeByOrg(orgId)).filter((k) => k.kind === "image" && k.employeeId == null && k.fileUrl);
}

/** Swaps placeholders for real links: Brain photos, generated stock images, the button and the form. */
async function fill(orgId: number, page: SitePage, html: string, onProgress: (s: string) => void) {
  const photos = await photosOnFile(orgId);
  let out = html.replace(/\{\{photo:(\d+)\}\}/g, (_, id) => {
    const p = photos.find((x) => x.id === Number(id));
    return p ? publicLink(orgId, p.fileUrl!) : "";
  });
  const stock = Array.from(new Set(Array.from(out.matchAll(/\{\{stock:([^}]{3,400})\}\}/g)).map((m) => m[1].trim()))).slice(0, MAX_STOCK);
  if (stock.length) {
    onProgress(`Making ${stock.length} stock image${stock.length === 1 ? "" : "s"}`);
    const made = await Promise.all(
      stock.map(async (desc) => {
        try {
          const img = await generateImage({ prompt: `Realistic editorial photograph for a professional website: ${desc}. Natural light, authentic people, no text, no logos.`, size: "1536x1024", quality: "medium", folder: `org-${orgId}/pages` });
          return publicLink(orgId, img.url);
        } catch (err) {
          console.warn("[pages] stock image failed:", err instanceof Error ? err.message : err);
          return "";
        }
      })
    );
    stock.forEach((desc, i) => {
      out = out.split(`{{stock:${desc}}}`).join(made[i]);
    });
  }
  out = out.replace(/\{\{stock:[^}]*\}\}/g, "");
  out = out.split("{{button_url}}").join(page.buttonUrl || "#");
  out = out.split("{{form}}").join(page.embedCode || "");
  return out;
}

async function brief(emp: AIEmployee, page: SitePage) {
  const photos = await photosOnFile(emp.organizationId);
  const photoList = photos.length
    ? `\nPhotos on file (use {{photo:ID}}):\n${photos.slice(0, 40).map((p) => `- ${p.id}: ${p.title}${p.content ? `: ${p.content}` : ""}`).join("\n")}`
    : "\nNo photos on file: use {{stock:...}} images.";
  return `${PAGE_DESIGN.split("{WRAP}").join(wrapClass(page.id))}${photoList}`;
}

/** Starts a page; the build runs in the background and posts to chat when ready. */
export async function startPage(orgId: number, input: { title: string; pageType: "landing" | "website"; goal: string; buttonUrl?: string | null }) {
  const emp = await employeeFor(orgId, "website");
  const page = db.createSitePage({ organizationId: orgId, employeeId: emp.id, title: input.title.slice(0, 200), pageType: input.pageType, goal: input.goal.slice(0, 500), buttonUrl: input.buttonUrl ?? null, status: "building", progress: "Writing the page" });
  void build(emp, page, null);
  return page;
}

/** Asks for changes; Jordan makes a new version from the current one. */
export async function revisePage(orgId: number, pageId: number, request: string) {
  const emp = await employeeFor(orgId, "website");
  const page = db.getSitePage(pageId, orgId);
  if (!page) throw new Error("That page is not in this workspace.");
  if (page.status === "building") throw new Error(`${emp.name} is still working on this page.`);
  const updated = db.updateSitePage(pageId, orgId, { status: "building", progress: "Making your changes" });
  void build(emp, updated, request.slice(0, 2000));
  return updated;
}

async function build(emp: AIEmployee, page: SitePage, request: string | null) {
  const orgId = emp.organizationId;
  const progress = (s: string) => void db.updateSitePage(page.id, orgId, { progress: s });
  try {
    const current = request ? db.listSitePageVersions(page.id, orgId)[0] : null;
    const html = await working(emp, async () => {
      const { system } = await systemPromptAbout(
        emp,
        `${page.title} ${page.goal} ${request ?? ""}`,
        `Your job: ${request ? "change an existing" : "build a complete"} ${page.pageType === "website" ? "website page" : "landing page"} as HTML the owner pastes into their site builder.\n\n${await brief(emp, page)}`
      );
      const prompt = request && current
        ? `Page: ${page.title}\nGoal: ${page.goal}\n\nThe owner asked for these changes:\n${request}\n\nMake them, keep everything else as it is, and return the whole updated fragment (same wrapper class). Current page:\n${current.html}`
        : `Page: ${page.title}\nType: ${page.pageType === "website" ? "website page" : "landing page"}\nGoal: ${page.goal}\nThe main button: ${page.buttonUrl ? "links to {{button_url}}" : "links to {{button_url}} (the owner adds the link later)"}`;
      return clean(await generateText({ system, prompt, maxTokens: 16000, temperature: 0.7, timeoutMs: 290_000 }));
    });
    if (!html.includes(wrapClass(page.id))) throw new Error("The page came back without its wrapper. Ask again and I'll rebuild it.");
    const filled = await fill(orgId, page, html, progress);
    const version = (current?.version ?? page.currentVersion) + 1;
    db.addSitePageVersion({ organizationId: orgId, pageId: page.id, version, html: filled, note: request ? request.slice(0, 200) : "First build" });
    const done = db.updateSitePage(page.id, orgId, { status: "ready", currentVersion: version, progress: null });
    await db.createChatMessage({
      organizationId: orgId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: request
        ? `Done: version ${version} of ${page.title} has your changes. Earlier versions are saved on the Pages tab.`
        : `Ready for review: ${page.title}. Preview it on desktop and phone on the Pages tab, then Copy HTML and paste it into a custom code element on your page.`,
      cards: JSON.stringify([pageCard(done)]),
    });
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: request ? "Changed a page" : "Built a page", details: `${page.title}, version ${version}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pages] build failed:", message);
    db.updateSitePage(page.id, orgId, { status: page.currentVersion ? "ready" : "failed", progress: `Stopped: ${message.slice(0, 200)}` });
    await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `I couldn't finish ${page.title}: ${message.slice(0, 200)}` });
  }
}

export function pageCard(p: SitePage) {
  return { type: "page" as const, id: p.id, title: p.title, subtitle: `${p.pageType === "website" ? "Website page" : "Landing page"} · version ${p.currentVersion}`, body: p.goal };
}

export function restoreVersion(orgId: number, pageId: number, version: number) {
  const v = db.listSitePageVersions(pageId, orgId).find((x) => x.version === version);
  if (!v) throw new Error("That version is not saved.");
  const latest = db.listSitePageVersions(pageId, orgId)[0];
  const next = latest.version + 1;
  db.addSitePageVersion({ organizationId: orgId, pageId, version: next, html: v.html, note: `Restored version ${version}` });
  return db.updateSitePage(pageId, orgId, { currentVersion: next, status: "ready" });
}

/** Saves the button link and form embed, and puts them into the current version. */
export function saveDetails(orgId: number, pageId: number, input: { buttonUrl: string; embedCode: string }) {
  const page = db.getSitePage(pageId, orgId);
  if (!page) throw new Error("That page is not in this workspace.");
  const versions = db.listSitePageVersions(pageId, orgId);
  const updated = db.updateSitePage(pageId, orgId, { buttonUrl: input.buttonUrl || null, embedCode: input.embedCode || null });
  const cur = versions[0];
  if (cur) {
    let html = cur.html;
    if (page.buttonUrl && input.buttonUrl && page.buttonUrl !== input.buttonUrl) html = html.split(`href="${page.buttonUrl}"`).join(`href="${input.buttonUrl}"`);
    else if (!page.buttonUrl && input.buttonUrl) html = html.split('href="#"').join(`href="${input.buttonUrl}"`);
    if (input.embedCode && input.embedCode !== page.embedCode) {
      html = page.embedCode && html.includes(page.embedCode) ? html.split(page.embedCode).join(input.embedCode) : html.replace(/<\/div>\s*$/, `<div class="ldp-form">${input.embedCode}</div></div>`);
    }
    if (html !== cur.html) {
      db.addSitePageVersion({ organizationId: orgId, pageId, version: cur.version + 1, html, note: "Button link or form updated" });
      return db.updateSitePage(pageId, orgId, { currentVersion: cur.version + 1 });
    }
  }
  return updated;
}

export function approvePage(orgId: number, pageId: number) {
  const page = db.getSitePage(pageId, orgId);
  if (!page) throw new Error("That page is not in this workspace.");
  return db.updateSitePage(pageId, orgId, { status: "approved" });
}

/** The page as a full document, for preview and download. */
export function fullDocument(title: string, fragment: string) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title.replace(/</g, "")}</title>\n<style>body{margin:0}</style>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;
}
