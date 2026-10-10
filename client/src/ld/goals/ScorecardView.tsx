import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtYmd, OwnerName, OwnerSelect, ownerKey, parseOwnerKey, Spark, STATUS_COLOR, StatusPill, valueText } from "./shared";
import type { GoalsCtx, Overview } from "../pages/Goals";

/** The weekly scorecard: each measure's owner, weekly goal, trend and status; a row opens its 13 weeks and Simone's read. Edit changes the measures. */
type Row = Overview["scorecard"]["rows"][number];
type Unit = "number" | "currency" | "percent" | "hours";

export function ScorecardView({ c }: { c: GoalsCtx }) {
  const [editing, setEditing] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);
  const s = c.data.scorecard;
  if (editing) return <ScorecardEdit c={c} onDone={() => setEditing(false)} />;
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <h3>Weekly scorecard · week of {fmtYmd(s.thisWeek)}</h3>
        <span className="ld-row">
          <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Add a measure</button>
          <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>
        </span>
      </div>
      {c.data.read?.note && (
        <div className="gp-note" style={{ margin: "14px 18px 4px" }}>
          <span className="gp-sav">S</span>
          <span>{c.data.read.note}</span>
        </div>
      )}
      <div className="gp-sch">
        <span>Measure</span>
        <span>Owner</span>
        <span>Weekly goal</span>
        <span>Type</span>
        <span>Last 6 weeks</span>
        <span>This week</span>
        <span>Status</span>
      </div>
      {s.rows.length === 0 && <div className="gp-empty">No measures yet. Press Edit to add the numbers you want to see every week.</div>}
      {s.rows.map((r) => (
        <React.Fragment key={r.measure.id}>
          <button type="button" className={`gp-scr ${open === r.measure.id ? "open" : ""}`} aria-expanded={open === r.measure.id} onClick={() => setOpen(open === r.measure.id ? null : r.measure.id)}>
            <b>{r.measure.name}</b>
            <OwnerName o={r.owner} />
            <span>{r.measure.weeklyGoal === null ? "None" : `${r.measure.direction === "down" ? "Under " : ""}${valueText(r.measure.weeklyGoal, r.measure.unit)}`}</span>
            <span className="gp-chip">{r.measure.kind === "leading" ? "Leading" : "Result"}</span>
            <Spark values={r.values.slice(-6)} goal={r.measure.weeklyGoal} color={STATUS_COLOR[r.status ?? "on"]} />
            <b>{valueText(r.value, r.measure.unit) || "None yet"}</b>
            <StatusPill s={r.status} />
          </button>
          {open === r.measure.id && <Detail c={c} r={r} />}
        </React.Fragment>
      ))}
      <div className="ld-small ld-muted" style={{ padding: "12px 18px" }}>
        Leading measures move first and predict results. On track meets the weekly goal, at risk is within 10% of it, off track is further, or under goal three weeks in a row.
      </div>
    </div>
  );
}

function trend(r: Row) {
  const vals = r.values.filter((v): v is number => v !== null);
  const goal = r.measure.weeklyGoal;
  if (vals.length < 2) return "Not enough weeks yet.";
  const first = vals[0];
  const last = vals[vals.length - 1];
  const met = (v: number) => goal === null || (r.measure.direction === "up" ? v >= goal : v <= goal);
  let run = 0;
  for (let i = r.values.length - 1; i >= 0; i--) {
    const v = r.values[i];
    if (v === null || met(v)) break;
    run++;
  }
  const dir = last === first ? "Flat" : last > first ? "Up" : "Down";
  return `${dir} ${last === first ? "" : `${valueText(Math.abs(last - first), r.measure.unit)} `}over ${vals.length} weeks${run >= 2 ? `, under goal ${run} weeks in a row` : ""}.`;
}

