import React from "react";
import { trpc } from "@/lib/trpc";
import { fmtYmd, OwnerAvatar, type Owner } from "../goals/shared";
import { FieldInput, FieldValue, type FieldDef } from "./fields";
import { PRIORITY_COLOR, PRIORITY_TEXT, StatusTag } from "./bits";
import type { TaskRow } from "../pages/Projects";

/**
 * Quick edits, the way ClickUp does them: click a cell (in a list row, the
 * table, or the task window) and a small picker opens in place. Pick, and it
 * saves. Click away or press Escape to close without changing anything.
 * These work for anyone with edit access to the task's list; everyone else
 * sees the plain value.
 */

type Assignee = TaskRow["assignees"][number];
export type QuickTask = { id: number; listId: number; assignees: Assignee[]; dueDate: string | null; startDate: string | null; priority: string | null; status: string; closed: boolean; fields: Record<string, unknown>; subtasks: number; subtasksDone: number; checklist: { done: number; total: number } };
export type QuickCtx = { orgId: number; people: Owner[]; statuses: { name: string; color: string; type: string }[]; canEdit: boolean; refresh: () => Promise<unknown>; today: string; tasks?: { id: number; name: string }[] };

/** The popup itself: positioned under its cell, closed by a click outside or Escape. */
export function Pop({ onClose, children, width = 260, align = "left" }: { onClose: () => void; children: React.ReactNode; width?: number; align?: "left" | "right" }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  // Keep the popup on screen: flip up when there's no room below.
  const [up, setUp] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setUp(r.bottom > window.innerHeight - 8 && r.top > r.height + 40);
  }, []);
  return (
    <div ref={ref} className={`gp-qpop ${up ? "up" : ""}`} style={{ width, ...(align === "right" ? { right: 0 } : { left: 0 }) }} role="dialog" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** A cell that opens a picker. `show` is the read value; `pick` renders the popup. */
export function Cell({ canEdit, show, pick, ghost, className = "" }: { canEdit: boolean; show: React.ReactNode; pick: (close: () => void) => React.ReactNode; ghost?: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  if (!canEdit) return <span className={className}>{show}</span>;
  return (
    <span className={`gp-qcell ${className}`} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`gp-qbtn ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} onKeyDown={(e) => e.stopPropagation()}>
        {show}
        {ghost && <span className="gp-qghost">{ghost}</span>}
      </button>
      {open && pick(close)}
    </span>
  );
}

function useSave(q: QuickCtx) {
  const up = trpc.pj.update.useMutation({ onSuccess: () => q.refresh() });
  return (id: number, patch: Parameters<typeof up.mutate>[0]["patch"]) => up.mutate({ organizationId: q.orgId, id, patch });
}

const same = (a: Assignee, b: Owner) => a.type === b.type && a.id === b.id && (a.type !== "name" || a.name === b.name);

/** People: click a name to add or remove. */
export function PeoplePick({ q, value, onChange, close, title = "People" }: { q: QuickCtx; value: Assignee[]; onChange: (v: Assignee[]) => void; close: () => void; title?: string }) {
  const [s, setS] = React.useState("");
  const words = s.trim().toLowerCase();
  const hit = (p: Owner) => !words || p.name.toLowerCase().includes(words);
  const people = q.people.filter((p) => p.type === "user" && hit(p));
  const emps = q.people.filter((p) => p.type === "employee" && hit(p));
  const toggle = (p: Owner) => {
    const on = value.some((a) => same(a, p));
    onChange(on ? value.filter((a) => !same(a, p)) : [...value, { type: p.type, id: p.id, name: p.name }]);
  };
  const row = (p: Owner) => {
    const on = value.some((a) => same(a, p));
    return (
      <button key={`${p.type}:${p.id}`} type="button" className={`gp-qi ${on ? "on" : ""}`} onClick={() => toggle(p)}>
        <OwnerAvatar o={p} size={22} />
        <span className="gp-ell">{p.name}</span>
        {p.type === "employee" && p.kind ? <span className="ld-small ld-muted">{p.kind}</span> : null}
        {on && <span className="tick">✓</span>}
      </button>
    );
  };
  return (
    <Pop onClose={close}>
      <input className="ld-in xs" autoFocus aria-label={`Search ${title.toLowerCase()}`} placeholder="Search people" value={s} onChange={(e) => setS(e.target.value)} />
      {people.length > 0 && <span className="gp-qh">People</span>}
      {people.map(row)}
      {emps.length > 0 && <span className="gp-qh">AI employees</span>}
      {emps.map(row)}
      {!people.length && !emps.length && <span className="ld-small ld-muted" style={{ padding: "6px 8px" }}>Nobody matches.</span>}
      {value.length > 0 && (
        <button type="button" className="gp-qi" onClick={() => onChange([])}>
          <span className="ld-small ld-muted">Clear</span>
        </button>
      )}
    </Pop>
  );
}

/** A date: quick choices, a small calendar, or type MM/DD/YYYY. */
export function DatePick({ value, onChange, close, today }: { value: string | null; onChange: (v: string | null) => void; close: () => void; today: string }) {
  const [typed, setTyped] = React.useState("");
  const [err, setErr] = React.useState("");
  const base = value ?? today;
  const [y0, m0] = base.split("-").map(Number);
  const [ym, setYm] = React.useState<[number, number]>([y0, m0]);
  const [y, m] = ym;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const startDow = first.getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: number) => `${y}-${pad(m)}-${pad(d)}`;
  const shift = (base: string, n: number) => {
    const d = new Date(`${base}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const pick = (v: string | null) => {
    onChange(v);
    close();
  };
  const submitTyped = () => {
    const mm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(typed.trim());
    if (!mm) return setErr("Type it as MM/DD/YYYY.");
    pick(`${mm[3]}-${pad(Number(mm[1]))}-${pad(Number(mm[2]))}`);
  };
  const monthName = first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <Pop onClose={close} width={262}>
      <div className="gp-qquick">
        <button type="button" onClick={() => pick(today)}>Today</button>
        <button type="button" onClick={() => pick(shift(today, 1))}>Tomorrow</button>
        <button type="button" onClick={() => pick(shift(today, 7))}>Next week</button>
        <button type="button" onClick={() => pick(null)}>No date</button>
      </div>
      <div className="gp-qmon">
        <button type="button" aria-label="Earlier month" onClick={() => setYm(m === 1 ? [y - 1, 12] : [y, m - 1])}>‹</button>
        <b>{monthName}</b>
        <button type="button" aria-label="Later month" onClick={() => setYm(m === 12 ? [y + 1, 1] : [y, m + 1])}>›</button>
      </div>
      <div className="gp-qcal">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i} className="h">{d}</span>
        ))}
        {Array.from({ length: startDow }).map((_, i) => (
          <span key={`b${i}`} />
        ))}
        {Array.from({ length: days }).map((_, i) => {
          const v = ymd(i + 1);
          return (
            <button key={v} type="button" className={`${v === value ? "on" : ""} ${v === today ? "today" : ""}`} onClick={() => pick(v)}>
              {i + 1}
            </button>
          );
        })}
      </div>
      <div className="ld-row">
        <input className="ld-in xs" style={{ flex: 1 }} aria-label="Type a date" placeholder="Or type 10/16/2026" value={typed} onChange={(e) => { setTyped(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submitTyped()} />
        <button type="button" className="ld-btn sm" onClick={submitTyped} disabled={!typed.trim()}>Set</button>
      </div>
      {err && <span className="ld-small" style={{ color: "#b42318" }}>{err}</span>}
    </Pop>
  );
}

