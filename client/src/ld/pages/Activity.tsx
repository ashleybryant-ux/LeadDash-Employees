import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, FolderTabs, Page, useEmployees } from "../ui";
import { parseJson } from "../meta";

type Tab = "all" | "you" | "handoff" | "sent";
type Row = { key: string; at: Date; employeeId: number | null; text: string; tag: "handoff" | "sent" | "done" | "you"; link: string | null; btn: string };

const TAGS: Record<Row["tag"], { label: string; cls: string }> = {
  handoff: { label: "Handoff", cls: "green" },
  sent: { label: "Sent", cls: "gray" },
  done: { label: "Done", cls: "gray" },
  you: { label: "Needs you", cls: "amber" },
};
const COLS = "90px 150px minmax(0,1fr) 110px 128px";

const WAITING: Record<string, string> = {
  email_draft: "An email is ready for your approval.",
  calendar_hold: "A calendar hold is ready for your approval.",
  social_post: "A post is ready for your approval.",
  blog_post: "An article is ready for your approval.",
  speaking_pitch: "A speaking pitch is ready for your approval.",
  hiring_email: "A hiring email is ready for your approval.",
  outreach_email: "A 3-email sequence is ready for your approval.",
  lead_reply: "A reply to a new lead is ready for your approval.",
};

function dayKey(d: Date, tz: string) {
  return d.toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Every handoff, sent item and finished job across the team, newest first. */
export default function Activity() {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const { list: employees } = useEmployees();
  const on = currentOrgId > 0;
  const feed = trpc.team.activity.useQuery({ organizationId: currentOrgId }, { enabled: on, refetchInterval: 60_000 });
  const queue = trpc.publishing.listApprovalQueue.useQuery({ organizationId: currentOrgId }, { enabled: on });
  const apps = trpc.applications.list.useQuery({ organizationId: currentOrgId }, { enabled: on });
  const [tab, setTab] = React.useState<Tab>("all");

  const rows: Row[] = React.useMemo(() => {
    const out: Row[] = [];
    for (const a of feed.data ?? []) {
      out.push({ key: `a${a.id}`, at: new Date(a.createdAt), employeeId: a.employeeId, text: a.text, tag: a.kind, link: a.link, btn: "Open" });
    }
    for (const i of queue.data ?? []) {
      if (i.status !== "pending_approval") continue;
      if (i.kind === "outreach_email" && (parseJson<{ step?: number }>(i.metadata, {}).step ?? 1) > 1) continue;
      const what = i.title ? `${WAITING[i.kind] ?? "Something is ready for your approval."} ${i.title}` : WAITING[i.kind] ?? "Something is ready for your approval.";
      out.push({ key: `q${i.id}`, at: new Date(i.updatedAt ?? i.createdAt), employeeId: i.employeeId, text: what, tag: "you", link: "/approvals", btn: "Review" });
    }
    for (const a of apps.data ?? []) {
      if (a.status !== "ready") continue;
      out.push({ key: `p${a.id}`, at: new Date(a.updatedAt ?? a.createdAt), employeeId: a.employeeId, text: `Application for ${a.title} is ready. It needs your signature to submit.`, tag: "you", link: "/approvals", btn: "Review" });
    }
    return out.sort((x, y) => y.at.getTime() - x.at.getTime());
  }, [feed.data, queue.data, apps.data]);

  const inTab = (r: Row, t: Tab) => t === "all" || (t === "you" && r.tag === "you") || (t === "handoff" && r.tag === "handoff") || (t === "sent" && (r.tag === "sent" || r.tag === "done"));
  const shown = rows.filter((r) => inTab(r, tab));
  const n = (t: Tab) => rows.filter((r) => inTab(r, t)).length;

  const today = dayKey(new Date(), tz);
  const groups: { label: string; rows: Row[] }[] = [];
  for (const r of shown) {
    const k = dayKey(r.at, tz);
    const label = r.at.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const full = k === today ? `Today, ${label}` : label;
    const last = groups[groups.length - 1];
    if (last && last.label === full) last.rows.push(r);
    else groups.push({ label: full, rows: [r] });
  }

  return (
    <Page rail="activity">
      <h1 className="ld-h1">Activity</h1>
      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "all", label: `All (${n("all")})` },
          { key: "you", label: `Needs you (${n("you")})` },
          { key: "handoff", label: `Handoffs (${n("handoff")})` },
          { key: "sent", label: `Sent and posted (${n("sent")})` },
        ]}
      >
        {shown.length === 0 && <div className="ld-empty">{feed.isLoading ? "Loading..." : tab === "you" ? "Nothing needs you right now." : "Nothing here yet. Your employees' handoffs and finished work show up here."}</div>}
        {groups.map((g) => (
          <React.Fragment key={g.label}>
            <div style={{ padding: "10px 18px", fontSize: 12, fontWeight: 700, color: "#5b6b64", textTransform: "uppercase", letterSpacing: ".06em", background: "#f8fafb", borderBottom: "1px solid #e3e9e6" }}>{g.label}</div>
            {g.rows.map((r) => {
              const emp = employees.find((e) => e.id === r.employeeId);
              const tag = TAGS[r.tag];
              return (
                <div key={r.key} className="ld-rw ld-act" style={{ gridTemplateColumns: COLS }}>
                  <span className="ld-muted ld-act-time">{r.at.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}</span>
                  <span className="ld-act-who" style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, minWidth: 0 }}>
                    <Avatar name={emp?.name ?? "LeadDash"} kind={emp?.kind} src={emp?.avatar} size={26} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{emp?.name ?? "LeadDash"}</span>
                  </span>
                  <span className="ld-act-text" style={{ overflowWrap: "anywhere" }}>{r.text}</span>
                  <span className={`ld-pill ${tag.cls}`}>{tag.label}</span>
                  {r.link ? (
                    <Link href={r.link} className="ld-btn">{r.btn}</Link>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </FolderTabs>
    </Page>
  );
}
