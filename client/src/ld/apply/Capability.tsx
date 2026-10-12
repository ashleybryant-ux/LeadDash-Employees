import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine } from "../ui";
import { openDownload } from "../meta";

/**
 * Morgan's capability statement: the one page a buyer or funder reads. Read view
 * with Edit, Rewrite (Shorter or Fuller) and Download; Edit opens the fields.
 */

type Form = {
  overview: string;
  competencies: string;
  pastPerformance: string;
  differentiators: string;
  uei: string;
  cage: string;
  naics: string;
  certifications: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  web: string;
};

const toLines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export default function CapabilityTab() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.capability.get.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const done = () => utils.capability.get.invalidate();
  const save = trpc.capability.save.useMutation({ onSuccess: async () => { setEditing(null); await done(); } });
  const rewrite = trpc.capability.rewrite.useMutation({ onSuccess: async () => { setAsking(false); await done(); } });
  const dl = trpc.capability.download.useMutation({ onSuccess: openDownload });
  const [editing, setEditing] = React.useState<Form | null>(null);
  const [asking, setAsking] = React.useState(false);
  const c = q.data;
  if (!c) return <div className="ld-card ld-empty">{q.isLoading ? "Loading..." : "Couldn't load the capability statement."}</div>;
  const empty = !c.overview && !c.competencies.length;

  const open = () =>
    setEditing({
      overview: c.overview,
      competencies: c.competencies.join("\n"),
      pastPerformance: c.pastPerformance.join("\n"),
      differentiators: c.differentiators.join("\n"),
      uei: c.uei,
      cage: c.cage,
      naics: c.naics,
      certifications: c.certifications,
      contactName: c.contactName,
      contactEmail: c.contactEmail,
      contactPhone: c.contactPhone,
      web: c.web,
    });
  const set = (k: keyof Form, v: string) => setEditing((f) => (f ? { ...f, [k]: v } : f));

  if (editing) {
    const ta = (k: keyof Form, label: string, rows: number) => (
      <>
        <label className="ld-lbl ld-cap-l" htmlFor={`cap-${k}`}>{label}</label>
        <textarea id={`cap-${k}`} className="ld-in ld-cap-ta" rows={rows} value={editing[k]} onChange={(e) => set(k, e.target.value)} />
      </>
    );
    const pair = (label: string, a: keyof Form, b: keyof Form, la: string, lb: string) => (
      <>
        <span className="ld-lbl ld-cap-l">{label}</span>
        <div className="ld-cap-pair">
          <input className="ld-in" aria-label={la} placeholder={la} value={editing[a]} onChange={(e) => set(a, e.target.value)} />
          <input className="ld-in" aria-label={lb} placeholder={lb} value={editing[b]} onChange={(e) => set(b, e.target.value)} />
        </div>
      </>
    );
    return (
      <div className="ld-card ld-cap editing">
        <div className="ld-cap-ed">
          {ta("overview", "Overview", 2)}
          {ta("competencies", "Competencies", 3)}
          {ta("pastPerformance", "Past performance", 2)}
          {ta("differentiators", "Differentiators", 2)}
          {pair("UEI / CAGE", "uei", "cage", "UEI", "CAGE")}
          <label className="ld-lbl ld-cap-l" htmlFor="cap-naics">NAICS</label>
          <input id="cap-naics" className="ld-in" value={editing.naics} onChange={(e) => set("naics", e.target.value)} />
          <label className="ld-lbl ld-cap-l" htmlFor="cap-certs">Certifications</label>
          <input id="cap-certs" className="ld-in" value={editing.certifications} onChange={(e) => set("certifications", e.target.value)} />
          {pair("Contact", "contactName", "contactEmail", "Name and title", "Email")}
          {pair("Phone / web", "contactPhone", "web", "Phone", "Website")}
          <span />
          <ErrorLine error={save.error} />
        </div>
        <div className="ld-cap-btns">
          <button
            type="button"
            className="ld-btn p"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                organizationId: currentOrgId,
                ...editing,
                competencies: toLines(editing.competencies).slice(0, 8),
                pastPerformance: toLines(editing.pastPerformance).slice(0, 8),
                differentiators: toLines(editing.differentiators).slice(0, 8),
              })
            }
          >
            {save.isPending ? "Saving..." : "Save"}
          </button>
          <button type="button" className="ld-btn" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  const kv = (k: string, v: string) => (v ? (<React.Fragment key={k}><span className="ld-muted">{k}</span><span className="ld-cap-v">{v}</span></React.Fragment>) : null);
  const list = (xs: string[]) => <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>;

  return (
    <div className="ld-card ld-cap">
      {empty ? (
        <div className="ld-empty" style={{ textAlign: "left" }}>No capability statement yet. Morgan writes it from the Brain: what you do, who you've done it for, and your company data.</div>
      ) : (
        <div className="ld-cap-sheet">
          <div className="ld-cap-top">
            <h3>{c.name}</h3>
            {c.tagline && <span className="ld-small ld-muted">{c.tagline}</span>}
          </div>
          <div className="ld-cap-col">
            {c.overview && (<div><h4>Company overview</h4><p>{c.overview}</p></div>)}
            {c.competencies.length > 0 && (<div><h4>Core competencies</h4>{list(c.competencies)}</div>)}
            {c.pastPerformance.length > 0 && (<div><h4>Past performance</h4>{list(c.pastPerformance)}</div>)}
            {c.differentiators.length > 0 && (<div><h4>Differentiators</h4>{list(c.differentiators)}</div>)}
          </div>
          <div className="ld-cap-col">
            <div>
              <h4>Company data</h4>
              <div className="ld-cap-kv">{kv("UEI", c.uei)}{kv("CAGE", c.cage)}{kv("NAICS", c.naics)}{kv("Certified", c.certifications)}{!c.uei && !c.cage && !c.naics && !c.certifications && <span className="ld-muted" style={{ gridColumn: "1 / -1" }}>None added yet</span>}</div>
            </div>
            <div>
              <h4>Contact</h4>
              <div className="ld-cap-kv">{kv("Name", c.contactName)}{kv("Email", c.contactEmail)}{kv("Phone", c.contactPhone)}{kv("Web", c.web)}</div>
            </div>
          </div>
        </div>
      )}
      <div className="ld-cap-btns">
        {!empty && <button type="button" className="ld-btn" onClick={open}>Edit</button>}
        {empty ? (
          <button type="button" className="ld-btn p" disabled={rewrite.isPending} onClick={() => rewrite.mutate({ organizationId: currentOrgId, length: "first" })}>{rewrite.isPending ? "Writing..." : "Write it"}</button>
        ) : (
          <button type="button" className="ld-btn" disabled={rewrite.isPending} onClick={() => setAsking((v) => !v)} aria-expanded={asking}>{rewrite.isPending ? "Writing..." : "Rewrite"}</button>
        )}
        {asking && !rewrite.isPending && (
          <div className="ld-cap-ask" role="group" aria-label="How should Morgan rewrite it">
            <button type="button" className="ld-btn sm" onClick={() => rewrite.mutate({ organizationId: currentOrgId, length: "shorter" })}>Shorter</button>
            <button type="button" className="ld-btn sm" onClick={() => rewrite.mutate({ organizationId: currentOrgId, length: "fuller" })}>Fuller</button>
          </div>
        )}
        {!empty && <button type="button" className="ld-btn p" disabled={dl.isPending} onClick={() => dl.mutate({ organizationId: currentOrgId })}>Download</button>}
        <ErrorLine error={rewrite.error || dl.error} />
      </div>
    </div>
  );
}
