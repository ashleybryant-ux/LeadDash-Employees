import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { StylePicker } from "./Styles";
import type { Outputs } from "../types";

/**
 * A Scene (2026-10-13): characters talking to each other, every line lip synced, in a
 * real or drawn style. The cast with their voices, then each shot with who speaks, the
 * line and what we see; Edit opens a shot or a person in place with Save and Cancel.
 * Pictures are made first; Make the scene animates them and matches every line.
 */

export type SceneV = NonNullable<Outputs["scenes"]["get"]>;
type Shot = SceneV["shots"][number];

const PILL: Record<SceneV["status"], { cls: string; label: string }> = {
  script: { cls: "amber", label: "Draft" },
  keyframes: { cls: "amber", label: "Ready to make" },
  making: { cls: "blue", label: "Making" },
  ready: { cls: "green", label: "Ready" },
  failed: { cls: "red", label: "Stopped" },
};

const at = (shots: Shot[], i: number) => {
  const t = shots.slice(0, i).reduce((n, s) => n + (s.seconds || 0), 0);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

function useScene(id: number) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.scenes.get.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.status === "making" ? 3_000 : false) });
  const refresh = () => Promise.all([utils.scenes.get.invalidate({ organizationId: currentOrgId, id }), utils.scenes.list.invalidate()]);
  return { orgId: currentOrgId, v: q.data, loading: q.isLoading, refresh };
}

/** What it's doing now and how far along, while pictures are made or the scene is animated. */
function SceneProgress({ v }: { v: SceneV }) {
  const pct = Math.max(2, Math.min(99, v.scene?.pct ?? 0));
  const label = v.progress || (v.plan.approved ? `Animating shot ${v.done + 1} of ${v.shots.length}` : `Picture ${Math.min(v.stills + 1, v.shots.length)} of ${v.shots.length}`);
  return (
    <div className="ld-vprog">
      <div className="ld-vprog-head">
        <span>{label}</span>
        <span className="ld-vprog-pct">{`${pct}%`}</span>
      </div>
      <div className="ld-vprog-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Making the scene">
        <div className="ld-vprog-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="ld-vprog-steps">
        <span className={`ld-vprog-step ${v.stills === v.shots.length ? "done" : "now"}`}>{`Pictures ${v.stills} of ${v.shots.length}`}</span>
        <span className={`ld-vprog-step ${v.plan.approved ? (v.done === v.shots.length ? "done" : "now") : "next"}`}>{`Animating and lip sync ${v.done} of ${v.shots.length}`}</span>
        <span className={`ld-vprog-step ${v.plan.approved && v.done === v.shots.length ? "now" : "next"}`}>Cutting it together</span>
      </div>
    </div>
  );
}

