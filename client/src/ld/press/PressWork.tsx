import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs, UnderlineTabs } from "../ui";
import { fmtDate, openDownload } from "../meta";
import type { Outputs } from "../types";
import ApplyWork from "../apply/ApplyWork";

/**
 * Taylor's Press tab: one newsroom for the owner's desks. Newsroom (stories
 * routed to the right desk, weekly numbers, press settings), Media list
 * (reporters with proof), Campaigns (plan, angles, pitches with a quality
 * score), Replies, Interviews (briefings), Coverage, Library, and Speaking
 * (the events and press requests Taylor already applies to).
 */

type N = Outputs["newsroom"];
type View = N["view"];
type Contact = N["contacts"][number];
type Pitch = N["pitches"][number];
type Campaign = N["campaigns"][number];
type Reply = N["replies"][number];
type Interview = N["interviews"][number];
type Lib = N["library"][number];

const DESK_PILL = ["green", "purple", "blue", "amber", "gray"];
const REL: Record<string, [string, string]> = { prospect: ["gray", "Prospect"], contacted: ["amber", "Contacted"], engaged: ["green", "Engaged"], source: ["green", "Source"], warm: ["green", "Warm"], advocate: ["green", "Advocate"] };
const LEVEL_TEXT: Record<number, string> = {
  1: "Level 1: you approve every pitch and reply",
  2: "Level 2: you approve everything; Taylor drafts follow-ups",
  3: "Level 3: follow-ups send themselves",
  4: "Level 4: pitches scoring 90 or more on safe topics send themselves",
  5: "Level 5: any pitch that passes the check on a safe topic sends itself",
};
const REPLY_KIND: Record<string, [string, string]> = { interview: ["green", "Wants interview"], not_now: ["amber", "Not now"], questions: ["green", "Questions"], dnc: ["red", "Do not contact"], referral: ["gray", "Referral"], moved: ["gray", "Moved outlets"], ooo: ["gray", "Out of office"], crisis: ["red", "Crisis"], other: ["gray", "Other"] };
const fmt = (d: Date | string | null | undefined) => (d ? fmtDate(d) : "");
const fmtWhen = (d: Date | string | null | undefined) => (d ? `${fmtDate(d)}, ${new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "Time not set");
const typedToIso = (s: string) => {
  const t = s.trim();
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
};
const toTyped = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  return `${String(x.getMonth() + 1).padStart(2, "0")}/${String(x.getDate()).padStart(2, "0")}/${x.getFullYear()} ${x.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

function useOrg() {
  return useTenant().currentOrgId;
}

function DeskPill({ id, desks }: { id: number; desks: { id: number; name: string }[] }) {
  const i = Math.max(0, desks.findIndex((d) => d.id === id));
  return <span className={`ld-pill ${DESK_PILL[i] ?? "gray"}`} style={{ alignSelf: "flex-start", justifySelf: "start" }}>{desks.find((d) => d.id === id)?.name ?? "Another desk"}</span>;
}

function Box({ label, children, right }: { label?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {(label || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {label && <span className="ld-lbl">{label}</span>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="ld-press-kv" style={{ display: "grid", gridTemplateColumns: "170px minmax(0,1fr)", gap: "7px 14px", fontSize: 14, lineHeight: 1.5 }}>
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
        <React.Fragment key={k}>
          <b>{k}</b>
          <span style={{ overflowWrap: "anywhere" }}>{v}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", border: "1px solid #cfd9d4", borderRadius: 8, overflow: "hidden", justifySelf: "start", alignSelf: "flex-start", flexWrap: "wrap" }}>
      {options.map((o) => (
        <button key={String(o.key)} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)} style={{ height: 32, padding: "0 14px", border: 0, borderRight: "1px solid #e3e9e6", background: value === o.key ? "var(--ld-accent-bg)" : "#fff", font: "inherit", fontSize: 13, fontWeight: 700, color: value === o.key ? "var(--ld-accent-dark)" : "var(--ld-text2)", cursor: "pointer", whiteSpace: "nowrap" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Form({ children }: { children: React.ReactNode }) {
  return <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "170px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>{children}</div>;
}
function Field({ id, label, children, top }: { id: string; label: string; children: React.ReactNode; top?: boolean }) {
  return (
    <>
      <label htmlFor={id} style={{ fontWeight: 700, ...(top ? { alignSelf: "start", paddingTop: 6 } : {}) }}>{label}</label>
      {children}
    </>
  );
}
const TA: React.CSSProperties = { height: "auto", padding: "8px 10px", lineHeight: 1.5, resize: "vertical" };

function Buttons({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>;
}

function useRefresh() {
  const utils = trpc.useUtils();
  return () => utils.newsroom.invalidate();
}

// ==========================================
// The page
// ==========================================

type Tab = "newsroom" | "media" | "campaigns" | "replies" | "interviews" | "coverage" | "library" | "speaking";

export default function PressWork({ emp }: { emp: EmployeeRow }) {
  const orgId = useOrg();
  const initial = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
  const [tab, setTab] = React.useState<Tab>(initial === "applications" || initial === "awards" || new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("opp") ? "speaking" : ((initial as Tab) || "newsroom"));
  const view = trpc.newsroom.view.useQuery({ organizationId: orgId }, { refetchInterval: (q) => (q.state.data?.scouting ? 8000 : 60_000) });
  const contacts = trpc.newsroom.contacts.useQuery({ organizationId: orgId });
  const campaigns = trpc.newsroom.campaigns.useQuery({ organizationId: orgId }, { refetchInterval: 20_000 });
  const replies = trpc.newsroom.replies.useQuery({ organizationId: orgId });
  const interviews = trpc.newsroom.interviews.useQuery({ organizationId: orgId });
  const coverage = trpc.newsroom.coverage.useQuery({ organizationId: orgId });
  const resume = trpc.newsroom.resume.useMutation({ onSuccess: useRefresh() });
  const v = view.data;
  const others = (v?.desks ?? []).slice(1);
  return (
    <main className="ld-main" style={{ padding: "24px 32px", gap: 16 }}>
      {v && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, color: "var(--ld-text2)" }}>
          <span className="ld-pill green">{v.desk.name} desk</span>
          <span>{others.length ? `Shared newsroom with ${others.map((d) => d.name).join(" and ")}` : "Its own newsroom. Link your other workspaces in Press settings."}</span>
        </div>
      )}
      {v?.settings.paused && (
        <div role="alert" className="ld-card" style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "center", background: "#fdeeee", borderColor: "#f3cccc" }}>
          <span style={{ fontSize: 14, lineHeight: 1.5 }}><b>Outreach is stopped on this desk.</b> {v.settings.pausedReason}. Nothing goes out until you resume it.</span>
          <button type="button" className="ld-btn" disabled={resume.isPending} onClick={() => resume.mutate({ organizationId: orgId })}>Resume</button>
        </div>
      )}
      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "newsroom", label: "Newsroom" },
          { key: "media", label: `Media list (${contacts.data?.length ?? 0})` },
          { key: "campaigns", label: `Campaigns (${campaigns.data?.length ?? 0})` },
          { key: "replies", label: `Replies (${(replies.data ?? []).filter((r) => r.status === "open").length})` },
          { key: "interviews", label: `Interviews (${(interviews.data ?? []).filter((i) => i.status === "upcoming").length})` },
          { key: "coverage", label: `Coverage (${coverage.data?.list.length ?? 0})` },
          { key: "library", label: "Library" },
          { key: "speaking", label: "Speaking" },
        ]}
      />
      {tab === "newsroom" && v && <Newsroom v={v} onSpeaking={() => setTab("speaking")} />}
      {tab === "media" && v && <MediaList v={v} list={contacts.data ?? []} loading={contacts.isLoading} />}
      {tab === "campaigns" && v && <Campaigns v={v} list={campaigns.data ?? []} />}
      {tab === "replies" && <Replies list={replies.data ?? []} />}
      {tab === "interviews" && v && <Interviews v={v} list={interviews.data ?? []} contacts={contacts.data ?? []} />}
      {tab === "coverage" && v && <Coverage v={v} data={coverage.data} />}
      {tab === "library" && <Library />}
      {tab === "speaking" && <ApplyWork emp={emp} embedded />}
      {!v && <div className="ld-card ld-empty">{view.isLoading ? "Loading..." : "Couldn't load the newsroom."}</div>}
    </main>
  );
}

// ==========================================
// Pitch box (used on stories, campaigns and the media list)
// ==========================================

function PitchBox({ p }: { p: Pitch | NonNullable<Contact["pitch"]> }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [edit, setEdit] = React.useState<{ subject: string; body: string } | null>(null);
  const approve = trpc.newsroom.approvePitch.useMutation({ onSuccess: refresh });
  const save = trpc.newsroom.editPitch.useMutation({ onSuccess: async () => { setEdit(null); await refresh(); } });
  const pill =
    p.status === "sent" ? <span className="ld-pill green">Sent {fmt(p.sentAt)}</span>
    : p.status === "pending" ? <span className="ld-pill amber">Sending</span>
    : p.status === "cooling" ? <span className="ld-pill gray">Cooling until {fmt(p.coolingUntil)}</span>
    : p.status === "skipped" ? <span className="ld-pill red">Do not contact</span>
    : p.status === "replied" ? <span className="ld-pill green">Replied</span>
    : p.status === "weak" ? <span className="ld-pill amber">Quality {p.score} of 100, needs you</span>
    : <span className="ld-pill green">Quality {p.score} of 100</span>;
  const canSend = p.status === "ready" || p.status === "weak";
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <b>{p.followUp ? "Follow-up" : "Pitch"} to {p.name}{p.outlet ? `, ${p.outlet}` : ""}</b>
          {pill}
        </div>
        {edit ? (
          <Form>
            <Field id={`ps-${p.id}`} label="Subject"><input id={`ps-${p.id}`} className="ld-in" value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>
            <Field id={`pb-${p.id}`} label="Pitch" top><textarea id={`pb-${p.id}`} className="ld-in" rows={8} style={TA} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
          </Form>
        ) : p.subject ? (
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-line" }}><b>Subject: {p.subject}</b>{"\n\n"}{p.body}</div>
        ) : (
          <span className="ld-small">{p.status === "cooling" ? "Not written: another desk pitched this reporter recently." : p.status === "skipped" ? "Not written: they asked not to be contacted." : ""}</span>
        )}
        {!p.email && canSend && <span className="ld-small">No public email for {p.name} yet. Add one on the Media list to send.</span>}
        <ErrorLine error={approve.error || save.error} />
      </div>
      <Buttons>
        {edit ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: p.id, subject: edit.subject, body: edit.body })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
          </>
        ) : canSend ? (
          <>
            <button type="button" className="ld-btn p" disabled={approve.isPending || !p.email} onClick={() => approve.mutate({ organizationId: orgId, id: p.id })}>{approve.isPending ? "Sending..." : "Approve pitch"}</button>
            <button type="button" className="ld-btn" onClick={() => setEdit({ subject: p.subject, body: p.body })}>Edit pitch</button>
          </>
        ) : null}
      </Buttons>
    </div>
  );
}

