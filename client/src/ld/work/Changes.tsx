import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine } from "../ui";
import { fmtDate } from "../meta";

/**
 * Kai's work: the code he works on (and whether Claude is connected to it),
 * and every change Claude made, with Merge and Ask for changes. The same card
 * shows under Kai's chat messages.
 */

type Change = {
  id: number;
  title: string;
  label: string;
  repo: string;
  request: string;
  status: "working" | "ready" | "merged" | "closed" | "failed" | "handed_off";
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  files: number | null;
  checks: string | null;
  summary: string[];
  error: string | null;
  createdAt: Date | string;
};

const PILL: Record<Change["status"], [string, string]> = {
  working: ["amber", "Claude is working"],
  ready: ["green", "Ready for you"],
  merged: ["gray", "Merged"],
  closed: ["gray", "Closed"],
  failed: ["red", "Didn't finish"],
  handed_off: ["gray", "Ready to post"],
};

function useChangeActions() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.dev.invalidate(), utils.chat.list.invalidate()]);
  return { orgId: currentOrgId, merge: trpc.dev.merge.useMutation({ onSuccess: refresh }), ask: trpc.dev.askForChanges.useMutation({ onSuccess: refresh }) };
}

function GitHubLink({ c }: { c: Change }) {
  const url = c.prUrl ?? c.issueUrl;
  if (!url) return null;
  if (c.status === "handed_off") {
    return (
      <a className="ld-btn p ld-av-link" href={url} target="_blank" rel="noreferrer noopener">
        Post on GitHub
      </a>
    );
  }
  return (
    <a className="ld-btn ld-av-link-plain" href={url} target="_blank" rel="noreferrer noopener">
      On GitHub
    </a>
  );
}

/** Merge, Ask for changes (opens a short box), On GitHub. */
function Actions({ c }: { c: Change }) {
  const a = useChangeActions();
  const [asking, setAsking] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  if (asking) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, gridColumn: "1 / -1" }}>
        <label className="ld-lbl" htmlFor={`ask-${c.id}`}>What should Claude change?</label>
        <textarea id={`ask-${c.id}`} className="ld-in" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} style={{ height: "auto", padding: "8px 10px", lineHeight: 1.5, resize: "vertical" }} />
        <div className="ld-row">
          <button type="button" className="ld-btn p" disabled={!notes.trim() || a.ask.isPending} onClick={() => a.ask.mutate({ organizationId: a.orgId, id: c.id, notes }, { onSuccess: () => { setAsking(false); setNotes(""); } })}>Send</button>
          <button type="button" className="ld-btn" onClick={() => setAsking(false)}>Cancel</button>
        </div>
        <ErrorLine error={a.ask.error} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {c.status === "ready" && (
        <>
          <button type="button" className="ld-btn p" disabled={a.merge.isPending} onClick={() => a.merge.mutate({ organizationId: a.orgId, id: c.id })}>{a.merge.isPending ? "Merging..." : "Merge"}</button>
          <button type="button" className="ld-btn" onClick={() => setAsking(true)}>Ask for changes</button>
        </>
      )}
      {c.status === "failed" && <button type="button" className="ld-btn" onClick={() => setAsking(true)}>Try again</button>}
      <GitHubLink c={c} />
      <ErrorLine error={a.merge.error} />
    </div>
  );
}

