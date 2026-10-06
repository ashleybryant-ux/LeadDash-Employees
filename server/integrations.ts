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
import { payloadFor, postChannels, type Payload, type SocialChannel } from "@shared/post-model";

/**
 * One-click connections. LeadDash registers one app with each company
 * (Google, LinkedIn, Meta, Threads, TikTok, X) and puts its keys in the server's .env once.
 * Every workspace then connects with a Connect button: the person signs in
 * with the company, approves, and lands back on Integrations. Tokens are
 * encrypted with SECRETS_KEY and never sent to the browser.
 *
 * After that, Approve in Approvals posts or sends for real.
 */

// ==========================================
// Apps (set once in .env by LeadDash)
// ==========================================

export type AppKey = "google" | "google_business" | "linkedin" | "meta" | "x" | "threads" | "tiktok" | "clickup" | "zoom";

type AppDef = {
  provider: Provider;
  clientId: () => string;
  clientSecret: () => string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  pkce?: boolean;
};

const GRAPH_VERSION = "v26.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const THREADS = "https://graph.threads.net/v1.0";
const TIKTOK = "https://open.tiktokapis.com/v2";
const CLICKUP = "https://api.clickup.com/api/v2";
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
  threads: {
    provider: "threads",
    clientId: () => process.env.THREADS_APP_ID || "",
    clientSecret: () => process.env.THREADS_APP_SECRET || "",
    authUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    scopes: ["threads_basic", "threads_content_publish"],
  },
  tiktok: {
    provider: "tiktok",
    clientId: () => process.env.TIKTOK_CLIENT_KEY || "",
    clientSecret: () => process.env.TIKTOK_CLIENT_SECRET || "",
    authUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: `${TIKTOK}/oauth/token/`,
    scopes: ["user.info.basic", "video.publish"],
  },
  // ClickUp has no scopes: the person picks which Workspaces the app may use when they approve.
  clickup: {
    provider: "clickup",
    clientId: () => process.env.CLICKUP_CLIENT_ID || "",
    clientSecret: () => process.env.CLICKUP_CLIENT_SECRET || "",
    authUrl: "https://app.clickup.com/api",
    tokenUrl: "https://api.clickup.com/api/v2/oauth/token",
    scopes: [],
  },
  // Zoom scopes are set on the app in Zoom's App Marketplace (create meetings, read recordings).
  zoom: {
    provider: "zoom",
    clientId: () => process.env.ZOOM_CLIENT_ID || "",
    clientSecret: () => process.env.ZOOM_CLIENT_SECRET || "",
    authUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    scopes: [],
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

export async function api(url: string, init: RequestInit & { token: string; headers?: Record<string, string> }) {
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

/** The main Google connection's token (null when it isn't connected). */
export async function mainGoogleToken(orgId: number) {
  try {
    return (await accessToken(orgId, "google_workspace")).token;
  } catch {
    return null;
  }
}

/** A fresh access token for an extra Google account, refreshing it when needed. */
export async function linkToken(link: { id: number; organizationId: number; name: string; secretsEncrypted: string | null }) {
  const t = readTokens(link.secretsEncrypted);
  if (!t?.accessToken) throw new Error(`Reconnect ${link.name}`);
  if (!t.expiresAt || t.expiresAt > Date.now() + 90_000) return t.accessToken;
  if (!t.refreshToken) {
    db.updateAccountLink(link.id, link.organizationId, { status: "error", error: "The sign-in expired" });
    throw new Error(`Reconnect ${link.name}, the sign-in expired`);
  }
  const a = APPS.google;
  try {
    const d = await postForm(a.tokenUrl, { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: a.clientId(), client_secret: a.clientSecret() });
    const next: Tokens = { ...t, accessToken: d.access_token, refreshToken: d.refresh_token || t.refreshToken, expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null };
    db.updateAccountLink(link.id, link.organizationId, { secretsEncrypted: encryptJson(next), status: "connected", error: null });
    return next.accessToken;
  } catch {
    db.updateAccountLink(link.id, link.organizationId, { status: "error", error: "The sign-in expired" });
    throw new Error(`Reconnect ${link.name}, the sign-in expired`);
  }
}

/** A fresh access token for a workspace's connection, refreshing it when it is about to expire. */
async function accessToken(orgId: number, provider: Provider) {
  const conn = await db.getConnectionByProvider(orgId, provider);
  if (!conn || conn.status !== "connected") throw new NotConnected(`${LABEL[provider]} is not connected`);
  const t = readTokens(conn.secretsEncrypted);
  if (!t?.accessToken) throw new NotConnected(`Reconnect ${LABEL[provider]}`);
  // Threads tokens last 60 days and refresh themselves; renew a week early.
  if (provider === "threads" && t.expiresAt && t.expiresAt < Date.now() + 7 * 86_400_000) {
    if (t.expiresAt < Date.now()) {
      await db.upsertExternalConnection({ ...conn, status: "error", lastCheckedAt: new Date() });
      throw new NotConnected("Reconnect Threads, the sign-in expired");
    }
    try {
      const r = await fetch(`https://graph.threads.net/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: t.accessToken })}`, { signal: AbortSignal.timeout(20_000) });
      const d = await r.json();
      if (d.access_token) {
        const next: Tokens = { ...t, accessToken: d.access_token, expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : t.expiresAt };
        await db.upsertExternalConnection({ ...conn, secretsEncrypted: encryptJson(next), lastCheckedAt: new Date() });
        return { token: next.accessToken, conn, tokens: next };
      }
    } catch {
      // Still valid for now; try again next time.
    }
    return { token: t.accessToken, conn, tokens: t };
  }
  if (t.expiresAt && t.expiresAt < Date.now() + 90_000) {
    const key = (Object.keys(APPS) as AppKey[]).find((k) => APPS[k].provider === provider)!;
    if (!t.refreshToken) {
      await db.upsertExternalConnection({ ...conn, status: "error", lastCheckedAt: new Date() });
      throw new NotConnected(`Reconnect ${LABEL[provider]}, the sign-in expired`);
    }
    const a = APPS[key];
    try {
      const d =
        key === "x" || key === "zoom"
          ? await postForm(a.tokenUrl, { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: a.clientId() }, { authorization: `Basic ${Buffer.from(`${a.clientId()}:${a.clientSecret()}`).toString("base64")}` })
          : key === "tiktok"
            ? await postForm(a.tokenUrl, { grant_type: "refresh_token", refresh_token: t.refreshToken, client_key: a.clientId(), client_secret: a.clientSecret() })
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
  threads: "Threads",
  tiktok: "TikTok",
  wordpress: "WordPress",
  clickup: "ClickUp",
  zoom: "Zoom",
  submittable: "Submittable",
  sessionize: "Sessionize",
};

// ==========================================
// Connect: start and callback
// ==========================================

/** link: an extra Google account (a calendar Avery checks, or a Gmail some employees send from), not the main connection. */
export type LinkStart = { purpose: "calendar" | "send"; name: string; id?: number };
type Pending = { orgId: number; userId: number; app: AppKey; verifier?: string; exp: number; link?: LinkStart };
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

/** Extra Google accounts ask only for what their job needs. */
export const LINK_SCOPES: Record<LinkStart["purpose"], string[]> = {
  calendar: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
  send: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.send"],
};

export function authorizeUrl(key: AppKey, state: string, verifier?: string, scopes?: string[]) {
  const a = { ...APPS[key], scopes: scopes ?? APPS[key].scopes };
  const q = new URLSearchParams({ [key === "tiktok" ? "client_key" : "client_id"]: a.clientId(), redirect_uri: redirectUri(key), response_type: "code", state });
  if (key === "clickup") return `${a.authUrl}?${new URLSearchParams({ client_id: a.clientId(), redirect_uri: redirectUri(key), state }).toString()}`;
  if (key === "meta" || key === "threads" || key === "tiktok") q.set("scope", a.scopes.join(","));
  else if (a.scopes.length) q.set("scope", a.scopes.join(" "));
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
  // An extra Google account: same Google app and callback, its own scopes.
  // Registered before /api/oauth/:app/start, or "link" is taken for an app name ("Unknown connection.").
  app.get("/api/oauth/link/start", async (req, res) => {
    const orgId = Number(req.query.organizationId);
    const purpose = req.query.purpose === "send" ? "send" : "calendar";
    if (!appReady("google")) return back(res, { error: "Google is not set up on this server yet." });
    const { user: signedIn } = await authenticateRequest(req);
    if (!signedIn) return res.redirect("/signin");
    const user = Number.isFinite(orgId) && orgId > 0 ? await canManage(req, orgId) : null;
    if (!user) return back(res, { error: "Only a workspace owner or admin can connect accounts." });
    sweep();
    const state = crypto.randomBytes(24).toString("base64url");
    const id = Number(req.query.id) || undefined;
    const name = String(req.query.name || "").trim().slice(0, 80);
    pending.set(state, { orgId, userId: user.id, app: "google", exp: Date.now() + 10 * 60_000, link: { purpose, name, id } });
    res.redirect(authorizeUrl("google", state, undefined, LINK_SCOPES[purpose]));
  });

  app.get("/api/oauth/:app/start", async (req, res) => {
    const key = String(req.params.app) as AppKey;
    const orgId = Number(req.query.organizationId);
    if (!APPS[key]) return res.status(404).send("Unknown connection.");
    if (!appReady(key)) return back(res, { error: `${LABEL[APPS[key].provider]} is not set up on this server yet.` });
    const { user: signedIn } = await authenticateRequest(req);
    if (!signedIn) return res.redirect("/signin");
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
    const code = String(req.query.code || "").replace(/#_$/, "");
    if (!code) return back(res, { error: "No sign-in code came back. Press Connect again." });
    if (p.link) {
      try {
        const { finishLink } = await import("./employees/calendars");
        const row = await finishLink(p.orgId, code, p.link);
        await db.logAction({ organizationId: p.orgId, actorType: "human_user", actorName: user.name?.trim() || user.email, action: p.link.purpose === "send" ? "Connected a sending address" : "Connected a calendar", details: `${row.name}: ${row.email ?? ""}` });
        return back(res, { connected: p.link.purpose === "send" ? "sending" : "calendar" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[oauth] link failed:", message);
        return back(res, { error: `Google did not connect (${message.slice(0, 160)}).` });
      }
    }
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

  // Meta checks robots.txt before it fetches a Reel from this server.
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nAllow: /\n");
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

export async function exchange(key: AppKey, code: string, verifier?: string) {
  const a = APPS[key];
  if (key === "x") {
    return postForm(a.tokenUrl, { code, grant_type: "authorization_code", client_id: a.clientId(), redirect_uri: redirectUri(key), code_verifier: verifier ?? "" }, { authorization: `Basic ${Buffer.from(`${a.clientId()}:${a.clientSecret()}`).toString("base64")}` });
  }
  if (key === "clickup") {
    const q = new URLSearchParams({ client_id: a.clientId(), client_secret: a.clientSecret(), code });
    const r = await fetch(`${a.tokenUrl}?${q}`, { method: "POST", headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw new Error(providerError(d, r.status));
    return d;
  }
  if (key === "zoom") {
    return postForm(a.tokenUrl, { code, grant_type: "authorization_code", redirect_uri: redirectUri(key) }, { authorization: `Basic ${Buffer.from(`${a.clientId()}:${a.clientSecret()}`).toString("base64")}` });
  }
  if (key === "tiktok") {
    const d = await postForm(a.tokenUrl, { client_key: a.clientId(), client_secret: a.clientSecret(), code, grant_type: "authorization_code", redirect_uri: redirectUri(key) });
    if (!d.access_token) throw new Error(providerError(d, 400));
    return d;
  }
  if (key === "threads") {
    const body = { client_id: a.clientId(), client_secret: a.clientSecret(), grant_type: "authorization_code", redirect_uri: redirectUri(key), code };
    // Meta documents both hosts; try the .net one first.
    const short = await postForm(a.tokenUrl, body).catch(() => postForm("https://graph.threads.com/oauth/access_token", body));
    if (!short.access_token) throw new Error(providerError(short, 400));
    const lq = new URLSearchParams({ grant_type: "th_exchange_token", client_secret: a.clientSecret(), access_token: short.access_token });
    const long = await (await fetch(`https://graph.threads.net/access_token?${lq}`, { signal: AbortSignal.timeout(20_000) })).json();
    if (!long.access_token) throw new Error(providerError(long, 400));
    return { ...long, user_id: short.user_id };
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
  } else if (key === "threads") {
    const { data } = await api(`${THREADS}/me?fields=id,username`, { token: tokens.accessToken });
    label = data.username ? `@${data.username}` : "Threads account";
    handle = data.username ? `@${data.username}` : null;
    settings = { userId: String(data.id ?? d.user_id ?? ""), username: data.username ?? null };
  } else if (key === "tiktok") {
    const info = await tiktokCreatorWith(tokens.accessToken);
    label = info.username ? `@${info.username}` : info.nickname || "TikTok account";
    handle = info.username ? `@${info.username}` : null;
    settings = { openId: d.open_id ?? null, username: info.username, nickname: info.nickname };
  } else if (key === "clickup") {
    const me = await api(`${CLICKUP}/user`, { token: tokens.accessToken });
    const teams = await api(`${CLICKUP}/team`, { token: tokens.accessToken });
    const team = teams.data.teams?.[0];
    if (!team) throw new Error("No ClickUp Workspace came back. Choose a Workspace when ClickUp asks");
    const spaces = await api(`${CLICKUP}/team/${team.id}/space?archived=false`, { token: tokens.accessToken });
    const list = (spaces.data.spaces ?? []).map((sp: any) => ({ id: String(sp.id), name: String(sp.name) }));
    label = team.name || "ClickUp Workspace";
    handle = me.data.user?.email ?? null;
    settings = { teamId: String(team.id), teamName: team.name ?? null, userId: me.data.user?.id ?? null, userEmail: me.data.user?.email ?? null, spaces: list, spaceId: list[0]?.id ?? null, spaceName: list[0]?.name ?? null };
  } else if (key === "zoom") {
    // Reading the profile only names the account. Without the user:read:user scope Zoom still connects.
    const me = await api("https://api.zoom.us/v2/users/me", { token: tokens.accessToken }).catch(() => null);
    label = me?.data.email || [me?.data.first_name, me?.data.last_name].filter(Boolean).join(" ") || "Zoom account";
    handle = me?.data.email ?? null;
    settings = { email: me?.data.email ?? null, userId: me?.data.id ?? null };
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
    threads: !!by("threads"),
    tiktok: !!by("tiktok"),
    google_business: !!by("google_business"),
    gmail: !!by("google_workspace") || db.listAccountLinks(orgId, "send").some((l) => l.status === "connected"),
    calendar: !!by("google_workspace") || db.listAccountLinks(orgId, "calendar").some((l) => l.kind === "google" && l.holds !== "no"),
  } as Record<string, boolean>;
}

function localFile(fileUrl: string | null | undefined) {
  if (!fileUrl?.startsWith("/files/")) return null;
  const full = path.resolve(uploadsRoot(), fileUrl.slice("/files/".length));
  return full.startsWith(uploadsRoot()) && fs.existsSync(full) ? full : null;
}

// ---------- Files and waiting ----------

const VIDEO_MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };
const videoMime = (file: string) => VIDEO_MIME[path.extname(file).toLowerCase()] ?? "video/mp4";

/** Seconds between status checks while a platform processes a video. Tests set it to 0. */
let pollMs = 10_000;
export function setPollMs(ms: number) {
  pollMs = ms;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks until check() returns a value, or gives up after maxMs. */
async function waitUntil<T>(check: () => Promise<T | null>, maxMs: number, what: string): Promise<T> {
  const tries = Math.max(1, Math.ceil(maxMs / Math.max(pollMs, 1)));
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v !== null) return v;
    await sleep(pollMs);
  }
  throw new Error(`${what} was still processing after ${Math.round(maxMs / 60_000)} minutes. Press Try again later`);
}

async function readRange(file: string, start: number, length: number) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function needVideo(p: Payload) {
  const file = localFile(p.videoUrl);
  if (!file) throw new Error("The video file is missing. Upload it again");
  return file;
}

function relUrl(full: string) {
  return `/files/${path.relative(uploadsRoot(), full).split(path.sep).join("/")}`;
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
  return relUrl(out);
}

/**
 * Instagram feed images must be between 4:5 (tall) and 1.91:1 (wide). Taller
 * or wider images are cut evenly from both sides, exactly as the preview shows.
 */
export function igCropBox(w: number, h: number) {
  const r = w / h;
  if (r < 0.8) {
    const nh = Math.round(w / 0.8);
    return { left: 0, top: Math.floor((h - nh) / 2), width: w, height: nh };
  }
  if (r > 1.91) {
    const nw = Math.round(h * 1.91);
    return { left: Math.floor((w - nw) / 2), top: 0, width: nw, height: h };
  }
  return null;
}

async function instagramImageUrl(fileUrl: string) {
  const src = localFile(fileUrl);
  if (!src) return fileUrl;
  const out = src.replace(/\.[a-z0-9]+$/i, "") + ".ig4.jpg";
  if (!fs.existsSync(out)) {
    const sharp = (await import("sharp")).default;
    const m = await sharp(src).metadata();
    let img = sharp(src);
    const box = m.width && m.height ? igCropBox(m.width, m.height) : null;
    if (box) img = img.extract(box);
    await img.resize({ width: 1440, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toFile(out);
  }
  return relUrl(out);
}

/** Threads takes JPEG or PNG up to 8 MB. */
async function threadsImageUrl(fileUrl: string) {
  const src = localFile(fileUrl);
  if (!src) return fileUrl;
  if (/\.(jpe?g|png)$/i.test(src) && fs.statSync(src).size <= 8_000_000) return fileUrl;
  const out = src.replace(/\.[a-z0-9]+$/i, "") + ".th.jpg";
  if (!fs.existsSync(out)) {
    const sharp = (await import("sharp")).default;
    await sharp(src).resize({ width: 1440, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toFile(out);
  }
  return relUrl(out);
}

const form = (body: Record<string, string>) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

// ---------- LinkedIn ----------

async function postLinkedIn(orgId: number, p: Payload) {
  const { token, conn } = await accessToken(orgId, "linkedin");
  const author = JSON.parse(conn.settings || "{}").personUrn;
  if (!author) throw new Error("Reconnect LinkedIn");
  const headers = { "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0", "content-type": "application/json" };
  let content: Record<string, unknown> | undefined;
  if (p.type === "reel") {
    const file = needVideo(p);
    const size = fs.statSync(file).size;
    const init = await api("https://api.linkedin.com/rest/videos?action=initializeUpload", { method: "POST", token, headers, body: JSON.stringify({ initializeUploadRequest: { owner: author, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }) });
    const v = init.data.value;
    const etags: string[] = [];
    for (const part of v.uploadInstructions ?? []) {
      const chunk = await readRange(file, Number(part.firstByte), Number(part.lastByte) - Number(part.firstByte) + 1);
      const up = await fetch(part.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: chunk, signal: AbortSignal.timeout(300_000) });
      if (!up.ok) throw new Error(`LinkedIn video upload ${up.status}`);
      etags.push(String(up.headers.get("etag") ?? "").replace(/"/g, ""));
    }
    await api("https://api.linkedin.com/rest/videos?action=finalizeUpload", { method: "POST", token, headers, body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? "", uploadedPartIds: etags } }) });
    await waitUntil(
      async () => {
        const st = await api(`https://api.linkedin.com/rest/videos/${encodeURIComponent(v.video)}`, { token, headers });
        if (st.data.status === "PROCESSING_FAILED") throw new Error("LinkedIn could not process the video");
        return st.data.status === "AVAILABLE" ? true : null;
      },
      10 * 60_000,
      "LinkedIn"
    );
    content = { media: { id: v.video, title: p.text.split("\n")[0].slice(0, 100) } };
  } else {
    const file = localFile(p.imageUrl);
    if (file) {
      const init = await api("https://api.linkedin.com/rest/images?action=initializeUpload", { method: "POST", token, headers, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) });
      const up = await fetch(init.data.value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: fs.readFileSync(file) });
      if (!up.ok) throw new Error(`image upload ${up.status}`);
      content = { media: { id: init.data.value.image, altText: p.text.slice(0, 120) } };
    }
  }
  const { res } = await api("https://api.linkedin.com/rest/posts", {
    method: "POST",
    token,
    headers,
    body: JSON.stringify({ author, commentary: p.text, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, ...(content ? { content } : {}) }),
  });
  const urn = res.headers.get("x-restli-id");
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

// ---------- Facebook and Instagram ----------

async function metaPage(orgId: number) {
  const conn = await db.getConnectionByProvider(orgId, "facebook");
  if (!conn || conn.status !== "connected") throw new NotConnected("Facebook is not connected");
  const s = JSON.parse(conn.settings || "{}");
  const t = readTokens(conn.secretsEncrypted);
  if (!s.pageId || !t?.pageToken) throw new NotConnected("Choose a Facebook Page on Integrations");
  return { pageId: String(s.pageId), igId: s.igId ? String(s.igId) : null, token: t.pageToken };
}

async function postFacebook(orgId: number, p: Payload) {
  const { pageId, token } = await metaPage(orgId);
  if (p.type === "reel") {
    needVideo(p);
    const start = await api(`${GRAPH}/${pageId}/video_reels`, { method: "POST", token, ...form({ upload_phase: "start" }) });
    const videoId = String(start.data.video_id);
    const up = await fetch(`https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`, { method: "POST", headers: { authorization: `OAuth ${token}`, file_url: publicMediaUrl(p.videoUrl!) }, signal: AbortSignal.timeout(120_000) });
    if (!up.ok) throw new Error(`Facebook could not fetch the video (${up.status})`);
    await api(`${GRAPH}/${pageId}/video_reels`, { method: "POST", token, ...form({ upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: p.text }) });
    await waitUntil(
      async () => {
        const st = await api(`${GRAPH}/${videoId}?fields=status`, { token });
        const s = st.data.status ?? {};
        if (s.video_status === "error" || s.processing_phase?.status === "error") throw new Error(s.processing_phase?.error?.message || "Facebook could not process the Reel");
        return s.video_status === "ready" || s.publishing_phase?.status === "complete" ? true : null;
      },
      10 * 60_000,
      "Facebook"
    );
    return `https://www.facebook.com/reel/${videoId}`;
  }
  if (p.imageUrl && localFile(p.imageUrl)) {
    const { data } = await api(`${GRAPH}/${pageId}/photos`, { method: "POST", token, ...form({ url: publicMediaUrl(p.imageUrl), caption: p.text }) });
    return data.post_id ? `https://www.facebook.com/${data.post_id}` : null;
  }
  const { data } = await api(`${GRAPH}/${pageId}/feed`, { method: "POST", token, ...form({ message: p.text }) });
  return data.id ? `https://www.facebook.com/${data.id}` : null;
}

async function postInstagram(orgId: number, p: Payload) {
  const { igId, token } = await metaPage(orgId);
  if (!igId) throw new NotConnected("No Instagram business account is linked to the chosen Page");
  let body: Record<string, string>;
  if (p.type === "reel") {
    needVideo(p);
    body = { media_type: "REELS", video_url: publicMediaUrl(p.videoUrl!), caption: p.text, share_to_feed: "true" };
    if (p.coverUrl && localFile(p.coverUrl)) body.cover_url = publicMediaUrl(await jpegUrl(p.coverUrl));
    else body.thumb_offset = String(p.coverMs || 0);
  } else {
    if (!p.imageUrl || !localFile(p.imageUrl)) throw new Error("Instagram posts need an image");
    body = { image_url: publicMediaUrl(await instagramImageUrl(p.imageUrl)), caption: p.text };
  }
  const c = await api(`${GRAPH}/${igId}/media`, { method: "POST", token, ...form(body) });
  // Meta fetches the file before the container can be published.
  await waitUntil(
    async () => {
      const st = await api(`${GRAPH}/${c.data.id}?fields=status_code,status`, { token }).catch(() => null);
      if (!st) return null;
      if (st.data.status_code === "ERROR" || st.data.status_code === "EXPIRED") throw new Error(`Instagram could not read the ${p.type === "reel" ? "video" : "image"}${st.data.status ? ` (${st.data.status})` : ""}`);
      return st.data.status_code === "FINISHED" ? true : null;
    },
    p.type === "reel" ? 5 * 60_000 : 60_000,
    "Instagram"
  );
  const { data } = await api(`${GRAPH}/${igId}/media_publish`, { method: "POST", token, ...form({ creation_id: c.data.id }) });
  const link = await api(`${GRAPH}/${data.id}?fields=permalink`, { token }).catch(() => null);
  return link?.data?.permalink ?? null;
}

// ---------- Threads ----------

async function postThreads(orgId: number, p: Payload) {
  const { token, conn } = await accessToken(orgId, "threads");
  const uid = JSON.parse(conn.settings || "{}").userId || "me";
  const body: Record<string, string> = { text: p.text };
  if (p.type === "reel") {
    needVideo(p);
    body.media_type = "VIDEO";
    body.video_url = publicMediaUrl(p.videoUrl!);
  } else if (p.imageUrl && localFile(p.imageUrl)) {
    body.media_type = "IMAGE";
    body.image_url = publicMediaUrl(await threadsImageUrl(p.imageUrl));
  } else body.media_type = "TEXT";
  const c = await api(`${THREADS}/${uid}/threads`, { method: "POST", token, ...form(body) });
  const id = String(c.data.id);
  await waitUntil(
    async () => {
      const st = await api(`${THREADS}/${id}?fields=status,error_message`, { token }).catch(() => null);
      if (!st) return null;
      if (st.data.status === "ERROR" || st.data.status === "EXPIRED") throw new Error(`Threads could not use the post${st.data.error_message ? ` (${st.data.error_message})` : ""}`);
      return st.data.status === "FINISHED" || st.data.status === "PUBLISHED" ? true : null;
    },
    p.type === "reel" ? 5 * 60_000 : 60_000,
    "Threads"
  );
  const { data } = await api(`${THREADS}/${uid}/threads_publish`, { method: "POST", token, ...form({ creation_id: id }) });
  const link = await api(`${THREADS}/${data.id}?fields=permalink`, { token }).catch(() => null);
  return link?.data?.permalink ?? null;
}

// ---------- TikTok ----------

export type TikTokCreator = {
  nickname: string;
  username: string | null;
  avatarUrl: string | null;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxSeconds: number;
};

async function tiktokCreatorWith(token: string): Promise<TikTokCreator> {
  const { data } = await api(`${TIKTOK}/post/publish/creator_info/query/`, { method: "POST", token, headers: { "content-type": "application/json; charset=UTF-8" }, body: "{}" });
  if (data.error?.code && data.error.code !== "ok") throw new Error(data.error.message || data.error.code);
  const d = data.data ?? {};
  return {
    nickname: String(d.creator_nickname ?? ""),
    username: d.creator_username ? String(d.creator_username) : null,
    avatarUrl: d.creator_avatar_url ?? null,
    privacyOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options.map(String) : [],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxSeconds: Number(d.max_video_post_duration_sec) || 600,
  };
}

/** What TikTok says this account can post right now (asked fresh each time, as TikTok requires). */
export async function tiktokCreator(orgId: number) {
  const { token } = await accessToken(orgId, "tiktok");
  return tiktokCreatorWith(token);
}

const MB = 1024 * 1024;

/** TikTok chunks: 5 to 64 MB each; the last one takes the remainder. */
export function tiktokChunks(size: number) {
  if (size <= 5 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.max(1, Math.floor(size / chunkSize)) };
}

async function postTikTok(orgId: number, p: Payload) {
  if (p.type !== "reel") throw new Error("TikTok takes videos only");
  const file = needVideo(p);
  const { token, conn } = await accessToken(orgId, "tiktok");
  const creator = await tiktokCreatorWith(token);
  const t = p.tiktok;
  if (!t.privacy) throw new Error("Choose who can view the TikTok video");
  if (creator.privacyOptions.length && !creator.privacyOptions.includes(t.privacy)) throw new Error("That TikTok viewing choice is not open to this account. Choose another");
  if (p.videoMeta?.seconds && p.videoMeta.seconds > creator.maxSeconds) throw new Error(`This TikTok account can post videos up to ${Math.floor(creator.maxSeconds / 60)} minutes`);
  const size = fs.statSync(file).size;
  const { chunkSize, count } = tiktokChunks(size);
  const json = { "content-type": "application/json; charset=UTF-8" };
  const init = await api(`${TIKTOK}/post/publish/video/init/`, {
    method: "POST",
    token,
    headers: json,
    body: JSON.stringify({
      post_info: {
        title: p.text,
        privacy_level: t.privacy,
        disable_comment: !t.allowComment || creator.commentDisabled,
        disable_duet: !t.allowDuet || creator.duetDisabled,
        disable_stitch: !t.allowStitch || creator.stitchDisabled,
        video_cover_timestamp_ms: p.coverMs || 0,
        brand_content_toggle: t.disclose && t.brandedContent,
        brand_organic_toggle: t.disclose && t.yourBrand,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count },
    }),
  });
  if (init.data.error?.code && init.data.error.code !== "ok") throw new Error(init.data.error.message || init.data.error.code);
  const publishId = String(init.data.data.publish_id);
  const uploadUrl = String(init.data.data.upload_url);
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    const chunk = await readRange(file, start, end - start + 1);
    const up = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": videoMime(file), "content-length": String(chunk.length), "content-range": `bytes ${start}-${end}/${size}` }, body: chunk, signal: AbortSignal.timeout(300_000) });
    if (!up.ok) throw new Error(`TikTok video upload ${up.status}`);
  }
  const done = await waitUntil(
    async () => {
      const st = await api(`${TIKTOK}/post/publish/status/fetch/`, { method: "POST", token, headers: json, body: JSON.stringify({ publish_id: publishId }) });
      const d = st.data.data ?? {};
      if (d.status === "FAILED") throw new Error(`TikTok could not post the video${d.fail_reason ? ` (${d.fail_reason})` : ""}`);
      return d.status === "PUBLISH_COMPLETE" || d.status === "SEND_TO_USER_INBOX" ? d : null;
    },
    10 * 60_000,
    "TikTok"
  );
  // TikTok spells this field "publicaly".
  const postId = (done.publicaly_available_post_id ?? [])[0];
  const user = JSON.parse(conn.settings || "{}").username || creator.username;
  return postId && user ? `https://www.tiktok.com/@${user}/video/${postId}` : null;
}

// ---------- X ----------

async function postX(orgId: number, p: Payload) {
  const { token, conn } = await accessToken(orgId, "x");
  let media: { media_ids: string[] } | undefined;
  if (p.type === "reel") {
    const file = needVideo(p);
    const size = fs.statSync(file).size;
    const init = await api("https://api.x.com/2/media/upload/initialize", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ media_category: "tweet_video", media_type: videoMime(file), total_bytes: size }) });
    const id = String(init.data.data.id);
    const SEG = 4 * MB;
    for (let i = 0, off = 0; off < size; i++, off += SEG) {
      const chunk = await readRange(file, off, Math.min(SEG, size - off));
      const f = new FormData();
      f.append("media", new Blob([chunk]), path.basename(file));
      f.append("segment_index", String(i));
      await api(`https://api.x.com/2/media/upload/${id}/append`, { method: "POST", token, body: f });
    }
    const fin = await api(`https://api.x.com/2/media/upload/${id}/finalize`, { method: "POST", token });
    if (fin.data.data?.processing_info) {
      await waitUntil(
        async () => {
          const st = await api(`https://api.x.com/2/media/upload?media_id=${id}&command=STATUS`, { token });
          const info = st.data.data?.processing_info ?? {};
          if (info.state === "failed") throw new Error(`X could not process the video${info.error?.message ? ` (${info.error.message})` : ""}`);
          return !info.state || info.state === "succeeded" ? true : null;
        },
        10 * 60_000,
        "X"
      );
    }
    media = { media_ids: [id] };
  } else {
    const file = localFile(p.imageUrl);
    if (file) {
      const f = new FormData();
      f.append("media", new Blob([fs.readFileSync(file)]), path.basename(file));
      f.append("media_category", "tweet_image");
      const up = await api("https://api.x.com/2/media/upload", { method: "POST", token, body: f });
      if (up.data?.data?.id) media = { media_ids: [String(up.data.data.id)] };
    }
  }
  const { data } = await api("https://api.x.com/2/tweets", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: p.text, ...(media ? { media } : {}) }) });
  const user = JSON.parse(conn.settings || "{}").username;
  return data.data?.id ? `https://x.com/${user || "i"}/status/${data.data.id}` : null;
}

// ---------- Google Business Profile ----------

async function postBusiness(orgId: number, p: Payload) {
  if (p.type === "reel") throw new Error("Google Business Profile takes photos, not videos");
  const { token, conn } = await accessToken(orgId, "google_business");
  const s = JSON.parse(conn.settings || "{}");
  if (!s.account || !s.location) throw new Error(s.setupNote ? `Business Profile access is not ready: ${s.setupNote}` : "No Business Profile location was found");
  const locId = String(s.location).split("/").pop();
  const body: Record<string, unknown> = { languageCode: "en-US", summary: p.text, topicType: "STANDARD" };
  if (p.imageUrl && localFile(p.imageUrl)) body.media = [{ mediaFormat: "PHOTO", sourceUrl: publicMediaUrl(p.imageUrl) }];
  const { data } = await api(`https://mybusiness.googleapis.com/v4/${s.account}/locations/${locId}/localPosts`, { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return data.searchUrl ?? null;
}

// ---------- Facebook Page history (for Suggest time) ----------

/** The Page's recent posts with their time and engagement. Empty when Facebook is not connected. */
export async function facebookHistory(orgId: number): Promise<{ at: Date; score: number }[]> {
  try {
    const { pageId, token } = await metaPage(orgId);
    const { data } = await api(`${GRAPH}/${pageId}/published_posts?fields=created_time,reactions.summary(true).limit(0),comments.summary(true).limit(0),shares&limit=100`, { token });
    return (data.data ?? []).map((x: any) => ({
      at: new Date(x.created_time),
      score: Number(x.reactions?.summary?.total_count ?? 0) + 2 * Number(x.comments?.summary?.total_count ?? 0) + 3 * Number(x.shares?.count ?? 0),
    })).filter((x: { at: Date }) => !Number.isNaN(x.at.getTime()));
  } catch {
    return [];
  }
}

function encodeHeader(v: string) {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** Sends a plain-text email from the connected Gmail account. */
export async function sendGmail(orgId: number, to: string, subject: string, body: string, fromKind?: string | null) {
  const token = (await sendToken(orgId, fromKind)) ?? (await accessToken(orgId, "google_workspace")).token;
  const raw = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");
  const { data } = await api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }) });
  return data.id ? `https://mail.google.com/mail/u/0/#sent/${data.threadId ?? data.id}` : null;
}

/** Sends an email with files attached (a bid or application response) from the connected Gmail account. */
export async function sendGmailWithFiles(orgId: number, to: string, subject: string, body: string, files: { name: string; buf: Buffer; mime: string }[]) {
  const { token } = await accessToken(orgId, "google_workspace");
  const boundary = `ld_${Date.now().toString(36)}`;
  const parts = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ];
  for (const f of files) {
    const name = f.name.replace(/["\r\n]/g, "");
    parts.push(`--${boundary}`, `Content-Type: ${f.mime}; name="${encodeHeader(name)}"`, `Content-Disposition: attachment; filename="${encodeHeader(name)}"`, "Content-Transfer-Encoding: base64", "", f.buf.toString("base64").replace(/.{76}/g, "$&\r\n"));
  }
  parts.push(`--${boundary}--`, "");
  const raw = parts.join("\r\n");
  const { data } = await api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw, "utf8").toString("base64url") }) });
  return data.id ? `https://mail.google.com/mail/u/0/#sent/${data.threadId ?? data.id}` : null;
}

