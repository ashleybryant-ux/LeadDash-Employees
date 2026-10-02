import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { AVATAR_FILES, GROUP_ORDER, KIND_META, KIND_ORDER, fmtWhen, initials, type Kind } from "./meta";

// ==========================================
// Data hooks
// ==========================================

export function useEmployees() {
  const { currentOrgId } = useTenant();
  const q = trpc.employees.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const list = q.data ?? [];
  const byKind = (kind: string) => list.find((e) => e.kind === kind) ?? null;
  return { ...q, list, byKind };
}

export function useApprovalCount() {
  const { currentOrgId } = useTenant();
  const q = trpc.publishing.listApprovalQueue.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const apps = trpc.applications.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  return (q.data ?? []).filter((i) => i.status === "pending_approval").length + (apps.data ?? []).filter((a) => a.status === "ready").length;
}

// ==========================================
// Avatar
// ==========================================

export function Avatar({ name, kind, src, size = 44 }: { name: string; kind?: string; src?: string | null; size?: number }) {
  const file = src || (kind ? AVATAR_FILES[kind as Kind] : undefined);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [file]);
  const color = KIND_META[(kind as Kind) ?? "custom"]?.color ?? "#3d4c45";
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 999,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontWeight: 800,
    fontSize: Math.round(size * 0.38),
    background: color,
    overflow: "hidden",
  };
  if (file && !broken) {
    return (
      <span style={style}>
        <img src={file} alt={name} onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </span>
    );
  }
  return (
    <span style={style} aria-label={name}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function PersonAvatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      aria-label={name}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: "#e88a3a",
        color: "#1a1209",
        fontWeight: 800,
        fontSize: Math.round(size * 0.38),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {initials(name)}
    </span>
  );
}

// ==========================================
// Icons (inline, stroke)
// ==========================================

