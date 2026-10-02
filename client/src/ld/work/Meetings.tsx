import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import type { Outputs } from "../types";

type M = Outputs["coo"]["meetings"]["upcoming"][number];
type Tab = "upcoming" | "past" | "scorecard";

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
  const [tab, setTab] = React.useState<Tab>("upcoming");
  const data = q.data;
  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "upcoming", label: `Upcoming (${data?.upcoming.length ?? 0})` },
          { key: "past", label: `Past (${data?.past.length ?? 0})` },
          { key: "scorecard", label: "Scorecard" },
        ]}
      >
        {tab === "upcoming" && <List list={data?.upcoming ?? []} tz={tz} loading={q.isLoading} emp={emp} />}
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

const ITEM_PILL: Record<string, { l: string; c: string }> = { in_clickup: { l: "In ClickUp", c: "green" }, task: { l: "With Nora", c: "green" }, open: { l: "Not sent", c: "amber" }, done: { l: "Done", c: "gray" } };

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
        {m.actionItems.some((i) => i.status === "in_clickup") && <span className="ld-small ld-muted">Nora added these to the launch list in ClickUp.</span>}
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
