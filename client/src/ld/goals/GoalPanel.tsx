import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { AddFiles, Bar, fmtAt, fmtYmd, FileTiles, money, OwnerAvatar, OwnerName, StatusPill, valueText, type Status } from "./shared";
import type { GoalRow, GoalsCtx } from "../pages/Goals";

/** One goal, opened in the side panel: its details, Simone's reason when she suggested it, updates, numbers, work and files. */
export function GoalPanel({ c, row, onClose }: { c: GoalsCtx; row: GoalRow; onClose: () => void }) {
  const g = row.goal;
  const parent = c.data.goals.find((x) => x.goal.id === g.parentId);
  const waiting = g.state === "suggested" || g.state === "draft";
  const approve = trpc.goals.approve.useMutation({ onSuccess: () => c.refresh() });
  const dismiss = trpc.goals.dismiss.useMutation({ onSuccess: () => { void c.refresh(); onClose(); } });
  const attach = trpc.goals.attach.useMutation({ onSuccess: () => c.refresh() });
  const detach = trpc.goals.detach.useMutation({ onSuccess: () => c.refresh() });
  const topic = trpc.goals.addTopic.useMutation();
  const [mode, setMode] = React.useState<"" | "update" | "numbers">("");
  const measures = c.data.scorecard.rows.filter((r) => r.measure.goalId === g.id || row.targets.some((t) => t.measureId === r.measure.id));
  React.useEffect(() => setMode(""), [g.id]);
  return (
    <aside className="gp-spn" aria-label={g.title}>
      <div className="ph">
        <div className="ld-between">
          <span className="ld-small ld-muted">{parent ? `${parent.goal.title} ›` : g.level === "company" ? "Company goal" : `${g.level === "year" ? "Year" : g.level === "cycle" ? "12-week cycle" : "Quarter"} goal`}</span>
          <button type="button" className="gp-x big" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="ld-row" style={{ gap: 10, alignItems: "flex-start" }}>
          <span className="gp-gi" style={{ background: g.color }}>◎</span>
          <b style={{ fontSize: 18, lineHeight: 1.3 }}>{g.title}</b>
        </div>
        {waiting && (
          <div className="gp-note sugg" style={{ margin: 0 }}>
            <span className="gp-sav">S</span>
            <span style={{ flex: 1 }}>
              <b>{g.state === "draft" ? "Simone's draft." : "Simone suggests this goal."}</b> {g.why}
            </span>
          </div>
        )}
        {waiting && (
          <span className="ld-row">
            <button type="button" className="ld-btn p" disabled={approve.isPending} onClick={() => approve.mutate({ organizationId: c.orgId, id: g.id })}>Approve</button>
            <button type="button" className="ld-btn" onClick={() => c.edit(row)}>Edit</button>
            <button type="button" className="ld-btn" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ organizationId: c.orgId, id: g.id })}>Not now</button>
          </span>
        )}
        <ErrorLine error={approve.error || dismiss.error} />
        <div className="gp-fld">
          <span>Status</span>
          <span>{waiting ? <span className="gp-sd s-none">Waiting for you</span> : <StatusPill s={row.status} />}</span>
          <span>Owner</span>
          <OwnerName o={row.owner} />
          <span>Time period</span>
          <span>
            {g.period} · due {fmtYmd(g.dueDate)}
          </span>
          <span>Progress</span>
          <span>
            <Bar p={row.progress} color={g.color} red={row.status === "off"} />
            {!waiting && row.status !== "done" && <span className="ld-small ld-muted">Should be about {row.expected}% by now</span>}
          </span>
          {row.forecast && (
            <>
              <span>At this pace</span>
              <span>{row.forecast.kind === "currency" ? money(row.forecast.landing) : row.forecast.landing.toLocaleString("en-US")} by {fmtYmd(row.forecast.end)}</span>
            </>
          )}
          <span>Set by</span>
          <span>
            {g.setBy || "Not recorded"}
            {g.agreedBy ? ` · agreed with ${g.agreedBy}${g.agreedAt ? `, ${fmtYmd(new Date(g.agreedAt).toISOString().slice(0, 10))}` : ""}` : ""}
          </span>
        </div>
      </div>
      <div className="pbd">
        {row.lastUpdate && mode !== "update" && (
          <div className="gp-upd">
            <span className="ld-between">
              <b>{row.lastUpdate.author}'s update</b>
              {row.lastUpdate.status && <StatusPill s={row.lastUpdate.status as Status} />}
            </span>
            <span>{row.lastUpdate.body}</span>
            <span className="ld-small ld-muted">{fmtAt(row.lastUpdate.at)}</span>
          </div>
        )}
        {mode === "update" && <UpdateForm c={c} goalId={g.id} onDone={() => setMode("")} />}
        <Targets c={c} row={row} editing={mode === "numbers"} onDone={() => setMode("")} />
        {measures.length > 0 && (
          <div>
            <b className="gp-sub-h">Measures it tracks</b>
            {measures.map((m) => (
              <div key={m.measure.id} className="gp-sub">
                <span>{m.measure.name}</span>
                <span className="ld-small ld-muted">{valueText(m.value, m.measure.unit) || "No number"}</span>
                <StatusPill s={m.status} />
              </div>
            ))}
          </div>
        )}
        <Work c={c} row={row} />
        <div>
          <b className="gp-sub-h ld-between">
            Attachments
            <AddFiles orgId={c.orgId} onAdded={(ids) => attach.mutate({ organizationId: c.orgId, itemType: "goal", itemId: g.id, fileIds: ids })} />
          </b>
          {row.files.length ? <FileTiles files={row.files} cols={3} onRemove={(f) => f.linkId && detach.mutate({ organizationId: c.orgId, linkId: f.linkId })} /> : <span className="ld-small ld-muted">No files yet.</span>}
          <ErrorLine error={attach.error || detach.error} />
        </div>
        {!waiting && mode === "" && (
          <div className="gp-panel-btns">
            <button type="button" className="ld-btn" onClick={() => c.edit(row)}>Edit</button>
            <button type="button" className="ld-btn" onClick={() => setMode("update")}>Add update</button>
            {row.targets.some((t) => t.kind === "number" || t.kind === "currency" || t.kind === "boolean") && (
              <button type="button" className="ld-btn" onClick={() => setMode("numbers")}>New numbers</button>
            )}
            <button type="button" className="ld-btn" disabled={topic.isPending || topic.isSuccess} onClick={() => topic.mutate({ organizationId: c.orgId, text: `Goal: ${g.title} (${row.status ? row.status : "no status"}, ${row.progress}% done)` })}>
              {topic.isSuccess ? "On the agenda" : "Add to meeting"}
            </button>
          </div>
        )}
        <AllUpdates c={c} goalId={g.id} />
      </div>
    </aside>
  );
}

