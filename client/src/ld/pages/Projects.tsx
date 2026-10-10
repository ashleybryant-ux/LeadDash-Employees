import React from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BottomNav, ErrorLine, Rail } from "../ui";
import { Menu } from "../goals/shared";
import type { Outputs } from "../types";
import { Tree, type Ask } from "../projects/Tree";
import { groupsOf, ListView, TableView } from "../projects/ListView";
import { BoardView } from "../projects/BoardView";
import { CalendarView, GanttView } from "../projects/TimeViews";
import { MindMapView, TimelineView, WorkloadView } from "../projects/MoreViews";
import { TaskModal } from "../projects/TaskModal";
import { Automations } from "../projects/Automations";
import { ImportPage } from "../projects/ImportPage";
import { ListSettings } from "../projects/ListSettings";
import { ShareList } from "../projects/Share";
import { SaveTemplate, TemplatesPage, UseTaskTemplate } from "../projects/Templates";
import { TimesheetPage } from "../projects/Timesheet";
import { DocPage } from "../projects/Docs";
import { BoardPage } from "../projects/Whiteboard";
import { FormPage } from "../projects/Forms";
import { DashboardsPage } from "../projects/Dashboards";
import { RunningTimer } from "../projects/Running";
import { MyWorkPhone } from "../projects/Phone";
import { AddView, DEFAULT_TABS, KINDS, ViewTabsPlus, type Current, type SavedView, type ViewKind, type ViewSettings } from "../projects/Views";
import { DEFAULT_COLUMNS, type ColKey } from "../projects/Columns";
import { FolderOverview } from "../projects/Overview";
import { DocsHub } from "../projects/DocsHub";
import { HomePage } from "../projects/Home";
import { BulkBar } from "../projects/Bulk";
import { PortfolioPage, PortfoliosPage } from "../projects/Portfolios";
import { StatusPill, StatusUpdate } from "../projects/StatusUpdate";
import { Customize, exportRows, GroupPop, groupLabel, SORT_CHOICES, SortPop, useExport, type Flags } from "../projects/Customize";
import { SidebarPage } from "../projects/Sidebar";

/**
 * Projects, in place of ClickUp: Home (what needs a person, the work by when,
 * the AI team, each project's health), then this workspace's folders with
 * their lists, docs, whiteboards and forms on the left, plus Docs, Dashboards,
 * Timesheets and Templates; a list's (or a folder's, or everything's) tasks as
 * a List, Board or Calendar, with Gantt, Table, Workload, Timeline and Mind map
 * added as tabs, and saved views of any kind. A task opens beside the list (or
 * over the page); its values change with one click. Tick rows to change many
 * at once. Keys: N new task, / search, X pick a row, arrows and Enter.
 * People and employees are both assignees. A guest sees only the lists
 * shared with them.
 */

export type ViewOut = Outputs["pj"]["view"];
export type TaskRow = ViewOut["tasks"][number];
type View = ViewKind;
const VIEW_KEYS = KINDS.map((k) => k.key);

export type Where =
  | { scope: "home" }
  | { scope: "list"; listId: number }
  | { scope: "folder"; folderId: number; tab?: "overview" }
  | { scope: "everything" }
  | { scope: "mine" }
  | { scope: "import" }
  | { scope: "docs"; tab?: "boards" | "forms" }
  | { scope: "doc"; id: number }
  | { scope: "board"; id: number }
  | { scope: "form"; id: number }
  | { scope: "dash"; id?: number }
  | { scope: "time" }
  | { scope: "templates" }
  | { scope: "portfolios" }
  | { scope: "portfolio"; id: number }
  | { scope: "sidebar" };
export type PjCtx = {
  orgId: number;
  data: ViewOut;
  tasks: TaskRow[];
  open: (id: number) => void;
  refresh: () => Promise<unknown>;
  /** status, priority, assignee, project, tags, due, none, or f:<field id>. */
  group: string;
  dir: "asc" | "desc";
  sort: "manual" | "due" | "priority" | "name";
  sortDir: "asc" | "desc";
  /** Subtasks collapsed under the parent, expanded below it, or rows of their own. */
  subtaskMode: "collapsed" | "expanded" | "separate";
  subtasks: TaskRow[];
  /** View options from Customize view. */
  opts: { showEmpty?: boolean; wrap?: boolean; locations?: boolean; parentNames?: boolean; estimates?: boolean };
  listId: number | null;
  /** What I can do here: view, comment, edit or full. */
  level: "view" | "comment" | "edit" | "full";
  /** Columns shown on the List and Table views, and how to change them. */
  columns: ColKey[];
  setColumns: (cols: ColKey[]) => void;
  /** True while the columns are the defaults nobody picked: empty ones stay hidden. */
  autoColumns: boolean;
  /** Rows ticked for a change to all of them at once. */
  selected: Set<number>;
  toggle: (id: number, range?: boolean) => void;
  clearSelected: () => void;
  /** A task is open beside the list: rows show only the name, who and when. */
  compact: boolean;
  openId: number | null;
  /** Set when the tasks shown are a portfolio's. */
  portfolioId?: number | null;
};

