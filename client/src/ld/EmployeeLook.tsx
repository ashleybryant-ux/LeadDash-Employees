import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, ErrorLine } from "./ui";
import { SILENT } from "./voice";
import type { Outputs } from "./types";

/**
 * Photos and voices: each employee's photo (shown everywhere it appears) and
 * the voice it speaks with, a Play next to every option, and what each
 * provider costs. Read view with Edit; Edit opens the fields with Save and
 * Cancel. The whole list lives on the Workspace page; one employee's card sits
 * on its Onboarding tab.
 */

type Options = Outputs["voices"]["options"];
type Emp = Options["employees"][number];
type Provider = "elevenlabs" | "openai";
const PROVIDER_NAME: Record<Provider, string> = { elevenlabs: "ElevenLabs", openai: "OpenAI" };
/** The AI providers are LeadDash's trade secret: workspaces see Standard and Premium voices, and only LeadDash staff see who and what it costs. */
const CUSTOMER_NAME: Record<Provider, string> = { elevenlabs: "Premium", openai: "Standard" };
function useStaff() {
  return useAuth().user?.role === "admin";
}

/** Plays a sample: the audio element starts on the tap (so phones allow it), then gets the clip. */
function usePlayer() {
  const { currentOrgId } = useTenant();
  const preview = trpc.voices.preview.useMutation();
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const el = React.useRef<HTMLAudioElement | null>(null);
  const play = (provider: Provider, voiceId: string, employeeId?: number) => {
    const key = `${provider}:${voiceId}:${employeeId ?? 0}`;
    const a = el.current ?? new Audio();
    el.current = a;
    if (playing === key) {
      a.pause();
      setPlaying(null);
      return;
    }
    setError(null);
    a.src = SILENT;
    void a.play().catch(() => null);
    setPlaying(key);
    preview.mutate(
      { organizationId: currentOrgId, provider, voiceId, employeeId },
      {
        onSuccess: (r) => {
          a.src = r.audioUrl;
          a.onended = () => setPlaying((p) => (p === key ? null : p));
          void a.play().catch(() => setPlaying(null));
        },
        onError: (e) => {
          setPlaying(null);
          setError(e.message);
        },
      }
    );
  };
  React.useEffect(() => () => el.current?.pause(), []);
  return { play, playing, error, busy: preview.isPending };
}

function PlayButton({ on, busy, onClick, small }: { on: boolean; busy?: boolean; onClick: () => void; small?: boolean }) {
  return (
    <button type="button" className={`ld-btn ${small ? "sm" : ""} ${on ? "p" : ""}`} style={{ width: small ? 72 : 90 }} aria-label={on ? "Stop" : "Play a sample"} disabled={busy && !on} onClick={onClick}>
      {on ? (busy ? "Loading" : "■ Stop") : "▶ Play"}
    </button>
  );
}

