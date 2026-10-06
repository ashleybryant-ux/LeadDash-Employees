import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate } from "../meta";
import { longDate } from "../sops/shared";

const who = (x: { name?: string; initials: string }) => (x.name && x.name.trim()) || x.initials;

const money = (cents: number) => `$${(Math.round(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const when = (iso: string, tz?: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
};

type Tab = "today" | "denials" | "unpaid" | "balances" | "eligibility";

/** Harper's Claims tab: what LeadDash EHR says needs a person, with every row opening the claim in the EHR. */
export default function Billing() {
  const { currentOrgId, currentOrg } = useTenant();
  const q = trpc.ehr.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const refresh = trpc.ehr.refresh.useMutation({ onSuccess: () => q.refetch() });
  const [tab, setTab] = React.useState<Tab>("today");
  const v = q.data;
  const s = v?.snapshot;
  const tz = currentOrg?.timezone;
  if (!v) return <main className="ld-main" style={{ padding: "20px 32px" }}><div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load."}</div></main>;
  if (!v.connected) return <main className="ld-main" style={{ padding: "20px 32px" }}><NotConnected who="Harper" what="claims, payments, balances and eligibility" /></main>;
  const tabs: { key: Tab; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "denials", label: `Denials (${s?.claims.length ?? 0})` },
    { key: "unpaid", label: `Unpaid (${s?.unpaid.reduce((n, u) => n + u.count, 0) ?? 0})` },
    { key: "balances", label: `Balances (${s?.balances.length ?? 0})` },
    { key: "eligibility", label: "Eligibility" },
  ];
  return (
    <main className="ld-main" style={{ padding: "20px 32px", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <UnderlineTabs tabs={tabs} value={tab} onChange={setTab} />
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="ld-small ld-muted">{v.fetchedAt ? `Read ${fmtDate(v.fetchedAt)}` : "Not read yet"}{v.error ? ` · last read failed` : ""}</span>
          <button type="button" className="ld-btn sm" disabled={refresh.isPending} onClick={() => refresh.mutate({ organizationId: currentOrgId })}>{refresh.isPending ? "Reading..." : "Read now"}</button>
        </span>
      </div>
      <ErrorLine error={refresh.error} />
      {v.error && <div className="ld-card" style={{ padding: "10px 14px", color: "#b42318", fontSize: 13 }}>{v.error}</div>}
      {!s && <div className="ld-empty">Connected as {v.practice}. The first read is on its way; press Read now to do it this minute.</div>}
      {s && (tab === "today" || tab === "denials") && (
        <>
          {tab === "today" && (
            <div className="ld-stats4">
              <Stat label="Denied or rejected" value={String(s.claims.length)} />
              <Stat label="Unpaid past 30 days" value={money(s.totals.unpaid30Cents)} />
              <Stat label="Client balances" value={money(s.totals.balancesCents)} />
              <Stat label="Collected this month" value={money(s.totals.collectedMonthCents)} />
            </div>
          )}
          <section className="ld-card">
            <div className="ld-sh"><span className="ld-st">Denied or rejected · fix in LeadDash EHR</span><span className="ld-small ld-muted">From the EHR, {s.generatedAt ? fmtDate(s.generatedAt) : ""}</span></div>
            <div className="ld-hd hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 110px 150px minmax(0,1.2fr) minmax(0,1.2fr) 120px" }}><span>Client</span><span>Date of service</span><span>Payer</span><span>Reason</span><span>Fix</span><span /></div>
            {s.claims.length === 0 && <div className="ld-empty">Nothing denied or rejected right now.</div>}
            {s.claims.map((c) => (
              <div key={c.id} className="ld-rw hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 110px 150px minmax(0,1.2fr) minmax(0,1.2fr) 120px", alignItems: "start" }}>
                <span className="ld-strong">{who(c)}</span>
                <span>{longDate(c.dos)}</span>
                <span>{c.payer}</span>
                <span>{c.status === "rejected" ? "Rejected: " : ""}{c.reason}</span>
                <span>{c.fix}</span>
                <a href={c.url} target="_blank" rel="noreferrer noopener" className="ld-btn p" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open in EHR</a>
              </div>
            ))}
          </section>
        </>
      )}
      {s && (tab === "today" || tab === "unpaid") && (
        <section className="ld-card">
          <div className="ld-sh"><span className="ld-st">Unpaid past 30 days · {s.unpaid.reduce((n, u) => n + u.count, 0)} claims</span><span className="ld-small ld-muted">{money(s.totals.unpaid30Cents)}</span></div>
          <div className="ld-hd hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 70px 110px minmax(0,1.2fr) 100px 120px" }}><span>Payer</span><span>Claims</span><span>Oldest</span><span>Status</span><span>Amount</span><span /></div>
          {s.unpaid.length === 0 && <div className="ld-empty">Nothing past 30 days.</div>}
          {s.unpaid.map((u) => (
            <div key={u.payer} className="ld-rw hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 70px 110px minmax(0,1.2fr) 100px 120px" }}>
              <span className="ld-strong">{u.payer}</span>
              <span>{u.count}</span>
              <span>{longDate(u.oldest)}</span>
              <span>{u.status}</span>
              <span style={{ fontWeight: 700 }}>{money(u.amountCents)}</span>
              <a href={u.url} target="_blank" rel="noreferrer noopener" className="ld-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open in EHR</a>
            </div>
          ))}
        </section>
      )}
      {s && (tab === "today" || tab === "balances") && (
        <section className="ld-card">
          <div className="ld-sh"><span className="ld-st">Client balances</span><span className="ld-small ld-muted">{s.balances.length} clients · statements go out from the EHR</span></div>
          <div className="ld-hd hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 100px 120px 110px minmax(0,0.6fr) 120px" }}><span>Client</span><span>Balance</span><span>Last payment</span><span>Card on file</span><span /><span /></div>
          {s.balances.length === 0 && <div className="ld-empty">No client balances.</div>}
          {s.balances.map((b) => (
            <div key={b.id} className="ld-rw hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 100px 120px 110px minmax(0,0.6fr) 120px" }}>
              <span className="ld-strong">{who(b)}</span>
              <span style={{ fontWeight: 700 }}>{money(b.cents)}</span>
              <span>{b.lastPayment ? longDate(b.lastPayment) : <span className="ld-muted">None</span>}</span>
              <span>{b.cardOnFile ? "Yes" : "No"}</span>
              <span />
              <a href={b.url} target="_blank" rel="noreferrer noopener" className="ld-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open in EHR</a>
            </div>
          ))}
        </section>
      )}
      {s && (tab === "today" || tab === "eligibility") && (
        <section className="ld-card">
          <div className="ld-sh"><span className="ld-st">Eligibility · this week's sessions</span><span className="ld-small ld-muted">{s.eligibility.length} checked · {s.eligibility.filter((e) => !e.ok).length} need attention</span></div>
          <div className="ld-hd hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 220px 150px minmax(0,1fr) 120px" }}><span>Client</span><span>Session</span><span>Clinician</span><span>Result</span><span /></div>
          {s.eligibility.filter((e) => tab === "eligibility" || !e.ok).length === 0 && <div className="ld-empty">{tab === "today" ? "Every check this week came back fine." : "No checks this week."}</div>}
          {s.eligibility.filter((e) => tab === "eligibility" || !e.ok).map((e) => (
            <div key={e.id} className="ld-rw hb-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 220px 150px minmax(0,1fr) 120px" }}>
              <span className="ld-strong">{who(e)}</span>
              <span>{when(e.session, tz)}</span>
              <span>{e.clinician}</span>
              <span>{e.ok ? <span className="ld-pill green">Covered</span> : e.result}</span>
              <a href={e.url} target="_blank" rel="noreferrer noopener" className={`ld-btn ${e.ok ? "" : "p"}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open in EHR</a>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ld-card" style={{ padding: "14px 16px" }}>
      <div className="ld-small ld-muted">{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function NotConnected({ who, what }: { who: string; what: string }) {
  return (
    <div className="ld-card" style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
      <span className="ld-strong" style={{ fontSize: 15 }}>LeadDash EHR is not connected</span>
      <span style={{ fontSize: 14, lineHeight: 1.5 }}>{who} reads {what} from LeadDash EHR. Connect it on Integrations with the key from Practice Settings, LeadDash Employees, and this tab fills in at the next read.</span>
      <Link href="/integrations" className="ld-btn p" style={{ width: 160, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open Integrations</Link>
    </div>
  );
}
