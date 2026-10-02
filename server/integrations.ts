import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import * as db from "./db";
import { ENV } from "./_core/env";
import { authenticateRequest } from "./_core/context";
import { decryptJson, encryptJson, hasSecretsKey } from "./_core/crypto";
import { uploadsRoot } from "./storage";
import type { OutboundItem, Provider } from "../drizzle/schema";

/**
 * One-click connections. LeadDash registers one app with each company
 * (Google, LinkedIn, Meta, X) and puts its keys in the server's .env once.
 * Every workspace then connects with a Connect button: the person signs in
 * with the company, approves, and lands back on Integrations. Tokens are
 * encrypted with SECRETS_KEY and never sent to the browser.
 *
 * After that, Approve in Approvals posts or sends for real.
 */

// ==========================================
// Apps (set once in .env by LeadDash)
// ==========================================

export type AppKey = "google" | "google_business" | "linkedin" | "meta" | "x";

type AppDef = {
  provider: Provider;
  clientId: () => string;
  clientSecret: () => string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce?: boolean;
};

const GRAPH = "https://graph.facebook.com/v26.0";
const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || "202609";

export const APPS: Record<AppKey, AppDef> = {
  google: {
    provider: "google_workspace",
    clientId: () => process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || "",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // gmail.send is a sensitive scope (no yearly security audit). Reading the inbox would need restricted scopes.
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events"],
  },
  google_business: {
    provider: "google_business",
    clientId: () => process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || "",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/business.manage"],
  },
  linkedin: {
    provider: "linkedin",
    clientId: () => process.env.LINKEDIN_CLIENT_ID || "",
    clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET || "",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "email", "w_member_social"],
  },
  meta: {
    provider: "facebook",
    clientId: () => process.env.META_APP_ID || "",
    clientSecret: () => process.env.META_APP_SECRET || "",
    authUrl: "https://www.facebook.com/v26.0/dialog/oauth",
    tokenUrl: `${GRAPH}/oauth/access_token`,
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish", "business_management"],
  },
  x: {
    provider: "x",
    clientId: () => process.env.X_CLIENT_ID || "",
    clientSecret: () => process.env.X_CLIENT_SECRET || "",
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    pkce: true,
  },
};

export function appReady(key: AppKey) {
  const a = APPS[key];
  return !!(a.clientId() && a.clientSecret() && hasSecretsKey());
}

/** Which Connect buttons work on this server. Nothing secret. */
export function readyApps() {
  return Object.fromEntries((Object.keys(APPS) as AppKey[]).map((k) => [k, appReady(k)])) as Record<AppKey, boolean>;
}

const redirectUri = (key: AppKey) => `${ENV.appUrl}/api/oauth/${key}/callback`;

// ==========================================
// Tokens
// ==========================================

export type Tokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null; // ms
  /** Meta: the chosen Page's token (does not expire). */
  pageToken?: string | null;
  /** Meta: every Page the person manages, until one is chosen. */
  pages?: { id: string; name: string; token: string; igId: string | null; igUsername: string | null }[];
};

function readTokens(secrets: string | null): Tokens | null {
  try {
    return decryptJson<Tokens>(secrets);
  } catch {
    return null;
  }
}

async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(providerError(data, res.status));
  return data;
}

function providerError(data: any, status: number) {
  const msg = data?.error_description || data?.error?.message || data?.message || data?.detail || data?.title || (typeof data?.error === "string" ? data.error : "") || data?.raw?.slice?.(0, 200) || "";
  return `${status}${msg ? `: ${msg}` : ""}`;
}

