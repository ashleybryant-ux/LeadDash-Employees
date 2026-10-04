import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";

/** Taylor's newsroom in chat: the Monday briefing, a rapid-response story, a planned campaign. */

const workTab = "/chats/speaking/work";

export function PressBriefCard() {
  const { currentOrgId } = useTenant();
  const v = trpc.newsroom.view.useQuery({ organizationId: currentOrgId }).data;
  if (!v) return null;
  const me = v.counts.find((c) => c.orgId === currentOrgId);
  if (!me) return null;
  const parts = [
    `${me.stories} open ${me.stories === 1 ? "story" : "stories"}`,
    `${me.newReporters} new reporters qualified`,
    me.moved ? `${me.moved} changed outlets` : "",
    `${me.ready} ${me.ready === 1 ? "pitch" : "pitches"} ready`,
    `${me.followUps} ${me.followUps === 1 ? "follow-up" : "follow-ups"} due`,
    me.replies ? `${me.replies} ${me.replies === 1 ? "reply" : "replies"} to answer` : "",
    me.interviews ? `${me.interviews} upcoming ${me.interviews === 1 ? "interview" : "interviews"}` : "",
  ].filter(Boolean);
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.7, minWidth: 0 }}>
        <b>Week of {fmtDate(new Date())}</b>
        <span>{parts.join(" · ")}</span>
        {v.counts.length > 1 && <span className="ld-small">Other desks: {v.counts.filter((c) => c.orgId !== currentOrgId).map((c) => `${c.name} (${c.ready} ready, ${c.stories} stories)`).join("; ")}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Link href={workTab} className="ld-btn p ld-av-link-plain">Open newsroom</Link>
      </div>
    </div>
  );
}

export function PressStoryCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const v = trpc.newsroom.view.useQuery({ organizationId: currentOrgId }).data;
  const pitches = trpc.newsroom.pitches.useQuery({ organizationId: currentOrgId }).data ?? [];
  const approve = trpc.newsroom.approvePitch.useMutation();
  const [busy, setBusy] = React.useState(false);
  const s = v?.stories.find((x) => x.id === id);
  if (!s) return null;
  const mine = pitches.filter((p) => p.storyId === id);
  const ready = mine.filter((p) => p.status === "ready" && p.email);
  const approveAll = async () => {
    setBusy(true);
    try {
      for (const p of ready) await approve.mutateAsync({ organizationId: currentOrgId, id: p.id });
    } finally {
      setBusy(false);
      await utils.newsroom.invalidate();
    }
  };
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.6, minWidth: 0 }}>
        <b>{s.title}</b>
        {s.quote && <span><b>Your comment (from your quote bank):</b> "{s.quote}"</span>}
        <span className="ld-small">{mine.length} {mine.length === 1 ? "pitch" : "pitches"} · {mine.filter((p) => p.score >= 85).length} passed the pitch check · window ends {s.windowEnds || "soon"}</span>
        {s.skipped.map((x) => (
          <div key={x.contactId} style={{ background: "#fdf6ee", border: "1px solid #f1dcc4", borderRadius: 10, padding: "8px 12px", fontSize: 13 }}><b>Skipped {x.name}.</b> {x.reason}. Free again {fmtDate(x.until)}.</div>
        ))}
        <ErrorLine error={approve.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ready.length > 0 && <button type="button" className="ld-btn p" disabled={busy || v?.settings.paused} onClick={() => void approveAll()}>{busy ? "Sending..." : `Approve all ${ready.length}`}</button>}
        <Link href={workTab} className="ld-btn ld-av-link-plain">Review each</Link>
      </div>
    </div>
  );
}

export function PressCampaignCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const c = (trpc.newsroom.campaigns.useQuery({ organizationId: currentOrgId }).data ?? []).find((x) => x.id === id);
  if (!c) return null;
  return (
    <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.6, minWidth: 0 }}>
        <b>{c.title}</b>
        <span>{c.plan.story}</span>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.6, listStyle: "decimal" }}>
          {c.angles.map((a, i) => <li key={i} style={{ color: a.use ? "#14221c" : "#5b6b64" }}>{a.text}{a.use ? " (using)" : ""}</li>)}
        </ol>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Link href={`${workTab}?tab=campaigns`} className="ld-btn p ld-av-link-plain">Open</Link>
      </div>
    </div>
  );
}
