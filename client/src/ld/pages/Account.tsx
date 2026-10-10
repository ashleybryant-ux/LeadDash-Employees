import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorLine, Page, PersonAvatar } from "../ui";
import { fmtDate, fmtTime } from "../meta";
import { useTenant } from "@/contexts/TenantContext";
import { currentSubscription, needsHomeScreen, pushSupported, subscribe, unsubscribeHere } from "../push";
import { playSound, type SoundKind } from "../sounds";
import { applyTheme, useTheme, type Theme } from "../theme";

type Prefs = Record<string, { push: boolean; email: boolean; sound: boolean }>;
type Sound = { kind: SoundKind; volume: number };
const SOUND_LABEL: Record<SoundKind, string> = { chime: "Chime", knock: "Soft knock", bell: "Bell" };

/** My account: name, push notifications on this device, and what to be told about. */
export default function Account() {
  const account = trpc.account.get.useQuery();
  const { logout } = useAuth();
  const { chatOnly } = useTenant();
  const a = account.data;
  return (
    <Page rail="account" maxWidth={900}>
      <h1 className="ld-h1">My account</h1>
      {!a ? (
        <div className="ld-empty">{account.isLoading ? "Loading..." : "Could not load your account."}</div>
      ) : (
        <>
          <YouCard name={a.name ?? ""} email={a.email} photo={a.avatarUrl} />
          {a.staff && (
            <section className="ld-card ld-between" style={{ padding: "14px 18px" }}>
              <span className="ld-strong">Base instructions</span>
              <Link href="/base" className="ld-btn" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>Open</Link>
            </section>
          )}
          {a.staff && <ReviewCard />}
          <AppearanceCard />
          <PushCard pushReady={a.pushReady} vapid={a.vapidPublicKey} devices={a.devices} />
          {!chatOnly && <ConnectorCard />}
          <PrefsCard prefs={a.prefs as Prefs} sound={a.sound as Sound} events={chatOnly ? a.events.filter((e) => e.key === "team_message") : a.events} />
          <section className="ld-card ld-between" style={{ padding: "14px 18px" }}>
            <span className="ld-strong">Sign out of this device</span>
            <button type="button" className="ld-btn" onClick={() => logout()}>Sign out</button>
          </section>
        </>
      )}
      <ErrorLine error={account.error} />
    </Page>
  );
}

const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Match my device" };

/** Appearance: light, dark, or match the device. Saved on the account so every device follows it. */
function AppearanceCard() {
  const utils = trpc.useUtils();
  const theme = useTheme();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Theme>(theme);
  const save = trpc.auth.setTheme.useMutation({
    onSuccess: async (r) => {
      applyTheme(r.theme);
      setEditing(false);
      await utils.auth.me.invalidate();
    },
  });
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-between" style={{ padding: "14px 18px" }}>
        <span>
          <span className="ld-strong">Appearance</span>
          {!editing && <span className="ld-small ld-muted" style={{ display: "block" }}>{THEME_LABEL[theme]}</span>}
        </span>
        {!editing && <button type="button" className="ld-btn sm" onClick={() => { setDraft(theme); setEditing(true); }}>Edit</button>}
      </div>
      {editing && (
        <div style={{ padding: "0 18px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="ld-row" role="radiogroup" aria-label="Appearance" style={{ flexWrap: "wrap" }}>
            {(["light", "dark", "system"] as Theme[]).map((t) => (
              <label key={t} className="ld-row ld-small" style={{ gap: 6 }}>
                <input type="radio" name="theme" checked={draft === t} onChange={() => { setDraft(t); applyTheme(t); }} />
                {THEME_LABEL[t]}
              </label>
            ))}
          </div>
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { applyTheme(theme); setEditing(false); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ theme: draft })}>Save</button>
          </span>
          <ErrorLine error={save.error} />
        </div>
      )}
    </section>
  );
}