async function api(url: string, init: RequestInit & { token: string; headers?: Record<string, string> }) {
  const { token, headers, ...rest } = init;
  const res = await fetch(url, { ...rest, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(providerError(data, res.status));
  return { data, res };
}

class NotConnected extends Error {}

/** A fresh access token for a workspace's connection, refreshing it when it is about to expire. */
async function accessToken(orgId: number, provider: Provider) {
  const conn = await db.getConnectionByProvider(orgId, provider);
  if (!conn || conn.status !== "connected") throw new NotConnected(`${LABEL[provider]} is not connected`);
  const t = readTokens(conn.secretsEncrypted);
  if (!t?.accessToken) throw new NotConnected(`Reconnect ${LABEL[provider]}`);
  if (t.expiresAt && t.expiresAt < Date.now() + 90_000) {
    const key = (Object.keys(APPS) as AppKey[]).find((k) => APPS[k].provider === provider)!;
    if (!t.refreshToken) {
      await db.upsertExternalConnection({ ...conn, status: "error", lastCheckedAt: new Date() });
      throw new NotConnected(`Reconnect ${LABEL[provider]}, the sign-in expired`);
    }
    const a = APPS[key];
    try {
      const d =
        key === "x"
          ? await postForm(a.tokenUrl, { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: a.clientId() }, { authorization: `Basic ${Buffer.from(`${a.clientId()}:${a.clientSecret()}`).toString("base64")}` })
          : await postForm(a.tokenUrl, { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: a.clientId(), client_secret: a.clientSecret() });
      const next: Tokens = { ...t, accessToken: d.access_token, refreshToken: d.refresh_token || t.refreshToken, expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null };
      await db.upsertExternalConnection({ ...conn, secretsEncrypted: encryptJson(next), lastCheckedAt: new Date() });
      return { token: next.accessToken, conn, tokens: next };
    } catch (err) {
      await db.upsertExternalConnection({ ...conn, status: "error", lastCheckedAt: new Date() });
      throw new NotConnected(`Reconnect ${LABEL[provider]}, the sign-in expired`);
    }
  }
  return { token: t.accessToken, conn, tokens: t };
}

const LABEL: Record<string, string> = {
  google_workspace: "Google",
  google_business: "Google Business Profile",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  x: "X",
  wordpress: "WordPress",
  submittable: "Submittable",
  sessionize: "Sessionize",
};

// ==========================================
// Connect: start and callback
// ==========================================

type Pending = { orgId: number; userId: number; app: AppKey; verifier?: string; exp: number };
const pending = new Map<string, Pending>();

function sweep() {
  const now = Date.now();
  pending.forEach((v, k) => v.exp < now && pending.delete(k));
}

async function canManage(req: Request, orgId: number) {
  const { user } = await authenticateRequest(req);
  if (!user) return null;
  if (user.role === "admin") return user;
  const m = await db.getOrganizationMembership(orgId, user.id);
  return m && (m.role === "owner" || m.role === "admin") ? user : null;
}

function back(res: Response, params: Record<string, string>) {
  res.redirect(`/integrations?${new URLSearchParams(params).toString()}`);
}

export function authorizeUrl(key: AppKey, state: string, verifier?: string) {
  const a = APPS[key];
  const q = new URLSearchParams({ client_id: a.clientId(), redirect_uri: redirectUri(key), response_type: "code", state });
  if (key === "meta") q.set("scope", a.scopes.join(","));
  else q.set("scope", a.scopes.join(" "));
  if (key === "google" || key === "google_business") {
    q.set("access_type", "offline");
    q.set("prompt", "consent");
    q.set("include_granted_scopes", "true");
  }
  if (a.pkce && verifier) {
    q.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    q.set("code_challenge_method", "S256");
  }
  return `${a.authUrl}?${q.toString()}`;
}

export function registerOAuth(app: Express) {
  app.get("/api/oauth/:app/start", async (req, res) => {
    const key = String(req.params.app) as AppKey;
    const orgId = Number(req.query.organizationId);
    if (!APPS[key]) return res.status(404).send("Unknown connection.");
    if (!appReady(key)) return back(res, { error: `${LABEL[APPS[key].provider]} is not set up on this server yet.` });
    const { user: signedIn } = await authenticateRequest(req);
    if (!signedIn) return res.redirect("/");
    const user = Number.isFinite(orgId) && orgId > 0 ? await canManage(req, orgId) : null;
    if (!user) return back(res, { error: "Only a workspace owner or admin can connect accounts." });
    sweep();
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = APPS[key].pkce ? crypto.randomBytes(48).toString("base64url") : undefined;
    pending.set(state, { orgId, userId: user.id, app: key, verifier, exp: Date.now() + 10 * 60_000 });
    res.redirect(authorizeUrl(key, state, verifier));
  });

  app.get("/api/oauth/:app/callback", async (req, res) => {
    const key = String(req.params.app) as AppKey;
    const state = String(req.query.state || "");
    const p = pending.get(state);
    pending.delete(state);
    if (!APPS[key] || !p || p.app !== key || p.exp < Date.now()) return back(res, { error: "That sign-in took too long or was already used. Press Connect again." });
    const { user } = await authenticateRequest(req);
    if (!user || user.id !== p.userId) return back(res, { error: "Sign in to LeadDash Employees, then press Connect again." });
    if (req.query.error) return back(res, { error: `${LABEL[APPS[key].provider]} sign-in was cancelled.` });
    const code = String(req.query.code || "");
    if (!code) return back(res, { error: "No sign-in code came back. Press Connect again." });
    try {
      const label = await finishConnect(p.orgId, key, code, p.verifier);
      await db.logAction({ organizationId: p.orgId, actorType: "human_user", actorName: user.name?.trim() || user.email, action: "Connected account", details: `${LABEL[APPS[key].provider]}: ${label}` });
      back(res, { connected: key });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[oauth] ${key} failed:`, message);
      back(res, { error: `${LABEL[APPS[key].provider]} did not connect (${message.slice(0, 160)}).` });
    }
  });

  // Images for Instagram and Facebook: Meta fetches them from a public link, so
  // a signed link that expires after a day serves one stored file.
  app.get("/media/:sig/:exp/*", (req, res) => {
    const rel = String((req.params as Record<string, string>)[0] || "");
    const exp = Number(req.params.exp);
    if (!rel || !exp || exp < Date.now() / 1000 || !safeSig(signMedia(rel, exp), String(req.params.sig))) return res.status(404).end();
    const full = path.resolve(uploadsRoot(), rel);
    if (!full.startsWith(uploadsRoot()) || !fs.existsSync(full)) return res.status(404).end();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.sendFile(full);
  });
}

function signMedia(rel: string, exp: number) {
  return crypto.createHmac("sha256", `media:${ENV.secretsKey}`).update(`${rel}|${exp}`).digest("base64url").slice(0, 32);
}

function safeSig(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A public link to a stored file that works for 24 hours. */
export function publicMediaUrl(fileUrl: string) {
  const rel = fileUrl.replace(/^\/files\//, "");
  const exp = Math.floor(Date.now() / 1000) + 86_400;
  return `${ENV.appUrl}/media/${signMedia(rel, exp)}/${exp}/${rel}`;
}

async function exchange(key: AppKey, code: string, verifier?: string) {
  const a = APPS[key];
  if (key === "x") {
    return postForm(a.tokenUrl, { code, grant_type: "authorization_code", client_id: a.clientId(), redirect_uri: redirectUri(key), code_verifier: verifier ?? "" }, { authorization: `Basic ${Buffer.from(`${a.clientId()}:${a.clientSecret()}`).toString("base64")}` });
  }
  if (key === "meta") {
    const q = new URLSearchParams({ client_id: a.clientId(), client_secret: a.clientSecret(), redirect_uri: redirectUri(key), code });
    const short = await (await fetch(`${a.tokenUrl}?${q}`, { signal: AbortSignal.timeout(20_000) })).json();
    if (!short.access_token) throw new Error(providerError(short, 400));
    const lq = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: a.clientId(), client_secret: a.clientSecret(), fb_exchange_token: short.access_token });
    const long = await (await fetch(`${a.tokenUrl}?${lq}`, { signal: AbortSignal.timeout(20_000) })).json();
    if (!long.access_token) throw new Error(providerError(long, 400));
    return long;
  }
  return postForm(a.tokenUrl, { code, grant_type: "authorization_code", client_id: a.clientId(), client_secret: a.clientSecret(), redirect_uri: redirectUri(key) });
}

/** Trades the code for tokens, reads who connected, and saves the connection. Returns the account label. */
export async function finishConnect(orgId: number, key: AppKey, code: string, verifier?: string) {
  const a = APPS[key];
  const d = await exchange(key, code, verifier);
  const tokens: Tokens = { accessToken: d.access_token, refreshToken: d.refresh_token ?? null, expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null };
  let label = "";
  let handle: string | null = null;
  let settings: Record<string, unknown> = {};
  let status: "connected" | "pending" = "connected";

  if (key === "google" || key === "google_business") {
    const { data } = await api("https://openidconnect.googleapis.com/v1/userinfo", { token: tokens.accessToken });
    label = data.email || data.name || "Google account";
    handle = data.email ?? null;
    settings = { email: data.email ?? null, name: data.name ?? null };
    if (key === "google_business") {
      try {
        const accts = await api("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { token: tokens.accessToken });
        const account = accts.data.accounts?.[0];
        if (account) {
          const locs = await api(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title`, { token: tokens.accessToken });
          const loc = locs.data.locations?.[0];
          settings = { ...settings, account: account.name, location: loc?.name ?? null, locationTitle: loc?.title ?? null };
          if (loc?.title) label = loc.title;
        }
      } catch (err) {
        settings = { ...settings, setupNote: err instanceof Error ? err.message.slice(0, 200) : "Business Profile access is not approved yet" };
      }
    }
  } else if (key === "linkedin") {
    const { data } = await api("https://api.linkedin.com/v2/userinfo", { token: tokens.accessToken });
    label = data.name || data.email || "LinkedIn member";
    handle = data.email ?? null;
    settings = { personUrn: `urn:li:person:${data.sub}`, name: data.name ?? null };
  } else if (key === "x") {
    const { data } = await api("https://api.x.com/2/users/me", { token: tokens.accessToken });
    label = data.data?.name ? `${data.data.name} (@${data.data.username})` : "X account";
    handle = data.data?.username ? `@${data.data.username}` : null;
    settings = { userId: data.data?.id ?? null, username: data.data?.username ?? null };
  } else if (key === "meta") {
    const me = await api(`${GRAPH}/me?fields=id,name`, { token: tokens.accessToken });
    const pages = await api(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=50`, { token: tokens.accessToken });
    const list = (pages.data.data ?? []).map((pg: any) => ({ id: String(pg.id), name: String(pg.name), token: String(pg.access_token), igId: pg.instagram_business_account?.id ?? null, igUsername: pg.instagram_business_account?.username ?? null }));
    if (list.length === 0) throw new Error("No Facebook Pages came back. Choose at least one Page when Facebook asks");
    tokens.pages = list;
    label = me.data.name || "Facebook account";
    settings = { userName: me.data.name ?? null, pages: list.map((x: any) => ({ id: x.id, name: x.name, igUsername: x.igUsername })) };
    if (list.length === 1) {
      Object.assign(settings, pickSettings(list[0]));
      tokens.pageToken = list[0].token;
    } else status = "pending"; // the person picks a Page on Integrations
  }

  await db.upsertExternalConnection({
    organizationId: orgId,
    provider: a.provider,
    accountLabel: label.slice(0, 255),
    accountHandle: handle,
    status,
    capabilities: JSON.stringify(a.scopes),
    settings: JSON.stringify(settings),
    secretsEncrypted: encryptJson(tokens),
    connectedAt: new Date(),
    lastCheckedAt: new Date(),
  });
  return label;
}

function pickSettings(pg: { id: string; name: string; igId: string | null; igUsername: string | null }) {
  return { pageId: pg.id, pageName: pg.name, igId: pg.igId, igUsername: pg.igUsername };
}

/** Meta: the person chose which Page (and its Instagram) to post to. */
export async function choosePage(orgId: number, pageId: string) {
  const conn = await db.getConnectionByProvider(orgId, "facebook");
  const t = readTokens(conn?.secretsEncrypted ?? null);
  const pg = t?.pages?.find((x) => x.id === pageId);
  if (!conn || !t || !pg) throw new Error("That Page is not on this Facebook connection. Press Connect again.");
  const settings = { ...JSON.parse(conn.settings || "{}"), ...pickSettings(pg) };
  await db.upsertExternalConnection({ ...conn, status: "connected", settings: JSON.stringify(settings), secretsEncrypted: encryptJson({ ...t, pageToken: pg.token }), lastCheckedAt: new Date() });
  return db.getConnectionByProvider(orgId, "facebook");
}

export async function disconnect(orgId: number, provider: Provider) {
  const conn = await db.getConnectionByProvider(orgId, provider);
  if (!conn) return;
  const t = readTokens(conn.secretsEncrypted);
  // Best effort: tell Google to drop the grant too.
  if (t?.accessToken && (provider === "google_workspace" || provider === "google_business")) {
    fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent(t.refreshToken || t.accessToken)}` }).catch(() => {});
  }
  await db.upsertExternalConnection({ ...conn, status: "disconnected", secretsEncrypted: null, settings: null, accountHandle: null, connectedAt: null, lastCheckedAt: new Date() });
}

