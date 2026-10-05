import React from "react";
import { trpc } from "@/lib/trpc";
import { fmtYmd, OwnerAvatar, type Owner } from "../goals/shared";
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

export function People({ c, list, max = 3 }: { c: { data: { people: Owner[] } }; list: TaskRow["assignees"]; max?: number }) {
  if (!list.length) return <span className="ld-small ld-muted">Unassigned</span>;
  return (
    <span className="gp-avs" aria-label={list.map((a) => a.name).join(", ")}>
      {list.slice(0, max).map((a) => (
        <OwnerAvatar key={`${a.type}:${a.id}:${a.name}`} o={c.data.people.find((p) => p.type === a.type && p.id === a.id) ?? { type: "name", id: 0, name: a.name }} size={24} />
      ))}
      {list.length > max && <span className="more">+{list.length - max}</span>}
    </span>
  );
}

export function Due({ t, today }: { t: TaskRow; today: string }) {
  if (!t.dueDate) return <span className="ld-small ld-muted">No date</span>;
  const late = !t.closed && t.dueDate < today;
  return <span style={late ? { color: "#c2253c", fontWeight: 700 } : undefined}>{fmtYmd(t.dueDate)}</span>;
}

export function Counts({ t }: { t: TaskRow }) {
  const bits = [t.subtasks ? `⤷ ${t.subtasksDone}/${t.subtasks}` : "", t.checklist.total ? `☑ ${t.checklist.done}/${t.checklist.total}` : "", t.files ? `📎 ${t.files}` : "", t.comments ? `💬 ${t.comments}` : ""].filter(Boolean);
  if (!bits.length) return null;
  return <span className="gp-meta">{bits.join(" · ")}</span>;
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

/** "+ Add task" at the end of a group: a name, then Enter. */
export function AddInline({ c, listId, status, label = "+ Add task" }: { c: PjCtx; listId: number | null; status?: string; label?: string }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const create = trpc.pj.create.useMutation({ onSuccess: async () => { setName(""); await c.refresh(); } });
  const lid = listId ?? c.data.lists[0]?.id;
  if (!lid) return null;
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
