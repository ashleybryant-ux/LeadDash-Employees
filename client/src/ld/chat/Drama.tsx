import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";

/**
 * Elena's mini drama studio on screen: the season card and episode card in
 * chat, and the Episodes and Cast tabs on her Videos page.
 */

type Shot = { n: number; framing: string; move: string; action: string; setting: string; cast: string[]; line: { who: string; text: string } | null; seconds: number; stillUrl?: string | null; clipUrl?: string | null; status?: string; error?: string | null; costCents?: number };
type Ep = { id: number; number: number; title: string; logline: string; beats: { label: string; at: string; text: string }[]; shots: Shot[]; status: "script" | "making" | "ready" | "failed"; progress: string | null; videoUrl: string | null; error: string | null; length: string; cost: string; done: number };

const PILL: Record<Ep["status"], [string, string]> = {
  script: ["gray", "Script ready"],
  making: ["amber", "Making"],
  ready: ["green", "Ready"],
  failed: ["red", "Stopped"],
};

function useStudio() {
  const { currentOrgId } = useTenant();
  return trpc.drama.studio.useQuery({ organizationId: currentOrgId }, { refetchInterval: (q) => ((q.state.data?.episodes ?? []).some((e) => e.status === "making") ? 10_000 : false) });
}

function useMake() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.drama.invalidate(), utils.chat.list.invalidate()]);
  return {
    orgId: currentOrgId,
    make: trpc.drama.make.useMutation({ onSuccess: refresh }),
    remake: trpc.drama.remakeShot.useMutation({ onSuccess: refresh }),
  };
}

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function Face({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  return url ? (
    <img src={url} alt={name} style={{ width: size, height: size, borderRadius: 999, objectFit: "cover", border: "2px solid #fff" }} />
  ) : (
    <span aria-label={name} style={{ width: size, height: size, borderRadius: 999, background: "#8a2f3a", color: "#fff", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "2px solid #fff" }}>{initials(name)}</span>
  );
}

/** The season card in chat: the series, its cast, the first episode, Make. */
export function DramaSeasonCard({ firstId }: { firstId: number }) {
  const q = useStudio();
  const m = useMake();
  const st = q.data;
  if (!st?.series) return null;
  const eps = st.episodes.filter((e) => e.id >= firstId);
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
          {st.cast.map((c) => (
            <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, marginRight: 8 }}>
              <Face name={c.name} url={c.photoUrl} />
              {c.kind === "owner" ? "You" : c.name.split(" ")[0]}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 14, lineHeight: 1.5 }}>
          <b>Episode {first.number}: "{first.title}."</b> {first.logline}
        </span>
        <ErrorLine error={m.make.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {first.status === "script" || first.status === "failed" ? (
          <button type="button" className="ld-btn p" disabled={m.make.isPending} onClick={() => m.make.mutate({ organizationId: m.orgId, id: first.id })}>{m.make.isPending ? "Starting..." : `Make episode ${first.number}`}</button>
        ) : (
          <span className={`ld-pill ${PILL[first.status][0]}`} style={{ alignSelf: "flex-start" }}>{PILL[first.status][1]}</span>
        )}
        <Link href="/chats/video/work" className="ld-btn ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}

/** One episode in chat: progress while it's made, then the video. */
export function DramaEpisodeCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.drama.episode.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data?.status === "making" ? 10_000 : false) });
  const m = useMake();
  const e = q.data as Ep | null | undefined;
  if (!e) return null;
  const [cls, label] = PILL[e.status];
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="ld-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <b style={{ fontSize: 15 }}>Episode {e.number}: {e.title}</b>
          <span className={`ld-pill ${cls}`}>{label}</span>
        </div>
        {e.status === "ready" && e.videoUrl ? (
          <video src={e.videoUrl} controls playsInline preload="metadata" style={{ width: 240, maxWidth: "100%", aspectRatio: "9 / 16", borderRadius: 10, background: "#000" }} />
        ) : (
          <span style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.6 }}>
            {e.status === "making" ? `${e.progress ?? "Starting"}. ${e.done} of ${e.shots.length} shots made.` : e.status === "failed" ? `${e.error ?? "It stopped."} ${e.done} of ${e.shots.length} shots are kept.` : `${e.shots.length} shots · ${e.length} · ${e.cost}`}
          </span>
        )}
        <span className="ld-small">{e.length} · {e.cost}</span>
        <ErrorLine error={m.make.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(e.status === "script" || e.status === "failed") && (
          <button type="button" className="ld-btn p" disabled={m.make.isPending} onClick={() => m.make.mutate({ organizationId: m.orgId, id: e.id })}>{e.status === "failed" ? "Make again" : "Make it"}</button>
        )}
        {e.status === "ready" && e.videoUrl && (
          <a className="ld-btn p ld-av-link" href={e.videoUrl} download={`episode-${e.number}.mp4`}>Download</a>
        )}
        <Link href="/chats/video/work" className="ld-btn ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}

