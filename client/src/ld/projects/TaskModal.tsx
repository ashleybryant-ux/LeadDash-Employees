import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { AddFiles, fmtAt, fmtYmd, FileTiles, OwnerAvatar } from "../goals/shared";
import { Flag, PRIORITY_TEXT, StatusTag } from "./bits";
import type { Outputs } from "../types";

/**
 * A task, opened over the page: read view with an Edit button (Edit opens
 * every field, then Save or Cancel), subtasks, checklist, attachments, and
 * the activity with comments. @ a person or an employee in a comment.
 */

type Detail = Outputs["pj"]["task"];
type Assignee = Detail["task"]["assignees"][number];

export function TaskModal({ orgId, id, onClose, onOpen }: { orgId: number; id: number; onClose: () => void; onOpen: (id: number) => void }) {
  const q = trpc.pj.task.useQuery({ organizationId: orgId, id });
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => setEditing(false), [id]);
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [editing, onClose]);
  const d = q.data;
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
            <div className="tml">{editing ? <EditTask orgId={orgId} d={d} onDone={() => setEditing(false)} onClose={onClose} /> : <ReadTask orgId={orgId} d={d} onEdit={() => setEditing(true)} onOpen={onOpen} />}</div>
            <Activity orgId={orgId} d={d} onClose={onClose} />
          </>
        )}
      </div>
    </div>
  );
}

