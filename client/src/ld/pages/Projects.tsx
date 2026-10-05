import React from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { BottomNav, ErrorLine, Rail } from "../ui";
import { ViewTabs } from "../goals/shared";
import type { Outputs } from "../types";
import { Tree } from "../projects/Tree";
import { ListView, TableView } from "../projects/ListView";
import { BoardView } from "../projects/BoardView";
import { CalendarView, GanttView } from "../projects/TimeViews";
import { TaskModal } from "../projects/TaskModal";
import { Automations } from "../projects/Automations";
import { ImportPage } from "../projects/ImportPage";
import { ListSettings } from "../projects/ListSettings";

/**
 * Projects, in place of ClickUp: this workspace's folders and lists on the
 * left, and the list's tasks as a List, Board, Calendar, Gantt or Table.
 * A task opens over the page. People and employees are both assignees.
 */

export type ViewOut = Outputs["pj"]["view"];
export type TaskRow = ViewOut["tasks"][number];
type View = "list" | "board" | "calendar" | "gantt" | "table";
const VIEWS: { key: View; label: string }[] = [
  { key: "list", label: "List" },
  { key: "board", label: "Board" },
  { key: "calendar", label: "Calendar" },
  { key: "gantt", label: "Gantt" },
  { key: "table", label: "Table" },
];

export type Where = { scope: "list"; listId: number } | { scope: "everything" } | { scope: "mine" } | { scope: "import" };
export type PjCtx = {
  orgId: number;
  data: ViewOut;
  tasks: TaskRow[];
  open: (id: number) => void;
  refresh: () => Promise<unknown>;
  group: "status" | "priority" | "assignee" | "none";
  listId: number | null;
};

function readUrl(): { where: Where; view: View; task: number | null } {
  const p = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const list = Number(p.get("list"));
  const view = (VIEWS.some((v) => v.key === p.get("view")) ? p.get("view") : "list") as View;
  const where: Where = p.get("import") ? { scope: "import" } : list ? { scope: "list", listId: list } : p.get("scope") === "mine" ? { scope: "mine" } : { scope: "everything" };
  return { where, view, task: Number(p.get("task")) || null };
}

export default function Projects() {
  const { currentOrgId } = useTenant();
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
  const [panel, setPanel] = React.useState<"" | "automations" | "settings">("");
  const tree = trpc.pj.tree.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const isImport = where.scope === "import";
  const v = trpc.pj.view.useQuery(
    { organizationId: currentOrgId, listId: where.scope === "list" ? where.listId : null, scope: where.scope === "list" ? "list" : where.scope === "mine" ? "mine" : "everything", closed },
    { enabled: currentOrgId > 0 && !isImport, refetchInterval: 20_000 }
  );
  React.useEffect(() => {
    const p = new URLSearchParams();
    if (where.scope === "list") p.set("list", String(where.listId));
    if (where.scope === "mine") p.set("scope", "mine");
    if (where.scope === "import") p.set("import", "1");
    if (view !== "list") p.set("view", view);
    if (taskId) p.set("task", String(taskId));
    const s = p.toString();
    go(`/projects${s ? `?${s}` : ""}`, { replace: true });
  }, [where, view, taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => Promise.all([utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.task.invalidate()]);
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
  const ctx: PjCtx | null = data ? { orgId: currentOrgId, data, tasks, open: setTaskId, refresh, group, listId: where.scope === "list" ? where.listId : null } : null;
  const title = where.scope === "list" ? data?.list?.name ?? "" : where.scope === "mine" ? "My work" : where.scope === "import" ? "Move from ClickUp" : "Everything";
  const crumb = where.scope === "list" && data?.list?.folderName ? `${data.list.folderName} /` : "";
  const assignees = Array.from(new Map((data?.tasks ?? []).flatMap((t) => t.assignees).map((a) => [`${a.type}:${a.id}:${a.name}`, a])).values());
  return (
    <div className="ld">
      <Rail active="projects" />
      <Tree orgId={currentOrgId} tree={tree.data} where={where} onPick={(w) => { setWhere(w); setTaskId(null); }} refresh={refresh} />
      <main className="gp-main">
        <div className="gp-head">
          <div className="gp-hrow">
            <span className="gp-ttl" style={{ fontSize: 18 }}>
              {crumb && <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>{crumb}</span>}
              {title}
            </span>
            {!isImport && (
              <span className="ld-row">
                {where.scope === "list" && <button type="button" className="ld-btn" onClick={() => setPanel("settings")}>Edit list</button>}
                <button type="button" className="ld-btn" onClick={() => setPanel("automations")}>Automations</button>
              </span>
            )}
          </div>
          {!isImport && <ViewTabs views={VIEWS} value={view} onChange={setView} />}
        </div>
        {!isImport && (
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
              <button type="button" className={`gp-fb ${me ? "sel" : ""}`} aria-pressed={me} onClick={() => setMe(!me)}>Me mode</button>
            </span>
            <span className="gp-tool-r">
              <input className="gp-srch" placeholder="Search tasks" aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} />
              {ctx && <NewTask c={ctx} />}
            </span>
          </div>
        )}
        <div className="gp-canvas">
          <ErrorLine error={v.error || tree.error} />
          {isImport ? (
            <ImportPage orgId={currentOrgId} onDone={() => { void refresh(); setWhere({ scope: "everything" }); }} />
          ) : !ctx ? (
            <p className="ld-muted" style={{ padding: 20 }}>{v.isLoading ? "Loading tasks" : ""}</p>
          ) : (
            <div className="gp-view">
              {ctx.data.lists.length === 0 && where.scope !== "list" ? (
                <Empty onImport={() => setWhere({ scope: "import" })} />
              ) : (
                <>
                  {view === "list" && <ListView c={ctx} />}
                  {view === "board" && <BoardView c={ctx} />}
                  {view === "calendar" && <CalendarView c={ctx} />}
                  {view === "gantt" && <GanttView c={ctx} />}
                  {view === "table" && <TableView c={ctx} />}
                </>
              )}
            </div>
          )}
        </div>
      </main>
      {taskId && <TaskModal orgId={currentOrgId} id={taskId} onClose={() => { setTaskId(null); void refresh(); }} onOpen={setTaskId} />}
      {panel === "automations" && ctx && <Automations c={ctx} onClose={() => setPanel("")} />}
      {panel === "settings" && ctx?.data.list && <ListSettings c={ctx} onClose={() => setPanel("")} onRemoved={() => { setPanel(""); setWhere({ scope: "everything" }); void refresh(); }} />}
      <BottomNav active="projects" />
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

function NewTask({ c }: { c: PjCtx }) {
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
  React.useEffect(() => setList(c.listId ?? c.data.lists[0]?.id ?? ""), [c.listId, c.data.lists]);
  if (!open)
    return (
      <button type="button" className="ld-btn p gp-auto" onClick={() => setOpen(true)} disabled={!c.data.lists.length}>
        + Task
      </button>
    );
  return (
    <span className="ld-row">
      {!c.listId && (
        <select className="ld-in xs" style={{ width: 160 }} aria-label="List" value={list} onChange={(e) => setList(Number(e.target.value))}>
          {c.data.lists.map((l) => (
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
