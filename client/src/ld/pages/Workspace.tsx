import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, OrgLogo, Page } from "../ui";
import { initials, parseJson } from "../meta";

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

const LOGO_MAX = 8 * 1024 * 1024;

type SectionKey = "about" | "basic" | "brand";

type Form = {
  description: string;
  audience: string;
  entity: string;
  website: string;
  state: string;
  ein: string;
  annualBudget: string;
  focusAreas: string;
  timezone: string;
  brandColors: string;
  fonts: string;
};

function NotSet() {
  return <span className="ld-muted">Not set</span>;
}

function val(v: string | null | undefined) {
  return v && v.trim() ? <span style={{ overflowWrap: "anywhere" }}>{v}</span> : <NotSet />;
}

function colorsOf(raw: string | null | undefined) {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

export default function Workspace() {
  const { currentOrg, refetchOrgs } = useTenant();
  const [editing, setEditing] = React.useState<SectionKey | null>(null);
  const [f, setF] = React.useState<Form | null>(null);
  const [logoError, setLogoError] = React.useState<string | null>(null);

  const update = trpc.organizations.update.useMutation({
    onSuccess: async () => {
      await refetchOrgs();
      setEditing(null);
    },
  });
  const uploadLogo = trpc.organizations.uploadLogo.useMutation({ onSuccess: () => refetchOrgs() });
  const removeLogo = trpc.organizations.removeLogo.useMutation({ onSuccess: () => refetchOrgs() });
  const logoRef = React.useRef<HTMLInputElement>(null);

  if (!currentOrg) {
    return (
      <Page rail="workspace" maxWidth={920}>
        <div className="ld-empty">Loading...</div>
      </Page>
    );
  }
  const o = currentOrg;

  const start = (key: SectionKey) => {
    update.reset();
    setLogoError(null);
    setF({
      description: o.description ?? "",
      audience: o.audience ?? "",
      entity: o.entity ?? "",
      website: o.website ?? "",
      state: o.state ?? "",
      ein: o.ein ?? "",
      annualBudget: o.annualBudget ?? "",
      focusAreas: o.focusAreas ?? "",
      timezone: o.timezone || "America/Chicago",
      brandColors: o.brandColors ?? "",
      fonts: o.fonts ?? "",
    });
    setEditing(key);
  };

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((p) => (p ? { ...p, [k]: e.target.value } : p));

  const save = (key: SectionKey) => {
    if (!f) return;
    if (key === "about") update.mutate({ id: o.id, description: f.description.trim(), audience: f.audience.trim(), entity: f.entity.trim() });
    if (key === "basic")
      update.mutate({
        id: o.id,
        website: f.website.trim(),
        state: f.state.trim(),
        ein: f.ein.trim(),
        annualBudget: f.annualBudget.trim(),
        focusAreas: f.focusAreas.trim(),
        timezone: f.timezone,
      });
    if (key === "brand") update.mutate({ id: o.id, brandColors: colorsOf(f.brandColors).join(", "), fonts: f.fonts.trim() });
  };

  const onLogo = (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    if (file.size > LOGO_MAX) {
      setLogoError("Logos can be up to 8 MB.");
      return;
    }
    const r = new FileReader();
    r.onload = () => uploadLogo.mutate({ id: o.id, data: String(r.result) });
    r.onerror = () => setLogoError("That file could not be read.");
    r.readAsDataURL(file);
  };

  const header = (key: SectionKey, title: string) => (
    <div className="ld-sh">
      <span className="ld-st">{title}</span>
      {editing === key ? (
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>
            Cancel
          </button>
          <button type="button" className="ld-btn sm p" disabled={update.isPending} onClick={() => save(key)}>
            Save
          </button>
        </span>
      ) : (
        <button type="button" className="ld-btn sm" disabled={editing !== null} onClick={() => start(key)}>
          Edit
        </button>
      )}
    </div>
  );

  const tzLabel = TIMEZONES.find((t) => t.value === o.timezone)?.label ?? o.timezone;
  const swatches = colorsOf(o.brandColors);
  const kStart: React.CSSProperties = { alignSelf: "start", paddingTop: 6 };

  return (
    <Page rail="workspace" maxWidth={920}>
      <div className="ld-row" style={{ gap: 16 }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 14,
            background: "#fff",
            border: "1px solid #e3e9e6",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            color: "#1b6b4a",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {o.logoUrl ? <img src={o.logoUrl} alt={`${o.name} logo`} style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : initials(o.name)}
        </div>
        <h1 className="ld-h1">{o.name}</h1>
      </div>

      <section className={`ld-card ${editing === "about" ? "editing" : ""}`}>
        {header("about", "About the business")}
        {editing === "about" && f ? (
          <div className="ld-kv">
            <label htmlFor="w-desc" className="ld-k" style={kStart}>What it is</label>
            <textarea id="w-desc" className="ld-ta" rows={2} value={f.description} onChange={set("description")} />
            <label htmlFor="w-aud" className="ld-k" style={kStart}>Who it serves</label>
            <textarea id="w-aud" className="ld-ta" rows={2} value={f.audience} onChange={set("audience")} />
            <label htmlFor="w-ent" className="ld-k">Entity</label>
            <input id="w-ent" className="ld-in" type="text" value={f.entity} onChange={set("entity")} />
          </div>
        ) : (
          <div className="ld-kv" style={{ alignItems: "start" }}>
            <span className="ld-k">What it is</span>
            {val(o.description)}
            <span className="ld-k">Who it serves</span>
            {val(o.audience)}
            <span className="ld-k">Entity</span>
            {val(o.entity)}
          </div>
        )}
      </section>

      <section className={`ld-card ${editing === "basic" ? "editing" : ""}`}>
        {header("basic", "Basic information")}
        {editing === "basic" && f ? (
          <div className="ld-kv">
            <label htmlFor="w-web" className="ld-k">Website</label>
            <input id="w-web" className="ld-in" type="text" value={f.website} onChange={set("website")} />
            <label htmlFor="w-loc" className="ld-k">Location</label>
            <input id="w-loc" className="ld-in" type="text" value={f.state} onChange={set("state")} />
            <label htmlFor="w-ein" className="ld-k">EIN</label>
            <input id="w-ein" className="ld-in" type="text" value={f.ein} onChange={set("ein")} />
            <label htmlFor="w-bud" className="ld-k">Annual budget</label>
            <input id="w-bud" className="ld-in" type="text" value={f.annualBudget} onChange={set("annualBudget")} />
            <label htmlFor="w-focus" className="ld-k" style={kStart}>Focus areas</label>
            <textarea id="w-focus" className="ld-ta" rows={2} value={f.focusAreas} onChange={set("focusAreas")} />
            <label htmlFor="w-tz" className="ld-k">Time zone</label>
            <select id="w-tz" className="ld-in" value={f.timezone} onChange={set("timezone")}>
              {!TIMEZONES.some((t) => t.value === f.timezone) && <option value={f.timezone}>{f.timezone}</option>}
              {TIMEZONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="ld-kv" style={{ alignItems: "start" }}>
            <span className="ld-k">Website</span>
            {val(o.website)}
            <span className="ld-k">Location</span>
            {val(o.state)}
            <span className="ld-k">EIN</span>
            {val(o.ein)}
            <span className="ld-k">Annual budget</span>
            {val(o.annualBudget)}
            <span className="ld-k">Focus areas</span>
            {val(o.focusAreas)}
            <span className="ld-k">Time zone</span>
            {val(tzLabel)}
          </div>
        )}
      </section>

      <section className={`ld-card ${editing === "brand" ? "editing" : ""}`}>
        {header("brand", "Brand")}
        {editing === "brand" && f ? (
          <div className="ld-kv">
            <label htmlFor="w-logo" className="ld-k">Logo</label>
            <span className="ld-row" style={{ flexWrap: "wrap", gap: 12 }}>
              <OrgLogo name={o.name} src={o.logoUrl} size={40} />
              <input id="w-logo" ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={(e) => { onLogo(e.target.files?.[0]); e.target.value = ""; }} />
              <button type="button" className="ld-btn sm" style={{ width: 120 }} disabled={uploadLogo.isPending} onClick={() => logoRef.current?.click()}>{uploadLogo.isPending ? "Uploading..." : o.logoUrl ? "Change logo" : "Upload logo"}</button>
              {o.logoUrl && <button type="button" className="ld-btn sm" style={{ width: 120 }} disabled={removeLogo.isPending} onClick={() => removeLogo.mutate({ id: o.id })}>Remove</button>}
            </span>
            <label htmlFor="w-colors" className="ld-k">Colors</label>
            <input id="w-colors" className="ld-in" type="text" placeholder="#0d3b2e, #e88a3a" value={f.brandColors} onChange={set("brandColors")} />
            <label htmlFor="w-fonts" className="ld-k">Fonts</label>
            <input id="w-fonts" className="ld-in" type="text" value={f.fonts} onChange={set("fonts")} />
          </div>
        ) : (
          <div className="ld-kv">
            <span className="ld-k">Logo</span>
            {o.logoUrl ? <img src={o.logoUrl} alt={`${o.name} logo`} style={{ height: 32, maxWidth: 160, objectFit: "contain", justifySelf: "start" }} /> : <NotSet />}
            <span className="ld-k">Colors</span>
            {swatches.length ? (
              <span className="ld-row" style={{ flexWrap: "wrap", gap: 8 }}>
                {swatches.map((c, i) => (
                  <span key={`${c}-${i}`} className="ld-row" style={{ gap: 8, marginLeft: i ? 10 : 0 }}>
                    <span style={{ width: 22, height: 22, borderRadius: 6, background: c, border: "1px solid #e3e9e6" }} />
                    {c}
                  </span>
                ))}
              </span>
            ) : (
              <NotSet />
            )}
            <span className="ld-k">Fonts</span>
            {val(o.fonts)}
          </div>
        )}
      </section>
      {logoError && (
        <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>
          {logoError}
        </p>
      )}
      <ErrorLine error={update.error ?? uploadLogo.error ?? removeLogo.error} />
      <Registrations />
    </Page>
  );
}

// ==========================================
// Registrations (federal and state)
// ==========================================

const REG_INFO: Record<string, { name: string; detail: string; fields: { key: string; label: string }[] }> = {
  sam: { name: "SAM.gov", detail: "Needed for every federal grant", fields: [{ key: "uei", label: "UEI" }] },
  grants_gov: { name: "Grants.gov", detail: "Your account and role", fields: [{ key: "email", label: "Account email" }, { key: "role", label: "Role" }] },
  login_gov: { name: "Login.gov", detail: "Used to sign in to SAM.gov and Grants.gov", fields: [{ key: "email", label: "Account email" }] },
  sbir: { name: "SBIR.gov company registry", detail: "Needed for SBIR and STTR", fields: [{ key: "number", label: "SBC control ID" }] },
  state_supplier: { name: "State supplier portal", detail: "Needed for state contracts", fields: [{ key: "number", label: "Supplier number" }] },
  candid: { name: "Candid profile", detail: "Nonprofits: funders look you up here", fields: [{ key: "url", label: "Profile link" }] },
};
const REG_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "green" },
  set_up: { label: "Set up", cls: "green" },
  not_verified: { label: "Not verified", cls: "amber" },
  not_started: { label: "Not started", cls: "gray" },
  expired: { label: "Expired", cls: "red" },
};
const RG_COLS = "minmax(0,1.3fr) minmax(0,1.6fr) 140px 96px";

function Registrations() {
  const { currentOrgId } = useTenant();
  const q = trpc.registrations.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <section className="ld-card" style={{ overflow: "hidden" }}>
      <div className="ld-sh"><span className="ld-st">Registrations</span></div>
      <div className="ld-hd" style={{ gridTemplateColumns: RG_COLS }}><span>Registration</span><span>Details</span><span>Status</span><span /></div>
      {(q.data ?? []).map((r) => {
        const info = REG_INFO[r.kind];
        const d = parseJson<Record<string, string>>(r.details, {});
        const st = REG_STATUS[r.status] ?? REG_STATUS.not_started;
        const summary = [info.fields.map((f) => d[f.key]).filter(Boolean).join(", "), r.expires && `expires ${r.expires}`].filter(Boolean).join(" · ") || info.detail;
        return open === r.kind ? (
          <RegEditor key={r.kind} kind={r.kind} details={d} status={r.status} expires={r.expires ?? ""} onDone={() => setOpen(null)} />
        ) : (
          <div key={r.kind} className="ld-rw" style={{ gridTemplateColumns: RG_COLS }}>
            <span className="ld-strong">{info.name}</span>
            <span className="ld-muted ld-clip">{summary}</span>
            <span className={`ld-pill ${st.cls}`}>{st.label}</span>
            <button type="button" className="ld-btn sm" onClick={() => setOpen(r.kind)}>Edit</button>
          </div>
        );
      })}
    </section>
  );
}

