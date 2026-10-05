import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import type { PjCtx } from "../pages/Projects";

/**
 * Automations for a list (or every list): when a task is made, or moves to a
 * status, assign someone, set the priority, move it to a status, or add a
 * note. Each rule reads plainly with an Edit button.
 */

type Rule = { id?: number; on: "created" | "status"; to: string; do: "assign" | "priority" | "status" | "comment"; value: string; active: boolean };

export function Automations({ c, onClose }: { c: PjCtx; onClose: () => void }) {
  const listId = c.listId;
  const q = trpc.pj.automations.useQuery({ organizationId: c.orgId, listId });
  const save = trpc.pj.saveAutomation.useMutation({ onSuccess: () => { setEdit(null); void q.refetch(); } });
  const remove = trpc.pj.removeAutomation.useMutation({ onSuccess: () => void q.refetch() });
  const [edit, setEdit] = React.useState<Rule | null>(null);
  const statuses = c.data.list?.statuses ?? c.data.statuses;
  const who = (v: string) => c.data.people.find((p) => `${p.type}:${p.id}` === v)?.name ?? "someone";
  const say = (r: Rule) => `When ${r.on === "created" ? "a task is made" : `a task moves to ${r.to || "any status"}`}, ${r.do === "assign" ? `assign ${who(r.value)}` : r.do === "priority" ? `set the priority to ${r.value}` : r.do === "status" ? `move it to ${r.value}` : `add the note "${r.value}"`}.`;
  const rules: Rule[] = (q.data ?? []).map((a) => ({ id: a.id, on: a.trigger.on, to: a.trigger.to ?? "", do: a.action.do, value: a.action.value, active: a.active }));
  const submit = (r: Rule) => save.mutate({ organizationId: c.orgId, id: r.id, listId, trigger: { on: r.on, ...(r.on === "status" && r.to ? { to: r.to } : {}) }, action: { do: r.do, value: r.value }, active: r.active });
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Automations">
      <div className="gp-mbox">
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>Automations · {c.data.list?.name ?? "every list"}</b>
          <span className="ld-row">
            {!edit && <button type="button" className="ld-btn" onClick={() => setEdit({ on: "status", to: statuses[statuses.length - 1]?.name ?? "", do: "assign", value: "", active: true })}>Add</button>}
            <button type="button" className="ld-btn" onClick={onClose}>Close</button>
          </span>
        </div>
        <div style={{ padding: "6px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          {rules.length === 0 && !edit && <span className="ld-small ld-muted">No automations yet.</span>}
          {rules.map((r) =>
            edit?.id === r.id ? null : (
              <div key={r.id} className="gp-auto-r">
                <span className={r.active ? "" : "ld-muted"}>{say(r)}{r.active ? "" : " (off)"}</span>
                <span className="ld-row">
                  <button type="button" className="ld-btn sm" onClick={() => setEdit(r)}>Edit</button>
                  <button type="button" className="ld-btn sm" onClick={() => r.id && remove.mutate({ organizationId: c.orgId, id: r.id })}>Remove</button>
                </span>
              </div>
            )
          )}
          {edit && (
            <div className="gp-auto-r editing">
              <span className="gp-auto-f">
                <span>When</span>
                <select className="ld-in xs" aria-label="When" value={edit.on} onChange={(e) => setEdit({ ...edit, on: e.target.value as Rule["on"] })}>
                  <option value="created">a task is made</option>
                  <option value="status">a task moves to</option>
                </select>
                {edit.on === "status" && (
                  <select className="ld-in xs" aria-label="Status" value={edit.to} onChange={(e) => setEdit({ ...edit, to: e.target.value })}>
                    {statuses.map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                )}
                <span>then</span>
                <select className="ld-in xs" aria-label="Then" value={edit.do} onChange={(e) => setEdit({ ...edit, do: e.target.value as Rule["do"], value: "" })}>
                  <option value="assign">assign</option>
                  <option value="priority">set the priority to</option>
                  <option value="status">move it to</option>
                  <option value="comment">add a note</option>
                </select>
                {edit.do === "assign" && (
                  <select className="ld-in xs" aria-label="Who" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}>
                    <option value="">Pick a person or employee</option>
                    {c.data.people.map((p) => (
                      <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
                    ))}
                  </select>
                )}
                {edit.do === "priority" && (
                  <select className="ld-in xs" aria-label="Priority" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}>
                    <option value="">Pick one</option>
                    <option value="urgent">urgent</option>
                    <option value="high">high</option>
                    <option value="normal">normal</option>
                    <option value="low">low</option>
                  </select>
                )}
                {edit.do === "status" && (
                  <select className="ld-in xs" aria-label="Status" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}>
                    <option value="">Pick one</option>
                    {statuses.map((s) => (
                      <option key={s.name} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                )}
                {edit.do === "comment" && <input className="ld-in xs" aria-label="Note" placeholder="Send it to Caroline to paste in" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />}
              </span>
              <span className="ld-row">
                <label className="ld-row ld-small">
                  <input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> On
                </label>
                <button type="button" className="ld-btn sm" onClick={() => setEdit(null)}>Cancel</button>
                <button type="button" className="ld-btn p sm" disabled={!edit.value || save.isPending} onClick={() => submit(edit)}>Save</button>
              </span>
            </div>
          )}
          <ErrorLine error={save.error || remove.error || q.error} />
        </div>
      </div>
    </div>
  );
}
