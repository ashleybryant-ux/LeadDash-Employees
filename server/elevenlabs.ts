import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { ENV } from "./_core/env";
import { decryptJson, encryptJson } from "./_core/crypto";

/**
 * Whose ElevenLabs account a workspace's voices use.
 * - LeadDash's own workspaces: the server's account (ELEVENLABS_API_KEY).
 * - Every other workspace: standard (OpenAI) voices for everything, and its own
 *   ElevenLabs account, connected on Integrations, only for Elena's videos. It never
 *   sees or uses LeadDash's account or the voices cloned on it.
 */

const PROVIDER = "elevenlabs" as const;
const API = "https://api.elevenlabs.io/v1";

/** The workspace's own key, when it connected one. */
export async function ownKey(orgId: number) {
  const c = await db.getConnectionByProvider(orgId, PROVIDER);
  if (!c || c.status !== "connected") return "";
  try {
    return decryptJson<{ apiKey?: string }>(c.secretsEncrypted)?.apiKey ?? "";
  } catch {
    return "";
  }
}

/**
 * The ElevenLabs key for this workspace, or "" for the standard voices. A customer's own
 * account is used only for Elena's videos ("video"); its employees' voices stay standard.
 */
export async function keyFor(orgId?: number | null, use: "video" | "voice" = "voice") {
  if (!orgId) return ENV.elevenLabsKey;
  const org = await db.getOrganizationById(orgId);
  if (org?.internal) return ENV.elevenLabsKey;
  return use === "video" ? ownKey(orgId) : "";
}

type Voice = { voice_id: string; name: string; category?: string };

async function listWith(key: string) {
  const res = await fetch(`${API}/voices`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) throw new TRPCError({ code: "BAD_REQUEST", message: "ElevenLabs didn't accept that key. Copy it again from elevenlabs.io, Developers, API keys." });
  if (!res.ok) throw new TRPCError({ code: "BAD_GATEWAY", message: `ElevenLabs didn't answer (${res.status}). Try again in a minute.` });
  const data = (await res.json()) as { voices?: Voice[] };
  return (data.voices ?? []).filter((v) => v.voice_id);
}

const isOwn = (v: Voice) => ["cloned", "professional", "generated"].includes(v.category ?? "");

/** What the Integrations tile shows. Internal workspaces use LeadDash's account, so they have no tile. */
export async function view(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const c = await db.getConnectionByProvider(orgId, PROVIDER);
  const connected = c?.status === "connected";
  let s: { voices?: number; own?: string[] } = {};
  try {
    s = c?.settings ? JSON.parse(c.settings) : {};
  } catch {
    s = {};
  }
  return { internal: !!org?.internal, connected, voices: connected ? s.voices ?? 0 : 0, own: connected ? s.own ?? [] : [], connectedAt: connected ? c!.connectedAt : null };
}

/** Checks the key with ElevenLabs, then saves it encrypted. */
export async function connect(orgId: number, apiKey: string) {
  const key = apiKey.trim();
  if (key.length < 20) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the whole API key from elevenlabs.io, Developers, API keys." });
  const voices = await listWith(key);
  const own = voices.filter(isOwn).map((v) => v.name).slice(0, 20);
  await db.upsertExternalConnection({
    organizationId: orgId,
    provider: PROVIDER,
    accountLabel: "ElevenLabs",
    accountHandle: null,
    status: "connected",
    settings: JSON.stringify({ voices: voices.length, own }),
    secretsEncrypted: encryptJson({ apiKey: key }),
    connectedAt: new Date(),
    lastCheckedAt: new Date(),
  });
  (await import("./employees/huddle")).forgetVoices();
  return view(orgId);
}

/** Back to the standard voices. Voices picked from the account stop working until it is connected again. */
export async function disconnect(orgId: number) {
  const c = await db.getConnectionByProvider(orgId, PROVIDER);
  if (c) await db.upsertExternalConnection({ organizationId: orgId, provider: PROVIDER, accountLabel: c.accountLabel, status: "disconnected", settings: "{}", secretsEncrypted: null });
  (await import("./employees/huddle")).forgetVoices();
  return view(orgId);
}
