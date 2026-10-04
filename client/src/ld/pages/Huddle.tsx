import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, BottomNav, ErrorLine, Rail, useEmployees } from "../ui";
import { SILENT, listen, micErrorText, type Listener } from "../voice";

/**
 * Team huddle: you talk, the employees answer out loud in their own voices.
 * The microphone streams to AssemblyAI for live transcription (with a token the
 * server makes, so no key reaches the browser); each finished sentence goes to the
 * server, which picks who answers and returns their words and voice. The team can
 * also join a Zoom or Meet. Ending the huddle sends the transcript to Simone for
 * notes and action items.
 */

type Line = { who: string; kind: string | null; text: string; at: number };
type Reply = { kind: string; name: string; text: string; audioUrl: string | null };

// ==========================================
// The page
// ==========================================

function elapsed(from: Date | string, now: number) {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Huddle() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const { list: employees } = useEmployees();
  const active = employees.filter((e) => e.status !== "paused");
  const q = trpc.huddle.current.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (r) => (r.state.data?.live ? 2500 : false) });
  const live = q.data?.live ?? null;

  const [picked, setPicked] = React.useState<string[] | null>(null);
  const [partial, setPartial] = React.useState("");
  const [speaking, setSpeaking] = React.useState<string | null>(null);
  const [listening, setListening] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [micError, setMicError] = React.useState<string | null>(null);
  const [voiceError, setVoiceError] = React.useState<string | null>(null);
  const [blocked, setBlocked] = React.useState<Reply | null>(null);
  const [link, setLink] = React.useState("");
  const [whoOpen, setWhoOpen] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const listener = React.useRef<Listener | null>(null);
  const queue = React.useRef<Reply[]>([]);
  const playing = React.useRef(false);
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const mutedRef = React.useRef(false);
  const huddleId = React.useRef<number | null>(null);
  const bottom = React.useRef<HTMLDivElement>(null);
  huddleId.current = live?.id ?? null;
  mutedRef.current = muted || speaking !== null;

  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  React.useEffect(() => () => listener.current?.stop(), []);
  React.useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [live?.lines.length, partial]);

  const refresh = () => utils.huddle.current.invalidate();
  const start = trpc.huddle.start.useMutation({ onSuccess: refresh });
  const members = trpc.huddle.members.useMutation({ onSuccess: refresh });
  const token = trpc.huddle.listenToken.useMutation();
  const bring = trpc.huddle.bring.useMutation({ onSuccess: () => { setLink(""); refresh(); } });
  const takeOut = trpc.huddle.takeOut.useMutation({ onSuccess: refresh });
  const end = trpc.huddle.end.useMutation({
    onSuccess: () => {
      listener.current?.stop();
      listener.current = null;
      setListening(false);
      refresh();
      utils.coo.invalidate();
    },
  });

  const playNext = React.useCallback(() => {
    if (playing.current) return;
    const r = queue.current.shift();
    if (!r) {
      setSpeaking(null);
      return;
    }
    playing.current = true;
    setSpeaking(r.kind);
    const done = () => {
      playing.current = false;
      playNext();
    };
    if (!r.audioUrl) {
      setTimeout(done, Math.min(9000, 1500 + r.text.length * 55));
      return;
    }
    const a = audio.current ?? new Audio();
    audio.current = a;
    a.src = r.audioUrl;
    a.onended = done;
    a.onerror = done;
    a.play().catch((err: Error) => {
      // The browser blocked sound: offer a button to play it.
      if (err?.name === "NotAllowedError") setBlocked(r);
      done();
    });
  }, []);

  const say = trpc.huddle.say.useMutation({
    onSuccess: (r) => {
      utils.huddle.current.setData({ organizationId: currentOrgId }, (old) => (old ? { ...old, live: r.huddle } : old));
      setVoiceError(r.voiceError ?? null);
      queue.current.push(...r.replies);
      playNext();
    },
  });
  const sayRef = React.useRef(say.mutate);
  sayRef.current = say.mutate;

  const startListening = async () => {
    setMicError(null);
    if (!huddleId.current) return;
    // Unlock sound now, during the tap, before anything waits.
    unlockSound();
    try {
      const t = await token.mutateAsync({ organizationId: currentOrgId });
      listener.current = await listen(
        t.token,
        t.url,
        {
          partial: setPartial,
          final: (text) => {
            if (huddleId.current) sayRef.current({ organizationId: currentOrgId, id: huddleId.current, text });
          },
          error: (m) => setMicError(m),
        },
        () => mutedRef.current
      );
      setListening(true);
    } catch (err) {
      setMicError(micErrorText(err, "press Start talking again"));
    }
  };
  function unlockSound() {
    const a = audio.current ?? new Audio();
    audio.current = a;
    a.src = SILENT;
    a.play().then(() => a.pause()).catch(() => null);
  }
  const playBlocked = () => {
    const r = blocked;
    setBlocked(null);
    unlockSound();
    if (r) {
      queue.current.unshift(r);
      setTimeout(playNext, 150);
    }
  };
  const stopListening = () => {
    listener.current?.stop();
    listener.current = null;
    setListening(false);
    setPartial("");
  };

  const inKinds = live?.kinds ?? picked ?? active.map((e) => e.kind);
  const inHuddle = active.filter((e) => inKinds.includes(e.kind));
  const toggle = (kind: string) => {
    const next = inKinds.includes(kind) ? inKinds.filter((k) => k !== kind) : [...inKinds, kind];
    if (!next.length) return;
    if (live) members.mutate({ organizationId: currentOrgId, id: live.id, kinds: next });
    else setPicked(next);
  };
  const thinking = say.isPending;
  const last = q.data?.last ?? null;

  const whoPicker = (
    <div className="ld-card" style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
      {active.map((e) => (
        <button key={e.kind} type="button" className={`ld-chip ${inKinds.includes(e.kind) ? "on" : ""}`} aria-pressed={inKinds.includes(e.kind)} onClick={() => toggle(e.kind)}>
          {e.name}
        </button>
      ))}
    </div>
  );

  return (
    <div className="ld">
      <Rail active="huddle" />
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: "100vh", background: "#f8fafb" }}>
        <header className="ld-hud-head">
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontWeight: 800, fontSize: 18 }}>Team huddle</h1>
            {live && <span className="ld-pill green">{`${live.inMeeting ? "In your meeting" : "Live"} · ${elapsed(live.createdAt, now)}`}</span>}
          </div>
          {live &&
            (live.inMeeting ? (
              <button type="button" className="ld-btn" disabled={takeOut.isPending} onClick={() => takeOut.mutate({ organizationId: currentOrgId, id: live.id })}>
                Take them out
              </button>
            ) : (
              <form
                style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (link.trim()) bring.mutate({ organizationId: currentOrgId, id: live.id, url: link.trim() });
                }}
              >
                <label htmlFor="hud-link" className="ld-sr">Zoom or Meet link</label>
                <input id="hud-link" className="ld-in" style={{ width: 300, height: 36 }} placeholder="Paste a Zoom or Google Meet link" value={link} onChange={(e) => setLink(e.target.value)} />
                <button type="submit" className="ld-btn" disabled={bring.isPending || !link.trim()}>
                  {bring.isPending ? "Sending..." : "Bring the team"}
                </button>
              </form>
            ))}
        </header>

        {!live ? (
          <main style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 960 }}>
            {last && last.meetingId && (
              <div className="ld-card" style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="ld-lbl">Last huddle</span>
                  <span style={{ fontWeight: 800 }}>{`${last.lines.length} lines · notes and action items went to Simone and Nora`}</span>
                </div>
                <Link href="/chats/coo/work" className="ld-btn p">Open notes</Link>
              </div>
            )}
            <div className="ld-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              <span style={{ fontWeight: 800, fontSize: 16 }}>Talk with your team out loud</span>
              <span style={{ fontSize: 14, lineHeight: 1.6, color: "#3d4c45" }}>Say a name to ask someone directly, or ask the whole team. Each employee answers from their own work, in their own voice. When you end, Simone writes the notes and Nora tracks the action items.</span>
              <span className="ld-lbl">Who's in</span>
              {whoPicker}
              <div>
                <button type="button" className="ld-btn p" style={{ width: "auto", padding: "0 20px" }} disabled={start.isPending || !inHuddle.length} onClick={() => start.mutate({ organizationId: currentOrgId, kinds: inKinds })}>
                  {start.isPending ? "Starting..." : "Start the huddle"}
                </button>
              </div>
              <ErrorLine error={start.error} />
            </div>
          </main>
        ) : (
          <div className="ld-hud">
            <div style={{ padding: "22px 28px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="ld-lbl">{`In the huddle (${inHuddle.length})`}</span>
                <button type="button" className="ld-btn" aria-expanded={whoOpen} onClick={() => setWhoOpen(!whoOpen)}>Who's in</button>
              </div>
              {whoOpen && whoPicker}
              <div className="ld-hud-tiles">
                {inHuddle.map((e) => {
                  const on = speaking === e.kind;
                  return (
                    <div key={e.kind} className={`ld-hud-tile ${on ? "on" : ""}`}>
                      <Avatar name={e.name} kind={e.kind} src={e.avatar} size={84} />
                      <span style={{ fontWeight: 800, fontSize: 15 }}>{e.name}</span>
                      <span className="ld-small ld-muted ld-hud-role" style={{ marginTop: -6 }}>{e.roleTitle}</span>
                      {on ? (
                        <span className="ld-bars" aria-label="Speaking"><span /><span /><span /><span /><span /></span>
                      ) : (
                        <span className="ld-small ld-muted">{thinking ? "Thinking" : "Listening"}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="ld-card" style={{ padding: "12px 16px", display: "flex", gap: 10, alignItems: "center" }}>
                <span className={`ld-pill ${listening && !muted ? "green" : "gray"}`}>You</span>
                <span style={{ fontSize: 14, color: "#3d4c45", minWidth: 0 }}>{partial || (live.inMeeting ? "The team is in your meeting and answers there. Talk in the meeting." : listening ? (muted ? "You're muted." : "Talk normally. Say a name to ask someone directly.") : "Press Start talking and allow the microphone.")}</span>
              </div>
              {micError && <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>{micError}</p>}
              {voiceError && <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>{`The answer showed but had no voice. ${voiceError}`}</p>}
              {blocked && (
                <div className="ld-card" style={{ padding: "12px 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, flex: 1, minWidth: 0 }}>{`Your browser blocked ${blocked.name}'s voice.`}</span>
                  <button type="button" className="ld-btn p" onClick={playBlocked}>Play sound</button>
                </div>
              )}
              <ErrorLine error={say.error || bring.error || takeOut.error || members.error} />
            </div>
            <aside className="ld-hud-side">
              <div style={{ padding: "14px 16px", borderBottom: "1px solid #e3e9e6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 800 }}>Transcript</span>
                <span className="ld-small ld-muted">Saved when you end</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", minHeight: 200 }}>
                {live.lines.length === 0 && <div className="ld-small ld-muted" style={{ padding: 16 }}>Nothing said yet.</div>}
                {live.lines.map((l: Line, i: number) => (
                  <div key={i} style={{ padding: "10px 16px", borderBottom: "1px solid #f1f4f2", fontSize: 14, lineHeight: 1.5 }}>
                    <b>{l.who}</b>
                    <br />
                    {l.text}
                  </div>
                ))}
                <div ref={bottom} />
              </div>
              <div className="ld-hud-ctl">
                {listening ? (
                  <button type="button" className="ld-hud-mic" onClick={stopListening}>{MIC}Listening</button>
                ) : (
                  <button type="button" className="ld-hud-mic" disabled={live.inMeeting || token.isPending} onClick={startListening}>{MIC}Start talking</button>
                )}
                <button type="button" className="ld-btn" style={{ height: 52, borderRadius: 999, width: "auto", padding: "0 18px" }} disabled={!listening} aria-pressed={muted} onClick={() => setMuted(!muted)}>{muted ? "Unmute" : "Mute"}</button>
                <button type="button" className="ld-hud-end" disabled={end.isPending} onClick={() => end.mutate({ organizationId: currentOrgId, id: live.id })}>{end.isPending ? "Ending..." : "End"}</button>
              </div>
            </aside>
          </div>
        )}
      </section>
      <BottomNav active="huddle" />
    </div>
  );
}

const MIC = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
