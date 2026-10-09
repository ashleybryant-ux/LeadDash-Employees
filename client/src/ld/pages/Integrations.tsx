import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { ErrorLine, FolderTabs, Page, useEmployees } from "../ui";
import { fmtDate, fmtTime, parseJson } from "../meta";

type Provider = "google_workspace" | "linkedin" | "facebook" | "instagram" | "wordpress" | "x" | "google_business" | "submittable" | "sessionize" | "threads" | "tiktok" | "clickup" | "zoom" | "recall";
type AppKey = "google" | "google_business" | "linkedin" | "meta" | "x" | "threads" | "tiktok" | "clickup" | "zoom";

type CatalogItem = { key: string; name: string; provider: Provider; logo: string; color: string; desc: string; app?: AppKey };

/** One-click cards: each signs in with the company. WordPress, Submittable and Sessionize still take a sign-in. */
const CATALOG: CatalogItem[] = [
  { key: "google", name: "Google", provider: "google_workspace", app: "google", logo: "G", color: "#db4437", desc: "Gmail, Calendar and Google Meet. Avery sends replies you approve, and Simone adds a Meet link to each meeting she schedules." },
  { key: "clickup", name: "ClickUp", provider: "clickup", app: "clickup", logo: "CU", color: "#7b68ee", desc: "Only for bringing your old ClickUp tasks into Projects. Nobody works in ClickUp anymore." },
  { key: "zoom", name: "Zoom", provider: "zoom", app: "zoom", logo: "Z", color: "#0b5cff", desc: "Simone adds a Zoom link instead of Google Meet, and can read the transcript when cloud recording is on." },
  { key: "linkedin", name: "LinkedIn", provider: "linkedin", app: "linkedin", logo: "in", color: "#0a66c2", desc: "Sienna posts to your profile after you approve." },
  { key: "meta", name: "Facebook and Instagram", provider: "facebook", app: "meta", logo: "f", color: "#1877f2", desc: "Sienna posts and Reels to your page and Instagram after you approve." },
  { key: "tiktok", name: "TikTok", provider: "tiktok", app: "tiktok", logo: "tt", color: "#010101", desc: "Sienna posts videos to TikTok after you approve." },
  { key: "threads", name: "Threads", provider: "threads", app: "threads", logo: "@", color: "#000000", desc: "Sienna posts to Threads after you approve." },
  { key: "x", name: "X", provider: "x", app: "x", logo: "X", color: "#111111", desc: "Sienna posts the short version after you approve." },
  { key: "gbp", name: "Google Business Profile", provider: "google_business", app: "google_business", logo: "GB", color: "#34a853", desc: "Sienna posts updates to your listing after you approve." },
  { key: "wordpress", name: "WordPress", provider: "wordpress", logo: "W", color: "#21759b", desc: "Theo saves approved articles as drafts on your site." },
  { key: "submittable", name: "Submittable", provider: "submittable", logo: "S", color: "#c2410c", desc: "Morgan fills and submits foundation forms." },
  { key: "sessionize", name: "Sessionize", provider: "sessionize", logo: "Se", color: "#9a4d14", desc: "Taylor submits speaker applications." },
];
const MAIN = ["google", "clickup", "zoom", "linkedin", "meta", "tiktok", "threads", "x", "gbp", "wordpress"];

type FieldDef = { key: string; label: string; secret?: boolean };

const SECRET_LABELS: Record<string, string> = { clientSecret: "Client secret", appSecret: "App secret", appPassword: "Password" };

function fieldsFor(p: Provider): FieldDef[] {
  if (p === "submittable" || p === "sessionize")
    return [
      { key: "username", label: "Sign-in email" },
      { key: "appPassword", label: "Password", secret: true },
    ];
  return [
    { key: "username", label: "Username" },
    { key: "appPassword", label: "Application password", secret: true },
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
const okTile: React.CSSProperties = { ...tile, background: "#e6f2ec", color: "#155c3e", cursor: "default" };
const warnTile: React.CSSProperties = { ...tile, background: "#fdf0e3", color: "#8a4510" };

export default function Integrations() {
  const { currentOrgId, currentOrg } = useTenant();
  const q = trpc.publishing.listConnections.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const info = trpc.publishing.connectInfo.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [tab, setTab] = React.useState<"all" | "connected" | "applying">(params.get("tab") === "applying" ? "applying" : "all");
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const [notice] = React.useState<{ ok: boolean; text: string } | null>(() => {
    const c = params.get("connected");
    const e = params.get("error");
    if (c === "calendar") return { ok: true, text: "The calendar is connected. Pick which of its calendars Avery checks with Edit." };
    if (c === "sending") return { ok: true, text: "The sending address is connected." };
    if (c) return { ok: true, text: `${CATALOG.find((x) => x.app === c)?.name ?? "Account"} is connected.` };
    if (e) return { ok: false, text: e };
    return null;
  });
  React.useEffect(() => {
    if (params.get("connected") || params.get("error")) window.history.replaceState(null, "", "/integrations");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conns = (q.data ?? []) as Conn[];
  const connOf = (p: Provider) => conns.find((c) => c.provider === p);
  const main = CATALOG.filter((c) => MAIN.includes(c.key));
  const isConnected = (c: CatalogItem) => connOf(c.provider)?.status === "connected";
  const connectedCount = main.filter(isConnected).length;
  const needle = search.trim().toLowerCase();
  const shown = main.filter((c) => (tab === "all" || (tab === "connected" && isConnected(c))) && (!needle || c.name.toLowerCase().includes(needle)));

  return (
    <Page rail="integrations" maxWidth={1140}>
      <h1 className="ld-h1">Integrations</h1>
      {currentOrg?.orgType === "healthcare" && <EhrConnection />}
      <WebsiteLogins />
      <Calendars />
      <SendingAddresses />
      <PressInbox />
      {notice && (
        <div role="status" className="ld-card" style={{ padding: "12px 16px", borderColor: notice.ok ? "#1b6b4a" : "#e2a7a1", background: notice.ok ? "#f1f8f4" : "#fdf3f2", fontSize: 14, fontWeight: 600, color: notice.ok ? "#155c3e" : "#b42318" }}>
          {notice.text}
        </div>
      )}
      <label htmlFor="int-search" className="ld-sr">Search integrations</label>
      <input
        id="int-search"
        type="text"
        placeholder="Search integrations"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ height: 44, border: "1px solid #cfd9d4", borderRadius: 10, padding: "0 14px", font: "inherit", fontSize: 14, background: "#fff", boxSizing: "border-box" }}
      />

      <FolderTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "all", label: `All (${main.length})` },
          { key: "connected", label: `Connected (${connectedCount})` },
          { key: "applying", label: "Applying (5)" },
        ]}
      >
        {tab === "applying" ? (
          <Applying conns={conns} open={open} setOpen={setOpen} ready={info.data?.apps} />
        ) : (
          <div className="ld-intgrid" style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, alignItems: "start" }}>
            {shown.length === 0 && (
              <div className="ld-empty" style={{ gridColumn: "1 / -1" }}>
                {q.isLoading ? "Loading..." : tab === "connected" ? "Nothing is connected yet." : "No integrations match."}
              </div>
            )}
            {shown.map((c) =>
              c.app ? (
                <OneClick key={c.key} item={c} conn={connOf(c.provider)} ready={info.data?.apps?.[c.app] ?? false} loading={info.isLoading} />
              ) : (
                <div key={c.key} style={tileBox(open === c.key)}>
                  <TileHead logo={c.logo} color={c.color} name={c.name} desc={c.desc} right={<StatusTile conn={connOf(c.provider)} isOpen={open === c.key} toggle={() => setOpen(open === c.key ? null : c.key)} />} />
                  {open === c.key && <ConnectForm item={c} conn={connOf(c.provider)} onDone={() => setOpen(null)} />}
                </div>
              )
            )}
          </div>
        )}
      </FolderTabs>
    </Page>
  );
}

