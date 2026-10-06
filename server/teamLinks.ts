import dns from "node:dns/promises";
import net from "node:net";
import * as db from "./db";

/**
 * Link previews for team chat. A link in a message gets a card under it:
 * Loom, YouTube and Vimeo by their oEmbed (title, length, thumbnail, a
 * player that runs in place), Google Docs, Sheets, Slides and Drive by name,
 * and any other page by its Open Graph tags (site, title, description,
 * image). What a site says is kept by url in team_links, so the same link in
 * ten messages is read once. Reading happens after the message is saved and
 * never holds it up; messages that came over from Slack get theirs at boot.
 */

const URL_RE = /https?:\/\/[^\s<>)]+[^\s<>).,!?;:'"]/g;
const MAX_PER_MESSAGE = 3;
const FRESH_OK = 7 * 24 * 3_600_000;
const FRESH_NONE = 24 * 3_600_000;
const TIMEOUT = 8_000;
const MAX_HTML = 512 * 1024;
const UA = "Mozilla/5.0 (compatible; LeadDashEmployees/1.0; link preview)";

/** The links in a message, in order, each once, the first few. */
export function urlsIn(text: string, max = MAX_PER_MESSAGE) {
  const out: string[] = [];
  for (const m of text.match(URL_RE) ?? []) {
    if (!out.includes(m)) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}

export type Preview = { url: string; kind: "video" | "file" | "page"; site: string; title: string | null; description: string | null; image: string | null; embed: string | null; duration: number | null };

type Found = Omit<Preview, "url">;

// ==========================================
// Which site, and how to read it
// ==========================================

function videoOf(u: URL): { site: string; oembed: string; embed: string } | null {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "loom.com") {
    const m = /^\/(?:share|embed)\/([a-f0-9]{32})/i.exec(u.pathname);
    if (m) return { site: "Loom", oembed: `https://www.loom.com/v1/oembed?url=${encodeURIComponent(u.href)}`, embed: `https://www.loom.com/embed/${m[1]}` };
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    const id = host === "youtu.be" ? u.pathname.slice(1).split("/")[0] : u.pathname.startsWith("/shorts/") ? u.pathname.split("/")[2] : u.searchParams.get("v");
    if (id && /^[\w-]{6,}$/.test(id)) return { site: "YouTube", oembed: `https://www.youtube.com/oembed?url=${encodeURIComponent(u.href)}&format=json`, embed: `https://www.youtube.com/embed/${id}` };
  }
  if (host === "vimeo.com") {
    const m = /^\/(\d+)/.exec(u.pathname);
    if (m) return { site: "Vimeo", oembed: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u.href)}`, embed: `https://player.vimeo.com/video/${m[1]}` };
  }
  return null;
}

function googleOf(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "docs.google.com") {
    if (u.pathname.startsWith("/document")) return "Google Docs";
    if (u.pathname.startsWith("/spreadsheets")) return "Google Sheets";
    if (u.pathname.startsWith("/presentation")) return "Google Slides";
    if (u.pathname.startsWith("/forms")) return "Google Forms";
    return "Google Docs";
  }
  if (host === "drive.google.com") return "Google Drive";
  return null;
}

/** Only public hosts: nothing on this machine or a private network gets read. */
async function safeHost(hostname: string) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  const isPrivate = (ip: string) => {
    if (net.isIPv4(ip)) {
      const [a, b] = ip.split(".").map(Number);
      return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
    }
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
  };
  if (net.isIP(h)) return !isPrivate(h);
  try {
    const found = await dns.lookup(h, { all: true });
    return found.every((f) => !isPrivate(f.address));
  } catch {
    // Unknown host: the read itself fails, nothing private is reached.
    return true;
  }
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT), redirect: "follow" });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return v && typeof v === "object" ? v : null;
}

async function getHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(TIMEOUT), redirect: "follow" });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
  const html = (await res.text()).slice(0, MAX_HTML);
  return { html, finalUrl: res.url || url };
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();

/** <meta property="og:title" content="..."> in either attribute order. */
function meta(html: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, "i").exec(html);
  if (a) return decode(a[1]) || null;
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, "i").exec(html);
  return b ? decode(b[1]) || null : null;
}

function pageTitle(html: string) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? decode(m[1]) || null : null;
}

const SIGNIN = /sign[ -]?in|log[ -]?in|google accounts|access denied|not found|request access|^google (docs|sheets|slides|forms|drive)$/i;

