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

export function sortTasks(tasks: TaskRow[], sort: PjCtx["sort"], dir: "asc" | "desc" = "asc") {
  if (sort === "manual") return tasks;
  const by = [...tasks];
  if (sort === "due") by.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.sort - b.sort);
  if (sort === "priority") by.sort((a, b) => (PRIORITY_RANK[a.priority ?? ""] ?? 9) - (PRIORITY_RANK[b.priority ?? ""] ?? 9) || a.sort - b.sort);
  if (sort === "name") by.sort((a, b) => a.name.localeCompare(b.name));
  return dir === "desc" ? by.reverse() : by;
}

/** Which bucket a due date falls in, for Group: Due date. */
export function dueBucket(due: string | null, today: string): string {
  if (!due) return "none";
  if (due < today) return "overdue";
  if (due === today) return "today";
  const diff = Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (diff === 1) return "tomorrow";
  if (diff <= 7) return "week";
  if (diff <= 14) return "next";
  return "later";
}
const DUE_BUCKETS: { key: string; label: string; color: string }[] = [
  { key: "overdue", label: "Overdue", color: "#c2253c" },
  { key: "today", label: "Today", color: "#1b6b4a" },
  { key: "tomorrow", label: "Tomorrow", color: "#2563eb" },
  { key: "week", label: "This week", color: "#0f766e" },
  { key: "next", label: "Next week", color: "#7c3aed" },
  { key: "later", label: "Later", color: "#475569" },
  { key: "none", label: "No date", color: "#87909e" },
];

/** Tasks with their subtasks as rows of their own (Subtasks: separate). */
export function withSubtasks(c: PjCtx, tasks: TaskRow[]) {
  if (c.subtaskMode !== "separate") return tasks;
  const ids = new Set(tasks.map((t) => t.id));
  return [...tasks, ...c.subtasks.filter((s) => !ids.has(s.id))];
}

export function groupsOf(c: PjCtx): Group[] {
  const t = sortTasks(withSubtasks(c, c.tasks), c.sort, c.sortDir);
  const today = c.data.today;
  const keepEmpty = !!c.opts.showEmpty;
  const order = (groups: Group[]) => (c.dir === "desc" ? [...groups].reverse() : groups);
  if (c.group === "tags") {
    const names = Array.from(new Set(t.flatMap((x) => x.tags))).sort();
    return order([...names.map((n) => ({ key: `t:${n}`, label: n, color: "#0f766e", tasks: t.filter((x) => x.tags.includes(n)) })), { key: "none", label: "No tags", color: "#87909e", tasks: t.filter((x) => !x.tags.length) }].filter((g) => g.tasks.length || keepEmpty));
  }
  if (c.group === "due") return order(DUE_BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color, tasks: t.filter((x) => dueBucket(x.dueDate, today) === b.key) })).filter((g) => g.tasks.length || keepEmpty));
  if (c.group.startsWith("f:")) {
    const f = c.data.fields.find((x) => `f:${x.id}` === c.group);
    if (!f) return [{ key: "all", label: "All tasks", color: "#475569", tasks: t }];
    const valueOf = (x: TaskRow): string[] => {
      const v = x.fields[f.id];
      if (v === undefined || v === null || v === "") return [];
      if (Array.isArray(v)) return v.map((y) => (typeof y === "object" && y && "name" in y ? String((y as { name: string }).name) : String(y)));
      if (typeof v === "boolean") return [v ? "Yes" : "No"];
      if (typeof v === "object") return ["name" in v ? String((v as { name: string }).name) : JSON.stringify(v)];
      return [String(v)];
    };
    const opts = (f as { options?: string[] }).options ?? [];
    const found = Array.from(new Set(t.flatMap(valueOf)));
    const names = [...opts.filter((o) => found.includes(o) || keepEmpty), ...found.filter((n) => !opts.includes(n)).sort()];
    return order([...names.map((n) => ({ key: `v:${n}`, label: n, color: "#2563eb", tasks: t.filter((x) => valueOf(x).includes(n)) })), { key: "none", label: `No ${f.name}`, color: "#87909e", tasks: t.filter((x) => !valueOf(x).length) }].filter((g) => g.tasks.length || keepEmpty));
  }
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
      .filter((g) => g.tasks.length || c.listId === g.listId || keepEmpty);
    // What needs a person comes first, across every project.
    const need = t.filter((x) => attentionWhy(x, today).length);
    const out = order(groups);
    if (need.length && !c.listId) out.unshift({ key: "attention", label: "Needs attention", color: "#c2253c", attention: true, note: `${need.length} with no date, no owner, or overdue`, tasks: need });
    return out;
  }
  if (c.group === "status")
    return order(c.data.statuses.map((s) => ({ key: s.name, label: s.name, color: s.color, status: s.name, tasks: t.filter((x) => x.status === s.name) })).filter((g, i) => g.tasks.length || c.listId || i === 0 || keepEmpty));
  if (c.group === "priority")
    return order(["urgent", "high", "normal", "low", ""].map((p) => ({ key: p || "none", label: p ? PRIORITY_TEXT[p] : "No priority", color: p ? { urgent: "#c2253c", high: "#d97706", normal: "#2563eb", low: "#9aa8a2" }[p]! : "#87909e", tasks: t.filter((x) => (x.priority ?? "") === p) })).filter((g) => g.tasks.length || keepEmpty));
  if (c.group === "assignee") {
    const names = Array.from(new Set(t.flatMap((x) => x.assignees.map((a) => a.name))));
    return order([...names.map((n) => ({ key: n, label: n, color: "#475569", tasks: t.filter((x) => x.assignees.some((a) => a.name === n)) })), { key: "", label: "Unassigned", color: "#87909e", tasks: t.filter((x) => !x.assignees.length) }].filter((g) => g.tasks.length || keepEmpty));
  }
  return [{ key: "all", label: "All tasks", color: "#475569", tasks: t }];
}