function YouCard({ name, email, photo }: { name: string; email: string; photo: string | null }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const refresh = () => Promise.all([utils.account.get.invalidate(), utils.auth.me.invalidate(), utils.members.invalidate()]);
  const save = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });
  const upload = trpc.auth.uploadPhoto.useMutation({ onSuccess: refresh });
  const remove = trpc.auth.removePhoto.useMutation({ onSuccess: refresh });
  const onFile = (file?: File) => {
    setFileError(null);
    if (!file) return;
    if (file.size > 8_000_000) return setFileError("Photos must be under 8 MB.");
    const r = new FileReader();
    r.onload = () => upload.mutate({ data: String(r.result) });
    r.readAsDataURL(file);
  };
  const shown = name || email;
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">You</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setEditing(false); setDraft(name); setFileError(null); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending || !draft.trim()} onClick={() => save.mutate({ name: draft.trim() })}>Save</button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={() => { setDraft(name); setEditing(true); }}>Edit</button>
        )}
      </div>
      <div className="ld-kv">
        <span className="ld-k">Photo</span>
        <span className="ld-row" style={{ gap: 12, flexWrap: "wrap" }}>
          <PersonAvatar name={shown} src={photo} size={56} />
          {editing && (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
              <button type="button" className="ld-btn sm" style={{ width: 120 }} disabled={upload.isPending} onClick={() => fileRef.current?.click()}>{upload.isPending ? "Uploading..." : photo ? "Change photo" : "Upload photo"}</button>
              {photo && <button type="button" className="ld-btn sm" style={{ width: 120 }} disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>}
            </>
          )}
          {!editing && !photo && <span style={{ color: "var(--ld-soft2)" }}>Not set. Your initials show until you add one.</span>}
        </span>
        <span className="ld-k">Name</span>
        {editing ? (
          <input className="ld-in" style={{ maxWidth: 320 }} value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} aria-label="Name" />
        ) : (
          <span style={{ color: name ? undefined : "var(--ld-soft2)" }}>{name || "Not set. Your employees see your email until you add it."}</span>
        )}
        <span className="ld-k">Email</span>
        <span style={{ overflowWrap: "anywhere" }}>{email}</span>
      </div>
      <div style={{ padding: "0 18px 12px" }}>
        <ErrorLine error={save.error ?? upload.error ?? remove.error} />
        {fileError && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{fileError}</span>}
      </div>
    </section>
  );
}