// ==========================================
// Posting and sending on approval
// ==========================================

export type DispatchResult = { channel: string; ok: boolean; url?: string | null; error?: string; at: string };

/** Which channels a workspace can post to right now. */
export async function channelState(orgId: number) {
  const conns = await db.listConnectionsByOrg(orgId);
  const by = (p: Provider) => conns.find((c) => c.provider === p && c.status === "connected");
  const fb = by("facebook");
  const fbSettings = fb ? JSON.parse(fb.settings || "{}") : {};
  return {
    linkedin: !!by("linkedin"),
    facebook: !!(fb && fbSettings.pageId),
    instagram: !!(fb && fbSettings.igId),
    x: !!by("x"),
    google_business: !!by("google_business"),
    gmail: !!by("google_workspace"),
    calendar: !!by("google_workspace"),
  } as Record<string, boolean>;
}

function localFile(fileUrl: string | null | undefined) {
  if (!fileUrl?.startsWith("/files/")) return null;
  const full = path.resolve(uploadsRoot(), fileUrl.slice("/files/".length));
  return full.startsWith(uploadsRoot()) && fs.existsSync(full) ? full : null;
}

/** Instagram takes JPEG only; converts once and keeps the copy next to the original. */
async function jpegUrl(fileUrl: string) {
  if (/\.jpe?g$/i.test(fileUrl)) return fileUrl;
  const src = localFile(fileUrl);
  if (!src) return fileUrl;
  const out = src.replace(/\.[a-z0-9]+$/i, "") + ".ig.jpg";
  if (!fs.existsSync(out)) {
    const sharp = (await import("sharp")).default;
    await sharp(src).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toFile(out);
  }
  return `/files/${path.relative(uploadsRoot(), out).split(path.sep).join("/")}`;
}

