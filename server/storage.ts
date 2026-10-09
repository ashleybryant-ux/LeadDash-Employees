import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENV } from "./_core/env";

/**
 * Files (generated images, banners) are kept on the server's disk under
 * UPLOADS_DIR and served read-only at /files/<key>. Keys are random, so a
 * URL cannot be guessed from another one.
 */

/**
 * Who a stored file under /files belongs to: a workspace (org-<id>/...) or one
 * person's own photo (user-<id>/...). Anything else is no one's, and is never
 * served: every file the app writes lives under one of the two.
 */
export function fileOwner(urlPath: string): { kind: "org" | "user"; id: number } | null {
  let p = urlPath;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes("..") || p.includes("\\")) return null;
  const m = p.match(/^\/(org|user)-(\d+)\//);
  return m ? { kind: m[1] as "org" | "user", id: Number(m[2]) } : null;
}

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

/** Streams a large upload (a pitch video) straight to disk, never holding it in memory. */
export async function storagePutStream(relKey: string, source: NodeJS.ReadableStream, maxBytes: number): Promise<{ key: string; url: string; size: number }> {
  const key = safeKey(relKey);
  const full = path.join(uploadsRoot(), key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const out = fs.createWriteStream(full);
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      source.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error(`Files must be under ${Math.round(maxBytes / 1_000_000)} MB.`));
          (source as any).destroy?.();
        }
      });
      source.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve());
      source.pipe(out);
    });
  } catch (err) {
    out.destroy();
    await fs.promises.rm(full, { force: true });
    throw err;
  }
  return { key, url: `/files/${key}`, size };
}
