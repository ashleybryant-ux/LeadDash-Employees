import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import type { Outputs } from "../types";

type M = Outputs["coo"]["meetings"]["upcoming"][number];
type Tab = "upcoming" | "sitting" | "notes" | "past" | "scorecard";
type NT = Outputs["coo"]["notetaker"]["upcoming"][number];

const day = (d: Date | string | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const time = (d: Date | string | number, tz: string) => new Date(d).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const mdy = (d: Date | string | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", year: "numeric" });
const hhmm = (d: Date | string | number, tz: string) => new Date(d).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const TIMES = Array.from({ length: 27 }, (_, i) => {
  const mins = 7 * 60 + i * 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return { v: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, label: `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` };
});
const LENGTHS = [15, 30, 45, 60, 90];
const firstNames = (list: { name: string }[]) => list.map((a) => a.name.split(" ")[0]).join(", ");

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

export function AgendaList({ items }: { items: { at: string; item: string; who: string; minutes: number }[] }) {
  if (!items.length) return <span className="ld-body ld-muted">The agenda is written the day before.</span>;
  return (
    <div className="ld-keep ld-agenda" style={{ display: "grid", gridTemplateColumns: "60px minmax(0,1fr) minmax(0,150px) 60px", gap: "6px 12px", fontSize: 14, lineHeight: 1.5 }}>
      {items.map((a, i) => (
        <React.Fragment key={i}>
          <span className="ld-muted">{a.at}</span>
          <b>{a.item}</b>
          <span className="ld-ag-who">{a.who}</span>
          <span className="ld-muted ld-ag-min">{`${a.minutes} min`}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function meetingStatus(m: Pick<M, "status" | "agenda" | "startsAt" | "actionItems" | "notes">, tz: string, past = false) {
  if (past) return m.actionItems.length ? { l: `${m.actionItems.length} action item${m.actionItems.length === 1 ? "" : "s"}`, c: "green" } : { l: "Add notes", c: "amber" };
  if (m.status === "invited") return { l: "Invites sent", c: "green" };
  if (m.agenda.length) return { l: "Invite not sent", c: "amber" };
  return { l: `Agenda ${new Date(new Date(m.startsAt).getTime() - 86_400_000).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })}`, c: "gray" };
}

/** Simone's Work tab: meetings coming up, past meetings and their action items, and the scorecard. */
export default function Meetings({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const q = trpc.coo.meetings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const nt = trpc.coo.notetaker.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const [tab, setTab] = React.useState<Tab>(() => {
    const t = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("tab") : null;
    return t === "sitting" || t === "notes" || t === "past" || t === "scorecard" ? t : "upcoming";
  });
  const data = q.data;
  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "upcoming", label: `Upcoming (${data?.upcoming.length ?? 0})` },
          { key: "sitting", label: `Sitting in (${nt.data?.upcoming.length ?? 0})` },
          { key: "notes", label: `Notes (${nt.data?.notes.length ?? 0})` },
          { key: "past", label: `Past (${data?.past.length ?? 0})` },
          { key: "scorecard", label: "Scorecard" },
        ]}
      >
        {tab === "upcoming" && <List list={data?.upcoming ?? []} tz={tz} loading={q.isLoading} emp={emp} />}
        {tab === "sitting" && <SittingIn list={nt.data?.upcoming ?? []} tz={tz} loading={nt.isLoading} emp={emp} />}
        {tab === "notes" && <NotesList list={nt.data?.notes ?? []} tz={tz} loading={nt.isLoading} emp={emp} />}
        {tab === "past" && <List list={data?.past ?? []} tz={tz} loading={q.isLoading} emp={emp} past />}
        {tab === "scorecard" && <Scorecard />}
      </FolderTabs>
    </main>
  );
}

const MQ = "minmax(0,1.6fr) 240px minmax(0,1fr) 140px 128px";

function List({ list, tz, loading, emp, past = false }: { list: M[]; tz: string; loading: boolean; emp: EmployeeRow; past?: boolean }) {
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: MQ }}>
        <span>Meeting</span>
        <span>When</span>
        <span>Who</span>
        <span>Status</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : past ? "No past meetings yet." : `No meetings coming up. Add repeating meetings on ${emp.name}'s Onboarding tab, or ask ${emp.name} in Chat to schedule one.`}</div>}
      {list.map((m) => {
        const isOpen = open === m.id;
        const st = meetingStatus(m, tz, past);
        return (
          <React.Fragment key={m.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: MQ, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a,input,select,textarea")) return; setOpen(isOpen ? null : m.id); }}>
              <span className="ld-strong">{m.title}</span>
              <span>{`${day(m.startsAt, tz)} · ${time(m.startsAt, tz)}`}</span>
              <span>{firstNames(m.attendees) || "No one yet"}</span>
              <span className={`ld-pill ${st.c}`}>{st.l}</span>
              <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : m.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && (past ? <PastMeeting m={m} tz={tz} onClose={() => setOpen(null)} /> : <UpcomingMeeting m={m} tz={tz} />)}
          </React.Fragment>
        );
      })}
    </>
  );
}

