import React from "react";
import { fmtYmd } from "../goals/shared";
import { AddInline, Check, Counts, Due, Flag, People, PRIORITY_TEXT, statusColor, StatusTag } from "./bits";
import type { PjCtx, TaskRow } from "../pages/Projects";

/** List view: tasks grouped by status (or priority, or person), the way ClickUp shows a list. */

type Group = { key: string; label: string; color: string; status?: string; tasks: TaskRow[] };

export function groupsOf(c: PjCtx): Group[] {
  const t = c.tasks;
  if (c.group === "status")
    return c.data.statuses.map((s) => ({ key: s.name, label: s.name, color: s.color, status: s.name, tasks: t.filter((x) => x.status === s.name) })).filter((g, i) => g.tasks.length || c.listId || i === 0);
  if (c.group === "priority")
    return ["urgent", "high", "normal", "low", ""].map((p) => ({ key: p || "none", label: p ? PRIORITY_TEXT[p] : "No priority", color: p ? { urgent: "#c2253c", high: "#d97706", normal: "#2563eb", low: "#9aa8a2" }[p]! : "#87909e", tasks: t.filter((x) => (x.priority ?? "") === p) })).filter((g) => g.tasks.length);
  if (c.group === "assignee") {
    const names = Array.from(new Set(t.flatMap((x) => x.assignees.map((a) => a.name))));
    return [...names.map((n) => ({ key: n, label: n, color: "#475569", tasks: t.filter((x) => x.assignees.some((a) => a.name === n)) })), { key: "", label: "Unassigned", color: "#87909e", tasks: t.filter((x) => !x.assignees.length) }].filter((g) => g.tasks.length);
  }
  return [{ key: "all", label: "All tasks", color: "#475569", tasks: t }];
}

export function ListView({ c }: { c: PjCtx }) {
  const groups = groupsOf(c);
  const field = c.data.list?.fields.find((f) => f.type === "dropdown");
  const many = !c.listId;
  return (
    <div className="gp-gl">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="gp-sg">
            <span className="gp-sgp" style={{ background: g.color }}>{g.label}</span>
            <span className="ld-small ld-muted">{g.tasks.length}</span>
          </div>
          <div className="gp-tr trh">
            <span>Name</span>
            <span>Assignee</span>
            <span>Due date</span>
            <span>Priority</span>
            <span>{field ? field.name : many ? "List" : "Status"}</span>
            <span>Goal</span>
          </div>
          {g.tasks.map((t) => {
            const fv = field ? field.options?.find((o) => o.id === t.fields[field.id]) : null;
            return (
              <div key={t.id} className={`gp-tr ${t.closed ? "done" : ""}`} role="button" tabIndex={0} onClick={() => c.open(t.id)} onKeyDown={(e) => e.key === "Enter" && c.open(t.id)}>
                <span className="gp-tn">
                  <Check c={c} t={t} />
                  <span className="gp-ell">{t.name}</span>
                  <Counts t={t} />
                </span>
                <People c={c} list={t.assignees} />
                <Due t={t} today={c.data.today} />
                <Flag p={t.priority} />
                <span>{field ? fv ? <StatusTag name={fv.name} color={fv.color} /> : <span className="ld-small ld-muted">None</span> : many ? <span className="ld-small gp-ell">{t.listName}</span> : <StatusTag name={t.status} color={statusColor(c, t)} />}</span>
                <span>{t.goal ? <span className="gp-chip gp-ell">◎ {t.goal}</span> : null}</span>
              </div>
            );
          })}
          {c.group === "status" && (c.listId || g.tasks.length > 0) && <AddInline c={c} listId={c.listId} status={g.status} />}
        </div>
      ))}
      {!c.tasks.length && !c.listId && <div className="gp-empty">No tasks match.</div>}
    </div>
  );
}

/** Table view: one row per task, every field as a column, like a spreadsheet. Changes are made in the task. */
export function TableView({ c }: { c: PjCtx }) {
  const fields = c.data.list?.fields ?? [];
  const show = (t: TaskRow, f: (typeof fields)[number]) => {
    const v = t.fields[f.id];
    if (v === undefined || v === null || v === "") return "";
    if (f.type === "dropdown") return f.options?.find((o) => o.id === v)?.name ?? "";
    if (f.type === "date") return fmtYmd(String(v));
    if (f.type === "checkbox") return v ? "Yes" : "No";
    if (f.type === "money") return `$${Number(v).toLocaleString("en-US")}`;
    return String(v);
  };
  return (
    <div className="gp-gl gp-tablewrap">
      <table className="gp-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Assignees</th>
            <th>Start</th>
            <th>Due</th>
            <th>Priority</th>
            <th>Estimate</th>
            <th>Tags</th>
            {fields.map((f) => (
              <th key={f.id}>{f.name}</th>
            ))}
            {!c.listId && <th>List</th>}
            <th>Goal</th>
          </tr>
        </thead>
        <tbody>
          {c.tasks.map((t) => (
            <tr key={t.id} tabIndex={0} onClick={() => c.open(t.id)} onKeyDown={(e) => e.key === "Enter" && c.open(t.id)}>
              <td className="nm">{t.name}</td>
              <td><StatusTag name={t.status} color={statusColor(c, t)} /></td>
              <td>{t.assignees.map((a) => a.name).join(", ")}</td>
              <td>{fmtYmd(t.startDate)}</td>
              <td><Due t={t} today={c.data.today} /></td>
              <td>{t.priority ? PRIORITY_TEXT[t.priority] : ""}</td>
              <td>{t.timeEstimate ? `${Math.round((t.timeEstimate / 60) * 10) / 10} h` : ""}</td>
              <td>{t.tags.join(", ")}</td>
              {fields.map((f) => (
                <td key={f.id}>{show(t, f)}</td>
              ))}
              {!c.listId && <td>{t.listName}</td>}
              <td>{t.goal ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!c.tasks.length && <div className="gp-empty">No tasks yet.</div>}
    </div>
  );
}
