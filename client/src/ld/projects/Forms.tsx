import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt, Menu, OwnerAvatar } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";

/**
 * A form: questions at a public link; each answer becomes a task in the
 * form's list, fills the fields the questions point to, and goes to the
 * person or employee picked. Questions and Settings each have Edit.
 */

type F = Outputs["pj"]["form"];
type Q = F["form"]["questions"][number];
const TYPES: { v: Q["type"]; label: string }[] = [
  { v: "text", label: "Short answer" },
  { v: "longtext", label: "Long text" },
  { v: "email", label: "Email" },
  { v: "phone", label: "Phone" },
  { v: "number", label: "Number" },
  { v: "dropdown", label: "Dropdown" },
  { v: "labels", label: "Pick several" },
  { v: "date", label: "Date" },
  { v: "files", label: "Files" },
];
const typeLabel = (t: string) => TYPES.find((x) => x.v === t)?.label ?? t;

export function FormPage({ orgId, id, onPick, onOpenTask, refresh }: { orgId: number; id: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void; refresh: () => Promise<unknown> }) {
  const q = trpc.pj.form.useQuery({ organizationId: orgId, id });
  const [tab, setTab] = React.useState<"questions" | "answers">("questions");
  const [copied, setCopied] = React.useState(false);
  const remove = trpc.pj.removeForm.useMutation({ onSuccess: async () => { await refresh(); onPick({ scope: "everything" }); } });
  const d = q.data;
  if (!d) return <div className="gp-canvas"><ErrorLine error={q.error} />{q.isLoading && <span className="ld-muted">Opening the form</span>}</div>;
  const mapName = (m: string) => (m === "name" ? "Task name" : m === "description" ? "Task description" : m === "due" ? "Due date" : m === "attachments" ? "Attachments" : m.startsWith("field:") ? `Custom field: ${d.fields.find((f) => f.id === m.slice(6))?.name ?? "removed"}` : "Not saved to the task");
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 0 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>
            {d.form.folderName && <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>{d.form.folderName} /</span>}
            {d.form.title}
            {!d.form.active && <span className="gp-chip">Off</span>}
          </span>
          <span className="ld-row">
            <a className="ld-btn" href={d.form.link} target="_blank" rel="noreferrer">Preview</a>
            <button
              type="button"
              className="ld-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(d.form.link);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <Menu label="Form options">
              {(close) => (
                <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete "${d.form.title}" and its answers? Tasks it made stay.`)) remove.mutate({ organizationId: orgId, id }); close(); }}>Delete form</button>
              )}
            </Menu>
          </span>
        </div>
        <div className="gp-views" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "questions"} className={`gp-vw ${tab === "questions" ? "on" : ""}`} onClick={() => setTab("questions")}>Questions</button>
          <button type="button" role="tab" aria-selected={tab === "answers"} className={`gp-vw ${tab === "answers" ? "on" : ""}`} onClick={() => setTab("answers")}>Answers ({d.answers})</button>
        </div>
      </div>
      <div className="gp-canvas">
        <ErrorLine error={remove.error} />
        {tab === "questions" ? (
          <div className="gp-form2">
            <Questions orgId={orgId} d={d} mapName={mapName} refresh={() => q.refetch()} />
            <Settings orgId={orgId} d={d} refresh={() => q.refetch()} />
          </div>
        ) : (
          <Answers orgId={orgId} id={id} onOpenTask={onOpenTask} />
        )}
      </div>
    </>
  );
}

function Questions({ orgId, d, mapName, refresh }: { orgId: number; d: F; mapName: (m: string) => string; refresh: () => void }) {
  const [edit, setEdit] = React.useState<(Q & { opts: string })[] | null>(null);
  const [drag, setDrag] = React.useState<number | null>(null);
  const save = trpc.pj.saveForm.useMutation({ onSuccess: () => { setEdit(null); refresh(); } });
  const maps = [
    { v: "name", label: "Task name" },
    { v: "description", label: "Task description" },
    { v: "due", label: "Due date" },
    { v: "attachments", label: "Attachments" },
    ...d.fields.map((f) => ({ v: `field:${f.id}`, label: `Custom field: ${f.name}` })),
  ];
  if (!edit)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
        <div className="ld-between">
          <b>Questions</b>
          <button type="button" className="ld-btn sm" onClick={() => setEdit(d.form.questions.map((x) => ({ ...x, opts: (x.options ?? []).join(", ") })))}>Edit</button>
        </div>
        {d.form.questions.map((x) => (
          <div key={x.id} className="gp-ff">
            <span style={{ minWidth: 0 }}>
              <b>{x.label}</b>
              {x.required && <span className="ld-small" style={{ color: "#b42318" }}> *</span>}
              <span className="ld-small ld-muted"> · {typeLabel(x.type)}{x.options?.length ? `: ${x.options.join(", ")}` : ""}</span>
            </span>
            <span className="ld-small ld-muted">→ {mapName(x.mapTo)}</span>
          </div>
        ))}
        {!d.form.questions.length && <span className="ld-small ld-muted">No questions yet.</span>}
      </div>
    );
  const put = (i: number, patch: Partial<Q & { opts: string }>) => setEdit(edit.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div className="ld-between">
        <b>Questions</b>
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => setEdit(null)}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, id: d.form.id, title: d.form.title, questions: edit.map(({ opts, ...x }) => ({ ...x, options: x.type === "dropdown" || x.type === "labels" ? opts.split(",").map((o) => o.trim()).filter(Boolean) : undefined })) })}>Save</button>
        </span>
      </div>
      {edit.map((x, i) => (
        <div
          key={x.id}
          className={`gp-ff edit ${drag === i ? "on" : ""}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (drag === null || drag === i) return;
            const next = edit.slice();
            const [m] = next.splice(drag, 1);
            next.splice(i, 0, m);
            setEdit(next);
            setDrag(null);
          }}
        >
          <span className="hd" aria-hidden="true">⋮⋮</span>
          <input className="ld-in xs lbl" aria-label="Question" placeholder="Question" value={x.label} onChange={(e) => put(i, { label: e.target.value })} />
          <select className="ld-in xs" aria-label="Kind of answer" value={x.type} onChange={(e) => put(i, { type: e.target.value as Q["type"] })}>
            {TYPES.map((t) => (
              <option key={t.v} value={t.v}>{t.label}</option>
            ))}
          </select>
          <select className="ld-in xs" aria-label="Saves to" value={x.mapTo} onChange={(e) => put(i, { mapTo: e.target.value })}>
            {maps.map((m) => (
              <option key={m.v} value={m.v}>{m.label}</option>
            ))}
          </select>
          <label className="ld-row ld-small"><input type="checkbox" checked={x.required} onChange={(e) => put(i, { required: e.target.checked })} /> Required</label>
          <button type="button" className="ld-btn sm" onClick={() => setEdit(edit.filter((_, k) => k !== i))}>Remove</button>
          {(x.type === "dropdown" || x.type === "labels") && <input className="ld-in xs opts" aria-label="Choices, separated by commas" placeholder="Choices, separated by commas" value={x.opts} onChange={(e) => put(i, { opts: e.target.value })} />}
        </div>
      ))}
      <button type="button" className="gp-addrow" onClick={() => setEdit([...edit, { id: `q${Date.now().toString(36)}`, label: "", type: "text", required: false, mapTo: "description", opts: "" }])}>+ Add a question</button>
      <ErrorLine error={save.error} />
    </div>
  );
}

