import React from "react";
import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { Icons, Page, PersonAvatar, Switcher } from "../ui";

/** Phone only: everything the desktop rail holds that the bottom bar does not. */
export default function More() {
  const { user, logout } = useAuth();
  const { currentOrg } = useTenant();
  const [switcher, setSwitcher] = React.useState(false);
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderBottom: "1px solid #eef2f0", textDecoration: "none", color: "#14221c", fontSize: 15, fontWeight: 700, background: "none", border: 0, width: "100%", font: "inherit", cursor: "pointer", textAlign: "left" };
  const items: [string, string, React.ReactNode][] = [
    ["Huddle", "/huddle", Icons.huddle],
    ["Activity", "/activity", Icons.activity],
    ["Brain", "/brain", Icons.brain],
    ["Workspace", "/workspace", Icons.workspace],
    ["Handbook", "/handbook", Icons.workspace],
    ["Integrations", "/integrations", Icons.integrations],
    ["Team", "/team", Icons.team],
  ];
  return (
    <Page rail="more">
      <h1 className="ld-h1">More</h1>
      <Link href="/account" className="ld-card" style={{ ...row, borderBottom: 0, borderRadius: 12, border: "1px solid #e3e9e6" }}>
        <PersonAvatar name={user?.name || user?.email || "?"} src={user?.avatarUrl} size={40} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span>{user?.name || "My account"}</span>
          <span className="ld-small ld-muted" style={{ fontWeight: 500 }}>My account and notifications</span>
        </span>
      </Link>
      <div className="ld-card" style={{ overflow: "hidden" }}>
        <button type="button" style={{ ...row, borderBottom: "1px solid #eef2f0" }} onClick={() => setSwitcher((v) => !v)}>
          <img src="/brand/icon.png" alt="" width={22} height={22} style={{ width: 22, height: 22, borderRadius: 6, display: "block" }} />
          <span style={{ flex: 1 }}>Workspace: {currentOrg?.name ?? "Choose"}</span>
          {Icons.chevron}
        </button>
        {switcher && <Switcher onClose={() => setSwitcher(false)} className="ld-switcher-pop" style={{ position: "fixed", left: 12, top: 60 }} />}
        {items.map(([label, href, icon]) => (
          <Link key={href} href={href} style={row}>
            {icon}
            <span>{label}</span>
          </Link>
        ))}
        <a href="mailto:info@leaddash.io" style={{ ...row, borderBottom: 0 }}>
          {Icons.help}
          <span>Help</span>
        </a>
      </div>
      <button type="button" className="ld-btn" style={{ width: "100%" }} onClick={() => logout()}>Sign out</button>
    </Page>
  );
}
