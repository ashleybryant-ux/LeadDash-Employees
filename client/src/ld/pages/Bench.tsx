import React from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BottomNav, ErrorLine, FolderTabs, Page, Rail } from "../ui";
import { DictateButton, appendText } from "../Dictate";
import { AVATAR_FILES, DEPARTMENT_ORDER, EHR_GROUP, KIND_META, KIND_ORDER, type Kind } from "../meta";
import type { Outputs } from "../types";
import { BEACH, dayText } from "../bench/Leave";

/**
 * The bench: every employee waits here until the owner brings them on. Each
 * card has Bring on (one click: they join Chats and offer to start
 * onboarding), Interview (they speak first, out loud, and answer questions;
 * each answer uses work hours) and Read bio (a lightbox, free). In a
 * healthcare practice the three who work with LeadDash EHR sit in their own
 * section at the top.
 */

type View = Outputs["bench"]["view"];
type Emp = View["employees"][number];

const MIC = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const PLUS = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
const SHIELD = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z" />
    <path d="M12 9v6M9 12h6" />
  </svg>
);

/** "Avery", "Avery and Nora", "Simone, Nora and Avery". */
const namesText = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

const chatHref = (e: Pick<Emp, "kind" | "id">) => (e.kind === "custom" ? `/chats/e/${e.id}` : `/chats/${e.kind}`);

/** The employee's picture, full size: their portrait, or their initial on their color. */
export function Photo({ e, className }: { e: Pick<Emp, "name" | "kind" | "avatar">; className?: string }) {
  const src = e.avatar || AVATAR_FILES[e.kind as Kind];
  const [broken, setBroken] = React.useState(false);
  if (src && !broken) return <img className={className} src={src} alt={e.name} onError={() => setBroken(true)} />;
  return (
    <span className={`${className ?? ""} ld-bench-ini`} style={{ background: KIND_META[(e.kind as Kind) ?? "custom"]?.color ?? "#3d4c45" }} aria-label={e.name}>
      {e.name.slice(0, 1)}
    </span>
  );
}

function useBench() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const q = trpc.bench.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const bring = trpc.bench.bringOn.useMutation({
    onSuccess: async (r) => {
      await Promise.all([utils.bench.view.invalidate(), utils.employees.list.invalidate(), utils.chat.invalidate()]);
      navigate(r.kind === "custom" ? `/chats/e/${r.id}` : `/chats/${r.kind}`);
    },
  });
  return { q, bring, orgId: currentOrgId };
}

/** Why someone can't come on yet, in the same words as the server. */
function limitText(v: View, e: Emp) {
  if (v.ehrStart) return { title: `${e.name} isn't in your plan yet.`, body: `Your plan includes the three who work with LeadDash EHR. Add the full team to bring on ${e.name} and anyone else on the bench.`, plans: true };
  return { title: `Your first ${v.startLimit ?? 5} are on the team.`, body: `Finish onboarding with ${namesText(v.waitingOn)} first, then bring on one more at a time.`, plans: false };
}

export default function Bench() {
  const params = useParams<{ kind?: string }>();
  if (params.kind) return <InterviewPage kind={params.kind} />;
  return <BenchPage />;
}

