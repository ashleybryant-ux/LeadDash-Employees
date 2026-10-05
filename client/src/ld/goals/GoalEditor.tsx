import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { COLORS, OwnerSelect, parseOwnerKey } from "./shared";
import type { GoalRow, GoalsCtx } from "../pages/Goals";

type Level = "company" | "year" | "quarter" | "cycle";
type TKind = "number" | "currency" | "boolean" | "tasks" | "measure";
type TRow = { id?: number; kind: TKind; name: string; startValue: string; currentValue: string; targetValue: string; done: boolean; listId: number | null; measureId: number | null };

const pad = (n: number) => String(n).padStart(2, "0");
const addDays = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
};
function periodOf(level: Level, year: number, quarter: number, start: string, due: string) {
  if (level === "year") return { period: String(year), startDate: `${year}-01-01`, dueDate: `${year}-12-31` };
  if (level === "quarter") {
    const sm = (quarter - 1) * 3 + 1;
    const end = quarter === 4 ? `${year}-12-31` : addDays(`${year}-${pad(sm + 3)}-01`, -1);
    return { period: `Q${quarter} ${year}`, startDate: `${year}-${pad(sm)}-01`, dueDate: end };
  }
  if (level === "cycle") return { period: `12 weeks from ${start}`, startDate: start, dueDate: addDays(start, 83) };
  return { period: `${start.slice(0, 4)} to ${due.slice(0, 4)}`, startDate: start, dueDate: due };
}

