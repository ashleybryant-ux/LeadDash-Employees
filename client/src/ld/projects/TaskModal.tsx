import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { AddFiles, fmtAt, fmtYmd, FileTiles, Menu, OwnerAvatar } from "../goals/shared";
import { Flag, PRIORITY_TEXT, StatusTag } from "./bits";
import { FieldInput, FieldValue, fieldText } from "./fields";
import { AssigneeCell, Cell, DateCell, FieldCell, PeoplePick, PriorityCell, StatusCell, type QuickCtx } from "./Quick";
import { FilePreview, type PreviewFile } from "./Preview";
import type { Outputs } from "../types";

/**
 * A task, opened over the page: read view with an Edit button (Edit opens
 * every field, then Save or Cancel), how it repeats, who watches it, what it
 * waits on and blocks, linked tasks, time tracked with a timer, subtasks,
 * checklist, attachments, and the activity with comments. @ a person or an
 * employee in a comment.
 */

type Detail = Outputs["pj"]["task"];
type Assignee = Detail["task"]["assignees"][number];
type Repeat = NonNullable<Detail["task"]["repeat"]>;
const RANK = { view: 1, comment: 2, edit: 3, full: 4 } as const;

export function TaskModal({ orgId, id, onClose, onOpen, onEditFields, onSaveTemplate, mode = "modal", onFull }: { orgId: number; id: number; onClose: () => void; onOpen: (id: number) => void; onEditFields?: () => void; onSaveTemplate?: (id: number) => void; mode?: "modal" | "panel"; onFull?: () => void }) {
  const q = trpc.pj.task.useQuery({ organizationId: orgId, id }, { refetchInterval: 30_000 });
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => {
    setEditing(false);
  }, [id]);
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [editing, onClose]);
  const d = q.data;
  // Beside the list: the same task, stacked, with the list still in view.
  if (mode === "panel")
    return (
      <aside className="gp-tpane" aria-label={d?.task.name ?? "Task"}>
        <div className="gp-tpane-h">
          <span className="ld-small ld-muted gp-ell">{d ? [d.list.folderName, d.list.name].filter(Boolean).join(" › ") : ""}</span>
          <span className="ld-row">
            {onFull && <button type="button" className="ld-btn sm" onClick={onFull}>Open full</button>}
            <button type="button" className="ld-btn sm" onClick={onClose}>Close</button>
          </span>
        </div>
        {!d ? (
          <div style={{ padding: 20 }}>
            <ErrorLine error={q.error} />
            {q.isLoading && <span className="ld-muted">Opening the task</span>}
          </div>
        ) : (
          <>
            <div className="tml">{editing ? <EditTask orgId={orgId} d={d} onDone={() => setEditing(false)} onClose={onClose} /> : <ReadTask orgId={orgId} d={d} onEdit={() => setEditing(true)} onOpen={onOpen} onEditFields={onEditFields} onSaveTemplate={onSaveTemplate} />}</div>
            <Activity orgId={orgId} d={d} onClose={onClose} panel />
          </>
        )}
      </aside>
    );
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={d?.task.name ?? "Task"} onMouseDown={(e) => e.target === e.currentTarget && !editing && onClose()}>
      <div className="gp-tm">
        {!d ? (
          <div style={{ padding: 30 }}>
            <ErrorLine error={q.error} />
            {q.isLoading && <span className="ld-muted">Opening the task</span>}
            <button type="button" className="ld-btn" onClick={onClose} style={{ marginTop: 12 }}>Close</button>
          </div>
        ) : (
          <>
            <div className="tml">{editing ? <EditTask orgId={orgId} d={d} onDone={() => setEditing(false)} onClose={onClose} /> : <ReadTask orgId={orgId} d={d} onEdit={() => setEditing(true)} onOpen={onOpen} onEditFields={onEditFields} onSaveTemplate={onSaveTemplate} />}</div>
            <Activity orgId={orgId} d={d} onClose={onClose} />
          </>
        )}
      </div>
    </div>
  );
}

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
export function repeatText(r: Repeat, short = false) {
  if (r.unit === "week" && r.days?.length) {
    if (short && r.every === 1 && r.days.length === 1) return DAY_SHORT[r.days[0]];
    return `Every ${r.every > 1 ? `${r.every} weeks on ` : ""}${r.days.map((x) => DAY[x]).join(", ")}`;
  }
  return `Every ${r.every > 1 ? `${r.every} ${r.unit}s` : r.unit}`;
}
const repeatLong = (r: Repeat) => `${repeatText(r)}, ${r.mode === "done" ? "when this one is done" : "on schedule"}${r.ends === "date" && r.until ? `, until ${fmtYmd(r.until)}` : r.ends === "count" && r.count ? `, ${r.count} times` : ""}`;

