import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";

/**
 * Elena's videos of the owner, made by AI from her photo and her own voice:
 * the card in chat (script, Make it, then the finished video), the Your videos
 * tab (settings and every video), and the settings editor.
 */

type View = {
  id: number;
  title: string;
  script: string;
  status: "draft" | "making" | "ready" | "failed";
  length: string;
  cost: string;
  quality: string;
  voiceName: string | null;
  photoTitle: string | null;
  /** Who is on camera: a made-up person from the cast (null: the owner). */
  who?: { id: number; name: string; look: string; photoUrl: string | null } | null;
  videoUrl: string | null;
  error: string | null;
  madeAt: Date | string | null;
  createdAt: Date | string;
};

const PILL: Record<View["status"], [string, string]> = {
  draft: ["gray", "Script ready"],
  making: ["amber", "Making"],
  ready: ["green", "Ready"],
  failed: ["red", "Didn't finish"],
};

function StatusPill({ status }: { status: View["status"] }) {
  const [cls, label] = PILL[status];
  return <span className={`ld-pill ${cls}`}>{label}</span>;
}

function Player({ url, width = 200 }: { url: string; width?: number }) {
  return (
    <div className="ld-av-player" style={{ width }}>
      <span className="ld-av-ai">AI-generated</span>
      <video src={url} controls playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#1f1a1c" }} />
    </div>
  );
}

function useAvatarActions(id: number) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.avatar.get.invalidate({ organizationId: currentOrgId, id }), utils.avatar.list.invalidate(), utils.avatar.settings.invalidate()]);
  return {
    make: trpc.avatar.make.useMutation({ onSuccess: refresh }),
    newLook: trpc.avatar.newLook.useMutation({ onSuccess: refresh }),
    setVoice: trpc.avatar.setCastVoice.useMutation({ onSuccess: refresh }),
    again: trpc.avatar.again.useMutation({ onSuccess: () => { void refresh(); void utils.chat.list.invalidate(); } }),
    save: trpc.avatar.updateScript.useMutation({ onSuccess: refresh }),
    remove: trpc.avatar.remove.useMutation({ onSuccess: refresh }),
    orgId: currentOrgId,
  };
}

/** Edit opens the title and the words; Save or Cancel. */
function ScriptEditor({ v, onDone }: { v: View; onDone: () => void }) {
  const a = useAvatarActions(v.id);
  const [title, setTitle] = React.useState(v.title);
  const [script, setScript] = React.useState(v.script);
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <label className="ld-lbl" htmlFor={`av-t-${v.id}`}>Title</label>
      <input id={`av-t-${v.id}`} className="ld-in" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label className="ld-lbl" htmlFor={`av-s-${v.id}`}>What you say</label>
      <textarea id={`av-s-${v.id}`} className="ld-in" rows={6} value={script} onChange={(e) => setScript(e.target.value)} style={{ height: "auto", padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }} />
      <span className="ld-small ld-muted">About {Math.max(3, Math.round(words / 2.5))} seconds</span>
      <div className="ld-row">
        <button type="button" className="ld-btn p" disabled={a.save.isPending || !script.trim()} onClick={() => a.save.mutate({ organizationId: a.orgId, id: v.id, title, script }, { onSuccess: onDone })}>
          Save
        </button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
      <ErrorLine error={a.save.error} />
    </div>
  );
}

/** The card under Elena's message. */
/**
 * The voice of a made-up person on camera: pick from the stock voices and play a sample before
 * making the video. The cast member keeps the voice for every video they are in.
 */
