import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import { fmtDate } from "../meta";
import { SevPill } from "../chat/Platform";

/**
 * Zara's work: the last audit of the LeadDash platform's workflows. Needs
 * fixing lists each problem with how the workflow runs now and the one fix
 * (Fix makes it); Fixed keeps the history; All workflows is everything read.
 */

const COLS = "minmax(0,1.4fr) minmax(0,2fr) 120px 128px";

function StatusCard({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.platform.overview.useQuery({ organizationId: currentOrgId });
  const audit = trpc.platform.audit.useMutation({ onSuccess: () => Promise.all([utils.platform.overview.invalidate(), utils.chat.list.invalidate()]) });
  const o = q.data;
  return (
    <div className="ld-card ld-av-set">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span className="ld-lbl">LeadDash platform</span>
        {!o ? (
          <span style={{ fontSize: 14 }}>Loading...</span>
        ) : !o.login ? (
          <span style={{ fontSize: 14, lineHeight: 1.5 }}>
            Add the LeadDash platform on <Link href="/integrations" style={{ color: "var(--ld-accent-dark)", fontWeight: 700 }}>Integrations</Link> under Website logins, locked to the LeadDash sub-account. Then {emp.name} can start.
          </span>
        ) : (
          <>
            <span style={{ fontSize: 14 }}>{o.login.name} · {o.login.lockName} sub-account only</span>
            <span className="ld-small" style={{ color: "var(--ld-text2)" }}>
              {o.auditing ? `${emp.name} is reading your workflows now. Watch in Chat.` : o.auditedAt ? `Last audit ${fmtDate(o.auditedAt)}: ${o.workflows.length} workflows read. Audits only read; nothing changes until you press Fix.` : "No audit yet. Audits only read; nothing changes until you press Fix."}
            </span>
          </>
        )}
        <ErrorLine error={audit.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {o?.login && (
          o.auditing ? (
            <Link href="/chats/platform" className="ld-btn ld-av-link-plain">Watch</Link>
          ) : (
            <button type="button" className="ld-btn p" disabled={audit.isPending} onClick={() => audit.mutate({ organizationId: currentOrgId })}>{audit.isPending ? "Starting..." : o.auditedAt ? "Audit again" : "Audit now"}</button>
          )
        )}
      </div>
    </div>
  );
}

type Finding = {
  id: number;
  workflow: string;
  issue: string;
  severity: "fix_now" | "should_fix";
  status: "open" | "fixing" | "fixed" | "dismissed";
  howItRuns: string[];
  fix: string;
  note: string | null;
  fixedAt: Date | string | null;
};

function Steps({ lines }: { lines: string[] }) {
  if (!lines.length) return <span style={{ fontSize: 14, color: "var(--ld-muted)" }}>Not read.</span>;
  return (
    <div style={{ fontSize: 14, lineHeight: 1.7 }}>
      {lines.map((l, i) => (
        <div key={i}>{/^\d+\./.test(l.trim()) || /^Trigger:/i.test(l) ? l : `${i + 1}. ${l}`}</div>
      ))}
    </div>
  );
}

function FindingRow({ f, open, onToggle }: { f: Finding; open: boolean; onToggle: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const done = () => Promise.all([utils.platform.overview.invalidate(), utils.chat.list.invalidate()]);
  const fix = trpc.platform.fix.useMutation({ onSuccess: done });
  const dismiss = trpc.platform.dismiss.useMutation({ onSuccess: done });
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "var(--ld-hover)", borderBottom: 0 } : {}) }}>
        <b style={{ overflowWrap: "anywhere" }}>{f.workflow}</b>
        <span>{f.issue}</span>
        {f.status === "fixing" ? <span className="ld-pill amber" style={{ justifySelf: "start" }}>Fixing now</span> : <SevPill s={f.severity} />}
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span className="ld-lbl">How it runs now</span>
            <Steps lines={f.howItRuns} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span className="ld-lbl">The fix</span>
            <span style={{ fontSize: 14, lineHeight: 1.6 }}>{f.fix}</span>
            <span className="ld-small">Zara saves the workflow after the change. It stays published.</span>
            {f.note && f.status === "open" && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>Last try: {f.note}</span>}
            <ErrorLine error={fix.error || dismiss.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {f.status === "open" && (
              <>
                <button type="button" className="ld-btn p" disabled={fix.isPending} onClick={() => fix.mutate({ organizationId: currentOrgId, findingId: f.id })}>{fix.isPending ? "Starting..." : "Fix"}</button>
                <button type="button" className="ld-btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ organizationId: currentOrgId, findingId: f.id })}>Dismiss</button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FixedRow({ f, open, onToggle }: { f: Finding; open: boolean; onToggle: () => void }) {
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "var(--ld-hover)", borderBottom: 0 } : {}) }}>
        <b style={{ overflowWrap: "anywhere" }}>{f.workflow}</b>
        <span>{f.issue}</span>
        <span>{f.fixedAt ? fmtDate(f.fixedAt) : ""}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span className="ld-lbl">How it ran before</span>
            <Steps lines={f.howItRuns} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span className="ld-lbl">What Zara changed</span>
            <span style={{ fontSize: 14, lineHeight: 1.6 }}>{f.note || f.fix}</span>
          </div>
        </div>
      )}
    </>
  );
}