async function postLinkedIn(orgId: number, text: string, imageUrl: string | null) {
  const { token, conn } = await accessToken(orgId, "linkedin");
  const author = JSON.parse(conn.settings || "{}").personUrn;
  if (!author) throw new Error("Reconnect LinkedIn");
  const headers = { "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0", "content-type": "application/json" };
  let content: Record<string, unknown> | undefined;
  const file = localFile(imageUrl);
  if (file) {
    const init = await api("https://api.linkedin.com/rest/images?action=initializeUpload", { method: "POST", token, headers, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) });
    const up = await fetch(init.data.value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: fs.readFileSync(file) });
    if (!up.ok) throw new Error(`image upload ${up.status}`);
    content = { media: { id: init.data.value.image, altText: text.slice(0, 120) } };
  }
  const { res } = await api("https://api.linkedin.com/rest/posts", {
    method: "POST",
    token,
    headers,
    body: JSON.stringify({ author, commentary: text, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...(content ? { content } : {}) }),
  });
  const urn = res.headers.get("x-restli-id");
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

async function metaPage(orgId: number) {
  const conn = await db.getConnectionByProvider(orgId, "facebook");
  if (!conn || conn.status !== "connected") throw new NotConnected("Facebook is not connected");
  const s = JSON.parse(conn.settings || "{}");
  const t = readTokens(conn.secretsEncrypted);
  if (!s.pageId || !t?.pageToken) throw new NotConnected("Choose a Facebook Page on Integrations");
  return { pageId: String(s.pageId), igId: s.igId ? String(s.igId) : null, token: t.pageToken };
}

