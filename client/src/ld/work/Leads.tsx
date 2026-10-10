import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import type { Outputs } from "../types";

type Lead = Outputs["sales"]["leads"][number];
type Tab = "new" | "replied" | "booked" | "closed" | "lapsed";
const TABS: { key: Tab; label: string }[] = [
  { key: "new", label: "New" },
  { key: "replied", label: "Replied" },
  { key: "booked", label: "Booked" },
  { key: "closed", label: "Closed" },
];
const COLS = "minmax(0,1.6fr) minmax(0,1.2fr) 150px 150px 128px 128px";

function when(d: Date | string | null | undefined, tz: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", { timeZone: tz, ...opts }).replace(/, (\d{1,2}:\d{2})/, ", $1");
}
const long = (d: Date | string | null | undefined, tz: string) => (d ? new Date(d).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/, (\d{1,2}:\d{2})/, " at $1") : "");

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

function status(l: Lead, tz: string) {
  if (l.status === "booked") return { label: `Booked ${when(l.bookedFor, tz, { month: "short", day: "numeric" })}`, cls: "green" };
  if (l.status === "replied") return { label: "Replied", cls: "green" };
  if (l.status === "closed") return { label: "Closed", cls: "gray" };
  if (l.reply?.status === "pending_approval") return { label: "Reply waiting", cls: "amber" };
  if (l.reply?.status === "scheduled") return { label: "Replies at 8 AM", cls: "amber" };
  return { label: "New", cls: "amber" };
}

