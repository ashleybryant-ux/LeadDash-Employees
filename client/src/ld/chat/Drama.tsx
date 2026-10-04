import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { uploadFile } from "../meta";

/**
 * Elena's studio on screen: micro drama episodes and branded campaigns. In
 * chat: the season card, the three directions, the keyframes to approve, and
 * the finished video. On her Videos page: Episodes, Campaigns, Cast (with the
 * owner's character pack and plates) and Style (videos she likes).
 */

type Shot = { n: number; framing: string; move: string; action: string; setting: string; cast: string[]; line: { who: string; text: string } | null; seconds: number; sound?: string; plate?: string; props?: string[]; vo?: string; caption?: string; engine?: "kling" | "seedance"; takeUrl?: string | null; takeSeconds?: number; stillUrl?: string | null; clipUrl?: string | null; status?: string; error?: string | null; costCents?: number };
type Direction = { title: string; hook: string; story: string; metaphor: string; location: string; wardrobe: string; lighting: string; camera: string; ending: string };
type Ep = {
  id: number;
  kind: "drama" | "campaign";
  number: number;
  title: string;
  logline: string;
  beats: { label: string; at: string; text: string }[];
  shots: Shot[];
  status: "script" | "making" | "keyframes" | "ready" | "failed";
  progress: string | null;
  videoUrl: string | null;
  versions: Record<string, string>;
  error: string | null;
  length: string;
  cost: string;
  animateCost: string;
  done: number;
  stills: number;
  plan: { goal: string; directions: Direction[]; chosen: number | null; script: string; cta: string; approved: boolean };
};

const PILL: Record<Ep["status"], [string, string]> = {
  script: ["gray", "Script ready"],
  making: ["amber", "Making"],
  keyframes: ["amber", "Keyframes ready"],
  ready: ["green", "Ready"],
  failed: ["red", "Stopped"],
};

function statusLabel(e: Ep) {
  if (e.kind === "campaign" && !e.shots.length) return "Pick a direction";
  if (e.status === "making") return e.plan.approved ? `Making ${e.done} of ${e.shots.length}` : `Keyframes ${e.stills} of ${e.shots.length}`;
  return PILL[e.status][1];
}

function useStudio() {
  const { currentOrgId } = useTenant();
  return trpc.drama.studio.useQuery({ organizationId: currentOrgId }, { refetchInterval: (q) => ([...(q.state.data?.episodes ?? []), ...(q.state.data?.campaigns ?? [])].some((e) => e.status === "making") ? 10_000 : false) });
}

function useActions() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.drama.invalidate(), utils.chat.list.invalidate()]);
  return {
    orgId: currentOrgId,
    make: trpc.drama.make.useMutation({ onSuccess: refresh }),
    remake: trpc.drama.remakeShot.useMutation({ onSuccess: refresh }),
    approve: trpc.drama.approveKeyframes.useMutation({ onSuccess: refresh }),
    pick: trpc.drama.pickDirection.useMutation({ onSuccess: refresh }),
    engine: trpc.drama.animateWith.useMutation({ onSuccess: refresh }),
    clearTake: trpc.drama.clearTake.useMutation({ onSuccess: refresh }),
  };
}

const ENGINE: Record<string, string> = { kling: "Kling", seedance: "Seedance" };
const otherEngine = (s: Shot) => (s.engine === "seedance" ? "kling" : "seedance");

/**
 * Add take: the owner records herself performing the shot (on a phone the
 * front camera opens). Her movement, expressions and voice go onto the keyframe.
 */
function TakeButton({ e, s, width }: { e: Ep; s: Shot; width?: number | string }) {
  const a = useActions();
  const utils = trpc.useUtils();
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState("");
  if (!s.cast.length || e.status === "making") return null;
  if (s.takeUrl) {
    return (
      <button type="button" className="ld-btn sm" style={{ width }} disabled={a.clearTake.isPending} onClick={() => a.clearTake.mutate({ organizationId: a.orgId, id: e.id, n: s.n })}>Remove take</button>
    );
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="video/*"
        capture="user"
        hidden
        aria-label={`Your take for shot ${s.n}`}
        onChange={async (ev) => {
          const f = ev.target.files?.[0];
          ev.target.value = "";
          if (!f) return;
          setBusy(true);
          setErr("");
          try {
            await uploadFile("take", f, { organizationId: a.orgId, episodeId: e.id, n: s.n });
            await utils.drama.invalidate();
          } catch (x) {
            setErr(x instanceof Error ? x.message : "Upload failed.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <button type="button" className="ld-btn sm" style={{ width }} disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading..." : "Add take"}</button>
      {err && <span className="ld-small" style={{ color: "#a3272f" }}>{err}</span>}
    </>
  );
}

function useEpisode(id: number) {
  const { currentOrgId } = useTenant();
  return trpc.drama.episode.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data?.status === "making" ? 8_000 : false) });
}

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const workTab = "/chats/video/work";