function ReadTask({ orgId, d, onEdit, onOpen }: { orgId: number; d: Detail; onEdit: () => void; onOpen: (id: number) => void }) {
  const utils = trpc.useUtils();
  const t = d.task;
  const refresh = () => Promise.all([utils.pj.task.invalidate(), utils.pj.view.invalidate(), utils.pj.tree.invalidate()]);
  const up = trpc.pj.update.useMutation({ onSuccess: refresh });
  const create = trpc.pj.create.useMutation({ onSuccess: refresh });
  const attach = trpc.goals.attach.useMutation({ onSuccess: refresh });
  const detach = trpc.goals.detach.useMutation({ onSuccess: refresh });
  const [sub, setSub] = React.useState("");
  const [item, setItem] = React.useState("");
  const status = d.list.statuses.find((s) => s.name === t.status);
  const doneStatus = d.list.statuses.find((s) => s.type === "done") ?? d.list.statuses.find((s) => s.type === "closed");
  const person = (a: Assignee) => d.people.find((p) => p.type === a.type && p.id === a.id) ?? { type: "name" as const, id: 0, name: a.name };
  const fieldText = (f: Detail["list"]["fields"][number]) => {
    const v = t.fields[f.id];
    if (v === undefined || v === null || v === "") return null;
    if (f.type === "dropdown") {
      const o = f.options?.find((x) => x.id === v);
      return o ? <StatusTag name={o.name} color={o.color} /> : null;
    }
    if (f.type === "date") return fmtYmd(String(v));
    if (f.type === "checkbox") return v ? "Yes" : "No";
    if (f.type === "money") return `$${Number(v).toLocaleString("en-US")}`;
    return String(v);
  };
  return (
    <>
      <div className="ld-small ld-muted">
        {[d.list.folderName, d.list.name].filter(Boolean).join(" / ")}
        {d.parent && (
          <>
            {" / "}
            <button type="button" className="gp-link" onClick={() => onOpen(d.parent!.id)}>{d.parent.name}</button>
          </>
        )}
      </div>
      <div className="ld-row" style={{ flexWrap: "wrap" }}>
        <StatusTag name={t.status} color={status?.color ?? "#87909e"} />
        {t.priority && <Flag p={t.priority} />}
        {t.goal && <span className="gp-chip">◎ {t.goal}</span>}
        <span style={{ marginLeft: "auto" }} className="ld-row">
          {doneStatus && t.status !== doneStatus.name && (
            <button type="button" className="ld-btn sm" disabled={up.isPending} onClick={() => up.mutate({ organizationId: orgId, id: t.id, patch: { status: doneStatus.name } })}>Mark done</button>
          )}
          <button type="button" className="ld-btn sm" onClick={onEdit}>Edit</button>
        </span>
      </div>
      <h2 className="gp-tt">{t.name}</h2>
      <div className="gp-tf2">
        <span>Assignees</span>
        <span className="ld-row" style={{ flexWrap: "wrap" }}>
          {t.assignees.length ? t.assignees.map((a) => (
            <span key={`${a.type}:${a.id}:${a.name}`} className="ld-row">
              <OwnerAvatar o={person(a)} size={24} />
              {a.name}
            </span>
          )) : <span className="ld-muted">Unassigned</span>}
        </span>
        <span>Due date</span>
        <span>{t.dueDate ? fmtYmd(t.dueDate) : <span className="ld-muted">None</span>}</span>
        <span>Start date</span>
        <span>{t.startDate ? fmtYmd(t.startDate) : <span className="ld-muted">None</span>}</span>
        <span>Time estimate</span>
        <span>{t.timeEstimate ? `${Math.round((t.timeEstimate / 60) * 10) / 10} hours` : <span className="ld-muted">None</span>}</span>
        <span>Priority</span>
        <span>{t.priority ? PRIORITY_TEXT[t.priority] : <span className="ld-muted">None</span>}</span>
        <span>Tags</span>
        <span>{t.tags.length ? t.tags.map((x) => <span key={x} className="gp-chip" style={{ marginRight: 4 }}>{x}</span>) : <span className="ld-muted">None</span>}</span>
        {d.list.fields.map((f) => (
          <React.Fragment key={f.id}>
            <span>{f.name}</span>
            <span>{fieldText(f) ?? <span className="ld-muted">None</span>}</span>
          </React.Fragment>
        ))}
      </div>
      <div>
        <b className="gp-sub-h">Description</b>
        {d.task.description ? <p className="gp-desc">{d.task.description}</p> : <span className="ld-small ld-muted">No description.</span>}
      </div>
      {!t.parentId && (
        <div>
          <b className="gp-sub-h">Subtasks {d.subtasks.length ? `${d.subtasks.filter((s) => s.closed).length} of ${d.subtasks.length}` : ""}</b>
          {d.subtasks.map((s) => (
            <div key={s.id} className="gp-sub" style={{ gridTemplateColumns: "24px minmax(0,1fr) 120px 110px" }}>
              <button
                type="button"
                className={`gp-ck ${s.closed ? "on" : ""}`}
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
          <div className="ld-row" style={{ marginTop: 6 }}>
            <input className="ld-in xs" aria-label="New subtask" placeholder="Add a subtask, then Enter" value={sub} onChange={(e) => setSub(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && sub.trim()) { create.mutate({ organizationId: orgId, listId: d.list.id, parentId: t.id, name: sub }); setSub(""); } }} />
          </div>
        </div>
      )}
      <div>
        <b className="gp-sub-h">Checklist {d.task.checklistItems.length ? `${d.task.checklistItems.filter((x) => x.done).length} of ${d.task.checklistItems.length}` : ""}</b>
        {d.task.checklistItems.map((x, i) => (
          <label key={i} className="gp-cl">
            <input type="checkbox" checked={x.done} onChange={() => up.mutate({ organizationId: orgId, id: t.id, patch: { checklist: d.task.checklistItems.map((y, k) => (k === i ? { ...y, done: !y.done } : y)) } })} />
            <span style={x.done ? { textDecoration: "line-through", color: "#5b6b64" } : undefined}>{x.text}</span>
          </label>
        ))}
        <input className="ld-in xs" aria-label="New checklist item" placeholder="Add an item, then Enter" value={item} onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && item.trim()) { up.mutate({ organizationId: orgId, id: t.id, patch: { checklist: [...d.task.checklistItems, { text: item.trim(), done: false }] } }); setItem(""); } }} />
      </div>
      <div>
        <b className="gp-sub-h ld-between">
          Attachments
          <AddFiles orgId={orgId} label="Drop files here · + Add" onAdded={(ids) => attach.mutate({ organizationId: orgId, itemType: "task", itemId: t.id, fileIds: ids })} />
        </b>
        <DropZone orgId={orgId} onAdded={(ids) => attach.mutate({ organizationId: orgId, itemType: "task", itemId: t.id, fileIds: ids })}>
          {d.files.length ? <FileTiles files={d.files} onRemove={(f) => f.linkId && detach.mutate({ organizationId: orgId, linkId: f.linkId })} /> : <span className="ld-small ld-muted">No files yet. Drop files here.</span>}
        </DropZone>
      </div>
      <ErrorLine error={up.error || create.error || attach.error || detach.error} />
    </>
  );
}