export default function Workflows({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const q = trpc.platform.overview.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => (r.state.data?.auditing || (r.state.data?.findings ?? []).some((f) => f.status === "fixing") ? 10_000 : false) });
  const [tab, setTab] = React.useState<"open" | "fixed" | "all">("open");
  const [open, setOpen] = React.useState<string | null>(null);
  const toggle = (k: string) => setOpen(open === k ? null : k);
  const findings = q.data?.findings ?? [];
  const needs = findings.filter((f) => f.status === "open" || f.status === "fixing").sort((a, b) => (a.severity === b.severity ? a.id - b.id : a.severity === "fix_now" ? -1 : 1));
  const fixed = findings.filter((f) => f.status === "fixed");
  const all = q.data?.workflows ?? [];
  return (
    <main className="ld-main" style={{ padding: "28px 36px", display: "flex", flexDirection: "column", gap: 16 }}>
      <StatusCard emp={emp} />
      <FolderTabs
        value={tab}
        onChange={(k) => { setTab(k); setOpen(null); }}
        tabs={[
          { key: "open", label: `Needs fixing (${needs.length})` },
          { key: "fixed", label: `Fixed (${fixed.length})` },
          { key: "all", label: `All workflows (${all.length})` },
        ]}
      >
        {tab === "open" && (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>Workflow</span>
              <span>What's wrong</span>
              <span>Priority</span>
              <span />
            </div>
            {needs.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : q.data?.auditedAt ? "Nothing needs fixing." : `Nothing yet. Press Audit now or ask ${emp.name} in Chat.`}</div>}
            {needs.map((f) => (
              <FindingRow key={f.id} f={f} open={open === `f${f.id}`} onToggle={() => toggle(`f${f.id}`)} />
            ))}
          </>
        )}
        {tab === "fixed" && (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>Workflow</span>
              <span>What was wrong</span>
              <span>Fixed</span>
              <span />
            </div>
            {fixed.length === 0 && <div className="ld-empty">Nothing fixed yet.</div>}
            {fixed.map((f) => (
              <FixedRow key={f.id} f={f} open={open === `x${f.id}`} onToggle={() => toggle(`x${f.id}`)} />
            ))}
          </>
        )}
        {tab === "all" && (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>Workflow</span>
              <span>Trigger</span>
              <span>Status</span>
              <span />
            </div>
            {all.length === 0 && <div className="ld-empty">No workflows read yet.</div>}
            {all.map((w, i) => (
              <React.Fragment key={`${w.name}-${i}`}>
                <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open === `w${i}` ? { background: "var(--ld-hover)", borderBottom: 0 } : {}) }}>
                  <b style={{ overflowWrap: "anywhere" }}>{w.name}</b>
                  <span>{w.error ? "Couldn't open it" : w.trigger || "Not read"}</span>
                  <span>{w.status || ""}</span>
                  <button type="button" className="ld-btn" onClick={() => toggle(`w${i}`)}>{open === `w${i}` ? "Close" : "Open"}</button>
                </div>
                {open === `w${i}` && (
                  <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                      <span className="ld-lbl">{w.error ? "Why it didn't open" : "Steps"}</span>
                      {w.error ? <span style={{ fontSize: 14 }}>{w.error}</span> : <Steps lines={w.steps} />}
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </>
        )}
      </FolderTabs>
    </main>
  );
}