function Face({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  return url ? (
    <img src={url} alt={name} style={{ width: size, height: size, borderRadius: 999, objectFit: "cover", border: "2px solid #fff" }} />
  ) : (
    <span aria-label={name} style={{ width: size, height: size, borderRadius: 999, background: "#8a2f3a", color: "#fff", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "2px solid #fff" }}>{initials(name)}</span>
  );
}

function Frame({ shot, w = 96 }: { shot: Shot; w?: number }) {
  if (shot.clipUrl) return <video src={shot.clipUrl} muted playsInline preload="metadata" controls style={{ width: w, aspectRatio: "9 / 16", borderRadius: 8, background: "#000" }} />;
  if (shot.stillUrl) return <img src={shot.stillUrl} alt={`Shot ${shot.n}`} style={{ width: w, aspectRatio: "9 / 16", objectFit: "cover", borderRadius: 8 }} />;
  return <span style={{ width: w, aspectRatio: "9 / 16", borderRadius: 8, background: "#eef2f0", display: "block" }} />;
}

const VERSION_LABEL: Record<string, string> = { "9:16": "Vertical", "1:1": "Square", "16:9": "Wide" };

function Versions({ e }: { e: Ep }) {
  const keys = Object.keys(e.versions).length ? Object.keys(e.versions) : e.videoUrl ? ["9:16"] : [];
  if (!keys.length) return null;
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
      {keys.map((k) => {
        const url = e.versions[k] ?? e.videoUrl!;
        const w = k === "16:9" ? 300 : k === "1:1" ? 200 : 170;
        return (
          <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <video src={url} controls playsInline preload="metadata" style={{ width: w, aspectRatio: k.replace(":", " / "), borderRadius: 10, background: "#000" }} />
            <a className="ld-btn sm ld-av-link-plain" href={url} download={`${e.title.replace(/[^\w ]+/g, "")}-${VERSION_LABEL[k] ?? k}.mp4`} style={{ width: w }}>Download {VERSION_LABEL[k] ?? k}</a>
          </div>
        );
      })}
    </div>
  );
}

// ==========================================
// Chat cards
// ==========================================

/** The season card: the series, its cast, the first episode, Make. */
export function DramaSeasonCard({ firstId }: { firstId: number }) {
  const q = useStudio();
  const a = useActions();
  const st = q.data;
  if (!st?.series) return null;
  const eps = (st.episodes as Ep[]).filter((e) => e.id >= firstId);
  const first = eps[0];
  if (!first) return null;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>{st.series.title}</b>
          <span className="ld-pill gray">Scripts ready</span>
        </div>
        <span style={{ fontSize: 13, color: "#3d4c45" }}>{eps.length} {eps.length === 1 ? "episode" : "episodes"} · {first.length} each · {st.cast.length} characters · {first.cost} per episode to make</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {st.cast.filter((c) => c.kind !== "team").map((c) => (
            <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, marginRight: 8 }}>
              <Face name={c.name} url={c.photoUrl} />
              {c.kind === "owner" ? "You" : c.name.split(" ")[0]}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 14, lineHeight: 1.5 }}>
          <b>Episode {first.number}: "{first.title}."</b> {first.logline}
        </span>
        <ErrorLine error={a.make.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {first.status === "script" || first.status === "failed" ? (
          <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.make.mutate({ organizationId: a.orgId, id: first.id })}>{a.make.isPending ? "Starting..." : `Make episode ${first.number}`}</button>
        ) : (
          <span className={`ld-pill ${PILL[first.status][0]}`} style={{ alignSelf: "flex-start" }}>{statusLabel(first)}</span>
        )}
        <Link href={workTab} className="ld-btn ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}

