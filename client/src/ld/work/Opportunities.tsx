import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, UnderlineTabs } from "../ui";
import { fmtDate, parseJson } from "../meta";

const COLS = "minmax(0,2.4fr) minmax(0,1.4fr) 130px 140px 128px";

const SECTIONS = [
  { key: "executiveSummary", label: "Executive summary" },
  { key: "statementOfNeed", label: "Statement of need" },
  { key: "programDesign", label: "Program design" },
  { key: "budgetNarrative", label: "Budget narrative" },
  { key: "evaluationPlan", label: "Evaluation plan" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

const STATUS: Record<string, { label: string; cls: string }> = {
  drafting: { label: "Drafting", cls: "gray" },
  pending_review: { label: "Waiting for review", cls: "amber" },
  changes_requested: { label: "Sent back", cls: "amber" },
  approved: { label: "Approved", cls: "green" },
  ready_for_portal: { label: "Ready to submit", cls: "green" },
};

/** Morgan's Work tab: Opportunities and Proposals. */
export default function Opportunities({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const initialTab = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "proposals" ? "proposals" : "opps";
  const [tab, setTab] = React.useState<"opps" | "proposals">(initialTab);
  const opps = trpc.grants.listOpportunities.useQuery({ organizationId: currentOrgId });
  const proposals = trpc.grants.listProposals.useQuery({ organizationId: currentOrgId });
  const find = trpc.grants.scoutOpportunities.useMutation({ onSuccess: () => utils.grants.invalidate() });

  return (
    <main className="ld-main" style={{ padding: "28px 36px" }}>
      <div className="ld-row" style={{ justifyContent: "flex-end" }}>
        {find.data && !find.isPending && (
          <span className="ld-small ld-muted">
            {find.data.added ? `Added ${find.data.added} from ${find.data.queries.length} searches.` : `No new grants from ${find.data.queries.length} searches.`}
          </span>
        )}
        <button type="button" className="ld-btn p" disabled={find.isPending} onClick={() => find.mutate({ organizationId: currentOrgId })}>
          {find.isPending ? "Searching..." : "Find grants"}
        </button>
      </div>
      <ErrorLine error={find.error} />

      <UnderlineTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "opps", label: `Opportunities (${opps.data?.length ?? 0})` },
          { key: "proposals", label: `Proposals (${proposals.data?.length ?? 0})` },
        ]}
      />

      {tab === "opps" ? (
        <OpportunityList onStarted={() => setTab("proposals")} empName={emp.name} />
      ) : (
        <ProposalList empName={emp.name} />
      )}
    </main>
  );
}

