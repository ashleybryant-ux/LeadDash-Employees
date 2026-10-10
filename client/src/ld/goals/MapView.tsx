import React from "react";
import { Bar, OwnerAvatar, StatusPill } from "./shared";
import type { GoalRow, GoalsCtx } from "../pages/Goals";

/** Map (like Asana's strategy map): goals as connected cards, from the company goal down to each quarter's, with the work under each. */
const W = 250;
const H = 128;
const GAP = 22;
const ROW = 220;

export function MapView({ c }: { c: GoalsCtx }) {
  const rows = c.shown.filter((g) => g.goal.state === "active" || g.goal.state === "done" || g.goal.state === "suggested");
  const ids = new Set(rows.map((g) => g.goal.id));
  const roots = rows.filter((g) => !g.goal.parentId || !ids.has(g.goal.parentId));
  const kids = (id: number) => rows.filter((g) => g.goal.parentId === id);
  // Lay out by leaves: each leaf takes one slot, a parent sits over its children.
  const pos = new Map<number, { x: number; y: number; g: GoalRow }>();
  let slot = 0;
  const place = (g: GoalRow, depth: number): number => {
    const ks = depth < 5 ? kids(g.goal.id) : [];
    let x: number;
    if (!ks.length) x = slot++ * (W + GAP);
    else {
      const xs = ks.map((k) => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.set(g.goal.id, { x, y: depth * ROW, g });
    return x;
  };
  roots.forEach((r) => place(r, 0));
  const all = Array.from(pos.values());
  const width = Math.max(W, ...all.map((p) => p.x + W)) + 40;
  const height = Math.max(H, ...all.map((p) => p.y + H)) + 60;
  const box = React.useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = React.useState(1);
  const fit = () => {
    const el = box.current;
    if (!el) return;
    setZoom(Math.max(0.3, Math.min(1, (el.clientWidth - 40) / width, (el.clientHeight - 40) / height)));
  };
  React.useEffect(fit, [width, height]);
  if (!rows.length) return <div className="gp-empty">No goals to map yet.</div>;
  const scale = Math.min(150 / width, 90 / height);
  return (
    <div className="gp-map" ref={box}>
      <div className="inner" style={{ width, height, transform: `scale(${zoom})` }}>
        <svg width={width} height={height} style={{ position: "absolute", left: 0, top: 0 }} aria-hidden="true">
          {all
            .filter((p) => p.g.goal.parentId && pos.has(p.g.goal.parentId))
            .map((p) => {
              const par = pos.get(p.g.goal.parentId!)!;
              const x1 = par.x + W / 2 + 20;
              const y1 = par.y + H + 20;
              const x2 = p.x + W / 2 + 20;
              const y2 = p.y + 20;
              return <path key={p.g.goal.id} d={`M${x1} ${y1} C ${x1} ${y1 + 50}, ${x2} ${y2 - 50}, ${x2} ${y2}`} fill="none" stroke="var(--ld-soft)" strokeWidth="2" />;
            })}
        </svg>
        {all.map((p) => (
          <button key={p.g.goal.id} type="button" className="gp-mc" style={{ left: p.x + 20, top: p.y + 20, width: W, borderTopColor: p.g.goal.color }} onClick={() => c.open(p.g.goal.id)} aria-label={`Open ${p.g.goal.title}`}>
            <span className="ld-small ld-muted">{p.g.goal.level === "company" ? `Company · ${p.g.goal.period}` : p.g.goal.period}</span>
            <b>{p.g.goal.title}</b>
            <Bar p={p.g.progress} color={p.g.goal.color} red={p.g.status === "off"} />
            <span className="ld-between">
              <OwnerAvatar o={p.g.owner} size={22} />
              {p.g.goal.state === "suggested" ? <span className="gp-chip warn">Needs your OK</span> : <StatusPill s={p.g.status} />}
            </span>
            {p.g.supporting > 0 && <span className="cnt">▾ {p.g.supporting}</span>}
          </button>
        ))}
      </div>
      <div className="gp-mini" aria-hidden="true">
        <svg width="150" height="90">
          {all.map((p) => (
            <rect key={p.g.goal.id} x={p.x * scale + 4} y={p.y * scale + 4} width={Math.max(4, W * scale)} height={Math.max(3, H * scale)} rx="1.5" fill={p.g.goal.color} opacity=".55" />
          ))}
          <rect x="1" y="1" width="148" height="88" rx="4" fill="none" stroke="var(--ld-accent)" />
        </svg>
      </div>
      <div className="gp-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}>−</button>
        <button type="button" aria-label="Fit the map" onClick={fit} style={{ fontSize: 11 }}>Fit</button>
      </div>
    </div>
  );
}