function Rubric({ p }: { p: Pitch }) {
  return (
    <Box label={`Pitch check: ${p.name}`} right={<span className={`ld-pill ${p.score >= 85 ? "green" : "amber"}`}>{p.score} of 100{p.score >= 85 ? ", passes" : ", under 85"}</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 80px", gap: "6px 14px", fontSize: 13 }}>
        {p.rubric.map((r) => (
          <React.Fragment key={r.name}>
            <span>{r.name}</span>
            <b>{r.points} of {r.max}</b>
          </React.Fragment>
        ))}
      </div>
      <span className="ld-small">Pitches under 85 are rewritten before you see them.</span>
    </Box>
  );
}

// ==========================================
// Newsroom
// ==========================================

function Newsroom({ v, onSpeaking }: { v: View; onSpeaking: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [open, setOpen] = React.useState<number | null>(v.stories[0]?.id ?? null);
  const [settings, setSettings] = React.useState(false);
  const scout = trpc.newsroom.scout.useMutation({ onSuccess: refresh });
  const COLS = "minmax(0,2fr) 170px 140px 70px 128px";
  const pitches = trpc.newsroom.pitches.useQuery({ organizationId: orgId }).data ?? [];
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">This week, {fmt(new Date())}</span>
          <div className="ld-press-desks" style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, v.counts.length)}, minmax(0,1fr))`, gap: 12 }}>
            {v.counts.map((c) => (
              <div key={c.orgId} style={{ border: "1px solid #e3e9e6", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <DeskPill id={c.orgId} desks={v.desks} />
                <span style={{ fontSize: 13, lineHeight: 1.7 }}>
                  {c.stories} open {c.stories === 1 ? "story" : "stories"}<br />
                  {c.newReporters} new reporters qualified<br />
                  {c.ready} {c.ready === 1 ? "pitch" : "pitches"} ready<br />
                  {c.followUps} waiting on follow-up{c.replies ? <><br />{c.replies} {c.replies === 1 ? "reply" : "replies"} to answer</> : null}{c.interviews ? <><br />{c.interviews} upcoming {c.interviews === 1 ? "interview" : "interviews"}</> : null}
                </span>
              </div>
            ))}
          </div>
          {v.settings.lastScoutAt && <span className="ld-small">Last scouted {fmtWhen(v.settings.lastScoutAt)}. Taylor scouts every Monday morning and posts your briefing at 8:00.</span>}
          <ErrorLine error={scout.error} />
        </div>
        <Buttons>
          <button type="button" className="ld-btn p" disabled={v.scouting || scout.isPending || v.settings.paused} onClick={() => scout.mutate({ organizationId: orgId })}>{v.scouting || scout.isPending ? "Scouting..." : "Scout now"}</button>
          <button type="button" className="ld-btn" onClick={() => setSettings(!settings)}>{settings ? "Close settings" : "Settings"}</button>
        </Buttons>
      </div>

      {settings && <PressSettings v={v} />}

      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Story</span><span>Best desk</span><span>Window</span><span>Score</span><span /></div>
        {v.stories.length === 0 && <div className="ld-empty">{v.scouting ? "Taylor is scouting. Stories show up here as she finds them." : "No stories yet. Press Scout now, or connect the Press inbox on Integrations for HARO and Source of Sources requests."}</div>}
        {v.stories.map((s) => (
          <StoryRow key={s.id} s={s} v={v} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} cols={COLS} pitches={pitches.filter((p) => p.storyId === s.id)} onSpeaking={onSpeaking} />
        ))}
      </div>
    </>
  );
}

function StoryRow({ s, v, open, onToggle, cols, pitches, onSpeaking }: { s: View["stories"][number]; v: View; open: boolean; onToggle: () => void; cols: string; pitches: Pitch[]; onSpeaking: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [moving, setMoving] = React.useState(false);
  const write = trpc.newsroom.pitchStory.useMutation({ onSuccess: refresh });
  const dismiss = trpc.newsroom.dismissStory.useMutation({ onSuccess: refresh });
  const move = trpc.newsroom.moveStory.useMutation({ onSuccess: async () => { setMoving(false); await refresh(); } });
  const plan = trpc.newsroom.planCampaign.useMutation({ onSuccess: refresh });
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <b style={{ overflowWrap: "anywhere" }}>{s.title}</b>
        <DeskPill id={orgId} desks={v.desks} />
        <span>{s.windowEnds ? (/rolling/i.test(s.windowEnds) ? "Rolling" : `Ends ${s.windowEnds}`) : ""}</span>
        <span>{s.score}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <KV
              rows={[
                ["Found", `${fmt(s.foundAt)}${s.source ? ` · ${s.source}` : ""}`],
                ["Also fits", s.alsoFits.length ? <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>{s.alsoFits.map((a) => <span key={a.deskId}><DeskPill id={a.deskId} desks={v.desks} /> {a.why}</span>)} One desk pitches, so this one takes it.</span> : ""],
                ["Spokesperson", s.spokesperson],
                ["Angle", s.angle],
                ["What we offer", s.offer],
                ["Reporters", s.reporters.length || s.skipped.length ? `${s.reporters.length} on it${s.skipped.length ? `, ${s.skipped.length} skipped (${s.skipped.map((x) => `${x.name}: ${x.reason}`).join("; ")})` : ""}` : ""],
                ["Your quote", s.quote ? `"${s.quote}"` : ""],
                ["Source", s.sourceUrl ? <a href={s.sourceUrl} target="_blank" rel="noreferrer noopener">{s.sourceUrl.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}</a> : ""],
              ]}
            />
            {pitches.map((p) => <PitchBox key={p.id} p={p} />)}
            {moving && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 14 }}>
                <b>Move to</b>
                {v.desks.filter((d) => d.id !== orgId).map((d) => <button key={d.id} type="button" className="ld-sug" style={{ borderRadius: 8, height: 32, fontWeight: 700 }} onClick={() => move.mutate({ organizationId: orgId, id: s.id, to: d.id })}>{d.name}</button>)}
              </div>
            )}
            <ErrorLine error={write.error || dismiss.error || move.error || plan.error} />
          </div>
          <Buttons>
            {s.oppId ? (
              <button type="button" className="ld-btn p" onClick={onSpeaking}>Open pitch</button>
            ) : (
              <button type="button" className="ld-btn p" disabled={write.isPending || v.settings.paused} onClick={() => write.mutate({ organizationId: orgId, id: s.id })}>{write.isSuccess ? "Writing..." : pitches.length ? "More pitches" : "Write pitches"}</button>
            )}
            <button type="button" className="ld-btn" disabled={plan.isPending} onClick={() => plan.mutate({ organizationId: orgId, brief: s.title, storyId: s.id })}>{plan.isPending ? "Planning..." : plan.isSuccess ? "Planned" : "Plan campaign"}</button>
            {v.desks.length > 1 && <button type="button" className="ld-btn" onClick={() => setMoving(!moving)}>Other desk</button>}
            <button type="button" className="ld-btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ organizationId: orgId, id: s.id })}>Dismiss</button>
          </Buttons>
        </div>
      )}
    </>
  );
}

// ==========================================
// Press settings (view, then Edit)
// ==========================================

function PressSettings({ v }: { v: View }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const all = trpc.newsroom.view.useQuery({ organizationId: orgId }).data?.myWorkspaces ?? [];
  const st = v.settings;
  const [edit, setEdit] = React.useState<null | { shared: number[]; coolingDays: string; level: number; alwaysNeedsYou: string; stopWords: string }>(null);
  const [own, setOwn] = React.useState<null | { owns: string; beats: string }>(null);
  const save = trpc.newsroom.saveSettings.useMutation({ onSuccess: async () => { setEdit(null); setOwn(null); await refresh(); } });
  const base = { organizationId: orgId, shared: st.shared, coolingDays: st.coolingDays, level: st.level, alwaysNeedsYou: st.alwaysNeedsYou, stopWords: st.stopWords };
  const names = (ids: number[]) => ids.map((id) => v.desks.find((d) => d.id === id)?.name ?? all.find((w) => w.id === id)?.name ?? "").filter(Boolean).join(", ");
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Press settings</span>
          {edit ? (
            <Form>
              <b>Shared newsroom</b>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {all.map((w) => {
                  const on = edit.shared.includes(w.id) || w.id === orgId;
                  return <button key={w.id} type="button" aria-pressed={on} disabled={w.id === orgId} className="ld-sug" style={{ borderRadius: 8, height: 32, fontWeight: 700, background: on ? "var(--ld-accent-bg)" : "#fff", borderColor: on ? "var(--ld-accent)" : undefined, color: on ? "var(--ld-accent-dark)" : "var(--ld-ink)" }} onClick={() => setEdit({ ...edit, shared: on ? edit.shared.filter((x) => x !== w.id) : [...edit.shared, w.id] })}>{w.name}</button>;
                })}
              </div>
              <Field id="pr-cool" label="Cooling period"><div style={{ display: "flex", gap: 8, alignItems: "center" }}><input id="pr-cool" className="ld-in" style={{ width: 80 }} inputMode="numeric" value={edit.coolingDays} onChange={(e) => setEdit({ ...edit, coolingDays: e.target.value.replace(/\D/g, "") })} /><span>days between desks pitching the same reporter</span></div></Field>
              <b style={{ alignSelf: "start", paddingTop: 6 }}>How much Taylor sends</b>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Seg label="Sending level" value={edit.level} onChange={(n) => setEdit({ ...edit, level: n })} options={[1, 2, 3, 4, 5].map((n) => ({ key: n, label: `Level ${n}` }))} />
                <span className="ld-small">{LEVEL_TEXT[edit.level]}</span>
              </div>
              <Field id="pr-always" label="Always needs you"><input id="pr-always" className="ld-in" value={edit.alwaysNeedsYou} onChange={(e) => setEdit({ ...edit, alwaysNeedsYou: e.target.value })} /></Field>
              <Field id="pr-stop" label="Stops everything"><input id="pr-stop" className="ld-in" value={edit.stopWords} onChange={(e) => setEdit({ ...edit, stopWords: e.target.value })} /></Field>
            </Form>
          ) : (
            <KV
              rows={[
                ["Shared newsroom", names(st.shared)],
                ["Cooling period", `${st.coolingDays} days between desks pitching the same reporter`],
                ["How much Taylor sends", LEVEL_TEXT[st.level]],
                ["Always needs you", st.alwaysNeedsYou],
                ["Stops everything", st.stopWords],
              ]}
            />
          )}
          <ErrorLine error={save.error} />
        </div>
        <Buttons>
          {edit ? (
            <>
              <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ ...base, shared: edit.shared.filter((x) => x !== orgId), coolingDays: Number(edit.coolingDays || 0), level: edit.level, alwaysNeedsYou: edit.alwaysNeedsYou, stopWords: edit.stopWords })}>Save</button>
              <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="ld-btn" onClick={() => setEdit({ shared: st.shared.filter((x) => x !== orgId), coolingDays: String(st.coolingDays), level: st.level, alwaysNeedsYou: st.alwaysNeedsYou, stopWords: st.stopWords })}>Edit</button>
          )}
        </Buttons>
      </div>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Which desk owns a story</span>
          {own ? (
            <Form>
              <Field id="pr-owns" label={`${v.desk.name} owns`}><input id="pr-owns" className="ld-in" value={own.owns} onChange={(e) => setOwn({ ...own, owns: e.target.value })} /></Field>
              <Field id="pr-beats" label="Beats it watches"><input id="pr-beats" className="ld-in" value={own.beats} placeholder="AI in healthcare, behavioral health technology" onChange={(e) => setOwn({ ...own, beats: e.target.value })} /></Field>
            </Form>
          ) : (
            <KV rows={v.desks.map((d) => [d.name, (d.id === orgId ? st.owns : d.owns) || (d.id === orgId ? "Written from the Brain on the first scout" : "Set on that workspace's Press settings")] as [string, string])} />
          )}
          {!own && st.beats.length > 0 && <span className="ld-small">Beats this desk watches: {st.beats.join(", ")}</span>}
          <span className="ld-small">When a story fits two desks, the one with the higher fit takes it and the other is noted.</span>
        </div>
        <Buttons>
          {own ? (
            <>
              <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ ...base, shared: st.shared.filter((x) => x !== orgId), owns: own.owns, beats: own.beats.split(",").map((b) => b.trim()).filter(Boolean) })}>Save</button>
              <button type="button" className="ld-btn" onClick={() => setOwn(null)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="ld-btn" onClick={() => setOwn({ owns: st.owns, beats: st.beats.join(", ") })}>Edit</button>
          )}
        </Buttons>
      </div>
    </>
  );
}

// ==========================================
// Media list
// ==========================================

type ContactEdit = { id?: number; name: string; outlet: string; title: string; email: string; beats: string; relationship: string; notes: string; doNotContact: boolean };

function MediaList({ v, list, loading }: { v: View; list: Contact[]; loading: boolean }) {
  const [q, setQ] = React.useState("");
  const [desk, setDesk] = React.useState<number>(0);
  const [open, setOpen] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const COLS = "minmax(0,1.5fr) minmax(0,1.2fr) 200px 120px 128px";
  const needle = q.trim().toLowerCase();
  const shown = list
    .filter((c) => !needle || `${c.name} ${c.outlet} ${c.beats.join(" ")}`.toLowerCase().includes(needle))
    .filter((c) => !desk || Number(c.fit[desk] ?? 0) >= 60)
    .sort((a, b) => (desk ? Number(b.fit[desk] ?? 0) - Number(a.fit[desk] ?? 0) : b.myFit - a.myFit));
  const recentCount = list.filter((c) => c.verifiedAt && Date.now() - new Date(c.verifiedAt).getTime() < 30 * 86_400_000).length;
  const proven = list.filter((c) => c.articles.some((a) => Date.now() - Date.parse(a.date) < 183 * 86_400_000)).length;
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="ml-q" className="ld-sr">Search reporters</label>
        <input id="ml-q" className="ld-in" style={{ maxWidth: 280 }} placeholder="Search reporters, outlets or beats" value={q} onChange={(e) => setQ(e.target.value)} />
        {v.desks.length > 1 && <Seg label="Desk" value={desk} onChange={setDesk} options={[{ key: 0, label: "All desks" }, ...v.desks.map((d) => ({ key: d.id, label: d.name }))]} />}
        <span style={{ flex: 1 }} />
        <button type="button" className="ld-btn p" onClick={() => { setOpen(null); setAdding(true); }}>Add reporter</button>
      </div>
      {adding && <ContactForm v={v} initial={{ name: "", outlet: "", title: "", email: "", beats: "", relationship: "prospect", notes: "", doNotContact: false }} onDone={() => setAdding(false)} />}
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Reporter</span><span>Beat</span><span>Fit: {v.desks.map((d) => d.name.replace(/^Dr\.?\s+/, "").split(" ")[0]).join(" · ")}</span><span>Relationship</span><span /></div>
        {shown.length === 0 && <div className="ld-empty">{loading ? "Loading..." : list.length ? "No reporters match." : "No reporters yet. Press Scout now on the Newsroom tab and Taylor finds reporters with recent articles on your beats."}</div>}
        {shown.map((c) => <ContactRow key={c.id} c={c} v={v} cols={COLS} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} />)}
      </div>
      {list.length > 0 && <span className="ld-small">{list.length} reporters · {recentCount} checked in the last 30 days · {proven === list.length ? "every one has" : `${proven} have`} an article from the last 6 months</span>}
    </>
  );
}

function ContactRow({ c, v, cols, open, onToggle }: { c: Contact; v: View; cols: string; open: boolean; onToggle: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [editing, setEditing] = React.useState(false);
  const pitch = trpc.newsroom.pitchContact.useMutation({ onSuccess: refresh });
  const recheck = trpc.newsroom.recheck.useMutation({ onSuccess: refresh });
  const save = trpc.newsroom.saveContact.useMutation({ onSuccess: refresh });
  const [rc, rl] = c.doNotContact ? ["red", "Do not contact"] : c.movedFrom ? ["red", "Moved outlets"] : REL[c.relationship] ?? ["gray", c.relationship];
  const deskName = (id: number | null) => v.desks.find((d) => d.id === id)?.name ?? "another desk";
  const toggleDnc = () => save.mutate({ organizationId: orgId, id: c.id, name: c.name, outlet: c.outlet, title: c.title, email: c.email ?? "", beats: c.beats, relationship: c.relationship, notes: c.notes ?? "", doNotContact: !c.doNotContact });
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <span><b>{c.name}</b><br /><span className="ld-small">{[c.title, c.outlet].filter(Boolean).join(", ")}</span></span>
        <span>{c.beats.slice(0, 3).join(", ")}</span>
        <span>{v.desks.map((d, i) => <React.Fragment key={d.id}>{i ? " · " : ""}{d.id === orgId ? <b>{Number(c.fit[d.id] ?? 0)}</b> : Number(c.fit[d.id] ?? 0)}</React.Fragment>)}</span>
        <span className={`ld-pill ${rc}`}>{rl}</span>
        <button type="button" className="ld-btn" onClick={() => { setEditing(false); onToggle(); }}>{open ? "Close" : "Open"}</button>
      </div>
      {open && editing && <ContactForm v={v} initial={{ id: c.id, name: c.name, outlet: c.outlet, title: c.title, email: c.email ?? "", beats: c.beats.join(", "), relationship: c.relationship, notes: c.notes ?? "", doNotContact: c.doNotContact }} onDone={() => setEditing(false)} inRow />}
      {open && !editing && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <Box label="Why this person"><span style={{ fontSize: 14, lineHeight: 1.6 }}>{c.why || "Not written yet."}</span></Box>
            <Box label="Proof from their articles">
              {c.articles.length ? c.articles.map((a) => (
                <div key={a.url} className="ld-press-ev" style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr) 160px", gap: 10, fontSize: 13, alignItems: "start" }}>
                  <b>{a.date}</b>
                  <a href={a.url} target="_blank" rel="noreferrer noopener">{a.title}</a>
                  <span>{a.topics}</span>
                </div>
              )) : <span className="ld-small">No articles yet. Press Recheck and Taylor looks for their recent work before any pitch.</span>}
            </Box>
            {(c.profile.storyType || c.profile.sources || c.profile.strongest) && (
              <Box label="How they work"><KV rows={[["Story type", c.profile.storyType ?? ""], ["Sources they quote", c.profile.sources ?? ""], ["Product launches", c.profile.launches ?? ""], ["Strongest angle", c.profile.strongest ?? ""], ["Likes", c.profile.likes ?? ""]]} /></Box>
            )}
            <Box label="Contact and history">
              <KV
                rows={[
                  ["Email", c.email ? `${c.email}${c.emailSource ? ` (${/^https?:/.test(c.emailSource) ? `from ${c.emailSource.replace(/^https?:\/\/(www\.)?/, "").slice(0, 50)}` : c.emailSource}` : ""}${c.verifiedAt ? `, verified ${fmt(c.verifiedAt)}` : ""})` : "No public email found yet"],
                  ["Moved from", c.movedFrom ?? ""],
                  ["Last contact", c.lastContactAt ? `${fmt(c.lastContactAt)} by the ${deskName(c.lastContactOrgId)} desk${c.lastPitch ? `: ${c.lastPitch}` : ""}` : "Never contacted"],
                  ["Cooling", c.cooling ? `Free again ${fmt(c.cooling.until)} (${c.cooling.reason})` : ""],
                  ["They asked for", c.asks ?? ""],
                  ["Interviews", String(c.interviews || "None yet")],
                  ["Coverage", String(c.coverage || "None yet")],
                  ["Notes", c.notes ?? ""],
                ]}
              />
            </Box>
            {c.pitch && <PitchBox p={c.pitch} />}
            <ErrorLine error={pitch.error || recheck.error || save.error} />
          </div>
          <Buttons>
            <button type="button" className="ld-btn p" disabled={pitch.isPending || c.doNotContact || Boolean(c.cooling) || v.settings.paused} onClick={() => pitch.mutate({ organizationId: orgId, id: c.id })}>{pitch.isPending ? "Writing..." : "Pitch"}</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="ld-btn" disabled={recheck.isPending} onClick={() => recheck.mutate({ organizationId: orgId, id: c.id })}>{recheck.isPending ? "Checking..." : "Recheck"}</button>
            <button type="button" className="ld-btn" disabled={save.isPending} onClick={toggleDnc}>{c.doNotContact ? "Allow contact" : "Do not contact"}</button>
          </Buttons>
        </div>
      )}
    </>
  );
}

function ContactForm({ v, initial, onDone, inRow }: { v: View; initial: ContactEdit; onDone: () => void; inRow?: boolean }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [e, setE] = React.useState<ContactEdit>(initial);
  const save = trpc.newsroom.saveContact.useMutation({ onSuccess: async () => { await refresh(); onDone(); } });
  const remove = trpc.newsroom.removeContact.useMutation({ onSuccess: async () => { await refresh(); onDone(); } });
  void v;
  const id = e.id ?? "new";
  const body = (
    <>
      <div className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        {!inRow && <span className="ld-lbl">Add reporter</span>}
        <Form>
          <Field id={`c-n-${id}`} label="Name"><input id={`c-n-${id}`} className="ld-in" style={{ maxWidth: 360 }} value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} /></Field>
          <Field id={`c-o-${id}`} label="Outlet"><input id={`c-o-${id}`} className="ld-in" style={{ maxWidth: 360 }} value={e.outlet} onChange={(x) => setE({ ...e, outlet: x.target.value })} /></Field>
          <Field id={`c-t-${id}`} label="Title"><input id={`c-t-${id}`} className="ld-in" style={{ maxWidth: 360 }} value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} /></Field>
          <Field id={`c-e-${id}`} label="Email"><input id={`c-e-${id}`} className="ld-in" style={{ maxWidth: 360 }} value={e.email} onChange={(x) => setE({ ...e, email: x.target.value })} /></Field>
          <Field id={`c-b-${id}`} label="Beats"><input id={`c-b-${id}`} className="ld-in" placeholder="Healthcare operations, AI in clinics" value={e.beats} onChange={(x) => setE({ ...e, beats: x.target.value })} /></Field>
          <b>Relationship</b>
          <Seg label="Relationship" value={e.relationship} onChange={(r) => setE({ ...e, relationship: r })} options={Object.entries(REL).map(([k, [, l]]) => ({ key: k, label: l }))} />
          <Field id={`c-x-${id}`} label="Notes" top><textarea id={`c-x-${id}`} className="ld-in" rows={2} style={TA} value={e.notes} onChange={(x) => setE({ ...e, notes: x.target.value })} /></Field>
          <b>Do not contact</b>
          <Seg label="Do not contact" value={e.doNotContact ? "yes" : "no"} onChange={(x) => setE({ ...e, doNotContact: x === "yes" })} options={[{ key: "no", label: "No" }, { key: "yes", label: "Yes" }]} />
        </Form>
        {!e.id && <span className="ld-small">Taylor checks their recent articles before any pitch.</span>}
        <ErrorLine error={save.error || remove.error} />
      </div>
      <Buttons>
        <button type="button" className="ld-btn p" disabled={save.isPending || !e.name.trim()} onClick={() => save.mutate({ organizationId: orgId, id: e.id, name: e.name, outlet: e.outlet, title: e.title, email: e.email, beats: e.beats.split(",").map((b) => b.trim()).filter(Boolean), relationship: e.relationship as Contact["relationship"], notes: e.notes, doNotContact: e.doNotContact })}>Save</button>
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
        {e.id && <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: e.id! })}>Remove</button>}
      </Buttons>
    </>
  );
  return inRow ? <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>{body}</div> : <div className="ld-resultcard" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>{body}</div>;
}

// ==========================================
// Campaigns
// ==========================================

function Campaigns({ v, list }: { v: View; list: Campaign[] }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [open, setOpen] = React.useState<number | null>(list[0]?.id ?? null);
  const [brief, setBrief] = React.useState("");
  const plan = trpc.newsroom.planCampaign.useMutation({ onSuccess: async (c) => { setBrief(""); setOpen(c.id); await refresh(); } });
  const COLS = "minmax(0,2fr) 170px 100px 170px 128px";
  const STATUS: Record<string, [string, string]> = { planning: ["gray", "Planning"], pitching: ["amber", "Pitching"], scheduled: ["gray", "Starts later"], done: ["green", "Done"] };
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label htmlFor="cp-brief" className="ld-lbl" style={{ whiteSpace: "nowrap" }}>New campaign</label>
          <input id="cp-brief" className="ld-in" placeholder="The LeadDash Employees launch" value={brief} onChange={(e) => setBrief(e.target.value)} />
        </div>
        <button type="button" className="ld-btn p" disabled={plan.isPending || brief.trim().length < 3} onClick={() => plan.mutate({ organizationId: orgId, brief })}>{plan.isPending ? "Planning..." : "Plan campaign"}</button>
        <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={plan.error} /></div>
      </div>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Campaign</span><span>Desk</span><span>Reporters</span><span>Status</span><span /></div>
        {list.length === 0 && <div className="ld-empty">No campaigns yet. Type what it's about above, or tell Taylor in Chat, like "Build a media list for the LeadDash Employees launch."</div>}
        {list.map((c) => {
          const [sc, sl] = c.status === "scheduled" && c.startsOn ? ["gray", `Starts ${c.startsOn}`] : STATUS[c.status] ?? ["gray", c.status];
          return (
            <React.Fragment key={c.id}>
              <div className={`ld-rw ${open === c.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                <b style={{ overflowWrap: "anywhere" }}>{c.title}</b>
                <DeskPill id={orgId} desks={v.desks} />
                <span>{c.reporters}</span>
                <span className={`ld-pill ${sc}`}>{sl}</span>
                <button type="button" className="ld-btn" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Close" : "Open"}</button>
              </div>
              {open === c.id && <CampaignDetail c={c} paused={v.settings.paused} />}
            </React.Fragment>
          );
        })}
      </div>
    </>
  );
}