function UpdateForm({ c, goalId, onDone }: { c: GoalsCtx; goalId: number; onDone: () => void }) {
  const [status, setStatus] = React.useState<"" | Status>("");
  const [body, setBody] = React.useState("");
  const [fileIds, setFileIds] = React.useState<number[]>([]);
  const add = trpc.goals.addUpdate.useMutation({
    onSuccess: async () => {
      await c.refresh();
      onDone();
    },
  });
  return (
    <div className="gp-upd editing">
      <span className="ld-between">
        <b>New update</b>
        <select className="ld-in xs" style={{ width: 130 }} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
          <option value="">Status: as is</option>
          <option value="on">On track</option>
          <option value="risk">At risk</option>
          <option value="off">Off track</option>
          <option value="done">Done</option>
        </select>
      </span>
      <textarea className="ld-ta" rows={3} aria-label="Update" value={body} onChange={(e) => setBody(e.target.value)} placeholder="What moved, what's in the way, what's next" />
      <span className="ld-between">
        <span className="ld-small ld-muted">{fileIds.length ? `${fileIds.length} file${fileIds.length === 1 ? "" : "s"} attached` : ""}</span>
        <AddFiles orgId={c.orgId} label="Attach files" onAdded={(ids) => setFileIds([...fileIds, ...ids])} />
      </span>
      <span className="ld-row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
        <button type="button" className="ld-btn p sm" disabled={add.isPending || !body.trim()} onClick={() => add.mutate({ organizationId: c.orgId, goalId, status: status || null, body, fileIds })}>
          {add.isPending ? "Saving" : "Save"}
        </button>
      </span>
      <ErrorLine error={add.error} />
    </div>
  );
}