const PAGES = ["doc", "board", "form", "dash", "time", "templates", "docs", "portfolios", "portfolio", "sidebar"] as const;
function readUrl(): { where: Where; view: View; savedId: number | null; task: number | null; hadView: boolean } {
  const p = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const list = Number(p.get("list"));
  const folder = Number(p.get("folder"));
  const view = (VIEW_KEYS.includes(p.get("view") as View) ? p.get("view") : "list") as View;
  const page = p.get("page") as (typeof PAGES)[number] | null;
  const id = Number(p.get("id")) || undefined;
  const where: Where = p.get("import")
    ? { scope: "import" }
    : page === "doc" || page === "board" || page === "form" || page === "portfolio"
      ? { scope: page, id: id ?? 0 }
      : page === "dash"
        ? { scope: "dash", id }
        : page === "docs"
          ? { scope: "docs", tab: p.get("tab") === "boards" || p.get("tab") === "forms" ? (p.get("tab") as "boards" | "forms") : undefined }
        : page === "time" || page === "templates" || page === "portfolios" || page === "sidebar"
          ? { scope: page }
          : list
            ? { scope: "list", listId: list }
            : folder
              ? { scope: "folder", folderId: folder, tab: p.get("tab") === "overview" || !p.get("view") ? "overview" : undefined }
              : p.get("scope") === "mine"
                ? { scope: "mine" }
                : p.get("scope") === "everything" || p.get("view") || p.get("saved") || p.get("task")
                  ? { scope: "everything" }
                  : { scope: "home" };
  return { where, view, savedId: Number(p.get("saved")) || null, task: Number(p.get("task")) || null, hadView: !!p.get("view") || !!p.get("saved") };
}

