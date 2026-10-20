import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import * as db from "./db";
import { storagePutStream, uploadsRoot } from "./storage";

/**
 * Videos shared in team chat, an employee's chat, tasks and docs (2026-10-20).
 *
 * A video goes to disk as it arrives (never held in memory), is checked to be a
 * real MP4, MOV or WebM, and gets its length and a first-frame picture from
 * ffmpeg (shipped with the app). Nothing is sent to an AI: an employee only
 * learns the file's name and length. It is served from /files like any other
 * attachment, so only people on the workspace can open it.
 *
 * 250 MB: about 4 minutes of 1080p or 1.5 minutes of 4K from a phone, and under
 * the web server's 300 MB limit, so one upload gets through with no change there.
 */
export const VIDEO_MAX = 250_000_000;
export const VIDEO_TYPES = "MP4, MOV or WebM";

const EXT = /\.(mp4|mov|m4v|webm)$/i;
const MIME_EXT: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-m4v": ".m4v" };
const OTHER = /\.(avi|mkv|wmv|flv|3gp|3g2|mpe?g|m2ts|mts|ogv|hevc)$/i;
const run = promisify(execFile);

/** "ok": a video this app plays. "other": a video in a format it doesn't. null: not a video. */
export function videoKind(name: string, mime: string): "ok" | "other" | null {
  if (EXT.test(name) || mime in MIME_EXT) return "ok";
  if (/^video\//.test(mime) || OTHER.test(name)) return "other";
  return null;
}

/** The name it's kept under, always with a video ending so it is served as a video. */
export function videoName(name: string, mime: string) {
  if (EXT.test(name)) return name;
  return `${name.replace(/\.[a-z0-9]{1,5}$/i, "") || "video"}${MIME_EXT[mime] ?? ".mp4"}`;
}

/** Whether a file's first bytes are an MP4 or MOV box, or a WebM header. */
export function sniffVideo(head: Buffer) {
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return true; // WebM
  if (head.length < 8) return false;
  return ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(head.subarray(4, 8).toString("latin1"));
}

/** 0:42, 12:05. */
export const fmtLength = (seconds: number) => {
  const t = Math.max(0, Math.round(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const mimeOf = (file: string) => (/\.mov$/i.test(file) ? "video/quicktime" : /\.webm$/i.test(file) ? "video/webm" : "video/mp4");
const tooBig = () => new Error(`Videos must be under ${VIDEO_MAX / 1_000_000} MB.`);
const notPlayable = () => new Error(`That file isn't a video that can play here. Upload an ${VIDEO_TYPES}.`);

async function firstFrame(file: string, seconds: number) {
  const ff = (await import("./employees/drama")).ffmpegPath();
  const out = file.replace(/\.[a-z0-9]+$/i, "") + "-poster.jpg";
  const at = String(Math.min(0.5, seconds / 2));
  await run(ff, ["-y", "-loglevel", "error", "-ss", at, "-i", file, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4", out], { timeout: 30_000 }).catch(() => null);
  return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : null;
}

/**
 * Saves a video from the request body as a chat file. employeeId is the
 * employee whose chat it is in, or 0 for team chat, tasks and docs.
 */
export async function saveVideo(orgId: number, slot: string, name: string, mime: string, body: NodeJS.ReadableStream, opts: { employeeId: number; userId: number; declared: number }) {
  if (opts.declared > VIDEO_MAX) throw tooBig();
  const file = videoName(name, mime);
  const saved = await storagePutStream(`org-${orgId}/${slot}/${file}`, body, VIDEO_MAX).catch((err: Error) => {
    throw /must be under/.test(err.message) ? tooBig() : err;
  });
  const root = uploadsRoot();
  const full = path.join(root, saved.key);
  const drop = () => fs.rmSync(full, { force: true });
  if (saved.size === 0) {
    drop();
    throw new Error("The file was empty.");
  }
  const head = Buffer.alloc(12);
  const fd = fs.openSync(full, "r");
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  if (!sniffVideo(head)) {
    drop();
    throw notPlayable();
  }
  const { probe } = await import("./employees/broll");
  const p = await probe(full);
  if (!p.video) {
    drop();
    throw notPlayable();
  }
  const poster = await firstFrame(full, p.seconds);
  const posterUrl = poster ? `/files/${path.relative(root, poster).split(path.sep).join("/")}` : null;
  const length = p.seconds > 0 ? fmtLength(p.seconds) : null;
  // What an employee knows about it: the name and length only. Nothing is watched or transcribed.
  const text = opts.employeeId
    ? `Video${length ? `, ${length} long` : ""}${p.width && p.height ? `, ${p.width}x${p.height}` : ""}${p.audio ? ", with sound" : ", no sound"}. You can't watch or hear it; you only know its name and length.`
    : "";
  return db.createChatFile({
    organizationId: orgId,
    employeeId: opts.employeeId,
    userId: opts.userId,
    name: file,
    mime: mimeOf(file),
    size: saved.size,
    kind: "video",
    fileUrl: saved.url,
    text,
    pages: null,
    posterUrl,
    seconds: p.seconds > 0 ? Math.round(p.seconds) : null,
  });
}

/** What a message, task or doc keeps about a file: a video also carries its picture and length. */
export const attachmentOf = (f: { id: number; name: string; size: number; kind: string; fileUrl: string; posterUrl?: string | null; seconds?: number | null }) => ({
  id: f.id,
  name: f.name,
  size: f.size,
  kind: f.kind,
  url: f.fileUrl,
  ...(f.kind === "video" ? { poster: f.posterUrl ?? null, seconds: f.seconds ?? null } : {}),
});