async function postFacebook(orgId: number, text: string, imageUrl: string | null) {
  const { pageId, token } = await metaPage(orgId);
  if (imageUrl && localFile(imageUrl)) {
    const { data } = await api(`${GRAPH}/${pageId}/photos`, { method: "POST", token, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: publicMediaUrl(imageUrl), caption: text }).toString() });
    return data.post_id ? `https://www.facebook.com/${data.post_id}` : null;
  }
  const { data } = await api(`${GRAPH}/${pageId}/feed`, { method: "POST", token, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: text }).toString() });
  return data.id ? `https://www.facebook.com/${data.id}` : null;
}

async function postInstagram(orgId: number, text: string, imageUrl: string | null) {
  const { igId, token } = await metaPage(orgId);
  if (!igId) throw new NotConnected("No Instagram business account is linked to the chosen Page");
  if (!imageUrl || !localFile(imageUrl)) throw new Error("Instagram posts need an image");
  const jpg = await jpegUrl(imageUrl);
  const c = await api(`${GRAPH}/${igId}/media`, { method: "POST", token, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ image_url: publicMediaUrl(jpg), caption: text.slice(0, 2200) }).toString() });
  // Meta needs a moment to fetch the image before the container can be published.
  for (let i = 0; i < 10; i++) {
    const st = await api(`${GRAPH}/${c.data.id}?fields=status_code`, { token }).catch(() => null);
    if (!st || st.data.status_code === "FINISHED") break;
    if (st.data.status_code === "ERROR") throw new Error("Instagram could not read the image");
    await new Promise((r) => setTimeout(r, 2000));
  }
  const { data } = await api(`${GRAPH}/${igId}/media_publish`, { method: "POST", token, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ creation_id: c.data.id }).toString() });
  const link = await api(`${GRAPH}/${data.id}?fields=permalink`, { token }).catch(() => null);
  return link?.data?.permalink ?? null;
}

