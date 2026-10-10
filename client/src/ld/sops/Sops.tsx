import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs } from "../ui";
import { uploadFile } from "../meta";
import type { Outputs } from "../types";
import { StatusActions, StatusPill, StepList, longDate, type SopRow } from "./shared";

const COLS = "minmax(0,1fr) 110px 100px 120px 120px 110px 96px";

type Area = "all" | SopRow["area"];

/** The SOPs tab on the Handbook page: the library by area, and the three ways to write one. */
export default function Sops() {
  const { currentOrgId } = useTenant();
  const q = trpc.sops.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.jobs.some((j) => j.status === "queued" || j.status === "working") ? 4000 : false) });
  const [area, setArea] = React.useState<Area>("all");
  const [open, setOpen] = React.useState<number | null>(null);
  const [menu, setMenu] = React.useState(false);
  const [mode, setMode] = React.useState<null | "record" | "site" | "chat">(null);
  const data = q.data;
  const sops = (data?.sops ?? []).filter((s) => area === "all" || s.area === area);
  const tabs: { key: Area; label: string }[] = [{ key: "all", label: `All (${data?.counts.all ?? 0})` }, ...(data?.areas ?? []).map((a) => ({ key: a.key as Area, label: `${a.label} (${data?.counts[a.key] ?? 0})` }))];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {data?.canEdit && (
        <div style={{ display: "flex", justifyContent: "flex-end", position: "relative" }}>
          <button type="button" className="ld-btn p" onClick={() => setMenu((v) => !v)}>New SOP</button>
          {menu && (
            <NewMenu
              onClose={() => setMenu(false)}
              onPick={(m) => {
                setMenu(false);
                setMode(m);
              }}
            />
          )}
        </div>
      )}
      {(data?.jobs ?? []).map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
      <FolderTabs tabs={tabs} value={area} onChange={setArea}>
        <div className="ld-hd sop-cols" style={{ gridTemplateColumns: COLS }}>
          <span>SOP</span>
          <span>Owner</span>
          <span>Area</span>
          <span>Reviewed</span>
          <span>Next review</span>
          <span>Status</span>
          <span />
        </div>
        {sops.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : data?.canEdit ? "No SOPs yet. Press New SOP: record your screen, send an employee to the site, or tell one how it is done in chat." : "No SOPs yet."}</div>}
        {sops.map((s) => {
          const isOpen = open === s.id;
          return (
            <React.Fragment key={s.id}>
              <div className={`ld-rw sop-cols ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <span className="ld-strong">{s.title}</span>
                <span>{s.ownerName}</span>
                <span>{s.areaLabel}</span>
                <span>{s.reviewedAt ? longDate(s.reviewedAt) : <span className="ld-muted">Not yet</span>}</span>
                <span>{longDate(s.nextReview)}</span>
                <StatusPill s={s} />
                <button type="button" className={`ld-btn ${isOpen ? "p" : ""}`} onClick={() => setOpen(isOpen ? null : s.id)}>{isOpen ? "Close" : "Open"}</button>
              </div>
              {isOpen && <Expanded s={s} canEdit={Boolean(data?.canEdit)} />}
            </React.Fragment>
          );
        })}
      </FolderTabs>
      <ErrorLine error={q.error} />
      {mode === "record" && <RecordModal onClose={() => setMode(null)} />}
      {mode === "site" && <SiteModal onClose={() => setMode(null)} />}
      {mode === "chat" && <ChatHint onClose={() => setMode(null)} />}
    </div>
  );
}

function NewMenu({ onClose, onPick }: { onClose: () => void; onPick: (m: "record" | "site" | "chat") => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", h);
    };
  }, [onClose]);
  const items: { key: "record" | "site" | "chat"; icon: string; title: string; sub: string }[] = [
    { key: "record", icon: "●", title: "Record my screen", sub: "Do it once while you talk. The steps are written from the recording and your words, with a screenshot under each one." },
    { key: "site", icon: "◎", title: "Send an employee to the site", sub: "Zara signs in with a saved Website login, walks the screens herself and writes it up. For the LeadDash platform and LeadDash EHR." },
    { key: "chat", icon: "✎", title: "Tell an employee in chat", sub: "For procedures that are not on a screen. Say how it is done and the employee drafts it." },
  ];
  return (
    <div ref={ref} className="ld-card sop-menu">
      {items.map((it) => (
        <button key={it.key} type="button" className="sop-menu-it" onClick={() => onPick(it.key)}>
          <span className={`sop-menu-ic ${it.key}`}>{it.icon}</span>
          <span>
            <b>{it.title}</b>
            <small>{it.sub}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function Expanded({ s, canEdit }: { s: SopRow; canEdit: boolean }) {
  return (
    <div className="ld-expand" style={{ paddingTop: 14 }}>
      <div className="sop-kv">
        <b>Who follows it</b>
        <span>{s.follows || <span className="ld-muted">Not set</span>}</span>
        <b>When</b>
        <span>{s.when || <span className="ld-muted">Not set</span>}</span>
        <b>Source</b>
        <span>{s.sourceNote || "Typed"}{s.sourceUrl && s.sourceKind === "record" ? <> · <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener">Recording</a></> : null}</span>
        <b>Version</b>
        <span>{s.version}</span>
      </div>
      <StepList steps={s.steps} limit={3} small />
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <Link href={`/handbook/sop/${s.id}`} className="ld-btn p" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open</Link>
        {canEdit && <Link href={`/handbook/sop/${s.id}?edit=1`} className="ld-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Edit</Link>}
        {canEdit && <StatusActions sop={s} />}
      </div>
    </div>
  );
}

// ==========================================
// A recording or site walk in progress
// ==========================================

type Job = Outputs["sops"]["list"]["jobs"][number];

function JobCard({ job }: { job: Job }) {
  const running = job.status === "queued" || job.status === "working";
  const label = job.kind === "record" ? `Writing it from your recording${job.title ? `: ${job.title}` : ""}` : `Writing it from the site${job.title ? `: ${job.title}` : ""}`;
  return (
    <div className="ld-card" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span className="ld-strong">{label}</span>
        <span className={`ld-pill ${job.status === "failed" ? "red" : "purple"}`}>{job.status === "failed" ? "Stopped" : job.stage || "Starting"}</span>
      </div>
      {job.stages.length > 0 && (
        <div className="sop-stages">
          {job.stages.map((st, i) => (
            <span key={i}><b>✓</b>{st.label}{st.detail ? ` · ${st.detail}` : ""}</span>
          ))}
          {running && <span><b className="w">…</b>{job.stage}</span>}
        </div>
      )}
      {job.status === "failed" && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{job.note}</span>}
    </div>
  );
}

// ==========================================
// Record my screen
// ==========================================

type RecState = "pick" | "recording" | "uploading" | "done" | "error";

function RecordModal({ onClose }: { onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [title, setTitle] = React.useState("");
  const [mic, setMic] = React.useState(true);
  const [state, setState] = React.useState<RecState>("pick");
  const [error, setError] = React.useState<string | null>(null);
  const [seconds, setSeconds] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const rec = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);
  const streams = React.useRef<MediaStream[]>([]);
  const timer = React.useRef<number | null>(null);
  const video = React.useRef<HTMLVideoElement>(null);
  const supported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== "undefined";

  const stopAll = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    for (const s of streams.current) s.getTracks().forEach((t) => t.stop());
    streams.current = [];
  };
  React.useEffect(() => () => stopAll(), []);

  const start = async () => {
    setError(null);
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false });
      streams.current.push(screen);
      const tracks: MediaStreamTrack[] = [...screen.getVideoTracks()];
      if (mic) {
        try {
          const m = await navigator.mediaDevices.getUserMedia({ audio: true });
          streams.current.push(m);
          tracks.push(...m.getAudioTracks());
        } catch {
          setError("The microphone could not be opened, so the recording has no narration. Say yes to the microphone next time, or type the steps after.");
        }
      }
      const mixed = new MediaStream(tracks);
      const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const r = new MediaRecorder(mixed, mime ? { mimeType: mime, videoBitsPerSecond: 1_500_000 } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => void finish();
      rec.current = r;
      r.start(1000);
      screen.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (rec.current?.state !== "inactive") rec.current?.stop();
      });
      if (video.current) video.current.srcObject = screen;
      setSeconds(0);
      timer.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      setState("recording");
    } catch (err) {
      setError(err instanceof Error && err.name === "NotAllowedError" ? "Nothing was shared. Press Start and pick what to record." : (err as Error).message);
      stopAll();
    }
  };

  const finish = async () => {
    stopAll();
    const blob = new Blob(chunks.current, { type: "video/webm" });
    if (blob.size < 10_000) {
      setState("error");
      setError("The recording was empty.");
      return;
    }
    setState("uploading");
    try {
      const file = new File([blob], "recording.webm", { type: "video/webm" });
      await uploadFile("sop_recording", file, { organizationId: currentOrgId, title });
      await utils.sops.list.invalidate();
      setState("done");
    } catch (err) {
      setState("error");
      setError((err as Error).message);
    }
  };

  const mm = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <Modal title={state === "recording" ? <span className="sop-rec"><i className={paused ? "p" : ""} />{paused ? "Paused" : "Recording"} · {mm}</span> : state === "done" ? "Recording sent" : "Record my screen"} onClose={state === "recording" ? undefined : onClose}>
      {state === "pick" && (
        <>
          {!supported && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>This browser cannot record the screen. Use Chrome, Edge or Safari on a computer.</span>}
          <label className="ld-lbl" htmlFor="sop-rec-title">What is the SOP for</label>
          <input id="sop-rec-title" className="ld-in lg" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Adding a clinician's availability" />
          <div className="sop-opt">
            <b>What to record</b>
            <span>Pick a tab, a window or the whole screen when the browser asks. A tab is best for the LeadDash platform and LeadDash EHR.</span>
          </div>
          <label className="sop-opt" style={{ cursor: "pointer" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}><input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} /><b>Microphone on</b></span>
            <span>Say what you are doing as you do it. The steps are written from your words.</span>
          </label>
          <span className="ld-small ld-muted">Recording LeadDash EHR: use the demo practice, not a real chart. The recording is read by the AI to write the steps.</span>
          {error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{error}</span>}
          <div className="sop-mf">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={!supported} onClick={() => void start()}>Start</button>
          </div>
        </>
      )}
      {state === "recording" && (
        <>
          <video ref={video} autoPlay muted playsInline className="sop-preview" />
          <span className="ld-small ld-muted">{mic ? "Your microphone is on. " : ""}Press Stop when you are done; the steps are written from the recording.</span>
          {error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{error}</span>}
          <div className="sop-mf">
            <button
              type="button"
              className="ld-btn"
              onClick={() => {
                if (!rec.current) return;
                if (paused) {
                  rec.current.resume();
                  timer.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
                } else {
                  rec.current.pause();
                  if (timer.current) window.clearInterval(timer.current);
                  timer.current = null;
                }
                setPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="ld-btn p" onClick={() => rec.current?.stop()}>Stop</button>
          </div>
        </>
      )}
      {state === "uploading" && (
        <>
          <span>Sending the recording to the server ({mm} recorded).</span>
          <div className="sop-prog"><i style={{ width: "40%" }} /></div>
        </>
      )}
      {state === "done" && (
        <>
          <span>It is on its way: the narration is transcribed, a screenshot is kept at every change of screen, and the steps are written with one under each. Progress shows at the top of the SOPs tab, and the draft lands there in a few minutes.</span>
          <div className="sop-mf">
            <button type="button" className="ld-btn p" onClick={onClose}>Close</button>
          </div>
        </>
      )}
      {state === "error" && (
        <>
          <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{error}</span>
          <div className="sop-mf">
            <button type="button" className="ld-btn" onClick={onClose}>Close</button>
            <button type="button" className="ld-btn p" onClick={() => setState("pick")}>Try again</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ==========================================
// Send an employee to the site
// ==========================================

function SiteModal({ onClose }: { onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const logins = trpc.portals.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const emps = trpc.employees.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [title, setTitle] = React.useState("");
  const [login, setLogin] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [kind, setKind] = React.useState("platform");
  const [error, setError] = React.useState<string | null>(null);
  const start = trpc.sops.fromSite.useMutation({
    onSuccess: async (r) => {
      await utils.sops.list.invalidate();
      onClose();
      navigate(`/chats/e/${r.employeeId}`);
    },
    onError: (e) => setError(e.message),
  });
  const kinds = (emps.data ?? []).filter((e) => ["platform", "coo", "inbox", "leads", "onboarding", "website"].includes(e.kind));
  return (
    <Modal title="Send an employee to the site" onClose={onClose}>
      <label className="ld-lbl" htmlFor="sop-site-title">What is the SOP for</label>
      <input id="sop-site-title" className="ld-in lg" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Adding a clinician's availability" autoFocus />
      <label className="ld-lbl" htmlFor="sop-site-login">Website login</label>
      <select id="sop-site-login" className="ld-in lg" value={login} onChange={(e) => setLogin(e.target.value)}>
        <option value="">None, use a web address</option>
        {(logins.data ?? []).map((l) => (
          <option key={l.id} value={l.name}>{l.name}{l.lockName ? ` (${l.lockName})` : ""}</option>
        ))}
      </select>
      {!login && (
        <>
          <label className="ld-lbl" htmlFor="sop-site-url">Web address</label>
          <input id="sop-site-url" className="ld-in lg" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </>
      )}
      <label className="ld-lbl" htmlFor="sop-site-emp">Who goes</label>
      <select id="sop-site-emp" className="ld-in lg" value={kind} onChange={(e) => setKind(e.target.value)}>
        {kinds.map((e) => (
          <option key={e.id} value={e.kind}>{e.name}, {e.roleTitle}</option>
        ))}
      </select>
      <span className="ld-small ld-muted">For LeadDash EHR, use the demo practice login, never a real chart. The employee changes nothing and stops before any Save or Submit.</span>
      {error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{error}</span>}
      <div className="sop-mf">
        <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ld-btn p" disabled={start.isPending || !title.trim() || (!login && !url.trim())} onClick={() => start.mutate({ organizationId: currentOrgId, title: title.trim(), login: login || undefined, url: login ? undefined : url.trim(), employeeKind: kind })}>Go</button>
      </div>
    </Modal>
  );
}

function ChatHint({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  return (
    <Modal title="Tell an employee in chat" onClose={onClose}>
      <span>Open the chat of the employee closest to the work (Simone for anything general) and say what the SOP is for and how it goes, in your words. They ask what is missing, one question at a time, then draft it here for your review.</span>
      <div className="sop-mf">
        <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ld-btn p" onClick={() => navigate("/chats/coo")}>Open Simone's chat</button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: React.ReactNode; onClose?: () => void; children: React.ReactNode }) {
  return (
    <div className="sop-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="ld-card sop-modal" role="dialog" aria-modal="true">
        <div className="sop-mh">
          <span>{title}</span>
          {onClose && <button type="button" className="sop-x" aria-label="Close" onClick={onClose}>✕</button>}
        </div>
        <div className="sop-mb">{children}</div>
      </div>
    </div>
  );
}