// ==========================================
// One-click card
// ==========================================

function OneClick({ item, conn, ready, loading }: { item: CatalogItem; conn: Conn | undefined; ready: boolean; loading: boolean }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.publishing.listConnections.invalidate(), utils.publishing.connectInfo.invalidate()]);
  const disconnect = trpc.publishing.disconnect.useMutation({ onSuccess: refresh });
  const choose = trpc.publishing.choosePage.useMutation({ onSuccess: refresh });
  const settings = parseJson<{ pages?: { id: string; name: string; igUsername: string | null }[]; pageId?: string; pageName?: string; igUsername?: string | null; setupNote?: string; userName?: string; spaceName?: string | null; canCreateMeetings?: boolean | null }>(conn?.settings ?? null, {});
  const [pick, setPick] = React.useState<string | null>(settings.pageId ?? null);
  const connect = () => {
    window.location.href = `/api/oauth/${item.app}/start?organizationId=${currentOrgId}`;
  };
  const status = conn?.status ?? "disconnected";
  const choosing = item.app === "meta" && status === "pending" && (settings.pages?.length ?? 0) > 1;

  let right: React.ReactNode;
  if (choosing) {
    right = (
      <>
        <button type="button" className="ld-btn p" disabled={!pick || choose.isPending} onClick={() => pick && choose.mutate({ organizationId: currentOrgId, pageId: pick })}>Save</button>
        <button type="button" className="ld-btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ organizationId: currentOrgId, provider: item.provider })}>Cancel</button>
      </>
    );
  } else if (status === "connected") {
    right = (
      <>
        <span style={okTile}>Connected</span>
        {item.app === "clickup" && <Link href="/projects?import=1" className="ld-btn">Import</Link>}
        <button type="button" className="ld-btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ organizationId: currentOrgId, provider: item.provider })}>Disconnect</button>
      </>
    );
  } else if (status === "error") {
    right = (
      <>
        <button type="button" className="ld-btn p" disabled={!ready} onClick={connect}>Reconnect</button>
        <button type="button" className="ld-btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ organizationId: currentOrgId, provider: item.provider })}>Disconnect</button>
      </>
    );
  } else if (!ready) {
    right = <span style={{ ...tile, background: "#eef2f0", color: "#5b6b64", cursor: "default" }}>{loading ? "..." : "Coming soon"}</span>;
  } else {
    right = <button type="button" className="ld-btn p" onClick={connect}>Connect</button>;
  }

  const account =
    status === "connected"
      ? item.app === "meta"
        ? `Posting to ${settings.pageName ?? "your page"}${settings.igUsername ? ` and Instagram @${settings.igUsername}` : ""}`
        : item.app === "clickup"
          ? `${conn?.accountLabel} · import from Projects, Import`
        : `Connected as ${conn?.accountLabel}`
      : status === "error"
        ? "The sign-in expired. Press Reconnect."
        : choosing
          ? `Signed in as ${settings.userName ?? conn?.accountLabel}`
          : null;

  return (
    <div style={{ ...tileBox(choosing), display: "grid", gridTemplateColumns: "44px minmax(0,1fr) 128px", gap: 14, alignItems: "start" }} className="ld-oneclick ld-keep">
      <div style={{ width: 44, height: 44, borderRadius: 10, background: item.color, color: "#fff", fontWeight: 800, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
        {item.logo}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>{item.name}</div>
        <div style={{ fontSize: 13, color: "#3d4c45", lineHeight: 1.45, marginTop: 2 }}>{item.desc}</div>
        {account && <div style={{ fontSize: 13, fontWeight: 700, color: status === "error" ? "#8a4510" : "#155c3e", marginTop: 6, overflowWrap: "anywhere" }}>{account}</div>}
        {status === "connected" && item.app === "google_business" && settings.setupNote && (
          <div style={{ fontSize: 12, color: "#8a4510", marginTop: 4 }}>Google has not opened Business Profile access for LeadDash yet. Posts will wait until it does.</div>
        )}
        {status === "connected" && item.app === "zoom" && settings.canCreateMeetings === false && (
          <div style={{ fontSize: 12, color: "#8a4510", marginTop: 4 }}>This connection can't create meetings: it was approved before the Zoom app had that permission. Disconnect and reconnect to approve it.</div>
        )}
        {choosing && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="ld-lbl">Post to which page?</span>
            <div className="ld-row" style={{ flexWrap: "wrap" }}>
              {settings.pages!.map((pg) => (
                <button key={pg.id} type="button" className={`ld-chip ${pick === pg.id ? "on" : ""}`} aria-pressed={pick === pg.id} onClick={() => setPick(pg.id)}>
                  {pg.name}
                </button>
              ))}
            </div>
            {pick && (
              <span style={{ fontSize: 13, color: "#3d4c45" }}>
                {settings.pages!.find((x) => x.id === pick)?.igUsername ? `Instagram: @${settings.pages!.find((x) => x.id === pick)?.igUsername} (linked to this page)` : "No Instagram business account is linked to this page."}
              </span>
            )}
          </div>
        )}
        <ErrorLine error={disconnect.error || choose.error} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{right}</div>
    </div>
  );
}

