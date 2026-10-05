import React from "react";
import { evalFormula } from "@shared/formula";
import { fmtYmd, OwnerAvatar, type Owner } from "../goals/shared";
import { StatusTag } from "./bits";
import type { Outputs } from "../types";

/**
 * Custom fields of every type, shown read-only and edited inside a task's
 * Edit view: text, number, money, date, checkbox, dropdown, labels, people,
 * email, phone, website, rating, progress, formula, files and related tasks.
 */

export type FieldDef = NonNullable<Outputs["pj"]["view"]["list"]>["fields"][number];
type Person = { type: "user" | "employee" | "name"; id: number; name: string };
type FileVal = { id: number; name: string; url: string; kind: string };

export const FIELD_TYPE_LABEL: Record<string, string> = {
  text: "Text",
  number: "Number",
  money: "Money",
  date: "Date",
  checkbox: "Checkbox",
  dropdown: "Dropdown",
  labels: "Labels",
  people: "People",
  email: "Email",
  phone: "Phone",
  website: "Website",
  rating: "Rating",
  progress: "Progress bar",
  formula: "Formula",
  files: "Files",
  relationship: "Relationship",
};
export const FIELD_TYPES = Object.keys(FIELD_TYPE_LABEL);

const toMdy = (ymd: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ymd;
};
const fromMdy = (s: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : s;
};

/** A formula's value from the task's number and money fields. */
export function formulaValue(f: FieldDef, fields: FieldDef[], vals: Record<string, unknown>) {
  const named: Record<string, number | null> = {};
  for (const x of fields) if (x.type === "number" || x.type === "money" || x.type === "rating") named[x.name] = vals[x.id] === undefined || vals[x.id] === null || vals[x.id] === "" ? null : Number(vals[x.id]);
  return evalFormula(f.setup ?? "", named);
}

export function progressValue(f: FieldDef, vals: Record<string, unknown>, t: { subtasks: number; subtasksDone: number; checklist: { done: number; total: number } }) {
  if (f.setup === "subtasks") return t.subtasks ? Math.round((t.subtasksDone / t.subtasks) * 100) : 0;
  if (f.setup === "checklist") return t.checklist.total ? Math.round((t.checklist.done / t.checklist.total) * 100) : 0;
  const v = Number(vals[f.id] ?? 0);
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
}

export const Stars = ({ n, max = 5, onPick }: { n: number; max?: number; onPick?: (n: number) => void }) => (
  <span className="gp-stars" role={onPick ? "radiogroup" : undefined} aria-label={`${n} of ${max}`}>
    {Array.from({ length: max }, (_, i) =>
      onPick ? (
        <button key={i} type="button" role="radio" aria-checked={n === i + 1} aria-label={`${i + 1} star${i ? "s" : ""}`} className={i < n ? "on" : ""} onClick={() => onPick(n === i + 1 ? 0 : i + 1)}>
          {i < n ? "★" : "☆"}
        </button>
      ) : (
        <span key={i} className={i < n ? "on" : ""}>{i < n ? "★" : "☆"}</span>
      )
    )}
  </span>
);

export function Bar({ p }: { p: number }) {
  return (
    <span className="gp-pbar">
      <span className="t">
        <i style={{ width: `${p}%` }} />
      </span>
      <span>{p}%</span>
    </span>
  );
}

