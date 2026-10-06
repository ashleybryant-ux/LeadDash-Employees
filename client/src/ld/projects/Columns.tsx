import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { FIELD_TYPE_LABEL, type FieldDef } from "./fields";
import { Pop } from "./Quick";
import type { PjCtx } from "../pages/Projects";

/**
 * Columns on a list or table view, and the "+" after the headers that shows
 * or hides them or makes a new custom field without leaving the list.
 */

export type ColKey = string;
export const BUILTIN: { key: ColKey; label: string; many?: boolean }[] = [
  { key: "assignee", label: "Assignee" },
  { key: "due", label: "Due date" },
  { key: "start", label: "Start date" },
  { key: "priority", label: "Priority" },
  { key: "status", label: "Status" },
  { key: "estimate", label: "Time estimate" },
  { key: "tracked", label: "Tracked" },
  { key: "tags", label: "Tags" },
  { key: "goal", label: "Goal" },
  { key: "list", label: "List", many: true },
];
export const DEFAULT_COLUMNS: Record<string, ColKey[]> = {
  list: ["assignee", "due", "priority", "status", "goal"],
  table: ["status", "assignee", "start", "due", "priority", "estimate", "tracked", "tags", "goal"],
};

export function columnLabel(key: ColKey, fields: FieldDef[]) {
  if (key.startsWith("f:")) return fields.find((f) => `f:${f.id}` === key)?.name ?? "";
  return BUILTIN.find((b) => b.key === key)?.label ?? key;
}

/** Column width for the list grid. */
export function columnWidth(key: ColKey, fields: FieldDef[]) {
  if (key.startsWith("f:")) {
    const f = fields.find((x) => `f:${x.id}` === key);
    return f?.type === "checkbox" || f?.type === "rating" ? "90px" : f?.type === "progress" || f?.type === "labels" || f?.type === "people" ? "150px" : "130px";
  }
  return { assignee: "110px", due: "120px", start: "120px", priority: "95px", status: "120px", estimate: "95px", tracked: "80px", tags: "140px", goal: "170px", list: "150px" }[key] ?? "120px";
}

const TYPE_POPULAR = ["dropdown", "text", "date", "number", "labels"];

