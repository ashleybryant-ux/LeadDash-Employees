import React from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BottomNav, ErrorLine, Rail } from "../ui";
import { Menu } from "../goals/shared";
import type { Outputs } from "../types";
import { Tree, type Ask } from "../projects/Tree";
import { ListView, TableView } from "../projects/ListView";
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
import { AddView, KINDS, ViewTabsPlus, type Current, type SavedView, type ViewKind, type ViewSettings } from "../projects/Views";
import { DEFAULT_COLUMNS, type ColKey } from "../projects/Columns";
import { FolderOverview } from "../projects/Overview";
import { DocsHub } from "../projects/DocsHub";

/**
 * Projects, in place of ClickUp: this workspace's folders with their lists,
 * docs, whiteboards and forms on the left, plus Docs, Dashboards, Timesheets
 * and Templates; a list's (or a folder's) tasks as a List, Board, Calendar,
 * Gantt, Table, Workload, Timeline or Mind map, with saved views of any kind.
 * A task opens over the page; its values change with one click. People and
 * employees are both assignees. A guest sees only the lists shared with them.
 */

export type ViewOut = Outputs["pj"]["view"];
export type TaskRow = ViewOut["tasks"][number];
type View = ViewKind;
const VIEW_KEYS = KINDS.map((k) => k.key);

export type Where =
  | { scope: "list"; listId: number }
  | { scope: "folder"; folderId: number; tab?: "overview" }
  | { scope: "everything" }
  | { scope: "mine" }
  | { scope: "import" }
  | { scope: "docs" }
  | { scope: "doc"; id: number }
  | { scope: "board"; id: number }
  | { scope: "form"; id: number }
  | { scope: "dash"; id?: number }
  | { scope: "time" }
  | { scope: "templates" };
export type PjCtx = {
  orgId: number;
  data: ViewOut;
  tasks: TaskRow[];
  open: (id: number) => void;
  refresh: () => Promise<unknown>;
  group: "status" | "priority" | "assignee" | "none";
  listId: number | null;
  /** What I can do here: view, comment, edit or full. */
  level: "view" | "comment" | "edit" | "full";
  /** Columns shown on the List and Table views, and how to change them. */
  columns: ColKey[];
  setColumns: (cols: ColKey[]) => void;
};