function Detail({ c, r }: { c: GoalsCtx; r: Row }) {
  const [entering, setEntering] = React.useState(false);
  const [val, setVal] = React.useState("");
  const setValue = trpc.goals.setValue.useMutation({ onSuccess: async () => { setEntering(false); await c.refresh(); } });
  const topic = trpc.goals.addTopic.useMutation();
  const task = trpc.goals.makeTask.useMutation();
  const said = c.data.read?.items.find((i) => i.measureId === r.measure.id);
  const goal = c.data.goals.find((g) => g.goal.id === r.measure.goalId);
  const emp = r.owner?.type === "employee" ? r.owner : null;
  const manual = r.measure.source === "manual";
  return (
    <div className="gp-scx">
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="gp-leg">
          <span><i style={{ background: STATUS_COLOR[r.status ?? "on"] }} />Actual</span>
          {r.measure.weeklyGoal !== null && <span><i style={{ background: "var(--ld-soft)" }} />Goal {valueText(r.measure.weeklyGoal, r.measure.unit)}</span>}
        </div>
        <WeekChart r={r} weeks={c.data.scorecard.weeks} />
      </div>
      <div className="gp-kv">
        <b>Trend</b>
        <span>{trend(r)}</span>
        {said && (
          <>
            <b>Simone's read</b>
            <span>{said.text}</span>
          </>
        )}
        <b>Moves</b>
        <span>{goal ? goal.goal.title : "Not tied to a goal yet (Edit to tie it)"}</span>
        <b>Comes from</b>
        <span>{r.sourceLabel}</span>
        {manual && (
          <>
            <b>This week</b>
            {entering ? (
              <span className="ld-row">
                <input className="ld-in xs" style={{ width: 120 }} autoFocus aria-label={`${r.measure.name} this week`} inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value.replace(/[^\d.-]/g, ""))} />
                <button type="button" className="ld-btn sm" onClick={() => setEntering(false)}>Cancel</button>
                <button type="button" className="ld-btn p sm" disabled={setValue.isPending} onClick={() => setValue.mutate({ organizationId: c.orgId, measureId: r.measure.id, weekStart: c.data.scorecard.thisWeek, value: val === "" ? null : Number(val) })}>Save</button>
              </span>
            ) : (
              <span>{valueText(r.value, r.measure.unit) || "Not entered yet"}</span>
            )}
          </>
        )}
      </div>
      <div className="gp-col-btns">
        {manual && !entering && (
          <button type="button" className="ld-btn" onClick={() => { setVal(r.value === null ? "" : String(r.value)); setEntering(true); }}>Enter number</button>
        )}
        <button type="button" className="ld-btn" disabled={topic.isPending || topic.isSuccess} onClick={() => topic.mutate({ organizationId: c.orgId, text: `${r.measure.name}: ${valueText(r.value, r.measure.unit) || "no number"} against ${valueText(r.measure.weeklyGoal, r.measure.unit)} (${r.status ?? "no status"})` })}>
          {topic.isSuccess ? "On the agenda" : "Add to meeting"}
        </button>
        <button type="button" className="ld-btn" disabled={task.isPending || task.isSuccess} onClick={() => task.mutate({ organizationId: c.orgId, text: `Get ${r.measure.name.toLowerCase()} back to ${valueText(r.measure.weeklyGoal, r.measure.unit)}`, goalId: r.measure.goalId })}>
          {task.isSuccess ? "Task made" : "Make a task"}
        </button>
        {emp && (
          <Link href={`/chats/${emp.kind}`} className="ld-btn">Ask {emp.name}</Link>
        )}
        <ErrorLine error={setValue.error || topic.error || task.error} />
      </div>
    </div>
  );
}

function WeekChart({ r, weeks }: { r: Row; weeks: string[] }) {
  const w = 620;
  const h = 170;
  const L = 44;
  const T = 10;
  const B = 24;
  const vals = r.values;
  const goal = r.measure.weeklyGoal;
  const nums = vals.filter((v): v is number => v !== null);
  const mx = Math.max(1, ...nums, goal ?? 0) * 1.15;
  const X = (i: number) => L + (i / Math.max(1, vals.length - 1)) * (w - L - 10);
  const Y = (v: number) => T + (h - T - B) - (v / mx) * (h - T - B);
  const pts = vals.map((v, i) => (v === null ? null : `${X(i).toFixed(0)},${Y(v).toFixed(0)}`)).filter(Boolean).join(" ");
  const avg = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" className="gp-chartbox" role="img" aria-label={`${r.measure.name}, last ${vals.length} weeks`}>
      {[0, 0.5, 1].map((k) => (
        <g key={k}>
          <line x1={L} x2={w - 10} y1={Y(mx * k)} y2={Y(mx * k)} stroke="var(--ld-line2)" />
          <text x={L - 6} y={Y(mx * k) + 4} fontSize="10" textAnchor="end" fill="var(--ld-muted)">{valueText(Math.round(mx * k * 10) / 10, r.measure.unit)}</text>
        </g>
      ))}
      {goal !== null && <line x1={L} x2={w - 10} y1={Y(goal)} y2={Y(goal)} stroke="var(--ld-soft)" strokeDasharray="5 4" />}
      {avg !== null && <line x1={L} x2={w - 10} y1={Y(avg)} y2={Y(avg)} stroke="#c98a1b" strokeDasharray="2 3" />}
      {pts && <polyline points={pts} fill="none" stroke={STATUS_COLOR[r.status ?? "on"]} strokeWidth="2.5" />}
      <text x={L} y={h - 6} fontSize="10" fill="var(--ld-muted)">{fmtYmd(weeks[0])}</text>
      <text x={w - 10} y={h - 6} fontSize="10" textAnchor="end" fill="var(--ld-muted)">{fmtYmd(weeks[weeks.length - 1])}</text>
    </svg>
  );
}

