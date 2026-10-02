import React from "react";
import { trpc } from "@/lib/trpc";
import { useTenant } from "@/contexts/TenantContext";
import { Avatar, ErrorLine, FolderTabs, Page, useEmployees } from "../ui";
import { fmtDate } from "../meta";

const COLS = "minmax(0,2.4fr) 130px minmax(0,1.3fr) 130px 128px";

type Repeat = "once" | "daily" | "weekdays" | "weekly" | "monthly";

const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "once", label: "Once" },
];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TZ_LABELS: Record<string, string> = {
  "America/New_York": "Eastern time",
  "America/Chicago": "Central time",
  "America/Denver": "Mountain time",
  "America/Phoenix": "Arizona time",
  "America/Los_Angeles": "Pacific time",
  "America/Anchorage": "Alaska time",
  "Pacific/Honolulu": "Hawaii time",
};

function fmt12(hhmm: string) {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

const TIMES: string[] = [];
for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 15) TIMES.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);

/** "2026-10-05" to "10/05/2026". */
function isoToUs(iso: string | null | undefined) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

/** "10/5/2026" to "2026-10-05", or null when it is not a real date. */
function usToIso(us: string) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(us);
  if (!m) return null;
  const mo = +m[1];
  const d = +m[2];
  const y = +m[3];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

type TaskRow = {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeKind: string;
  title: string;
  instructions: string;
  repeat: Repeat;
  weekday: number | null;
  monthDay: number | null;
  time: string;
  onDate: string | null;
  enabled: boolean;
  nextRunAt: Date | string | null;
  repeatLabel: string;
};

type Draft = {
  employeeId: number;
  title: string;
  instructions: string;
  repeat: Repeat;
  weekday: number;
  monthDay: number;
  time: string;
  onDate: string; // typed MM/DD/YYYY
  enabled: boolean;
};