function DirectionList({ e }: { e: Ep }) {
  const a = useActions();
  const chosen = e.plan.chosen;
  return (
    <>
      {e.plan.directions.map((d, i) => (
        <div key={i} className="ld-resultcard" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, padding: "14px 16px", borderBottom: i < e.plan.directions.length - 1 ? "1px solid #eef2f0" : 0, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <b>{i + 1}. {d.title}</b>
            <div style={{ display: "grid", gridTemplateColumns: "90px minmax(0,1fr)", gap: "4px 10px", fontSize: 13, color: "#3d4c45", lineHeight: 1.5 }}>
              <b style={{ color: "#14221c" }}>Hook</b><span>{d.hook}</span>
              <b style={{ color: "#14221c" }}>Story</b><span>{d.story}</span>
              <b style={{ color: "#14221c" }}>Look</b><span>{[d.location, d.lighting, d.camera].filter(Boolean).join(". ")}</span>
              <b style={{ color: "#14221c" }}>Wardrobe</b><span>{d.wardrobe}</span>
              <b style={{ color: "#14221c" }}>Ending</b><span>{d.ending}</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {chosen === i + 1 ? (
              <span className="ld-pill green" style={{ alignSelf: "flex-start" }}>Picked</span>
            ) : (
              <button type="button" className={`ld-btn ${chosen ? "" : "p"}`} disabled={a.pick.isPending || e.status === "making"} onClick={() => a.pick.mutate({ organizationId: a.orgId, id: e.id, pick: i + 1 })}>{a.pick.isPending && a.pick.variables?.pick === i + 1 ? "Planning..." : "Use this"}</button>
            )}
          </div>
        </div>
      ))}
      {a.pick.error && <div style={{ padding: "0 16px 12px" }}><ErrorLine error={a.pick.error} /></div>}
    </>
  );
}

/** The three creative directions, each with Use this. */
export function CampaignDirectionsCard({ id }: { id: number }) {
  const q = useEpisode(id);
  const e = q.data as Ep | null | undefined;
  if (!e) return null;
  return <div className="ld-card" style={{ padding: 0 }}><DirectionList e={e} /></div>;
}

/** The keyframes: one still per shot, Redo any, then Animate it. Nothing is animated before this. */
export function DramaKeyframesCard({ id }: { id: number }) {
  const q = useEpisode(id);
  const a = useActions();
  const e = q.data as Ep | null | undefined;
  if (!e) return null;
  const waiting = e.status === "keyframes";
  const making = e.status === "making" && !e.plan.approved;
  const past = e.plan.approved && !waiting;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>{e.kind === "campaign" ? e.title : `Episode ${e.number}: ${e.title}`}</b>
          <span className={`ld-pill ${past ? "green" : "amber"}`}>{past ? "Approved" : making ? `Keyframes ${e.stills} of ${e.shots.length}` : waiting ? "Keyframes ready" : statusLabel(e)}</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {e.shots.map((s) => (
            <div key={s.n} style={{ display: "flex", flexDirection: "column", gap: 4, width: 104 }}>
              <Frame shot={{ ...s, clipUrl: null }} w={104} />
              <span className="ld-small">{s.n}. {s.framing}</span>
              {s.takeUrl && <span className="ld-small" style={{ color: "#155c3e", fontWeight: 700 }}>Your take, {s.takeSeconds} sec</span>}
              {waiting && s.stillUrl && (
                <>
                  <button type="button" className="ld-btn sm" disabled={a.remake.isPending} onClick={() => a.remake.mutate({ organizationId: a.orgId, id: e.id, n: s.n })}>Redo</button>
                  <TakeButton e={e} s={s} />
                </>
              )}
            </div>
          ))}
        </div>
        <span className="ld-small">{e.shots.length} shots · {e.length} · {waiting ? `${e.animateCost} to animate` : e.cost}</span>
        {waiting && e.shots.some((s) => s.line && s.cast.length) && <span className="ld-small">Speaking on camera? Press Add take and record yourself saying the line. Your expressions and real voice go onto the keyframe.</span>}
        <ErrorLine error={a.approve.error || a.remake.error || a.clearTake.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {waiting && <button type="button" className="ld-btn p" disabled={a.approve.isPending} onClick={() => a.approve.mutate({ organizationId: a.orgId, id: e.id })}>{a.approve.isPending ? "Starting..." : "Animate it"}</button>}
        <Link href={`${workTab}?tab=${e.kind === "campaign" ? "campaigns" : "episodes"}`} className="ld-btn ld-av-link-plain">{e.kind === "campaign" ? "Edit script" : "Open"}</Link>
      </div>
    </div>
  );
}

/** One episode or campaign in chat: progress while it's made, then the video. */
export function DramaEpisodeCard({ id }: { id: number }) {
  const q = useEpisode(id);
  const a = useActions();
  const e = q.data as Ep | null | undefined;
  if (!e) return null;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>{e.kind === "campaign" ? e.title : `Episode ${e.number}: ${e.title}`}</b>
          <span className={`ld-pill ${PILL[e.status][0]}`}>{statusLabel(e)}</span>
        </div>
        {e.status === "ready" ? (
          <Versions e={e} />
        ) : (
          <span style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.6 }}>
            {e.status === "making" ? `${e.progress ?? "Starting"}.` : e.status === "failed" ? `${e.error ?? "It stopped."} What's made is kept.` : `${e.shots.length} shots · ${e.length} · ${e.cost}`}
          </span>
        )}
        <span className="ld-small">{e.length} · {e.cost}</span>
        <ErrorLine error={a.make.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(e.status === "script" || e.status === "failed") && e.shots.length > 0 && (
          <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.make.mutate({ organizationId: a.orgId, id: e.id })}>{e.status === "failed" ? "Make again" : "Make it"}</button>
        )}
        <Link href={workTab} className="ld-btn ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}

