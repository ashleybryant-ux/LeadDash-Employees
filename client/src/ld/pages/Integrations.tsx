import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs, Page } from "../ui";
import { parseJson } from "../meta";

type Provider = "google_workspace" | "linkedin" | "facebook" | "instagram" | "wordpress" | "x" | "google_business" | "submittable" | "sessionize";

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
  { key: "submittable", name: "Submittable", provider: "submittable", logo: "S", color: "#c2410c", desc: "Morgan fills and submits foundation forms." },
  { key: "sessionize", name: "Sessionize", provider: "sessionize", logo: "Se", color: "#9a4d14", desc: "Taylor submits speaker applications." },
];

type FieldDef = { key: string; label: string; secret?: boolean };

const SECRET_LABELS: Record<string, string> = { clientSecret: "Client secret", appSecret: "App secret", appPassword: "Password" };

function fieldsFor(p: Provider): FieldDef[] {
  if (p === "submittable" || p === "sessionize")
    return [
      { key: "username", label: "Sign-in email" },
      { key: "appPassword", label: "Password", secret: true },
    ];
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
  const [tab, setTab] = React.useState<"all" | "connected" | "applying">(
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "applying" ? "applying" : "all"
  );
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);

  const conns = (q.data ?? []) as Conn[];
  const connOf = (p: Provider) => conns.find((c) => c.provider === p);
  const isConnected = (c: CatalogItem) => connOf(c.provider)?.status === "connected";
  const connectedCount = CATALOG.filter(isConnected).length;
  const needle = search.trim().toLowerCase();
  const shown = CATALOG.filter((c) => (tab === "all" || (tab === "connected" && isConnected(c))) && (!needle || c.name.toLowerCase().includes(needle)));

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
          { key: "applying", label: "Applying (5)" },
        ]}
      >
        {tab === "applying" ? (
          <Applying conns={conns} open={open} setOpen={setOpen} />
        ) : (
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
        )}
      </FolderTabs>
    </Page>
  );
}

// ==========================================
// Applying: who signs, Grants.gov, portals, Gmail, Sessionize
// ==========================================

function StatusTile({ conn, isOpen, toggle }: { conn: Conn | undefined; isOpen: boolean; toggle: () => void }) {
  if (conn?.status === "connected") return <button type="button" style={okTile} onClick={toggle} aria-expanded={isOpen}>Connected</button>;
  if (conn?.status === "pending") return <button type="button" style={warnTile} onClick={toggle} aria-expanded={isOpen}>Not verified</button>;
  if (conn?.status === "error") return <button type="button" style={warnTile} onClick={toggle} aria-expanded={isOpen}>Needs attention</button>;
  return <button type="button" className="ld-btn p" onClick={toggle} aria-expanded={isOpen}>Connect</button>;
}

const tileBox = (on: boolean): React.CSSProperties => ({ background: "#fff", border: `1px solid ${on ? "#1b6b4a" : "#e3e9e6"}`, borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 });

function TileHead({ logo, color, name, desc, right }: { logo: string; color: string; name: string; desc: string; right: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "44px minmax(0,1fr) 128px", gap: 14, alignItems: "center" }}>
      <div style={{ width: 44, height: 44, borderRadius: 10, background: color, color: "#fff", fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">{logo}</div>
      <div>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{name}</div>
        <div style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.45 }}>{desc}</div>
      </div>
      {right}
    </div>
  );
}

function Applying({ conns, open, setOpen }: { conns: Conn[]; open: string | null; setOpen: (k: string | null) => void }) {
  const connOf = (p: Provider) => conns.find((c) => c.provider === p);
  const item = (key: string) => CATALOG.find((c) => c.key === key)!;
  const toggle = (k: string) => setOpen(open === k ? null : k);
  const gmail = { ...item("gmail"), desc: "Morgan and Taylor send email applications." };
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <Signer />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, alignItems: "start" }}>
        <GrantsGov isOpen={open === "grantsgov"} toggle={() => toggle("grantsgov")} />
        {[item("submittable"), { key: "portals" } as CatalogItem, gmail, item("sessionize")].map((c) =>
          c.key === "portals" ? (
            <Portals key="portals" isOpen={open === "portals"} toggle={() => toggle("portals")} />
          ) : (
            <div key={c.key} style={tileBox(open === c.key)}>
              <TileHead logo={c.logo} color={c.color} name={c.name} desc={c.desc} right={<StatusTile conn={connOf(c.provider)} isOpen={open === c.key} toggle={() => toggle(c.key)} />} />
              {open === c.key && <ConnectForm item={c} conn={connOf(c.provider)} onDone={() => setOpen(null)} />}
            </div>
          )
        )}
      </div>
      <p className="ld-small ld-muted" style={{ margin: 0 }}>Sign-ins are saved encrypted. Automatic sending through each one is switched on after it is verified.</p>
    </div>
  );
}

