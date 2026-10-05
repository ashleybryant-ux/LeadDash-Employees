import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BottomNav, ErrorLine, Rail } from "../ui";
import { fmtYmd, ViewTabs } from "../goals/shared";
import type { Outputs } from "../types";
import { ListView } from "../goals/ListView";
import { CardsView } from "../goals/CardsView";
import { DashboardView } from "../goals/DashboardView";
import { MapView } from "../goals/MapView";
import { ScorecardView } from "../goals/ScorecardView";
import { PeopleView, TodayView } from "../goals/PeopleToday";
import { GoalPanel } from "../goals/GoalPanel";
import { GoalEditor } from "../goals/GoalEditor";

/**
 * Goals: this workspace's goals, set by the owner and Simone together, in the
 * views ClickUp and Asana use: List (with a side panel), Cards (in folders),
 * Dashboard, Map, the weekly Scorecard, People and Today.
 */

export type Overview = Outputs["goals"]["overview"];
export type GoalRow = Overview["goals"][number];
type View = "list" | "cards" | "dashboard" | "map" | "scorecard" | "people" | "today";
const VIEWS: { key: View; label: string }[] = [
  { key: "list", label: "List" },
  { key: "cards", label: "Cards" },
  { key: "dashboard", label: "Dashboard" },
  { key: "map", label: "Map" },
  { key: "scorecard", label: "Scorecard" },
  { key: "people", label: "People" },
  { key: "today", label: "Today" },
];

export type Filters = { period: string; owner: string; status: string; group: "parent" | "folder" | "none"; q: string };

export type GoalsCtx = {
  orgId: number;
  data: Overview;
  open: (id: number | null) => void;
  edit: (g: GoalRow | "new" | null, defaults?: Partial<GoalRow["goal"]>) => void;
  refresh: () => Promise<unknown>;
  filters: Filters;
  setFilters: (f: Filters) => void;
  shown: GoalRow[];
};

function readView(): View {
  const v = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("view") : null;
  return (VIEWS.some((x) => x.key === v) ? v : "list") as View;
}

export default function Goals() {
  const { currentOrgId, currentOrg } = useTenant();
  const [, go] = useLocation();
  const utils = trpc.useUtils();
  const q = trpc.goals.overview.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0, refetchInterval: 60_000 });
  const [view, setView] = React.useState<View>(readView);
  const [openId, setOpenId] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<{ row: GoalRow | "new"; defaults?: Partial<GoalRow["goal"]> } | null>(null);
  const [filters, setFilters] = React.useState<Filters>({ period: "", owner: "", status: "", group: "parent", q: "" });
  const refresh = () => utils.goals.overview.invalidate();
  const pick = (v: View) => {
    setView(v);
    go(`/goals?view=${v}`, { replace: true });
  };
  const data = q.data;
  const shown = React.useMemo(() => {
    if (!data) return [];
    const words = filters.q.trim().toLowerCase();
    return data.goals.filter(
      (g) =>
        g.goal.state !== "dismissed" &&
        (!filters.period || g.goal.period === filters.period) &&
        (!filters.owner || `${g.goal.ownerType}:${g.goal.ownerId}` === filters.owner) &&
        (!filters.status || g.status === filters.status || (filters.status === "waiting" && (g.goal.state === "suggested" || g.goal.state === "draft"))) &&
        (!words || g.goal.title.toLowerCase().includes(words))
    );
  }, [data, filters]);
  const orgName = currentOrg?.name ?? "";
  const ctx: GoalsCtx | null = data
    ? { orgId: currentOrgId, data, open: setOpenId, edit: (g, defaults) => setEditing(g ? { row: g, defaults } : null), refresh, filters, setFilters, shown }
    : null;
  const openRow = data?.goals.find((g) => g.goal.id === openId) ?? null;
  const periods = Array.from(new Set((data?.goals ?? []).map((g) => g.goal.period).filter(Boolean)));
  const read = data?.read;
  const coo = data?.people.find((p) => p.type === "employee" && p.kind === "coo");

  return (
    <div className="ld">
      <Rail active="goals" />
      <main className="gp-main">
        <div className="gp-head">
          <div className="gp-hrow">
            <span className="gp-ttl">
              <span className="gi" aria-hidden="true">◎</span>Goals
              <span className="crumb">{orgName ? `· ${orgName}` : ""}</span>
            </span>
            <span className="ld-small ld-muted gp-hide-sm">Set by you and Simone{read ? ` · Monday scorecard posted ${fmtYmd(new Date(read.at).toISOString().slice(0, 10))}` : ""}</span>
          </div>
          <ViewTabs views={VIEWS} value={view} onChange={pick} />
        </div>
        {ctx && view !== "dashboard" && view !== "people" && view !== "today" && view !== "scorecard" && (
          <div className="gp-tool">
            <span className="gp-tool-l">
              <select className="gp-fb sel" aria-label="Time period" value={filters.period} onChange={(e) => setFilters({ ...filters, period: e.target.value })}>
                <option value="">All periods</option>
                {periods.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <select className="gp-fb" aria-label="Owner" value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })}>
                <option value="">Owner: anyone</option>
                {ctx.data.people.map((p) => (
                  <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
                ))}
              </select>
              <select className="gp-fb" aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="">Status: any</option>
                <option value="on">On track</option>
                <option value="risk">At risk</option>
                <option value="off">Off track</option>
                <option value="done">Done</option>
                <option value="waiting">Needs your OK</option>
              </select>
              {view === "list" && (
                <select className="gp-fb" aria-label="Group" value={filters.group} onChange={(e) => setFilters({ ...filters, group: e.target.value as Filters["group"] })}>
                  <option value="parent">Group: Year goal</option>
                  <option value="folder">Group: Folder</option>
                  <option value="none">Group: None</option>
                </select>
              )}
            </span>
            <span className="gp-tool-r">
              <input className="gp-srch" placeholder="Search goals" aria-label="Search goals" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
              <Link href={coo ? "/chats/coo" : "/chats"} className="ld-btn gp-auto">Ask Simone</Link>
              <button type="button" className="ld-btn p gp-auto" onClick={() => setEditing({ row: "new" })}>+ New goal</button>
            </span>
          </div>
        )}
        <div className={`gp-canvas ${openRow ? "with-pane" : ""}`}>
          <ErrorLine error={q.error} />
          {!ctx ? (
            <p className="ld-muted" style={{ padding: 20 }}>{q.isLoading ? "Loading goals" : ""}</p>
          ) : (
            <>
              <div className="gp-view">
                {view === "list" && <ListView c={ctx} openId={openId} />}
                {view === "cards" && <CardsView c={ctx} />}
                {view === "dashboard" && <DashboardView c={ctx} />}
                {view === "map" && <MapView c={ctx} />}
                {view === "scorecard" && <ScorecardView c={ctx} />}
                {view === "people" && <PeopleView c={ctx} onOwner={(k: string) => { setFilters({ ...filters, owner: k }); pick("list"); }} />}
                {view === "today" && <TodayView c={ctx} />}
              </div>
              {openRow && <GoalPanel c={ctx} row={openRow} onClose={() => setOpenId(null)} />}
            </>
          )}
        </div>
      </main>
      {ctx && editing && <GoalEditor c={ctx} row={editing.row} defaults={editing.defaults} onClose={() => setEditing(null)} />}
      <BottomNav active="goals" />
    </div>
  );
}