// ==========================================
// Applying: who signs, Grants.gov, Gmail, Sessionize (portal sign-ins are Website logins)
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

function Applying({ conns, open, setOpen, ready }: { conns: Conn[]; open: string | null; setOpen: (k: string | null) => void; ready?: Record<AppKey, boolean> }) {
  const connOf = (p: Provider) => conns.find((c) => c.provider === p);
  const item = (key: string) => CATALOG.find((c) => c.key === key)!;
  const toggle = (k: string) => setOpen(open === k ? null : k);
  const gmail = { ...item("google"), key: "gmail", name: "Gmail", desc: "Morgan and Taylor send email applications." };
  return (
    <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <Signer />
      <BidPrime isOpen={open === "bidprime"} toggle={() => toggle("bidprime")} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, alignItems: "start" }}>
        <GrantsGov isOpen={open === "grantsgov"} toggle={() => toggle("grantsgov")} />
        {[item("submittable"), gmail, item("sessionize")].map((c) =>
          c.app ? (
            <OneClick key={c.key} item={c} conn={connOf(c.provider)} ready={ready?.[c.app] ?? false} loading={!ready} />
          ) : (
            <div key={c.key} style={tileBox(open === c.key)}>
              <TileHead logo={c.logo} color={c.color} name={c.name} desc={c.desc} right={<StatusTile conn={connOf(c.provider)} isOpen={open === c.key} toggle={() => toggle(c.key)} />} />
              {open === c.key && <ConnectForm item={c} conn={connOf(c.provider)} onDone={() => setOpen(null)} />}
            </div>
          )
        )}
      </div>
      <p className="ld-small ld-muted" style={{ margin: 0 }}>Sign-ins are saved encrypted.</p>
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

