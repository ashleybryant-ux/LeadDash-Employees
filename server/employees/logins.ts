import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { decryptJson, encryptJson } from "../_core/crypto";
import type { PortalLogin } from "../../drizzle/schema";

/**
 * Website logins: saved sign-ins every employee can use in their browser.
 *
 * A login can be locked to one sub-account (the LeadDash platform holds
 * other businesses' sub-accounts, some with client records). A locked login
 * only ever opens pages inside that sub-account: every other sub-account and
 * the agency-level pages are refused, whatever the AI tries.
 */

/** The sub-account id in a pasted address (".../location/AbC123.../...") or a bare id. */
export function parseLockId(input: string | null | undefined) {
  const s = (input ?? "").trim();
  if (!s) return null;
  const m = s.match(/\/location\/([A-Za-z0-9]{8,64})/) || s.match(/[?&]location_?[iI]d=([A-Za-z0-9]{8,64})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]{12,64}$/.test(s)) return s;
  return null;
}

function hostOf(url: string | null | undefined) {
  try {
    return url ? new URL(url).host.toLowerCase() : "";
  } catch {
    return "";
  }
}

/** Pages a locked login may open: only the one sub-account, plus sign-in pages. */
export function lockGuard(login: Pick<PortalLogin, "lockId" | "url">): ((url: string) => boolean) | undefined {
  const id = login.lockId;
  if (!id) return undefined;
  const appHost = hostOf(login.url);
  return (raw: string) => {
    if (raw === "about:blank") return true;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const where = `${u.pathname}${u.hash}`;
    const ids = Array.from(where.matchAll(/\/location\/([A-Za-z0-9]+)/g), (m) => m[1]);
    for (const key of ["locationId", "location_id", "locationid"]) {
      const q = u.searchParams.get(key);
      if (q) ids.push(q);
    }
    if (ids.length) return ids.every((x) => x === id);
    // On the platform itself, a page with no sub-account in it is agency-level (other accounts), so only sign-in pages pass.
    if (u.host.toLowerCase() === appHost) return /^\/?(|v2|login|signin|sign-in|sign_in|oauth[\w/-]*|sso[\w/-]*|verify[\w/-]*|2fa[\w/-]*|otp[\w/-]*|auth[\w/-]*|forgot[\w/-]*)\/?$/i.test(u.pathname);
    // Other sites (a sign-in provider, a page preview) carry no sub-account.
    return true;
  };
}

/** Where a locked login starts: a section of its sub-account. */
export function startIn(login: Pick<PortalLogin, "lockId" | "url">, section = "dashboard") {
  const host = hostOf(login.url);
  if (!login.lockId || !host) return login.url || "";
  return `https://${host}/v2/location/${login.lockId}/${section.replace(/^\//, "")}`;
}

export function secretsOf(login: PortalLogin) {
  return { email: login.username, password: decryptJson<{ password: string }>(login.secretEncrypted)?.password };
}

export function sessionOf(login: PortalLogin) {
  return decryptJson<{ state: string }>(login.sessionEncrypted)?.state ?? null;
}

export async function keepSession(orgId: number, login: PortalLogin, state: string | null) {
  if (!state) return;
  await db.savePortalLogin({ id: login.id, organizationId: orgId, name: login.name, username: login.username, sessionEncrypted: encryptJson({ state }) });
}

/** The saved login a request names: by its name, or a web address on the same site. */
export function findLogin(logins: PortalLogin[], words: string, url = "") {
  const w = words.trim().toLowerCase();
  const host = hostOf(url).replace(/^www\./, "");
  return (
    (w ? logins.find((l) => l.name.toLowerCase() === w) : undefined) ??
    (w ? logins.find((l) => l.name.toLowerCase().includes(w) || w.includes(l.name.toLowerCase())) : undefined) ??
    (host ? logins.find((l) => hostOf(l.url).replace(/^www\./, "") === host) : undefined) ??
    null
  );
}

/** The LeadDash platform login Zara works in. It must be locked to one sub-account. */
export async function platformLogin(orgId: number) {
  const locked = (await db.listPortalLogins(orgId)).filter((l) => l.lockId);
  return locked.find((l) => /leaddash|platform/i.test(`${l.name} ${l.url ?? ""}`)) ?? locked[0] ?? null;
}

export async function listView(orgId: number) {
  return (await db.listPortalLogins(orgId)).map((l) => ({
    id: l.id,
    name: l.name,
    url: l.url,
    username: l.username,
    lockName: l.lockName,
    lockId: l.lockId,
    hasPassword: Boolean(l.secretEncrypted),
  }));
}

export type LoginInput = { id?: number; name: string; url?: string; username: string; password?: string; lockName?: string; lockAddress?: string };

export async function save(orgId: number, input: LoginInput) {
  const existing = input.id ? (await db.listPortalLogins(orgId)).find((p) => p.id === input.id) : null;
  if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "That login is not in this workspace." });
  const url = (input.url ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) throw new TRPCError({ code: "BAD_REQUEST", message: "The web address starts with https://" });
  const lockName = (input.lockName ?? "").trim();
  let lockId: string | null = null;
  if (lockName) {
    lockId = parseLockId(input.lockAddress) ?? (existing?.lockName ? existing.lockId : null);
    if (!lockId) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the address of any page inside that sub-account. It has /location/ in it." });
    if (!url) throw new TRPCError({ code: "BAD_REQUEST", message: "Add the web address you sign in at." });
  }
  const changedSite = existing && (existing.url !== (url || null) || existing.username !== input.username || existing.lockId !== lockId);
  return db.savePortalLogin({
    id: input.id,
    organizationId: orgId,
    name: input.name.trim(),
    url: url || null,
    username: input.username.trim(),
    secretEncrypted: input.password ? encryptJson({ password: input.password }) : existing?.secretEncrypted ?? null,
    lockName: lockName || null,
    lockId,
    // A new password, site or lock starts from a fresh sign-in.
    sessionEncrypted: input.password || changedSite ? null : existing?.sessionEncrypted ?? null,
  });
}
