import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { Buttons, Choice } from "../sales/OnboardingCards";

const grid: React.CSSProperties = { padding: "18px 20px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 };
const small: React.CSSProperties = { fontSize: 12, color: "#5b6b64", lineHeight: 1.45 };

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eef2f0" }}>
      <span className="ld-strong" style={{ fontSize: 14 }}>{label}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {children}
        {note && <span style={small}>{note}</span>}
      </div>
    </div>
  );
}

const CHECK = [
  { key: "07:30", label: "7:30 AM" },
  { key: "08:30", label: "8:30 AM" },
  { key: "09:30", label: "9:30 AM" },
] as const;

/** Nora: the ClickUp Space, who gets tasks, the morning check and the report day. */
export function ClickUpCard({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.projects.settings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const [d, setD] = React.useState({ spaceId: "", taskOwners: "employees" as "people" | "employees", checkTime: "08:30" as "07:30" | "08:30" | "09:30", reportDay: 5 as 1 | 5 });
  const save = trpc.projects.saveSettings.useMutation({ onSuccess: async () => { setEditing(false); await Promise.all([utils.projects.settings.invalidate(), utils.publishing.listConnections.invalidate()]); } });
  const refresh = trpc.projects.refreshSpaces.useMutation({ onSuccess: () => utils.projects.settings.invalidate() });
  if (!q.data) return null;
  const s = q.data;
  const cu = s.clickup;
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div style={grid} className="ld-keep-check">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ld-lbl">ClickUp</span>
          <Row label="Space" note={cu ? `${emp.name} makes a new list here for each launch.` : undefined}>
            {!cu ? (
              <span className="ld-body">Not connected. <Link href="/integrations">Connect ClickUp on Integrations.</Link></span>
            ) : editing ? (
              <div className="ld-row" style={{ gap: 8 }}>
                <select className="ld-in" style={{ maxWidth: 320 }} aria-label="ClickUp Space" value={d.spaceId} onChange={(e) => setD({ ...d, spaceId: e.target.value })}>
                  {cu.spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                </select>
                <button type="button" className="ld-btn" style={{ width: 128 }} disabled={refresh.isPending} onClick={() => refresh.mutate({ organizationId: currentOrgId })}>Refresh list</button>
              </div>
            ) : (
              <span className="ld-body">{cu.spaceName ? `${cu.spaceName} (${cu.teamName ?? "ClickUp"})` : "Not chosen"}</span>
            )}
          </Row>
          <Row label="Who gets tasks" note="Employees' tasks are assigned to you in ClickUp and tagged with the employee's name.">
            {editing ? <Choice options={[{ key: "people", label: "People on your team" }, { key: "employees", label: "Your employees too" }]} value={d.taskOwners} onChange={(v) => setD({ ...d, taskOwners: v })} /> : <span className="ld-body">{s.taskOwners === "people" ? "People on your team" : "Your employees too"}</span>}
          </Row>
          <Row label="Morning check" note="Overdue and at-risk tasks. Owners get a reminder in ClickUp.">
            {editing ? <Choice options={CHECK.map((c) => ({ key: c.key, label: c.label }))} value={d.checkTime} onChange={(v) => setD({ ...d, checkTime: v })} /> : <span className="ld-body">{CHECK.find((c) => c.key === s.checkTime)?.label}</span>}
          </Row>
          <Row label="Status report">
            {editing ? <Choice options={[{ key: "5", label: "Friday" }, { key: "1", label: "Monday" }]} value={String(d.reportDay) as "1" | "5"} onChange={(v) => setD({ ...d, reportDay: Number(v) as 1 | 5 })} /> : <span className="ld-body">{s.reportDay === 1 ? "Monday" : "Friday"}</span>}
          </Row>
          <ErrorLine error={save.error || refresh.error} />
        </div>
        <Buttons editing={editing} saving={save.isPending} onEdit={() => { setD({ spaceId: cu?.spaceId ?? "", taskOwners: s.taskOwners, checkTime: s.checkTime, reportDay: s.reportDay }); setEditing(true); }} onSave={() => save.mutate({ organizationId: currentOrgId, spaceId: d.spaceId || undefined, taskOwners: d.taskOwners, checkTime: d.checkTime, reportDay: d.reportDay })} onCancel={() => setEditing(false)} />
      </div>
    </section>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TIMES = Array.from({ length: 27 }, (_, i) => {
  const mins = 7 * 60 + i * 30;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return { v: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, label: `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` };
});
const timeLabel = (v: string) => TIMES.find((t) => t.v === v)?.label ?? v;
type Series = { id: string; name: string; day: number; time: string; minutes: number; attendees: string[]; updatesFrom: string[] };

/** Simone: the meeting link, repeating meetings, when agendas go out, and what happens after. */
export function MeetingsCard({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.coo.settings.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const [d, setD] = React.useState({ meetingLink: "meet" as "meet" | "zoom", agendaWhen: "day_before" as "day_before" | "morning_of", afterMeeting: "notes" as "notes" | "zoom", recurring: [] as Series[] });
  const save = trpc.coo.saveSettings.useMutation({ onSuccess: async () => { setEditing(false); await utils.coo.invalidate(); } });
  if (!q.data) return null;
  const s = q.data;
  const nameOf = (email: string) => s.people.find((p) => p.email === email)?.name ?? email;
  const empName = (kind: string) => s.employees.find((e) => e.kind === kind)?.name ?? kind;
  const setRow = (i: number, patch: Partial<Series>) => setD({ ...d, recurring: d.recurring.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const RQ: React.CSSProperties = { display: "grid", gridTemplateColumns: "120px 112px 96px 96px", gap: 8, alignItems: "center" };
  const lab: React.CSSProperties = { ...small, width: 92, fontWeight: 700 };
  return (
    <section className={`ld-card ${editing ? "editing" : ""}`}>
      <div style={grid} className="ld-keep-check">
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span className="ld-lbl">Meetings</span>
          <Row label="Meeting link" note={editing ? `Google Meet comes with your Google connection. Zoom needs Zoom connected on Integrations${s.zoom ? "" : " (not connected yet)"}.` : undefined}>
            {editing ? <Choice options={[{ key: "meet", label: "Google Meet" }, { key: "zoom", label: "Zoom" }]} value={d.meetingLink} onChange={(v) => setD({ ...d, meetingLink: v })} /> : <span className="ld-body">{s.meetingLink === "zoom" ? "Zoom" : "Google Meet"}{!s.google && " · Connect Google on Integrations to send invites"}</span>}
          </Row>
          <Row label="Repeating meetings">
            {editing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {d.recurring.map((r, i) => (
                  <div key={r.id || i} style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 10, borderBottom: "1px dashed #e3e9e6" }}>
                    <input className="ld-in" aria-label="Meeting name" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
                    <div className="ld-keep" style={RQ}>
                      <select className="ld-in" aria-label="Day" value={r.day} onChange={(e) => setRow(i, { day: Number(e.target.value) })}>{DAYS.map((dn, k) => <option key={dn} value={k}>{dn}</option>)}</select>
                      <select className="ld-in" aria-label="Time" value={r.time} onChange={(e) => setRow(i, { time: e.target.value })}>{TIMES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}</select>
                      <select className="ld-in" aria-label="Length" value={r.minutes} onChange={(e) => setRow(i, { minutes: Number(e.target.value) })}>{s.minutes.map((n) => <option key={n} value={n}>{`${n} min`}</option>)}</select>
                      <button type="button" className="ld-btn" style={{ width: 96 }} onClick={() => setD({ ...d, recurring: d.recurring.filter((_, j) => j !== i) })}>Remove</button>
                    </div>
                    <div className="ld-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={lab}>Who attends</span>
                      {s.people.map((p) => {
                        const on = r.attendees.includes(p.email);
                        return <button key={p.email} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setRow(i, { attendees: toggle(r.attendees, p.email) })}>{p.name}</button>;
                      })}
                    </div>
                    <div className="ld-row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={lab}>Updates from</span>
                      {s.employees.map((e) => {
                        const on = r.updatesFrom.includes(e.kind);
                        return <button key={e.kind} type="button" className={`ld-chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => setRow(i, { updatesFrom: toggle(r.updatesFrom, e.kind) })}>{e.name}</button>;
                      })}
                    </div>
                  </div>
                ))}
                <div>
                  <button type="button" className="ld-btn" style={{ width: 128 }} onClick={() => setD({ ...d, recurring: [...d.recurring, { id: "", name: "Weekly leadership meeting", day: 1, time: "09:00", minutes: 45, attendees: s.people.map((p) => p.email).slice(0, 3), updatesFrom: s.employees.filter((e) => e.kind === "projects").map((e) => e.kind) }] })}>Add meeting</button>
                </div>
              </div>
            ) : s.recurring.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {s.recurring.map((r) => (
                  <span key={r.id} className="ld-body">
                    <b>{r.name}</b>
                    {`: ${DAYS[r.day]}s at ${timeLabel(r.time)}, ${r.minutes} min · ${r.attendees.map(nameOf).join(", ") || "no one"}${r.updatesFrom.length ? ` · updates from ${r.updatesFrom.map(empName).join(", ")}` : ""}`}
                  </span>
                ))}
              </div>
            ) : (
              <span className="ld-body">None yet. Press Edit and Add meeting.</span>
            )}
          </Row>
          <Row label="Agenda goes out">
            {editing ? <Choice options={[{ key: "day_before", label: "The day before at 4:00 PM" }, { key: "morning_of", label: "The morning of" }]} value={d.agendaWhen} onChange={(v) => setD({ ...d, agendaWhen: v })} /> : <span className="ld-body">{s.agendaWhen === "morning_of" ? "The morning of, at 7:00 AM" : "The day before at 4:00 PM"}</span>}
          </Row>
          <Row label="After the meeting" note={editing ? "A transcript needs Zoom with cloud recording." : undefined}>
            {editing ? <Choice options={[{ key: "notes", label: "Ask me for notes" }, { key: "zoom", label: "Use the Zoom transcript" }]} value={d.afterMeeting} onChange={(v) => setD({ ...d, afterMeeting: v })} /> : <span className="ld-body">{s.afterMeeting === "zoom" ? "Use the Zoom transcript" : `Ask me for notes. Paste them on the Past tab or in ${emp.name}'s chat.`}</span>}
          </Row>
          <ErrorLine error={save.error} />
        </div>
        <Buttons editing={editing} saving={save.isPending} onEdit={() => { setD({ meetingLink: s.meetingLink, agendaWhen: s.agendaWhen, afterMeeting: s.afterMeeting, recurring: s.recurring.map((r) => ({ ...r })) }); setEditing(true); }} onSave={() => save.mutate({ organizationId: currentOrgId, ...d, recurring: d.recurring.filter((r) => r.name.trim()) })} onCancel={() => setEditing(false)} />
      </div>
    </section>
  );
}