function BenchPage() {
  const { currentOrg } = useTenant();
  const { q, bring, orgId } = useBench();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [bio, setBio] = React.useState<string | null>(() => new URLSearchParams(search).get("bio"));
  const [warn, setWarn] = React.useState<Emp | null>(null);
  const [tab, setTab] = React.useState("All");
  const v = q.data;
  const orgType = currentOrg?.orgType ?? "business";
  const order = (a: Emp, b: Emp) => KIND_ORDER.indexOf(a.kind as Kind) - KIND_ORDER.indexOf(b.kind as Kind) || a.id - b.id;
  const benched = (v?.employees ?? []).filter((e) => !e.onTeam && !e.away).sort(order);
  const onVacation = (v?.employees ?? []).filter((e) => e.away?.kind === "vacation").sort((a, b) => (a.away!.until < b.away!.until ? -1 : 1));
  const terminated = (v?.employees ?? []).filter((e) => e.away?.kind === "terminated").sort((a, b) => (a.away!.until < b.away!.until ? -1 : 1));
  const team = (v?.employees ?? []).filter((e) => e.onTeam).sort(order);
  const ehr = benched.filter((e) => v?.ehrKinds.includes(e.kind));
  const rest = benched.filter((e) => !v?.ehrKinds.includes(e.kind));
  const depts = (DEPARTMENT_ORDER[orgType] ?? DEPARTMENT_ORDER.business).filter((d) => rest.some((e) => e.department === d));
  const shown = tab === "All" ? rest : rest.filter((e) => e.department === tab);
  const onBring = (e: Emp) => {
    if (!v) return;
    if (e.away) {
      if (!e.away.canReturn) return;
      bring.mutate({ organizationId: orgId, employeeId: e.id });
      return;
    }
    if (!e.canBringOn) {
      setWarn(e);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    bring.mutate({ organizationId: orgId, employeeId: e.id });
  };
  const card = (e: Emp) => (
    <div key={e.id} className="ld-bench-card">
      <button type="button" className="ld-bench-photo" aria-label={`Read ${e.name}'s bio`} onClick={() => setBio(e.kind)}>
        <Photo e={e} />
      </button>
      <div className="ld-bench-body">
        <b>{e.name}</b>
        <span className="r">{e.roleTitle}</span>
        <span className="l">{e.bio.support[0] ?? ""}</span>
        <button type="button" className="ld-btn p bring" disabled={bring.isPending} onClick={() => onBring(e)}>{PLUS}{`Bring on ${e.name}`}</button>
        <button type="button" className="ld-btn" onClick={() => navigate(`/bench/${e.kind === "custom" ? `e${e.id}` : e.kind}`)}>{MIC}Interview</button>
        <button type="button" className="ld-btn" onClick={() => setBio(e.kind)}>Read bio</button>
      </div>
    </div>
  );
  const open = bio ? v?.employees.find((e) => e.kind === bio || `e${e.id}` === bio) ?? null : null;
  const lim = warn && v ? limitText(v, warn) : null;
  return (
    <Page rail="bench" maxWidth={1240}>
      <div className="ld-between" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <h1 className="ld-h1" style={{ fontSize: 28 }}>The bench</h1>
          <p className="ld-body" style={{ margin: "4px 0 0", color: "var(--ld-text2)" }}>
            {v?.ehrStart ? "Your plan includes the three who work with LeadDash EHR. Interview anyone." : `Interview anyone. Bring on the ones you want.${v?.startLimit ? ` Start with up to ${v.startLimit}.` : ""}`}
          </p>
        </div>
        {v && (
          <Link href="/chats" className="ld-bench-meter">
            <span className="faces">{team.slice(0, 6).map((e) => <Photo key={e.id} e={e} />)}</span>
            <span>
              <b>{v.startLimit ? `${team.length} of ${Math.max(v.startLimit, team.length)}` : team.length}</b>
              <small>{onVacation.length ? `on your team · ${onVacation.length} on vacation` : "on your team"}</small>
            </span>
          </Link>
        )}
      </div>
      {lim && (
        <div className="ld-bench-warn" role="alert">
          <div>
            <b>{lim.title}</b>
            <p>{lim.body}</p>
          </div>
          <div className="ld-row">
            {lim.plans && <Link href="/workspace" className="ld-btn p">See plans</Link>}
            <button type="button" className="ld-btn" onClick={() => setWarn(null)}>{lim.plans ? "Not now" : "OK"}</button>
          </div>
        </div>
      )}
      <ErrorLine error={q.error || bring.error} />
      {v && <span className="ld-bench-hours">Interviews use work hours. Bios are free to read.</span>}
      {onVacation.length > 0 && (
        <section className="ld-bench-vac" style={{ backgroundImage: `linear-gradient(180deg, rgba(3, 28, 46, .78) 0%, rgba(3, 28, 46, .35) 45%, rgba(3, 28, 46, .1) 100%), url(${BEACH})` }}>
          <div>
            <h2><span aria-hidden="true">🏖️</span> On vacation</h2>
            <p>No jobs, no work hours, no spot on the team.</p>
          </div>
          <div className="ld-bench-grid">{onVacation.map((e) => <AwayCard key={e.id} e={e} onBring={() => onBring(e)} onBio={() => setBio(e.kind)} busy={bring.isPending} />)}</div>
        </section>
      )}
      {terminated.length > 0 && (
        <section className="ld-bench-term">
          <div>
            <h2>Terminated</h2>
            <p>{`Stored, not deleted. Rehirable ${v?.terminateDays ?? 90} days after they leave.`}</p>
          </div>
          <div className="ld-bench-grid">{terminated.map((e) => <AwayCard key={e.id} e={e} onBring={() => onBring(e)} onBio={() => setBio(e.kind)} busy={bring.isPending} />)}</div>
        </section>
      )}
      {ehr.length > 0 && (
        <section className="ld-bench-ehr">
          <div className="ld-bench-ehrhead">
            <span className="ld-bench-badge">{SHIELD}LeadDash EHR</span>
            <div>
              <h2>{EHR_GROUP}</h2>
              <p>They read your claims, team and leads from LeadDash EHR.</p>
            </div>
          </div>
          <div className="ld-bench-grid">{ehr.map(card)}</div>
        </section>
      )}
      {rest.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ehr.length > 0 && <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>The rest of the bench</h2>}
          <FolderTabs tabs={["All", ...depts].map((d) => ({ key: d, label: d }))} value={depts.includes(tab) ? tab : "All"} onChange={setTab}>
            <div className="ld-bench-grid" style={{ padding: 16 }}>{shown.map(card)}</div>
          </FolderTabs>
        </section>
      )}
      {v && benched.length === 0 && onVacation.length === 0 && terminated.length === 0 && <div className="ld-empty">Everyone is on your team.</div>}
      {!v && q.isLoading && <div className="ld-empty">Loading...</div>}
      {open && <BioBox e={open} onClose={() => setBio(null)} onBring={() => { setBio(null); onBring(open); }} busy={bring.isPending} />}
    </Page>
  );
}

