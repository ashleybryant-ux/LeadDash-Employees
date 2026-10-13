import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { Outputs } from "../types";
import { useHoursAsk } from "../HoursAsk";
import { ErrorLine, FolderTabs } from "../ui";
import { uploadTo } from "./VideoAgent";
import { StylePicker, columnsFor, useStyles } from "./Styles";

/**
 * Edit my video on screen:
 * - EditUpload: upload a video of you talking (up to 30 minutes), sent in parts.
 * - VideoEditor: the rail (Style, Captions, AI Tools, B-rolls, Layout), the panel, and a live
 *   preview that shows every change before anything is cut; Export cuts every size.
 * - EditCard: the card under Elena's message.
 */

export type EV = NonNullable<Outputs["edits"]["get"]>;
type Opts = Outputs["edits"]["options"];
type Look = EV["look"];
type Line = EV["lines"][number];
type Pick = NonNullable<Line["broll"]>;
type Size = "vertical" | "square" | "wide";
type Patch = { captions?: Partial<Look["captions"]>; tools?: { autoBroll?: boolean; transitions?: boolean; zooms?: boolean; hook?: Partial<Look["tools"]["hook"]>; cleanAudio?: boolean; silences?: boolean; badTakes?: boolean; translate?: Partial<Look["tools"]["translate"]> }; music?: Partial<Look["music"]>; transition?: Partial<Look["transition"]>; layout?: { kind?: Look["layout"]["kind"]; split?: Partial<Look["layout"]["split"]>; green?: Partial<Look["layout"]["green"]>; pip?: Partial<Look["layout"]["pip"]> }; logo?: Partial<Look["logo"]> };

const RATIO: Record<Size, string> = { vertical: "9:16", square: "1:1", wide: "16:9" };
const ASPECT: Record<Size, string> = { vertical: "9 / 16", square: "1 / 1", wide: "16 / 9" };
const SIZE_KEYS: Size[] = ["vertical", "square", "wide"];
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const CORNERS = [
  { key: "tl", label: "Top left" },
  { key: "tr", label: "Top right" },
  { key: "bl", label: "Bottom left" },
  { key: "br", label: "Bottom right" },
] as const;

function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Sec({ title, editing, onEdit, children, right }: { title: string; editing?: boolean; onEdit?: () => void; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className={`ld-vm-sec ${editing ? "editing" : ""}`}>
      <div className="ld-vm-sec-hd">
        <b>{title}</b>
        {right ?? (!editing && onEdit && (
          <button type="button" className="ld-btn sm" onClick={onEdit}>Edit</button>
        ))}
      </div>
      {children}
    </div>
  );
}

function SaveRow({ onSave, onCancel, busy, disabled, label = "Save" }: { onSave: () => void; onCancel: () => void; busy?: boolean; disabled?: boolean; label?: string }) {
  return (
    <div className="ld-row" style={{ gap: 8 }}>
      <button type="button" className="ld-btn p sm" disabled={busy || disabled} onClick={onSave}>{busy ? "Saving..." : label}</button>
      <button type="button" className="ld-btn sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Plays a transition's sound (the files are made once on the server and cached by the browser). */
const sounds = new Map<string, HTMLAudioElement>();
function playSound(key: string | null | undefined, volume = 0.8) {
  if (!key || typeof Audio === "undefined") return;
  let a = sounds.get(key);
  if (!a) {
    a = new Audio(`/api/transition-sounds/${key}.mp3`);
    a.preload = "auto";
    sounds.set(key, a);
  }
  a.volume = volume;
  a.currentTime = 0;
  void a.play().catch(() => null);
}

// ==========================================
// Data
// ==========================================

export function useEdit(id: number) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.edits.get.useQuery(
    { organizationId: currentOrgId, id },
    {
      enabled: currentOrgId > 0,
      refetchInterval: (r) => {
        const d = r.state.data;
        return d && (d.status === "preparing" || d.status === "making" || d.step || d.cutout.cutting) ? 3000 : false;
      },
    }
  );
  const set = (v: EV) => {
    utils.edits.get.setData({ organizationId: currentOrgId, id }, v);
    void utils.edits.list.invalidate();
  };
  return { orgId: currentOrgId, v: q.data ?? null, loading: q.isLoading, set, utils };
}

export function useEditOptions() {
  const { currentOrgId } = useTenant();
  return trpc.edits.options.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, staleTime: 60_000 }).data ?? null;
}

// ==========================================
// Upload
// ==========================================

/** How long a video file runs, read in the browser before it's sent. */
function lengthOf(file: File) {
  return new Promise<number>((resolve) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      resolve(el.duration || 0);
      URL.revokeObjectURL(el.src);
    };
    el.onerror = () => resolve(0);
    el.src = URL.createObjectURL(file);
  });
}

/** A video sent in 40 MB parts, so any size gets past the web server's limit. */
async function uploadEdit(file: File, organizationId: number, onProgress: (sent: number) => void) {
  const PART = 40_000_000;
  const total = Math.max(1, Math.ceil(file.size / PART));
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const uploadId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  let data: any = null;
  for (let index = 0; index < total; index++) {
    const offset = index * PART;
    const q = new URLSearchParams({ organizationId: String(organizationId), name: file.name, uploadId, index: String(index), total: String(total), offset: String(offset) });
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`/api/upload/edit-part?${q.toString()}`, { method: "POST", body: file.slice(offset, offset + PART), credentials: "include", headers: { "content-type": "application/octet-stream" } }).catch(() => null);
      if (res && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    if (!res) throw new Error("The connection dropped while uploading. Check your internet and try again.");
    data = await res.json().catch(() => ({ error: "Upload failed." }));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    onProgress(Math.min(file.size, offset + PART) / file.size);
  }
  return data as { id: number };
}