function Settings({ orgId, d, refresh }: { orgId: number; d: F; refresh: () => void }) {
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: false });
  const save = trpc.pj.saveForm.useMutation({ onSuccess: () => { setEdit(null); refresh(); } });
  const [edit, setEdit] = React.useState<null | { listId: number | null; status: string; assignTo: string; ask: string; thanks: string; intro: string; active: boolean; title: string }>(null);
  const s = d.form.settings;
  const who = d.assignee;
  if (!edit)
    return (
      <div className="gp-gl" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <b>Settings</b>
        <div className="gp-kv">
          <b>Makes tasks in</b>
          <span>{d.form.listName ? `${d.form.folderName ? `${d.form.folderName} / ` : ""}${d.form.listName}` : <span className="ld-muted">Pick a list</span>}</span>
          <b>Status</b>
          <span>{s.status || d.statuses[0]?.name || "The list's first status"}</span>
          <b>Assign to</b>
          <span className="ld-row">{who ? <><OwnerAvatar o={who} size={22} /> {who.name}</> : <span className="ld-muted">No one</span>}</span>
          {who?.type === "employee" && (
            <>
              <b>Then</b>
              <span>{s.ask || <span className="ld-muted">{who.name} is assigned and starts on it</span>}</span>
            </>
          )}
          <b>At the top</b>
          <span>{s.intro || <span className="ld-muted">Nothing</span>}</span>
          <b>After sending</b>
          <span>"{s.thanks || "Thanks. We got it."}"</span>
          <b>Public link</b>
          <span>{d.form.active ? "On" : "Off"}</span>
          <b>Answers</b>
          <span>{d.answers} so far</span>
        </div>
        <button type="button" className="ld-btn" style={{ alignSelf: "flex-start" }} onClick={() => setEdit({ listId: d.form.listId, status: s.status, assignTo: s.assignTo, ask: s.ask, thanks: s.thanks, intro: s.intro, active: d.form.active, title: d.form.title })}>Edit</button>
      </div>
    );
  const statuses = v.data?.lists.find((l) => l.id === edit.listId)?.statuses ?? [];
  const isEmp = edit.assignTo.startsWith("employee:");
  return (
    <div className="gp-gl" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="ld-between">
        <b>Settings</b>
        <span className="ld-row">
          <button type="button" className="ld-btn sm" onClick={() => setEdit(null)}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={save.isPending || !edit.title.trim()} onClick={() => save.mutate({ organizationId: orgId, id: d.form.id, title: edit.title, listId: edit.listId, active: edit.active, settings: { intro: edit.intro, status: edit.status, assignTo: edit.assignTo, ask: isEmp ? edit.ask : "", thanks: edit.thanks } })}>Save</button>
        </span>
      </div>
      <div className="gp-xedit" style={{ gridTemplateColumns: "120px minmax(0,1fr)" }}>
        <label htmlFor="fs-title">Name</label>
        <input id="fs-title" className="ld-in xs" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        <label htmlFor="fs-list">Makes tasks in</label>
        <select id="fs-list" className="ld-in xs" value={edit.listId ?? ""} onChange={(e) => setEdit({ ...edit, listId: e.target.value ? Number(e.target.value) : null, status: "" })}>
          <option value="">Pick a list</option>
          {d.lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        <label htmlFor="fs-st">Status</label>
        <select id="fs-st" className="ld-in xs" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
          <option value="">The list's first status</option>
          {statuses.map((x) => (
            <option key={x.name} value={x.name}>{x.name}</option>
          ))}
        </select>
        <label htmlFor="fs-who">Assign to</label>
        <select id="fs-who" className="ld-in xs" value={edit.assignTo} onChange={(e) => setEdit({ ...edit, assignTo: e.target.value })}>
          <option value="">No one</option>
          {d.people.map((p) => (
            <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}{p.type === "employee" ? " (AI employee)" : ""}</option>
          ))}
        </select>
        {isEmp && (
          <>
            <label htmlFor="fs-ask">Then</label>
            <textarea id="fs-ask" className="ld-ta" rows={2} placeholder="Reply within an hour and book a demo" value={edit.ask} onChange={(e) => setEdit({ ...edit, ask: e.target.value })} />
          </>
        )}
        <label htmlFor="fs-intro">At the top</label>
        <textarea id="fs-intro" className="ld-ta" rows={2} placeholder="25 seats at $299 a month. Tell us about your practice." value={edit.intro} onChange={(e) => setEdit({ ...edit, intro: e.target.value })} />
        <label htmlFor="fs-thanks">After sending</label>
        <input id="fs-thanks" className="ld-in xs" value={edit.thanks} onChange={(e) => setEdit({ ...edit, thanks: e.target.value })} />
        <label htmlFor="fs-on">Public link</label>
        <select id="fs-on" className="ld-in xs" value={edit.active ? "on" : "off"} onChange={(e) => setEdit({ ...edit, active: e.target.value === "on" })}>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
      <ErrorLine error={save.error} />
    </div>
  );
}

