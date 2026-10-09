import React from "react";
import { trpc } from "@/lib/trpc";
import type { FieldDef } from "./fields";
import { AddInline, Check, Counts, dueText, PRIORITY_TEXT, SelectBox, statusColor } from "./bits";
import { AssigneeCell, DateCell, FieldCell, PriorityCell, StatusCell, type QuickCtx, type QuickTask } from "./Quick";
import { ColumnsPlus, columnWidth, type ColKey } from "./Columns";
import type { PjCtx, TaskRow } from "../pages/Projects";

/**
 * List view: tasks grouped by project (folder and list), status, priority or
 * person, the way ClickUp shows a list. Click a cell to change it; tick the
 * box on a row to change many at once; drag a row to reorder it.
 */

type Group = { key: string; label: string; color: string; status?: string; listId?: number; folder?: string; note?: string; health?: "on" | "risk" | "off" | "done"; attention?: boolean; tasks: TaskRow[] };

const HEALTH_TEXT = { on: "On track", risk: "At risk", off: "Off track", done: "Done" } as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Why a task needs a person: no owner, no date, or a date that has passed. */
export function attentionWhy(t: TaskRow, today: string): string[] {
  if (t.closed) return [];
  const why: string[] = [];
  if (!t.assignees.length) why.push("No owner");
  if (!t.dueDate) why.push("No date");
  else if (t.dueDate < today) why.push("Overdue");
  return why;
}

/** A project's health from its open tasks: off track when a third or more are late, at risk when any is. */
function healthOf(tasks: TaskRow[], today: string) {
  const open = tasks.filter((t) => !t.closed);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today).length;
  if (!open.length) return "done" as const;
  if (overdue && overdue / open.length >= 1 / 3) return "off" as const;
  return overdue ? ("risk" as const) : ("on" as const);
}

export function sortTasks(tasks: TaskRow[], sort: PjCtx["sort"]) {
  if (sort === "manual") return tasks;
  const by = [...tasks];
  if (sort === "due") by.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.sort - b.sort);
  if (sort === "priority") by.sort((a, b) => (PRIORITY_RANK[a.priority ?? ""] ?? 9) - (PRIORITY_RANK[b.priority ?? ""] ?? 9) || a.sort - b.sort);
  if (sort === "name") by.sort((a, b) => a.name.localeCompare(b.name));
  return by;
}

