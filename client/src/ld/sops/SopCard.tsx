import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { StatusActions, StatusPill, StepList } from "./shared";

/** An SOP posted in chat: the first steps, Open, and Send to the reviewer. */
export function SopCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.sops.get.useQuery({ organizationId: currentOrgId, id }, { enabled: currentOrgId > 0 });
  const s = q.data;
  if (!s) return <div className="ld-card" style={{ padding: 14 }}><span className="ld-small ld-muted">{q.isLoading ? "Loading..." : "This SOP is gone."}</span></div>;
  return (
    <div className="ld-card sop-card">
      <div className="sop-hd">
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <b>{s.title}</b>
          <span className="ld-small ld-muted">{s.areaLabel} · {s.steps.length} step{s.steps.length === 1 ? "" : "s"} · owner {s.ownerName}</span>
        </span>
        <StatusPill s={s} />
      </div>
      <div style={{ padding: "12px 14px" }}>
        <StepList steps={s.steps} limit={3} small />
      </div>
      <div className="sop-ft">
        <Link href={`/handbook/sop/${s.id}`} className="ld-btn p" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open the draft</Link>
        <StatusActions sop={s} reviewerName={s.reviewerName} />
      </div>
    </div>
  );
}