const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`;

/** Where a task lives, for Show task locations: "Folder › List". */
function locationOf(c: PjCtx, t: TaskRow) {
  const l = c.data.lists.find((x) => x.id === t.listId);
  return l ? `${l.folderName ? `${l.folderName} › ` : ""}${l.name}` : t.listName;
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
  const parentName = (t: TaskRow) => (t.parentId ? c.tasks.find((p) => p.id === t.parentId)?.name ?? c.subtasks.find((p) => p.id === t.parentId)?.name ?? "" : "");
  const expanded = c.subtaskMode === "expanded";
  const rowFor = (g: Group, t: TaskRow, sub = false) => (
    <div
      key={t.id}
      className={`gp-tr ${t.closed ? "done" : ""} ${c.selected.has(t.id) ? "sel" : ""} ${c.openId === t.id ? "open" : ""} ${over === t.id && drag && drag.id !== t.id ? "over" : ""} ${sub ? "sub" : ""}`}
      style={grid}
      role="button"
      tabIndex={0}
      data-task={t.id}
      draggable={canDrag && !g.attention && !sub}
      onDragStart={(e) => { setDrag({ id: t.id, group: g.key }); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { if (drag && drag.group === g.key) { e.preventDefault(); setOver(t.id); } }}
      onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
      onDrop={(e) => { e.preventDefault(); drop(g, t.id); setDrag(null); setOver(null); }}
      onDragEnd={() => { setDrag(null); setOver(null); }}
      onClick={() => c.open(t.id)}
      onKeyDown={(e) => { if (e.key === "Enter") c.open(t.id); if (e.key.toLowerCase() === "x") { e.preventDefault(); c.toggle(t.id, e.shiftKey); } }}
    >
      <span className="gp-tn" style={sub ? { paddingLeft: 26 } : undefined}>
        <SelectBox c={c} id={t.id} />
        <Check c={c} t={t} />
        {sub && <span className="ld-muted" aria-hidden="true">⤷</span>}
        {c.opts.parentNames && t.parentId && !c.compact && parentName(t) && <span className="ld-small ld-muted gp-ell" style={{ flexShrink: 1 }}>{parentName(t)} ›</span>}
        <span className="gp-ell">{t.name}</span>
        {(g.attention || c.opts.locations) && !c.compact && <span className="gp-chip">{c.opts.locations ? locationOf(c, t) : t.listName}</span>}
        {!c.compact && !expanded && <Counts t={t} />}
        {!c.compact && expanded && <Counts t={{ ...t, subtasks: 0 }} />}
        {g.attention && !c.compact && <span className="gp-chip warn">{attentionWhy(t, c.data.today).join(", ")}</span>}
      </span>
      {cols.map((k) => (
        <CellFor key={k} c={c} t={t} k={k} fields={fields} />
      ))}
      <span />
    </div>
  );
  return (
    <div className={`gp-gl ${c.group === "project" ? "gp-byproject" : ""} ${c.opts.wrap ? "wrap" : ""}`}>
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
              {c.opts.estimates && <span className="ld-small ld-muted" title="Time estimates in this group">Σ {hours(g.tasks.reduce((n, t) => n + (t.timeEstimate ?? 0), 0))}</span>}
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
              {c.opts.estimates && <span className="ld-small ld-muted" title="Time estimates in this group">Σ {hours(g.tasks.reduce((n, t) => n + (t.timeEstimate ?? 0), 0))}</span>}
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
                  <React.Fragment key={t.id}>
                    {rowFor(g, t, !!t.parentId && c.subtaskMode === "separate")}
                    {expanded && c.subtasks.filter((x) => x.parentId === t.id).map((x) => rowFor(g, x, true))}
                  </React.Fragment>
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
  const tasks = sortTasks(withSubtasks(c, c.tasks), c.sort, c.sortDir);
  return (
    <div className={`gp-gl gp-tablewrap ${c.opts.wrap ? "wrap" : ""}`}>
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
