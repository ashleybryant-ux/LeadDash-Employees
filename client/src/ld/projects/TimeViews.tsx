import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { addDays, fmtYmd, OwnerAvatar } from "../goals/shared";
import { statusColor } from "./bits";
import type { PjCtx, TaskRow } from "../pages/Projects";

/** Calendar and Gantt views of tasks, weeks starting on Sunday. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wd = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

export function CalendarView({ c }: { c: PjCtx }) {
  const [month, setMonth] = React.useState(c.data.today.slice(0, 7));
  const first = `${month}-01`;
  const start = addDays(first, -wd(first));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const [y, m] = month.split("-").map(Number);
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1, 12));
    setMonth(d.toISOString().slice(0, 7));
  };
  const undated = c.tasks.filter((t) => !t.dueDate && !t.closed).length;
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => shift(-1)} aria-label="Last month">Previous</button>
          <h3 style={{ minWidth: 170, textAlign: "center" }}>{MONTHS[m - 1]} {y}</h3>
          <button type="button" className="ld-btn sm" onClick={() => shift(1)} aria-label="Next month">Next</button>
        </span>
        <span className="ld-row">
          {undated > 0 && <span className="ld-small ld-muted">{undated} open task{undated === 1 ? "" : "s"} without a due date</span>}
          <button type="button" className="ld-btn sm" onClick={() => setMonth(c.data.today.slice(0, 7))}>Today</button>
        </span>
      </div>
      <div className="gp-cal">
        {DAYS.map((d) => (
          <span key={d} className="dh">{d}</span>
        ))}
        {cells.map((d) => {
          const ts = c.tasks.filter((t) => t.dueDate === d);
          return (
            <div key={d} className={`cell ${d.slice(0, 7) !== month ? "out" : ""} ${d === c.data.today ? "today" : ""}`}>
              <span className="dn">{Number(d.slice(8))}</span>
              {ts.slice(0, 4).map((t) => (
                <button key={t.id} type="button" className={`ev ${t.closed ? "done" : ""}`} style={{ borderLeftColor: statusColor(c, t) }} onClick={() => c.open(t.id)}>
                  {t.name}
                </button>
              ))}
              {ts.length > 4 && <span className="ld-small ld-muted">+{ts.length - 4} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GanttView({ c }: { c: PjCtx }) {
  const weeks = 9;
  const [from, setFrom] = React.useState(() => addDays(c.data.today, -wd(c.data.today) - 7));
  const days = weeks * 7;
  const lane = React.useRef<HTMLDivElement>(null);
  const shift = trpc.pj.shiftDates.useMutation({ onSuccess: () => c.refresh() });
  const [drag, setDrag] = React.useState<{ id: number; mode: "move" | "end"; x0: number; delta: number } | null>(null);
  const rows = c.tasks.filter((t) => t.dueDate || t.startDate).sort((a, b) => (a.startDate ?? a.dueDate ?? "").localeCompare(b.startDate ?? b.dueDate ?? ""));
  const none = c.tasks.filter((t) => !t.dueDate && !t.startDate);
  const dayW = () => (lane.current?.clientWidth ?? 700) / days;
  const span = (t: TaskRow) => {
    const s = t.startDate ?? t.dueDate!;
    const e = t.dueDate ?? t.startDate!;
    let a = daysBetween(from, s);
    let b = daysBetween(from, e) + 1;
    if (drag?.id === t.id) {
      if (drag.mode === "move") {
        a += drag.delta;
        b += drag.delta;
      } else b = Math.max(a + 1, b + drag.delta);
    }
    return { a, b };
  };
  const done = (t: TaskRow) => {
    if (!drag || drag.id !== t.id) return;
    const d = drag.delta;
    setDrag(null);
    if (!d) return;
    const s = t.startDate ?? t.dueDate!;
    const e = t.dueDate ?? t.startDate!;
    if (drag.mode === "move") shift.mutate({ organizationId: c.orgId, id: t.id, startDate: addDays(s, d), dueDate: addDays(e, d) });
    else {
      const ne = addDays(e, d);
      shift.mutate({ organizationId: c.orgId, id: t.id, startDate: s, dueDate: ne < s ? s : ne });
    }
  };
  const todayAt = daysBetween(from, c.data.today);
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => setFrom(addDays(from, -28))}>Earlier</button>
          <button type="button" className="ld-btn sm" onClick={() => setFrom(addDays(c.data.today, -wd(c.data.today) - 7))}>Today</button>
          <button type="button" className="ld-btn sm" onClick={() => setFrom(addDays(from, 28))}>Later</button>
        </span>
        <span className="ld-small ld-muted">Drag a bar to move its dates; drag its end to change how long it runs.</span>
      </div>
      <ErrorLine error={shift.error} />
      <div className="gp-gantt">
        <div className="gh">
          <span>Task</span>
          <div className="wk">
            {Array.from({ length: weeks }, (_, i) => (
              <span key={i}>{fmtYmd(addDays(from, i * 7))}</span>
            ))}
          </div>
        </div>
        {rows.map((t, i) => {
          const { a, b } = span(t);
          const left = Math.max(0, a);
          const right = Math.min(days, b);
          const show = right > 0 && left < days;
          const a0 = t.assignees[0];
          return (
            <div key={t.id} className="grw">
              <button type="button" className="nm" onClick={() => c.open(t.id)}>
                {a0 ? <OwnerAvatar o={c.data.people.find((p) => p.type === a0.type && p.id === a0.id) ?? { type: "name", id: 0, name: a0.name }} size={22} /> : <span style={{ width: 22 }} />}
                <span className="gp-ell">{t.name}</span>
              </button>
              <div className="lane" ref={i === 0 ? lane : undefined} style={{ backgroundSize: `${100 / weeks}% 100%` }}>
                {i === 0 && todayAt >= 0 && todayAt < days && <span className="now" style={{ left: `${((todayAt + 0.5) / days) * 100}%`, height: `${rows.length * 42}px` }} />}
                {show && (
                  <span
                    className={`bar ${t.closed ? "done" : ""}`}
                    style={{ left: `${(left / days) * 100}%`, width: `${Math.max(1.4, ((right - left) / days) * 100)}%`, background: statusColor(c, t) }}
                    onPointerDown={(e) => {
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                      setDrag({ id: t.id, mode: (e.target as HTMLElement).classList.contains("end") ? "end" : "move", x0: e.clientX, delta: 0 });
                    }}
                    onPointerMove={(e) => drag?.id === t.id && setDrag({ ...drag, delta: Math.round((e.clientX - drag.x0) / dayW()) })}
                    onPointerUp={() => done(t)}
                    title={`${fmtYmd(t.startDate ?? t.dueDate)} to ${fmtYmd(t.dueDate ?? t.startDate)}`}
                  >
                    <span className="lb">{right - left > 4 ? t.name : ""}</span>
                    <span className="end" aria-hidden="true" />
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="gp-empty">No tasks with dates yet. Give a task a start or due date and it shows here.</div>}
      </div>
      {none.length > 0 && <div className="ld-small ld-muted" style={{ padding: "10px 18px" }}>{none.length} task{none.length === 1 ? "" : "s"} without dates aren't shown.</div>}
    </div>
  );
}
