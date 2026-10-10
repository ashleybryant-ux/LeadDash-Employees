import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { addDays, fmtYmd, OwnerAvatar } from "../goals/shared";
import { statusColor } from "./bits";
import { Pop } from "./Quick";
import { useExport } from "./Customize";
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

/** The longest chain of waiting-on links, ending at the latest-due linked task: if any of these slip, the end slips. */
export function criticalPath(tasks: TaskRow[], links: { from: number; to: number }[]) {
  const by = new Map(tasks.map((t) => [t.id, t]));
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const ends = tasks.filter((t) => linked.has(t.id) && !links.some((l) => l.from === t.id) && t.dueDate).sort((a, b) => (b.dueDate ?? "").localeCompare(a.dueDate ?? ""));
  const out = new Set<number>();
  let cur = ends[0];
  for (let i = 0; cur && i < 200; i++) {
    out.add(cur.id);
    const before = links.filter((l) => l.to === cur!.id).map((l) => by.get(l.from)).filter((t): t is TaskRow => !!t && !out.has(t.id));
    cur = before.sort((a, b) => (b.dueDate ?? b.startDate ?? "").localeCompare(a.dueDate ?? a.startDate ?? ""))[0];
  }
  return out.size > 1 ? out : new Set<number>();
}

type GRow = { key: string; kind: "folder" | "list" | "task"; name: string; color?: string; depth: number; t?: TaskRow; start: string | null; end: string | null; done?: number; total?: number; open?: boolean; parent?: string };
type Scale = "day" | "week" | "month";
const SCALE_DAYS: Record<Scale, number> = { day: 21, week: 63, month: 183 };
const SHORT_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const monthShort = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

/**
 * Gantt, the way ClickUp's works: Today, a Day / Week / Month scale, Auto fit
 * (the whole plan on one screen) and Export, with the rows as a tree of
 * folder, project and task that folds up, a due date column, and summary bars
 * for each folder and project. Drag a bar to move its dates; drag its end to
 * change how long it runs. Arrows show what waits on what.
 */
