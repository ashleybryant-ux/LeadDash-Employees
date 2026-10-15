import sharp from "sharp";

/**
 * SVG files (logos, icons, web graphics) people share in the app. An SVG is a picture written as
 * code, so it can carry scripts. Every SVG is cleaned when it's uploaded, and it is always served
 * with a policy that stops anything in it from running, so it shows and downloads as the clean,
 * see-through picture it is.
 */

/** Whether a file is an SVG, by its contents (names and browser types can't be trusted). */
export function isSvg(buf: Buffer) {
  const head = buf
    .subarray(0, 8192)
    .toString("utf8")
    .replace(/^﻿/, "")
    .replace(/^\s*<\?xml[^>]*\?>/i, "")
    .replace(/^(\s*<!--[\s\S]*?-->)+/, "")
    .replace(/^\s*<!DOCTYPE\s+svg\b[^[>]*(\[[\s\S]*?\])?\s*>/i, "")
    .replace(/^(\s*<!--[\s\S]*?-->)+/, "")
    .trimStart();
  return /^<svg[\s>]/i.test(head);
}

/** The SVG with everything that could run or reach out removed. Everything that draws stays as it was. */
export function cleanSvg(text: string) {
  let s = text.replace(/^﻿/, "");
  // No document type or entities (they can pull in other files or blow up in size).
  s = s.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "");
  s = s.replace(/<!ENTITY[\s\S]*?>/gi, "");
  // No scripts, no embedded web pages, no frames or objects.
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "").replace(/<script[^>]*\/>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "").replace(/<foreignObject[^>]*\/>/gi, "");
  s = s.replace(/<(iframe|embed|object|audio|video|handler|listener)[\s\S]*?(<\/\1\s*>|\/>)/gi, "");
  // No event handlers (onload, onclick and the rest).
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Links may point inside the file (#id) or at an embedded picture (data:image), nothing else.
  s = s.replace(/\s+((?:xlink:)?href)\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, attr, _q, a, b) => {
    const v = String(a ?? b ?? "").trim();
    return /^#/.test(v) || /^data:image\/(png|jpe?g|gif|webp);/i.test(v) ? ` ${attr}="${v.replace(/"/g, "&quot;")}"` : "";
  });
  // No javascript: or outside addresses hidden in styles or other attributes.
  s = s.replace(/javascript\s*:/gi, "").replace(/url\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, "none");
  s = s.replace(/@import[^;]+;?/gi, "");
  return s.trim();
}

/** A cleaned SVG ready to store, or an error a person can act on. */
export function cleanSvgFile(buf: Buffer) {
  const out = cleanSvg(buf.toString("utf8"));
  if (!/<svg[\s>]/i.test(out)) throw new Error("That SVG couldn't be read. Export it again from your design app and upload it.");
  return Buffer.from(out, "utf8");
}

/** A PNG of an SVG, for the tools that can't read SVG (describing a picture, making a video). Its see-through background is kept. */
export async function svgToPng(buf: Buffer, minSide = 1024) {
  const img = sharp(buf, { density: 300 });
  const meta = await img.metadata();
  const short = Math.min(meta.width ?? 0, meta.height ?? 0) || minSide;
  const scale = short < minSide ? minSide / short : 1;
  return sharp(buf, { density: 300 })
    .resize(Math.ceil((meta.width ?? minSide) * scale), Math.ceil((meta.height ?? minSide) * scale), { fit: "fill" })
    .png()
    .toBuffer();
}

/** Headers for serving an SVG: shown as a picture, with nothing in it allowed to run. */
export const SVG_HEADERS: Record<string, string> = {
  "Content-Type": "image/svg+xml",
  "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; sandbox",
  "X-Content-Type-Options": "nosniff",
};

/** The same file name, ending in .svg. */
export function svgName(name: string) {
  return /\.svg$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, "") || "graphic"}.svg`;
}
