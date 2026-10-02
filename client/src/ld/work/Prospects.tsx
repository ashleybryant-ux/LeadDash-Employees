import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import type { EmployeeRow } from "../ChatPage";
import { ErrorLine, FolderTabs } from "../ui";
import { parseJson } from "../meta";
import type { Outputs } from "../types";

type Prospect = Outputs["sales"]["prospects"][number];
type Tab = "new" | "outreach" | "replied" | "booked" | "not_fit";
const TABS: { key: Tab; label: string }[] = [
  { key: "new", label: "New" },
  { key: "outreach", label: "In outreach" },
  { key: "replied", label: "Replied" },
  { key: "booked", label: "Booked" },
  { key: "not_fit", label: "Not a fit" },
];
const STAGE: Record<Tab, { label: string; cls: string }> = {
  new: { label: "New", cls: "gray" },
  outreach: { label: "In outreach", cls: "amber" },
  replied: { label: "Replied", cls: "green" },
  booked: { label: "Booked", cls: "green" },
  not_fit: { label: "Not a fit", cls: "gray" },
};
const COLS = "minmax(0,2fr) 150px 70px minmax(0,1.3fr) 128px 128px";

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span className="ld-lbl">{label}</span>
      <span className="ld-body" style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

/** Riley's Work tab: the businesses (or referral partners) she found. */
export default function Prospects({ emp }: { emp: EmployeeRow }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.sales.prospects.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [tab, setTab] = React.useState<Tab>("new");
  const [open, setOpen] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [form, setForm] = React.useState({ contactName: "", email: "", phone: "" });
  const refresh = () => Promise.all([utils.sales.prospects.invalidate(), utils.sales.sequences.invalidate()]);
  const start = trpc.sales.startOutreach.useMutation({ onSuccess: refresh });
  const notFit = trpc.sales.notFit.useMutation({ onSuccess: refresh });
  const save = trpc.sales.updateProspect.useMutation({ onSuccess: async () => { setEditing(null); await refresh(); } });

  const all = q.data ?? [];
  const shown = all.filter((p) => p.stage === tab);
  const referral = all.some((p) => p.kind === "referral") && !all.some((p) => p.kind === "practice");

  return (
    <main className="ld-main" style={{ padding: "20px 32px" }}>
      <FolderTabs value={tab} onChange={(k) => { setTab(k); setOpen(null); setEditing(null); }} tabs={TABS.map((t) => ({ key: t.key, label: `${t.label} (${all.filter((p) => p.stage === t.key).length})` }))}>
        <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
          <span>{referral ? "Partner" : "Practice"}</span>
          <span>City</span>
          <span>Fit</span>
          <span>{referral ? "Contact" : "Owner"}</span>
          <span />
          <span />
        </div>
        {shown.length === 0 && <div className="ld-empty">{q.isLoading ? "Loading..." : tab === "new" ? `No new prospects. Ask ${emp.name} in Chat to find some.` : "Nothing here yet."}</div>}
        {shown.map((p) => {
          const isOpen = open === p.id;
          const d = parseJson<{ size?: string; partnerType?: string }>(p.details, {});
          const isEditing = editing === p.id;
          return (
            <React.Fragment key={p.id}>
              <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS, cursor: "pointer" }} aria-expanded={isOpen} onClick={(e) => { if ((e.target as HTMLElement).closest("button,a,input")) return; setOpen(isOpen ? null : p.id); setEditing(null); }}>
                <span className="ld-strong">{p.name}</span>
                <span>{p.city ?? ""}</span>
                <span className={`ld-pill ${p.fitScore >= 70 ? "green" : "gray"}`}>{p.fitScore}</span>
                <span>{p.contactName ?? <span className="ld-muted">Not found</span>}</span>
                {tab === "new" ? (
                  <>
                    <button type="button" className="ld-btn p" disabled={start.isPending} onClick={() => { if (!p.email) { setOpen(p.id); setEditing(p.id); setForm({ contactName: p.contactName ?? "", email: "", phone: p.phone ?? "" }); return; } start.mutate({ organizationId: currentOrgId, ids: [p.id] }); }}>Start outreach</button>
                    <button type="button" className="ld-btn" disabled={notFit.isPending} onClick={() => notFit.mutate({ organizationId: currentOrgId, id: p.id })}>Not a fit</button>
                  </>
                ) : (
                  <>
                    <span className={`ld-pill ${STAGE[tab].cls}`}>{STAGE[tab].label}</span>
                    <button type="button" className="ld-btn" onClick={() => { setOpen(isOpen ? null : p.id); setEditing(null); }}>{isOpen ? "Close" : "Open"}</button>
                  </>
                )}
              </div>
              {isOpen && (
                <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 24 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <KV label="Why it fits">{p.fitReason || "No reason given."}</KV>
                    <KV label="Found on">
                      {p.foundOn ? `${p.foundOn} · ` : ""}
                      {p.sourceUrl ? <a href={p.sourceUrl} target="_blank" rel="noreferrer noopener">{p.sourceUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a> : null}
                    </KV>
                    {(d.size || d.partnerType) && <KV label={d.partnerType ? "Type" : "Size"}>{[d.partnerType, d.size].filter(Boolean).join(" · ")}</KV>}
                  </div>
                  {isEditing ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div className="ld-field"><label className="ld-lbl" htmlFor={`pc-${p.id}`}>{referral ? "Contact" : "Owner"}</label><input id={`pc-${p.id}`} className="ld-in" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></div>
                      <div className="ld-field"><label className="ld-lbl" htmlFor={`pe-${p.id}`}>Email</label><input id={`pe-${p.id}`} className="ld-in" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                      <div className="ld-field"><label className="ld-lbl" htmlFor={`pp-${p.id}`}>Phone</label><input id={`pp-${p.id}`} className="ld-in" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                      <ErrorLine error={save.error} />
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <KV label={referral ? "Contact" : "Owner"}>{[p.contactName, p.contactTitle].filter(Boolean).join(", ") || "Not found"}</KV>
                      <KV label="Email">{p.email ?? "Not on their site"}</KV>
                      <KV label="Phone">{p.phone ?? "Not on their site"}</KV>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {isEditing ? (
                      <>
                        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: p.id, ...form })}>Save</button>
                        <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="ld-btn" onClick={() => { setEditing(p.id); setForm({ contactName: p.contactName ?? "", email: p.email ?? "", phone: p.phone ?? "" }); }}>Edit</button>
                        <button type="button" className="ld-btn" onClick={() => setOpen(null)}>Close</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        {(start.error || notFit.error) && <div style={{ padding: "8px 18px" }}><ErrorLine error={start.error || notFit.error} /></div>}
      </FolderTabs>
    </main>
  );
}