function CastVoice({ v, a }: { v: View; a: ReturnType<typeof useAvatarActions> }) {
  const { currentOrgId } = useTenant();
  const voices = trpc.avatar.castVoices.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, staleTime: 300_000 });
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string>("");
  const current = voices.data?.find((x) => x.name === v.voiceName) ?? null;
  const chosen = picked || current?.id || "";
  const play = () => {
    const voice = voices.data?.find((x) => x.id === chosen);
    if (!voice?.previewUrl) return;
    if (audio.current) { audio.current.pause(); audio.current = null; }
    if (playing === voice.id) { setPlaying(null); return; }
    const el = new Audio(voice.previewUrl);
    audio.current = el;
    setPlaying(voice.id);
    el.onended = () => setPlaying(null);
    void el.play().catch(() => setPlaying(null));
  };
  const label = (x: { name: string; gender: string; accent: string; description: string }) => [x.name, [x.gender, x.accent, x.description].filter(Boolean).join(", ")].filter(Boolean).join(": ");
  return (
    <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
      <label className="ld-small ld-muted" htmlFor={`cv-${v.id}`}>Voice</label>
      <select id={`cv-${v.id}`} className="ld-in" style={{ height: 32, flex: "1 1 140px", minWidth: 0, maxWidth: 260 }} value={chosen} disabled={v.status === "making" || a.setVoice.isPending} onChange={(e) => { setPicked(e.target.value); setPlaying(null); }}>
        {!current && v.voiceName && <option value="">{v.voiceName}</option>}
        {(voices.data ?? []).map((x) => <option key={x.id} value={x.id}>{label(x)}</option>)}
      </select>
      <button type="button" className="ld-btn sm" disabled={!chosen || !voices.data?.find((x) => x.id === chosen)?.previewUrl} onClick={play}>{playing && playing === chosen ? "Stop" : "Play"}</button>
      {chosen && chosen !== current?.id && v.status !== "making" && (
        <button type="button" className="ld-btn sm p" disabled={a.setVoice.isPending} onClick={() => a.setVoice.mutate({ organizationId: a.orgId, id: v.id, voiceId: chosen }, { onSuccess: () => setPicked("") })}>
          {a.setVoice.isPending ? "Saving..." : "Use it"}
        </button>
      )}
    </div>
  );
}