function CastCard({ v, c, busy }: { v: SceneV; c: NonNullable<SceneV["scene"]>["cast"][number]; busy: boolean }) {
  const { orgId, refresh } = useScene(v.id);
  const [edit, setEdit] = React.useState(false);
  const [name, setName] = React.useState(c.name);
  const [look, setLook] = React.useState(c.look);
  const [voice, setVoice] = React.useState(c.voiceId ?? "");
  const voices = trpc.scenes.voices.useQuery({ organizationId: orgId }, { enabled: edit && !c.owner });
  const save = trpc.scenes.saveCast.useMutation({ onSuccess: async () => (await refresh(), setEdit(false)) });
  const open = () => (setName(c.name), setLook(c.look), setVoice(c.voiceId ?? ""), setEdit(true));
  return (
    <div className={`ld-sc-person ${edit ? "editing" : ""}`}>
      <div className="ld-sc-person-row">
        {c.portrait ? <img className="ld-sc-face" src={c.portrait} alt="" /> : <span className="ld-sc-face ph">{initial(c.name)}</span>}
        <span style={{ minWidth: 0, flex: 1 }}>
          <b>{c.name}</b>
          <span className="ld-small">{`${c.team ? "Your AI team" : c.role || "In the scene"} · ${c.owner ? "your voice" : c.voiceName ?? "no voice yet"}`}</span>
        </span>
        <button type="button" className="ld-btn sm" style={{ width: 90 }} disabled={busy} onClick={() => (edit ? setEdit(false) : open())}>{edit ? "Cancel" : "Edit"}</button>
      </div>
      {edit && (
        <div className="ld-sc-form">
          {!c.team && (
            <>
              <span className="ld-lbl">Name</span>
              <input className="ld-in xs" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            </>
          )}
          {!c.owner && (
            <>
              {!c.team && (
                <>
                  <span className="ld-lbl">Look</span>
                  <input className="ld-in xs" aria-label="Look" value={look} onChange={(e) => setLook(e.target.value)} />
                </>
              )}
              <span className="ld-lbl">Voice</span>
              <select className="ld-in xs" aria-label="Voice" value={voice} onChange={(e) => setVoice(e.target.value)}>
                {!voice && <option value="">Pick a voice</option>}
                {c.voiceId && !(voices.data ?? []).some((x) => x.id === c.voiceId) && <option value={c.voiceId}>{c.voiceName ?? "Current voice"}</option>}
                {(voices.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>{[x.name, x.gender, x.accent].filter(Boolean).join(", ")}</option>
                ))}
              </select>
            </>
          )}
          <span />
          <div className="ld-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit(false)}>Cancel</button>
            <button
              type="button"
              className="ld-btn p"
              style={{ width: 100 }}
              disabled={save.isPending}
              onClick={() => {
                const pick = (voices.data ?? []).find((x) => x.id === voice);
                save.mutate({ organizationId: orgId, id: v.id, index: c.index, name, look: c.owner || c.team ? c.look : look, voiceId: c.owner ? c.voiceId : voice || null, voiceName: c.owner ? c.voiceName : pick?.name ?? (voice === c.voiceId ? c.voiceName : null) });
              }}
            >
              {save.isPending ? "Saving" : "Save"}
            </button>
          </div>
          {!c.owner && !c.team && look.trim() !== c.look && <span className="ld-small" style={{ gridColumn: "1 / -1" }}>A new look means a new portrait, and the shots they're in are drawn again.</span>}
          <ErrorLine error={save.error} />
        </div>
      )}
    </div>
  );
}