function CampaignDetail({ c, paused }: { c: Campaign; paused: boolean }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [edit, setEdit] = React.useState<null | { title: string; plan: Campaign["plan"]; angles: Campaign["angles"] }>(null);
  const [pick, setPick] = React.useState<number | null>(c.pitches.find((p) => p.subject)?.id ?? null);
  const save = trpc.newsroom.saveCampaign.useMutation({ onSuccess: async () => { setEdit(null); await refresh(); } });
  const add = trpc.newsroom.addReporters.useMutation({ onSuccess: refresh });
  const approve = trpc.newsroom.approveReady.useMutation({ onSuccess: refresh });
  const finish = trpc.newsroom.finishCampaign.useMutation({ onSuccess: refresh });
  const kit = trpc.newsroom.makeKit.useMutation();
  const kitDoc = trpc.newsroom.kitDocx.useMutation();
  const ready = c.pitches.filter((p) => p.status === "ready" && p.email).length;
  const P = c.plan;
  const pitch = c.pitches.find((p) => p.id === pick) ?? null;
  const STAT: Record<string, [string, string]> = { ready: ["green", "Ready"], weak: ["amber", "Needs you"], pending: ["amber", "Sending"], sent: ["green", "Sent"], cooling: ["gray", "Cooling"], skipped: ["red", "Do not contact"], replied: ["green", "Replied"], draft: ["gray", "Writing"] };
  const pressKit = async () => {
    const k = await kit.mutateAsync({ organizationId: orgId, id: c.id });
    openDownload(await kitDoc.mutateAsync({ organizationId: orgId, id: k.id }));
  };
  return (
    <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <Box label="The plan">
          {edit ? (
            <Form>
              <Field id="cp-t" label="Title"><input id="cp-t" className="ld-in" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
              {([["goal", "Goal"], ["audience", "Audience"], ["story", "Main story"], ["founderAngle", "Founder angle"], ["proof", "Proof"], ["neverSay", "Never say"], ["order", "Order"]] as const).map(([k, l]) => (
                <Field key={k} id={`cp-${k}`} label={l}><input id={`cp-${k}`} className="ld-in" value={edit.plan[k]} onChange={(e) => setEdit({ ...edit, plan: { ...edit.plan, [k]: e.target.value } })} /></Field>
              ))}
              <Field id="cp-beats" label="Beats"><input id="cp-beats" className="ld-in" value={edit.plan.beats.join(", ")} onChange={(e) => setEdit({ ...edit, plan: { ...edit.plan, beats: e.target.value.split(",").map((b) => b.trimStart()) } })} /></Field>
              <b style={{ alignSelf: "start", paddingTop: 6 }}>Story angles</b>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {edit.angles.map((a, i) => (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "24px minmax(0,1fr)", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" aria-label={`Use angle ${i + 1}`} checked={a.use} style={{ accentColor: "var(--ld-accent)" }} onChange={(e) => setEdit({ ...edit, angles: edit.angles.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)) })} />
                    <input className="ld-in" aria-label={`Angle ${i + 1}`} value={a.text} onChange={(e) => setEdit({ ...edit, angles: edit.angles.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                  </div>
                ))}
              </div>
            </Form>
          ) : (
            <KV rows={[["Goal", P.goal], ["Audience", P.audience], ["Main story", P.story], ["Founder angle", P.founderAngle], ["Proof", P.proof], ["Beats", (P.beats ?? []).join(", ")], ["Never say", P.neverSay], ["Order", P.order]]} />
          )}
        </Box>
        {!edit && (
          <Box label="Story angles">
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.5 }}>
              {c.angles.map((a, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "70px minmax(0,1fr)", gap: 10, alignItems: "start" }}>
                  <span className={`ld-pill ${a.use ? "green" : "gray"}`}>{a.use ? "Using" : "Not used"}</span>
                  <span>{a.text}</span>
                </div>
              ))}
            </div>
          </Box>
        )}
        {c.pitches.length > 0 && (
          <Box label="Reporters and pitches">
            <div className="ld-press-pt" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) 60px 100px 170px 128px", gap: 10, fontSize: 13, alignItems: "center" }}>
              <b className="ld-lbl">Reporter</b><b className="ld-lbl">Fit</b><b className="ld-lbl">Pitch</b><b className="ld-lbl">Status</b><span />
              {c.pitches.map((p) => {
                const [sc, sl] = p.status === "cooling" ? ["gray", `Cooling until ${fmt(p.coolingUntil)}`] : STAT[p.status] ?? ["gray", p.status];
                return (
                  <React.Fragment key={p.id}>
                    <span><b>{p.name}</b>{p.outlet ? `, ${p.outlet}` : ""}</span>
                    <span>{p.fit}</span>
                    <span>{p.subject ? `${p.score} of 100` : ""}</span>
                    <span className={`ld-pill ${sc}`}>{sl}</span>
                    <button type="button" className="ld-btn sm" onClick={() => setPick(pick === p.id ? null : p.id)}>{pick === p.id ? "Close" : "Open"}</button>
                  </React.Fragment>
                );
              })}
            </div>
          </Box>
        )}
        {pitch && <PitchBox p={pitch} />}
        {pitch && pitch.rubric.length > 0 && <Rubric p={pitch} />}
        {add.isSuccess && !c.pitches.length && <span className="ld-small">Taylor is matching reporters and writing pitches. They show up here as they're ready.</span>}
        <ErrorLine error={save.error || add.error || approve.error || finish.error || kit.error || kitDoc.error} />
      </div>
      <Buttons>
        {edit ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: c.id, title: edit.title, plan: { ...edit.plan, beats: edit.plan.beats.map((b) => b.trim()).filter(Boolean) }, angles: edit.angles })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="ld-btn p" disabled={!ready || approve.isPending || paused} onClick={() => approve.mutate({ organizationId: orgId, id: c.id })}>{approve.isPending ? "Sending..." : `Approve ready (${ready})`}</button>
            <button type="button" className="ld-btn" onClick={() => setEdit({ title: c.title, plan: { ...c.plan, beats: c.plan.beats ?? [] }, angles: c.angles })}>Edit plan</button>
            <button type="button" className="ld-btn" disabled={add.isPending || paused} onClick={() => add.mutate({ organizationId: orgId, id: c.id })}>{add.isPending || add.isSuccess ? "Matching..." : "Add reporters"}</button>
            <button type="button" className="ld-btn" disabled={kit.isPending || kitDoc.isPending} onClick={() => void pressKit()}>{kit.isPending ? "Writing..." : "Press kit"}</button>
            {c.status !== "done" && <button type="button" className="ld-btn" disabled={finish.isPending} onClick={() => finish.mutate({ organizationId: orgId, id: c.id })}>Finish</button>}
          </>
        )}
      </Buttons>
    </div>
  );
}