async function postX(orgId: number, text: string, imageUrl: string | null) {
  const { token, conn } = await accessToken(orgId, "x");
  let media: { media_ids: string[] } | undefined;
  const file = localFile(imageUrl);
  if (file) {
    const form = new FormData();
    form.append("media", new Blob([fs.readFileSync(file)]), path.basename(file));
    form.append("media_category", "tweet_image");
    const up = await api("https://api.x.com/2/media/upload", { method: "POST", token, body: form });
    if (up.data?.data?.id) media = { media_ids: [String(up.data.data.id)] };
  }
  const short = text.length > 280 ? `${text.slice(0, 276).replace(/\s+\S*$/, "")}...` : text;
  const { data } = await api("https://api.x.com/2/tweets", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: short, ...(media ? { media } : {}) }) });
  const user = JSON.parse(conn.settings || "{}").username;
  return data.data?.id ? `https://x.com/${user || "i"}/status/${data.data.id}` : null;
}

async function postBusiness(orgId: number, text: string, imageUrl: string | null) {
  const { token, conn } = await accessToken(orgId, "google_business");
  const s = JSON.parse(conn.settings || "{}");
  if (!s.account || !s.location) throw new Error(s.setupNote ? `Business Profile access is not ready: ${s.setupNote}` : "No Business Profile location was found");
  const locId = String(s.location).split("/").pop();
  const body: Record<string, unknown> = { languageCode: "en-US", summary: text.slice(0, 1500), topicType: "STANDARD" };
  if (imageUrl && localFile(imageUrl)) body.media = [{ mediaFormat: "PHOTO", sourceUrl: publicMediaUrl(imageUrl) }];
  const { data } = await api(`https://mybusiness.googleapis.com/v4/${s.account}/locations/${locId}/localPosts`, { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return data.searchUrl ?? null;
}

function encodeHeader(v: string) {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** Sends a plain-text email from the connected Gmail account. */
export async function sendGmail(orgId: number, to: string, subject: string, body: string) {
  const { token } = await accessToken(orgId, "google_workspace");
  const raw = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");
  const { data } = await api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }) });
  return data.id ? `https://mail.google.com/mail/u/0/#sent/${data.threadId ?? data.id}` : null;
}

function emailIn(s: string | undefined | null) {
  return (s ?? "").match(/[^\s<>"',;]+@[^\s<>"',;]+\.[a-z]{2,}/i)?.[0] ?? null;
}

async function addToCalendar(orgId: number, item: OutboundItem) {
  const { token } = await accessToken(orgId, "google_workspace");
  const meta = JSON.parse(item.metadata || "{}");
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const start = toLocalDateTime(meta.date, meta.time);
  if (!start) throw new Error("The hold has no date and time Google can read. Edit it with a date like 10/05/2026 and a time like 2:00 PM.");
  const end = new Date(new Date(`${start}Z`).getTime() + 60 * 60_000).toISOString().slice(0, 19);
  const attendees = (meta.attendees ?? []).map((a: string) => emailIn(a)).filter(Boolean).map((email: string) => ({ email }));
  const { data } = await api("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none", {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: item.title, description: item.body ?? "", start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz }, attendees }),
  });
  return data.htmlLink ?? null;
}

