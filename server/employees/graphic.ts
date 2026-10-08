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
 * Three kinds. The usual one is an illustrated graphic: the image model draws a
 * visual idea for the post (an illustration, a cartoon, a scene, a photo-style
 * shot) and the headline is set under it here, so every word is spelled exactly
 * as written and the colors are the brand's. A plain text card (a headline on a
 * brand color) is made only when the person asks for just words. A picture is a
 * scene with no words at all.
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

/** The visual idea for an illustrated graphic. */
export type ArtSpec = {
  /** What the picture shows: a concrete visual idea for the post's point, not a literal restatement. */
  scene: string;
  /** How it's drawn: "flat vector illustration", "playful cartoon", "3D clay render", "editorial photo" and the like. */
  style: string;
  /** The brand's look for the words and layout (fonts, colors, feel), from the brand guide. "" when there is none. */
  look?: string;
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

/** The headline and the line under it, centered in an area, shrinking until it fits. */
function textBlock(spec: CardSpec, w: number, areaTop: number, areaH: number, startPx: number, maxLines: number) {
  const pad = Math.round(w * 0.09);
  const maxWidth = w - pad * 2;
  let px = startPx;
  let lines = wrap(spec.headline, px, maxWidth);
  const fits = () => {
    const subPx = Math.round(px * 0.42);
    const subLines = spec.subline.trim() ? wrap(spec.subline, subPx, maxWidth, 0.52) : [];
    const height = lines.length * Math.round(px * 1.18) + (subLines.length ? subLines.length * Math.round(subPx * 1.4) + Math.round(px * 0.5) : 0);
    return lines.length <= maxLines && !lines.some((l) => widthOf(l, px) > maxWidth) && height <= areaH * 0.9;
  };
  while (!fits() && px > 30) {
    px -= 4;
    lines = wrap(spec.headline, px, maxWidth);
  }
  const lineHeight = Math.round(px * 1.18);
  const subPx = Math.round(px * 0.42);
  const subLines = spec.subline.trim() ? wrap(spec.subline, subPx, maxWidth, 0.52) : [];
  const subHeight = subLines.length ? subLines.length * Math.round(subPx * 1.4) + Math.round(px * 0.5) : 0;
  const block = lines.length * lineHeight + subHeight;
  const top = areaTop + Math.round((areaH - block) / 2) + px * 0.85;
  const headline = headlineSvg(lines, spec, w / 2, top, px, lineHeight);
  const sub = subLines
    .map((l, i) => `<text x="${w / 2}" y="${Math.round(top + lines.length * lineHeight + px * 0.25 + i * subPx * 1.4)}" font-family="Inter, 'Plus Jakarta Sans', 'DejaVu Sans', sans-serif" font-weight="500" font-size="${subPx}" fill="${spec.subtext}" text-anchor="middle">${esc(l)}</text>`)
    .join("\n");
  return `${headline}\n${sub}`;
}

const stripOf = (shape: Shape, h: number) => Math.round(h * (shape === "story" ? 0.07 : 0.11));

/** Puts the logo, or the business name, on the strip at the bottom. */
async function withStrip(base: Buffer, spec: CardSpec, shape: Shape, logoPath: string | null, name: string) {
  const { w, h } = SIZES[shape];
  const stripH = stripOf(shape, h);
  if (logoPath) {
    // The logo sits on the strip, scaled to fit it with room around.
    const maxLogoH = Math.round(stripH * 0.7);
    const maxLogoW = Math.round(w * 0.5);
    const logo = await sharp(logoPath).resize({ height: maxLogoH, width: maxLogoW, fit: "inside" }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    return sharp(base).composite([{ input: logo, left: Math.round((w - (meta.width ?? maxLogoW)) / 2), top: h - stripH + Math.round((stripH - (meta.height ?? maxLogoH)) / 2) }]).png().toBuffer();
  }
  if (!name) return base;
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${stripH}"><text x="${w / 2}" y="${Math.round(stripH * 0.62)}" font-family="Inter, 'Plus Jakarta Sans', 'DejaVu Sans', sans-serif" font-weight="700" font-size="${Math.round(stripH * 0.32)}" fill="${spec.stripText}" text-anchor="middle" letter-spacing="2">${esc(name.toUpperCase())}</text></svg>`;
  return sharp(base).composite([{ input: Buffer.from(label), left: 0, top: h - stripH }]).png().toBuffer();
}

/**
 * The illustrated graphic: the picture fills the top, the headline sits on a brand-color
 * panel under it, and the logo or name is on the strip at the bottom.
 */
export async function renderIllustrated(spec: CardSpec, shape: Shape, art: Buffer, logoPath: string | null, name = "") {
  const { w, h } = SIZES[shape];
  const stripH = stripOf(shape, h);
  const bodyH = h - stripH;
  const artH = Math.round(bodyH * (shape === "story" ? 0.6 : shape === "portrait" ? 0.6 : 0.56));
  const panelH = bodyH - artH;
  const picture = await sharp(art).resize({ width: w, height: artH, fit: "cover", position: "attention" }).png().toBuffer();
  const startPx = Math.round(w * (shape === "story" ? 0.075 : 0.068));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${spec.background}"/>
<rect x="0" y="${artH}" width="${w}" height="${Math.max(6, Math.round(h * 0.006))}" fill="${spec.accent}"/>
<rect x="0" y="${bodyH}" width="${w}" height="${stripH}" fill="${spec.strip}"/>
${textBlock(spec, w, artH + Math.round(h * 0.006), panelH - Math.round(h * 0.006), startPx, shape === "story" ? 4 : 3)}
</svg>`;
  const base = await sharp(Buffer.from(svg)).composite([{ input: picture, left: 0, top: 0 }]).png().toBuffer();
  return withStrip(base, spec, shape, logoPath, name);
}

/** What the image model is asked to design: the picture and the exact words, laid out together. */
export function designPrompt(spec: CardSpec, art: ArtSpec, shape: Shape) {
  const ratio = shape === "story" ? "tall vertical" : "square";
  return [
    `Design a premium, minimal social media graphic (${ratio}), the kind a top brand agency would post: calm, confident and uncluttered.`,
    `Visual: ${art.scene} Style: ${art.style}. One hero subject, large and beautifully lit, with at most three supporting objects. Generous empty space around it. No icon grids, no checklists, no charts, no app screens, no rows of small symbols, no busy patterns, no clip art.`,
    `Words: set this headline exactly, letter for letter, large: "${spec.headline}".${spec.emphasis ? ` Set "${spec.emphasis}" in italic in ${spec.accent}.` : ""}${spec.subline ? ` Under it, much smaller: "${spec.subline}".` : ""} ${art.look ? `${art.look} ` : "Use one elegant typeface with a clear size difference between headline and the line under it. "}No other words, letters, numbers, labels, logos or watermarks anywhere.`,
    `Layout: the headline sits on a clean area of the background with lots of space around it, never on top of the picture's details. Keep everything well inside the edges, with a wide empty margin on all four sides.`,
    `Colors: built around ${spec.background} and ${spec.accent}, with ${spec.text} for the words where they read well; only a few colors overall.`,
  ].join("\n");
}

/** The designed graphic from the image model, fitted to the card, with the logo or name on the strip at the bottom. */
export async function renderDesigned(spec: CardSpec, shape: Shape, art: Buffer, logoPath: string | null, name = "") {
  const { w, h } = SIZES[shape];
  const stripH = stripOf(shape, h);
  const picture = await sharp(art).resize({ width: w, height: h - stripH, fit: "cover", position: "centre" }).png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${spec.strip}"/></svg>`;
  const base = await sharp(Buffer.from(svg)).composite([{ input: picture, left: 0, top: 0 }]).png().toBuffer();
  return withStrip(base, spec, shape, logoPath, name);
}

/** Draws the plain text card as a PNG. */
export async function renderCard(spec: CardSpec, shape: Shape, logoPath: string | null) {
  const { w, h } = SIZES[shape];
  const stripH = stripOf(shape, h);
  const bodyH = h - stripH;
  // The headline shrinks until it fits in four lines (five on a story).
  const text = textBlock(spec, w, 0, bodyH, Math.round(w * (shape === "story" ? 0.1 : 0.085)), shape === "story" ? 5 : 4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="${spec.background}"/>
<rect x="0" y="${bodyH}" width="${w}" height="${stripH}" fill="${spec.strip}"/>
${text}
</svg>`;
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  return withStrip(base, spec, shape, logoPath, "");
}

/** The business name drawn on the strip when there is no logo. */
async function renderWithName(spec: CardSpec, shape: Shape, name: string) {
  return withStrip(await renderCard(spec, shape, null), spec, shape, null, name);
}

/** The person asked for words only, with no picture. */
export const wordsOnly = (words: string) => /\b((just|only) (the )?(words|text|headline|quote)|text[- ]only|words[- ]only|no (picture|image|illustration|art|photo)|typographic|plain card)\b/i.test(words);

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
export async function postGraphic(orgId: number, emp: AIEmployee, input: { target: string; words: string; kind: "text" | "picture" | ""; shape: Shape | "" }): Promise<{ post: NonNullable<Awaited<ReturnType<typeof db.updateOutboundItem>>>; kind: "picture" | "illustrated" | "text"; spec: CardSpec | null; art: ArtSpec | null; artError: string | null }> {
  const post = await postNamed(orgId, emp.id, input.target);
  if (!post) throw new Error("There's no post of mine in front of you to make a graphic for. Ask me to write one first.");
  const org = (await db.getOrganizationById(orgId))!;
  const meta = JSON.parse(post.metadata || "{}");
  const platforms: string[] = meta.platforms ?? JSON.parse(post.targetChannels || "[]");
  const shape: Shape = input.shape || (platforms.includes("instagram") ? "portrait" : "square");
  const wantsPicture = input.kind === "picture" || (!input.kind && /\b(photo|picture|scene|illustration)\b/i.test(input.words) && !/\b(text|words|headline|quote|type)\b/i.test(input.words));

  if (wantsPicture) {
    const size: ImageSize = shape === "square" ? "1024x1024" : "1024x1536";
    const prompt = `${input.words.trim() || post.imagePrompt || post.title}. Bold, polished, scroll-stopping social media art with a clear focal point. No text, letters, numbers or logos in the image.`;
    const { url } = await generateImage({ prompt, size, folder: `org-${orgId}/social` });
    const [w, h] = size.split("x").map(Number);
    const saved = await db.updateOutboundItem(post.id, orgId, { imageUrl: url, imagePrompt: prompt, metadata: JSON.stringify({ ...meta, imageError: null, graphic: null, post: { ...(meta.post ?? {}), imageMeta: { w, h } } }) });
    return { post: saved!, kind: "picture" as const, spec: null, art: null, artError: null };
  }

  const colors: string[] = (() => {
    try {
      return JSON.parse(org.brandColors || "[]");
    } catch {
      return [];
    }
  })();
  const illustrated = !wordsOnly(input.words);
  // The brand guide in the Brain (fonts, colors, feel), so the graphic looks like the brand's own.
  const guide = (await db.listKnowledgeByOrg(orgId))
    .filter((k) => k.employeeId == null && k.kind !== "image" && /\b(design|brand|style guide|visual)\b/i.test(k.title))
    .map((k) => `${k.title}:\n${k.content}`)
    .join("\n\n")
    .slice(0, 3000);
  const spec = await generateJson<CardSpec & ArtSpec>({
    system: `You art-direct a social graphic for ${org.name}${illustrated ? ": a finished design where a strong picture and the headline work together, drawn by an image model" : ": a typographic card, words only"}. Short words, no hype, American English, never an em dash. The headline is the line people read first (at most ${illustrated ? 10 : 12} words); the subline is one short line under it, or "".${illustrated ? `
The picture is what stops the scroll, so make it a real idea, not decoration:
- scene: one concrete visual idea that shows the post's point, with a clear subject, setting and action. Favor a visual metaphor or a small story (for "one price covers everything": a shopping cart piled high with a desk phone, a fax machine, a calendar, a laptop and a chart; for "five bills for one practice": a tired owner at a desk buried under five stacks of envelopes). People are diverse and look like the business's real customers. Nothing in it may need words to be understood.
- style: how it's drawn. Pick what suits the idea and the brand: "bright flat vector illustration", "playful editorial cartoon with bold outlines", "soft 3D clay render", "warm candid editorial photo" and the like. Follow what the person asked for (a cartoon, a photo, a mascot) when they said it.
- Keep it simple: one hero subject and at most three supporting objects. Never icon grids, checklists, charts, app screens or rows of little symbols; they look cheap at phone size.
- look: one or two sentences on how the words should look, from the brand guide below (the headline typeface, how the emphasized word is set, the feel), or "" when there is no guide.
- The picture never contains text, letters, numbers, prices, logos or signs; the headline carries the words.${guide ? `\n\nThe brand guide:\n${guide}` : ""}` : `
scene, style and look are "".`}
The emphasis is one word or short phrase copied exactly from the headline, or "". Colors are hex. Background, accent, text, subtext, strip and stripText come from the brand colors when they fit: ${colors.length ? colors.join(", ") : "none saved; use background #0d3b2e, accent #d6a74a, text #ffffff, subtext #efe7d6, strip #14221c, stripText #ffffff"}. Keep text readable on the background (light text on a dark background, dark on light). Never put a client's name or health information on a graphic.`,
    prompt: `Post title: ${post.title}\nPost text: ${(post.body ?? "").slice(0, 1200)}\n\nWhat the person asked for: ${input.words.trim() || "a graphic for this post"}`,
    schemaName: "graphic_spec",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "emphasis", "subline", "background", "accent", "text", "subtext", "strip", "stripText", "scene", "style", "look"],
      properties: { headline: { type: "string" }, emphasis: { type: "string" }, subline: { type: "string" }, background: { type: "string" }, accent: { type: "string" }, text: { type: "string" }, subtext: { type: "string" }, strip: { type: "string" }, stripText: { type: "string" }, scene: { type: "string" }, style: { type: "string" }, look: { type: "string" } },
    },
    maxTokens: 700,
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
  const scene = String(spec.scene ?? "").trim();
  let art: ArtSpec | null = illustrated && scene ? { scene: scene.slice(0, 900), style: String(spec.style ?? "").trim().slice(0, 120) || "bright flat vector illustration", look: String(spec.look ?? "").trim().slice(0, 400) } : null;
  let artError: string | null = null;
  let png: Buffer | null = null;
  if (art) {
    try {
      // OpenAI's image model (the one ChatGPT uses) designs the whole graphic, words included; the logo strip is added here so the brand is exact.
      const prompt = designPrompt(clean, art, shape);
      // The closest shape to the space above the logo strip, so nothing important is cut off.
      const { url: artUrl } = await generateImage({ prompt, size: shape === "story" ? "1024x1536" : "1024x1024", quality: "high", folder: `org-${orgId}/social` });
      const file = localPath(artUrl);
      if (!file) throw new Error("The picture didn't save.");
      png = await renderDesigned(clean, shape, fs.readFileSync(file), logo, org.name);
    } catch (err) {
      artError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      art = null;
    }
  }
  if (!png) png = logo ? await renderCard(clean, shape, logo) : await renderWithName(clean, shape, org.name);
  const { url } = await storagePut(`org-${orgId}/social/graphic-${post.id}-${Date.now()}.png`, png, "image/png");
  const { w, h } = SIZES[shape];
  const saved = await db.updateOutboundItem(post.id, orgId, { imageUrl: url, metadata: JSON.stringify({ ...meta, imageError: null, graphic: { ...clean, shape, art }, post: { ...(meta.post ?? {}), imageMeta: { w, h } } }) });
  return { post: saved!, kind: art ? ("illustrated" as const) : ("text" as const), spec: clean, art, artError: illustrated ? artError : null };
}
