import React from "react";
import type { FieldDef } from "./fields";
import { AddInline, Check, Counts, PRIORITY_TEXT, statusColor } from "./bits";
import { AssigneeCell, DateCell, FieldCell, PriorityCell, StatusCell, type QuickCtx, type QuickTask } from "./Quick";
import { ColumnsPlus, columnWidth, type ColKey } from "./Columns";
import type { PjCtx, TaskRow } from "../pages/Projects";

/** List view: tasks grouped by status (or priority, or person), the way ClickUp shows a list. Click a cell to change it. */

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

/** What quick edits on this task may do: the task's list decides its statuses and whether this person can edit. */
export function quickOf(c: PjCtx, t: TaskRow): QuickCtx {
  const list = c.data.lists.find((l) => l.id === t.listId);
  const level = c.data.levels[t.listId] ?? "view";
  return { orgId: c.orgId, people: c.data.people, statuses: list?.statuses ?? c.data.statuses, canEdit: level === "edit" || level === "full", refresh: c.refresh, today: c.data.today, tasks: c.tasks };
}

const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : "");

/** One cell of a row, by column key. */
export function CellFor({ c, t, k, fields }: { c: PjCtx; t: TaskRow; k: ColKey; fields: FieldDef[] }) {
  const q = quickOf(c, t);
  const qt: QuickTask = t;
  if (k === "assignee") return <AssigneeCell q={q} t={qt} />;
  if (k === "due") return <DateCell q={q} t={qt} which="dueDate" />;
  if (k === "start") return <DateCell q={q} t={qt} which="startDate" />;
  if (k === "priority") return <PriorityCell q={q} t={qt} />;
  if (k === "status") return <StatusCell q={q} t={qt} color={statusColor(c, t)} />;
  if (k === "estimate") return <span>{t.timeEstimate ? `${Math.round((t.timeEstimate / 60) * 10) / 10} h` : <span className="ld-small ld-muted">None</span>}</span>;
  if (k === "tracked") return <span>{hm(t.minutes)}</span>;
  if (k === "tags") return <span className="gp-ell">{t.tags.map((x) => <span key={x} className="gp-chip" style={{ marginRight: 4 }}>{x}</span>)}</span>;
  if (k === "goal") return <span>{t.goal ? <span className="gp-chip gp-ell">◎ {t.goal}</span> : null}</span>;
  if (k === "list") return <span className="ld-small gp-ell">{t.listName}</span>;
  if (k.startsWith("f:")) {
    const f = fields.find((x) => `f:${x.id}` === k);
    return f ? <FieldCell q={q} t={qt} f={f} fields={fields} /> : <span />;
  }
  return <span />;
}

export function ListView({ c }: { c: PjCtx }) {
  const groups = groupsOf(c);
  const fields = c.data.fields;
  const many = !c.listId;
  const cols = c.columns.filter((k) => !k.startsWith("f:") || fields.some((f) => `f:${f.id}` === k));
  const grid = { gridTemplateColumns: `minmax(0, 2.4fr) ${cols.map((k) => columnWidth(k, fields)).join(" ")} 28px` };
  return (
    <div className="gp-gl">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="gp-sg">
            <span className="gp-sgp" style={{ background: g.color }}>{g.label}</span>
            <span className="ld-small ld-muted">{g.tasks.length}</span>
          </div>
          <div className="gp-tr trh" style={grid}>
            <span>Name</span>
            {cols.map((k) => (
              <span key={k} className="gp-ell">{columnLabelFor(k, fields)}</span>
            ))}
            <ColumnsPlus c={c} columns={c.columns} onColumns={c.setColumns} fields={fields} many={many} />
          </div>
          {g.tasks.map((t) => (
            <div key={t.id} className={`gp-tr ${t.closed ? "done" : ""}`} style={grid} role="button" tabIndex={0} onClick={() => c.open(t.id)} onKeyDown={(e) => e.key === "Enter" && c.open(t.id)}>
              <span className="gp-tn">
                <Check c={c} t={t} />
                <span className="gp-ell">{t.name}</span>
                <Counts t={t} />
              </span>
              {cols.map((k) => (
                <CellFor key={k} c={c} t={t} k={k} fields={fields} />
              ))}
              <span />
            </div>
          ))}
          {c.group === "status" && (c.listId || g.tasks.length > 0) && <AddInline c={c} listId={c.listId} status={g.status} />}
        </div>
      ))}
      {!c.tasks.length && !c.listId && <div className="gp-empty">No tasks match.</div>}
    </div>
  );
}

function columnLabelFor(k: ColKey, fields: FieldDef[]) {
  if (k.startsWith("f:")) return fields.find((f) => `f:${f.id}` === k)?.name ?? "";
  return { assignee: "Assignee", due: "Due date", start: "Start date", priority: "Priority", status: "Status", estimate: "Estimate", tracked: "Tracked", tags: "Tags", goal: "Goal", list: "List" }[k] ?? k;
}

/** Table view: one row per task, the chosen fields as columns, like a spreadsheet. Click a cell to change it. */
export function TableView({ c }: { c: PjCtx }) {
  const fields = c.data.fields;
  const cols = c.columns.filter((k) => !k.startsWith("f:") || fields.some((f) => `f:${f.id}` === k));
  return (
    <div className="gp-gl gp-tablewrap">
      <table className="gp-table">
        <thead>
          <tr>
            <th>Name</th>
            {cols.map((k) => (
              <th key={k}>{columnLabelFor(k, fields)}</th>
            ))}
            <th style={{ width: 36 }}>
              <ColumnsPlus c={c} columns={c.columns} onColumns={c.setColumns} fields={fields} many={!c.listId} />
            </th>
          </tr>
        </thead>
        <tbody>
          {c.tasks.map((t) => (
            <tr key={t.id} tabIndex={0} onClick={() => c.open(t.id)} onKeyDown={(e) => e.key === "Enter" && c.open(t.id)}>
              <td className="nm">{t.name}</td>
              {cols.map((k) => (
                <td key={k} className="qc">{k === "tags" ? t.tags.join(", ") : <CellFor c={c} t={t} k={k} fields={fields} />}</td>
              ))}
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      {!c.tasks.length && <div className="gp-empty">No tasks yet.</div>}
    </div>
  );
}

