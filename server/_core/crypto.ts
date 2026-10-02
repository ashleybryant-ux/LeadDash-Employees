import crypto from "node:crypto";
import { ENV } from "./env";

/** SHA-256 hex digest. Used for sign-in codes and session tokens, which are never stored in plain text. */
export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** A 6-digit code with no modulo bias. */
export function randomCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function secretsKey(): Buffer {
  const raw = ENV.secretsKey;
  if (!raw) throw new Error("SECRETS_KEY is not set, so connection secrets cannot be saved");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes (64 hex characters or 44 base64 characters)");
  return key;
}

export function hasSecretsKey() {
  try {
    secretsKey();
    return true;
  } catch {
    return false;
  }
}

/** AES-256-GCM. Output is "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretsKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptJson<T = Record<string, string>>(payload: string | null | undefined): T | null {
  if (!payload) return null;
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognized secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretsKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const out = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
  return JSON.parse(out.toString("utf8")) as T;
}
