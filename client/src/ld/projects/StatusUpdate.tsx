import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt } from "../goals/shared";

/**
 * A status update on a project or a portfolio, the way Asana does it: On
 * track, At risk, Off track or On hold, with a summary, accomplishments,
 * blockers and next steps. Nora can draft it from the tasks.
 */

export type StatusKey = "on" | "risk" | "off" | "hold";
export const STATUS_TEXT: Record<StatusKey, string> = { on: "On track", risk: "At risk", off: "Off track", hold: "On hold" };

const ago = (d: Date | string) => {
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return fmtAt(d);
};

export function StatusPill({ status, at, by, size }: { status: StatusKey | null | undefined; at?: Date | string | null; by?: string; size?: "sm" }) {
  if (!status) return <span className={`gp-status none ${size ?? ""}`}>No status</span>;
  return (
    <span className="gp-statuswrap">
      <span className={`gp-status ${status} ${size ?? ""}`}>{STATUS_TEXT[status]}</span>
      {at && <span className="ld-small ld-muted">{by ? `${by}, ` : ""}{ago(at)}</span>}
    </span>
  );
}

type Highlight = { itemId: number; name: string; status: StatusKey };

export function StatusUpdate({ orgId, kind, itemId, name, highlights = [], onClose }: { orgId: number; kind: "list" | "portfolio"; itemId: number; name: string; highlights?: Highlight[]; onClose: () => void }) {
  const [status, setStatus] = React.useState<StatusKey>("on");
  const [summary, setSummary] = React.useState("");
  const [acc, setAcc] = React.useState("");
  const [blockers, setBlockers] = React.useState("");
  const [next, setNext] = React.useState("");
  const [withHighlights, setWithHighlights] = React.useState(highlights.length > 0);
  const post = trpc.pj.postStatus.useMutation({ onSuccess: onClose });
  const draft = trpc.pj.draftStatus.useMutation({
    onSuccess: (d) => {
      setStatus(d.status);
      setSummary(d.summary);
      setAcc(d.accomplishments ?? "");
      setBlockers(d.blockers ?? "");
      setNext(d.next ?? "");
    },
  });
  const ta = (label: string, value: string, set: (v: string) => void, rows = 2) => (
    <label className="gp-sfield">
      <span className="gp-sub-h">{label}</span>
      <textarea className="ld-ta" rows={rows} aria-label={label} value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Status update for ${name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox" style={{ width: 560 }}>
        <div className="ld-between gp-mhead">
          <span>
            <b style={{ fontSize: 17 }}>Status update</b>
            <span className="ld-small ld-muted" style={{ display: "block" }}>{name}</span>
          </span>
          <button type="button" className="ld-btn sm gp-auto" disabled={draft.isPending} onClick={() => draft.mutate({ organizationId: orgId, kind, itemId })}>{draft.isPending ? "Nora is drafting" : "Ask Nora to draft it"}</button>
        </div>
        <div style={{ padding: "6px 20px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="ld-row" role="radiogroup" aria-label="Status" style={{ flexWrap: "wrap" }}>
            {(["on", "risk", "off", "hold"] as StatusKey[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={status === k} className={`gp-schoice ${status === k ? `on ${k}` : ""}`} onClick={() => setStatus(k)}>{STATUS_TEXT[k]}</button>
            ))}
          </div>
          {ta("Summary", summary, setSummary, 3)}
          {ta("Accomplishments", acc, setAcc)}
          {ta("Blockers", blockers, setBlockers)}
          {ta("Next steps", next, setNext)}
          {highlights.length > 0 && (
            <label className="ld-row ld-small" style={{ gap: 6 }}>
              <input type="checkbox" checked={withHighlights} onChange={(e) => setWithHighlights(e.target.checked)} />
              Add project highlights ({highlights.map((h) => `${h.name}: ${STATUS_TEXT[h.status]}`).join("; ")})
            </label>
          )}
          <span className="ld-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p sm gp-auto" disabled={!summary.trim() || post.isPending} onClick={() => post.mutate({ organizationId: orgId, kind, itemId, status, summary, accomplishments: acc, blockers, next, highlights: withHighlights ? highlights : [] })}>Post update</button>
          </span>
          <ErrorLine error={post.error || draft.error} />
        </div>
      </div>
    </div>
  );
}

/** Past updates, newest first. */
export function StatusHistory({ orgId, kind, itemId }: { orgId: number; kind: "list" | "portfolio"; itemId: number }) {
  const q = trpc.pj.statusUpdates.useQuery({ organizationId: orgId, kind, itemId });
  const rows = q.data?.updates ?? [];
  if (!rows.length) return <div className="gp-empty">No status updates yet.</div>;
  return (
    <div className="gp-shist">
      {rows.map((u) => (
        <div key={u.id} className="gp-supd">
          <div className="ld-row" style={{ gap: 10 }}>
            <StatusPill status={u.status} />
            <b>{u.authorName}</b>
            <span className="ld-small ld-muted">{fmtAt(u.at)}</span>
          </div>
          <p>{u.summary}</p>
          {u.accomplishments && <p><b>Accomplishments.</b> {u.accomplishments}</p>}
          {u.blockers && <p><b>Blockers.</b> {u.blockers}</p>}
          {u.next && <p><b>Next steps.</b> {u.next}</p>}
          {u.highlights.length > 0 && (
            <div className="ld-row" style={{ flexWrap: "wrap", gap: 6 }}>
              {u.highlights.map((h) => (
                <span key={h.itemId} className="ld-small"><StatusPill status={h.status} size="sm" /> {h.name}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