/** Edit my video: the upload card on Elena's Videos tab. */
export function EditUpload({ onStarted, onCancel }: { onStarted: (id: number) => void; onCancel: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const ref = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [progress, setProgress] = React.useState(0);
  const [err, setErr] = React.useState<string | null>(null);
  const start = async (f: File | null) => {
    if (!f) return;
    setErr(null);
    if (!/\.(mp4|mov|m4v|webm)$/i.test(f.name)) return setErr("Upload an MP4 or MOV video.");
    const secs = await lengthOf(f);
    if (secs > 30 * 60 + 1) return setErr(`Videos can be up to 30 minutes. This one is ${fmt(secs)}.`);
    setFile(f);
    setProgress(0);
    try {
      const r = await uploadEdit(f, currentOrgId, setProgress);
      await utils.edits.list.invalidate();
      onStarted(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
      setFile(null);
    }
  };
  return (
    <div className="ld-card ld-ed-up">
      <div className="ld-ed-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), void start(e.dataTransfer.files?.[0] ?? null))}>
        <div>
          <b>Edit my video</b>
          <span>Upload a video of you talking. MP4 or MOV, up to 30 minutes. Elena writes the captions and gets it ready to edit.</span>
        </div>
        <div className="ld-row" style={{ gap: 8 }}>
          <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={!!file} onClick={() => ref.current?.click()}>Upload video</button>
          <button type="button" className="ld-btn" style={{ width: 150 }} disabled={!!file} onClick={onCancel}>Cancel</button>
        </div>
        <input ref={ref} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v" hidden onChange={(e) => (void start(e.target.files?.[0] ?? null), (e.target.value = ""))} />
      </div>
      {file && (
        <div className="ld-ed-uprow">
          <div className="ld-ed-upt">
            <b className="ld-clip">{file.name}</b>
            <span>Uploading {Math.round(progress * 100)}%</span>
            <span className="ld-ed-bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
          </div>
        </div>
      )}
      {err && <p role="alert" className="ld-small" style={{ color: "var(--ld-bad)", margin: 0 }}>{err}</p>}
    </div>
  );
}

// ==========================================
// The editor
// ==========================================

type RailKey = "style" | "captions" | "tools" | "broll" | "layout" | "export";
const RAIL: { key: RailKey; label: string }[] = [
  { key: "style", label: "Style" },
  { key: "captions", label: "Captions" },
  { key: "tools", label: "AI Tools" },
  { key: "broll", label: "B-rolls" },
  { key: "layout", label: "Layout" },
];

export function VideoEditor({ id, onRemoved }: { id: number; onRemoved?: () => void }) {
  const { orgId, v, loading, set } = useEdit(id);
  const opts = useEditOptions();
  const [tab, setTab] = React.useState<RailKey>("style");
  const [ratio, setRatio] = React.useState<Size | null>(null);
  const [sent, setSent] = React.useState(false);
  const sienna = trpc.edits.toSienna.useMutation({ onSuccess: () => setSent(true) });
  const remove = trpc.edits.remove.useMutation({ onSuccess: () => onRemoved?.() });
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  if (!v) return loading ? <div className="ld-empty">Loading...</div> : <div className="ld-empty">This video was removed.</div>;
  if (v.status === "preparing" || (v.status === "failed" && !v.lines.length)) {
    return (
      <div className="ld-card ld-ed-prep">
        <div className="ld-ed-uprow" style={{ border: 0, padding: 0 }}>
          {v.thumbUrl && <img src={v.thumbUrl} alt="" />}
          <div className="ld-ed-upt">
            <b>{v.title}</b>
            <span>{v.status === "failed" ? v.error : `${v.step ?? "Getting it ready"}...`}</span>
            {v.status !== "failed" && <span className="ld-dots" aria-hidden="true"><span /><span /><span /></span>}
          </div>
          {v.status === "failed" && <button type="button" className="ld-btn sm" onClick={() => remove.mutate({ organizationId: orgId, id: v.id })}>Remove</button>}
        </div>
      </div>
    );
  }
  const preview = ratio ?? v.sizes[0] ?? v.shape;
  const busy = v.status === "making" || !!v.step;
  return (
    <div className="ld-ed">
      <div className="ld-ed-top">
        <div className="ld-ed-t">
          <b>{v.title}</b>
          <span>{["Your video", v.outLength, v.ratios.join(" and ")].join(" · ")}</span>
        </div>
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {v.status === "ready" && (
            <button type="button" className="ld-btn" style={{ width: 140 }} disabled={sent || sienna.isPending} onClick={() => sienna.mutate({ organizationId: orgId, id: v.id })}>
              {sent ? "Sent to Sienna" : sienna.isPending ? "Sending..." : "Send to Sienna"}
            </button>
          )}
          <button type="button" className={`ld-btn ${tab === "export" ? "" : "p"}`} style={{ width: 140 }} onClick={() => setTab("export")}>Export</button>
        </div>
      </div>
      {(v.step || v.status === "making") && (
        <div className="ld-ed-busy" role="status">
          <span className="ld-dots" aria-hidden="true"><span /><span /><span /></span>
          {v.step ?? "Exporting"}...
        </div>
      )}
      {v.error && !busy && <p role="alert" className="ld-ed-err">{v.error}</p>}
      <ErrorLine error={sienna.error} />
      <div className="ld-ed-body">
        <nav className="ld-ed-rail" aria-label="Edit">
          {RAIL.map((r) => (
            <button key={r.key} type="button" className={`ld-ed-ri ${tab === r.key ? "on" : ""}`} aria-current={tab === r.key} onClick={() => setTab(r.key)}>
              {r.label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {confirmRemove ? (
            <span className="ld-ed-rm">
              <span className="ld-small">Remove this video?</span>
              <button type="button" className="ld-btn sm danger" onClick={() => remove.mutate({ organizationId: orgId, id: v.id })}>Remove</button>
              <button type="button" className="ld-btn sm" onClick={() => setConfirmRemove(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="ld-ed-ri" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove</button>
          )}
        </nav>
        <div className="ld-ed-panel">
          {!opts ? null : tab === "style" ? (
            <StylePanel v={v} opts={opts} set={set} />
          ) : tab === "captions" ? (
            <CaptionsPanel v={v} opts={opts} set={set} />
          ) : tab === "tools" ? (
            <ToolsPanel v={v} opts={opts} set={set} go={setTab} />
          ) : tab === "broll" ? (
            <BrollPanel v={v} opts={opts} set={set} size={preview} />
          ) : tab === "layout" ? (
            <LayoutPanel v={v} opts={opts} set={set} />
          ) : (
            <ExportPanel v={v} set={set} />
          )}
        </div>
        <div className="ld-ed-prevcol">
          <Preview v={v} opts={opts} size={preview} />
          <div className="ld-row" style={{ gap: 6 }}>
            {SIZE_KEYS.map((s) => (
              <Chip key={s} on={preview === s} onClick={() => setRatio(s)}>{RATIO[s]}</Chip>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Preview: the video with every edit shown live
// ==========================================

const CAP_PER: Record<string, number> = { pop: 3, gold: 4, boxed: 4, clean: 5, neon: 4, hook: 2, type: 6, highlight: 4, outline: 3, shadow: 3, pill: 5, lower: 7 };
const CAP_UPPER = new Set(["pop", "gold", "boxed", "neon", "hook", "highlight", "outline", "shadow"]);
type W = { text: string; start: number; end: number };

function spread(text: string, from: number, to: number): W[] {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  const weight = toks.map((t) => 1 + t.length / 6);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let at = from;
  return toks.map((t, i) => {
    const len = ((to - from) * weight[i]) / total;
    const w = { text: t, start: at, end: at + len };
    at += len;
    return w;
  });
}
function chunkOf(words: W[], per: number, t: number) {
  const chunks: W[][] = [];
  let cur: W[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= per || /[.!?,;:]["')\]]*$/.test(w.text)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    const end = Math.min(chunks[k + 1]?.[0]?.start ?? c[c.length - 1].end + 0.6, c[c.length - 1].end + 0.6);
    if (t >= c[0].start && t < end) return { words: c, at: c.findIndex((w, j) => t >= w.start && (j === c.length - 1 || t < c[j + 1].start)) };
  }
  return null;
}
const mapTime = (ranges: { from: number; to: number }[], t: number) => {
  let out = 0;
  for (const r of ranges) {
    if (t < r.from) return out;
    if (t <= r.to) return out + (t - r.from);
    out += r.to - r.from;
  }
  return out;
};
const unmap = (ranges: { from: number; to: number }[], o: number) => {
  let acc = 0;
  for (const r of ranges) {
    const len = r.to - r.from;
    if (o <= acc + len) return r.from + (o - acc);
    acc += len;
  }
  return ranges[ranges.length - 1]?.to ?? 0;
};

function ClipLayer({ pick, className }: { pick: Pick | null; className?: string }) {
  if (!pick) return null;
  return <video key={pick.file} className={className} src={pick.file} poster={pick.thumb ?? undefined} muted loop autoPlay playsInline />;
}

function Preview({ v, opts, size }: { v: EV; opts: Opts | null; size: Size }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const cutRef = React.useRef<HTMLVideoElement>(null);
  const [t, setT] = React.useState(v.ranges[0]?.from ?? 0);
  const [playing, setPlaying] = React.useState(false);
  const look = v.look;
  const ranges = v.ranges;
  const kept = React.useMemo(() => v.lines.filter((l) => !(look.tools.badTakes && l.drop)), [v.lines, look.tools.badTakes]);
  // Each transition's sound as the preview reaches it, when Sound is on.
  const lastT = React.useRef(0);
  const cues = React.useMemo(
    () => (look.tools.transitions && look.transition.sound ? kept
            .filter((l, k) => k > 0 && l.tr)
            .map((l) => {
              const o = opts?.transitions.find((x) => x.key === l.tr!.key);
              // Started early enough that its loudest moment lands on the change.
              return { at: Math.max(0, l.from - (o?.soundPeak ?? 0.3)), kind: o?.sound ? l.tr!.key : null };
            }) : []),
    [kept, look.tools.transitions, look.transition.sound, opts]
  );
  const cuesRef = React.useRef(cues);
  cuesRef.current = cues;
  // Skip what the cut takes out, so the preview plays like the finished video.
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const now = el.currentTime;
        if (!el.paused && now > lastT.current && now - lastT.current < 0.5) {
          for (const c of cuesRef.current) if (c.at > lastT.current && c.at <= now) playSound(c.kind, 0.5);
        }
        lastT.current = now;
        if (ranges.length && !el.paused) {
          const inside = ranges.some((r) => now >= r.from - 0.02 && now < r.to);
          if (!inside) {
            const next = ranges.find((r) => r.from > now);
            if (next) el.currentTime = next.from;
            else {
              el.pause();
              el.currentTime = ranges[0].from;
            }
          }
        }
        setT(el.currentTime);
        const c = cutRef.current;
        if (c && Math.abs(c.currentTime - el.currentTime) > 0.25) c.currentTime = el.currentTime;
        if (c && c.paused !== el.paused) void (el.paused ? c.pause() : c.play().catch(() => null));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ranges]);
  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      if (ranges.length && !ranges.some((r) => el.currentTime >= r.from && el.currentTime < r.to)) el.currentTime = ranges.find((r) => r.from > el.currentTime)?.from ?? ranges[0].from;
      void el.play();
    } else el.pause();
  };
  const out = mapTime(ranges, t);
  const total = v.outSeconds || 1;
  const pictureLine = [...kept].reverse().find((l) => l.from <= t + 0.01) ?? kept[0];
  const pick = pictureLine?.broll ?? null;
  const capLine = kept.find((l) => t >= l.from - 0.05 && t < l.to + 0.6);
  const style = look.captions.style;
  const words = capLine ? (look.tools.translate.on && capLine.tx ? spread(capLine.tx, capLine.from, capLine.to) : capLine.words) : [];
  const tall = size === "vertical";
  const chunk = look.captions.on && capLine ? chunkOf(words, tall ? CAP_PER[style] : CAP_PER[style] + 1, t) : null;
  const hi = look.captions.highlight === "none" ? null : look.captions.highlight === "brand" ? opts?.brandColor ?? "#F5C542" : "#F5C542";
  const lay = look.layout;
  const zoom = look.tools.zooms && pictureLine?.zoom && !pick;
  const green = lay.kind === "green" && v.cutout.ready && v.cutout.previewUrl;
  const split = lay.kind === "split" && (lay.split.when === "whole" || !!pick);
  const splitPick: Pick | null = lay.kind === "split" ? (lay.split.other === "video" && lay.split.videoUrl ? { src: "upload", file: lay.split.videoUrl, name: "Second video", thumb: null } : pick ?? kept.find((l) => l.broll)?.broll ?? null) : null;
  const youClass = split ? `ld-ed-you half ${lay.split.you}${size === "wide" ? " side" : ""}` : lay.kind === "pip" && pick ? `ld-ed-you pip ${lay.pip.corner}` : "ld-ed-you";
  const emoji = look.captions.on && look.captions.emojis && capLine?.emoji && opts?.emojis[capLine.emoji] ? String.fromCodePoint(parseInt(opts.emojis[capLine.emoji], 16)) : null;
  const bg = lay.green;
  return (
    <div className="ld-ed-prev">
      <div className={`ld-ed-phone ${size}`} style={{ aspectRatio: ASPECT[size] }}>
        {lay.kind === "green" && (
          <div className="ld-ed-bg" style={bg.bg === "color" ? { background: bg.color } : undefined}>
            {bg.bg === "picture" && bg.url && <img src={bg.url} alt="" />}
            {bg.bg === "style" && bg.drawn && <img src={bg.drawn} alt="" />}
          </div>
        )}
        <video
          ref={ref}
          className={`${youClass}${zoom ? " zoom" : ""}`}
          style={green ? { opacity: 0 } : undefined}
          src={v.previewUrl ?? undefined}
          poster={v.thumbUrl ?? undefined}
          playsInline
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={toggle}
        />
        {green && <video ref={cutRef} className={`ld-ed-you${zoom ? " zoom" : ""}`} src={v.cutout.previewUrl!} muted playsInline preload="auto" />}
        {lay.kind === "split" && split && <ClipLayer pick={splitPick} className={`ld-ed-clip half ${lay.split.you === "top" ? "bottom" : "top"}${size === "wide" ? " side" : ""}`} />}
        {lay.kind !== "split" && pick && <ClipLayer pick={pick} className="ld-ed-clip" />}
        {lay.kind === "pip" && pick && <span className={`ld-ed-pipframe ${lay.pip.corner}`} aria-hidden="true" />}
        {lay.kind === "pip" && pick && (
          <video
            className={`ld-ed-you pip ${lay.pip.corner}`}
            src={v.previewUrl ?? undefined}
            muted
            playsInline
            ref={(el) => {
              if (el && ref.current && Math.abs(el.currentTime - ref.current.currentTime) > 0.3) el.currentTime = ref.current.currentTime;
              if (el && ref.current) void (ref.current.paused ? el.pause() : el.play().catch(() => null));
            }}
          />
        )}
        {lay.kind === "green" && !green && <span className="ld-ed-badge">{v.cutout.cutting ? "Cutting you out..." : "Green screen shows once you're cut out"}</span>}
        {look.tools.hook.on && look.tools.hook.text && out < 3 && <span className="ld-ed-hook" style={opts?.brandColor ? { background: opts.brandColor } : undefined}>{look.tools.hook.text}</span>}
        {chunk && (
          <span className={`ld-ed-cap ${style} ${style === "lower" ? "" : look.captions.position} sz-${look.captions.size}`} style={{ ["--hi" as string]: hi ?? "#fff", ...(style === "lower" && opts?.brandColor ? { ["--brand" as string]: opts.brandColor } : {}) }}>
            {emoji && <span className="ld-ed-emoji">{emoji}</span>}
            {(style === "type" ? chunk.words.slice(0, chunk.at + 1) : chunk.words).map((w, j) => (
              <React.Fragment key={j}>
                {j > 0 && " "}
                <span className={j === chunk.at && hi && style !== "type" && style !== "lower" ? "on" : undefined}>{CAP_UPPER.has(style) ? w.text.toUpperCase() : w.text}</span>
              </React.Fragment>
            ))}
          </span>
        )}
        {look.logo.on && opts?.logoUrl && <img className={`ld-ed-logo ${look.logo.corner} ${look.logo.size}`} src={opts.logoUrl} alt="" />}
        <span className="ld-ed-pv">Preview</span>
      </div>
      <div className="ld-ed-pbar">
        <button type="button" className="ld-ed-play" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? "❚❚" : "▶"}</button>
        <span className="ld-ed-ptime">{fmt(out)} / {v.outLength}</span>
        <input
          type="range"
          className="ld-ed-track"
          aria-label="Where in the video"
          min={0}
          max={Math.round(total * 10)}
          value={Math.round(out * 10)}
          onChange={(e) => {
            const el = ref.current;
            if (el) el.currentTime = unmap(ranges, Number(e.target.value) / 10);
          }}
        />
      </div>
    </div>
  );
}

// ==========================================
// Style: the look of the captions
// ==========================================

function useChange(v: EV, set: (v: EV) => void) {
  const { currentOrgId } = useTenant();
  const m = trpc.edits.changeLook.useMutation({ onSuccess: set });
  return { m, save: (patch: Patch, after?: () => void) => m.mutate({ organizationId: currentOrgId, id: v.id, ...(patch as object) } as never, { onSuccess: () => after?.() }) };
}

const POS = [
  { key: "top", label: "Top" },
  { key: "middle", label: "Middle" },
  { key: "bottom", label: "Bottom" },
] as const;
const HI = [
  { key: "gold", label: "Gold" },
  { key: "brand", label: "Brand color" },
  { key: "none", label: "None" },
] as const;
const SZ = [
  { key: "s", label: "Small" },
  { key: "m", label: "Medium" },
  { key: "l", label: "Large" },
] as const;

function StylePanel({ v, opts, set }: { v: EV; opts: Opts; set: (v: EV) => void }) {
  const { m, save } = useChange(v, set);
  const [group, setGroup] = React.useState<"All" | "Bold" | "Clean" | "Boxed">("All");
  const [edit, setEdit] = React.useState<Look["captions"] | null>(null);
  const c = v.look.captions;
  const label = opts.captionStyles.find((s) => s.key === c.style)?.label ?? "Captions";
  const shown = opts.captionStyles.filter((s) => group === "All" || s.group === group);
  const d = edit ?? c;
  const text = c.style === "lower" ? "Bottom left" : POS.find((p) => p.key === c.position)?.label;
  return (
    <>
      <FolderTabs tabs={(["All", "Bold", "Clean", "Boxed"] as const).map((k) => ({ key: k, label: k }))} value={group} onChange={setGroup}>
        <div className="ld-ed-csgrid">
          {shown.map((s) => (
            <button key={s.key} type="button" className={`ld-ed-cs ${c.style === s.key ? "on" : ""}`} aria-pressed={c.style === s.key} disabled={m.isPending} onClick={() => save({ captions: { style: s.key as Look["captions"]["style"], on: true } })}>
              <span className={`ld-ed-csx ${s.key}`}>{s.label}</span>
            </button>
          ))}
        </div>
      </FolderTabs>
      <Sec title={c.on ? label : "Captions are off"} editing={!!edit} onEdit={() => setEdit({ ...c })}>
        {!edit ? (
          <span className="ld-ed-kvv">{c.on ? `${text}, ${HI.find((h) => h.key === c.highlight)?.label.toLowerCase()} highlight, ${SZ.find((s) => s.key === c.size)?.label.toLowerCase()}, emojis ${c.emojis ? "on" : "off"}` : "Turn them on under AI Tools, or pick a style above."}</span>
        ) : (
          <>
            <div className="ld-ed-kv">
              {c.style !== "lower" && (
                <>
                  <span>Position</span>
                  <div className="ld-row">{POS.map((p) => <Chip key={p.key} on={d.position === p.key} onClick={() => setEdit({ ...d, position: p.key })}>{p.label}</Chip>)}</div>
                </>
              )}
              <span>Highlight</span>
              <div className="ld-row">{HI.map((h) => <Chip key={h.key} on={d.highlight === h.key} onClick={() => setEdit({ ...d, highlight: h.key })}>{h.label}</Chip>)}</div>
              <span>Size</span>
              <div className="ld-row">{SZ.map((s) => <Chip key={s.key} on={d.size === s.key} onClick={() => setEdit({ ...d, size: s.key })}>{s.label}</Chip>)}</div>
              <span>Emojis</span>
              <div className="ld-row">
                <Chip on={d.emojis} onClick={() => setEdit({ ...d, emojis: true })}>On</Chip>
                <Chip on={!d.emojis} onClick={() => setEdit({ ...d, emojis: false })}>Off</Chip>
              </div>
            </div>
            <SaveRow busy={m.isPending} onSave={() => save({ captions: { position: d.position, highlight: d.highlight, size: d.size, emojis: d.emojis } }, () => setEdit(null))} onCancel={() => setEdit(null)} />
          </>
        )}
      </Sec>
      <ErrorLine error={m.error} />
    </>
  );
}

// ==========================================
// Captions: fix a word
// ==========================================

function CaptionsPanel({ v, opts, set }: { v: EV; opts: Opts; set: (v: EV) => void }) {
  const { currentOrgId } = useTenant();
  const { m, save } = useChange(v, set);
  const line = trpc.edits.saveLine.useMutation({ onSuccess: (r) => (set(r), setOpen(null)) });
  const [open, setOpen] = React.useState<number | null>(null);
  const [text, setText] = React.useState("");
  const [lang, setLang] = React.useState<{ on: boolean; lang: string } | null>(null);
  const tr = v.look.tools.translate;
  const busy = !!v.step || v.status === "making";
  return (
    <>
      <Sec title="Language" editing={!!lang} onEdit={() => setLang({ on: tr.on, lang: tr.lang })}>
        {!lang ? (
          <span className="ld-ed-kvv">{tr.on ? `${tr.lang}, translated` : "English, as spoken"}</span>
        ) : (
          <>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              <Chip on={!lang.on} onClick={() => setLang({ ...lang, on: false })}>As spoken</Chip>
              <Chip on={lang.on} onClick={() => setLang({ ...lang, on: true })}>Translate</Chip>
              {lang.on && (
                <select className="ld-in" style={{ width: 200 }} aria-label="Language" value={lang.lang} onChange={(e) => setLang({ ...lang, lang: e.target.value })}>
                  {opts.languages.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              )}
            </div>
            <SaveRow busy={m.isPending} onSave={() => save({ tools: { translate: lang } }, () => setLang(null))} onCancel={() => setLang(null)} />
          </>
        )}
      </Sec>
      <ErrorLine error={m.error} />
      <p className="ld-ed-note">Fix a word Elena heard wrong. The voice stays as you said it.</p>
      <div className="ld-ed-lines">
        {v.lines.map((l) => (
          <React.Fragment key={l.i}>
            <div className={`ld-ed-line ${open === l.i ? "open" : ""}`}>
              <span className="ld-ed-lt">{fmt(l.from)}</span>
              <span className="ld-ed-ltx">
                {l.text}
                {tr.on && l.tx && <em>{l.tx}</em>}
                {v.look.tools.badTakes && l.drop && <span className="ld-pill amber" style={{ marginLeft: 8 }}>Bad take, cut</span>}
              </span>
              <button type="button" className="ld-btn sm" disabled={busy && open !== l.i} onClick={() => (open === l.i ? setOpen(null) : (setOpen(l.i), setText(l.text)))}>{open === l.i ? "Close" : "Edit"}</button>
            </div>
            {open === l.i && (
              <div className="ld-ed-lineed">
                <label className="ld-lbl" htmlFor={`ln-${l.i}`}>Words on screen</label>
                <input id={`ln-${l.i}`} className="ld-in" value={text} maxLength={400} onChange={(e) => setText(e.target.value)} />
                <ErrorLine error={line.error} />
                <SaveRow busy={line.isPending} disabled={!text.trim()} onSave={() => line.mutate({ organizationId: currentOrgId, id: v.id, n: l.i, text })} onCancel={() => setOpen(null)} />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

// ==========================================
// AI Tools
// ==========================================

function Tool({ name, note, on, onToggle, busy, children, hours }: { name: string; note: string; on: boolean; onToggle: () => void; busy?: boolean; children?: React.ReactNode; hours?: string }) {
  return (
    <div className="ld-ed-tool">
      <div className="ld-ed-tt">
        <b>
          {name}
          {on && <span className="ld-pill green" style={{ marginLeft: 8 }}>On</span>}
        </b>
        <span>{note}{hours ? ` · ${hours}` : ""}</span>
        {children}
      </div>
      <button type="button" className="ld-btn" style={{ width: 140 }} disabled={busy} onClick={onToggle}>{on ? "Turn off" : "Turn on"}</button>
    </div>
  );
}

function ToolsPanel({ v, opts, set, go }: { v: EV; opts: Opts; set: (v: EV) => void; go: (k: RailKey) => void }) {
  const { currentOrgId } = useTenant();
  const { m, save } = useChange(v, set);
  const clips = trpc.edits.shortClips.useMutation({ onSuccess: set });
  const t = v.look.tools;
  const [hook, setHook] = React.useState<string | null>(null);
  const [music, setMusic] = React.useState<Look["music"] | null>(null);
  const [lang, setLang] = React.useState<string | null>(null);
  const [upErr, setUpErr] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const busy = m.isPending || !!v.step || v.status === "making";
  const mu = v.look.music;
  const trackName = mu.track === "upload" ? mu.name || "My track" : opts.tracks.find((x) => x.key === mu.track)?.name;
  const upload = async (f: File | null) => {
    if (!f || !music) return;
    setUpErr(null);
    setUploading(true);
    try {
      const r = await uploadTo<{ url: string; name: string }>("music", currentOrgId, f);
      setMusic({ ...music, track: "upload", url: r.url, name: r.name });
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };
  return (
    <>
      <div className="ld-ed-tg">
        <span className="ld-lbl">Hook them</span>
        <Tool name="Captions" note="Word by word, timed to your voice" on={v.look.captions.on} busy={busy} onToggle={() => save({ captions: { on: !v.look.captions.on } })} />
        <Tool name="Auto b-roll" note="Elena picks the lines and adds footage" hours="library and stock use no hours" on={t.autoBroll} busy={busy} onToggle={() => save({ tools: { autoBroll: !t.autoBroll } })} />
        <Tool name="Transitions" note="A transition at every change between you and b-roll" on={t.transitions} busy={busy} onToggle={() => save({ tools: { transitions: !t.transitions } })} />
        <Tool name="Auto zooms" note="Punch in on key points" on={t.zooms} busy={busy} onToggle={() => save({ tools: { zooms: !t.zooms } })} />
        <Tool name="Hook title" note="A bold line over the first 3 seconds" on={t.hook.on} busy={busy} onToggle={() => (t.hook.on ? save({ tools: { hook: { on: false } } }) : setHook(t.hook.text))}>
          {t.hook.on && hook === null && (
            <span className="ld-row" style={{ gap: 8 }}>
              <span className="ld-ed-kvv">"{t.hook.text}"</span>
              <button type="button" className="ld-btn sm" onClick={() => setHook(t.hook.text)}>Edit</button>
            </span>
          )}
          {hook !== null && (
            <span className="ld-ed-inline">
              <input className="ld-in" aria-label="Hook title" maxLength={80} value={hook} onChange={(e) => setHook(e.target.value)} />
              <SaveRow busy={m.isPending} disabled={!hook.trim()} onSave={() => save({ tools: { hook: { on: true, text: hook.trim() } } }, () => setHook(null))} onCancel={() => setHook(null)} />
            </span>
          )}
        </Tool>
      </div>
      <div className="ld-ed-tg">
        <span className="ld-lbl">Sound good</span>
        <Tool name="Clean audio" note="Less room echo and hum, even volume" on={t.cleanAudio} busy={busy} onToggle={() => save({ tools: { cleanAudio: !t.cleanAudio } })} />
        <Tool name="Remove silences" note="Cut pauses longer than half a second" on={t.silences} busy={busy} onToggle={() => save({ tools: { silences: !t.silences } })} />
        <Tool name="Music" note="Low under your voice" on={mu.on} busy={busy} onToggle={() => (mu.on ? save({ music: { on: false } }) : setMusic({ ...mu, on: true }))}>
          {mu.on && music === null && (
            <span className="ld-row" style={{ gap: 8 }}>
              <span className="ld-ed-kvv">{trackName}, volume {mu.volume}</span>
              <button type="button" className="ld-btn sm" onClick={() => setMusic({ ...mu })}>Edit</button>
            </span>
          )}
          {music && (
            <span className="ld-ed-inline">
              <span className="ld-row" style={{ flexWrap: "wrap" }}>
                {opts.tracks.map((x) => <Chip key={x.key} on={music.track === x.key} onClick={() => setMusic({ ...music, track: x.key as Look["music"]["track"] })}>{x.name}</Chip>)}
                <Chip on={music.track === "upload"} disabled={uploading} onClick={() => document.getElementById(`mu-${v.id}`)?.click()}>{uploading ? "Uploading..." : music.track === "upload" ? music.name || "My track" : "Upload track"}</Chip>
                <input id={`mu-${v.id}`} type="file" accept="audio/*,.mp3,.m4a,.wav" hidden onChange={(e) => (void upload(e.target.files?.[0] ?? null), (e.target.value = ""))} />
              </span>
              <label className="ld-row" style={{ gap: 10 }}>
                <span className="ld-small">Volume</span>
                <input type="range" min={5} max={40} value={music.volume} onChange={(e) => setMusic({ ...music, volume: Number(e.target.value) })} aria-label="Music volume" />
                <span className="ld-small">{music.volume}</span>
              </label>
              {upErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{upErr}</span>}
              <SaveRow busy={m.isPending} disabled={uploading || (music.track === "upload" && !music.url)} onSave={() => save({ music: { ...music, on: true } }, () => setMusic(null))} onCancel={() => setMusic(null)} />
            </span>
          )}
        </Tool>
      </div>
      <div className="ld-ed-tg">
        <span className="ld-lbl">Look good</span>
        <Tool name="Remove bad takes" note={v.dropCount ? `Keep the last take when you repeat a line (${v.dropCount} found)` : "Keep the last take when you repeat a line"} on={t.badTakes} busy={busy} onToggle={() => save({ tools: { badTakes: !t.badTakes } })} />
        <Tool name="Translate captions" note={t.translate.on ? `Captions in ${t.translate.lang}` : `${opts.languages.slice(0, 2).join(", ")} and ${opts.languages.length - 2} more`} on={t.translate.on} busy={busy} onToggle={() => (t.translate.on ? save({ tools: { translate: { on: false } } }) : setLang(t.translate.lang))}>
          {lang !== null && (
            <span className="ld-ed-inline">
              <select className="ld-in" style={{ maxWidth: 240 }} aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
                {opts.languages.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <SaveRow busy={m.isPending} onSave={() => save({ tools: { translate: { on: true, lang } } }, () => setLang(null))} onCancel={() => setLang(null)} />
            </span>
          )}
        </Tool>
        <div className="ld-ed-tool">
          <div className="ld-ed-tt">
            <b>Short clips</b>
            <span>{v.seconds < 45 ? "For videos over 45 seconds: Elena finds the best 30 to 60 seconds to post" : `Elena finds the best 30 to 60 seconds to post, as their own videos · ${opts.editHoursPerMinute} work hours each to export`}</span>
          </div>
          <button type="button" className="ld-btn" style={{ width: 140 }} disabled={busy || clips.isPending || v.seconds < 45} onClick={() => clips.mutate({ organizationId: currentOrgId, id: v.id })}>Find clips</button>
        </div>
      </div>
      <p className="ld-ed-note">
        Caption style is on <button type="button" className="ld-ed-link" onClick={() => go("style")}>Style</button>. B-roll and transitions are on <button type="button" className="ld-ed-link" onClick={() => go("broll")}>B-rolls</button>.
      </p>
      <ErrorLine error={m.error ?? clips.error} />
    </>
  );
}

// ==========================================
// B-rolls: by line, with transitions
// ==========================================

function BrollPanel({ v, opts, set, size }: { v: EV; opts: Opts; set: (v: EV) => void; size: Size }) {
  const { currentOrgId } = useTenant();
  const { m, save } = useChange(v, set);
  const redo = trpc.edits.redoAutoBroll.useMutation({ onSuccess: set });
  const remove = trpc.edits.setBroll.useMutation({ onSuccess: set });
  const [open, setOpen] = React.useState<{ kind: "broll" | "tr"; n: number } | null>(null);
  const [speed, setSpeed] = React.useState<Look["transition"]["speed"] | null>(null);
  const [sound, setSound] = React.useState(true);
  const busy = !!v.step || v.status === "making";
  const sp = v.look.transition.speed;
  const snd = v.look.transition.sound !== false;
  const SPEEDS = [
    { key: "quick", label: "Quick" },
    { key: "normal", label: "Normal" },
    { key: "slow", label: "Slow" },
  ] as const;
  return (
    <>
      <div className="ld-ed-autobox">
        <div>
          <b>{v.look.tools.autoBroll ? `Elena added b-roll to ${v.autoCount} of ${v.lines.length} lines` : "Auto b-roll is off"}</b>
          <span>{v.look.tools.autoBroll ? "She picked lines that describe something you can show, and kept you on screen for the rest." : "Add b-roll to any line below, or turn Auto b-roll on under AI Tools."}{v.look.tools.transitions ? " Every change has a transition." : ""}</span>
        </div>
        <button type="button" className="ld-btn" style={{ width: 160 }} disabled={busy || redo.isPending || !v.look.tools.autoBroll} onClick={() => redo.mutate({ organizationId: currentOrgId, id: v.id })}>Redo auto b-roll</button>
      </div>
      <Sec title="Transitions" editing={!!speed} onEdit={() => (setSpeed(sp), setSound(snd))}>
        {!speed ? (
          v.look.tools.transitions ? (
            <div className="ld-ed-kv">
              <span>Speed</span>
              <span className="ld-ed-kvv">{SPEEDS.find((s) => s.key === sp)?.label}</span>
              <span>Sound</span>
              <span className="ld-ed-kvv">{snd ? "On" : "Off"}</span>
            </div>
          ) : (
            <span className="ld-ed-kvv">Off: straight cuts. Turn them on under AI Tools.</span>
          )
        ) : (
          <>
            <div className="ld-ed-kv">
              <span>Speed</span>
              <div className="ld-row">{SPEEDS.map((s) => <Chip key={s.key} on={speed === s.key} onClick={() => setSpeed(s.key)}>{s.label}</Chip>)}</div>
              <span>Sound</span>
              <div className="ld-row">
                <Chip on={sound} onClick={() => setSound(true)}>On</Chip>
                <Chip on={!sound} onClick={() => setSound(false)}>Off</Chip>
              </div>
            </div>
            <SaveRow busy={m.isPending} onSave={() => save({ transition: { speed, sound } }, () => setSpeed(null))} onCancel={() => setSpeed(null)} />
          </>
        )}
      </Sec>
      <ErrorLine error={m.error ?? redo.error ?? remove.error} />
      <div className="ld-ed-lines">
        {v.lines.map((l) => (
          <React.Fragment key={l.i}>
            {l.tr && v.look.tools.transitions && (
              <>
                <div className="ld-ed-tr">
                  <span className="ld-ed-trl" />
                  <button type="button" className={`ld-ed-trb ${open?.kind === "tr" && open.n === l.i ? "on" : ""}`} disabled={busy} aria-expanded={open?.kind === "tr" && open.n === l.i} onClick={() => setOpen(open?.kind === "tr" && open.n === l.i ? null : { kind: "tr", n: l.i })}>
                    <span aria-hidden="true">⇄</span>
                    {l.tr.label}
                    {l.tr.auto && <span className="ld-ed-trby">Elena</span>}
                  </button>
                  <span className="ld-ed-trl" />
                </div>
                {open?.kind === "tr" && open.n === l.i && <TransitionPicker v={v} opts={opts} n={l.i} set={set} onClose={() => setOpen(null)} />}
              </>
            )}
            <div className={`ld-ed-bl ${open?.kind === "broll" && open.n === l.i ? "open" : ""} ${v.look.tools.badTakes && l.drop ? "cut" : ""}`}>
              <span className="ld-ed-lt">{l.time}</span>
              <div className="ld-ed-blmain">
                <span className="ld-ed-ltx">{l.text}</span>
                <div className="ld-ed-blrow">
                  {l.broll ? (
                    <span className="ld-ed-bch b">
                      {l.broll.thumb ? <img src={l.broll.thumb} alt="" /> : <i />}
                      <span className="ld-clip">{l.broll.name}{l.broll.src === "stock" ? " · stock" : ""}</span>
                    </span>
                  ) : (
                    <span className="ld-ed-bch">{v.thumbUrl ? <img src={v.thumbUrl} alt="" /> : <i />}You</span>
                  )}
                  {l.broll && l.auto && <span className="ld-pill blue">Added by Elena</span>}
                </div>
              </div>
              <div className="ld-ed-btns">
                <button type="button" className="ld-btn sm" disabled={busy} aria-expanded={open?.kind === "broll" && open.n === l.i} onClick={() => setOpen(open?.kind === "broll" && open.n === l.i ? null : { kind: "broll", n: l.i })}>
                  {open?.kind === "broll" && open.n === l.i ? "Close" : l.broll ? "Change" : "Add b-roll"}
                </button>
                {l.broll && <button type="button" className="ld-btn sm" disabled={busy || remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: v.id, n: l.i, pick: { src: "none" } })}>Remove</button>}
              </div>
            </div>
            {open?.kind === "broll" && open.n === l.i && <BrollPicker v={v} opts={opts} n={l.i} size={size} set={set} onClose={() => setOpen(null)} />}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

/** Columns that leave no picture alone in the last row. */
const cols = (n: number) => ({ ["--cols" as string]: String(columnsFor(n, [4, 5, 3])), ["--cols-sm" as string]: String(columnsFor(n, [2, 3])) });

function BrollPicker({ v, opts, n, size, set, onClose }: { v: EV; opts: Opts; n: number; size: Size; set: (v: EV) => void; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const hours = useHoursAsk();
  const line = v.lines[n];
  const lib = trpc.broll.list.useQuery({ organizationId: currentOrgId });
  const [tab, setTab] = React.useState<"library" | "stock" | "ai" | "upload">("library");
  const [chosen, setChosen] = React.useState<{ src: "library"; clipId: number } | { src: "stock"; url: string; page: string; thumb: string; credit: string; query: string } | null>(line.broll?.clipId ? { src: "library", clipId: line.broll.clipId } : null);
  const [query, setQuery] = React.useState(line.broll?.src === "stock" ? line.broll.name : line.text.split(/\s+/).slice(0, 4).join(" "));
  const [search, setSearch] = React.useState(query);
  const stock = trpc.edits.stock.useQuery({ organizationId: currentOrgId, query: search, size }, { enabled: tab === "stock" && opts.stock && search.trim().length > 0, staleTime: 5 * 60_000 });
  const [see, setSee] = React.useState(line.text);
  const [upErr, setUpErr] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const pick = trpc.edits.setBroll.useMutation({ onSuccess: (r) => (set(r), onClose()) });
  const ai = trpc.edits.aiClip.useMutation({ onSuccess: (r) => (set(r), onClose()) });
  const clips = (lib.data?.clips ?? []).filter((c) => c.status === "ready");
  const upload = async (f: File | null) => {
    if (!f) return;
    setUpErr(null);
    setUploading(true);
    try {
      const c = await uploadTo<{ id: number }>("broll", currentOrgId, f);
      await lib.refetch();
      setChosen({ src: "library", clipId: c.id });
      setTab("library");
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };
  const tabs = [
    { key: "library" as const, label: "Your b-roll" },
    { key: "stock" as const, label: "Stock" },
    { key: "ai" as const, label: "New AI clip" },
    { key: "upload" as const, label: "Upload" },
  ];
  const secs = line.to - line.from > 5.5 ? 10 : 5;
  return (
    <div className="ld-ed-pick">
      <FolderTabs tabs={tabs} value={tab} onChange={setTab}>
        <div className="ld-ed-pickbody">
          {tab === "library" &&
            (clips.length ? (
              <div className="ld-ed-thumbs" style={cols(clips.length)}>
                {clips.map((c) => (
                  <button key={c.id} type="button" className={`ld-ed-th ${chosen?.src === "library" && chosen.clipId === c.id ? "on" : ""}`} aria-pressed={chosen?.src === "library" && chosen.clipId === c.id} onClick={() => setChosen({ src: "library", clipId: c.id })}>
                    {c.thumbUrl ? <img src={c.thumbUrl} alt="" /> : <i />}
                    <b className="ld-clip">{c.title}</b>
                  </button>
                ))}
              </div>
            ) : (
              <span className="ld-ed-kvv">No clips in your library yet. Use Stock, a new AI clip, or Upload.</span>
            ))}
          {tab === "stock" &&
            (!opts.stock ? (
              <span className="ld-ed-kvv">Stock footage isn't set up on the server yet. LeadDash support can turn it on.</span>
            ) : (
              <>
                <form className="ld-row" style={{ gap: 8 }} onSubmit={(e) => (e.preventDefault(), setSearch(query.trim()))}>
                  <input className="ld-in" aria-label="Search stock" value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
                  <button type="submit" className="ld-btn sm">Search</button>
                </form>
                {stock.isFetching ? (
                  <span className="ld-ed-kvv">Searching...</span>
                ) : (stock.data ?? []).length ? (
                  <div className="ld-ed-thumbs" style={cols((stock.data ?? []).length)}>
                    {(stock.data ?? []).map((s) => (
                      <button key={s.url} type="button" className={`ld-ed-th ${chosen?.src === "stock" && chosen.url === s.url ? "on" : ""}`} aria-pressed={chosen?.src === "stock" && chosen.url === s.url} onClick={() => setChosen({ src: "stock", url: s.url, page: s.page, thumb: s.thumb, credit: s.credit, query: search })}>
                        <img src={s.thumb} alt="" />
                        <b className="ld-clip">{s.credit}</b>
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="ld-ed-kvv">No stock clips for that. Try other words.</span>
                )}
              </>
            ))}
          {tab === "ai" && (
            <>
              <label className="ld-lbl" htmlFor={`see-${n}`}>What the clip shows</label>
              <textarea id={`see-${n}`} className="ld-ta" rows={2} maxLength={600} value={see} onChange={(e) => setSee(e.target.value)} />
              <span className="ld-ed-kvv">A {secs} second clip, saved to your library. Uses {opts.clipHours * (secs === 10 ? 2 : 1)} work hours.</span>
              {hours.question(`ai-${v.id}-${n}`)}
            </>
          )}
          {tab === "upload" && (
            <>
              <span className="ld-ed-kvv">An MP4 or MOV clip up to 60 seconds. It's saved to your library too.</span>
              <div className="ld-row">
                <button type="button" className="ld-btn" style={{ width: 150 }} disabled={uploading} onClick={() => document.getElementById(`br-${v.id}-${n}`)?.click()}>{uploading ? "Uploading..." : "Upload clip"}</button>
              </div>
              <input id={`br-${v.id}-${n}`} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" hidden onChange={(e) => (void upload(e.target.files?.[0] ?? null), (e.target.value = ""))} />
              {upErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{upErr}</span>}
            </>
          )}
        </div>
      </FolderTabs>
      <ErrorLine error={pick.error ?? ai.error} />
      {tab === "ai" ? (
        <SaveRow
          label="Make clip"
          busy={ai.isPending}
          disabled={!see.trim()}
          onSave={() => hours.confirm(`ai-${v.id}-${n}`, `A new AI clip uses ${opts.clipHours * (secs === 10 ? 2 : 1)} work hours`, () => ai.mutate({ organizationId: currentOrgId, id: v.id, n, see }))}
          onCancel={onClose}
        />
      ) : (
        <SaveRow busy={pick.isPending} disabled={!chosen || tab === "upload"} onSave={() => chosen && pick.mutate({ organizationId: currentOrgId, id: v.id, n, pick: chosen })} onCancel={onClose} />
      )}
    </div>
  );
}

/** The transition picker: every effect as a playing tile (hover plays it), with speed and where to use it. */
function TransitionPicker({ v, opts, n, set, onClose }: { v: EV; opts: Opts; n: number; set: (v: EV) => void; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const line = v.lines[n];
  const prev = [...v.lines.slice(0, n)].reverse().find((l) => !(v.look.tools.badTakes && l.drop));
  const fromImg = prev?.broll?.thumb ?? v.thumbUrl ?? "";
  const toImg = line.broll?.thumb ?? v.thumbUrl ?? "";
  const [group, setGroup] = React.useState<"All" | "Simple" | "Motion" | "Effects">("All");
  const [key, setKey] = React.useState<string>(line.tr?.key ?? "fade");
  const [speed, setSpeed] = React.useState(v.look.transition.speed);
  const [every, setEvery] = React.useState(false);
  const soundOn = v.look.transition.sound !== false;
  const save = trpc.edits.setTransition.useMutation({ onSuccess: (r) => (set(r), onClose()) });
  const shown = opts.transitions.filter((t) => group === "All" || t.group === group);
  const current = line.tr?.key;
  return (
    <div className="ld-ed-pick">
      <div className="ld-vm-sec-hd">
        <b>Transition {line.broll ? "into b-roll" : "back to you"}</b>
        <span className="ld-small ld-muted">{fmt(line.from)} · {soundOn ? "hover to play, click to hear" : "hover a tile to play it"}</span>
      </div>
      <FolderTabs tabs={(["All", "Simple", "Motion", "Effects"] as const).map((k) => ({ key: k, label: k }))} value={group} onChange={setGroup}>
        <div className="ld-ed-trgrid" style={{ ["--a" as string]: `url("${fromImg}")`, ["--b" as string]: `url("${toImg}")` }}>
          {shown.map((t) => (
            <button key={t.key} type="button" className={`ld-tx ${key === t.key ? "on" : ""}`} aria-pressed={key === t.key} onClick={() => (setKey(t.key), soundOn && t.sound && playSound(t.key))}>
              {current === t.key && <span className="cur">Current</span>}
              <span className={`tp e-${t.key}`}>
                <i className="a" />
                <i className="b" />
                <i className="f" />
              </span>
              <b>{t.label}</b>
            </button>
          ))}
        </div>
      </FolderTabs>
      <div className="ld-ed-kv">
        <span>Speed</span>
        <div className="ld-row">
          <Chip on={speed === "quick"} onClick={() => setSpeed("quick")}>Quick</Chip>
          <Chip on={speed === "normal"} onClick={() => setSpeed("normal")}>Normal</Chip>
          <Chip on={speed === "slow"} onClick={() => setSpeed("slow")}>Slow</Chip>
        </div>
        <span>Use for</span>
        <div className="ld-row">
          <Chip on={!every} onClick={() => setEvery(false)}>This change</Chip>
          <Chip on={every} onClick={() => setEvery(true)}>Every change</Chip>
        </div>
      </div>
      <ErrorLine error={save.error} />
      <SaveRow busy={save.isPending} onSave={() => save.mutate({ organizationId: currentOrgId, id: v.id, n, key, every, speed })} onCancel={onClose} />
    </div>
  );
}

// ==========================================
// Layout: split screen, green screen, picture in picture
// ==========================================

const LAYOUTS = [
  { key: "full", label: "Full screen", note: "Just you" },
  { key: "split", label: "Split screen", note: "You and b-roll, half each" },
  { key: "green", label: "Green screen", note: "You over any background" },
  { key: "pip", label: "Picture in picture", note: "B-roll with you in a corner" },
] as const;

function LayoutIcon({ k }: { k: string }) {
  if (k === "split") return <svg viewBox="0 0 36 64" aria-hidden="true"><rect x="1" y="1" width="34" height="30" rx="4" fill="#cfe5d8" /><circle cx="18" cy="13" r="5" fill="#1b6b4a" /><rect x="11" y="19" width="14" height="10" rx="5" fill="#1b6b4a" /><rect x="1" y="33" width="34" height="30" rx="4" fill="#f3d39c" /></svg>;
  if (k === "green") return <svg viewBox="0 0 36 64" aria-hidden="true"><rect x="1" y="1" width="34" height="62" rx="4" fill="#f3d39c" /><circle cx="18" cy="30" r="7" fill="#1b6b4a" /><rect x="8" y="39" width="20" height="24" rx="9" fill="#1b6b4a" /></svg>;
  if (k === "pip") return <svg viewBox="0 0 36 64" aria-hidden="true"><rect x="1" y="1" width="34" height="62" rx="4" fill="#f3d39c" /><rect x="19" y="44" width="13" height="16" rx="3" fill="#cfe5d8" /><circle cx="25.5" cy="50" r="3" fill="#1b6b4a" /></svg>;
  return <svg viewBox="0 0 36 64" aria-hidden="true"><rect x="1" y="1" width="34" height="62" rx="4" fill="#cfe5d8" /><circle cx="18" cy="26" r="7" fill="#1b6b4a" /><rect x="8" y="35" width="20" height="18" rx="9" fill="#1b6b4a" /></svg>;
}

function LayoutPanel({ v, opts, set }: { v: EV; opts: Opts; set: (v: EV) => void }) {
  const { currentOrgId } = useTenant();
  const { m, save } = useChange(v, set);
  const retry = trpc.edits.retryCutout.useMutation({ onSuccess: set });
  const hours = useHoursAsk();
  const lib = trpc.broll.list.useQuery({ organizationId: currentOrgId });
  const st = useStyles();
  const lay = v.look.layout;
  const [d, setD] = React.useState<Look["layout"] | null>(null);
  const [picking, setPicking] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [upErr, setUpErr] = React.useState<string | null>(null);
  const clips = (lib.data?.clips ?? []).filter((c) => c.status === "ready");
  const busy = !!v.step || v.status === "making";
  const kindNow = d?.kind ?? lay.kind;
  const upload = async (f: File | null, what: "video" | "picture") => {
    if (!f || !d) return;
    setUpErr(null);
    setUploading(true);
    try {
      const r = await uploadTo<{ url: string; kind: string; name: string }>("edit_media", currentOrgId, f);
      if (what === "video" && r.kind !== "video") throw new Error("Upload a video for the other half.");
      if (what === "picture" && r.kind !== "image") throw new Error("Upload a picture to put behind you.");
      if (what === "video") setD({ ...d, split: { ...d.split, other: "video", videoUrl: r.url, videoName: r.name } });
      else setD({ ...d, green: { ...d.green, bg: "picture", url: r.url } });
    } catch (e) {
      setUpErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };
  const doSave = () => {
    if (!d) return;
    const run = () =>
      save(
        {
          layout: {
            kind: d.kind,
            split: { you: d.split.you, other: d.split.other, when: d.split.when, clipId: d.split.clipId ?? null, videoUrl: d.split.videoUrl ?? null, videoName: d.split.videoName ?? null },
            green: { bg: d.green.bg, color: d.green.color, clipId: d.green.clipId ?? null, url: d.green.url ?? null, style: d.green.style ?? null, place: d.green.place ?? null },
            pip: { corner: d.pip.corner },
          },
        },
        () => setD(null)
      );
    if (d.kind === "green" && !v.cutout.ready && !v.cutout.cutting) hours.confirm(`green-${v.id}`, `Green screen uses ${v.greenHours} once`, run);
    else run();
  };
  const g = d?.green ?? lay.green;
  const clipName = (id?: number | null) => clips.find((c) => c.id === id)?.title ?? "a clip";
  const readText =
    lay.kind === "split"
      ? `You ${lay.split.you === "top" ? "on top" : "below"}. Other half: ${lay.split.other === "auto" ? "your b-roll" : lay.split.other === "clip" ? clipName(lay.split.clipId) : lay.split.videoName || "your second video"}, ${lay.split.when === "whole" ? "the whole video" : "only lines with b-roll"}.`
      : lay.kind === "green"
        ? `Background: ${lay.green.bg === "color" ? `color ${lay.green.color}` : lay.green.bg === "clip" ? clipName(lay.green.clipId) : lay.green.bg === "picture" ? "your picture" : `${st.find(lay.green.style || "studio").label}, ${lay.green.place || "a bright modern office"}`}. ${v.cutout.ready ? "You're cut out." : v.cutout.cutting ? "Elena is cutting you out now." : ""}`
        : lay.kind === "pip"
          ? `You in the ${CORNERS.find((c) => c.key === lay.pip.corner)?.label.toLowerCase()} corner when b-roll plays.`
          : "Just you, with b-roll over the lines that have it.";
  return (
    <>
      <div className="ld-ed-lays">
        {LAYOUTS.map((l) => (
          <button key={l.key} type="button" className={`ld-ed-lay ${kindNow === l.key ? "on" : ""}`} aria-pressed={kindNow === l.key} disabled={busy} onClick={() => setD({ ...(d ?? lay), kind: l.key })}>
            <span className="ld-ed-ls"><LayoutIcon k={l.key} /></span>
            <b>{l.label}</b>
            <span>{l.note}</span>
          </button>
        ))}
      </div>
      <Sec title={(LAYOUTS.find((l) => l.key === kindNow) ?? LAYOUTS[0]).label} editing={!!d} onEdit={() => setD({ ...lay })}>
        {!d ? (
          <>
            <span className="ld-ed-kvv">{readText}</span>
            {lay.kind === "green" && v.cutout.error && !v.cutout.cutting && (
              <span className="ld-row" style={{ gap: 8 }}>
                <span className="ld-small" style={{ color: "var(--ld-bad)" }}>The cutout didn't finish: {v.cutout.error}</span>
                <button type="button" className="ld-btn sm" disabled={retry.isPending} onClick={() => retry.mutate({ organizationId: currentOrgId, id: v.id })}>Try again</button>
              </span>
            )}
          </>
        ) : (
          <>
            {d.kind === "split" && (
              <div className="ld-ed-kv">
                <span>You</span>
                <div className="ld-row">
                  <Chip on={d.split.you === "top"} onClick={() => setD({ ...d, split: { ...d.split, you: "top" } })}>On top</Chip>
                  <Chip on={d.split.you === "bottom"} onClick={() => setD({ ...d, split: { ...d.split, you: "bottom" } })}>Below</Chip>
                </div>
                <span>Other half</span>
                <div className="ld-row" style={{ flexWrap: "wrap" }}>
                  <Chip on={d.split.other === "auto"} onClick={() => setD({ ...d, split: { ...d.split, other: "auto" } })}>Your b-roll</Chip>
                  <Chip on={d.split.other === "clip"} onClick={() => setD({ ...d, split: { ...d.split, other: "clip" } })}>One clip</Chip>
                  <Chip on={d.split.other === "video"} onClick={() => setD({ ...d, split: { ...d.split, other: "video" } })}>Your second video</Chip>
                </div>
                {d.split.other === "clip" && (
                  <>
                    <span>Clip</span>
                    <select className="ld-in" style={{ maxWidth: 280 }} aria-label="Clip for the other half" value={d.split.clipId ?? ""} onChange={(e) => setD({ ...d, split: { ...d.split, clipId: Number(e.target.value) || null } })}>
                      <option value="">Pick a clip</option>
                      {clips.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                  </>
                )}
                {d.split.other === "video" && (
                  <>
                    <span>Video</span>
                    <div className="ld-row">
                      {d.split.videoName && <span className="ld-small ld-clip" style={{ maxWidth: 180 }}>{d.split.videoName}</span>}
                      <button type="button" className="ld-btn sm" disabled={uploading} onClick={() => document.getElementById(`sv-${v.id}`)?.click()}>{uploading ? "Uploading..." : d.split.videoUrl ? "Replace" : "Upload"}</button>
                      <input id={`sv-${v.id}`} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" hidden onChange={(e) => (void upload(e.target.files?.[0] ?? null, "video"), (e.target.value = ""))} />
                    </div>
                  </>
                )}
                <span>When</span>
                <div className="ld-row" style={{ flexWrap: "wrap" }}>
                  <Chip on={d.split.when === "whole"} onClick={() => setD({ ...d, split: { ...d.split, when: "whole" } })}>Whole video</Chip>
                  <Chip on={d.split.when === "broll"} onClick={() => setD({ ...d, split: { ...d.split, when: "broll" } })}>Only lines with b-roll</Chip>
                </div>
              </div>
            )}
            {d.kind === "green" && (
              <div className="ld-ed-kv">
                <span>Background</span>
                <div className="ld-row" style={{ flexWrap: "wrap" }}>
                  <Chip on={g.bg === "color"} onClick={() => setD({ ...d, green: { ...g, bg: "color" } })}>Color</Chip>
                  <Chip on={g.bg === "clip"} onClick={() => setD({ ...d, green: { ...g, bg: "clip" } })}>B-roll clip</Chip>
                  <Chip on={g.bg === "picture"} onClick={() => setD({ ...d, green: { ...g, bg: "picture" } })}>Picture</Chip>
                  <Chip on={g.bg === "style"} onClick={() => setD({ ...d, green: { ...g, bg: "style" } })}>Drawn style</Chip>
                </div>
                {g.bg === "color" && (
                  <>
                    <span>Color</span>
                    <div className="ld-row">
                      <input type="color" aria-label="Background color" value={g.color} onChange={(e) => setD({ ...d, green: { ...g, color: e.target.value.toUpperCase() } })} />
                      {opts.brandColor && <Chip on={g.color.toUpperCase() === opts.brandColor.toUpperCase()} onClick={() => setD({ ...d, green: { ...g, color: opts.brandColor!.toUpperCase() } })}>Brand color</Chip>}
                    </div>
                  </>
                )}
                {g.bg === "clip" && (
                  <>
                    <span>Clip</span>
                    <select className="ld-in" style={{ maxWidth: 280 }} aria-label="Clip behind you" value={g.clipId ?? ""} onChange={(e) => setD({ ...d, green: { ...g, clipId: Number(e.target.value) || null } })}>
                      <option value="">Pick a clip</option>
                      {clips.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                  </>
                )}
                {g.bg === "picture" && (
                  <>
                    <span>Picture</span>
                    <div className="ld-row">
                      {g.url && <img className="ld-ed-bgthumb" src={g.url} alt="" />}
                      <button type="button" className="ld-btn sm" disabled={uploading} onClick={() => document.getElementById(`gp-${v.id}`)?.click()}>{uploading ? "Uploading..." : g.url ? "Replace" : "Upload"}</button>
                      <input id={`gp-${v.id}`} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => (void upload(e.target.files?.[0] ?? null, "picture"), (e.target.value = ""))} />
                    </div>
                  </>
                )}
                {g.bg === "style" && (
                  <>
                    <span>Style</span>
                    <div className="ld-row">
                      <span className="ld-small">{st.find(g.style || "studio").label}</span>
                      <button type="button" className="ld-btn sm" onClick={() => setPicking(true)}>Change</button>
                    </div>
                    <span>Behind you</span>
                    <input className="ld-in" style={{ maxWidth: 320 }} aria-label="What's behind you" maxLength={200} placeholder="A bright modern office" value={g.place ?? ""} onChange={(e) => setD({ ...d, green: { ...g, place: e.target.value } })} />
                  </>
                )}
                {!v.cutout.ready && (
                  <>
                    <span>Work hours</span>
                    <span className="ld-ed-kvv">{v.greenHours} once, to cut you out of your room. No green screen needed.</span>
                  </>
                )}
              </div>
            )}
            {d.kind === "pip" && (
              <div className="ld-ed-kv">
                <span>Corner</span>
                <div className="ld-row" style={{ flexWrap: "wrap" }}>{CORNERS.map((c) => <Chip key={c.key} on={d.pip.corner === c.key} onClick={() => setD({ ...d, pip: { corner: c.key } })}>{c.label}</Chip>)}</div>
              </div>
            )}
            {d.kind === "full" && <span className="ld-ed-kvv">Just you, with b-roll over the lines that have it.</span>}
            {upErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{upErr}</span>}
            {hours.question(`green-${v.id}`)}
            <SaveRow busy={m.isPending} disabled={uploading} onSave={doSave} onCancel={() => setD(null)} />
          </>
        )}
      </Sec>
      <ErrorLine error={m.error ?? retry.error} />
      {picking && d && <StylePicker value={g.style || "studio"} title="Background style" onPick={(k) => (setD({ ...d, green: { ...g, style: k === "real" || k === "auto" ? "studio" : k } }), setPicking(false))} onClose={() => setPicking(false)} />}
    </>
  );
}

// ==========================================
// Export
// ==========================================

function ExportPanel({ v, set }: { v: EV; set: (v: EV) => void }) {
  const { currentOrgId } = useTenant();
  const hours = useHoursAsk();
  const [sizes, setSizes] = React.useState<Size[]>(v.sizes as Size[]);
  const [cap, setCap] = React.useState<string | null>(null);
  const [view, setView] = React.useState<Size>((v.sizes[0] as Size) ?? "vertical");
  const go = trpc.edits.export.useMutation({ onSuccess: set });
  const rename = trpc.edits.rename.useMutation({ onSuccess: (r) => (set(r), setCap(null)) });
  const clips = trpc.edits.shortClips.useMutation({ onSuccess: set });
  const busy = v.status === "making" || !!v.step;
  const toggle = (s: Size) => setSizes(sizes.includes(s) ? sizes.filter((x) => x !== s) : [...sizes, s]);
  const lk = v.look;
  const includes = [
    lk.captions.on ? "captions" : null,
    lk.tools.zooms ? "auto zooms" : null,
    lk.tools.silences ? "silences removed" : null,
    lk.tools.badTakes ? "bad takes removed" : null,
    lk.tools.cleanAudio ? "clean audio" : null,
    lk.layout.kind !== "full" ? v.layoutLabel.toLowerCase() : null,
    v.brollCount ? `${v.brollCount} b-roll ${v.brollCount === 1 ? "clip" : "clips"}${lk.tools.transitions ? " with transitions" : ""}` : null,
    lk.tools.hook.on ? "hook title" : null,
    lk.music.on ? "music" : null,
    lk.tools.translate.on ? `${lk.tools.translate.lang} captions` : null,
  ].filter(Boolean);
  const url = v.videoUrls[view];
  const start = () => {
    const run = () => go.mutate({ organizationId: currentOrgId, id: v.id, sizes });
    if (v.exportMinutes > 0) hours.confirm(`export-${v.id}`, `Exporting uses ${v.hoursToExport}`, run);
    else run();
  };
  return (
    <>
      {v.status === "ready" && url && (
        <div className="ld-ed-done">
          <div className="ld-vm-player" style={{ aspectRatio: ASPECT[view] }}>
            <video key={url} src={`${url}#t=0.1`} controls playsInline preload="metadata" />
          </div>
          <div className="ld-row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(Object.keys(v.videoUrls) as Size[]).map((s) => <Chip key={s} on={view === s} onClick={() => setView(s)}>{RATIO[s]}</Chip>)}
            <a className="ld-btn sm" href={url} download>Download</a>
          </div>
        </div>
      )}
      <Sec title="Export">
        <div className="ld-ed-kv">
          <span>Sizes</span>
          <div className="ld-row">{SIZE_KEYS.map((s) => <Chip key={s} on={sizes.includes(s)} onClick={() => toggle(s)}>{RATIO[s]}</Chip>)}</div>
          <span>Length</span>
          <span className="ld-ed-kvv">{v.outLength} (from {v.length})</span>
          <span>Includes</span>
          <span className="ld-ed-kvv">{includes.length ? includes.join(", ") : "Your video as it is"}</span>
        </div>
        <div className="ld-row">
          <span className="ld-ed-hours">{v.exportMinutes > 0 ? `Uses ${v.hoursToExport}` : "Uses no work hours"}</span>
        </div>
        {hours.question(`export-${v.id}`)}
        <ErrorLine error={go.error ?? clips.error} />
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ld-btn p" style={{ width: 140 }} disabled={busy || go.isPending || !sizes.length} onClick={start}>{v.status === "making" ? "Exporting..." : v.status === "ready" ? "Export again" : "Export"}</button>
          <button type="button" className="ld-btn" style={{ width: 140 }} disabled={busy || clips.isPending || v.seconds < 45} onClick={() => clips.mutate({ organizationId: currentOrgId, id: v.id })}>Short clips</button>
        </div>
      </Sec>
      <Sec title="Post caption" editing={cap !== null} onEdit={() => setCap(v.caption)}>
        {cap === null ? (
          <span className="ld-ed-kvv">{v.caption || "None yet."}</span>
        ) : (
          <>
            <textarea className="ld-ta" rows={3} maxLength={1000} aria-label="Post caption" value={cap} onChange={(e) => setCap(e.target.value)} />
            <ErrorLine error={rename.error} />
            <SaveRow busy={rename.isPending} onSave={() => rename.mutate({ organizationId: currentOrgId, id: v.id, caption: cap })} onCancel={() => setCap(null)} />
          </>
        )}
      </Sec>
    </>
  );
}

// ==========================================
// Chat card
// ==========================================

/** The card under Elena's message: where the edit stands, and the editor when it's ready. */
export function EditCard({ id }: { id: number }) {
  const { v, loading } = useEdit(id);
  const [open, setOpen] = React.useState(false);
  if (!v) return loading ? null : <div className="ld-card ld-empty">This video was removed.</div>;
  const pill = v.status === "ready" ? "green" : v.status === "failed" ? "red" : v.status === "draft" ? "amber" : "blue";
  return (
    <div className="ld-card ld-ed-chat">
      <div className="ld-ed-uprow" style={{ border: 0 }}>
        {v.thumbUrl && <img src={v.thumbUrl} alt="" />}
        <div className="ld-ed-upt">
          <b>{v.title}</b>
          <span>{["Your video", v.outLength, v.ratios.join(" and ")].join(" · ")}</span>
        </div>
        <span className={`ld-pill ${pill}`}>{v.statusLabel}</span>
        {v.status !== "preparing" && v.status !== "failed" && (
          <button type="button" className="ld-btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close" : "Open"}</button>
        )}
      </div>
      {open && <VideoEditor id={id} />}
    </div>
  );
}
