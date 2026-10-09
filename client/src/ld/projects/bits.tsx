import React from "react";
import { trpc } from "@/lib/trpc";
import { addDays, OwnerAvatar, type Owner } from "../goals/shared";
import type { PjCtx, TaskRow } from "../pages/Projects";

/** Small pieces every Projects view uses. */

export const PRIORITY_COLOR: Record<string, string> = { urgent: "#c2253c", high: "#d97706", normal: "#2563eb", low: "#9aa8a2" };
export const PRIORITY_TEXT: Record<string, string> = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

export function Flag({ p }: { p: string | null }) {
  if (!p) return <span className="ld-small ld-muted">None</span>;
  return (
    <span className="gp-flag" style={{ color: PRIORITY_COLOR[p] }}>
      ⚑ {PRIORITY_TEXT[p]}
    </span>
  );
}

export function StatusTag({ name, color }: { name: string; color: string }) {
  return (
    <span className="gp-st" style={{ background: color }}>
      {name}
    </span>
  );
}

export function statusColor(c: PjCtx, t: { listId: number; status: string }) {
  const l = c.data.lists.find((x) => x.id === t.listId);
  return l?.statuses.find((s) => s.name === t.status)?.color ?? c.data.statuses.find((s) => s.name === t.status)?.color ?? "#87909e";
}

/** An empty dashed circle stands for nobody yet. */
export function NobodyAvatar({ size = 24, title = "Unassigned" }: { size?: number; title?: string }) {
  return <span className="gp-noone" style={{ width: size, height: size }} title={title} aria-label={title} />;
}

export function People({ c, list, max = 3 }: { c: { data: { people: Owner[] } }; list: TaskRow["assignees"]; max?: number }) {
  if (!list.length) return <NobodyAvatar />;
  return (
    <span className="gp-avs" aria-label={list.map((a) => a.name).join(", ")}>
      {list.slice(0, max).map((a) => (
        <OwnerAvatar key={`${a.type}:${a.id}:${a.name}`} o={c.data.people.find((p) => p.type === a.type && p.id === a.id) ?? { type: "name", id: 0, name: a.name }} size={24} />
      ))}
      {list.length > max && <span className="more">+{list.length - max}</span>}
    </span>
  );
}

/** A due date the way people say it: Today, Tomorrow, Yesterday, or "Mon, Oct 12, 2026". */
export function dueText(ymd: string, today: string) {
  if (ymd === today) return "Today";
  if (ymd === addDays(today, 1)) return "Tomorrow";
  if (ymd === addDays(today, -1)) return "Yesterday";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function Due({ t, today }: { t: TaskRow; today: string }) {
  if (!t.dueDate) return <span className="ld-small ld-muted">No date</span>;
  const late = !t.closed && t.dueDate < today;
  return <span style={late ? { color: "#c2253c", fontWeight: 700 } : t.dueDate === today ? { color: "#b45309", fontWeight: 700 } : undefined}>{dueText(t.dueDate, today)}</span>;
}

export function Counts({ t }: { t: TaskRow }) {
  const bits = [t.repeat ? "↻" : "", t.subtasks ? `⤷ ${t.subtasksDone}/${t.subtasks}` : "", t.checklist.total ? `☑ ${t.checklist.done}/${t.checklist.total}` : "", t.files ? `📎 ${t.files}` : "", t.comments ? `💬 ${t.comments}` : ""].filter(Boolean);
  if (!bits.length && !t.blocked) return null;
  return (
    <span className="gp-meta">
      {t.blocked && <span className="gp-wait" title="Waiting on another task">Waiting</span>}
      {bits.join(" · ")}
    </span>
  );
}

/** The round check: marks the task done (the list's first done status), or open again. */
export function Check({ c, t }: { c: PjCtx; t: TaskRow }) {
  const up = trpc.pj.update.useMutation({ onSuccess: () => c.refresh() });
  const list = c.data.lists.find((l) => l.id === t.listId);
  const done = list?.statuses.find((s) => s.type === "done") ?? list?.statuses.find((s) => s.type === "closed");
  const open = list?.statuses[0];
  return (
    <button
      type="button"
      className={`gp-ck ${t.closed ? "on" : ""}`}
      aria-label={t.closed ? `Open ${t.name} again` : `Mark ${t.name} done`}
      disabled={up.isPending || !done}
      onClick={(e) => {
        e.stopPropagation();
        up.mutate({ organizationId: c.orgId, id: t.id, patch: { status: t.closed ? open!.name : done!.name } });
      }}
    >
      {t.closed ? "✓" : ""}
    </button>
  );
}

/** The square check that picks a row for a bulk change. Shows on hover, and stays while anything is picked. */
export function SelectBox({ c, id }: { c: PjCtx; id: number }) {
  const on = c.selected.has(id);
  return (
    <button
      type="button"
      className={`gp-selbox ${on ? "on" : ""} ${c.selected.size ? "stay" : ""}`}
      aria-label={on ? "Unselect" : "Select"}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        c.toggle(id, e.shiftKey);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {on ? "✓" : ""}
    </button>
  );
}

/** "+ Add task" at the end of a group: a name, then Enter. */
export function AddInline({ c, listId, status, label = "+ Add task" }: { c: PjCtx; listId: number | null; status?: string; label?: string }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const create = trpc.pj.create.useMutation({ onSuccess: async () => { setName(""); await c.refresh(); } });
  const lid = listId ?? c.data.lists[0]?.id;
  if (!lid) return null;
  const level = c.data.levels[lid] ?? "view";
  if (level !== "edit" && level !== "full") return null;
  if (!open)
    return (
      <button type="button" className="gp-addrow" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <span className="gp-addline">
      <input className="ld-in xs" autoFocus aria-label="Task name" placeholder="Task name, then Enter" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create.mutate({ organizationId: c.orgId, listId: lid, name, status }); if (e.key === "Escape") setOpen(false); }} />
      <button type="button" className="ld-btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}
