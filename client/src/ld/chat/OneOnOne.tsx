import React from "react";
import { trpc } from "@/lib/trpc";
import { Avatar } from "../ui";
import { SILENT, listen, micErrorText, type Listener } from "../voice";

/**
 * One-on-one meetings in an employee's chat. Press Talk and speak: each finished
 * sentence goes out as a chat message, and the employee's answer is played in
 * their voice. The microphone sends silence while the employee thinks or talks, so
 * they don't hear themselves. End meeting turns the conversation into notes and
 * action items (Simone's Meetings tab, Nora for the tasks) and posts them in the chat.
 * The meeting survives a page reload (it's remembered in this browser).
 */

type Meeting = { sinceId: number; startedAt: number };
type Emp = { id: number; name: string; kind: string; avatar?: string | null };

const keyOf = (orgId: number, empId: number) => `ld-1on1-${orgId}-${empId}`;

function readMeeting(orgId: number, empId: number): Meeting | null {
  try {
    const raw = localStorage.getItem(keyOf(orgId, empId));
    const m = raw ? (JSON.parse(raw) as Meeting) : null;
    // Meetings left open for more than 3 hours are forgotten.
    return m && Date.now() - m.startedAt < 3 * 3600_000 ? m : null;
  } catch {
    return null;
  }
}
function writeMeeting(orgId: number, empId: number, m: Meeting | null) {
  try {
    if (m) localStorage.setItem(keyOf(orgId, empId), JSON.stringify(m));
    else localStorage.removeItem(keyOf(orgId, empId));
  } catch {
    /* storage blocked: the meeting still works until the page closes */
  }
}

