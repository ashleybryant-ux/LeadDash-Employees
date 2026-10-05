import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Bar, fmtYmd, Menu, money, short, Spark, STATUS_COLOR, StatusPill, valueText, type Status } from "./shared";
import type { GoalsCtx, Overview } from "../pages/Goals";

/**
 * Dashboard (like ClickUp dashboards): cards you add, move, resize and point
 * at a goal or measures. The layout is the workspace's own.
 */

type Card = Overview["layout"][number];
type CardType = Card["type"];
const TYPES: { type: CardType; label: string; span: Card["span"] }[] = [
  { type: "revenue", label: "Goal number", span: 3 },
  { type: "measure", label: "One measure", span: 3 },
  { type: "goals", label: "Goals by status", span: 3 },
  { type: "scorecard", label: "Scorecard this week", span: 3 },
  { type: "chart", label: "Goal against pace", span: 8 },
  { type: "read", label: "Simone's read", span: 4 },
  { type: "donut", label: "Measures side by side", span: 4 },
  { type: "bars", label: "Weekly bars", span: 4 },
  { type: "funnel", label: "Funnel", span: 4 },
];
const SIZES: { span: Card["span"]; label: string }[] = [
  { span: 3, label: "Small" },
  { span: 4, label: "Medium" },
  { span: 6, label: "Half" },
  { span: 8, label: "Large" },
  { span: 12, label: "Full width" },
];
const PALETTE = ["#2563eb", "#7c3aed", "#1b6b4a", "#d97706", "#c2253c", "#0f766e"];

export function DashboardView({ c }: { c: GoalsCtx }) {
  const [cards, setCards] = React.useState<Card[]>(c.data.layout);
  const [drag, setDrag] = React.useState<string | null>(null);
  const save = trpc.goals.saveLayout.useMutation();
  React.useEffect(() => setCards(c.data.layout), [c.data.layout]);
  const commit = (next: Card[]) => {
    setCards(next);
    save.mutate({ organizationId: c.orgId, cards: next.map((x) => ({ ...x, goalId: x.goalId ?? null, measureIds: x.measureIds ?? [] })) });
  };
  const add = (t: (typeof TYPES)[number]) => commit([...cards, { id: `c${Date.now().toString(36)}`, type: t.type, span: t.span, measureIds: [] }]);
  return (
    <div>
      <div className="gp-dash-tool">
        <span className="ld-small ld-muted">Drag a card by its title to move it. Use ··· to resize it, point it at a goal or measures, or remove it.</span>
        <Menu label="Add card" button="+ Add card">
          {(close) =>
            TYPES.map((t) => (
              <button key={t.type} type="button" role="menuitem" onClick={() => { add(t); close(); }}>
                {t.label}
              </button>
            ))
          }
        </Menu>
      </div>
      <div className="gp-dash">
        {cards.map((card) => (
          <div
            key={card.id}
            className={`gp-wd ${drag === card.id ? "dragging" : ""}`}
            style={{ gridColumn: `span ${card.span}` }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (!drag || drag === card.id) return;
              const from = cards.findIndex((x) => x.id === drag);
              const to = cards.findIndex((x) => x.id === card.id);
              const next = [...cards];
              const [m] = next.splice(from, 1);
              next.splice(to, 0, m);
              setDrag(null);
              commit(next);
            }}
          >
            <h5 draggable onDragStart={() => setDrag(card.id)} onDragEnd={() => setDrag(null)}>
              <span>{titleOf(c, card)}</span>
              <CardMenu c={c} card={card} onChange={(nc) => commit(cards.map((x) => (x.id === card.id ? nc : x)))} onRemove={() => commit(cards.filter((x) => x.id !== card.id))} />
            </h5>
            <CardBody c={c} card={card} />
          </div>
        ))}
        <button type="button" className="gp-addc" style={{ gridColumn: "span 12" }} onClick={() => add(TYPES[1])}>+ Add card</button>
      </div>
      <ErrorLine error={save.error} />
    </div>
  );
}