/** BidPrime: Morgan signs in each morning, reads leads and saved bids, and adds them to Opportunities. */
function BidPrime({ isOpen, toggle }: { isOpen: boolean; toggle: () => void }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.bidprime.get.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: (x) => (x.state.data && "checking" in x.state.data && x.state.data.checking ? 5000 : false) });
  const done = () => utils.bidprime.get.invalidate();
  const save = trpc.bidprime.save.useMutation({ onSuccess: async () => { setEditing(false); setPw(""); await done(); } });
  const check = trpc.bidprime.check.useMutation({ onSuccess: done });
  const disconnect = trpc.bidprime.disconnect.useMutation({ onSuccess: done });
  const v = q.data;
  const on = Boolean(v?.connected);
  const [editing, setEditing] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [pw, setPw] = React.useState("");
  const startEdit = () => { setEmail(v?.connected ? v.email : ""); setPw(""); setEditing(true); if (!isOpen) toggle(); };

  const right = !on ? (
    <button type="button" className="ld-btn p" onClick={startEdit} aria-expanded={isOpen}>Connect</button>
  ) : v?.connected && (v.status === "error" || v.waitingCode) ? (
    <button type="button" style={warnTile} onClick={toggle} aria-expanded={isOpen}>{v.waitingCode ? "Needs a code" : "Needs attention"}</button>
  ) : (
    <button type="button" style={okTile} onClick={toggle} aria-expanded={isOpen}>Connected</button>
  );

  let line = "";
  if (v?.connected) {
    if (v.checking) line = "Checking now...";
    else if (v.waitingCode) line = "Waiting for the sign-in code in Morgan's chat.";
    else if (v.lastError) line = `Last check stopped: ${v.lastError}`;
    else if (v.lastCheckedAt) line = `Last checked ${fmtDate(v.lastCheckedAt)}, ${fmtTime(v.lastCheckedAt)}. ${v.lastFound ? `${v.lastFound} new ${v.lastFound === 1 ? "bid" : "bids"}.` : "Nothing new."}`;
    else line = "First check is queued.";
  }

  return (
    <div style={tileBox(isOpen || editing)}>
      <TileHead logo="BP" color="#1d4ed8" name="BidPrime" desc="Morgan signs in each morning, reads your leads inbox and saved bids, and adds them to Opportunities with a fit score." right={right} />
      {(isOpen || editing) && (
        <div style={{ borderTop: "1px solid #eef2f0", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {editing ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label className="ld-lbl" htmlFor="bp-email">Email</label>
                  <input id="bp-email" className="ld-in" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label className="ld-lbl" htmlFor="bp-pw">Password</label>
                  <input id="bp-pw" className="ld-in" type="password" autoComplete="new-password" placeholder={on ? "Saved" : undefined} value={pw} onChange={(e) => setPw(e.target.value)} />
                </div>
              </div>
              <span className="ld-small ld-muted">Saved encrypted. Morgan types it into BidPrime and never shows it to the AI. If BidPrime sends a code, Morgan asks for it in Chat.</span>
              <div className="ld-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="ld-btn sm" onClick={() => setEditing(false)}>Cancel</button>
                <button type="button" className="ld-btn p sm" disabled={save.isPending || !email.trim() || (!on && !pw)} onClick={() => save.mutate({ organizationId: currentOrgId, email: email.trim(), password: pw || undefined })}>
                  {save.isPending ? "Saving..." : "Save"}
                </button>
              </div>
              <ErrorLine error={save.error} />
            </>
          ) : v?.connected ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 14 }}>
                  <span>Signed in as <strong>{v.email}</strong></span>
                  <span className="ld-muted" style={{ fontSize: 13 }}>{line}</span>
                </div>
                <div className="ld-row">
                  <button type="button" className="ld-btn sm" onClick={startEdit}>Edit</button>
                  <button type="button" className="ld-btn sm" disabled={check.isPending || v.checking} onClick={() => check.mutate({ organizationId: currentOrgId })}>Check now</button>
                  <button type="button" className="ld-btn sm danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ organizationId: currentOrgId })}>Disconnect</button>
                </div>
              </div>
              <ErrorLine error={check.error || disconnect.error} />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

type LoginEdit = { id?: number; name: string; url: string; username: string; password: string; lockName: string; lockAddress: string; hasLock: boolean };

function hostLabel(url: string | null) {
  try {
    return url ? new URL(url).host.replace(/^www\./, "") : "";
  } catch {
    return url ?? "";
  }
}

const CLIP: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };

/** Website logins: every employee can sign in with these in their browser. */
function WebsiteLogins() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const list = trpc.portals.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [edit, setEdit] = React.useState<LoginEdit | null>(null);
  const save = trpc.portals.save.useMutation({ onSuccess: async () => { setEdit(null); await utils.portals.list.invalidate(); } });
  const remove = trpc.portals.remove.useMutation({ onSuccess: async () => { setEdit(null); await utils.portals.list.invalidate(); } });
  const rows = list.data ?? [];
  const field = (id: string, label: string, input: React.ReactNode) => (
    <>
      <label htmlFor={id} style={{ fontWeight: 700 }}>{label}</label>
      {input}
    </>
  );
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Website logins</span>
          {rows.length ? (
            <div className="ld-logins" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr) minmax(0,1fr) 128px", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              {rows.map((l) => (
                <React.Fragment key={l.id}>
                  <b style={CLIP}>{l.name}</b>
                  <span style={CLIP}>{hostLabel(l.url) || "No web address"}{l.lockName ? ` · ${l.lockName} sub-account only` : ""}</span>
                  <span style={CLIP}>{l.username}</span>
                  <button type="button" className="ld-btn" onClick={() => setEdit({ id: l.id, name: l.name, url: l.url ?? "", username: l.username, password: "", lockName: l.lockName ?? "", lockAddress: "", hasLock: Boolean(l.lockId) })}>Edit</button>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 14, color: "#3d4c45" }}>{list.isLoading ? "Loading..." : "No logins yet. Add the sites your employees should sign in to, like the LeadDash platform or an agency portal."}</span>
          )}
          <span className="ld-small">Every employee can use these in their browser. Passwords are typed into the page directly and never shown to the AI.</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className="ld-btn p" onClick={() => setEdit({ name: "", url: "", username: "", password: "", lockName: "", lockAddress: "", hasLock: false })}>Add login</button>
        </div>
      </div>
      {edit && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">{edit.id ? edit.name || "Edit login" : "New login"}</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              {field("wl-name", "Name", <input id="wl-name" className="ld-in" value={edit.name} placeholder="LeadDash platform" onChange={(e) => setEdit({ ...edit, name: e.target.value })} />)}
              {field("wl-url", "Web address", <input id="wl-url" className="ld-in" value={edit.url} placeholder="https://app.leaddash.io" onChange={(e) => setEdit({ ...edit, url: e.target.value })} />)}
              {field("wl-user", "Email or username", <input id="wl-user" className="ld-in" autoComplete="off" value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} />)}
              {field("wl-pw", "Password", <input id="wl-pw" className="ld-in" type="password" autoComplete="new-password" placeholder={edit.id ? "Saved. Type a new one to change it" : undefined} value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />)}
              {field(
                "wl-lock",
                "Only this sub-account",
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <input id="wl-lock" className="ld-in" value={edit.lockName} placeholder="LeadDash" style={{ maxWidth: 320 }} onChange={(e) => setEdit({ ...edit, lockName: e.target.value })} />
                  <span className="ld-small">Employees can't open any other sub-account with this login, so client data in other sub-accounts stays out of reach. Leave it empty for sites without sub-accounts.</span>
                </div>
              )}
              {edit.lockName.trim() &&
                field(
                  "wl-lockurl",
                  "Its address",
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <input id="wl-lockurl" className="ld-in" value={edit.lockAddress} placeholder={edit.hasLock ? "Saved. Paste a new one to change it" : "https://app.leaddash.io/v2/location/..."} onChange={(e) => setEdit({ ...edit, lockAddress: e.target.value })} />
                    <span className="ld-small">Open that sub-account in your own browser and copy the address from the top. It has /location/ in it.</span>
                  </div>
                )}
            </div>
            <ErrorLine error={save.error || remove.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              type="button"
              className="ld-btn p"
              disabled={save.isPending || !edit.name.trim() || !edit.username.trim()}
              onClick={() => save.mutate({ organizationId: currentOrgId, id: edit.id, name: edit.name, url: edit.url || undefined, username: edit.username, password: edit.password || undefined, lockName: edit.lockName, lockAddress: edit.lockAddress || undefined })}
            >
              {save.isPending ? "Saving..." : "Save"}
            </button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            {edit.id && (
              <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: edit.id! })}>Remove</button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

