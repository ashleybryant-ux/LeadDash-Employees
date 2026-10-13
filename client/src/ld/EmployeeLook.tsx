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
type Provider = "local" | "elevenlabs" | "openai";
type Setting = "auto" | Provider;
const PROVIDER_NAME: Record<Provider, string> = { local: "LeadDash voices", elevenlabs: "ElevenLabs", openai: "OpenAI" };
/** The AI providers are LeadDash's trade secret: workspaces see Standard and Premium voices, and only LeadDash staff see who and what it costs. */
const CUSTOMER_NAME: Record<Provider, string> = { local: "Standard", elevenlabs: "Premium", openai: "Standard" };
const short = (price: string) => price.replace("about ", "").replace(" per minute", "/min");

/** The month's minutes and cost, one row per voice. */
function UsageTable({ v }: { v: Options }) {
  const u = v.usage;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="ld-vtable">
        <thead>
          <tr><th>Voice</th><th className="n">Minutes</th><th className="n">Cost</th></tr>
        </thead>
        <tbody>
          {u.rows.map((r) => (
            <tr key={r.key}><td>{r.label}</td><td className="n">{r.minutes.toLocaleString()}</td><td className="n">{r.cost}</td></tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>Total ({u.period})</td><td className="n">{u.total.minutes.toLocaleString()}</td><td className="n">{u.total.cost}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}
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

/** LeadDash staff: the main voice, the backup order, what each costs LeadDash and the month so far. */
export function VoiceProviderCard({ v }: { v: Options }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [edit, setEdit] = React.useState<null | { setting: Setting; backup: (Provider | "")[] }>(null);
  const saveMain = trpc.voices.setProvider.useMutation();
  const saveBackup = trpc.voices.setBackup.useMutation();
  const busy = saveMain.isPending || saveBackup.isPending;
  const save = async () => {
    if (!edit) return;
    await saveMain.mutateAsync({ organizationId: currentOrgId, setting: edit.setting });
    await saveBackup.mutateAsync({ organizationId: currentOrgId, order: edit.backup.filter((p): p is Provider => !!p) });
    await utils.voices.options.invalidate();
    setEdit(null);
  };
  const notSet: Record<Provider, boolean> = { local: !v.hasLocal, elevenlabs: !v.hasElevenLabs, openai: !v.hasOpenAi };
  const mainName = (s: Setting) => (s === "auto" ? "Automatic" : PROVIDER_NAME[s]);
  const label = `${mainName(v.setting as Setting)}${v.setting === "auto" ? `: ${PROVIDER_NAME[v.provider as Provider]} now` : ""}${v.setting !== "auto" && v.provider !== v.setting ? ` (not set up, so ${PROVIDER_NAME[v.provider as Provider]} speaks for now)` : ""}`;
  const choices: { key: Setting; price: string }[] = [
    { key: "auto", price: "LeadDash voices, then ElevenLabs, then OpenAI" },
    { key: "local", price: v.prices.local.perMinute },
    { key: "elevenlabs", price: v.prices.elevenlabs.perMinute },
    { key: "openai", price: v.prices.openai.perMinute },
  ];
  const backupText = v.backup.length ? (
    <span className="ld-row" style={{ gap: 16 }}>
      {v.backup.map((p, i) => (
        <span key={p}>{`${i + 1}. ${PROVIDER_NAME[p as Provider]}`}</span>
      ))}
    </span>
  ) : (
    "None"
  );
  return (
    <section className={`ld-card ${edit ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">Voices</span>
        {edit ? (
          <span className="ld-row">
            <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="ld-btn p" style={{ width: 100 }} disabled={busy} onClick={() => void save()}>{busy ? "Saving" : "Save"}</button>
          </span>
        ) : (
          <button type="button" className="ld-btn" style={{ width: 100 }} onClick={() => setEdit({ setting: v.setting as Setting, backup: [v.backup[0] ?? "", v.backup[1] ?? ""] as (Provider | "")[] })}>Edit</button>
        )}
      </div>
      <div className="ld-kv" style={{ alignItems: "start" }}>
        <span className="ld-k">Main voice</span>
        {edit ? (
          <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {choices.map((c) => (
              <label key={c.key} className={`ld-look-opt ${edit.setting === c.key ? "on" : ""}`} style={{ cursor: "pointer" }}>
                <input type="radio" name="voice-provider" checked={edit.setting === c.key} onChange={() => setEdit({ ...edit, setting: c.key })} />
                <span style={{ flex: 1 }}>
                  <b>{mainName(c.key)}</b>
                  <span className="ld-small ld-muted" style={{ display: "block" }}>{c.key !== "auto" && notSet[c.key] ? "Not set up on the server" : c.price}</span>
                </span>
              </label>
            ))}
          </span>
        ) : (
          <span>{label}</span>
        )}
        <span className="ld-k">Backup order</span>
        {edit ? (
          <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[0, 1].map((i) => (
              <span key={i} className="ld-row" style={{ gap: 8 }}>
                <b style={{ width: 16 }}>{i + 1}</b>
                <select
                  className="ld-in xs"
                  style={{ width: "auto", minWidth: 160 }}
                  aria-label={i === 0 ? "First backup" : "Second backup"}
                  value={edit.backup[i] ?? ""}
                  onChange={(ev) => {
                    const next = [...edit.backup];
                    next[i] = ev.target.value as Provider | "";
                    setEdit({ ...edit, backup: next });
                  }}
                >
                  <option value="">None</option>
                  {(["local", "elevenlabs", "openai"] as Provider[]).map((p) => (
                    <option key={p} value={p}>{PROVIDER_NAME[p]}</option>
                  ))}
                </select>
                {edit.backup[i] && <span className="ld-small ld-muted">{short(v.prices[edit.backup[i] as Provider].perMinute)}</span>}
              </span>
            ))}
          </span>
        ) : (
          <span>{backupText}</span>
        )}
        {!edit && (
          <>
            <span className="ld-k">What it costs</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(["local", "elevenlabs", "openai"] as Provider[]).map((p) => (
                <span key={p}>
                  <b>{PROVIDER_NAME[p]}</b>: {v.prices[p].perMinute}
                  {v.prices[p].url && <> <a href={v.prices[p].url} target="_blank" rel="noreferrer">Pricing</a></>}
                </span>
              ))}
            </span>
            <span className="ld-k">This month</span>
            <UsageTable v={v} />
          </>
        )}
      </div>
      <ErrorLine error={saveMain.error || saveBackup.error} />
    </section>
  );
}

/** A workspace's own view: its voice level, what that costs and the month so far. Never the providers. */
export function CustomerVoicesCard({ v }: { v: Options }) {
  const level = v.provider === "elevenlabs" ? "Premium" : "Standard";
  return (
    <section className="ld-card">
      <div className="ld-sh">
        <span className="ld-st">Voices</span>
      </div>
      <div className="ld-kv" style={{ alignItems: "start" }}>
        <span className="ld-k">Voice level</span>
        <span>{level}</span>
        <span className="ld-k">What it costs</span>
        <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span><b>Standard</b>: {v.prices.local.perMinute}</span>
          {v.hasElevenLabs && <span><b>Premium</b>: {v.prices.elevenlabs.perMinute}</span>}
        </span>
        <span className="ld-k">This month</span>
        <UsageTable v={v} />
      </div>
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
    provider === "openai" ? v.openai : provider === "local" ? v.local : (v.elevenlabs ?? []).map((x) => ({ id: x.id, name: x.name, note: [x.gender, x.accent, x.own ? "your own voice" : ""].filter(Boolean).join(", ") }));
  const staff = useStaff();
  // Staff see every provider; a workspace sees Standard (LeadDash voices, or OpenAI before they are set up) and Premium.
  const chips: Provider[] = staff ? (["local", "elevenlabs", "openai"] as Provider[]).filter((p) => p !== "local" || v.hasLocal) : [v.hasLocal ? "local" : "openai", "elevenlabs"];
  const nameOf = (p: Provider) => (staff ? PROVIDER_NAME[p] : CUSTOMER_NAME[p]);
  const defaultName = e.own ? "" : e.voiceName;
  const priceOf = (p: Provider) => short(v.prices[p].perMinute);
  const voiceText = e.voiceId ? `${e.voiceName || e.voiceId} (${nameOf(e.provider)})${priceOf(e.provider) ? ` · ${priceOf(e.provider)}` : ""}` : `No voice yet (${nameOf(e.provider)})`;
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
              {chips.map((p) => (
                <button key={p} type="button" className={`ld-chip ${provider === p ? "on" : ""}`} aria-pressed={provider === p} disabled={p === "elevenlabs" && !v.hasElevenLabs} onClick={() => { setProvider(p); setVoiceId(null); }}>
                  {`${staff ? PROVIDER_NAME[p] : CUSTOMER_NAME[p]}${priceOf(p) ? ` · ${priceOf(p)}` : ""}`}
                </button>
              ))}
              {!v.hasElevenLabs && <span className="ld-small ld-muted">{staff ? "ElevenLabs is not set up on the server." : "Premium voices aren't turned on yet."}</span>}
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
      {staff ? <VoiceProviderCard v={q.data} /> : <CustomerVoicesCard v={q.data} />}
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