// ==========================================
// Episodes and Campaigns tabs
// ==========================================

const SHOT_STATUS: Record<string, [string, string]> = { done: ["green", "Done"], making: ["amber", "Making"], failed: ["red", "Stopped"], todo: ["gray", "Not made"] };

function ShotList({ e }: { e: Ep }) {
  const a = useActions();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="ld-lbl">Shots ({e.shots.length})</span>
      {e.shots.map((s) => {
        const key = s.clipUrl ? "done" : s.status === "making" ? "making" : s.stillUrl ? "todo" : s.status ?? "todo";
        const [sc, sl] = s.stillUrl && !s.clipUrl && key !== "making" ? ["gray", "Keyframe"] : SHOT_STATUS[key] ?? SHOT_STATUS.todo;
        return (
          <div key={s.n} className="ld-shot" style={{ display: "grid", gridTemplateColumns: "28px 72px minmax(0,1fr) 150px", gap: 12, alignItems: "start", background: "#fff", border: "1px solid #e3e9e6", borderRadius: 10, padding: 10 }}>
            <b style={{ fontSize: 13 }}>{s.n}</b>
            <Frame shot={s} w={72} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, lineHeight: 1.5, minWidth: 0 }}>
              <span><b>{s.framing}</b>, {s.move.toLowerCase()}: {s.action}</span>
              {s.line && <span style={{ color: "#3d4c45" }}>{s.line.who}: "{s.line.text}"</span>}
              {s.vo && <span style={{ color: "#3d4c45" }}>Voice-over: "{s.vo}"</span>}
              {s.caption && <span style={{ color: "#3d4c45" }}>Caption: {s.caption}</span>}
              {s.takeUrl && <span style={{ color: "#155c3e", fontWeight: 700 }}>Your take, {s.takeSeconds} sec: your movement and voice{s.vo ? " (in place of the voice-over)" : ""}</span>}
              <span className="ld-small">{s.cast.length ? s.cast.join(", ") : "No one"}{s.plate ? ` · plate: ${s.plate}` : ""} · {s.seconds} sec · {s.takeUrl ? "your take" : ENGINE[s.engine ?? "kling"]}{s.sound ? ` · ${s.sound}` : ""}{s.costCents ? ` · $${(s.costCents / 100).toFixed(2)}` : ""}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
              <span className={`ld-pill ${sc}`} style={{ alignSelf: "flex-start" }}>{sl}</span>
              {(s.clipUrl || s.stillUrl) && e.status !== "making" && (
                <button type="button" className="ld-btn sm" style={{ width: "100%" }} disabled={a.remake.isPending} onClick={() => a.remake.mutate({ organizationId: a.orgId, id: e.id, n: s.n })}>{s.clipUrl ? "Remake" : "Redo"}</button>
              )}
              {s.stillUrl && !s.takeUrl && s.cast.length > 0 && e.status !== "making" && (e.plan.approved ? Boolean(s.clipUrl) : true) && (
                <button type="button" className="ld-btn sm" style={{ width: "100%" }} disabled={a.engine.isPending} onClick={() => a.engine.mutate({ organizationId: a.orgId, id: e.id, n: s.n, engine: otherEngine(s) })}>{e.plan.approved ? `Redo with ${ENGINE[otherEngine(s)]}` : `Use ${ENGINE[otherEngine(s)]}`}</button>
              )}
              {s.stillUrl && <TakeButton e={e} s={s} width="100%" />}
            </div>
          </div>
        );
      })}
      <ErrorLine error={a.remake.error || a.engine.error || a.clearTake.error} />
    </div>
  );
}

function RowActions({ e }: { e: Ep }) {
  const a = useActions();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {e.status === "keyframes" && <button type="button" className="ld-btn p" disabled={a.approve.isPending} onClick={() => a.approve.mutate({ organizationId: a.orgId, id: e.id })}>Animate it</button>}
      {(e.status === "script" || e.status === "failed") && e.shots.length > 0 && (
        <button type="button" className="ld-btn p" disabled={a.make.isPending} onClick={() => a.make.mutate({ organizationId: a.orgId, id: e.id })}>{e.status === "failed" ? "Make again" : e.plan.approved ? "Make it" : "Make keyframes"}</button>
      )}
      <ErrorLine error={a.approve.error || a.make.error} />
    </div>
  );
}

