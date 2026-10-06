import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { Outputs } from "../types";

export type SopRow = Outputs["sops"]["list"]["sops"][number];
export type SopFull = Outputs["sops"]["get"];
export type SopStep = { title: string; detail: string; imageUrl: string | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YYYY-MM-DD to "Oct 6, 2026". */
export function longDate(ymd: string | null | undefined) {
  if (!ymd) return "";
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** YYYY-MM-DD to the typed form, MM/DD/YYYY. */
export function mdy(ymd: string | null | undefined) {
  if (!ymd) return "";
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ymd;
}

export function StatusPill({ s }: { s: Pick<SopRow, "status" | "statusLabel" | "reviewDue"> }) {
  const cls = s.reviewDue ? "amber" : s.status === "current" ? "green" : s.status === "review" ? "blue" : s.status === "writing" ? "purple" : "gray";
  return <span className={`ld-pill ${cls}`}>{s.statusLabel}</span>;
}

export function Shot({ url, alt, small }: { url: string | null; alt: string; small?: boolean }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={`sop-shot ${small ? "s" : ""}`}>
      <img src={url} alt={alt} loading="lazy" />
    </a>
  );
}

/** The step list, read view. */
export function StepList({ steps, limit, small }: { steps: SopStep[]; limit?: number; small?: boolean }) {
  const shown = limit ? steps.slice(0, limit) : steps;
  return (
    <div className="sop-steps">
      {shown.map((st, i) => (
        <div key={i} className="sop-step">
          <span className="sop-n">{i + 1}</span>
          <div style={{ minWidth: 0 }}>
            <div className="sop-st">{st.title}</div>
            {st.detail && <div className="sop-sd">{st.detail}</div>}
          </div>
          <Shot url={st.imageUrl} alt={`Step ${i + 1}`} small={small} />
        </div>
      ))}
      {limit && steps.length > limit && <div className="ld-small ld-muted" style={{ paddingLeft: 42 }}>{steps.length - limit} more step{steps.length - limit === 1 ? "" : "s"}</div>}
    </div>
  );
}

/** Buttons that move an SOP along: Send for review, Approve, Mark reviewed. */
export function StatusActions({ sop, onDone, reviewerName }: { sop: Pick<SopRow, "id" | "status" | "reviewDue">; onDone?: () => void; reviewerName?: string | null }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const [error, setError] = React.useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([utils.sops.list.invalidate(), utils.sops.get.invalidate()]);
    onDone?.();
  };
  const set = trpc.sops.setStatus.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });
  const reviewed = trpc.sops.reviewed.useMutation({ onSuccess: refresh, onError: (e) => setError(e.message) });
  const busy = set.isPending || reviewed.isPending;
  return (
    <>
      {sop.status === "draft" && <button type="button" className="ld-btn p" disabled={busy} onClick={() => set.mutate({ organizationId: currentOrgId, id: sop.id, status: "review" })}>{reviewerName ? `Send to ${reviewerName}` : "Send for review"}</button>}
      {sop.status === "review" && <button type="button" className="ld-btn p" disabled={busy} onClick={() => set.mutate({ organizationId: currentOrgId, id: sop.id, status: "current" })}>Approve</button>}
      {sop.status === "review" && <button type="button" className="ld-btn" disabled={busy} onClick={() => set.mutate({ organizationId: currentOrgId, id: sop.id, status: "draft" })}>Back to draft</button>}
      {sop.status === "current" && sop.reviewDue && <button type="button" className="ld-btn p" disabled={busy} onClick={() => reviewed.mutate({ organizationId: currentOrgId, id: sop.id })}>Mark reviewed</button>}
      {sop.status === "current" && <button type="button" className="ld-btn" disabled={busy} onClick={() => set.mutate({ organizationId: currentOrgId, id: sop.id, status: "retired" })}>Retire</button>}
      {error && <span className="ld-small" style={{ color: "#b42318" }}>{error}</span>}
    </>
  );
}