function goalFor(c: GoalsCtx, card: Card) {
  const all = c.data.goals.filter((g) => g.goal.state === "active");
  return all.find((g) => g.goal.id === card.goalId) ?? all.find((g) => (g.goal.level === "year" || g.goal.level === "company") && g.forecast?.kind === "currency") ?? all.find((g) => g.forecast) ?? all[0] ?? null;
}
function measuresFor(c: GoalsCtx, card: Card, fallback: number) {
  const rows = c.data.scorecard.rows;
  const picked = (card.measureIds ?? []).map((id) => rows.find((r) => r.measure.id === id)).filter((r): r is (typeof rows)[number] => !!r);
  return picked.length ? picked : rows.slice(0, fallback);
}
function titleOf(c: GoalsCtx, card: Card) {
  if (card.title) return card.title;
  if (card.type === "revenue" || card.type === "chart") {
    const g = goalFor(c, card);
    return card.type === "chart" ? `${g?.goal.title ?? "A goal"} against pace` : g?.goal.title ?? "Goal number";
  }
  if (card.type === "measure" || card.type === "bars") return `${measuresFor(c, card, 1)[0]?.measure.name ?? "A measure"}${card.type === "bars" ? " by week" : ""}`;
  return TYPES.find((t) => t.type === card.type)?.label ?? "";
}

function CardMenu({ c, card, onChange, onRemove }: { c: GoalsCtx; card: Card; onChange: (c: Card) => void; onRemove: () => void }) {
  const usesGoal = card.type === "revenue" || card.type === "chart";
  const usesOne = card.type === "measure" || card.type === "bars";
  const usesMany = card.type === "donut" || card.type === "funnel";
  return (
    <Menu label={`Card options for ${titleOf(c, card)}`}>
      {(close) => (
        <>
          <span className="gp-menu-h">Size</span>
          {SIZES.map((s) => (
            <button key={s.span} type="button" role="menuitemradio" aria-checked={card.span === s.span} onClick={() => { onChange({ ...card, span: s.span }); close(); }}>
              {card.span === s.span ? "✓ " : ""}
              {s.label}
            </button>
          ))}
          {usesGoal && (
            <>
              <span className="gp-menu-h">Goal</span>
              <select className="ld-in xs" aria-label="Goal" value={goalFor(c, card)?.goal.id ?? ""} onChange={(e) => onChange({ ...card, goalId: Number(e.target.value) })}>
                {c.data.goals.filter((g) => g.goal.state === "active").map((g) => (
                  <option key={g.goal.id} value={g.goal.id}>{g.goal.title}</option>
                ))}
              </select>
            </>
          )}
          {usesOne && (
            <>
              <span className="gp-menu-h">Measure</span>
              <select className="ld-in xs" aria-label="Measure" value={measuresFor(c, card, 1)[0]?.measure.id ?? ""} onChange={(e) => onChange({ ...card, measureIds: [Number(e.target.value)] })}>
                {c.data.scorecard.rows.map((r) => (
                  <option key={r.measure.id} value={r.measure.id}>{r.measure.name}</option>
                ))}
              </select>
            </>
          )}
          {usesMany && (
            <>
              <span className="gp-menu-h">{card.type === "funnel" ? "Steps, in order" : "Measures"}</span>
              {c.data.scorecard.rows.map((r) => {
                const on = (card.measureIds ?? []).includes(r.measure.id);
                return (
                  <label key={r.measure.id} className="gp-menu-ck">
                    <input type="checkbox" checked={on} onChange={() => onChange({ ...card, measureIds: on ? (card.measureIds ?? []).filter((x) => x !== r.measure.id) : [...(card.measureIds ?? []), r.measure.id].slice(0, 8) })} />
                    {r.measure.name}
                  </label>
                );
              })}
            </>
          )}
          <button type="button" role="menuitem" className="danger" onClick={() => { onRemove(); close(); }}>Remove card</button>
        </>
      )}
    </Menu>
  );
}