/** The + menu: Show a field (tick columns) or New field (make one). */
export function ColumnsMenu({ c, columns, onColumns, fields, many, onClose }: { c: PjCtx; columns: ColKey[]; onColumns: (cols: ColKey[]) => void; fields: FieldDef[]; many: boolean; onClose: () => void }) {
  const [tab, setTab] = React.useState<"show" | "new">("show");
  const [q, setQ] = React.useState("");
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState("dropdown");
  const [options, setOptions] = React.useState("");
  const [scope, setScope] = React.useState<"list" | "folder">("list");
  const add = trpc.pj.addField.useMutation({
    onSuccess: async (f) => {
      await c.refresh();
      onColumns([...columns, `f:${f.id}`]);
      onClose();
    },
  });
  const words = q.trim().toLowerCase();
  const hit = (s: string) => !words || s.toLowerCase().includes(words);
  const toggle = (key: ColKey) => onColumns(columns.includes(key) ? columns.filter((k) => k !== key) : [...columns, key]);
  const own = fields.filter((f) => f.scope !== "folder");
  const shared = fields.filter((f) => f.scope === "folder");
  const inFolder = !!c.data.list?.folderId || !!c.data.folder;
  const canMake = c.level === "full" || !!c.data.folder;
  const row = (key: ColKey, label: string, note?: string) => (
    <button key={key} type="button" className={`gp-qi ${columns.includes(key) ? "on" : ""}`} onClick={() => toggle(key)}>
      <span className="gp-qbox">{columns.includes(key) ? "☑" : "☐"}</span>
      <span className="gp-ell">{label}</span>
      {note && <span className="ld-small ld-muted">{note}</span>}
    </button>
  );
  const needsOptions = type === "dropdown" || type === "labels";
  const makeIt = () => {
    if (!name.trim()) return;
    add.mutate({ organizationId: c.orgId, listId: c.listId, folderId: c.data.folder?.id ?? c.data.list?.folderId ?? null, scope: c.data.folder ? "folder" : scope, name, type: type as FieldDef["type"], options: needsOptions ? options.split(",").map((s) => s.trim()).filter(Boolean) : undefined, setup: type === "rating" ? "5" : type === "progress" ? "manual" : undefined });
  };
  return (
    <Pop onClose={onClose} width={310} align="right">
      <input className="ld-in xs" autoFocus aria-label={tab === "show" ? "Search fields" : "Search field types"} placeholder={tab === "show" ? "Search fields" : "Search field types"} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="gp-ftabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "show"} className={tab === "show" ? "on" : ""} onClick={() => setTab("show")}>Show a field</button>
        {canMake && <button type="button" role="tab" aria-selected={tab === "new"} className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>New field</button>}
      </div>
      <div className="gp-fbody">
        {tab === "show" ? (
          <>
            <span className="gp-qh">Built in</span>
            {BUILTIN.filter((b) => (many || !b.many) && hit(b.label)).map((b) => row(b.key, b.label))}
            {own.length > 0 && <span className="gp-qh">Custom fields on this list</span>}
            {own.filter((f) => hit(f.name)).map((f) => row(`f:${f.id}`, f.name, FIELD_TYPE_LABEL[f.type]?.toLowerCase()))}
            {shared.length > 0 && <span className="gp-qh">From the folder</span>}
            {shared.filter((f) => hit(f.name)).map((f) => row(`f:${f.id}`, f.name, FIELD_TYPE_LABEL[f.type]?.toLowerCase()))}
          </>
        ) : (
          <>
            <input className="ld-in xs" aria-label="Field name" placeholder="Field name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && makeIt()} />
            <span className="gp-qh">Popular</span>
            {TYPE_POPULAR.filter((t) => hit(FIELD_TYPE_LABEL[t])).map((t) => (
              <button key={t} type="button" className={`gp-qi ${type === t ? "on" : ""}`} onClick={() => setType(t)}>{FIELD_TYPE_LABEL[t]}</button>
            ))}
            <span className="gp-qh">All</span>
            {Object.keys(FIELD_TYPE_LABEL).filter((t) => !TYPE_POPULAR.includes(t) && hit(FIELD_TYPE_LABEL[t])).map((t) => (
              <button key={t} type="button" className={`gp-qi ${type === t ? "on" : ""}`} onClick={() => setType(t)}>{FIELD_TYPE_LABEL[t]}</button>
            ))}
            {needsOptions && <input className="ld-in xs" aria-label="Choices" placeholder="Choices, separated by commas" value={options} onChange={(e) => setOptions(e.target.value)} />}
            {inFolder && !c.data.folder && (
              <span className="ld-row ld-small" style={{ padding: "4px 8px", gap: 10 }}>
                Add to:
                <label className="ld-row" style={{ gap: 4 }}><input type="radio" name="fscope" checked={scope === "list"} onChange={() => setScope("list")} /> this list</label>
                <label className="ld-row" style={{ gap: 4 }}><input type="radio" name="fscope" checked={scope === "folder"} onChange={() => setScope("folder")} /> the whole folder</label>
              </span>
            )}
            <span className="ld-row" style={{ justifyContent: "flex-end", padding: "4px 4px 0" }}>
              <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
              <button type="button" className="ld-btn p sm" disabled={!name.trim() || add.isPending} onClick={makeIt}>Add field</button>
            </span>
            <ErrorLine error={add.error} />
          </>
        )}
      </div>
    </Pop>
  );
}

/** The + button in a header row. */
export function ColumnsPlus(props: Omit<React.ComponentProps<typeof ColumnsMenu>, "onClose">) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="gp-qcell" style={{ justifySelf: "end" }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`gp-colplus ${open ? "on" : ""}`} aria-label="Add or hide columns" title="Add or hide columns" onClick={() => setOpen((v) => !v)}>+</button>
      {open && <ColumnsMenu {...props} onClose={() => setOpen(false)} />}
    </span>
  );
}
