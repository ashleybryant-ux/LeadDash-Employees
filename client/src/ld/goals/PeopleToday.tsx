import React from "react";
import { Link } from "wouter";
import { fmtYmd, OwnerAvatar, OwnerName, ownerKey } from "./shared";
import type { GoalsCtx } from "../pages/Goals";

/** People: each person and employee with their goals, how often they hit their measures, and what moved this week. */
export function PeopleView({ c, onOwner }: { c: GoalsCtx; onOwner: (key: string) => void }) {
  const t = c.data.team;
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <h3>Who owns what</h3>
        <span className="ld-small ld-muted">People and employees, side by side</span>
      </div>
      <div className="gp-pch">
        <span>Owner</span>
        <span>Goals</span>
        <span>Measures hit</span>
        <span>What moved this week</span>
        <span />
      </div>
      {t.people.map((p) => (
        <div key={ownerKey(p.owner)} className="gp-pc">
          <OwnerName o={p.owner} size={28} />
          <span>{p.goals ? `${p.goalsOn} of ${p.goals} on track` : "No goals"}</span>
          <span>{p.counted ? `${p.hit} of ${p.counted} weeks` : "No measures"}</span>
          <span className="ld-small ld-muted gp-ell2">{p.moved.length ? p.moved.join(" · ") : "Nothing finished yet this week"}</span>
          <button type="button" className="ld-btn sm" onClick={() => onOwner(ownerKey(p.owner))}>Open</button>
        </div>
      ))}
      <div className="gp-pc foot">
        <span className="ld-small">
          <b>The AI team this week:</b> {t.employeeTasks} task{t.employeeTasks === 1 ? "" : "s"} finished, {t.employeeTasksOnGoals} tied to a goal{t.employeeTasks - t.employeeTasksOnGoals > 0 ? `, ${t.employeeTasks - t.employeeTasksOnGoals} not tied to any goal` : ""}.
        </span>
      </div>
    </div>
  );
}

/** Today: tasks due today or late, and what got done today, each with the goal it moves. */
export function TodayView({ c }: { c: GoalsCtx }) {
  const list = c.data.today_;
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <h3>Today · {fmtYmd(c.data.today)}</h3>
        <span className="ld-small ld-muted">Tasks due today or late, and what's done today</span>
      </div>
      <div className="gp-tdh">
        <span>Task</span>
        <span>Who</span>
        <span>Moves</span>
        <span>Status</span>
      </div>
      {list.length === 0 && <div className="gp-empty">Nothing due today. Tasks in Projects with today's date show up here.</div>}
      {list.map((t) => (
        <Link key={t.id} href={`/projects?task=${t.id}`} className="gp-td">
          <span className="gp-ell">
            {t.name}
            <span className="ld-small ld-muted"> · {t.listName}</span>
          </span>
          <span className="ld-row">
            {t.who.slice(0, 3).map((w) => (
              <OwnerAvatar key={`${w.type}:${w.id}:${w.name}`} o={w} size={24} />
            ))}
            <span className="gp-ell">{t.who.map((w) => w.name).join(", ") || "No one"}</span>
          </span>
          <span className={t.goal ? "" : "ld-muted"}>{t.goal ?? "Not tied to a goal"}</span>
          <span>
            <span className={`ld-pill ${t.done ? "green" : t.waiting ? "red" : t.late ? "amber" : "gray"}`}>{t.done ? "Done" : t.waiting ? "Waiting on you" : t.late ? `Late, due ${fmtYmd(t.dueDate)}` : t.status}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