function Signer() {
  const { currentOrg, refetchOrgs } = useTenant();
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState("");
  const [title, setTitle] = React.useState("");
  const save = trpc.organizations.update.useMutation({ onSuccess: async () => { await refetchOrgs(); setEditing(false); } });
  const org = currentOrg as (typeof currentOrg & { signerName?: string | null; signerTitle?: string | null }) | null;
  return (
    <div style={{ ...tileBox(editing), display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, alignItems: "center" }}>
      {editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor="sg-name">Signer name</label>
            <input id="sg-name" className="ld-in" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label className="ld-lbl" htmlFor="sg-title">Title</label>
            <input id="sg-title" className="ld-in" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div style={{ gridColumn: "span 2" }}><ErrorLine error={save.error} /></div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr)", gap: "6px 14px", fontSize: 14 }}>
          <span className="ld-lbl" style={{ alignSelf: "center" }}>Signs as</span>
          <span style={{ fontWeight: 700 }}>{org?.signerName ? `${org.signerName}${org.signerTitle ? `, ${org.signerTitle}` : ""}` : <span className="ld-muted">Not set</span>}</span>
          <span className="ld-lbl" style={{ alignSelf: "center" }}>Organization</span>
          <span>{org?.name}</span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {editing ? (
          <>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => org && save.mutate({ id: org.id, signerName: name.trim(), signerTitle: title.trim() })}>Save</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <button type="button" className="ld-btn" onClick={() => { setName(org?.signerName ?? ""); setTitle(org?.signerTitle ?? ""); setEditing(true); }}>Edit</button>
        )}
      </div>
    </div>
  );
}