/** New goal, or Edit: every field in one compact editor, with Save and Cancel. */
export function GoalEditor({ c, row, defaults, onClose }: { c: GoalsCtx; row: GoalRow | "new"; defaults?: Partial<GoalRow["goal"]>; onClose: () => void }) {
  const g = row === "new" ? null : row.goal;
  const today = c.data.today;
  const y = Number(today.slice(0, 4));
  const tree = trpc.pj.tree.useQuery({ organizationId: c.orgId });
  const save = trpc.goals.save.useMutation();
  const remove = trpc.goals.remove.useMutation();
  const [f, setF] = React.useState(() => ({
    title: g?.title ?? defaults?.title ?? "",
    description: g?.description ?? "",
    level: (g?.level ?? defaults?.level ?? "quarter") as Level,
    year: Number((g?.startDate ?? today).slice(0, 4)),
    quarter: Math.floor((Number((g?.startDate ?? today).slice(5, 7)) - 1) / 3) + 1,
    start: g?.startDate ?? today,
    due: g?.dueDate ?? `${y}-12-31`,
    startText: toMdy(g?.startDate ?? today),
    dueText: toMdy(g?.dueDate ?? `${y}-12-31`),
    parentId: g?.parentId ?? defaults?.parentId ?? null,
    folderId: g?.folderId ?? defaults?.folderId ?? null,
    owner: g?.ownerType ? `${g.ownerType}:${g.ownerId}` : "",
    color: g?.color ?? COLORS[0],
    status: (g?.status ?? "") as "" | "on" | "risk" | "off" | "done",
    manual: g?.manualProgress === null || g?.manualProgress === undefined ? "" : String(g.manualProgress),
  }));
  const [targets, setTargets] = React.useState<TRow[]>(() =>
    row === "new" ? [] : row.targets.map((t) => ({ id: t.id, kind: t.kind as TKind, name: t.name, startValue: String(t.startValue), currentValue: String(t.currentValue), targetValue: String(t.targetValue), done: t.done, listId: t.listId, measureId: t.measureId }))
  );
  const [err, setErr] = React.useState<string | null>(null);
  const p = periodOf(f.level, f.year, f.quarter, f.start, f.due);
  const parents = c.data.goals.filter((x) => x.goal.id !== g?.id && x.goal.state === "active" && (x.goal.level === "company" || (x.goal.level === "year" && f.level !== "year" && f.level !== "company")));
  const lists = [...(tree.data?.folders ?? []).flatMap((fo) => fo.lists.map((l) => ({ id: l.id, name: `${fo.name} › ${l.name}` }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name }))];
  const submit = async () => {
    setErr(null);
    const o = parseOwnerKey(f.owner);
    try {
      await save.mutateAsync({
        organizationId: c.orgId,
        goal: {
          id: g?.id,
          title: f.title,
          description: f.description,
          level: f.level,
          parentId: f.parentId,
          folderId: f.folderId,
          ownerType: o?.type ?? null,
          ownerId: o?.id ?? null,
          startDate: p.startDate,
          dueDate: p.dueDate,
          period: p.period,
          color: f.color,
          status: f.status || null,
          manualProgress: f.manual === "" ? null : Number(f.manual),
          targets: targets.map((t) => ({ id: t.id, kind: t.kind, name: t.name || f.title, startValue: Number(t.startValue) || 0, currentValue: Number(t.currentValue) || 0, targetValue: Number(t.targetValue) || 0, done: t.done, listId: t.listId, measureId: t.measureId })),
        },
      });
      await c.refresh();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const setT = (i: number, patch: Partial<TRow>) => setTargets(targets.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={g ? `Edit ${g.title}` : "New goal"}>
      <div className="gp-mbox">
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>{g ? "Edit goal" : "New goal"}</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving" : "Save"}</button>
          </span>
        </div>
        <div className="gp-form">
          <label>Goal</label>
          <input className="ld-in" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="40 new paying practices" aria-label="Goal" />
          <label>Kind</label>
          <span className="ld-row">
            <select className="ld-in xs" aria-label="Kind" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as Level })}>
              <option value="company">Company goal</option>
              <option value="year">Year goal</option>
              <option value="quarter">Quarter goal</option>
              <option value="cycle">12-week cycle</option>
            </select>
            {(f.level === "year" || f.level === "quarter") && (
              <select className="ld-in xs" aria-label="Year" value={f.year} onChange={(e) => setF({ ...f, year: Number(e.target.value) })}>
                {[y - 1, y, y + 1, y + 2].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            )}
            {f.level === "quarter" && (
              <select className="ld-in xs" aria-label="Quarter" value={f.quarter} onChange={(e) => setF({ ...f, quarter: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>Q{n}</option>
                ))}
              </select>
            )}
            {(f.level === "cycle" || f.level === "company") && <input className="ld-in xs" aria-label="Start date (MM/DD/YYYY)" value={f.startText} onChange={(e) => setF({ ...f, startText: e.target.value, start: fromMdy(e.target.value) ?? f.start })} placeholder="MM/DD/YYYY" />}
            {f.level === "company" && <input className="ld-in xs" aria-label="Due date (MM/DD/YYYY)" value={f.dueText} onChange={(e) => setF({ ...f, dueText: e.target.value, due: fromMdy(e.target.value) ?? f.due })} placeholder="MM/DD/YYYY" />}
          </span>
          <label>Dates</label>
          <span className="ld-small ld-muted">{`${toLong(p.startDate)} to ${toLong(p.dueDate)}`}</span>
          <label>Rolls up to</label>
          <select className="ld-in xs" aria-label="Rolls up to" value={f.parentId ?? ""} onChange={(e) => setF({ ...f, parentId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nothing</option>
            {parents.map((x) => (
              <option key={x.goal.id} value={x.goal.id}>{x.goal.title} ({x.goal.period})</option>
            ))}
          </select>
          <label>Owner</label>
          <OwnerSelect label="Owner" people={c.data.people} value={f.owner} onChange={(v) => setF({ ...f, owner: v })} />
          <label>Folder</label>
          <select className="ld-in xs" aria-label="Folder" value={f.folderId ?? ""} onChange={(e) => setF({ ...f, folderId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No folder</option>
            {c.data.folders.map((fo) => (
              <option key={fo.id} value={fo.id}>{fo.name}</option>
            ))}
          </select>
          <label>Color</label>
          <span className="ld-row" role="radiogroup" aria-label="Color">
            {COLORS.map((col) => (
              <button key={col} type="button" role="radio" aria-checked={f.color === col} aria-label={col} className={`gp-sw ${f.color === col ? "on" : ""}`} style={{ background: col }} onClick={() => setF({ ...f, color: col })} />
            ))}
          </span>
          <label>Status</label>
          <select className="ld-in xs" aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })}>
            <option value="">From progress and pace</option>
            <option value="on">On track</option>
            <option value="risk">At risk</option>
            <option value="off">Off track</option>
            <option value="done">Done</option>
          </select>
          {targets.length === 0 && (
            <>
              <label>Progress</label>
              <input className="ld-in xs" style={{ width: 100 }} aria-label="Progress (0 to 100)" inputMode="numeric" value={f.manual} placeholder="0 to 100" onChange={(e) => setF({ ...f, manual: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })} />
            </>
          )}
          <label>Notes</label>
          <textarea className="ld-ta" rows={2} aria-label="Notes" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </div>
        <div className="gp-tgt">
          <div className="ld-between">
            <b>Targets</b>
            <button type="button" className="gp-link" onClick={() => setTargets([...targets, { kind: "number", name: "", startValue: "0", currentValue: "0", targetValue: "", done: false, listId: null, measureId: null }])}>+ Add a target</button>
          </div>
          {targets.length === 0 && <span className="ld-small ld-muted">No targets: progress is what you set above, or the sub-goals' average.</span>}
          {targets.map((t, i) => (
            <div key={i} className="gp-trow">
              <select className="ld-in xs" aria-label="Target kind" value={t.kind} onChange={(e) => setT(i, { kind: e.target.value as TKind })}>
                <option value="number">Number</option>
                <option value="currency">Money</option>
                <option value="boolean">Done or not</option>
                <option value="tasks">Tasks</option>
                <option value="measure">Scorecard measure</option>
              </select>
              <input className="ld-in xs" aria-label="What's counted" placeholder="What's counted" value={t.name} onChange={(e) => setT(i, { name: e.target.value })} />
              {(t.kind === "number" || t.kind === "currency") && (
                <>
                  <input className="ld-in xs" aria-label="Start" placeholder="Start" inputMode="decimal" value={t.startValue} onChange={(e) => setT(i, { startValue: e.target.value.replace(/[^\d.-]/g, "") })} />
                  <input className="ld-in xs" aria-label="Now" placeholder="Now" inputMode="decimal" value={t.currentValue} onChange={(e) => setT(i, { currentValue: e.target.value.replace(/[^\d.-]/g, "") })} />
                  <input className="ld-in xs" aria-label="Target" placeholder="Target" inputMode="decimal" value={t.targetValue} onChange={(e) => setT(i, { targetValue: e.target.value.replace(/[^\d.-]/g, "") })} />
                </>
              )}
              {t.kind === "boolean" && (
                <label className="ld-row ld-small" style={{ gridColumn: "span 3" }}>
                  <input type="checkbox" checked={t.done} onChange={(e) => setT(i, { done: e.target.checked })} /> Done
                </label>
              )}
              {t.kind === "tasks" && (
                <select className="ld-in xs" style={{ gridColumn: "span 3" }} aria-label="List" value={t.listId ?? ""} onChange={(e) => setT(i, { listId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Tasks tied to this goal</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              )}
              {t.kind === "measure" && (
                <>
                  <select className="ld-in xs" style={{ gridColumn: "span 2" }} aria-label="Measure" value={t.measureId ?? ""} onChange={(e) => setT(i, { measureId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Pick a measure</option>
                    {c.data.scorecard.rows.map((r) => (
                      <option key={r.measure.id} value={r.measure.id}>{r.measure.name}</option>
                    ))}
                  </select>
                  <input className="ld-in xs" aria-label="Target" placeholder="Target" inputMode="decimal" value={t.targetValue} onChange={(e) => setT(i, { targetValue: e.target.value.replace(/[^\d.-]/g, "") })} />
                </>
              )}
              <button type="button" className="ld-btn sm" onClick={() => setTargets(targets.filter((_, k) => k !== i))}>Remove</button>
            </div>
          ))}
        </div>
        <ErrorLine error={err ? { message: err } : remove.error} />
        {g && (
          <div style={{ padding: "0 20px 18px" }}>
            <button
              type="button"
              className="ld-btn danger"
              disabled={remove.isPending}
              onClick={async () => {
                if (!window.confirm(`Remove "${g.title}"? Its sub-goals move up a level.`)) return;
                await remove.mutateAsync({ organizationId: c.orgId, id: g.id });
                await c.refresh();
                onClose();
              }}
            >
              Remove goal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function toMdy(ymd: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ymd;
}
function fromMdy(s: string) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}` : null;
}
function toLong(ymd: string) {
  const [yy, m, d] = ymd.split("-").map(Number);
  if (!yy) return ymd;
  return new Date(Date.UTC(yy, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