/** The provider for the whole workspace, with what each costs. */
export function VoiceProviderCard({ v }: { v: Options }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [edit, setEdit] = React.useState<null | "auto" | "elevenlabs" | "openai">(null);
  const save = trpc.voices.setProvider.useMutation({ onSuccess: async () => { await utils.voices.options.invalidate(); setEdit(null); } });
  const label = v.setting === "auto" ? `Automatic: ${v.hasElevenLabs ? "ElevenLabs, with OpenAI as the fallback" : "OpenAI (ElevenLabs is not set up on the server)"}` : v.setting === "elevenlabs" ? (v.hasElevenLabs ? "ElevenLabs" : "ElevenLabs (not set up on the server, so OpenAI speaks for now)") : "OpenAI";
  const choices: { key: "auto" | "elevenlabs" | "openai"; title: string; price: string }[] = [
    { key: "auto", title: "Automatic", price: v.hasElevenLabs ? "ElevenLabs when it works, OpenAI if it runs out" : "OpenAI until ElevenLabs is set up" },
    { key: "elevenlabs", title: "ElevenLabs", price: v.prices.elevenlabs.perMinute },
    { key: "openai", title: "OpenAI", price: v.prices.openai.perMinute },
  ];
  return (
    <section className={`ld-card ${edit ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">Voices</span>
        {edit ? (
          <span className="ld-row">
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, setting: edit })}>{save.isPending ? "Saving" : "Save"}</button>
          </span>
        ) : (
          <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit(v.setting as never)}>Edit</button>
        )}
      </div>
      <div className="ld-kv" style={{ alignItems: "start" }}>
        <span className="ld-k">Voice provider</span>
        {edit ? (
          <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {choices.map((c) => (
              <label key={c.key} className="ld-row" style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="radio" name="voice-provider" style={{ marginTop: 4, accentColor: "var(--ld-accent)" }} checked={edit === c.key} onChange={() => setEdit(c.key)} />
                <span>
                  <b>{c.title}</b>
                  <span className="ld-small ld-muted" style={{ display: "block" }}>{c.price}</span>
                </span>
              </label>
            ))}
          </span>
        ) : (
          <span>{label}</span>
        )}
        <span className="ld-k">What it costs</span>
        <span style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
          <span>
            <b>OpenAI</b>: {v.prices.openai.perMinute}. <span className="ld-muted">{v.prices.openai.detail}</span> <a href={v.prices.openai.url} target="_blank" rel="noreferrer">OpenAI pricing</a>
          </span>
          <span>
            <b>ElevenLabs</b>: {v.prices.elevenlabs.perMinute}. <span className="ld-muted">{v.prices.elevenlabs.detail}</span> <a href={v.prices.elevenlabs.url} target="_blank" rel="noreferrer">ElevenLabs pricing</a>
          </span>
          <span className="ld-small ld-muted">Prices are the vendors' published rates as of October 2026; the vendor's page is current. A huddle or one-on-one answer is usually 15 to 40 seconds of speech.</span>
        </span>
      </div>
      <ErrorLine error={save.error} />
    </section>
  );
}

/** One employee: photo and voice, read view with Edit. */
export function EmployeeLookRow({ v, e, single }: { v: Options; e: Emp; single?: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const player = usePlayer();
  const [editing, setEditing] = React.useState(false);
  const [provider, setProvider] = React.useState<Provider>(e.provider);
  const [voiceId, setVoiceId] = React.useState<string | null>(e.own ? e.voiceId : null);
  const [photoErr, setPhotoErr] = React.useState<string | null>(null);
  const refresh = async () => Promise.all([utils.voices.options.invalidate(), utils.employees.list.invalidate(), utils.onboarding.get.invalidate()]);
  const save = trpc.voices.setEmployee.useMutation({ onSuccess: async () => { await refresh(); setEditing(false); } });
  const upload = trpc.employees.uploadPhoto.useMutation({ onSuccess: refresh });
  const remove = trpc.employees.removePhoto.useMutation({ onSuccess: refresh });
  const start = () => {
    setProvider(e.provider);
    setVoiceId(e.own ? e.voiceId : null);
    setPhotoErr(null);
    setEditing(true);
  };
  const onFile = (file: File | undefined) => {
    setPhotoErr(null);
    if (!file) return;
    if (file.size > 8_000_000) return setPhotoErr("Photos can be up to 8 MB.");
    const r = new FileReader();
    r.onload = () => upload.mutate({ organizationId: currentOrgId, id: e.id, data: String(r.result) });
    r.onerror = () => setPhotoErr("That file could not be read.");
    r.readAsDataURL(file);
  };
  const options: { id: string; name: string; note: string }[] =
    provider === "openai" ? v.openai : (v.elevenlabs ?? []).map((x) => ({ id: x.id, name: x.name, note: [x.gender, x.accent, x.own ? "your own voice" : ""].filter(Boolean).join(", ") }));
  const staff = useStaff();
  const nameOf = (p: Provider) => (staff ? PROVIDER_NAME[p] : CUSTOMER_NAME[p]);
  const defaultName = e.own ? "" : e.voiceName;
  const voiceText = e.voiceId ? `${e.voiceName || e.voiceId} (${nameOf(e.provider)})${e.own ? "" : ", the standard voice for this role"}` : `No voice yet (${nameOf(e.provider)})`;
  return (
    <div className={`ld-look ${editing ? "editing" : ""}`}>
      <div className="ld-look-row">
        <Avatar name={e.name} kind={e.kind} src={e.avatar} size={44} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <b style={{ display: "block", fontSize: 14 }}>{e.name}</b>
          <span className="ld-small ld-muted" style={{ display: "block" }}>{e.roleTitle}</span>
        </span>
        <span className="ld-look-voice">{voiceText}</span>
        {e.voiceId && <PlayButton on={player.playing === `${e.provider}:${e.voiceId}:${e.id}`} busy={player.busy} onClick={() => player.play(e.provider, e.voiceId!, e.id)} />}
        {!editing ? (
          <button type="button" className="ld-btn" style={{ width: 90 }} onClick={start}>Edit</button>
        ) : (
          <button type="button" className="ld-btn" style={{ width: 90 }} onClick={() => setEditing(false)}>Cancel</button>
        )}
      </div>
      {editing && (
        <div className="ld-look-edit">
          <div className="ld-field">
            <span className="ld-lbl">Photo</span>
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 10 }}>
              <Avatar name={e.name} kind={e.kind} src={e.avatar} size={56} />
              <label className="ld-btn" style={{ width: 128 }}>
                {upload.isPending ? "Uploading" : "Upload photo"}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={(ev) => { onFile(ev.target.files?.[0]); ev.target.value = ""; }} />
              </label>
              {e.avatar && <button type="button" className="ld-btn" style={{ width: 150 }} disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: e.id })}>Use the standard one</button>}
              <span className="ld-small ld-muted">Square works best. It shows everywhere {e.name} appears the moment it is uploaded.</span>
              {photoErr && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{photoErr}</span>}
            </div>
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Voice</span>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              {(["elevenlabs", "openai"] as Provider[]).map((p) => (
                <button key={p} type="button" className={`ld-chip ${provider === p ? "on" : ""}`} aria-pressed={provider === p} disabled={p === "elevenlabs" && !v.hasElevenLabs} onClick={() => { setProvider(p); setVoiceId(null); }}>
                  {staff ? `${PROVIDER_NAME[p]} · ${v.prices[p].perMinute.replace("about ", "")}` : CUSTOMER_NAME[p]}
                </button>
              ))}
              {!v.hasElevenLabs && <span className="ld-small ld-muted">{staff ? "ElevenLabs is not set up on the server." : "Premium voices use your own ElevenLabs account. Connect it under Integrations."}</span>}
            </div>
            {provider === "elevenlabs" && v.elevenError && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{staff ? v.elevenError : "Premium voices couldn't load. Try again in a minute."}</span>}
            <div className="ld-look-voices">
              <label className={`ld-look-opt ${voiceId === null ? "on" : ""}`}>
                <input type="radio" name={`voice-${e.id}`} checked={voiceId === null} onChange={() => setVoiceId(null)} />
                <span style={{ flex: 1 }}>
                  <b>The standard voice for this role</b>
                  <span className="ld-small ld-muted" style={{ display: "block" }}>{provider === e.provider && defaultName ? defaultName : "Picked by the provider"}</span>
                </span>
              </label>
              {options.map((o) => (
                <label key={o.id} className={`ld-look-opt ${voiceId === o.id ? "on" : ""}`}>
                  <input type="radio" name={`voice-${e.id}`} checked={voiceId === o.id} onChange={() => setVoiceId(o.id)} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>{o.name}</b>
                    {o.note && <span className="ld-small ld-muted" style={{ display: "block" }}>{o.note}</span>}
                  </span>
                  <PlayButton small on={player.playing === `${provider}:${o.id}:${e.id}`} busy={player.busy} onClick={() => player.play(provider, o.id, e.id)} />
                </label>
              ))}
              {provider === "elevenlabs" && v.hasElevenLabs && !options.length && !v.elevenError && <span className="ld-small ld-muted">{staff ? "No voices on the ElevenLabs account yet. Add some under My Voices in ElevenLabs." : "No premium voices yet."}</span>}
            </div>
          </div>
          {player.error && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{player.error}</span>}
          <ErrorLine error={save.error || upload.error || remove.error} />
          <div className="ld-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEditing(false)}>Cancel</button>
            <button
              type="button"
              className="ld-btn p"
              style={{ width: 100 }}
              disabled={save.isPending}
              onClick={() => save.mutate({ organizationId: currentOrgId, employeeId: e.id, choice: voiceId ? { provider, voiceId, voiceName: options.find((o) => o.id === voiceId)?.name ?? voiceId } : null })}
            >
              {save.isPending ? "Saving" : "Save"}
            </button>
          </div>
        </div>
      )}
      {!editing && player.error && !single && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)", padding: "0 18px 10px", display: "block" }}>{player.error}</span>}
    </div>
  );
}

/** The whole team on the Workspace page. */
export function EmployeesLook() {
  const { currentOrgId } = useTenant();
  const q = trpc.voices.options.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const staff = useStaff();
  if (!q.data) return <section className="ld-card"><div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load the voices."}<ErrorLine error={q.error} /></div></section>;
  return (
    <>
      {staff && <VoiceProviderCard v={q.data} />}
      <section className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-sh">
          <span className="ld-st">Photos and voices</span>
          <span className="ld-small ld-muted">Play hears the employee; Edit changes its photo or voice.</span>
        </div>
        {q.data.employees.map((e) => (
          <EmployeeLookRow key={e.id} v={q.data!} e={e} />
        ))}
      </section>
    </>
  );
}

/** One employee's card, on its Onboarding tab. */
export function EmployeeLookCard({ employeeId }: { employeeId: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.voices.options.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const e = q.data?.employees.find((x) => x.id === employeeId);
  if (!q.data || !e) return null;
  return (
    <section className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-sh">
        <span className="ld-st">Photo and voice</span>
        <span className="ld-small ld-muted">Every employee's, and what voices cost, is on the Workspace page.</span>
      </div>
      <EmployeeLookRow v={q.data} e={e} single />
    </section>
  );
}