export const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}` : `${m} m`);
/** "1h 30m", "1:30", "45m", "2h" or minutes. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  const hm = /^(\d+):(\d{1,2})$/.exec(t);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const h = /(\d+(?:\.\d+)?)\s*h/.exec(t);
  const m = /(\d+)\s*m/.exec(t);
  if (h || m) return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
  return /^\d+$/.test(t) ? Number(t) : null;
}

const elapsed = (from: Date | string | null) => {
  if (!from) return "0:00:00";
  const s = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
function useTick(on: boolean) {
  const [, set] = React.useState(0);
  React.useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

function ReadTask({ orgId, d, onEdit, onOpen, onEditFields, onSaveTemplate }: { orgId: number; d: Detail; onEdit: () => void; onOpen: (id: number) => void; onEditFields?: () => void; onSaveTemplate?: (id: number) => void }) {
  const utils = trpc.useUtils();
  const me = trpc.pj.me.useQuery({ organizationId: orgId });
  const t = d.task;
  const refresh = () => Promise.all([utils.pj.task.invalidate(), utils.pj.view.invalidate(), utils.pj.tree.invalidate(), utils.pj.me.invalidate()]);
  const up = trpc.pj.update.useMutation({ onSuccess: refresh });
  const create = trpc.pj.create.useMutation({ onSuccess: refresh });
  const attach = trpc.pj.attach.useMutation({ onSuccess: refresh });
  const detach = trpc.pj.detach.useMutation({ onSuccess: refresh });
  const [sub, setSub] = React.useState("");
  const [item, setItem] = React.useState("");
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  const canEdit = RANK[d.level] >= RANK.edit;
  const canComment = RANK[d.level] >= RANK.comment;
  const status = d.list.statuses.find((s) => s.name === t.status);
  const doneStatus = d.list.statuses.find((s) => s.type === "done") ?? d.list.statuses.find((s) => s.type === "closed");
  const person = (a: Assignee) => d.people.find((p) => p.type === a.type && p.id === a.id) ?? { type: "name" as const, id: 0, name: a.name };
  const meW = me.data ? { type: "user" as const, id: me.data.userId, name: me.data.name } : null;
  const watching = !!meW && t.watchers.some((w) => w.type === "user" && w.id === meW.id);
  // Click a value to change it in place; Edit still opens the whole form.
  const q: QuickCtx = { orgId, people: d.people, statuses: d.list.statuses, canEdit, refresh, today: d.today, tasks: d.pickable };
  return (
    <>
      <div className="ld-between" style={{ gap: 12 }}>
      <div className="ld-small ld-muted gp-crumb">
        {[d.list.folderName, d.list.name].filter(Boolean).join(" / ")}
        {d.parent && (
          <>
            {" / "}
            <button type="button" className="gp-link" onClick={() => onOpen(d.parent!.id)}>{d.parent.name}</button>
          </>
        )}
      </div>
        <span className="ld-row">
          {canEdit && doneStatus && t.status !== doneStatus.name && (
            <button type="button" className="ld-btn sm" disabled={up.isPending} onClick={() => up.mutate({ organizationId: orgId, id: t.id, patch: { status: doneStatus.name } })}>Mark done</button>
          )}
          {meW && canComment && (
            <button type="button" className="ld-btn sm" aria-pressed={watching} onClick={() => up.mutate({ organizationId: orgId, id: t.id, patch: { watchers: watching ? t.watchers.filter((w) => !(w.type === "user" && w.id === meW.id)) : [...t.watchers, meW] } })}>
              {watching ? "Watching" : "Watch"}
            </button>
          )}
          {canEdit && <button type="button" className="ld-btn sm" onClick={onEdit}>Edit</button>}
          {onSaveTemplate && (
            <Menu label="Task options">
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { onSaveTemplate(t.id); close(); }}>Save as a template</button>
                  <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/projects?task=${t.id}`); close(); }}>Copy link</button>
                </>
              )}
            </Menu>
          )}
        </span>
      </div>
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        <StatusCell q={q} t={t} color={status?.color ?? "#87909e"} />
        {t.priority && <Flag p={t.priority} />}
        {t.goal && <span className="gp-chip">◎ {t.goal}</span>}
        {t.repeat && <span className="gp-xpill blue">↻ {repeatText(t.repeat)}</span>}
        {t.blocked && <span className="gp-xpill red">Waiting</span>}
      </div>
      <h2 className="gp-tt">{t.name}</h2>
      <div className="gp-tf2">
        <span>Assignees</span>
        <span><AssigneeCell q={q} t={t} max={6} label /></span>
        <span>Due date</span>
        <span><DateCell q={q} t={t} which="dueDate" /></span>
        <span>Start date</span>
        <span><DateCell q={q} t={t} which="startDate" /></span>
        <span>Repeats</span>
        <span>{t.repeat ? repeatLong(t.repeat) : <span className="ld-muted">No</span>}</span>
        <span>Watchers</span>
        <span>
          <Cell
            canEdit={canComment}
            show={<span className="ld-row">{t.watchers.length ? t.watchers.map((w) => <OwnerAvatar key={`${w.type}:${w.id}`} o={person(w)} size={24} />) : <span className="ld-muted">None</span>}</span>}
            ghost={!t.watchers.length ? "⊕ Add" : undefined}
            pick={(close) => <PeoplePick q={q} title="Watchers" value={t.watchers} onChange={(w) => up.mutate({ organizationId: orgId, id: t.id, patch: { watchers: w } })} close={close} />}
          />
        </span>
        <span>Time estimate</span>
        <span>{t.timeEstimate ? `${Math.round((t.timeEstimate / 60) * 10) / 10} hours` : <span className="ld-muted">None</span>}</span>
        <span>Priority</span>
        <span><PriorityCell q={q} t={t} /></span>
        <span>Tags</span>
        <span>{t.tags.length ? t.tags.map((x) => <span key={x} className="gp-chip" style={{ marginRight: 4 }}>{x}</span>) : <span className="ld-muted">None</span>}</span>
      </div>
      {d.list.fields.length > 0 && (
        <div className="gp-xsec">
          <b className="gp-sub-h ld-between">
            Custom fields
            {onEditFields && d.level === "full" && <button type="button" className="gp-link" onClick={onEditFields}>Edit list fields</button>}
          </b>
          <div className="gp-tf2">
            {d.list.fields.map((f) => (
              <React.Fragment key={f.id}>
                <span>{f.name}</span>
                <span>{canEdit && f.type !== "formula" && f.type !== "progress" ? <FieldCell q={q} t={t} f={f} fields={d.list.fields} /> : fieldText(f, d.list.fields, t, d.pickable) ? <FieldValue f={f} fields={d.list.fields} t={t} people={d.people} tasks={d.pickable} /> : <span className="ld-muted">None</span>}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
      <div>
        <b className="gp-sub-h">Description</b>
        {d.task.description ? <p className="gp-desc">{d.task.description}</p> : <span className="ld-small ld-muted">No description.</span>}
      </div>
      <Waits orgId={orgId} d={d} canEdit={canEdit} onOpen={onOpen} person={person} refresh={refresh} />
      <Linked orgId={orgId} d={d} canEdit={canEdit} onOpen={onOpen} refresh={refresh} />
      <TimeBox orgId={orgId} d={d} canEdit={canEdit} me={meW} person={person} refresh={refresh} />
      {!t.parentId && (
        <div>
          <b className="gp-sub-h">Subtasks {d.subtasks.length ? `${d.subtasks.filter((s) => s.closed).length} of ${d.subtasks.length}` : ""}</b>
          {d.subtasks.map((s) => (
            <div key={s.id} className="gp-sub gp-subt">
              <button
                type="button"
                className={`gp-ck ${s.closed ? "on" : ""}`}
                disabled={!canEdit}
                aria-label={s.closed ? `Open ${s.name} again` : `Mark ${s.name} done`}
                onClick={() => up.mutate({ organizationId: orgId, id: s.id, patch: { status: s.closed ? d.list.statuses[0].name : doneStatus?.name ?? s.status } })}
              >
                {s.closed ? "✓" : ""}
              </button>
              <button type="button" className="gp-link gp-ell" style={{ textAlign: "left" }} onClick={() => onOpen(s.id)}>{s.name}</button>
              <span className="ld-row">{s.assignees.slice(0, 2).map((a) => <OwnerAvatar key={`${a.type}:${a.id}`} o={person(a)} size={22} />)}</span>
              <span className="ld-small ld-muted">{s.dueDate ? fmtYmd(s.dueDate) : ""}</span>
            </div>
          ))}
          {canEdit && (
            <div className="ld-row" style={{ marginTop: 6 }}>
              <input className="ld-in xs" aria-label="New subtask" placeholder="Add a subtask, then Enter" value={sub} onChange={(e) => setSub(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && sub.trim()) { create.mutate({ organizationId: orgId, listId: d.list.id, parentId: t.id, name: sub }); setSub(""); } }} />
            </div>
          )}
        </div>
      )}
      <div>
        <b className="gp-sub-h">Checklist {d.task.checklistItems.length ? `${d.task.checklistItems.filter((x) => x.done).length} of ${d.task.checklistItems.length}` : ""}</b>
        {d.task.checklistItems.map((x, i) => (
          <label key={i} className="gp-cl">
            <input type="checkbox" disabled={!canComment} checked={x.done} onChange={() => up.mutate({ organizationId: orgId, id: t.id, patch: { checklist: d.task.checklistItems.map((y, k) => (k === i ? { ...y, done: !y.done } : y)) } })} />
            <span style={x.done ? { textDecoration: "line-through", color: "#5b6b64" } : undefined}>{x.text}</span>
          </label>
        ))}
        {canEdit && <input className="ld-in xs" aria-label="New checklist item" placeholder="Add an item, then Enter" value={item} onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && item.trim()) { up.mutate({ organizationId: orgId, id: t.id, patch: { checklist: [...d.task.checklistItems, { text: item.trim(), done: false }] } }); setItem(""); } }} />}
      </div>
      <div>
        <b className="gp-sub-h ld-between">
          Attachments
          {canEdit && <AddFiles orgId={orgId} label="Drop files here · + Add" onAdded={(ids) => attach.mutate({ organizationId: orgId, taskId: t.id, fileIds: ids })} />}
        </b>
        <DropZone orgId={orgId} disabled={!canEdit} onAdded={(ids) => attach.mutate({ organizationId: orgId, taskId: t.id, fileIds: ids })}>
          {d.files.length ? <FileTiles files={d.files} onOpen={setPreview} onRemove={canEdit ? (f) => f.linkId && detach.mutate({ organizationId: orgId, taskId: t.id, linkId: f.linkId }) : undefined} /> : <span className="ld-small ld-muted">{canEdit ? "No files yet. Drop files here." : "No files."}</span>}
          {preview && <FilePreview orgId={orgId} file={preview} onClose={() => setPreview(null)} />}
        </DropZone>
      </div>
      <ErrorLine error={up.error || create.error || attach.error || detach.error} />
    </>
  );
}

