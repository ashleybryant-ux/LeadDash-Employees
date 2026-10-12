import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useHoursAsk } from "../HoursAsk";
import { ErrorLine } from "../ui";

/**
 * Elena's videos made from instructions (b-roll with a voice-over, a slideshow, an explainer):
 * the Videos tab (rows that open in place, Edit script with Save and Cancel) and the card in chat.
 */

type Shot = { at: number; time: string; see: string; say: string; photo: string };
type View = {
  id: number;
  title: string;
  kind: string;
  kindLabel: string;
  size: "vertical" | "square" | "wide";
  sizeLabel: string;
  seconds: number;
  length: string;
  status: "draft" | "making" | "ready" | "failed";
  statusLabel: string;
  shots: Shot[];
  caption: string;
  voiceName: string;
  voiceStandard: boolean;
  hours: string;
  videoUrl: string | null;
  error: string | null;
};

const PILL: Record<View["status"], string> = { draft: "amber", making: "blue", ready: "green", failed: "red" };
const COLS = "minmax(0,2fr) 160px 120px 140px 128px";
const PLAYER_W: Record<View["size"], number> = { vertical: 180, square: 220, wide: 300 };

function Pill({ v }: { v: View }) {
  return <span className={`ld-pill ${PILL[v.status]}`} style={{ justifySelf: "start" }}>{v.statusLabel}</span>;
}

function Player({ v }: { v: View }) {
  return (
    <div className="ld-av-player ld-mv-player" style={{ width: PLAYER_W[v.size], aspectRatio: v.size === "vertical" ? "9 / 16" : v.size === "square" ? "1 / 1" : "16 / 9" }}>
      <span className="ld-av-ai">AI-generated</span>
      <video src={v.videoUrl!} controls playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#1f1a1c" }} />
    </div>
  );
}

/** "0:06" or "6" as seconds. */
const toSeconds = (t: string) => {
  const m = t.trim().match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(t.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

function useActions(id: number) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const hours = useHoursAsk();
  const refresh = () => Promise.all([utils.videos.list.invalidate(), utils.videos.get.invalidate({ organizationId: currentOrgId, id })]);
  return {
    orgId: currentOrgId,
    ask: (what: string, run: () => void) => hours.confirm(`made-${id}`, what, run),
    question: hours.question(`made-${id}`),
    make: trpc.videos.make.useMutation({ onSuccess: refresh }),
    save: trpc.videos.saveScript.useMutation({ onSuccess: refresh }),
    remove: trpc.videos.remove.useMutation({ onSuccess: refresh }),
  };
}

/** The shots as typed: when, what we see, what's said. Save or Cancel. */
function ScriptEditor({ v, a, onDone }: { v: View; a: ReturnType<typeof useActions>; onDone: () => void }) {
  const [rows, setRows] = React.useState(v.shots.map((s) => ({ time: s.time, see: s.see, say: s.say })));
  const set = (i: number, k: "time" | "see" | "say", val: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: val } : r)));
  const save = () =>
    a.save.mutate(
      { organizationId: a.orgId, id: v.id, shots: rows.filter((r) => r.see.trim() || r.say.trim()).map((r) => ({ at: toSeconds(r.time), see: r.see, say: r.say })) },
      { onSuccess: onDone }
    );
  return (
    <>
      <div className="ld-mv-edit">
        <div className="ld-mv-erow ld-mv-ehd">
          <span>Time</span>
          <span>What we see</span>
          <span>What's said</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="ld-mv-erow">
            <input className="ld-in xs" aria-label={`Shot ${i + 1} time`} value={r.time} onChange={(e) => set(i, "time", e.target.value)} />
            <input className="ld-in xs" aria-label={`Shot ${i + 1}, what we see`} value={r.see} onChange={(e) => set(i, "see", e.target.value)} />
            <input className="ld-in xs" aria-label={`Shot ${i + 1}, what's said`} value={r.say} onChange={(e) => set(i, "say", e.target.value)} />
          </div>
        ))}
        <ErrorLine error={a.save.error} />
      </div>
      <div className="ld-mv-btns">
        <button type="button" className="ld-btn p" disabled={a.save.isPending || !rows.some((r) => r.see.trim() || r.say.trim())} onClick={save}>
          {a.save.isPending ? "Saving..." : "Save"}
        </button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
    </>
  );
}