export function GanttView({ c }: { c: PjCtx }) {
  const [scale, setScale] = React.useState<Scale>("week");
  const [fit, setFit] = React.useState<{ from: string; days: number } | null>(null);
  const [from, setFrom] = React.useState(() => addDays(c.data.today, -wd(c.data.today) - 7));
  const [crit, setCrit] = React.useState(true);
  const [shut, setShut] = React.useState<Set<string>>(new Set());
  const [exporting, setExporting] = React.useState(false);
  const exporter = useExport(c.orgId);
  const days = fit ? fit.days : SCALE_DAYS[scale];
  const start = fit ? fit.from : from;
  const lane = React.useRef<HTMLDivElement>(null);
  const rowH = 42;
  const shift = trpc.pj.shiftDates.useMutation({ onSuccess: () => c.refresh() });
  const [drag, setDrag] = React.useState<{ id: number; mode: "move" | "end"; x0: number; delta: number } | null>(null);
  const dated = c.tasks.filter((t) => t.dueDate || t.startDate).sort((a, b) => (a.startDate ?? a.dueDate ?? "").localeCompare(b.startDate ?? b.dueDate ?? ""));
  const none = c.tasks.filter((t) => !t.dueDate && !t.startDate);
  // The tree: folders hold projects, projects hold tasks. In one list only its tasks show under the list.
  const lists = [...c.data.lists].sort((a, b) => (a.folderId ?? 1e9) - (b.folderId ?? 1e9) || a.sort - b.sort || a.id - b.id);
  const rows: GRow[] = [];
  const summary = (ts: TaskRow[]) => {
    const starts = ts.map((t) => t.startDate ?? t.dueDate).filter(Boolean) as string[];
    const ends = ts.map((t) => t.dueDate ?? t.startDate).filter(Boolean) as string[];
    return { start: starts.length ? starts.sort()[0] : null, end: ends.length ? ends.sort().at(-1)! : null, done: ts.filter((t) => t.closed).length, total: ts.length };
  };
  const pushList = (l: (typeof lists)[number], depth: number, parent?: string) => {
    const ts = dated.filter((t) => t.listId === l.id);
    if (!ts.length && c.listId !== l.id) return;
    const key = `l${l.id}`;
    rows.push({ key, kind: "list", name: l.name, color: l.folderColor ?? "#1b6b4a", depth, ...summary(ts), open: !shut.has(key), parent });
    if (!shut.has(key)) for (const t of ts) rows.push({ key: `t${t.id}`, kind: "task", name: t.name, depth: depth + 1, t, start: t.startDate ?? t.dueDate, end: t.dueDate ?? t.startDate, parent: key });
  };
  if (c.listId) {
    const l = lists.find((x) => x.id === c.listId);
    if (l) pushList(l, 0);
  } else {
    const folders = Array.from(new Map(lists.filter((l) => l.folderId).map((l) => [l.folderId!, { id: l.folderId!, name: l.folderName ?? "", color: l.folderColor ?? "#1b6b4a" }])).values());
    for (const f of folders) {
      const inF = lists.filter((l) => l.folderId === f.id);
      const ts = dated.filter((t) => inF.some((l) => l.id === t.listId));
      if (!ts.length) continue;
      const key = `f${f.id}`;
      rows.push({ key, kind: "folder", name: f.name, color: f.color, depth: 0, ...summary(ts), open: !shut.has(key) });
      if (!shut.has(key)) for (const l of inF) pushList(l, 1, key);
    }
    for (const l of lists.filter((l) => !l.folderId)) pushList(l, 0);
  }
  const taskRows = rows.filter((r) => r.kind === "task").map((r) => r.t!);
  const links = c.data.links.filter((l) => taskRows.some((r) => r.id === l.from) && taskRows.some((r) => r.id === l.to));
  const critical = crit ? criticalPath(taskRows, links) : new Set<number>();
  const dayW = () => (lane.current?.clientWidth ?? 700) / days;
  const spanOf = (s: string | null, e: string | null, id?: number) => {
    if (!s || !e) return null;
    let a = daysBetween(start, s);
    let b = daysBetween(start, e) + 1;
    if (id !== undefined && drag?.id === id) {
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
  const todayAt = daysBetween(start, c.data.today);
  const H = rows.length * rowH;
  const toggleShut = (k: string) => setShut((x) => { const n = new Set(x); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const goToday = () => { setFit(null); setFrom(scale === "day" ? addDays(c.data.today, -3) : scale === "week" ? addDays(c.data.today, -wd(c.data.today) - 7) : addDays(`${c.data.today.slice(0, 7)}-01`, -31)); };
  const pickScale = (sc: Scale) => { setScale(sc); setFit(null); setFrom(sc === "day" ? addDays(c.data.today, -3) : sc === "week" ? addDays(c.data.today, -wd(c.data.today) - 7) : addDays(`${c.data.today.slice(0, 7)}-01`, -31)); };
  const autoFit = () => {
    const starts = dated.map((t) => t.startDate ?? t.dueDate!).sort();
    const ends = dated.map((t) => t.dueDate ?? t.startDate!).sort();
    if (!starts.length) return;
    const a = addDays(starts[0], -2);
    const n = Math.max(7, daysBetween(a, ends.at(-1)!) + 4);
    setFit({ from: a, days: n });
    setScale(n <= 28 ? "day" : n <= 120 ? "week" : "month");
  };
  // Header cells: each day, each week, or each month in view.
  const cols: { label: string; at: number; w: number; today?: boolean }[] = [];
  if (scale === "day") for (let i = 0; i < days; i++) { const d = addDays(start, i); cols.push({ label: `${SHORT_DAYS[wd(d)]} ${Number(d.slice(8))}`, at: i, w: 1, today: d === c.data.today }); }
  else if (scale === "week") for (let i = 0; i < days; i += 7) { const d = addDays(start, i); cols.push({ label: `${monthShort(d)} ${Number(d.slice(8))}`, at: i, w: Math.min(7, days - i) }); }
  else {
    let i = 0;
    while (i < days) {
      const d = addDays(start, i);
      const next = addDays(`${d.slice(0, 7)}-01`, 32);
      const monthEnd = daysBetween(start, `${next.slice(0, 7)}-01`);
      cols.push({ label: `${monthShort(d)} ${d.slice(0, 4)}`, at: i, w: Math.min(days, monthEnd) - i });
      i = monthEnd;
    }
  }
  const exportCsv = (format: "csv" | "xlsx") => {
    const name = c.data.list?.name ?? c.data.folder?.name ?? "Everything";
    exporter.run(`${name} Gantt`, format, ["Folder or project", "Task", "Start", "Due", "Status", "Assignees"], rows.map((r) => (r.kind === "task" ? [rows.find((x) => x.key === r.parent)?.name ?? "", r.name, r.start ?? "", r.end ?? "", r.t!.status, r.t!.assignees.map((a) => a.name).join(", ")] : [r.name, "", r.start ?? "", r.end ?? "", `${r.done ?? 0} of ${r.total ?? 0} done`, ""])));
  };
  return (
    <div className="gp-gl gp-ganttwrap">
      <div className="gp-sec">
        <span className="ld-row" style={{ flexWrap: "wrap" }}>
          <button type="button" className="ld-btn sm gp-auto" onClick={goToday}>Today</button>
          <select className="gp-fb" aria-label="Scale" value={scale} onChange={(e) => pickScale(e.target.value as Scale)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
          <button type="button" className={`ld-btn sm gp-auto ${fit ? "on" : ""}`} aria-pressed={!!fit} disabled={!dated.length} onClick={() => (fit ? goToday() : autoFit())}>Auto fit</button>
          <button type="button" className="ld-btn sm gp-auto" disabled={fit !== null} onClick={() => setFrom(addDays(from, -Math.round(days / 2)))} aria-label="Earlier">‹</button>
          <button type="button" className="ld-btn sm gp-auto" disabled={fit !== null} onClick={() => setFrom(addDays(from, Math.round(days / 2)))} aria-label="Later">›</button>
          <span className="gp-qcell">
            <button type="button" className="ld-btn sm gp-auto" aria-expanded={exporting} disabled={exporter.busy} onClick={() => setExporting((v) => !v)}>Export ▾</button>
            {exporting && (
              <Pop onClose={() => setExporting(false)} width={220}>
                <button type="button" className="gp-qi" onClick={() => { setExporting(false); window.print(); }}>Print or save as PDF</button>
                <button type="button" className="gp-qi" onClick={() => { setExporting(false); exportCsv("csv"); }}>CSV</button>
                <button type="button" className="gp-qi" onClick={() => { setExporting(false); exportCsv("xlsx"); }}>Excel (.xlsx)</button>
              </Pop>
            )}
          </span>
          {links.length > 0 && (
            <button type="button" className={`gp-fb ${crit ? "sel" : ""}`} aria-pressed={crit} onClick={() => setCrit(!crit)}>
              Critical path: {crit ? "on" : "off"}
            </button>
          )}
        </span>
        <span className="ld-small ld-muted">{links.length ? "Arrows show what waits on what. Moving a task moves the ones waiting on it." : "Drag a bar to move its dates; drag its end to change how long it runs."}</span>
      </div>
      <ErrorLine error={shift.error || exporter.error} />
      <div className="gp-gantt tree">
        <div className="gh">
          <span className="gp-gnh"><span>Name</span><span>Due date</span></span>
          <div className={`wk ${scale}`} style={{ gridTemplateColumns: cols.map((x) => `${x.w}fr`).join(" ") }}>
            {cols.map((x) => (
              <span key={x.at} className={x.today ? "today" : ""}>{x.label}</span>
            ))}
          </div>
        </div>
        <div style={{ position: "relative" }}>
          {rows.map((r, i) => {
            const sp = spanOf(r.start, r.end, r.t?.id);
            const left = sp ? Math.max(0, sp.a) : 0;
            const right = sp ? Math.min(days, sp.b) : 0;
            const show = !!sp && right > 0 && left < days;
            const a0 = r.t?.assignees[0];
            return (
              <div key={r.key} className={`grw ${r.kind}`}>
                <div className="nmc" style={{ paddingLeft: 10 + r.depth * 18 }}>
                  {r.kind !== "task" ? (
                    <button type="button" className="gp-car" aria-expanded={r.open} aria-label={r.open ? `Hide ${r.name}` : `Show ${r.name}`} onClick={() => toggleShut(r.key)}>{r.open ? "▾" : "▸"}</button>
                  ) : (
                    <span style={{ width: 18 }} />
                  )}
                  {r.kind === "folder" && <span className="gp-fi" style={{ background: r.color }} />}
                  {r.kind === "list" && <span className="ld-muted" aria-hidden="true">☰</span>}
                  {r.kind === "task" && (a0 ? <OwnerAvatar o={c.data.people.find((p) => p.type === a0.type && p.id === a0.id) ?? { type: "name", id: 0, name: a0.name }} size={20} /> : <span className="gp-noone" aria-hidden="true">○</span>)}
                  {r.kind === "task" ? (
                    <button type="button" className="nm" onClick={() => c.open(r.t!.id)}><span className="gp-ell">{r.name}</span></button>
                  ) : (
                    <b className="gp-ell">{r.name}</b>
                  )}
                  <span className="due ld-small ld-muted">{r.end ? fmtYmd(r.end) : ""}</span>
                </div>
                <div className="lane" ref={i === 0 ? lane : undefined} style={{ backgroundSize: `${(100 / days) * (scale === "day" ? 1 : scale === "week" ? 7 : 30)}% 100%` }}>
                  {i === 0 && todayAt >= 0 && todayAt < days && <span className="now" style={{ left: `${((todayAt + 0.5) / days) * 100}%`, height: `${H}px` }} />}
                  {show && r.kind !== "task" && (
                    <span className={`bar sum ${r.kind}`} style={{ left: `${(left / days) * 100}%`, width: `${Math.max(1.4, ((right - left) / days) * 100)}%`, background: r.color }} title={`${fmtYmd(r.start)} to ${fmtYmd(r.end)}`}>
                      <span className="lb">{right - left > 4 ? `${r.name} · ${r.done} of ${r.total}` : ""}</span>
                    </span>
                  )}
                  {show && r.kind === "task" && (
                    <span
                      className={`bar ${r.t!.closed ? "done" : ""} ${critical.has(r.t!.id) ? "crit" : ""}`}
                      style={{ left: `${(left / days) * 100}%`, width: `${Math.max(1.4, ((right - left) / days) * 100)}%`, background: statusColor(c, r.t!) }}
                      onPointerDown={(e) => {
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                        setDrag({ id: r.t!.id, mode: (e.target as HTMLElement).classList.contains("end") ? "end" : "move", x0: e.clientX, delta: 0 });
                      }}
                      onPointerMove={(e) => drag?.id === r.t!.id && setDrag({ ...drag, delta: Math.round((e.clientX - drag.x0) / dayW()) })}
                      onPointerUp={() => done(r.t!)}
                      title={`${fmtYmd(r.start)} to ${fmtYmd(r.end)}`}
                    >
                      <span className="lb">{right - left > 4 ? r.name : ""}</span>
                      <span className="end" aria-hidden="true" />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {links.length > 0 && rows.length > 0 && (
            <svg className="gp-arrows" viewBox={`0 0 ${days * 10} ${H}`} preserveAspectRatio="none" style={{ height: H }} aria-hidden="true">
              {links.map((l) => {
                const fi = rows.findIndex((r) => r.t?.id === l.from);
                const ti = rows.findIndex((r) => r.t?.id === l.to);
                if (fi < 0 || ti < 0) return null;
                const fs = spanOf(rows[fi].start, rows[fi].end, l.from)!;
                const ts = spanOf(rows[ti].start, rows[ti].end, l.to)!;
                const x1 = Math.min(days, Math.max(0, fs.b)) * 10;
                const x2 = Math.min(days, Math.max(0, ts.a)) * 10;
                const y1 = fi * rowH + rowH / 2;
                const y2 = ti * rowH + rowH / 2;
                const mid = Math.max(x1 + 6, Math.min(x2 - 6, x1 + 12));
                const red = critical.has(l.from) && critical.has(l.to);
                return (
                  <g key={`${l.from}-${l.to}`} stroke={red ? "#c2253c" : "#5b6b64"} fill="none">
                    <path d={`M${x1} ${y1} H${mid} V${y2} H${x2 - 1}`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                    <path d={`M${x2 - 8} ${y2 - 4} L${x2} ${y2} L${x2 - 8} ${y2 + 4}`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        {!rows.length && <div className="gp-empty">No tasks with dates yet. Give a task a start or due date and it shows here.</div>}
      </div>
      {critical.size > 0 && <div className="ld-small ld-muted" style={{ padding: "10px 18px 0" }}>Outlined in red: the critical path. If any of these slip, {taskRows.find((r) => critical.has(r.id) && !c.data.links.some((l) => l.from === r.id))?.name ?? "the last one"} slips too.</div>}
      {none.length > 0 && <div className="ld-small ld-muted" style={{ padding: "10px 18px" }}>{none.length} task{none.length === 1 ? "" : "s"} without dates aren't shown.</div>}
    </div>
  );
}