function PushCard({ pushReady, vapid, devices }: { pushReady: boolean; vapid: string | null; devices: { id: number; device: string; endpoint: string; createdAt: Date; lastSentAt: Date | null }[] }) {
  const utils = trpc.useUtils();
  const [here, setHere] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tested, setTested] = React.useState(false);
  const sub = trpc.account.subscribe.useMutation();
  const remove = trpc.account.removeDevice.useMutation();
  const test = trpc.account.testPush.useMutation({ onSuccess: () => setTested(true) });
  React.useEffect(() => {
    currentSubscription().then((s) => setHere(s?.endpoint ?? null)).catch(() => setHere(null));
  }, []);
  const hereRow = devices.find((d) => d.endpoint === here);
  const supported = pushSupported();

  const turnOn = async () => {
    setError(null);
    setBusy(true);
    try {
      if (!vapid) throw new Error("Push is not set up on the server yet.");
      const s = await subscribe(vapid);
      await sub.mutateAsync(s);
      setHere(s.endpoint);
      await utils.account.get.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn on push.");
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (id: number, endpoint: string) => {
    setError(null);
    setBusy(true);
    try {
      if (endpoint === here) await unsubscribeHere();
      await remove.mutateAsync({ id });
      if (endpoint === here) setHere(null);
      await utils.account.get.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn off push.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ld-card">
      <div className="ld-sh">
        <span className="ld-st">Push notifications</span>
        {!hereRow && pushReady && supported && (
          <button type="button" className="ld-btn p" disabled={busy} onClick={turnOn}>{busy ? "Turning on..." : "Turn on here"}</button>
        )}
      </div>
      <div style={{ padding: "6px 18px 12px 18px" }}>
        {!pushReady && <div className="ld-body ld-muted" style={{ padding: "8px 0" }}>Push is not set up on the server yet.</div>}
        {pushReady && !supported && <div className="ld-body ld-muted" style={{ padding: "8px 0" }}>This browser cannot get push notifications.</div>}
        {devices.length === 0 && pushReady && <div className="ld-body ld-muted" style={{ padding: "8px 0" }}>No devices yet.</div>}
        {devices.map((d) => {
          const isHere = d.endpoint === here;
          return (
            <div key={d.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 90px 128px 128px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eef2f0", fontSize: 14 }} className="ld-devrow">
              <span>
                <b>{d.device}</b>
                {isHere ? " · This device" : ""} · Added {fmtDate(d.createdAt)}
              </span>
              <span className="ld-pill green">On</span>
              {isHere ? (
                <button type="button" className="ld-btn" disabled={test.isPending} onClick={() => test.mutate()}>{tested ? "Sent" : "Send test"}</button>
              ) : (
                <span />
              )}
              <button type="button" className="ld-btn" disabled={busy} onClick={() => turnOff(d.id, d.endpoint)}>Turn off</button>
            </div>
          );
        })}
        {error && <p role="alert" className="ld-small" style={{ color: "var(--ld-bad)", margin: "8px 0 0" }}>{error}</p>}
        <ErrorLine error={test.error} />
      </div>
      {needsHomeScreen() && (
        <div className="ld-small ld-muted" style={{ padding: "0 18px 14px 18px", lineHeight: 1.5 }}>
          On iPhone, add the app to your Home Screen first (Share, then Add to Home Screen), then open it from there and turn on push.
        </div>
      )}
    </section>
  );
}

function PrefsCard({ prefs, sound, events }: { prefs: Prefs; sound: Sound; events: { key: string; label: string }[] }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Prefs>(prefs);
  const [snd, setSnd] = React.useState<Sound>(sound);
  const save = trpc.account.savePrefs.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await utils.account.get.invalidate();
    },
  });
  const cell = (on: boolean) => <span style={{ fontWeight: 700, color: on ? "var(--ld-accent-dark)" : "var(--ld-muted)" }}>{on ? "On" : "Off"}</span>;
  const COLS = "minmax(0,1fr) 64px 64px 64px";
  const open = () => {
    setDraft(prefs);
    setSnd(sound);
    setEditing(true);
  };
  const box = (label: string, on: boolean, set: (v: boolean) => void) => <input type="checkbox" checked={on} aria-label={label} onChange={(ev) => set(ev.target.checked)} style={{ width: 20, height: 20, accentColor: "var(--ld-accent)" }} />;
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">Tell me when</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ ...(draft as never as object), sound: snd } as never)}>Save</button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={open}>Edit</button>
        )}
      </div>
      <div style={{ padding: "6px 18px 14px 18px" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "8px 0", borderBottom: "1px solid #eef2f0" }} className="ld-lbl ld-keep">
          <span />
          <span>Push</span>
          <span>Email</span>
          <span>Sound</span>
        </div>
        {events.map((e) => {
          const v = (editing ? draft : prefs)[e.key] ?? { push: false, email: false, sound: false };
          const set = (k: "push" | "email" | "sound") => (on: boolean) => setDraft((d) => ({ ...d, [e.key]: { ...v, [k]: on } }));
          return (
            <div key={e.key} className="ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "10px 0", borderBottom: "1px solid #eef2f0", fontSize: 14, alignItems: "center" }}>
              <span>{e.label}</span>
              {editing ? (
                <>
                  {box(`${e.label}: push`, v.push, set("push"))}
                  {box(`${e.label}: email`, v.email, set("email"))}
                  {box(`${e.label}: sound`, v.sound, set("sound"))}
                </>
              ) : (
                <>
                  {cell(v.push)}
                  {cell(v.email)}
                  {cell(v.sound)}
                </>
              )}
            </div>
          );
        })}
        {editing ? (
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", gap: "10px 14px", alignItems: "center", fontSize: 14, paddingTop: 12 }}>
            <b>Sound</b>
            <span className="ld-seg" role="radiogroup" aria-label="Sound" style={{ justifySelf: "start" }}>
              {(Object.keys(SOUND_LABEL) as SoundKind[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={snd.kind === k} className={snd.kind === k ? "on" : ""} onClick={() => { setSnd((x) => ({ ...x, kind: k })); playSound(k, snd.volume); }}>
                  {SOUND_LABEL[k]}
                </button>
              ))}
            </span>
            <b>Volume</b>
            <span className="ld-row" style={{ gap: 10 }}>
              <input type="range" min={0} max={100} step={5} value={snd.volume} aria-label="Volume" onChange={(ev) => setSnd((x) => ({ ...x, volume: Number(ev.target.value) }))} style={{ width: 180, accentColor: "var(--ld-accent)" }} />
              <button type="button" className="ld-btn sm" onClick={() => playSound(snd.kind, snd.volume)}>Play</button>
            </span>
          </div>
        ) : (
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", gap: 14, fontSize: 14, paddingTop: 12 }}>
            <b>Sound</b>
            <span>{SOUND_LABEL[sound.kind]}, {sound.volume}% volume</span>
          </div>
        )}
        <p className="ld-small ld-muted" style={{ margin: "8px 0 0" }}>Sounds play on this device while the app is open.</p>
        <ErrorLine error={save.error} />
      </div>
    </section>
  );
}

