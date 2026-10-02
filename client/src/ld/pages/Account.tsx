import React from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorLine, Page } from "../ui";
import { fmtDate } from "../meta";
import { currentSubscription, needsHomeScreen, pushSupported, subscribe, unsubscribeHere } from "../push";

type Prefs = Record<string, { push: boolean; email: boolean }>;

/** My account: name, push notifications on this device, and what to be told about. */
export default function Account() {
  const account = trpc.account.get.useQuery();
  const { logout } = useAuth();
  const a = account.data;
  return (
    <Page rail="account" maxWidth={900}>
      <h1 className="ld-h1">My account</h1>
      {!a ? (
        <div className="ld-empty">{account.isLoading ? "Loading..." : "Could not load your account."}</div>
      ) : (
        <>
          <YouCard name={a.name ?? ""} email={a.email} />
          <PushCard pushReady={a.pushReady} vapid={a.vapidPublicKey} devices={a.devices} />
          <PrefsCard prefs={a.prefs as Prefs} events={a.events} />
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

function YouCard({ name, email }: { name: string; email: string }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const save = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await Promise.all([utils.account.get.invalidate(), utils.auth.me.invalidate()]);
    },
  });
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">You</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setEditing(false); setDraft(name); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending || !draft.trim()} onClick={() => save.mutate({ name: draft.trim() })}>Save</button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={() => { setDraft(name); setEditing(true); }}>Edit</button>
        )}
      </div>
      <div className="ld-kv">
        <span className="ld-k">Name</span>
        {editing ? (
          <input className="ld-in" style={{ maxWidth: 320 }} value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} aria-label="Name" autoFocus />
        ) : (
          <span style={{ color: name ? undefined : "#8a9a93" }}>{name || "Not set. Your employees see your email until you add it."}</span>
        )}
        <span className="ld-k">Email</span>
        <span style={{ overflowWrap: "anywhere" }}>{email}</span>
      </div>
      <div style={{ padding: "0 18px 12px" }}>
        <ErrorLine error={save.error} />
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
        {error && <p role="alert" className="ld-small" style={{ color: "#b42318", margin: "8px 0 0" }}>{error}</p>}
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

function PrefsCard({ prefs, events }: { prefs: Prefs; events: { key: string; label: string }[] }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Prefs>(prefs);
  const save = trpc.account.savePrefs.useMutation({
    onSuccess: async () => {
      setEditing(false);
      await utils.account.get.invalidate();
    },
  });
  const cell = (on: boolean) => <span style={{ fontWeight: 700, color: on ? "#155c3e" : "#5b6b64" }}>{on ? "On" : "Off"}</span>;
  const COLS = "minmax(0,1fr) 64px 64px";
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div className="ld-sh">
        <span className="ld-st">Tell me when</span>
        {editing ? (
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setEditing(false); setDraft(prefs); }}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate(draft as never)}>Save</button>
          </span>
        ) : (
          <button type="button" className="ld-btn sm" onClick={() => { setDraft(prefs); setEditing(true); }}>Edit</button>
        )}
      </div>
      <div style={{ padding: "6px 18px 12px 18px" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "8px 0", borderBottom: "1px solid #eef2f0" }} className="ld-lbl ld-keep">
          <span />
          <span>Push</span>
          <span>Email</span>
        </div>
        {events.map((e) => {
          const v = (editing ? draft : prefs)[e.key] ?? { push: false, email: false };
          return (
            <div key={e.key} className="ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "10px 0", borderBottom: "1px solid #eef2f0", fontSize: 14, alignItems: "center" }}>
              <span>{e.label}</span>
              {editing ? (
                <>
                  <input type="checkbox" checked={v.push} aria-label={`${e.label}: push`} onChange={(ev) => setDraft((d) => ({ ...d, [e.key]: { ...v, push: ev.target.checked } }))} style={{ width: 20, height: 20 }} />
                  <input type="checkbox" checked={v.email} aria-label={`${e.label}: email`} onChange={(ev) => setDraft((d) => ({ ...d, [e.key]: { ...v, email: ev.target.checked } }))} style={{ width: 20, height: 20 }} />
                </>
              ) : (
                <>
                  {cell(v.push)}
                  {cell(v.email)}
                </>
              )}
            </div>
          );
        })}
        <ErrorLine error={save.error} />
      </div>
    </section>
  );
}