const ROW = "70px minmax(0,1.6fr) 80px 170px 100px 128px";

function EpisodeRow({ e, open, onToggle }: { e: Ep; open: boolean; onToggle: () => void }) {
  const [cls] = PILL[e.status];
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: ROW, ...(open ? { background: "#f4f8f6", borderBottom: 0 } : {}) }}>
        <b>Ep {e.number}</b>
        <span style={{ overflowWrap: "anywhere" }}>{e.title}</span>
        <span>{e.length}</span>
        <span className={`ld-pill ${cls}`} style={{ justifySelf: "start" }}>{statusLabel(e)}</span>
        <span>{e.cost}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            {e.status === "ready" && <Versions e={e} />}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="ld-lbl">Beats</span>
              {e.beats.map((b, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: 10, fontSize: 14, lineHeight: 1.5 }}>
                  <b>{b.label}</b>
                  <span>{b.at} {b.text}</span>
                </div>
              ))}
            </div>
            <ShotList e={e} />
          </div>
          <RowActions e={e} />
        </div>
      )}
    </>
  );
}

function SpentCard({ title, body, sub, spent, limit }: { title: string; body: string; sub?: string; spent: number; limit: number }) {
  return (
    <div className="ld-card ld-av-set">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span className="ld-lbl">{title}</span>
        <span style={{ fontSize: 14, lineHeight: 1.5 }}>{body}</span>
        {sub && <span className="ld-small">{sub}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="ld-lbl">Spent this month</span>
        <b style={{ fontSize: 18 }}>${(spent / 100).toFixed(2)}</b>
        <span className="ld-small">of ${(limit / 100).toFixed(0)}</span>
      </div>
    </div>
  );
}

export function DramaEpisodesTab({ empName }: { empName: string }) {
  const q = useStudio();
  const [open, setOpen] = React.useState<number | null>(null);
  const st = q.data;
  if (!st) return <div className="ld-card ld-empty">Loading...</div>;
  if (!st.series) return <div className="ld-card ld-empty">No series yet. Tell {empName} in Chat about the drama you want, like "Write a micro drama about a therapist who finds a file she wasn't supposed to see. I play the practice owner."</div>;
  const eps = st.episodes as Ep[];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SpentCard title={st.series.title} body={st.series.premise} sub={`Look: ${st.series.look}`} spent={st.spentCents} limit={st.limitCents} />
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: ROW }}>
          <span>Episode</span><span>Title</span><span>Length</span><span>Status</span><span>Cost</span><span />
        </div>
        {eps.map((e) => <EpisodeRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />)}
      </div>
    </div>
  );
}

function ScriptEditor({ e, onDone }: { e: Ep; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const save = trpc.drama.saveScript.useMutation({ onSuccess: async () => { await utils.drama.invalidate(); onDone(); } });
  const [cta, setCta] = React.useState(e.plan.cta);
  const [rows, setRows] = React.useState(e.shots.map((s) => ({ n: s.n, vo: s.vo ?? "", caption: s.caption ?? "" })));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r, i) => (
        <div key={r.n} className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "60px minmax(0,1.6fr) minmax(0,1fr)", gap: 10, alignItems: "center", fontSize: 14 }}>
          <b>Shot {r.n}</b>
          <input className="ld-in" aria-label={`Shot ${r.n} voice-over`} placeholder="Voice-over" value={r.vo} onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, vo: ev.target.value } : x)))} />
          <input className="ld-in" aria-label={`Shot ${r.n} caption`} placeholder="Caption" value={r.caption} onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, caption: ev.target.value } : x)))} />
        </div>
      ))}
      <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "60px minmax(0,1fr)", gap: 10, alignItems: "center", fontSize: 14 }}>
        <label htmlFor={`cta-${e.id}`} style={{ fontWeight: 700 }}>Ending</label>
        <input id={`cta-${e.id}`} className="ld-in" style={{ maxWidth: 360 }} placeholder="Book a demo" value={cta} onChange={(ev) => setCta(ev.target.value)} />
      </div>
      <span className="ld-small">Changed voice-over is read again and its shot is animated again; caption and ending changes only need a new cut.</span>
      <div className="ld-row" style={{ gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: e.id, cta, shots: rows })}>Save</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
      <ErrorLine error={save.error} />
    </div>
  );
}