/** The token of the sending address set up for this employee's job, if there is one. */
async function sendToken(orgId: number, kind?: string | null) {
  if (!kind) return null;
  const link = db.listAccountLinks(orgId, "send").find((l) => parseList(l.sendsFor).includes(kind));
  return link ? linkToken(link) : null;
}
function parseList(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function emailIn(s: string | undefined | null) {
  return (s ?? "").match(/[^\s<>"',;]+@[^\s<>"',;]+\.[a-z]{2,}/i)?.[0] ?? null;
}

async function addToCalendar(orgId: number, item: OutboundItem) {
  const meta = JSON.parse(item.metadata || "{}");
  const { holdTarget } = await import("./employees/calendars");
  const target = await holdTarget(orgId, meta.linkId ?? null);
  const token = target ? target.token : (await accessToken(orgId, "google_workspace")).token;
  const calendarId = target ? target.calendarId : "primary";
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const start = toLocalDateTime(meta.date, meta.time);
  if (!start) throw new Error("The hold has no date and time Google can read. Edit it with a date like 10/05/2026 and a time like 2:00 PM.");
  const end = new Date(new Date(`${start}Z`).getTime() + 60 * 60_000).toISOString().slice(0, 19);
  const attendees = (meta.attendees ?? []).map((a: string) => emailIn(a)).filter(Boolean).map((email: string) => ({ email }));
  // A hold with guests is a call: it gets a video link (Zoom when that's the workspace's meeting link and Zoom is connected, else Google Meet) and the invites go out.
  const call = attendees.length > 0;
  const video = call ? await holdVideo(orgId, item.title, start, tz, item.body ?? "", meta.video === "zoom") : null;
  const description = video?.zoomUrl ? `Join on Zoom: ${video.zoomUrl}\n\n${item.body ?? ""}` : item.body ?? "";
  const { data } = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${call ? "all&conferenceDataVersion=1" : "none"}`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: item.title, description, start: { dateTime: start, timeZone: tz }, end: { dateTime: end, timeZone: tz }, attendees, ...(video?.zoomUrl ? { location: video.zoomUrl } : video ? { conferenceData: { createRequest: { requestId: crypto.randomBytes(10).toString("hex"), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}) }),
  });
  // Remember the event and its link, so Avery can give the link or move it to Zoom later.
  const link = video?.zoomUrl ? { platform: "zoom" as const, url: video.zoomUrl } : meetingLinkOf(data);
  await db.updateOutboundItem(item.id, orgId, { metadata: JSON.stringify({ ...meta, eventId: data.id ?? null, calendarId, meeting: link }) });
  return data.htmlLink ?? null;
}

/** A hold that went on the calendar before its event was remembered: find it there by its time and title. */
async function findBookedEvent(orgId: number, item: OutboundItem, meta: any) {
  const start = toLocalDateTime(meta.date, meta.time);
  if (!start) return null;
  const { holdTarget } = await import("./employees/calendars");
  const target = await holdTarget(orgId, meta.linkId ?? null).catch(() => null);
  const token = target ? target.token : (await accessToken(orgId, "google_workspace")).token;
  const calendarId = target ? target.calendarId : "primary";
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const { zonedToUtc } = await import("./employees/schedule");
  const [Y, M, D] = start.slice(0, 10).split("-").map(Number);
  const [h, mi] = start.slice(11, 16).split(":").map(Number);
  const at = zonedToUtc(Y, M, D, h, mi, tz);
  const q = new URLSearchParams({ timeMin: new Date(at.getTime() - 60_000).toISOString(), timeMax: new Date(at.getTime() + 60 * 60_000).toISOString(), singleEvents: "true", maxResults: "20" });
  const { data } = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { token });
  const ev = (data.items ?? []).find((e: any) => e.summary === item.title && e.status !== "cancelled");
  if (!ev?.id) return null;
  const found = { eventId: String(ev.id), calendarId, meeting: meetingLinkOf(ev) };
  await db.updateOutboundItem(item.id, orgId, { metadata: JSON.stringify({ ...meta, ...found }) });
  return found;
}

/** A meeting Avery booked: its Zoom or Meet link, or (want "zoom") the meeting moved to Zoom, with updated invites. */
export async function meetingOnHold(orgId: number, item: OutboundItem, want: "zoom" | "any"): Promise<{ text: string; url: string | null }> {
  let meta = JSON.parse(item.metadata || "{}");
  if (!meta.eventId && item.status === "published") meta = { ...meta, ...((await findBookedEvent(orgId, item, meta)) ?? {}) };
  const zoomOn = (await db.getConnectionByProvider(orgId, "zoom"))?.status === "connected";
  const noZoom = "Zoom isn't connected yet, so I can't make a Zoom link. Connect it on Integrations and ask me again.";
  if (!meta.eventId) {
    // Not on the calendar yet: it waits for approval.
    if (want === "zoom") {
      await db.updateOutboundItem(item.id, orgId, { metadata: JSON.stringify({ ...meta, video: "zoom" }) });
      if (!zoomOn) return { text: `I set "${item.title}" to use Zoom. ${noZoom}`, url: null };
      return { text: `"${item.title}" will be on Zoom. The Zoom link is made and sent to the guests the moment you approve it in Approvals.`, url: null };
    }
    return { text: `"${item.title}" isn't on the calendar yet, so it doesn't have a link. It gets one when you approve it in Approvals.`, url: null };
  }
  const have = meta.meeting as { platform: MeetingPlatform; url: string } | null;
  if (have && (want === "any" || have.platform === "zoom")) return { text: `Here's the ${PLATFORM_NAMES[have.platform]} link for "${item.title}": ${have.url}`, url: have.url };
  if (!zoomOn) return { text: have ? `"${item.title}" is on Google Meet: ${have.url}

${noZoom}` : `"${item.title}" doesn't have a meeting link. ${noZoom}`, url: have?.url ?? null };
  const { holdTarget } = await import("./employees/calendars");
  const target = await holdTarget(orgId, meta.linkId ?? null);
  const token = target ? target.token : (await accessToken(orgId, "google_workspace")).token;
  const calendarId = meta.calendarId || (target ? target.calendarId : "primary");
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const start = toLocalDateTime(meta.date, meta.time);
  if (!start) return { text: `I couldn't read the time on "${item.title}".`, url: null };
  const { zonedToUtc } = await import("./employees/schedule");
  const [Y, M, D] = start.slice(0, 10).split("-").map(Number);
  const [h, mi] = start.slice(11, 16).split(":").map(Number);
  const z = await createZoomMeeting(orgId, { topic: item.title, start: zonedToUtc(Y, M, D, h, mi, tz), minutes: 60, tz, agenda: item.body ?? "" });
  // Zoom replaces Meet on the event, and the guests get the updated invite.
  await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(meta.eventId)}?sendUpdates=all&conferenceDataVersion=1`, {
    method: "PATCH",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: z.joinUrl, description: `Join on Zoom: ${z.joinUrl}\n\n${item.body ?? ""}`, conferenceData: null }),
  });
  await db.updateOutboundItem(item.id, orgId, { metadata: JSON.stringify({ ...meta, video: "zoom", meeting: { platform: "zoom", url: z.joinUrl }, zoomMeetingId: z.id }) });
  return { text: `"${item.title}" is on Zoom now, and the guests got the updated invite. Here's the link: ${z.joinUrl}`, url: z.joinUrl };
}

/** The video link for a call Avery books: a Zoom meeting when Zoom is the workspace's meeting link and connected, else Google Meet. */
export async function holdVideo(orgId: number, title: string, localStart: string, tz: string, agenda: string, wantZoom = false): Promise<{ zoomUrl: string | null }> {
  const { opsFor } = await import("./employees/ops");
  const { ops } = await opsFor(orgId);
  const zoomOn = (await db.getConnectionByProvider(orgId, "zoom"))?.status === "connected";
  if ((ops.meetingLink !== "zoom" && !wantZoom) || !zoomOn) return { zoomUrl: null };
  const { zonedToUtc } = await import("./employees/schedule");
  const [Y, M, D] = localStart.slice(0, 10).split("-").map(Number);
  const [h, mi] = localStart.slice(11, 16).split(":").map(Number);
  const z = await createZoomMeeting(orgId, { topic: title, start: zonedToUtc(Y, M, D, h, mi, tz), minutes: 60, tz, agenda });
  return { zoomUrl: z.joinUrl };
}

/** Busy times on the connected Google Calendar (primary), for offering open times. All-day events block the whole day. */
export async function calendarBusy(orgId: number, from: Date, to: Date) {
  const { token } = await accessToken(orgId, "google_workspace");
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const { data } = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { token });
  const out: { start: Date; end: Date }[] = [];
  for (const e of data.items ?? []) {
    if (e.status === "cancelled" || e.transparency === "transparent") continue;
    const start = e.start?.dateTime ? new Date(e.start.dateTime) : e.start?.date ? new Date(`${e.start.date}T00:00:00Z`) : null;
    const end = e.end?.dateTime ? new Date(e.end.dateTime) : e.end?.date ? new Date(`${e.end.date}T00:00:00Z`) : null;
    if (start && end) out.push({ start: e.start?.date ? new Date(start.getTime() - 14 * 3600_000) : start, end: e.end?.date ? new Date(end.getTime() + 14 * 3600_000) : end });
  }
  return out;
}

/** Puts a booked meeting on the connected Google Calendar and sends the invite to the guest. */
export async function bookCalendarEvent(orgId: number, ev: { summary: string; description: string; start: Date; end: Date; attendeeEmail: string; tz: string }) {
  const { token } = await accessToken(orgId, "google_workspace");
  const { data } = await api("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: ev.summary, description: ev.description, start: { dateTime: ev.start.toISOString(), timeZone: ev.tz }, end: { dateTime: ev.end.toISOString(), timeZone: ev.tz }, attendees: [{ email: ev.attendeeEmail }] }),
  });
  return (data.htmlLink as string | undefined) ?? null;
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

const SOCIAL: Record<SocialChannel, (orgId: number, p: Payload) => Promise<string | null>> = {
  linkedin: postLinkedIn,
  facebook: postFacebook,
  instagram: postInstagram,
  threads: postThreads,
  tiktok: postTikTok,
  x: postX,
  google_business: postBusiness,
};

/** Channels an item goes to, by name (linkedin, facebook, gmail, calendar...). */
export function channelsFor(item: OutboundItem): string[] {
  if (item.kind === "social_post") return postChannels(item);
  if (item.kind === "calendar_hold") return ["calendar"];
  if (item.kind === "email_draft" || item.kind === "hiring_email" || item.kind === "speaking_pitch" || item.kind === "outreach_email" || item.kind === "lead_reply") return ["gmail"];
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
        const emp = item.employeeId ? await db.getEmployeeForOrg(item.employeeId, item.organizationId) : null;
        const kind = emp?.kind ?? (item.kind === "outreach_email" ? "outreach" : item.kind === "lead_reply" ? "leads" : null);
        url = await sendGmail(item.organizationId, to, subject, item.body ?? "", kind);
      } else if (ch === "calendar") url = await addToCalendar(item.organizationId, item);
      else url = await SOCIAL[ch as SocialChannel](item.organizationId, payloadFor(item, ch as SocialChannel));
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


// ==========================================
// Meetings (Simone): calendar invites with Google Meet or Zoom links
// ==========================================

/** A one-hour-or-less Zoom meeting on the connected Zoom account. */
export async function createZoomMeeting(orgId: number, m: { topic: string; start: Date; minutes: number; tz: string; agenda: string }) {
  const { token } = await accessToken(orgId, "zoom");
  const { data } = await api("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: m.topic.slice(0, 200), type: 2, start_time: m.start.toISOString().replace(/\.\d{3}Z$/, "Z"), duration: m.minutes, timezone: m.tz, agenda: m.agenda.slice(0, 2000), settings: { join_before_host: true, waiting_room: false } }),
  });
  return { id: String(data.id), joinUrl: String(data.join_url) };
}