export function PriorityPick({ value, onChange, close }: { value: string | null; onChange: (v: string | null) => void; close: () => void }) {
  return (
    <Pop onClose={close} width={170}>
      {(["urgent", "high", "normal", "low"] as const).map((p) => (
        <button key={p} type="button" className={`gp-qi ${value === p ? "on" : ""}`} onClick={() => { onChange(p); close(); }}>
          <span style={{ color: PRIORITY_COLOR[p] }}>⚑</span>
          {PRIORITY_TEXT[p]}
        </button>
      ))}
      <button type="button" className={`gp-qi ${!value ? "on" : ""}`} onClick={() => { onChange(null); close(); }}>
        <span className="ld-muted">⚑</span>None
      </button>
    </Pop>
  );
}

export function StatusPick({ statuses, value, onChange, close }: { statuses: QuickCtx["statuses"]; value: string; onChange: (v: string) => void; close: () => void }) {
  return (
    <Pop onClose={close} width={200}>
      {statuses.map((s) => (
        <button key={s.name} type="button" className={`gp-qi ${value === s.name ? "on" : ""}`} onClick={() => { onChange(s.name); close(); }}>
          <StatusTag name={s.name} color={s.color} />
        </button>
      ))}
    </Pop>
  );
}

/** A custom field: the same input the task editor uses, with Save and Cancel. */
export function FieldPick({ q, f, fields, t, close }: { q: QuickCtx; f: FieldDef; fields: FieldDef[]; t: QuickTask; close: () => void }) {
  const save = useSave(q);
  const [v, setV] = React.useState<unknown>(t.fields[f.id]);
  const done = () => {
    save(t.id, { fields: { ...t.fields, [f.id]: v } });
    close();
  };
  return (
    <Pop onClose={close} width={300}>
      <span className="gp-qh">{f.name}</span>
      <div style={{ padding: "0 4px" }} onKeyDown={(e) => e.key === "Enter" && done()}>
        <FieldInput f={f} value={v} onChange={setV} people={q.people} tasks={q.tasks ?? []} orgId={q.orgId} />
      </div>
      <span className="ld-row" style={{ justifyContent: "flex-end", padding: "4px 4px 0" }}>
        <button type="button" className="ld-btn sm" onClick={close}>Cancel</button>
        <button type="button" className="ld-btn p sm" onClick={done}>Save</button>
      </span>
    </Pop>
  );
}