function ShotRow({ v, s, i, busy }: { v: SceneV; s: Shot; i: number; busy: boolean }) {
  const { orgId, refresh } = useScene(v.id);
  const cast = v.scene?.cast ?? [];
  const [edit, setEdit] = React.useState(false);
  const [who, setWho] = React.useState(s.line?.who ?? "");
  const [line, setLine] = React.useState(s.line?.text ?? "");
  const [see, setSee] = React.useState(s.action);
  const save = trpc.scenes.saveShot.useMutation({ onSuccess: async () => (await refresh(), setEdit(false)) });
  const redo = trpc.scenes.redo.useMutation({ onSuccess: refresh });
  // Gemini speaks a talking shot itself, in a voice it picks. She chooses it per shot, after a warning.
  const [warn, setWarn] = React.useState(false);
  const engine = trpc.scenes.engine.useMutation({ onSuccess: async () => (await refresh(), setWarn(false)) });
  const gemini = s.engine === "omni";
  const speaker = s.line ? cast.find((c) => c.name.toLowerCase() === s.line!.who.toLowerCase()) : null;
  const canGemini = !!s.line && !!s.stillUrl;
  const open = () => (setWho(s.line?.who ?? ""), setLine(s.line?.text ?? ""), setSee(s.action), setEdit(true));
  const thumb = s.stillUrl;
  return (
    <>
      <div className={`ld-sc-shot ${edit ? "editing" : ""}`}>
        <span className="ld-sc-n">{s.n}</span>
        <span className={`ld-sc-th ${v.scene?.ratio === "16:9" ? "wide" : v.scene?.ratio === "1:1" ? "square" : ""}`}>
          {thumb ? <img src={thumb} alt="" /> : <span>{v.status === "making" && !v.plan.approved ? "Drawing..." : "Not made yet"}</span>}
        </span>
        <div className="ld-sc-say">
          <span className="ld-sc-tag">{`${s.line ? (gemini ? "Gemini voice" : "Lip synced") : "No dialogue"} · ${at(v.shots, i)}`}</span>
          {s.line && <span className="ld-sc-who">{s.line.who}</span>}
          {s.line && <span className="ld-sc-line">{`"${s.line.text}"`}</span>}
          <span className="ld-sc-see">{s.action}</span>
        </div>
        <div className="ld-sc-acts">
          <button type="button" className="ld-btn sm" disabled={busy} aria-expanded={edit} onClick={() => (edit ? setEdit(false) : open())}>{edit ? "Cancel" : "Edit"}</button>
          <button type="button" className="ld-btn sm" disabled={busy || redo.isPending || !s.stillUrl} onClick={() => redo.mutate({ organizationId: orgId, id: v.id, n: s.n })}>{redo.isPending ? "Starting..." : "Redo picture"}</button>
          {canGemini && (
            <button type="button" className="ld-btn sm" disabled={busy || engine.isPending} onClick={() => (gemini ? engine.mutate({ organizationId: orgId, id: v.id, n: s.n, engine: "kling" }) : setWarn(!warn))}>{engine.isPending ? "Switching..." : gemini ? "Use Kling" : "Use Gemini"}</button>
          )}
        </div>
      </div>
      {edit && (
        <div className="ld-sc-form ld-sc-shotedit">
          <span className="ld-lbl">Who speaks</span>
          <select className="ld-in xs" aria-label="Who speaks" value={who} onChange={(e) => setWho(e.target.value)}>
            {cast.map((c) => (
              <option key={c.index} value={c.name}>{c.name}</option>
            ))}
            <option value="">Nobody</option>
          </select>
          <span className="ld-lbl">Line</span>
          <input className="ld-in xs" aria-label="Line" value={line} disabled={!who} maxLength={200} onChange={(e) => setLine(e.target.value)} />
          <span className="ld-lbl">What we see</span>
          <input className="ld-in xs" aria-label="What we see" value={see} maxLength={600} onChange={(e) => setSee(e.target.value)} />
          <span />
          <div className="ld-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit(false)}>Cancel</button>
            <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: v.id, n: s.n, who: who || null, line: who ? line : "", see })}>
              {save.isPending ? "Saving" : "Save"}
            </button>
          </div>
          {see.trim() !== s.action && <span className="ld-small" style={{ gridColumn: "1 / -1" }}>A new "what we see" means this picture is made again.</span>}
          <ErrorLine error={save.error} />
        </div>
      )}
      {!edit && redo.error && <ErrorLine error={redo.error} />}
      {!edit && warn && !gemini && (
        <div className="ld-sc-warn" role="alert">
          <b>{speaker?.owner ? "This won't be your voice." : `This won't be ${s.line?.who ?? "their"}'s voice from the cast.`}</b>
          <span>{speaker?.owner
            ? "Gemini makes the picture and the voice together and picks the voice itself, so your cloned voice can't be used. Keep Kling for your own lines if you want to sound like you."
            : "Gemini makes the picture and the voice together and picks the voice itself from how they look. It may sound like someone else in the scene."}</span>
          <div className="ld-row" style={{ gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="ld-btn sm" onClick={() => setWarn(false)}>Cancel</button>
            <button type="button" className="ld-btn sm p" disabled={engine.isPending} onClick={() => engine.mutate({ organizationId: orgId, id: v.id, n: s.n, engine: "omni" })}>{engine.isPending ? "Switching..." : "Use Gemini"}</button>
          </div>
        </div>
      )}
      {!edit && engine.error && <ErrorLine error={engine.error} />}
    </>
  );
}