type CalRow = { id: number; kind: "google" | "link"; name: string; color: string; email: string | null; calendars: { id: string; name: string; primary: boolean; include: boolean }[]; detail: "full" | "busy"; holds: "default" | "yes" | "no"; status: "connected" | "error"; error: string | null };
type CalEdit = { id: number; name: string; include: string[]; detail: "full" | "busy"; holds: "default" | "yes" | "no"; url: string };

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "inline-flex", border: "1px solid #cfd9d4", borderRadius: 8, overflow: "hidden", alignSelf: "flex-start", justifySelf: "start" }}>
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)} style={{ height: 32, padding: "0 14px", border: 0, background: value === o.key ? "#e6f2ec" : "#fff", font: "inherit", fontSize: 13, fontWeight: 700, color: value === o.key ? "#155c3e" : "#3d4c45", cursor: "pointer", whiteSpace: "nowrap" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function linkStart(orgId: number, purpose: "calendar" | "send", name: string, id?: number) {
  const q = new URLSearchParams({ organizationId: String(orgId), purpose, name });
  if (id) q.set("id", String(id));
  window.location.href = `/api/oauth/link/start?${q.toString()}`;
}

/** Calendars Avery checks: Google accounts and Outlook or iCloud calendars by link. */
function Calendars() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.accounts.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [edit, setEdit] = React.useState<CalEdit | null>(null);
  const [adding, setAdding] = React.useState<{ name: string; where: "google" | "link"; url: string } | null>(null);
  const done = async () => { setEdit(null); setAdding(null); await utils.accounts.list.invalidate(); };
  const save = trpc.accounts.saveCalendar.useMutation();
  const saveLink = trpc.accounts.saveLink.useMutation();
  const remove = trpc.accounts.remove.useMutation({ onSuccess: done });
  const rows = (q.data?.calendars ?? []) as CalRow[];
  const editing = edit ? rows.find((r) => r.id === edit.id) : null;
  const summary = (r: CalRow) => {
    const n = r.calendars.filter((c) => c.include).length;
    return `${n === 1 ? "1 calendar" : `${n} calendars`} · ${r.detail === "busy" ? "busy times only" : "full details"}`;
  };
  const submitEdit = async () => {
    if (!edit || !editing) return;
    if (editing.kind === "link") await saveLink.mutateAsync({ organizationId: currentOrgId, id: edit.id, name: edit.name, url: edit.url || undefined });
    await save.mutateAsync({ organizationId: currentOrgId, id: edit.id, name: edit.name, include: edit.include, detail: edit.detail, holds: edit.holds });
    await done();
  };
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Calendars</span>
          {rows.length ? (
            <div className="ld-cals" style={{ display: "grid", gridTemplateColumns: "190px minmax(0,1fr) minmax(0,1.15fr) 120px 128px", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <b style={{ ...CLIP, display: "flex", alignItems: "center", gap: 8 }}><span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: r.color, flexShrink: 0 }} />{r.name}</b>
                  <span style={CLIP} title={r.email ?? undefined}>{r.kind === "link" ? "Outlook or iCloud link" : r.email ?? "Google"}</span>
                  <span style={{ ...CLIP, color: r.status === "error" ? "#b42318" : undefined }}>{r.status === "error" ? "Reconnect needed" : summary(r)}</span>
                  {r.holds === "default" ? <span className="ld-pill green" style={{ justifySelf: "start" }}>Holds go here</span> : <span />}
                  <button type="button" className="ld-btn" onClick={() => { setAdding(null); setEdit({ id: r.id, name: r.name, include: r.calendars.filter((c) => c.include).map((c) => c.id), detail: r.detail, holds: r.holds, url: "" }); }}>Edit</button>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 14, color: "#3d4c45" }}>{q.isLoading ? "Loading..." : "No calendars yet. Avery uses your main Google calendar until you add them here."}</span>
          )}
          {rows.length > 0 && <span className="ld-small">Avery checks all of these when you ask about your schedule, and warns you when two calendars overlap.</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className="ld-btn p" onClick={() => { setEdit(null); setAdding({ name: "", where: "google", url: "" }); }}>Add calendar</button>
        </div>
      </div>

      {edit && editing && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">{editing.name}</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              <label htmlFor="cal-name" style={{ fontWeight: 700 }}>Name</label>
              <input id="cal-name" className="ld-in" style={{ maxWidth: 360 }} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <b>Account</b>
              {editing.kind === "google" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span>{editing.email ?? "Google"} · Google</span>
                  <button type="button" className="ld-btn sm" onClick={() => linkStart(currentOrgId, "calendar", editing.name, editing.id)}>Reconnect</button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <input className="ld-in" aria-label="Calendar link" placeholder="Saved. Paste a new link to change it" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
                  <span className="ld-small">Avery can read this calendar but can't add holds to it.</span>
                </div>
              )}
              {editing.kind === "google" && (
                <>
                  <b style={{ alignSelf: "start", paddingTop: 8 }}>Calendars Avery checks</b>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {editing.calendars.map((c, i) => (
                      <div key={c.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 200px", gap: 12, alignItems: "center", padding: "8px 0", borderBottom: i < editing.calendars.length - 1 ? "1px solid #eef2f0" : 0 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input type="checkbox" checked={edit.include.includes(c.id)} style={{ width: 16, height: 16, margin: 0, accentColor: "#1b6b4a" }} onChange={(e) => setEdit({ ...edit, include: e.target.checked ? [...edit.include, c.id] : edit.include.filter((x) => x !== c.id) })} />
                          {c.name}
                        </label>
                        <span className="ld-small">{c.primary ? "Your main calendar" : ""}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <b style={{ alignSelf: "start", paddingTop: 6 }}>What Avery sees</b>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Seg label="What Avery sees" value={edit.detail} onChange={(v) => setEdit({ ...edit, detail: v })} options={[{ key: "full", label: "Full details" }, { key: "busy", label: "Busy times only" }]} />
                {edit.detail === "busy" && <span className="ld-small">Avery sees when you're booked, never the event names, so client names on this calendar stay out of the AI.</span>}
              </div>
              {editing.kind === "google" && (
                <>
                  <b style={{ alignSelf: "start", paddingTop: 6 }}>New holds</b>
                  <Seg label="New holds" value={edit.holds} onChange={(v) => setEdit({ ...edit, holds: v })} options={[{ key: "default", label: "Go here" }, { key: "yes", label: "When I name it" }, { key: "no", label: "Never here" }]} />
                </>
              )}
            </div>
            <ErrorLine error={save.error || saveLink.error || remove.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={save.isPending || saveLink.isPending || !edit.name.trim()} onClick={submitEdit}>{save.isPending || saveLink.isPending ? "Saving..." : "Save"}</button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: edit.id })}>Remove</button>
          </div>
        </div>
      )}

      {adding && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">Add calendar</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              <label htmlFor="cal-new-name" style={{ fontWeight: 700 }}>Name</label>
              <input id="cal-new-name" className="ld-in" style={{ maxWidth: 360 }} placeholder="Legacy Family Services" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
              <b style={{ alignSelf: "start", paddingTop: 6 }}>Where it lives</b>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Seg label="Where it lives" value={adding.where} onChange={(v) => setAdding({ ...adding, where: v })} options={[{ key: "google", label: "Google" }, { key: "link", label: "Outlook or iCloud" }]} />
                {adding.where === "google" ? (
                  <span className="ld-small">Sign in with that Google account. Each one you add can be a different account.</span>
                ) : (
                  <>
                    <input className="ld-in" aria-label="Calendar link" placeholder="https://... or webcal://..." value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} />
                    <span className="ld-small">In Outlook or iCloud, share or publish the calendar and copy its private link. Avery can read it but can't add holds.</span>
                  </>
                )}
              </div>
            </div>
            <ErrorLine error={saveLink.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {adding.where === "google" ? (
              <button type="button" className="ld-btn p" disabled={!adding.name.trim()} onClick={() => linkStart(currentOrgId, "calendar", adding.name.trim())}>Connect Google</button>
            ) : (
              <button type="button" className="ld-btn p" disabled={saveLink.isPending || !adding.name.trim() || !adding.url.trim()} onClick={async () => { await saveLink.mutateAsync({ organizationId: currentOrgId, name: adding.name, url: adding.url }); await done(); }}>{saveLink.isPending ? "Checking..." : "Save"}</button>
            )}
            <button type="button" className="ld-btn" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

const SENDERS: { kind: string; name: string }[] = [
  { kind: "outreach", name: "Jada" },
  { kind: "leads", name: "Malik" },
  { kind: "inbox", name: "Avery" },
  { kind: "hiring", name: "Quinn" },
  { kind: "speaking", name: "Taylor" },
  { kind: "onboarding", name: "Imani" },
];

/** Sending addresses: a second Gmail some employees send from. */
function SendingAddresses() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.accounts.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const emps = useEmployees().list;
  const nameOf = (k: string) => emps.find((e) => e.kind === k)?.name ?? SENDERS.find((x) => x.kind === k)?.name ?? k;
  const [edit, setEdit] = React.useState<{ id: number; name: string; sendsFor: string[] } | null>(null);
  const [adding, setAdding] = React.useState<string | null>(null);
  const done = async () => { setEdit(null); await utils.accounts.list.invalidate(); };
  const save = trpc.accounts.saveSender.useMutation({ onSuccess: done });
  const remove = trpc.accounts.remove.useMutation({ onSuccess: done });
  const rows = q.data?.senders ?? [];
  const editing = edit ? rows.find((r) => r.id === edit.id) : null;
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Sending addresses</span>
          {rows.length ? (
            <div className="ld-logins" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr) minmax(0,1fr) 128px", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              {rows.map((r) => (
                <React.Fragment key={r.id}>
                  <b style={CLIP}>{r.name}</b>
                  <span style={{ ...CLIP, color: r.status === "error" ? "#b42318" : undefined }}>{r.status === "error" ? "Reconnect needed" : r.email ?? ""}</span>
                  <span style={CLIP}>{r.sendsFor.length ? `Used by ${r.sendsFor.map(nameOf).join(", ")}` : "No one sends from it yet"}</span>
                  <button type="button" className="ld-btn" onClick={() => { setAdding(null); setEdit({ id: r.id, name: r.name, sendsFor: r.sendsFor }); }}>Edit</button>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 14, color: "#3d4c45" }}>{q.isLoading ? "Loading..." : "Everyone sends from your main Google account. Add an address on its own domain for outreach so cold email never affects your main one."}</span>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className="ld-btn p" onClick={() => { setEdit(null); setAdding(""); }}>Add address</button>
        </div>
      </div>

      {edit && editing && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">{editing.email ?? editing.name}</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              <label htmlFor="snd-name" style={{ fontWeight: 700 }}>Name</label>
              <input id="snd-name" className="ld-in" style={{ maxWidth: 360 }} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <b>Account</b>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span>{editing.email ?? "Google"} · Google</span>
                <button type="button" className="ld-btn sm" onClick={() => linkStart(currentOrgId, "send", editing.name, editing.id)}>Reconnect</button>
              </div>
              <b style={{ alignSelf: "start", paddingTop: 6 }}>Who sends from it</b>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {SENDERS.map((x) => {
                    const on = edit.sendsFor.includes(x.kind);
                    return (
                      <button key={x.kind} type="button" aria-pressed={on} className="ld-sug" style={{ borderRadius: 8, height: 32, fontWeight: 700, background: on ? "#e6f2ec" : "#fff", borderColor: on ? "#1b6b4a" : undefined, color: on ? "#155c3e" : "#14221c" }} onClick={() => setEdit({ ...edit, sendsFor: on ? edit.sendsFor.filter((k) => k !== x.kind) : [...edit.sendsFor, x.kind] })}>
                        {nameOf(x.kind)}
                      </button>
                    );
                  })}
                </div>
                <span className="ld-small">Everyone else keeps sending from your main Google account.</span>
              </div>
            </div>
            <ErrorLine error={save.error || remove.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: currentOrgId, id: edit.id, name: edit.name, sendsFor: edit.sendsFor as never })}>{save.isPending ? "Saving..." : "Save"}</button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId, id: edit.id })}>Remove</button>
          </div>
        </div>
      )}

      {adding !== null && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">Add address</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              <label htmlFor="snd-new" style={{ fontWeight: 700 }}>Name</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <input id="snd-new" className="ld-in" style={{ maxWidth: 360 }} placeholder="Outreach" value={adding} onChange={(e) => setAdding(e.target.value)} />
                <span className="ld-small">Sign in with the Google account for that address. Jada and Malik send from it to start; change that with Edit.</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={!adding.trim()} onClick={() => linkStart(currentOrgId, "send", adding.trim())}>Connect Google</button>
            <button type="button" className="ld-btn" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Taylor's press inbox: the address the owner signed up to HARO, Source of
 * Sources, Qwoted and Featured with. Taylor reads only those services' emails
 * and turns fitting reporter requests into pitches for approval.
 */
function PressInbox() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.press.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [edit, setEdit] = React.useState<{ email: string; password: string; host: string } | null>(null);
  const done = async () => { setEdit(null); await utils.press.view.invalidate(); };
  const save = trpc.press.save.useMutation({ onSuccess: done });
  const remove = trpc.press.remove.useMutation({ onSuccess: done });
  const check = trpc.press.checkNow.useMutation({ onSuccess: () => utils.press.view.invalidate() });
  const v = q.data;
  const services = v?.services ?? [];
  const guess = (email: string) => {
    const d = (email.split("@")[1] ?? "").toLowerCase();
    return /^(gmail|googlemail)\.com$/.test(d) ? "imap.gmail.com" : /^(outlook|hotmail|live|msn)\.com$/.test(d) ? "outlook.office365.com" : /^(yahoo|ymail)\.com$/.test(d) ? "imap.mail.yahoo.com" : /^(icloud|me|mac)\.com$/.test(d) ? "imap.mail.me.com" : "";
  };
  const open = () => setEdit(v?.connected ? { email: v.email, password: "", host: v.host } : { email: "", password: "", host: "" });
  return (
    <>
      <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <span className="ld-lbl">Press inbox</span>
          {v?.connected ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 28px", fontSize: 14, alignItems: "center" }}>
              <b style={{ overflowWrap: "anywhere" }}>{v.email}</b>
              <span style={{ color: v.status === "error" ? "#b42318" : undefined }}>{v.status === "error" ? v.error ?? "Can't read the inbox" : v.checkedAt ? `Checked ${fmtDate(v.checkedAt)}, ${fmtTime(v.checkedAt)}` : "Checking soon"}</span>
              <span>{v.found} {v.found === 1 ? "request" : "requests"} found · {v.pitched} {v.pitched === 1 ? "pitch" : "pitches"} started</span>
            </div>
          ) : (
            <span style={{ fontSize: 14, color: "#3d4c45", lineHeight: 1.5 }}>{q.isLoading ? "Loading..." : "Taylor reads reporter requests from free services the moment they arrive and pitches you for the ones that fit. Sign up for each one as a source with one email address, then connect that inbox here."}</span>
          )}
          <span style={{ fontSize: 14, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <b>Sign up free:</b>
            {services.map((sv, i) => (
              <React.Fragment key={sv.name}>
                <a href={sv.signup} target="_blank" rel="noreferrer noopener" style={{ color: "#155c3e", fontWeight: 700 }}>{sv.name}</a>
                {i < services.length - 1 && <span aria-hidden="true">·</span>}
              </React.Fragment>
            ))}
          </span>
          <span className="ld-small">Taylor only reads emails from these services. Every pitch waits in Approvals until you send it. Answers to Qwoted and Featured go in with their website login, so add those under Website logins.</span>
          <ErrorLine error={check.error} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" className={`ld-btn ${v?.connected ? "" : "p"}`} onClick={open}>{v?.connected ? "Edit" : "Connect inbox"}</button>
          {v?.connected && <button type="button" className="ld-btn" disabled={check.isPending} onClick={() => check.mutate({ organizationId: currentOrgId })}>{check.isPending ? "Checking..." : "Check now"}</button>}
        </div>
      </div>

      {edit && (
        <div className="ld-card ld-resultcard" style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 20, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <span className="ld-lbl">{v?.connected ? "Press inbox" : "Connect press inbox"}</span>
            <div className="ld-logins-form" style={{ display: "grid", gridTemplateColumns: "200px minmax(0,1fr)", gap: "10px 16px", fontSize: 14, alignItems: "center" }}>
              <label htmlFor="pr-email" style={{ fontWeight: 700 }}>Email address</label>
              <input id="pr-email" className="ld-in" style={{ maxWidth: 360 }} autoComplete="off" placeholder="press@yourdomain.com" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value, host: edit.host || guess(e.target.value) })} />
              <label htmlFor="pr-pw" style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>App password</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <input id="pr-pw" className="ld-in" style={{ maxWidth: 360 }} type="password" autoComplete="new-password" placeholder={v?.connected ? "Saved. Paste a new one to change it" : "16 letters from your email provider"} value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
                <span className="ld-small">Not your regular password. In Gmail: Google Account, Security, 2-Step Verification, App passwords. It's stored encrypted and never shown to the AI.</span>
              </div>
              <label htmlFor="pr-host" style={{ fontWeight: 700, alignSelf: "start", paddingTop: 6 }}>Mail server</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <input id="pr-host" className="ld-in" style={{ maxWidth: 360 }} placeholder="imap.gmail.com" value={edit.host} onChange={(e) => setEdit({ ...edit, host: e.target.value })} />
                <span className="ld-small">Filled in for Gmail, Outlook, Yahoo and iCloud. For Google Workspace, use imap.gmail.com.</span>
              </div>
            </div>
            <ErrorLine error={save.error || remove.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={save.isPending || !edit.email.trim() || (!v?.connected && !edit.password.trim())} onClick={() => save.mutate({ organizationId: currentOrgId, email: edit.email, password: edit.password || undefined, host: edit.host || undefined })}>{save.isPending ? "Checking..." : "Save"}</button>
            <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
            {v?.connected && <button type="button" className="ld-btn" disabled={remove.isPending} onClick={() => remove.mutate({ organizationId: currentOrgId })}>Remove</button>}
          </div>
        </div>
      )}
    </>
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

// ==========================================
// LeadDash EHR: one key from Practice Settings, checked with the EHR before it is saved
// ==========================================

const EHR_READERS = [
  { kind: "billing", what: "Claims, payments, client balances, eligibility results. Opens the claim in LeadDash EHR for the fix; never submits, charges or sends on her own.", how: "Reads" },
  { kind: "compliance", what: "Note and treatment plan status by clinician, measure due dates. Counts and dates only.", how: "Reads" },
  { kind: "leads", what: "Bookings, cancellations, reschedule requests and paperwork that is past due, so the front desk hears about them.", how: "Reads" },
];

function EhrConnection() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const q = trpc.ehr.view.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const emps = trpc.employees.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [editing, setEditing] = React.useState(false);
  const [url, setUrl] = React.useState("https://api.health.leaddash.io");
  const [key, setKey] = React.useState("");
  const refresh = () => Promise.all([utils.ehr.view.invalidate(), utils.publishing.listConnections.invalidate()]);
  const connect = trpc.ehr.connect.useMutation({ onSuccess: async () => { setKey(""); setEditing(false); await refresh(); } });
  const disconnect = trpc.ehr.disconnect.useMutation({ onSuccess: async () => { setEditing(false); await refresh(); } });
  const v = q.data;
  const byKind = (k: string) => emps.data?.find((e) => e.kind === k);
  return (
    <section className="ld-card" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="ld-between">
        <span className="ld-lbl">LeadDash EHR</span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {v?.connected ? <span className="ld-pill green">Connected</span> : <span className="ld-pill gray">Not connected</span>}
          {!editing && <button type="button" className="ld-btn sm" onClick={() => setEditing(true)}>{v?.connected ? "Change" : "Connect"}</button>}
        </span>
      </div>
      {v?.connected && !editing && (
        <span style={{ fontSize: 14 }}>Connected as <b>{v.practice}</b>{v.fetchedAt ? <span className="ld-small ld-muted"> · last read {fmtDate(v.fetchedAt)}</span> : <span className="ld-small ld-muted"> · first read pending</span>}{v.error ? <span className="ld-small" style={{ color: "#b42318" }}> · last read failed: {v.error}</span> : null}</span>
      )}
      {!v?.connected && !editing && <span style={{ fontSize: 14 }}>Harper, Camille and Malik read from LeadDash EHR once it is connected. The key comes from LeadDash EHR, Practice Settings, LeadDash Employees.</span>}
      {editing && (
        <div style={{ borderTop: "1px solid #eef2f0", paddingTop: 14, display: "grid", gridTemplateColumns: "minmax(0,1fr) 128px", gap: 14, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="ehr-url" className="ld-lbl">EHR address</label>
            <input id="ehr-url" className="ld-in" value={url} onChange={(e) => setUrl(e.target.value)} />
            <label htmlFor="ehr-key" className="ld-lbl">Key</label>
            <input id="ehr-key" className="ld-in" type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} />
            <span className="ld-small ld-muted">From LeadDash EHR, Practice Settings, LeadDash Employees. Checked with the EHR, then saved encrypted; never shown again.</span>
            <ErrorLine error={connect.error || disconnect.error} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button type="button" className="ld-btn p" disabled={connect.isPending || !key.trim() || !url.trim()} onClick={() => connect.mutate({ organizationId: currentOrgId, url: url.trim(), key: key.trim() })}>{connect.isPending ? "Checking..." : "Save"}</button>
            <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
            {v?.connected && <button type="button" className="ld-btn danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ organizationId: currentOrgId })}>Disconnect</button>}
          </div>
        </div>
      )}
      <div style={{ borderTop: "1px solid #eef2f0" }}>
        {EHR_READERS.map((r) => {
          const e = byKind(r.kind);
          if (!e) return null;
          return (
            <div key={r.kind} className="ld-rw" style={{ gridTemplateColumns: "150px minmax(0,1fr) 90px", padding: "9px 0" }}>
              <span className="ld-strong">{e.name}</span>
              <span style={{ fontSize: 13.5 }}>{r.what}</span>
              <span className="ld-pill blue" style={{ justifySelf: "end" }}>{r.how}</span>
            </div>
          );
        })}
      </div>
      <span className="ld-small ld-muted">Everything read from LeadDash EHR stays on the providers under a signed BAA. Nothing from the EHR goes to web search, and clients are initials outside it.</span>
    </section>
  );
}

