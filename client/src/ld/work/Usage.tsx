import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, FolderTabs, PersonAvatar } from "../ui";

type Tab = "this" | "last" | "person";
const num1 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
/** "30 min", "1 hr", "8 hr", "1.5 hr". */
const hoursText = (minutes: number) => (minutes < 60 ? `${Math.round(minutes)} min` : `${num1(minutes / 60)} hr`);

const tile: React.CSSProperties = { border: "1px solid var(--ld-line)", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, background: "var(--ld-surface)", minWidth: 0 };
const lbl: React.CSSProperties = { fontSize: 13, color: "var(--ld-muted)", fontWeight: 600 };
const num: React.CSSProperties = { fontSize: 28, fontWeight: 800, color: "var(--ld-ink)", lineHeight: 1.1 };
const head: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ld-muted)" };
const COLS = "40px minmax(0,1fr) 90px 70px";
const JOB_COLS = "36px minmax(0,1fr) 120px 72px";

/** Work hours: what's left on the plan, hours used, jobs done and chats, recent jobs and each employee's hours. No dollar amounts. */
export function UsageCard() {
  const { currentOrgId, currentOrg } = useTenant();
  const role = (currentOrg as { role?: string } | null)?.role;
  const manager = role === "owner" || role === "admin";
  const [tab, setTab] = React.useState<Tab>("this");
  const q = trpc.usage.summary.useQuery({ organizationId: currentOrgId, back: tab === "last" ? 1 : 0 }, { enabled: currentOrgId > 0 && tab !== "person" });
  const h = trpc.hours.get.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const recent = trpc.hours.recent.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 && tab === "this" });
  const u = q.data;
  const b = h.data;
  const rows = (u?.employees ?? []).filter((e) => e.tasks > 0);
  return (
    <section className="ld-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="ld-between">
        <span className="ld-st">Usage</span>
        {b && <span className="ld-small ld-muted">{b.metered ? `${b.planName} plan · resets ${b.resetsOn}` : b.month}</span>}
      </div>
      <FolderTabs
        tabs={[
          { key: "this" as Tab, label: "This month" },
          { key: "last" as Tab, label: "Last month" },
          { key: "person" as Tab, label: "By person" },
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === "person" ? (
          <ByPerson />
        ) : !u ? (
          <div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load usage."}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
            {tab === "this" && b?.metered && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="ld-between" style={{ gap: 12, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 15, color: b.out ? "var(--ld-bad)" : undefined }}>
                    {num1((b.planLeftMinutes ?? 0) / 60)} of {num1((b.planMinutes ?? 0) / 60)} work hours left
                  </b>
                  {manager && (
                    <a className="ld-btn" style={{ width: 110, textDecoration: "none", color: "var(--ld-ink)", display: "inline-flex", alignItems: "center", justifyContent: "center" }} href={`${b.pricingUrl}#hours${b.healthcare ? "-healthcare" : ""}`} target="_blank" rel="noreferrer">
                      Add hours
                    </a>
                  )}
                </div>
                <div className="ld-hours-bar" role="progressbar" aria-label="Work hours left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(((b.planLeftMinutes ?? 0) / Math.max(1, b.planMinutes ?? 0)) * 100)}>
                  <i style={{ width: `${Math.min(100, Math.round(((b.planLeftMinutes ?? 0) / Math.max(1, b.planMinutes ?? 0)) * 100))}%` }} />
                </div>
                {b.packMinutes > 0 && <span className="ld-small ld-muted">Plus {num1(b.packMinutes / 60)} bought hours, good through {b.packsGoodThrough}</span>}
              </div>
            )}
            <div className="ld-usage-tiles ld-keep" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12 }}>
              <div style={tile}>
                <span style={lbl}>Work hours used</span>
                <span style={num}>{num1(u.hours)}</span>
              </div>
              <div style={tile}>
                <span style={lbl}>Jobs done</span>
                <span style={num}>{u.tasks.toLocaleString("en-US")}</span>
              </div>
              <div style={tile}>
                <span style={lbl}>Chats</span>
                <span style={num}>{(u.chats ?? 0).toLocaleString("en-US")}</span>
              </div>
            </div>
            {tab === "this" ? (
              <RecentJobs rows={recent.data ?? []} loading={recent.isLoading} month={u.month} />
            ) : rows.length === 0 ? (
              <div className="ld-empty">{`No work in ${u.month}.`}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, padding: "0 0 6px", ...head }}>
                  <span />
                  <span>Employee</span>
                  <span style={{ textAlign: "right" }}>Work hours</span>
                  <span style={{ textAlign: "right" }}>Jobs</span>
                </div>
                {rows.map((e) => (
                  <div key={e.id} className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: COLS, gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--ld-line2)", fontSize: 14 }}>
                    <Avatar name={e.name} kind={e.kind} src={e.avatar} size={36} />
                    <span style={{ minWidth: 0 }}>
                      <b>{e.name}</b>
                      <span className="ld-small ld-muted" style={{ display: "block" }}>{e.roleTitle}</span>
                    </span>
                    <span style={{ textAlign: "right", fontWeight: 700 }}>{num1(e.hours)}</span>
                    <span style={{ textAlign: "right" }}>{e.tasks}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </FolderTabs>
      <ErrorLine error={q.error ?? h.error} />
    </section>
  );
}

type Job = { id: number; employee: { id: number; name: string; kind: string; avatar: string | null } | null; what: string; minutes: number; charged: boolean; at: string };

/** This month's jobs, newest first, each with the work hours it used. A job that didn't finish shows as not charged. */
function RecentJobs({ rows, loading, month }: { rows: Job[]; loading: boolean; month: string }) {
  if (!rows.length) return <div className="ld-empty">{loading ? "Loading..." : `No jobs yet in ${month}.`}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ ...head, paddingBottom: 6 }}>Recent jobs</span>
      {rows.map((j) => (
        <div key={j.id} className="ld-job-row" style={{ display: "grid", gridTemplateColumns: JOB_COLS, gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--ld-line2)", fontSize: 14 }}>
          {j.employee ? <Avatar name={j.employee.name} kind={j.employee.kind} src={j.employee.avatar} size={32} /> : <span />}
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {j.employee && <b>{j.employee.name} · </b>}
            {j.what}
            {!j.charged && <span className="ld-pill amber" style={{ marginLeft: 8 }}>Not charged</span>}
          </span>
          <span className="ld-small ld-muted">{j.at}</span>
          <span style={{ textAlign: "right", fontWeight: 700, ...(j.charged ? {} : { color: "var(--ld-soft)", textDecoration: "line-through", fontWeight: 600 }) }}>{hoursText(j.minutes)}</span>
        </div>
      ))}
    </div>
  );
}

