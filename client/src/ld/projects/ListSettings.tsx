import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import type { PjCtx } from "../pages/Projects";
import { FIELD_TYPE_LABEL, FIELD_TYPES, type FieldDef } from "./fields";

/** A list's name, folder, statuses and custom fields (every type, on this list or the whole folder), with Save and Cancel. */
type S = { name: string; color: string; type: "open" | "active" | "done" | "closed" };
type F = { id: string; name: string; type: FieldDef["type"]; options: string; setup: string; scope: "list" | "folder" };
const COLORS = ["var(--ld-soft3)", "#1090e0", "#f76808", "#e5484d", "#12a594", "#7c3aed"];

export function ListSettings({ c, onClose, onRemoved }: { c: PjCtx; onClose: () => void; onRemoved: () => void }) {
  const l = c.data.list!;
  const tree = trpc.pj.tree.useQuery({ organizationId: c.orgId });
  const save = trpc.pj.saveList.useMutation({ onSuccess: async () => { await c.refresh(); onClose(); } });
  const remove = trpc.pj.removeList.useMutation({ onSuccess: onRemoved });
  const [name, setName] = React.useState(l.name);
  const [folderId, setFolderId] = React.useState<number | null>(l.folderId);
  const [statuses, setStatuses] = React.useState<S[]>(l.statuses.map((s) => ({ ...s })));
  const [fields, setFields] = React.useState<F[]>(l.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: (f.options ?? []).map((o) => o.name).join(", "), setup: f.setup ?? "", scope: f.scope ?? "list" })));
  const folderName = tree.data?.folders.find((f) => f.id === folderId)?.name ?? null;
  const numberFields = fields.filter((f) => f.type === "number" || f.type === "money" || f.type === "rating").map((f) => f.name).filter(Boolean);
  const setField = (i: number, patch: Partial<F>) => setFields(fields.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const submit = () =>
    save.mutate({
      organizationId: c.orgId,
      id: l.id,
      name,
      folderId,
      statuses,
      fields: fields.map((f) => {
        const old = l.fields.find((x) => x.id === f.id);
        const withOptions = f.type === "dropdown" || f.type === "labels";
        return {
          id: f.id,
          name: f.name,
          type: f.type,
          scope: folderId ? f.scope : "list",
          ...(withOptions
            ? { options: f.options.split(",").map((n) => n.trim()).filter(Boolean).map((n, i) => old?.options?.find((o) => o.name === n) ?? { id: `${f.id}-${i}-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: n, color: COLORS[(i + 1) % COLORS.length] }) }
            : {}),
          ...(["formula", "rating", "progress", "relationship"].includes(f.type) && f.setup ? { setup: f.setup } : {}),
        };
      }),
    });
  const setup = (f: F, i: number) => {
    if (f.type === "dropdown" || f.type === "labels") return <input className="ld-in xs" aria-label="Choices, separated by commas" placeholder="To Do, On Track, Danger, Done" value={f.options} onChange={(e) => setField(i, { options: e.target.value })} />;
    if (f.type === "rating")
      return (
        <select className="ld-in xs" aria-label="Stars" value={f.setup || "5"} onChange={(e) => setField(i, { setup: e.target.value })}>
          <option value="3">3 stars</option>
          <option value="5">5 stars</option>
          <option value="10">10 stars</option>
        </select>
      );
    if (f.type === "progress")
      return (
        <select className="ld-in xs" aria-label="Progress comes from" value={f.setup || "manual"} onChange={(e) => setField(i, { setup: e.target.value })}>
          <option value="manual">Typed in</option>
          <option value="subtasks">From subtasks</option>
          <option value="checklist">From the checklist</option>
        </select>
      );
    if (f.type === "formula") return <input className="ld-in xs" aria-label="Formula" placeholder={numberFields.length ? `25 - ${numberFields[0]}` : "Use number fields by name"} value={f.setup} onChange={(e) => setField(i, { setup: e.target.value })} />;
    if (f.type === "relationship")
      return (
        <select className="ld-in xs" aria-label="Tasks from" value={f.setup} onChange={(e) => setField(i, { setup: e.target.value })}>
          <option value="">Tasks in any list</option>
          {[...(tree.data?.folders ?? []).flatMap((fo) => fo.lists), ...(tree.data?.loose ?? [])].map((x) => (
            <option key={x.id} value={x.id}>Tasks in {x.name}</option>
          ))}
        </select>
      );
    return <input className="ld-in xs" aria-label="Setup" placeholder="None" disabled value="" />;
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Edit ${l.name}`}>
      <div className="gp-mbox wide">
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>Edit list · {l.name}</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={submit}>Save</button>
          </span>
        </div>
        <div className="gp-form">
          <label>Name</label>
          <input className="ld-in xs" aria-label="List name" value={name} onChange={(e) => setName(e.target.value)} />
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
            <b>Custom fields</b>
            <button type="button" className="gp-link" onClick={() => setFields([...fields, { id: `f${Date.now().toString(36)}`, name: "", type: "text", options: "", setup: "", scope: "list" }])}>+ Add a field</button>
          </div>
          {fields.length > 0 && (
            <div className="gp-cfh h">
              <span>Field</span>
              <span>Type</span>
              <span>Choices or setup</span>
              <span>Used in</span>
              <span />
            </div>
          )}
          {fields.length === 0 && <span className="ld-small ld-muted">No custom fields.</span>}
          {fields.map((f, i) => (
            <div key={f.id} className="gp-cfh">
              <input className="ld-in xs" aria-label="Field name" placeholder="Field name" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
              <select className="ld-in xs" aria-label="Field type" value={f.type} onChange={(e) => setField(i, { type: e.target.value as F["type"], setup: "" })}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>
                ))}
              </select>
              {setup(f, i)}
              <select className="ld-in xs" aria-label="Used in" value={folderId ? f.scope : "list"} disabled={!folderId} onChange={(e) => setField(i, { scope: e.target.value as F["scope"] })}>
                <option value="list">This list</option>
                {folderId && <option value="folder">This folder ({folderName})</option>}
              </select>
              <button type="button" className="ld-btn sm" onClick={() => setFields(fields.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
          <span className="ld-small ld-muted">"This folder" puts the field on every list in {folderName ?? "the folder"}. Formulas use the number and money fields on the task by name, with + - * / and parentheses.</span>
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
        <ErrorLine error={save.error || remove.error} />
        <div style={{ padding: "0 20px 18px" }}>
          <button type="button" className="ld-btn danger" onClick={() => window.confirm(`Delete ${l.name} and all of its tasks?`) && remove.mutate({ organizationId: c.orgId, id: l.id })}>Delete list</button>
        </div>
      </div>
    </div>
  );
}