// ==========================================
// Upcoming: agenda, link, invites, Edit
// ==========================================

function UpcomingMeeting({ m, tz }: { m: M; tz: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const settings = trpc.coo.settings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const refresh = () => utils.coo.invalidate();
  const invite = trpc.coo.sendInvite.useMutation({ onSuccess: refresh });
  const cancel = trpc.coo.cancelMeeting.useMutation({ onSuccess: refresh });
  const rebuild = trpc.coo.rebuildAgenda.useMutation({ onSuccess: refresh });
  const save = trpc.coo.editMeeting.useMutation({ onSuccess: async () => { setEditing(false); await refresh(); } });
  const [editing, setEditing] = React.useState(false);
  const [d, setD] = React.useState({ title: "", date: "", time: "", minutes: 30, attendees: [] as string[], agenda: [] as { item: string; who: string; minutes: number }[] });
  const begin = () => {
    setD({ title: m.title, date: mdy(m.startsAt, tz), time: hhmm(m.startsAt, tz), minutes: m.minutes, attendees: m.attendees.map((a) => a.email), agenda: m.agenda.map((a) => ({ item: a.item, who: a.who, minutes: a.minutes })) });
    setEditing(true);
  };
  const err = invite.error || cancel.error || rebuild.error || save.error;
  const agendaOut = new Date(new Date(m.startsAt).getTime() - 86_400_000);

  if (editing) {
    const total = d.agenda.reduce((s, a) => s + a.minutes, 0);
    return (
      <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px 128px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <span className="ld-lbl">Agenda</span>
          {d.agenda.map((a, i) => (
            <div key={i} className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px 84px 96px", gap: 8, alignItems: "center" }}>
              <input className="ld-in" aria-label="Agenda item" value={a.item} onChange={(e) => setD({ ...d, agenda: d.agenda.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)) })} />
              <input className="ld-in" aria-label="Who" value={a.who} onChange={(e) => setD({ ...d, agenda: d.agenda.map((x, j) => (j === i ? { ...x, who: e.target.value } : x)) })} />
              <select className="ld-in" aria-label="Minutes" value={a.minutes} onChange={(e) => setD({ ...d, agenda: d.agenda.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)) })}>
                {[5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{`${n} min`}</option>)}
              </select>
              <button type="button" className="ld-btn" style={{ width: 96 }} onClick={() => setD({ ...d, agenda: d.agenda.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <div className="ld-row" style={{ gap: 12, alignItems: "center" }}>
            <button type="button" className="ld-btn" style={{ width: 128 }} onClick={() => setD({ ...d, agenda: [...d.agenda, { item: "", who: "", minutes: 5 }] })}>Add item</button>
            <span className="ld-small" style={{ color: total > d.minutes ? "#b42318" : "#5b6b64" }}>{`${total} of ${d.minutes} minutes`}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="ld-field"><label className="ld-lbl" htmlFor={`mt-${m.id}`}>Meeting</label><input id={`mt-${m.id}`} className="ld-in" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></div>
          <div className="ld-field"><label className="ld-lbl" htmlFor={`md-${m.id}`}>Date</label><input id={`md-${m.id}`} className="ld-in" placeholder="MM/DD/YYYY" aria-label="Date MM/DD/YYYY" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></div>
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div className="ld-field"><label className="ld-lbl" htmlFor={`mh-${m.id}`}>Time</label><select id={`mh-${m.id}`} className="ld-in" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })}>{(TIMES.some((t) => t.v === d.time) ? TIMES : [{ v: d.time, label: d.time }, ...TIMES]).map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</select></div>
            <div className="ld-field"><label className="ld-lbl" htmlFor={`ml-${m.id}`}>Length</label><select id={`ml-${m.id}`} className="ld-in" value={d.minutes} onChange={(e) => setD({ ...d, minutes: Number(e.target.value) })}>{LENGTHS.map((n) => <option key={n} value={n}>{`${n} min`}</option>)}</select></div>
          </div>
          <div className="ld-field">
            <span className="ld-lbl">Who attends</span>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              {(settings.data?.people ?? []).map((p) => {
                const on = d.attendees.includes(p.email);
                return <button key={p.email} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setD({ ...d, attendees: on ? d.attendees.filter((x) => x !== p.email) : [...d.attendees, p.email] })}>{p.name}</button>;
              })}
            </div>
          </div>
          <ErrorLine error={err} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: m.id, title: d.title, date: d.date, time: d.time, minutes: d.minutes, attendees: d.attendees, agenda: d.agenda.filter((a) => a.item.trim()) })}>Save</button>
          <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px 128px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <span className="ld-lbl">Agenda</span>
        <AgendaList items={m.agenda} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <KV label="Link">{m.link ? m.link.replace(/^https?:\/\//, "") : m.linkKind === "zoom" ? "Zoom link is made when the invite goes out" : "Google Meet link is made when the invite goes out"}</KV>
        <KV label="Invites">{m.inviteSentAt ? `Sent ${day(m.inviteSentAt, tz)} at ${time(m.inviteSentAt, tz)}.` : "Not sent yet."}</KV>
        {!m.inviteSentAt && <KV label="Agenda">{m.agenda.length ? "Written. Press Send invite and it goes out with the link." : `Written ${day(agendaOut, tz)} at 4:00 PM.`}</KV>}
        <KV label="Who">{m.attendees.map((a) => a.name).join(", ") || "No one yet"}</KV>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {m.status === "invited" && m.link ? (
          <a className="ld-btn p" href={m.link} target="_blank" rel="noreferrer noopener">Join</a>
        ) : (
          <button type="button" className="ld-btn p" disabled={invite.isPending} onClick={() => invite.mutate({ organizationId: currentOrgId, id: m.id })}>{invite.isPending ? "Sending..." : "Send invite"}</button>
        )}
        {m.agenda.length === 0 && <button type="button" className="ld-btn" disabled={rebuild.isPending} onClick={() => rebuild.mutate({ organizationId: currentOrgId, id: m.id })}>{rebuild.isPending ? "Writing..." : "Write agenda"}</button>}
        <button type="button" className="ld-btn" onClick={begin}>Edit</button>
        <button type="button" className="ld-btn" disabled={cancel.isPending} onClick={() => cancel.mutate({ organizationId: currentOrgId, id: m.id })}>Cancel meeting</button>
        <ErrorLine error={err} />
      </div>
    </div>
  );
}