export default function Projects() {
  const { currentOrgId, currentOrg } = useTenant();
  const [, go] = useLocation();
  const utils = trpc.useUtils();
  const first = React.useMemo(readUrl, []);
  const [where, setWhere] = React.useState<Where>(first.where);
  const [cur, setCur] = React.useState<Current>({ kind: first.view, savedId: first.savedId });
  const [taskId, setTaskId] = React.useState<number | null>(first.task);
  const [group, setGroup] = React.useState<PjCtx["group"]>("status");
  const [dir, setDir] = React.useState<PjCtx["dir"]>("asc");
  const [sort, setSort] = React.useState<PjCtx["sort"]>("manual");
  const [sortDir, setSortDir] = React.useState<PjCtx["sortDir"]>("asc");
  const [subtaskMode, setSubtaskMode] = React.useState<PjCtx["subtaskMode"]>("collapsed");
  const [opts, setOpts] = React.useState<PjCtx["opts"]>({});
  const [pop, setPop] = React.useState<"" | "group" | "sort">("");
  // Opening a list or folder lands on its default view unless the link named one.
  const [wantDefault, setWantDefault] = React.useState(!first.hadView);
  const [edited, setEdited] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  const [lastPick, setLastPick] = React.useState<number | null>(null);
  const [taskFull, setTaskFull] = React.useState(false);
  const [wide, setWide] = React.useState(() => typeof window === "undefined" || window.innerWidth > 1100);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [who, setWho] = React.useState("");
  const [priority, setPriority] = React.useState("");
  const [closed, setClosed] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [columnsLocal, setColumnsLocal] = React.useState<ColKey[] | null>(null);
  const [panel, setPanel] = React.useState<"" | "automations" | "settings" | "share" | "saveList" | "fromTemplate" | "addView" | "customize">("");
  const [editView, setEditView] = React.useState<SavedView | null>(null);
  const [saveTask, setSaveTask] = React.useState<number | null>(null);
  const [statusFor, setStatusFor] = React.useState<number | null>(null);
  const archiveList = trpc.pj.archiveList.useMutation({ onSuccess: () => refresh() });
  const [adding, setAdding] = React.useState(false);
  const [ask, setAsk] = React.useState<Ask>(null);
  const [drawer, setDrawer] = React.useState(false);
  const guest = !!(currentOrg as { guest?: boolean } | null)?.guest;
  const tree = trpc.pj.tree.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const meQ = trpc.pj.me.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const home = where.scope === "home";
  const isFolder = where.scope === "folder";
  const folderId = isFolder ? where.folderId : null;
  const overview = isFolder && where.tab === "overview";
  const isList = where.scope === "list" || where.scope === "everything" || where.scope === "mine" || (isFolder && !overview);
  const view = cur.kind;
  const v = trpc.pj.view.useQuery(
    {
      organizationId: currentOrgId,
      listId: where.scope === "list" ? where.listId : null,
      folderId,
      scope: where.scope === "list" ? "list" : where.scope === "mine" ? "mine" : isFolder ? "folder" : "everything",
      closed,
    },
    { enabled: currentOrgId > 0 && isList, refetchInterval: 20_000 }
  );
  const target = { listId: where.scope === "list" ? where.listId : null, folderId };
  const views = trpc.pj.views.useQuery({ organizationId: currentOrgId, ...target }, { enabled: currentOrgId > 0 && (isList || overview) && !guest });
  const setBuiltin = trpc.pj.setBuiltinView.useMutation({ onSuccess: () => utils.pj.views.invalidate() });
  const setFlags = trpc.pj.setViewFlags.useMutation({ onSuccess: () => utils.pj.views.invalidate() });
  const setAutosave = trpc.pj.setAutosave.useMutation({ onSuccess: () => utils.pj.views.invalidate() });
  const starView = trpc.pj.starView.useMutation({ onSuccess: () => { void utils.pj.views.invalidate(); void utils.pj.favorites.invalidate(); } });
  const exporter = useExport(currentOrgId);
  const removeView = trpc.pj.removeView.useMutation({ onSuccess: () => { void utils.pj.views.invalidate(); setCur((c) => ({ kind: c.kind, savedId: null })); } });
  const saveViewMut = trpc.pj.saveView.useMutation({ onSuccess: () => utils.pj.views.invalidate() });
  React.useEffect(() => {
    const p = new URLSearchParams();
    if (where.scope === "list") p.set("list", String(where.listId));
    if (where.scope === "folder") {
      p.set("folder", String(where.folderId));
      if (where.tab === "overview") p.set("tab", "overview");
    }
    if (where.scope === "mine" || where.scope === "everything") p.set("scope", where.scope);
    if (where.scope === "import") p.set("import", "1");
    if ((PAGES as readonly string[]).includes(where.scope)) {
      p.set("page", where.scope);
      if ("id" in where && where.id) p.set("id", String(where.id));
      if (where.scope === "docs" && where.tab) p.set("tab", where.tab);
    }
    if (isList && (view !== "list" || cur.savedId)) p.set("view", view);
    if (isList && cur.savedId) p.set("saved", String(cur.savedId));
    if (taskId) p.set("task", String(taskId));
    const s = p.toString();
    go(`/projects${s ? `?${s}` : ""}`, { replace: true });
  }, [where, cur, taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A guest starts on the first list shared with them, or the first doc when no list is.
  React.useEffect(() => {
    if (!guest || !tree.data || where.scope === "list" || where.scope === "doc") return;
    const firstList = tree.data.folders.flatMap((f) => f.lists)[0] ?? tree.data.loose[0];
    if (firstList) setWhere({ scope: "list", listId: firstList.id });
    else if (tree.data.sharedDocs[0]) setWhere({ scope: "doc", id: tree.data.sharedDocs[0].id });
  }, [guest, tree.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening a view loads its filters, grouping and columns.
  const saved = cur.savedId ? views.data?.saved.find((s) => s.id === cur.savedId) ?? null : null;
  React.useEffect(() => {
    const s: ViewSettings | undefined = saved ? saved.settings : views.data?.builtin[view];
    setGroup(s?.group ?? (where.scope === "list" ? "status" : "project"));
    setDir(s?.dir ?? "asc");
    setSort((s?.sort as PjCtx["sort"]) ?? "manual");
    setSortDir(s?.sortDir ?? "asc");
    setSubtaskMode(s?.subtasks ?? "collapsed");
    setOpts({ showEmpty: s?.showEmpty, wrap: s?.wrap, locations: s?.locations, parentNames: s?.parentNames, estimates: s?.estimates });
    setWho(s?.who ?? "");
    setPriority(s?.priority ?? "");
    setClosed(!!s?.closed);
    setQ(s?.q ?? "");
    setColumnsLocal(null);
    setSelected(new Set());
    setEdited(false);
  }, [cur.savedId, cur.kind, where.scope, target.listId, target.folderId, views.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // The default view of a list or folder, once its views load.
  React.useEffect(() => {
    if (!wantDefault || !views.data || !isList) return;
    setWantDefault(false);
    const d = views.data.defaultView;
    if (d && (d.kind !== cur.kind || (d.savedId ?? null) !== cur.savedId)) setCur({ kind: d.kind as ViewKind, savedId: d.savedId ?? null });
  }, [wantDefault, views.data, isList]); // eslint-disable-line react-hooks/exhaustive-deps
  // Wide screens open a task beside the list; narrow ones over it.
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 1101px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const refresh = () => Promise.all([utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.task.invalidate(), utils.pj.me.invalidate(), utils.pj.views.invalidate(), utils.pj.overview.invalidate()]);
  const data = v.data;
  const tasks = React.useMemo(() => {
    if (!data) return [];
    const words = q.trim().toLowerCase();
    const base = subtaskMode === "separate" ? [...data.tasks, ...data.subtasks] : data.tasks;
    return base.filter(
      (t) =>
        (!words || t.name.toLowerCase().includes(words)) &&
        (!who || (who === "me" ? t.assignees.some((a) => a.type === "user" && a.id === meQ.data?.userId) : t.assignees.some((a) => `${a.type}:${a.id}:${a.name}` === who))) &&
        (!priority || (t.priority ?? "none") === priority)
    );
  }, [data, q, who, priority, meQ.data?.userId, subtaskMode]);
  const level = data?.list?.level ?? data?.folder?.level ?? (guest ? "view" : "edit");
  const pickedColumns = columnsLocal ?? (saved ? saved.settings.columns : views.data?.builtin[view]?.columns);
  const columns: ColKey[] = pickedColumns ?? DEFAULT_COLUMNS[view === "table" ? "table" : "list"];
  const settingsNow: ViewSettings = { group, dir: dir === "desc" ? "desc" : undefined, sort: sort === "manual" ? undefined : sort, sortDir: sortDir === "desc" ? "desc" : undefined, subtasks: subtaskMode === "collapsed" ? undefined : subtaskMode, who: who || undefined, priority: priority || undefined, closed: closed || undefined, q: q || undefined, columns: pickedColumns, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)) };
  // Customize view: one place to change any setting; flags live on the view row.
  const patchSettings = (p: Partial<ViewSettings>) => {
    setEdited(true);
    if (p.group !== undefined) setGroup(p.group ?? "status");
    if (p.dir !== undefined) setDir(p.dir ?? "asc");
    if ("sort" in p) setSort((p.sort as PjCtx["sort"]) ?? "manual");
    if (p.sortDir !== undefined) setSortDir(p.sortDir ?? "asc");
    if ("subtasks" in p) setSubtaskMode(p.subtasks ?? "collapsed");
    if ("who" in p) setWho(p.who ?? "");
    if ("priority" in p) setPriority(p.priority ?? "");
    if ("closed" in p) setClosed(!!p.closed);
    if ("q" in p) setQ(p.q ?? "");
    const o: Partial<PjCtx["opts"]> = {};
    for (const k of ["showEmpty", "wrap", "locations", "parentNames", "estimates"] as const) if (k in p) o[k] = !!p[k];
    if (Object.keys(o).length) setOpts((x) => ({ ...x, ...o }));
  };
  const builtinFlags = views.data?.flags[view];
  const autosaveKey = `autosave:${target.listId ?? 0}:${target.folderId ?? 0}:${view}:${cur.savedId ?? 0}`;
  const flags: Flags = {
    protected: saved ? saved.protected : !!builtinFlags?.protected,
    isDefault: saved ? saved.isDefault : !!builtinFlags?.isDefault,
    pinned: !!saved?.pinned,
    private: !!saved?.private,
    starred: !!views.data?.starred.includes(saved ? saved.id : builtinFlags?.id ?? -1),
    autosave: !!views.data?.autosave[autosaveKey],
  };
  const lockedView = flags.protected && !views.data?.canProtect && !(saved?.private && saved.mine);
  const saveSettingsNow = (settings: ViewSettings) => {
    if (guest || lockedView) return;
    if (saved) { if (saved.mine) saveViewMut.mutate({ organizationId: currentOrgId, id: saved.id, ...target, name: saved.name, kind: saved.kind, settings, private: saved.private, pinned: saved.pinned }); }
    else if (level === "edit" || level === "full") setBuiltin.mutate({ organizationId: currentOrgId, ...target, kind: view, settings });
  };
  // Autosave for me: each change saves to the view a moment later.
  React.useEffect(() => {
    if (!flags.autosave || !edited || !isList) return;
    const h = setTimeout(() => saveSettingsNow(settingsNow), 600);
    return () => clearTimeout(h);
  }, [JSON.stringify(settingsNow), flags.autosave, edited]); // eslint-disable-line react-hooks/exhaustive-deps
  const setColumns = (cols: ColKey[]) => {
    setColumnsLocal(cols);
    if (guest) return;
    if (saved) saveViewMut.mutate({ organizationId: currentOrgId, id: saved.id, ...target, name: saved.name, kind: saved.kind, settings: { ...saved.settings, columns: cols }, private: saved.private, pinned: saved.pinned });
    else if (level === "edit" || level === "full") setBuiltin.mutate({ organizationId: currentOrgId, ...target, kind: view, settings: { ...(views.data?.builtin[view] ?? {}), columns: cols } });
  };
  const toggle = (id: number, range = false) => {
    setSelected((s) => {
      const n = new Set(s);
      if (range && lastPick !== null) {
        const order = Array.from(document.querySelectorAll<HTMLElement>("[data-task]")).map((el) => Number(el.dataset.task));
        const a = order.indexOf(lastPick);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) n.add(x);
        return n;
      }
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    setLastPick(id);
  };
  const clearSelected = () => setSelected(new Set());
  const openTask = (id: number) => { setTaskId(id); setTaskFull(false); };
  const beside = !!taskId && wide && !taskFull && isList;
  const ctx: PjCtx | null = data ? { orgId: currentOrgId, data, tasks, open: openTask, refresh, group, dir, sort, sortDir, subtaskMode, subtasks: data.subtasks, opts, listId: where.scope === "list" ? where.listId : null, level, columns, setColumns, autoColumns: !pickedColumns, selected, toggle, clearSelected, compact: beside, openId: taskId } : null;
  const folderRow = folderId ? tree.data?.folders.find((f) => f.id === folderId) : null;
  const title = where.scope === "list" ? data?.list?.name ?? "" : where.scope === "mine" ? "My tasks" : where.scope === "home" ? "Home" : where.scope === "import" ? "Import from ClickUp" : isFolder ? folderRow?.name ?? data?.folder?.name ?? "" : "Everything";
  const crumb = where.scope === "list" && data?.list?.folderName ? `${data.list.folderName} /` : isFolder ? `${currentOrg?.name ?? ""} /` : "";
  const assignees = Array.from(new Map((data?.tasks ?? []).flatMap((t) => t.assignees).map((a) => [`${a.type}:${a.id}:${a.name}`, a])).values());
  const pick = (w: Where) => {
    setWhere(w);
    setTaskId(null);
    setSelected(new Set());
    setPop("");
    if (panel === "customize") setPanel("");
    if (w.scope === "list" || w.scope === "folder" || w.scope === "everything") setWantDefault(true);
    if (w.scope !== "list" && w.scope !== "folder" && w.scope !== "everything") setCur({ kind: "list", savedId: null });
    else if (cur.savedId || !(views.data?.tabs ?? DEFAULT_TABS).includes(cur.kind)) setCur({ kind: "list", savedId: null });
  };
  const full = level === "full";
  const tabs = (views.data?.tabs ?? DEFAULT_TABS) as ViewKind[];
  const kinds = (guest ? tabs.filter((x) => x !== "workload") : tabs).filter((k) => VIEW_KEYS.includes(k));
  const removeTab = trpc.pj.removeBuiltinView.useMutation({ onSuccess: () => { void utils.pj.views.invalidate(); setCur({ kind: "list", savedId: null }); } });
  // Keys: N new task, / search, Escape clears the picked rows, arrows move between rows (X on a row picks it, Enter opens it).
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (el?.closest(".gp-modal, .gp-qpop, [role=dialog]")) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-task]"));
        if (!rows.length) return;
        const i = rows.findIndex((r) => r === document.activeElement);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
        next.focus();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        if (selected.size) setSelected(new Set());
        return;
      }
      if (e.key === "/") {
        searchRef.current?.focus();
        e.preventDefault();
        return;
      }
      if (e.key.toLowerCase() === "n" && !guest) {
        if (!isList) pick({ scope: "everything" });
        setAdding(true);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selected.size, isList, guest]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveDoc = trpc.pj.saveDoc.useMutation({ onSuccess: async (d) => { await refresh(); pick({ scope: "doc", id: d.id }); } });
  const saveBoard = trpc.pj.saveBoard.useMutation({ onSuccess: async (b) => { await refresh(); pick({ scope: "board", id: b.id }); } });
  const saveForm = trpc.pj.saveForm.useMutation({ onSuccess: async (f) => { await refresh(); pick({ scope: "form", id: f.id }); } });
  const saveDash = trpc.pj.saveDashboard.useMutation({ onSuccess: async (d) => { await refresh(); pick({ scope: "dash", id: d.id }); } });
  const makeItem = (kind: "doc" | "board" | "form" | "dash", name: string) => {
    setPanel("");
    const listId = where.scope === "list" ? where.listId : null;
    const inFolder = folderId ?? data?.list?.folderId ?? null;
    if (kind === "doc") saveDoc.mutate({ organizationId: currentOrgId, title: name, listId, folderId: inFolder });
    else if (kind === "board") saveBoard.mutate({ organizationId: currentOrgId, title: name, listId, folderId: inFolder });
    else if (kind === "form") saveForm.mutate({ organizationId: currentOrgId, title: name, listId, folderId: inFolder });
    else saveDash.mutate({ organizationId: currentOrgId, name });
  };
  const archivedList = where.scope === "list" && !!data?.list?.archivedAt;
  const headerButtons = (
    <span className="ld-row">
      {archivedList && (meQ.data?.role === "owner" || meQ.data?.role === "admin") && <button type="button" className="ld-btn p" disabled={archiveList.isPending} onClick={() => archiveList.mutate({ organizationId: currentOrgId, id: (where as { listId: number }).listId, on: false })}>Restore</button>}
      {where.scope === "list" && !guest && !archivedList && (level === "edit" || full) && <button type="button" className="ld-btn" onClick={() => setStatusFor(where.listId)}>{data?.list?.status ? "Update status" : "Set status"}</button>}
      {where.scope === "list" && !guest && <button type="button" className="ld-btn" onClick={() => setPanel("share")}>Share</button>}
      {where.scope === "list" && full && <button type="button" className="ld-btn" onClick={() => setPanel("settings")}>Edit list</button>}
      {folderId && !guest && <button type="button" className="ld-btn" onClick={() => setAsk({ kind: "folder", n: Date.now(), id: folderId })}>Edit folder</button>}
      {!guest && (where.scope !== "list" || full) && !overview && <button type="button" className="ld-btn" onClick={() => setPanel("automations")}>Automations</button>}
      {where.scope === "list" && !guest && (
        <Menu label="List options">
          {(close) => (
            <button type="button" role="menuitem" onClick={() => { setPanel("saveList"); close(); }}>Save as a template</button>
          )}
        </Menu>
      )}
    </span>
  );
  return (
    <div className={`ld ${guest ? "ld-guest" : ""}`}>
      {!guest && <Rail active="projects" />}
      <Tree
        orgId={currentOrgId}
        tree={tree.data}
        where={where}
        onPick={pick}
        onPickView={(w, kind, savedId) => { pick(w); setWantDefault(false); setCur({ kind: kind as ViewKind, savedId }); }}
        refresh={refresh}
        ask={ask}
        drawer={drawer}
        onCloseDrawer={() => setDrawer(false)}
        onNewTask={() => {
          if (!isList) pick({ scope: "everything" });
          setAdding(true);
        }}
        onHome={() => pick({ scope: "home" })}
      />
      <main className="gp-main">
        {guest && <GuestBar name={currentOrg?.name ?? ""} />}
        {home ? (
          <>
            <div className="gp-head" style={{ paddingBottom: 14 }}>
              <div className="gp-hrow">
                <span className="gp-ttl" style={{ fontSize: 18 }}>
                  <button type="button" className="ld-btn sm gp-auto gp-show-sm" onClick={() => setDrawer(true)} aria-label="Folders and lists">☰</button>
                  Home
                </span>
                <span className="ld-row">
                  <button type="button" className="ld-btn p" onClick={() => { pick({ scope: "everything" }); setAdding(true); }}>+ Task</button>
                </span>
              </div>
            </div>
            <div className="gp-canvas">
              <HomePage orgId={currentOrgId} onOpenTask={(id) => { setTaskId(id); setTaskFull(true); }} onPick={pick} onNewTask={() => { pick({ scope: "everything" }); setAdding(true); }} />
            </div>
          </>
        ) : isList || where.scope === "import" || overview ? (
          <>
            <div className="gp-head">
              <div className="gp-hrow">
                <span className="gp-ttl" style={{ fontSize: 18 }}>
                  <button type="button" className="ld-btn sm gp-auto gp-show-sm" onClick={() => setDrawer(true)} aria-label="Folders and lists">☰</button>
                  {crumb && (where.scope === "list" && data?.list?.folderId ? (
                    <button type="button" className="crumb gp-crumbbtn" style={{ fontSize: 14, marginLeft: 0 }} onClick={() => pick({ scope: "folder", folderId: data.list!.folderId!, tab: "overview" })}>{crumb}</button>
                  ) : (
                    <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>{crumb}</span>
                  ))}
                  {folderRow && <span style={{ background: folderRow.color, width: 12, height: 12, borderRadius: 3, display: "inline-block", flexShrink: 0 }} />}
                  {title}
                  {data?.list?.private && <span className="gp-chip" title={data.list.adminsOnly ? "Owners and admins only" : "Only the people it's shared with see it"}>🔒 {data.list.adminsOnly ? "Admins only" : "Private"}</span>}
                  {data?.list?.status && <StatusPill status={data.list.status.status} at={data.list.status.at} />}
                </span>
                {(isList || overview) && headerButtons}
              </div>
              {(isList || overview) && (
                <div style={{ position: "relative" }}>
                  <ViewTabsPlus
                    kinds={kinds}
                    current={overview ? null : cur}
                    saved={views.data?.saved ?? []}
                    canAdd={!guest && where.scope !== "mine"}
                    extra={folderId ? (
                      <button type="button" role="tab" aria-selected={overview} className={`gp-vw ${overview ? "on" : ""}`} onClick={() => setWhere({ scope: "folder", folderId, tab: "overview" })}>▥ Overview</button>
                    ) : undefined}
                    onPick={(c) => {
                      if (folderId && overview) setWhere({ scope: "folder", folderId });
                      setCur(c);
                    }}
                    onAdd={() => { setEditView(null); setPanel("addView"); }}
                    onRename={(sv) => { setEditView(sv); setPanel("addView"); }}
                    onRemove={(sv) => { if (window.confirm(`Delete the "${sv.name}" view? The tasks stay.`)) removeView.mutate({ organizationId: currentOrgId, id: sv.id }); }}
                    onRemoveTab={!guest && (level === "edit" || level === "full") ? (k) => removeTab.mutate({ organizationId: currentOrgId, ...target, kind: k }) : undefined}
                  />
                  {panel === "addView" && (
                    <AddView
                      orgId={currentOrgId}
                      listId={target.listId}
                      folderId={target.folderId}
                      listName={where.scope === "everything" ? "Everything" : title}
                      settings={settingsNow}
                      editing={editView}
                      canShare={level === "edit" || level === "full"}
                      tabs={tabs}
                      onAddTab={level === "edit" || level === "full" ? (k) => { setPanel(""); setBuiltin.mutate({ organizationId: currentOrgId, ...target, kind: k, settings: {} }, { onSuccess: () => { if (folderId && overview) setWhere({ scope: "folder", folderId }); setCur({ kind: k, savedId: null }); } }); } : undefined}
                      onClose={() => setPanel("")}
                      onMade={(c) => { setPanel(""); void utils.pj.views.invalidate(); if (folderId && overview) setWhere({ scope: "folder", folderId }); setCur(c); }}
                      onItem={makeItem}
                    />
                  )}
                </div>
              )}
            </div>
            {archivedList && data?.list && (
              <div className="gp-archbar" style={{ margin: "14px 28px 0" }}>
                <span><b>Archived {fmtArchived(data.list.archivedAt)}{data.list.archivedBy ? ` by ${data.list.archivedBy}` : ""}.</b> Read only. Its tasks, docs and time stay. Restore brings it back.</span>
              </div>
            )}
            {isList && (
              <div className="gp-tool">
                <span className="gp-tool-l">
                  {(view === "list" || view === "board") && (
                    <span className="gp-qcell">
                      <button type="button" className={`gp-fb sel ${pop === "group" ? "on" : ""}`} aria-expanded={pop === "group"} aria-haspopup="menu" onClick={() => setPop(pop === "group" ? "" : "group")}>Group: {groupLabel(group, data?.fields ?? [])} ▾</button>
                      {pop === "group" && ctx && <GroupPop c={ctx} group={group} dir={dir} many={where.scope !== "list"} onGroup={(g) => { patchSettings({ group: g }); setPop(""); }} onDir={(d) => patchSettings({ dir: d })} onClose={() => setPop("")} />}
                    </span>
                  )}
                  {(view === "list" || view === "table") && (
                    <span className="gp-qcell">
                      <button type="button" className="gp-fb" aria-expanded={pop === "sort"} aria-haspopup="menu" onClick={() => setPop(pop === "sort" ? "" : "sort")}>Sort: {SORT_CHOICES.find((x) => x.key === sort)?.label}{sort !== "manual" && sortDir === "desc" ? " ↓" : ""} ▾</button>
                      {pop === "sort" && <SortPop sort={sort} dir={sortDir} onSort={(x) => { patchSettings({ sort: x }); setPop(""); }} onDir={(d) => patchSettings({ sortDir: d })} onClose={() => setPop("")} />}
                    </span>
                  )}
                  {view !== "workload" && (
                    <>
                      <select className="gp-fb" aria-label="Assignee" value={who} onChange={(e) => patchSettings({ who: e.target.value || undefined })}>
                        <option value="">Anyone</option>
                        {!guest && <option value="me">Me</option>}
                        {assignees.map((a) => (
                          <option key={`${a.type}:${a.id}:${a.name}`} value={`${a.type}:${a.id}:${a.name}`}>{a.name}</option>
                        ))}
                      </select>
                      <select className="gp-fb" aria-label="Priority" value={priority} onChange={(e) => patchSettings({ priority: e.target.value || undefined })}>
                        <option value="">Any priority</option>
                        <option value="urgent">Urgent</option>
                        <option value="high">High</option>
                        <option value="normal">Normal</option>
                        <option value="low">Low</option>
                        <option value="none">No priority</option>
                      </select>
                      <button type="button" className={`gp-fb ${closed ? "sel" : ""}`} aria-pressed={closed} onClick={() => patchSettings({ closed: !closed })}>{closed ? "Hide done" : "Show done"}</button>
                      {saved && saved.mine && edited && !flags.autosave && (
                        <button type="button" className="gp-fb" onClick={() => saveSettingsNow(settingsNow)} disabled={saveViewMut.isPending}>
                          Save to this view
                        </button>
                      )}
                    </>
                  )}
                </span>
                <span className="gp-tool-r">
                  <RunningTimer orgId={currentOrgId} onOpen={setTaskId} />
                  {view !== "workload" && <input ref={searchRef} className="gp-srch" placeholder="Search tasks  /" aria-label="Search tasks" value={q} onChange={(e) => patchSettings({ q: e.target.value || undefined })} onKeyDown={(e) => e.key === "Escape" && (e.target as HTMLInputElement).blur()} />}
                  {!guest && <button type="button" className={`gp-fb ${panel === "customize" ? "sel" : ""}`} aria-pressed={panel === "customize"} onClick={() => setPanel(panel === "customize" ? "" : "customize")}>Customize</button>}
                  {ctx && (level === "edit" || level === "full" || where.scope !== "list") && <NewTask c={ctx} guest={guest} open={adding} setOpen={setAdding} onTemplate={() => setPanel("fromTemplate")} />}
                </span>
              </div>
            )}
            <div className={`gp-canvas ${beside ? "with-task" : ""} ${panel === "customize" && isList ? "with-custom" : ""}`}>
              <ErrorLine error={v.error || tree.error || views.error} />
              {where.scope === "import" ? (
                <ImportPage orgId={currentOrgId} onDone={() => { void refresh(); setWhere({ scope: "everything" }); }} />
              ) : overview && folderId ? (
                <FolderOverview orgId={currentOrgId} folderId={folderId} onPick={pick} onOpenTask={setTaskId} onNewList={() => setAsk({ kind: "list", n: Date.now(), folderId })} onNewDoc={() => { setEditView(null); setPanel("addView"); }} />
              ) : !ctx ? (
                <p className="ld-muted" style={{ padding: 20 }}>{v.isLoading ? "Loading tasks" : ""}</p>
              ) : (
                <div className="gp-view">
                  {ctx.data.lists.length === 0 && where.scope !== "list" ? (
                    guest ? (
                      <div className="gp-gl gp-empty">Nothing is shared with you here yet.</div>
                    ) : folderId ? (
                      <div className="gp-gl gp-empty-start">
                        <b style={{ fontSize: 16 }}>No lists in this folder yet</b>
                        <span className="ld-row"><button type="button" className="ld-btn p" onClick={() => setAsk({ kind: "list", n: Date.now(), folderId })}>+ New list</button></span>
                      </div>
                    ) : (
                      <Empty onImport={() => setWhere({ scope: "import" })} onFolder={() => setAsk({ kind: "folder", n: Date.now() })} onTask={() => setAdding(true)} />
                    )
                  ) : (
                    <>
                      <MyWorkPhone c={ctx} show={where.scope === "mine"} />
                      <div className={where.scope === "mine" ? "gp-hide-phone" : ""}>
                        {view === "list" && <ListView c={ctx} />}
                        {view === "board" && <BoardView c={ctx} />}
                        {view === "calendar" && <CalendarView c={ctx} />}
                        {view === "gantt" && <GanttView c={ctx} />}
                        {view === "table" && <TableView c={ctx} />}
                        {view === "workload" && <WorkloadView c={ctx} />}
                        {view === "timeline" && <TimelineView c={ctx} />}
                        {view === "mindmap" && <MindMapView c={ctx} />}
                      </div>
                    </>
                  )}
                </div>
              )}
              {beside && taskId && <TaskModal mode="panel" orgId={currentOrgId} id={taskId} onClose={() => { setTaskId(null); void refresh(); }} onOpen={openTask} onFull={() => setTaskFull(true)} onEditFields={ctx?.data.list ? () => { setTaskId(null); setPanel("settings"); } : undefined} onSaveTemplate={guest ? undefined : (id) => setSaveTask(id)} />}
              {panel === "customize" && isList && ctx && (
                <Customize
                  c={ctx}
                  view={view}
                  saved={saved}
                  views={views.data}
                  listName={where.scope === "everything" ? "Everything" : title}
                  settings={{ ...settingsNow, closed }}
                  patch={patchSettings}
                  flags={flags}
                  onFlag={(p) => setFlags.mutate({ organizationId: currentOrgId, ...target, kind: view, savedId: cur.savedId, ...p })}
                  onAutosave={(on) => { setAutosave.mutate({ organizationId: currentOrgId, ...target, kind: view, savedId: cur.savedId, on }); if (on && edited) saveSettingsNow(settingsNow); }}
                  onStar={(on) => starView.mutate({ organizationId: currentOrgId, ...target, kind: view, savedId: cur.savedId, on })}
                  onCopyLink={() => void navigator.clipboard?.writeText(window.location.href)}
                  onExport={(format) => { const ex = exportRows(ctx, ctx.columns, view === "table" || view === "list" ? sortTasksForExport(ctx) : ctx.tasks); exporter.run(`${title || "Tasks"} ${saved ? saved.name : view}`, format, ex.headers, ex.rows); }}
                  onShare={() => setPanel("share")}
                  onTemplates={() => pick({ scope: "templates" })}
                  onSaveTemplate={() => setPanel("saveList")}
                  onSaveAs={() => { if (saved) { setEditView(saved); setPanel("addView"); } }}
                  onSaveNow={() => saveSettingsNow(settingsNow)}
                  canChange={!lockedView && (saved ? saved.mine : level === "edit" || level === "full")}
                  canShare={level === "edit" || level === "full"}
                  isList={where.scope === "list"}
                  onClose={() => setPanel("")}
                  busy={exporter.busy || setFlags.isPending || saveViewMut.isPending || setBuiltin.isPending}
                  error={exporter.error || setFlags.error || setAutosave.error || starView.error || saveViewMut.error || setBuiltin.error}
                />
              )}
            </div>
          </>
        ) : where.scope === "docs" ? (
          <DocsHub orgId={currentOrgId} onPick={pick} refresh={refresh} start={where.tab} />
        ) : where.scope === "doc" ? (
          <DocPage orgId={currentOrgId} id={where.id} onPick={pick} onOpenTask={setTaskId} refresh={refresh} />
        ) : where.scope === "board" ? (
          <BoardPage orgId={currentOrgId} id={where.id} onPick={pick} onOpenTask={setTaskId} refresh={refresh} />
        ) : where.scope === "form" ? (
          <FormPage orgId={currentOrgId} id={where.id} onPick={pick} onOpenTask={setTaskId} refresh={refresh} />
        ) : where.scope === "dash" ? (
          <DashboardsPage orgId={currentOrgId} id={where.id} onPick={pick} onOpenTask={setTaskId} />
        ) : where.scope === "time" ? (
          <TimesheetPage orgId={currentOrgId} onOpenTask={setTaskId} />
        ) : where.scope === "portfolios" ? (
          <PortfoliosPage orgId={currentOrgId} onPick={pick} />
        ) : where.scope === "portfolio" ? (
          <PortfolioPage orgId={currentOrgId} id={where.id} onPick={pick} onOpenTask={(id) => { setTaskId(id); setTaskFull(true); }} />
        ) : where.scope === "sidebar" ? (
          <SidebarPage orgId={currentOrgId} onDone={() => pick({ scope: "home" })} />
        ) : (
          <TemplatesPage orgId={currentOrgId} onPick={pick} onOpenTask={setTaskId} refresh={refresh} />
        )}
      </main>
      {taskId && !beside && <TaskModal orgId={currentOrgId} id={taskId} onClose={() => { setTaskId(null); setTaskFull(false); void refresh(); }} onOpen={setTaskId} onEditFields={ctx?.data.list ? () => { setTaskId(null); setPanel("settings"); } : undefined} onSaveTemplate={guest ? undefined : (id) => setSaveTask(id)} />}
      {ctx && selected.size > 0 && <BulkBar c={ctx} />}
      {panel === "automations" && ctx && <Automations c={ctx} onClose={() => setPanel("")} />}
      {panel === "settings" && ctx?.data.list && <ListSettings c={ctx} onClose={() => setPanel("")} onRemoved={() => { setPanel(""); setWhere({ scope: "everything" }); void refresh(); }} />}
      {panel === "share" && ctx?.data.list && <ShareList orgId={currentOrgId} listId={ctx.data.list.id} name={ctx.data.list.name} canChange={full} onClose={() => { setPanel(""); void refresh(); }} />}
      {panel === "saveList" && ctx?.data.list && <SaveTemplate orgId={currentOrgId} kind="list" sourceId={ctx.data.list.id} name={ctx.data.list.name} onClose={() => setPanel("")} />}
      {panel === "fromTemplate" && ctx && <UseTaskTemplate orgId={currentOrgId} listId={ctx.listId ?? ctx.data.lists[0]?.id ?? null} lists={ctx.data.lists} onClose={() => setPanel("")} onMade={(id) => { setPanel(""); void refresh(); setTaskId(id); }} />}
      {saveTask && <SaveTemplate orgId={currentOrgId} kind="task" sourceId={saveTask} name="" onClose={() => setSaveTask(null)} />}
      {statusFor && <StatusUpdate orgId={currentOrgId} kind="list" itemId={statusFor} name={data?.list?.name ?? ""} onClose={() => { setStatusFor(null); void refresh(); }} />}
      {!guest && <BottomNav active="projects" />}
    </div>
  );
}

/** The rows in the order the list shows them, for Export view. */
function sortTasksForExport(c: PjCtx) {
  return groupsOf(c).flatMap((g) => g.tasks).filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i);
}

const fmtArchived = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

/** A guest sees one workspace's shared lists and nothing else. */
function GuestBar({ name }: { name: string }) {
  const out = trpc.auth.logout.useMutation({ onSuccess: () => { window.location.href = "/signin"; } });
  return (
    <div className="gp-guestbar">
      <span>
        <b>{name}</b> <span className="ld-small ld-muted">· Shared with you</span>
      </span>
      <button type="button" className="ld-btn sm" onClick={() => out.mutate()}>Sign out</button>
    </div>
  );
}

function Empty({ onImport, onFolder, onTask }: { onImport: () => void; onFolder: () => void; onTask: () => void }) {
  return (
    <div className="gp-gl gp-empty-start">
      <b style={{ fontSize: 16 }}>Start your first project</b>
      <span className="ld-small ld-muted">Folders hold lists, and lists hold tasks.</span>
      <span className="ld-row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="ld-btn p" onClick={onFolder}>+ New folder</button>
        <button type="button" className="ld-btn" onClick={onTask}>+ Task</button>
        <button type="button" className="ld-btn gp-auto" onClick={onImport}>Import from ClickUp</button>
      </span>
    </div>
  );
}

/** + Task: opens a name box (and a list picker when not in a list). With no lists yet, the task goes in a new "Tasks" list. */
function NewTask({ c, guest, open, setOpen, onTemplate }: { c: PjCtx; guest: boolean; open: boolean; setOpen: (v: boolean) => void; onTemplate: () => void }) {
  const [name, setName] = React.useState("");
  const [list, setList] = React.useState<number | "">(c.listId ?? "");
  const create = trpc.pj.create.useMutation({
    onSuccess: async (t) => {
      setName("");
      setOpen(false);
      await c.refresh();
      c.open(t.id);
    },
  });
  const makeList = trpc.pj.saveList.useMutation();
  const editable = c.data.lists.filter((l) => l.level === "edit" || l.level === "full");
  const none = !editable.length;
  React.useEffect(() => {
    setList(c.listId ?? editable[0]?.id ?? "");
  }, [c.listId, c.data.lists]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    if (!name.trim()) return;
    let id = list ? Number(list) : 0;
    if (!id && none && !guest) id = (await makeList.mutateAsync({ organizationId: c.orgId, name: "Tasks", folderId: c.data.folder?.id ?? null }))?.id ?? 0;
    if (id) create.mutate({ organizationId: c.orgId, listId: id, name });
  };
  if (!open)
    return guest ? (
      <button type="button" className="ld-btn p gp-auto" onClick={() => setOpen(true)} disabled={none}>+ Task</button>
    ) : (
      <span className="gp-split">
        <button type="button" className="ld-btn p gp-auto" onClick={() => setOpen(true)}>+ Task</button>
        <Menu label="More ways to add a task" button="▾">
          {(close) => (
            <>
              <button type="button" role="menuitem" onClick={() => { setOpen(true); close(); }}>A new task</button>
              <button type="button" role="menuitem" onClick={() => { onTemplate(); close(); }}>From a template</button>
            </>
          )}
        </Menu>
      </span>
    );
  return (
    <span className="ld-row">
      {!c.listId && !none && (
        <select className="ld-in xs" style={{ width: 160 }} aria-label="List" value={list} onChange={(e) => setList(Number(e.target.value))}>
          {editable.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      )}
      <input className="ld-in xs" style={{ width: 220 }} autoFocus aria-label="New task" placeholder="Task name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
      <button type="button" className="ld-btn sm" onClick={() => setOpen(false)}>Cancel</button>
      <button type="button" className="ld-btn p sm" disabled={!name.trim() || create.isPending || makeList.isPending} onClick={() => void add()}>Add</button>
      <ErrorLine error={create.error || makeList.error} />
    </span>
  );
}