const I = (d: React.ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
export const Icons = {
  chats: I(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />),
  approvals: I(<><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></>),
  tasks: I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  brain: I(<><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /></>),
  workspace: I(<><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4" /></>),
  integrations: I(<><rect x="3" y="11" width="7" height="7" rx="1" /><rect x="11" y="11" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /></>),
  team: I(<><circle cx="10" cy="8" r="4" /><path d="M3 21a7 7 0 0 1 14 0" /><path d="M19 8v6M16 11h6" /></>),
  help: I(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01" /></>),
  chevron: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  check: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1b6b4a" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  ),
};

// ==========================================
// Rail
// ==========================================

type RailKey = "chats" | "approvals" | "tasks" | "brain" | "workspace" | "integrations" | "team";

export function Rail({ active }: { active: RailKey }) {
  const count = useApprovalCount();
  const { user, logout } = useAuth();
  const [switcher, setSwitcher] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const base: React.CSSProperties = {
    width: 68,
    minHeight: 56,
    boxSizing: "border-box",
    borderRadius: 12,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    textDecoration: "none",
    fontSize: 10.5,
    fontWeight: 700,
  };
  const item = (key: RailKey, label: string, href: string, icon: React.ReactNode, badge?: number) => (
    <Link
      key={key}
      href={href}
      aria-current={active === key ? "page" : undefined}
      style={{ ...base, background: active === key ? "#24403a" : "transparent", color: active === key ? "#ffffff" : "#a9c0b6" }}
    >
      <span style={{ position: "relative", display: "flex" }}>
        {icon}
        {badge ? (
          <span style={{ position: "absolute", top: -6, right: -10, background: "#e88a3a", color: "#1a1209", fontSize: 10, fontWeight: 800, borderRadius: 999, padding: "0 5px", lineHeight: "16px" }}>
            {badge}
          </span>
        ) : null}
      </span>
      <span>{label}</span>
    </Link>
  );
  return (
    <nav
      aria-label="Main"
      style={{ width: 76, minHeight: "100vh", flexShrink: 0, boxSizing: "border-box", background: "#12211d", display: "flex", flexDirection: "column", alignItems: "center", padding: "14px 0", gap: 6, position: "sticky", top: 0, height: "100vh", zIndex: 20 }}
    >
      <button
        type="button"
        aria-label="Switch workspace"
        onClick={() => setSwitcher((v) => !v)}
        style={{ width: 44, height: 44, borderRadius: 11, background: "#fff", color: "#12211d", border: 0, font: "inherit", fontWeight: 800, fontSize: 14, cursor: "pointer", marginBottom: 12 }}
      >
        LD
      </button>
      {item("chats", "Chats", "/chats", Icons.chats)}
      {item("approvals", "Approvals", "/approvals", Icons.approvals, count)}
      {item("tasks", "Tasks", "/tasks", Icons.tasks)}
      {item("brain", "Brain", "/brain", Icons.brain)}
      {item("workspace", "Workspace", "/workspace", Icons.workspace)}
      {item("integrations", "Integrations", "/integrations", Icons.integrations)}
      {item("team", "Team", "/team", Icons.team)}
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, position: "relative" }}>
        <a href="mailto:info@leaddash.io" style={{ ...base, color: "#a9c0b6" }}>
          {Icons.help}
          <span>Help</span>
        </a>
        <button
          type="button"
          aria-label="My account"
          onClick={() => setMenu((v) => !v)}
          style={{ width: 36, height: 36, borderRadius: 999, background: "#e88a3a", color: "#1a1209", border: 0, font: "inherit", fontWeight: 800, fontSize: 13, cursor: "pointer" }}
        >
          {initials(user?.name || user?.email || "?")}
        </button>
        {menu && (
          <div className="ld-card" style={{ position: "absolute", left: 60, bottom: 0, width: 240, padding: 12, display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 12px 32px rgba(18,33,29,0.14)" }}>
            <span className="ld-strong">{user?.name || "Signed in"}</span>
            <span className="ld-small ld-muted">{user?.email}</span>
            <button type="button" className="ld-btn" onClick={() => logout()}>
              Sign out
            </button>
          </div>
        )}
      </div>
      {switcher && <Switcher onClose={() => setSwitcher(false)} style={{ position: "fixed", left: 84, top: 12 }} />}
    </nav>
  );
}

// ==========================================
// Workspace switcher
// ==========================================

export function Switcher({ onClose, style }: { onClose: () => void; style?: React.CSSProperties }) {
  const { organizations, currentOrgId, switchOrganization, refetchOrgs } = useTenant();
  const { user } = useAuth();
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const create = trpc.organizations.create.useMutation({
    onSuccess: async (r) => {
      await refetchOrgs();
      if (r.id) switchOrganization(r.id);
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", h);
    };
  }, [onClose]);
  const it: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, border: 0, background: "none", font: "inherit", fontSize: 15, fontWeight: 600, color: "#14221c", cursor: "pointer", textAlign: "left", width: "100%" };
  const lg = (bg: string, fg = "#fff"): React.CSSProperties => ({ width: 36, height: 36, borderRadius: 9, background: bg, color: fg, fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" });
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return (
    <div
      ref={ref}
      className="ld-card"
      style={{ width: 360, boxSizing: "border-box", padding: 12, boxShadow: "0 12px 32px rgba(18,33,29,0.14)", display: "flex", flexDirection: "column", gap: 2, zIndex: 50, color: "#14221c", ...style }}
    >
      {organizations.map((o) => (
        <button
          key={o.id}
          type="button"
          style={{ ...it, background: o.id === currentOrgId ? "#eef3f0" : "none" }}
          onClick={() => {
            switchOrganization(o.id);
            onClose();
          }}
        >
          <span style={lg("#2f6b5a")}>{o.logoUrl ? <img src={o.logoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initials(o.name)}</span>
          <span style={{ flex: 1 }}>{o.name}</span>
          {o.id === currentOrgId && Icons.check}
        </button>
      ))}
      {user?.role === "admin" && (
        <>
          <div style={{ height: 1, background: "#e3e9e6", margin: "6px 0" }} />
          {!creating ? (
            <button type="button" style={{ ...it, color: "#1b6b4a", fontWeight: 700 }} onClick={() => setCreating(true)}>
              <span style={lg("#eef3f0", "#1b6b4a")}>+</span>
              <span>New workspace</span>
            </button>
          ) : (
            <form
              style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                create.mutate({ name: name.trim(), slug: slug(name), plan: "growth", ownerEmail: owner.trim() || undefined });
              }}
            >
              <label className="ld-lbl" htmlFor="ws-name">Name</label>
              <input id="ws-name" className="ld-in" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} autoFocus />
              <label className="ld-lbl" htmlFor="ws-owner">Owner email (optional)</label>
              <input id="ws-owner" className="ld-in" type="email" value={owner} onChange={(e) => setOwner(e.target.value)} />
              {error && <span className="ld-small" style={{ color: "#b42318" }}>{error}</span>}
              <div className="ld-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="ld-btn sm" onClick={() => setCreating(false)}>Cancel</button>
                <button type="submit" className="ld-btn p sm" disabled={create.isPending}>Create</button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ==========================================
// Chat list
// ==========================================

export function ChatList({ activeKind }: { activeKind: string | null }) {
  const { currentOrgId, currentOrg } = useTenant();
  const { list } = useEmployees();
  const summaries = trpc.chat.summaries.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 30_000 });
  const [switcher, setSwitcher] = React.useState(false);
  const sorted = [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind as Kind) - KIND_ORDER.indexOf(b.kind as Kind) || a.id - b.id);
  return (
    <aside style={{ width: 340, flexShrink: 0, boxSizing: "border-box", background: "#fff", borderRight: "1px solid #e3e9e6", display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0, overflowY: "auto" }}>
      <div style={{ padding: "18px 18px 12px 18px", position: "relative" }}>
        <button type="button" onClick={() => setSwitcher((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, border: 0, background: "none", font: "inherit", fontSize: 16, fontWeight: 800, color: "#14221c", cursor: "pointer", padding: 0 }}>
          {currentOrg?.name ?? "Choose a workspace"}
          {Icons.chevron}
        </button>
        {switcher && <Switcher onClose={() => setSwitcher(false)} style={{ position: "fixed", left: 88, top: 52 }} />}
      </div>
      {GROUP_ORDER.map((group) => {
        const people = sorted.filter((e) => KIND_META[(e.kind as Kind) ?? "custom"].group === group);
        if (people.length === 0) return null;
        return (
          <div key={group}>
            <div style={{ padding: "10px 18px 4px 18px", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5b6b64" }}>{group}</div>
            {people.map((e) => {
              const s = summaries.data?.find((x) => x.employeeId === e.id);
              const href = e.kind === "custom" ? `/chats/e/${e.id}` : `/chats/${e.kind}`;
              const on = activeKind === (e.kind === "custom" ? `e${e.id}` : e.kind);
              const preview = s ? `${s.role === "user" ? s.authorName.split(" ")[0] : e.name}: ${s.content}` : `${e.name}: ${e.description ?? ""}`;
              return (
                <Link key={e.id} href={href} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", margin: "2px 8px", borderRadius: 12, textDecoration: "none", color: "#14221c", background: on ? "#eef3f0" : "transparent" }}>
                  <Avatar name={e.name} kind={e.kind} src={e.avatar} size={46} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.roleTitle}</span>
                      <span style={{ fontSize: 12, color: "#5b6b64", whiteSpace: "nowrap" }}>{s ? fmtWhen(s.createdAt) : ""}</span>
                    </span>
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, color: "#3d4c45", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{preview}</span>
                      {s && s.unread > 0 && !on ? (
                        <span style={{ background: "#c2410c", color: "#fff", fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "0 7px", lineHeight: "18px" }}>{s.unread}</span>
                      ) : null}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        );
      })}
      {list.length === 0 && <div className="ld-empty">No employees in this workspace yet.</div>}
    </aside>
  );
}

// ==========================================
// Employee header (Chat | Work | Guidelines)
// ==========================================

type Emp = { id: number; name: string; roleTitle: string; kind: string; status: string; avatar: string | null };

export function EmpHeader({ emp, active, base }: { emp: Emp; active: "chat" | "work" | "knowledge" | "guidelines"; base: string }) {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const toggle = trpc.employees.toggleStatus.useMutation({ onSuccess: () => utils.employees.list.invalidate() });
  const work = KIND_META[(emp.kind as Kind) ?? "custom"].work;
  const paused = emp.status === "paused";
  const tab = (on: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 34,
    padding: "0 16px",
    borderRadius: 9,
    textDecoration: "none",
    fontSize: 14,
    fontWeight: 700,
    background: on ? "#fff" : "transparent",
    color: on ? "#14221c" : "#5b6b64",
    boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
  });
  return (
    <header style={{ boxSizing: "border-box", height: 72, padding: "0 24px", background: "#fff", borderBottom: "1px solid #e3e9e6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, position: "sticky", top: 0, zIndex: 10 }}>
      <div className="ld-row" style={{ gap: 12 }}>
        <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={44} />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>{emp.name}</span>
          <span style={{ fontSize: 13, color: "#5b6b64" }}>{emp.roleTitle}</span>
        </span>
      </div>
      <nav aria-label="Employee views" style={{ display: "flex", gap: 6, background: "#f1f5f3", padding: 4, borderRadius: 12 }}>
        <Link href={base} style={tab(active === "chat")} className="ld-tablink">Chat</Link>
        {work && <Link href={`${base}/work`} style={tab(active === "work")}>{work}</Link>}
        <Link href={`${base}/knowledge`} style={tab(active === "knowledge")}>Knowledge</Link>
        <Link href={`${base}/guidelines`} style={tab(active === "guidelines")}>Guidelines</Link>
      </nav>
      <div className="ld-row">
        <span className={`ld-pill ${paused ? "gray" : "green"}`}>{paused ? "Paused" : emp.status === "working" ? "Working" : "Ready"}</span>
        <button
          type="button"
          className="ld-btn sm"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ organizationId: currentOrgId, id: emp.id, status: paused ? "active" : "paused" })}
        >
          {paused ? "Resume" : "Pause"}
        </button>
      </div>
    </header>
  );
}

// ==========================================
// Folder tabs
// ==========================================

export function FolderTabs<T extends string>({ tabs, value, onChange, children }: { tabs: { key: T; label: string }[]; value: T; onChange: (k: T) => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="ld-ftabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={`ld-ft ${value === t.key ? "on" : ""}`} onClick={() => onChange(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="ld-ftbody">{children}</div>
    </div>
  );
}

export function UnderlineTabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="ld-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className={`ld-tab ${value === t.key ? "on" : ""}`} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ==========================================
// Page shell for non-chat pages
// ==========================================

export function Page({ rail, children, maxWidth }: { rail: RailKey; children: React.ReactNode; maxWidth?: number }) {
  return (
    <div className="ld">
      <Rail active={rail} />
      <main className="ld-main" style={maxWidth ? { maxWidth } : undefined}>
        {children}
      </main>
    </div>
  );
}

/** Renders an error from a mutation or query as one line. */
export function ErrorLine({ error }: { error?: { message: string } | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>
      {error.message}
    </p>
  );
}

export function useGo() {
  const [, navigate] = useLocation();
  return navigate;
}