/** "11/30/2026" to "Nov 30, 2026". */
function showEnds(mmddyyyy: string | null) {
  if (!mmddyyyy) return "No end date";
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mmddyyyy);
  return m ? fmtDate(new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))) : mmddyyyy;
}

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** LeadDash staff only: the sign-in Google and Meta reviewers use. */
function ReviewCard() {
  const utils = trpc.useUtils();
  const q = trpc.review.get.useQuery();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({ enabled: true, email: "", endsOn: "" });
  const [copied, setCopied] = React.useState(false);
  const save = trpc.review.save.useMutation({
    onSuccess: async (v) => {
      utils.review.get.setData(undefined, v);
      setEditing(false);
    },
  });
  const newCode = trpc.review.newCode.useMutation({ onSuccess: (v) => utils.review.get.setData(undefined, v) });
  const r = q.data;
  if (!r) return q.error ? <ErrorLine error={q.error} /> : null;

  const open = () => {
    save.reset();
    setDraft({ enabled: r.enabled || !r.code, email: r.email, endsOn: r.endsOn ?? "" });
    setEditing(true);
  };
  const copySteps = async () => {
    if (!r.code) return;
    const text = [
      `Sign in at ${window.location.origin}`,
      `1. Enter ${r.email} and press Send code.`,
      `2. Type the code ${r.code} and press Sign in. No email is needed.`,
      `The account opens a sample workspace. Every person and number in it is made up.`,
      r.endsOn ? `Access ends ${showEnds(r.endsOn)}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy these steps:", text);
    }
  };

  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          App review access
          {!editing && <span className={`ld-pill ${r.active ? "green" : "gray"}`}>{r.active ? "On" : "Off"}</span>}
        </span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
            <button
              type="button"
              className="ld-btn p"
              disabled={save.isPending || !draft.email.trim()}
              onClick={() => save.mutate({ enabled: draft.enabled, email: draft.email.trim(), endsOn: draft.endsOn.trim() || null })}
            >
              {save.isPending ? "Saving..." : "Save"}
            </button>
          </span>
        ) : (
          <span className="ld-row">
            <button type="button" className="ld-btn" disabled={!r.active} onClick={copySteps}>{copied ? "Copied" : "Copy steps"}</button>
            <button type="button" className="ld-btn" onClick={open}>Edit</button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="ld-kv" style={{ alignItems: "center" }}>
          <span className="ld-k">Access</span>
          <span className="ld-row">
            <button type="button" className={`ld-chip ${draft.enabled ? "on" : ""}`} aria-pressed={draft.enabled} onClick={() => setDraft((d) => ({ ...d, enabled: true }))}>On</button>
            <button type="button" className={`ld-chip ${!draft.enabled ? "on" : ""}`} aria-pressed={!draft.enabled} onClick={() => setDraft((d) => ({ ...d, enabled: false }))}>Off</button>
          </span>
          <label className="ld-k" htmlFor="rv-email">Email</label>
          <input id="rv-email" className="ld-in" style={{ maxWidth: 320 }} type="email" value={draft.email} maxLength={320} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
          <span className="ld-k">Code</span>
          <span className="ld-row" style={{ gap: 12 }}>
            <span style={r.code ? { fontWeight: 800, letterSpacing: "0.18em", fontSize: 16 } : { color: "var(--ld-soft2)" }}>{r.code ? spaced(r.code) : "Made when you save"}</span>
            {r.code && (
              <button
                type="button"
                className="ld-btn"
                disabled={newCode.isPending}
                onClick={() => {
                  if (window.confirm("Make a new code? The old one stops working and the reviewer is signed out.")) newCode.mutate();
                }}
              >
                New code
              </button>
            )}
          </span>
          <label className="ld-k" htmlFor="rv-ends">Ends</label>
          <input id="rv-ends" className="ld-in" style={{ maxWidth: 160 }} type="text" inputMode="numeric" placeholder="MM/DD/YYYY" maxLength={10} value={draft.endsOn} onChange={(e) => setDraft((d) => ({ ...d, endsOn: e.target.value }))} />
        </div>
      ) : (
        <div className="ld-kv">
          <span className="ld-k">Email</span>
          <span style={{ overflowWrap: "anywhere" }}>{r.email}</span>
          <span className="ld-k">Code</span>
          <span style={r.code ? { fontWeight: 800, letterSpacing: "0.18em", fontSize: 16 } : { color: "var(--ld-soft2)" }}>{r.code ? spaced(r.code) : "Made when you turn it on"}</span>
          <span className="ld-k">Opens</span>
          <span>{r.opens}</span>
          <span className="ld-k">Ends</span>
          <span>{showEnds(r.endsOn)}</span>
          <span className="ld-k">Last sign-in</span>
          <span>{r.lastSignInAt ? `${fmtDate(r.lastSignInAt)} at ${fmtTime(r.lastSignInAt)}` : "Never"}</span>
        </div>
      )}
      <div style={{ padding: "0 18px 12px" }}>
        <ErrorLine error={save.error ?? newCode.error} />
      </div>
    </section>
  );
}

/** The link that connects Claude and ChatGPT to this workspace. */
function ConnectorCard() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.account.connector.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const fresh = trpc.account.newConnector.useMutation({ onSuccess: (r) => utils.account.connector.setData({ organizationId: currentOrgId }, r) });
  const [copied, setCopied] = React.useState(false);
  const c = q.data;
  const shown = c ? c.url.replace(/[^/]+$/, `${"•".repeat(12)}${c.last4}`) : "";
  const copy = () => {
    if (!c) return;
    void navigator.clipboard?.writeText(c.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <section className="ld-card ld-av-set">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <span className="ld-lbl">Connect Claude and ChatGPT</span>
        {!c ? (
          <span className="ld-small ld-muted">{q.isLoading ? "Loading..." : "Couldn't load your connector link."}</span>
        ) : (
          <div className="ld-av-kv">
            <span className="ld-strong">Connector link</span>
            <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, overflowWrap: "anywhere" }}>{shown}</span>
            <span className="ld-strong">Claude</span>
            <span>Customize, Connectors, Add custom connector. Paste the link.</span>
            <span className="ld-strong">ChatGPT</span>
            <span>Settings, Security and login, turn on Developer mode. Then Apps, Create, paste the link.</span>
            <span className="ld-strong">Last used</span>
            <span>{c.lastUsedAt ? `${c.lastClient ?? "A connector"}, ${fmtDate(c.lastUsedAt)} at ${fmtTime(c.lastUsedAt)}` : "Not yet"}</span>
          </div>
        )}
        <span className="ld-small ld-muted">Anyone with this link can reach your workspace. Treat it like a password.</span>
        <ErrorLine error={fresh.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={!c} onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        <button type="button" className="ld-btn" disabled={fresh.isPending} onClick={() => fresh.mutate({ organizationId: currentOrgId })}>New link</button>
      </div>
    </section>
  );
}
