import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { Outputs } from "../types";
import { useHoursAsk } from "../HoursAsk";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";
import { uploadTo } from "./VideoAgent";
import { useStyles } from "./Styles";

/**
 * My twin on Elena's Your avatar tab:
 * - TwinCard: 1 your video (upload or record here), 2 your consent line (record or upload, checked against
 *   the video), 3 your voice (made from the video; Play sample).
 * - Looks: the grid of looks (Original, saved looks, previews) and the New look editor
 *   (name, outfit, background, before and after, Save look, Try again, Cancel).
 */

type TwinList = Outputs["twin"]["list"];
type TV = TwinList["twins"][number];
type LookV = TV["looks"][number];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const hrs = (m: number) => {
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} work ${h === 1 ? "hour" : "hours"}`;
};

function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function useTwins() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.twin.list.useQuery(
    { organizationId: currentOrgId },
    {
      enabled: currentOrgId > 0,
      refetchInterval: (r) => ((r.state.data?.twins ?? []).some((t) => t.status === "preparing" || t.consent === "checking" || t.looks.some((l) => l.status === "making")) ? 4000 : false),
    }
  );
  return { orgId: currentOrgId, data: q.data ?? null, loading: q.isLoading, refresh: () => utils.twin.list.invalidate(), utils };
}

function lengthOf(file: Blob) {
  return new Promise<number>((resolve) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      resolve(Number.isFinite(el.duration) ? el.duration : 0);
      URL.revokeObjectURL(el.src);
    };
    el.onerror = () => resolve(0);
    el.src = URL.createObjectURL(file);
  });
}

/** The twin video, sent in 40 MB parts. */
async function uploadTwin(file: File, organizationId: number, extra: { twinId?: number | null; twinName: string }, onProgress: (sent: number) => void) {
  const PART = 40_000_000;
  const total = Math.max(1, Math.ceil(file.size / PART));
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const uploadId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  let data: any = null;
  for (let index = 0; index < total; index++) {
    const offset = index * PART;
    const q = new URLSearchParams({ organizationId: String(organizationId), name: file.name, uploadId, index: String(index), total: String(total), offset: String(offset), twinName: extra.twinName, ...(extra.twinId ? { twinId: String(extra.twinId) } : {}) });
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`/api/upload/twin-part?${q.toString()}`, { method: "POST", body: file.slice(offset, offset + PART), credentials: "include", headers: { "content-type": "application/octet-stream" } }).catch(() => null);
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

// ==========================================
// Recording here (camera and microphone)
// ==========================================

function Recorder({ title, hint, maxSeconds, onDone, onCancel }: { title: string; hint?: React.ReactNode; maxSeconds: number; onDone: (file: File) => void; onCancel: () => void }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const stream = React.useRef<MediaStream | null>(null);
  const rec = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const [state, setState] = React.useState<"starting" | "ready" | "recording" | "error">("starting");
  const [secs, setSecs] = React.useState(0);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (ref.current) ref.current.srcObject = s;
        setState("ready");
      })
      .catch(() => {
        setErr("The camera or microphone couldn't open. Allow them for this site, or upload a video instead.");
        setState("error");
      });
    return () => {
      alive = false;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  React.useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state]);
  React.useEffect(() => {
    if (state === "recording" && secs >= maxSeconds) stop();
  }, [secs]);
  const start = () => {
    if (!stream.current) return;
    chunks.current = [];
    const type = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
    const r = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      const mime = r.mimeType || "video/webm";
      const blob = new Blob(chunks.current, { type: mime });
      onDone(new File([blob], `recording.${mime.includes("mp4") ? "mp4" : "webm"}`, { type: mime }));
    };
    rec.current = r;
    r.start(1000);
    setSecs(0);
    setState("recording");
  };
  const stop = () => {
    rec.current?.state === "recording" && rec.current.stop();
    stream.current?.getTracks().forEach((t) => t.stop());
  };
  return (
    <div className="ld-tw-rec">
      <b style={{ fontSize: 15 }}>{title}</b>
      {hint}
      <div className="ld-tw-cam">
        <video ref={ref} autoPlay muted playsInline />
        {state === "recording" && <span className="ld-tw-recdot">REC {fmt(secs)}</span>}
      </div>
      {err && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{err}</span>}
      <div className="ld-row" style={{ gap: 8 }}>
        {state === "recording" ? (
          <button type="button" className="ld-btn p" style={{ width: 150 }} onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={state !== "ready"} onClick={start}>Start</button>
        )}
        <button type="button" className="ld-btn" style={{ width: 150 }} onClick={() => (stop(), onCancel())}>Cancel</button>
      </div>
    </div>
  );
}

// ==========================================
// My twin
// ==========================================

export function TwinSection() {
  const { data, loading } = useTwins();
  if (!data) return <div className="ld-card ld-empty">{loading ? "Loading..." : "Couldn't load your twin."}</div>;
  const t = data.twins[0] ?? null;
  return (
    <>
      <div className="ld-tw-grid">
        <TwinCard t={t} data={data} />
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="ld-card ld-tw-tip">
            <b>A good video</b>
            <span>About 2 minutes of you talking to the camera like you would to a client or colleague. Face the camera, chest up, steady phone or webcam, good light from the front, a quiet room, no one else in frame. Natural hand movement is fine; keep it calm.</span>
          </div>
          <div className="ld-card ld-tw-tip">
            <b>Who can have a twin</b>
            <span>Only the person in the video, with their own consent line. Never a client, a team member who didn't record their own consent, or anyone else.</span>
          </div>
        </div>
      </div>
      {t?.usable && <Looks t={t} data={data} />}
    </>
  );
}

function TwinCard({ t, data }: { t: TV | null; data: TwinList }) {
  const { orgId, refresh } = useTwins();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const consentRef = React.useRef<HTMLInputElement>(null);
  const [mode, setMode] = React.useState<null | "record" | "consent">(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [sample, setSample] = React.useState<string | null>(null);
  const setConsent = trpc.twin.setConsent.useMutation({ onSuccess: refresh, onError: (e) => setErr(e.message) });
  const makeVoice = trpc.twin.makeVoice.useMutation({ onSuccess: refresh });
  const play = trpc.twin.sample.useMutation({ onSuccess: (r) => setSample(r.url) });
  const remove = trpc.twin.remove.useMutation({ onSuccess: refresh });
  const name = t?.name || data.myName || "";
  const line = t?.consentLine ?? data.consentLine;

  const sendVideo = async (f: File | null) => {
    if (!f) return;
    setErr(null);
    if (!/\.(mp4|mov|m4v|webm)$/i.test(f.name)) return setErr("Upload an MP4 or MOV video.");
    const secs = await lengthOf(f);
    if (secs && secs < 29) return setErr(`The video needs at least 30 seconds of you talking. This one is ${fmt(secs)}.`);
    if (secs > 5 * 60 + 1) return setErr(`Videos can be up to 5 minutes. This one is ${fmt(secs)}.`);
    setProgress(0);
    try {
      await uploadTwin(f, orgId, { twinId: t?.id ?? null, twinName: name }, setProgress);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setProgress(null);
    }
  };
  const sendConsent = async (f: File | null) => {
    if (!f || !t) return;
    setErr(null);
    setProgress(0);
    try {
      const r = await uploadTo<{ url: string }>("twin_consent", orgId, f);
      setConsent.mutate({ organizationId: orgId, id: t.id, url: r.url });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setProgress(null);
    }
  };

  const step = t?.step ?? 1;
  const videoDone = !!t && t.status === "ready" && !!t.sourceUrl;
  const consentDone = t?.consent === "ok";
  const voiceDone = !!t?.voiceId;
  const pill = t?.usable && voiceDone ? <span className="ld-pill green">Ready</span> : <span className="ld-pill amber">Step {Math.min(step, 3)} of 3</span>;

  if (mode === "record")
    return (
      <div className="ld-card ld-tw-card">
        <Recorder title="Record your video" maxSeconds={300} hint={<span className="ld-small" style={{ color: "var(--ld-text2)" }}>Talk to the camera for about 2 minutes, like you would to a client. It stops at 5 minutes.</span>} onCancel={() => setMode(null)} onDone={(f) => (setMode(null), void sendVideo(f))} />
      </div>
    );
  if (mode === "consent")
    return (
      <div className="ld-card ld-tw-card">
        <Recorder title="Record your consent" maxSeconds={30} hint={<span className="ld-tw-line">"{line}"</span>} onCancel={() => setMode(null)} onDone={(f) => (setMode(null), void sendConsent(f))} />
      </div>
    );

  return (
    <div className="ld-card ld-tw-card">
      <div className="ld-row" style={{ justifyContent: "space-between", gap: 10, paddingTop: 12 }}>
        <b style={{ fontSize: 17 }}>My twin</b>
        {pill}
      </div>
      <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" hidden onChange={(e) => (void sendVideo(e.target.files?.[0] ?? null), (e.target.value = ""))} />
      <input ref={consentRef} type="file" accept="video/*,audio/*" hidden onChange={(e) => (void sendConsent(e.target.files?.[0] ?? null), (e.target.value = ""))} />

      <div className="ld-tw-step">
        <span className={`num ${videoDone ? "done" : "now"}`}>{videoDone ? "✓" : "1"}</span>
        <div className="ld-tw-what">
          {t?.thumbUrl ? <img src={t.thumbUrl} alt="" className="ld-tw-thumb" /> : <span className="ld-tw-thumb face" aria-hidden="true"><i /><b /></span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <b style={{ fontSize: 15 }}>Your video</b>
            {!t ? (
              <span className="ld-small">MP4 or MOV, 30 seconds to 5 minutes of you talking to the camera.</span>
            ) : t.status === "preparing" ? (
              <span className="ld-small">Reading your video...</span>
            ) : t.status === "failed" ? (
              <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{t.error}</span>
            ) : (
              <span className="ld-small">{`${t.length ?? ""} · added ${fmtDate(t.updatedAt)}`}</span>
            )}
            {progress !== null && <span className="ld-small">Uploading {Math.round(progress * 100)}%</span>}
          </div>
        </div>
        <div className="ld-tw-btns">
          <button type="button" className="ld-btn" disabled={progress !== null || t?.status === "preparing"} onClick={() => fileRef.current?.click()}>{t?.sourceUrl ? "Replace" : "Upload video"}</button>
          {!t?.sourceUrl && <button type="button" className="ld-btn" disabled={progress !== null} onClick={() => setMode("record")}>Record here</button>}
        </div>
      </div>

      <div className="ld-tw-step">
        <span className={`num ${consentDone ? "done" : videoDone ? "now" : ""}`}>{consentDone ? "✓" : "2"}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>Your consent</b>
          {consentDone ? (
            <span className="ld-small">{t?.consentNote ?? "Heard"}. Only you can use your twin.</span>
          ) : (
            <>
              <span className="ld-small">Record yourself saying this line once. Elena checks it's the same person as your video.</span>
              <span className="ld-tw-line">"{line}"</span>
              {t?.consent === "checking" && <span className="ld-small">Checking your recording...</span>}
              {t?.consent === "failed" && t.consentNote && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{t.consentNote}</span>}
            </>
          )}
        </div>
        <div className="ld-tw-btns">
          {!consentDone && (
            <>
              <button type="button" className="ld-btn p" disabled={!videoDone || progress !== null || t?.consent === "checking"} onClick={() => setMode("consent")}>Record</button>
              <button type="button" className="ld-btn" disabled={!videoDone || progress !== null || t?.consent === "checking"} onClick={() => consentRef.current?.click()}>Upload</button>
            </>
          )}
        </div>
      </div>

      <div className="ld-tw-step last">
        <span className={`num ${voiceDone ? "done" : consentDone ? "now" : ""}`}>{voiceDone ? "✓" : "3"}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>Your voice</b>
          <span className="ld-small">{voiceDone ? t!.voiceName : t?.voiceNote ?? "Made from your video once your consent is in. You can play a sample before using it."}</span>
          {sample && <audio src={sample} controls autoPlay style={{ maxWidth: "100%", height: 36 }} />}
        </div>
        <div className="ld-tw-btns">
          {voiceDone ? (
            <button type="button" className="ld-btn" disabled={play.isPending} onClick={() => play.mutate({ organizationId: orgId, id: t!.id })}>{play.isPending ? "Making..." : "Play sample"}</button>
          ) : consentDone ? (
            <button type="button" className="ld-btn" disabled={makeVoice.isPending} onClick={() => makeVoice.mutate({ organizationId: orgId, id: t!.id })}>{makeVoice.isPending ? "Making..." : "Make voice"}</button>
          ) : (
            <button type="button" className="ld-btn" disabled>Play sample</button>
          )}
        </div>
      </div>
      {err && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{err}</span>}
      <ErrorLine error={makeVoice.error ?? play.error ?? remove.error} />
      {t && (
        <div style={{ paddingBottom: 14 }}>
          <button type="button" className="ld-btn" style={{ width: 150 }} disabled={remove.isPending} onClick={() => window.confirm("Delete your twin and its looks? Videos already made stay.") && remove.mutate({ organizationId: orgId, id: t.id })}>Delete twin</button>
        </div>
      )}
    </div>
  );
}

// ==========================================
// Looks
// ==========================================

type BgType = "room" | "picture" | "color" | "clip" | "style";
const BG_LABEL: Record<BgType, string> = { room: "Keep my room", picture: "Picture", color: "Brand color", clip: "B-roll clip", style: "Drawn style" };
const OUTFIT_LABEL = { keep: "Keep mine", describe: "Describe it", photo: "From a photo" } as const;

function bgText(l: LookV) {
  const b = l.background;
  if (b.type === "room") return "Your room";
  if (b.type === "color") return `Color ${b.color ?? ""}`.trim();
  if (b.type === "clip") return "A b-roll clip";
  if (b.type === "style") return b.place ? `Drawn: ${b.place}` : "A drawn place";
  return "Your picture";
}
function outfitText(l: LookV) {
  return l.outfit === "keep" ? "Your clothes" : l.outfit === "photo" ? "The outfit in your photo" : l.outfitText ?? "A new outfit";
}

function Looks({ t, data }: { t: TV; data: TwinList }) {
  const [sel, setSel] = React.useState<number | "new" | null>(null);
  const looks = t.looks;
  const cur = typeof sel === "number" ? looks.find((l) => l.id === sel) ?? null : null;
  return (
    <div className="ld-card ld-tw-looks">
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <b style={{ fontSize: 17 }}>Looks</b>
        <span className="ld-small">Your twin in other clothes or another place. Every video's avatar picker offers your saved looks.</span>
      </div>
      <div className="ld-tw-lgrid">
        <div className="ld-tw-look">
          {t.thumbUrl ? <img src={t.thumbUrl} alt="" className="pv" /> : <span className="pv" />}
          <b>Original</b>
          <span className="ld-small">From your video</span>
        </div>
        {looks.map((l) => (
          <button key={l.id} type="button" aria-pressed={sel === l.id} className={`ld-tw-look ${sel === l.id ? "on" : ""}`} onClick={() => setSel(sel === l.id ? null : l.id)}>
            {l.thumbUrl ? <img src={l.thumbUrl} alt="" className="pv" /> : <span className="pv wait">{l.status === "making" ? "Making the preview" : l.status === "failed" ? "Didn't work" : ""}</span>}
            <b>{l.name}</b>
            <span className="ld-small">{l.status === "saved" ? bgText(l) : l.status === "preview" ? "Not saved" : l.status === "making" ? "Not saved" : "Try again"}</span>
          </button>
        ))}
        <button type="button" aria-pressed={sel === "new"} className={`ld-tw-look new ${sel === "new" ? "on" : ""}`} onClick={() => setSel(sel === "new" ? null : "new")}>
          <b>New look</b>
        </button>
      </div>
      {sel === "new" && <NewLook t={t} data={data} onMade={(id) => setSel(id)} onCancel={() => setSel(null)} />}
      {cur && <LookPanel t={t} l={cur} onClose={() => setSel(null)} />}
    </div>
  );
}

function NewLook({ t, data, onMade, onCancel }: { t: TV; data: TwinList; onMade: (id: number) => void; onCancel: () => void }) {
  const { orgId, refresh } = useTwins();
  const hours = useHoursAsk();
  const styles = useStyles();
  const clips = trpc.broll.list.useQuery({ organizationId: orgId }, { enabled: orgId > 0 });
  const org = trpc.edits.options.useQuery({ organizationId: orgId }, { enabled: orgId > 0 });
  const [name, setName] = React.useState("");
  const [outfit, setOutfit] = React.useState<"keep" | "describe" | "photo">("describe");
  const [outfitTextV, setOutfitText] = React.useState("");
  const [outfitPhoto, setOutfitPhoto] = React.useState<string | null>(null);
  const [bg, setBg] = React.useState<BgType>("room");
  const [color, setColor] = React.useState<string | null>(null);
  const [picture, setPicture] = React.useState<string | null>(null);
  const [clipId, setClipId] = React.useState<number | null>(null);
  const [style, setStyle] = React.useState("studio");
  const [place, setPlace] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const shownColor = color ?? org.data?.brandColor ?? "#1B6B4A";
  const cost = trpc.twin.lookMinutes.useQuery({ organizationId: orgId, twinId: t.id, outfit, background: bg }, { enabled: orgId > 0 });
  const make = trpc.twin.newLook.useMutation({
    onSuccess: async (r) => {
      await refresh();
      onMade(r.id);
    },
    onError: (e) => setErr(e.message),
  });
  const upload = async (f: File | null, set: (url: string) => void) => {
    if (!f) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await uploadTo<{ url: string }>("style_ref", orgId, f);
      set(r.url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    setErr(null);
    const run = () =>
      make.mutate({
        organizationId: orgId,
        twinId: t.id,
        name: name.trim() || "New look",
        outfit,
        outfitText: outfit === "describe" ? outfitTextV : null,
        outfitPhoto: outfit === "photo" ? outfitPhoto : null,
        background: { type: bg, color: bg === "color" ? shownColor : null, url: bg === "picture" ? picture : null, clipId: bg === "clip" ? clipId : null, style: bg === "style" ? style : null, place: bg === "style" ? place : null },
      });
    const m = cost.data?.minutes ?? 0;
    if (m >= 180) hours.confirm(`look-${t.id}`, `This preview uses ${hrs(m)}`, run);
    else run();
  };
  const readyClips = (clips.data?.clips ?? []).filter((c) => c.status === "ready" && c.url);
  const drawn = styles.all.filter((s) => s.key !== "auto" && s.key !== "real");
  return (
    <div className="ld-tw-edit">
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <b style={{ fontSize: 15 }}>New look</b>
        <div className="ld-tw-kv">
          <span className="ld-lbl">Name</span>
          <input className="ld-in lg" style={{ maxWidth: 320 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Conference keynote" />
          <span className="ld-lbl">Outfit</span>
          <div className="ld-dv-chips">
            {(Object.keys(OUTFIT_LABEL) as (keyof typeof OUTFIT_LABEL)[]).map((k) => (
              <Chip key={k} on={outfit === k} onClick={() => setOutfit(k)}>{OUTFIT_LABEL[k]}</Chip>
            ))}
          </div>
          {outfit === "describe" && (
            <>
              <span />
              <input className="ld-in lg" value={outfitTextV} onChange={(e) => setOutfitText(e.target.value)} placeholder="A navy blazer over a white top" />
            </>
          )}
          {outfit === "photo" && (
            <>
              <span />
              <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
                {outfitPhoto && <img src={outfitPhoto} alt="The outfit" className="ld-tw-mini" />}
                <label className="ld-btn" style={{ width: 150 }}>
                  {busy ? "Uploading..." : outfitPhoto ? "Replace photo" : "Upload photo"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0] ?? null, setOutfitPhoto)} />
                </label>
              </div>
            </>
          )}
          <span className="ld-lbl">Background</span>
          <div className="ld-dv-chips">
            {(Object.keys(BG_LABEL) as BgType[]).map((k) => (
              <Chip key={k} on={bg === k} onClick={() => setBg(k)}>{BG_LABEL[k]}</Chip>
            ))}
          </div>
          {bg === "color" && (
            <>
              <span className="ld-lbl">Color</span>
              <div className="ld-row" style={{ gap: 8 }}>
                <input type="color" aria-label="Background color" value={shownColor} onChange={(e) => setColor(e.target.value)} className="ld-tw-color" />
                <span>{shownColor.toUpperCase()}</span>
              </div>
            </>
          )}
          {bg === "picture" && (
            <>
              <span className="ld-lbl">Picture</span>
              <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
                {picture && <img src={picture} alt="The background" className="ld-tw-mini wide" />}
                <label className="ld-btn" style={{ width: 150 }}>
                  {busy ? "Uploading..." : picture ? "Replace picture" : "Upload picture"}
                  <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void upload(e.target.files?.[0] ?? null, setPicture)} />
                </label>
              </div>
            </>
          )}
          {bg === "clip" && (
            <>
              <span className="ld-lbl">Clip</span>
              <select className="ld-in lg" style={{ maxWidth: 360 }} value={clipId ?? ""} onChange={(e) => setClipId(Number(e.target.value) || null)}>
                <option value="">{readyClips.length ? "Pick a clip" : "No b-roll clips yet"}</option>
                {readyClips.map((c) => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
            </>
          )}
          {bg === "style" && (
            <>
              <span className="ld-lbl">Style</span>
              <select className="ld-in lg" style={{ maxWidth: 360 }} value={style} onChange={(e) => setStyle(e.target.value)}>
                {drawn.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
              <span className="ld-lbl">Place</span>
              <input className="ld-in lg" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="A bright modern office" />
            </>
          )}
        </div>
        <span className="ld-small" style={{ lineHeight: 1.5 }}>The background is swapped exactly. The outfit is redrawn by AI from a 10-second piece of your video, so check that your face, hair and hands still look like you. Only saved looks are used in videos.</span>
        {err && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{err}</span>}
        <span className="ld-pill amber">{cost.data ? (cost.data.minutes ? `Preview uses ${hrs(cost.data.minutes)}` : "Change the outfit or the background") : "Preview uses work hours"}</span>
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="ld-btn p" style={{ width: 130 }} disabled={make.isPending || busy || !cost.data?.minutes} onClick={submit}>{make.isPending ? "Starting..." : "Make preview"}</button>
          <button type="button" className="ld-btn" style={{ width: 130 }} onClick={onCancel}>Cancel</button>
        </div>
        {hours.question(`look-${t.id}`)}
      </div>
      <div className="ld-tw-ba">
        <span className="ld-lbl">Before and after</span>
        <div className="ld-tw-ba2">
          {t.thumbUrl ? <img src={t.thumbUrl} alt="Before" className="pv" /> : <span className="pv" />}
          <span className="pv wait">The preview shows here</span>
        </div>
      </div>
    </div>
  );
}

function LookPanel({ t, l, onClose }: { t: TV; l: LookV; onClose: () => void }) {
  const { orgId, refresh } = useTwins();
  const hours = useHoursAsk();
  const [playing, setPlaying] = React.useState(false);
  const save = trpc.twin.saveLook.useMutation({ onSuccess: refresh });
  const retry = trpc.twin.retryLook.useMutation({ onSuccess: refresh });
  const remove = trpc.twin.removeLook.useMutation({ onSuccess: async () => (await refresh(), onClose()) });
  const cost = trpc.twin.lookMinutes.useQuery({ organizationId: orgId, twinId: t.id, outfit: l.outfit as "keep" | "describe" | "photo", background: l.background.type as BgType }, { enabled: orgId > 0 });
  const again = () => hours.confirm(`relook-${l.id}`, `Trying again uses ${hrs(cost.data?.minutes ?? 0)}`, () => retry.mutate({ organizationId: orgId, id: l.id }));
  return (
    <div className="ld-tw-edit">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div className="ld-row" style={{ justifyContent: "space-between", gap: 10 }}>
          <b style={{ fontSize: 15 }}>{l.name}</b>
          <span className={`ld-pill ${l.status === "saved" ? "green" : l.status === "failed" ? "red" : l.status === "making" ? "blue" : "amber"}`}>{l.status === "saved" ? "Saved" : l.status === "preview" ? "Preview" : l.status === "making" ? "Making" : "Didn't work"}</span>
        </div>
        <div className="ld-tw-kv">
          <span className="ld-lbl">Outfit</span>
          <span>{outfitText(l)}</span>
          <span className="ld-lbl">Background</span>
          <span>{bgText(l)}</span>
        </div>
        {l.status === "making" && <span className="ld-small">Making the preview. It takes a few minutes.</span>}
        {l.status === "failed" && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{l.error}</span>}
        {l.status === "preview" && <span className="ld-small" style={{ lineHeight: 1.5 }}>Check that your face, hair and hands still look like you. Only saved looks are used in videos.</span>}
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {l.status === "preview" && <button type="button" className="ld-btn p" style={{ width: 130 }} disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: l.id })}>Save look</button>}
          {(l.status === "preview" || l.status === "failed") && <button type="button" className="ld-btn" style={{ width: 130 }} disabled={retry.isPending} onClick={again}>Try again</button>}
          {l.status !== "making" && (
            <button type="button" className="ld-btn" style={{ width: 130 }} disabled={remove.isPending} onClick={() => (l.status === "saved" ? window.confirm(`Delete the look "${l.name}"?`) : true) && remove.mutate({ organizationId: orgId, id: l.id })}>{l.status === "saved" ? "Delete" : "Cancel"}</button>
          )}
        </div>
        {hours.question(`relook-${l.id}`)}
        <ErrorLine error={save.error ?? retry.error ?? remove.error} />
      </div>
      <div className="ld-tw-ba">
        <span className="ld-lbl">Before and after</span>
        <div className="ld-tw-ba2">
          {t.thumbUrl ? <img src={t.thumbUrl} alt="Before" className="pv" /> : <span className="pv" />}
          {playing && l.baseUrl ? <video src={l.baseUrl} className="pv" autoPlay controls playsInline /> : l.thumbUrl ? <img src={l.thumbUrl} alt="After" className="pv" /> : <span className="pv wait">{l.status === "making" ? "Making the preview" : ""}</span>}
        </div>
        <button type="button" className="ld-btn" style={{ width: "100%" }} disabled={!l.baseUrl} onClick={() => setPlaying(!playing)}>{playing ? "Show the picture" : "Play preview"}</button>
      </div>
    </div>
  );
}
