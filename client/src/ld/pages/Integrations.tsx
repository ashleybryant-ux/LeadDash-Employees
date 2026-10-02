import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs, Page } from "../ui";
import { parseJson } from "../meta";

type Provider = "google_workspace" | "linkedin" | "facebook" | "instagram" | "wordpress" | "x" | "google_business";

type CatalogItem = { key: string; name: string; provider: Provider; logo: string; color: string; desc: string };

const CATALOG: CatalogItem[] = [
  { key: "facebook", name: "Facebook", provider: "facebook", logo: "f", color: "#1877f2", desc: "Sienna posts to your page after you approve." },
  { key: "linkedin", name: "LinkedIn", provider: "linkedin", logo: "in", color: "#0a66c2", desc: "Sienna posts to your profile or page after you approve." },
  { key: "instagram", name: "Instagram", provider: "instagram", logo: "IG", color: "#c13584", desc: "Sienna posts images and captions after you approve." },
  { key: "gmail", name: "Gmail", provider: "google_workspace", logo: "G", color: "#db4437", desc: "Avery reads your inbox and sends replies you approve." },
  { key: "gcal", name: "Google Calendar", provider: "google_workspace", logo: "31", color: "#4285f4", desc: "Avery places holds you approve." },
  { key: "wordpress", name: "WordPress", provider: "wordpress", logo: "W", color: "#21759b", desc: "Theo saves approved articles as drafts on your site." },
  { key: "x", name: "X", provider: "x", logo: "X", color: "#111111", desc: "Sienna posts the short version after you approve." },
  { key: "gbp", name: "Google Business Profile", provider: "google_business", logo: "GB", color: "#34a853", desc: "Sienna posts updates to your listing after you approve." },
];

type FieldDef = { key: string; label: string; secret?: boolean };

const SECRET_LABELS: Record<string, string> = { clientSecret: "Client secret", appSecret: "App secret", appPassword: "Application password" };

function fieldsFor(p: Provider): FieldDef[] {
  if (p === "wordpress")
    return [
      { key: "username", label: "Username" },
      { key: "appPassword", label: "Application password", secret: true },
    ];
  if (p === "facebook" || p === "instagram")
    return [
      { key: "appId", label: "App ID" },
      { key: "appSecret", label: "App secret", secret: true },
      { key: "pageId", label: "Page or account ID" },
    ];
  return [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
  ];
}

type Conn = {
  provider: string;
  accountLabel: string;
  accountHandle: string | null;
  status: "disconnected" | "pending" | "connected" | "error";
  settings: string | null;
  savedSecrets: string[];
};

const tile: React.CSSProperties = {
  font: "inherit",
  height: 36,
  width: 128,
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: 0,
  cursor: "pointer",
  boxSizing: "border-box",
};
const okTile: React.CSSProperties = { ...tile, background: "#e6f2ec", color: "#155c3e" };
const warnTile: React.CSSProperties = { ...tile, background: "#fdf0e3", color: "#8a4510" };

export default function Integrations() {
  const { currentOrgId } = useTenant();
  const q = trpc.publishing.listConnections.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [tab, setTab] = React.useState<"all" | "connected">("all");
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);

  const conns = (q.data ?? []) as Conn[];
  const connOf = (p: Provider) => conns.find((c) => c.provider === p);
  const isConnected = (c: CatalogItem) => connOf(c.provider)?.status === "connected";
  const connectedCount = CATALOG.filter(isConnected).length;
  const needle = search.trim().toLowerCase();
  const shown = CATALOG.filter((c) => (tab === "all" || isConnected(c)) && (!needle || c.name.toLowerCase().includes(needle)));

  return (
    <Page rail="integrations" maxWidth={1140}>
      <h1 className="ld-h1">Integrations</h1>
      <label htmlFor="int-search" className="ld-sr">Search integrations</label>
      <input
        id="int-search"
        type="text"
        placeholder="Search integrations"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ height: 44, border: "1px solid #cfd9d4", borderRadius: 10, padding: "0 14px", font: "inherit", fontSize: 14, background: "#fff", boxSizing: "border-box" }}
      />
      <p className="ld-small ld-muted" style={{ margin: 0 }}>Sending is not switched on yet. Approved items wait until each channel is verified.</p>

      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "all", label: `All (${CATALOG.length})` },
          { key: "connected", label: `Connected (${connectedCount})` },
        ]}
      >
        <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, alignItems: "start" }}>
          {shown.length === 0 && (
            <div className="ld-empty" style={{ gridColumn: "1 / -1" }}>
              {q.isLoading ? "Loading..." : tab === "connected" ? "Nothing is connected yet." : "No integrations match."}
            </div>
          )}
          {shown.map((c) => {
            const conn = connOf(c.provider);
            const isOpen = open === c.key;
            const toggle = () => setOpen(isOpen ? null : c.key);
            let right: React.ReactNode;
            if (conn?.status === "connected") right = <button type="button" style={okTile} onClick={toggle} aria-expanded={isOpen}>Connected</button>;
            else if (conn?.status === "pending") right = <button type="button" style={warnTile} onClick={toggle} aria-expanded={isOpen}>Not verified</button>;
            else if (conn?.status === "error") right = <button type="button" style={warnTile} onClick={toggle} aria-expanded={isOpen}>Needs attention</button>;
            else right = <button type="button" className="ld-btn p" onClick={toggle} aria-expanded={isOpen}>Connect</button>;
            return (
              <div
                key={c.key}
                style={{ background: "#fff", border: `1px solid ${isOpen ? "#1b6b4a" : "#e3e9e6"}`, borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) 128px", gap: 14, alignItems: "center" }}>
                  <div style={{ width: 44, height: 44, borderRadius: 10, background: c.color, color: "#fff", fontWeight: 800, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
                    {c.logo}
                  </div>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>{c.name}</div>
                    <div style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.45 }}>{c.desc}</div>
                  </div>
                  {right}
                </div>
                {isOpen && <ConnectForm item={c} conn={conn} onDone={() => setOpen(null)} />}
              </div>
            );
          })}
        </div>
      </FolderTabs>
    </Page>
  );
}