/** The Scene in chat and on Elena's Videos tab. */
export function SceneCard({ id, bare = false }: { id: number; bare?: boolean }) {
  const { orgId, v, loading, refresh } = useScene(id);
  const make = trpc.scenes.make.useMutation({ onSuccess: refresh });
  const stop = trpc.scenes.stop.useMutation({ onSuccess: refresh });
  const style = trpc.scenes.setStyle.useMutation({ onSuccess: refresh });
  const rewrite = trpc.scenes.rewrite.useMutation({ onSuccess: async () => (await refresh(), setRewriting(false), setChange("")) });
  const remove = trpc.scenes.remove.useMutation({ onSuccess: refresh });
  const [picking, setPicking] = React.useState(false);
  const [rewriting, setRewriting] = React.useState(false);
  const [change, setChange] = React.useState("");
  if (!v) return loading ? null : <div className="ld-card ld-empty">This scene was removed.</div>;
  const sc = v.scene!;
  const pill = PILL[v.status];
  const making = v.status === "making";
  const ready = v.status === "ready" && !!v.videoUrl;
  const allPictures = v.shots.every((s) => s.stillUrl);
  const meta = ["Scene", sc.styleLabel, v.length, sc.ratio].join(" · ");
  return (
    <div className={bare ? "ld-vm-card bare" : "ld-card ld-vm-card"}>
      <div className="ld-vm-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span className="ld-vm-title">{v.title}</span>
          <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{meta}</span>
        </div>
        <span className={`ld-pill ${pill.cls}`}>{pill.label}</span>
      </div>

      {ready && (
        <div className={`ld-sc-player ${sc.ratio === "16:9" ? "wide" : ""}`}>
          <video key={v.videoUrl!} src={`${v.videoUrl}#t=0.1`} controls playsInline preload="metadata" />
          <div className="ld-vm-btncol">
            <a className="ld-btn p" href={v.videoUrl!} download={`${v.title}.mp4`}>Download</a>
            <span className="ld-small">{`Made for ${v.cost}.`}</span>
          </div>
        </div>
      )}
      {making && <SceneProgress v={v} />}
      {v.status === "failed" && v.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{v.error}</span>}

      <span className="ld-lbl">Cast</span>
      <div className="ld-sc-cast">
        {sc.cast.map((c) => (
          <CastCard key={c.index} v={v} c={c} busy={making} />
        ))}
      </div>

      <span className="ld-lbl">Shots</span>
      <div className="ld-sc-shots">
        {v.shots.map((s, i) => (
          <ShotRow key={s.n} v={v} s={s} i={i} busy={making} />
        ))}
      </div>

      {rewriting && (
        <div className="ld-sc-form">
          <span className="ld-lbl">Change</span>
          <input className="ld-in xs" aria-label="What to change" value={change} placeholder="Make it funnier, add her boss, end on a twist" onChange={(e) => setChange(e.target.value)} />
          <span />
          <div className="ld-row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setRewriting(false)}>Cancel</button>
            <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={rewrite.isPending || !change.trim()} onClick={() => rewrite.mutate({ organizationId: orgId, id: v.id, change })}>{rewrite.isPending ? "Writing" : "Rewrite"}</button>
          </div>
        </div>
      )}
      {picking && <StylePicker title="Change style" value={sc.style} onClose={() => setPicking(false)} onPick={(k) => (setPicking(false), k !== sc.style && style.mutate({ organizationId: orgId, id: v.id, style: k }))} />}
      <ErrorLine error={make.error ?? style.error ?? rewrite.error ?? stop.error ?? remove.error} />

      <div className="ld-vm-foot">
        <span className="ld-vm-hours">{ready ? `Made for ${v.cost}` : allPictures ? `Making it costs ${v.animateCost}` : `Pictures so far: ${v.cost}`}</span>
        <div className="ld-row" style={{ gap: 8, flexWrap: "wrap" }}>
          {making ? (
            <button type="button" className="ld-btn" style={{ width: 150 }} disabled={stop.isPending} onClick={() => stop.mutate({ organizationId: orgId, id: v.id })}>Stop</button>
          ) : (
            <>
              <button type="button" className="ld-btn" style={{ width: 150 }} disabled={style.isPending} onClick={() => setPicking(true)}>{style.isPending ? "Changing..." : "Change style"}</button>
              <button type="button" className="ld-btn" style={{ width: 150 }} aria-pressed={rewriting} onClick={() => setRewriting(!rewriting)}>Rewrite scene</button>
              {bare && <button type="button" className="ld-btn" style={{ width: 150 }} disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: v.id })}>Remove</button>}
              <button type="button" className="ld-btn p" style={{ width: 150 }} disabled={make.isPending || (!allPictures && v.status !== "failed")} onClick={() => make.mutate({ organizationId: orgId, id: v.id })}>
                {make.isPending ? "Starting..." : v.status === "failed" ? "Try again" : ready ? "Make it again" : "Make the scene"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
