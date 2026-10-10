import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import type { Outputs } from "../types";

type Seq = Outputs["sales"]["sequences"][number];
type Tab = "waiting" | "linkedin" | "sending" | "replied" | "booked" | "finished";
type LiRow = Outputs["sales"]["linkedin"][number];
const TABS: { key: Tab; label: string }[] = [
  { key: "waiting", label: "Waiting for you" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "sending", label: "Sending" },
  { key: "replied", label: "Replied" },
  { key: "booked", label: "Booked" },
  { key: "finished", label: "Finished" },
];
const COLS = "minmax(0,2fr) minmax(0,1.3fr) 150px 128px 128px";
const LI_COLS = "minmax(0,1.6fr) minmax(0,1.4fr) 150px 128px 128px";

function LinkedInMark() {
  return <span aria-hidden="true" style={{ display: "inline-flex", width: 18, height: 18, borderRadius: 4, background: "#0a66c2", color: "#fff", fontSize: 11, fontWeight: 800, alignItems: "center", justifyContent: "center" }}>in</span>;
}
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

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
export default function Outreach({ emp, embedded = false }: { emp: EmployeeRow; embedded?: boolean }) {
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
  const [noteDraft, setNoteDraft] = React.useState("");
  const [copied, setCopied] = React.useState<number | null>(null);
  const li = trpc.sales.linkedin.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const refresh = () => Promise.all([utils.sales.sequences.invalidate(), utils.sales.prospects.invalidate(), utils.sales.linkedin.invalidate(), utils.publishing.listApprovalQueue.invalidate()]);
  const liAct = trpc.sales.linkedinAction.useMutation({ onSuccess: refresh });
  const saveNote = trpc.sales.linkedinNote.useMutation();
  const [liOpen, setLiOpen] = React.useState<number | null>(null);
  const approve = trpc.sales.approveSequence.useMutation({ onSuccess: refresh });
  const stop = trpc.sales.stop.useMutation({ onSuccess: refresh });
  const replied = trpc.sales.replied.useMutation({ onSuccess: refresh });
  const saveStep = trpc.sales.updateStep.useMutation();
  const [saving, setSaving] = React.useState(false);

  const all = q.data ?? [];
  const shown = all.filter((s) => s.tab === tab);
  const err = approve.error || stop.error || replied.error || saveStep.error || saveNote.error;
  const liRows = li.data ?? [];
  const copyNote = async (r: LiRow) => {
    try {
      await navigator.clipboard.writeText(r.note);
      setCopied(r.prospectId);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

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
      if (seq.linkedin && seq.prospect && noteDraft !== seq.linkedin.note) await saveNote.mutateAsync({ organizationId: currentOrgId, prospectId: seq.prospect.id, note: noteDraft });
      setEditing(null);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const Shell = embedded ? "div" : "main";
  return (
    <Shell className={embedded ? undefined : "ld-main"} style={embedded ? undefined : { padding: "20px 32px" }}>
      <FolderTabs value={tab} onChange={(k) => { setTab(k); setOpen(null); setEditing(null); }} tabs={TABS.map((t) => ({ key: t.key, label: `${t.label} (${t.key === "linkedin" ? liRows.length : all.filter((s) => s.tab === t.key).length})` }))}>
        {tab === "linkedin" ? (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: LI_COLS }}>
              <span>Practice</span>
              <span>Send to</span>
              <span>Due</span>
              <span />
              <span />
            </div>
            {liRows.length === 0 && <div className="ld-empty">{li.isLoading ? "Loading..." : "No LinkedIn requests to send."}</div>}
            {liRows.map((r) => {
              const isOpen = liOpen === r.prospectId;
              return (
                <React.Fragment key={r.prospectId}>
                  <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: LI_COLS, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a")) return; setLiOpen(isOpen ? null : r.prospectId); }}>
                    <span className="ld-strong">{r.name}</span>
                    <span>{[r.contactName, r.contactTitle].filter(Boolean).join(", ")}</span>
                    <span>{when(r.due, tz)}</span>
                    <a className="ld-btn p" href={r.url} target="_blank" rel="noreferrer noopener">Open profile</a>
                    <button type="button" className="ld-btn" disabled={liAct.isPending} onClick={() => liAct.mutate({ organizationId: currentOrgId, prospectId: r.prospectId, action: "done" })}>Done</button>
                  </div>
                  {isOpen && (
                    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 260px 128px", gap: 24 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                        <span className="ld-lbl">Note to send with the request</span>
                        {r.note ? (
                          <div style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "var(--ld-surface)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                            <span style={{ fontSize: 14, lineHeight: 1.5, overflowWrap: "anywhere" }}>{r.note}</span>
                            <span className="ld-small ld-muted" style={{ fontSize: 12 }}>{`${r.note.length} of 200 characters`}</span>
                          </div>
                        ) : (
                          <span className="ld-body">No note. Send the request without one.</span>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <KV label="Profile"><a href={r.url} target="_blank" rel="noreferrer noopener">{shortUrl(r.url)}</a></KV>
                        <KV label="Found by">{r.foundBy}</KV>
                        {r.email1 && <KV label="Email 1">{r.email1.publishedAt ? `Sent ${when(r.email1.publishedAt, tz, true)}` : r.email1.scheduledFor ? `Sends ${when(r.email1.scheduledFor, tz, true)}` : "Not sent"}</KV>}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {r.note && <button type="button" className="ld-btn p" onClick={() => copyNote(r)}>{copied === r.prospectId ? "Copied" : "Copy note"}</button>}
                        <a className={`ld-btn ${r.note ? "" : "p"}`} href={r.url} target="_blank" rel="noreferrer noopener">Open profile</a>
                        <button type="button" className="ld-btn" disabled={liAct.isPending} onClick={() => liAct.mutate({ organizationId: currentOrgId, prospectId: r.prospectId, action: "done" })}>Done</button>
                        <button type="button" className="ld-btn" disabled={liAct.isPending} onClick={() => liAct.mutate({ organizationId: currentOrgId, prospectId: r.prospectId, action: "skip" })}>Skip</button>
                      </div>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
            {liAct.error && <div style={{ padding: "8px 18px" }}><ErrorLine error={liAct.error} /></div>}
          </>
        ) : (
        <>
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
                      const l = seq.linkedin;
                      const liStep = s.step === 2 && l && l.status !== "cancelled" ? (
                        <div key={`li-${seq.sequence}`} style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "var(--ld-surface)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, opacity: l.status === "skipped" ? 0.6 : 1 }}>
                          <div className="ld-between">
                            <span style={{ fontWeight: 800, fontSize: 14, display: "inline-flex", alignItems: "center", gap: 8 }}><LinkedInMark />Connect on LinkedIn</span>
                            <span className="ld-small ld-muted" style={{ fontSize: 12 }}>{l.status === "done" ? `You sent it${l.doneAt ? ` ${when(l.doneAt, tz)}` : ""}` : l.status === "skipped" ? "Skipped" : `For you, ${when(l.due, tz)}`}</span>
                          </div>
                          <span style={{ fontSize: 14, fontWeight: 700, overflowWrap: "anywhere" }}>{[p?.contactName && [p.contactName, p.contactTitle].filter(Boolean).join(", "), shortUrl(l.url)].filter(Boolean).join(" · ")}</span>
                          {isEditing && (l.status === "waiting" || l.status === "todo") ? (
                            <>
                              <textarea className="ld-ta" rows={2} aria-label="LinkedIn note" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} />
                              <span className="ld-small ld-muted" style={{ fontSize: 12, color: noteDraft.length > 200 ? "var(--ld-bad)" : undefined }}>{`${noteDraft.length} of 200 characters`}</span>
                            </>
                          ) : (
                            <span style={{ fontSize: 14, lineHeight: 1.5, overflowWrap: "anywhere" }}>{l.note || "No note."}</span>
                          )}
                        </div>
                      ) : null;
                      return (
                        <React.Fragment key={s.id}>
                        {liStep}
                        <div style={{ border: "1px solid #e3e9e6", borderRadius: 10, background: "var(--ld-surface)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, opacity: s.status === "cancelled" ? 0.6 : 1 }}>
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
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <KV label="Sends from">{gmail ? `${gmail.accountLabel} (Gmail)` : "Connect Google on Integrations"}</KV>
                    {seq.linkedin && (seq.linkedin.status === "waiting" || seq.linkedin.status === "todo") && <KV label="LinkedIn step">{`You send it from your LinkedIn. It shows on the LinkedIn tab on ${when(seq.linkedin.due, tz)}.`}</KV>}
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
                        {openSteps.length > 0 && <button type="button" className="ld-btn" onClick={() => { setEditing(seq.sequence); setDraft(Object.fromEntries(seq.steps.map((s) => [s.id, { title: s.title, body: s.body }]))); setNoteDraft(seq.linkedin?.note ?? ""); }}>Edit</button>}
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
        </>
        )}
      </FolderTabs>
    </Shell>
  );
}