export function AvatarVideoCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.avatar.get.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data?.status === "making" ? 10_000 : false) });
  const a = useAvatarActions(id);
  const [editing, setEditing] = React.useState(false);
  const v = q.data as View | null | undefined;
  if (!v) return q.isLoading ? null : <div className="ld-card ld-empty">This video was deleted.</div>;
  const meta = [v.length, v.quality === "pro" ? "Pro" : "Standard", v.cost, v.status === "ready" && v.madeAt ? fmtDate(v.madeAt) : ""].filter(Boolean).join(" · ");
  return (
    <div className="ld-card ld-av-card" style={{ gridTemplateColumns: v.status === "ready" && v.videoUrl ? "200px minmax(0,1fr) 128px" : v.who?.photoUrl ? "96px minmax(0,1fr) 128px" : "minmax(0,1fr) 128px" }}>
      {v.status === "ready" && v.videoUrl && <Player url={v.videoUrl} />}
      {v.status !== "ready" && v.who?.photoUrl && <img src={v.who.photoUrl} alt={v.who.name} className="ld-av-thumb cast" />}
      {editing ? (
        <ScriptEditor v={v} onDone={() => setEditing(false)} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div className="ld-row" style={{ flexWrap: "wrap" }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>{v.title}</span>
            <StatusPill status={v.status} />
          </div>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{meta}</span>
          {v.who && <span className="ld-small ld-muted">On camera: <b>{v.who.name}</b>, {v.who.look}</span>}
          {v.who && !editing && <CastVoice v={v} a={a} />}
          {v.status === "ready" ? (
            <span className="ld-small ld-muted">TikTok asks you to turn on its AI-generated label when you post.</span>
          ) : (
            <span style={{ fontSize: 14, lineHeight: 1.6 }}>"{v.script}"</span>
          )}
          {v.status === "making" && <span className="ld-small ld-muted">This usually takes 3 to 8 minutes. Elena posts it here when it's done.</span>}
          {v.status === "failed" && v.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{v.error}</span>}
          <ErrorLine error={a.make.error ?? a.again.error ?? a.newLook.error} />
        </div>
      )}
      {!editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(v.status === "draft" || v.status === "failed") && (
            <>
              <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.make.mutate({ organizationId: a.orgId, id })}>
                {a.make.isPending ? "Starting..." : v.status === "failed" ? "Try again" : "Make it"}
              </button>
              <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit script</button>
              {v.who && (
                <button type="button" className="ld-btn" disabled={a.newLook.isPending} onClick={() => a.newLook.mutate({ organizationId: a.orgId, id })}>
                  {a.newLook.isPending ? "Making..." : "New look"}
                </button>
              )}
            </>
          )}
          {v.status === "ready" && v.videoUrl && (
            <>
              <a className="ld-btn p ld-av-link" href={v.videoUrl} download={`${v.title}.mp4`}>Download</a>
              <button type="button" className="ld-btn" disabled={a.again.isPending} onClick={() => a.again.mutate({ organizationId: a.orgId, id })}>
                {a.again.isPending ? "Starting..." : "Make again"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ==========================================
// Your videos tab
// ==========================================

const COLS = "minmax(0,2fr) 90px 130px 110px 150px 128px";
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function SettingsCard() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.avatar.settings.useQuery({ organizationId: currentOrgId });
  const save = trpc.avatar.saveSettings.useMutation({ onSuccess: async () => { setEditing(false); await utils.avatar.settings.invalidate(); } });
  const [editing, setEditing] = React.useState(false);
  const [form, setForm] = React.useState<{ imageId: number | null; voiceId: string | null; quality: "standard" | "pro"; limit: string }>({ imageId: null, voiceId: null, quality: "standard", limit: "50" });
  const s = q.data;
  if (!s) return <div className="ld-card ld-empty">{q.isLoading ? "Loading..." : "Couldn't load your avatar settings."}</div>;
  const photo = s.photos.find((p) => p.id === s.imageId) ?? s.photos[0] ?? null;
  const voice = s.voices.find((v) => v.id === s.voiceId) ?? (s.voiceName ? { id: s.voiceId ?? "", name: s.voiceName, own: true } : s.voices.find((v) => v.own)) ?? null;
  const open = () => {
    setForm({ imageId: photo?.id ?? null, voiceId: voice?.id ?? null, quality: s.quality, limit: String(Math.round(s.limitCents / 100)) });
    setEditing(true);
  };
  const rate = (k: "standard" | "pro") => `$${(s.rates[k] / 100).toFixed(3).replace(/0$/, "")} a second`;
  const missing = !s.ready.fal || !s.ready.voice;

  return (
    <div className="ld-card ld-av-set">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <span className="ld-lbl">Your avatar</span>
        {!editing ? (
          <div className="ld-av-kv">
            <span className="ld-strong">Photo</span>
            <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              {photo ? (
                <>
                  <img src={photo.url} alt="" className="ld-av-thumb sm" />
                  <span style={{ overflowWrap: "anywhere" }}>{photo.title}</span>
                </>
              ) : (
                "None yet. Add a photo of yourself to the Brain or attach one in Elena's chat."
              )}
            </span>
            <span className="ld-strong">Voice</span>
            <span>{voice ? voice.name : s.ready.voice ? "Not picked yet" : "Voice isn't set up"}</span>
            <span className="ld-strong">Quality</span>
            <span>{s.quality === "pro" ? "Pro" : "Standard"}, {rate(s.quality)}</span>
            <span className="ld-strong">This month</span>
            <span>{money(s.spentCents)} of {money(s.limitCents)}</span>
          </div>
        ) : (
          <div className="ld-av-kv">
            <span className="ld-strong">Photo</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {s.photos.map((p) => (
                  <button key={p.id} type="button" className={`ld-av-pick ${form.imageId === p.id ? "on" : ""}`} aria-pressed={form.imageId === p.id} title={p.title} onClick={() => setForm({ ...form, imageId: p.id })}>
                    <img src={p.url} alt={p.title} className="ld-av-thumb" />
                  </button>
                ))}
                {!s.photos.length && <span className="ld-small">No photos in the Brain yet.</span>}
              </div>
              <span className="ld-small ld-muted">Pick one facing the camera, in good light. A tall (portrait) photo makes a vertical video.</span>
            </div>
            <label className="ld-strong" htmlFor="av-voice">Voice</label>
            <select id="av-voice" className="ld-in" style={{ maxWidth: 360 }} value={form.voiceId ?? ""} onChange={(e) => setForm({ ...form, voiceId: e.target.value || null })}>
              <option value="">Pick your voice</option>
              {s.voiceId && !s.voices.some((v) => v.id === s.voiceId) && <option value={s.voiceId}>{s.voiceName ?? "Your saved voice"}</option>}
              {s.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}{v.own ? " (your voice)" : ""}
                </option>
              ))}
            </select>
            <span className="ld-strong">Quality</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(["standard", "pro"] as const).map((k) => (
                <button key={k} type="button" className={`ld-chip ${form.quality === k ? "on" : ""}`} aria-pressed={form.quality === k} onClick={() => setForm({ ...form, quality: k })}>
                  {k === "pro" ? "Pro" : "Standard"}, {rate(k)}
                </button>
              ))}
            </div>
            <label className="ld-strong" htmlFor="av-limit">Monthly limit</label>
            <div className="ld-row">
              <span>$</span>
              <input id="av-limit" className="ld-in" inputMode="numeric" style={{ maxWidth: 100 }} value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value.replace(/[^0-9]/g, "") })} />
              <span className="ld-small ld-muted">Elena won't start a video that goes over it.</span>
            </div>
          </div>
        )}
        {missing && <span className="ld-small" style={{ color: "#8a4510" }}>Making videos isn't set up yet. LeadDash support can turn it on.</span>}
        <ErrorLine error={save.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing ? (
          <>
            <button
              type="button"
              className="ld-btn p"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  organizationId: currentOrgId,
                  imageId: form.imageId,
                  voiceId: form.voiceId,
                  voiceName: s.voices.find((v) => v.id === form.voiceId)?.name ?? (form.voiceId === s.voiceId ? s.voiceName : null),
                  quality: form.quality,
                  limitCents: Math.round(Number(form.limit || "0") * 100),
                })
              }
            >
              Save
            </button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="ld-btn" onClick={open}>Edit</button>
        )}
      </div>
    </div>
  );
}