function ConnectForm({ item, conn, onDone }: { item: CatalogItem; conn: Conn | undefined; onDone: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const fields = fieldsFor(item.provider);
  const existing = parseJson<Record<string, unknown>>(conn?.settings, {});
  const [label, setLabel] = React.useState(conn?.accountLabel ?? "");
  const [handle, setHandle] = React.useState(conn?.accountHandle ?? "");
  const [values, setValues] = React.useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of fields) v[f.key] = f.secret ? "" : typeof existing[f.key] === "string" ? (existing[f.key] as string) : "";
    return v;
  });
  const done = async () => {
    await utils.publishing.listConnections.invalidate();
    onDone();
  };
  const save = trpc.publishing.updateConnection.useMutation({ onSuccess: done });

  const submit = (status: "pending" | "disconnected") => {
    const settings: Record<string, unknown> = { ...existing };
    for (const f of fields) {
      const v = values[f.key]?.trim() ?? "";
      if (f.secret) {
        if (v && status !== "disconnected") settings[f.key] = v;
      } else {
        settings[f.key] = v;
      }
    }
    save.mutate({
      organizationId: currentOrgId,
      provider: item.provider,
      accountLabel: label.trim() || conn?.accountLabel || `${item.name} account`,
      accountHandle: handle.trim() || undefined,
      status,
      settings: JSON.stringify(settings),
    });
  };

  const id = `c-${item.key}`;
  const saved = (conn?.savedSecrets ?? []).filter((s) => fields.some((f) => f.key === s));
  const isWp = item.provider === "wordpress";

  return (
    <div style={{ borderTop: "1px solid #eef2f0", paddingTop: 14, display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, alignItems: "start" }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor={`${id}-label`} className="ld-lbl">Account name</label>
          <input id={`${id}-label`} className="ld-in" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label htmlFor={`${id}-handle`} className="ld-lbl">{isWp ? "Site API address" : "Handle or link"}</label>
          <input
            id={`${id}-handle`}
            className="ld-in"
            type="text"
            placeholder={isWp ? "https://site.com/wp-json/wp/v2" : undefined}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
        </div>
        {fields.map((f) => (
          <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label htmlFor={`${id}-${f.key}`} className="ld-lbl">{f.label}</label>
            <input
              id={`${id}-${f.key}`}
              className="ld-in"
              type={f.secret ? "password" : "text"}
              autoComplete={f.secret ? "new-password" : "off"}
              placeholder={f.secret && saved.includes(f.key) ? "Saved" : undefined}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
            />
          </div>
        ))}
        {saved.length > 0 && (
          <span className="ld-small ld-muted" style={{ gridColumn: "span 2" }}>
            Saved: {saved.map((s) => SECRET_LABELS[s] ?? s).join(", ")}
          </span>
        )}
        <div style={{ gridColumn: "span 2" }}>
          <ErrorLine error={save.error} />
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => submit("pending")}>
          Save
        </button>
        <button type="button" className="ld-btn" onClick={onDone}>
          Cancel
        </button>
        {conn && conn.status !== "disconnected" && (
          <button type="button" className="ld-btn danger" disabled={save.isPending} onClick={() => submit("disconnected")}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
