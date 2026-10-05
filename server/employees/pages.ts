import crypto from "node:crypto";
import path from "node:path";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, generateText } from "../_core/llm";
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
const MAX_GRAPHICS = 3;

export const PAGE_DESIGN = `How to build the page (follow every point):
- Output ONLY an HTML fragment: optionally one Google Fonts <link>, then one <style> block, then one <div class="{WRAP}"> holding the whole page. No <html>, <head>, <body> or <script>. Every CSS selector starts with .{WRAP} so nothing leaks in or out. Reset margins inside the wrapper and set the font, colors and box-sizing on it.
- Design to the standard of a top product studio: a modern, image-led layout with clear hierarchy and generous whitespace. Typical order for a landing page: slim header (brand name and one button), split hero (eyebrow, headline, one-line subhead, primary button, small trust line beside a strong image), press or proof strip, 3 benefit cards with simple inline SVG icons, how it works in 3 steps, a section that alternates image and text, honest proof (only real numbers, real press, real permitted quotes), FAQ using <details>, a full-width closing call to action, a small footer. A website page follows the same craft with sections that fit its purpose.
- Layout: max content width about 1120px, CSS grid and flex, section padding about 96px on desktop and 56px on phone, one breakpoint at 768px where columns stack. Buttons at least 44px tall with clear hover states. Rounded corners 12 to 20px, soft shadows used sparingly.
- Type: one display font and one body font from Google Fonts (from the brand guide when the Brain has one). Headlines about 48 to 60px on desktop and 32 to 38px on phone; body 17 to 18px with line height about 1.6.
- Color: the workspace's brand colors from the Brain or company training. One accent color for buttons and highlights. Text contrast at least 4.5:1.
- Images: every page has at least one strong image. For pages about the owner or the company, use the owner's images from the Brain with {{photo:ID}} (her photos, logo and graphics). For other photos, write {{stock:a specific description of a realistic photo}} (at most ${MAX_STOCK}); describe real-looking people and settings that match the audience, never people in distress, never clinical stereotypes. Every <img> has alt text and object-fit: cover.
- Graphics: draw icons, diagrams, steps, timelines, comparison tables, number callouts and simple charts in the page itself with inline SVG and CSS in the brand colors, so the words stay real text. For an illustration a photo can't show (a feeling, a metaphor, a concept), write {{graphic:a specific description of a flat modern illustration}} (at most ${MAX_GRAPHICS}); it is made without any words in it.
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
  const graphics = Array.from(new Set(Array.from(out.matchAll(/\{\{graphic:([^}]{3,400})\}\}/g)).map((m) => m[1].trim()))).slice(0, MAX_GRAPHICS);
  if (graphics.length) {
    onProgress(`Making ${graphics.length} graphic${graphics.length === 1 ? "" : "s"}`);
    const colors = ((await db.getOrganizationById(orgId))?.brandColors ?? "").match(/#[0-9a-f]{6}/gi) ?? [];
    const made = await Promise.all(
      graphics.map(async (desc) => {
        try {
          const img = await generateImage({ prompt: `Flat modern vector illustration for a professional website section: ${desc}. Simple rounded shapes, no outlines, a soft light background${colors.length ? `, using mainly ${colors.slice(0, 3).join(", ")} and warm neutrals` : ""}. No text, letters, numbers or logos anywhere in the image.`, size: "1536x1024", quality: "medium", folder: `org-${orgId}/pages` });
          return publicLink(orgId, img.url);
        } catch (err) {
          console.warn("[pages] graphic failed:", err instanceof Error ? err.message : err);
          return "";
        }
      })
    );
    graphics.forEach((desc, i) => {
      out = out.split(`{{graphic:${desc}}}`).join(made[i]);
    });
  }
  out = out.replace(/\{\{graphic:[^}]*\}\}/g, "");
  out = out.split("{{button_url}}").join(page.buttonUrl || "#");
  out = out.split("{{form}}").join(page.embedCode || "");
  return out;
}

async function brief(emp: AIEmployee, page: SitePage) {
  const photos = await photosOnFile(emp.organizationId);
  const photoList = photos.length
    ? `\nImages on file in the Brain (photos, logo, graphics; use {{photo:ID}}):\n${photos.slice(0, 40).map((p) => `- ${p.id}: ${p.title}${p.content ? `: ${p.content}` : ""}`).join("\n")}`
    : "\nNo photos on file: use {{stock:...}} images.";
  return `${PAGE_DESIGN.split("{WRAP}").join(wrapClass(page.id))}${photoList}`;
}

/** What the owner chose in chat before the first build: the layout, where the button goes, notes and attached photos. */
export type BuildExtra = { layout?: string; button?: string; notes?: string; photos?: { url: string; text: string; name: string }[]; source?: string };

const LAYOUT_GUIDE: Record<string, string> = {
  split: "Layout: split hero with the photo beside the headline; the photo carries the page.",
  bold: "Layout: a big centered headline first with the button under it, then the image below or in the next section; the promise carries the page.",
  story: "Layout: open with the problem and why it matters in a short story section, then the offer, then proof.",
};

function layoutLine(layout?: string) {
  const l = (layout ?? "").toLowerCase();
  if (!l) return "";
  if (l.includes("photo") || l.includes("split")) return LAYOUT_GUIDE.split;
  if (l.includes("headline") || l.includes("bold")) return LAYOUT_GUIDE.bold;
  if (l.includes("story")) return LAYOUT_GUIDE.story;
  return `Layout the owner asked for: ${layout}`;
}

function buttonLine(button?: string) {
  const b = (button ?? "").toLowerCase();
  if (!b) return "";
  if (b.includes("form on the page")) return "The main button scrolls to a form section: put {{form}} in that section and link the button to #form.";
  if (b.includes("email")) return "The main button opens an email to the owner: link it to {{button_url}} (the owner adds the address).";
  return `The main button goes to: ${button} (link it to {{button_url}}).`;
}

/** Starts a page; the build runs in the background and posts to chat when ready. */
export async function startPage(orgId: number, input: { title: string; pageType: "landing" | "website"; goal: string; buttonUrl?: string | null }, extra: BuildExtra = {}) {
  const emp = await employeeFor(orgId, "website");
  const page = db.createSitePage({ organizationId: orgId, employeeId: emp.id, title: input.title.slice(0, 200), pageType: input.pageType, goal: input.goal.slice(0, 500), buttonUrl: input.buttonUrl ?? null, status: "building", progress: "Writing the page" });
  void build(emp, page, null, extra);
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

async function build(emp: AIEmployee, page: SitePage, request: string | null, extra: BuildExtra = {}) {
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
        : [
            `Page: ${page.title}`,
            `Type: ${page.pageType === "website" ? "website page" : "landing page"}`,
            `Goal: ${page.goal}`,
            buttonLine(extra.button) || `The main button: ${page.buttonUrl ? "links to {{button_url}}" : "links to {{button_url}} (the owner adds the link later)"}`,
            layoutLine(extra.layout),
            extra.photos?.length ? `Photos the owner attached for this page (use these first, with the link as the img src):\n${extra.photos.map((p) => `- ${p.url}: ${p.text || p.name}`).join("\n")}` : "",
            extra.notes ? `What the owner told you and gave you:\n${extra.notes.slice(0, 12000)}` : "",
            extra.source ? `\n${extra.source}` : "",
          ].filter(Boolean).join("\n");
      return clean(await generateText({ system, prompt, maxTokens: 16000, temperature: 0.7, timeoutMs: 290_000 }));
    });
    if (!html.includes(wrapClass(page.id))) throw new Error("The page came back without its wrapper. Ask again and I'll rebuild it.");
    const filled = await fill(orgId, page, html, progress);
    const version = (current?.version ?? page.currentVersion) + 1;
    db.addSitePageVersion({ organizationId: orgId, pageId: page.id, version, html: filled, note: request ? request.slice(0, 200) : "First build" });
    const done = db.updateSitePage(page.id, orgId, { status: "ready", currentVersion: version, progress: null });
    const talk = await talkAbout(emp, page, filled, request, version);
    await db.createChatMessage({
      organizationId: orgId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content: talk.content,
      cards: JSON.stringify([pageCard(done), ...(talk.choices.length ? [{ type: "choices", id: Date.now(), title: "", options: talk.choices }] : [])]),
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
  return { type: "page" as const, id: p.id, version: p.currentVersion, title: p.title, subtitle: `${p.pageType === "website" ? "Website page" : "Landing page"} · version ${p.currentVersion}`, body: p.goal };
}

/** Jordan's message with a new version: why she laid it out that way (first build) or exactly what changed, then quick replies. */
async function talkAbout(emp: AIEmployee, page: SitePage, html: string, request: string | null, version: number) {
  const fallback = {
    content: request ? `Here's version ${version} with your changes. Version ${version - 1} is saved if you want it back.` : `Here's version 1 of ${page.title}.`,
    choices: request ? ["Looks good", "Go back to the last version"] : ["Shorter headline", "Different photo", "Looks good"],
  };
  try {
    const text = (await import("./files")).htmlToText(html).slice(0, 4000);
    const out = await generateJson<{ message: string; why: string[]; choices: string[] }>({
      system: `You are ${emp.name}, the owner's web designer, talking with them in chat about a page you just ${request ? "changed" : "built"}. Plain, warm, specific. No em dashes.`,
      prompt: request
        ? `They asked: ${request.slice(0, 1500)}\nThis is version ${version}.\nThe page now reads:\n${text}\n\nmessage: one or two sentences saying exactly what you changed and that version ${version - 1} is saved. why: []. choices: 2 to 4 short next things they might say about this page (under 6 words each), ending with "Looks good".`
        : `Page: ${page.title}. Goal: ${page.goal}.\nThe page reads:\n${text}\n\nmessage: one sentence introducing version 1. why: 3 short points on why you laid it out this way (each one sentence, about this page). choices: 3 or 4 short changes they might want (under 6 words each), ending with "Looks good".`,
      schemaName: "page_talk",
      schema: { type: "object", additionalProperties: false, required: ["message", "why", "choices"], properties: { message: { type: "string" }, why: { type: "array", items: { type: "string" } }, choices: { type: "array", items: { type: "string" } } } },
      maxTokens: 700,
    });
    if (!out?.message) return fallback;
    const why = (out.why ?? []).filter(Boolean).slice(0, 4);
    return {
      content: `${out.message.trim()}${why.length ? `\n${why.map((w) => `- ${w.trim()}`).join("\n")}` : ""}`.replace(/—|–/g, ", "),
      choices: (out.choices ?? []).map((c) => c.trim().slice(0, 60)).filter(Boolean).slice(0, 4),
    };
  } catch {
    return fallback;
  }
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