function VideoRow({ v, open, onToggle }: { v: View; open: boolean; onToggle: () => void }) {
  const a = useAvatarActions(v.id);
  const [editing, setEditing] = React.useState(false);
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "var(--ld-hover)", borderBottom: 0 } : {}) }}>
        <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{v.title}</span>
        <span>{v.length}</span>
        <StatusPill status={v.status} />
        <span>{v.cost}</span>
        <span>{v.status === "draft" ? "" : fmtDate(v.madeAt ?? v.createdAt)}</span>
        {v.status === "draft" && !open ? (
          <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.make.mutate({ organizationId: a.orgId, id: v.id })}>
            {a.make.isPending ? "Starting..." : "Make it"}
          </button>
        ) : (
          <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
        )}
      </div>
      {!open && a.make.error && <div style={{ padding: "0 18px 10px" }}><ErrorLine error={a.make.error} /></div>}
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: v.status === "ready" && v.videoUrl ? "180px minmax(0,1fr) 128px" : "minmax(0,1fr) 128px" }}>
          {v.status === "ready" && v.videoUrl && <Player url={v.videoUrl} width={180} />}
          {editing ? (
            <ScriptEditor v={v} onDone={() => setEditing(false)} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <span className="ld-lbl">What you say</span>
              <span style={{ fontSize: 14, lineHeight: 1.6 }}>"{v.script}"</span>
              <span className="ld-small ld-muted">{[v.photoTitle ? `Photo: ${v.photoTitle}` : "", v.voiceName ? `Voice: ${v.voiceName}` : "", v.quality === "pro" ? "Pro" : "Standard"].filter(Boolean).join(" · ")}</span>
              {v.status === "making" && <span className="ld-small ld-muted">This usually takes 3 to 8 minutes.</span>}
              {v.status === "failed" && v.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{v.error}</span>}
              <ErrorLine error={a.make.error ?? a.again.error ?? a.remove.error} />
            </div>
          )}
          {!editing && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {v.status === "ready" && v.videoUrl && (
                <>
                  <a className="ld-btn p ld-av-link" href={v.videoUrl} download={`${v.title}.mp4`}>Download</a>
                  <button type="button" className="ld-btn" disabled={a.again.isPending} onClick={() => a.again.mutate({ organizationId: a.orgId, id: v.id })}>Make again</button>
                </>
              )}
              {(v.status === "draft" || v.status === "failed") && (
                <>
                  <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.make.mutate({ organizationId: a.orgId, id: v.id })}>
                    {v.status === "failed" ? "Try again" : "Make it"}
                  </button>
                  <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit script</button>
                </>
              )}
              {v.status !== "making" && (
                <button type="button" className="ld-btn" disabled={a.remove.isPending} onClick={() => a.remove.mutate({ organizationId: a.orgId, id: v.id })}>Delete</button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Elena's Your videos tab: avatar settings, then every video. */
export function AvatarVideosTab({ empName }: { empName: string }) {
  const { currentOrgId } = useTenant();
  const list = trpc.avatar.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data ?? []).some((v) => v.status === "making") ? 10_000 : false) });
  const [open, setOpen] = React.useState<number | null>(null);
  const rows = (list.data ?? []) as View[];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsCard />
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Video</span>
          <span>Length</span>
          <span>Status</span>
          <span>Cost</span>
          <span>Made</span>
          <span />
        </div>
        {rows.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No videos yet. Ask ${empName} in Chat for a video of you talking about anything.`}</div>}
        {rows.map((v) => (
          <VideoRow key={v.id} v={v} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />
        ))}
      </div>
    </div>
  );
}