// ==========================================
// Past: notes and action items
// ==========================================

const ITEM_PILL: Record<string, { l: string; c: string }> = { in_projects: { l: "In Projects", c: "green" }, in_clickup: { l: "In ClickUp", c: "green" }, task: { l: "With Nora", c: "green" }, open: { l: "Not sent", c: "amber" }, done: { l: "Done", c: "gray" } };

function PastMeeting({ m, tz, onClose }: { m: M; tz: string; onClose: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.coo.invalidate(), utils.projects.invalidate()]);
  const [editing, setEditing] = React.useState(!m.notes);
  const [notes, setNotes] = React.useState(m.notes ?? "");
  const save = trpc.coo.saveNotes.useMutation({ onSuccess: async () => { setEditing(false); await refresh(); } });
  const items = trpc.coo.sendItems.useMutation({ onSuccess: refresh });
  const recap = trpc.coo.sendRecap.useMutation({ onSuccess: refresh });
  const err = save.error || items.error || recap.error;
  const open = m.actionItems.filter((i) => i.status === "open");
  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <span className="ld-lbl">Your notes</span>
        {editing ? (
          <textarea className="ld-ta" rows={7} aria-label="Meeting notes" placeholder="Paste your notes. Simone pulls out who agreed to do what." value={notes} onChange={(e) => setNotes(e.target.value)} />
        ) : (
          <span className="ld-body" style={{ whiteSpace: "pre-line" }}>{m.notes}</span>
        )}
        {m.notesAt && !editing && <span className="ld-small ld-muted">{`Saved ${day(m.notesAt, tz)} at ${time(m.notesAt, tz)}`}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <span className="ld-lbl">Action items Simone found</span>
        {m.actionItems.length === 0 ? (
          <span className="ld-body ld-muted">{m.notes ? "No action items in these notes." : "Save your notes and Simone lists who agreed to do what."}</span>
        ) : (
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 80px 104px", gap: "8px 10px", fontSize: 14, lineHeight: 1.45, alignItems: "center" }}>
            {m.actionItems.map((i, k) => (
              <React.Fragment key={k}>
                <span>{i.text}</span>
                <span>{i.owner}</span>
                <span className={`ld-pill ${ITEM_PILL[i.status]?.c ?? "gray"}`}>{ITEM_PILL[i.status]?.l ?? i.status}</span>
              </React.Fragment>
            ))}
          </div>
        )}
        {m.actionItems.some((i) => i.status === "in_projects") && <span className="ld-small ld-muted">Nora added these to the launch list in Projects.</span>}
        {m.recapSentAt && <span className="ld-small ld-muted">{`Recap sent ${day(m.recapSentAt, tz)}.`}</span>}
        <ErrorLine error={err} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending || !notes.trim()} onClick={() => save.mutate({ organizationId: currentOrgId, id: m.id, notes })}>{save.isPending ? "Reading..." : "Save notes"}</button>
            {m.notes && <button type="button" className="ld-btn" onClick={() => { setEditing(false); setNotes(m.notes ?? ""); }}>Cancel</button>}
          </>
        ) : (
          <>
            {m.actionItems.length > 0 && <button type="button" className="ld-btn p" disabled={recap.isPending} onClick={() => recap.mutate({ organizationId: currentOrgId, id: m.id })}>{m.recapSentAt ? "Send again" : "Send recap"}</button>}
            {open.length > 0 && <button type="button" className="ld-btn" disabled={items.isPending} onClick={() => items.mutate({ organizationId: currentOrgId, id: m.id })}>Send to Nora</button>}
            <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
        <button type="button" className="ld-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ==========================================
// Sitting in: meetings on the calendar Avery joins (his notes come to Simone)
// ==========================================

const PLATFORM: Record<string, string> = { zoom: "Zoom", meet: "Google Meet", teams: "Teams" };
const SQ_SIT = "minmax(0,1.8fr) 240px 120px 150px 128px";

export function sitState(r: Pick<NT, "status" | "lockReason" | "botId" | "choice" | "host">, joins: "mine" | "any" | "picked") {
  if (r.lockReason) return { l: "Never joins", c: "gray" };
  if (r.status === "in_call") return { l: "In the meeting", c: "green" };
  if (r.status === "joining") return { l: "Joining", c: "green" };
  if (r.status === "scheduled") return { l: "Avery joins", c: "green" };
  if (r.choice === "join" || (r.choice === "auto" && (joins === "any" || (joins === "mine" && r.host)))) return { l: "Joins at the start", c: "green" };
  if (r.choice === "auto" && joins === "mine" && !r.host) return { l: "Not yours", c: "gray" };
  return { l: "Skipped", c: "gray" };
}

function SittingIn({ list, tz, loading, emp }: { list: NT[]; tz: string; loading: boolean; emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const settings = trpc.coo.notetakerSettings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const setJoin = trpc.coo.setJoin.useMutation({ onSuccess: () => utils.coo.notetaker.invalidate() });
  const refresh = trpc.coo.refreshCalendar.useMutation({ onSuccess: () => utils.coo.notetaker.invalidate() });
  const [open, setOpen] = React.useState<number | null>(null);
  const s = settings.data;
  const joins = s?.joins ?? "mine";
  if (s && (!s.recall || !s.google)) {
    return (
      <div className="ld-empty" style={{ textAlign: "left" }}>
        {!s.google ? "Connect Google on Integrations so Avery can read your calendar. " : ""}
        {!s.recall ? "Connect Recall.ai on Integrations so Avery can sit in on your Zoom, Google Meet and Teams meetings. " : ""}
        <Link href="/integrations">Open Integrations</Link>
      </div>
    );
  }
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: SQ_SIT }}>
        <span>Meeting</span>
        <span>When</span>
        <span>Link</span>
        <span>Notes</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : "No Zoom, Google Meet or Teams meetings on your calendar in the next 2 days."}</div>}
      {list.map((r) => {
        const isOpen = open === r.id;
        const st = sitState(r, joins);
        const joining = st.c === "green";
        const busy = setJoin.isPending && setJoin.variables?.id === r.id;
        return (
          <React.Fragment key={r.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: SQ_SIT, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a")) return; setOpen(isOpen ? null : r.id); }}>
              <span className="ld-strong">{r.title}</span>
              <span>{`${day(r.startsAt, tz)} · ${time(r.startsAt, tz)}`}</span>
              <span>{PLATFORM[r.platform] ?? r.platform}</span>
              <span className={`ld-pill ${st.c}`}>{st.l}</span>
              {r.lockReason ? (
                <button type="button" className="ld-btn" disabled title={r.lockReason}>Locked</button>
              ) : joining ? (
                <button type="button" className="ld-btn" disabled={busy} onClick={() => setJoin.mutate({ organizationId: currentOrgId, id: r.id, choice: "skip" })}>{r.status === "in_call" || r.status === "joining" ? "Remove him" : "Skip"}</button>
              ) : (
                <button type="button" className="ld-btn p" disabled={busy} onClick={() => setJoin.mutate({ organizationId: currentOrgId, id: r.id, choice: "join" })}>Join</button>
              )}
            </div>
            {isOpen && (
              <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                  <KV label="Who">{r.attendees.map((a) => a.name).join(", ") || "Only you"}</KV>
                  <KV label="Link">{r.meetingUrl.replace(/^https?:\/\//, "")}</KV>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                  {r.lockReason ? (
                    <KV label="Why Avery never joins">{`${r.lockReason}. Change the never-join words on Avery's Onboarding tab if this is wrong.`}</KV>
                  ) : st.l === "Not yours" ? (
                    <KV label="Why Avery skips">Someone else set this meeting up, and Avery joins only the meetings you set up. Press Join to send him anyway.</KV>
                  ) : (
                    <KV label="He joins as">{s?.botNameShown ?? emp.name}</KV>
                  )}
                  {r.error && <KV label="Last problem">{r.error}</KV>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button type="button" className="ld-btn" onClick={() => setOpen(null)}>Close</button>
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
      <div className="ld-row" style={{ padding: "10px 18px", gap: 12, alignItems: "center" }}>
        <button type="button" className="ld-btn" style={{ width: 128 }} disabled={refresh.isPending} onClick={() => refresh.mutate({ organizationId: currentOrgId })}>{refresh.isPending ? "Reading..." : "Refresh"}</button>
        <span className="ld-small ld-muted">Every calendar on Integrations, the next 2 days. Zoom, Google Meet and Teams links.</span>
      </div>
      <div style={{ padding: "0 18px 10px" }}>
        <ErrorLine error={setJoin.error || refresh.error} />
      </div>
    </>
  );
}

// ==========================================
// Notes: meetings Avery sat in on
// ==========================================

const SQ_NOTES = "minmax(0,1.8fr) 240px 90px 160px 128px";

export function notesState(r: Pick<NT, "status" | "recapSentAt">) {
  if (r.status === "processing") return { l: "Writing notes", c: "amber" };
  if (r.status === "failed") return { l: "No notes", c: "red" };
  if (r.status === "removed") return { l: "Removed from meeting", c: "amber" };
  if (r.recapSentAt) return { l: "Recap sent", c: "green" };
  return { l: "Notes ready", c: "green" };
}

function NotesList({ list, tz, loading, emp }: { list: NT[]; tz: string; loading: boolean; emp: EmployeeRow }) {
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: SQ_NOTES }}>
        <span>Meeting</span>
        <span>When</span>
        <span>Length</span>
        <span>Status</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{loading ? "Loading..." : "No notes yet. Avery writes them after each meeting he sits in on and sends them here."}</div>}
      {list.map((r) => {
        const isOpen = open === r.id;
        const st = notesState(r);
        return (
          <React.Fragment key={r.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: SQ_NOTES, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a")) return; setOpen(isOpen ? null : r.id); }}>
              <span className="ld-strong">{r.title}</span>
              <span>{`${day(r.startsAt, tz)} · ${time(r.startsAt, tz)}`}</span>
              <span>{r.heldMinutes ? `${r.heldMinutes} min` : ""}</span>
              <span className={`ld-pill ${st.c}`}>{st.l}</span>
              <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : r.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && <NotesDetail r={r} tz={tz} onClose={() => setOpen(null)} />}
          </React.Fragment>
        );
      })}
    </>
  );
}

const lines = (list: string[]) => (list.length ? list.join("\n") : "");

/** The notes as sections: a summary paragraph, then decisions, open questions and action items as lists. */
export function NotesBody({ summary, decisions, questions, items, compact }: { summary: string; decisions: string[]; questions: string[]; items: { text: string; owner: string; due: string | null; status?: string }[]; compact?: boolean }) {
  const sec = (label: string, body: React.ReactNode) => (
    <div className="ld-notes-sec">
      <span className="ld-lbl">{label}</span>
      {body}
    </div>
  );
  return (
    <div className={`ld-notes ${compact ? "compact" : ""}`}>
      {sec("Summary", <p>{summary || "None"}</p>)}
      {(decisions.length > 0 || !compact) && sec("Decisions", decisions.length ? <ul>{decisions.map((d, i) => <li key={i}>{d}</li>)}</ul> : <p className="ld-muted">None</p>)}
      {questions.length > 0 && sec("Open questions", <ul>{questions.map((q, i) => <li key={i}>{q}</li>)}</ul>)}
      {(items.length > 0 || !compact) && sec(`Action items (${items.length})`, items.length ? (
        <ul>
          {items.map((i, k) => (
            <li key={k} className={i.status === "done" ? "done" : ""}>
              {i.text} <span className="ld-muted">({i.owner}{i.due ? `, by ${i.due}` : ""})</span>
            </li>
          ))}
        </ul>
      ) : <p className="ld-muted">No one agreed to do anything in this meeting.</p>)}
    </div>
  );
}

export function NotesDetail({ r, tz, onClose }: { r: NT; tz: string; onClose?: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.coo.invalidate(), utils.projects.invalidate()]);
  const settings = trpc.coo.notetakerSettings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const recap = trpc.coo.sendNotesRecap.useMutation({ onSuccess: refresh });
  const items = trpc.coo.sendNotesItems.useMutation({ onSuccess: refresh });
  const save = trpc.coo.editNotes.useMutation({ onSuccess: async () => { setEditing(false); await refresh(); } });
  const [showText, setShowText] = React.useState(false);
  const transcript = trpc.coo.transcript.useQuery({ organizationId: currentOrgId, id: r.id }, { enabled: showText && r.hasTranscript });
  const [editing, setEditing] = React.useState(false);
  const [d, setD] = React.useState({ summary: "", decisions: "", questions: "", items: [] as { text: string; owner: string; due: string }[] });
  const s = r.summary;
  const open = r.actionItems.filter((i) => i.status === "open");
  const err = recap.error || items.error || save.error;
  const begin = () => {
    setD({ summary: s?.summary ?? "", decisions: lines(s?.decisions ?? []), questions: lines(s?.questions ?? []), items: r.actionItems.map((i) => ({ text: i.text, owner: i.owner, due: i.due ?? "" })) });
    setEditing(true);
  };
  const facts = [
    r.actionItems.some((i) => i.status === "in_projects" || i.status === "task") ? "Sent to Nora" : null,
    r.mediaDeletedAt ? "Recording deleted" : r.status === "ready" ? (settings.data?.keep === "7" ? "Recording kept 7 days" : settings.data?.keep === "30" ? "Recording kept 30 days" : null) : null,
    r.hasTranscript ? "Transcript kept" : null,
    r.recapSentAt ? `Recap sent ${day(r.recapSentAt, tz)}` : null,
  ].filter(Boolean);

  if (r.status !== "ready") {
    return (
      <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
        <span className="ld-body">{r.status === "processing" ? "The meeting ended. The transcript and notes are being written; this usually takes a few minutes." : r.error || "There are no notes for this meeting."}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{onClose && <button type="button" className="ld-btn" onClick={onClose}>Close</button>}</div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <div className="ld-field"><label className="ld-lbl" htmlFor={`ns-${r.id}`}>Summary</label><textarea id={`ns-${r.id}`} className="ld-ta" rows={4} value={d.summary} onChange={(e) => setD({ ...d, summary: e.target.value })} /></div>
          <div className="ld-field"><label className="ld-lbl" htmlFor={`nd-${r.id}`}>Decisions, one per line</label><textarea id={`nd-${r.id}`} className="ld-ta" rows={3} value={d.decisions} onChange={(e) => setD({ ...d, decisions: e.target.value })} /></div>
          <div className="ld-field"><label className="ld-lbl" htmlFor={`nq-${r.id}`}>Open questions, one per line</label><textarea id={`nq-${r.id}`} className="ld-ta" rows={2} value={d.questions} onChange={(e) => setD({ ...d, questions: e.target.value })} /></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <span className="ld-lbl">Action items</span>
          {d.items.map((i, k) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 8, borderBottom: "1px dashed #e3e9e6" }}>
              <input className="ld-in" aria-label="Action item" value={i.text} onChange={(e) => setD({ ...d, items: d.items.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)) })} />
              <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px 96px", gap: 6, alignItems: "center" }}>
                <input className="ld-in" aria-label="Owner" placeholder="Owner" value={i.owner} onChange={(e) => setD({ ...d, items: d.items.map((x, j) => (j === k ? { ...x, owner: e.target.value } : x)) })} />
                <input className="ld-in" aria-label="Due MM/DD/YYYY" placeholder="MM/DD/YYYY" value={i.due} onChange={(e) => setD({ ...d, items: d.items.map((x, j) => (j === k ? { ...x, due: e.target.value } : x)) })} />
                <button type="button" className="ld-btn" style={{ width: 96 }} onClick={() => setD({ ...d, items: d.items.filter((_, j) => j !== k) })}>Remove</button>
              </div>
            </div>
          ))}
          <div><button type="button" className="ld-btn" style={{ width: 128 }} onClick={() => setD({ ...d, items: [...d.items, { text: "", owner: "", due: "" }] })}>Add item</button></div>
          <ErrorLine error={save.error} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            type="button"
            className="ld-btn p"
            disabled={save.isPending}
            onClick={() => save.mutate({ organizationId: currentOrgId, id: r.id, summary: d.summary, decisions: d.decisions.split("\n"), questions: d.questions.split("\n"), items: d.items.filter((i) => i.text.trim()) })}
          >
            {save.isPending ? "Saving..." : "Save"}
          </button>
          <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <NotesBody summary={s?.summary ?? ""} decisions={s?.decisions ?? []} questions={s?.questions ?? []} items={[]} compact />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <span className="ld-lbl">{`Action items (${r.actionItems.length})`}</span>
        {r.actionItems.length === 0 ? (
          <span className="ld-body ld-muted">No one agreed to do anything in this meeting.</span>
        ) : (
          <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 80px 110px", gap: "8px 10px", fontSize: 14, lineHeight: 1.45, alignItems: "center" }}>
            {r.actionItems.map((i, k) => (
              <React.Fragment key={k}>
                <span>{i.text}</span>
                <span>{i.owner}</span>
                <span>{i.due ? new Date(`${i.due.slice(6)}-${i.due.slice(0, 2)}-${i.due.slice(3, 5)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : <span className="ld-muted">No date</span>}</span>
              </React.Fragment>
            ))}
          </div>
        )}
        {facts.length > 0 && <span className="ld-small ld-muted" style={{ paddingTop: 6 }}>{facts.join(" · ")}</span>}
        {showText && (
          <div className="ld-body" style={{ whiteSpace: "pre-line", maxHeight: 320, overflowY: "auto", border: "1px solid #e3e9e6", borderRadius: 8, padding: "10px 12px", background: "#fff", fontSize: 13 }}>
            {transcript.isLoading ? "Loading..." : transcript.data?.transcript || "No transcript."}
          </div>
        )}
        <ErrorLine error={err} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={recap.isPending} onClick={() => recap.mutate({ organizationId: currentOrgId, id: r.id })}>{recap.isPending ? "Sending..." : r.recapSentAt ? "Send again" : "Send recap"}</button>
        {open.length > 0 && <button type="button" className="ld-btn" disabled={items.isPending} onClick={() => items.mutate({ organizationId: currentOrgId, id: r.id })}>Send to Nora</button>}
        {r.hasTranscript && <button type="button" className="ld-btn" onClick={() => setShowText(!showText)}>{showText ? "Hide transcript" : "Transcript"}</button>}
        <button type="button" className="ld-btn" onClick={begin}>Edit</button>
        {onClose && <button type="button" className="ld-btn" onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}

// ==========================================
// Scorecard
// ==========================================

const SQ = "130px minmax(0,1.8fr) 110px 110px 110px 130px";

function Scorecard() {
  const { currentOrgId } = useTenant();
  const [back, setBack] = React.useState(0);
  const q = trpc.coo.scorecard.useQuery({ organizationId: currentOrgId, weeksBack: back }, { enabled: currentOrgId > 0 });
  const weeks = Array.from({ length: 8 }, (_, i) => i);
  const val = (n: number | null, unit: string) => (n === null ? <span className="ld-muted">None</span> : `${n}${unit}`);
  return (
    <>
      <div style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #e3e9e6" }}>
        <label className="ld-lbl" htmlFor="sc-week" style={{ margin: 0 }}>Week</label>
        <select id="sc-week" className="ld-in" style={{ width: "auto", minWidth: 240 }} value={back} onChange={(e) => setBack(Number(e.target.value))}>
          {weeks.map((w) => <option key={w} value={w}>{w === 0 ? `This week${q.data && back === 0 ? `, ${q.data.label}` : ""}` : w === 1 ? "Last week" : `${w} weeks ago`}</option>)}
        </select>
        {q.data && back > 0 && <span className="ld-small ld-muted">{q.data.label}</span>}
      </div>
      <div className="ld-hd" style={{ gridTemplateColumns: SQ }}>
        <span>Team</span>
        <span>Number</span>
        <span>This week</span>
        <span>Last week</span>
        <span>Weekly goal</span>
        <span />
      </div>
      {(q.data?.rows ?? []).map((r) => (
        <div key={r.key} className="ld-rw" style={{ gridTemplateColumns: SQ }}>
          <span className="ld-muted" style={{ fontWeight: 700 }}>{r.team}</span>
          <span className="ld-strong">{r.label}</span>
          <span>{val(r.thisWeek, r.unit)}</span>
          <span>{val(r.lastWeek, r.unit)}</span>
          <span>{r.goal === null ? <span className="ld-muted">Not set</span> : `${r.goal}${r.unit}`}</span>
          {r.met === null ? <span /> : <span className={`ld-pill ${r.met ? "green" : "amber"}`}>{r.met ? "On goal" : "Below goal"}</span>}
        </div>
      ))}
      <div style={{ padding: "10px 18px" }} className="ld-small ld-muted">Set a weekly goal by asking Simone in Chat, for example "Set the weekly goal for demos booked to 4."</div>
    </>
  );
}
