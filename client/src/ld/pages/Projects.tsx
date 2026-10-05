import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BottomNav, ErrorLine, Rail } from "../ui";
import { Menu, ViewTabs } from "../goals/shared";
import type { Outputs } from "../types";
import { Tree } from "../projects/Tree";
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

/**
 * Projects, in place of ClickUp: this workspace's folders with their lists,
 * docs, whiteboards and forms on the left, plus Dashboards, Timesheets and
 * Templates; a list's tasks as a List, Board, Calendar, Gantt, Table,
 * Workload, Timeline or Mind map. A task opens over the page. People and
 * employees are both assignees. A guest sees only the lists shared with them.
 */

export type ViewOut = Outputs["pj"]["view"];
export type TaskRow = ViewOut["tasks"][number];
type View = "list" | "board" | "calendar" | "gantt" | "table" | "workload" | "timeline" | "mindmap";
const VIEWS: { key: View; label: string }[] = [
  { key: "list", label: "List" },
  { key: "board", label: "Board" },
  { key: "calendar", label: "Calendar" },
  { key: "gantt", label: "Gantt" },
  { key: "table", label: "Table" },
  { key: "workload", label: "Workload" },
  { key: "timeline", label: "Timeline" },
  { key: "mindmap", label: "Mind map" },
];

export type Where =
  | { scope: "list"; listId: number }
  | { scope: "everything" }
  | { scope: "mine" }
  | { scope: "import" }
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
};

const PAGES = ["doc", "board", "form", "dash", "time", "templates"] as const;
function readUrl(): { where: Where; view: View; task: number | null } {
  const p = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const list = Number(p.get("list"));
  const view = (VIEWS.some((v) => v.key === p.get("view")) ? p.get("view") : "list") as View;
  const page = p.get("page") as (typeof PAGES)[number] | null;
  const id = Number(p.get("id")) || undefined;
  const where: Where = p.get("import")
    ? { scope: "import" }
    : page === "doc" || page === "board" || page === "form"
      ? { scope: page, id: id ?? 0 }
      : page === "dash"
        ? { scope: "dash", id }
        : page === "time" || page === "templates"
          ? { scope: page }
          : list
            ? { scope: "list", listId: list }
            : p.get("scope") === "mine"
              ? { scope: "mine" }
              : { scope: "everything" };
  return { where, view, task: Number(p.get("task")) || null };
}

