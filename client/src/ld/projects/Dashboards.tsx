import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtYmd, Menu, OwnerAvatar } from "../goals/shared";
import { useLocation } from "wouter";

const TABLE_TEXT: [string, string][] = [["tasks", "Task list"], ["overdue", "Overdue tasks"], ["soon", "Tasks due soon"], ["priority", "Urgent and high tasks"], ["milestones", "Milestones"], ["instatus", "Time in status"], ["completed", "Completed, by person"], ["workedon", "Worked on, by person"], ["behind", "Who is behind"], ["activity", "Activity"], ["newcontent", "New content"], ["portfolio", "Portfolio"], ["timereport", "Time reporting"], ["timesheet", "Timesheet"], ["billable", "Billable report"], ["estimates", "Time estimated"]];
const WHICH_TEXT: Record<string, string> = { open: "Open", overdue: "Overdue", done: "Done this week", all: "All", active: "In progress", closed: "Closed", unassigned: "Unassigned", assigned: "Assigned, open", urgent: "Urgent", high: "High", normal: "Normal", low: "Low", none: "No priority" };
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";
import { fmtMin } from "./TaskModal";
import { BarChart, Battery, CardLibrary, LineChart, PieChart, type Template } from "./CardLibrary";

/**
 * Projects dashboards, the way ClickUp's hub works: All, Mine, Shared with me
 * and Private tabs, templates to start from, a table with location, last
 * viewed, updated, owner and sharing, stars for the sidebar, Copy link and
 * Share on each row. One dashboard shows its cards over any list, folder,
 * everything, or just me.
 */

type Card = Outputs["pj"]["dashboards"]["dashboards"][number]["cards"][number];
type CardData = Outputs["pj"]["dashboardData"]["cards"][number];
const TYPES: { type: Card["type"]; label: string; title: string }[] = [
  { type: "count", label: "Number (count of tasks)", title: "Open tasks" },
  { type: "status", label: "Tasks by status", title: "Tasks by status" },
  { type: "person", label: "Tasks by person", title: "Open tasks by person" },
  { type: "overdue", label: "Overdue", title: "Overdue by person" },
  { type: "time", label: "Time tracked", title: "Time tracked" },
  { type: "workload", label: "Workload", title: "Workload this week" },
  { type: "trend", label: "Done vs. added", title: "Done vs. added" },
  { type: "burndown", label: "Burndown for a list", title: "Burndown" },
  { type: "tasks", label: "Task list", title: "Due this week" },
  { type: "goal", label: "Goal progress", title: "Goal progress" },
  { type: "doc", label: "A doc", title: "A doc" },
  { type: "fieldsum", label: "Custom field total (money, number)", title: "Total" },
  { type: "chart", label: "Chart", title: "Chart" },
  { type: "ai", label: "AI card", title: "AI card" },
  { type: "notes", label: "Notes", title: "Notes" },
  { type: "embed", label: "Embed", title: "Embed" },
  { type: "table", label: "Table", title: "Table" },
];

type Hub = Outputs["pj"]["dashboards"];
type Row = Hub["dashboards"][number];
type Tab = "all" | "mine" | "shared" | "private";
const TABS: [Tab, string][] = [["all", "All"], ["mine", "Mine"], ["shared", "Shared with me"], ["private", "Private"]];
const TEMPLATES: { key: "simple" | "ai" | "project"; label: string; blurb: string; color: string; icon: string }[] = [
  { key: "simple", label: "Simple dashboard", blurb: "Open tasks, by status, by person, due this week", color: "#2563eb", icon: "▥" },
  { key: "ai", label: "AI team center", blurb: "What each employee did, time, handoffs", color: "#7c3aed", icon: "✦" },
  { key: "project", label: "Project management", blurb: "Progress, overdue, burndown, workload", color: "var(--ld-accent)", icon: "◔" },
];
const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

/** Dashboards: the hub (every dashboard, in tabs, with templates) or one dashboard's cards. */
export function DashboardsPage({ orgId, id, onPick, onOpenTask }: { orgId: number; id?: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void }) {
  return id ? <DashView orgId={orgId} id={id} onPick={onPick} onOpenTask={onOpenTask} /> : <DashHub orgId={orgId} onPick={onPick} />;
}

const Avatars = ({ people, size = 24 }: { people: { id: number; name: string; avatarUrl: string | null }[]; size?: number }) => (
  <span className="gp-avs">
    {people.slice(0, 4).map((p) => (
      <OwnerAvatar key={p.id} o={{ type: "user", id: p.id, name: p.name, avatarUrl: p.avatarUrl }} size={size} />
    ))}
    {people.length > 4 && <span className="ld-small ld-muted">+{people.length - 4}</span>}
  </span>
);

