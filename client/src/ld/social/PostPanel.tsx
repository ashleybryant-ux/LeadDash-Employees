import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { uploadFile } from "../meta";
import { PlatIcon, PostPreview, PreviewTabs, useAccounts, Frame } from "./PostPreview";
import { DEFAULT_TIKTOK, PLAT, PLATFORMS, TEXT_LIMIT, TIMES, dateValid, fmtDuration, payloadFor, postChannels, postSpec, videoWarnings, whenLabel, zoned, type MediaMeta, type PostRow, type SocialChannel, type TikTokSettings } from "./model";

type Variant = { text: string; imageUrl: string | null; imageMeta: MediaMeta | null };

type Draft = {
  type: "post" | "reel";
  mode: "same" | "different";
  channels: SocialChannel[];
  text: string;
  imageUrl: string | null;
  imageMeta: MediaMeta | null;
  variants: Partial<Record<SocialChannel, Variant>>;
  videoUrl: string | null;
  videoMeta: MediaMeta | null;
  coverUrl: string | null;
  coverMs: number;
  tiktok: TikTokSettings;
  date: string;
  time: string;
};

const PRIVACY: Record<string, string> = { PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only me" };
const ORDER: SocialChannel[] = ["facebook", "instagram", "tiktok", "threads", "x", "linkedin", "google_business"];

function draftOf(item: PostRow | null, tz: string, preset?: Partial<Draft>): Draft {
  if (!item) {
    return { type: "post", mode: "same", channels: ["facebook", "instagram"], text: "", imageUrl: null, imageMeta: null, variants: {}, videoUrl: null, videoMeta: null, coverUrl: null, coverMs: 0, tiktok: { ...DEFAULT_TIKTOK }, date: "", time: "", ...preset };
  }
  const spec = postSpec(item);
  const channels = postChannels(item);
  const variants: Draft["variants"] = {};
  if (spec.mode === "different") {
    for (const c of channels) {
      const p = payloadFor(item, c);
      variants[c] = { text: spec.variants[c]?.text?.trim() ? spec.variants[c]!.text : item.body ?? "", imageUrl: p.imageUrl, imageMeta: spec.variants[c]?.imageMeta ?? (p.imageUrl === item.imageUrl ? spec.imageMeta : null) };
    }
  }
  const at = item.scheduledFor ? zoned(item.scheduledFor, tz) : null;
  return {
    type: spec.type,
    mode: spec.mode,
    channels,
    text: item.body ?? "",
    imageUrl: item.imageUrl,
    imageMeta: spec.imageMeta,
    variants,
    videoUrl: spec.videoUrl,
    videoMeta: spec.videoMeta,
    coverUrl: spec.coverUrl,
    coverMs: spec.coverMs,
    tiktok: spec.tiktok,
    date: at?.date ?? "",
    time: at?.time ?? "",
  };
}

/** Width and height (and length) of a picked file, read in the browser. */
function readMeta(file: File): Promise<MediaMeta> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const done = (m: MediaMeta) => {
      URL.revokeObjectURL(url);
      resolve({ name: file.name, size: file.size, ...m });
    };
    if (file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => done({ w: v.videoWidth, h: v.videoHeight, seconds: Math.round(v.duration * 10) / 10 });
      v.onerror = () => done({});
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
    }
  });
}

/** Six frames spread across the video, drawn in the browser, for picking the cover. */
function useFrames(src: string | null, seconds?: number) {
  const [frames, setFrames] = React.useState<{ ms: number; url: string }[]>([]);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFrames([]);
    setFailed(false);
    if (!src || !seconds) return;
    let cancelled = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = src;
    const times = Array.from({ length: 6 }, (_, i) => Math.min(seconds - 0.1, (seconds * (i + 0.5)) / 6));
    const canvas = document.createElement("canvas");
    const out: { ms: number; url: string }[] = [];
    const grab = (i: number) => {
      if (cancelled || i >= times.length) return;
      v.onseeked = () => {
        try {
          const w = 90;
          const h = Math.round((w * (v.videoHeight || 16)) / (v.videoWidth || 9));
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d")?.drawImage(v, 0, 0, w, h);
          out.push({ ms: Math.round(times[i] * 1000), url: canvas.toDataURL("image/jpeg", 0.7) });
          if (!cancelled) setFrames([...out]);
        } catch {
          // a frame that cannot be drawn is skipped
        }
        grab(i + 1);
      };
      v.currentTime = times[i];
    };
    v.onloadeddata = () => grab(0);
    v.onerror = () => !cancelled && setFailed(true);
    const timer = window.setTimeout(() => !cancelled && out.length === 0 && setFailed(true), 15_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      v.removeAttribute("src");
    };
  }, [src, seconds]);
  return { frames, failed };
}

