import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { Avatar, ErrorLine, FolderTabs, PersonAvatar, useEmployees } from "../ui";
import type { Outputs } from "../types";

type View = Outputs["projects"]["launch"];
type Card = Outputs["projects"]["launches"][number];
type Task = View["tasks"][number];
type Kpi = View["kpis"][number];
type Tab = "tasks" | "milestones" | "kpis" | "reports";

const day = (d: Date | string | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const short = (d: Date | string | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" });
const mdy = (d: Date | string | number, tz: string) => new Date(d).toLocaleDateString("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", year: "numeric" });
const STATE_CLS: Record<string, string> = { done: "gray", on_track: "green", behind: "amber", not_started: "gray", waiting: "amber" };

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function Owner({ t }: { t: Pick<Task, "ownerName" | "ownerType" | "ownerKind"> }) {
  const { list } = useEmployees();
  const emp = t.ownerType === "employee" ? list.find((e) => e.kind === t.ownerKind) : null;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      {emp ? <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={24} /> : <PersonAvatar name={t.ownerName} size={24} />}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.ownerName}</span>
    </span>
  );
}

const groupHead: React.CSSProperties = { padding: "10px 18px", fontSize: 12, fontWeight: 700, color: "var(--ld-muted)", textTransform: "uppercase", letterSpacing: ".06em", background: "var(--ld-page)", borderBottom: "1px solid #eef2f0", display: "flex", justifyContent: "space-between" };

/** What a project card says on its right: the thing that needs attention first. */
function attention(c: Card, tz: string) {
  if (c.status === "planning") return "";
  if (c.behind) return `${c.behind} behind`;
  if (c.needPerson) return `${c.needPerson} need${c.needPerson === 1 ? "s" : ""} a person`;
  if (c.dueToday) return c.dueToday === 1 ? "due today" : `${c.dueToday} due today`;
  return c.ongoing ? "" : short(c.launchDate, tz);
}

