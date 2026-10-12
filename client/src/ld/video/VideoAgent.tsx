import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { Outputs } from "../types";
import { useHoursAsk } from "../HoursAsk";
import { ErrorLine } from "../ui";
import { StylePicker, StyleRow } from "./Styles";

/**
 * Elena's video agent on screen:
 * - VideoMaker: the Make a video card (format cards with pictures, what to start from, sizes,
 *   length, voice, captions, the logo question and the music question, then Plan the video).
 * - VideoCard: the storyboard (scenes with their sources, Change shot and Rewrite line), the
 *   finished video (sizes, Download, Edit, Send to Sienna, Redo a scene, 3 ad versions), and
 *   Edit (captions, logo and music, each read first with its own Edit button).
 */

export type V = NonNullable<Outputs["videos"]["get"]>;
type FormatKey = "ad" | "broll" | "explainer" | "talking" | "story" | "audio";
type StartKey = "idea" | "script" | "link" | "audio";
type Size = "vertical" | "square" | "wide";
type Src = V["shots"][number]["src"];

export const FORMATS: { key: FormatKey; title: string; note: string }[] = [
  { key: "ad", title: "Ad", note: "Sell one offer in 15 to 30 seconds." },
  { key: "broll", title: "B-roll story", note: "Real footage under your voice." },
  { key: "explainer", title: "Explainer", note: "Motion text that teaches one idea." },
  { key: "talking", title: "Talking to camera", note: "You or your avatar on camera." },
  { key: "story", title: "Personal story", note: "Your photos and footage, first person." },
  { key: "audio", title: "Audio to video", note: "A podcast clip or voice memo, with visuals." },
];
const STARTS: { key: StartKey; title: string; note: string }[] = [
  { key: "idea", title: "An idea", note: "One line is enough" },
  { key: "script", title: "My script", note: "Kept word for word" },
  { key: "link", title: "A link", note: "Blog post or article" },
  { key: "audio", title: "Audio", note: "Upload a recording" },
];
const SIZES: { key: Size; ratio: string }[] = [
  { key: "vertical", ratio: "9:16" },
  { key: "square", ratio: "1:1" },
  { key: "wide", ratio: "16:9" },
];
const LENGTHS = [15, 30, 60, 90, 180, 300, 600];
const lengthText = (l: number) => (l < 120 ? `${l}s` : `${l / 60} min`);

/**
 * What a frame of each format looks like in the finished video, drawn over its photo:
 * the story bars along the top and the caption in the Bold pop style.
 */
const FRAME: Record<FormatKey, { cap: [string, string, string]; extra?: "shop" | "wave" | "big" | "rec" }> = {
  ad: { cap: ["20% off", "this", "week"], extra: "shop" },
  broll: { cap: ["Mornings", "just", "got easier"] },
  explainer: { cap: ["One", "big", "idea"], extra: "big" },
  talking: { cap: ["Here's", "what", "works"], extra: "rec" },
  story: { cap: ["The day", "it", "changed"] },
  audio: { cap: ["Your", "words,", "seen"], extra: "wave" },
};
const COLOR: Record<FormatKey, string> = { ad: "linear-gradient(170deg,#f7b3a6,#e46a7d)", broll: "linear-gradient(170deg,#e9c17d,#3c5a45)", explainer: "linear-gradient(170deg,#b7a6ff,#5a3fd0)", talking: "linear-gradient(170deg,#8aa6d8,#22355f)", story: "linear-gradient(170deg,#ffd38a,#e4708f)", audio: "linear-gradient(170deg,#7b5cff,#1b1145)" };

function FrameOverlay({ k }: { k: FormatKey }) {
  const f = FRAME[k];
  return (
    <span className="ld-vm-ov" aria-hidden="true">
      <span className="ld-vm-bars"><i className="on" /><i /><i /></span>
      {f.extra === "rec" && <span className="ld-vm-rec"><i />REC</span>}
      {f.extra === "wave" && (
        <span className="ld-vm-wave">
          {[30, 60, 90, 45, 75, 100, 55, 80, 40, 65, 35, 70, 50].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}
        </span>
      )}
      <span className={`ld-vm-cap ${f.extra === "big" ? "big" : ""}`}>
        {f.cap[0]} <em>{f.cap[1]}</em> {f.cap[2]}
      </span>
      {f.extra === "shop" && <span className="ld-vm-shop">Shop now</span>}
    </span>
  );
}

/** A file sent to one of the upload slots; the reply is JSON or an error. */
export async function uploadTo<T>(slot: string, orgId: number, file: File): Promise<T> {
  const q = new URLSearchParams({ organizationId: String(orgId), name: file.name });
  const res = await fetch(`/api/upload/${slot}?${q.toString()}`, { method: "POST", body: file, credentials: "include", headers: { "content-type": file.type || "application/octet-stream" } });
  const data = await res.json().catch(() => ({ error: res.status === 413 ? "That file is too large for the server." : "Upload failed." }));
  if (!res.ok) throw new Error(data.error || "Upload failed.");
  return data as T;
}