/** Waiting on and blocking: other tasks this one depends on, or holds up. */
function Waits({ orgId, d, canEdit, onOpen, person, refresh }: { orgId: number; d: Detail; canEdit: boolean; onOpen: (id: number) => void; person: (a: Assignee) => { type: "user" | "employee" | "name"; id: number; name: string }; refresh: () => Promise<unknown> }) {
  const [adding, setAdding] = React.useState(false);
  const [kind, setKind] = React.useState<"waits" | "blocks">("waits");
  const [other, setOther] = React.useState<number | "">("");
  const add = trpc.pj.addLink.useMutation({ onSuccess: async () => { setAdding(false); setOther(""); await refresh(); } });
  const rows = [...d.links.waitingOn.map((x) => ({ ...x, kind: "Waiting on" as const })), ...d.links.blocking.map((x) => ({ ...x, kind: "Blocking" as const }))];
  if (!rows.length && !canEdit) return null;
  return (
    <div className="gp-xsec">
      <b className="gp-sub-h ld-between">
        Waiting on and blocking
        {canEdit && !adding && <button type="button" className="gp-link" onClick={() => setAdding(true)}>+ Add</button>}
      </b>
      {rows.map((r) => (
        <div key={`${r.kind}${r.linkId}`} className="gp-dep">
          <span className={`gp-xpill ${r.kind === "Waiting on" ? (r.closed ? "green" : "red") : "amber"}`}>{r.kind === "Waiting on" && r.closed ? "Done" : r.kind}</span>
          <button type="button" className="gp-link gp-ell" style={{ textAlign: "left", fontWeight: 600, color: "#14221c" }} onClick={() => onOpen(r.id)}>{r.name}</button>
          <span className="ld-row">{r.assignees.slice(0, 2).map((a) => <OwnerAvatar key={`${a.type}:${a.id}`} o={person(a)} size={22} />)}</span>
          <span className="ld-small ld-muted">{r.dueDate ? `Due ${fmtYmd(r.dueDate)}` : ""}</span>
        </div>
      ))}
      {!rows.length && !adding && <span className="ld-small ld-muted">Not waiting on anything.</span>}
      {adding && (
        <div className="ld-row" style={{ flexWrap: "wrap" }}>
          <select className="ld-in xs" style={{ width: 130 }} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "waits" | "blocks")}>
            <option value="waits">Waiting on</option>
            <option value="blocks">Blocking</option>
          </select>
          <select className="ld-in xs" style={{ flex: 1, minWidth: 200 }} aria-label="Task" value={other} onChange={(e) => setOther(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Pick a task</option>
            {d.pickable.map((x) => (
              <option key={x.id} value={x.id}>{x.name}{x.listName ? ` (${x.listName})` : ""}</option>
            ))}
          </select>
          <button type="button" className="ld-btn sm" onClick={() => setAdding(false)}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={!other || add.isPending} onClick={() => other && add.mutate({ organizationId: orgId, taskId: d.task.id, otherId: other, kind })}>Add</button>
        </div>
      )}
      <ErrorLine error={add.error} />
    </div>
  );
}