/** The host's start link for a meeting on the connected Zoom account, or null when Zoom doesn't give one. It lasts about two hours. */
export async function zoomStartUrl(orgId: number, meetingId: string) {
  const { token } = await accessToken(orgId, "zoom");
  const { data } = await api(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`, { token });
  return typeof data.start_url === "string" && /^https:\/\/([\w-]+\.)?zoom\.us\//.test(data.start_url) ? (data.start_url as string) : null;
}

/** The meeting's transcript text from Zoom cloud recording, or null when there is none yet. */
export async function zoomTranscript(orgId: number, meetingId: string) {
  const { token } = await accessToken(orgId, "zoom");
  try {
    const { data } = await api(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/recordings`, { token });
    const file = (data.recording_files ?? []).find((f: any) => f.file_type === "TRANSCRIPT" && f.download_url);
    if (!file) return null;
    const r = await fetch(file.download_url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) return null;
    const vtt = await r.text();
    return vtt.replace(/^WEBVTT.*$/m, "").replace(/^\d+\s*$/gm, "").replace(/^\d{2}:\d{2}:\d{2}\.\d{3} --> .*$/gm, "").replace(/\n{2,}/g, "\n").trim().slice(0, 60_000);
  } catch {
    return null;
  }
}

/**
 * Puts a meeting on the connected Google Calendar and emails the invite to every attendee.
 * With linkKind "meet" Google adds a Meet link; with "zoom" the Zoom link goes in the event.
 */