function Targets({ c, row, editing, onDone }: { c: GoalsCtx; row: GoalRow; editing: boolean; onDone: () => void }) {
  const set = trpc.goals.setTarget.useMutation();
  const [vals, setVals] = React.useState<Record<number, string>>({});
  const [done, setDone] = React.useState<Record<number, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setVals(Object.fromEntries(row.targets.map((t) => [t.id, String(t.currentValue)])));
    setDone(Object.fromEntries(row.targets.map((t) => [t.id, t.done])));
  }, [row, editing]);
  if (!row.targets.length) return null;
  const save = async () => {
    setBusy(true);
    for (const t of row.targets) {
      if (t.kind === "boolean" && done[t.id] !== t.done) await set.mutateAsync({ organizationId: c.orgId, targetId: t.id, value: null, done: done[t.id] });
      if ((t.kind === "number" || t.kind === "currency") && Number(vals[t.id]) !== t.currentValue && vals[t.id] !== "") await set.mutateAsync({ organizationId: c.orgId, targetId: t.id, value: Number(vals[t.id]) });
    }
    await c.refresh();
    setBusy(false);
    onDone();
  };
  const show = (t: GoalRow["targets"][number]) =>
    t.kind === "boolean" ? (t.done ? "Done" : "Not done") : t.kind === "tasks" ? `${t.tasksDone} of ${t.tasksTotal} tasks done` : t.kind === "measure" ? `${t.measureValue ?? "No number"} / ${t.targetValue}` : t.kind === "currency" ? `${money(t.currentValue)} / ${money(t.targetValue)}` : `${t.currentValue.toLocaleString("en-US")} / ${t.targetValue.toLocaleString("en-US")}`;
  return (
    <div>
      <b className="gp-sub-h">Targets</b>
      {row.targets.map((t) => (
        <div key={t.id} className="gp-sub">
          <span className="ld-row">
            <span className="gp-tk">{t.kind === "currency" ? "$" : t.kind === "boolean" ? "✓" : t.kind === "tasks" ? "☐" : t.kind === "measure" ? "~" : "#"}</span>
            {t.name}
          </span>
          {editing && (t.kind === "number" || t.kind === "currency") ? (
            <input className="ld-in xs" style={{ width: 110 }} aria-label={`${t.name} now`} inputMode="decimal" value={vals[t.id] ?? ""} onChange={(e) => setVals({ ...vals, [t.id]: e.target.value.replace(/[^\d.-]/g, "") })} />
          ) : editing && t.kind === "boolean" ? (
            <label className="ld-row ld-small">
              <input type="checkbox" checked={!!done[t.id]} onChange={(e) => setDone({ ...done, [t.id]: e.target.checked })} /> Done
            </label>
          ) : (
            <span className="ld-small ld-strong">{show(t)}</span>
          )}
          <span className="ld-small ld-muted" style={{ textAlign: "right" }}>{t.progress}%</span>
        </div>
      ))}
      {editing && (
        <span className="ld-row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={busy} onClick={save}>{busy ? "Saving" : "Save"}</button>
        </span>
      )}
      <ErrorLine error={set.error} />
    </div>
  );
}

function Work({ c, row }: { c: GoalsCtx; row: GoalRow }) {
  const [adding, setAdding] = React.useState(false);
  const [text, setText] = React.useState("");
  const make = trpc.goals.makeTask.useMutation({
    onSuccess: async () => {
      setText("");
      setAdding(false);
      await c.refresh();
    },
  });
  return (
    <div>
      <b className="gp-sub-h ld-between">
        Supporting work · Projects
        {!adding && (
          <button type="button" className="gp-link" onClick={() => setAdding(true)}>+ Add a task</button>
        )}
      </b>
      {row.tasks.length === 0 && !adding && <span className="ld-small ld-muted">No tasks tied to this goal yet.</span>}
      {row.tasks.slice(0, 12).map((t) => (
        <div key={t.id} className="gp-sub" style={{ gridTemplateColumns: "20px minmax(0,1fr) 110px 100px" }}>
          <span>{t.done ? "✓" : "○"}</span>
          <Link href={`/projects?task=${t.id}`} className="gp-ell">{t.name}</Link>
          <span className="ld-small ld-muted gp-ell">{t.assignees.join(", ")}</span>
          <span className="ld-small ld-muted">{t.dueDate ? fmtYmd(t.dueDate) : ""}</span>
        </div>
      ))}
      {adding && (
        <div className="ld-row" style={{ marginTop: 6 }}>
          <input className="ld-in xs" autoFocus aria-label="New task" placeholder="Task name" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" className="ld-btn sm" onClick={() => setAdding(false)}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={!text.trim() || make.isPending} onClick={() => make.mutate({ organizationId: c.orgId, text, goalId: row.goal.id })}>Add</button>
        </div>
      )}
      <ErrorLine error={make.error} />
    </div>
  );
}

function AllUpdates({ c, goalId }: { c: GoalsCtx; goalId: number }) {
  const [open, setOpen] = React.useState(false);
  const q = trpc.goals.updates.useQuery({ organizationId: c.orgId, goalId }, { enabled: open });
  return (
    <div>
      <button type="button" className="gp-link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide updates" : "All updates"}
      </button>
      {open &&
        (q.data ?? []).map((u) => (
          <div key={u.id} className="gp-upd" style={{ marginTop: 8 }}>
            <span className="ld-between">
              <span className="ld-row">
                <OwnerAvatar o={c.data.people.find((p) => p.type === u.authorType && p.id === u.authorId) ?? { type: "name", id: 0, name: u.authorName }} size={22} />
                <b>{u.authorName}</b>
              </span>
              {u.status && <StatusPill s={u.status as Status} />}
            </span>
            <span>{u.body}</span>
            {u.files.length > 0 && <FileTiles files={u.files} cols={3} />}
            <span className="ld-small ld-muted">{fmtAt(u.createdAt)}</span>
          </div>
        ))}
      {open && q.data?.length === 0 && <p className="ld-small ld-muted">No updates yet.</p>}
    </div>
  );
}