/** "10/05/2026" or "2026-10-05" or "Oct 5, 2026" with "2:00 PM" or "14:00" becomes "2026-10-05T14:00:00". */
export function toLocalDateTime(date: string | undefined, time: string | undefined) {
  if (!date) return null;
  let y: number, m: number, d: number;
  let mm = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mm) [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [m, d, y] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else {
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return null;
    [y, m, d] = [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate()];
  }
  const t = (time ?? "09:00").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?/);
  let h = t ? Number(t[1]) : 9;
  const mi = t?.[2] ? Number(t[2]) : 0;
  if (t?.[3]?.startsWith("p") && h < 12) h += 12;
  if (t?.[3]?.startsWith("a") && h === 12) h = 0;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p2(m)}-${p2(d)}T${p2(h)}:${p2(mi)}:00`;
}

/** A subject a candidate would expect, instead of the Approvals title ("Outreach: Outpatient therapist"). */
async function hiringSubject(item: OutboundItem, purpose: string | undefined) {
  const role = item.title.replace(/^[^:]+:\s*/, "");
  const org = (await db.getOrganizationById(item.organizationId))?.name ?? "";
  if (purpose === "interview") return `Interview for ${role}${org ? ` at ${org}` : ""}`;
  if (purpose === "decline") return `Your application for ${role}`;
  if (purpose === "offer") return `Your offer from ${org || "us"}`;
  if (purpose === "follow_up") return `Following up: ${role}${org ? ` at ${org}` : ""}`;
  return `${role}${org ? ` at ${org}` : ""}`;
}

const SOCIAL: Record<string, (orgId: number, text: string, image: string | null) => Promise<string | null>> = {
  linkedin: postLinkedIn,
  facebook: postFacebook,
  instagram: postInstagram,
  x: postX,
  google_business: postBusiness,
};

/** Channels an item goes to, by name (linkedin, facebook, gmail, calendar...). */
export function channelsFor(item: OutboundItem): string[] {
  if (item.kind === "social_post") {
    try {
      const list = JSON.parse(item.targetChannels || "[]");
      return (Array.isArray(list) ? list : []).filter((c: unknown): c is string => typeof c === "string" && c in SOCIAL);
    } catch {
      return [];
    }
  }
  if (item.kind === "calendar_hold") return ["calendar"];
  if (item.kind === "email_draft" || item.kind === "hiring_email" || item.kind === "speaking_pitch") return ["gmail"];
  return [];
}

/**
 * Posts or sends an approved item to every connected channel it is meant for.
 * Channels that are not connected are left waiting; nothing is sent twice.
 */
export async function dispatch(item: OutboundItem): Promise<{ status: OutboundItem["status"]; results: DispatchResult[] }> {
  const meta = JSON.parse(item.metadata || "{}");
  const previous: DispatchResult[] = Array.isArray(meta.dispatch) ? meta.dispatch : [];
  const channels = channelsFor(item);
  if (channels.length === 0) return { status: item.status === "published" ? "published" : "blocked_connection", results: previous };
  const state = await channelState(item.organizationId);
  const results: DispatchResult[] = [];
  for (const ch of channels) {
    const done = previous.find((r) => r.channel === ch && r.ok);
    if (done) {
      results.push(done);
      continue;
    }
    if (!state[ch]) {
      results.push({ channel: ch, ok: false, error: `${LABEL[ch] ?? (ch === "gmail" ? "Gmail" : "Google Calendar")} is not connected`, at: new Date().toISOString() });
      continue;
    }
    try {
      let url: string | null = null;
      if (ch === "gmail") {
        const to = emailIn(meta.email) || emailIn(meta.recipient) || emailIn(meta.to);
        if (!to) throw new Error("There is no email address for the recipient");
        const subject = item.kind === "hiring_email" ? await hiringSubject(item, meta.purpose) : item.title;
        url = await sendGmail(item.organizationId, to, subject, item.body ?? "");
      } else if (ch === "calendar") url = await addToCalendar(item.organizationId, item);
      else url = await SOCIAL[ch](item.organizationId, item.body ?? item.title, item.imageUrl);
      results.push({ channel: ch, ok: true, url, at: new Date().toISOString() });
    } catch (err) {
      results.push({ channel: ch, ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err), at: new Date().toISOString() });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const waiting = results.filter((r) => !r.ok && /not connected|Choose a Facebook Page/.test(r.error ?? "")).length;
  const status: OutboundItem["status"] = okCount === results.length ? "published" : okCount === 0 && waiting === results.length ? "blocked_connection" : "approved";
  return { status, results };
}

export function channelLabel(ch: string) {
  return ch === "gmail" ? "Gmail" : ch === "calendar" ? "Google Calendar" : LABEL[ch] ?? ch;
}
