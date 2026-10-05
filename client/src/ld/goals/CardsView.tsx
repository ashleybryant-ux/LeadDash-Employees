import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { COLORS, money, OwnerAvatar, StatusPill } from "./shared";
import type { GoalRow, GoalsCtx } from "../pages/Goals";

/** Cards view (like ClickUp Goals): each goal a colored card with a progress ring and its targets, in folders. */
export function CardsView({ c }: { c: GoalsCtx }) {
  const [folder, setFolder] = React.useState<number | "all">("all");
  const [editing, setEditing] = React.useState<{ id?: number; name: string; color: string } | null>(null);
  const saveF = trpc.goals.saveFolder.useMutation({ onSuccess: async () => { setEditing(null); await c.refresh(); } });
  const removeF = trpc.goals.removeFolder.useMutation({ onSuccess: async () => { setEditing(null); setFolder("all"); await c.refresh(); } });
  const rows = c.shown.filter((g) => g.goal.state === "active" || g.goal.state === "done" || g.goal.state === "suggested").filter((g) => folder === "all" || g.goal.folderId === folder);
  const cur = folder === "all" ? null : c.data.folders.find((f) => f.id === folder);
  return (
    <div>
      <div className="ld-ftabs" role="tablist" aria-label="Folders">
        <button type="button" role="tab" aria-selected={folder === "all"} className={`ld-ft ${folder === "all" ? "on" : ""}`} onClick={() => setFolder("all")}>All goals</button>
        {c.data.folders.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={folder === f.id} className={`ld-ft ${folder === f.id ? "on" : ""}`} onClick={() => setFolder(f.id)}>
            <span className="gp-fi" style={{ background: f.color }} />
            {f.name}
          </button>
        ))}
        <button type="button" className="ld-ft" onClick={() => setEditing({ name: "", color: COLORS[(c.data.folders.length + 1) % COLORS.length] })}>+ Folder</button>
      </div>
      <div className="ld-ftbody" style={{ padding: 18 }}>
        {editing ? (
          <div className="gp-folder-ed">
            <input className="ld-in xs" autoFocus aria-label="Folder name" placeholder="Folder name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <span className="ld-row" role="radiogroup" aria-label="Color">
              {COLORS.map((col) => (
                <button key={col} type="button" role="radio" aria-checked={editing.color === col} aria-label={col} className={`gp-sw ${editing.color === col ? "on" : ""}`} style={{ background: col }} onClick={() => setEditing({ ...editing, color: col })} />
              ))}
            </span>
            <span className="ld-row">
              {editing.id && (
                <button type="button" className="ld-btn danger" onClick={() => window.confirm("Remove this folder? Its goals stay, out of the folder.") && removeF.mutate({ organizationId: c.orgId, id: editing.id! })}>Remove</button>
              )}
              <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="ld-btn p" disabled={!editing.name.trim() || saveF.isPending} onClick={() => saveF.mutate({ organizationId: c.orgId, id: editing.id, name: editing.name, color: editing.color, parentId: null })}>Save</button>
            </span>
            <ErrorLine error={saveF.error || removeF.error} />
          </div>
        ) : (
          cur && (
            <div className="ld-between" style={{ marginBottom: 14 }}>
              <b>{cur.name}</b>
              <span className="ld-row">
                <button type="button" className="ld-btn" onClick={() => setEditing({ id: cur.id, name: cur.name, color: cur.color })}>Edit folder</button>
                <button type="button" className="ld-btn p" onClick={() => c.edit("new", { folderId: cur.id })}>+ New goal</button>
              </span>
            </div>
          )
        )}
        <div className="gp-cards">
          {rows.map((g) => (
            <GoalCard key={g.goal.id} c={c} g={g} />
          ))}
          {!rows.length && <div className="gp-empty">{folder === "all" ? "No goals yet." : "No goals in this folder yet."}</div>}
        </div>
      </div>
    </div>
  );
}

function Ring({ p }: { p: number }) {
  const r = 26;
  const L = 2 * Math.PI * r;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-label={`${p}% done`}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="7" />
      <circle cx="32" cy="32" r={r} fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(p / 100) * L} ${L}`} transform="rotate(-90 32 32)" />
      <text x="32" y="37" textAnchor="middle" fontSize="14" fontWeight="800" fill="#fff">{p}%</text>
    </svg>
  );
}

function GoalCard({ c, g }: { c: GoalsCtx; g: GoalRow }) {
  const val = (t: GoalRow["targets"][number]) =>
    t.kind === "boolean" ? (t.done ? "Done" : "Not done") : t.kind === "tasks" ? `${t.tasksDone} of ${t.tasksTotal} done` : t.kind === "measure" ? `${t.measureValue ?? "None"} / ${t.targetValue}` : t.kind === "currency" ? `${money(t.currentValue)} / ${money(t.targetValue)}` : `${t.currentValue.toLocaleString("en-US")} / ${t.targetValue.toLocaleString("en-US")}`;
  const icon = (k: string, done: boolean) => (k === "currency" ? "$" : k === "boolean" ? (done ? "✓" : "✗") : k === "tasks" ? "☐" : k === "measure" ? "~" : "#");
  return (
    <button type="button" className="gp-gc" onClick={() => c.open(g.goal.id)} aria-label={`Open ${g.goal.title}`}>
      <span className="gtop" style={{ background: g.goal.color }}>
        <span className="l">
          <span className="per">{g.goal.period}{g.goal.state === "suggested" ? " · Simone suggests" : ""}</span>
          <b>{g.goal.title}</b>
          <span className="ow">
            <OwnerAvatar o={g.owner} size={22} />
            <span>{g.owner?.name ?? "No owner"}</span>
          </span>
        </span>
        <Ring p={g.progress} />
      </span>
      <span className="bd">
        <span className="ld-between">
          <span className="ld-lbl">Targets</span>
          {g.goal.state === "suggested" ? <span className="gp-chip warn">Needs your OK</span> : <StatusPill s={g.status} />}
        </span>
        {g.targets.length ? (
          g.targets.slice(0, 4).map((t) => (
            <span key={t.id} className="gp-tg">
              <span className="k">{icon(t.kind, t.done)}</span>
              <span className="gp-ell">{t.name}</span>
              <span className="v">{val(t)}</span>
            </span>
          ))
        ) : (
          <span className="ld-small ld-muted">No targets. {g.progress}% done.</span>
        )}
      </span>
    </button>
  );
}