const SHOT_STATUS: Record<string, [string, string]> = { done: ["green", "Done"], making: ["amber", "Making"], failed: ["red", "Stopped"], todo: ["gray", "Not made"] };

function EpisodeRow({ e, open, onToggle }: { e: Ep; open: boolean; onToggle: () => void }) {
  const m = useMake();
  const [cls, label] = PILL[e.status];
  const COLS = "70px minmax(0,1.6fr) 80px 150px 100px 128px";
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "#f4f8f6", borderBottom: 0 } : {}) }}>
        <b>Ep {e.number}</b>
        <span style={{ overflowWrap: "anywhere" }}>{e.title}</span>
        <span>{e.length}</span>
        <span className={`ld-pill ${cls}`} style={{ justifySelf: "start" }}>{e.status === "making" ? `Making ${e.done} of ${e.shots.length}` : label}</span>
        <span>{e.cost}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            {e.videoUrl && e.status === "ready" && <video src={e.videoUrl} controls playsInline preload="metadata" style={{ width: 240, aspectRatio: "9 / 16", borderRadius: 10, background: "#000" }} />}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="ld-lbl">Beats</span>
              {e.beats.map((b, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr)", gap: 10, fontSize: 14, lineHeight: 1.5 }}>
                  <b>{b.label}</b>
                  <span>{b.at} {b.text}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="ld-lbl">Shots ({e.shots.length})</span>
              {e.shots.map((s) => {
                const [sc, sl] = SHOT_STATUS[s.status ?? (s.clipUrl ? "done" : "todo")] ?? SHOT_STATUS.todo;
                return (
                  <div key={s.n} className="ld-shot" style={{ display: "grid", gridTemplateColumns: "28px 72px minmax(0,1fr) 110px", gap: 12, alignItems: "start", background: "#fff", border: "1px solid #e3e9e6", borderRadius: 10, padding: 10 }}>
                    <b style={{ fontSize: 13 }}>{s.n}</b>
                    {s.clipUrl ? (
                      <video src={s.clipUrl} muted playsInline preload="metadata" controls style={{ width: 72, aspectRatio: "9 / 16", borderRadius: 6, background: "#000" }} />
                    ) : s.stillUrl ? (
                      <img src={s.stillUrl} alt={`Shot ${s.n}`} style={{ width: 72, aspectRatio: "9 / 16", objectFit: "cover", borderRadius: 6 }} />
                    ) : (
                      <span style={{ width: 72, aspectRatio: "9 / 16", borderRadius: 6, background: "#eef2f0", display: "block" }} />
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14, lineHeight: 1.5, minWidth: 0 }}>
                      <span><b>{s.framing}</b>, {s.move.toLowerCase()}: {s.action}</span>
                      {s.line && <span style={{ color: "#3d4c45" }}>{s.line.who}: "{s.line.text}"</span>}
                      <span className="ld-small">{s.cast.length ? s.cast.join(", ") : "No one"} · {s.seconds} sec{s.costCents ? ` · $${(s.costCents / 100).toFixed(2)}` : ""}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                      <span className={`ld-pill ${sc}`} style={{ alignSelf: "flex-start" }}>{sl}</span>
                      {s.clipUrl && e.status !== "making" && (
                        <button type="button" className="ld-btn sm" disabled={m.remake.isPending} onClick={() => m.remake.mutate({ organizationId: m.orgId, id: e.id, n: s.n })}>Remake</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <ErrorLine error={m.make.error || m.remake.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(e.status === "script" || e.status === "failed") && (
              <button type="button" className="ld-btn p" disabled={m.make.isPending} onClick={() => m.make.mutate({ organizationId: m.orgId, id: e.id })}>{e.status === "failed" ? "Make again" : "Make episode"}</button>
            )}
            {e.status === "ready" && e.videoUrl && <a className="ld-btn ld-av-link-plain" href={e.videoUrl} download={`episode-${e.number}.mp4`}>Download</a>}
          </div>
        </div>
      )}
    </>
  );
}

/** Episodes tab: the series, what's been spent, every episode with its beats and shots. */
export function DramaEpisodesTab({ empName }: { empName: string }) {
  const q = useStudio();
  const [open, setOpen] = React.useState<number | null>(null);
  const st = q.data;
  if (!st) return <div className="ld-card ld-empty">Loading...</div>;
  if (!st.series) return <div className="ld-card ld-empty">No series yet. Tell {empName} in Chat about the drama you want, like "Write a micro drama about a therapist who finds a file she wasn't supposed to see. I play the practice owner."</div>;
  const eps = st.episodes as Ep[];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="ld-card ld-av-set">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ld-lbl">Series</span>
          <b style={{ fontSize: 15 }}>{st.series.title}</b>
          <span style={{ fontSize: 14, lineHeight: 1.5 }}>{st.series.premise}</span>
          <span className="ld-small">Look: {st.series.look}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="ld-lbl">Spent this month</span>
          <b style={{ fontSize: 18 }}>${(st.spentCents / 100).toFixed(2)}</b>
          <span className="ld-small">of ${(st.limitCents / 100).toFixed(0)}</span>
        </div>
      </div>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: "70px minmax(0,1.6fr) 80px 150px 100px 128px" }}>
          <span>Episode</span>
          <span>Title</span>
          <span>Length</span>
          <span>Status</span>
          <span>Cost</span>
          <span />
        </div>
        {eps.map((e) => (
          <EpisodeRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
        ))}
      </div>
    </div>
  );
}

/** Cast tab: who's in the series, how they look, and their voice. */
export function DramaCastTab() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = useStudio();
  const voices = trpc.avatar.settings.useQuery({ organizationId: currentOrgId }).data?.voices ?? [];
  const save = trpc.drama.saveCast.useMutation({ onSuccess: async () => { setEdit(null); await utils.drama.invalidate(); } });
  const [edit, setEdit] = React.useState<{ id: number; name: string; role: string; look: string; voiceId: string } | null>(null);
  const cast = q.data?.cast ?? [];
  if (!cast.length) return <div className="ld-card ld-empty">{q.isLoading ? "Loading..." : "No cast yet. The cast is made when Elena writes the first episodes."}</div>;
  const COLS = "56px minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,1fr) 128px";
  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
        <span />
        <span>Character</span>
        <span>Role</span>
        <span>Voice</span>
        <span />
      </div>
      {cast.map((c) => {
        const open = edit?.id === c.id;
        return (
          <React.Fragment key={c.id}>
            <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "#f4f8f6", borderBottom: 0 } : {}) }}>
              <Face name={c.name} url={c.photoUrl} size={40} />
              <span><b>{c.kind === "owner" ? "You" : c.name}</b><br /><span className="ld-small">{c.kind === "owner" ? c.name : "Made up"}</span></span>
              <span>{c.role}</span>
              <span>{c.voiceName ?? <span style={{ color: "#8a4510" }}>Pick a voice</span>}</span>
              <button type="button" className="ld-btn" onClick={() => setEdit(open ? null : { id: c.id, name: c.name, role: c.role, look: c.look, voiceId: c.voiceId ?? "" })}>{open ? "Close" : "Edit"}</button>
            </div>
            {open && edit && (
              <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
                <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
                  <label htmlFor={`cn-${c.id}`} style={{ fontWeight: 700 }}>Character name</label>
                  <input id={`cn-${c.id}`} className="ld-in" style={{ maxWidth: 360 }} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                  <label htmlFor={`cr-${c.id}`} style={{ fontWeight: 700 }}>Role</label>
                  <input id={`cr-${c.id}`} className="ld-in" style={{ maxWidth: 360 }} value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} />
                  <label htmlFor={`cl-${c.id}`} style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>{c.kind === "owner" ? "Wardrobe" : "How they look"}</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <textarea id={`cl-${c.id}`} className="ld-in" rows={2} value={edit.look} onChange={(e) => setEdit({ ...edit, look: e.target.value })} style={{ height: "auto", padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }} />
                    <span className="ld-small">{c.kind === "owner" ? "Your face comes from your photo in the Brain, so you look like you in every shot." : "Changing this makes a new portrait the next time they're in a shot."}</span>
                  </div>
                  <label htmlFor={`cv-${c.id}`} style={{ fontWeight: 700 }}>Voice</label>
                  <select id={`cv-${c.id}`} className="ld-in" style={{ maxWidth: 360 }} value={edit.voiceId} onChange={(e) => setEdit({ ...edit, voiceId: e.target.value })}>
                    <option value="">Pick a voice</option>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}{v.own ? " (yours)" : ""}</option>
                    ))}
                  </select>
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
  );
}