/** Nora's Projects tab: every project as a card on the left, the one you pick on the right. */
export default function Launches({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const list = trpc.projects.launches.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const cards = list.data ?? [];
  const [picked, setPicked] = React.useState<number | null>(null);
  const [making, setMaking] = React.useState(false);
  const current = picked && cards.some((c) => c.id === picked) ? picked : cards[0]?.id ?? null;
  const q = trpc.projects.launch.useQuery({ organizationId: currentOrgId, id: current ?? 0 }, { enabled: currentOrgId > 0 && !!current, refetchInterval: 60_000 });
  const [tab, setTab] = React.useState<Tab>("tasks");
  const utils = trpc.useUtils();
  const v = q.data;
  const card = cards.find((c) => c.id === current) ?? null;

  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <div className="ld-pjwrap">
        <aside className="ld-pjlist" aria-label="Projects">
          <div className="ld-between">
            <span className="ld-lbl" style={{ margin: 0 }}>Projects · {cards.length}</span>
            <button type="button" className="ld-btn p sm" onClick={() => setMaking(true)}>+ New project</button>
          </div>
          {making && <ProjectForm onClose={() => setMaking(false)} onSaved={(id) => { setMaking(false); setPicked(id); }} />}
          {cards.map((c) => {
            const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
            const on = c.id === current;
            return (
              <button key={c.id} type="button" className={`ld-pjcard ${on ? "on" : ""}`} aria-pressed={on} onClick={() => { setPicked(c.id); setTab("tasks"); }}>
                <span className="nm">
                  <span className="gp-ell">{c.name}</span>
                  <span className={`ld-pill ${c.status === "planning" ? "amber" : c.status === "done" ? "gray" : c.ongoing ? "gray" : "green"}`}>{c.status === "planning" ? "Plan waiting for you" : c.status === "done" ? "Done" : c.ongoing ? "Ongoing" : short(c.launchDate, tz)}</span>
                </span>
                <span className="ld-pjbar"><i style={{ width: `${pct}%` }} /></span>
                <span className="meta">
                  <span>{c.done} of {c.total} tasks done</span>
                  <span>{attention(c, tz)}</span>
                </span>
              </button>
            );
          })}
          {!list.isLoading && cards.length === 0 && <span className="ld-small ld-muted">No projects yet. Make one here, or ask {emp.name} in Chat to plan a launch.</span>}
          <span className="ld-small ld-muted">Meeting and huddle action items go into the project they are about. {emp.name} makes a project when none fits.</span>
        </aside>
        <section className="ld-pjmain">
          {!current ? null : !v ? (
            <div className="ld-empty">Loading...</div>
          ) : (
            <>
              <ProjectHead v={v} card={card} tz={tz} onSaved={() => utils.projects.invalidate()} />
              <FolderTabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { key: "tasks", label: `Tasks (${v.tasks.length})` },
                  { key: "milestones", label: `Milestones (${v.milestones.length})` },
                  { key: "kpis", label: `KPIs (${v.kpis.length})` },
                  { key: "reports", label: `Reports (${v.reports.length})` },
                ]}
              >
                {tab === "tasks" && <Tasks v={v} tz={tz} emp={emp} projects={cards} />}
                {tab === "milestones" && <Milestones v={v} tz={tz} />}
                {tab === "kpis" && <Kpis v={v} tz={tz} />}
                {tab === "reports" && <Reports v={v} tz={tz} />}
              </FolderTabs>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** The project's name, dates and where it started, with Approve plan, Open in Projects, Edit and Move date. Edit opens the fields with Save and Cancel. */
function ProjectHead({ v, card, tz, onSaved }: { v: View; card: Card | null; tz: string; onSaved: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const approve = trpc.projects.approvePlan.useMutation({ onSuccess: () => utils.projects.invalidate() });
  const [editing, setEditing] = React.useState(false);
  const l = v.launch;
  const owners = new Set(v.tasks.map((t) => t.ownerName)).size;
  const sub = [l.ongoing ? "Ongoing" : `Launch day ${day(l.launchDate, tz)}`, `${v.tasks.length} task${v.tasks.length === 1 ? "" : "s"}, ${owners} owner${owners === 1 ? "" : "s"}`, l.sourceNote ?? ""].filter(Boolean).join(" · ");
  if (editing) return <ProjectForm editing={{ id: l.id, name: l.name, brief: l.brief ?? "", launchDate: l.ongoing ? "" : mdy(l.launchDate, tz) }} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onSaved(); }} />;
  return (
    <div className="ld-pjhead">
      <div style={{ minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>{l.name}</h2>
        <span className="ld-small ld-muted">{l.brief ? `${l.brief.slice(0, 120)}${l.brief.length > 120 ? "…" : ""} · ` : ""}{sub}</span>
        {card?.status === "planning" && <span className="ld-pill amber" style={{ marginLeft: 8 }}>Plan waiting for you</span>}
      </div>
      <div className="ld-row" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
        {l.status === "planning" && <button type="button" className="ld-btn p gp-auto" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: currentOrgId, id: l.id })}>Approve plan</button>}
        {l.pjListId ? <Link href={`/projects?list=${l.pjListId}`} className="ld-btn gp-auto">Open in Projects</Link> : l.clickupListUrl ? <a href={l.clickupListUrl} target="_blank" rel="noreferrer noopener" className="ld-btn gp-auto">Open in ClickUp</a> : null}
        <button type="button" className="ld-btn gp-auto" onClick={() => setEditing(true)}>Edit</button>
        <button type="button" className="ld-btn gp-auto" onClick={() => setEditing(true)}>{l.ongoing ? "Set a launch date" : "Move date"}</button>
      </div>
      <ErrorLine error={approve.error} />
    </div>
  );
}