export async function inviteMeeting(orgId: number, m: { eventId?: string | null; summary: string; description: string; start: Date; minutes: number; tz: string; attendees: string[]; zoomUrl?: string | null }) {
  const { token } = await accessToken(orgId, "google_workspace");
  const end = new Date(m.start.getTime() + m.minutes * 60_000);
  const body: Record<string, unknown> = {
    summary: m.summary,
    description: m.zoomUrl ? `Join on Zoom: ${m.zoomUrl}\n\n${m.description}` : m.description,
    start: { dateTime: m.start.toISOString(), timeZone: m.tz },
    end: { dateTime: end.toISOString(), timeZone: m.tz },
    attendees: m.attendees.filter((a) => emailIn(a)).map((email) => ({ email: emailIn(email)! })),
    ...(m.zoomUrl ? { location: m.zoomUrl } : { conferenceData: { createRequest: { requestId: crypto.randomBytes(10).toString("hex"), conferenceSolutionKey: { type: "hangoutsMeet" } } } }),
  };
  const url = m.eventId
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(m.eventId)}?sendUpdates=all&conferenceDataVersion=1`
    : "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1";
  const { data } = await api(url, { method: m.eventId ? "PATCH" : "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const meet = (data.conferenceData?.entryPoints ?? []).find((e: any) => e.entryPointType === "video")?.uri ?? data.hangoutLink ?? null;
  return { eventId: String(data.id), eventUrl: (data.htmlLink as string | undefined) ?? null, link: m.zoomUrl ?? meet };
}

export async function cancelCalendarEvent(orgId: number, eventId: string) {
  const { token } = await accessToken(orgId, "google_workspace");
  await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE", token }).catch(() => null);
}

// ==========================================
// ClickUp (Nora): a list for each launch, tasks kept in sync
// ==========================================

export async function clickupSettings(orgId: number) {
  const conn = await db.getConnectionByProvider(orgId, "clickup");
  if (!conn || conn.status !== "connected") return null;
  try {
    return JSON.parse(conn.settings || "{}") as { teamId: string; teamName: string | null; userId: number | null; userEmail: string | null; spaces: { id: string; name: string }[]; spaceId: string | null; spaceName: string | null };
  } catch {
    return null;
  }
}

export async function clickup(orgId: number, pathName: string, init: { method?: string; body?: unknown } = {}) {
  const { token } = await accessToken(orgId, "clickup");
  const { data } = await api(`${CLICKUP}${pathName}`, { method: init.method ?? "GET", token, headers: init.body ? { "content-type": "application/json" } : {}, body: init.body ? JSON.stringify(init.body) : undefined });
  return data;
}

/** Refreshes the Space list and saves the chosen Space. */
export async function chooseClickupSpace(orgId: number, spaceId?: string) {
  const conn = await db.getConnectionByProvider(orgId, "clickup");
  const cur = await clickupSettings(orgId);
  if (!conn || !cur) throw new Error("ClickUp is not connected");
  const spaces = await clickup(orgId, `/team/${cur.teamId}/space?archived=false`);
  const list = (spaces.spaces ?? []).map((sp: any) => ({ id: String(sp.id), name: String(sp.name) }));
  const pick = list.find((x: { id: string }) => x.id === (spaceId ?? cur.spaceId)) ?? list[0] ?? null;
  const next = { ...cur, spaces: list, spaceId: pick?.id ?? null, spaceName: pick?.name ?? null };
  await db.upsertExternalConnection({ ...conn, settings: JSON.stringify(next), accountLabel: conn.accountLabel, lastCheckedAt: new Date() });
  return next;
}

/** ClickUp members by email, for assigning tasks to people. */
export async function clickupMembers(orgId: number) {
  const cur = await clickupSettings(orgId);
  if (!cur) return [] as { id: number; email: string; name: string }[];
  const data = await clickup(orgId, "/team");
  const team = (data.teams ?? []).find((t: any) => String(t.id) === cur.teamId) ?? data.teams?.[0];
  return (team?.members ?? []).map((m: any) => ({ id: Number(m.user?.id), email: String(m.user?.email ?? "").toLowerCase(), name: String(m.user?.username ?? "") }));
}

// ==========================================
// Google Calendar: meetings with a Zoom or Google Meet link
// ==========================================

export type MeetingPlatform = "zoom" | "meet" | "teams";
export const PLATFORM_NAMES: Record<MeetingPlatform, string> = { zoom: "Zoom", meet: "Google Meet", teams: "Teams" };

export type CalendarMeeting = {
  eventId: string;
  title: string;
  start: Date;
  end: Date;
  platform: MeetingPlatform;
  url: string;
  /** The owner is the organizer: they set the meeting up. */
  host: boolean;
  /** Title, description and place, for the never-join words. */
  text: string;
  attendees: { name: string; email: string }[];
  declined: boolean;
};

const MEET_RE = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
const ZOOM_RE = /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w)\/[^\s"'<>)]+/i;
const TEAMS_RE = /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/|teams\.live\.com\/meet\/|teams\.microsoft\.com\/meet\/)[^\s"'<>)]+/i;

/** The meeting link on a calendar event: Zoom, Google Meet or Microsoft Teams. Other links are ignored. */
export function meetingLinkOf(e: any): { platform: MeetingPlatform; url: string } | null {
  const video = (e?.conferenceData?.entryPoints ?? []).filter((p: any) => p?.entryPointType === "video" && typeof p.uri === "string").map((p: any) => p.uri as string);
  const pool = [typeof e?.hangoutLink === "string" ? e.hangoutLink : "", ...video, String(e?.location ?? ""), String(e?.description ?? "")].join(" \n ");
  const zoom = pool.match(ZOOM_RE);
  const meet = pool.match(MEET_RE);
  const teams = pool.match(TEAMS_RE);
  // A Meet link Google adds itself wins over a Zoom link pasted in the notes, and the other way round.
  if (typeof e?.hangoutLink === "string" && meet) return { platform: "meet", url: meet[0] };
  if (zoom) return { platform: "zoom", url: zoom[0].replace(/[.,;]+$/, "") };
  if (meet) return { platform: "meet", url: meet[0] };
  if (teams) return { platform: "teams", url: teams[0].replace(/[.,;]+$/, "") };
  return null;
}

/** One Google Calendar event as a meeting Avery can sit in on, or null when it has no Zoom or Google Meet link. */
export function calendarMeetingOf(e: any): CalendarMeeting | null {
  if (!e || e.status === "cancelled" || !e.start?.dateTime || !e.end?.dateTime || !e.id) return null;
  const link = meetingLinkOf(e);
  if (!link) return null;
  const people = (e.attendees ?? []).filter((a: any) => a?.email && !a.resource);
  return {
    eventId: String(e.id),
    title: String(e.summary || "Untitled meeting").slice(0, 200),
    start: new Date(e.start.dateTime),
    end: new Date(e.end.dateTime),
    platform: link.platform,
    url: link.url,
    host: Boolean(e.organizer?.self),
    text: [e.summary, e.description, e.location].filter(Boolean).join(" \n ").slice(0, 8000),
    attendees: people.slice(0, 40).map((a: any) => ({ name: String(a.displayName || a.email).slice(0, 120), email: String(a.email).slice(0, 200) })),
    declined: people.some((a: any) => a.self && a.responseStatus === "declined"),
  };
}

/** Timed events on one Google calendar between two times that have a Zoom or Google Meet link. */
export async function calendarMeetingsOn(token: string, calendarId: string, from: Date, to: Date): Promise<CalendarMeeting[]> {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const { data } = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { token });
  const out: CalendarMeeting[] = [];
  for (const e of data.items ?? []) {
    const m = calendarMeetingOf(e);
    if (m) out.push(m);
  }
  return out;
}

/** The main Google connection's primary calendar. Avery reads every calendar through calendars.notetakerMeetings. */
export async function calendarMeetings(orgId: number, from: Date, to: Date): Promise<CalendarMeeting[]> {
  const { token } = await accessToken(orgId, "google_workspace");
  return calendarMeetingsOn(token, "primary", from, to);
}

// ==========================================
// Recall.ai: the bot that sits in on meetings for Simone
// ==========================================

const recallBase = () => `https://${process.env.RECALL_REGION || "us-west-2"}.recall.ai/api/v1`;

