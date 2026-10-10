import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { addDays, fmtYmd, OwnerAvatar } from "../goals/shared";
import { statusColor } from "./bits";
import type { PjCtx, TaskRow } from "../pages/Projects";

/**
 * Timeline (the Gantt, one row per person), Workload (each person's hours per
 * week against the hours they work), and the Mind map (the list, its tasks,
 * and their subtasks).
 */

const wd = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const keyOf = (a: { type: string; id: number; name: string }) => `${a.type}:${a.id}:${a.name}`;

// ==========================================
// Timeline
// ==========================================

export function TimelineView({ c }: { c: PjCtx }) {
  const weeks = 9;
  const days = weeks * 7;
  const [from, setFrom] = React.useState(() => addDays(c.data.today, -wd(c.data.today) - 7));
  const lane = React.useRef<HTMLDivElement>(null);
  const shift = trpc.pj.shiftDates.useMutation({ onSuccess: () => c.refresh() });
  const [drag, setDrag] = React.useState<{ id: number; x0: number; delta: number } | null>(null);
  const dated = c.tasks.filter((t) => t.dueDate || t.startDate);
  const owners = Array.from(new Map(dated.flatMap((t) => t.assignees).map((a) => [keyOf(a), a])).values());
  const lanes = [...owners.map((o) => ({ key: keyOf(o), who: o as { type: "user" | "employee" | "name"; id: number; name: string } | null, tasks: dated.filter((t) => t.assignees.some((a) => keyOf(a) === keyOf(o))) })), { key: "none", who: null, tasks: dated.filter((t) => !t.assignees.length) }].filter((l) => l.tasks.length);
  const span = (t: TaskRow) => {
    const s = t.startDate ?? t.dueDate!;
    const e = t.dueDate ?? t.startDate!;
    const d = drag?.id === t.id ? drag.delta : 0;
    return { a: daysBetween(from, s) + d, b: daysBetween(from, e) + 1 + d };
  };
  // Stack bars that overlap into rows inside a person's lane.
  const pack = (ts: TaskRow[]) => {
    const rows: number[] = [];
    return ts
      .slice()
      .sort((x, y) => span(x).a - span(y).a)
      .map((t) => {
        const { a } = span(t);
        // Bars are drawn at least about a week wide so their names show; pack by that.
        const b = Math.max(span(t).b, a + Math.ceil(days * 0.1));
        let r = rows.findIndex((end) => end <= a);
        if (r < 0) {
          r = rows.length;
          rows.push(b);
        } else rows[r] = b;
        return { t, r };
      });
  };
  const dayW = () => (lane.current?.clientWidth ?? 700) / days;
  const todayAt = daysBetween(from, c.data.today);
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => setFrom(addDays(from, -28))}>Earlier</button>
          <button type="button" className="ld-btn sm" onClick={() => setFrom(addDays(c.data.today, -wd(c.data.today) - 7))}>Today</button>
          <button type="button" className="ld-btn sm" onClick={() => setFrom(addDays(from, 28))}>Later</button>
        </span>
        <span className="ld-small ld-muted">One row per person. Drag a bar to move its dates.</span>
      </div>
      <ErrorLine error={shift.error} />
      <div className="gp-gantt tl">
        <div className="gh">
          <span>Person</span>
          <div className="wk">
            {Array.from({ length: weeks }, (_, i) => (
              <span key={i}>{fmtYmd(addDays(from, i * 7))}</span>
            ))}
          </div>
        </div>
        {lanes.map((l, li) => {
          const packed = pack(l.tasks);
          const n = Math.max(1, ...packed.map((p) => p.r + 1));
          return (
            <div key={l.key} className="grw" style={{ height: 22 + n * 30 }}>
              <span className="nm">
                {l.who ? <OwnerAvatar o={c.data.people.find((p) => p.type === l.who!.type && p.id === l.who!.id) ?? { type: "name", id: 0, name: l.who.name }} size={24} /> : <span style={{ width: 24 }} />}
                <span className="gp-ell">{l.who ? l.who.name : "Unassigned"}</span>
              </span>
              <div className="lane" ref={li === 0 ? lane : undefined} style={{ backgroundSize: `${100 / weeks}% 100%` }}>
                {todayAt >= 0 && todayAt < days && <span className="now" style={{ left: `${((todayAt + 0.5) / days) * 100}%`, height: "100%" }} />}
                {packed.map(({ t, r }) => {
                  const { a, b } = span(t);
                  const left = Math.max(0, a);
                  const right = Math.min(days, b);
                  if (right <= 0 || left >= days) return null;
                  return (
                    <span
                      key={t.id}
                      className={`bar ${t.closed ? "done" : ""}`}
                      style={{ top: 11 + r * 30, left: `${(left / days) * 100}%`, width: `${Math.max(((right - left) / days) * 100, 9)}%`, background: statusColor(c, t) }}
                      title={`${t.name}: ${fmtYmd(t.startDate ?? t.dueDate)} to ${fmtYmd(t.dueDate ?? t.startDate)}`}
                      onPointerDown={(e) => {
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                        setDrag({ id: t.id, x0: e.clientX, delta: 0 });
                      }}
                      onPointerMove={(e) => drag?.id === t.id && setDrag({ ...drag, delta: Math.round((e.clientX - drag.x0) / dayW()) })}
                      onPointerUp={() => {
                        const d = drag?.id === t.id ? drag.delta : 0;
                        setDrag(null);
                        if (!d) return c.open(t.id);
                        shift.mutate({ organizationId: c.orgId, id: t.id, startDate: t.startDate ? addDays(t.startDate, d) : null, dueDate: t.dueDate ? addDays(t.dueDate, d) : null });
                      }}
                    >
                      <span className="lb">{t.name}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!lanes.length && <div className="gp-empty">No tasks with dates yet.</div>}
      </div>
    </div>
  );
}

// ==========================================
// Workload
// ==========================================

const fmtH = (m: number) => `${Math.round(m / 6) / 10} h`.replace(".0 h", " h");

export function WorkloadView({ c }: { c: PjCtx }) {
  const [start, setStart] = React.useState(() => addDays(c.data.today, -wd(c.data.today)));
  const [show, setShow] = React.useState<"hours" | "tasks">("hours");
  const [open, setOpen] = React.useState<string | null>(null);
  const [hoursEdit, setHoursEdit] = React.useState<Record<string, string> | null>(null);
  const [dragTask, setDragTask] = React.useState<{ id: number; from: string; week: number } | null>(null);
  const q = trpc.pj.workload.useQuery({ organizationId: c.orgId, start, weeks: 6, listId: c.listId, portfolioId: c.portfolioId ?? null });
  const up = trpc.pj.update.useMutation();
  const shift = trpc.pj.shiftDates.useMutation();
  const setHours = trpc.pj.setHours.useMutation();
  const w = q.data;
  const move = async (taskId: number, fromKey: string, toKey: string, weeksBy: number) => {
    const t = c.tasks.find((x) => x.id === taskId);
    if (!t) return;
    if (fromKey !== toKey) {
      const [ft, fid] = fromKey.split(":");
      const [tt, tid] = toKey.split(":");
      const target = w?.rows.find((r) => r.type === tt && r.id === Number(tid));
      if (target) await up.mutateAsync({ organizationId: c.orgId, id: t.id, patch: { assignees: [...t.assignees.filter((a) => !(a.type === ft && a.id === Number(fid))), { type: target.type, id: target.id, name: target.name }] } });
    }
    if (weeksBy) await shift.mutateAsync({ organizationId: c.orgId, id: t.id, startDate: t.startDate ? addDays(t.startDate, weeksBy * 7) : null, dueDate: t.dueDate ? addDays(t.dueDate, weeksBy * 7) : null });
    await Promise.all([q.refetch(), c.refresh()]);
  };
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => setStart(addDays(start, -7))}>Earlier</button>
          <button type="button" className="ld-btn sm" onClick={() => setStart(addDays(c.data.today, -wd(c.data.today)))}>This week</button>
          <button type="button" className="ld-btn sm" onClick={() => setStart(addDays(start, 7))}>Later</button>
          <select className="gp-fb sel" aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as "hours" | "tasks")}>
            <option value="hours">Show: hours</option>
            <option value="tasks">Show: tasks</option>
          </select>
        </span>
        {!hoursEdit && w && (
          <button type="button" className="ld-btn sm" onClick={() => setHoursEdit(Object.fromEntries(w.rows.map((r) => [`${r.type}:${r.id}`, r.hours === null ? "" : String(r.hours)])))}>Set hours</button>
        )}
      </div>
      <ErrorLine error={q.error || up.error || shift.error || setHours.error} />
      {hoursEdit && w && (
        <div className="gp-hours">
          <div className="ld-between">
            <b>Hours each person works in a week</b>
            <span className="ld-row">
              <button type="button" className="ld-btn sm" onClick={() => setHoursEdit(null)}>Cancel</button>
              <button
                type="button"
                className="ld-btn p sm"
                onClick={async () => {
                  for (const r of w.rows) {
                    const v = hoursEdit[`${r.type}:${r.id}`];
                    const next = v === "" ? null : Number(v);
                    if (next !== r.hours) await setHours.mutateAsync({ organizationId: c.orgId, type: r.type, id: r.id, hours: next });
                  }
                  setHoursEdit(null);
                  await q.refetch();
                }}
              >
                Save
              </button>
            </span>
          </div>
          <div className="gp-hours-g">
            {w.rows.map((r) => (
              <label key={`${r.type}:${r.id}`} className="ld-row ld-small">
                <OwnerAvatar o={c.data.people.find((p) => p.type === r.type && p.id === r.id) ?? { type: "name", id: 0, name: r.name }} size={22} />
                <span className="gp-ell" style={{ flex: 1 }}>{r.name}</span>
                <input className="ld-in xs" style={{ width: 70 }} inputMode="decimal" placeholder="No limit" aria-label={`Hours for ${r.name}`} value={hoursEdit[`${r.type}:${r.id}`]} onChange={(e) => setHoursEdit({ ...hoursEdit, [`${r.type}:${r.id}`]: e.target.value.replace(/[^\d.]/g, "") })} />
              </label>
            ))}
          </div>
          <span className="ld-small ld-muted">Leave it empty for no limit (AI employees don't have one).</span>
        </div>
      )}
      {!w ? (
        <p className="ld-muted" style={{ padding: 18 }}>{q.isLoading ? "Working it out" : ""}</p>
      ) : (
        <div className="gp-wl-wrap">
          <div className="gp-wl h">
            <span>Person</span>
            {w.weeks.map((wk) => (
              <span key={wk}>Week of {fmtYmd(wk)}</span>
            ))}
          </div>
          {w.rows.filter((r) => r.type === "user" || r.cells.some((x) => x.tasks.length)).map((r) => {
            const rk = `${r.type}:${r.id}`;
            const openCell = open?.startsWith(`${rk}|`) ? Number(open.split("|")[1]) : -1;
            return (
              <React.Fragment key={rk}>
                <div className="gp-wl">
                  <span className="who">
                    <OwnerAvatar o={c.data.people.find((p) => p.type === r.type && p.id === r.id) ?? { type: "name", id: 0, name: r.name }} size={26} />
                    <span style={{ minWidth: 0 }}>
                      <b className="gp-ell" style={{ display: "block" }}>{r.name}</b>
                      <span className="ld-small ld-muted">{r.hours === null ? (r.type === "employee" ? "AI employee" : "No limit") : `${r.hours} h a week`}</span>
                    </span>
                  </span>
                  {r.cells.map((cell, i) => {
                    const h = cell.minutes / 60;
                    const cls = !cell.tasks.length ? "none" : r.hours === null ? "" : h > r.hours ? "over" : h >= r.hours * 0.9 ? "near" : "";
                    return (
                      <button
                        key={cell.week}
                        type="button"
                        className={`cell ${openCell === i ? "on" : ""} ${dragTask ? "drop" : ""}`}
                        aria-expanded={openCell === i}
                        onClick={() => setOpen(openCell === i ? null : `${rk}|${i}`)}
                        onDragOver={(e) => dragTask && e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragTask) void move(dragTask.id, dragTask.from, rk, i - dragTask.week);
                          setDragTask(null);
                        }}
                      >
                        <span className={`gp-cap ${cls}`}>{show === "hours" ? (r.hours === null ? fmtH(cell.minutes) : `${Math.round(h)} h of ${r.hours}`) : `${cell.tasks.length} task${cell.tasks.length === 1 ? "" : "s"}`}</span>
                        <span className="ld-small ld-muted">{cell.tasks.length ? (show === "hours" ? `${cell.tasks.length} task${cell.tasks.length === 1 ? "" : "s"}` : fmtH(cell.minutes)) : "Free"}</span>
                      </button>
                    );
                  })}
                </div>
                {openCell >= 0 && (
                  <div className="gp-wl-open">
                    <span className="ld-small ld-muted">Week of {fmtYmd(r.cells[openCell].week)}. Drag a task to another week or person to move it.</span>
                    <div className="ld-row" style={{ flexWrap: "wrap" }}>
                      {r.cells[openCell].tasks.map((t) => (
                        <button key={t.id} type="button" className="gp-wl-task" draggable onDragStart={() => setDragTask({ id: t.id, from: rk, week: openCell })} onDragEnd={() => setDragTask(null)} onClick={() => c.open(t.id)}>
                          <b className="gp-ell">{t.name}</b>
                          <span className="ld-small ld-muted">{t.listName} · {fmtH(t.minutes)}{t.dueDate ? ` · due ${fmtYmd(t.dueDate)}` : ""}</span>
                        </button>
                      ))}
                      {!r.cells[openCell].tasks.length && <span className="ld-small ld-muted">Nothing this week.</span>}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      )}
      <div className="ld-small ld-muted" style={{ padding: "10px 18px" }}>Hours come from each task's time estimate, spread across its working days. Red is over the person's hours for the week. Open a week and drag a task to another week or person.</div>
    </div>
  );
}

// ==========================================
// Mind map
// ==========================================

export function MindMapView({ c }: { c: PjCtx }) {
  const up = trpc.pj.update.useMutation({ onSuccess: () => c.refresh() });
  const create = trpc.pj.create.useMutation({ onSuccess: () => c.refresh() });
  const [adding, setAdding] = React.useState<number | "root" | null>(null);
  const [name, setName] = React.useState("");
  const [drag, setDrag] = React.useState<number | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const box = React.useRef<HTMLDivElement>(null);
  const tasks = c.tasks.filter((t) => !t.parentId);
  const subsOf = (id: number) => c.data.subtasks.filter((s) => s.parentId === id);
  const ROW = 50;
  // Lay out: each task takes as many rows as its subtasks (at least one).
  let y = 40;
  const placed = tasks.map((t) => {
    const subs = subsOf(t.id);
    const rows = Math.max(1, subs.length + (adding === t.id ? 1 : 0));
    const top = y;
    y += rows * ROW + 14;
    return { t, subs, y: top + ((rows - 1) * ROW) / 2, subY: subs.map((_, i) => top + i * ROW) };
  });
  const addY = y;
  const height = Math.max(420, addY + 80);
  const rootY = placed.length ? (placed[0].y + placed[placed.length - 1].y) / 2 : 120;
  const X0 = 40;
  const X1 = 340;
  const X2 = 700;
  const listName = c.data.list?.name ?? "Tasks";
  const fit = () => {
    const w = box.current?.clientWidth ?? 1000;
    setZoom(Math.min(1, Math.max(0.4, Math.min(w / 1000, 640 / height))));
  };
  const submit = () => {
    if (!name.trim() || !c.listId) return;
    create.mutate({ organizationId: c.orgId, listId: c.listId, name, parentId: adding === "root" ? null : (adding as number) });
    setName("");
    setAdding(null);
  };
  if (!c.listId) return <div className="gp-gl"><div className="gp-empty">Open a list to see it as a mind map.</div></div>;
  return (
    <div className="gp-gl">
      <div className="gp-sec">
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={fit}>Fit</button>
          <button type="button" className="ld-btn sm" onClick={() => setZoom(1)}>Full size</button>
        </span>
        <span className="ld-small ld-muted">Drag a task onto another to make it a subtask. Drop it on the list to make it a task again.</span>
      </div>
      <ErrorLine error={up.error || create.error} />
      <div className="gp-mm" ref={box} style={{ height: Math.min(720, height * zoom + 20) }}>
        <div style={{ transform: `scale(${zoom})`, transformOrigin: "0 0", width: 1100, height, position: "relative" }}>
          <svg width={1100} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
            <g stroke="var(--ld-soft)" strokeWidth="1.5" fill="none">
              {placed.map((p) => (
                <path key={p.t.id} d={`M${X0 + 200} ${rootY + 18} C ${X0 + 260} ${rootY + 18}, ${X1 - 60} ${p.y + 18}, ${X1} ${p.y + 18}`} />
              ))}
              {placed.flatMap((p) => p.subY.map((sy, i) => <path key={`${p.t.id}-${i}`} d={`M${X1 + 260} ${p.y + 18} C ${X1 + 320} ${p.y + 18}, ${X2 - 60} ${sy + 18}, ${X2} ${sy + 18}`} />))}
            </g>
          </svg>
          <span
            className={`gp-node root ${drag ? "drop" : ""}`}
            style={{ left: X0, top: rootY }}
            onDragOver={(e) => drag && e.preventDefault()}
            onDrop={() => {
              const t = c.data.subtasks.find((s) => s.id === drag);
              if (t) up.mutate({ organizationId: c.orgId, id: t.id, patch: { parentId: null } });
              setDrag(null);
            }}
          >
            {listName}
          </span>
          {placed.map((p) => (
            <React.Fragment key={p.t.id}>
              <span
                className={`gp-node ${p.t.closed ? "done" : ""}`}
                style={{ left: X1, top: p.y }}
                draggable={!p.subs.length}
                onDragStart={() => setDrag(p.t.id)}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => drag && drag !== p.t.id && e.preventDefault()}
                onDrop={() => {
                  if (drag && drag !== p.t.id) up.mutate({ organizationId: c.orgId, id: drag, patch: { parentId: p.t.id } });
                  setDrag(null);
                }}
              >
                <span className={`gp-mmck ${p.t.closed ? "on" : ""}`} aria-hidden="true" />
                <button type="button" className="gp-node-nm" onClick={() => c.open(p.t.id)}>{p.t.name}</button>
                <button type="button" className="gp-node-add" aria-label={`Add a subtask to ${p.t.name}`} onClick={() => { setAdding(p.t.id); setName(""); }}>+</button>
              </span>
              {p.subs.map((s, i) => (
                <span key={s.id} className={`gp-node sub ${s.closed ? "done" : ""}`} style={{ left: X2, top: p.subY[i] }} draggable onDragStart={() => setDrag(s.id)} onDragEnd={() => setDrag(null)}>
                  <button type="button" className="gp-node-nm" onClick={() => c.open(s.id)}>{s.name}{s.closed ? " ✓" : ""}</button>
                </span>
              ))}
              {adding === p.t.id && (
                <span className="gp-node add" style={{ left: X2, top: p.subY.length ? p.subY[p.subY.length - 1] + ROW : p.y }}>
                  <input className="ld-in xs" autoFocus aria-label="New subtask" placeholder="New subtask, then Enter" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setAdding(null); }} onBlur={() => !name.trim() && setAdding(null)} />
                </span>
              )}
            </React.Fragment>
          ))}
          {adding === "root" ? (
            <span className="gp-node add" style={{ left: X1, top: addY }}>
              <input className="ld-in xs" autoFocus aria-label="New task" placeholder="New task, then Enter" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") setAdding(null); }} onBlur={() => !name.trim() && setAdding(null)} />
            </span>
          ) : (
            <button type="button" className="gp-node add" style={{ left: X1, top: addY }} onClick={() => { setAdding("root"); setName(""); }}>+ Add a task</button>
          )}
        </div>
      </div>
    </div>
  );
}
