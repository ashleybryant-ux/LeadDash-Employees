import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import type { PjCtx } from "../pages/Projects";

/** A list's name, folder, statuses and custom fields, with Save and Cancel. */
type S = { name: string; color: string; type: "open" | "active" | "done" | "closed" };
type F = { id: string; name: string; type: "text" | "number" | "dropdown" | "date" | "money" | "checkbox"; options: string };

export function ListSettings({ c, onClose, onRemoved }: { c: PjCtx; onClose: () => void; onRemoved: () => void }) {
  const l = c.data.list!;
  const tree = trpc.pj.tree.useQuery({ organizationId: c.orgId });
  const save = trpc.pj.saveList.useMutation({ onSuccess: async () => { await c.refresh(); onClose(); } });
  const remove = trpc.pj.removeList.useMutation({ onSuccess: onRemoved });
  const [name, setName] = React.useState(l.name);
  const [folderId, setFolderId] = React.useState<number | null>(l.folderId);
  const [statuses, setStatuses] = React.useState<S[]>(l.statuses.map((s) => ({ ...s })));
  const [fields, setFields] = React.useState<F[]>(l.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: (f.options ?? []).map((o) => o.name).join(", ") })));
  const submit = () =>
    save.mutate({
      organizationId: c.orgId,
      id: l.id,
      name,
      folderId,
      statuses,
      fields: fields.map((f) => {
        const old = l.fields.find((x) => x.id === f.id);
        return {
          id: f.id,
          name: f.name,
          type: f.type,
          ...(f.type === "dropdown"
            ? { options: f.options.split(",").map((n) => n.trim()).filter(Boolean).map((n, i) => old?.options?.find((o) => o.name === n) ?? { id: `${f.id}-${i}-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: n, color: ["#87909e", "#1090e0", "#f76808", "#e5484d", "#12a594", "#7c3aed"][i % 6] }) }
            : {}),
        };
      }),
    });
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Edit ${l.name}`}>
      <div className="gp-mbox">
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>Edit list</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={submit}>Save</button>
          </span>
        </div>
        <div className="gp-form">
          <label>Name</label>
          <input className="ld-in" aria-label="List name" value={name} onChange={(e) => setName(e.target.value)} />
          <label>Folder</label>
          <select className="ld-in xs" aria-label="Folder" value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No folder</option>
            {tree.data?.folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="gp-tgt">
          <div className="ld-between">
            <b>Statuses, in order</b>
            <button type="button" className="gp-link" onClick={() => setStatuses([...statuses.slice(0, -1), { name: "", color: "#f8ae00", type: "active" }, ...statuses.slice(-1)])}>+ Add a status</button>
          </div>
          {statuses.map((s, i) => (
            <div key={i} className="gp-trow" style={{ gridTemplateColumns: "40px minmax(0,1fr) 160px 96px" }}>
              <input type="color" aria-label="Color" value={s.color} onChange={(e) => setStatuses(statuses.map((x, k) => (k === i ? { ...x, color: e.target.value } : x)))} style={{ width: 36, height: 30, border: 0, background: "none" }} />
              <input className="ld-in xs" aria-label="Status name" value={s.name} onChange={(e) => setStatuses(statuses.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <select className="ld-in xs" aria-label="Kind" value={s.type} onChange={(e) => setStatuses(statuses.map((x, k) => (k === i ? { ...x, type: e.target.value as S["type"] } : x)))}>
                <option value="open">Not started</option>
                <option value="active">In progress</option>
                <option value="done">Done</option>
                <option value="closed">Closed</option>
              </select>
              <button type="button" className="ld-btn sm" disabled={statuses.length <= 2} onClick={() => setStatuses(statuses.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
          <span className="ld-small ld-muted">Tasks in a removed status move to the first one.</span>
        </div>
        <div className="gp-tgt">
          <div className="ld-between">
            <b>Custom fields</b>
            <button type="button" className="gp-link" onClick={() => setFields([...fields, { id: `f${Date.now().toString(36)}`, name: "", type: "text", options: "" }])}>+ Add a field</button>
          </div>
          {fields.length === 0 && <span className="ld-small ld-muted">No custom fields.</span>}
          {fields.map((f, i) => (
            <div key={f.id} className="gp-trow" style={{ gridTemplateColumns: "minmax(0,1fr) 130px minmax(0,1.3fr) 96px" }}>
              <input className="ld-in xs" aria-label="Field name" placeholder="Field name" value={f.name} onChange={(e) => setFields(fields.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <select className="ld-in xs" aria-label="Field type" value={f.type} onChange={(e) => setFields(fields.map((x, k) => (k === i ? { ...x, type: e.target.value as F["type"] } : x)))}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="money">Money</option>
                <option value="date">Date</option>
                <option value="checkbox">Checkbox</option>
                <option value="dropdown">Dropdown</option>
              </select>
              {f.type === "dropdown" ? <input className="ld-in xs" aria-label="Choices, separated by commas" placeholder="To Do, On Track, Danger, Done" value={f.options} onChange={(e) => setFields(fields.map((x, k) => (k === i ? { ...x, options: e.target.value } : x)))} /> : <span />}
              <button type="button" className="ld-btn sm" onClick={() => setFields(fields.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
        </div>
        <ErrorLine error={save.error || remove.error} />
        <div style={{ padding: "0 20px 18px" }}>
          <button type="button" className="ld-btn danger" onClick={() => window.confirm(`Delete ${l.name} and all of its tasks?`) && remove.mutate({ organizationId: c.orgId, id: l.id })}>Delete list</button>
        </div>
      </div>
    </div>
  );
}