async function recallFetch(key: string, pathName: string, init: { method?: string; body?: unknown } = {}) {
  const go = (auth: string) =>
    fetch(`${recallBase()}/${pathName.replace(/^\//, "")}`, {
      method: init.method ?? "GET",
      headers: { authorization: auth, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  let res = await go(key);
  // Older Recall keys expect the "Token " prefix.
  if (res.status === 401 && !key.startsWith("Token ")) res = await go(`Token ${key}`);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`Recall.ai ${providerError(data, res.status)}`);
  return data;
}

/**
 * Meeting notes run on LeadDash's own Recall.ai account (RECALL_API_KEY) for every
 * workspace; the minutes are rebilled as usage. A workspace is never asked for a key.
 * A key a workspace saved before this stays usable as a fallback.
 */
const serverRecallKey = () => (process.env.RECALL_API_KEY || "").trim();

async function legacyRecallKey(orgId: number) {
  const conn = await db.getConnectionByProvider(orgId, "recall");
  if (!conn || conn.status !== "connected") return "";
  try {
    return decryptJson<{ apiKey?: string }>(conn.secretsEncrypted)?.apiKey ?? "";
  } catch {
    return "";
  }
}

async function recallKey(orgId: number) {
  const key = serverRecallKey() || (await legacyRecallKey(orgId));
  if (!key) throw new NotConnected("Meeting notes aren't set up on this server yet (RECALL_API_KEY).");
  return key;
}

/** Whether Avery can sit in on meetings in this workspace: the server has a Recall.ai key. */
export async function recallConnected(orgId: number) {
  return !!serverRecallKey() || !!(await legacyRecallKey(orgId));
}

/**
 * Books a bot for a meeting. With joinAt more than 10 minutes away Recall reserves it and it
 * joins on time; without joinAt it joins now. It posts the note in the meeting chat when it joins.
 */
export async function createRecallBot(orgId: number, b: { meetingUrl: string; joinAt: Date | null; botName: string; message: string; imageB64?: string | null }) {
  const key = await recallKey(orgId);
  // The portrait shows as the bot's camera the whole time it is in the meeting (a 1280x720 JPEG under 1.3MB, per Recall.ai).
  const image = b.imageB64 ? { kind: "jpeg", b64_data: b.imageB64 } : null;
  const data = await recallFetch(key, "bot/", {
    method: "POST",
    body: {
      meeting_url: b.meetingUrl,
      bot_name: b.botName.slice(0, 100),
      ...(b.joinAt ? { join_at: b.joinAt.toISOString() } : {}),
      chat: { on_bot_join: { send_to: "everyone", message: b.message.slice(0, 480) } },
      ...(image ? { automatic_video_output: { in_call_recording: image, in_call_not_recording: image } } : {}),
    },
  });
  return String(data.id);
}

/**
 * The talking team: a bot that joins now, shows the huddle page as its camera (so the
 * meeting hears the employees' voices), and sends each finished line people say to
 * our webhook as it happens.
 */
export async function createRecallTeamBot(orgId: number, b: { meetingUrl: string; botName: string; pageUrl: string; webhookUrl: string; message: string }) {
  const key = await recallKey(orgId);
  const data = await recallFetch(key, "bot/", {
    method: "POST",
    body: {
      meeting_url: b.meetingUrl,
      bot_name: b.botName.slice(0, 100),
      output_media: { camera: { kind: "webpage", config: { url: b.pageUrl } } },
      variant: { zoom: "web_4_core", google_meet: "web_4_core", microsoft_teams: "web_4_core" },
      recording_config: {
        transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } } },
        realtime_endpoints: [{ type: "webhook", url: b.webhookUrl, events: ["transcript.data"] }],
      },
      chat: { on_bot_join: { send_to: "everyone", message: b.message.slice(0, 480) } },
    },
  });
  return String(data.id);
}