function Timeline({ e }: { e: Ep }) {
  let t = 0;
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
  return (
    <div style={{ border: "1px solid #e3e9e6", borderRadius: 10, overflow: "hidden", background: "#fff" }}>
      <div className="ld-tl" style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1.6fr) minmax(0,1.3fr) minmax(0,1fr)", gap: 12, padding: "9px 16px", fontSize: 11, fontWeight: 700, color: "#5b6b64", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid #eef2f0" }}>
        <span>Time</span><span>Shot</span><span>Voice-over and caption</span><span>Sound</span>
      </div>
      {e.shots.map((s) => {
        const from = t;
        t += s.seconds;
        return (
          <div key={s.n} className="ld-tl" style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1.6fr) minmax(0,1.3fr) minmax(0,1fr)", gap: 12, padding: "9px 16px", fontSize: 13, borderBottom: "1px solid #eef2f0", alignItems: "start" }}>
            <b>{fmt(from)} to {fmt(t)}</b>
            <span>{s.framing}, {s.move.toLowerCase()}: {s.action}</span>
            <span>{s.vo ? `"${s.vo}"` : ""}{s.caption ? `${s.vo ? " " : ""}Caption: ${s.caption}` : ""}</span>
            <span>{s.sound}</span>
          </div>
        );
      })}
      {e.plan.cta && <div style={{ padding: "9px 16px", fontSize: 13 }}><b>Ending:</b> {e.plan.cta}</div>}
    </div>
  );
}

function CampaignRow({ e, open, onToggle }: { e: Ep; open: boolean; onToggle: () => void }) {
  const [editing, setEditing] = React.useState(false);
  const [cls] = PILL[e.status];
  const COLS = "minmax(0,1.6fr) 80px 170px 100px 128px";
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "#f4f8f6", borderBottom: 0 } : {}) }}>
        <b style={{ overflowWrap: "anywhere" }}>{e.title}</b>
        <span>{e.shots.length ? e.length : ""}</span>
        <span className={`ld-pill ${e.shots.length ? cls : "amber"}`} style={{ justifySelf: "start" }}>{statusLabel(e)}</span>
        <span>{e.shots.length ? e.cost : ""}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            {e.plan.goal && <div style={{ fontSize: 14, lineHeight: 1.5 }}><span className="ld-lbl">Goal</span><br />{e.plan.goal}</div>}
            {!e.shots.length ? (
              <div className="ld-card" style={{ padding: 0 }}><DirectionList e={e} /></div>
            ) : (
              <>
                {e.status === "ready" && <Versions e={e} />}
                {editing ? <ScriptEditor e={e} onDone={() => setEditing(false)} /> : <Timeline e={e} />}
                <ShotList e={e} />
              </>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <RowActions e={e} />
            {e.shots.length > 0 && !editing && e.status !== "making" && <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit script</button>}
          </div>
        </div>
      )}
    </>
  );
}

export function CampaignsTab({ empName }: { empName: string }) {
  const q = useStudio();
  const [open, setOpen] = React.useState<number | null>(null);
  const st = q.data;
  if (!st) return <div className="ld-card ld-empty">Loading...</div>;
  const list = st.campaigns as Ep[];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SpentCard title="Campaigns" body="Branded videos with you as the founder: three directions, keyframes for your approval, then the finished video in vertical, square and wide." spent={st.spentCents} limit={st.limitCents} />
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: "minmax(0,1.6fr) 80px 170px 100px 128px" }}>
          <span>Campaign</span><span>Length</span><span>Status</span><span>Cost</span><span />
        </div>
        {list.length === 0 && <div className="ld-empty">No campaigns yet. Tell {empName} in Chat what the video is for, like "Make a 30-second LeadDash ad about therapists drowning in double entry."</div>}
        {list.map((e) => <CampaignRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />)}
      </div>
    </div>
  );
}

// ==========================================
// Cast: characters, the owner's pack and plates
// ==========================================