function RegEditor({ kind, details, status, expires, onDone }: { kind: string; details: Record<string, string>; status: string; expires: string; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const info = REG_INFO[kind];
  const [d, setD] = React.useState<Record<string, string>>(details);
  const [st, setSt] = React.useState(status);
  const [exp, setExp] = React.useState(expires);
  const save = trpc.registrations.save.useMutation({ onSuccess: async () => { await utils.registrations.list.invalidate(); onDone(); } });
  return (
    <>
      <div className="ld-rw open" style={{ gridTemplateColumns: RG_COLS }}>
        <span className="ld-strong">{info.name}</span>
        <span className="ld-muted">{info.detail}</span>
        <span />
        <span />
      </div>
      <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px", gap: 14, alignItems: "start" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 10 }}>
          {info.fields.map((f) => (
            <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="ld-lbl" htmlFor={`rg-${kind}-${f.key}`}>{f.label}</label>
              <input id={`rg-${kind}-${f.key}`} className="ld-in" value={d[f.key] ?? ""} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
            </div>
          ))}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor={`rg-${kind}-exp`}>Expires (MM/DD/YYYY)</label>
            <input id={`rg-${kind}-exp`} className="ld-in" inputMode="numeric" value={exp} onChange={(e) => setExp(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor={`rg-${kind}-st`}>Status</label>
            <select id={`rg-${kind}-st`} className="ld-in" value={st} onChange={(e) => setSt(e.target.value)}>
              {Object.entries(REG_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}><ErrorLine error={save.error} /></div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, kind: kind as never, status: st as never, details: d, expires: exp.trim() })}>Save</button>
          <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
        </div>
      </div>
    </>
  );
}