function Linked({ orgId, d, canEdit, onOpen, refresh }: { orgId: number; d: Detail; canEdit: boolean; onOpen: (id: number) => void; refresh: () => Promise<unknown> }) {
  const [adding, setAdding] = React.useState(false);
  const [other, setOther] = React.useState<number | "">("");
  const add = trpc.pj.addLink.useMutation({ onSuccess: async () => { setAdding(false); setOther(""); await refresh(); } });
  if (!d.links.linked.length && !canEdit) return null;
  return (
    <div className="gp-xsec">
      <b className="gp-sub-h ld-between">
        Linked tasks
        {canEdit && !adding && <button type="button" className="gp-link" onClick={() => setAdding(true)}>+ Link</button>}
      </b>
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        {d.links.linked.map((x) => (
          <button key={x.linkId} type="button" className="gp-tlink" onClick={() => onOpen(x.id)}>↔ {x.name}</button>
        ))}
        {!d.links.linked.length && !adding && <span className="ld-small ld-muted">No linked tasks.</span>}
      </div>
      {adding && (
        <div className="ld-row">
          <select className="ld-in xs" style={{ flex: 1 }} aria-label="Task to link" value={other} onChange={(e) => setOther(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Pick a task</option>
            {d.pickable.map((x) => (
              <option key={x.id} value={x.id}>{x.name}{x.listName ? ` (${x.listName})` : ""}</option>
            ))}
          </select>
          <button type="button" className="ld-btn sm" onClick={() => setAdding(false)}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={!other || add.isPending} onClick={() => other && add.mutate({ organizationId: orgId, taskId: d.task.id, otherId: other, kind: "link" })}>Link</button>
        </div>
      )}
      <ErrorLine error={add.error} />
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const toMdy = (ymd: string | null) => {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd) : null;
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
};
const fromMdy = (s: string): string | null | undefined => {
  if (!s.trim()) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}` : undefined;
};
const todayMdy = () => {
  const n = new Date();
  return `${pad(n.getMonth() + 1)}/${pad(n.getDate())}/${n.getFullYear()}`;
};

/** Time on the task: the running timer, total against the estimate, and the entries. */
function TimeBox({ orgId, d, canEdit, me, person, refresh }: { orgId: number; d: Detail; canEdit: boolean; me: { type: "user"; id: number; name: string } | null; person: (a: Assignee) => { type: "user" | "employee" | "name"; id: number; name: string }; refresh: () => Promise<unknown> }) {
  const t = d.task;
  const running = d.time.entries.filter((e) => e.running);
  const mine = running.find((e) => me && e.whoType === "user" && e.whoId === me.id);
  useTick(running.length > 0);
  const start = trpc.pj.startTimer.useMutation({ onSuccess: refresh });
  const stop = trpc.pj.stopTimer.useMutation({ onSuccess: refresh });
  const add = trpc.pj.addTime.useMutation({ onSuccess: async () => { setForm(null); await refresh(); } });
  const removeTime = trpc.pj.removeTime.useMutation({ onSuccess: refresh });
  const [form, setForm] = React.useState<{ who: string; day: string; dur: string; note: string; billable: boolean } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const total = d.time.total;
  const pct = t.timeEstimate ? Math.min(100, Math.round((total / t.timeEstimate) * 100)) : null;
  const other = running.find((e) => e !== mine);
  return (
    <div className="gp-xsec">
      <b className="gp-sub-h ld-between">
        Time
        {canEdit && !form && <button type="button" className="gp-link" onClick={() => setForm({ who: me ? `user:${me.id}` : "", day: todayMdy(), dur: "", note: "", billable: true })}>+ Add time</button>}
      </b>
      <div className="gp-timer">
        {mine ? (
          <button type="button" className="gp-stop" aria-label="Stop my timer" disabled={stop.isPending} onClick={() => stop.mutate({ organizationId: orgId })} />
        ) : (
          <button type="button" className="gp-play" aria-label="Start my timer" disabled={!canEdit || start.isPending} onClick={() => start.mutate({ organizationId: orgId, taskId: t.id })} />
        )}
        <span className="big">{mine ? elapsed(mine.startedAt) : other ? elapsed(other.startedAt) : fmtMin(total)}</span>
        <span>{mine ? "Your timer is running" : other ? `${other.whoName.split(" ")[0]}'s timer is running` : canEdit ? "Start the timer" : "Tracked"}</span>
        <span className="gp-timer-r">
          {pct !== null && (
            <span className="gp-tbar">
              <i style={{ width: `${pct}%` }} />
            </span>
          )}
          <span style={{ whiteSpace: "nowrap" }}>
            <b>{fmtMin(total)}</b>
            {t.timeEstimate ? ` of ${Math.round((t.timeEstimate / 60) * 10) / 10} h` : " tracked"}
          </span>
        </span>
      </div>
      {d.time.entries
        .filter((e) => !e.running)
        .slice(0, 8)
        .map((e) => (
          <div key={e.id} className="gp-log">
            <OwnerAvatar o={person({ type: e.whoType, id: e.whoId, name: e.whoName })} size={24} />
            <span className="gp-ell">
              {e.whoName}
              {e.note ? ` · ${e.note}` : ""}
              {!e.billable && <span className="ld-small ld-muted"> · not billable</span>}
            </span>
            <span className="ld-small ld-muted">{fmtYmd(e.day)}</span>
            <span>{fmtMin(e.minutes ?? 0)}</span>
            {canEdit ? <button type="button" className="gp-x" aria-label="Remove this time" onClick={() => removeTime.mutate({ organizationId: orgId, id: e.id })}>×</button> : <span />}
          </div>
        ))}
      {form && (
        <div className="gp-addtime">
          <select className="ld-in xs" aria-label="Whose time" value={form.who} onChange={(e) => setForm({ ...form, who: e.target.value })}>
            {d.people.length === 0 && me && <option value={`user:${me.id}`}>{me.name}</option>}
            {d.people.map((p) => (
              <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
            ))}
          </select>
          <input className="ld-in xs" aria-label="Day (MM/DD/YYYY)" placeholder="MM/DD/YYYY" value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} />
          <input className="ld-in xs" aria-label="How long" placeholder="1h 30m" value={form.dur} onChange={(e) => setForm({ ...form, dur: e.target.value })} />
          <input className="ld-in xs" aria-label="What it was" placeholder="What it was" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <label className="ld-row ld-small"><input type="checkbox" checked={form.billable} onChange={(e) => setForm({ ...form, billable: e.target.checked })} /> Billable</label>
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => { setForm(null); setErr(null); }}>Cancel</button>
            <button
              type="button"
              className="ld-btn p sm"
              disabled={add.isPending}
              onClick={() => {
                const minutes = parseDuration(form.dur);
                const day = fromMdy(form.day);
                if (!minutes) return setErr("Type how long, like 1h 30m.");
                if (!day) return setErr("Type the day as MM/DD/YYYY.");
                setErr(null);
                const [type, id] = form.who.split(":");
                const p = d.people.find((x) => x.type === type && x.id === Number(id));
                add.mutate({ organizationId: orgId, taskId: t.id, day, minutes, note: form.note, billable: form.billable, ...(p && (p.type === "user" || p.type === "employee") ? { who: { type: p.type, id: p.id, name: p.name } } : {}) });
              }}
            >
              Save
            </button>
          </span>
        </div>
      )}
      <ErrorLine error={err ? { message: err } : start.error || stop.error || add.error || removeTime.error} />
    </div>
  );
}