function OwnerPack() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = useStudio();
  const [ids, setIds] = React.useState<number[] | null>(null);
  const save = trpc.drama.savePack.useMutation({ onSuccess: async () => { setIds(null); await utils.drama.invalidate(); } });
  const plates = trpc.drama.makePlates.useMutation({ onSuccess: () => utils.drama.invalidate() });
  const photos = q.data?.photos ?? [];
  const picked = ids ?? photos.filter((p) => p.mine).map((p) => p.id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span className="ld-lbl">Photos of you ({picked.length})</span>
      {photos.length ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {photos.map((p) => {
            const on = picked.includes(p.id);
            return (
              <label key={p.id} style={{ display: "flex", flexDirection: "column", gap: 4, width: 88, fontSize: 12, cursor: "pointer" }}>
                <img src={p.url} alt={p.title} style={{ width: 88, height: 110, objectFit: "cover", borderRadius: 8, outline: on ? "3px solid #1b6b4a" : "1px solid #e3e9e6" }} />
                <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input type="checkbox" checked={on} style={{ margin: 0, accentColor: "#1b6b4a" }} onChange={(ev) => setIds(ev.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <span style={{ fontSize: 14 }}>No photos in the Brain yet. Attach 8 to 15 in Elena's chat: straight on, both three-quarter angles, full body, seated, standing, smiling and neutral, in business and casual looks.</span>
      )}
      {ids && (
        <div className="ld-row" style={{ gap: 8 }}>
          <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, ids: picked })}>Save</button>
          <button type="button" className="ld-btn sm" onClick={() => setIds(null)}>Cancel</button>
        </div>
      )}
      <span className="ld-lbl" style={{ marginTop: 6 }}>Character plates ({q.data?.plates.length ?? 0})</span>
      {(q.data?.plates ?? []).length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {q.data!.plates.map((p) => (
            <div key={p.label} style={{ display: "flex", flexDirection: "column", gap: 4, width: 88, fontSize: 12 }}>
              <img src={p.url} alt={p.label} style={{ width: 88, height: 117, objectFit: "cover", borderRadius: 8 }} />
              <span>{p.label}</span>
            </div>
          ))}
        </div>
      )}
      <span className="ld-small">Plates are standard images of you (front, walking, seated, profile, waist-up, full body, green blazer, black suit, evening). Every shot with you names the plate it uses, so your face holds across long campaigns.</span>
      <div>
        <button type="button" className="ld-btn sm" style={{ width: 160 }} disabled={plates.isPending || !picked.length} onClick={() => plates.mutate({ organizationId: currentOrgId })}>{plates.isPending ? "Making plates..." : q.data?.plates.length ? "Make plates again" : "Make plates"}</button>
      </div>
      <ErrorLine error={save.error || plates.error} />
    </div>
  );
}

export function DramaCastTab() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = useStudio();
  const voices = trpc.avatar.settings.useQuery({ organizationId: currentOrgId }).data?.voices ?? [];
  const save = trpc.drama.saveCast.useMutation({ onSuccess: async () => { setEdit(null); await utils.drama.invalidate(); } });
  const [edit, setEdit] = React.useState<{ id: number; name: string; role: string; look: string; voiceId: string } | null>(null);
  const [packOpen, setPackOpen] = React.useState(false);
  const cast = q.data?.cast ?? [];
  const COLS = "56px minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1fr) 128px";
  const hasOwner = cast.some((c) => c.kind === "owner");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!hasOwner && (
        <div className="ld-card ld-av-set">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span className="ld-lbl">You</span>
            {packOpen ? <OwnerPack /> : <span style={{ fontSize: 14 }}>{(q.data?.photos ?? []).filter((p) => p.mine).length} photos of you · {q.data?.plates.length ?? 0} plates</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn" onClick={() => setPackOpen(!packOpen)}>{packOpen ? "Close" : "Edit"}</button>
          </div>
        </div>
      )}
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span /><span>Character</span><span>Role</span><span>Voice</span><span />
        </div>
        {cast.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : "No cast yet. The cast is made when Elena writes the first episodes or plans a campaign."}</div>}
        {cast.map((c) => {
          const open = edit?.id === c.id;
          return (
            <React.Fragment key={c.id}>
              <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "#f4f8f6", borderBottom: 0 } : {}) }}>
                <Face name={c.name} url={c.photoUrl} size={40} />
                <span><b>{c.kind === "owner" ? "You" : c.name}</b><br /><span className="ld-small">{c.kind === "owner" ? c.name : c.kind === "team" ? "Your AI team" : "Made up"}</span></span>
                <span>{c.role}</span>
                <span>{c.voiceName ?? (c.kind === "team" ? "No lines" : <span style={{ color: "#8a4510" }}>Pick a voice</span>)}</span>
                <button type="button" className="ld-btn" onClick={() => setEdit(open ? null : { id: c.id, name: c.name, role: c.role, look: c.look, voiceId: c.voiceId ?? "" })}>{open ? "Close" : "Edit"}</button>
              </div>
              {open && edit && (
                <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
                    <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
                      <label htmlFor={`cn-${c.id}`} style={{ fontWeight: 700 }}>Character name</label>
                      <input id={`cn-${c.id}`} className="ld-in" style={{ maxWidth: 360 }} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                      <label htmlFor={`cr-${c.id}`} style={{ fontWeight: 700 }}>Role</label>
                      <input id={`cr-${c.id}`} className="ld-in" style={{ maxWidth: 360 }} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} />
                      <label htmlFor={`cl-${c.id}`} style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>{c.kind === "owner" ? "Wardrobe" : "How they look"}</label>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <textarea id={`cl-${c.id}`} className="ld-in" rows={2} value={edit.look} onChange={(e) => setEdit({ ...edit, look: e.target.value })} style={{ height: "auto", padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }} />
                        <span className="ld-small">{c.kind === "owner" ? "Your face comes from your photos and plates below." : c.kind === "team" ? "Their face comes from their portrait on Team." : "Changing this makes a new portrait the next time they're in a shot."}</span>
                      </div>
                      <label htmlFor={`cv-${c.id}`} style={{ fontWeight: 700 }}>Voice</label>
                      <select id={`cv-${c.id}`} className="ld-in" style={{ maxWidth: 360 }} value={edit.voiceId} onChange={(e) => setEdit({ ...edit, voiceId: e.target.value })}>
                        <option value="">Pick a voice</option>
                        {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.own ? " (yours)" : ""}</option>)}
                      </select>
                    </div>
                    {c.kind === "owner" && <OwnerPack />}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: c.id, name: edit.name, role: edit.role, look: edit.look, voiceId: edit.voiceId || null, voiceName: voices.find((v) => v.id === edit.voiceId)?.name ?? (edit.voiceId === c.voiceId ? c.voiceName : null) })}>Save</button>
                    <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
                    <ErrorLine error={save.error} />
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ==========================================
// Style: videos the owner likes
// ==========================================

