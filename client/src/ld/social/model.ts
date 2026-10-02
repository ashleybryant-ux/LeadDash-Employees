import type { Outputs } from "../types";
import { parseJson } from "../meta";
import { DEFAULT_TIKTOK, TEXT_LIMIT, fitText, itemMeta, payloadFor, postChannels, postSpec, type MediaMeta, type PostSpec, type SocialChannel, type TikTokSettings } from "@shared/post-model";

export type PostRow = Outputs["social"]["listPosts"][number];
export { DEFAULT_TIKTOK, TEXT_LIMIT, fitText, itemMeta, payloadFor, postChannels, postSpec };
export type { MediaMeta, PostSpec, SocialChannel, TikTokSettings };

/** The accounts Sienna posts to, in the order the editor shows them. */
export const PLATFORMS: { key: SocialChannel; name: string; abbr: string; color: string }[] = [
  { key: "facebook", name: "Facebook", abbr: "f", color: "#1877f2" },
  { key: "instagram", name: "Instagram", abbr: "ig", color: "#c13584" },
  { key: "tiktok", name: "TikTok", abbr: "tt", color: "#010101" },
  { key: "threads", name: "Threads", abbr: "@", color: "#000000" },
  { key: "x", name: "X", abbr: "X", color: "#111111" },
  { key: "linkedin", name: "LinkedIn", abbr: "in", color: "#0a66c2" },
  { key: "google_business", name: "Google Business Profile", abbr: "GB", color: "#34a853" },
];
export const PLAT = Object.fromEntries(PLATFORMS.map((p) => [p.key, p])) as Record<SocialChannel, (typeof PLATFORMS)[number]>;

export type Dispatch = { channel: string; ok: boolean; url?: string | null; error?: string };

/** Where a post stands, in the words the screens use. */
export function postState(p: PostRow) {
  const meta = itemMeta(p);
  const dispatch: Dispatch[] = Array.isArray(meta.dispatch) ? meta.dispatch : [];
  const postingSince = meta.postingSince ? new Date(meta.postingSince).getTime() : 0;
  const stuck = postingSince && Date.now() - postingSince > 30 * 60_000;
  if (p.status === "published") return { key: "posted" as const, label: "Posted", cls: "green", dispatch };
  if (p.status === "approved" && postingSince && !stuck) return { key: "posting" as const, label: "Posting", cls: "amber", dispatch };
  if ((p.status === "approved" && (dispatch.some((d) => !d.ok) || stuck)) || p.status === "blocked_connection") {
    const some = dispatch.some((d) => d.ok);
    return { key: "failed" as const, label: p.status === "blocked_connection" ? "Needs connection" : some ? "Partly posted" : "Did not post", cls: "red", dispatch };
  }
  if (p.status === "scheduled") return { key: "scheduled" as const, label: "Scheduled", cls: "green", dispatch };
  if (p.status === "approved") return { key: "draft" as const, label: "Approved", cls: "green", dispatch };
  if (p.status === "changes_requested") return { key: "draft" as const, label: "Sent back", cls: "amber", dispatch };
  if (p.status === "cancelled") return { key: "cancelled" as const, label: "Cancelled", cls: "gray", dispatch };
  return { key: "draft" as const, label: "Needs approval", cls: "amber", dispatch };
}

// ==========================================
// Times in the workspace's time zone
// ==========================================

const p2 = (n: number) => String(n).padStart(2, "0");

export function zoned(at: Date | string | number, tz: string) {
  const d = at instanceof Date ? at : new Date(at);
  const parts: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d)) parts[x.type] = x.value;
  const y = +parts.year;
  const m = +parts.month;
  const day = +parts.day;
  const h = +parts.hour % 24;
  const mi = +parts.minute;
  return { y, m, d: day, h, mi, key: y * 10000 + m * 100 + day, date: `${p2(m)}/${p2(day)}/${y}`, time: `${h % 12 === 0 ? 12 : h % 12}:${p2(mi)} ${h >= 12 ? "PM" : "AM"}` };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue, Oct 6, 2026 at 11:30 AM" */
export function whenLabel(at: Date | string | number, tz: string) {
  const z = zoned(at, tz);
  const wd = new Date(Date.UTC(z.y, z.m - 1, z.d)).getUTCDay();
  return `${DOW[wd]}, ${MON[z.m - 1]} ${z.d}, ${z.y} at ${z.time}`;
}

/** "Oct 6, 2026, 11:30 AM" for table cells. */
export function whenShort(at: Date | string | number, tz: string) {
  const z = zoned(at, tz);
  return `${MON[z.m - 1]} ${z.d}, ${z.y}, ${z.time}`;
}

/** Times every 15 minutes, for the time picker. */
export const TIMES = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const mi = (i % 4) * 15;
  return `${h % 12 === 0 ? 12 : h % 12}:${p2(mi)} ${h >= 12 ? "PM" : "AM"}`;
});

export function dateValid(s: string) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) return false;
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2];
}

// ==========================================
// Image shapes
// ==========================================

/** The shape each platform shows an image at in the feed. Instagram clamps to 4:5 through 1.91:1; the rest show the image's own shape. */
export function feedRatio(channel: SocialChannel, w?: number, h?: number) {
  const r = w && h ? w / h : 0.8;
  if (channel === "instagram") return Math.min(1.91, Math.max(0.8, r));
  return r;
}

export function ratioText(r: number) {
  const known: [number, string][] = [[0.8, "4:5"], [1, "1:1"], [1.91, "1.91:1"], [16 / 9, "16:9"], [9 / 16, "9:16"], [2 / 3, "2:3"], [3 / 2, "3:2"], [4 / 3, "4:3"], [3 / 4, "3:4"]];
  const hit = known.find(([k]) => Math.abs(k - r) < 0.01);
  return hit ? hit[1] : `${r.toFixed(2)}:1`;
}

export function fmtDuration(sec?: number) {
  if (!sec && sec !== 0) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
}

/** Problems with the video for each platform, from the published limits. */
export function videoWarnings(channels: SocialChannel[], meta: MediaMeta | null, tiktokMax?: number) {
  const out: string[] = [];
  const s = meta?.seconds;
  if (!s) return out;
  const len = fmtDuration(s);
  if (channels.includes("facebook") && (s < 3 || s > 90)) out.push(`Facebook Reels must be 3 to 90 seconds. This video is ${len}.`);
  if (channels.includes("instagram") && (s < 3 || s > 900)) out.push(`Instagram Reels must be 3 seconds to 15 minutes. This video is ${len}.`);
  if (channels.includes("x") && s > 140) out.push(`X takes videos up to 2:20. This video is ${len}.`);
  if (channels.includes("threads") && s > 300) out.push(`Threads takes videos up to 5 minutes. This video is ${len}.`);
  if (channels.includes("linkedin") && (s < 3 || s > 1800)) out.push(`LinkedIn takes videos of 3 seconds to 30 minutes. This video is ${len}.`);
  if (channels.includes("tiktok") && tiktokMax && s > tiktokMax) out.push(`This TikTok account can post videos up to ${fmtDuration(tiktokMax)}. This video is ${len}.`);
  if (meta?.size && meta.size > 300_000_000 && channels.includes("instagram")) out.push("Instagram Reels must be under 300 MB.");
  return out;
}

export function parseList(raw: string | null) {
  return parseJson<string[]>(raw, []);
}
