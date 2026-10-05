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
  const followStep = (i: { kind: string; metadata: string | null }) => {
    if (i.kind !== "outreach_email") return false;
    try {
      return ((JSON.parse(i.metadata || "{}") as { step?: number }).step ?? 1) > 1;
    } catch {
      return false;
    }
  };
  return (q.data ?? []).filter((i) => i.status === "pending_approval" && !followStep(i)).length + (apps.data ?? []).filter((a) => a.status === "ready").length;
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
      // Headshots are rounded squares so more of the face shows; initials stay round.
      <span style={{ ...style, background: "transparent", borderRadius: Math.round(size * 0.24) }}>
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

export function PersonAvatar({ name, src, size = 36 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    // Photos are rounded squares, like the employees' headshots.
    return (
      <span aria-label={name} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24), overflow: "hidden", flexShrink: 0, display: "flex" }}>
        <img src={src} alt={name} onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </span>
    );
  }
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

/** A workspace's logo on white, or its initials. */
export function OrgLogo({ name, src, size = 36 }: { name: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [src]);
  const box: React.CSSProperties = { width: size, height: size, borderRadius: Math.round(size * 0.25), flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" };
  if (src && !broken) {
    return (
      <span style={{ ...box, background: "#fff", border: "1px solid #e3e9e6", padding: Math.max(2, Math.round(size * 0.08)) }}>
        <img src={src} alt={`${name} logo`} onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </span>
    );
  }
  return <span style={{ ...box, background: "#2f6b5a", color: "#fff", fontWeight: 800, fontSize: Math.round(size * 0.36) }}>{initials(name)}</span>;
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
  huddle: I(<><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  activity: I(<path d="M3 12h4l3-8 4 16 3-8h4" />),
  approvals: I(<><path d="M9 11l3 3 8-8" /><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" /></>),
  tasks: I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  calendar: I(<><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M14 14h2M8 17.5h2" /></>),
  goals: I(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>),
  projects: I(<><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M7.5 9l1.5 1.5L12 7.5M7.5 15l1.5 1.5L12 13.5M14 9h3M14 15h3" /></>),
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

export type RailKey = "chats" | "calendar" | "goals" | "projects" | "huddle" | "activity" | "approvals" | "tasks" | "brain" | "workspace" | "integrations" | "team" | "account" | "more";

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
      className="ld-rail"
      style={{ width: 76, minHeight: "100vh", flexShrink: 0, boxSizing: "border-box", background: "#12211d", display: "flex", flexDirection: "column", alignItems: "center", padding: "14px 0", gap: 6, position: "sticky", top: 0, height: "100vh", zIndex: 20 }}
    >
      <button
        type="button"
        aria-label="Switch workspace"
        onClick={() => setSwitcher((v) => !v)}
        style={{ width: 44, height: 44, borderRadius: 11, background: "transparent", border: 0, padding: 0, cursor: "pointer", marginBottom: 12 }}
      >
        <img src="/brand/icon.png" alt="LeadDash Employees" width={44} height={44} style={{ display: "block", width: 44, height: 44, borderRadius: 11 }} />
      </button>
      {item("chats", "Chats", "/chats", Icons.chats)}
      {item("calendar", "Calendar", "/calendar", Icons.calendar)}
      {item("goals", "Goals", "/goals", Icons.goals)}
      {item("projects", "Projects", "/projects", Icons.projects)}
      {item("huddle", "Huddle", "/huddle", Icons.huddle)}
      {item("activity", "Activity", "/activity", Icons.activity)}
      {item("approvals", "Approvals", "/approvals", Icons.approvals, count)}
      {item("brain", "Brain", "/brain", Icons.brain)}
      {item("workspace", "Workspace", "/workspace", Icons.workspace)}
      {item("integrations", "Integrations", "/integrations", Icons.integrations)}
      {item("team", "Team", "/team", Icons.team)}
      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, position: "relative" }}>
        <a href="mailto:info@leaddash.io" style={{ ...base, color: "#a9c0b6" }}>
          {Icons.help}
          <span>Help</span>
        </a>
        <button type="button" aria-label="My account" onClick={() => setMenu((v) => !v)} style={{ border: 0, padding: 0, background: "none", cursor: "pointer", display: "flex" }}>
          <PersonAvatar name={user?.name || user?.email || "?"} src={user?.avatarUrl} size={36} />
        </button>
        {menu && (
          <div className="ld-card" style={{ position: "absolute", left: 60, bottom: 0, width: 240, padding: 12, display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 12px 32px rgba(18,33,29,0.14)" }}>
            <span className="ld-strong">{user?.name || "Signed in"}</span>
            <span className="ld-small ld-muted">{user?.email}</span>
            <Link href="/account" className="ld-btn" style={{ width: "100%" }} onClick={() => setMenu(false)}>
              My account
            </Link>
            <button type="button" className="ld-btn" style={{ width: "100%" }} onClick={() => logout()}>
              Sign out
            </button>
          </div>
        )}
      </div>
      {switcher && <Switcher onClose={() => setSwitcher(false)} className="ld-switcher-pop" style={{ position: "fixed", left: 84, top: 12 }} />}
    </nav>
  );
}

// ==========================================
// Workspace switcher
// ==========================================

export function Switcher({ onClose, style, className }: { onClose: () => void; style?: React.CSSProperties; className?: string }) {
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
      className={`ld-card ${className ?? ""}`}
      style={{ width: 360, maxWidth: "calc(100vw - 24px)", boxSizing: "border-box", padding: 12, boxShadow: "0 12px 32px rgba(18,33,29,0.14)", display: "flex", flexDirection: "column", gap: 2, zIndex: 50, color: "#14221c", ...style }}
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
          <OrgLogo name={o.name} src={o.logoUrl} size={36} />
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
// Hours saved (bottom of the chat list)
// ==========================================

/** A soft area chart of hours saved per day, drawn behind the total. */
function hoursPath(daily: number[], w: number, h: number) {
  const pts = daily.length > 1 ? daily : [0, ...daily, 0];
  // Running 3-day average keeps the curve smooth on quiet days.
  const smooth = pts.map((_, i) => {
    const a = pts.slice(Math.max(0, i - 1), i + 2);
    return a.reduce((x, y) => x + y, 0) / a.length;
  });
  const max = Math.max(...smooth, 0.5);
  const xy = smooth.map((v, i) => [(i / (smooth.length - 1)) * w, h - (v / max) * (h * 0.85)] as const);
  let d = `M0,${h} L${xy[0][0]},${xy[0][1]}`;
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return { area: `${d} L${w},${h} Z`, line: d.replace(/^M0,[\d.]+ L/, "M") };
}

export function HoursSaved() {
  const { currentOrgId } = useTenant();
  const q = trpc.usage.summary.useQuery({ organizationId: currentOrgId, back: 0 }, { enabled: currentOrgId > 0, refetchInterval: 300_000 });
  const u = q.data;
  if (!u) return null;
  const w = 300;
  const h = 96;
  const { area, line } = hoursPath(u.daily, w, h);
  const n = u.hours;
  const label = `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${n === 1 ? "hour" : "hours"}`;
  return (
    <Link href="/workspace" className="ld-hours" aria-label={`${label} saved this month`} style={{ marginTop: "auto", position: "sticky", bottom: 0, display: "block", textDecoration: "none", color: "#14221c", background: "#fff", borderTop: "1px solid #eef2f0", overflow: "hidden" }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: 0, width: "100%", height: h }}>
        <defs>
          <linearGradient id="ld-hours-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2f6b5a" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#2f6b5a" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#ld-hours-fill)" />
        <path d={line} fill="none" stroke="#2f6b5a" strokeOpacity="0.35" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <span style={{ position: "relative", display: "flex", flexDirection: "column", gap: 2, padding: "26px 18px 18px" }}>
        <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.1 }}>{label}</span>
        <span style={{ fontSize: 14, color: "#5b6b64", fontWeight: 600 }}>saved this month →</span>
      </span>
    </Link>
  );
}

// ==========================================
// Chat list
// ==========================================

export function ChatList({ activeKind }: { activeKind: string | null }) {
  const { currentOrgId, currentOrg } = useTenant();
  const { user } = useAuth();
  const { list } = useEmployees();
  const summaries = trpc.chat.summaries.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 30_000 });
  const [switcher, setSwitcher] = React.useState(false);
  const sorted = [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind as Kind) - KIND_ORDER.indexOf(b.kind as Kind) || a.id - b.id);
  return (
    <aside className="ld-chatlist" style={{ width: 340, flexShrink: 0, boxSizing: "border-box", background: "#fff", borderRight: "1px solid #e3e9e6", display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0, overflowY: "auto" }}>
      <div style={{ padding: "18px 18px 12px 18px", position: "relative" }} className="ld-between">
        <button type="button" onClick={() => setSwitcher((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 10, border: 0, background: "none", font: "inherit", fontSize: 16, fontWeight: 800, color: "#14221c", cursor: "pointer", padding: 0, minWidth: 0, textAlign: "left" }}>
          {currentOrg && <OrgLogo name={currentOrg.name} src={currentOrg.logoUrl} size={32} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentOrg?.name ?? "Choose a workspace"}</span>
          {Icons.chevron}
        </button>
        <Link href="/account" className="ld-mobile-only" aria-label="My account" style={{ textDecoration: "none" }}>
          <PersonAvatar name={user?.name || user?.email || "?"} src={user?.avatarUrl} size={32} />
        </Link>
        {switcher && <Switcher onClose={() => setSwitcher(false)} className="ld-switcher-pop" style={{ position: "fixed", left: 88, top: 52 }} />}
      </div>
      <TeamGroup activeKind={activeKind} />
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
              const preview = s ? (s.role === "user" ? `${s.authorName.split(" ")[0]}: ${s.content}` : s.content || "Asked you a question") : e.description ?? "";
              return (
                <Link key={e.id} href={href} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", margin: "2px 8px", borderRadius: 12, textDecoration: "none", color: "#14221c", background: on ? "#eef3f0" : "transparent" }}>
                  <Avatar name={e.name} kind={e.kind} src={e.avatar} size={46} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
                      <span style={{ fontSize: 12, color: "#5b6b64", whiteSpace: "nowrap" }}>{s ? fmtWhen(s.createdAt) : ""}</span>
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#1b6b4a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.roleTitle}</span>
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
      <HoursSaved />
    </aside>
  );
}

/** The people in this workspace: the Everyone channel and a direct message with each person. */
function TeamGroup({ activeKind }: { activeKind: string | null }) {
  const { currentOrgId } = useTenant();
  const q = trpc.teamChat.channels.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 10_000 });
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <div>
      <div style={{ padding: "10px 18px 4px 18px", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5b6b64" }}>Team</div>
      {list.map((c) => {
        const on = activeKind === `team:${c.key}`;
        const preview = c.last ? `${c.last.mine ? "You" : c.last.author.split(" ")[0]}: ${c.last.text}` : c.kind === "channel" ? "Everyone in this workspace" : c.sub;
        return (
          <Link key={c.key} href={`/chats/team/${c.key}`} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px", margin: "2px 8px", borderRadius: 12, textDecoration: "none", color: "#14221c", background: on ? "#eef3f0" : "transparent" }}>
            {c.kind === "channel" ? (
              <span aria-hidden="true" style={{ width: 46, height: 46, borderRadius: 12, background: "#1b6b4a", color: "#fff", fontSize: 20, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>#</span>
            ) : (
              <span style={{ position: "relative", display: "flex", flexShrink: 0 }}>
                <PersonAvatar name={c.name} src={c.avatarUrl} size={46} />
                {c.online && <span aria-label="Online" style={{ position: "absolute", right: 0, bottom: 0, width: 11, height: 11, borderRadius: 999, background: "#22a06b", border: "2px solid #fff" }} />}
              </span>
            )}
            <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                <span style={{ fontSize: 12, color: "#5b6b64", whiteSpace: "nowrap" }}>{c.last ? fmtWhen(c.last.at) : ""}</span>
              </span>
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "#3d4c45", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{preview}</span>
                {c.unread > 0 && !on ? <span style={{ background: "#c2410c", color: "#fff", fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "0 7px", lineHeight: "18px" }}>{c.unread}</span> : null}
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

// ==========================================
// Employee header (Chat | Work | Guidelines)
// ==========================================

type Emp = { id: number; name: string; roleTitle: string; kind: string; status: string; avatar: string | null };

export function EmpHeader({ emp, active, base }: { emp: Emp; active: "chat" | "work" | "knowledge" | "onboarding" | "guidelines"; base: string }) {
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
    <header className="ld-emphead" style={{ boxSizing: "border-box", height: 72, padding: "0 24px", background: "#fff", borderBottom: "1px solid #e3e9e6", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, position: "sticky", top: 0, zIndex: 10 }}>
      <div className="ld-row ld-emphead-who" style={{ gap: 12 }}>
        <Link href="/chats?list=1" className="ld-mobile-only" aria-label="Back to chats" style={{ color: "#14221c", display: "flex" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </Link>
        <Avatar name={emp.name} kind={emp.kind} src={emp.avatar} size={44} />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>{emp.name}</span>
          <span style={{ fontSize: 13, color: "#5b6b64", whiteSpace: "nowrap" }}>{emp.roleTitle}</span>
        </span>
      </div>
      <nav aria-label="Employee views" className="ld-emptabs" style={{ display: "flex", gap: 6, background: "#f1f5f3", padding: 4, borderRadius: 12 }}>
        <Link href={base} style={tab(active === "chat")} className="ld-tablink">Chat</Link>
        {work && <Link href={`${base}/work`} style={tab(active === "work")}>{work}</Link>}
        <Link href={`${base}/knowledge`} style={tab(active === "knowledge")}>Knowledge</Link>
        <Link href={`${base}/onboarding`} style={tab(active === "onboarding")}>Onboarding</Link>
        <Link href={`${base}/guidelines`} style={tab(active === "guidelines")}>Guidelines</Link>
      </nav>
      <div className="ld-row ld-emphead-status">
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
      <BottomNav active={rail} />
    </div>
  );
}

// ==========================================
// Phone: bottom navigation (the rail is hidden on small screens)
// ==========================================

const MoreIcon = I(<><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>);

export function BottomNav({ active }: { active: RailKey }) {
  const count = useApprovalCount();
  const on = (k: RailKey) => (k === "more" ? ["calendar", "goals", "tasks", "huddle", "activity", "brain", "workspace", "integrations", "team", "account", "more"].includes(active) : active === k);
  const item = (key: RailKey, label: string, href: string, icon: React.ReactNode, badge?: number) => (
    <Link key={key} href={href} className={`ld-bn-item ${on(key) ? "on" : ""}`} aria-current={on(key) ? "page" : undefined}>
      <span style={{ position: "relative", display: "flex" }}>
        {icon}
        {badge ? <span className="ld-bn-badge">{badge}</span> : null}
      </span>
      <span>{label}</span>
    </Link>
  );
  return (
    <nav className="ld-bottomnav" aria-label="Main">
      {item("chats", "Chats", "/chats?list=1", Icons.chats)}
      {item("approvals", "Approvals", "/approvals", Icons.approvals, count)}
      {item("projects", "Projects", "/projects", Icons.projects)}
      {item("more", "More", "/more", MoreIcon)}
    </nav>
  );
}

/** True on phone-size screens. */
export function useIsMobile() {
  const q = "(max-width: 760px)";
  const [m, setM] = React.useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  React.useEffect(() => {
    const mq = window.matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return m;
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
