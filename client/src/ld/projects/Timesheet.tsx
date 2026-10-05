import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { addDays, fmtYmd, OwnerAvatar } from "../goals/shared";
import { fmtMin, parseDuration } from "./TaskModal";

/** Timesheets: everyone's tracked time for a week, by task and day; billable hours; estimate vs. actual; download. */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${pad(m % 60)}` : "·");

export function TimesheetPage({ orgId, onOpenTask }: { orgId: number; onOpenTask: (id: number) => void }) {
  const [week, setWeek] = React.useState<string | undefined>(undefined);
  const [who, setWho] = React.useState("");
  const [billable, setBillable] = React.useState<"any" | "yes" | "no">("any");
  const [adding, setAdding] = React.useState(false);
  const [wt, wid] = who.split(":");
  const q = trpc.pj.timesheet.useQuery({ organizationId: orgId, weekStart: week, billable, ...(who ? { whoType: wt as "user" | "employee", whoId: Number(wid) } : {}) }, { refetchInterval: 30_000 });
  const d = q.data;
  const download = () => {
    if (!d) return;
    const rows = [["Task", "List", "Person", ...d.days.map((x) => fmtYmd(x)), "Total (hours)", "Billable (hours)"], ...d.rows.map((r) => [r.taskName, r.listName, r.whoName, ...r.byDay.map((m) => (m / 60).toFixed(2)), (r.total / 60).toFixed(2), (r.billable / 60).toFixed(2)])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `Timesheet week of ${fmtYmd(d.start)}.csv`;
    a.click();
  };
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>Timesheets{d && <span className="crumb">· Week of {fmtYmd(d.start)}</span>}</span>
        </div>
      </div>
      <div className="gp-tool">
        <span className="gp-tool-l">
          <button type="button" className="ld-btn sm" disabled={!d} onClick={() => d && setWeek(addDays(d.start, -7))}>Last week</button>
          <button type="button" className="ld-btn sm" onClick={() => setWeek(undefined)}>This week</button>
          <button type="button" className="ld-btn sm" disabled={!d} onClick={() => d && setWeek(addDays(d.start, 7))}>Next week</button>
          <select className="gp-fb" aria-label="Whose time" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {d?.people.map((p) => (
              <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
            ))}
          </select>
          <select className="gp-fb" aria-label="Billable" value={billable} onChange={(e) => setBillable(e.target.value as typeof billable)}>
            <option value="any">Billable: any</option>
            <option value="yes">Billable only</option>
            <option value="no">Not billable</option>
          </select>
        </span>
        <span className="gp-tool-r">
          <button type="button" className="ld-btn sm" onClick={() => setAdding(true)}>Add time</button>
          <button type="button" className="ld-btn sm" disabled={!d?.rows.length} onClick={download}>Download</button>
        </span>
      </div>
      <div className="gp-canvas" style={{ flexDirection: "column" }}>
        <ErrorLine error={q.error} />
        {adding && <AddTime orgId={orgId} people={d?.people ?? []} onDone={() => { setAdding(false); void q.refetch(); }} />}
        {d && (
          <>
            <div className="gp-stats3">
              <div className="gp-w">
                <h5>This week</h5>
                <span className="num">{fmtMin(d.total)}</span>
                <span className="ld-small ld-muted">{fmtMin(d.billable)} billable</span>
              </div>
              <div className="gp-w">
                <h5>Estimate vs. actual</h5>
                <span className="num">{d.estimateUse === null ? "None" : `${d.estimateUse}%`}</span>
                <span className="ld-small ld-muted">{d.estimateUse === null ? "No tasks with estimates were done this week" : "of estimated time used on tasks done this week"}</span>
              </div>
              <div className="gp-w">
                <h5>Timers running</h5>
                <span className="num">{d.running.length}</span>
                <span className="ld-small ld-muted gp-ell">{d.running.map((r) => `${r.whoName.split(" ")[0]} · ${r.taskName}`).join("; ") || "None right now"}</span>
              </div>
            </div>
            <div className="gp-gl" style={{ width: "100%" }}>
              <div className="gp-ts h">
                <span>Task</span>
                {d.days.map((x) => (
                  <span key={x}>
                    {DOW[new Date(`${x}T12:00:00Z`).getUTCDay()]} {fmtYmd(x).replace(/, \d{4}$/, "").replace(/^\w+ /, (m) => m)}
                  </span>
                ))}
                <span>Total</span>
              </div>
              {d.rows.map((r) => (
                <button key={`${r.taskId}:${r.whoType}:${r.whoId}`} type="button" className="gp-ts" onClick={() => onOpenTask(r.taskId)}>
                  <span className="nm">
                    <OwnerAvatar o={{ type: r.whoType as "user" | "employee", id: r.whoId, name: r.whoName }} size={24} />
                    <span className="gp-ell">
                      {r.taskName}
                      <span className="ld-small ld-muted"> · {r.listName}</span>
                    </span>
                    {r.running && <span className="gp-xpill red">Running</span>}
                  </span>
                  {r.byDay.map((m, i) => (
                    <span key={i}>{hm(m)}</span>
                  ))}
                  <span><b>{hm(r.total)}</b></span>
                </button>
              ))}
              {d.rows.length > 0 && (
                <div className="gp-ts t">
                  <span>Total</span>
                  {d.totals.map((m, i) => (
                    <span key={i}>{hm(m)}</span>
                  ))}
                  <span>{hm(d.total)}</span>
                </div>
              )}
              {!d.rows.length && <div className="gp-empty">No time tracked this week. Start a timer on a task, or add time.</div>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function AddTime({ orgId, people, onDone }: { orgId: number; people: { type: "user" | "employee"; id: number; name: string }[]; onDone: () => void }) {
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: true });
  const add = trpc.pj.addTime.useMutation({ onSuccess: onDone });
  const now = new Date();
  const [f, setF] = React.useState({ taskId: 0, who: people[0] ? `${people[0].type}:${people[0].id}` : "", day: `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`, dur: "", note: "", billable: true });
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div className="gp-gl" style={{ padding: 16, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="ld-between">
        <b>Add time</b>
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
          <button
            type="button"
            className="ld-btn p sm"
            disabled={add.isPending}
            onClick={() => {
              const minutes = parseDuration(f.dur);
              const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(f.day.trim());
              if (!f.taskId) return setErr("Pick the task.");
              if (!minutes || !m) return setErr("Type how long (1h 30m) and the day (MM/DD/YYYY).");
              const [type, id] = f.who.split(":");
              const p = people.find((x) => x.type === type && x.id === Number(id));
              add.mutate({ organizationId: orgId, taskId: f.taskId, day: `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`, minutes, note: f.note, billable: f.billable, ...(p ? { who: p } : {}) });
            }}
          >
            Save
          </button>
        </span>
      </div>
      <div className="gp-addtime" style={{ gridTemplateColumns: "minmax(0,2fr) 180px 130px 100px minmax(0,1fr) 90px" }}>
        <select className="ld-in xs" aria-label="Task" value={f.taskId} onChange={(e) => setF({ ...f, taskId: Number(e.target.value) })}>
          <option value={0}>Pick a task</option>
          {v.data?.tasks.map((t) => (
            <option key={t.id} value={t.id}>{t.name} ({t.listName})</option>
          ))}
        </select>
        <select className="ld-in xs" aria-label="Whose time" value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}>
          {people.map((p) => (
            <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
          ))}
        </select>
        <input className="ld-in xs" aria-label="Day (MM/DD/YYYY)" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
        <input className="ld-in xs" aria-label="How long" placeholder="1h 30m" value={f.dur} onChange={(e) => setF({ ...f, dur: e.target.value })} />
        <input className="ld-in xs" aria-label="What it was" placeholder="What it was" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <label className="ld-row ld-small"><input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable</label>
      </div>
      <ErrorLine error={err ? { message: err } : add.error} />
    </div>
  );
}