function OpportunityList({ onStarted, empName }: { onStarted: () => void; empName: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const opps = trpc.grants.listOpportunities.useQuery({ organizationId: currentOrgId });
  const proposals = trpc.grants.listProposals.useQuery({ organizationId: currentOrgId });
  const [open, setOpen] = React.useState<number | null>(null);
  const start = trpc.grants.startProposal.useMutation({
    onSuccess: async () => {
      await utils.grants.invalidate();
      onStarted();
    },
  });
  const dismiss = trpc.grants.dismissOpportunity.useMutation({ onSuccess: () => utils.grants.invalidate() });
  const list = opps.data ?? [];

  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
        <span>Opportunity</span>
        <span>Funder</span>
        <span>Deadline</span>
        <span>Award</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">{opps.isLoading ? "Loading..." : `No opportunities yet. Press Find grants or ask ${empName} in Chat.`}</div>}
      {list.map((o) => {
        const isOpen = open === o.id;
        const hasProposal = proposals.data?.some((p) => p.opportunityId === o.id);
        const queries = parseJson<string[]>(o.searchQueries, []);
        return (
          <React.Fragment key={o.id}>
            <div
              className={`ld-rw ${isOpen ? "open" : ""}`}
              style={{ gridTemplateColumns: COLS, cursor: "pointer" }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button,a")) return;
                setOpen(isOpen ? null : o.id);
              }}
              aria-expanded={isOpen}
            >
              <span className="ld-strong">{o.title}</span>
              <span>{o.funder}</span>
              <span>{o.deadline || "Not listed"}</span>
              <span>{o.fundingAmount || "Not listed"}</span>
              {hasProposal ? (
                <button type="button" className="ld-btn" onClick={onStarted}>Open proposal</button>
              ) : (
                <button type="button" className="ld-btn p" disabled={start.isPending} onClick={() => start.mutate({ organizationId: currentOrgId, opportunityId: o.id })}>
                  Start proposal
                </button>
              )}
            </div>
            {isOpen && (
              <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="Who can apply">{o.eligibility || "Not listed on the funder's page."}</Field>
                  <Field label="Why it fits">{o.fitReason || o.summary || ""}</Field>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <Field label="Source">
                    {o.sourceUrl ? (
                      <a href={o.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                        {o.sourceUrl.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    ) : (
                      "None"
                    )}
                  </Field>
                  {queries.length > 0 && (
                    <Field label={`Searches ${empName} ran`}>
                      <span style={{ lineHeight: 1.6, color: "#3d4c45" }}>
                        {queries.map((q, i) => (
                          <span key={i} style={{ display: "block" }}>{q}</span>
                        ))}
                      </span>
                    </Field>
                  )}
                  <Field label="Found">{fmtDate(o.createdAt)}</Field>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button type="button" className="ld-btn" onClick={() => dismiss.mutate({ organizationId: currentOrgId, id: o.id })}>Dismiss</button>
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
      <div style={{ padding: "0 18px" }}>
        <ErrorLine error={start.error ?? dismiss.error} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body">{children}</span>
    </div>
  );
}

const PCOLS = "minmax(0,2.4fr) minmax(0,1.4fr) 130px 160px 128px";

function ProposalList({ empName }: { empName: string }) {
  const { currentOrgId } = useTenant();
  const proposals = trpc.grants.listProposals.useQuery({ organizationId: currentOrgId });
  const opps = trpc.grants.listOpportunities.useQuery({ organizationId: currentOrgId, status: "all" });
  const [open, setOpen] = React.useState<number | null>(proposals.data?.[0]?.id ?? null);
  React.useEffect(() => {
    if (open === null && proposals.data?.[0]) setOpen(proposals.data[0].id);
  }, [proposals.data, open]);
  const list = proposals.data ?? [];

  return (
    <div className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-hd" style={{ gridTemplateColumns: PCOLS }}>
        <span>Proposal</span>
        <span>Funder</span>
        <span>Deadline</span>
        <span>Status</span>
        <span />
      </div>
      {list.length === 0 && <div className="ld-empty">No proposals yet. Press Start proposal on an opportunity.</div>}
      {list.map((p) => {
        const opp = opps.data?.find((o) => o.id === p.opportunityId);
        const isOpen = open === p.id;
        const st = STATUS[p.status] ?? { label: p.status, cls: "gray" };
        return (
          <React.Fragment key={p.id}>
            <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: PCOLS }}>
              <span className="ld-strong">{p.title}</span>
              <span>{opp?.funder ?? ""}</span>
              <span>{opp?.deadline || "Not listed"}</span>
              <span className={`ld-pill ${st.cls}`}>{st.label}</span>
              <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : p.id)}>
                {isOpen ? "Close" : "Open"}
              </button>
            </div>
            {isOpen && <ProposalEditor proposalId={p.id} empName={empName} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ProposalEditor({ proposalId, empName }: { proposalId: number; empName: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.grants.getProposal.useQuery({ organizationId: currentOrgId, proposalId });
  const p = q.data;
  const [editing, setEditing] = React.useState<SectionKey | "checklist" | null>(null);
  const [draft, setDraft] = React.useState("");
  const [checklist, setChecklist] = React.useState<{ item: string; verified: boolean }[]>([]);
  const [drafting, setDrafting] = React.useState<SectionKey | null>(null);
  const [notes, setNotes] = React.useState("");
  const refresh = () => Promise.all([utils.grants.getProposal.invalidate(), utils.grants.listProposals.invalidate(), utils.grants.listOpportunities.invalidate()]);
  const save = trpc.grants.updateProposal.useMutation({ onSuccess: async () => { setEditing(null); await refresh(); } });
  const generate = trpc.grants.generateSection.useMutation({ onSettled: async () => { setDrafting(null); await refresh(); } });
  const review = trpc.grants.reviewProposal.useMutation({ onSuccess: async () => { setNotes(""); await refresh(); } });

  if (!p) return <div className="ld-expand ld-small ld-muted">Loading...</div>;
  const items = parseJson<{ item: string; verified: boolean }[]>(p.complianceChecklist, []);
  const allText = SECTIONS.map((s) => `## ${s.label}\n\n${(p as any)[s.key] || "[Not written yet]"}`).join("\n\n");

  return (
    <div className="ld-expand" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {SECTIONS.map((s) => {
        const value: string = (p as any)[s.key] || "";
        const isEditing = editing === s.key;
        return (
          <section key={s.key} className={`ld-card ${isEditing ? "editing" : ""}`}>
            <div className="ld-sh">
              <span className="ld-st">{s.label}</span>
              {isEditing ? (
                <span className="ld-row">
                  <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ id: p.id, organizationId: currentOrgId, [s.key]: draft } as any)}>
                    Save
                  </button>
                </span>
              ) : (
                <span className="ld-row">
                  <button
                    type="button"
                    className="ld-btn"
                    disabled={drafting !== null}
                    onClick={() => {
                      setDrafting(s.key);
                      generate.mutate({ organizationId: currentOrgId, proposalId: p.id, sectionKey: s.key });
                    }}
                  >
                    {drafting === s.key ? "Drafting..." : value ? `Redraft` : `Draft with ${empName}`}
                  </button>
                  <button
                    type="button"
                    className="ld-btn sm"
                    onClick={() => {
                      setDraft(value);
                      setEditing(s.key);
                    }}
                  >
                    Edit
                  </button>
                </span>
              )}
            </div>
            <div style={{ padding: "14px 18px" }}>
              {isEditing ? (
                <textarea className="ld-ta" rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={s.label} />
              ) : value ? (
                <div className="ld-body ld-pre">{value}</div>
              ) : (
                <span className="ld-small ld-muted">Not written yet.</span>
              )}
            </div>
          </section>
        );
      })}

      <section className={`ld-card ${editing === "checklist" ? "editing" : ""}`}>
        <div className="ld-sh">
          <span className="ld-st">Before you submit</span>
          {editing === "checklist" ? (
            <span className="ld-row">
              <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="ld-btn p sm" onClick={() => save.mutate({ id: p.id, organizationId: currentOrgId, complianceChecklist: JSON.stringify(checklist) })}>
                Save
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ld-btn sm"
              onClick={() => {
                setChecklist(items);
                setEditing("checklist");
              }}
            >
              Edit
            </button>
          )}
        </div>
        <div style={{ padding: "12px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
          {(editing === "checklist" ? checklist : items).map((c, i) => (
            <label key={i} className="ld-row ld-body" style={{ gap: 10 }}>
              <input
                type="checkbox"
                checked={c.verified}
                disabled={editing !== "checklist"}
                onChange={(e) => setChecklist((prev) => prev.map((x, j) => (j === i ? { ...x, verified: e.target.checked } : x)))}
              />
              {c.item}
            </label>
          ))}
        </div>
      </section>

      <section className="ld-card" style={{ padding: "14px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px 128px 128px", gap: 10, alignItems: "end" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label className="ld-lbl" htmlFor={`notes-${p.id}`}>Note for {empName} (optional)</label>
          <input id={`notes-${p.id}`} className="ld-in lg" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button type="button" className="ld-btn" onClick={() => review.mutate({ organizationId: currentOrgId, proposalId: p.id, action: "request_edits", notes })}>Send back</button>
        <button type="button" className="ld-btn p" onClick={() => review.mutate({ organizationId: currentOrgId, proposalId: p.id, action: "approve", notes })}>Approve</button>
        <button
          type="button"
          className="ld-btn"
          onClick={() => {
            navigator.clipboard?.writeText(allText);
          }}
        >
          Copy all
        </button>
      </section>
      {p.approvedBy && <span className="ld-small ld-muted">Approved by {p.approvedBy}{p.approvedAt ? ` on ${fmtDate(p.approvedAt)}` : ""}</span>}
      <ErrorLine error={save.error ?? generate.error ?? review.error} />
    </div>
  );
}
