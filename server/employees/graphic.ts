import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as db from "../db";
import { generateJson } from "../_core/llm";
import { generateImage, type ImageSize } from "../_core/imageGeneration";
import { storagePut, uploadsRoot } from "../storage";
import type { AIEmployee } from "../../drizzle/schema";

/**
 * Graphics for social posts, made by Sienna herself.
 *
 * Two kinds. A text graphic is a typographic card (a headline on a brand color,
 * one word set off in the accent color, a smaller line under it, the business's
 * name or logo on a strip at the bottom). It is drawn here, so every word is
 * spelled exactly as written and the colors are the brand's. A picture is a
 * scene with no words in it, made by the image model, as the post's first
 * image was.
 */

export type CardSpec = {
  headline: string;
  /** A word or short phrase from the headline shown in the accent color, italic. "" for none. */
  emphasis: string;
  subline: string;
  background: string;
  accent: string;
  text: string;
  subtext: string;
  strip: string;
  stripText: string;
};

export type Shape = "square" | "portrait" | "story";
const SIZES: Record<Shape, { w: number; h: number }> = { square: { w: 1080, h: 1080 }, portrait: { w: 1080, h: 1350 }, story: { w: 1080, h: 1920 } };

/** LeadDash's own palette, used when the workspace has not saved brand colors. */
const DEFAULT: Omit<CardSpec, "headline" | "emphasis" | "subline"> = { background: "#0d3b2e", accent: "#d6a74a", text: "#ffffff", subtext: "#efe7d6", strip: "#14221c", stripText: "#ffffff" };

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (s: string | undefined, fallback: string) => (s && HEX.test(s.trim()) ? s.trim().toLowerCase() : fallback);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough text width in px for Inter at a size: enough to wrap lines without measuring glyphs. */
const widthOf = (s: string, px: number, factor = 0.56) => s.length * px * factor;