function GrantsGov({ isOpen, toggle }: { isOpen: boolean; toggle: () => void }) {
  const { currentOrgId, currentOrg, refetchOrgs } = useTenant();
  const utils = trpc.useUtils();
  const regs = trpc.registrations.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const sam = regs.data?.find((r) => r.kind === "sam");
  const gg = regs.data?.find((r) => r.kind === "grants_gov");
  const samD = parseJson<Record<string, string>>(sam?.details, {});
  const ggD = parseJson<Record<string, string>>(gg?.details, {});
  const [uei, setUei] = React.useState("");
  const [ein, setEin] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("Expanded AOR");
  React.useEffect(() => {
    if (isOpen) {
      setUei(samD.uei ?? "");
      setEin(currentOrg?.ein ?? "");
      setEmail(ggD.email ?? "");
      setRole(ggD.role ?? "Expanded AOR");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const saveReg = trpc.registrations.save.useMutation();
  const saveOrg = trpc.organizations.update.useMutation();
  const [error, setError] = React.useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await saveReg.mutateAsync({ organizationId: currentOrgId, kind: "sam", status: sam && sam.status !== "not_started" ? sam.status : uei.trim() ? "not_verified" : "not_started", details: { ...samD, uei: uei.trim() }, expires: sam?.expires ?? "" });
      await saveReg.mutateAsync({ organizationId: currentOrgId, kind: "grants_gov", status: gg && ["active", "set_up"].includes(gg.status) ? gg.status : email.trim() ? "not_verified" : "not_started", details: { ...ggD, email: email.trim(), role } });
      if (currentOrg && ein.trim() !== (currentOrg.ein ?? "")) await saveOrg.mutateAsync({ id: currentOrg.id, ein: ein.trim() });
      await Promise.all([utils.registrations.list.invalidate(), refetchOrgs()]);
      toggle();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const ready = sam?.status === "active" && gg && ["active", "set_up"].includes(gg.status);
  const started = Boolean(samD.uei || ggD.email);
  return (
    <div style={{ ...tileBox(isOpen), gridRow: isOpen ? "span 2" : undefined }}>
      <TileHead
        logo="GG"
        color="#0b3d6b"
        name="Grants.gov"
        desc="Morgan submits federal applications you approve."
        right={ready ? <button type="button" style={okTile} onClick={toggle} aria-expanded={isOpen}>Set up</button> : started ? <button type="button" style={warnTile} onClick={toggle} aria-expanded={isOpen}>Not verified</button> : <button type="button" className="ld-btn p" onClick={toggle} aria-expanded={isOpen}>Set up</button>}
      />
      {isOpen && (
        <div style={{ borderTop: "1px solid #eef2f0", paddingTop: 14, display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, alignItems: "start" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label htmlFor="gg-uei" className="ld-lbl">SAM.gov UEI</label><input id="gg-uei" className="ld-in" value={uei} onChange={(e) => setUei(e.target.value)} /></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label htmlFor="gg-ein" className="ld-lbl">EIN</label><input id="gg-ein" className="ld-in" value={ein} onChange={(e) => setEin(e.target.value)} /></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "span 2" }}><label htmlFor="gg-email" className="ld-lbl">Grants.gov account email</label><input id="gg-email" className="ld-in" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: "span 2" }}>
              <label htmlFor="gg-role" className="ld-lbl">Your role on Grants.gov</label>
              <select id="gg-role" className="ld-in" value={role} onChange={(e) => setRole(e.target.value)}>
                <option>Expanded AOR</option>
                <option>AOR</option>
                <option>Not set yet</option>
              </select>
            </div>
            {error && <span className="ld-small" style={{ color: "#b42318", gridColumn: "span 2" }}>{error}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={saveReg.isPending} onClick={save}>Save</button>
            <button type="button" className="ld-btn" onClick={toggle}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Portals({ isOpen, toggle }: { isOpen: boolean; toggle: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const list = trpc.portals.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const save = trpc.portals.save.useMutation({ onSuccess: async () => { setEdit(null); await utils.portals.list.invalidate(); } });
  const remove = trpc.portals.remove.useMutation({ onSuccess: () => utils.portals.list.invalidate() });
  const [edit, setEdit] = React.useState<{ id?: number; name: string; url: string; username: string; password: string } | null>(null);
  const n = list.data?.length ?? 0;
  return (
    <div style={tileBox(isOpen)}>
      <TileHead logo="P" color="#3d4c45" name="Other grant portals" desc="Saved sign-ins for funders' own forms." right={<button type="button" className="ld-btn" onClick={toggle} aria-expanded={isOpen}>{n ? `${n} saved` : "Add"}</button>} />
      {isOpen && (
        <div style={{ borderTop: "1px solid #eef2f0", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {(list.data ?? []).map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px 96px", gap: 8, alignItems: "center", fontSize: 14 }}>
              <span className="ld-clip"><strong>{p.name}</strong> <span className="ld-muted">{p.username}</span></span>
              <button type="button" className="ld-btn sm" onClick={() => setEdit({ id: p.id, name: p.name, url: p.url ?? "", username: p.username, password: "" })}>Edit</button>
              <button type="button" className="ld-btn sm danger" onClick={() => remove.mutate({ organizationId: currentOrgId, id: p.id })}>Remove</button>
            </div>
          ))}
          {edit ? (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8, paddingTop: 6 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label className="ld-lbl" htmlFor="pt-name">Portal</label><input id="pt-name" className="ld-in" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label className="ld-lbl" htmlFor="pt-url">Sign-in page</label><input id="pt-url" className="ld-in" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /></div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label className="ld-lbl" htmlFor="pt-user">Username</label><input id="pt-user" className="ld-in" autoComplete="off" value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}><label className="ld-lbl" htmlFor="pt-pw">Password</label><input id="pt-pw" className="ld-in" type="password" autoComplete="new-password" placeholder={edit.id ? "Saved" : undefined} value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></div>
              <div className="ld-row" style={{ gridColumn: "span 2", justifyContent: "flex-end" }}>
                <button type="button" className="ld-btn sm" onClick={() => setEdit(null)}>Cancel</button>
                <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: edit.id, name: edit.name, url: edit.url || undefined, username: edit.username, password: edit.password || undefined })}>Save</button>
              </div>
              <div style={{ gridColumn: "span 2" }}><ErrorLine error={save.error} /></div>
            </div>
          ) : (
            <button type="button" className="ld-btn sm" onClick={() => setEdit({ name: "", url: "", username: "", password: "" })}>Add</button>
          )}
        </div>
      )}
    </div>
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
