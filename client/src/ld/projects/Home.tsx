import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt, OwnerAvatar } from "../goals/shared";
import { dueText } from "./bits";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";

/**
 * Home, the landing page of Projects: the signed-in person's own tasks (what
 * needs them, with Nora's fix ready to apply, then by when), each with Find
 * time to put it on their calendar, what each AI employee is on, and each
 * project's health. Everyone's tasks are on All tasks for owners and admins.
 */
type HomeOut = Outputs["pj"]["home"];
type Row = HomeOut["todayTasks"][number];

const HEALTH_TEXT = { on: "On track", risk: "At risk", off: "Off track", done: "Done" } as const;
const LENGTHS = [{ m: 15, label: "15 min" }, { m: 30, label: "30 min" }, { m: 60, label: "1 hour" }, { m: 120, label: "2 hours" }] as const;
const WHENS = [{ k: "first", label: "First open time" }, { k: "tomorrow", label: "Tomorrow" }, { k: "next_week", label: "Next week" }] as const;
type When = (typeof WHENS)[number]["k"];

/** Find time, open below a row: how long and when, the time found, then Save. */
function FindTime({ orgId, taskId, hasTime, defaultMinutes, onDone }: { orgId: number; taskId: number; hasTime: boolean; defaultMinutes: number; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [minutes, setMinutes] = React.useState(defaultMinutes);
  const [when, setWhen] = React.useState<When>("first");
  const find = trpc.pj.findTime.useMutation();
  const save = trpc.pj.saveTime.useMutation({ onSuccess: async () => { await Promise.all([utils.pj.home.invalidate(), utils.calendar.invalidate()]); onDone(); } });
  const clear = trpc.pj.clearTime.useMutation({ onSuccess: async () => { await Promise.all([utils.pj.home.invalidate(), utils.calendar.invalidate()]); onDone(); } });
  const look = (m: number, w: When, after: Date | null = null) => find.mutate({ organizationId: orgId, taskId, minutes: m, when: w, after });
  React.useEffect(() => { look(minutes, when); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const r = find.data;
  return (
    <div className="gp-ft" onClick={(e) => e.stopPropagation()}>
      <div className="gp-ft-f">
        <span className="ld-lbl">How long</span>
        <span className="gp-ft-c" role="radiogroup" aria-label="How long">
          {LENGTHS.map((x) => (
            <button key={x.m} type="button" role="radio" aria-checked={minutes === x.m} className={`ld-chip ${minutes === x.m ? "on" : ""}`} onClick={() => { setMinutes(x.m); look(x.m, when); }}>{x.label}</button>
          ))}
        </span>
        <span className="ld-lbl">When</span>
        <span className="gp-ft-c" role="radiogroup" aria-label="When">
          {WHENS.map((x) => (
            <button key={x.k} type="button" role="radio" aria-checked={when === x.k} className={`ld-chip ${when === x.k ? "on" : ""}`} onClick={() => { setWhen(x.k); look(minutes, x.k); }}>{x.label}</button>
          ))}
        </span>
        <div className="gp-ft-found" aria-live="polite">
          {find.isPending ? <span className="ld-muted">Looking for an open time...</span> : r?.found ? (<><b>{r.text}</b><span>{r.why}</span></>) : r ? <span>{r.text}</span> : null}
        </div>
        <ErrorLine error={find.error || save.error || clear.error} />
      </div>
      <div className="gp-ft-b">
        <button type="button" className="ld-btn p" disabled={!r?.found || save.isPending} onClick={() => r?.found && save.mutate({ organizationId: orgId, taskId, start: new Date(r.start), minutes: r.minutes })}>Save</button>
        <button type="button" className="ld-btn" disabled={!r?.found || find.isPending} onClick={() => r?.found && look(minutes, when, new Date(r.start))}>Another time</button>
        {hasTime && <button type="button" className="ld-btn" disabled={clear.isPending} onClick={() => clear.mutate({ organizationId: orgId, taskId })}>Remove time</button>}
        <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

export function HomePage({ orgId, onOpenTask, onPick, onNewTask }: { orgId: number; onOpenTask: (id: number) => void; onPick: (w: Where) => void; onNewTask: () => void }) {
  const utils = trpc.useUtils();
  const h = trpc.pj.home.useQuery({ organizationId: orgId }, { refetchInterval: 30_000 });
  const refresh = () => Promise.all([utils.pj.home.invalidate(), utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.task.invalidate()]);
  const up = trpc.pj.update.useMutation({ onSuccess: refresh });
  const fix = trpc.pj.fixAttention.useMutation({ onSuccess: refresh });
  const [skipped, setSkipped] = React.useState<Set<number>>(new Set());
  const [later, setLater] = React.useState(false);
  const [weekAll, setWeekAll] = React.useState(false);
  const [finding, setFinding] = React.useState<number | null>(null);
  const settings = trpc.pj.findTimeSettings.useQuery({ organizationId: orgId });
  const d = h.data;
  if (!d)
    return (
      <div className="gp-home">
        <ErrorLine error={h.error} />
        {h.isLoading && <p className="ld-muted">Loading</p>}
      </div>
    );
  const doneStatus = (listId: number) => {
    const l = d.lists.find((x) => x.id === listId);
    return l?.statuses.find((s) => s.type === "done") ?? l?.statuses.find((s) => s.type === "closed") ?? null;
  };
  const openStatus = (listId: number) => d.lists.find((x) => x.id === listId)?.statuses.find((s) => s.type !== "done" && s.type !== "closed") ?? null;
  const canEdit = (listId: number) => {
    const lv = d.lists.find((x) => x.id === listId)?.level;
    return lv === "edit" || lv === "full";
  };
  const row = (t: Row, attention?: HomeOut["attention"][number]) => {
    const late = t.dueDate && t.dueDate < d.today && !t.closed;
    const done = doneStatus(t.listId);
    const back = openStatus(t.listId);
    const time = t.time;
    const isFinding = finding === t.id;
    const timeDay = time && time.day !== d.today ? dueText(time.day, d.today) : null;
    return (
      <React.Fragment key={t.id}>
        <div className={`gp-hrw ${t.closed ? "done" : ""}`} role="button" tabIndex={0} onClick={() => onOpenTask(t.id)} onKeyDown={(e) => e.key === "Enter" && onOpenTask(t.id)}>
          <button type="button" className={`gp-ck ${t.closed ? "on" : ""}`} aria-label={t.closed ? `${t.name} is done` : `Mark ${t.name} done`} disabled={t.closed || !done || !canEdit(t.listId) || up.isPending} onClick={(e) => { e.stopPropagation(); if (done) up.mutate({ organizationId: orgId, id: t.id, patch: { status: done.name } }); }}>{t.closed ? "✓" : ""}</button>
          <span className="gp-hrn">
            <span className="gp-ell">{t.name}</span>
            <span className="gp-chip">{t.listName}</span>
            {attention && <span className="gp-chip warn">{attention.why}</span>}
          </span>
          <span className={`gp-hrd ${late ? "late" : t.dueDate === d.today ? "now" : ""}`}>
            {t.dueDate ? dueText(t.dueDate, d.today) : <span className="ld-muted">No date</span>}
            {t.closed ? <span className="gp-slot">Done</span> : time && <span className="gp-slot">{timeDay ? `${timeDay}, ` : ""}{time.text}</span>}
            {!t.closed && time?.movedFrom && <span className="gp-moved">Moved from {time.movedFrom}, not done</span>}
          </span>
          {t.closed ? (
            <button type="button" className="ld-btn gp-hbtn" disabled={!back || !canEdit(t.listId) || up.isPending} onClick={(e) => { e.stopPropagation(); if (back) up.mutate({ organizationId: orgId, id: t.id, patch: { status: back.name } }); }}>Undo</button>
          ) : (
            <button type="button" className="ld-btn gp-hbtn" aria-expanded={isFinding} onClick={(e) => { e.stopPropagation(); setFinding(isFinding ? null : t.id); }}>{isFinding ? "Close" : time ? "Change time" : "Find time"}</button>
          )}
        </div>
        {isFinding && <FindTime orgId={orgId} taskId={t.id} hasTime={!!time} defaultMinutes={settings.data?.minutes ?? 60} onDone={() => setFinding(null)} />}
      </React.Fragment>
    );
  };
  const need = d.attention.filter((t) => !skipped.has(t.id));
  const fixable = need.filter((t) => t.suggestion);
  const week = weekAll ? d.week : d.week.slice(0, 5);
  return (
    <div className="gp-home">
      <div className="gp-home-l">
        {need.length > 0 && (
          <section className="gp-hcard attn" aria-label="Needs attention">
            <div className="gp-hch">
              <b>Needs attention <span className="ld-muted">{d.attentionTotal}</span></b>
              <span className="ld-small ld-muted">Your tasks with no date, past due, or moved 3 times</span>
            </div>
            {need.map((t) => row({ ...t, closed: false }, t))}
            {fixable.length > 0 && (
              <div className="gp-hsug">
                <span style={{ minWidth: 0 }}>
                  <b>Nora suggests</b>
                  {fixable.slice(0, 3).map((t) => (
                    <span key={t.id} className="gp-hsl"><span className="gp-ell">{t.name}</span>: {t.suggestion!.say}</span>
                  ))}
                  {fixable.length > 3 && <span className="gp-hsl ld-muted">and {fixable.length - 3} more</span>}
                </span>
                <span className="ld-row">
                  <button type="button" className="ld-btn p sm" disabled={fix.isPending} onClick={() => fix.mutate({ organizationId: orgId, ids: fixable.map((t) => t.id) })}>Apply all</button>
                  <button type="button" className="ld-btn sm" onClick={() => setSkipped(new Set(Array.from(skipped).concat(fixable.map((t) => t.id))))}>Skip</button>
                </span>
              </div>
            )}
            {d.attentionTotal > d.attention.length && (
              <button type="button" className="gp-addrow" onClick={() => onPick({ scope: "mine" })}>See all {d.attentionTotal} in My tasks</button>
            )}
            <ErrorLine error={fix.error || up.error} />
          </section>
        )}
        <section className="gp-hcard" aria-label="Today">
          <div className="gp-hch"><b>Today <span className="ld-muted">{d.todayTasks.length}</span></b></div>
          {d.todayTasks.length ? d.todayTasks.map((t) => row(t)) : <div className="gp-hempty">Nothing due today.</div>}
        </section>
        <section className="gp-hcard" aria-label="Next 7 days">
          <div className="gp-hch"><b>Next 7 days <span className="ld-muted">{d.week.length}</span></b></div>
          {d.week.length ? week.map((t) => row(t)) : <div className="gp-hempty">Nothing else due in the next 7 days.</div>}
          {d.week.length > 5 && <button type="button" className="gp-addrow" onClick={() => setWeekAll((v) => !v)}>{weekAll ? "Show fewer" : `${d.week.length - 5} more`}</button>}
        </section>
        <section className="gp-hcard" aria-label="Later">
          <div className="gp-hch">
            <b>Later <span className="ld-muted">{d.later.length}</span>{d.undated > 0 && <span className="ld-small ld-muted"> · {d.undated} with no date</span>}</b>
            <button type="button" className="gp-link" onClick={() => setLater((v) => !v)}>{later ? "Collapse" : "Show"}</button>
          </div>
          {later && (d.later.length ? d.later.map((t) => row(t)) : <div className="gp-hempty">Nothing further out.</div>)}
        </section>
        {!d.todayTasks.length && !d.week.length && !d.later.length && !need.length && (
          <div className="gp-hempty" style={{ textAlign: "center" }}>
            Nothing is assigned to you yet.{d.manager ? " Everyone's tasks are on All tasks." : ""} <button type="button" className="gp-link" onClick={onNewTask}>+ Task</button>
          </div>
        )}
      </div>
      <div className="gp-home-r">
        <section className="gp-hcard" aria-label="AI team today">
          <div className="gp-hch"><b>AI team today</b></div>
          {d.team.filter((e) => e.active).map((e) => (
            <div key={e.id} className="gp-hteam">
              <OwnerAvatar o={{ type: "employee", id: e.id, name: e.name, avatarUrl: e.avatar, kind: e.kind }} size={30} />
              <span style={{ minWidth: 0 }}>
                <b>{e.name}</b>
                <span className="gp-hline">{e.taskId ? <button type="button" className="gp-link" style={{ textAlign: "left" }} onClick={() => onOpenTask(e.taskId!)}>{e.line}</button> : e.line}</span>
                <span className="ld-small ld-muted">{e.working ? "Working now" : e.at ? fmtAt(e.at) : ""}</span>
              </span>
            </div>
          ))}
          {d.team.some((e) => !e.active) && <div className="gp-hempty">{d.team.filter((e) => !e.active).length} {d.team.some((e) => e.active) ? "others have" : "employees have"} nothing in Projects yet today.</div>}
          {!d.team.length && <div className="gp-hempty">No AI employees yet.</div>}
        </section>
        <section className="gp-hcard" aria-label="Projects">
          <div className="gp-hch">
            <b>Projects</b>
            <span className="ld-small ld-muted">
              {(["on", "risk", "off"] as const).map((k) => ({ k, n: d.projects.filter((p) => p.health === k).length })).filter((x) => x.n).map((x) => `${HEALTH_TEXT[x.k].toLowerCase()} ${x.n}`).join(" · ")}
            </span>
          </div>
          {d.projects.map((p) => (
            <button key={p.id} type="button" className="gp-hproj" onClick={() => onPick({ scope: "list", listId: p.id })}>
              <span className="gp-fi" style={{ background: p.folderColor ?? "#475569" }} />
              <span className="gp-hpn">
                <span className="gp-ell">{p.name}</span>
                {p.due && <span className="ld-small ld-muted">{dueText(p.due, d.today)}</span>}
              </span>
              <span className="gp-hbar" aria-label={`${p.done} of ${p.total} done`}><i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`, background: p.health === "off" ? "var(--ld-red)" : p.health === "risk" ? "var(--ld-warn)" : "var(--ld-accent)" }} /></span>
              <span className={`gp-health ${p.health}`}>{HEALTH_TEXT[p.health]}</span>
            </button>
          ))}
          {!d.projects.length && <div className="gp-hempty">No lists with tasks yet.</div>}
        </section>
      </div>
    </div>
  );
}
