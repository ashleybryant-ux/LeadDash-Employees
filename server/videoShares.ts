import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { dramaEpisodes, videoEdits, videos, videoShares, type VideoShare } from "../drizzle/schema";

/**
 * Watch links for Elena's finished videos (2026-10-20): Share makes a random
 * token and /watch/<token> plays the video for anyone with the link, no
 * sign-in, showing only the workspace's name. Stop sharing deletes the token,
 * so the old link stops working. A token is 144 random bits, never the
 * video's id, so a link can't be guessed from another one.
 *
 * Covers every finished video on Elena's Videos tab: made from instructions
 * ("video"), Edit my video ("edit") and Scenes ("scene").
 */
export type ShareSource = VideoShare["source"];
export const SHARE_SOURCES = ["video", "edit", "scene"] as const;

const RATIO: Record<string, string> = { vertical: "9:16", square: "1:1", wide: "16:9" };
const TOKEN = /^[A-Za-z0-9_-]{24}$/;

export const newToken = () => crypto.randomBytes(18).toString("base64url");
export const watchPath = (token: string) => `/watch/${token}`;

const parseUrls = (raw: string | null | undefined): Record<string, string> => {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

/** A finished video's files, one per size: { ratio: "9:16", slug: "9x16", url: "/files/..." }. Empty while it isn't finished. */
export function filesOf(orgId: number, source: ShareSource, id: number): { ratio: string; slug: string; url: string }[] {
  const d = db.getDb();
  let byRatio: Record<string, string> = {};
  if (source === "video") {
    const v = d.select().from(videos).where(and(eq(videos.id, id), eq(videos.organizationId, orgId))).get();
    if (!v || v.status !== "ready") return [];
    byRatio = Object.fromEntries(Object.entries(parseUrls(v.videoUrls)).map(([size, url]) => [RATIO[size] ?? size, url]));
    if (!Object.keys(byRatio).length && v.videoUrl) byRatio = { [RATIO[v.size] ?? "9:16"]: v.videoUrl };
  } else if (source === "edit") {
    const e = d.select().from(videoEdits).where(and(eq(videoEdits.id, id), eq(videoEdits.organizationId, orgId))).get();
    if (!e) return [];
    byRatio = Object.fromEntries(Object.entries(parseUrls(e.videoUrls)).map(([size, url]) => [RATIO[size] ?? size, url]));
  } else {
    const s = d.select().from(dramaEpisodes).where(and(eq(dramaEpisodes.id, id), eq(dramaEpisodes.organizationId, orgId))).get();
    if (!s || s.status !== "ready") return [];
    byRatio = parseUrls(s.versions);
    if (!Object.keys(byRatio).length && s.videoUrl) byRatio = { "9:16": s.videoUrl };
  }
  return Object.entries(byRatio)
    .filter(([ratio, url]) => /^\d{1,2}:\d{1,2}$/.test(ratio) && typeof url === "string" && /^\/files\//.test(url))
    .map(([ratio, url]) => ({ ratio, slug: ratio.replace(":", "x"), url }));
}

export function shareOf(orgId: number, source: ShareSource, id: number) {
  return db.getDb().select().from(videoShares).where(and(eq(videoShares.organizationId, orgId), eq(videoShares.source, source), eq(videoShares.sourceId, id))).get() ?? null;
}

/** Turns the watch link on (keeping the same link if it is already on) or off. Returns the link, or null when off. */
export function setShared(orgId: number, source: ShareSource, id: number, on: boolean, by: string): string | null {
  const have = shareOf(orgId, source, id);
  if (!on) {
    if (have) db.getDb().delete(videoShares).where(eq(videoShares.token, have.token)).run();
    return null;
  }
  if (have) return watchPath(have.token);
  if (!filesOf(orgId, source, id).length) throw new TRPCError({ code: "BAD_REQUEST", message: "You can share it once it's finished." });
  const token = newToken();
  db.getDb().insert(videoShares).values({ token, organizationId: orgId, source, sourceId: id, createdBy: by.slice(0, 120) }).run();
  return watchPath(token);
}

/** What a watch link plays: its share row and the video's files. null for a bad, stopped or unfinished link. */
export function byToken(token: string) {
  if (!TOKEN.test(token)) return null;
  const share = db.getDb().select().from(videoShares).where(eq(videoShares.token, token)).get();
  if (!share) return null;
  const files = filesOf(share.organizationId, share.source, share.sourceId);
  return files.length ? { share, files } : null;
}