function DashHub({ orgId, onPick }: { orgId: number; onPick: (w: Where) => void }) {
  const utils = trpc.useUtils();
  const hub = trpc.pj.dashboards.useQuery({ organizationId: orgId });
  const refresh = () => Promise.all([hub.refetch(), utils.pj.favorites.invalidate()]);
  const save = trpc.pj.saveDashboard.useMutation({ onSuccess: async (d) => { await refresh(); onPick({ scope: "dash", id: d.id }); } });
  const remove = trpc.pj.removeDashboard.useMutation({ onSuccess: refresh });
  const dup = trpc.pj.duplicateDashboard.useMutation({ onSuccess: refresh });
  const star = trpc.pj.starDashboard.useMutation({ onSuccess: refresh });
  const [tab, setTab] = React.useState<Tab>("all");
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState<"viewed" | "updated" | "name">("viewed");
  const [naming, setNaming] = React.useState<{ id?: number; name: string; template?: "simple" | "ai" | "project" } | null>(null);
  const [sharing, setSharing] = React.useState<Row | null>(null);
  const [copied, setCopied] = React.useState(0);
  const d = hub.data;
  const words = q.trim().toLowerCase();
  const rows = (d?.dashboards ?? [])
    .filter((x) => (tab === "all" ? true : tab === "mine" ? x.mine : tab === "shared" ? x.sharedWithMe : x.private))
    .filter((x) => !words || x.name.toLowerCase().includes(words) || x.location.name.toLowerCase().includes(words))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "updated" ? b.updatedAt.localeCompare(a.updatedAt) : (b.lastViewed ?? "").localeCompare(a.lastViewed ?? "") || b.updatedAt.localeCompare(a.updatedAt)));
  const count = (k: Tab) => (k === "all" ? d?.counts.all : k === "mine" ? d?.counts.mine : k === "shared" ? d?.counts.shared : d?.counts.private) ?? 0;
  const linkOf = (x: Row) => `${window.location.origin}/projects?page=dash&id=${x.id}`;
  const copy = (x: Row) => {
    void navigator.clipboard?.writeText(linkOf(x));
    setCopied(x.id);
    setTimeout(() => setCopied(0), 1500);
  };
  const open = (x: Row) => onPick({ scope: "dash", id: x.id });
  const locIcon = (x: Row) => (x.location.kind === "folder" ? "📁 " : x.location.kind === "list" ? "☰ " : "");
  const sharingOf = (x: Row) => [...(x.owner ? [x.owner] : []), ...x.shared.filter((p) => p.id !== x.owner?.id)];
  const startNaming = (template?: "simple" | "ai" | "project") => setNaming({ name: template ? TEMPLATES.find((t) => t.key === template)!.label : "", template });
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 0 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>Dashboards</span>
          <span className="ld-row">
            {naming && !naming.id ? (
              <span className="ld-row">
                <input className="ld-in xs" style={{ width: 260 }} autoFocus aria-label="Dashboard name" placeholder="Dashboard name" value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && naming.name.trim() && save.mutate({ organizationId: orgId, name: naming.name, template: naming.template })} />
                <button type="button" className="ld-btn sm" onClick={() => setNaming(null)}>Cancel</button>
                <button type="button" className="ld-btn p sm" disabled={!naming.name.trim() || save.isPending} onClick={() => save.mutate({ organizationId: orgId, name: naming.name, template: naming.template })}>Make it</button>
              </span>
            ) : (
              <Menu label="New dashboard" button="+ New dashboard ▾" buttonClass="ld-btn p gp-auto">
                {(close) => (
                  <>
                    <button type="button" role="menuitem" onClick={() => { startNaming(); close(); }}>Simple dashboard</button>
                    {TEMPLATES.filter((t) => t.key !== "simple").map((t) => (
                      <button key={t.key} type="button" role="menuitem" onClick={() => { startNaming(t.key); close(); }}>{t.label}</button>
                    ))}
                  </>
                )}
              </Menu>
            )}
          </span>
        </div>
        <div className="gp-views" role="tablist" aria-label="Dashboards">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`gp-vw ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
              {k === "private" ? "🔒 " : ""}{label} <span className="ld-small ld-muted" style={{ fontWeight: 600 }}>{count(k)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="gp-canvas" style={{ display: "block" }}>
        <span className="ld-small ld-muted" style={{ display: "block", margin: "0 0 8px" }}>Start from a template</span>
        <div className="gp-tcards">
          {TEMPLATES.map((t) => (
            <button key={t.key} type="button" className="gp-tcard" onClick={() => startNaming(t.key)}>
              <span className="gp-tcic" style={{ background: t.color }} aria-hidden="true">{t.icon}</span>
              <span style={{ minWidth: 0 }}>
                <b style={{ display: "block" }}>{t.label}</b>
                <span className="ld-small ld-muted">{t.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="ld-between" style={{ margin: "16px 0 10px", gap: 10, flexWrap: "wrap" }}>
          <select className="gp-fb" style={{ maxWidth: "none" }} aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="viewed">Sort: Last viewed</option>
            <option value="updated">Sort: Updated</option>
            <option value="name">Sort: Name</option>
          </select>
          <input className="gp-srch" style={{ width: 220 }} placeholder="Search dashboards" aria-label="Search dashboards" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ErrorLine error={hub.error || save.error || remove.error || dup.error || star.error} />
        <div className="gp-gl">
          <div className="gp-dhrow h">
            <span>Name</span>
            <span>Location</span>
            <span>Last viewed</span>
            <span>Updated</span>
            <span>Owner</span>
            <span>Sharing</span>
            <span />
          </div>
          {rows.map((x) => (
            <div key={x.id} className="gp-dhrow" role="button" tabIndex={0} onClick={() => open(x)} onKeyDown={(e) => e.key === "Enter" && open(x)}>
              <span className="ld-row" style={{ gap: 8, minWidth: 0 }}>
                <button type="button" className={`gp-star ${x.starred ? "on" : ""}`} aria-label={x.starred ? "Remove from favorites" : "Add to favorites"} aria-pressed={x.starred} onClick={(e) => { e.stopPropagation(); star.mutate({ organizationId: orgId, id: x.id, on: !x.starred }); }}>★</button>
                {naming?.id === x.id ? (
                  <span className="ld-row" onClick={(e) => e.stopPropagation()}>
                    <input className="ld-in xs" style={{ width: 220 }} autoFocus aria-label="Dashboard name" value={naming.name} onChange={(e) => setNaming({ ...naming, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && save.mutate({ organizationId: orgId, id: x.id, name: naming.name })} />
                    <button type="button" className="ld-btn sm" onClick={() => setNaming(null)}>Cancel</button>
                    <button type="button" className="ld-btn p sm" disabled={!naming.name.trim()} onClick={() => { save.mutate({ organizationId: orgId, id: x.id, name: naming.name }); setNaming(null); }}>Save</button>
                  </span>
                ) : (
                  <b className="gp-ell">{x.name}</b>
                )}
                {x.private && <span aria-label="Private" title="Private">🔒</span>}
                <span className="gp-dacts">
                  <button type="button" className="ld-btn sm gp-auto" onClick={(e) => { e.stopPropagation(); copy(x); }}>{copied === x.id ? "Copied" : "Copy link"}</button>
                  {x.canEdit && <button type="button" className="ld-btn sm gp-auto" onClick={(e) => { e.stopPropagation(); setSharing(x); }}>Share</button>}
                </span>
              </span>
              <span className="gp-ell ld-muted">{locIcon(x)}{x.location.name}</span>
              <span className="ld-muted">{x.lastViewed ? fmtAt(x.lastViewed) : "Never"}</span>
              <span className="ld-muted">{fmtAt(x.updatedAt)}</span>
              <span className="ld-row gp-ell" style={{ gap: 8 }}>
                {x.owner ? <><OwnerAvatar o={{ type: "user", id: x.owner.id, name: x.owner.name, avatarUrl: x.owner.avatarUrl }} size={24} /><span className="gp-ell">{x.owner.name}</span></> : <span className="ld-muted">Workspace</span>}
              </span>
              <span><Avatars people={sharingOf(x)} /></span>
              <span onClick={(e) => e.stopPropagation()}>
                <Menu label={`Options for ${x.name}`}>
                  {(close) => (
                    <>
                      <button type="button" role="menuitem" onClick={() => { open(x); close(); }}>Open</button>
                      {x.canEdit && <button type="button" role="menuitem" onClick={() => { setNaming({ id: x.id, name: x.name }); close(); }}>Rename</button>}
                      <button type="button" role="menuitem" onClick={() => { dup.mutate({ organizationId: orgId, id: x.id }); close(); }}>Duplicate</button>
                      {x.canEdit && <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete the dashboard "${x.name}"?`)) remove.mutate({ organizationId: orgId, id: x.id }); close(); }}>Delete</button>}
                    </>
                  )}
                </Menu>
              </span>
            </div>
          ))}
          {d && !rows.length && <div className="gp-empty">{tab === "all" ? "No dashboards yet. Start from a template above." : "Nothing here."}</div>}
        </div>
      </div>
      {sharing && <DashShare orgId={orgId} dash={d?.dashboards.find((x) => x.id === sharing.id) ?? sharing} people={d?.people ?? []} onClose={() => { setSharing(null); void refresh(); }} onChanged={() => void hub.refetch()} />}
    </>
  );
}