export function groupsOf(c: PjCtx): Group[] {
  const t = sortTasks(c.tasks, c.sort);
  const today = c.data.today;
  if (c.group === "project") {
    const lists = [...c.data.lists].sort((a, b) => (a.folderId ?? 1e9) - (b.folderId ?? 1e9) || a.sort - b.sort || a.id - b.id);
    const groups: Group[] = lists
      .map((l) => {
        const tasks = t.filter((x) => x.listId === l.id);
        const open = tasks.filter((x) => !x.closed);
        const ends = tasks.map((x) => x.dueDate).filter(Boolean) as string[];
        const last = ends.length ? ends.sort().at(-1)! : null;
        return { key: `l${l.id}`, label: l.name, color: l.folderColor ?? "#475569", listId: l.id, folder: l.folderName ?? undefined, note: `${open.length} open${last ? ` · due ${dueText(last, today)}` : ""}`, health: tasks.length ? healthOf(tasks, today) : undefined, tasks };
      })
      .filter((g) => g.tasks.length || c.listId === g.listId);
    // What needs a person comes first, across every project.
    const need = t.filter((x) => attentionWhy(x, today).length);
    if (need.length && !c.listId) groups.unshift({ key: "attention", label: "Needs attention", color: "#c2253c", attention: true, note: `${need.length} with no date, no owner, or overdue`, tasks: need });
    return groups;
  }
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

/** Whether any shown task has something in this column; empty columns stay hidden until someone picks them. */
export function columnHasValue(k: ColKey, tasks: TaskRow[]) {
  if (k === "status" || k === "list" || k === "assignee" || k === "due") return true;
  return tasks.some((t) => {
    if (k === "start") return !!t.startDate;
    if (k === "priority") return !!t.priority;
    if (k === "estimate") return !!t.timeEstimate;
    if (k === "tracked") return !!t.minutes;
    if (k === "tags") return t.tags.length > 0;
    if (k === "goal") return !!t.goal;
    if (k.startsWith("f:")) {
      const v = t.fields[k.slice(2)];
      return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
    }
    return true;
  });
}

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

/** The columns to draw: the picked ones, less the empty ones nobody picked on purpose; two when a task is open beside the list. */
export function shownColumns(c: PjCtx) {
  const fields = c.data.fields;
  if (c.compact) return ["assignee", "due"] as ColKey[];
  const cols = c.columns.filter((k) => !k.startsWith("f:") || fields.some((f) => `f:${f.id}` === k));
  return c.autoColumns ? cols.filter((k) => columnHasValue(k, c.tasks)) : cols;
}

export function ListView({ c }: { c: PjCtx }) {
  const groups = groupsOf(c);
  const fields = c.data.fields;
  const many = !c.listId;
  const cols = shownColumns(c);
  const grid = { gridTemplateColumns: `minmax(0, 2.4fr) ${cols.map((k) => (c.compact && k === "due" ? "150px" : columnWidth(k, fields))).join(" ")} 28px` };
  const [shut, setShut] = React.useState<Set<string>>(new Set());
  const [drag, setDrag] = React.useState<{ id: number; group: string } | null>(null);
  const [over, setOver] = React.useState<number | null>(null);
  const reorder = trpc.pj.reorder.useMutation({ onSuccess: () => c.refresh() });
  const fix = trpc.pj.fixAttention.useMutation({ onSuccess: () => c.refresh() });
  const canDrag = c.sort === "manual";
  const drop = (g: Group, toId: number) => {
    if (!drag || drag.group !== g.key || drag.id === toId) return;
    const ids = g.tasks.map((t) => t.id).filter((id) => id !== drag.id);
    ids.splice(ids.indexOf(toId), 0, drag.id);
    reorder.mutate({ organizationId: c.orgId, ids });
  };
  const toggleShut = (k: string) => setShut((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    <div className={`gp-gl ${c.group === "project" ? "gp-byproject" : ""}`}>
      {groups.map((g) => {
        const closedUp = shut.has(g.key);
        const head =
          c.group === "project" ? (
            <div className={`gp-pg ${g.attention ? "attn" : ""}`}>
              <button type="button" className="gp-car" aria-expanded={!closedUp} aria-label={closedUp ? `Show ${g.label}` : `Hide ${g.label}`} onClick={() => toggleShut(g.key)}>{closedUp ? "▸" : "▾"}</button>
              {g.attention ? <span className="gp-sgp" style={{ background: "#fde8e8", color: "#9b1c1c" }}>Needs attention</span> : <span className="gp-fi" style={{ background: g.color }} />}
              {!g.attention && (
                <span className="gp-pgn">
                  {g.folder && <span className="ld-muted">{g.folder} › </span>}
                  <b>{g.label}</b>
                </span>
              )}
              <span className="ld-small ld-muted">{closedUp ? `${g.tasks.length} task${g.tasks.length === 1 ? "" : "s"} · collapsed` : g.note}</span>
              <span className="gp-pgr">
                {g.attention && (c.level === "edit" || c.level === "full") && (
                  <button type="button" className="ld-btn sm gp-auto" disabled={fix.isPending} onClick={() => fix.mutate({ organizationId: c.orgId, ids: g.tasks.map((t) => t.id) })}>Let Nora fix these</button>
                )}
                {g.health && g.health !== "done" && <span className={`gp-health ${g.health}`}>{HEALTH_TEXT[g.health]}</span>}
              </span>
            </div>
          ) : (
            <div className="gp-sg">
              <button type="button" className="gp-car" aria-expanded={!closedUp} aria-label={closedUp ? `Show ${g.label}` : `Hide ${g.label}`} onClick={() => toggleShut(g.key)}>{closedUp ? "▸" : "▾"}</button>
              <span className="gp-sgp" style={{ background: g.color }}>{g.label}</span>
              <span className="ld-small ld-muted">{g.tasks.length}</span>
            </div>
          );
        return (
          <div key={g.key} className={g.attention ? "gp-attn" : ""}>
            {head}
            {!closedUp && (
              <>
                {!c.compact && (
                  <div className="gp-tr trh" style={grid}>
                    <span>Name</span>
                    {cols.map((k) => (
                      <span key={k} className="gp-ell">{columnLabelFor(k, fields)}</span>
                    ))}
                    <ColumnsPlus c={c} columns={c.columns} onColumns={c.setColumns} fields={fields} many={many} />
                  </div>
                )}
                {g.tasks.map((t) => (
                  <div
                    key={t.id}
                    className={`gp-tr ${t.closed ? "done" : ""} ${c.selected.has(t.id) ? "sel" : ""} ${c.openId === t.id ? "open" : ""} ${over === t.id && drag && drag.id !== t.id ? "over" : ""}`}
                    style={grid}
                    role="button"
                    tabIndex={0}
                    data-task={t.id}
                    draggable={canDrag && !g.attention}
                    onDragStart={(e) => { setDrag({ id: t.id, group: g.key }); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => { if (drag && drag.group === g.key) { e.preventDefault(); setOver(t.id); } }}
                    onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
                    onDrop={(e) => { e.preventDefault(); drop(g, t.id); setDrag(null); setOver(null); }}
                    onDragEnd={() => { setDrag(null); setOver(null); }}
                    onClick={() => c.open(t.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") c.open(t.id); if (e.key.toLowerCase() === "x") { e.preventDefault(); c.toggle(t.id, e.shiftKey); } }}
                  >
                    <span className="gp-tn">
                      <SelectBox c={c} id={t.id} />
                      <Check c={c} t={t} />
                      <span className="gp-ell">{t.name}</span>
                      {g.attention && !c.compact && <span className="gp-chip">{t.listName}</span>}
                      {!c.compact && <Counts t={t} />}
                      {g.attention && !c.compact && <span className="gp-chip warn">{attentionWhy(t, c.data.today).join(", ")}</span>}
                    </span>
                    {cols.map((k) => (
                      <CellFor key={k} c={c} t={t} k={k} fields={fields} />
                    ))}
                    <span />
                  </div>
                ))}
                {!c.compact && !g.attention && (c.group === "status" || c.group === "project") && (c.listId || g.tasks.length > 0 || c.group === "project") && <AddInline c={c} listId={g.listId ?? c.listId} status={g.status} />}
              </>
            )}
          </div>
        );
      })}
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
  const tasks = sortTasks(c.tasks, c.sort);
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
          {tasks.map((t) => (
            <tr key={t.id} tabIndex={0} className={c.selected.has(t.id) ? "sel" : ""} data-task={t.id} onClick={() => c.open(t.id)} onKeyDown={(e) => { if (e.key === "Enter") c.open(t.id); if (e.key.toLowerCase() === "x") { e.preventDefault(); c.toggle(t.id, e.shiftKey); } }}>
              <td className="nm">
                <span className="gp-tn">
                  <SelectBox c={c} id={t.id} />
                  {t.name}
                </span>
              </td>
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
