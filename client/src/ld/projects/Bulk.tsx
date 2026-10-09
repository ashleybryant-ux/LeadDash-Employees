import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { DatePick, PeoplePick, Pop, PriorityPick, StatusPick, type QuickCtx } from "./Quick";
import type { PjCtx } from "../pages/Projects";

/**
 * The bar that appears when rows are ticked: one change for all of them.
 * Assign, due date, status, priority, move to another list, or delete.
 */
type Patch = { status?: string; priority?: "urgent" | "high" | "normal" | "low" | null; dueDate?: string | null; assign?: PjCtx["tasks"][number]["assignees"]; listId?: number };

export function BulkBar({ c }: { c: PjCtx }) {
  const [open, setOpen] = React.useState<"" | "assign" | "due" | "status" | "priority" | "move">("");
  const ids = Array.from(c.selected);
  const bulk = trpc.pj.bulk.useMutation({
    onSuccess: async () => {
      setOpen("");
      c.clearSelected();
      await c.refresh();
    },
  });
  if (!ids.length) return null;
  const go = (patch: Patch) => bulk.mutate({ organizationId: c.orgId, ids, change: { action: "update", patch } });
  // Statuses every picked task's list shares, so one pick fits them all.
  const picked = c.tasks.filter((t) => c.selected.has(t.id));
  const listIds = Array.from(new Set(picked.map((t) => t.listId)));
  const statuses = c.data.statuses.filter((s) => listIds.every((lid) => (c.data.lists.find((l) => l.id === lid)?.statuses ?? []).some((x) => x.name === s.name)));
  const q: QuickCtx = { orgId: c.orgId, people: c.data.people, statuses, canEdit: true, refresh: c.refresh, today: c.data.today };
  const lists = c.data.lists.filter((l) => l.level === "edit" || l.level === "full");
  const close = () => setOpen("");
  const btn = (key: typeof open, label: string) => (
    <span key={key} className="gp-qcell">
      <button type="button" className={`ld-btn sm gp-auto ${open === key ? "on" : ""}`} aria-expanded={open === key} onClick={() => setOpen(open === key ? "" : key)}>{label}</button>
      {open === key && key === "assign" && <PeoplePick q={q} value={[]} onChange={(v) => v.length && go({ assign: v })} close={close} title="Assign" />}
      {open === key && key === "due" && <DatePick value={null} onChange={(d) => go({ dueDate: d })} close={close} today={c.data.today} />}
      {open === key && key === "status" && <StatusPick statuses={statuses} value="" onChange={(s) => go({ status: s })} close={close} />}
      {open === key && key === "priority" && <PriorityPick value={null} onChange={(p) => go({ priority: p as Patch["priority"] })} close={close} />}
      {open === key && key === "move" && (
        <Pop onClose={close} width={220}>
          <span className="gp-qh">Move to</span>
          {lists.map((l) => (
            <button key={l.id} type="button" className="gp-qi" onClick={() => go({ listId: l.id })}>{l.name}</button>
          ))}
        </Pop>
      )}
    </span>
  );
  return (
    <div className="gp-bulk" role="toolbar" aria-label="Selected tasks">
      <b>{ids.length} selected</b>
      {btn("assign", "Assign")}
      {btn("due", "Due date")}
      {statuses.length > 0 && btn("status", "Status")}
      {btn("priority", "Priority")}
      {lists.length > 1 && btn("move", "Move to")}
      <button type="button" className="ld-btn sm gp-auto danger" disabled={bulk.isPending} onClick={() => { if (window.confirm(`Delete ${ids.length} task${ids.length === 1 ? "" : "s"}?`)) bulk.mutate({ organizationId: c.orgId, ids, change: { action: "remove" } }); }}>Delete</button>
      <button type="button" className="ld-btn sm gp-auto" onClick={c.clearSelected}>Clear</button>
      <ErrorLine error={bulk.error} />
    </div>
  );
}
