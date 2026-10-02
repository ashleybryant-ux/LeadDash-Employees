import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import type { Outputs } from "../types";

type Seq = Outputs["sales"]["sequences"][number];
type Tab = "waiting" | "sending" | "replied" | "booked" | "finished";
const TABS: { key: Tab; label: string }[] = [
  { key: "waiting", label: "Waiting for you" },
  { key: "sending", label: "Sending" },
  { key: "replied", label: "Replied" },
  { key: "booked", label: "Booked" },
  { key: "finished", label: "Finished" },
];
const COLS = "minmax(0,2fr) minmax(0,1.3fr) 150px 128px 128px";

function when(d: Date | string | null | undefined, tz: string, withTime = false) {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}) }).replace(/, (\d{1,2}:\d{2})/, " at $1");
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

/** Jada's Work tab: one row per prospect, with the 3-email sequence inside. */
export default function Outreach({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId, currentOrg } = useTenant();
  const tz = currentOrg?.timezone || "America/Chicago";
  const utils = trpc.useUtils();
  const q = trpc.sales.sequences.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 30_000 });
  const conns = trpc.publishing.listConnections.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const gmail = (conns.data ?? []).find((c) => c.provider === "google_workspace" && c.status === "connected");
  const [tab, setTab] = React.useState<Tab>("waiting");
  const [open, setOpen] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Record<number, { title: string; body: string }>>({});
  const refresh = () => Promise.all([utils.sales.sequences.invalidate(), utils.sales.prospects.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const approve = trpc.sales.approveSequence.useMutation({ onSuccess: refresh });
  const stop = trpc.sales.stop.useMutation({ onSuccess: refresh });
  const replied = trpc.sales.replied.useMutation({ onSuccess: refresh });
  const saveStep = trpc.sales.updateStep.useMutation();
  const [saving, setSaving] = React.useState(false);

  const all = q.data ?? [];
  const shown = all.filter((s) => s.tab === tab);
  const err = approve.error || stop.error || replied.error || saveStep.error;

  const stepLabel = (s: Seq["steps"][number], first: Seq["steps"][number]) => {
    if (s.status === "published") return `Sent ${when(s.publishedAt, tz, true)}`;
    if (s.status === "cancelled") return "Not sent";
    if (s.step === 1) return `Sends ${when(s.scheduledFor, tz, true)}`;
    return `${when(s.scheduledFor, tz)}, if no reply`;
  };

  const saveEdits = async (seq: Seq) => {
    setSaving(true);
    try {
      for (const s of seq.steps) {
        const d = draft[s.id];
        if (d && (d.title !== s.title || d.body !== s.body)) await saveStep.mutateAsync({ organizationId: currentOrgId, itemId: s.id, title: d.title, body: d.body });
      }
      setEditing(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <FolderTabs value={tab} onChange={(k) => { setTab(k); setOpen(null); setEditing(null); }} tabs={TABS.map((t) => ({ key: t.key, label: `${t.label} (${all.filter((s) => s.tab === t.key).length})` }))}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>Practice</span>
          <span>To</span>
          <span>First email</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : tab === "waiting" ? "Nothing is waiting for you." : "Nothing here yet."}</div>}
        {shown.map((seq) => {
          const isOpen = open === seq.sequence;
          const first = seq.steps[0];
          const isEditing = editing === seq.sequence;
          const openSteps = seq.steps.filter((s) => ["pending_approval", "scheduled", "approved"].includes(s.status));
          const p = seq.prospect;
          return (
            <React.Fragment key={seq.sequence}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a,textarea,input")) return; setOpen(isOpen ? null : seq.sequence); setEditing(null); }}>
                <span className="ld-strong">{p?.name ?? "Prospect"}</span>
                <span>{[p?.contactName, p?.contactTitle].filter(Boolean).join(", ") || p?.email || ""}</span>
                <span>{first?.publishedAt ? when(first.publishedAt, tz) : when(first?.scheduledFor, tz)}</span>
                {tab === "waiting" ? (
                  <>
                    <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: currentOrgId, sequence: seq.sequence })}>Approve</button>
                    <button type="button" className="ld-btn" disabled={stop.isPending || !p} onClick={() => p && stop.mutate({ organizationId: currentOrgId, prospectId: p.id })}>Skip</button>
                  </>
                ) : tab === "sending" ? (
                  <>
                    <button type="button" className="ld-btn" disabled={replied.isPending || !p} onClick={() => p && replied.mutate({ organizationId: currentOrgId, prospectId: p.id })}>Replied</button>
                    <button type="button" className="ld-btn" disabled={stop.isPending || !p} onClick={() => p && stop.mutate({ organizationId: currentOrgId, prospectId: p.id })}>Stop</button>
                  </>
                ) : (
                  <>
                    <span className={`ld-pill ${tab === "finished" ? "gray" : "green"}`}>{`${seq.sent} sent`}</span>
                    <button type="button" className="ld-btn" onClick={() => setOpen(isOpen ? null : seq.sequence)}>{isOpen ? "Close" : "Open"}</button>
                  </>
                )}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px 128px", gap: 24 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                    {seq.steps.map((s) => {
                      const editable = isEditing && openSteps.some((o) => o.id === s.id);
                      const d = draft[s.id] ?? { title: s.title, body: s.body };
                      return (
                        <div key={s.id} style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "#fff", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, opacity: s.status === "cancelled" ? 0.6 : 1 }}>
                          <div className="ld-between">
                            <span style={{ fontWeight: 800, fontSize: 14 }}>Email {s.step}</span>
                            <span className="ld-small ld-muted" style={{ fontSize: 12 }}>{stepLabel(s, first)}</span>
                          </div>
                          {editable ? (
                            <>
                              {s.step === 1 && <input className="ld-in" aria-label="Subject" value={d.title} onChange={(e) => setDraft({ ...draft, [s.id]: { ...d, title: e.target.value } })} />}
                              <textarea className="ld-ta" rows={s.step === 1 ? 7 : 3} aria-label={`Email ${s.step}`} value={d.body} onChange={(e) => setDraft({ ...draft, [s.id]: { ...d, body: e.target.value } })} />
                            </>
                          ) : (
                            <>
                              {s.step === 1 && <span style={{ fontSize: 14, fontWeight: 700 }}>{s.title}</span>}
                              <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{s.body}</span>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <KV label="Sends from">{gmail ? `${gmail.accountLabel} (Gmail)` : "Connect Google on Integrations"}</KV>
                    <KV label="Stops when">They book a time, or you press Replied</KV>
                    {p && <KV label="From Riley">{[`Fit ${p.fitScore}`, p.city].filter(Boolean).join(" · ")}</KV>}
                    <ErrorLine error={err} />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {isEditing ? (
                      <>
                        <button type="button" className="ld-btn p" disabled={saving} onClick={() => saveEdits(seq)}>Save</button>
                        <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        {tab === "waiting" && <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: currentOrgId, sequence: seq.sequence })}>{`Approve all ${seq.steps.filter((s) => s.status === "pending_approval").length}`}</button>}
                        {openSteps.length > 0 && <button type="button" className="ld-btn" onClick={() => { setEditing(seq.sequence); setDraft(Object.fromEntries(seq.steps.map((s) => [s.id, { title: s.title, body: s.body }]))); }}>Edit</button>}
                        {tab === "waiting" && <button type="button" className="ld-btn" disabled={!p} onClick={() => p && stop.mutate({ organizationId: currentOrgId, prospectId: p.id })}>Skip</button>}
                        {tab === "sending" && <button type="button" className="ld-btn" disabled={!p} onClick={() => p && replied.mutate({ organizationId: currentOrgId, prospectId: p.id })}>Replied</button>}
                      </>
                    )}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </FolderTabs>
    </main>
  );
}