function CardBody({ c, card }: { c: GoalsCtx; card: Card }) {
  const today = c.data.today;
  switch (card.type) {
    case "revenue": {
      const g = goalFor(c, card);
      if (!g) return <Empty text="Add a goal to show it here." />;
      const f = g.forecast;
      const t = g.targets[0];
      const big = f ? (f.kind === "currency" ? money(f.current) : f.current.toLocaleString("en-US")) : `${g.progress}%`;
      return (
        <>
          <div className="gp-big">{big}</div>
          <span className="ld-small ld-muted">{f ? `of ${f.kind === "currency" ? money(f.target) : f.target.toLocaleString("en-US")} · on pace for ${f.kind === "currency" ? money(f.landing) : f.landing.toLocaleString("en-US")}` : t ? t.name : g.goal.period}</span>
          <Bar p={g.progress} red={g.status === "off"} color={g.goal.color} />
        </>
      );
    }
    case "measure": {
      const r = measuresFor(c, card, 1)[0];
      if (!r) return <Empty text="Add a measure to the scorecard to show it here." />;
      const prev = r.values[r.values.length - 2];
      const diff = r.value !== null && prev !== null && prev !== undefined ? r.value - prev : null;
      return (
        <>
          <div className="gp-big">{valueText(r.value, r.measure.unit) || "No number yet"}</div>
          <span className="ld-small ld-muted">{diff !== null ? `${diff >= 0 ? "+" : "-"}${valueText(Math.abs(diff), r.measure.unit)} from last week` : r.measure.weeklyGoal !== null ? `Weekly goal ${valueText(r.measure.weeklyGoal, r.measure.unit)}` : ""}</span>
          <Spark values={r.values.slice(-8)} goal={r.measure.weeklyGoal} w={220} h={34} color={STATUS_COLOR[r.status ?? "on"]} />
        </>
      );
    }
    case "goals": {
      const list = c.data.goals.filter((g) => g.goal.state === "active" && g.goal.level !== "year" && g.goal.level !== "company" && g.goal.startDate <= today && g.goal.dueDate >= today);
      return <Counts list={list.map((g) => g.status)} sub={`${list.length} goal${list.length === 1 ? "" : "s"} running now`} />;
    }
    case "scorecard":
      return <Counts list={c.data.scorecard.rows.map((r) => r.status)} sub={`Week of ${fmtYmd(c.data.scorecard.thisWeek)}`} />;
    case "chart": {
      const g = goalFor(c, card);
      if (!g?.forecast) return <Empty text="Pick a goal with a number or money target." />;
      return <PaceChart f={g.forecast} />;
    }
    case "read":
      return <Read c={c} />;
    case "donut": {
      const rows = measuresFor(c, card, 0);
      if (!rows.length) return <Empty text="Pick the measures to compare with ··· above (like new practices from each source)." />;
      return <Donut rows={rows.map((r, i) => ({ name: r.measure.name, v: r.value ?? 0, color: PALETTE[i % PALETTE.length] }))} />;
    }
    case "bars": {
      const r = measuresFor(c, card, 1)[0];
      if (!r) return <Empty text="Add a measure to the scorecard to show it here." />;
      return <WeekBars c={c} r={r} />;
    }
    case "funnel": {
      const rows = measuresFor(c, card, 0);
      if (rows.length < 2) return <Empty text="Pick two or more steps, in order, with ··· above (like leads, demos booked, demos held, paying practices)." />;
      return <Funnel rows={rows.map((r) => ({ name: r.measure.name, v: r.value ?? 0 }))} />;
    }
  }
}

function Empty({ text }: { text: string }) {
  return <span className="ld-small ld-muted">{text}</span>;
}

function Counts({ list, sub }: { list: (Status | null | string)[]; sub: string }) {
  const n = (s: string) => list.filter((x) => x === s).length;
  return (
    <>
      <div className="gp-cnts">
        <span><StatusPill s="on" /><b>{n("on") + n("done")}</b></span>
        <span><StatusPill s="risk" /><b>{n("risk")}</b></span>
        <span><StatusPill s="off" /><b>{n("off")}</b></span>
      </div>
      <span className="ld-small ld-muted">{sub}</span>
    </>
  );
}