/** Cancels a booked bot, or takes it out of a meeting it is already in. */
export async function removeRecallBot(orgId: number, botId: string) {
  const key = await recallKey(orgId);
  try {
    await recallFetch(key, `bot/${encodeURIComponent(botId)}/`, { method: "DELETE" });
  } catch {
    await recallFetch(key, `bot/${encodeURIComponent(botId)}/leave_call/`, { method: "POST", body: {} }).catch(() => null);
  }
}

export type RecallBotState = { code: string; subCode: string | null; recordingId: string | null; recordingDone: boolean };

/** Where the bot is: its latest status code and its recording, if it has one. */
export async function recallBotState(orgId: number, botId: string): Promise<RecallBotState> {
  const key = await recallKey(orgId);
  const data = await recallFetch(key, `bot/${encodeURIComponent(botId)}/`);
  const changes = Array.isArray(data.status_changes) ? data.status_changes : [];
  const last = changes[changes.length - 1] ?? {};
  const rec = Array.isArray(data.recordings) ? data.recordings[0] : null;
  return {
    code: String(last.code ?? "ready"),
    subCode: last.sub_code ? String(last.sub_code) : null,
    recordingId: rec?.id ? String(rec.id) : null,
    recordingDone: rec?.status?.code === "done",
  };
}