const PCOLS = "40px minmax(0,1fr) 100px 100px 190px";

/** Each person's work hours this month against their limit, with scheduled work on its own row. */
function ByPerson() {
  const { currentOrgId } = useTenant();
  const q = trpc.usage.byPerson.useQuery({ organizationId: currentOrgId, back: 0 }, { enabled: currentOrgId > 0 });
  const r = q.data;
  if (!r) return <div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load usage."}</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
      <div className="ld-usage-tiles ld-keep" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12 }}>
        <div style={tile}>
          <span style={lbl}>Work hours used</span>
          <span style={num}>{num1(r.total)}</span>
        </div>
        <div style={tile}>
          <span style={lbl}>Asked for by people</span>
          <span style={num}>{num1(r.people)}</span>
        </div>
        <div style={tile}>
          <span style={lbl}>Scheduled work</span>
          <span style={num}>{num1(r.scheduled)}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: PCOLS, gap: 12, padding: "0 0 6px", ...head }}>
          <span />
          <span>Person</span>
          <span style={{ textAlign: "right" }}>Work hours</span>
          <span style={{ textAlign: "right" }}>Limit</span>
          <span>Used</span>
        </div>
        {r.rows.map((p) => {
          const pct = p.pct == null ? null : Math.min(100, p.pct);
          const color = p.pct != null && p.pct >= 100 ? "var(--ld-bad)" : p.pct != null && p.pct >= 80 ? "#e88a3a" : "var(--ld-accent)";
          return (
            <div key={p.userId} className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: PCOLS, gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--ld-line2)", fontSize: 14 }}>
              <PersonAvatar name={p.name} src={p.avatarUrl} size={36} />
              <b style={{ minWidth: 0, overflowWrap: "anywhere" }}>{p.name}</b>
              <span style={{ textAlign: "right", fontWeight: 700 }}>{num1(p.hours)}</span>
              <span style={{ textAlign: "right", color: p.limit == null ? "var(--ld-muted)" : undefined }}>{p.limit == null ? "No limit" : `${num1(p.limit)} hr`}</span>
              {pct == null ? (
                <span />
              ) : (
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--ld-line2)", overflow: "hidden" }}>
                    <span style={{ display: "block", width: `${pct}%`, height: "100%", background: color }} />
                  </span>
                  <span style={{ fontSize: 12.5, width: 40, textAlign: "right", color: p.pct! >= 100 ? "var(--ld-bad)" : undefined, fontWeight: p.pct! >= 100 ? 700 : 400 }}>{p.pct}%</span>
                </span>
              )}
            </div>
          );
        })}
        <div className="ld-usage-row ld-keep" style={{ display: "grid", gridTemplateColumns: PCOLS, gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--ld-line2)", fontSize: 14 }}>
          <span />
          <span>
            <b>Scheduled work</b>
            <span className="ld-small ld-muted" style={{ display: "block" }}>Daily searches, reports and meeting notes</span>
          </span>
          <span style={{ textAlign: "right", fontWeight: 700 }}>{num1(r.scheduled)}</span>
          <span style={{ textAlign: "right", color: "var(--ld-muted)" }}>No limit</span>
          <span />
        </div>
      </div>
      <ErrorLine error={q.error} />
    </div>
  );
}