export async function readPreview(url: string): Promise<Found | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!(await safeHost(u.hostname))) return null;
  const video = videoOf(u);
  if (video) {
    const j = await getJson(video.oembed).catch(() => null);
    if (!j) return { kind: "video", site: video.site, title: null, description: null, image: null, embed: video.embed, duration: null };
    const dur = typeof j.duration === "number" ? Math.round(j.duration) : null;
    return { kind: "video", site: video.site, title: typeof j.title === "string" ? decode(j.title) : null, description: typeof j.description === "string" ? decode(j.description).slice(0, 300) : null, image: typeof j.thumbnail_url === "string" ? j.thumbnail_url : null, embed: video.embed, duration: dur };
  }
  const google = googleOf(u);
  if (google) {
    // A shared file's page says its name; one that needs sign-in shows by site only.
    const page = await getHtml(u.href).catch(() => null);
    const t = page ? pageTitle(page.html) : null;
    const title = t && !SIGNIN.test(t) ? t.replace(/\s*-\s*Google (Docs|Sheets|Slides|Forms|Drive)\s*$/i, "") : null;
    return { kind: "file", site: google, title, description: null, image: null, embed: null, duration: null };
  }
  const page = await getHtml(u.href).catch(() => null);
  if (!page) return null;
  const html = page.html;
  const title = meta(html, "og:title") ?? meta(html, "twitter:title") ?? pageTitle(html);
  if (!title) return null;
  const description = meta(html, "og:description") ?? meta(html, "twitter:description") ?? meta(html, "description");
  let image = meta(html, "og:image") ?? meta(html, "og:image:url") ?? meta(html, "twitter:image");
  if (image) {
    try {
      image = new URL(image, page.finalUrl).href;
    } catch {
      image = null;
    }
  }
  const site = meta(html, "og:site_name") ?? u.hostname.replace(/^www\./, "");
  return { kind: "page", site, title, description: description ? description.slice(0, 300) : null, image, embed: null, duration: null };
}

// ==========================================
// The cache and the queue
// ==========================================

function fresh(row: db.TeamLinkRow) {
  return Date.now() - row.fetchedAt.getTime() < (row.status === "ok" ? FRESH_OK : FRESH_NONE);
}

export function toPreview(row: db.TeamLinkRow): Preview | null {
  if (row.status !== "ok") return null;
  return { url: row.url, kind: row.kind, site: row.site, title: row.title, description: row.description, image: row.image, embed: row.embed, duration: row.duration };
}

/** The previews already read for these links, by url. */
export function previewsFor(urls: string[]) {
  const out = new Map<string, Preview>();
  for (const row of db.team.links(urls)) {
    const p = toPreview(row);
    if (p) out.set(row.url, p);
  }
  return out;
}

const pending = new Set<Promise<unknown>>();
const inFlight = new Map<string, Promise<void>>();
let running = 0;
const waiting: (() => void)[] = [];
const LANES = 3;

async function lane<T>(job: () => Promise<T>) {
  if (running >= LANES) await new Promise<void>((r) => waiting.push(r));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** Reads one link (once, even when asked twice) and keeps what it found. */
export function fetchPreview(url: string) {
  const have = db.team.linkByUrl(url);
  if (have && fresh(have)) return Promise.resolve();
  const going = inFlight.get(url);
  if (going) return going;
  const p = lane(async () => {
    const found = await readPreview(url).catch(() => null);
    db.team.saveLink(found ? { url, ...found, status: "ok", fetchedAt: new Date() } : { url, status: "none", fetchedAt: new Date() });
  }).finally(() => {
    inFlight.delete(url);
    pending.delete(p);
  });
  inFlight.set(url, p);
  pending.add(p);
  return p;
}

/** Reads the links in a message in the background. */
export function want(text: string) {
  for (const url of urlsIn(text)) void fetchPreview(url);
}

/** Tests wait here for the reads to finish. */
export async function settled() {
  while (pending.size) await Promise.allSettled(Array.from(pending));
}

/** Messages already here without a card (history from Slack, say) get theirs. */
export async function backfill() {
  const urls = new Set<string>();
  for (const m of db.team.withLinks()) for (const u of urlsIn(m.content)) urls.add(u);
  const have = new Set(db.team.links(Array.from(urls)).filter(fresh).map((l) => l.url));
  for (const u of Array.from(urls)) if (!have.has(u)) void fetchPreview(u);
}

export const _test = { meta, pageTitle, videoOf, googleOf };