/** New project, or Edit on one: name, what it is for, and the launch date (blank for ongoing). Save and Cancel. */
function ProjectForm({ editing, onClose, onSaved }: { editing?: { id: number; name: string; brief: string; launchDate: string }; onClose: () => void; onSaved: (id: number) => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [d, setD] = React.useState({ name: editing?.name ?? "", brief: editing?.brief ?? "", launchDate: editing?.launchDate ?? "" });
  const save = trpc.projects.saveProject.useMutation({ onSuccess: async (r) => { await utils.projects.invalidate(); onSaved(r.id); } });
  const go = () => d.name.trim() && save.mutate({ organizationId: currentOrgId, id: editing?.id, name: d.name, brief: d.brief, launchDate: d.launchDate.trim() || null });
  return (
    <div className="ld-card editing ld-pjform">
      <span className="ld-lbl">{editing ? "Change the project" : "New project"}</span>
      <div className="ld-field"><label className="ld-lbl" htmlFor="pj-name">Name</label><input id="pj-name" className="ld-in" autoFocus value={d.name} placeholder="November 10 webinar" onChange={(e) => setD({ ...d, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && go()} /></div>
      <div className="ld-field"><label className="ld-lbl" htmlFor="pj-brief">What it is for</label><input id="pj-brief" className="ld-in" value={d.brief} placeholder="Webinar for group practices" onChange={(e) => setD({ ...d, brief: e.target.value })} onKeyDown={(e) => e.key === "Enter" && go()} /></div>
      <div className="ld-field"><label className="ld-lbl" htmlFor="pj-date">Launch date (MM/DD/YYYY), blank for ongoing</label><input id="pj-date" className="ld-in" style={{ maxWidth: 160 }} value={d.launchDate} placeholder="MM/DD/YYYY" onChange={(e) => setD({ ...d, launchDate: e.target.value })} onKeyDown={(e) => e.key === "Enter" && go()} /></div>
      <div className="ld-row">
        <button type="button" className="ld-btn p sm" disabled={!d.name.trim() || save.isPending} onClick={go}>Save</button>
        <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
      </div>
      <ErrorLine error={save.error} />
    </div>
  );
}

// ==========================================
// Tasks
// ==========================================

const TQ = "minmax(0,2.4fr) minmax(0,1.2fr) 118px 112px 84px";

function Tasks({ v, tz, emp, projects }: { v: View; tz: string; emp: EmployeeRow; projects: Card[] }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const owners = trpc.projects.owners.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [d, setD] = React.useState({ title: "", details: "", owner: "", due: "", launchId: 0 });
  const refresh = () => utils.projects.invalidate();
  const mark = trpc.projects.markTask.useMutation({ onSuccess: refresh });
  const move = trpc.projects.moveTask.useMutation({ onSuccess: refresh });
  const save = trpc.projects.updateTask.useMutation({
    onSuccess: async (_r, vars) => {
      if (d.launchId && d.launchId !== v.launch.id) await move.mutateAsync({ organizationId: currentOrgId, taskId: vars.taskId, launchId: d.launchId });
      setEditing(null);
      await refresh();
    },
  });
  const groups: { key: string; label: string; right: string; tasks: Task[] }[] = v.milestones.map((m) => ({ key: `m${m.id}`, label: `${m.name} · ${day(m.dueDate, tz)}`, right: `${m.done} of ${m.total} done`, tasks: v.tasks.filter((t) => t.milestoneId === m.id) }));
  const loose = v.tasks.filter((t) => !t.milestoneId || !v.milestones.some((m) => m.id === t.milestoneId));
  if (loose.length) groups.push({ key: "loose", label: v.milestones.length ? "Other tasks" : "", right: v.milestones.length ? `${loose.filter((t) => t.status === "done").length} of ${loose.length} done` : "", tasks: loose });

  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: TQ }}>
        <span>Task</span>
        <span>Owner</span>
        <span>Due</span>
        <span>Status</span>
        <span />
      </div>
      {v.tasks.length === 0 && <div className="ld-empty">No tasks in this project yet.</div>}
      {groups.map((g) => (
        <React.Fragment key={g.key}>
          {g.label && (
            <div style={groupHead}>
              <span>{g.label}</span>
              <span>{g.right}</span>
            </div>
          )}
          {g.tasks.map((t) => {
            const isOpen = open === t.id;
            const isEditing = editing === t.id;
            const m = v.milestones.find((x) => x.id === t.milestoneId);
            return (
              <React.Fragment key={t.id}>
                <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: TQ, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a,input,select,textarea")) return; setOpen(isOpen ? null : t.id); setEditing(null); }}>
                  <span className="ld-strong">{t.title}</span>
                  <Owner t={t} />
                  <span className="ld-small">{short(t.dueDate, tz)}</span>
                  <span className={`ld-pill ${STATE_CLS[t.shown.key]}`}>{t.shown.label}</span>
                  <button type="button" className="ld-btn" style={{ width: 84 }} onClick={() => { setOpen(isOpen ? null : t.id); setEditing(null); }}>{isOpen ? "Close" : "Open"}</button>
                </div>
                {isOpen && (
                  <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
                    {isEditing ? (
                      <>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div className="ld-field"><label className="ld-lbl" htmlFor={`tt-${t.id}`}>Task</label><input id={`tt-${t.id}`} className="ld-in" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></div>
                          <div className="ld-field"><label className="ld-lbl" htmlFor={`td-${t.id}`}>Details</label><textarea id={`td-${t.id}`} className="ld-ta" rows={3} value={d.details} onChange={(e) => setD({ ...d, details: e.target.value })} /></div>
                          <div className="ld-field">
                            <label className="ld-lbl" htmlFor={`tp-${t.id}`}>Project</label>
                            <select id={`tp-${t.id}`} className="ld-in" value={d.launchId} onChange={(e) => setD({ ...d, launchId: Number(e.target.value) })}>
                              {projects.filter((p) => p.status !== "done").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div className="ld-field">
                            <label className="ld-lbl" htmlFor={`to-${t.id}`}>Owner</label>
                            <select id={`to-${t.id}`} className="ld-in" value={d.owner} onChange={(e) => setD({ ...d, owner: e.target.value })}>
                              {Array.from(new Set([t.ownerName, ...(owners.data ?? [])])).map((o) => <option key={o} value={o}>{o}</option>)}
                            </select>
                          </div>
                          <div className="ld-field"><label className="ld-lbl" htmlFor={`tdue-${t.id}`}>Due (MM/DD/YYYY)</label><input id={`tdue-${t.id}`} className="ld-in" style={{ maxWidth: 160 }} placeholder="MM/DD/YYYY" value={d.due} onChange={(e) => setD({ ...d, due: e.target.value })} /></div>
                          <ErrorLine error={save.error ?? move.error} />
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <button type="button" className="ld-btn p" disabled={save.isPending || move.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, taskId: t.id, title: d.title, details: d.details, owner: d.owner, due: d.due })}>Save</button>
                          <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          <KV label="Task">{t.details || t.title}</KV>
                          {t.doneWhen && <KV label="Done when">{t.doneWhen}</KV>}
                          {t.waitingOn && <KV label="Waiting on">{t.waitingOn}</KV>}
                          {t.note && <KV label={`${emp.name}'s note`}>{t.note}</KV>}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                          <KV label="Project">{v.launch.name}{m ? ` · ${m.name}, ${day(m.dueDate, tz)}` : ""}</KV>
                          <KV label="Owner">{t.ownerType === "employee" ? `${t.ownerName} (your employee)` : t.ownerName}</KV>
                          <KV label="In Projects">{t.pjTaskId && v.launch.pjListId ? <Link href={`/projects?list=${v.launch.pjListId}&task=${t.pjTaskId}`}>{`Launches › ${v.launch.name} › ${t.title}`}</Link> : t.clickupUrl ? <a href={t.clickupUrl} target="_blank" rel="noreferrer noopener">{`In ClickUp: ${v.launch.name} › ${t.title}`}</a> : v.launch.status === "planning" ? "Once you approve the plan" : "Not there yet"}</KV>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {t.pjTaskId && v.launch.pjListId ? <Link className="ld-btn" href={`/projects?list=${v.launch.pjListId}&task=${t.pjTaskId}`}>Open in Projects</Link> : t.clickupUrl ? <a className="ld-btn" href={t.clickupUrl} target="_blank" rel="noreferrer noopener">Open in ClickUp</a> : null}
                          <button type="button" className="ld-btn" onClick={() => { setEditing(t.id); setD({ title: t.title, details: t.details ?? "", owner: t.ownerName, due: mdy(t.dueDate, tz), launchId: v.launch.id }); }}>Edit</button>
                          <button type="button" className="ld-btn" disabled={mark.isPending} onClick={() => mark.mutate({ organizationId: currentOrgId, taskId: t.id, done: t.status !== "done" })}>{t.status === "done" ? "Reopen" : "Mark done"}</button>
                          <ErrorLine error={mark.error} />
                        </div>
                      </>
                    )}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </React.Fragment>
      ))}
    </>
  );
}

// ==========================================
// Milestones
// ==========================================

const MQ = "minmax(0,2fr) 170px 150px 140px";
function Milestones({ v, tz }: { v: View; tz: string }) {
  const now = Date.now();
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: MQ }}>
        <span>Milestone</span>
        <span>Due</span>
        <span>Done</span>
        <span>Status</span>
      </div>
      {v.milestones.map((m) => {
        const st = m.total > 0 && m.done === m.total ? { l: "Done", c: "gray" } : m.behind > 0 || new Date(m.dueDate).getTime() < now ? { l: "Behind", c: "amber" } : { l: "On track", c: "green" };
        return (
          <div key={m.id} className="ld-rw" style={{ gridTemplateColumns: MQ }}>
            <span className="ld-strong">{m.name}</span>
            <span>{day(m.dueDate, tz)}</span>
            <span>{`${m.done} of ${m.total}`}</span>
            <span className={`ld-pill ${st.c}`}>{st.l}</span>
          </div>
        );
      })}
    </>
  );
}

// ==========================================
// KPIs
// ==========================================

const KQ = "minmax(0,1.8fr) 110px 110px 130px minmax(0,1.2fr) 128px";
const fmtVal = (n: number, unit: string) => `${Number.isInteger(n) ? n : n.toFixed(1)}${unit === "percent" ? "%" : ""}`;

function Kpis({ v, tz }: { v: View; tz: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [editing, setEditing] = React.useState<number | "new" | null>(null);
  const [d, setD] = React.useState({ name: "", target: "", by: "", source: "manual" as Kpi["source"], manual: "" });
  const done = async () => { setEditing(null); await utils.projects.launch.invalidate(); };
  const save = trpc.projects.saveKpi.useMutation({ onSuccess: done });
  const remove = trpc.projects.removeKpi.useMutation({ onSuccess: done });
  const begin = (k: Kpi | null) => {
    setEditing(k ? k.id : "new");
    setD(k ? { name: k.name, target: String(k.target), by: mdy(k.byDate, tz), source: k.source, manual: String(k.manualValue ?? "") } : { name: "", target: "", by: mdy(v.launch.launchDate, tz), source: "manual", manual: "" });
  };
  const form = (k: Kpi | null) => (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="ld-field"><label className="ld-lbl" htmlFor="kpi-name">KPI</label><input id="kpi-name" className="ld-in" style={{ maxWidth: 320 }} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
        <div className="ld-keep" style={{ display: "grid", gridTemplateColumns: "140px 180px", gap: 12 }}>
          <div className="ld-field"><label className="ld-lbl" htmlFor="kpi-target">Target</label><input id="kpi-target" className="ld-in" inputMode="numeric" value={d.target} onChange={(e) => setD({ ...d, target: e.target.value.replace(/[^\d.]/g, "") })} /></div>
          <div className="ld-field"><label className="ld-lbl" htmlFor="kpi-by">By</label><input id="kpi-by" className="ld-in" placeholder="MM/DD/YYYY" aria-label="By date MM/DD/YYYY" value={d.by} onChange={(e) => setD({ ...d, by: e.target.value })} /></div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="ld-field">
          <label className="ld-lbl" htmlFor="kpi-src">Counted from</label>
          <select id="kpi-src" className="ld-in" style={{ maxWidth: 320 }} value={d.source} onChange={(e) => setD({ ...d, source: e.target.value as Kpi["source"] })}>
            {v.kpiSources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        {d.source === "manual" ? (
          <div className="ld-field"><label className="ld-lbl" htmlFor="kpi-now">Now</label><input id="kpi-now" className="ld-in" style={{ maxWidth: 140 }} inputMode="numeric" value={d.manual} onChange={(e) => setD({ ...d, manual: e.target.value.replace(/[^\d.]/g, "") })} /></div>
        ) : k ? (
          <KV label="Pace">{k.unit === "percent" ? `${fmtVal(k.value, k.unit)} against ${k.target}%.` : `${k.value} so far.${k.value < k.target ? ` ${k.target - k.value} more by ${short(k.byDate, tz)}.` : " Target reached."}`}</KV>
        ) : null}
        <ErrorLine error={save.error || remove.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending || !d.name.trim() || !d.target} onClick={() => save.mutate({ organizationId: currentOrgId, id: k?.id, launchId: v.launch.id, name: d.name, target: Number(d.target), by: d.by, source: d.source, manualValue: d.source === "manual" && d.manual ? Number(d.manual) : null })}>Save</button>
        <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
        {k && <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: k.id })}>Remove</button>}
      </div>
    </div>
  );
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: KQ }}>
        <span>KPI</span>
        <span>Target</span>
        <span>Now</span>
        <span>Pace</span>
        <span>Counted from</span>
        <span />
      </div>
      {v.kpis.length === 0 && editing !== "new" && <div className="ld-empty">No KPIs yet.</div>}
      {v.kpis.map((k) => (
        <React.Fragment key={k.id}>
          <div className={`ld-rw ${editing === k.id ? "open" : ""}`} style={{ gridTemplateColumns: KQ }}>
            <span className="ld-strong">{k.name}</span>
            <span>{fmtVal(k.target, k.unit)}</span>
            <span>{fmtVal(k.value, k.unit)}</span>
            <span className={`ld-pill ${k.pace === "on_pace" ? "green" : "amber"}`}>{k.pace === "on_pace" ? "On pace" : "Behind"}</span>
            <span>{k.who}</span>
            <button type="button" className="ld-btn" onClick={() => (editing === k.id ? setEditing(null) : begin(k))}>Edit</button>
          </div>
          {editing === k.id && form(k)}
        </React.Fragment>
      ))}
      {editing === "new" ? (
        form(null)
      ) : (
        <div style={{ padding: "12px 18px", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="ld-btn" style={{ width: 128 }} onClick={() => begin(null)}>Add KPI</button>
        </div>
      )}
    </>
  );
}

