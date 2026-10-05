import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt, fmtYmd, Menu } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";

/**
 * A whiteboard: sticky notes, shapes, freehand lines, text, arrows between
 * items, frames, and task cards. Select notes and make them tasks. Changes
 * save on their own a moment after you stop.
 */

type B = Outputs["pj"]["board"];
type Item = B["board"]["items"][number];
type Tool = "select" | "sticky" | "rect" | "circle" | "pen" | "text" | "arrow" | "task";
const TOOLS: { t: Tool; icon: string; label: string }[] = [
  { t: "select", icon: "↖", label: "Select and move" },
  { t: "sticky", icon: "▤", label: "Sticky note" },
  { t: "rect", icon: "▢", label: "Box" },
  { t: "circle", icon: "◯", label: "Circle" },
  { t: "pen", icon: "✎", label: "Draw" },
  { t: "text", icon: "T", label: "Text" },
  { t: "arrow", icon: "→", label: "Arrow: click one item, then another" },
  { t: "task", icon: "☑", label: "Task card" },
];
const COLORS = ["#fff3b0", "#cfe8ff", "#ffd6e0", "#d6f5e3", "#ead9ff", "#ffe2c4", "#ffffff"];
const uid = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const W = 3000;
const H = 2000;

export function BoardPage({ orgId, id, onPick, onOpenTask, refresh }: { orgId: number; id: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void; refresh: () => Promise<unknown> }) {
  const q = trpc.pj.board.useQuery({ organizationId: orgId, id });
  const save = trpc.pj.saveBoardItems.useMutation();
  const rename = trpc.pj.saveBoard.useMutation({ onSuccess: async () => { setRenaming(null); await Promise.all([q.refetch(), refresh()]); } });
  const remove = trpc.pj.removeBoard.useMutation({ onSuccess: async () => { await refresh(); onPick({ scope: "everything" }); } });
  const makeTasks = trpc.pj.boardTasks.useMutation({ onSuccess: async () => { setPickList(false); setSel([]); const r = await q.refetch(); if (r.data) setItems(r.data.board.items); } });
  const tree = trpc.pj.tree.useQuery({ organizationId: orgId });
  const tasksQ = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: false });
  const [items, setItems] = React.useState<Item[]>([]);
  const [tool, setTool] = React.useState<Tool>("select");
  const [color, setColor] = React.useState(COLORS[0]);
  const [sel, setSel] = React.useState<string[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState<{ kind: "move" | "box" | "pen" | "size"; x0: number; y0: number; x: number; y: number; start?: Item[] } | null>(null);
  const [arrowFrom, setArrowFrom] = React.useState<string | null>(null);
  const [pickTask, setPickTask] = React.useState<{ x: number; y: number } | null>(null);
  const [pickList, setPickList] = React.useState(false);
  const [listId, setListId] = React.useState<number | "">("");
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const surface = React.useRef<HTMLDivElement>(null);
  const loaded = React.useRef<number | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (q.data && loaded.current !== id) {
      setItems(q.data.board.items);
      loaded.current = id;
      setSel([]);
    }
  }, [q.data, id]);
  const commit = (next: Item[]) => {
    setItems(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate({ organizationId: orgId, id, items: next.map((x) => ({ ...x, color: x.color ?? undefined, text: x.text ?? undefined, from: x.from ?? undefined, to: x.to ?? undefined, taskId: x.taskId ?? undefined, path: x.path ?? undefined, z: x.z ?? undefined })) }), 700);
  };
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = surface.current!.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
  };
  const topZ = () => Math.max(0, ...items.map((x) => x.z ?? 0)) + 1;
  const place = (p: { x: number; y: number }) => {
    const base = { id: uid(), x: p.x, y: p.y, z: topZ() };
    let it: Item | null = null;
    if (tool === "sticky") it = { ...base, kind: "sticky", w: 160, h: 110, color, text: "" };
    if (tool === "rect") it = { ...base, kind: "rect", w: 180, h: 110, color: color === "#fff3b0" ? "#ffffff" : color, text: "" };
    if (tool === "circle") it = { ...base, kind: "circle", w: 140, h: 140, color: color === "#fff3b0" ? "#ffffff" : color, text: "" };
    if (tool === "text") it = { ...base, kind: "text", w: 220, h: 40, text: "" };
    if (tool === "task") return setPickTask(p);
    if (!it) return;
    commit([...items, it]);
    setSel([it.id]);
    setEditing(it.id);
    setTool("select");
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.target !== surface.current && !(e.target as HTMLElement).classList.contains("gp-wb-svg")) return;
    const p = at(e);
    setEditing(null);
    if (tool === "pen") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ kind: "pen", x0: p.x, y0: p.y, x: p.x, y: p.y, start: [{ id: "pen", kind: "pen", x: 0, y: 0, w: 0, h: 0, path: `M ${p.x} ${p.y}` } as Item] });
      return;
    }
    if (tool !== "select") return place(p);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel([]);
    setArrowFrom(null);
    setDrag({ kind: "box", x0: p.x, y0: p.y, x: p.x, y: p.y });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = at(e);
    if (drag.kind === "pen") {
      const prev = drag.start![0];
      setDrag({ ...drag, x: p.x, y: p.y, start: [{ ...prev, path: `${prev.path} L ${p.x} ${p.y}` }] });
    } else setDrag({ ...drag, x: p.x, y: p.y });
  };
  const onUp = () => {
    if (!drag) return;
    const dx = drag.x - drag.x0;
    const dy = drag.y - drag.y0;
    if (drag.kind === "box") {
      const x1 = Math.min(drag.x0, drag.x);
      const y1 = Math.min(drag.y0, drag.y);
      const x2 = Math.max(drag.x0, drag.x);
      const y2 = Math.max(drag.y0, drag.y);
      if (x2 - x1 > 4 || y2 - y1 > 4) setSel(items.filter((i) => i.kind !== "arrow" && i.x < x2 && i.x + i.w > x1 && i.y < y2 && i.y + i.h > y1).map((i) => i.id));
    } else if (drag.kind === "move" && (dx || dy)) {
      commit(items.map((i) => (sel.includes(i.id) && i.kind !== "arrow" ? { ...i, x: i.x + dx, y: i.y + dy, ...(i.kind === "pen" && i.path ? { path: shiftPath(i.path, dx, dy) } : {}) } : i)));
    } else if (drag.kind === "size" && (dx || dy)) {
      commit(items.map((i) => (i.id === sel[0] ? { ...i, w: Math.max(40, i.w + dx), h: Math.max(30, i.h + dy) } : i)));
    } else if (drag.kind === "pen") {
      const path = drag.start![0].path!;
      const nums = path.match(/-?\d+/g)!.map(Number);
      const xs = nums.filter((_, k) => k % 2 === 0);
      const ys = nums.filter((_, k) => k % 2 === 1);
      if (xs.length > 2) {
        const it: Item = { id: uid(), kind: "pen", x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), color: "#14221c", path, z: topZ() };
        commit([...items, it]);
      }
    }
    setDrag(null);
  };
  const itemDown = (e: React.PointerEvent, it: Item) => {
    e.stopPropagation();
    if (tool === "arrow") {
      if (!arrowFrom) setArrowFrom(it.id);
      else if (arrowFrom !== it.id) {
        commit([...items, { id: uid(), kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: arrowFrom, to: it.id, z: 0 }]);
        setArrowFrom(null);
        setTool("select");
      }
      return;
    }
    if (tool !== "select" || editing === it.id) return;
    const next = e.shiftKey ? (sel.includes(it.id) ? sel.filter((x) => x !== it.id) : [...sel, it.id]) : sel.includes(it.id) ? sel : [it.id];
    setSel(next);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = at(e);
    setDrag({ kind: "move", x0: p.x, y0: p.y, x: p.x, y: p.y });
  };
  const moving = drag?.kind === "move" ? { dx: drag.x - drag.x0, dy: drag.y - drag.y0 } : { dx: 0, dy: 0 };
  const sizing = drag?.kind === "size" ? { dw: drag.x - drag.x0, dh: drag.y - drag.y0 } : { dw: 0, dh: 0 };
  const pos = (i: Item) => {
    const m = sel.includes(i.id) ? moving : { dx: 0, dy: 0 };
    const s = sel[0] === i.id ? sizing : { dw: 0, dh: 0 };
    return { x: i.x + m.dx, y: i.y + m.dy, w: Math.max(40, i.w + s.dw), h: Math.max(30, i.h + s.dh) };
  };
  const center = (id?: string | null) => {
    const i = items.find((x) => x.id === id);
    if (!i) return null;
    const p = pos(i);
    return { cx: p.x + p.w / 2, cy: p.y + p.h / 2, w: p.w, h: p.h };
  };
  const words = items.filter((i) => sel.includes(i.id) && ["sticky", "text", "rect", "circle"].includes(i.kind) && i.text?.trim());
  const lists = [...(tree.data?.folders ?? []).flatMap((f) => f.lists.map((l) => ({ id: l.id, name: `${f.name} › ${l.name}` }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name }))];
  const selBox = sel.length
    ? (() => {
        const ps = items.filter((i) => sel.includes(i.id) && i.kind !== "arrow").map(pos);
        if (!ps.length) return null;
        return { x: Math.min(...ps.map((p) => p.x)), y: Math.max(...ps.map((p) => p.y + p.h)) + 14 };
      })()
    : null;
  const group = () => {
    const ps = items.filter((i) => sel.includes(i.id) && i.kind !== "arrow");
    if (!ps.length) return;
    const x = Math.min(...ps.map((p) => p.x)) - 20;
    const y = Math.min(...ps.map((p) => p.y)) - 40;
    const w = Math.max(...ps.map((p) => p.x + p.w)) - x + 20;
    const h = Math.max(...ps.map((p) => p.y + p.h)) - y + 20;
    const z = Math.min(0, ...items.map((i) => i.z ?? 0)) - 1;
    commit([...items, { id: uid(), kind: "frame", x, y, w, h, text: "Group", z }]);
  };
  const b = q.data?.board;
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          {renaming !== null ? (
            <span className="ld-row">
              <input className="ld-in xs" style={{ width: 280 }} aria-label="Whiteboard name" value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              <button type="button" className="ld-btn sm" onClick={() => setRenaming(null)}>Cancel</button>
              <button type="button" className="ld-btn p sm" disabled={!renaming.trim()} onClick={() => rename.mutate({ organizationId: orgId, id, title: renaming })}>Save</button>
            </span>
          ) : (
            <span className="gp-ttl" style={{ fontSize: 18 }}>
              {b?.folderName && <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>{b.folderName} /</span>}
              {b?.title}
            </span>
          )}
          <span className="ld-row">
            <span className="ld-small ld-muted">{save.isPending ? "Saving" : b?.editedBy ? `Saved · ${b.editedBy}, ${fmtAt(b.updatedAt)}` : ""}</span>
            <button
              type="button"
              className="ld-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(`${window.location.origin}/projects?page=board&id=${id}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Link copied" : "Share"}
            </button>
            <Menu label="Whiteboard options">
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { setRenaming(b?.title ?? ""); close(); }}>Rename</button>
                  <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete "${b?.title}"?`)) remove.mutate({ organizationId: orgId, id }); close(); }}>Delete whiteboard</button>
                </>
              )}
            </Menu>
          </span>
        </div>
      </div>
      <div className="gp-canvas" style={{ display: "block" }}>
        <ErrorLine error={q.error || save.error || makeTasks.error || remove.error || rename.error} />
        <div className="gp-wb">
          <div className="gp-wbtools" role="toolbar" aria-label="Whiteboard tools">
            {TOOLS.map((t) => (
              <button key={t.t} type="button" title={t.label} aria-label={t.label} aria-pressed={tool === t.t} className={tool === t.t ? "on" : ""} onClick={() => { setTool(t.t); setArrowFrom(null); }}>
                {t.icon}
              </button>
            ))}
            <span className="gp-wb-sep" />
            {COLORS.slice(0, 6).map((c) => (
              <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={color === c} className={`sw ${color === c ? "on" : ""}`} style={{ background: c }} onClick={() => { setColor(c); if (sel.length) commit(items.map((i) => (sel.includes(i.id) && i.kind !== "arrow" && i.kind !== "pen" && i.kind !== "task" ? { ...i, color: c } : i))); }} />
            ))}
          </div>
          {tool === "arrow" && <div className="gp-wb-hint">{arrowFrom ? "Now click the item it points to." : "Click the item the arrow starts from."}</div>}
          {tool === "pen" && <div className="gp-wb-hint">Drag to draw.</div>}
          <div className="gp-wb-scroll">
            <div ref={surface} className={`gp-wb-surface t-${tool}`} style={{ width: W, height: H }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
              <svg className="gp-wb-svg" width={W} height={H}>
                <defs>
                  <marker id="wbarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill="#5b6b64" />
                  </marker>
                </defs>
                {items
                  .filter((i) => i.kind === "arrow")
                  .map((a) => {
                    const f = center(a.from);
                    const t = center(a.to);
                    if (!f || !t) return null;
                    const edge = (c: { cx: number; cy: number; w: number; h: number }, ox: number, oy: number) => {
                      const dx = ox - c.cx;
                      const dy = oy - c.cy;
                      const s = Math.min(Math.abs((c.w / 2) / (dx || 1e-6)), Math.abs((c.h / 2) / (dy || 1e-6)));
                      return { x: c.cx + dx * s, y: c.cy + dy * s };
                    };
                    const p1 = edge(f, t.cx, t.cy);
                    const p2 = edge(t, f.cx, f.cy);
                    return (
                      <g key={a.id} onPointerDown={(e) => { e.stopPropagation(); setSel([a.id]); }} style={{ cursor: "pointer" }}>
                        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth="12" />
                        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={sel.includes(a.id) ? "#2563eb" : "#5b6b64"} strokeWidth="2" markerEnd="url(#wbarrow)" />
                      </g>
                    );
                  })}
                {items
                  .filter((i) => i.kind === "pen")
                  .map((i) => {
                    const m = sel.includes(i.id) ? moving : { dx: 0, dy: 0 };
                    return <path key={i.id} d={i.path ?? ""} transform={`translate(${m.dx} ${m.dy})`} stroke={sel.includes(i.id) ? "#2563eb" : i.color ?? "#14221c"} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" onPointerDown={(e) => itemDown(e as unknown as React.PointerEvent, i)} style={{ cursor: "move" }} />;
                  })}
                {drag?.kind === "pen" && <path d={drag.start![0].path} stroke="#14221c" strokeWidth="2.5" fill="none" strokeLinecap="round" />}
                {drag?.kind === "box" && <rect x={Math.min(drag.x0, drag.x)} y={Math.min(drag.y0, drag.y)} width={Math.abs(drag.x - drag.x0)} height={Math.abs(drag.y - drag.y0)} fill="rgba(37,99,235,.08)" stroke="#2563eb" strokeDasharray="4 3" />}
              </svg>
              {items
                .filter((i) => i.kind !== "arrow" && i.kind !== "pen")
                .sort((a, c) => (a.z ?? 0) - (c.z ?? 0))
                .map((i) => {
                  const p = pos(i);
                  const t = i.kind === "task" ? q.data?.tasks.find((x) => x.id === i.taskId) : null;
                  return (
                    <div
                      key={i.id}
                      className={`gp-wbi k-${i.kind} ${sel.includes(i.id) ? "sel" : ""} ${arrowFrom === i.id ? "from" : ""}`}
                      style={{ left: p.x, top: p.y, width: p.w, height: p.h, background: i.kind === "task" || i.kind === "text" || i.kind === "frame" ? undefined : i.color ?? "#fff3b0", zIndex: (i.z ?? 0) + 10 }}
                      onPointerDown={(e) => itemDown(e, i)}
                      onDoubleClick={() => (i.kind === "task" && i.taskId ? onOpenTask(i.taskId) : setEditing(i.id))}
                    >
                      {i.kind === "task" ? (
                        <span className="tc">
                          <b className="gp-ell">↔ {t?.name ?? "A task"}</b>
                          <span className="ld-small ld-muted gp-ell">{t ? `${t.status}${t.assignees[0] ? ` · ${t.assignees[0]}` : ""}${t.dueDate ? ` · ${fmtYmd(t.dueDate)}` : ""}` : "Not found"}</span>
                        </span>
                      ) : editing === i.id ? (
                        <textarea autoFocus aria-label="Words" value={i.text ?? ""} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => setItems(items.map((x) => (x.id === i.id ? { ...x, text: e.target.value } : x)))} onBlur={() => { commit(items); setEditing(null); }} />
                      ) : (
                        <span className="tx">{i.text || (i.kind === "frame" ? "Group" : "")}</span>
                      )}
                      {sel.length === 1 && sel[0] === i.id && i.kind !== "task" && (
                        <span
                          className="rs"
                          aria-hidden="true"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                            const pt = at(e);
                            setDrag({ kind: "size", x0: pt.x, y0: pt.y, x: pt.x, y: pt.y });
                          }}
                          onPointerMove={onMove}
                          onPointerUp={onUp}
                        />
                      )}
                    </div>
                  );
                })}
              {selBox && !drag && (
                <div className="gp-pop" style={{ left: selBox.x, top: selBox.y, zIndex: 100000 }} onPointerDown={(e) => e.stopPropagation()}>
                  {!pickList ? (
                    <>
                      <span className="n">{sel.length} selected</span>
                      {words.length > 0 && <button type="button" className="on" onClick={() => { setPickList(true); setListId(lists[0]?.id ?? ""); }}>Make {words.length} task{words.length === 1 ? "" : "s"}</button>}
                      {sel.length === 1 && items.find((i) => i.id === sel[0] && ["sticky", "rect", "circle", "text", "frame"].includes(i.kind)) && <button type="button" onClick={() => setEditing(sel[0])}>Edit words</button>}
                      {sel.length > 1 && <button type="button" onClick={group}>Group</button>}
                      <button type="button" onClick={() => { const drop = new Set(sel); commit(items.filter((i) => !drop.has(i.id) && !(i.kind === "arrow" && (drop.has(i.from ?? "") || drop.has(i.to ?? ""))))); setSel([]); }}>Delete</button>
                    </>
                  ) : (
                    <span className="gp-pop-form">
                      <select className="ld-in xs" aria-label="List for the tasks" value={listId} onChange={(e) => setListId(Number(e.target.value))}>
                        {lists.map((l) => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => setPickList(false)}>Cancel</button>
                      <button
                        type="button"
                        className="on"
                        disabled={!listId || makeTasks.isPending}
                        onClick={async () => {
                          if (!listId) return;
                          if (timer.current) {
                            clearTimeout(timer.current);
                            await save.mutateAsync({ organizationId: orgId, id, items: items.map((x) => ({ ...x, color: x.color ?? undefined, text: x.text ?? undefined, from: x.from ?? undefined, to: x.to ?? undefined, taskId: x.taskId ?? undefined, path: x.path ?? undefined, z: x.z ?? undefined })) });
                          }
                          makeTasks.mutate({ organizationId: orgId, id, itemIds: words.map((w) => w.id), listId });
                        }}
                      >
                        Make them
                      </button>
                    </span>
                  )}
                </div>
              )}
              {pickTask && (
                <div className="gp-pop" style={{ left: pickTask.x, top: pickTask.y, zIndex: 100000 }} onPointerDown={(e) => e.stopPropagation()}>
                  <span className="gp-pop-form">
                    <select
                      className="ld-in xs"
                      aria-label="Task for the card"
                      defaultValue=""
                      onChange={(e) => {
                        const tid = Number(e.target.value);
                        if (!tid) return;
                        commit([...items, { id: uid(), kind: "task", x: pickTask.x, y: pickTask.y, w: 240, h: 64, taskId: tid, z: topZ() }]);
                        setPickTask(null);
                        setTool("select");
                        void q.refetch();
                      }}
                    >
                      <option value="">Pick a task</option>
                      {tasksQ.data?.tasks.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => setPickTask(null)}>Cancel</button>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
        <p className="ld-small ld-muted" style={{ margin: "8px 2px 0" }}>Pick a tool, then click the board. Double-click a note to change its words, or a task card to open it. Shift-click or drag a box to pick several.</p>
      </div>
    </>
  );
}

const shiftPath = (path: string, dx: number, dy: number) => {
  let i = 0;
  return path.replace(/-?\d+/g, (n) => String(Number(n) + (i++ % 2 === 0 ? dx : dy)));
};
