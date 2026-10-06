import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, UnderlineTabs } from "../ui";
import type { Outputs } from "../types";
import { Stat } from "./Billing";
import { mdy } from "../sops/shared";

type Desk = Outputs["compliance"]["desk"];
type Item = Desk["items"][number];
type Tab = "today" | "dates" | "documentation" | "sops";
type Form = { kind: Item["kind"]; title: string; who: string; due: string; note: string };

const COLS = "150px minmax(0,1fr) 170px 120px 110px 96px";

/** Camille's Compliance tab: the dates the practice typed in, the EHR counts by clinician, and SOPs past review. */
export default function Compliance() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.compliance.desk.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [tab, setTab] = React.useState<Tab>("today");
  const [editing, setEditing] = React.useState<number | "new" | null>(null);
  const [form, setForm] = React.useState<Form>({ kind: "caqh", title: "", who: "", due: "", note: "" });
  const [error, setError] = React.useState<string | null>(null);
  const done = async () => {
    setEditing(null);
    setError(null);
    await utils.compliance.desk.invalidate();
  };
  const add = trpc.compliance.add.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const save = trpc.compliance.save.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const setDone = trpc.compliance.setDone.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const remove = trpc.compliance.remove.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const d = q.data;
  if (!d) return <main className="ld-main" style={{ padding: "20px 32px" }}><div className="ld-empty">{q.isLoading ? "Loading..." : "Could not load."}</div></main>;
  const start = (it: Item | null) => {
    setError(null);
    setForm(it ? { kind: it.kind, title: it.title, who: it.who, due: mdy(it.due), note: it.note } : { kind: "caqh", title: "", who: "", due: "", note: "" });
    setEditing(it ? it.id : "new");
  };
  const submit = () => {
    const input = { organizationId: currentOrgId, kind: form.kind, title: form.title.trim(), who: form.who.trim(), due: form.due.trim(), note: form.note.trim() };
    if (editing === "new") add.mutate(input);
    else if (typeof editing === "number") save.mutate({ ...input, id: editing });
  };
  const rows = tab === "today" ? d.due30 : d.items.filter((i) => i.status === "open");
  const tabs: { key: Tab; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "dates", label: `Dates (${d.items.filter((i) => i.status === "open").length})` },
    { key: "documentation", label: "Documentation" },
    { key: "sops", label: `SOPs (${d.counts.sopsDue})` },
  ];
  const editor = (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 170px 120px", gap: 10, alignItems: "end", paddingTop: 12 }}>
      <label className="ld-lbl" style={{ gridColumn: "1 / -1" }}>{editing === "new" ? "New date" : "Edit"}</label>
      <select className="ld-in" aria-label="Kind" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as Item["kind"] }))}>
        {d.kinds.map((k) => (
          <option key={k.key} value={k.key}>{k.label}</option>
        ))}
      </select>
      <input className="ld-in" aria-label="What it is" placeholder="LPC renewal, Oklahoma" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
      <input className="ld-in" aria-label="Who" placeholder="Who" value={form.who} onChange={(e) => setForm((f) => ({ ...f, who: e.target.value }))} />
      <input className="ld-in" aria-label="Due" placeholder="MM/DD/YYYY" value={form.due} onChange={(e) => setForm((f) => ({ ...f, due: e.target.value }))} />
      <input className="ld-in" aria-label="Note" placeholder="Note (16 of 20 CE hours on file)" style={{ gridColumn: "1 / 4" }} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
      <span style={{ display: "flex", gap: 8 }}>
        <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
        <button type="button" className="ld-btn sm p" disabled={add.isPending || save.isPending || !form.title.trim()} onClick={submit}>Save</button>
      </span>
      {error && <span className="ld-small" style={{ color: "#b42318", gridColumn: "1 / -1" }}>{error}</span>}
    </div>
  );
  return (
    <main className="ld-main" style={{ padding: "20px 32px", gap: 14 }}>
      <UnderlineTabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "today" && (
        <div className="ld-stats4">
          <Stat label="Due in 30 days" value={String(d.counts.due30)} />
          <Stat label="Unsigned notes" value={d.ehr.connected ? String(d.counts.unsigned) : "Not connected"} />
          <Stat label="Treatment plans due" value={d.ehr.connected ? String(d.counts.plansDue) : "Not connected"} />
          <Stat label="SOPs to review" value={String(d.counts.sopsDue)} />
        </div>
      )}
      {(tab === "today" || tab === "dates") && (
        <section className="ld-card">
          <div className="ld-sh">
            <span className="ld-st">{tab === "today" ? "Due in the next 30 days" : "Every date"}</span>
            <button type="button" className="ld-btn sm" disabled={editing !== null} onClick={() => start(null)}>Add date</button>
          </div>
          {editing === "new" && editor}
          <div className="ld-hd cp-cols" style={{ gridTemplateColumns: COLS }}><span>What</span><span>Detail</span><span>Who</span><span>Due</span><span>Status</span><span /></div>
          {rows.length === 0 && editing !== "new" && <div className="ld-empty">{tab === "today" ? "Nothing due in the next 30 days." : "No dates yet. Add the CAQH attestations, license renewals, trainings and payer enrollments to track."}</div>}
          {rows.map((it) => (
            <React.Fragment key={it.id}>
              <div className={`ld-rw cp-cols ${editing === it.id ? "open" : ""}`} style={{ gridTemplateColumns: COLS, alignItems: "start" }}>
                <span className="ld-strong">{it.kindLabel}</span>
                <span>{it.title}{it.note ? <><br /><span className="ld-small ld-muted">{it.note}</span></> : null}</span>
                <span>{it.who || <span className="ld-muted">Anyone</span>}</span>
                <span>{it.dueText || <span className="ld-muted">No date</span>}</span>
                <span className={`ld-pill ${it.overdue ? "red" : it.dueSoon ? "amber" : "gray"}`}>{it.overdue ? `${-it.days!} days late` : it.days !== null ? `${it.days} days` : "Open"}</span>
                <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button type="button" className="ld-btn xs" disabled={editing !== null} onClick={() => start(it)}>Edit</button>
                  <button type="button" className="ld-btn xs p" disabled={setDone.isPending} onClick={() => setDone.mutate({ organizationId: currentOrgId, id: it.id, done: true })}>Done</button>
                  <button type="button" className="ld-btn xs" style={{ color: "#b42318" }} disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: it.id })}>Remove</button>
                </span>
              </div>
              {editing === it.id && editor}
            </React.Fragment>
          ))}
        </section>
      )}
      {(tab === "today" || tab === "documentation") && (
        <section className="ld-card">
          <div className="ld-sh"><span className="ld-st">Documentation · from LeadDash EHR</span><span className="ld-small ld-muted">Counts only. Camille never reads a note.</span></div>
          {!d.ehr.connected && <div className="ld-empty">LeadDash EHR is not connected. Connect it on <Link href="/integrations">Integrations</Link> and the counts by clinician show here.</div>}
          {d.ehr.connected && d.docs.length === 0 && <div className="ld-empty">Nothing unsigned or due. {d.ehr.error ? `Last read failed: ${d.ehr.error}` : ""}</div>}
          {d.docs.length > 0 && (
            <>
              <div className="ld-hd cp-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 170px 190px 140px 120px" }}><span>Clinician</span><span>Unsigned past the limit</span><span>Plans due for review</span><span>Measures overdue</span><span /></div>
              {d.docs.map((c) => (
                <div key={c.clinician} className="ld-rw cp-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 170px 190px 140px 120px" }}>
                  <span className="ld-strong">{c.clinician}</span>
                  <span>{c.unsigned}{c.oldestUnsigned ? <span className="ld-small ld-muted"> (oldest {c.oldestUnsigned})</span> : ""}</span>
                  <span>{c.plansDue}{c.plansDueSoonest ? <span className="ld-small ld-muted"> (soonest {c.plansDueSoonest})</span> : ""}</span>
                  <span>{c.measuresOverdue}</span>
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className={`ld-btn ${c.unsigned ? "p" : ""}`} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open in EHR</a>
                </div>
              ))}
            </>
          )}
        </section>
      )}
      {(tab === "today" || tab === "sops") && (d.sops.length > 0 || tab === "sops") && (
        <section className="ld-card">
          <div className="ld-sh"><span className="ld-st">SOPs past their review date</span><span className="ld-small ld-muted">{d.sops.length}</span></div>
          {d.sops.length === 0 && <div className="ld-empty">Every SOP is within its review date.</div>}
          {d.sops.map((s) => (
            <div key={s.id} className="ld-rw cp-cols" style={{ gridTemplateColumns: "minmax(0,1fr) 150px 150px 120px" }}>
              <span className="ld-strong">{s.title}</span>
              <span>{s.ownerName}</span>
              <span>{s.nextReviewText}</span>
              <Link href={`/handbook/sop/${s.id}`} className="ld-btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open</Link>
            </div>
          ))}
        </section>
      )}
      <ErrorLine error={q.error} />
    </main>
  );
}