/** A field's value, read-only. Null when empty. */
export function FieldValue({ f, fields, t, people, tasks }: { f: FieldDef; fields: FieldDef[]; t: { fields: Record<string, unknown>; subtasks: number; subtasksDone: number; checklist: { done: number; total: number } }; people: Owner[]; tasks?: { id: number; name: string }[] }) {
  const v = t.fields[f.id];
  if (f.type === "formula") {
    const n = formulaValue(f, fields, t.fields);
    return n === null ? null : <span>{n.toLocaleString("en-US")} <span className="ld-small ld-muted">formula</span></span>;
  }
  if (f.type === "progress") return <Bar p={progressValue(f, t.fields, t)} />;
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return null;
  if (f.type === "dropdown") {
    const o = f.options?.find((x) => x.id === v);
    return o ? <StatusTag name={o.name} color={o.color} /> : null;
  }
  if (f.type === "labels") {
    const ids = Array.isArray(v) ? (v as string[]) : [];
    return (
      <span className="gp-labels">
        {ids.map((id) => {
          const o = f.options?.find((x) => x.id === id);
          return o ? <span key={id} className="gp-lab" style={{ background: `${o.color}22`, color: o.color }}>{o.name}</span> : null;
        })}
      </span>
    );
  }
  if (f.type === "people") {
    const list = (Array.isArray(v) ? v : []) as Person[];
    return (
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        {list.map((p) => (
          <span key={`${p.type}:${p.id}`} className="ld-row">
            <OwnerAvatar o={people.find((x) => x.type === p.type && x.id === p.id) ?? { type: "name", id: 0, name: p.name }} size={22} />
            {p.name}
          </span>
        ))}
      </span>
    );
  }
  if (f.type === "files") {
    const list = (Array.isArray(v) ? v : []) as FileVal[];
    return (
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        {list.map((x) => (
          <a key={x.id} className="gp-tlink" href={x.url} target="_blank" rel="noreferrer">📎 {x.name}</a>
        ))}
      </span>
    );
  }
  if (f.type === "relationship") {
    const ids = (Array.isArray(v) ? v : []) as number[];
    return <span className="ld-row" style={{ flexWrap: "wrap" }}>{ids.map((id) => <span key={id} className="gp-tlink">↔ {tasks?.find((x) => x.id === id)?.name ?? `Task ${id}`}</span>)}</span>;
  }
  if (f.type === "rating") return <Stars n={Number(v)} max={Number(f.setup) || 5} />;
  if (f.type === "date") return <>{fmtYmd(String(v))}</>;
  if (f.type === "checkbox") return <>{v ? "Yes" : "No"}</>;
  if (f.type === "money") return <>${Number(v).toLocaleString("en-US")}</>;
  if (f.type === "number") return <>{Number(v).toLocaleString("en-US")}</>;
  if (f.type === "website") {
    const href = /^https?:\/\//.test(String(v)) ? String(v) : `https://${v}`;
    return <a className="gp-wlink" href={href} target="_blank" rel="noreferrer">{String(v).replace(/^https?:\/\//, "")} ↗</a>;
  }
  if (f.type === "email") return <a className="gp-wlink" href={`mailto:${v}`}>{String(v)}</a>;
  if (f.type === "phone") return <a className="gp-wlink" href={`tel:${String(v).replace(/[^\d+]/g, "")}`}>{String(v)}</a>;
  return <>{String(v)}</>;
}

/** A plain-text version for the Table view and the phone. */
export function fieldText(f: FieldDef, fields: FieldDef[], t: { fields: Record<string, unknown>; subtasks: number; subtasksDone: number; checklist: { done: number; total: number } }, tasks?: { id: number; name: string }[]) {
  const v = t.fields[f.id];
  if (f.type === "formula") return formulaValue(f, fields, t.fields)?.toLocaleString("en-US") ?? "";
  if (f.type === "progress") return `${progressValue(f, t.fields, t)}%`;
  if (v === undefined || v === null || v === "") return "";
  if (f.type === "dropdown") return f.options?.find((o) => o.id === v)?.name ?? "";
  if (f.type === "labels") return (Array.isArray(v) ? (v as string[]) : []).map((id) => f.options?.find((o) => o.id === id)?.name).filter(Boolean).join(", ");
  if (f.type === "people") return ((Array.isArray(v) ? v : []) as Person[]).map((p) => p.name).join(", ");
  if (f.type === "files") return ((Array.isArray(v) ? v : []) as FileVal[]).map((x) => x.name).join(", ");
  if (f.type === "relationship") return ((Array.isArray(v) ? v : []) as number[]).map((id) => tasks?.find((x) => x.id === id)?.name ?? "").filter(Boolean).join(", ");
  if (f.type === "rating") return "★".repeat(Number(v));
  if (f.type === "date") return fmtYmd(String(v));
  if (f.type === "checkbox") return v ? "Yes" : "No";
  if (f.type === "money") return `$${Number(v).toLocaleString("en-US")}`;
  return String(v);
}

/** The editor for one field, inside a task's Edit view. */
export function FieldInput({ f, value, onChange, people, tasks, orgId }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void; people: Owner[]; tasks: { id: number; name: string; listName?: string; listId?: number }[]; orgId: number }) {
  const [busy, setBusy] = React.useState(false);
  if (f.type === "formula") return <span className="ld-small ld-muted">Worked out: {f.setup || "no formula yet"}</span>;
  if (f.type === "progress" && (f.setup === "subtasks" || f.setup === "checklist")) return <span className="ld-small ld-muted">From the {f.setup}</span>;
  if (f.type === "dropdown")
    return (
      <select className="ld-in xs" aria-label={f.name} value={String(value ?? "")} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">None</option>
        {f.options?.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    );
  if (f.type === "labels") {
    const ids = (Array.isArray(value) ? value : []) as string[];
    return (
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        {ids.map((id) => {
          const o = f.options?.find((x) => x.id === id);
          return o ? (
            <button key={id} type="button" className="gp-lab" style={{ background: `${o.color}22`, color: o.color }} aria-label={`Remove ${o.name}`} onClick={() => onChange(ids.filter((x) => x !== id))}>
              {o.name} ✕
            </button>
          ) : null;
        })}
        <select className="ld-in xs" style={{ width: 120 }} aria-label={`Add to ${f.name}`} value="" onChange={(e) => e.target.value && onChange([...ids, e.target.value])}>
          <option value="">Add</option>
          {f.options?.filter((o) => !ids.includes(o.id)).map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </span>
    );
  }
  if (f.type === "people") {
    const list = (Array.isArray(value) ? value : []) as Person[];
    return (
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        {list.map((p) => (
          <button key={`${p.type}:${p.id}`} type="button" className="gp-chip" aria-label={`Remove ${p.name}`} onClick={() => onChange(list.filter((x) => !(x.type === p.type && x.id === p.id)))}>
            {p.name} ✕
          </button>
        ))}
        <select className="ld-in xs" style={{ width: 220 }} aria-label={`Add to ${f.name}`} value="" onChange={(e) => {
          const p = people.find((x) => `${x.type}:${x.id}` === e.target.value);
          if (p) onChange([...list, { type: p.type, id: p.id, name: p.name }]);
        }}>
          <option value="">Add a person or employee</option>
          {people.filter((p) => !list.some((x) => x.type === p.type && x.id === p.id)).map((p) => (
            <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
          ))}
        </select>
      </span>
    );
  }
  if (f.type === "rating") return <Stars n={Number(value ?? 0)} max={Number(f.setup) || 5} onPick={(n) => onChange(n || null)} />;
  if (f.type === "checkbox") return <input type="checkbox" className="gp-cbx" aria-label={f.name} checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (f.type === "files") {
    const list = (Array.isArray(value) ? value : []) as FileVal[];
    return (
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        {list.map((x) => (
          <button key={x.id} type="button" className="gp-chip" aria-label={`Remove ${x.name}`} onClick={() => onChange(list.filter((y) => y.id !== x.id))}>📎 {x.name} ✕</button>
        ))}
        <label className="ld-btn sm" style={{ width: 96 }}>
          {busy ? "Uploading" : "Add files"}
          <input
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={async (e) => {
              const files = Array.from(e.target.files ?? []).slice(0, 5);
              e.target.value = "";
              if (!files.length) return;
              setBusy(true);
              const { uploadFile } = await import("../meta");
              const added: FileVal[] = [];
              for (const file of files) {
                try {
                  const r = await uploadFile("work", file, { organizationId: orgId, employeeId: 0 });
                  added.push({ id: r.id, name: r.name, url: r.url, kind: r.kind });
                } catch {
                  // Skipped.
                }
              }
              setBusy(false);
              onChange([...list, ...added]);
            }}
          />
        </label>
      </span>
    );
  }
  if (f.type === "relationship") {
    const ids = (Array.isArray(value) ? value : []) as number[];
    const pool = tasks.filter((x) => !ids.includes(x.id) && (!f.setup || String(x.listId ?? "") === f.setup));
    return (
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        {ids.map((id) => (
          <button key={id} type="button" className="gp-chip" aria-label="Remove" onClick={() => onChange(ids.filter((x) => x !== id))}>↔ {tasks.find((x) => x.id === id)?.name ?? `Task ${id}`} ✕</button>
        ))}
        <select className="ld-in xs" style={{ width: 240 }} aria-label={`Add to ${f.name}`} value="" onChange={(e) => e.target.value && onChange([...ids, Number(e.target.value)])}>
          <option value="">Pick a task</option>
          {pool.slice(0, 300).map((x) => (
            <option key={x.id} value={x.id}>{x.name}{x.listName ? ` (${x.listName})` : ""}</option>
          ))}
        </select>
      </span>
    );
  }
  const isNum = f.type === "number" || f.type === "money" || f.type === "progress";
  return (
    <input
      className="ld-in xs"
      style={isNum ? { width: 120 } : undefined}
      aria-label={f.name}
      inputMode={isNum ? "decimal" : f.type === "phone" ? "tel" : undefined}
      type={f.type === "email" ? "email" : "text"}
      placeholder={f.type === "date" ? "MM/DD/YYYY" : f.type === "website" ? "https://" : f.type === "progress" ? "0 to 100" : ""}
      value={f.type === "date" ? toMdy(String(value ?? "")) : value === null || value === undefined ? "" : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (isNum) onChange(raw === "" ? null : raw.replace(/[^\d.-]/g, "") === "" ? null : Number(raw.replace(/[^\d.-]/g, "")));
        else if (f.type === "date") onChange(fromMdy(raw));
        else onChange(raw);
      }}
    />
  );
}