/** Files dropped on the attachments area upload and attach. */
function DropZone({ orgId, onAdded, children }: { orgId: number; onAdded: (ids: number[]) => void; children: React.ReactNode }) {
  const [over, setOver] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  return (
    <div
      className={`gp-drop ${over ? "over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
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

function EditTask({ orgId, d, onDone, onClose }: { orgId: number; d: Detail; onDone: () => void; onClose: () => void }) {
  const utils = trpc.useUtils();
  const t = d.task;
  const tree = trpc.pj.tree.useQuery({ organizationId: orgId });
  const up = trpc.pj.update.useMutation();
  const remove = trpc.pj.remove.useMutation();
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
    fields: { ...t.fields } as Record<string, unknown>,
  }));
  const [err, setErr] = React.useState<string | null>(null);
  const lists = [...(tree.data?.folders ?? []).flatMap((fo) => fo.lists.map((l) => ({ id: l.id, name: `${fo.name} › ${l.name}` }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name }))];
  const has = (p: { type: string; id: number; name: string }) => f.assignees.some((a) => a.type === p.type && a.id === p.id);
  const save = async () => {
    setErr(null);
    const startDate = fromMdy(f.start);
    const dueDate = fromMdy(f.due);
    if (startDate === undefined || dueDate === undefined) return setErr("Type dates as MM/DD/YYYY.");
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
          fields: f.fields,
          ...(f.listId !== d.list.id ? { listId: f.listId } : {}),
        },
      });
      await Promise.all([utils.pj.task.invalidate(), utils.pj.view.invalidate(), utils.pj.tree.invalidate()]);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <div className="ld-between">
        <b>Edit task</b>
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={up.isPending} onClick={save}>{up.isPending ? "Saving" : "Save"}</button>
        </span>
      </div>
      <div className="gp-form" style={{ padding: 0 }}>
        <label>Name</label>
        <input className="ld-in" aria-label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <label>Status</label>
        <select className="ld-in xs" aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          {d.list.statuses.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <label>Priority</label>
        <select className="ld-in xs" aria-label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as typeof f.priority })}>
          <option value="">None</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <label>Dates</label>
        <span className="ld-row">
          <input className="ld-in xs" aria-label="Start date (MM/DD/YYYY)" placeholder="Start MM/DD/YYYY" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          <input className="ld-in xs" aria-label="Due date (MM/DD/YYYY)" placeholder="Due MM/DD/YYYY" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        </span>
        <label>Time estimate</label>
        <span className="ld-row">
          <input className="ld-in xs" style={{ width: 90 }} aria-label="Hours" inputMode="decimal" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value.replace(/[^\d.]/g, "") })} />
          <span className="ld-small ld-muted">hours</span>
        </span>
        <label>Assignees</label>
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
        <label>Tags</label>
        <input className="ld-in xs" aria-label="Tags, separated by commas" placeholder="website, launch" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
        <label>Goal</label>
        <select className="ld-in xs" aria-label="Goal" value={f.goalId ?? ""} onChange={(e) => setF({ ...f, goalId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Not tied to a goal</option>
          {d.goals.map((g) => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
        {!t.parentId && (
          <>
            <label>List</label>
            <select className="ld-in xs" aria-label="List" value={f.listId} onChange={(e) => setF({ ...f, listId: Number(e.target.value) })}>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </>
        )}
        {d.list.fields.map((fd) => (
          <React.Fragment key={fd.id}>
            <label>{fd.name}</label>
            {fd.type === "dropdown" ? (
              <select className="ld-in xs" aria-label={fd.name} value={String(f.fields[fd.id] ?? "")} onChange={(e) => setF({ ...f, fields: { ...f.fields, [fd.id]: e.target.value || null } })}>
                <option value="">None</option>
                {fd.options?.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            ) : fd.type === "checkbox" ? (
              <input type="checkbox" aria-label={fd.name} checked={!!f.fields[fd.id]} onChange={(e) => setF({ ...f, fields: { ...f.fields, [fd.id]: e.target.checked } })} />
            ) : (
              <input className="ld-in xs" aria-label={fd.name} placeholder={fd.type === "date" ? "MM/DD/YYYY" : ""} value={fd.type === "date" ? toMdy(String(f.fields[fd.id] ?? "")) || String(f.fields[fd.id] ?? "") : String(f.fields[fd.id] ?? "")} onChange={(e) => setF({ ...f, fields: { ...f.fields, [fd.id]: fd.type === "number" || fd.type === "money" ? (e.target.value === "" ? null : Number(e.target.value.replace(/[^\d.-]/g, ""))) : fd.type === "date" ? fromMdy(e.target.value) ?? e.target.value : e.target.value } })} />
            )}
          </React.Fragment>
        ))}
        <label>Description</label>
        <textarea className="ld-ta" rows={5} aria-label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
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

function Activity({ orgId, d, onClose }: { orgId: number; d: Detail; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [text, setText] = React.useState("");
  const [fileIds, setFileIds] = React.useState<number[]>([]);
  const send = trpc.pj.comment.useMutation({
    onSuccess: async () => {
      setText("");
      setFileIds([]);
      await utils.pj.task.invalidate();
    },
  });
  const end = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => end.current?.scrollIntoView({ block: "end" }), [d.comments.length]);
  // An employee answers in a moment: look again shortly after a comment that names one.
  React.useEffect(() => {
    if (!send.isSuccess) return;
    const t = setTimeout(() => void utils.pj.task.invalidate(), 8000);
    return () => clearTimeout(t);
  }, [send.isSuccess, utils]);
  return (
    <div className="tmr">
      <div className="ld-between" style={{ padding: "14px 16px", borderBottom: "1px solid #e3e9e6" }}>
        <b>Activity</b>
        <button type="button" className="gp-x big" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="gp-acts">
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
                {c.files.length > 0 && <FileTiles files={c.files} cols={2} />}
              </span>
            </div>
          )
        )}
        <div ref={end} />
      </div>
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
    </div>
  );
}