const hoursText = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} work ${h === 1 ? "hour" : "hours"}`;

function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

// ==========================================
// Make a video
// ==========================================

export function VideoMaker({ initial = "", onPlanned, onCancel }: { initial?: string; onPlanned?: (r: { kind: "video" | "talking"; id: number }) => void; onCancel?: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const opts = trpc.videos.options.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [format, setFormat] = React.useState<FormatKey>("broll");
  const [start, setStart] = React.useState<StartKey>("idea");
  const [text, setText] = React.useState(initial);
  const [link, setLink] = React.useState("");
  const [audio, setAudio] = React.useState<{ url: string; name: string; seconds: number } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [upErr, setUpErr] = React.useState<string | null>(null);
  const [sizes, setSizes] = React.useState<Size[]>(["vertical"]);
  const [seconds, setSeconds] = React.useState(30);
  const [voice, setVoice] = React.useState<string | null>(null);
  const [more, setMore] = React.useState(false);
  const [captions, setCaptions] = React.useState<"pop" | "clean" | "off">("pop");
  const [logo, setLogo] = React.useState<"br" | "tr" | "off" | null>(null);
  const [music, setMusic] = React.useState("calm");
  const [style, setStyle] = React.useState("real");
  const [motion, setMotion] = React.useState<"pictures" | "clips">("pictures");
  const fileRef = React.useRef<HTMLInputElement>(null);
  const write = trpc.videos.write.useMutation({
    onSuccess: async (r) => {
      await Promise.all([utils.chat.list.invalidate(), utils.videos.list.invalidate(), utils.avatar.invalidate()]);
      onPlanned?.(r);
    },
  });
  const o = opts.data;
  const myVoice = o?.myVoice ?? null;
  const coral = o?.voices.find((v) => v.name === "Coral") ?? null;
  const voiceId = voice ?? myVoice?.id ?? coral?.id ?? null;
  const logoPick = logo ?? (o?.hasLogo ? "br" : "off");
  const talking = format === "talking";
  const isAudio = format === "audio" || start === "audio";
  const pickFormat = (f: FormatKey) => {
    setFormat(f);
    if (f === "audio") setStart("audio");
    else if (start === "audio") setStart("idea");
  };
  const pickStart = (s: StartKey) => {
    setStart(s);
    if (s === "audio") setFormat("audio");
    else if (format === "audio") setFormat("broll");
  };
  const upload = async (file: File | null) => {
    if (!file) return;
    setUpErr(null);
    setUploading(true);
    try {
      setAudio(await uploadTo<{ url: string; name: string; seconds: number }>("video_audio", currentOrgId, file));
    } catch (err) {
      setUpErr(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };
  const halves = Math.max(1, Math.ceil(seconds / 30));
  const base = ((o?.videoHoursPerMinute ?? 8) / 2) * halves;
  const drawn = style !== "real" && !talking;
  // Over 90 seconds is a drawn story with moving pictures.
  const long = seconds > 90;
  const pickLength = (l: number) => {
    setSeconds(l);
    if (l > 90) {
      if (style === "real") setStyle("auto");
      setMotion("pictures");
    }
  };
  const pickStyle = (k: string) => {
    setStyle(k);
    if (k === "real" && seconds > 90) setSeconds(90);
  };
  const clipHours = o?.clipHours ?? 2;
  const estimate = talking
    ? `About ${hoursText(base * 2)} for a ${seconds}-second talking video`
    : drawn
      ? motion === "clips"
        ? `About ${hoursText(base + Math.ceil(seconds / 5) * clipHours)} with animated clips`
        : `About ${hoursText(base)} for a ${seconds <= 90 ? `${seconds}-second` : `${seconds / 60}-minute`} story`
      : `About ${hoursText(base)} for a ${seconds}-second video, plus ${clipHours} for each new AI clip`;
  const ready = isAudio ? !!audio : start === "link" ? /^https?:\/\/\S+$/.test(link.trim()) : !!text.trim();
  const plan = () =>
    write.mutate({
      organizationId: currentOrgId,
      format: isAudio ? "audio" : format,
      start: isAudio ? "audio" : start,
      text,
      sourceUrl: isAudio ? audio?.url ?? null : start === "link" ? link.trim() : null,
      sizes: talking ? ["vertical"] : sizes,
      seconds,
      voiceId: isAudio ? null : voiceId,
      captions,
      logo: logoPick,
      music,
      style: talking ? "real" : style,
      motion: drawn && !long ? motion : "pictures",
    });

  return (
    <div className="ld-card ld-vm">
      <div className="ld-vm-field">
        <span className="ld-lbl">Format</span>
        <div className="ld-vm-formats" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => (
            <button key={f.key} type="button" role="radio" aria-checked={format === f.key} className={`ld-vm-fmt ${format === f.key ? "on" : ""}`} onClick={() => pickFormat(f.key)}>
              <span className="ld-vm-fmt-img" style={{ background: COLOR[f.key] }}>
                <img src={`/api/video-pictures/${f.key}`} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                <FrameOverlay k={f.key} />
                {format === f.key && (
                  <span className="ld-vm-check" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                )}
              </span>
              <b>{f.title}</b>
              <span>{f.note}</span>
            </button>
          ))}
        </div>
      </div>

      {!talking && <StyleRow value={style} onChange={pickStyle} />}

      <div className="ld-vm-field">
        <span className="ld-lbl">Start from</span>
        <div className="ld-vm-starts" role="radiogroup" aria-label="Start from">
          {STARTS.filter((s) => !(talking && s.key === "audio")).map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={start === s.key} className={`ld-vm-start ${start === s.key ? "on" : ""}`} onClick={() => pickStart(s.key)}>
              <b>{s.title}</b>
              <span>{s.note}</span>
            </button>
          ))}
        </div>
        {isAudio ? (
          <div className="ld-vm-drop">
            <span>{audio ? `${audio.name}, ${Math.floor(audio.seconds / 60)}:${String(audio.seconds % 60).padStart(2, "0")}` : "MP3, M4A or WAV. Elena picks the best part for the length you choose."}</span>
            <button type="button" className="ld-btn" style={{ width: 150 }} disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Uploading..." : audio ? "Change file" : "Upload recording"}
            </button>
            <input ref={fileRef} type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav" hidden onChange={(e) => upload(e.target.files?.[0] ?? null)} />
          </div>
        ) : start === "link" ? (
          <input className="ld-in lg" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link to a blog post or article" />
        ) : (
          <textarea className="ld-vm-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={start === "script" ? "Paste your script. Elena keeps every word." : "What's the video about? One line is enough."} aria-label={start === "script" ? "Your script" : "Your idea"} />
        )}
        {upErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{upErr}</span>}
      </div>

      <div className="ld-vm-grid">
        {!talking && (
          <div className="ld-vm-field">
            <span className="ld-lbl">Sizes</span>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              {SIZES.map((s) => (
                <Chip key={s.key} on={sizes.includes(s.key)} onClick={() => setSizes(sizes.includes(s.key) ? (sizes.length > 1 ? sizes.filter((x) => x !== s.key) : sizes) : [...sizes, s.key])}>
                  {s.ratio}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div className="ld-vm-field">
          <span className="ld-lbl">Length</span>
          <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
            {LENGTHS.filter((l) => !(talking && l > 90)).map((l) => (
              <Chip key={l} on={seconds === l} onClick={() => pickLength(l)}>{lengthText(l)}</Chip>
            ))}
          </div>
        </div>
        {!isAudio && (
          <div className="ld-vm-field">
            <span className="ld-lbl">Voice</span>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              {myVoice && <Chip on={voiceId === myVoice.id} onClick={() => setVoice(myVoice.id)}>My voice</Chip>}
              {coral && coral.id !== myVoice?.id && <Chip on={voiceId === coral.id} onClick={() => setVoice(coral.id)}>Coral</Chip>}
              <Chip on={more || (!!voiceId && voiceId !== myVoice?.id && voiceId !== coral?.id)} onClick={() => setMore(!more)}>More</Chip>
            </div>
            {more && (
              <select className="ld-in" aria-label="Voice" value={voiceId ?? ""} onChange={(e) => setVoice(e.target.value)}>
                {(o?.voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
        {!talking && (
          <div className="ld-vm-field">
            <span className="ld-lbl">Captions</span>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              <Chip on={captions === "pop"} onClick={() => setCaptions("pop")}>Bold pop</Chip>
              <Chip on={captions === "clean"} onClick={() => setCaptions("clean")}>Clean</Chip>
              <Chip on={captions === "off"} onClick={() => setCaptions("off")}>Off</Chip>
            </div>
          </div>
        )}
      </div>

      {drawn && (
        <div className="ld-vm-field">
          <span className="ld-lbl">Scenes</span>
          <div className="ld-vm-opts" role="radiogroup" aria-label="Scenes">
            <button type="button" role="radio" aria-checked={motion === "pictures"} className={`ld-vm-opt ${motion === "pictures" ? "on" : ""}`} onClick={() => setMotion("pictures")}>
              <b>Moving pictures</b>
              <span>One picture per scene with a slow pan or zoom. No extra work hours.</span>
            </button>
            <button type="button" role="radio" aria-checked={motion === "clips"} className={`ld-vm-opt ${motion === "clips" ? "on" : ""}`} disabled={long} onClick={() => setMotion("clips")}>
              <b>Animated clips</b>
              <span>{long ? "Up to 90 seconds." : `Every scene moves like a short film. ${clipHours} work hours for each 5 seconds.`}</span>
            </button>
          </div>
        </div>
      )}

      {!talking && (
        <div className="ld-vm-asks">
          <div className="ld-vm-ask">
            <div>
              <b>Put your logo on the video?</b>
              <span>{o && !o.hasLogo ? <>No logo uploaded yet. <Link href="/workspace">Add it under Workspace</Link>, then pick a corner here.</> : "You can add it, move it or take it off later in Edit."}</span>
            </div>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              <Chip on={logoPick === "br"} disabled={!o?.hasLogo} onClick={() => setLogo("br")}>Yes, bottom right</Chip>
              <Chip on={logoPick === "tr"} disabled={!o?.hasLogo} onClick={() => setLogo("tr")}>Yes, top right</Chip>
              <Chip on={logoPick === "off"} onClick={() => setLogo("off")}>No logo</Chip>
            </div>
          </div>
          <div className="ld-vm-ask">
            <div>
              <b>Music?</b>
              <span>Low under the voice. Change it or take it off later in Edit.</span>
            </div>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              {(o?.tracks ?? []).map((t) => (
                <Chip key={t.key} on={music === t.key} onClick={() => setMusic(t.key)}>{t.name}</Chip>
              ))}
              <Chip on={music === "none"} onClick={() => setMusic("none")}>No music</Chip>
            </div>
          </div>
        </div>
      )}

      <div className="ld-vm-foot">
        <span className="ld-vm-hours">{estimate}</span>
        <div className="ld-row" style={{ gap: 8 }}>
          {onCancel && <button type="button" className="ld-btn" style={{ width: 150 }} onClick={onCancel}>Cancel</button>}
          <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={!ready || write.isPending || uploading} onClick={plan}>
            {write.isPending ? "Planning..." : "Plan the video"}
          </button>
        </div>
      </div>
      <ErrorLine error={write.error} />
    </div>
  );
}

// ==========================================
// Storyboard, finished video and Edit
// ==========================================

const SRC_COLOR: Record<Src, string> = { library: "t1", stock: "t2", ai: "t3", text: "t4", logo: "t5", photo: "t1", art: "t3" };
const SRC_NOTE: Record<Src, string> = { library: "no extra hours", stock: "licensed stock", ai: "saved to your b-roll", text: "", logo: "", photo: "your photo", art: "" };
const RATIO_OF: Record<Size, string> = { vertical: "9 / 16", square: "1 / 1", wide: "16 / 9" };

function useVideo(id: number) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const one = trpc.videos.get.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.status === "making" ? 8_000 : r.state.data?.drawing ? 4_000 : false) });
  const refresh = () => Promise.all([utils.videos.list.invalidate(), utils.videos.get.invalidate({ organizationId: currentOrgId, id }), utils.broll.list.invalidate()]);
  return { orgId: currentOrgId, v: one.data as V | null | undefined, loading: one.isLoading, refresh, utils };
}

function Thumb({ s, size, drawing }: { s: V["shots"][number]; size: Size; drawing?: boolean }) {
  return (
    <span className={`ld-vm-thumb ${SRC_COLOR[s.src]}`} style={{ aspectRatio: RATIO_OF[size] }}>
      {s.thumb && <img src={s.thumb} alt="" loading="lazy" />}
      {!(s.src === "art" && s.thumb) && <span>{s.src === "text" ? "Kinetic text" : s.src === "art" ? (drawing ? "Drawing..." : "Drawn when made") : s.srcLabel}</span>}
    </span>
  );
}

/** Change shot: what we see and where it comes from (your b-roll, stock, a new AI clip, motion text, the logo card). */
function ShotEditor({ v, n, redo, onDone }: { v: V; n: number; redo: boolean; onDone: () => void }) {
  const { orgId, refresh } = useVideo(v.id);
  const s = v.shots[n];
  const opts = trpc.videos.options.useQuery({ organizationId: orgId });
  const lib = trpc.broll.list.useQuery({ organizationId: orgId });
  const clips = (lib.data?.clips ?? []).filter((c) => c.status === "ready");
  const [src, setSrc] = React.useState<Src>(s.src);
  const [see, setSee] = React.useState(s.see);
  const [clipId, setClipId] = React.useState<number | null>(s.clipId);
  const hours = useHoursAsk();
  const change = trpc.videos.changeShot.useMutation({ onSuccess: async () => (await refresh(), onDone()) });
  const drawn = v.style !== "real";
  const choices: { key: Src; label: string; show: boolean }[] = drawn ? [
    { key: "art", label: `Drawn scene, ${v.styleLabel}`, show: true },
    { key: "text", label: "Motion text", show: true },
    { key: "logo", label: "Logo end", show: true },
  ] : [
    { key: "library", label: "Your b-roll", show: clips.length > 0 },
    { key: "stock", label: "Stock", show: !!opts.data?.stock },
    { key: "ai", label: "New AI clip", show: true },
    { key: "text", label: "Motion text", show: true },
    { key: "logo", label: "Logo end", show: true },
    { key: "photo", label: "Your photo", show: v.kind === "story" },
  ];
  const save = () => {
    const run = () => change.mutate({ organizationId: orgId, id: v.id, n, src, see, clipId: src === "library" ? clipId : null, redo });
    if (redo && (src === "ai" || (src === "art" && v.motion === "clips"))) hours.confirm(`redo-${v.id}-${n}`, `A new ${src === "art" ? "animated scene" : "AI clip"} uses ${opts.data?.clipHours ?? 2} work hours for each 5 seconds`, run);
    else run();
  };
  return (
    <div className="ld-vm-editor">
      <div className="ld-vm-field">
        <span className="ld-lbl">Where it comes from</span>
        <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
          {choices.filter((c) => c.show).map((c) => (
            <Chip key={c.key} on={src === c.key} onClick={() => setSrc(c.key)}>{c.label}</Chip>
          ))}
        </div>
      </div>
      {src === "library" ? (
        <div className="ld-vm-pick" role="radiogroup" aria-label="Clip from your b-roll">
          {clips.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={clipId === c.id} className={clipId === c.id ? "on" : ""} onClick={() => setClipId(c.id)}>
              {c.thumbUrl ? <img src={c.thumbUrl} alt="" loading="lazy" /> : <span className="ld-vm-ph t1" />}
              <span>{c.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <label className="ld-vm-field">
          <span className="ld-lbl">{src === "text" ? "Words on the card" : src === "logo" ? "Call to action" : src === "photo" ? "Photo title" : "What we see"}</span>
          <input className="ld-in lg" value={see} onChange={(e) => setSee(e.target.value)} />
        </label>
      )}
      {hours.question(`redo-${v.id}-${n}`)}
      <ErrorLine error={change.error} />
      <div className="ld-row" style={{ gap: 8 }}>
        <button type="button" className="ld-btn p" style={{ width: 130 }} disabled={change.isPending || (src === "library" && !clipId) || !see.trim()} onClick={save}>
          {change.isPending ? "Saving..." : redo ? "Redo scene" : "Save"}
        </button>
        <button type="button" className="ld-btn" style={{ width: 130 }} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function LineEditor({ v, n, onDone }: { v: V; n: number; onDone: () => void }) {
  const { orgId, refresh } = useVideo(v.id);
  const [say, setSay] = React.useState(v.shots[n].say);
  const save = trpc.videos.saveLine.useMutation({ onSuccess: async () => (await refresh(), onDone()) });
  return (
    <div className="ld-vm-editor">
      <label className="ld-vm-field">
        <span className="ld-lbl">What's said</span>
        <textarea className="ld-vm-text" style={{ minHeight: 60 }} value={say} onChange={(e) => setSay(e.target.value)} />
      </label>
      <ErrorLine error={save.error} />
      <div className="ld-row" style={{ gap: 8 }}>
        <button type="button" className="ld-btn p" style={{ width: 130 }} disabled={save.isPending || !say.trim()} onClick={() => save.mutate({ organizationId: orgId, id: v.id, n, say })}>
          {save.isPending ? "Saving..." : "Save"}
        </button>
        <button type="button" className="ld-btn" style={{ width: 130 }} onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function Scenes({ v, mode }: { v: V; mode: "plan" | "redo" | "view" }) {
  const [open, setOpen] = React.useState<{ n: number; what: "shot" | "line" } | null>(null);
  const size = v.sizes[0] as Size;
  return (
    <div className="ld-vm-board">
      {v.shots.map((s) => (
        <React.Fragment key={s.n}>
          <div className="ld-vm-scene">
            <span className="ld-vm-n">{s.n + 1}</span>
            <Thumb s={s} size={size} drawing={!!v.drawing} />
            <div className="ld-vm-say">
              <span className={`ld-vm-tag ${s.hook ? "hook" : "src"}`}>{s.hook ? `Hook · ${s.time}` : `${s.srcLabel} · ${s.time}${SRC_NOTE[s.src] && !s.made ? ` · ${SRC_NOTE[s.src]}` : s.src === "library" ? ` · ${SRC_NOTE.library}` : ""}`}</span>
              {s.say && <span className="ld-vm-s">{`"${s.say}"`}</span>}
              <span className="ld-vm-v">
                {s.see}
                {s.credit && (
                  <>
                    {" "}
                    (<a href={s.creditUrl ?? "https://www.pexels.com"} target="_blank" rel="noreferrer noopener">{`Video by ${s.credit}`}</a>)
                  </>
                )}
              </span>
            </div>
            {mode !== "view" && (
              <div className="ld-vm-acts">
                <button type="button" className="ld-btn" aria-expanded={open?.n === s.n && open.what === "shot"} onClick={() => setOpen(open?.n === s.n && open.what === "shot" ? null : { n: s.n, what: "shot" })}>
                  {mode === "redo" ? "Redo scene" : "Change shot"}
                </button>
                {mode === "plan" && v.source !== "audio" && (
                  <button type="button" className="ld-btn" aria-expanded={open?.n === s.n && open.what === "line"} onClick={() => setOpen(open?.n === s.n && open.what === "line" ? null : { n: s.n, what: "line" })}>
                    Rewrite line
                  </button>
                )}
              </div>
            )}
          </div>
          {open?.n === s.n && (open.what === "shot" ? <ShotEditor v={v} n={s.n} redo={mode === "redo"} onDone={() => setOpen(null)} /> : <LineEditor v={v} n={s.n} onDone={() => setOpen(null)} />)}
        </React.Fragment>
      ))}
    </div>
  );
}

type Look = V["look"];

/** One part of Edit: read first with its own Edit button; Edit opens the choices with Save and Cancel. */
function EditPart({ title, value, children, onSave, saving, editing, setEditing }: { title: string; value: string; children: React.ReactNode; onSave: () => void; saving: boolean; editing: boolean; setEditing: (b: boolean) => void }) {
  return (
    <div className={`ld-vm-sec ${editing ? "editing" : ""}`}>
      <div className="ld-vm-sec-hd">
        <b>{title}</b>
        {!editing && <button type="button" className="ld-btn sm" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {editing ? (
        <>
          {children}
          <div className="ld-row" style={{ gap: 8 }}>
            <button type="button" className="ld-btn p sm" disabled={saving} onClick={onSave}>{saving ? "Saving..." : "Save"}</button>
            <button type="button" className="ld-btn sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <span className="ld-vm-kv">{value}</span>
      )}
    </div>
  );
}

function EditPanel({ v }: { v: V }) {
  const { orgId, refresh, utils } = useVideo(v.id);
  const opts = trpc.videos.options.useQuery({ organizationId: orgId });
  const [part, setPart] = React.useState<"captions" | "logo" | "music" | null>(null);
  const [cap, setCap] = React.useState<Look["captions"]>(v.look.captions);
  const [logo, setLogo] = React.useState<Look["logo"]>(v.look.logo);
  const [music, setMusic] = React.useState<Look["music"]>(v.look.music);
  const [upErr, setUpErr] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const musicRef = React.useRef<HTMLInputElement>(null);
  const save = trpc.videos.restyle.useMutation({
    onSuccess: async () => {
      setPart(null);
      await Promise.all([refresh(), utils.chat.list.invalidate()]);
    },
  });
  const open = (p: typeof part) => {
    setCap(v.look.captions);
    setLogo(v.look.logo);
    setMusic(v.look.music);
    setPart(p);
  };
  const uploadMusic = async (file: File | null) => {
    if (!file) return;
    setUpErr(null);
    setUploading(true);
    try {
      const t = await uploadTo<{ url: string; name: string }>("music", orgId, file);
      setMusic({ ...music, track: "upload", url: t.url, name: t.name });
    } catch (err) {
      setUpErr(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="ld-vm-edit">
      <p className="ld-small ld-muted" style={{ margin: 0 }}>{v.status === "ready" ? "Saving cuts the video again with the same footage, so it uses no work hours." : "These apply when the video is made."}</p>
      <EditPart title="Captions" value={v.lookText.captions} editing={part === "captions"} setEditing={(b) => (b ? open("captions") : setPart(null))} saving={save.isPending} onSave={() => save.mutate({ organizationId: orgId, id: v.id, captions: cap })}>
        <div className="ld-vm-kvs">
          <span>Show</span>
          <div className="ld-row" style={{ gap: 6 }}>
            <Chip on={cap.on} onClick={() => setCap({ ...cap, on: true })}>On</Chip>
            <Chip on={!cap.on} onClick={() => setCap({ ...cap, on: false })}>Off</Chip>
          </div>
          <span>Style</span>
          <div className="ld-row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(["pop", "clean", "boxed"] as const).map((k) => (
              <Chip key={k} on={cap.style === k} onClick={() => setCap({ ...cap, style: k })}>{k === "pop" ? "Bold pop" : k === "clean" ? "Clean" : "Boxed"}</Chip>
            ))}
          </div>
          <span>Position</span>
          <div className="ld-row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(["top", "middle", "bottom"] as const).map((k) => (
              <Chip key={k} on={cap.position === k} onClick={() => setCap({ ...cap, position: k })}>{k[0].toUpperCase() + k.slice(1)}</Chip>
            ))}
          </div>
          <span>Highlight</span>
          <div className="ld-row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(["gold", "brand", "none"] as const).map((k) => (
              <Chip key={k} on={cap.highlight === k} onClick={() => setCap({ ...cap, highlight: k })}>{k === "gold" ? "Gold" : k === "brand" ? "Brand color" : "None"}</Chip>
            ))}
          </div>
        </div>
      </EditPart>
      <EditPart title="Logo" value={v.lookText.logo} editing={part === "logo"} setEditing={(b) => (b ? open("logo") : setPart(null))} saving={save.isPending} onSave={() => save.mutate({ organizationId: orgId, id: v.id, logo })}>
        <div className="ld-vm-kvs">
          <span>Show</span>
          <div className="ld-row" style={{ gap: 6 }}>
            <Chip on={logo.on} disabled={!opts.data?.hasLogo} onClick={() => setLogo({ ...logo, on: true })}>On</Chip>
            <Chip on={!logo.on} onClick={() => setLogo({ ...logo, on: false })}>Off</Chip>
          </div>
          <span>Corner</span>
          <div className="ld-vm-corners" role="radiogroup" aria-label="Logo corner">
            {(["tl", "tr", "bl", "br"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={logo.corner === k} aria-label={{ tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right" }[k]} className={logo.corner === k ? "on" : ""} onClick={() => setLogo({ ...logo, corner: k })} />
            ))}
          </div>
          <span>Size</span>
          <div className="ld-row" style={{ gap: 6 }}>
            {(["s", "m", "l"] as const).map((k) => (
              <Chip key={k} on={logo.size === k} onClick={() => setLogo({ ...logo, size: k })}>{k === "s" ? "Small" : k === "m" ? "Medium" : "Large"}</Chip>
            ))}
          </div>
        </div>
        {!opts.data?.hasLogo && <span className="ld-small ld-muted">No logo uploaded yet. <Link href="/workspace">Add it under Workspace</Link>.</span>}
      </EditPart>
      <EditPart title="Music" value={v.lookText.music} editing={part === "music"} setEditing={(b) => (b ? open("music") : setPart(null))} saving={save.isPending || uploading} onSave={() => save.mutate({ organizationId: orgId, id: v.id, music })}>
        <div className="ld-vm-kvs">
          <span>Track</span>
          <div className="ld-row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(opts.data?.tracks ?? []).map((t) => (
              <Chip key={t.key} on={music.track === t.key} onClick={() => setMusic({ ...music, track: t.key as Look["music"]["track"] })}>{t.name}</Chip>
            ))}
            <Chip on={music.track === "upload"} disabled={uploading} onClick={() => (music.url ? setMusic({ ...music, track: "upload" }) : musicRef.current?.click())}>
              {uploading ? "Uploading..." : music.track === "upload" && music.name ? music.name : "Upload my own"}
            </Chip>
            <Chip on={music.track === "none"} onClick={() => setMusic({ ...music, track: "none" })}>No music</Chip>
            <input ref={musicRef} type="file" accept="audio/*,.mp3,.m4a,.wav" hidden onChange={(e) => uploadMusic(e.target.files?.[0] ?? null)} />
          </div>
          <span>Volume</span>
          <div className="ld-row" style={{ gap: 10 }}>
            <input type="range" min={0} max={100} value={music.volume} disabled={music.track === "none"} onChange={(e) => setMusic({ ...music, volume: Number(e.target.value) })} aria-label="Music volume" className="ld-vm-vol" />
            <span className="ld-small">{music.volume}</span>
          </div>
        </div>
        {upErr && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{upErr}</span>}
      </EditPart>
      <ErrorLine error={save.error} />
    </div>
  );
}

/** The people in a drawn story: each drawn once and kept the same in every scene. Change look draws them again. */
function CastCard({ v }: { v: V }) {
  const { orgId, refresh } = useVideo(v.id);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [look, setLook] = React.useState("");
  const change = trpc.videos.changeLook.useMutation({ onSuccess: async () => (setEditing(null), await refresh()) });
  return (
    <div className="ld-vm-cast">
      {v.cast.map((c, i) => (
        <React.Fragment key={c.name}>
          <div className="ld-vm-castrow">
            <span className="ld-vm-portrait">{c.portrait ? <img src={c.portrait} alt="" /> : <span>{c.name[0]}</span>}</span>
            <div className="ld-vm-castt">
              <b>{c.name}</b>
              <span>{`${c.look[0].toUpperCase()}${c.look.slice(1)}. The same in every scene.`}</span>
            </div>
            <button type="button" className="ld-btn" style={{ width: 150 }} disabled={!!v.drawing || v.status === "making"} aria-expanded={editing === i} onClick={() => (setLook(c.look), setEditing(editing === i ? null : i))}>
              Change look
            </button>
          </div>
          {editing === i && (
            <div className="ld-vm-editor">
              <label className="ld-vm-field" htmlFor={`look-${v.id}-${i}`}>
                <span className="ld-lbl">{`How ${c.name} looks`}</span>
                <input id={`look-${v.id}-${i}`} className="ld-in lg" value={look} onChange={(e) => setLook(e.target.value)} />
              </label>
              <span className="ld-small ld-muted">{`${c.name} is drawn again, with every scene ${c.name} is in.`}</span>
              <ErrorLine error={change.error} />
              <div className="ld-row" style={{ gap: 8 }}>
                <button type="button" className="ld-btn p" style={{ width: 130 }} disabled={change.isPending || !look.trim()} onClick={() => change.mutate({ organizationId: orgId, id: v.id, index: i, look })}>{change.isPending ? "Saving..." : "Save"}</button>
                <button type="button" className="ld-btn" style={{ width: 130 }} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function Player({ v, ratio }: { v: V; ratio: string }) {
  const url = v.videoUrls[ratio] ?? v.videoUrl;
  const aspect = ratio === "1:1" ? "1 / 1" : ratio === "16:9" ? "16 / 9" : "9 / 16";
  return (
    <div className="ld-vm-player" style={{ aspectRatio: aspect }}>
      <span className="ld-av-ai">AI-generated</span>
      {url && <video key={url} src={`${url}#t=0.1`} controls playsInline preload="metadata" />}
    </div>
  );
}