/** Share a dashboard: private (owner, admins and the people below) or everyone, plus a link. */
export function DashShare({ orgId, dash, people, onClose, onChanged }: { orgId: number; dash: Row; people: { id: number; name: string; avatarUrl: string | null }[]; onClose: () => void; onChanged: () => void }) {
  const set = trpc.pj.setDashboardSharing.useMutation({ onSuccess: onChanged });
  const [pick, setPick] = React.useState<number | "">("");
  const [copied, setCopied] = React.useState(false);
  const link = `${window.location.origin}/projects?page=dash&id=${dash.id}`;
  const canAdd = people.filter((p) => p.id !== dash.owner?.id && !dash.shared.some((s) => s.id === p.id));
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Share ${dash.name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox">
        <div className="ld-between gp-mhead">
          <span>
            <b style={{ fontSize: 17 }}>Share</b>
            <span className="ld-small ld-muted" style={{ display: "block" }}>{dash.name}</span>
          </span>
          <button type="button" className="ld-btn" onClick={onClose}>Done</button>
        </div>
        <div style={{ padding: "4px 20px 20px", display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="gp-share">
            <span className="gp-share-ic" aria-hidden="true">👥</span>
            <span style={{ minWidth: 0 }}>
              <b>Who sees it</b>
              <br />
              <span className="ld-small ld-muted">{dash.private ? "Only you, owners and admins, and the people below." : "Everyone in the workspace."}</span>
            </span>
            <select className="ld-in xs" style={{ width: 210 }} aria-label="Who sees it" value={dash.private ? "private" : "all"} onChange={(e) => set.mutate({ organizationId: orgId, id: dash.id, private: e.target.value === "private" })}>
              <option value="all">Everyone in the workspace</option>
              <option value="private">Only these people</option>
            </select>
            <span />
          </div>
          <div className="ld-row gp-invite" style={{ margin: "6px 0" }}>
            <select className="ld-in xs" style={{ flex: 1 }} aria-label="Add a person" value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Add a person</option>
              {canAdd.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button type="button" className="ld-btn p" disabled={!pick || set.isPending} onClick={() => { if (pick) set.mutate({ organizationId: orgId, id: dash.id, add: [pick] }); setPick(""); }}>Add</button>
          </div>
          {dash.owner && (
            <div className="gp-share">
              <OwnerAvatar o={{ type: "user", id: dash.owner.id, name: dash.owner.name, avatarUrl: dash.owner.avatarUrl }} size={30} />
              <span style={{ minWidth: 0 }}><b className="gp-ell" style={{ display: "block" }}>{dash.owner.name}</b><span className="ld-small ld-muted">Owner</span></span>
              <span className="ld-small" style={{ fontWeight: 700 }}>Owner</span>
              <span />
            </div>
          )}
          {dash.shared.map((p) => (
            <div key={p.id} className="gp-share">
              <OwnerAvatar o={{ type: "user", id: p.id, name: p.name, avatarUrl: p.avatarUrl }} size={30} />
              <span style={{ minWidth: 0 }}><b className="gp-ell" style={{ display: "block" }}>{p.name}</b><span className="ld-small ld-muted">Can view</span></span>
              <span />
              <button type="button" className="ld-btn sm" onClick={() => set.mutate({ organizationId: orgId, id: dash.id, remove: [p.id] })}>Remove</button>
            </div>
          ))}
          <div className="gp-share">
            <span className="gp-share-ic" aria-hidden="true">↗</span>
            <span style={{ minWidth: 0 }}>
              <b>Link</b>
              <br />
              <span className="ld-small ld-muted gp-ell" style={{ display: "block" }}>Opens in the app after sign-in · {link.replace(/^https?:\/\//, "")}</span>
            </span>
            <span />
            <button type="button" className="ld-btn sm" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy link"}</button>
          </div>
          <ErrorLine error={set.error} />
        </div>
      </div>
    </div>
  );
}

/** One dashboard: its cards, with a crumb back to the hub, Share, Favorite and a menu. */
function DashView({ orgId, id, onPick, onOpenTask }: { orgId: number; id: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void }) {
  const utils = trpc.useUtils();
  const hub = trpc.pj.dashboards.useQuery({ organizationId: orgId });
  const refresh = () => Promise.all([hub.refetch(), utils.pj.favorites.invalidate()]);
  const save = trpc.pj.saveDashboard.useMutation({ onSuccess: async () => { await refresh(); await data.refetch(); } });
  const remove = trpc.pj.removeDashboard.useMutation({ onSuccess: async () => { await refresh(); onPick({ scope: "dash" }); } });
  const star = trpc.pj.starDashboard.useMutation({ onSuccess: async () => { await refresh(); await data.refetch(); } });
  const dash = hub.data?.dashboards.find((d) => d.id === id);
  const data = trpc.pj.dashboardData.useQuery({ organizationId: orgId, id }, { refetchInterval: 60_000 });
  const [editCard, setEditCard] = React.useState<Card | null>(null);
  const [library, setLibrary] = React.useState(false);
  const [naming, setNaming] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState(false);
  const refreshCard = trpc.pj.refreshCard.useMutation({ onSuccess: () => data.refetch() });
  const fromLibrary = (t: Template) => {
    setLibrary(false);
    setEditCard({ id: `c${Date.now().toString(36)}`, scope: { kind: "everything" }, ...t.card, options: t.card.options ? { ...t.card.options } : undefined } as Card);
  };
  const cards = dash?.cards ?? [];
  const canEdit = dash?.canEdit ?? data.data?.canEdit ?? false;
  const setCards = (next: Card[]) => dash && save.mutate({ organizationId: orgId, id: dash.id, name: dash.name, cards: next.map((c) => ({ ...c, scope: { kind: c.scope.kind, ...(c.scope.id ? { id: c.scope.id } : {}) } })) });
  const move = (i: number, by: number) => {
    const next = cards.slice();
    const [c] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, c);
    setCards(next);
  };
  const starred = dash?.starred ?? data.data?.starred ?? false;
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          {naming !== null && dash ? (
            <span className="ld-row">
              <input className="ld-in xs" style={{ width: 280 }} autoFocus aria-label="Dashboard name" value={naming} onChange={(e) => setNaming(e.target.value)} />
              <button type="button" className="ld-btn sm" onClick={() => setNaming(null)}>Cancel</button>
              <button type="button" className="ld-btn p sm" disabled={!naming.trim() || save.isPending} onClick={() => { save.mutate({ organizationId: orgId, id: dash.id, name: naming }); setNaming(null); }}>Save</button>
            </span>
          ) : (
            <span className="gp-ttl" style={{ fontSize: 18 }}>
              <button type="button" className="crumb gp-crumbbtn" style={{ fontSize: 14, marginLeft: 0 }} onClick={() => onPick({ scope: "dash" })}>Dashboards /</button>
              {dash?.name ?? data.data?.name ?? ""}
              {dash?.private && <span className="gp-chip" title="Only the people it is shared with see it">🔒 Private</span>}
            </span>
          )}
          <span className="ld-row">
            <button type="button" className={`gp-star ${starred ? "on" : ""}`} style={{ fontSize: 20 }} aria-pressed={starred} aria-label={starred ? "Remove from favorites" : "Add to favorites"} onClick={() => star.mutate({ organizationId: orgId, id, on: !starred })}>★</button>
            {canEdit && <button type="button" className="ld-btn" onClick={() => setSharing(true)}>Share</button>}
            {dash && (
              <Menu label="Dashboard options">
                {(close) => (
                  <>
                    <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/projects?page=dash&id=${id}`); close(); }}>Copy link</button>
                    {canEdit && <button type="button" role="menuitem" onClick={() => { setNaming(dash.name); close(); }}>Rename</button>}
                    {canEdit && <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete the dashboard "${dash.name}"?`)) remove.mutate({ organizationId: orgId, id: dash.id }); close(); }}>Delete dashboard</button>}
                  </>
                )}
              </Menu>
            )}
          </span>
        </div>
      </div>
      <div className="gp-tool">
        <span className="gp-tool-l">
          <span className="ld-small ld-muted">This week · {data.data ? fmtYmd(data.data.today) : ""}</span>
        </span>
        <span className="gp-tool-r">
          {dash && canEdit && <button type="button" className="ld-btn p" onClick={() => setLibrary(true)}>+ Add card</button>}
        </span>
      </div>
      <div className="gp-canvas" style={{ display: "block" }}>
        <ErrorLine error={hub.error || data.error || save.error || remove.error} />
        <div className="gp-pdash">
          {data.data?.cards.map((c, i) => (
            <div key={c.id} className="gp-w" style={{ gridColumn: `span ${c.size ?? 1}` }}>
              <h5>
                <span className="gp-ell">{c.title}</span>
                <span className="ld-row" style={{ gap: 6 }}>
                  <span className="ld-small ld-muted gp-ell">{c.scopeName}</span>
                  {canEdit && (
                    <Menu label={`Options for ${c.title}`}>
                      {(close) => (
                        <>
                          <button type="button" role="menuitem" onClick={() => { const cc = cards.find((x) => x.id === c.id); if (cc) setEditCard(cc); close(); }}>Edit</button>
                          <button type="button" role="menuitem" onClick={() => { setCards(cards.map((x) => (x.id === c.id ? { ...x, size: (((x.size ?? 1) % 3) + 1) as 1 | 2 | 3 } : x))); close(); }}>{(c.size ?? 1) === 3 ? "Make it narrow" : "Make it wider"}</button>
                          {i > 0 && <button type="button" role="menuitem" onClick={() => { move(i, -1); close(); }}>Move earlier</button>}
                          {i < cards.length - 1 && <button type="button" role="menuitem" onClick={() => { move(i, 1); close(); }}>Move later</button>}
                          <button type="button" role="menuitem" className="danger" onClick={() => { setCards(cards.filter((x) => x.id !== c.id)); close(); }}>Remove</button>
                        </>
                      )}
                    </Menu>
                  )}
                </span>
              </h5>
              <CardBody c={c} onOpenTask={onOpenTask} onPick={onPick} onRefresh={() => refreshCard.mutate({ organizationId: orgId, id, cardId: c.id })} refreshing={refreshCard.isPending && refreshCard.variables?.cardId === c.id} />
            </div>
          ))}
        </div>
      </div>
      {library && <CardLibrary onPick={fromLibrary} onClose={() => setLibrary(false)} />}
      {editCard && dash && (
        <CardEditor
          orgId={orgId}
          card={editCard}
          onClose={() => setEditCard(null)}
          onSave={(c) => {
            setCards(cards.some((x) => x.id === c.id) ? cards.map((x) => (x.id === c.id ? c : x)) : [...cards, c]);
            setEditCard(null);
          }}
        />
      )}
      {sharing && dash && <DashShare orgId={orgId} dash={dash} people={hub.data?.people ?? []} onClose={() => { setSharing(false); void refresh(); }} onChanged={() => void hub.refetch()} />}
    </>
  );
}