function wrap(text: string, px: number, maxWidth: number, factor?: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (widthOf(next, px, factor) <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The headline's lines as SVG text, with the emphasized words in the accent color and italic. */
function headlineSvg(lines: string[], spec: CardSpec, x: number, y0: number, px: number, lineHeight: number) {
  const emph = spec.emphasis.trim().toLowerCase();
  const out: string[] = [];
  lines.forEach((line, i) => {
    const y = y0 + i * lineHeight;
    let inner = esc(line);
    if (emph) {
      const at = line.toLowerCase().indexOf(emph);
      if (at >= 0) {
        const a = line.slice(0, at);
        const b = line.slice(at, at + emph.length);
        const c = line.slice(at + emph.length);
        inner = `${esc(a)}<tspan fill="${spec.accent}" font-style="italic">${esc(b)}</tspan>${esc(c)}`;
      }
    }
    out.push(`<text x="${x}" y="${y}" font-family="Inter, 'Plus Jakarta Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="${px}" fill="${spec.text}" text-anchor="middle">${inner}</text>`);
  });
  return out.join("\n");
}

/** Draws the card as a PNG. */
export async function renderCard(spec: CardSpec, shape: Shape, logoPath: string | null) {
  const { w, h } = SIZES[shape];
  const pad = Math.round(w * 0.09);
  const maxWidth = w - pad * 2;
  const stripH = Math.round(h * (shape === "story" ? 0.07 : 0.11));
  const bodyH = h - stripH;

  // The headline shrinks until it fits in four lines (five on a story).
  let px = Math.round(w * (shape === "story" ? 0.1 : 0.085));
  let lines = wrap(spec.headline, px, maxWidth);
  const maxLines = shape === "story" ? 5 : 4;
  while ((lines.length > maxLines || lines.some((l) => widthOf(l, px) > maxWidth)) && px > 40) {
    px -= 4;
    lines = wrap(spec.headline, px, maxWidth);
  }
  const lineHeight = Math.round(px * 1.18);
  const subPx = Math.round(px * 0.42);
  const subLines = spec.subline.trim() ? wrap(spec.subline, subPx, maxWidth, 0.52) : [];
  const subHeight = subLines.length ? subLines.length * Math.round(subPx * 1.4) + Math.round(px * 0.5) : 0;
  const block = lines.length * lineHeight + subHeight;
  const top = Math.round((bodyH - block) / 2) + px * 0.85;

  const headline = headlineSvg(lines, spec, w / 2, top, px, lineHeight);
  const sub = subLines
    .map((l, i) => `<text x="${w / 2}" y="${Math.round(top + lines.length * lineHeight + px * 0.25 + i * subPx * 1.4)}" font-family="Inter, 'Plus Jakarta Sans', 'DejaVu Sans', sans-serif" font-weight="500" font-size="${subPx}" fill="${spec.subtext}" text-anchor="middle">${esc(l)}</text>`)
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${spec.background}"/>
<rect x="0" y="${bodyH}" width="${w}" height="${stripH}" fill="${spec.strip}"/>
${headline}
${sub}
</svg>`;
  let img = sharp(Buffer.from(svg)).png();
  if (logoPath) {
    // The logo sits on the strip, scaled to fit it with room around.
    const maxLogoH = Math.round(stripH * 0.7);
    const maxLogoW = Math.round(w * 0.5);
    const logo = await sharp(logoPath).resize({ height: maxLogoH, width: maxLogoW, fit: "inside" }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    img = sharp(await img.toBuffer()).composite([{ input: logo, left: Math.round((w - (meta.width ?? maxLogoW)) / 2), top: bodyH + Math.round((stripH - (meta.height ?? maxLogoH)) / 2) }]).png();
  }
  return img.toBuffer();
}

/** The business name drawn on the strip when there is no logo. */
async function renderWithName(spec: CardSpec, shape: Shape, name: string) {
  const { w, h } = SIZES[shape];
  const stripH = Math.round(h * (shape === "story" ? 0.07 : 0.11));
  const base = await renderCard(spec, shape, null);
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${stripH}"><text x="${w / 2}" y="${Math.round(stripH * 0.62)}" font-family="Inter, 'Plus Jakarta Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="${Math.round(stripH * 0.32)}" fill="${spec.stripText}" text-anchor="middle" letter-spacing="2">${esc(name.toUpperCase())}</text></svg>`;
  return sharp(base).composite([{ input: Buffer.from(label), left: 0, top: h - stripH }]).png().toBuffer();
}

function localPath(fileUrl: string | null | undefined) {
  if (!fileUrl || !fileUrl.startsWith("/files/")) return null;
  const full = path.resolve(uploadsRoot(), fileUrl.slice("/files/".length));
  return full.startsWith(uploadsRoot()) && fs.existsSync(full) ? full : null;
}

/** The post the person means: by words from its title, else the newest one still in front of them. */
export async function postNamed(orgId: number, employeeId: number, target: string) {
  const posts = (await db.listOutboundItemsByOrg(orgId, "social_post")).filter((p) => p.employeeId === employeeId && !["published", "cancelled"].includes(p.status)).sort((a, b) => b.id - a.id);
  const t = target.trim().toLowerCase();
  return (t && posts.find((p) => p.title.toLowerCase().includes(t))) || posts[0] || null;
}

/**
 * Makes (or remakes) a post's graphic from what the person asked for. "text" draws a card with the
 * exact words; "picture" asks the image model for a scene with no words. Returns the post and what was made.
 */
export async function postGraphic(orgId: number, emp: AIEmployee, input: { target: string; words: string; kind: "text" | "picture" | ""; shape: Shape | "" }) {
  const post = await postNamed(orgId, emp.id, input.target);
  if (!post) throw new Error("There's no post of mine in front of you to make a graphic for. Ask me to write one first.");
  const org = (await db.getOrganizationById(orgId))!;
  const meta = JSON.parse(post.metadata || "{}");
  const platforms: string[] = meta.platforms ?? JSON.parse(post.targetChannels || "[]");
  const shape: Shape = input.shape || (platforms.includes("instagram") ? "portrait" : "square");
  const wantsPicture = input.kind === "picture" || (!input.kind && /\b(photo|picture|scene|illustration)\b/i.test(input.words) && !/\b(text|words|headline|quote|type)\b/i.test(input.words));

  if (wantsPicture) {
    const size: ImageSize = shape === "square" ? "1024x1024" : "1024x1536";
    const prompt = `${input.words.trim() || post.imagePrompt || post.title}. No text, letters or logos in the image.`;
    const { url } = await generateImage({ prompt, size, folder: `org-${orgId}/social` });
    const [w, h] = size.split("x").map(Number);
    const saved = await db.updateOutboundItem(post.id, orgId, { imageUrl: url, imagePrompt: prompt, metadata: JSON.stringify({ ...meta, imageError: null, graphic: null, post: { ...(meta.post ?? {}), imageMeta: { w, h } } }) });
    return { post: saved!, kind: "picture" as const, spec: null };
  }

  const colors: string[] = (() => {
    try {
      return JSON.parse(org.brandColors || "[]");
    } catch {
      return [];
    }
  })();
  const spec = await generateJson<CardSpec>({
    system: `You lay out a typographic social graphic for ${org.name}. Short words, no hype, American English, never an em dash. The headline is the line people read first (at most 12 words); the subline is one short line under it, or "". The emphasis is one word or short phrase copied exactly from the headline, or "". Colors are hex. Background, accent, text, subtext, strip and stripText come from the brand colors when they fit: ${colors.length ? colors.join(", ") : "none saved; use background #0d3b2e, accent #d6a74a, text #ffffff, subtext #efe7d6, strip #14221c, stripText #ffffff"}. Keep text readable on the background (light text on a dark background, dark on light). Never put a client's name or health information on a graphic.`,
    prompt: `Post title: ${post.title}\nPost text: ${(post.body ?? "").slice(0, 1200)}\n\nWhat the person asked for: ${input.words.trim() || "a graphic for this post"}`,
    schemaName: "graphic_spec",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "emphasis", "subline", "background", "accent", "text", "subtext", "strip", "stripText"],
      properties: { headline: { type: "string" }, emphasis: { type: "string" }, subline: { type: "string" }, background: { type: "string" }, accent: { type: "string" }, text: { type: "string" }, subtext: { type: "string" }, strip: { type: "string" }, stripText: { type: "string" } },
    },
    maxTokens: 400,
  });
  const clean: CardSpec = {
    headline: String(spec.headline ?? post.title).trim().slice(0, 140) || post.title,
    emphasis: String(spec.emphasis ?? "").trim().slice(0, 40),
    subline: String(spec.subline ?? "").trim().slice(0, 120),
    background: hex(spec.background, colors[0] && HEX.test(colors[0]) ? colors[0] : DEFAULT.background),
    accent: hex(spec.accent, colors[1] && HEX.test(colors[1]) ? colors[1] : DEFAULT.accent),
    text: hex(spec.text, DEFAULT.text),
    subtext: hex(spec.subtext, DEFAULT.subtext),
    strip: hex(spec.strip, DEFAULT.strip),
    stripText: hex(spec.stripText, DEFAULT.stripText),
  };
  const logo = localPath(org.logoUrl);
  const png = logo ? await renderCard(clean, shape, logo) : await renderWithName(clean, shape, org.name);
  const { url } = await storagePut(`org-${orgId}/social/graphic-${post.id}-${Date.now()}.png`, png, "image/png");
  const { w, h } = SIZES[shape];
  const saved = await db.updateOutboundItem(post.id, orgId, { imageUrl: url, metadata: JSON.stringify({ ...meta, imageError: null, graphic: { ...clean, shape }, post: { ...(meta.post ?? {}), imageMeta: { w, h } } }) });
  return { post: saved!, kind: "text" as const, spec: clean };
}