/** The video in chat and on the Videos tab: storyboard, making, finished, Edit. */
export function VideoCard({ id, bare = false }: { id: number; bare?: boolean }) {
  const { orgId, v, loading, refresh, utils } = useVideo(id);
  const hours = useHoursAsk();
  const [panel, setPanel] = React.useState<"edit" | "redo" | null>(null);
  const [ratio, setRatio] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const make = trpc.videos.make.useMutation({ onSuccess: refresh });
  const hook = trpc.videos.newHook.useMutation({ onSuccess: refresh });
  const versions = trpc.videos.adVersions.useMutation({ onSuccess: async () => (await refresh(), utils.chat.list.invalidate()) });
  const sienna = trpc.videos.toSienna.useMutation({ onSuccess: () => setSent(true) });
  const remove = trpc.videos.remove.useMutation({ onSuccess: refresh });
  const restyleTo = trpc.videos.changeStyle.useMutation({ onSuccess: refresh });
  const [picking, setPicking] = React.useState(false);
  if (!v) return loading ? null : <div className="ld-card ld-empty">This video was removed.</div>;
  const ready = v.status === "ready" && !!v.videoUrl;
  const drawn = v.style !== "real";
  const meta = [v.kindLabel, ...(drawn ? [v.styleLabel] : []), ready ? v.length : v.seconds > 90 ? `${Math.round(v.seconds / 60)} minutes` : `${v.seconds} seconds`, v.ratios.join(" and ")].join(" · ");
  const drawingText = v.drawing ? `Drawing the scene pictures: ${v.drawing.replace("/", " of ")}. They fill in here as they're done.` : null;
  const pill = v.status === "draft" ? "amber" : v.status === "making" ? "blue" : v.status === "ready" ? "green" : "red";
  const startMake = () => hours.confirm(`made-${v.id}`, `This video uses ${v.hours}`, () => make.mutate({ organizationId: orgId, id: v.id }));
  const shown = ratio && v.videoUrls[ratio] ? ratio : v.ratios.find((r) => v.videoUrls[r]) ?? v.ratios[0];

  return (
    <div className={bare ? "ld-vm-card bare" : "ld-card ld-vm-card"}>
      <div className="ld-vm-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="ld-vm-title">{v.title}</span>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{meta}</span>
        </div>
        <span className={`ld-pill ${pill}`}>{v.statusLabel}</span>
      </div>

      {ready ? (
        <>
          <div className="ld-vm-result">
            <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
              <Player v={v} ratio={shown} />
              {Object.keys(v.videoUrls).length > 1 && (
                <div className="ld-row" role="radiogroup" aria-label="Size" style={{ gap: 6 }}>
                  {v.ratios.filter((r) => v.videoUrls[r]).map((r) => (
                    <Chip key={r} on={shown === r} onClick={() => setRatio(r)}>{r}</Chip>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
              <div className="ld-vm-btncol">
                <a className="ld-btn p" href={v.videoUrls[shown] ?? v.videoUrl!} download={`${v.title} ${shown.replace(":", "x")}.mp4`}>Download</a>
                <button type="button" className="ld-btn" aria-pressed={panel === "edit"} onClick={() => setPanel(panel === "edit" ? null : "edit")}>Edit</button>
                <button type="button" className="ld-btn" disabled={sienna.isPending || sent} onClick={() => sienna.mutate({ organizationId: orgId, id: v.id })}>{sent ? "Sent to Sienna" : sienna.isPending ? "Sending..." : "Send to Sienna"}</button>
                <button type="button" className="ld-btn" aria-pressed={panel === "redo"} onClick={() => setPanel(panel === "redo" ? null : "redo")}>Redo a scene</button>
                {v.source !== "audio" && (
                  <button type="button" className="ld-btn" disabled={versions.isPending} onClick={() => versions.mutate({ organizationId: orgId, id: v.id })}>{versions.isPending ? "Writing..." : "Make 3 ad versions"}</button>
                )}
              </div>
              {sent && (
                <span className="ld-small">
                  It's in Sienna's drafts as a Reel. <Link href="/chats/social/work">Open her posts</Link>
                </span>
              )}
              {versions.data && <span className="ld-small">{`3 versions are in Elena's chat and on her Videos tab, ready to make.`}</span>}
              <ErrorLine error={sienna.error ?? versions.error} />
              {v.caption && (
                <div className="ld-vm-caption">
                  <span className="ld-lbl">Post caption</span>
                  <span className="ld-pre">{v.caption}</span>
                </div>
              )}
              <span className="ld-small ld-muted">{`Voice: ${v.voiceName}. Used ${v.hours}.`}</span>
            </div>
          </div>
          {panel === "edit" && <EditPanel v={v} />}
          {panel === "redo" && (
            <>
              <p className="ld-small ld-muted" style={{ margin: 0 }}>{drawn ? `Redoing a scene draws it again in ${v.styleLabel}, with the same people. ${v.motion === "clips" ? "Animating it uses hours for that scene only." : "It uses no work hours."}` : "Redoing a scene uses hours for that scene only: a new AI clip uses its own, and your b-roll, stock and text use none."}</p>
              <Scenes v={v} mode="redo" />
            </>
          )}
        </>
      ) : (
        <>
          {drawn && v.cast.length > 0 && <CastCard v={v} />}
          {drawingText && <span className="ld-vm-drawing">{drawingText}</span>}
          <Scenes v={v} mode={v.status === "making" ? "view" : "plan"} />
          <div className="ld-vm-settings">
            {drawn && (
              <div className="ld-vm-set">
                <span className="ld-lbl">Style</span>
                <b>{v.styleLabel}</b>
                <span>{v.motion === "clips" ? "Animated clips" : "Moving pictures"}</span>
              </div>
            )}
            <div className="ld-vm-set">
              <span className="ld-lbl">Voice</span>
              <b>{v.voiceName}</b>
              <span>{v.source === "audio" ? "Your recording, as it was said" : v.voiceStandard ? "A standard voice" : "From your voice"}</span>
            </div>
            <div className="ld-vm-set">
              <span className="ld-lbl">Music</span>
              <b>{v.look.music.track === "none" ? "No music" : v.lookText.music.split(",")[0]}</b>
              <span>{v.look.music.track === "none" ? "Voice only" : "Low under the voice"}</span>
            </div>
            {!drawn && (
              <div className="ld-vm-set">
                <span className="ld-lbl">Brand</span>
                <b>{v.look.logo.on ? "Logo and colors on" : "Colors on, no logo"}</b>
                <span>From your workspace</span>
              </div>
            )}
            <div className="ld-vm-set">
              <span className="ld-lbl">Captions</span>
              <b>{v.look.captions.on ? (v.look.captions.style === "pop" ? "Bold pop" : v.look.captions.style === "clean" ? "Clean" : "Boxed") : "Off"}</b>
              <span>{v.look.captions.on ? `Word by word, ${v.look.captions.position}` : "No captions"}</span>
            </div>
          </div>
          {v.status !== "making" && panel === "edit" && <EditPanel v={v} />}
          {v.status === "making" && <span className="ld-small ld-muted">Making it now. This usually takes a few minutes, and Elena posts it here when it's done.</span>}
          {v.status === "failed" && v.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{v.error}</span>}
          {hours.question(`made-${v.id}`)}
          <ErrorLine error={make.error ?? hook.error ?? remove.error ?? restyleTo.error} />
          {picking && <StylePicker title="Change style" value={v.style} onClose={() => setPicking(false)} onPick={(k) => (setPicking(false), k !== v.style && restyleTo.mutate({ organizationId: orgId, id: v.id, style: k }))} />}
          {v.status !== "making" && (
            <div className="ld-vm-foot">
              <span className="ld-vm-hours">{`Uses ${v.hours} when it's done`}</span>
              <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="ld-btn" style={{ width: 150 }} disabled={!!v.drawing || restyleTo.isPending} onClick={() => setPicking(true)}>{restyleTo.isPending ? "Changing..." : "Change style"}</button>
                <button type="button" className="ld-btn" style={{ width: 150 }} aria-pressed={panel === "edit"} onClick={() => setPanel(panel === "edit" ? null : "edit")}>Captions, logo, music</button>
                {v.source !== "audio" && (
                  <button type="button" className="ld-btn" style={{ width: 150 }} disabled={hook.isPending} onClick={() => hook.mutate({ organizationId: orgId, id: v.id })}>{hook.isPending ? "Writing..." : "New hook"}</button>
                )}
                {bare && (
                  <button type="button" className="ld-btn" style={{ width: 150 }} disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: v.id })}>Remove</button>
                )}
                <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={make.isPending || !!v.drawing} onClick={startMake}>
                  {make.isPending ? "Starting..." : v.status === "failed" ? "Try again" : "Make the video"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