function Bars({ bars }: { bars: { label: string; value: number; color: string; max?: number | null }[] }) {
  const top = Math.max(1, ...bars.map((b) => b.max ?? b.value));
  if (!bars.length) return <span className="ld-small ld-muted">Nothing yet.</span>;
  return (
    <div className="gp-hbs">
      {bars.map((b) => (
        <div key={b.label} className="gp-hb">
          <span className="gp-ell">{b.label}</span>
          <span className="t"><i style={{ width: `${Math.max(2, (b.value / top) * 100)}%`, background: b.color }} /></span>
          <b>{b.value}{b.max ? ` / ${b.max}` : ""}</b>
        </div>
      ))}
    </div>
  );
}

function Line({ series, labels }: { series: { values: number[]; color: string; dash?: boolean }[]; labels: string[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const n = labels.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 580 + 10 : 300);
  const y = (v: number) => 130 - (v / max) * 110;
  return (
    <svg viewBox="0 0 600 150" className="gp-line" role="img" aria-label="Chart">
      <g stroke="var(--ld-line2)">
        <path d="M0 20H600M0 75H600M0 130H600" />
      </g>
      {series.map((s, k) => (
        <path key={k} d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)} ${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={s.dash ? 2 : 3} strokeDasharray={s.dash ? "5 4" : undefined} />
      ))}
      <text x="4" y="146" fontSize="11" fill="var(--ld-muted)">{labels[0]}</text>
      <text x="596" y="146" fontSize="11" fill="var(--ld-muted)" textAnchor="end">{labels[n - 1]}</text>
      <text x="4" y="16" fontSize="11" fill="var(--ld-muted)">{max}</text>
    </svg>
  );
}