type F = NonNullable<Overview["goals"][number]["forecast"]>;
/** Actual against the straight pace to the goal, with where it lands at this pace. */
export function PaceChart({ f }: { f: F }) {
  const w = 760;
  const h = 300;
  const L = 56;
  const R = 16;
  const T = 18;
  const B = 30;
  const t0 = Date.parse(`${f.start}T12:00:00Z`);
  const t1 = Date.parse(`${f.end}T12:00:00Z`);
  const span = Math.max(1, t1 - t0);
  const mx = Math.max(f.target, f.landing, ...f.history.map((p) => p.v)) * 1.08 || 1;
  const mn = Math.min(0, f.startValue);
  const X = (d: string) => L + ((Date.parse(`${d}T12:00:00Z`) - t0) / span) * (w - L - R);
  const Y = (v: number) => T + (h - T - B) - ((v - mn) / (mx - mn)) * (h - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => mn + (mx - mn) * k);
  const months: { d: string; label: string }[] = [];
  for (let d = new Date(t0); d.getTime() <= t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12))) months.push({ d: d.toISOString().slice(0, 10), label: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) });
  const fmt = (v: number) => short(v, f.kind);
  const actual = f.history.filter((p) => p.d <= f.today).map((p) => `${X(p.d).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
  const off = f.landing < f.target;
  return (
    <div>
      <div className="gp-leg">
        <span><i style={{ background: "#1b6b4a" }} />Actual</span>
        <span><i style={{ background: "#9aa8a2" }} />Goal pace</span>
        <span><i style={{ background: off ? "#c2410c" : "#2563eb" }} />Forecast</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={`Now ${fmt(f.current)} of ${fmt(f.target)}; at this pace ${fmt(f.landing)} by ${fmtYmd(f.end)}`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} stroke="#eef2f0" />
            <text x={L - 8} y={Y(v) + 4} fontSize="11" textAnchor="end" fill="#5b6b64">{fmt(v)}</text>
          </g>
        ))}
        {months.length <= 14 && months.map((m) => <text key={m.d} x={X(m.d)} y={h - 10} fontSize="11" textAnchor="middle" fill="#5b6b64">{m.label}</text>)}
        <line x1={X(f.start)} y1={Y(f.startValue)} x2={X(f.end)} y2={Y(f.target)} stroke="#9aa8a2" strokeWidth="2" strokeDasharray="5 4" />
        {actual && <polyline points={actual} fill="none" stroke="#1b6b4a" strokeWidth="3" />}
        <line x1={X(f.today)} y1={Y(f.current)} x2={X(f.end)} y2={Y(f.landing)} stroke={off ? "#c2410c" : "#2563eb"} strokeWidth="2.5" strokeDasharray="6 4" />
        <circle cx={X(f.today)} cy={Y(f.current)} r="5" fill="#1b6b4a" />
        <text x={w - R - 4} y={Y(f.target) - 8} fontSize="12" fontWeight="800" textAnchor="end" fill="#5b6b64">Goal {fmt(f.target)}</text>
        <text x={w - R - 4} y={Y(f.landing) + (Math.abs(Y(f.landing) - Y(f.target)) < 18 ? 18 : -10)} fontSize="12" fontWeight="800" textAnchor="end" fill={off ? "#c2410c" : "#2563eb"}>{fmt(f.landing)} at this pace</text>
      </svg>
    </div>
  );
}

function Read({ c }: { c: GoalsCtx }) {
  const refresh = trpc.goals.refreshRead.useMutation({ onSuccess: () => c.refresh() });
  const read = c.data.read;
  return (
    <>
      {read ? (
        read.items.map((i, k) => (
          <div key={k} className="gp-read">
            <StatusPill s={i.status} />
            <span>{i.text}</span>
          </div>
        ))
      ) : (
        <span className="ld-small ld-muted">Simone reads the scorecard and goals every Monday morning.</span>
      )}
      <button type="button" className="ld-btn" style={{ alignSelf: "flex-start" }} disabled={refresh.isPending} onClick={() => refresh.mutate({ organizationId: c.orgId })}>
        {refresh.isPending ? "Reading" : read ? "Read it again" : "Read it now"}
      </button>
      <ErrorLine error={refresh.error} />
    </>
  );
}

function Donut({ rows }: { rows: { name: string; v: number; color: string }[] }) {
  const tot = rows.reduce((s, r) => s + Math.max(0, r.v), 0);
  const r = 40;
  const L = 2 * Math.PI * r;
  let off = 0;
  return (
    <div className="gp-donut">
      <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#eef2f0" strokeWidth="18" />
        {tot > 0 &&
          rows.map((x) => {
            const len = (Math.max(0, x.v) / tot) * L;
            const el = <circle key={x.name} cx="60" cy="60" r={r} fill="none" stroke={x.color} strokeWidth="18" strokeDasharray={`${len} ${L}`} strokeDashoffset={-off} transform="rotate(-90 60 60)" />;
            off += len;
            return el;
          })}
        <text x="60" y="64" textAnchor="middle" fontSize="20" fontWeight="800" fill="#14221c">{Math.round(tot * 10) / 10}</text>
      </svg>
      <div className="lg">
        {rows.map((x) => (
          <span key={x.name}>
            <i style={{ background: x.color }} />
            <span className="gp-ell">{x.name}</span>
            <b>{Math.round(x.v * 10) / 10}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function WeekBars({ c, r }: { c: GoalsCtx; r: Overview["scorecard"]["rows"][number] }) {
  const vals = r.values.slice(-6);
  const weeks = c.data.scorecard.weeks.slice(-6);
  const goal = r.measure.weeklyGoal;
  const mx = Math.max(1, ...vals.map((v) => v ?? 0), goal ?? 0);
  const met = (v: number) => goal === null || (r.measure.direction === "up" ? v >= goal : v <= goal);
  return (
    <>
      <div className="gp-wbars" style={{ position: "relative" }}>
        {goal !== null && <span className="gl" style={{ bottom: `${(goal / mx) * 110 + 18}px` }} />}
        {vals.map((v, i) => (
          <span key={weeks[i]} className="col">
            <em>{v === null ? "" : short(v, r.measure.unit === "currency" ? "currency" : undefined)}</em>
            <span className="b" style={{ height: `${((v ?? 0) / mx) * 110}px`, background: v === null ? "#eef2f0" : met(v) ? "#1b6b4a" : "#e8384f" }} />
            <span className="w">{fmtYmd(weeks[i]).replace(/, \d{4}$/, "")}</span>
          </span>
        ))}
      </div>
      <span className="ld-small ld-muted">Weeks of {weeks[weeks.length - 1]?.slice(0, 4)}{goal !== null ? ` · the line is the ${valueText(goal, r.measure.unit)} weekly goal` : ""}</span>
    </>
  );
}

function Funnel({ rows }: { rows: { name: string; v: number }[] }) {
  const top = Math.max(1, rows[0].v);
  const conv = rows.map((r, i) => (i === 0 || !rows[i - 1].v ? null : Math.round((r.v / rows[i - 1].v) * 100)));
  const worst = conv.reduce<number | null>((w, c2, i) => (c2 !== null && (w === null || c2 < (conv[w] ?? 101)) ? i : w), null);
  return (
    <>
      {rows.map((r, i) => (
        <div key={r.name} className="gp-fun">
          <span className="ld-between">
            <span>{r.name} <b>{Math.round(r.v * 10) / 10}</b></span>
            <span className="ld-small" style={i === worst ? { color: "#c2253c", fontWeight: 800 } : { color: "#5b6b64" }}>{conv[i] === null ? "" : `${conv[i]}%`}</span>
          </span>
          <span className="t"><i style={{ width: `${Math.max(3, (r.v / top) * 100)}%`, background: i === worst ? "#e8384f" : "#1b6b4a" }} /></span>
        </div>
      ))}
      {worst !== null && <span className="ld-small" style={{ color: "#c2253c", fontWeight: 700 }}>Biggest leak: {rows[worst - 1].name} to {rows[worst].name.toLowerCase()}</span>}
    </>
  );
}