const PAGES = ["doc", "board", "form", "dash", "time", "templates", "docs"] as const;
function readUrl(): { where: Where; view: View; savedId: number | null; task: number | null } {
  const p = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const list = Number(p.get("list"));
  const folder = Number(p.get("folder"));
  const view = (VIEW_KEYS.includes(p.get("view") as View) ? p.get("view") : "list") as View;
  const page = p.get("page") as (typeof PAGES)[number] | null;
  const id = Number(p.get("id")) || undefined;
  const where: Where = p.get("import")
    ? { scope: "import" }
    : page === "doc" || page === "board" || page === "form"
      ? { scope: page, id: id ?? 0 }
      : page === "dash"
        ? { scope: "dash", id }
        : page === "time" || page === "templates" || page === "docs"
          ? { scope: page }
          : list
            ? { scope: "list", listId: list }
            : folder
              ? { scope: "folder", folderId: folder, tab: p.get("tab") === "overview" || !p.get("view") ? "overview" : undefined }
              : p.get("scope") === "mine"
                ? { scope: "mine" }
                : { scope: "everything" };
  return { where, view, savedId: Number(p.get("saved")) || null, task: Number(p.get("task")) || null };
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
  const [who, setWho] = React.useState("");
  const [priority, setPriority] = React.useState("");
  const [me, setMe] = React.useState(false);
  const [closed, setClosed] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [columnsLocal, setColumnsLocal] = React.useState<ColKey[] | null>(null);
  const [panel, setPanel] = React.useState<"" | "automations" | "settings" | "share" | "saveList" | "fromTemplate" | "addView">("");
  const [editView, setEditView] = React.useState<SavedView | null>(null);
  const [saveTask, setSaveTask] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [ask, setAsk] = React.useState<Ask>(null);
  const [drawer, setDrawer] = React.useState(false);
  const guest = !!(currentOrg as { guest?: boolean } | null)?.guest;
  const tree = trpc.pj.tree.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
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
  const removeView = trpc.pj.removeView.useMutation({ onSuccess: () => { void utils.pj.views.invalidate(); setCur((c) => ({ kind: c.kind, savedId: null })); } });
  const saveViewMut = trpc.pj.saveView.useMutation({ onSuccess: () => utils.pj.views.invalidate() });
  React.useEffect(() => {
    const p = new URLSearchParams();
    if (where.scope === "list") p.set("list", String(where.listId));
    if (where.scope === "folder") {
      p.set("folder", String(where.folderId));
      if (where.tab === "overview") p.set("tab", "overview");
    }
    if (where.scope === "mine") p.set("scope", "mine");
    if (where.scope === "import") p.set("import", "1");
    if ((PAGES as readonly string[]).includes(where.scope)) {
      p.set("page", where.scope);
      if ("id" in where && where.id) p.set("id", String(where.id));
    }
    if (isList && (view !== "list" || cur.savedId)) p.set("view", view);
    if (isList && cur.savedId) p.set("saved", String(cur.savedId));
    if (taskId) p.set("task", String(taskId));
    const s = p.toString();
    go(`/projects${s ? `?${s}` : ""}`, { replace: true });
  }, [where, cur, taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A guest starts on the first list shared with them.
  React.useEffect(() => {
    if (!guest || !tree.data || where.scope === "list") return;
    const firstList = tree.data.folders.flatMap((f) => f.lists)[0] ?? tree.data.loose[0];
    if (firstList) setWhere({ scope: "list", listId: firstList.id });
  }, [guest, tree.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opening a view loads its filters, grouping and columns.
  const saved = cur.savedId ? views.data?.saved.find((s) => s.id === cur.savedId) ?? null : null;
  React.useEffect(() => {
    const s: ViewSettings | undefined = saved ? saved.settings : views.data?.builtin[view];
    setGroup(s?.group ?? "status");
    setWho(s?.who ?? "");
    setPriority(s?.priority ?? "");
    setClosed(!!s?.closed);
    setQ(s?.q ?? "");
    setColumnsLocal(null);
  }, [cur.savedId, cur.kind, where.scope, target.listId, target.folderId, views.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => Promise.all([utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.task.invalidate(), utils.pj.me.invalidate(), utils.pj.views.invalidate(), utils.pj.overview.invalidate()]);
  const data = v.data;
  const tasks = React.useMemo(() => {
    if (!data) return [];
    const words = q.trim().toLowerCase();
    return data.tasks.filter(
      (t) =>
        (!words || t.name.toLowerCase().includes(words)) &&
        (!who || t.assignees.some((a) => `${a.type}:${a.id}:${a.name}` === who)) &&
        (!priority || (t.priority ?? "none") === priority) &&
        (!me || t.assignees.some((a) => a.type === "user" && data.people.some((p) => p.type === "user" && p.id === a.id && p.name === a.name)))
    );
  }, [data, q, who, priority, me]);
  const level = data?.list?.level ?? data?.folder?.level ?? (guest ? "view" : "edit");
  const columns: ColKey[] = columnsLocal ?? (saved ? saved.settings.columns : views.data?.builtin[view]?.columns) ?? DEFAULT_COLUMNS[view === "table" ? "table" : "list"];
  const settingsNow: ViewSettings = { group, who: who || undefined, priority: priority || undefined, closed: closed || undefined, q: q || undefined, columns };
  const setColumns = (cols: ColKey[]) => {
    setColumnsLocal(cols);
    if (guest) return;
    if (saved) saveViewMut.mutate({ organizationId: currentOrgId, id: saved.id, ...target, name: saved.name, kind: saved.kind, settings: { ...saved.settings, columns: cols }, private: saved.private, pinned: saved.pinned });
    else if (level === "edit" || level === "full") setBuiltin.mutate({ organizationId: currentOrgId, ...target, kind: view, settings: { ...(views.data?.builtin[view] ?? {}), columns: cols } });
  };
  const ctx: PjCtx | null = data ? { orgId: currentOrgId, data, tasks, open: setTaskId, refresh, group, listId: where.scope === "list" ? where.listId : null, level, columns, setColumns } : null;
  const folderRow = folderId ? tree.data?.folders.find((f) => f.id === folderId) : null;
  const title = where.scope === "list" ? data?.list?.name ?? "" : where.scope === "mine" ? "My tasks" : where.scope === "import" ? "Import from ClickUp" : isFolder ? folderRow?.name ?? data?.folder?.name ?? "" : "Everything";
  const crumb = where.scope === "list" && data?.list?.folderName ? `${data.list.folderName} /` : isFolder ? `${currentOrg?.name ?? ""} /` : "";
  const assignees = Array.from(new Map((data?.tasks ?? []).flatMap((t) => t.assignees).map((a) => [`${a.type}:${a.id}:${a.name}`, a])).values());
  const pick = (w: Where) => {
    setWhere(w);
    setTaskId(null);
    if (w.scope !== "list" && w.scope !== "folder") setCur({ kind: "list", savedId: null });
    else if (cur.savedId) setCur({ kind: cur.kind, savedId: null });
  };
  const full = level === "full";
  const kinds = (guest ? VIEW_KEYS.filter((x) => x !== "workload") : VIEW_KEYS) as ViewKind[];
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
  const headerButtons = (
    <span className="ld-row">
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
        refresh={refresh}
        ask={ask}
        drawer={drawer}
        onCloseDrawer={() => setDrawer(false)}
        onNewTask={() => {
          if (!isList) pick({ scope: "everything" });
          setAdding(true);
        }}
      />
      <main className="gp-main">
        {guest && <GuestBar name={currentOrg?.name ?? ""} />}
        {isList || where.scope === "import" || overview ? (
          <>
            <div className="gp-head">
              <div className="gp-hrow">
                <span className="gp-ttl" style={{ fontSize: 18 }}>
                  <button type="button" className="ld-btn sm gp-auto gp-show-sm" onClick={() => setDrawer(true)} aria-label="Folders and lists">☰</button>
                  {crumb && <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>{crumb}</span>}
                  {folderRow && <span style={{ background: folderRow.color, width: 12, height: 12, borderRadius: 3, display: "inline-block", flexShrink: 0 }} />}
                  {title}
                  {data?.list?.private && <span className="gp-chip" title="Only the people it's shared with see it">🔒 Private</span>}
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
                      onClose={() => setPanel("")}
                      onMade={(c) => { setPanel(""); void utils.pj.views.invalidate(); if (folderId && overview) setWhere({ scope: "folder", folderId }); setCur(c); }}
                      onItem={makeItem}
                    />
                  )}
                </div>
              )}
            </div>
            {isList && (
              <div className="gp-tool">
                <span className="gp-tool-l">
                  {view === "list" && (
                    <select className="gp-fb sel" aria-label="Group" value={group} onChange={(e) => setGroup(e.target.value as PjCtx["group"])}>
                      <option value="status">Group: Status</option>
                      <option value="priority">Group: Priority</option>
                      <option value="assignee">Group: Assignee</option>
                      <option value="none">Group: None</option>
                    </select>
                  )}
                  {view !== "workload" && (
                    <>
                      <select className="gp-fb" aria-label="Assignee" value={who} onChange={(e) => setWho(e.target.value)}>
                        <option value="">Assignee: anyone</option>
                        {assignees.map((a) => (
                          <option key={`${a.type}:${a.id}:${a.name}`} value={`${a.type}:${a.id}:${a.name}`}>{a.name}</option>
                        ))}
                      </select>
                      <select className="gp-fb" aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                        <option value="">Priority: any</option>
                        <option value="urgent">Urgent</option>
                        <option value="high">High</option>
                        <option value="normal">Normal</option>
                        <option value="low">Low</option>
                        <option value="none">No priority</option>
                      </select>
                      <button type="button" className={`gp-fb ${closed ? "sel" : ""}`} aria-pressed={closed} onClick={() => setClosed(!closed)}>{closed ? "Showing all done" : "Show all done"}</button>
                      {!guest && <button type="button" className={`gp-fb ${me ? "sel" : ""}`} aria-pressed={me} onClick={() => setMe(!me)}>Me mode</button>}
                      {saved && saved.mine && (
                        <button type="button" className="gp-fb" onClick={() => saveViewMut.mutate({ organizationId: currentOrgId, id: saved.id, ...target, name: saved.name, kind: saved.kind, settings: settingsNow, private: saved.private, pinned: saved.pinned })} disabled={saveViewMut.isPending}>
                          Save to this view
                        </button>
                      )}
                    </>
                  )}
                </span>
                <span className="gp-tool-r">
                  <RunningTimer orgId={currentOrgId} onOpen={setTaskId} />
                  {view !== "workload" && <input className="gp-srch" placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />}
                  {ctx && (level === "edit" || level === "full" || where.scope !== "list") && <NewTask c={ctx} guest={guest} open={adding} setOpen={setAdding} onTemplate={() => setPanel("fromTemplate")} />}
                </span>
              </div>
            )}
            <div className="gp-canvas">
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
            </div>
          </>
        ) : where.scope === "docs" ? (
          <DocsHub orgId={currentOrgId} onPick={pick} refresh={refresh} />
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
        ) : (
          <TemplatesPage orgId={currentOrgId} onPick={pick} onOpenTask={setTaskId} refresh={refresh} />
        )}
      </main>
      {taskId && <TaskModal orgId={currentOrgId} id={taskId} onClose={() => { setTaskId(null); void refresh(); }} onOpen={setTaskId} onEditFields={ctx?.data.list ? () => { setTaskId(null); setPanel("settings"); } : undefined} onSaveTemplate={guest ? undefined : (id) => setSaveTask(id)} />}
      {panel === "automations" && ctx && <Automations c={ctx} onClose={() => setPanel("")} />}
      {panel === "settings" && ctx?.data.list && <ListSettings c={ctx} onClose={() => setPanel("")} onRemoved={() => { setPanel(""); setWhere({ scope: "everything" }); void refresh(); }} />}
      {panel === "share" && ctx?.data.list && <ShareList orgId={currentOrgId} listId={ctx.data.list.id} name={ctx.data.list.name} canChange={full} onClose={() => { setPanel(""); void refresh(); }} />}
      {panel === "saveList" && ctx?.data.list && <SaveTemplate orgId={currentOrgId} kind="list" sourceId={ctx.data.list.id} name={ctx.data.list.name} onClose={() => setPanel("")} />}
      {panel === "fromTemplate" && ctx && <UseTaskTemplate orgId={currentOrgId} listId={ctx.listId ?? ctx.data.lists[0]?.id ?? null} lists={ctx.data.lists} onClose={() => setPanel("")} onMade={(id) => { setPanel(""); void refresh(); setTaskId(id); }} />}
      {saveTask && <SaveTemplate orgId={currentOrgId} kind="task" sourceId={saveTask} name="" onClose={() => setSaveTask(null)} />}
      {!guest && <BottomNav active="projects" />}
    </div>
  );
}

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