type EditRow = { id?: number; name: string; owner: string; goal: string; unit: Unit; direction: "up" | "down"; kind: "leading" | "result"; source: string; goalId: number | null };

function ScorecardEdit({ c, onDone }: { c: GoalsCtx; onDone: () => void }) {
  const save = trpc.goals.saveScorecard.useMutation({ onSuccess: async () => { await c.refresh(); onDone(); } });
  const blank = (): EditRow => ({ name: "", owner: "", goal: "", unit: "number", direction: "up", kind: "leading", source: "manual", goalId: null });
  const [rows, setRows] = React.useState<EditRow[]>(() => [
    ...c.data.scorecard.rows.map((r) => ({ id: r.measure.id, name: r.measure.name, owner: r.owner ? ownerKey(r.owner) : "", goal: r.measure.weeklyGoal === null ? "" : String(r.measure.weeklyGoal), unit: r.measure.unit as Unit, direction: r.measure.direction, kind: r.measure.kind, source: r.measure.source, goalId: r.measure.goalId })),
    blank(),
  ]);
  const set = (i: number, patch: Partial<EditRow>) => {
    const next = rows.map((r, k) => (k === i ? { ...r, ...patch } : r));
    if (i === rows.length - 1 && (patch.name ?? "").trim()) next.push(blank());
    setRows(next);
  };
  const submit = () =>
    save.mutate({
      organizationId: c.orgId,
      rows: rows
        .filter((r) => r.name.trim())
        .map((r) => {
          const o = parseOwnerKey(r.owner);
          return { id: r.id, name: r.name, ownerType: o?.type ?? null, ownerId: o?.id ?? null, weeklyGoal: r.goal === "" ? null : Number(r.goal), unit: r.unit, direction: r.direction, kind: r.kind, source: r.source, goalId: r.goalId };
        }),
    });
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <h3>Weekly scorecard</h3>
        <span className="ld-row">
          <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
          <button type="button" className="ld-btn p" disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving" : "Save"}</button>
        </span>
      </div>
      <div className="gp-seh">
        <span>Measure</span>
        <span>Owner</span>
        <span>Weekly goal</span>
        <span>Unit</span>
        <span>Better when</span>
        <span>Type</span>
        <span>Comes from</span>
        <span>Ties to goal</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={r.id ?? `n${i}`} className="gp-ser">
          <input className="ld-in xs" aria-label="Measure" placeholder={i === rows.length - 1 ? "New measure" : ""} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <OwnerSelect label="Owner" people={c.data.people} value={r.owner} onChange={(v) => set(i, { owner: v })} none="Pick an owner" />
          <input className="ld-in xs" aria-label="Weekly goal" inputMode="decimal" placeholder="Goal" value={r.goal} onChange={(e) => set(i, { goal: e.target.value.replace(/[^\d.-]/g, "") })} />
          <select className="ld-in xs" aria-label="Unit" value={r.unit} onChange={(e) => set(i, { unit: e.target.value as Unit })}>
            <option value="number">Number</option>
            <option value="currency">Money</option>
            <option value="percent">Percent</option>
            <option value="hours">Hours</option>
          </select>
          <select className="ld-in xs" aria-label="Better when" value={r.direction} onChange={(e) => set(i, { direction: e.target.value as "up" | "down" })}>
            <option value="up">Higher</option>
            <option value="down">Lower</option>
          </select>
          <select className="ld-in xs" aria-label="Type" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as "leading" | "result" })}>
            <option value="leading">Leading</option>
            <option value="result">Result</option>
          </select>
          <select className="ld-in xs" aria-label="Comes from" value={r.source} onChange={(e) => set(i, { source: e.target.value })}>
            {c.data.sources.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <select className="ld-in xs" aria-label="Ties to goal" value={r.goalId ?? ""} onChange={(e) => set(i, { goalId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No goal</option>
            {c.data.goals.filter((g) => g.goal.state === "active").map((g) => (
              <option key={g.goal.id} value={g.goal.id}>{g.goal.title}</option>
            ))}
          </select>
          {i === rows.length - 1 ? <span /> : <button type="button" className="ld-btn sm" onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remove</button>}
        </div>
      ))}
      <div className="ld-small ld-muted" style={{ padding: "12px 18px" }}>
        Owners can be people or employees. For "Typed in each week", the person who owns it gets a notice every Monday morning when last week's number is missing; the app counts the others itself.
      </div>
      <div style={{ padding: "0 18px 12px" }}>
        <ErrorLine error={save.error} />
      </div>
    </div>
  );
}
