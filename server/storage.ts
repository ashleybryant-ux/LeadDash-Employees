import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENV } from "./_core/env";

/**
 * Files (generated images, banners) are kept on the server's disk under
 * UPLOADS_DIR and served read-only at /files/<key>. Keys are random, so a
 * URL cannot be guessed from another one.
 */

export function uploadsRoot() {
  const dir = path.resolve(ENV.uploadsDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(relKey: string) {
  const cleaned = relKey.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\.+/g, ".");
  const ext = path.extname(cleaned).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const base = path.basename(cleaned, path.extname(cleaned)).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "file";
  const dir = path.dirname(cleaned).split("/").map((p) => p.replace(/[^a-zA-Z0-9_-]/g, "")).filter(Boolean).join("/");
  const hash = crypto.randomBytes(8).toString("hex");
  return (dir ? `${dir}/` : "") + `${base}_${hash}${ext}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  _contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const key = safeKey(relKey);
  const full = path.join(uploadsRoot(), key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, data);
  return { key, url: `/files/${key}` };
}
