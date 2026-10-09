import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt, OwnerAvatar } from "../goals/shared";
import { dueText, NobodyAvatar } from "./bits";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";

/**
 * Home, the landing page of Projects: what needs a person (with Nora's fix
 * ready to apply), the open tasks by when, what each AI employee is on, and
 * each project's health.
 */
type HomeOut = Outputs["pj"]["home"];
type Row = HomeOut["todayTasks"][number];

const HEALTH_TEXT = { on: "On track", risk: "At risk", off: "Off track", done: "Done" } as const;

export function HomePage({ orgId, onOpenTask, onPick, onNewTask }: { orgId: number; onOpenTask: (id: number) => void; onPick: (w: Where) => void; onNewTask: () => void }) {
  const utils = trpc.useUtils();
  const h = trpc.pj.home.useQuery({ organizationId: orgId }, { refetchInterval: 30_000 });
  const refresh = () => Promise.all([utils.pj.home.invalidate(), utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.task.invalidate()]);
  const up = trpc.pj.update.useMutation({ onSuccess: refresh });
  const fix = trpc.pj.fixAttention.useMutation({ onSuccess: refresh });
  const [skipped, setSkipped] = React.useState<Set<number>>(new Set());
  const [later, setLater] = React.useState(false);
  const [weekAll, setWeekAll] = React.useState(false);
  const d = h.data;
  if (!d)
    return (
      <div className="gp-home">
        <ErrorLine error={h.error} />
        {h.isLoading && <p className="ld-muted">Loading</p>}
      </div>
    );
  const person = (a: Row["assignees"][number]) => d.people.find((p) => p.type === a.type && p.id === a.id) ?? { type: "name" as const, id: 0, name: a.name };
  const doneStatus = (listId: number) => {
    const l = d.lists.find((x) => x.id === listId);
    return l?.statuses.find((s) => s.type === "done") ?? l?.statuses.find((s) => s.type === "closed") ?? null;
  };
  const canEdit = (listId: number) => {
    const lv = d.lists.find((x) => x.id === listId)?.level;
    return lv === "edit" || lv === "full";
  };
  const row = (t: Row, attention?: HomeOut["attention"][number]) => {
    const late = t.dueDate && t.dueDate < d.today && !t.closed;
    const done = doneStatus(t.listId);
    return (
      <div key={t.id} className="gp-hrw" role="button" tabIndex={0} onClick={() => onOpenTask(t.id)} onKeyDown={(e) => e.key === "Enter" && onOpenTask(t.id)}>
        <button type="button" className={`gp-ck ${t.closed ? "on" : ""}`} aria-label={`Mark ${t.name} done`} disabled={!done || !canEdit(t.listId) || up.isPending} onClick={(e) => { e.stopPropagation(); if (done) up.mutate({ organizationId: orgId, id: t.id, patch: { status: done.name } }); }}>{t.closed ? "✓" : ""}</button>
        <span className="gp-hrn">
          <span className="gp-ell">{t.name}</span>
          <span className="gp-chip">{t.listName}</span>
          {attention && <span className="gp-chip warn">{attention.why}</span>}
        </span>
        <span className={`gp-hrd ${late ? "late" : t.dueDate === d.today ? "now" : ""}`}>{t.dueDate ? dueText(t.dueDate, d.today) : <span className="ld-muted">No date</span>}</span>
        <span className="gp-hra">{t.assignees.length ? t.assignees.slice(0, 2).map((a) => <OwnerAvatar key={`${a.type}:${a.id}`} o={person(a)} size={26} />) : <NobodyAvatar size={26} />}</span>
      </div>
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
              <span className="ld-small ld-muted">No date, no owner, or overdue</span>
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
              <button type="button" className="gp-addrow" onClick={() => onPick({ scope: "everything" })}>See all {d.attentionTotal} in Everything</button>
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
            {d.mineOnly ? "Nothing is assigned to you yet." : "No dated tasks yet."} <button type="button" className="gp-link" onClick={onNewTask}>+ Task</button>
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
              <span className="gp-hbar" aria-label={`${p.done} of ${p.total} done`}><i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`, background: p.health === "off" ? "#c2253c" : p.health === "risk" ? "#d97706" : "#1b6b4a" }} /></span>
              <span className={`gp-health ${p.health}`}>{HEALTH_TEXT[p.health]}</span>
            </button>
          ))}
          {!d.projects.length && <div className="gp-hempty">No lists with tasks yet.</div>}
        </section>
      </div>
    </div>
  );
}