function CardBody({ c, onOpenTask, onPick, onRefresh, refreshing }: { c: CardData; onOpenTask: (id: number) => void; onPick: (w: Where) => void; onRefresh?: () => void; refreshing?: boolean }) {
  const x = c as CardData & Record<string, unknown>;
  const [, go] = useLocation();
  if (c.type === "chart") {
    const kind = c.options?.chart ?? "bar";
    const unit = String(x.unit ?? "");
    if (kind === "line") return <LineChart weeks={(x.weeks as string[]) ?? []} lines={(x.lines as { label: string; color: string; values: number[] }[]) ?? []} />;
    const series = (x.series as { label: string; value: number; color: string }[]) ?? [];
    if (kind === "number")
      return (
        <>
          <span className="num">{unit === "minutes" ? fmtMin(Number(x.total)) : Number(x.total).toLocaleString("en-US")}</span>
          <span className="ld-small ld-muted">{unit === "minutes" ? "Tracked" : unit === "tasks" ? `${WHICH_TEXT[c.options?.which ?? "open"]} tasks` : String(x.sub ?? "")}</span>
        </>
      );
    if (kind === "pie" || kind === "donut") return <PieChart series={series} donut={kind === "donut"} unit={unit} />;
    if (kind === "battery") return <Battery series={series} />;
    return <BarChart series={series} />;
  }
  if (c.type === "table") {
    const cols = (x.columns as string[]) ?? [];
    const rows = (x.rows as { taskId?: number; link?: string; cells: string[] }[]) ?? [];
    return rows.length ? (
      <div className="gp-dtable">
        <table>
          <thead><tr>{cols.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.taskId || r.link ? "link" : ""} onClick={() => (r.taskId ? onOpenTask(r.taskId) : r.link ? go(r.link) : undefined)}>
                {r.cells.map((v, j) => <td key={j} className={j === 0 ? "nm" : ""}>{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <span className="ld-small ld-muted">Nothing here yet.</span>
    );
  }
  if (c.type === "ai")
    return (
      <>
        <div className="gp-aitext">{String(x.text ?? "")}</div>
        <span className="ld-row ld-small ld-muted" style={{ justifyContent: "space-between" }}>
          <span>Nora{x.at ? `, ${new Date(String(x.at)).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}{x.stale ? " (older)" : ""}</span>
          {onRefresh && <button type="button" className="gp-link" disabled={refreshing} onClick={onRefresh}>{refreshing ? "Writing" : "Refresh"}</button>}
        </span>
      </>
    );
  if (c.type === "notes") return <div className="gp-notes">{String(x.text ?? "") || <span className="ld-small ld-muted">Nothing written yet. Edit the card to add notes.</span>}</div>;
  if (c.type === "embed") {
    const kind = String(x.kind ?? "url");
    if (kind === "calendar") {
      const days = (x.days as string[]) ?? [];
      const byDay = (x.byDay as { id: number; name: string }[][]) ?? [];
      return (
        <div className="gp-dcal">
          {days.map((d, i) => (
            <div key={d} className="gp-dcal-day">
              <b>{new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", timeZone: "UTC" })}</b>
              {byDay[i]?.map((t) => (
                <button key={t.id} type="button" className="gp-dcal-t" onClick={() => onOpenTask(t.id)}>{t.name}</button>
              ))}
            </div>
          ))}
        </div>
      );
    }
    if (kind === "doc") {
      const doc = x.doc as { id: number; title: string; lines: string[] } | null;
      return doc ? (
        <>
          <button type="button" className="gp-link" style={{ alignSelf: "flex-start", fontWeight: 800 }} onClick={() => onPick({ scope: "doc", id: doc.id })}>{doc.title}</button>
          {doc.lines.map((l, i) => <span key={i} className="ld-small">{l.replace(/\*+/g, "")}</span>)}
        </>
      ) : <span className="ld-small ld-muted">Pick a doc in Edit.</span>;
    }
    if (kind === "board" || kind === "form") {
      const item = x.item as { id: number; title: string; link: string; note?: string } | null;
      return item ? (
        <>
          <button type="button" className="gp-link" style={{ alignSelf: "flex-start", fontWeight: 800 }} onClick={() => go(item.link)}>{item.title}</button>
          {item.note && <span className="ld-small ld-muted">{item.note}</span>}
        </>
      ) : <span className="ld-small ld-muted">Pick one in Edit.</span>;
    }
    const frame = String(x.frame ?? "");
    return frame ? <iframe className="gp-frame" src={frame} title={c.title} loading="lazy" allow="fullscreen" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" /> : <span className="ld-small ld-muted">{x.url ? "That link can't be shown here. Check it in Edit." : "Add a link in Edit."}</span>;
  }
  if (c.type === "count" || c.type === "fieldsum")
    return (
      <>
        <span className="num">{c.type === "fieldsum" && x.money ? `$${Number(x.number).toLocaleString("en-US")}` : Number(x.number).toLocaleString("en-US")}</span>
        <span className="ld-small ld-muted">{String(x.sub ?? "")}</span>
      </>
    );
  if (c.type === "time")
    return (
      <>
        <span className="num">{fmtMin(Number(x.minutes))}</span>
        <span className="ld-small ld-muted">{String(x.sub ?? "")}</span>
      </>
    );
  if (c.type === "status" || c.type === "person" || c.type === "overdue" || c.type === "workload") return <Bars bars={(x.bars as { label: string; value: number; color: string; max?: number | null }[]) ?? []} />;
  if (c.type === "trend") {
    const weeks = (x.weeks as string[]) ?? [];
    return (
      <>
        <Line labels={weeks.map((w) => fmtYmd(w))} series={[{ values: (x.done as number[]) ?? [], color: "var(--ld-accent)" }, { values: (x.added as number[]) ?? [], color: "var(--ld-soft)", dash: true }]} />
        <span className="ld-small ld-muted">Green: tasks done. Gray: tasks added. Weekly, last 8 weeks.</span>
      </>
    );
  }
  if (c.type === "burndown") {
    const days = (x.days as string[]) ?? [];
    return (
      <>
        <Line labels={days.map((d) => fmtYmd(d))} series={[{ values: (x.open as number[]) ?? [], color: "#2563eb" }]} />
        <span className="ld-small ld-muted">Open tasks each day, last 14 days.</span>
      </>
    );
  }
  if (c.type === "tasks") {
    const ts = (x.tasks as { id: number; name: string; dueDate: string | null; overdue: boolean }[]) ?? [];
    return ts.length ? (
      <div className="gp-dtasks">
        {ts.map((t) => (
          <button key={t.id} type="button" onClick={() => onOpenTask(t.id)}>
            <span className="gp-ell">{t.name}</span>
            <span style={t.overdue ? { color: "#c2253c", fontWeight: 700 } : undefined}>{t.dueDate ? fmtYmd(t.dueDate) : ""}</span>
          </button>
        ))}
      </div>
    ) : (
      <span className="ld-small ld-muted">Nothing due this week.</span>
    );
  }
  if (c.type === "goal") {
    const g = x.goal as { title: string; progress: number; status: string | null } | null;
    return g ? (
      <>
        <b>{g.title}</b>
        <span className="gp-pbar"><span className="t"><i style={{ width: `${g.progress}%` }} /></span><span>{g.progress}%</span></span>
      </>
    ) : (
      <span className="ld-small ld-muted">Pick a goal in Edit.</span>
    );
  }
  const doc = x.doc as { id: number; title: string; lines: string[] } | null;
  return doc ? (
    <>
      <button type="button" className="gp-link" style={{ alignSelf: "flex-start", fontWeight: 800 }} onClick={() => onPick({ scope: "doc", id: doc.id })}>{doc.title}</button>
      {doc.lines.map((l, i) => (
        <span key={i} className="ld-small">{l.replace(/\*+/g, "")}</span>
      ))}
    </>
  ) : (
    <span className="ld-small ld-muted">Pick a doc in Edit.</span>
  );
}

function CardEditor({ orgId, card, onClose, onSave }: { orgId: number; card: Card; onClose: () => void; onSave: (c: Card) => void }) {
  const ch = trpc.pj.cardChoices.useQuery({ organizationId: orgId });
  const [c, setC] = React.useState<Card>(card);
  const put = (p: Partial<Card>) => setC({ ...c, ...p });
  const opt = (p: NonNullable<Card["options"]>) => setC({ ...c, options: { ...(c.options ?? {}), ...p } });
  const needsScope = !["goal", "doc", "notes"].includes(c.type) && !(c.type === "embed" && c.options?.embed !== "calendar") && !(c.type === "table" && ["newcontent"].includes(c.options?.table ?? ""));
  const chartKind = c.options?.chart ?? "bar";
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Card">
      <div className="gp-mbox" style={{ width: 600 }}>
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>{TYPES.find((t) => t.type === c.type)?.label}</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={!c.title.trim()} onClick={() => onSave(c)}>Save</button>
          </span>
        </div>
        <div className="gp-xedit" style={{ padding: "4px 20px 20px" }}>
          <label htmlFor="ce-title">Title</label>
          <input id="ce-title" className="ld-in xs" value={c.title} onChange={(e) => put({ title: e.target.value })} />
          {needsScope && (
            <>
              <label htmlFor="ce-scope">Tasks from</label>
              <select
                id="ce-scope"
                className="ld-in xs"
                value={`${c.scope.kind}:${c.scope.id ?? ""}`}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(":");
                  put({ scope: { kind: kind as Card["scope"]["kind"], ...(id ? { id: Number(id) } : {}) } });
                }}
              >
                <option value="everything:">Everything</option>
                <option value="me:">Me</option>
                {ch.data?.folders.map((f) => (
                  <option key={`f${f.id}`} value={`folder:${f.id}`}>Folder: {f.name}</option>
                ))}
                {ch.data?.lists.map((l) => (
                  <option key={`l${l.id}`} value={`list:${l.id}`}>List: {l.name}</option>
                ))}
              </select>
            </>
          )}
          {(c.type === "count" || (c.type === "chart" && c.options?.measure !== "time" && c.options?.measure !== "estimate")) && (
            <>
              <label htmlFor="ce-which">Which tasks</label>
              <select id="ce-which" className="ld-in xs" value={c.options?.which ?? "open"} onChange={(e) => opt({ which: e.target.value as "open" })}>
                {Object.entries(WHICH_TEXT).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </>
          )}
          {c.type === "chart" && (
            <>
              <label htmlFor="ce-chart">Chart</label>
              <select id="ce-chart" className="ld-in xs" value={chartKind} onChange={(e) => opt({ chart: e.target.value as "bar" })}>
                <option value="number">Number</option>
                <option value="bar">Bar chart</option>
                <option value="pie">Pie chart</option>
                <option value="donut">Donut</option>
                <option value="battery">Battery</option>
                <option value="line">Line, over time</option>
              </select>
              <label htmlFor="ce-measure">Measure</label>
              <select id="ce-measure" className="ld-in xs" value={c.options?.measure ?? "count"} onChange={(e) => opt({ measure: e.target.value as "count" })}>
                <option value="count">Count of tasks</option>
                <option value="time">Time tracked (minutes)</option>
                <option value="estimate">Time estimated (minutes)</option>
                <option value="sum">Sum of a field</option>
                <option value="avg">Average of a field</option>
              </select>
              {(c.options?.measure === "sum" || c.options?.measure === "avg") && (
                <>
                  <label htmlFor="ce-mfield">Field</label>
                  <select id="ce-mfield" className="ld-in xs" value={c.options?.field ?? ""} onChange={(e) => opt({ field: e.target.value })}>
                    <option value="">Pick a field</option>
                    {ch.data?.fields.map((f) => (
                      <option key={f.id} value={f.id}>{f.name} ({f.listName})</option>
                    ))}
                  </select>
                </>
              )}
              {chartKind !== "number" && (
                <>
                  <label htmlFor="ce-by">Split by</label>
                  <select id="ce-by" className="ld-in xs" value={c.options?.by ?? "status"} onChange={(e) => opt({ by: e.target.value })}>
                    <option value="status">Status</option>
                    <option value="assignee">Assignee</option>
                    <option value="priority">Priority</option>
                    <option value="tag">Tag</option>
                    <option value="list">List</option>
                    {ch.data?.groupFields.map((f) => (
                      <option key={f.id} value={`f:${f.id}`}>{f.name} ({f.listName})</option>
                    ))}
                    <option value="none">Nothing, one total</option>
                  </select>
                </>
              )}
              <label htmlFor="ce-period">Time</label>
              <select id="ce-period" className="ld-in xs" value={c.options?.period ?? (chartKind === "line" ? "quarter" : "all")} onChange={(e) => opt({ period: e.target.value as "all" })}>
                <option value="week">This week</option>
                <option value="month">Last 30 days</option>
                <option value="quarter">Last 90 days</option>
                <option value="all">All time</option>
              </select>
            </>
          )}
          {c.type === "ai" && (
            <>
              <label htmlFor="ce-ai">Nora writes</label>
              <select id="ce-ai" className="ld-in xs" value={c.options?.ai ?? "summary"} onChange={(e) => opt({ ai: e.target.value as "summary" })}>
                <option value="team">A team update</option>
                <option value="standup">A daily standup</option>
                <option value="project">A project update</option>
                <option value="summary">An executive summary</option>
                <option value="brain">An answer to my prompt</option>
              </select>
              {c.options?.ai === "brain" && (
                <>
                  <label htmlFor="ce-prompt">Prompt</label>
                  <textarea id="ce-prompt" className="ld-ta" rows={3} placeholder="What should Nora work out from these tasks?" value={c.options?.prompt ?? ""} onChange={(e) => opt({ prompt: e.target.value })} />
                </>
              )}
              <span className="ld-small ld-muted" style={{ gridColumn: "1 / -1" }}>Nora writes it from the tasks in the place you pick, keeps it for six hours, and writes it again when you press Refresh.</span>
            </>
          )}
          {c.type === "notes" && (
            <>
              <label htmlFor="ce-text">Notes</label>
              <textarea id="ce-text" className="ld-ta" rows={8} placeholder="Anything the team should see on this dashboard." value={c.options?.text ?? ""} onChange={(e) => opt({ text: e.target.value })} />
            </>
          )}
          {c.type === "table" && (
            <>
              <label htmlFor="ce-table">Table</label>
              <select id="ce-table" className="ld-in xs" value={c.options?.table ?? "tasks"} onChange={(e) => opt({ table: e.target.value as "tasks" })}>
                {TABLE_TEXT.map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <label htmlFor="ce-limit">Rows</label>
              <select id="ce-limit" className="ld-in xs" value={c.options?.limit ?? 10} onChange={(e) => opt({ limit: Number(e.target.value) })}>
                {[5, 10, 20, 50].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </>
          )}
          {c.type === "embed" && (
            <>
              <label htmlFor="ce-embed">Show</label>
              <select id="ce-embed" className="ld-in xs" value={c.options?.embed ?? "url"} onChange={(e) => opt({ embed: e.target.value as "url" })}>
                <option value="url">Any page by link</option>
                <option value="doc">A doc from this workspace</option>
                <option value="board">A whiteboard</option>
                <option value="form">A form</option>
                <option value="gdoc">A Google Doc</option>
                <option value="gsheet">A Google Sheet</option>
                <option value="gslides">Google Slides</option>
                <option value="youtube">A YouTube video</option>
                <option value="calendar">This week's tasks on a calendar</option>
              </select>
              {["url", "gdoc", "gsheet", "gslides", "youtube"].includes(c.options?.embed ?? "url") && (
                <>
                  <label htmlFor="ce-url">Link</label>
                  <input id="ce-url" className="ld-in xs" placeholder="https://" value={c.options?.url ?? ""} onChange={(e) => opt({ url: e.target.value })} />
                </>
              )}
              {c.options?.embed === "doc" && (
                <>
                  <label htmlFor="ce-edoc">Doc</label>
                  <select id="ce-edoc" className="ld-in xs" value={c.options?.docId ?? ""} onChange={(e) => opt({ docId: Number(e.target.value) })}>
                    <option value="">Pick a doc</option>
                    {ch.data?.docs.map((d) => (
                      <option key={d.id} value={d.id}>{d.title}</option>
                    ))}
                  </select>
                </>
              )}
              {c.options?.embed === "board" && (
                <>
                  <label htmlFor="ce-board">Whiteboard</label>
                  <select id="ce-board" className="ld-in xs" value={c.options?.boardId ?? ""} onChange={(e) => opt({ boardId: Number(e.target.value) })}>
                    <option value="">Pick a whiteboard</option>
                    {ch.data?.boards.map((d) => (
                      <option key={d.id} value={d.id}>{d.title}</option>
                    ))}
                  </select>
                </>
              )}
              {c.options?.embed === "form" && (
                <>
                  <label htmlFor="ce-form">Form</label>
                  <select id="ce-form" className="ld-in xs" value={c.options?.formId ?? ""} onChange={(e) => opt({ formId: Number(e.target.value) })}>
                    <option value="">Pick a form</option>
                    {ch.data?.forms.map((d) => (
                      <option key={d.id} value={d.id}>{d.title}</option>
                    ))}
                  </select>
                </>
              )}
              {["url", "gdoc", "gsheet", "gslides"].includes(c.options?.embed ?? "url") && <span className="ld-small ld-muted" style={{ gridColumn: "1 / -1" }}>Some sites refuse to show inside another page. Google files need "Anyone with the link" sharing.</span>}
            </>
          )}
          {c.type === "fieldsum" && (
            <>
              <label htmlFor="ce-field">Field</label>
              <select id="ce-field" className="ld-in xs" value={c.options?.field ?? ""} onChange={(e) => opt({ field: e.target.value })}>
                <option value="">Pick a field</option>
                {ch.data?.fields.map((f) => (
                  <option key={f.id} value={f.id}>{f.name} ({f.listName})</option>
                ))}
              </select>
            </>
          )}
          {c.type === "goal" && (
            <>
              <label htmlFor="ce-goal">Goal</label>
              <select id="ce-goal" className="ld-in xs" value={c.options?.goalId ?? ""} onChange={(e) => opt({ goalId: Number(e.target.value) })}>
                <option value="">Pick a goal</option>
                {ch.data?.goals.map((g) => (
                  <option key={g.id} value={g.id}>{g.title}</option>
                ))}
              </select>
            </>
          )}
          {c.type === "doc" && (
            <>
              <label htmlFor="ce-doc">Doc</label>
              <select id="ce-doc" className="ld-in xs" value={c.options?.docId ?? ""} onChange={(e) => opt({ docId: Number(e.target.value) })}>
                <option value="">Pick a doc</option>
                {ch.data?.docs.map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="ce-size">Width</label>
          <select id="ce-size" className="ld-in xs" value={c.size ?? 1} onChange={(e) => put({ size: Number(e.target.value) as 1 | 2 | 3 })}>
            <option value={1}>One column</option>
            <option value={2}>Two columns</option>
            <option value={3}>Full width</option>
          </select>
          <ErrorLine error={ch.error} />
        </div>
      </div>
    </div>
  );
}