function Shots({ v }: { v: View }) {
  return (
    <div className="ld-mv-shots">
      {v.shots.map((s, i) => (
        <React.Fragment key={i}>
          <span>
            Shot {i + 1}, {s.time}: {s.see}
          </span>
          <span className="ld-small ld-muted">{s.say ? `"${s.say}"` : ""}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

const detail = (v: View) => `Voice: ${v.voiceName}${v.voiceStandard ? " (standard)" : ""}. Captions on. ${v.status === "ready" ? "Used" : "Uses"} ${v.hours} (8 for each minute of video).`;

function Row({ v, open, onToggle }: { v: View; open: boolean; onToggle: () => void }) {
  const a = useActions(v.id);
  const [editing, setEditing] = React.useState(false);
  const make = () => a.ask(`This video uses ${v.hours}`, () => a.make.mutate({ organizationId: a.orgId, id: v.id }));
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
        <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{v.title}</span>
        <span>{v.kindLabel}</span>
        <span>{v.length}</span>
        <Pill v={v} />
        <button type="button" className="ld-btn sm" style={{ width: 128 }} aria-expanded={open} onClick={() => { setEditing(false); onToggle(); }}>
          {open ? "Close" : "Open"}
        </button>
      </div>
      {open && (
        <div className="ld-mv-exp" style={{ gridTemplateColumns: v.status === "ready" && v.videoUrl && !editing ? `${PLAYER_W[v.size]}px minmax(0,1fr) 128px` : "minmax(0,1fr) 128px" }}>
          {editing ? (
            <ScriptEditor v={v} a={a} onDone={() => setEditing(false)} />
          ) : (
            <>
              {v.status === "ready" && v.videoUrl && <Player v={v} />}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                <Shots v={v} />
                <span className="ld-small ld-muted">{detail(v)}</span>
                {v.status === "making" && <span className="ld-small ld-muted">This usually takes a few minutes.</span>}
                {v.status === "failed" && v.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{v.error}</span>}
                {a.question}
                <ErrorLine error={a.make.error ?? a.remove.error} />
              </div>
              <div className="ld-mv-btns">
                {v.status === "ready" && v.videoUrl && (
                  <>
                    <a className="ld-btn p ld-av-link" href={v.videoUrl} download={`${v.title}.mp4`}>Download</a>
                    <a className="ld-btn ld-av-link-plain" href={v.videoUrl} target="_blank" rel="noreferrer noopener">Open</a>
                  </>
                )}
                {(v.status === "draft" || v.status === "failed") && (
                  <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={make}>
                    {a.make.isPending ? "Starting..." : v.status === "failed" ? "Try again" : "Make it"}
                  </button>
                )}
                {v.status !== "making" && (
                  <>
                    <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit script</button>
                    <button type="button" className="ld-btn" disabled={a.remove.isPending} onClick={() => a.remove.mutate({ organizationId: a.orgId, id: v.id })}>Remove</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Elena's Videos tab: every video she made from instructions. */
export function MadeVideosTab({ empName }: { empName: string }) {
  const { currentOrgId } = useTenant();
  const list = trpc.videos.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data ?? []).some((v) => v.status === "making") ? 10_000 : false) });
  const rows = (list.data ?? []) as View[];
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
        <span>Video</span>
        <span>Kind</span>
        <span>Length</span>
        <span>Status</span>
        <span />
      </div>
      {rows.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No videos yet. Tell ${empName} in Chat what video you want.`}</div>}
      {rows.map((v) => (
        <Row key={v.id} v={v} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />
      ))}
    </div>
  );
}

/** The card under Elena's message: the shot list, Make it, then the finished video. */
export function MadeVideoCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const one = trpc.videos.get.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data?.status === "making" ? 10_000 : false) });
  const a = useActions(id);
  const v = one.data as View | null | undefined;
  if (!v) return one.isLoading ? null : <div className="ld-card ld-empty">This video was removed.</div>;
  const ready = v.status === "ready" && !!v.videoUrl;
  return (
    <div className="ld-card ld-av-card" style={{ gridTemplateColumns: ready ? `${PLAYER_W[v.size]}px minmax(0,1fr) 128px` : "minmax(0,1fr) 128px" }}>
      {ready && <Player v={v} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="ld-row" style={{ flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{v.title}</span>
          <Pill v={v} />
        </div>
        <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{[v.kindLabel, v.length, v.sizeLabel].join(" · ")}</span>
        {!ready && <Shots v={v} />}
        <span className="ld-small ld-muted">{detail(v)}</span>
        {v.status === "making" && <span className="ld-small ld-muted">This usually takes a few minutes. Elena posts it here when it's done.</span>}
        {v.status === "failed" && v.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{v.error}</span>}
        {a.question}
        <ErrorLine error={a.make.error} />
      </div>
      <div className="ld-mv-btns">
        {ready ? (
          <>
            <a className="ld-btn p ld-av-link" href={v.videoUrl!} download={`${v.title}.mp4`}>Download</a>
            <a className="ld-btn ld-av-link-plain" href={v.videoUrl!} target="_blank" rel="noreferrer noopener">Open</a>
          </>
        ) : (
          (v.status === "draft" || v.status === "failed") && (
            <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.ask(`This video uses ${v.hours}`, () => a.make.mutate({ organizationId: a.orgId, id }))}>
              {a.make.isPending ? "Starting..." : v.status === "failed" ? "Try again" : "Make it"}
            </button>
          )
        )}
        <Link href="/chats/video/work?tab=videos" className="ld-btn ld-av-link-plain">Videos tab</Link>
      </div>
    </div>
  );
}