const LIKES = ["Camera", "Lighting", "Pacing", "Story", "Transitions", "Sound", "Color", "Hook"];
type RefEdit = { id?: string; name: string; link: string; likes: string[]; words: string };

export function StyleTab() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = useStudio();
  const [edit, setEdit] = React.useState<RefEdit | null>(null);
  const done = async () => { setEdit(null); await utils.drama.invalidate(); };
  const save = trpc.drama.saveStyleRef.useMutation({ onSuccess: done });
  const remove = trpc.drama.removeStyleRef.useMutation({ onSuccess: done });
  const refs = q.data?.styleRefs ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Videos you like</span>
          {refs.length ? (
            <div className="ld-logins" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,2fr) 128px", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              {refs.map((r) => (
                <React.Fragment key={r.id}>
                  <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.link ? <a href={r.link} target="_blank" rel="noreferrer noopener" style={{ color: "#14221c" }}>{r.name}</a> : r.name}</b>
                  <span>{[r.likes.join(", "), r.words].filter(Boolean).join(": ")}</span>
                  <button type="button" className="ld-btn" onClick={() => setEdit({ ...r })}>Edit</button>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 14, color: "#3d4c45" }}>{q.isLoading ? "Loading..." : "Add videos you love and tag what you like about each one. Elena can't watch them, so your tags and words are what she learns from."}</span>
          )}
          {refs.length > 0 && <span className="ld-small">Elena uses what you tag here in every plan. She can't watch the videos, so your words are what she learns from.</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className="ld-btn p" onClick={() => setEdit({ name: "", link: "", likes: [], words: "" })}>Add video</button>
        </div>
      </div>
      {edit && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">{edit.id ? edit.name || "Edit video" : "Add video"}</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              <label htmlFor="sr-name" style={{ fontWeight: 700 }}>Name</label>
              <input id="sr-name" className="ld-in" style={{ maxWidth: 360 }} placeholder="Founder walk-in, luxury lobby" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <label htmlFor="sr-link" style={{ fontWeight: 700 }}>Link</label>
              <input id="sr-link" className="ld-in" placeholder="Paste a TikTok, Instagram or YouTube link" value={edit.link} onChange={(e) => setEdit({ ...edit, link: e.target.value })} />
              <b>What you like</b>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {LIKES.map((l) => {
                  const on = edit.likes.includes(l);
                  return (
                    <button key={l} type="button" aria-pressed={on} className="ld-sug" style={{ borderRadius: 8, height: 32, fontWeight: 700, background: on ? "#e6f2ec" : "#fff", borderColor: on ? "#1b6b4a" : undefined, color: on ? "#155c3e" : "#14221c" }} onClick={() => setEdit({ ...edit, likes: on ? edit.likes.filter((x) => x !== l) : [...edit.likes, l] })}>{l}</button>
                  );
                })}
              </div>
              <label htmlFor="sr-words" style={{ fontWeight: 700 }}>In your words</label>
              <input id="sr-words" className="ld-in" placeholder="The slow walk toward camera and the warm lobby light" value={edit.words} onChange={(e) => setEdit({ ...edit, words: e.target.value })} />
            </div>
            <ErrorLine error={save.error || remove.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={save.isPending || !edit.name.trim()} onClick={() => save.mutate({ organizationId: currentOrgId, ...edit })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            {edit.id && <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: edit.id! })}>Remove</button>}
          </div>
        </div>
      )}
    </div>
  );
}
