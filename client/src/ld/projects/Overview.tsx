import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtYmd, OwnerAvatar } from "../goals/shared";
import { PRIORITY_COLOR, PRIORITY_TEXT } from "./bits";
import { FilePreview, type PreviewFile } from "./Preview";
import type { Where } from "../pages/Projects";

/**
 * A folder's Overview: what changed last, its docs, how it's going, its lists
 * with progress and dates, files from its tasks, and who has what.
 */

const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const ICON: Record<string, string> = { list: "☰", doc: "📄", board: "▢", form: "☰" };

export function FolderOverview({ orgId, folderId, onPick, onOpenTask, onNewList, onNewDoc }: { orgId: number; folderId: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void; onNewList: () => void; onNewDoc: () => void }) {
  const q = trpc.pj.overview.useQuery({ organizationId: orgId, folderId }, { refetchInterval: 30_000 });
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  const d = q.data;
  if (q.error) return <ErrorLine error={q.error} />;
  if (!d) return <p className="ld-muted" style={{ padding: 20 }}>Loading</p>;
  const go = (kind: string, id: number) => (kind === "list" ? onPick({ scope: "list", listId: id }) : onPick({ scope: kind as "doc" | "board" | "form", id }));
  const pct = d.totals.total ? Math.round(((d.totals.total - d.totals.open) / d.totals.total) * 100) : 0;
  const most = Math.max(1, ...d.byPerson.map((p) => p.n));
  return (
    <div className="gp-ov">
      {preview && <FilePreview orgId={orgId} file={preview} onClose={() => setPreview(null)} />}
      <div className="gp-ov3">
        <div className="gp-ovc">
          <h4>Recent</h4>
          {d.recent.map((r) => (
            <button key={`${r.kind}${r.id}`} type="button" className="gp-ovrow" onClick={() => go(r.kind, r.id)}>
              <span aria-hidden="true">{ICON[r.kind]}</span>
              <b className="gp-ell">{r.name}</b>
              <span className="ld-small ld-muted">{fmtAt(r.at)}</span>
            </button>
          ))}
          {!d.recent.length && <span className="ld-small ld-muted">Nothing here yet.</span>}
        </div>
        <div className="gp-ovc">
          <h4>
            Docs
            <button type="button" className="gp-link" onClick={onNewDoc}>+ New doc</button>
          </h4>
          {d.items.map((i) => (
            <button key={`${i.kind}${i.id}`} type="button" className="gp-ovrow" onClick={() => go(i.kind, i.id)}>
              <span aria-hidden="true">{ICON[i.kind]}</span>
              <b className="gp-ell">{i.name}</b>
              <span className="ld-small ld-muted">{fmtAt(i.at)}</span>
            </button>
          ))}
          {!d.items.length && <span className="ld-small ld-muted">No docs in this folder yet.</span>}
        </div>
        <div className="gp-ovc">
          <h4>This folder</h4>
          <div className="gp-ovnums">
            <span><b>{d.totals.open}</b>open tasks</span>
            <span><b style={d.totals.overdue ? { color: "#c2253c" } : undefined}>{d.totals.overdue}</b>overdue</span>
            <span><b>{d.totals.doneThisMonth}</b>done this month</span>
          </div>
          <span className="gp-ovbar"><i style={{ width: `${pct}%` }} /></span>
          <span className="ld-small ld-muted">{pct}% of {d.totals.total} tasks done</span>
        </div>
      </div>
      <div className="gp-ovc">
        <h4>
          Lists
          <button type="button" className="gp-link" onClick={onNewList}>+ New list</button>
        </h4>
        <div className="gp-ovl h"><span>Name</span><span>Progress</span><span>Start</span><span>End</span><span>Lead</span><span>Priority</span></div>
        {d.lists.map((l) => {
          const p = l.total ? Math.round((l.done / l.total) * 100) : 0;
          return (
            <button key={l.id} type="button" className="gp-ovl" onClick={() => onPick({ scope: "list", listId: l.id })}>
              <span className="gp-ell"><b>☰ {l.name}</b></span>
              <span className="ld-row" style={{ gap: 8 }}><span className="gp-ovbar" style={{ flex: 1 }}><i style={{ width: `${p}%` }} /></span><span className="ld-small">{l.done}/{l.total}</span></span>
              <span>{l.start ? fmtYmd(l.start) : <span className="ld-small ld-muted">None</span>}</span>
              <span>{l.end ? fmtYmd(l.end) : <span className="ld-small ld-muted">None</span>}</span>
              <span className="ld-row" style={{ gap: 6 }}>{l.lead ? <><OwnerAvatar o={l.lead} size={22} /> <span className="gp-ell">{l.lead.name}</span></> : <span className="ld-small ld-muted">Nobody yet</span>}</span>
              <span>{l.priority ? <span className="gp-flag" style={{ color: PRIORITY_COLOR[l.priority] }}>⚑ {PRIORITY_TEXT[l.priority]}</span> : <span className="ld-small ld-muted">None</span>}</span>
            </button>
          );
        })}
        {!d.lists.length && <span className="ld-small ld-muted">No lists yet.</span>}
      </div>
      <div className="gp-ov2">
        <div className="gp-ovc">
          <h4>Files</h4>
          {d.files.map((f) => (
            <span key={f.id} className="gp-ovfile">
              <span aria-hidden="true">📎</span>
              <span>
                <button type="button" className="gp-link gp-ell" style={{ fontWeight: 700, textAlign: "left" }} onClick={() => setPreview({ id: f.id, name: f.name, url: f.url, kind: f.kind })}>{f.name}</button>
                <button type="button" className="ld-small gp-link gp-ell" style={{ textAlign: "left" }} onClick={() => onOpenTask(f.taskId)} title={f.taskName}>on {f.taskName}</button>
              </span>
              <span className="ld-small ld-muted">{fmtAt(f.at)}</span>
            </span>
          ))}
          {!d.files.length && <span className="ld-small ld-muted">No files on this folder's tasks yet.</span>}
          <span className="ld-small ld-muted">Files attached to any task in this folder, newest first.</span>
        </div>
        <div className="gp-ovc">
          <h4>Tasks by person</h4>
          {d.byPerson.map((p) => (
            <span key={p.name} className="gp-ovhb">
              <span className="gp-ell">{p.name}</span>
              <span><i style={{ width: `${Math.round((p.n / most) * 100)}%`, background: p.who ? (p.who.type === "employee" ? "#7c3aed" : "#1b6b4a") : "#9aa8a2" }} /></span>
              <b>{p.n}</b>
            </span>
          ))}
          {!d.byPerson.length && <span className="ld-small ld-muted">No open tasks.</span>}
          <span className="ld-small ld-muted">Open tasks in this folder.</span>
        </div>
      </div>
    </div>
  );
}
