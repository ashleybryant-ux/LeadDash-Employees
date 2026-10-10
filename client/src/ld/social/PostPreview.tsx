import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { initials, parseJson } from "../meta";
import { PLAT, TEXT_LIMIT, feedRatio, fitText, fmtDuration, ratioText, type MediaMeta, type SocialChannel } from "./model";

/** A platform's square logo chip. */
export function PlatIcon({ c, size = 16 }: { c: SocialChannel; size?: number }) {
  const p = PLAT[c];
  return (
    <span
      title={p.name}
      aria-label={p.name}
      style={{ width: size, height: size, borderRadius: 4, background: p.color, color: "#fff", fontSize: Math.round(size * 0.56), fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, lineHeight: 1 }}
    >
      {p.abbr}
    </span>
  );
}

export type Account = { name: string; handle: string };

/** The page, profile or handle each platform posts as. */
export function useAccounts(): Record<SocialChannel, Account> {
  const { currentOrgId, currentOrg } = useTenant();
  const q = trpc.publishing.listConnections.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const org = currentOrg?.name ?? "Your practice";
  const slug = org.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "yourpractice";
  const conn = (p: string) => (q.data ?? []).find((c) => c.provider === p && c.status === "connected");
  const s = (p: string) => parseJson<Record<string, string | null>>(conn(p)?.settings ?? null, {});
  const fb = s("facebook");
  const handle = (p: string) => (conn(p)?.accountHandle || "").replace(/^@/, "");
  return {
    facebook: { name: fb.pageName || org, handle: "" },
    instagram: { name: fb.igUsername || slug, handle: fb.igUsername || slug },
    threads: { name: handle("threads") || slug, handle: handle("threads") || slug },
    tiktok: { name: s("tiktok").nickname || org, handle: handle("tiktok") || slug },
    x: { name: org, handle: handle("x") || slug },
    linkedin: { name: conn("linkedin")?.accountLabel || org, handle: "" },
    google_business: { name: s("google_business").locationTitle || org, handle: "" },
  };
}

export type PreviewInput = {
  channel: SocialChannel;
  type: "post" | "reel";
  text: string;
  imageUrl: string | null;
  imageMeta: MediaMeta | null;
  videoUrl: string | null;
  videoMeta: MediaMeta | null;
  coverUrl: string | null;
  coverMs: number;
  /** "Oct 6 at 11:30 AM", or null for "Just now". */
  when: string | null;
};

const post: React.CSSProperties = { border: "1px solid #e3e9e6", borderRadius: 10, background: "var(--ld-surface)", fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", color: "#1c1e21", overflow: "hidden" };
const ph: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", padding: "12px 14px" };
const pn: React.CSSProperties = { fontWeight: 700, fontSize: 14 };
const pm: React.CSSProperties = { fontSize: 12, color: "#65676b" };
const pt: React.CSSProperties = { padding: "0 14px 12px", fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const pbar: React.CSSProperties = { display: "flex", justifyContent: "space-around", borderTop: "1px solid #e3e9e6", padding: "9px 0", fontSize: 13, color: "#65676b", fontWeight: 600 };

function Pa({ name, size = 36 }: { name: string; size?: number }) {
  return <div style={{ width: size, height: size, borderRadius: 999, background: "#0d3b2e", color: "#fff", fontWeight: 800, fontSize: Math.round(size / 3), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{initials(name) || "LF"}</div>;
}

/** An image (or a video frame) at the given shape. */
function Media({ ratio, src, video, coverMs, round, empty }: { ratio: number; src: string | null; video?: string | null; coverMs?: number; round?: number; empty?: string }) {
  return (
    <div style={{ width: "100%", aspectRatio: String(ratio), overflow: "hidden", background: "#0d3b2e", borderRadius: round ?? 0, position: "relative" }}>
      {src ? (
        <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : video ? (
        <Frame src={video} ms={coverMs ?? 0} />
      ) : (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#cfe3d9", fontSize: 13, fontWeight: 700 }}>{empty ?? "No image"}</div>
      )}
      {video && <Play />}
    </div>
  );
}

/** A still frame of the video at ms. */
export function Frame({ src, ms }: { src: string; ms: number }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const seek = () => {
      try {
        v.currentTime = Math.min(ms / 1000, Math.max(0, (v.duration || 1) - 0.1));
      } catch {
        // not ready yet
      }
    };
    if (v.readyState >= 1) seek();
    v.addEventListener("loadedmetadata", seek);
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [src, ms]);
  return <video ref={ref} src={src} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
}

function Play() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ width: 52, height: 52, borderRadius: 999, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 20 }}>▶</div>
    </div>
  );
}