function Details({ c }: { c: Change }) {
  const meta = [c.label, c.prNumber ? `Change #${c.prNumber}` : c.issueNumber ? `Issue #${c.issueNumber}` : "", c.files != null ? `${c.files} file${c.files === 1 ? "" : "s"}` : "", c.checks && c.checks !== "no checks" ? c.checks : ""].filter(Boolean).join(" · ");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <span className="ld-small" style={{ color: "var(--ld-text2)" }}>{meta}</span>
      {c.summary.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
          {c.summary.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : (
        <span style={{ fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>{c.request}</span>
      )}
      {c.status === "failed" && c.error && <span className="ld-small" style={{ color: "var(--ld-bad)" }}>{c.error}</span>}
    </div>
  );
}

/** The card under Kai's message. */
export function DevChangeCard({ id }: { id: number }) {
  const { currentOrgId } = useTenant();
  const q = trpc.dev.get.useQuery({ organizationId: currentOrgId, id }, { refetchInterval: (r) => (r.state.data?.status === "working" ? 15_000 : false) });
  const c = q.data as Change | null | undefined;
  if (!c) return null;
  const [cls, label] = PILL[c.status];
  return (
    <div className="ld-card ld-av-set">
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
        <div className="ld-row" style={{ flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{c.title}</span>
          <span className={`ld-pill ${cls}`}>{label}</span>
        </div>
        <Details c={c} />
      </div>
      <Actions c={c} />
    </div>
  );
}

const COLS = "minmax(0,2fr) 170px 150px 150px 128px";

function ReposCard() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.dev.repos.useQuery({ organizationId: currentOrgId });
  const save = trpc.dev.saveRepos.useMutation({ onSuccess: (r) => { utils.dev.repos.setData({ organizationId: currentOrgId }, r); setEditing(false); } });
  const connect = trpc.dev.connect.useMutation({ onSuccess: (r) => utils.dev.repos.setData({ organizationId: currentOrgId }, r) });
  const [editing, setEditing] = React.useState(false);
  const [rows, setRows] = React.useState<{ label: string; repo: string; deploy: string }[]>([]);
  const repos = q.data ?? [];
  return (
    <div className="ld-card ld-av-set">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <span className="ld-lbl">Code Kai works on</span>
        {!editing ? (
          <div className="ld-dev-repos">
            {repos.map((r) => (
              <React.Fragment key={r.repo}>
                <span className="ld-strong">{r.label}</span>
                <span style={{ overflowWrap: "anywhere" }}>{r.repo}</span>
                {r.connected ? (
                  <span className="ld-pill green">Claude connected</span>
                ) : r.linkOnly ? (
                  <a className="ld-btn ld-av-link-plain" href={r.addUrl} target="_blank" rel="noreferrer noopener">Add Claude</a>
                ) : r.reason === "Claude's workflow isn't in this repo yet" ? (
                  <button type="button" className="ld-btn" disabled={connect.isPending} onClick={() => connect.mutate({ organizationId: currentOrgId, repo: r.repo })}>Connect</button>
                ) : (
                  <span className="ld-pill amber" title={r.reason}>Not connected</span>
                )}
              </React.Fragment>
            ))}
            {repos.some((r) => r.linkOnly) && (
              <span className="ld-small ld-muted" style={{ gridColumn: "1 / -1" }}>Add Claude opens GitHub with Claude's workflow filled in. Press Commit changes once per repo (skip any repo that already has it).</span>
            )}
            {repos.some((r) => !r.connected && r.reason && r.reason !== "Claude's workflow isn't in this repo yet") && (
              <span className="ld-small" style={{ gridColumn: "1 / -1", color: "#8a4510" }}>{repos.find((r) => !r.connected && r.reason)?.reason}</span>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map((r, i) => (
              <div key={i} className="ld-dev-edit">
                <input className="ld-in" aria-label="Name" value={r.label} placeholder="LeadDash EHR" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input className="ld-in" aria-label="GitHub repo" value={r.repo} placeholder="owner/name" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, repo: e.target.value } : x)))} />
                <input className="ld-in" aria-label="Deploy command" value={r.deploy} placeholder="Deploy command" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, deploy: e.target.value } : x)))} />
                <button type="button" className="ld-btn sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" className="ld-btn sm" style={{ width: 120 }} onClick={() => setRows([...rows, { label: "", repo: "", deploy: "" }])}>Add code</button>
            </div>
          </div>
        )}
        <ErrorLine error={save.error ?? connect.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, repos: rows })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="ld-btn" onClick={() => { setRows(repos.map((r) => ({ label: r.label, repo: r.repo, deploy: r.deploy }))); setEditing(true); }}>Edit</button>
        )}
      </div>
    </div>
  );
}

function Row({ c, open, onToggle }: { c: Change; open: boolean; onToggle: () => void }) {
  const [cls, label] = PILL[c.status];
  return (
    <>
      <div className="ld-rw" style={{ gridTemplateColumns: COLS, ...(open ? { background: "var(--ld-hover)", borderBottom: 0 } : {}) }}>
        <span className="ld-strong" style={{ overflowWrap: "anywhere" }}>{c.title}</span>
        <span>{c.label}</span>
        <span className={`ld-pill ${cls}`}>{label}</span>
        <span>{fmtDate(c.createdAt)}</span>
        <button type="button" className="ld-btn" onClick={onToggle}>{open ? "Close" : "Open"}</button>
      </div>
      {open && (
        <div className="ld-av-exp" style={{ gridTemplateColumns: "minmax(0,1fr) 128px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <span className="ld-lbl">{c.summary.length ? "What Claude changed" : "What Kai asked for"}</span>
            <Details c={c} />
          </div>
          <Actions c={c} />
        </div>
      )}
    </>
  );
}

export default function Changes({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const list = trpc.dev.list.useQuery({ organizationId: currentOrgId }, { refetchInterval: (r) => ((r.state.data ?? []).some((c) => c.status === "working") ? 15_000 : false) });
  const rows = (list.data ?? []) as Change[];
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <main className="ld-main" style={{ padding: "28px 36px", display: "flex", flexDirection: "column", gap: 16 }}>
      <ReposCard />
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Change</span>
          <span>Code</span>
          <span>Status</span>
          <span>Asked</span>
          <span />
        </div>
        {rows.length === 0 && <div className="ld-empty">{list.isLoading ? "Loading..." : `No changes yet. Tell ${emp.name} in Chat what's broken.`}</div>}
        {rows.map((c) => (
          <Row key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} />
        ))}
      </div>
    </main>
  );
}