function Answers({ orgId, id, onOpenTask }: { orgId: number; id: number; onOpenTask: (id: number) => void }) {
  const q = trpc.pj.formAnswers.useQuery({ organizationId: orgId, id });
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <div className="gp-gl" style={{ flex: 1 }}>
      {q.data?.map((a) => (
        <React.Fragment key={a.id}>
          <button type="button" className={`gp-ans ${open === a.id ? "on" : ""}`} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
            <b className="gp-ell">{a.items[0]?.value || "Answer"}</b>
            <span className="ld-small ld-muted gp-ell">{a.items.slice(1, 3).map((x) => x.value).filter(Boolean).join(" · ")}</span>
            <span className="ld-small ld-muted">{fmtAt(a.at)}</span>
            <span className="ld-small">{a.task ? a.task.status : "No task"}</span>
          </button>
          {open === a.id && (
            <div className="gp-ans-open">
              <div className="gp-kv">
                {a.items.map((x) => (
                  <React.Fragment key={x.label}>
                    <b>{x.label}</b>
                    <span>{x.value || <span className="ld-muted">No answer</span>}</span>
                  </React.Fragment>
                ))}
              </div>
              {a.task && <button type="button" className="ld-btn sm" onClick={() => onOpenTask(a.task!.id)}>Open task</button>}
            </div>
          )}
        </React.Fragment>
      ))}
      {q.data && !q.data.length && <div className="gp-empty">No answers yet. Copy the link and share it.</div>}
      <ErrorLine error={q.error} />
    </div>
  );
}