/** Starts the transcript of a finished recording. Returns the transcript id. */
export async function recallStartTranscript(orgId: number, recordingId: string) {
  const key = await recallKey(orgId);
  const data = await recallFetch(key, `recording/${encodeURIComponent(recordingId)}/create_transcript/`, {
    method: "POST",
    body: { provider: { recallai_async: { language_code: "en" } }, diarization: { use_separate_streams_when_available: true } },
  });
  return String(data.id);
}

/** The finished transcript as "Name: what they said" lines and its length, or the state while it is not ready. */
export async function recallTranscript(orgId: number, transcriptId: string): Promise<{ state: "working" | "failed" } | { state: "done"; text: string; minutes: number }> {
  const key = await recallKey(orgId);
  const data = await recallFetch(key, `transcript/${encodeURIComponent(transcriptId)}/`);
  const code = String(data?.status?.code ?? "");
  if (code === "failed") return { state: "failed" };
  if (code !== "done" || !data?.data?.download_url) return { state: "working" };
  const r = await fetch(data.data.download_url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) return { state: "working" };
  const parts = (await r.json()) as { participant?: { name?: string | null }; words?: { text: string; end_timestamp?: { relative?: number } }[] }[];
  let last = 0;
  const lines: string[] = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    const words = p.words ?? [];
    if (!words.length) continue;
    last = Math.max(last, words[words.length - 1]?.end_timestamp?.relative ?? 0);
    const said = words.map((w) => w.text).join(" ").replace(/\s+([.,?!])/g, "$1").trim();
    const who = p.participant?.name?.trim() || "Someone";
    if (lines.length && lines[lines.length - 1].startsWith(`${who}: `)) lines[lines.length - 1] += ` ${said}`;
    else lines.push(`${who}: ${said}`);
  }
  return { state: "done", text: lines.join("\n").slice(0, 120_000), minutes: Math.max(1, Math.round(last / 60)) };
}

/** Deletes the recording, transcript and other media Recall holds for a bot. */
export async function recallDeleteMedia(orgId: number, botId: string) {
  const key = await recallKey(orgId);
  await recallFetch(key, `bot/${encodeURIComponent(botId)}/delete_media/`, { method: "POST", body: {} });
}