function clock(from: number, now: number) {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function useOneOnOne(opts: { orgId: number; emp: Emp; lastId: number | null; sending: boolean; say: (text: string) => void; onEnded: () => void }) {
  const { orgId, emp } = opts;
  const [meeting, setMeeting] = React.useState<Meeting | null>(() => readMeeting(orgId, emp.id));
  const [listening, setListening] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [partial, setPartial] = React.useState("");
  const [talking, setTalking] = React.useState(false);
  const [micError, setMicError] = React.useState<string | null>(null);
  const [voiceError, setVoiceError] = React.useState<string | null>(null);
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const listener = React.useRef<Listener | null>(null);
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const mutedRef = React.useRef(false);
  const waiting = React.useRef<string[]>([]);
  const sayRef = React.useRef(opts.say);
  sayRef.current = opts.say;
  const sendingRef = React.useRef(opts.sending);
  sendingRef.current = opts.sending;
  // The microphone goes quiet while the employee is thinking or talking.
  mutedRef.current = muted || talking || opts.sending;

  const token = trpc.huddle.listenToken.useMutation();
  const end = trpc.chat.endMeeting.useMutation({ onSuccess: () => opts.onEnded() });

  const stopListening = React.useCallback(() => {
    listener.current?.stop();
    listener.current = null;
    setListening(false);
    setPartial("");
  }, []);

  // A different employee's chat: leave this meeting's microphone and pick up theirs.
  React.useEffect(() => {
    setMeeting(readMeeting(orgId, emp.id));
    setMuted(false);
    setTalking(false);
    setMicError(null);
    setVoiceError(null);
    setBlocked(null);
    waiting.current = [];
    return () => {
      stopListening();
      audio.current?.pause();
    };
  }, [orgId, emp.id, stopListening]);

  React.useEffect(() => {
    if (!meeting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [meeting]);

  // Words said while a reply was on its way go out once it lands.
  React.useEffect(() => {
    if (!opts.sending && !talking && waiting.current.length) {
      const text = waiting.current.join(" ");
      waiting.current = [];
      sayRef.current(text);
    }
  }, [opts.sending, talking]);

  function unlockSound() {
    const a = audio.current ?? new Audio();
    audio.current = a;
    a.src = SILENT;
    a.play().then(() => a.pause()).catch(() => null);
  }

  const play = (url: string) => {
    const a = audio.current ?? new Audio();
    audio.current = a;
    setTalking(true);
    const done = () => setTalking(false);
    a.src = url;
    a.onended = done;
    a.onerror = done;
    a.play().catch((err: Error) => {
      if (err?.name === "NotAllowedError") setBlocked(url);
      done();
    });
  };

  /** Starts the meeting (or picks it back up) and opens the microphone. Call from the tap itself. */
  const talk = async () => {
    setMicError(null);
    unlockSound();
    let m = meeting;
    if (!m) {
      m = { sinceId: (opts.lastId ?? 0) + 1, startedAt: Date.now() };
      setMeeting(m);
      writeMeeting(orgId, emp.id, m);
    }
    if (listener.current) return;
    try {
      const t = await token.mutateAsync({ organizationId: orgId });
      listener.current = await listen(
        t.token,
        t.url,
        {
          partial: setPartial,
          final: (text) => {
            if (sendingRef.current) waiting.current.push(text);
            else sayRef.current(text);
          },
          error: (msg) => setMicError(msg),
        },
        () => mutedRef.current
      );
      setListening(true);
    } catch (err) {
      setMicError(micErrorText(err));
    }
  };

  const endMeeting = () => {
    if (!meeting) return;
    stopListening();
    audio.current?.pause();
    setTalking(false);
    const m = meeting;
    setMeeting(null);
    writeMeeting(orgId, emp.id, null);
    end.mutate({ organizationId: orgId, employeeId: emp.id, sinceId: m.sinceId, startedAt: m.startedAt });
  };

  /** The answer to something said in the meeting: play it. */
  const heard = (r: { audioUrl?: string | null; voiceError?: string | null }) => {
    setVoiceError(r.voiceError ?? null);
    if (r.audioUrl) play(r.audioUrl);
  };

  const playBlocked = () => {
    const url = blocked;
    setBlocked(null);
    if (url) play(url);
  };

  return {
    active: !!meeting,
    listening,
    muted,
    setMuted,
    partial,
    talking,
    micError: micError ?? (token.error ? micErrorText(token.error) : null),
    voiceError,
    blocked,
    playBlocked,
    endError: end.error?.message ?? null,
    ending: end.isPending,
    elapsed: meeting ? clock(meeting.startedAt, now) : "",
    talk,
    stopListening,
    endMeeting,
    heard,
    starting: token.isPending,
  };
}

export type OneOnOne = ReturnType<typeof useOneOnOne>;

const Mic = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

/** The green Talk button next to Send. Hidden while the microphone is on. */
export function TalkButton({ o, name }: { o: OneOnOne; name: string }) {
  if (o.listening) return null;
  return (
    <button type="button" className="ld-talk" onClick={() => void o.talk()} disabled={o.starting} title={o.active ? `Keep talking with ${name}` : `Start a one-on-one with ${name}`}>
      <Mic />
      {o.starting ? "Starting" : "Talk"}
    </button>
  );
}

/** The bar above the message box during a one-on-one. */
export function VoiceBar({ o, emp, thinking }: { o: OneOnOne; emp: Emp; thinking: boolean }) {
  if (!o.active && !o.ending && !o.endError) return null;
  if (!o.active) {
    return o.endError ? (
      <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>
        The notes didn't save: {o.endError}
      </span>
    ) : (
      <div className="ld-1on1 ld-small ld-muted" role="status">
        Writing up the notes from your one-on-one...
      </div>
    );
  }
  const status = !o.listening
    ? { head: "Paused", sub: "Press Talk to keep going, or type." }
    : o.talking
      ? { head: `${emp.name} is talking`, sub: "Your microphone waits until they finish." }
      : thinking
        ? { head: `${emp.name} is thinking`, sub: "" }
        : o.muted
          ? { head: "Muted", sub: `${emp.name} can't hear you.` }
          : { head: "Listening", sub: o.partial || `Just talk. ${emp.name} answers when you pause.` };
  return (
    <div className="ld-1on1" role="region" aria-label={`One-on-one with ${emp.name}`}>
      <div className="ld-1on1-row">
        <Avatar name={emp.name} kind={emp.kind} src={emp.avatar ?? null} size={32} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span style={{ fontWeight: 800, fontSize: 14 }}>
            {status.head} <span className="ld-muted" style={{ fontWeight: 600 }}>· One-on-one {o.elapsed}</span>
          </span>
          {status.sub && (
            <span className={`ld-small ${o.partial && o.listening && !o.muted ? "" : "ld-muted"}`} aria-live="polite" style={{ overflowWrap: "anywhere" }}>
              {status.sub}
            </span>
          )}
        </div>
        {o.listening && o.active && !o.talking && !thinking && !o.muted && (
          <span className="ld-1on1-wave" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <div className="ld-1on1-btns">
          {o.listening && (
            <button type="button" className="ld-btn sm" onClick={() => o.setMuted(!o.muted)} aria-pressed={o.muted}>
              {o.muted ? "Unmute" : "Mute"}
            </button>
          )}
          <button type="button" className="ld-btn ld-1on1-end" onClick={o.endMeeting}>
            End meeting
          </button>
        </div>
      </div>
      {o.blocked && (
        <div className="ld-1on1-row" style={{ paddingTop: 0 }}>
          <span className="ld-small" style={{ flex: 1 }}>Your browser blocked the sound.</span>
          <button type="button" className="ld-btn sm p" onClick={o.playBlocked}>
            Play
          </button>
        </div>
      )}
      {o.micError && (
        <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)", padding: "0 12px 10px" }}>
          {o.micError}
        </span>
      )}
      {o.voiceError && !o.micError && (
        <span className="ld-small" role="alert" style={{ color: "#8a4510", padding: "0 12px 10px" }}>
          You'll see {emp.name}'s answers but won't hear them: {o.voiceError}
        </span>
      )}
    </div>
  );
}

/** "Spoken" under a person's line, "Said out loud" under an employee's. */
export function SpokenTag({ role }: { role: string }) {
  return <span className="ld-spoken">{role === "user" ? "Spoken" : "Said out loud"}</span>;
}