// ---- Cells that read the task and save straight away ----

export function AssigneeCell({ q, t, max = 3, label }: { q: QuickCtx; t: QuickTask; max?: number; label?: boolean }) {
  const save = useSave(q);
  const show = t.assignees.length ? (
    <span className="gp-avs" aria-label={t.assignees.map((a) => a.name).join(", ")}>
      {t.assignees.slice(0, max).map((a) => (
        <OwnerAvatar key={`${a.type}:${a.id}:${a.name}`} o={q.people.find((p) => same(a, p)) ?? { type: "name", id: 0, name: a.name }} size={24} />
      ))}
      {t.assignees.length > max && <span className="more">+{t.assignees.length - max}</span>}
      {label && <span style={{ marginLeft: 6 }}>{t.assignees.map((a) => a.name).join(", ")}</span>}
    </span>
  ) : (
    <span className="ld-small ld-muted">Unassigned</span>
  );
  return <Cell canEdit={q.canEdit} show={show} ghost={!t.assignees.length ? "⊕ Assign" : undefined} pick={(close) => <PeoplePick q={q} value={t.assignees} onChange={(v) => save(t.id, { assignees: v })} close={close} />} />;
}

export function DateCell({ q, t, which }: { q: QuickCtx; t: QuickTask; which: "dueDate" | "startDate" }) {
  const save = useSave(q);
  const v = t[which];
  const late = which === "dueDate" && v && !t.closed && v < q.today;
  const show = v ? <span style={late ? { color: "#c2253c", fontWeight: 700 } : undefined}>{fmtYmd(v)}</span> : <span className="ld-small ld-muted">No date</span>;
  return <Cell canEdit={q.canEdit} show={show} ghost={!v ? "📅 Date" : undefined} pick={(close) => <DatePick value={v} onChange={(d) => save(t.id, { [which]: d })} close={close} today={q.today} />} />;
}

export function PriorityCell({ q, t }: { q: QuickCtx; t: QuickTask }) {
  const save = useSave(q);
  const show = t.priority ? (
    <span className="gp-flag" style={{ color: PRIORITY_COLOR[t.priority] }}>
      ⚑ {PRIORITY_TEXT[t.priority]}
    </span>
  ) : (
    <span className="ld-small ld-muted">None</span>
  );
  return <Cell canEdit={q.canEdit} show={show} ghost={!t.priority ? "⚑ Priority" : undefined} pick={(close) => <PriorityPick value={t.priority} onChange={(p) => save(t.id, { priority: p as "urgent" | "high" | "normal" | "low" | null })} close={close} />} />;
}

export function StatusCell({ q, t, color }: { q: QuickCtx; t: QuickTask; color: string }) {
  const save = useSave(q);
  return <Cell canEdit={q.canEdit} show={<StatusTag name={t.status} color={color} />} pick={(close) => <StatusPick statuses={q.statuses} value={t.status} onChange={(s) => save(t.id, { status: s })} close={close} />} />;
}

export function FieldCell({ q, t, f, fields }: { q: QuickCtx; t: QuickTask; f: FieldDef; fields: FieldDef[] }) {
  const empty = t.fields[f.id] === undefined || t.fields[f.id] === null || t.fields[f.id] === "";
  const show = <FieldValue f={f} fields={fields} t={t} people={q.people} tasks={q.tasks} />;
  if (f.type === "formula" || f.type === "progress") return <span>{show}</span>;
  return <Cell canEdit={q.canEdit} show={show} ghost={empty ? `+ ${f.name}` : undefined} pick={(close) => <FieldPick q={q} f={f} fields={fields} t={t} close={close} />} />;
}
