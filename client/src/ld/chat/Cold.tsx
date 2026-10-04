import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";

/** Jada's cold email in chat: a hot lead the moment it lands, the weekly review, and a pre-call report (any employee). */

const work = "/chats/outreach/work";
const GRID: React.CSSProperties = { padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" };

export function ColdHotCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const r = trpc.cold.reply.useQuery({ organizationId: currentOrgId, id }).data;
  const send = trpc.cold.sendReply.useMutation({ onSuccess: () => utils.cold.invalidate() });
  if (!r) return null;
  const l = r.lead;
  return (
    <div className="ld-card ld-resultcard" style={{ ...GRID, background: "#fdf6ee", borderColor: "#f1dcc4" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.6, minWidth: 0 }}>
        <b>{l ? `${l.name}${l.practice ? `, ${l.practice}` : ""}` : "A lead"}</b>
        {l && <span>{[l.signals?.clinicians ? `${l.signals.clinicians} clinicians` : "", [l.city, l.state].filter(Boolean).join(", "), l.signals?.ehr?.name, l.fit != null ? `Fit ${l.fit}` : ""].filter(Boolean).join(" · ")}</span>}
        <span>"{r.text.split("\n").find((x) => x.trim())?.slice(0, 280)}"</span>
        {r.draft && <span className="ld-small" style={{ color: "#5b6b64", whiteSpace: "pre-line" }}>{r.status === "sent" ? "Sent: " : "Jada's answer: "}{r.draft}</span>}
        <ErrorLine error={send.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {r.status === "open" && r.draft && <button type="button" className="ld-btn p" disabled={send.isPending} onClick={() => send.mutate({ organizationId: currentOrgId, id })}>{send.isPending ? "Sending..." : "Approve"}</button>}
        {r.status === "sent" && <span className="ld-pill green" style={{ alignSelf: "flex-start" }}>Sent</span>}
        <Link href={`${work}?tab=replies`} className="ld-btn ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}

export function ColdReviewCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const r = trpc.cold.review.useQuery({ organizationId: currentOrgId, id }).data;
  const apply = trpc.cold.applyReview.useMutation({ onSuccess: () => utils.cold.invalidate() });
  if (!r) return null;
  return (
    <div className="ld-card ld-resultcard" style={GRID}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.6, minWidth: 0 }}>
        <b>Weekly review, {fmtDate(r.at)}</b>
        <ol style={{ margin: 0, paddingLeft: 20, listStyle: "decimal" }}>{r.points.map((p, i) => <li key={i}>{p}</li>)}</ol>
        {r.changes.length > 0 && (
          <span className="ld-small" style={{ color: "#3d4c45" }}>
            {r.status === "applied" ? "Made: " : "Proposed: "}
            {r.changes.map((c) => (c.kind === "share" ? `${c.campaign} to ${c.share}%` : c.kind === "pause" ? `pause ${c.campaign}` : `${c.campaign}: keep subject ${String(c.version).toUpperCase()}`)).join("; ")}.
          </span>
        )}
        <ErrorLine error={apply.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {r.status === "waiting" && <button type="button" className="ld-btn p" disabled={apply.isPending} onClick={() => apply.mutate({ organizationId: currentOrgId, id })}>Approve changes</button>}
        <Link href={work} className="ld-btn ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}

export function PrecallCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const r = trpc.precall.get.useQuery({ organizationId: currentOrgId, id }).data;
  if (!r) return null;
  const rep = r.report;
  return (
    <div className="ld-card ld-resultcard" style={GRID}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.6, minWidth: 0 }}>
        <b>Pre-call report: {[r.person, r.practice].filter(Boolean).join(", ")}</b>
        {r.meetingAt && <span>Meeting {fmtDate(r.meetingAt)}</span>}
        {r.status === "running" ? <span>Researching...</span> : r.status === "failed" ? <span style={{ color: "#b42318" }}>{r.error}</span> : (
          <>
            {rep.brief.summary && <span>{rep.brief.summary}</span>}
            {rep.demo.leadWith && <span><b>Lead with:</b> {rep.demo.leadWith}</span>}
            {rep.demo.dontLeadWith && <span><b>Don't lead with:</b> {rep.demo.dontLeadWith}</span>}
          </>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Link href={`${work}?tab=precall&report=${id}`} className="ld-btn p ld-av-link-plain">Open report</Link>
      </div>
    </div>
  );
}