/** Files dropped on the attachments area upload and attach. */
function DropZone({ orgId, onAdded, children, disabled }: { orgId: number; onAdded: (ids: number[]) => void; children: React.ReactNode; disabled?: boolean }) {
  const [over, setOver] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <div
      className={`gp-drop ${over ? "over" : ""}`}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(false);
        const { uploadFile } = await import("../meta");
        setBusy(true);
        const ids: number[] = [];
        for (const f of Array.from(e.dataTransfer.files).slice(0, 10)) {
          try {
            ids.push((await uploadFile("work", f, { organizationId: orgId, employeeId: 0 })).id);
          } catch {
            // A file that won't upload is skipped.
          }
        }
        setBusy(false);
        if (ids.length) onAdded(ids);
      }}
    >
      {busy ? <span className="ld-small ld-muted">Uploading</span> : children}
    </div>
  );
}

type Dep = { linkId?: number; kind: "waits" | "blocks"; otherId: number | "" };

function EditTask({ orgId, d, onDone, onClose }: { orgId: number; d: Detail; onDone: () => void; onClose: () => void }) {
  const utils = trpc.useUtils();
  const t = d.task;
  const tree = trpc.pj.tree.useQuery({ organizationId: orgId });
  const me = trpc.pj.me.useQuery({ organizationId: orgId });
  const up = trpc.pj.update.useMutation();
  const remove = trpc.pj.remove.useMutation();
  const addLink = trpc.pj.addLink.useMutation();
  const removeLink = trpc.pj.removeLink.useMutation();
  const addTime = trpc.pj.addTime.useMutation();
  const startDeps: Dep[] = [...d.links.waitingOn.map((x) => ({ linkId: x.linkId, kind: "waits" as const, otherId: x.id })), ...d.links.blocking.map((x) => ({ linkId: x.linkId, kind: "blocks" as const, otherId: x.id }))];
  const [f, setF] = React.useState(() => ({
    name: t.name,
    status: t.status,
    priority: (t.priority ?? "") as "" | "urgent" | "high" | "normal" | "low",
    start: toMdy(t.startDate),
    due: toMdy(t.dueDate),
    estimate: t.timeEstimate ? String(Math.round((t.timeEstimate / 60) * 10) / 10) : "",
    tags: t.tags.join(", "),
    description: d.task.description,
    goalId: t.goalId,
    listId: d.list.id,
    assignees: t.assignees as Assignee[],
    watchers: t.watchers as Assignee[],
    fields: { ...t.fields } as Record<string, unknown>,
    repeatOn: !!t.repeat,
    repeat: (t.repeat ?? { every: 1, unit: "week", days: [], mode: "done", ends: "never", keep: { subtasks: true, checklist: true, assignees: true, comments: false } }) as Repeat,
    until: t.repeat?.until ? toMdy(t.repeat.until) : "",
    deps: startDeps,
    time: { who: "", day: todayMdy(), dur: "", note: "", billable: true },
  }));
  const [err, setErr] = React.useState<string | null>(null);
  const lists = [...(tree.data?.folders ?? []).flatMap((fo) => fo.lists.map((l) => ({ id: l.id, name: `${fo.name} › ${l.name}` }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name }))];
  const has = (p: { type: string; id: number }) => f.assignees.some((a) => a.type === p.type && a.id === p.id);
  const r = f.repeat;
  const setR = (patch: Partial<Repeat>) => setF({ ...f, repeat: { ...f.repeat, ...patch } });
  const save = async () => {
    setErr(null);
    const startDate = fromMdy(f.start);
    const dueDate = fromMdy(f.due);
    if (startDate === undefined || dueDate === undefined) return setErr("Type dates as MM/DD/YYYY.");
    const until = f.repeat.ends === "date" ? fromMdy(f.until) : null;
    if (f.repeatOn && f.repeat.ends === "date" && !until) return setErr("Type the end date as MM/DD/YYYY.");
    const minutes = parseDuration(f.time.dur);
    const day = fromMdy(f.time.day);
    if (f.time.dur.trim() && (!minutes || !day)) return setErr("Type the time like 1h 30m and the day as MM/DD/YYYY.");
    try {
      await up.mutateAsync({
        organizationId: orgId,
        id: t.id,
        patch: {
          name: f.name,
          status: f.status,
          priority: f.priority || null,
          startDate,
          dueDate,
          timeEstimate: f.estimate ? Math.round(Number(f.estimate) * 60) : null,
          tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean),
          description: f.description,
          goalId: f.goalId,
          assignees: f.assignees,
          watchers: f.watchers,
          fields: f.fields,
          repeat: f.repeatOn ? { ...f.repeat, days: f.repeat.unit === "week" ? f.repeat.days ?? [] : undefined, until: until ?? undefined } : null,
          ...(f.listId !== d.list.id ? { listId: f.listId } : {}),
        },
      });
      // Waiting on and blocking: remove what was taken out, add what's new.
      for (const old of startDeps) if (!f.deps.some((x) => x.linkId === old.linkId && x.otherId === old.otherId && x.kind === old.kind)) await removeLink.mutateAsync({ organizationId: orgId, taskId: t.id, linkId: old.linkId! });
      for (const x of f.deps) if (x.otherId && !startDeps.some((o) => o.linkId === x.linkId && o.otherId === x.otherId && o.kind === x.kind)) await addLink.mutateAsync({ organizationId: orgId, taskId: t.id, otherId: x.otherId, kind: x.kind });
      if (minutes && day) {
        const [type, id] = (f.time.who || (me.data ? `user:${me.data.userId}` : "")).split(":");
        const p = d.people.find((x) => x.type === type && x.id === Number(id));
        await addTime.mutateAsync({ organizationId: orgId, taskId: t.id, day, minutes, note: f.time.note, billable: f.time.billable, ...(p && (p.type === "user" || p.type === "employee") ? { who: { type: p.type, id: p.id, name: p.name } } : {}) });
      }
      await Promise.all([utils.pj.task.invalidate(), utils.pj.view.invalidate(), utils.pj.tree.invalidate()]);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const busy = up.isPending || addLink.isPending || removeLink.isPending || addTime.isPending;
  return (
    <>
      <div className="ld-between">
        <b style={{ fontSize: 17 }}>Edit task</b>
        <span className="ld-row">
          <button type="button" className="ld-btn" onClick={onDone}>Cancel</button>
          <button type="button" className="ld-btn p" disabled={busy} onClick={save}>{busy ? "Saving" : "Save"}</button>
        </span>
      </div>
      <div className="gp-xedit">
        <label htmlFor="te-name">Name</label>
        <input id="te-name" className="ld-in xs" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label htmlFor="te-status">Status</label>
        <select id="te-status" className="ld-in xs" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          {d.list.statuses.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <label htmlFor="te-pri">Priority</label>
        <select id="te-pri" className="ld-in xs" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as typeof f.priority })}>
          <option value="">None</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <span>Dates</span>
        <span className="ld-row">
          <input className="ld-in xs" style={{ width: 140 }} aria-label="Start date (MM/DD/YYYY)" placeholder="Start MM/DD/YYYY" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          <input className="ld-in xs" style={{ width: 140 }} aria-label="Due date (MM/DD/YYYY)" placeholder="Due MM/DD/YYYY" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        </span>
        <label htmlFor="te-est">Time estimate</label>
        <span className="ld-row">
          <input id="te-est" className="ld-in xs" style={{ width: 90 }} inputMode="decimal" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value.replace(/[^\d.]/g, "") })} />
          <span className="ld-small ld-muted">hours</span>
        </span>
        <label htmlFor="te-rep">Repeats</label>
        <span className="ld-row" style={{ flexWrap: "wrap" }}>
          <select
            id="te-rep"
            className="ld-in xs"
            style={{ width: 150 }}
            value={f.repeatOn ? (r.every > 1 ? "custom" : r.unit) : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return setF({ ...f, repeatOn: false });
              setF({ ...f, repeatOn: true, repeat: { ...r, unit: v === "custom" ? r.unit : (v as Repeat["unit"]), every: v === "custom" ? Math.max(2, r.every) : 1 } });
            }}
          >
            <option value="">Doesn't repeat</option>
            <option value="day">Every day</option>
            <option value="week">Every week</option>
            <option value="month">Every month</option>
            <option value="year">Every year</option>
            <option value="custom">Every few...</option>
          </select>
          {f.repeatOn && r.every > 1 && (
            <>
              <input className="ld-in xs" style={{ width: 60 }} aria-label="How many" inputMode="numeric" value={r.every} onChange={(e) => setR({ every: Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 1) })} />
              <select className="ld-in xs" style={{ width: 100 }} aria-label="Unit" value={r.unit} onChange={(e) => setR({ unit: e.target.value as Repeat["unit"] })}>
                <option value="day">days</option>
                <option value="week">weeks</option>
                <option value="month">months</option>
                <option value="year">years</option>
              </select>
            </>
          )}
          {f.repeatOn && r.unit === "week" && (
            <span className="gp-days" role="group" aria-label="Days of the week">
              {["S", "M", "T", "W", "T", "F", "S"].map((x, i) => {
                const on = (r.days ?? []).includes(i);
                return (
                  <button key={i} type="button" aria-pressed={on} aria-label={DAY[i]} className={on ? "on" : ""} onClick={() => setR({ days: on ? (r.days ?? []).filter((y) => y !== i) : [...(r.days ?? []), i].sort() })}>
                    {x}
                  </button>
                );
              })}
            </span>
          )}
        </span>
        {f.repeatOn && (
          <>
            <label htmlFor="te-mode">Make the next one</label>
            <span className="ld-row" style={{ flexWrap: "wrap" }}>
              <select id="te-mode" className="ld-in xs" style={{ width: 280 }} value={r.mode} onChange={(e) => setR({ mode: e.target.value as Repeat["mode"] })}>
                <option value="done">When this one is done</option>
                <option value="schedule">On schedule, even if this one is open</option>
              </select>
              <select className="ld-in xs" style={{ width: 170 }} aria-label="Ends" value={r.ends} onChange={(e) => setR({ ends: e.target.value as Repeat["ends"] })}>
                <option value="never">Never ends</option>
                <option value="date">Ends on a date</option>
                <option value="count">Ends after a number</option>
              </select>
              {r.ends === "date" && <input className="ld-in xs" style={{ width: 130 }} aria-label="Ends on (MM/DD/YYYY)" placeholder="MM/DD/YYYY" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} />}
              {r.ends === "count" && <input className="ld-in xs" style={{ width: 80 }} aria-label="How many times" inputMode="numeric" value={r.count ?? ""} onChange={(e) => setR({ count: Number(e.target.value.replace(/\D/g, "")) || undefined })} />}
            </span>
            <span>Next one keeps</span>
            <span className="ld-row ld-small" style={{ flexWrap: "wrap", gap: 14 }}>
              {(["subtasks", "checklist", "assignees", "comments"] as const).map((k) => (
                <label key={k} className="ld-row">
                  <input type="checkbox" className="gp-cbx" checked={r.keep[k]} onChange={(e) => setR({ keep: { ...r.keep, [k]: e.target.checked } })} /> {k[0].toUpperCase() + k.slice(1)}
                </label>
              ))}
            </span>
          </>
        )}
        <span>Assignees</span>
        <div className="gp-assign">
          {d.people.map((p) => (
            <label key={`${p.type}:${p.id}`} className="ld-row ld-small">
              <input type="checkbox" checked={has(p)} onChange={() => setF({ ...f, assignees: has(p) ? f.assignees.filter((a) => !(a.type === p.type && a.id === p.id)) : [...f.assignees, { type: p.type, id: p.id, name: p.name }] })} />
              <OwnerAvatar o={p} size={20} />
              {p.name}
              {p.type === "employee" ? <span className="ld-muted"> · starts on it</span> : null}
            </label>
          ))}
          {f.assignees.filter((a) => a.type === "name").map((a) => (
            <span key={a.name} className="ld-small ld-muted">{a.name} (from ClickUp)</span>
          ))}
        </div>
        <span>Watchers</span>
        <span className="ld-row" style={{ flexWrap: "wrap" }}>
          {f.watchers.map((w) => (
            <button key={`${w.type}:${w.id}`} type="button" className="gp-chip" aria-label={`Remove ${w.name}`} onClick={() => setF({ ...f, watchers: f.watchers.filter((x) => !(x.type === w.type && x.id === w.id)) })}>
              {w.name} ✕
            </button>
          ))}
          <select className="ld-in xs" style={{ width: 220 }} aria-label="Add a watcher" value="" onChange={(e) => {
            const p = d.people.find((x) => `${x.type}:${x.id}` === e.target.value);
            if (p) setF({ ...f, watchers: [...f.watchers, { type: p.type, id: p.id, name: p.name }] });
          }}>
            <option value="">Add a person or employee</option>
            {d.people.filter((p) => !f.watchers.some((w) => w.type === p.type && w.id === p.id)).map((p) => (
              <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
            ))}
          </select>
        </span>
        <label htmlFor="te-tags">Tags</label>
        <input id="te-tags" className="ld-in xs" placeholder="website, launch" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
        <label htmlFor="te-goal">Goal</label>
        <select id="te-goal" className="ld-in xs" value={f.goalId ?? ""} onChange={(e) => setF({ ...f, goalId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Not tied to a goal</option>
          {d.goals.map((g) => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
        {!t.parentId && (
          <>
            <label htmlFor="te-list">List</label>
            <select id="te-list" className="ld-in xs" value={f.listId} onChange={(e) => setF({ ...f, listId: Number(e.target.value) })}>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </>
        )}
        {d.list.fields.map((fd) => (
          <React.Fragment key={fd.id}>
            <span>{fd.name}</span>
            <FieldInput f={fd} value={f.fields[fd.id]} onChange={(v) => setF({ ...f, fields: { ...f.fields, [fd.id]: v } })} people={d.people} tasks={d.pickable} orgId={orgId} />
          </React.Fragment>
        ))}
        <label htmlFor="te-desc">Description</label>
        <textarea id="te-desc" className="ld-ta" rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
      <div className="gp-xsec">
        <b className="gp-sub-h ld-between">
          Waiting on and blocking
          <button type="button" className="gp-link" onClick={() => setF({ ...f, deps: [...f.deps, { kind: "waits", otherId: "" }] })}>+ Add</button>
        </b>
        {f.deps.map((x, i) => (
          <div key={i} className="gp-depedit">
            <select className="ld-in xs" aria-label="Kind" value={x.kind} onChange={(e) => setF({ ...f, deps: f.deps.map((y, k) => (k === i ? { ...y, kind: e.target.value as Dep["kind"], linkId: undefined } : y)) })}>
              <option value="waits">Waiting on</option>
              <option value="blocks">Blocking</option>
            </select>
            <select className="ld-in xs" aria-label="Task" value={x.otherId} onChange={(e) => setF({ ...f, deps: f.deps.map((y, k) => (k === i ? { ...y, otherId: e.target.value ? Number(e.target.value) : "", linkId: undefined } : y)) })}>
              <option value="">Pick a task</option>
              {d.pickable.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.listName ? ` (${p.listName})` : ""}</option>
              ))}
            </select>
            <button type="button" className="ld-btn sm" onClick={() => setF({ ...f, deps: f.deps.filter((_, k) => k !== i) })}>Remove</button>
          </div>
        ))}
        {!f.deps.length && <span className="ld-small ld-muted">Not waiting on anything.</span>}
      </div>
      <div className="gp-xsec">
        <b className="gp-sub-h">Add time</b>
        <div className="gp-addtime">
          <select className="ld-in xs" aria-label="Whose time" value={f.time.who || (me.data ? `user:${me.data.userId}` : "")} onChange={(e) => setF({ ...f, time: { ...f.time, who: e.target.value } })}>
            {d.people.map((p) => (
              <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
            ))}
          </select>
          <input className="ld-in xs" aria-label="Day (MM/DD/YYYY)" value={f.time.day} onChange={(e) => setF({ ...f, time: { ...f.time, day: e.target.value } })} />
          <input className="ld-in xs" aria-label="How long" placeholder="1h 30m" value={f.time.dur} onChange={(e) => setF({ ...f, time: { ...f.time, dur: e.target.value } })} />
          <input className="ld-in xs" aria-label="What it was" placeholder="What it was" value={f.time.note} onChange={(e) => setF({ ...f, time: { ...f.time, note: e.target.value } })} />
          <label className="ld-row ld-small"><input type="checkbox" checked={f.time.billable} onChange={(e) => setF({ ...f, time: { ...f.time, billable: e.target.checked } })} /> Billable</label>
        </div>
      </div>
      <ErrorLine error={err ? { message: err } : remove.error} />
      <div>
        <button
          type="button"
          className="ld-btn danger"
          disabled={remove.isPending}
          onClick={async () => {
            if (!window.confirm(`Delete "${t.name}"${d.subtasks.length ? ` and its ${d.subtasks.length} subtasks` : ""}?`)) return;
            await remove.mutateAsync({ organizationId: orgId, id: t.id });
            await utils.pj.view.invalidate();
            onClose();
          }}
        >
          Delete task
        </button>
      </div>
    </>
  );
}