/** A card in On vacation or Terminated: when they can come back, and the button for it. */
function AwayCard({ e, onBring, onBio, busy }: { e: Emp; onBring: () => void; onBio: () => void; busy: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const a = e.away!;
  const [editing, setEditing] = React.useState(false);
  const [date, setDate] = React.useState(a.until);
  const change = trpc.bench.changeReturn.useMutation({ onSuccess: async () => { setEditing(false); await utils.bench.view.invalidate(); } });
  const vac = a.kind === "vacation";
  const earliest = vac ? [a.returnFrom, new Date().toISOString().slice(0, 10)].sort()[1] : a.until;
  const tag = vac ? (a.waiting ? "Back when there's room" : `Back ${dayText(a.until)}`) : a.canReturn ? "Rehirable now" : `Rehirable ${dayText(a.until)}`;
  const line = vac ? `Left ${dayText(a.since)}.${a.canReturn ? " Can come back now." : ""}` : `Terminated ${dayText(a.since)}.${a.reason ? ` ${a.reason}.` : ""}`;
  return (
    <div className={`ld-bench-card ${vac ? "" : "gone"}`}>
      <button type="button" className="ld-bench-photo" aria-label={`Read ${e.name}'s bio`} onClick={onBio}>
        <Photo e={e} />
        <span className={`ld-bench-tag ${vac ? "gold" : "red"}`}>{tag}</span>
      </button>
      <div className="ld-bench-body">
        <b>{e.name}</b>
        <span className="r">{e.roleTitle}</span>
        <span className="l">{line}</span>
        {a.canReturn ? (
          <button type="button" className={`ld-btn ${vac ? "gold" : "p"}`} disabled={busy} onClick={onBring}>{vac ? `Bring ${e.name} back` : `Rehire ${e.name}`}</button>
        ) : (
          <button type="button" className="ld-btn" disabled>{vac ? `Back ${dayText(a.returnFrom)}` : `Rehirable ${dayText(a.until)}`}</button>
        )}
        {vac ? (
          editing ? (
            <div className="ld-bench-date">
              <input type="date" className="ld-in" aria-label="Back on" min={earliest} value={date} onChange={(ev) => setDate(ev.target.value)} />
              <div className="ld-row">
                <button type="button" className="ld-btn p" disabled={change.isPending || date < earliest} onClick={() => change.mutate({ organizationId: currentOrgId, employeeId: e.id, back: date })}>Save</button>
                <button type="button" className="ld-btn" onClick={() => { setEditing(false); setDate(a.until); }}>Cancel</button>
              </div>
              <ErrorLine error={change.error} />
            </div>
          ) : (
            <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Change date</button>
          )
        ) : (
          <button type="button" className="ld-btn" onClick={onBio}>Read bio</button>
        )}
      </div>
    </div>
  );
}

function BioBox({ e, onClose, onBring, busy }: { e: Emp; onClose: () => void; onBring: () => void; busy: boolean }) {
  const [, navigate] = useLocation();
  React.useEffect(() => {
    const key = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="ld-bench-lb" role="dialog" aria-modal="true" aria-label={`${e.name}'s bio`} onClick={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="ld-bench-box">
        <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
        <div className="ph"><Photo e={e} /></div>
        <div className="tx">
          <span className="dept">{e.department}</span>
          <h2>{e.name}</h2>
          <span className="role">{e.roleTitle}</span>
          <p className="bio">{e.bio.pitch.join(" ")}</p>
          {e.bio.support.length > 0 && (
            <>
              <h4>{`What ${e.name} does for you`}</h4>
              <ul>{e.bio.support.map((s) => <li key={s}>{s}</li>)}</ul>
            </>
          )}
          {e.bio.works && (
            <>
              <h4>Works with</h4>
              <p className="works">{e.bio.works}</p>
            </>
          )}
          <div className="ld-row" style={{ flexWrap: "wrap", marginTop: 14 }}>
            {e.onTeam ? (
              <Link href={chatHref(e)} className="ld-btn p">Open chat</Link>
            ) : e.away && !e.away.canReturn ? (
              <button type="button" className="ld-btn" style={{ width: "auto", padding: "0 16px" }} disabled>{e.away.kind === "vacation" ? `Back ${dayText(e.away.returnFrom)}` : `Rehirable ${dayText(e.away.until)}`}</button>
            ) : e.away ? (
              <button type="button" className="ld-btn p" style={{ width: "auto", padding: "0 16px" }} disabled={busy} onClick={onBring}>{e.away.kind === "vacation" ? `Bring ${e.name} back` : `Rehire ${e.name}`}</button>
            ) : (
              <>
                <button type="button" className="ld-btn p" style={{ width: "auto", padding: "0 16px" }} disabled={busy} onClick={onBring}>{PLUS}{`Bring on ${e.name}`}</button>
                <button type="button" className="ld-btn" style={{ width: "auto", padding: "0 16px" }} onClick={() => navigate(`/bench/${e.kind === "custom" ? `e${e.id}` : e.kind}`)}>{MIC}{`Interview ${e.name}`}</button>
              </>
            )}
          </div>
          <span className="note">Interviews use work hours. Reading this bio is free.</span>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// Interview
// ==========================================

type Line = { me: boolean; text: string };
const ASK = ["What do you need from me?", "Show me an example", "What does this cost in hours?"];

function InterviewPage({ kind }: { kind: string }) {
  const { q, bring, orgId } = useBench();
  const [, navigate] = useLocation();
  const v = q.data;
  const e = v?.employees.find((x) => x.kind === kind || `e${x.id}` === kind) ?? null;
  const [lines, setLines] = React.useState<Line[]>([]);
  const [draft, setDraft] = React.useState("");
  const [muted, setMuted] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [warn, setWarn] = React.useState(false);
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const mutedRef = React.useRef(false);
  mutedRef.current = muted;
  const bottom = React.useRef<HTMLDivElement>(null);
  const started = React.useRef(false);
  const answers = lines.filter((l) => !l.me).length;

  const play = (url: string | null) => {
    if (!url || mutedRef.current) return;
    audio.current?.pause();
    const a = new Audio(url);
    audio.current = a;
    a.onplay = () => setSpeaking(true);
    a.onended = () => setSpeaking(false);
    a.onpause = () => setSpeaking(false);
    a.play().then(() => setBlocked(null)).catch(() => setBlocked(url));
  };
  const ask = trpc.bench.interview.useMutation({
    onSuccess: (r) => {
      setLines((ls) => [...ls, { me: false, text: r.text }]);
      play(r.audioUrl);
    },
  });
  React.useEffect(() => {
    if (!e || started.current) return;
    started.current = true;
    ask.mutate({ organizationId: orgId, employeeId: e.id });
  }, [e?.id]);
  React.useEffect(() => () => audio.current?.pause(), []);
  React.useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [lines.length, ask.isPending]);

  const send = (text: string) => {
    const t = text.trim();
    if (!t || !e || ask.isPending) return;
    const history = lines.slice(-20);
    setLines((ls) => [...ls, { me: true, text: t }]);
    setDraft("");
    ask.mutate({ organizationId: orgId, employeeId: e.id, question: t, history });
  };
  const onBring = () => {
    if (!e) return;
    if (!e.canBringOn && !e.onTeam && !e.away) return setWarn(true);
    audio.current?.pause();
    bring.mutate({ organizationId: orgId, employeeId: e.id });
  };
  const lim = warn && v && e ? limitText(v, e) : null;

  if (!e) {
    return (
      <Page rail="bench">
        {q.isLoading ? <div className="ld-empty">Loading...</div> : <div className="ld-empty">That employee isn't on the bench. <Link href="/bench">Back to the bench</Link></div>}
      </Page>
    );
  }
  return (
    <div className="ld">
      <Rail active="bench" />
      <section className="ld-iv">
        <aside className="ld-iv-side">
          <Link href="/bench" className="ld-btn" style={{ width: "auto", padding: "0 14px", alignSelf: "flex-start" }}>Back to bench</Link>
          <div className="ld-iv-photo">
            <Photo e={e} />
            <span className={`ld-iv-speaking ${speaking ? "on" : ""}`}>
              <span className="ld-bars" aria-hidden="true"><span /><span /><span /><span /><span /></span>
              {speaking ? "Speaking" : ask.isPending ? "Thinking" : muted ? "Voice off" : "Listening"}
            </span>
          </div>
          <div className="ld-iv-who">
            <h2>{e.name}</h2>
            <span>{e.roleTitle}</span>
          </div>
          <ul className="ld-iv-caps">{e.bio.support.map((s) => <li key={s}>{s}</li>)}</ul>
          <div className="ld-iv-btns">
            {e.onTeam ? (
              <Link href={chatHref(e)} className="ld-btn p">Open chat</Link>
            ) : e.away && !e.away.canReturn ? (
              <button type="button" className="ld-btn" style={{ width: "auto", padding: "0 16px" }} disabled>{e.away.kind === "vacation" ? `Back ${dayText(e.away.returnFrom)}` : `Rehirable ${dayText(e.away.until)}`}</button>
            ) : e.away ? (
              <button type="button" className="ld-btn p" style={{ width: "auto", padding: "0 16px" }} disabled={bring.isPending} onClick={onBring}>{e.away.kind === "vacation" ? `Bring ${e.name} back` : `Rehire ${e.name}`}</button>
            ) : (
              <button type="button" className="ld-btn p" disabled={bring.isPending} onClick={onBring}>{PLUS}{`Bring on ${e.name}`}</button>
            )}
            <button type="button" className="ld-btn" aria-pressed={muted} onClick={() => { setMuted(!muted); if (!muted) audio.current?.pause(); }}>{muted ? "Voice on" : "Mute voice"}</button>
          </div>
        </aside>
        <div className="ld-iv-main">
          <header className="ld-iv-top">
            <div>
              <h1>{`Interview ${e.name} to come off the bench`}</h1>
              <small>{e.department}</small>
            </div>
            <span className="ld-iv-usage">{`${answers} ${answers === 1 ? "answer" : "answers"} · ${answers * (v?.interviewMinutes ?? 5)} min of work hours`}</span>
          </header>
          <div className="ld-iv-msgs">
            {lines.map((l, i) => (
              <div key={i} className={`ld-iv-m ${l.me ? "me" : ""}`}>
                {!l.me && <Photo e={e} className="av" />}
                <div className="b">{l.text}</div>
              </div>
            ))}
            {ask.isPending && (
              <div className="ld-iv-m">
                <Photo e={e} className="av" />
                <div className="b ld-muted">{lines.length ? "Thinking..." : `${e.name} is getting ready...`}</div>
              </div>
            )}
            <div ref={bottom} />
          </div>
          {lim && (
            <div className="ld-bench-warn" role="alert" style={{ margin: "0 24px 12px" }}>
              <div>
                <b>{lim.title}</b>
                <p>{lim.body}</p>
              </div>
              <div className="ld-row">
                {lim.plans && <Link href="/workspace" className="ld-btn p">See plans</Link>}
                <button type="button" className="ld-btn" onClick={() => setWarn(false)}>{lim.plans ? "Not now" : "OK"}</button>
              </div>
            </div>
          )}
          {blocked && (
            <div className="ld-row" style={{ padding: "0 24px 10px", gap: 10 }}>
              <span className="ld-small">{`Your browser blocked ${e.name}'s voice.`}</span>
              <button type="button" className="ld-btn" onClick={() => play(blocked)}>Play voice</button>
            </div>
          )}
          <div style={{ padding: "0 24px" }}><ErrorLine error={ask.error || bring.error || q.error} /></div>
          <div className="ld-iv-ask">
            {ASK.map((s) => <button key={s} type="button" className="ld-chip" disabled={ask.isPending} onClick={() => send(s)}>{s}</button>)}
          </div>
          <form className="ld-iv-compose" onSubmit={(ev) => { ev.preventDefault(); send(draft); }}>
            <input className="ld-in" value={draft} placeholder={`Ask ${e.name} anything`} aria-label={`Ask ${e.name} anything`} onChange={(ev) => setDraft(ev.target.value)} />
            <DictateButton small label="Talk" onText={(t) => setDraft((d) => appendText(d, t))} />
            <button type="submit" className="ld-btn p" style={{ width: 96 }} disabled={ask.isPending || !draft.trim()}>Send</button>
          </form>
        </div>
      </section>
      <BottomNav active="bench" />
    </div>
  );
}