// ==========================================
// Reports
// ==========================================

const RQ = "minmax(0,2fr) 170px 140px 128px";
function Reports({ v, tz }: { v: View; tz: string }) {
  const [open, setOpen] = React.useState<number | null>(v.reports[0]?.id ?? null);
  const [copied, setCopied] = React.useState<number | null>(null);
  const copy = async (r: View["reports"][number]) => {
    const b = r.body;
    try {
      await navigator.clipboard.writeText([`Week ${r.week} of ${r.weeks}: ${v.launch.name} (${b.rating === "red" ? "Off track" : b.rating === "amber" ? "At risk" : r.status === "behind" ? "At risk" : "On track"})`, `Overall: ${b.overall}`, `Done this week: ${b.done}`, `Behind: ${b.behind}`, `Next week: ${b.next}`, ...(b.risks ? [`Risks: ${b.risks}`] : []), `Needs you: ${b.needsYou}`].join("\n"));
      setCopied(r.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: RQ }}>
        <span>Report</span>
        <span>Sent</span>
        <span>Status</span>
        <span />
      </div>
      {v.reports.length === 0 && <div className="ld-empty">The first report comes on the report day set on the Onboarding tab.</div>}
      {v.reports.map((r) => {
        const isOpen = open === r.id;
        return (
          <React.Fragment key={r.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: RQ, cursor: "pointer" }} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a")) return; setOpen(isOpen ? null : r.id); }}>
              <span className="ld-strong">{`Week ${r.week} of ${r.weeks}`}</span>
              <span>{day(r.createdAt, tz)}</span>
              {(() => {
                const rating = r.body.rating ?? (r.status === "behind" ? "amber" : "green");
                return <span className={`ld-pill ${rating}`}>{rating === "red" ? "Off track" : rating === "amber" ? "At risk" : "On track"}</span>;
              })()}
              <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : r.id)}>{isOpen ? "Close" : "Open"}</button>
            </div>
            {isOpen && (
              <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 24 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 820 }}>
                  <KV label="Overall">{r.body.overall}</KV>
                  <KV label="Done this week">{r.body.done}</KV>
                  <KV label="Behind">{r.body.behind}</KV>
                  <KV label="Next week">{r.body.next}</KV>
                  {r.body.risks && <KV label="Risks">{r.body.risks}</KV>}
                  <KV label="Needs you">{r.body.needsYou}</KV>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {v.launch.pjListId && <Link className="ld-btn" href={`/projects?list=${v.launch.pjListId}`}>Open in Projects</Link>}
                  <button type="button" className="ld-btn" onClick={() => copy(r)}>{copied === r.id ? "Copied" : "Copy"}</button>
                  <button type="button" className="ld-btn" onClick={() => setOpen(null)}>Close</button>
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