function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14, padding: "4px 0", gap: 12, opacity: disabled ? 0.55 : 1 }}>
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        style={{ width: 40, height: 22, borderRadius: 999, background: on ? "var(--ld-accent)" : "var(--ld-line4)", position: "relative", border: 0, cursor: disabled ? "default" : "pointer", flexShrink: 0, padding: 0 }}
      >
        <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 16, height: 16, borderRadius: 999, background: "var(--ld-surface)", transition: "left .15s" }} />
      </button>
    </div>
  );
}

const kv: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };
const help: React.CSSProperties = { fontSize: 12, color: "var(--ld-muted)", lineHeight: 1.45 };
const drop: React.CSSProperties = { border: "1.5px dashed #b7c6bf", borderRadius: 10, padding: 12, display: "flex", gap: 14, alignItems: "center", background: "var(--ld-surface)" };
const section: React.CSSProperties = { borderTop: "1px solid #dbe4df", paddingTop: 12, display: "flex", flexDirection: "column", gap: 12 };

/** A file box: shows what is there, Upload and Remove buttons, and takes a dropped file. */
function FileBox({ kind, url, meta, onFile, onRemove, busy, thumb }: { kind: "image" | "video"; url: string | null; meta: MediaMeta | null; onFile: (f: File) => void; onRemove: () => void; busy: boolean; thumb: React.ReactNode }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const dims = meta?.w && meta?.h ? ` · ${meta.w} × ${meta.h}` : "";
  return (
    <div
      style={{ ...drop, borderColor: over ? "var(--ld-accent)" : "#b7c6bf" }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      {url && thumb}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        {url && <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{(meta?.name || (kind === "video" ? "Video" : "Image")) + (kind === "video" && meta?.seconds ? ` · ${fmtDuration(meta.seconds)}` : "") + dims}</span>}
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ld-btn" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading..." : kind === "video" ? "Upload video" : "Upload image"}
          </button>
          {url && (
            <button type="button" className="ld-btn" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          )}
        </span>
        <span style={help}>{kind === "video" ? "MP4 or MOV, vertical 9:16. Or drag a file here." : "JPG or PNG, up to 8 MB. Or drag a file here."}</span>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={kind === "video" ? "video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" : "image/jpeg,image/png,image/webp"}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * One post, opened: the preview at each platform's real shape on the left,
 * and either a summary (with Edit) or the editor on the right.
 */
export default function PostPanel({
  item,
  startEditing = false,
  preset,
  side,
  extra,
  onClose,
  onSaved,
}: {
  item: PostRow | null;
  startEditing?: boolean;
  preset?: Partial<Draft>;
  /** Buttons under Edit (Approve, Unschedule...). */
  side?: React.ReactNode;
  /** More lines under the summary (results, who approved). */
  extra?: React.ReactNode;
  onClose?: () => void;
  onSaved?: (row: PostRow) => void;
}) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const utils = trpc.useUtils();
  const accounts = useAccounts();
  const info = trpc.publishing.connectInfo.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const live = (info.data?.channels ?? {}) as Record<string, boolean>;
  const [editing, setEditing] = React.useState(startEditing || !item);
  const [d, setD] = React.useState<Draft>(() => draftOf(item, tz, preset));
  const [tab, setTab] = React.useState<SocialChannel>(() => draftOf(item, tz, preset).channels[0] ?? "facebook");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [uploadErr, setUploadErr] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState<string | null>(null);
  const [coverMode, setCoverMode] = React.useState<"frame" | "upload">(() => (draftOf(item, tz, preset).coverUrl ? "upload" : "frame"));

  React.useEffect(() => {
    if (!editing) {
      const next = draftOf(item, tz, preset);
      setD(next);
      if (!next.channels.includes(tab)) setTab(next.channels[0] ?? "facebook");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.updatedAt, editing]);

  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));
  const reel = d.type === "reel";
  const shown = ORDER.filter((c) => d.channels.includes(c));
  const active = shown.includes(tab) ? tab : shown[0] ?? "facebook";
  const v = d.mode === "different" ? d.variants[active] ?? { text: d.text, imageUrl: d.imageUrl, imageMeta: d.imageMeta } : null;
  const curText = v ? v.text : d.text;
  const curImage = v ? v.imageUrl : d.imageUrl;
  const curImageMeta = v ? v.imageMeta : d.imageMeta;
  const tiktokOn = reel && d.channels.includes("tiktok");
  const creator = trpc.social.tiktokCreator.useQuery({ organizationId: currentOrgId }, { enabled: editing && tiktokOn && !!live.tiktok, staleTime: 0, refetchOnWindowFocus: false });
  const cr = creator.data?.ok ? creator.data.creator : null;
  const { frames, failed: framesFailed } = useFrames(editing && reel && coverMode === "frame" ? d.videoUrl : null, d.videoMeta?.seconds);

  const setText = (text: string) => (v ? set({ variants: { ...d.variants, [active]: { ...v, text } } }) : set({ text }));
  const setImage = (imageUrl: string | null, imageMeta: MediaMeta | null) => (v ? set({ variants: { ...d.variants, [active]: { ...v, imageUrl, imageMeta } } }) : set({ imageUrl, imageMeta }));

  const toggleChannel = (c: SocialChannel) => {
    const on = d.channels.includes(c);
    const channels = on ? d.channels.filter((x) => x !== c) : [...d.channels, c];
    const variants = { ...d.variants };
    if (!on && d.mode === "different" && !variants[c]) variants[c] = { text: d.text, imageUrl: d.imageUrl, imageMeta: d.imageMeta };
    set({ channels, variants });
    if (!on) setTab(c);
  };

  const setMode = (mode: "same" | "different") => {
    if (mode === d.mode) return;
    if (mode === "different") {
      const variants: Draft["variants"] = {};
      for (const c of d.channels) variants[c] = d.variants[c] ?? { text: d.text, imageUrl: d.imageUrl, imageMeta: d.imageMeta };
      set({ mode, variants });
    } else {
      // Back to one post: the open account's version becomes the post.
      set({ mode, text: v?.text ?? d.text, imageUrl: v?.imageUrl ?? d.imageUrl, imageMeta: v?.imageMeta ?? d.imageMeta });
    }
  };

  const setType = (type: "post" | "reel") => {
    if (type === d.type) return;
    set({ type, channels: type === "post" ? d.channels.filter((c) => c !== "tiktok") : d.channels.filter((c) => c !== "google_business") });
  };

  const upload = async (f: File, what: "image" | "video" | "cover") => {
    setUploadErr(null);
    setBusy(what);
    try {
      const [meta, r] = await Promise.all([readMeta(f), uploadFile("post_media", f, { organizationId: currentOrgId })]);
      if (what === "video") {
        if (r.kind !== "video") throw new Error("Pick a video file (MP4 or MOV).");
        set({ videoUrl: r.url, videoMeta: meta, coverMs: Math.min(d.coverMs, Math.round((meta.seconds ?? 0) * 1000)) });
      } else {
        if (r.kind !== "image") throw new Error("Pick an image file (JPG or PNG).");
        if (what === "cover") set({ coverUrl: r.url });
        else setImage(r.url, meta);
      }
    } catch (err) {
      setUploadErr((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const suggest = trpc.social.suggestTime.useMutation({
    onSuccess: (r) => {
      set({ date: r.date, time: r.time });
      setReason(r.reason);
    },
  });
  const save = trpc.social.savePost.useMutation({
    onSuccess: async (row) => {
      await Promise.all([utils.social.listPosts.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
      if (item) setEditing(false);
      onSaved?.(row as PostRow);
    },
  });

  const doSave = () => {
    const variants: Record<string, { text: string; imageUrl: string | null; imageMeta: MediaMeta | null }> = {};
    let text = d.text;
    let imageUrl = d.imageUrl;
    let imageMeta = d.imageMeta;
    if (d.mode === "different") {
      for (const c of d.channels) {
        const x = d.variants[c] ?? { text: d.text, imageUrl: d.imageUrl, imageMeta: d.imageMeta };
        variants[c] = { text: x.text, imageUrl: x.imageUrl, imageMeta: x.imageMeta };
      }
      const first = variants[shown[0]];
      if (first) {
        text = first.text;
        imageUrl = first.imageUrl;
        imageMeta = first.imageMeta;
      }
    }
    save.mutate({
      organizationId: currentOrgId,
      itemId: item?.id,
      type: d.type,
      mode: d.mode,
      channels: d.channels,
      text,
      imageUrl,
      imageMeta,
      variants,
      videoUrl: d.videoUrl,
      videoMeta: d.videoMeta,
      coverUrl: coverMode === "upload" ? d.coverUrl : null,
      coverMs: d.coverMs,
      tiktok: d.tiktok,
      date: d.date.trim(),
      time: d.date.trim() ? d.time : "",
    });
  };

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const when = d.date && dateValid(d.date) ? `${MON[+d.date.slice(0, 2) - 1]} ${+d.date.slice(3, 5)}${d.time ? ` at ${d.time}` : ""}` : item?.publishedAt ? (() => {
    const z = zoned(item.publishedAt, tz);
    return `${MON[z.m - 1]} ${z.d} at ${z.time}`;
  })() : null;

  const preview = (
    <div style={{ minWidth: 0 }}>
      <span className="ld-lbl">Preview</span>
      <div style={{ marginTop: 8 }}>
        {shown.length > 0 ? (
          <>
            <PreviewTabs list={shown} value={active} onChange={setTab} reel={reel} />
            <div style={{ background: "var(--ld-surface)", border: "1px solid #dbe4df", borderRadius: "0 12px 12px 12px", padding: 16 }}>
              <PostPreview
                account={accounts[active]}
                input={{ channel: active, type: d.type, text: curText, imageUrl: curImage, imageMeta: curImageMeta, videoUrl: d.videoUrl, videoMeta: d.videoMeta, coverUrl: coverMode === "upload" ? d.coverUrl : null, coverMs: d.coverMs, when }}
              />
              {reel && videoWarnings(d.channels, d.videoMeta, cr?.maxSeconds).map((w) => (
                <div key={w} style={{ fontSize: 12, color: "#8a4510", fontWeight: 600, marginTop: 6 }}>{w}</div>
              ))}
            </div>
          </>
        ) : (
          <div className="ld-card ld-empty">Pick an account to see the preview.</div>
        )}
      </div>
    </div>
  );

  if (!editing && item) {
    const spec = postSpec(item);
    const posts = shown.map((c) => {
      const a = accounts[c];
      if (c === "facebook") return `Facebook page ${a.name}`;
      if (c === "linkedin") return `LinkedIn as ${a.name}`;
      if (c === "google_business") return `Google Business Profile ${a.name}`;
      return `${PLAT[c].name} @${a.handle}`;
    });
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
        {preview}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div style={kv}>
            <span className="ld-lbl">{reel ? "Type" : "Content"}</span>
            <span className="ld-body">{reel ? "Reel" : spec.mode === "different" ? "Different for each account" : "Same post everywhere"}</span>
          </div>
          {reel ? (
            <div style={kv}>
              <span className="ld-lbl">Video</span>
              {spec.videoUrl ? (
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 54, height: 96, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "#000" }}>{spec.coverUrl ? <img src={spec.coverUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Frame src={spec.videoUrl} ms={spec.coverMs} />}</div>
                  <span className="ld-body">{[spec.videoMeta?.name, spec.videoMeta?.seconds ? fmtDuration(spec.videoMeta.seconds) : "", spec.videoMeta?.w ? `${spec.videoMeta.w} × ${spec.videoMeta.h}` : ""].filter(Boolean).join(" · ") || "Video"}</span>
                </div>
              ) : (
                <span className="ld-body" style={{ color: "#8a4510" }}>No video yet</span>
              )}
            </div>
          ) : item.imageUrl ? (
            <div style={kv}>
              <span className="ld-lbl">Image</span>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <img src={item.imageUrl} alt="" style={{ width: 72, height: 90, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                <span className="ld-body">{[spec.imageMeta?.name, spec.imageMeta?.w ? `${spec.imageMeta.w} × ${spec.imageMeta.h}` : ""].filter(Boolean).join(" · ") || "Image"}</span>
              </div>
            </div>
          ) : null}
          <div style={kv}>
            <span className="ld-lbl">Posts to</span>
            <span className="ld-body">{posts.join(" · ") || "No account picked"}</span>
            {shown.some((c) => !live[c]) && <span style={help}>Not connected yet: {shown.filter((c) => !live[c]).map((c) => PLAT[c].name).join(", ")}. Those wait until you connect them on Integrations.</span>}
          </div>
          <div style={kv}>
            <span className="ld-lbl">When</span>
            <span className="ld-body">{item.scheduledFor ? whenLabel(item.scheduledFor, tz) : item.publishedAt ? `Posted ${whenLabel(item.publishedAt, tz)}` : "Not scheduled yet"}</span>
          </div>
          {extra}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {item.status !== "published" && item.status !== "cancelled" && (
            <button type="button" className="ld-btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {side}
        </div>
      </div>
    );
  }

  const limit = TEXT_LIMIT[active];
  const chips = PLATFORMS.filter((p) => p.key !== "google_business" || live.google_business || d.channels.includes("google_business"));
  const tk = d.tiktok;
  const setTk = (patch: Partial<TikTokSettings>) => set({ tiktok: { ...tk, ...patch } });
  const privacyChoices = (cr?.privacyOptions?.length ? cr.privacyOptions : Object.keys(PRIVACY)).filter((k) => PRIVACY[k]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24, alignItems: "start" }}>
      {preview}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <div style={kv}>
          <span className="ld-lbl">Type</span>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {(["post", "reel"] as const).map((t) => (
              <button key={t} type="button" className={`ld-chip ${d.type === t ? "on" : ""}`} aria-pressed={d.type === t} onClick={() => setType(t)}>
                {t === "post" ? "Post" : "Reel"}
              </button>
            ))}
          </div>
        </div>
        <div style={kv}>
          <span className="ld-lbl">Content</span>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            <button type="button" className={`ld-chip ${d.mode === "same" ? "on" : ""}`} aria-pressed={d.mode === "same"} onClick={() => setMode("same")}>Same post everywhere</button>
            <button type="button" className={`ld-chip ${d.mode === "different" ? "on" : ""}`} aria-pressed={d.mode === "different"} onClick={() => setMode("different")}>Different for each account</button>
          </div>
        </div>
        <div style={kv}>
          <span className="ld-lbl">Posts to</span>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            {chips.map((p) => {
              const blocked = (p.key === "tiktok" && !reel) || (p.key === "google_business" && reel);
              return (
                <button key={p.key} type="button" className={`ld-chip ${d.channels.includes(p.key) ? "on" : ""}`} aria-pressed={d.channels.includes(p.key)} disabled={blocked} title={blocked ? (p.key === "tiktok" ? "TikTok takes videos only. Pick Reel." : "Google Business Profile takes photos only.") : undefined} onClick={() => toggleChannel(p.key)} style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: blocked ? 0.5 : 1 }}>
                  <PlatIcon c={p.key} /> {p.name === "Google Business Profile" ? "Google Business" : p.name}
                </button>
              );
            })}
          </div>
          {reel && <span style={help}>Instagram and Facebook post it as a Reel. Threads, X and LinkedIn post it as a video.</span>}
          {!reel && <span style={help}>TikTok takes videos only. Pick Reel to post there.</span>}
          {d.channels.some((c) => info.data && !live[c]) && <span style={help}>Not connected yet: {d.channels.filter((c) => !live[c]).map((c) => PLAT[c].name).join(", ")}. Those wait until you connect them.</span>}
        </div>

        <div style={section}>
          {d.mode === "different" && shown.length > 0 && (
            <span style={{ fontWeight: 800, fontSize: 14, display: "flex", gap: 8, alignItems: "center" }}>
              <PlatIcon c={active} /> {PLAT[active].name} {reel ? "caption" : "post"}
            </span>
          )}
          {reel ? (
            d.mode === "same" || active === shown[0] ? (
              <>
                <div style={kv}>
                  <span className="ld-lbl">Video</span>
                  <FileBox
                    kind="video"
                    url={d.videoUrl}
                    meta={d.videoMeta}
                    busy={busy === "video"}
                    onFile={(f) => upload(f, "video")}
                    onRemove={() => set({ videoUrl: null, videoMeta: null })}
                    thumb={<div style={{ width: 54, height: 96, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "#000" }}>{d.videoUrl && <Frame src={d.videoUrl} ms={d.coverMs} />}</div>}
                  />
                </div>
                {d.videoUrl && (
                  <div style={kv}>
                    <span className="ld-lbl">Cover</span>
                    <div className="ld-row" style={{ flexWrap: "wrap" }}>
                      <button type="button" className={`ld-chip ${coverMode === "frame" ? "on" : ""}`} aria-pressed={coverMode === "frame"} onClick={() => setCoverMode("frame")}>Frame from the video</button>
                      <button type="button" className={`ld-chip ${coverMode === "upload" ? "on" : ""}`} aria-pressed={coverMode === "upload"} onClick={() => setCoverMode("upload")}>Upload an image</button>
                    </div>
                    {coverMode === "frame" ? (
                      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                        {frames.length === 0 && <span style={help}>{framesFailed ? "This browser could not show frames of this video. The cover is the frame at " + fmtDuration(d.coverMs / 1000) + ", or upload an image." : "Loading frames..."}</span>}
                        {frames.map((f) => {
                          const on = Math.abs(f.ms - d.coverMs) < 50;
                          return (
                            <button key={f.ms} type="button" aria-label={`Frame at ${fmtDuration(f.ms / 1000)}`} aria-pressed={on} onClick={() => set({ coverMs: f.ms })} style={{ width: 40, height: 71, borderRadius: 6, overflow: "hidden", padding: 0, border: 0, cursor: "pointer", outline: on ? "2px solid #1b6b4a" : "none", outlineOffset: 1, opacity: on ? 1 : 0.6 }}>
                              <img src={f.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <FileBox kind="image" url={d.coverUrl} meta={null} busy={busy === "cover"} onFile={(f) => upload(f, "cover")} onRemove={() => set({ coverUrl: null })} thumb={d.coverUrl ? <img src={d.coverUrl} alt="" style={{ width: 54, height: 96, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} /> : null} />
                    )}
                    {d.channels.includes("facebook") && <span style={help}>Facebook picks its own cover for Reels.</span>}
                  </div>
                )}
              </>
            ) : (
              <span style={help}>The video and cover are the same on every account. Change them on the {PLAT[shown[0]].name} tab.</span>
            )
          ) : (
            <div style={kv}>
              <span className="ld-lbl">Image</span>
              <FileBox kind="image" url={curImage} meta={curImageMeta} busy={busy === "image"} onFile={(f) => upload(f, "image")} onRemove={() => setImage(null, null)} thumb={curImage ? <img src={curImage} alt="" style={{ width: 72, height: 90, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} /> : null} />
            </div>
          )}
          {uploadErr && <span className="ld-small" style={{ color: "var(--ld-bad)", fontWeight: 600 }}>{uploadErr}</span>}
          <div style={kv}>
            <label className="ld-lbl" htmlFor={`cap-${item?.id ?? "new"}`}>Caption</label>
            <textarea id={`cap-${item?.id ?? "new"}`} className="ld-ta" rows={active === "x" ? 3 : 5} value={curText} onChange={(e) => setText(e.target.value)} />
            <span style={{ ...help, color: curText.length > limit ? "#8a4510" : "var(--ld-muted)" }}>
              {curText.length.toLocaleString("en-US")} of {limit.toLocaleString("en-US")}
              {d.mode === "same" && shown.length > 1 ? `, for ${PLAT[active].name}` : ""}
            </span>
          </div>
        </div>

        {tiktokOn && (
          <div style={section}>
            <span style={{ fontWeight: 800, fontSize: 14, display: "flex", gap: 8, alignItems: "center" }}>
              <PlatIcon c="tiktok" /> TikTok settings
            </span>
            <div style={kv}>
              <span className="ld-lbl">Posting to</span>
              <span className="ld-body">{cr ? `${cr.nickname}${cr.username ? ` (@${cr.username})` : ""}` : !live.tiktok ? "TikTok is not connected yet" : creator.isLoading ? "Asking TikTok..." : creator.data && !creator.data.ok ? creator.data.error : ""}</span>
            </div>
            <div style={kv}>
              <label className="ld-lbl" htmlFor={`tv-${item?.id ?? "new"}`}>Who can view</label>
              <select id={`tv-${item?.id ?? "new"}`} className="ld-in" style={{ maxWidth: 260 }} value={tk.privacy} onChange={(e) => setTk({ privacy: e.target.value as TikTokSettings["privacy"] })}>
                <option value="">Choose who can view</option>
                {privacyChoices.map((k) => (
                  <option key={k} value={k} disabled={k === "SELF_ONLY" && tk.disclose && tk.brandedContent}>
                    {PRIVACY[k]}
                  </option>
                ))}
              </select>
              <span style={help}>TikTok requires you to pick this for every video.</span>
            </div>
            <div style={kv}>
              <span className="ld-lbl">Allow</span>
              <Toggle label="Comments" on={tk.allowComment && !cr?.commentDisabled} disabled={cr?.commentDisabled} onChange={(x) => setTk({ allowComment: x })} />
              <Toggle label="Duet" on={tk.allowDuet && !cr?.duetDisabled} disabled={cr?.duetDisabled} onChange={(x) => setTk({ allowDuet: x })} />
              <Toggle label="Stitch" on={tk.allowStitch && !cr?.stitchDisabled} disabled={cr?.stitchDisabled} onChange={(x) => setTk({ allowStitch: x })} />
            </div>
            <div style={kv}>
              <span className="ld-lbl">Disclose</span>
              <Toggle label="This video promotes a brand, product or service" on={tk.disclose} onChange={(x) => setTk({ disclose: x, yourBrand: x ? tk.yourBrand || !tk.brandedContent : tk.yourBrand })} />
              {tk.disclose && (
                <>
                  <label className="ld-row" style={{ fontSize: 14, gap: 8 }}>
                    <input type="checkbox" checked={tk.yourBrand} onChange={(e) => setTk({ yourBrand: e.target.checked })} /> Your brand
                  </label>
                  <label className="ld-row" style={{ fontSize: 14, gap: 8 }}>
                    <input type="checkbox" checked={tk.brandedContent} onChange={(e) => setTk({ brandedContent: e.target.checked, privacy: e.target.checked && tk.privacy === "SELF_ONLY" ? "" : tk.privacy })} /> Branded content
                  </label>
                  <span style={help}>
                    {tk.brandedContent ? 'TikTok labels the video "Paid partnership".' : tk.yourBrand ? 'TikTok labels the video "Promotional content".' : "Choose Your brand, Branded content, or both."}
                  </span>
                </>
              )}
            </div>
            <span style={help}>
              By posting, you agree to TikTok's{" "}
              {tk.disclose && tk.brandedContent && (
                <>
                  <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer noopener">Branded Content Policy</a> and{" "}
                </>
              )}
              <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer noopener">Music Usage Confirmation</a>.
            </span>
          </div>
        )}

        <div style={{ ...section }}>
          <span className="ld-lbl">When</span>
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "150px 130px 128px", gap: 8, alignItems: "center" }}>
            <input className="ld-in" aria-label="Date MM/DD/YYYY" placeholder="MM/DD/YYYY" value={d.date} onChange={(e) => set({ date: e.target.value })} />
            <select className="ld-in" aria-label="Time" value={d.time} onChange={(e) => set({ time: e.target.value })}>
              <option value="">Time</option>
              {!TIMES.includes(d.time) && d.time && <option value={d.time}>{d.time}</option>}
              {TIMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button type="button" className="ld-btn" disabled={suggest.isPending || d.channels.length === 0} onClick={() => suggest.mutate({ organizationId: currentOrgId, channels: d.channels, type: d.type, itemId: item?.id })}>
              {suggest.isPending ? "Thinking..." : "Suggest time"}
            </button>
          </div>
          {d.date && !dateValid(d.date) && <span style={{ ...help, color: "var(--ld-bad)" }}>Type the date as MM/DD/YYYY.</span>}
          <span style={help}>{reason ?? (item?.status === "scheduled" ? "Scheduled. It posts on its own at this time." : item?.status === "approved" ? (d.date ? "Approved. Goes on the calendar at this time." : "Approved. Pick a time to put it on the calendar.") : "Goes on the calendar once approved. Leave it blank to keep it in Drafts.")}</span>
          {(d.date || d.time) && (
            <button type="button" className="ld-btn sm" style={{ width: "auto", alignSelf: "flex-start" }} onClick={() => { set({ date: "", time: "" }); setReason(null); }}>
              Clear time
            </button>
          )}
        </div>
        <ErrorLine error={save.error || suggest.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending || !!busy || d.channels.length === 0 || (!!d.date && (!dateValid(d.date) || !d.time))} onClick={doSave}>
          {save.isPending ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          className="ld-btn"
          onClick={() => {
            if (item) {
              setD(draftOf(item, tz, preset));
              setEditing(false);
            }
            onClose?.();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
