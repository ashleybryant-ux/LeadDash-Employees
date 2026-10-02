/** The fields of an outbound item this file reads (the same on the server and in the browser). */
type OutboundItem = { metadata: string | null; body: string | null; title: string; imageUrl: string | null; targetChannels: string | null; kind: string };

/**
 * What a social post is made of. The item's body and imageUrl are the main
 * caption and image. metadata.post holds the rest: Post or Reel, the same
 * post everywhere or a different one per account, the video and its cover,
 * and the TikTok settings TikTok requires for every video.
 */

export const SOCIAL_CHANNELS = ["facebook", "instagram", "tiktok", "threads", "x", "linkedin", "google_business"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

/** Caption limits each platform enforces. */
export const TEXT_LIMIT: Record<SocialChannel, number> = {
  facebook: 63_206,
  instagram: 2_200,
  tiktok: 2_200,
  threads: 500,
  x: 280,
  linkedin: 3_000,
  google_business: 1_500,
};

export const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY)[number];

export type TikTokSettings = {
  privacy: TikTokPrivacy | "";
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** "This video promotes a brand, product or service." */
  disclose: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
};

export const DEFAULT_TIKTOK: TikTokSettings = { privacy: "", allowComment: true, allowDuet: true, allowStitch: true, disclose: false, yourBrand: false, brandedContent: false };

export type MediaMeta = { name?: string; w?: number; h?: number; seconds?: number; size?: number };

export type PostSpec = {
  type: "post" | "reel";
  mode: "same" | "different";
  /** Per-account text and image when mode is "different". */
  /** imageUrl missing: uses the main image. null: no image on that account. */
  variants: Partial<Record<SocialChannel, { text: string; imageUrl?: string | null; imageMeta?: MediaMeta | null }>>;
  imageMeta: MediaMeta | null;
  videoUrl: string | null;
  videoMeta: MediaMeta | null;
  /** An uploaded cover image, or a frame of the video at coverMs. */
  coverUrl: string | null;
  coverMs: number;
  tiktok: TikTokSettings;
};

export type Payload = {
  type: "post" | "reel";
  text: string;
  imageUrl: string | null;
  videoUrl: string | null;
  videoMeta: MediaMeta | null;
  coverUrl: string | null;
  coverMs: number;
  tiktok: TikTokSettings;
};

function parse(raw: string | null | undefined): Record<string, any> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function itemMeta(item: Pick<OutboundItem, "metadata">) {
  return parse(item.metadata);
}

export function isChannel(c: unknown): c is SocialChannel {
  return typeof c === "string" && (SOCIAL_CHANNELS as readonly string[]).includes(c);
}

/** The accounts a post goes to (lowercase keys). Older posts may say "LinkedIn". */
export function postChannels(item: Pick<OutboundItem, "targetChannels">): SocialChannel[] {
  let list: unknown = [];
  try {
    list = JSON.parse(item.targetChannels || "[]");
  } catch {
    list = [];
  }
  const out: SocialChannel[] = [];
  for (const c of Array.isArray(list) ? list : []) {
    const k = typeof c === "string" ? c.toLowerCase() : "";
    if (isChannel(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export function postSpec(item: Pick<OutboundItem, "metadata">): PostSpec {
  const meta = itemMeta(item);
  const p = meta.post && typeof meta.post === "object" ? meta.post : {};
  const variants: PostSpec["variants"] = {};
  if (p.variants && typeof p.variants === "object") {
    for (const [k, v] of Object.entries(p.variants as Record<string, any>)) {
      if (isChannel(k) && v && typeof v === "object") variants[k] = { text: String(v.text ?? ""), ...("imageUrl" in v ? { imageUrl: typeof v.imageUrl === "string" ? v.imageUrl : null } : {}), imageMeta: v.imageMeta ?? null };
    }
  }
  // Posts Sienna wrote before per-account text: her X version becomes the X text.
  let mode: PostSpec["mode"] = p.mode === "different" ? "different" : "same";
  if (!p.mode && typeof meta.xVersion === "string" && meta.xVersion.trim()) {
    mode = "different";
    variants.x = { text: meta.xVersion };
  }
  return {
    type: p.type === "reel" ? "reel" : "post",
    mode,
    variants,
    imageMeta: p.imageMeta ?? null,
    videoUrl: typeof p.videoUrl === "string" && p.videoUrl ? p.videoUrl : null,
    videoMeta: p.videoMeta ?? null,
    coverUrl: typeof p.coverUrl === "string" && p.coverUrl ? p.coverUrl : null,
    coverMs: Number.isFinite(Number(p.coverMs)) ? Math.max(0, Math.round(Number(p.coverMs))) : 0,
    tiktok: { ...DEFAULT_TIKTOK, ...(p.tiktok ?? {}) },
  };
}

/** Shortens text to fit a limit at a word break. */
export function fitText(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).replace(/\s+\S*$/, "")}...`;
}

/** Exactly what goes to one account. */
export function payloadFor(item: Pick<OutboundItem, "metadata" | "body" | "title" | "imageUrl">, channel: SocialChannel): Payload {
  const spec = postSpec(item);
  const base = item.body ?? item.title;
  const v = spec.mode === "different" ? spec.variants[channel] : undefined;
  const text = v && v.text.trim() ? v.text : base;
  // In "different" mode a variant that never set an image uses the main image.
  const imageUrl = spec.type === "reel" ? null : v && v.imageUrl !== undefined ? v.imageUrl : item.imageUrl ?? null;
  return {
    type: spec.type,
    text: fitText(text, TEXT_LIMIT[channel]),
    imageUrl,
    videoUrl: spec.type === "reel" ? spec.videoUrl : null,
    videoMeta: spec.videoMeta,
    coverUrl: spec.coverUrl,
    coverMs: spec.coverMs,
    tiktok: spec.tiktok,
  };
}

/** True when posting this takes a while (a video), so it runs in the background. */
export function hasVideo(item: Pick<OutboundItem, "metadata" | "kind">) {
  return item.kind === "social_post" && postSpec(item).type === "reel" && !!postSpec(item).videoUrl;
}

/** Problems that stop a post from going out, in plain words. Empty when it is ready. */
export function postProblems(item: Pick<OutboundItem, "metadata" | "body" | "title" | "imageUrl" | "targetChannels">): string[] {
  const spec = postSpec(item);
  const chans = postChannels(item);
  const out: string[] = [];
  if (chans.length === 0) out.push("Pick at least one account");
  if (spec.type === "reel" && !spec.videoUrl) out.push("Upload the video");
  if (spec.type === "post" && chans.includes("tiktok")) out.push("TikTok takes videos only. Switch to Reel or remove TikTok");
  if (spec.type === "post" && chans.includes("instagram") && !payloadFor(item, "instagram").imageUrl) out.push("Instagram posts need an image");
  if (spec.type === "reel" && chans.includes("google_business")) out.push("Google Business Profile takes photos, not videos");
  if (chans.includes("tiktok") && spec.type === "reel") {
    if (!spec.tiktok.privacy) out.push("Choose who can view the TikTok video");
    if (spec.tiktok.disclose && !spec.tiktok.yourBrand && !spec.tiktok.brandedContent) out.push("Choose Your brand or Branded content for the TikTok disclosure");
    if (spec.tiktok.brandedContent && spec.tiktok.privacy === "SELF_ONLY") out.push("Branded content on TikTok cannot be Only me");
  }
  return out;
}
