import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, Page } from "../ui";
import { initials } from "../meta";

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
            <span className="ld-row" style={{ flexWrap: "wrap" }}>
              {o.logoUrl ? <img src={o.logoUrl} alt="" style={{ width: 32, height: 32, objectFit: "contain", borderRadius: 6, border: "1px solid #e3e9e6" }} /> : null}
              <input id="w-logo" type="file" className="ld-small" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={(e) => onLogo(e.target.files?.[0])} />
              {uploadLogo.isPending && <span className="ld-small ld-muted">Uploading...</span>}
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
      <ErrorLine error={update.error ?? uploadLogo.error} />
    </Page>
  );
}