/** Malik's Work tab: new leads, his replies, and booked meetings. */
export default function Leads({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const utils = trpc.useUtils();
  const healthcare = currentOrg?.orgType === "healthcare";
  const q = trpc.sales.leads.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 30_000 });
  const ehr = trpc.ehr.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 && healthcare, refetchInterval: 60_000 });
  const lapsed = ehr.data?.snapshot?.lapsed ?? [];
  const [tab, setTab] = React.useState<Tab>("new");
  const [open, setOpen] = React.useState<number | null>(null);
  const refresh = () => Promise.all([utils.sales.leads.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const close = trpc.sales.closeLead.useMutation({ onSuccess: refresh });
  const send = trpc.publishing.approveAndDispatch.useMutation({ onSuccess: refresh });

  const all = q.data ?? [];
  const shown = all.filter((l) => l.status === tab);

  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <FolderTabs value={tab} onChange={(k) => { setTab(k); setOpen(null); }} tabs={[...TABS.map((t) => ({ key: t.key as Tab, label: `${t.label} (${all.filter((l) => l.status === t.key).length})` })), ...(healthcare ? [{ key: "lapsed" as Tab, label: `Not booked (${lapsed.length})` }] : [])]}>
        {tab === "lapsed" && <Lapsed rows={lapsed} connected={!!ehr.data?.connected} loading={ehr.isLoading} />}
        {tab !== "lapsed" && <><div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Lead</span>
          <span>Came from</span>
          <span>Came in</span>
          <span>Status</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : tab === "new" ? "No new leads. Set up where leads come from on the Onboarding tab." : "Nothing here yet."}</div>}
        {shown.map((l) => {
          const isOpen = open === l.id;
          const st = status(l, tz);
          const mins = l.reply?.publishedAt ? Math.max(1, Math.round((new Date(l.reply.publishedAt).getTime() - new Date(l.createdAt).getTime()) / 60_000)) : null;
          const waiting = l.reply?.status === "pending_approval";
          return (
            <React.Fragment key={l.id}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a")) return; setOpen(isOpen ? null : l.id); }}>
                <span className="ld-strong">{[l.name, l.company].filter(Boolean).join(" · ")}</span>
                <span>{l.source}</span>
                <span>{when(l.createdAt, tz)}</span>
                <span className={`ld-pill ${st.cls}`}>{st.label}</span>
                {waiting ? (
                  <button type="button" className="ld-btn p" disabled={send.isPending} onClick={() => send.mutate({ organizationId: currentOrgId, itemId: l.reply!.id, action: "approve_for_dispatch" })}>Send reply</button>
                ) : (
                  <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : l.id)}>{isOpen ? "Close" : "Open"}</button>
                )}
                {l.status !== "closed" ? <button type="button" className="ld-btn" disabled={close.isPending} onClick={() => close.mutate({ organizationId: currentOrgId, id: l.id })}>Close lead</button> : <span />}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <KV label="They wrote">{l.message || "No message."}</KV>
                    {l.company && <KV label="Practice or company">{l.company}</KV>}
                    <KV label="Contact">{[l.email, l.phone].filter(Boolean).join(" · ") || "None given"}</KV>
                    <KV label="Came in">{`${l.source}, ${long(l.createdAt, tz)}`}</KV>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                    {l.reply ? (
                      <>
                        <KV label={`${emp.name} replied`}>
                          {l.reply.publishedAt ? `${long(l.reply.publishedAt, tz)}${mins !== null && mins <= 120 ? `, ${mins} minute${mins === 1 ? "" : "s"} later` : ""}` : waiting ? "Waiting for your approval" : l.reply.scheduledFor ? `Goes out ${long(l.reply.scheduledFor, tz)}` : "Not sent"}
                        </KV>
                        <div style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "var(--ld-surface)", padding: "12px 14px", fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{l.reply.body}</div>
                      </>
                    ) : (
                      <KV label={`${emp.name} replied`}>{l.source === "Reply to outreach" ? "They replied to Jada's email. Answer from your Gmail." : "No reply yet. Connect Google on Integrations so replies can go out."}</KV>
                    )}
                    {l.bookedFor && (
                      <KV label="Booked">
                        {long(l.bookedFor, tz)}, on your Google Calendar
                        {l.eventUrl ? <> · <a href={l.eventUrl} target="_blank" rel="noreferrer noopener">Open</a></> : null}
                      </KV>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {waiting && <button type="button" className="ld-btn p" disabled={send.isPending} onClick={() => send.mutate({ organizationId: currentOrgId, itemId: l.reply!.id, action: "approve_for_dispatch" })}>Send reply</button>}
                    <button type="button" className="ld-btn" onClick={() => setOpen(null)}>Close</button>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        {(close.error || send.error) && <div style={{ padding: "8px 18px" }}><ErrorLine error={close.error || send.error} /></div>}</>}
      </FolderTabs>
    </main>
  );
}

const LQ = "minmax(0,1fr) 140px 110px minmax(0,1fr) 120px";
const longDate = (ymd: string) => {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ymd;
};

/** Active clients with no kept appointment in 30 days and nothing booked, from LeadDash EHR. Named here; the chart opens in the EHR. */
function Lapsed({ rows, connected, loading }: { rows: { id: string; name?: string; initials: string; lastSeen: string; days: number; clinician: string; url: string }[]; connected: boolean; loading: boolean }) {
  if (!connected) return <div className="ld-empty">{loading ? "Loading..." : "LeadDash EHR is not connected. Connect it on Integrations and this list fills in at the next read."}</div>;
  return (
    <>
      <div className="ld-hd" style={{ gridTemplateColumns: LQ }}>
        <span>Client</span>
        <span>Last seen</span>
        <span>Days</span>
        <span>Clinician</span>
        <span />
      </div>
      {rows.length === 0 && <div className="ld-empty">Every active client has been seen in the last 30 days or has a session booked.</div>}
      {rows.map((r) => (
        <div key={r.id} className="ld-rw" style={{ gridTemplateColumns: LQ }}>
          <span className="ld-strong">{(r.name && r.name.trim()) || r.initials}</span>
          <span>{longDate(r.lastSeen)}</span>
          <span className={`ld-pill ${r.days >= 60 ? "red" : "amber"}`}>{r.days} days</span>
          <span>{r.clinician || <span className="ld-muted">Not recorded</span>}</span>
          <a href={r.url} target="_blank" rel="noreferrer noopener" className="ld-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open in EHR</a>
        </div>
      ))}
    </>
  );
}
