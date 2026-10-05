import { assertPublicUrl, fetchWebpage, htmlToText } from "./files";

/**
 * Reads a website the way a designer would: the real HTML (rendered in the
 * server's browser when the site is built with JavaScript), what each page
 * says, its headings, buttons, images and links. Jordan audits and redesigns
 * from this instead of clicking around a live browser.
 */

export type SiteImage = { src: string; alt: string };
export type SitePageRead = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  buttons: string[];
  images: SiteImage[];
  forms: number;
  text: string;
  /** The page's markup without scripts, inline SVG paths or base64 data, for redesigning from. */
  html: string;
  /** True when the page was read in the server's browser because the plain page was empty. */
  rendered: boolean;
};
export type SiteRead = { start: string; pages: SitePageRead[]; links: { url: string; text: string }[] };

const decode = (s: string) => htmlToText(s).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(2).find((x) => x !== undefined) ?? "";

/** Markup worth reading: no scripts, no tracking, no base64 blobs, no long SVG paths. */
export function leanHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "<iframe></iframe>")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{40,}/gi, "data:...")
    .replace(/\sd="[^"]{120,}"/g, ' d="..."')
    .replace(/<link[^>]+rel=["']?(?:preload|prefetch|dns-prefetch|preconnect|modulepreload)[^>]*>/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Pulls what matters out of one page's HTML. */
export function readHtml(html: string, pageUrl: string, rendered = false): { page: SitePageRead; links: { url: string; text: string }[] } {
  const base = new URL(pageUrl);
  const abs = (u: string) => {
    try {
      return new URL(u.trim(), base).toString();
    } catch {
      return "";
    }
  };
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const headings = Array.from(body.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi))
    .map((m) => `H${m[1]}: ${decode(m[2])}`)
    .filter((h) => h.length > 4)
    .slice(0, 60);
  const buttons = Array.from(new Set(Array.from(body.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi))
    .filter((m) => m[1].toLowerCase() === "button" || /\b(btn|button|cta)\b/i.test(attr(m[2], "class")))
    .map((m) => decode(m[3]))
    .filter((t) => t && t.length < 60)))
    .slice(0, 30);
  const images: SiteImage[] = [];
  for (const m of Array.from(body.matchAll(/<img\b[^>]*>/gi))) {
    const src = abs(attr(m[0], "src") || attr(m[0], "data-src") || (attr(m[0], "srcset").split(/\s+/)[0] ?? ""));
    if (!src || src.startsWith("data:") || /\.svg(\?|$)/i.test(src) || /pixel|tracking|1x1|spacer/i.test(src)) continue;
    if (!images.some((x) => x.src === src)) images.push({ src, alt: decode(attr(m[0], "alt")) });
  }
  for (const m of Array.from(body.matchAll(/background(?:-image)?\s*:\s*url\((['"]?)([^'")]+)\1\)/gi))) {
    const src = abs(m[2]);
    if (src && !src.startsWith("data:") && !images.some((x) => x.src === src)) images.push({ src, alt: "(background image)" });
  }
  const links: { url: string; text: string }[] = [];
  for (const m of Array.from(body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi))) {
    const href = abs(attr(m[1], "href"));
    if (!href || !/^https?:/i.test(href)) continue;
    const u = new URL(href);
    u.hash = "";
    if (!links.some((l) => l.url === u.toString())) links.push({ url: u.toString(), text: decode(m[2]).slice(0, 80) });
  }
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 200);
  const description = decode(attr(html.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0] ?? "", "content")).slice(0, 400);
  const text = htmlToText(html.replace(/<(nav|footer|header)\b/gi, "<div").replace(/<\/(nav|footer|header)>/gi, "</div>"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return {
    page: { url: pageUrl, title, description, headings, buttons, images: images.slice(0, 40), forms: (body.match(/<form\b/gi) ?? []).length, text: text.slice(0, 40_000), html: leanHtml(html).slice(0, 120_000), rendered },
    links,
  };
}

/** One page: the plain page first, the server's browser when the plain page is empty (built with JavaScript). */
export async function readPage(url: string): Promise<{ page: SitePageRead; links: { url: string; text: string }[] }> {
  const safe = (await assertPublicUrl(url)).toString();
  let plain: { html: string; url: string } | null = null;
  try {
    const r = await fetchWebpage(safe);
    plain = { html: r.html, url: r.url };
  } catch (err) {
    plain = null;
    if (!/could not be read|status/i.test((err as Error).message)) throw err;
  }
  const first = plain ? readHtml(plain.html, plain.url) : null;
  if (first && first.page.text.length > 600) return first;
  try {
    const { renderHtml } = await import("./browser");
    const r = await renderHtml(safe);
    const second = readHtml(r.html, r.url, true);
    if (!first || second.page.text.length > first.page.text.length) return second;
  } catch {
    // No browser on this machine: keep what the plain page gave.
  }
  if (first) return first;
  throw new Error(`I couldn't open ${safe}. Check the address, or attach the page's HTML file and I'll read that.`);
}

/**
 * The start page and up to `max` more pages on the same site, picking the
 * linked pages whose address or link text matches what the job is about
 * ("founding member offer") first.
 */
export async function readSite(startUrl: string, opts: { max?: number; about?: string } = {}): Promise<SiteRead> {
  let start = startUrl.trim();
  if (!/^https?:\/\//i.test(start)) start = `https://${start.replace(/^\/+/, "")}`;
  const first = await readPage(start);
  const host = new URL(first.page.url).hostname.replace(/^www\./, "");
  const same = first.links.filter((l) => {
    try {
      const u = new URL(l.url);
      return u.hostname.replace(/^www\./, "") === host && !/\.(pdf|jpe?g|png|gif|webp|zip|docx?)$/i.test(u.pathname) && !/(login|signin|sign-in|cart|checkout|privacy|terms|wp-admin)/i.test(u.pathname);
    } catch {
      return false;
    }
  });
  const words = (opts.about ?? "").toLowerCase().split(/[^a-z0-9$]+/).filter((w) => w.length > 2 && !["the", "and", "for", "page", "website", "full", "audit", "complete", "flag", "flagging", "what", "change", "add", "cut", "with", "due", "today", "cold"].includes(w));
  const score = (l: { url: string; text: string }) => words.filter((w) => `${l.url} ${l.text}`.toLowerCase().includes(w)).length;
  const seen = new Set([first.page.url.replace(/\/$/, "")]);
  const queue = same
    .filter((l) => !seen.has(l.url.replace(/\/$/, "")))
    .map((l, i) => ({ l, s: score(l), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.l);
  const pages = [first.page];
  for (const l of queue) {
    if (pages.length > (opts.max ?? 0)) break;
    const key = l.url.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      pages.push((await readPage(l.url)).page);
    } catch {
      // A page that won't open is skipped.
    }
  }
  return { start: first.page.url, pages, links: same.slice(0, 60) };
}

/** The site as text for the AI: each page's facts, words and (optionally) its markup. */
export function siteBrief(site: SiteRead, opts: { html?: boolean; textChars?: number; htmlChars?: number } = {}) {
  return site.pages
    .map((p, i) =>
      [
        `PAGE ${i + 1}: ${p.url}${p.rendered ? " (read in the browser: the site is built with JavaScript)" : ""}`,
        `Title: ${p.title || "(none)"}`,
        `Meta description: ${p.description || "(none)"}`,
        `Headings:\n${p.headings.join("\n") || "(none)"}`,
        `Buttons: ${p.buttons.join(" | ") || "(none)"}`,
        `Forms: ${p.forms}`,
        `Images (${p.images.length}):\n${p.images.slice(0, 25).map((x) => `- ${x.src}${x.alt ? ` (alt: ${x.alt})` : " (no alt text)"}`).join("\n") || "(none)"}`,
        `What the page says:\n${p.text.slice(0, opts.textChars ?? 12_000)}`,
        opts.html ? `The page's HTML:\n${p.html.slice(0, opts.htmlChars ?? 40_000)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}