// ==========================================
// Replies
// ==========================================

function Replies({ list }: { list: Reply[] }) {
  const [open, setOpen] = React.useState<number | null>((list.find((r) => r.status === "open" && r.draft) ?? list.find((r) => r.status === "open"))?.id ?? null);
  const COLS = "minmax(0,1.3fr) minmax(0,2fr) 150px 128px";
  return (
    <>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Reporter</span><span>What they said</span><span>Sorted as</span><span /></div>
        {list.length === 0 && <div className="ld-empty">No replies yet. When a reporter answers a pitch, Taylor reads it from the Press inbox, sorts it and drafts your answer.</div>}
        {list.map((r) => <ReplyRow key={r.id} r={r} cols={COLS} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
      </div>
      <span className="ld-small">Do not contact is saved for every desk at once. Out-of-office replies wait; a reporter who changed outlets gets their record updated.</span>
    </>
  );
}

function ReplyRow({ r, cols, open, onToggle }: { r: Reply; cols: string; open: boolean; onToggle: () => void }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [draft, setDraft] = React.useState<string | null>(null);
  const save = trpc.newsroom.editReply.useMutation({ onSuccess: async () => { setDraft(null); await refresh(); } });
  const approve = trpc.newsroom.approveReply.useMutation({ onSuccess: refresh });
  const done = trpc.newsroom.doneReply.useMutation({ onSuccess: refresh });
  const [kc, kl] = REPLY_KIND[r.kind] ?? ["gray", r.kind];
  return (
    <>
      <div className={`ld-rw ${open ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
        <span><b>{r.name}</b><br /><span className="ld-small">{[r.outlet, fmt(r.receivedAt)].filter(Boolean).join(" · ")}</span></span>
        <span style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>"{r.text.replace(/\s+/g, " ").slice(0, 220)}"</span>
        <span className={`ld-pill ${r.status === "sent" ? "green" : kc}`}>{r.status === "sent" ? "Answered" : r.status === "done" ? `${kl}, done` : kl}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <Box label={r.subject || "Their email"}><span style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-line" }}>{r.text}</span></Box>
            {r.kind === "crisis" ? (
              <div role="alert" style={{ background: "#fdeeee", border: "1px solid #f3cccc", borderRadius: 10, padding: "10px 12px", fontSize: 14, lineHeight: 1.5 }}><b>This is a crisis question.</b> Outreach on this desk is stopped, and Taylor won't answer it. Answer it yourself, with counsel if needed, then resume the desk in Press settings.</div>
            ) : r.kind === "dnc" ? (
              <span className="ld-small">Saved as Do not contact for every desk.</span>
            ) : draft !== null ? (
              <Box label="Reply draft"><textarea className="ld-in" aria-label="Reply draft" rows={6} style={TA} value={draft} onChange={(e) => setDraft(e.target.value)} /></Box>
            ) : r.draft ? (
              <Box label="Reply draft"><span style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: "pre-line" }}>{r.draft}</span>{r.kind === "interview" && <span className="ld-small">Times come from Avery's view of your calendars. When they pick one, it lands on Interviews with a briefing.</span>}</Box>
            ) : null}
            <ErrorLine error={save.error || approve.error || done.error} />
          </div>
          <Buttons>
            {draft !== null ? (
              <>
                <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: r.id, draft })}>Save</button>
                <button type="button" className="ld-btn" onClick={() => setDraft(null)}>Cancel</button>
              </>
            ) : (
              <>
                {r.kind !== "crisis" && r.draft && r.status === "open" && <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: orgId, id: r.id })}>{approve.isPending ? "Sending..." : "Approve reply"}</button>}
                {r.kind !== "crisis" && r.kind !== "dnc" && r.status === "open" && <button type="button" className="ld-btn" onClick={() => setDraft(r.draft ?? "")}>Edit reply</button>}
                {r.status === "open" && <button type="button" className="ld-btn" disabled={done.isPending} onClick={() => done.mutate({ organizationId: orgId, id: r.id })}>Done</button>}
              </>
            )}
          </Buttons>
        </div>
      )}
    </>
  );
}

// ==========================================
// Interviews
// ==========================================

type IvEdit = { title: string; at: string; place: string; b: Interview["briefing"] };

function Interviews({ v, list, contacts }: { v: View; list: Interview[]; contacts: Contact[] }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [open, setOpen] = React.useState<number | null>(list.find((i) => i.status === "upcoming")?.id ?? null);
  const [adding, setAdding] = React.useState<null | { contactId: string; title: string; at: string; place: string }>(null);
  const add = trpc.newsroom.addInterview.useMutation({ onSuccess: async (i) => { setAdding(null); setOpen(i.id); await refresh(); } });
  const COLS = "minmax(0,2fr) 210px 170px 128px";
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="ld-btn p" onClick={() => setAdding({ contactId: "", title: "", at: "", place: "" })}>Add interview</button>
      </div>
      {adding && (
        <div className="ld-card ld-resultcard" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <span className="ld-lbl">Add interview</span>
            <Form>
              <Field id="iv-c" label="Reporter">
                <select id="iv-c" className="ld-in" style={{ maxWidth: 360 }} value={adding.contactId} onChange={(e) => { const c = contacts.find((x) => String(x.id) === e.target.value); setAdding({ ...adding, contactId: e.target.value, title: c ? `${c.name}${c.outlet ? `, ${c.outlet}` : ""}` : adding.title }); }}>
                  <option value="">Not on the media list</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.outlet ? `, ${c.outlet}` : ""}</option>)}
                </select>
              </Field>
              <Field id="iv-t" label="Interview"><input id="iv-t" className="ld-in" style={{ maxWidth: 360 }} value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} /></Field>
              <Field id="iv-a" label="When"><input id="iv-a" className="ld-in" style={{ maxWidth: 220 }} placeholder="10/08/2026 10:00 AM" value={adding.at} onChange={(e) => setAdding({ ...adding, at: e.target.value })} /></Field>
              <Field id="iv-p" label="Where"><input id="iv-p" className="ld-in" style={{ maxWidth: 360 }} placeholder="Zoom" value={adding.place} onChange={(e) => setAdding({ ...adding, place: e.target.value })} /></Field>
            </Form>
            <ErrorLine error={add.error} />
          </div>
          <Buttons>
            <button type="button" className="ld-btn p" disabled={add.isPending || !adding.title.trim()} onClick={() => add.mutate({ organizationId: orgId, contactId: adding.contactId ? Number(adding.contactId) : null, title: adding.title, at: typedToIso(adding.at), place: adding.place })}>{add.isPending ? "Briefing..." : "Save"}</button>
            <button type="button" className="ld-btn" onClick={() => setAdding(null)}>Cancel</button>
          </Buttons>
        </div>
      )}
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Interview</span><span>When</span><span>Desk</span><span /></div>
        {list.length === 0 && <div className="ld-empty">No interviews yet. When a reporter books one, it lands here with a briefing.</div>}
        {list.map((i) => (
          <React.Fragment key={i.id}>
            <div className={`ld-rw ${open === i.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <b style={{ overflowWrap: "anywhere" }}>{i.title}{i.status === "done" ? " (done)" : ""}</b>
              <span>{fmtWhen(i.at)}</span>
              <DeskPill id={orgId} desks={v.desks} />
              <button type="button" className="ld-btn" onClick={() => setOpen(open === i.id ? null : i.id)}>{open === i.id ? "Close" : "Open"}</button>
            </div>
            {open === i.id && <InterviewDetail i={i} />}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

function InterviewDetail({ i }: { i: Interview }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [e, setE] = React.useState<IvEdit | null>(null);
  const save = trpc.newsroom.saveInterview.useMutation({ onSuccess: async () => { setE(null); await refresh(); } });
  const done = trpc.newsroom.finishInterview.useMutation({ onSuccess: refresh });
  const rebuild = trpc.newsroom.rebuildBriefing.useMutation({ onSuccess: refresh });
  const doc = trpc.newsroom.briefingDocx.useMutation({ onSuccess: (r) => openDownload(r) });
  const b = i.briefing;
  return (
    <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {e ? (
          <Box>
            <Form>
              <Field id="ie-t" label="Interview"><input id="ie-t" className="ld-in" value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} /></Field>
              <Field id="ie-a" label="When"><input id="ie-a" className="ld-in" style={{ maxWidth: 220 }} placeholder="10/08/2026 10:00 AM" value={e.at} onChange={(x) => setE({ ...e, at: x.target.value })} /></Field>
              <Field id="ie-p" label="Where"><input id="ie-p" className="ld-in" style={{ maxWidth: 360 }} value={e.place} onChange={(x) => setE({ ...e, place: x.target.value })} /></Field>
              {[0, 1, 2].map((n) => (
                <Field key={n} id={`ie-pt${n}`} label={`Point ${n + 1}`}><input id={`ie-pt${n}`} className="ld-in" value={e.b.points[n] ?? ""} onChange={(x) => { const points = [...e.b.points]; points[n] = x.target.value; setE({ ...e, b: { ...e.b, points } }); }} /></Field>
              ))}
              {e.b.hard.map((h, n) => (
                <Field key={n} id={`ie-h${n}`} label={h.q} top><textarea id={`ie-h${n}`} className="ld-in" rows={2} style={TA} placeholder="Your approved answer" value={h.answer} onChange={(x) => setE({ ...e, b: { ...e.b, hard: e.b.hard.map((y, j) => (j === n ? { ...y, answer: x.target.value, approved: false } : y)) } })} /></Field>
              ))}
              <Field id="ie-dc" label="Don't claim"><input id="ie-dc" className="ld-in" value={e.b.dontClaim} onChange={(x) => setE({ ...e, b: { ...e.b, dontClaim: x.target.value } })} /></Field>
              <Field id="ie-bio" label="Bio to send"><input id="ie-bio" className="ld-in" value={e.b.bio} onChange={(x) => setE({ ...e, b: { ...e.b, bio: x.target.value } })} /></Field>
              <Field id="ie-af" label="After"><input id="ie-af" className="ld-in" value={e.b.after} onChange={(x) => setE({ ...e, b: { ...e.b, after: x.target.value } })} /></Field>
            </Form>
            <span className="ld-small">Answers you write here are saved to your library as approved answers for the next interview.</span>
          </Box>
        ) : (
          <>
            <Box label="Who you're talking to"><span style={{ fontSize: 14, lineHeight: 1.6 }}>{b.reporter || "Writing the briefing..."}</span></Box>
            {b.points.length > 0 && <Box label="Three points to land"><ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, listStyle: "decimal" }}>{b.points.map((p, n) => <li key={n}>{p}</li>)}</ol></Box>}
            {b.likely.length > 0 && <Box label="Likely questions"><div style={{ fontSize: 14, lineHeight: 1.7 }}>{b.likely.join(" · ")}</div></Box>}
            {b.hard.length > 0 && <Box label="Hard questions and your approved answers"><KV rows={b.hard.map((h) => [h.q, h.answer || "[Your approved answer]"] as [string, string])} /></Box>}
            {b.dontClaim && <Box label="Don't claim"><span style={{ fontSize: 14, lineHeight: 1.6 }}>{b.dontClaim}</span></Box>}
            <Box label="Logistics"><KV rows={[["Where", i.place || b.where], ["Bio to send", b.bio], ["After", b.after]]} /></Box>
          </>
        )}
        <ErrorLine error={save.error || done.error || rebuild.error || doc.error} />
      </div>
      <Buttons>
        {e ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: i.id, title: e.title, at: typedToIso(e.at), place: e.place, briefing: { ...e.b, points: e.b.points.filter((p) => p.trim()) } })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setE(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" className="ld-btn p" disabled={doc.isPending} onClick={() => doc.mutate({ organizationId: orgId, id: i.id })}>Download</button>
            <button type="button" className="ld-btn" onClick={() => setE({ title: i.title, at: toTyped(i.at), place: i.place, b: { ...b, points: [...b.points, "", "", ""].slice(0, 3) } })}>Edit</button>
            <button type="button" className="ld-btn" disabled={rebuild.isPending} onClick={() => rebuild.mutate({ organizationId: orgId, id: i.id })}>{rebuild.isPending ? "Writing..." : "Rewrite"}</button>
            {i.status === "upcoming" && <button type="button" className="ld-btn" disabled={done.isPending} onClick={() => done.mutate({ organizationId: orgId, id: i.id })}>Mark done</button>}
          </>
        )}
      </Buttons>
    </div>
  );
}

// ==========================================
// Coverage
// ==========================================

function Coverage({ v, data }: { v: View; data: N["coverage"] | undefined }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const [url, setUrl] = React.useState("");
  const [open, setOpen] = React.useState<number | null>(null);
  const add = trpc.newsroom.addCoverage.useMutation({ onSuccess: async (c) => { setUrl(""); setOpen(c.id); await refresh(); } });
  const s = data?.stats;
  const COLS = "minmax(0,2fr) minmax(0,1fr) 130px 170px 128px";
  return (
    <>
      <div className="ld-press-stats" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 12 }}>
        {([["Placements", s?.placements ?? 0], ["Interviews", s?.interviews ?? 0], ["Reply rate", `${s?.replyRate ?? 0}%`], ["Warm reporters", s?.warm ?? 0], ["Demos from press", s?.demos ?? 0]] as [string, string | number][]).map(([l, n]) => (
          <div key={l} className="ld-card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 }}><span className="ld-lbl">{l}</span><b style={{ fontSize: 24 }}>{n}</b></div>
        ))}
      </div>
      <div className="ld-card ld-resultcard" style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <label htmlFor="cv-url" className="ld-lbl" style={{ whiteSpace: "nowrap" }}>Story that ran</label>
          <input id="cv-url" className="ld-in" placeholder="Paste the article link" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <button type="button" className="ld-btn p" disabled={add.isPending || !/^https?:\/\//.test(url.trim())} onClick={() => add.mutate({ organizationId: orgId, url: url.trim() })}>{add.isPending ? "Reading..." : "Add story"}</button>
        <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={add.error} /></div>
      </div>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}><span>Story</span><span>Outlet</span><span>Ran</span><span>Desk</span><span /></div>
        {(data?.list ?? []).length === 0 && <div className="ld-empty">No coverage yet. Taylor logs stories that quote you when she scouts, or paste a link above.</div>}
        {(data?.list ?? []).map((c) => (
          <React.Fragment key={c.id}>
            <div className={`ld-rw ${open === c.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
              <b style={{ overflowWrap: "anywhere" }}>{c.headline}</b>
              <span>{c.outlet}</span>
              <span>{c.ranOn}</span>
              <DeskPill id={orgId} desks={v.desks} />
              <button type="button" className="ld-btn" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Close" : "Open"}</button>
            </div>
            {open === c.id && <CoverageDetail c={c} />}
          </React.Fragment>
        ))}
      </div>
    </>
  );
}

function CoverageDetail({ c }: { c: N["coverage"]["list"][number] }) {
  const orgId = useOrg();
  const refresh = useRefresh();
  const d = c.details;
  const [e, setE] = React.useState<null | { headline: string; outlet: string; ranOn: string; quotesUsed: string; visits: string; demos: string; backlink: boolean }>(null);
  const save = trpc.newsroom.saveCoverage.useMutation({ onSuccess: async () => { setE(null); await refresh(); } });
  const remove = trpc.newsroom.removeCoverage.useMutation({ onSuccess: refresh });
  return (
    <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
      <Box>
        {e ? (
          <Form>
            <Field id="ce-h" label="Headline"><input id="ce-h" className="ld-in" value={e.headline} onChange={(x) => setE({ ...e, headline: x.target.value })} /></Field>
            <Field id="ce-o" label="Outlet"><input id="ce-o" className="ld-in" style={{ maxWidth: 360 }} value={e.outlet} onChange={(x) => setE({ ...e, outlet: x.target.value })} /></Field>
            <Field id="ce-r" label="Ran"><input id="ce-r" className="ld-in" style={{ maxWidth: 220 }} placeholder="Oct 12, 2026" value={e.ranOn} onChange={(x) => setE({ ...e, ranOn: x.target.value })} /></Field>
            <Field id="ce-q" label="Your quotes used"><input id="ce-q" className="ld-in" style={{ maxWidth: 220 }} value={e.quotesUsed} onChange={(x) => setE({ ...e, quotesUsed: x.target.value })} /></Field>
            <b>Link back</b>
            <Seg label="Link back" value={e.backlink ? "yes" : "no"} onChange={(x) => setE({ ...e, backlink: x === "yes" })} options={[{ key: "yes", label: "Yes" }, { key: "no", label: "No" }]} />
            <Field id="ce-v" label="Visits"><input id="ce-v" className="ld-in" style={{ width: 120 }} inputMode="numeric" value={e.visits} onChange={(x) => setE({ ...e, visits: x.target.value.replace(/\D/g, "") })} /></Field>
            <Field id="ce-d" label="Demo requests"><input id="ce-d" className="ld-in" style={{ width: 120 }} inputMode="numeric" value={e.demos} onChange={(x) => setE({ ...e, demos: x.target.value.replace(/\D/g, "") })} /></Field>
          </Form>
        ) : (
          <KV
            rows={[
              ["Reporter", c.reporter],
              ["Campaign", c.campaign],
              ["Your quotes used", d.quotesUsed ?? ""],
              ["Messages that made it", [d.messagesIn, d.messagesMissed ? `Missed: ${d.messagesMissed}` : ""].filter(Boolean).join(". ")],
              ["Link back", d.backlink === undefined ? "" : d.backlink ? "Yes" : "No"],
              ["Results", d.visits || d.demos ? `${d.visits ?? 0} visits, ${d.demos ?? 0} demo requests` : "Add visits and demo requests with Edit"],
            ]}
          />
        )}
        <ErrorLine error={save.error || remove.error} />
      </Box>
      <Buttons>
        {e ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: c.id, headline: e.headline, outlet: e.outlet, ranOn: e.ranOn, details: { quotesUsed: e.quotesUsed, backlink: e.backlink, visits: Number(e.visits || 0), demos: Number(e.demos || 0) } })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setE(null)}>Cancel</button>
            <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: c.id })}>Remove</button>
          </>
        ) : (
          <>
            {c.url && <a className="ld-btn ld-av-link-plain" href={c.url} target="_blank" rel="noreferrer noopener">Open story</a>}
            <button type="button" className="ld-btn" onClick={() => setE({ headline: c.headline, outlet: c.outlet, ranOn: c.ranOn, quotesUsed: d.quotesUsed ?? "", visits: String(d.visits ?? 0), demos: String(d.demos ?? 0), backlink: Boolean(d.backlink) })}>Edit</button>
          </>
        )}
      </Buttons>
    </div>
  );
}

// ==========================================
// Library
// ==========================================

type LibTab = "quote" | "bio" | "story" | "moment" | "kit" | "answer";
type LibEdit = { id?: number; kind: LibTab; topic: string; text: string; meta: Record<string, unknown>; approved: boolean };
const LENGTHS = ["25", "50", "100", "150", "full"];
const ANGLES = ["Founder", "Clinical", "Relationships", "Workplace", "Tech"];

function Library() {
  const orgId = useOrg();
  const refresh = useRefresh();
  const q = trpc.newsroom.library.useQuery({ organizationId: orgId });
  const desks = trpc.newsroom.view.useQuery({ organizationId: orgId }).data?.desks ?? [];
  const [tab, setTab] = React.useState<LibTab>("quote");
  const [edit, setEdit] = React.useState<LibEdit | null>(null);
  const fill = trpc.newsroom.fillLibrary.useMutation({ onSuccess: refresh });
  const planMoment = trpc.newsroom.planMoment.useMutation({ onSuccess: refresh });
  const planStory = trpc.newsroom.planCampaign.useMutation({ onSuccess: refresh });
  const kitDoc = trpc.newsroom.kitDocx.useMutation({ onSuccess: (r) => openDownload(r) });
  const all = q.data ?? [];
  const of = (k: LibTab) => all.filter((x) => x.kind === k);
  const count = (k: LibTab) => of(k).length;
  const save = trpc.newsroom.saveLibrary.useMutation({ onSuccess: async () => { setEdit(null); await refresh(); } });
  const remove = trpc.newsroom.removeLibrary.useMutation({ onSuccess: async () => { setEdit(null); await refresh(); } });

  const editor = (e: LibEdit) => (
    <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
      <Box>
        <Form>
          {e.kind !== "bio" && <Field id="lb-t" label={e.kind === "answer" ? "Question" : e.kind === "quote" ? "Topic" : "Title"}><input id="lb-t" className="ld-in" value={e.topic} onChange={(x) => setE(e, { topic: x.target.value })} /></Field>}
          <Field id="lb-x" label={e.kind === "quote" ? "Quote" : e.kind === "bio" ? `${e.topic}, ${String(e.meta.length)} words` : e.kind === "answer" ? "Answer" : e.kind === "moment" ? "Angle" : "Text"} top>
            <textarea id="lb-x" className="ld-in" rows={e.kind === "kit" ? 14 : 3} style={TA} value={e.text} onChange={(x) => setE(e, { text: x.target.value })} />
          </Field>
          {e.kind === "quote" && (
            <>
              <b>Desks</b>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {desks.map((d) => {
                  const list = (e.meta.desks as number[] | undefined) ?? [];
                  const on = list.includes(d.id);
                  return <button key={d.id} type="button" aria-pressed={on} className="ld-sug" style={{ borderRadius: 8, height: 32, fontWeight: 700, background: on ? "var(--ld-accent-bg)" : "#fff", borderColor: on ? "var(--ld-accent)" : undefined, color: on ? "var(--ld-accent-dark)" : "var(--ld-ink)" }} onClick={() => setE(e, { meta: { ...e.meta, desks: on ? list.filter((x) => x !== d.id) : [...list, d.id] } })}>{d.name}</button>;
                })}
              </div>
            </>
          )}
          {e.kind === "moment" && (
            <>
              <Field id="lb-pb" label="Pitch by"><input id="lb-pb" className="ld-in" style={{ maxWidth: 220 }} placeholder="Jan 5, 2027" value={String(e.meta.pitchBy ?? "")} onChange={(x) => setE(e, { meta: { ...e.meta, pitchBy: x.target.value, alerted: false } })} /></Field>
              <b>Lead</b>
              <Seg label="Lead" value={String(e.meta.lead ?? "short")} onChange={(x) => setE(e, { meta: { ...e.meta, lead: x } })} options={[{ key: "short", label: "Short" }, { key: "long", label: "Long" }]} />
            </>
          )}
          {e.kind !== "moment" && (
            <>
              <b>Approved</b>
              <Seg label="Approved" value={e.approved ? "yes" : "no"} onChange={(x) => setE(e, { approved: x === "yes" })} options={[{ key: "yes", label: "Approved" }, { key: "no", label: "Draft" }]} />
            </>
          )}
        </Form>
        <ErrorLine error={save.error || remove.error} />
      </Box>
      <Buttons>
        <button type="button" className="ld-btn p" disabled={save.isPending || !e.text.trim()} onClick={() => save.mutate({ organizationId: orgId, ...e })}>Save</button>
        <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
        {e.id && <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: orgId, id: e.id! })}>Remove</button>}
      </Buttons>
    </div>
  );
  function setE(e: LibEdit, patch: Partial<LibEdit>) {
    setEdit({ ...e, ...patch });
  }
  const startEdit = (x: Lib) => setEdit({ id: x.id, kind: x.kind as LibTab, topic: x.topic, text: x.text, meta: x.meta, approved: x.approved });
  const rows = (k: LibTab, cols: string, head: string[], cells: (x: Lib) => React.ReactNode[], extra?: (x: Lib) => React.ReactNode) => (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: cols }}>{head.map((h, i) => <span key={i}>{h}</span>)}</div>
      {of(k).length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : "Nothing here yet."}</div>}
      {of(k).map((x) => (
        <React.Fragment key={x.id}>
          <div className={`ld-rw ${edit?.id === x.id ? "open" : ""}`} style={{ gridTemplateColumns: cols }}>
            {cells(x)}
            {extra ? extra(x) : <button type="button" className="ld-btn" onClick={() => (edit?.id === x.id ? setEdit(null) : startEdit(x))}>{edit?.id === x.id ? "Close" : "Edit"}</button>}
          </div>
          {edit?.id === x.id && editor(edit)}
        </React.Fragment>
      ))}
    </>
  );
  const bios = of("bio");
  return (
    <>
      <FolderTabs
        value={tab}
        onChange={(t) => { setTab(t); setEdit(null); }}
        tabs={[
          { key: "quote", label: `Quote bank (${count("quote")})` },
          { key: "bio", label: `Bios (${count("bio")})` },
          { key: "story", label: `Story bank (${count("story")})` },
          { key: "moment", label: `Calendar (${count("moment")})` },
          { key: "kit", label: `Press kits (${count("kit")})` },
          { key: "answer", label: `Answers (${count("answer")})` },
        ]}
      >
        {tab === "quote" && rows("quote", "170px minmax(0,2fr) 140px 128px", ["Topic", "What you said", "Approved", ""], (x) => [<b key="t">{x.topic}</b>, <span key="q">"{x.text}"</span>, <span key="a">{x.approved ? fmt(x.updatedAt) : <span className="ld-pill amber">Draft</span>}</span>])}
        {tab === "bio" && (
          <>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #eef2f0" }}>
              <div className="ld-press-bios" style={{ display: "grid", gridTemplateColumns: "150px repeat(5, minmax(0,1fr))", gap: 8, fontSize: 13, alignItems: "center" }}>
                <span />{LENGTHS.map((l) => <b key={l}>{l === "full" ? "Full" : `${l} words`}</b>)}
                {ANGLES.map((a) => (
                  <React.Fragment key={a}>
                    <b>{a}</b>
                    {LENGTHS.map((l) => {
                      const b = bios.find((x) => x.topic === a && String(x.meta.length) === l);
                      return <span key={l} className={`ld-pill ${b ? (b.approved ? "green" : "gray") : "gray"}`} style={{ justifySelf: "start" }}>{b ? (b.approved ? "Ready" : "Draft") : "None"}</span>;
                    })}
                  </React.Fragment>
                ))}
              </div>
            </div>
            {rows("bio", "150px 100px minmax(0,2fr) 128px", ["Angle", "Length", "Bio", ""], (x) => [<b key="a">{x.topic}</b>, <span key="l">{x.meta.length === "full" ? "Full" : `${String(x.meta.length)} words`}</span>, <span key="t" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.text}</span>])}
          </>
        )}
        {tab === "story" && rows("story", "minmax(0,1.4fr) minmax(0,2fr) 128px 128px", ["Story", "Angle", "", ""], (x) => [<b key="t">{x.topic}</b>, <span key="a">{x.text}</span>, <button key="p" type="button" className="ld-btn" disabled={planStory.isPending} onClick={() => planStory.mutate({ organizationId: orgId, brief: `${x.topic}. ${x.text}` })}>Plan</button>])}
        {tab === "moment" && rows("moment", "minmax(0,2fr) 150px 100px 128px 128px", ["Moment", "Pitch by", "Lead", "", ""], (x) => [<b key="t">{x.topic}</b>, <span key="d">{String(x.meta.pitchBy ?? "")}</span>, <span key="l">{x.meta.lead === "long" ? "Long" : "Short"}</span>, <button key="p" type="button" className="ld-btn" disabled={planMoment.isPending} onClick={() => planMoment.mutate({ organizationId: orgId, id: x.id })}>Plan</button>])}
        {tab === "kit" && rows("kit", "minmax(0,2fr) 140px 128px 128px", ["Campaign", "Updated", "", ""], (x) => [<b key="t">{x.topic}</b>, <span key="u">{fmt(x.updatedAt)}</span>, <button key="d" type="button" className="ld-btn" disabled={kitDoc.isPending} onClick={() => kitDoc.mutate({ organizationId: orgId, id: x.id })}>Download</button>])}
        {tab === "answer" && rows("answer", "minmax(0,1.3fr) minmax(0,2fr) 128px", ["Question", "Your answer", ""], (x) => [<b key="q">{x.topic}</b>, <span key="a">{x.text}</span>])}
        {edit && !edit.id && editor(edit)}
      </FolderTabs>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {tab === "quote" && <button type="button" className="ld-btn p" onClick={() => setEdit({ kind: "quote", topic: "", text: "", meta: { desks: [orgId] }, approved: true })}>Add quote</button>}
        {tab === "answer" && <button type="button" className="ld-btn p" onClick={() => setEdit({ kind: "answer", topic: "", text: "", meta: {}, approved: true })}>Add answer</button>}
        {tab === "bio" && <button type="button" className="ld-btn p" disabled={fill.isPending} onClick={() => fill.mutate({ organizationId: orgId, what: "bios" })}>{fill.isPending ? "Writing..." : "Write bios"}</button>}
        {tab === "story" && <button type="button" className="ld-btn p" disabled={fill.isPending} onClick={() => fill.mutate({ organizationId: orgId, what: "stories" })}>{fill.isPending ? "Writing..." : "Fill story bank"}</button>}
        {tab === "moment" && <button type="button" className="ld-btn p" disabled={fill.isPending} onClick={() => fill.mutate({ organizationId: orgId, what: "calendar" })}>{fill.isPending ? "Building..." : "Build calendar"}</button>}
        <span className="ld-small">
          {tab === "quote" ? "Taylor writes pitches from these. A quote she drafts stays a draft until you approve it." : tab === "moment" ? "Taylor tells you 6 weeks before each pitch-by date. Plan turns a moment into a campaign." : tab === "kit" ? "Press kits are made from a campaign's Press kit button." : tab === "answer" ? "Your answers to hard questions. Interview briefings use them word for word." : tab === "bio" ? "Drafts are written from your Brain. Approve each one you want Taylor to use." : "Ideas Taylor can pitch any time. Plan turns one into a campaign."}
        </span>
      </div>
      <ErrorLine error={fill.error || planMoment.error || planStory.error || kitDoc.error} />
    </>
  );
}