function Phone({ children, label, top }: { children: React.ReactNode; label?: string; top?: React.ReactNode }) {
  return (
    <div style={{ width: 270, maxWidth: "100%", aspectRatio: "9 / 16", borderRadius: 22, overflow: "hidden", position: "relative", background: "#000", border: "6px solid #111", boxSizing: "content-box" }}>
      {children}
      {label && <div style={{ position: "absolute", top: 10, left: 12, color: "#fff", font: "700 15px system-ui" }}>{label}</div>}
      {top}
    </div>
  );
}

function short(text: string, n: number) {
  return text.length > n ? `${text.slice(0, n).replace(/\s+\S*$/, "")}...` : text;
}

/** The post as it will look on one platform, with the note under it. */
export function PostPreview({ input, account }: { input: PreviewInput; account: Account }) {
  const { channel: c, type } = input;
  const limit = TEXT_LIMIT[c];
  const text = fitText(input.text, limit);
  const when = input.when ?? "Just now";
  const imgRatio = feedRatio(c, input.imageMeta?.w, input.imageMeta?.h);
  const ownRatio = input.imageMeta?.w && input.imageMeta?.h ? input.imageMeta.w / input.imageMeta.h : 0.8;
  const reelSrc = input.coverUrl;
  const count = `${input.text.length.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} characters`;
  const over = input.text.length > limit ? ` Too long for ${PLAT[c].name}; it will be shortened to fit.` : "";

  let body: React.ReactNode;
  let note: string;
  const isReel = type === "reel";
  if (isReel && (c === "instagram" || c === "facebook" || c === "tiktok")) {
    const tt = c === "tiktok";
    body = (
      <Phone label={tt ? undefined : "Reels"} top={tt ? <div style={{ position: "absolute", top: 10, left: 0, right: 0, textAlign: "center", color: "#fff", font: "700 13px system-ui" }}>Following&nbsp;&nbsp;<u>For You</u></div> : null}>
        {input.videoUrl || reelSrc ? (
          reelSrc ? <img src={reelSrc} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.9 }} /> : <Frame src={input.videoUrl!} ms={input.coverMs} />
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#cfe3d9", fontSize: 13, fontWeight: 700 }}>No video yet</div>
        )}
        <Play />
        <div style={{ position: "absolute", right: 10, bottom: 90, display: "flex", flexDirection: "column", gap: 14, color: "#fff", font: "600 11px system-ui", textAlign: "center" }}>
          <span>♡<br />Like</span>
          <span>💬<br />{tt ? "0" : "Comment"}</span>
          <span>➤<br />Share</span>
        </div>
        <div style={{ position: "absolute", left: 12, right: 60, bottom: 14, color: "#fff", font: "13px/1.35 system-ui" }}>
          <b>{tt ? `@${account.handle}` : c === "instagram" ? account.handle : account.name}</b>
          <br />
          {short(text, 70)} {text.length > 70 ? "more" : ""}
          <br />
          <span style={{ fontSize: 11, opacity: 0.85 }}>♫ {tt ? "original sound" : "Original audio"}</span>
        </div>
      </Phone>
    );
    note = `Shown at 9:16, full screen.${input.videoMeta?.seconds ? ` ${fmtDuration(input.videoMeta.seconds)} long.` : ""}${input.coverUrl ? " Cover: uploaded image." : input.videoUrl ? ` Cover: frame at ${fmtDuration(input.coverMs / 1000)}.` : ""} ${count}.${over}`;
  } else {
    const vRatio = input.videoMeta?.w && input.videoMeta?.h ? input.videoMeta.w / input.videoMeta.h : 9 / 16;
    const media = isReel ? (
      <Media ratio={Math.max(vRatio, c === "x" || c === "linkedin" ? 0.56 : 0.56)} src={reelSrc} video={input.videoUrl} coverMs={input.coverMs} round={c === "x" || c === "threads" ? 14 : 0} empty="No video yet" />
    ) : input.imageUrl ? (
      <Media ratio={imgRatio} src={input.imageUrl} round={c === "x" || c === "threads" ? 14 : 0} />
    ) : null;
    const shape = isReel ? `Shown as a video at ${ratioText(vRatio)}.` : input.imageUrl ? (c === "instagram" && Math.abs(imgRatio - ownRatio) > 0.01 ? `Shown at ${ratioText(imgRatio)}: Instagram cuts the ${ownRatio < imgRatio ? "top and bottom" : "sides"} of this image.` : `Shown at ${ratioText(imgRatio)}, the full image.`) : c === "instagram" ? "Instagram posts need an image." : "Text only.";
    note = `${shape} ${count}.${over}`;
    if (c === "facebook" || c === "linkedin" || c === "google_business") {
      body = (
        <div style={{ ...post, maxWidth: 440 }}>
          <div style={ph}>
            <Pa name={account.name} />
            <div>
              <div style={pn}>{account.name}</div>
              <div style={pm}>{when} · Public</div>
            </div>
          </div>
          <div style={pt}>{c === "linkedin" ? short(text, 210) + (text.length > 210 ? " ...more" : "") : text}</div>
          {media}
          <div style={pbar}>
            <span>Like</span>
            <span>Comment</span>
            <span>{c === "linkedin" ? "Repost" : "Share"}</span>
          </div>
        </div>
      );
    } else if (c === "instagram") {
      body = (
        <div style={{ ...post, maxWidth: 360 }}>
          <div style={ph}>
            <Pa name={account.name} size={30} />
            <div style={{ ...pn, fontSize: 13 }}>{account.handle}</div>
          </div>
          {media ?? <Media ratio={0.8} src={null} empty="Instagram needs an image" />}
          <div style={{ ...pbar, justifyContent: "flex-start", gap: 16, padding: "9px 14px", borderTop: 0 }}>
            <span>Like</span>
            <span>Comment</span>
            <span>Send</span>
          </div>
          <div style={{ ...pt, fontSize: 13 }}>
            <b>{account.handle}</b> {short(text, 90)}
            {text.length > 90 && <span style={{ color: "#8e8e8e" }}> more</span>}
          </div>
        </div>
      );
    } else {
      // X and Threads
      body = (
        <div style={{ ...post, maxWidth: 440 }}>
          <div style={{ ...ph, alignItems: "flex-start" }}>
            <Pa name={account.name} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={pn}>
                {c === "x" ? account.name : account.handle} <span style={pm}>{c === "x" ? `@${account.handle} · ` : ""}{when.replace(/ at .*/, "")}</span>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.45, margin: "4px 0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</div>
              {media}
            </div>
          </div>
        </div>
      );
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isReel && (c === "instagram" || c === "facebook" || c === "tiktok") ? "center" : "stretch", gap: 10 }}>
      {body}
      <div style={{ fontSize: 12, color: input.text.length > limit ? "#8a4510" : "var(--ld-muted)", alignSelf: "flex-start", lineHeight: 1.45 }}>{note}</div>
    </div>
  );
}

/** Platform tabs over the preview: icon only for the others, icon and name for the open one. */
export function PreviewTabs({ list, value, onChange, reel }: { list: SocialChannel[]; value: SocialChannel; onChange: (c: SocialChannel) => void; reel: boolean }) {
  return (
    <div className="ld-ftabs" role="tablist" aria-label="Preview">
      {list.map((c) => (
        <button key={c} type="button" role="tab" aria-selected={c === value} className={`ld-ft ${c === value ? "on" : ""}`} title={PLAT[c].name} onClick={() => onChange(c)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 12px", whiteSpace: "nowrap" }}>
          <PlatIcon c={c} />
          {c === value ? `${PLAT[c].name}${reel && (c === "instagram" || c === "facebook") ? " Reel" : ""}` : <span className="ld-sr">{PLAT[c].name}</span>}
        </button>
      ))}
    </div>
  );
}
