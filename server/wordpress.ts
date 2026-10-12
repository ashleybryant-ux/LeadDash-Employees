import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import * as db from "./db";
import { decryptJson } from "./_core/crypto";
import { uploadsRoot } from "./storage";
import type { OutboundItem } from "../drizzle/schema";

/**
 * Theo's articles on the workspace's own WordPress site (2026-10-12).
 *
 * The owner makes an application password in WordPress (Users, Profile,
 * Application Passwords; built in since WordPress 5.6, on sites served over
 * https) and saves the site address, the username and that password on
 * Integrations. Saving checks them with the site (GET /wp/v2/users/me) and
 * marks the connection connected.
 *
 * An approved article is posted (POST /wp/v2/posts, status publish): the
 * article as HTML with its photos, the meta description as the excerpt, the
 * slug, and the banner as the featured image. Every photo is uploaded to the
 * site's media library first (POST /wp/v2/media), so the post never points
 * back at this app. Approved means a person approved it, or Theo was set to
 * post on his own ("Posting new articles to WordPress" on his Onboarding tab).
 *
 * SEO plugins (Yoast, Rank Math) keep their own meta description field that
 * the REST API does not accept by default, so the excerpt carries it.
 */

export type WpCreds = { site: string; username: string; password: string };

/** Hooks tests use in place of the network. */
export const wpTools = {
  fetch: (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
};

/** "yoursite.com", "https://yoursite.com/wp-json/wp/v2/" and the like, as "https://yoursite.com". */
export function siteOf(raw: string) {
  let s = raw.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/[?#].*$/, "").replace(/\/wp-json(\/.*)?$/i, "").replace(/\/wp-admin(\/.*)?$/i, "").replace(/\/+$/, "");
  return s;
}

const auth = (c: WpCreds) => `Basic ${Buffer.from(`${c.username}:${c.password.replace(/\s+/g, "")}`).toString("base64")}`;

/** The REST address for a route: pretty permalinks first, then ?rest_route= for sites without them. */
function routes(site: string, route: string) {
  return [`${site}/wp-json${route}`, `${site}/?rest_route=${encodeURIComponent(route)}`];
}

async function call(c: WpCreds, route: string, init: RequestInit = {}): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let last: { status: number; data: Record<string, unknown> | null } = { status: 0, data: null };
  for (const url of routes(c.site, route)) {
    const res = await wpTools.fetch(url, { ...init, headers: { authorization: auth(c), accept: "application/json", ...(init.headers ?? {}) } });
    const text = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    last = { status: res.status, data };
    // A site without pretty permalinks answers /wp-json with its 404 page, not JSON.
    if (res.status === 404 && !data) continue;
    return last;
  }
  return last;
}

function why(r: { status: number; data: Record<string, unknown> | null }, what: string) {
  const code = String(r.data?.code ?? "");
  const msg = String(r.data?.message ?? "").replace(/<[^>]+>/g, "").slice(0, 200);
  if (r.status === 401 || code === "incorrect_password" || code === "invalid_username" || code === "rest_not_logged_in") return "WordPress didn't accept that username and application password. Make a new application password under Users, Profile in WordPress and save it again.";
  if (r.status === 403 || code === "rest_cannot_create" || code === "rest_cannot_publish") return "That WordPress user can't publish posts. Use an Author, Editor or Administrator account.";
  if (r.status === 404) return "That address doesn't answer like a WordPress site. Check the site address.";
  return `WordPress couldn't ${what}${msg ? `: ${msg}` : ` (${r.status || "no answer"})`}.`;
}

/** Checks the address, username and application password with the site. Returns who they signed in as. */
export async function verify(c: WpCreds): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (!/^https:\/\//i.test(c.site)) return { ok: false, error: "The site address has to start with https://. WordPress only accepts application passwords over https." };
  if (!c.username.trim() || !c.password.trim()) return { ok: false, error: "Add the WordPress username and the application password." };
  try {
    const r = await call(c, "/wp/v2/users/me?context=edit");
    if (r.status === 200 && r.data?.id) {
      const caps = (r.data.capabilities ?? {}) as Record<string, boolean>;
      if (Object.keys(caps).length && !caps.publish_posts) return { ok: false, error: "That WordPress user can't publish posts. Use an Author, Editor or Administrator account." };
      return { ok: true, name: String(r.data.name || c.username) };
    }
    return { ok: false, error: why(r, "check the sign-in") };
  } catch (err) {
    return { ok: false, error: `Couldn't reach ${c.site}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The workspace's saved WordPress sign-in, or null when it isn't connected. */
export async function credsFor(orgId: number): Promise<WpCreds | null> {
  const conn = await db.getConnectionByProvider(orgId, "wordpress");
  if (!conn || conn.status !== "connected") return null;
  const settings = JSON.parse(conn.settings || "{}") as { username?: string; site?: string };
  let secrets: { appPassword?: string } = {};
  try {
    secrets = decryptJson<{ appPassword?: string }>(conn.secretsEncrypted) ?? {};
  } catch {
    secrets = {};
  }
  const site = siteOf(settings.site || conn.accountHandle || "");
  if (!site || !settings.username || !secrets.appPassword) return null;
  return { site, username: settings.username, password: secrets.appPassword };
}

/** The banner's bytes: a file this app saved, or a picture at a web address. */
async function bannerOf(url: string | null | undefined): Promise<{ bytes: Buffer; name: string; type: string } | null> {
  if (!url) return null;
  const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
  if (url.startsWith("/files/")) {
    const full = path.resolve(uploadsRoot(), url.slice("/files/".length));
    if (!full.startsWith(uploadsRoot()) || !fs.existsSync(full)) return null;
    const ext = path.extname(full).toLowerCase();
    return { bytes: fs.readFileSync(full), name: path.basename(full), type: types[ext] ?? "image/png" };
  }
  if (!/^https:\/\//i.test(url)) return null;
  const res = await wpTools.fetch(url, { method: "GET" });
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") || "image/png").split(";")[0];
  const ext = Object.entries(types).find(([, t]) => t === type)?.[0] ?? ".png";
  return { bytes: Buffer.from(await res.arrayBuffer()), name: `banner${ext}`, type };
}

const meta = (item: OutboundItem) => {
  try {
    return JSON.parse(item.metadata || "{}") as { slug?: string; metaDescription?: string; keyword?: string };
  } catch {
    return {};
  }
};

/** Uploads one picture to the site's media library: its id and address there, or null. */
async function upload(c: WpCreds, url: string | null | undefined, name: string, alt: string): Promise<{ id: number; url: string } | null> {
  try {
    const pic = await bannerOf(url);
    if (!pic) return null;
    const body = new FormData();
    body.append("file", new Blob([new Uint8Array(pic.bytes)], { type: pic.type }), `${name.slice(0, 60)}${path.extname(pic.name) || ".png"}`);
    if (alt) body.append("alt_text", alt.slice(0, 160));
    const up = await call(c, "/wp/v2/media", { method: "POST", body });
    if ((up.status === 201 || up.status === 200) && up.data?.id) return { id: Number(up.data.id), url: String(up.data.source_url ?? "") };
    console.warn("[wordpress] photo upload:", why(up, "upload the photo"));
  } catch (err) {
    console.warn("[wordpress] photo upload failed:", err instanceof Error ? err.message : err);
  }
  return null;
}

/** Posts an approved article on the site, with its photos, and returns the post's address. */
export async function publishArticle(item: OutboundItem): Promise<string> {
  const c = await credsFor(item.organizationId);
  if (!c) throw new Error("WordPress is not connected");
  const m = meta(item);
  const slug = (m.slug || "article").slice(0, 50);
  const banner = await upload(c, item.imageUrl, slug, item.title);
  // Photos inside the article move to the site: each one is uploaded and its address swapped in. One that can't be uploaded is left out.
  let text = item.body ?? "";
  const photos = Array.from(text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g));
  let n = 0;
  for (const p of photos) {
    const up = await upload(c, p[2], `${slug}-${++n}`, p[1]);
    text = text.replace(p[0], up?.url ? `![${p[1]}](${up.url})` : "");
  }
  const html = await marked.parse(text, { gfm: true });
  const r = await call(c, "/wp/v2/posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: item.title, content: html, status: "publish", ...(m.slug ? { slug: m.slug } : {}), ...(m.metaDescription ? { excerpt: m.metaDescription } : {}), ...(banner ? { featured_media: banner.id } : {}) }),
  });
  if ((r.status !== 201 && r.status !== 200) || !r.data?.id) throw new Error(why(r, "post the article"));
  return typeof r.data.link === "string" && /^https?:\/\//.test(r.data.link) ? r.data.link : `${c.site}/?p=${r.data.id}`;
}