export default function Projects() {
  const { currentOrgId, currentOrg } = useTenant();
  const [, go] = useLocation();
  const utils = trpc.useUtils();
  const first = React.useMemo(readUrl, []);
  const [where, setWhere] = React.useState<Where>(first.where);
  const [view, setView] = React.useState<View>(first.view);
  const [taskId, setTaskId] = React.useState<number | null>(first.task);
  const [group, setGroup] = React.useState<PjCtx["group"]>("status");
  const [who, setWho] = React.useState("");
  const [priority, setPriority] = React.useState("");
  const [me, setMe] = React.useState(false);
  const [closed, setClosed] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [panel, setPanel] = React.useState<"" | "automations" | "settings" | "share" | "saveList" | "fromTemplate">("");
  const [saveTask, setSaveTask] = React.useState<number | null>(null);
  const guest = !!(currentOrg as { guest?: boolean } | null)?.guest;
  const tree = trpc.pj.tree.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const isList = where.scope === "list" || where.scope === "everything" || where.scope === "mine";
  const v = trpc.pj.view.useQuery(
    { organizationId: currentOrgId, listId: where.scope === "list" ? where.listId : null, scope: where.scope === "list" ? "list" : where.scope === "mine" ? "mine" : "everything", closed },
    { enabled: currentOrgId > 0 && isList, refetchInterval: 20_000 }
  );
  React.useEffect(() => {
    const p = new URLSearchParams();
    if (where.scope === "list") p.set("list", String(where.listId));
    if (where.scope === "mine") p.set("scope", "mine");
    if (where.scope === "import") p.set("import", "1");
    if ((PAGES as readonly string[]).includes(where.scope)) {
      p.set("page", where.scope);
      if ("id" in where && where.id) p.set("id", String(where.id));
    }
    if (isList && view !== "list") p.set("view", view);
    if (taskId) p.set("task", String(taskId));
    const s = p.toString();
    go(`/projects${s ? `?${s}` : ""}`, { replace: true });
  }, [where, view, taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A guest starts on the first list shared with them.
  React.useEffect(() => {
    if (!guest || !tree.data || where.scope === "list") return;
    const firstList = tree.data.folders.flatMap((f) => f.lists)[0] ?? tree.data.loose[0];
    if (firstList) setWhere({ scope: "list", listId: firstList.id });
  }, [guest, tree.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => Promise.all([utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.task.invalidate(), utils.pj.me.invalidate()]);
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
  const level = data?.list?.level ?? (guest ? "view" : "edit");
  const ctx: PjCtx | null = data ? { orgId: currentOrgId, data, tasks, open: setTaskId, refresh, group, listId: where.scope === "list" ? where.listId : null, level } : null;
  const title = where.scope === "list" ? data?.list?.name ?? "" : where.scope === "mine" ? "My work" : where.scope === "import" ? "Move from ClickUp" : "Everything";
  const crumb = where.scope === "list" && data?.list?.folderName ? `${data.list.folderName} /` : "";
  const assignees = Array.from(new Map((data?.tasks ?? []).flatMap((t) => t.assignees).map((a) => [`${a.type}:${a.id}:${a.name}`, a])).values());
  const pick = (w: Where) => {
    setWhere(w);
    setTaskId(null);
  };
  const full = level === "full";
  const views = guest ? VIEWS.filter((x) => x.key !== "workload") : VIEWS;
  return (
    <div className={`ld ${guest ? "ld-guest" : ""}`}>
      {!guest && <Rail active="projects" />}
      <Tree orgId={currentOrgId} tree={tree.data} where={where} onPick={pick} refresh={refresh} />
      <main className="gp-main">
        {guest && <GuestBar name={currentOrg?.name ?? ""} />}
        {isList || where.scope === "import" ? (
          <>
            <div className="gp-head">
              <div className="gp-hrow">
                <span className="gp-ttl" style={{ fontSize: 18 }}>
                  {crumb && <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>{crumb}</span>}
                  {title}
                  {data?.list?.private && <span className="gp-chip" title="Only the people it's shared with see it">🔒 Private</span>}
                </span>
                {isList && (
                  <span className="ld-row">
                    {where.scope === "list" && !guest && <button type="button" className="ld-btn" onClick={() => setPanel("share")}>Share</button>}
                    {where.scope === "list" && full && <button type="button" className="ld-btn" onClick={() => setPanel("settings")}>Edit list</button>}
                    {!guest && (where.scope !== "list" || full) && <button type="button" className="ld-btn" onClick={() => setPanel("automations")}>Automations</button>}
                    {where.scope === "list" && !guest && (
                      <Menu label="List options">
                        {(close) => (
                          <button type="button" role="menuitem" onClick={() => { setPanel("saveList"); close(); }}>Save as a template</button>
                        )}
                      </Menu>
                    )}
                  </span>
                )}
              </div>
              {isList && <ViewTabs views={views} value={view} onChange={setView} />}
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
                    </>
                  )}
                </span>
                <span className="gp-tool-r">
                  <RunningTimer orgId={currentOrgId} onOpen={setTaskId} />
                  {view !== "workload" && <input className="gp-srch" placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />}
                  {ctx && (level === "edit" || level === "full" || where.scope !== "list") && <NewTask c={ctx} guest={guest} onTemplate={() => setPanel("fromTemplate")} />}
                </span>
              </div>
            )}
            <div className="gp-canvas">
              <ErrorLine error={v.error || tree.error} />
              {where.scope === "import" ? (
                <ImportPage orgId={currentOrgId} onDone={() => { void refresh(); setWhere({ scope: "everything" }); }} />
              ) : !ctx ? (
                <p className="ld-muted" style={{ padding: 20 }}>{v.isLoading ? "Loading tasks" : ""}</p>
              ) : (
                <div className="gp-view">
                  {ctx.data.lists.length === 0 && where.scope !== "list" ? (
                    guest ? <div className="gp-gl gp-empty">Nothing is shared with you here yet.</div> : <Empty onImport={() => setWhere({ scope: "import" })} />
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

function Empty({ onImport }: { onImport: () => void }) {
  return (
    <div className="gp-gl" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <b style={{ fontSize: 16 }}>No lists yet</b>
      <span className="ld-small ld-muted">Make a folder and a list on the left, or bring everything over from ClickUp.</span>
      <span className="ld-row">
        <button type="button" className="ld-btn p" onClick={onImport}>Move from ClickUp</button>
        <Link href="/tasks" className="ld-btn">Nora's launches</Link>
      </span>
    </div>
  );
}

function NewTask({ c, guest, onTemplate }: { c: PjCtx; guest: boolean; onTemplate: () => void }) {
  const [open, setOpen] = React.useState(false);
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
  const editable = c.data.lists.filter((l) => l.level === "edit" || l.level === "full");
  React.useEffect(() => setList(c.listId ?? editable[0]?.id ?? ""), [c.listId, c.data.lists]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open)
    return guest ? (
      <button type="button" className="ld-btn p gp-auto" onClick={() => setOpen(true)} disabled={!editable.length}>+ Task</button>
    ) : (
      <span className="gp-split">
        <button type="button" className="ld-btn p gp-auto" onClick={() => setOpen(true)} disabled={!editable.length}>+ Task</button>
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
      {!c.listId && (
        <select className="ld-in xs" style={{ width: 160 }} aria-label="List" value={list} onChange={(e) => setList(Number(e.target.value))}>
          {editable.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      )}
      <input className="ld-in xs" style={{ width: 220 }} autoFocus aria-label="New task" placeholder="Task name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && list && create.mutate({ organizationId: c.orgId, listId: Number(list), name })} />
      <button type="button" className="ld-btn sm" onClick={() => setOpen(false)}>Cancel</button>
      <button type="button" className="ld-btn p sm" disabled={!name.trim() || !list || create.isPending} onClick={() => create.mutate({ organizationId: c.orgId, listId: Number(list), name })}>Add</button>
    </span>
  );
}