function Activity({ orgId, d, onClose, panel }: { orgId: number; d: Detail; onClose: () => void; panel?: boolean }) {
  const utils = trpc.useUtils();
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  const [text, setText] = React.useState("");
  const [fileIds, setFileIds] = React.useState<number[]>([]);
  const canComment = RANK[d.level] >= RANK.comment;
  const send = trpc.pj.comment.useMutation({
    onSuccess: async () => {
      setText("");
      setFileIds([]);
      await utils.pj.task.invalidate();
    },
  });
  const acts = React.useRef<HTMLDivElement>(null);
  // The newest comment shows: only the activity box scrolls, never the page or the panel around it.
  React.useEffect(() => {
    if (acts.current) acts.current.scrollTop = acts.current.scrollHeight;
  }, [d.comments.length]);
  // An employee answers in a moment: look again shortly after a comment that names one.
  React.useEffect(() => {
    if (!send.isSuccess) return;
    const t = setTimeout(() => void utils.pj.task.invalidate(), 8000);
    return () => clearTimeout(t);
  }, [send.isSuccess, utils]);
  return (
    <div className="tmr">
      {preview && <FilePreview orgId={orgId} file={preview} onClose={() => setPreview(null)} />}
      <div className="ld-between" style={{ padding: "14px 16px", borderBottom: "1px solid #e3e9e6" }}>
        <b>Activity</b>
        {!panel && <button type="button" className="gp-x big" aria-label="Close" onClick={onClose}>×</button>}
      </div>
      <div className="gp-acts" ref={acts}>
        {d.comments.map((c) =>
          c.kind === "activity" ? (
            <div key={c.id} className="gp-act">
              {c.body} · {fmtAt(c.at)}
            </div>
          ) : (
            <div key={c.id} className="gp-tcm">
              <OwnerAvatar o={d.people.find((p) => p.type === c.authorType && p.id === c.authorId) ?? { type: "name", id: 0, name: c.authorName }} size={26} />
              <span style={{ minWidth: 0 }}>
                <b>{c.authorName}</b> <span className="ld-small ld-muted">{fmtAt(c.at)}</span>
                <span className="body">{c.body}</span>
                {c.files.length > 0 && <FileTiles files={c.files} cols={2} onOpen={setPreview} />}
              </span>
            </div>
          )
        )}
      </div>
      {canComment ? (
        <div className="gp-cbox">
          <textarea className="ld-ta" rows={3} aria-label="Comment" placeholder="Comment, or @mention a person or an employee" value={text} onChange={(e) => setText(e.target.value)} />
          <span className="ld-between">
            <span className="ld-row">
              <AddFiles orgId={orgId} label="Attach" onAdded={(ids) => setFileIds([...fileIds, ...ids])} />
              {fileIds.length > 0 && <span className="ld-small ld-muted">{fileIds.length} attached</span>}
            </span>
            <button type="button" className="ld-btn p sm" disabled={send.isPending || (!text.trim() && !fileIds.length)} onClick={() => send.mutate({ organizationId: orgId, taskId: d.task.id, body: text, fileIds })}>Comment</button>
          </span>
          <ErrorLine error={send.error} />
        </div>
      ) : (
        <div className="gp-cbox ld-small ld-muted">You can look at this list. Ask its owner to let you comment.</div>
      )}
    </div>
  );
}