export default function Tasks() {
  const { currentOrgId } = useTenant();
  const utils = trpc.useUtils();
  const { list: employees } = useEmployees();
  const tasksQ = trpc.tasks.list.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const runsQ = trpc.tasks.runs.useQuery({ organizationId: currentOrgId }, { enabled: currentOrgId > 0 });
  const [tab, setTab] = React.useState<"scheduled" | "ran" | "failed">("scheduled");
  const [editing, setEditing] = React.useState<number | "new" | null>(null);

  const tasks = (tasksQ.data ?? []) as TaskRow[];
  const runs = runsQ.data ?? [];
  const ran = runs.filter((r) => r.status === "ok");
  const failed = runs.filter((r) => r.status === "failed");

  const refresh = () => Promise.all([utils.tasks.list.invalidate(), utils.tasks.runs.invalidate()]);
  const runNow = trpc.tasks.runNow.useMutation({ onSettled: refresh });

  const empOf = (id: number | undefined) => employees.find((e) => e.id === id);
  const who = (id: number | undefined, fallbackName?: string, fallbackKind?: string) => {
    const e = empOf(id);
    const name = e?.name ?? fallbackName ?? "Employee";
    return (
      <span className="ld-row ld-strong" style={{ minWidth: 0 }}>
        <Avatar name={name} kind={e?.kind ?? fallbackKind} src={e?.avatar} size={26} />
        <span className="ld-clip" style={{ whiteSpace: "nowrap" }}>{name}</span>
      </span>
    );
  };

  return (
    <Page rail="tasks">
      <div className="ld-between">
        <h1 className="ld-h1">Tasks</h1>
        <button
          type="button"
          className="ld-btn p"
          disabled={employees.length === 0}
          onClick={() => {
            setTab("scheduled");
            setEditing("new");
          }}
        >
          Add task
        </button>
      </div>

      <FolderTabs
        value={tab}
        onChange={(k) => {
          setTab(k);
          setEditing(null);
        }}
        tabs={[
          { key: "scheduled", label: `Scheduled (${tasks.length})` },
          { key: "ran", label: `Ran (${ran.length})` },
          { key: "failed", label: `Failed (${failed.length})` },
        ]}
      >
        {tab === "scheduled" ? (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>Task</span>
              <span>Employee</span>
              <span>Repeats</span>
              <span>Next run</span>
              <span />
            </div>
            {editing === "new" && <TaskEditor key="new" task={null} defaultEmployeeId={employees[0]?.id ?? 0} onDone={() => setEditing(null)} />}
            {tasks.length === 0 && editing !== "new" && <div className="ld-empty">{tasksQ.isLoading ? "Loading..." : "No tasks yet."}</div>}
            {tasks.map((t) => {
              const isOpen = editing === t.id;
              return (
                <React.Fragment key={t.id}>
                  <div className={`ld-rw ${isOpen ? "open" : ""}`} style={{ gridTemplateColumns: COLS }}>
                    <span className="ld-strong">{t.title}</span>
                    {who(t.employeeId, t.employeeName, t.employeeKind)}
                    <span>{t.repeatLabel}</span>
                    <span>{t.enabled ? fmtDate(t.nextRunAt) || "Not scheduled" : "Paused"}</span>
                    <button type="button" className="ld-btn" onClick={() => setEditing(isOpen ? null : t.id)}>
                      Edit
                    </button>
                  </div>
                  {isOpen && <TaskEditor key={t.id} task={t} defaultEmployeeId={t.employeeId} onDone={() => setEditing(null)} />}
                </React.Fragment>
              );
            })}
          </>
        ) : (
          <>
            <div className="ld-hd" style={{ gridTemplateColumns: COLS }}>
              <span>Task</span>
              <span>Employee</span>
              <span>{tab === "failed" ? "What went wrong" : "Result"}</span>
              <span>Ran on</span>
              <span />
            </div>
            {(tab === "ran" ? ran : failed).length === 0 && (
              <div className="ld-empty">{runsQ.isLoading ? "Loading..." : tab === "ran" ? "No runs yet." : "No failed runs."}</div>
            )}
            {(tab === "ran" ? ran : failed).map((r) => {
              const task = tasks.find((t) => t.id === r.taskId);
              return (
                <div key={r.id} className="ld-rw" style={{ gridTemplateColumns: COLS }}>
                  <span className="ld-strong">{r.title}</span>
                  {task ? who(task.employeeId, task.employeeName, task.employeeKind) : <span className="ld-muted">Deleted task</span>}
                  {r.status === "failed" ? (
                    <span className="ld-small" style={{ color: "#b42318", overflowWrap: "anywhere" }}>{r.error || "Failed"}</span>
                  ) : (
                    <span className="ld-pill green">Ran</span>
                  )}
                  <span>{fmtDate(r.startedAt)}</span>
                  {task ? (
                    <button
                      type="button"
                      className="ld-btn"
                      disabled={runNow.isPending}
                      onClick={() => runNow.mutate({ organizationId: currentOrgId, id: task.id })}
                    >
                      {runNow.isPending && runNow.variables?.id === task.id ? "Running..." : "Run again"}
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
            {runNow.error && (
              <div style={{ padding: "8px 18px" }}>
                <ErrorLine error={runNow.error} />
              </div>
            )}
          </>
        )}
      </FolderTabs>
    </Page>
  );
}

function TaskEditor({ task, defaultEmployeeId, onDone }: { task: TaskRow | null; defaultEmployeeId: number; onDone: () => void }) {
  const { currentOrgId, currentOrg } = useTenant();
  const utils = trpc.useUtils();
  const { list: employees } = useEmployees();
  const [d, setD] = React.useState<Draft>(() => ({
    employeeId: task?.employeeId ?? defaultEmployeeId,
    title: task?.title ?? "",
    instructions: task?.instructions ?? "",
    repeat: task?.repeat ?? "weekly",
    weekday: task?.weekday ?? 1,
    monthDay: task?.monthDay ?? 1,
    time: task?.time ?? "08:00",
    onDate: isoToUs(task?.onDate),
    enabled: task?.enabled ?? true,
  }));
  const [localError, setLocalError] = React.useState<string | null>(null);
  const refresh = () => Promise.all([utils.tasks.list.invalidate(), utils.tasks.runs.invalidate()]);
  const save = trpc.tasks.save.useMutation({
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const del = trpc.tasks.delete.useMutation({
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const runNow = trpc.tasks.runNow.useMutation({ onSettled: refresh });

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const id = task ? `t${task.id}` : "tnew";
  const tz = currentOrg?.timezone || "America/Chicago";
  const times = TIMES.includes(d.time) ? TIMES : [...TIMES, d.time].sort();

  const submit = () => {
    setLocalError(null);
    let onDate: string | null = null;
    if (d.repeat === "once") {
      onDate = usToIso(d.onDate);
      if (!onDate) {
        setLocalError("Type the date as MM/DD/YYYY.");
        return;
      }
    }
    if (!d.employeeId) {
      setLocalError("Pick an employee.");
      return;
    }
    save.mutate({
      organizationId: currentOrgId,
      id: task?.id,
      employeeId: d.employeeId,
      title: d.title.trim(),
      instructions: d.instructions.trim(),
      repeat: d.repeat,
      weekday: d.repeat === "weekly" ? d.weekday : null,
      monthDay: d.repeat === "monthly" ? d.monthDay : null,
      time: d.time,
      onDate,
      enabled: d.enabled,
    });
  };

  const field = (label: string, htmlFor: string, control: React.ReactNode, span2 = false) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: span2 ? "span 2" : undefined }}>
      <label htmlFor={htmlFor} className="ld-lbl">{label}</label>
      {control}
    </div>
  );

  return (
    <div className="ld-expand" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) 128px", gap: 14, alignItems: "start", paddingTop: task ? 4 : 16 }}>
      <div style={{ gridColumn: "span 2", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 14 }}>
        {field(
          "What to do",
          `${id}-what`,
          <textarea id={`${id}-what`} className="ld-ta" rows={2} value={d.instructions} onChange={(e) => set("instructions", e.target.value)} />,
          true
        )}
        {field("Title", `${id}-title`, <input id={`${id}-title`} className="ld-in" type="text" value={d.title} onChange={(e) => set("title", e.target.value)} />)}
        {!task &&
          field(
            "Employee",
            `${id}-emp`,
            <select id={`${id}-emp`} className="ld-in" value={d.employeeId} onChange={(e) => set("employeeId", Number(e.target.value))}>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        {field(
          "Repeats",
          `${id}-rep`,
          <select id={`${id}-rep`} className="ld-in" value={d.repeat} onChange={(e) => set("repeat", e.target.value as Repeat)}>
            {REPEAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {d.repeat === "weekly" &&
          field(
            "Day",
            `${id}-wd`,
            <select id={`${id}-wd`} className="ld-in" value={d.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}
                </option>
              ))}
            </select>
          )}
        {d.repeat === "monthly" &&
          field(
            "Day of month",
            `${id}-md`,
            <select id={`${id}-md`} className="ld-in" value={d.monthDay} onChange={(e) => set("monthDay", Number(e.target.value))}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        {d.repeat === "once" &&
          field(
            "Date",
            `${id}-date`,
            <input id={`${id}-date`} className="ld-in" type="text" inputMode="numeric" placeholder="MM/DD/YYYY" value={d.onDate} onChange={(e) => set("onDate", e.target.value)} />
          )}
        {field(
          "Time",
          `${id}-time`,
          <span className="ld-row">
            <select id={`${id}-time`} className="ld-in" style={{ width: 130 }} value={d.time} onChange={(e) => set("time", e.target.value)}>
              {times.map((t) => (
                <option key={t} value={t}>
                  {fmt12(t)}
                </option>
              ))}
            </select>
            <span className="ld-small ld-muted">{TZ_LABELS[tz] ?? tz}</span>
          </span>
        )}
        <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: 4 }}>
          {localError && (
            <p role="alert" className="ld-small" style={{ color: "#b42318", margin: 0 }}>
              {localError}
            </p>
          )}
          <ErrorLine error={save.error ?? del.error ?? runNow.error} />
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="ld-btn p" disabled={save.isPending} onClick={submit}>
          Save
        </button>
        <button type="button" className="ld-btn" onClick={onDone}>
          Cancel
        </button>
        {task && (
          <>
            <button type="button" className="ld-btn" disabled={runNow.isPending} onClick={() => runNow.mutate({ organizationId: currentOrgId, id: task.id })}>
              {runNow.isPending ? "Running..." : "Run now"}
            </button>
            <button type="button" className="ld-btn danger" disabled={del.isPending} onClick={() => {
                if (window.confirm(`Delete "${task.title}"?`)) del.mutate({ organizationId: currentOrgId, id: task.id });
              }}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
