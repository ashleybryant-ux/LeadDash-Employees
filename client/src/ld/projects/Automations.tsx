import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import type { PjCtx } from "../pages/Projects";
import type { Outputs } from "../types";

/**
 * Automations: when something happens to a task (or on a schedule), do
 * something. Each rule reads as a sentence with Edit and Remove; the editor
 * picks When, Then, the details, and which lists it covers.
 */

type Auto = Outputs["pj"]["automations"][number];
type Trigger = Auto["trigger"];
type Action = Auto["action"];
type Rule = { id?: number; trigger: Trigger; action: Action; active: boolean; scope: "list" | "folder" | "all" };

const WHEN: { on: Trigger["on"]; label: string }[] = [
  { on: "created", label: "A task is made" },
  { on: "status", label: "A task moves to a status" },
  { on: "due", label: "A due date arrives" },
  { on: "overdue", label: "A task becomes overdue" },
  { on: "field", label: "A field changes" },
  { on: "assigned", label: "A task is assigned" },
  { on: "comment", label: "A comment is added" },
  { on: "subtasks", label: "All subtasks are done" },
  { on: "unblocked", label: "A task is unblocked" },
  { on: "form", label: "A form answer comes in" },
  { on: "schedule", label: "On a schedule" },
];
const THEN: { do: Action["do"]; label: string }[] = [
  { do: "assign", label: "Assign someone" },
  { do: "priority", label: "Set priority" },
  { do: "status", label: "Move to a status" },
  { do: "field", label: "Set a field" },
  { do: "watcher", label: "Add a watcher" },
  { do: "comment", label: "Add a note" },
  { do: "task", label: "Make a task (or use a template)" },
  { do: "move", label: "Move to another list" },
  { do: "ask", label: "Ask an employee to start on it" },
  { do: "notify", label: "Notify someone" },
  { do: "chat", label: "Post in the Team chat" },
  { do: "email", label: "Send an email" },
  { do: "meeting", label: "Add to the meeting topics" },
];
const SCHEDULED_OK: Action["do"][] = ["task", "chat", "notify", "email", "meeting"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function Automations({ c, onClose }: { c: PjCtx; onClose: () => void }) {
  const tree = trpc.pj.tree.useQuery({ organizationId: c.orgId });
  const templates = trpc.pj.templates.useQuery({ organizationId: c.orgId });
  const folderId = c.data.list?.folderId ?? null;
  const [view, setView] = React.useState<"here" | "all">(c.listId ? "here" : "all");
  const q = trpc.pj.automations.useQuery({ organizationId: c.orgId, listId: null, all: true });
  const save = trpc.pj.saveAutomation.useMutation({ onSuccess: () => { setEdit(null); void q.refetch(); } });
  const remove = trpc.pj.removeAutomation.useMutation({ onSuccess: () => void q.refetch() });
  const [edit, setEdit] = React.useState<Rule | null>(null);
  const lists = [...(tree.data?.folders ?? []).flatMap((f) => f.lists.map((l) => ({ id: l.id, name: l.name, folderId: f.id }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name, folderId: null as number | null }))];
  const forms = [...(tree.data?.folders ?? []).flatMap((f) => f.items), ...(tree.data?.looseItems ?? [])].filter((i) => i.kind === "form");
  const statuses = c.data.list?.statuses ?? c.data.statuses;
  const fields = c.data.list?.fields ?? [];
  const who = (v: string) => c.data.people.find((p) => `${p.type}:${p.id}` === v.split("|")[0])?.name ?? "someone";
  const scopeText = (a: Auto) => (a.listId ? lists.find((l) => l.id === a.listId)?.name ?? "a list" : a.folderId ? `every list in ${tree.data?.folders.find((f) => f.id === a.folderId)?.name ?? "a folder"}` : "every list");
  const fieldName = (id?: string) => fields.find((f) => f.id === id)?.name ?? "a field";
  const optName = (fid?: string, v?: string) => fields.find((f) => f.id === fid)?.options?.find((o) => o.id === v)?.name ?? v ?? "";
  const whenText = (t: Trigger) =>
    ({
      created: "When a task is made",
      status: `When a task moves to ${t.to || "any status"}`,
      due: "When a due date arrives and the task is open",
      overdue: "When a task becomes overdue",
      field: `When ${fieldName(t.field)} changes${t.to ? ` to ${optName(t.field, t.to)}` : ""}`,
      assigned: "When a task is assigned",
      comment: "When a comment is added",
      subtasks: "When all subtasks are done",
      unblocked: "When a task waiting on others is unblocked",
      form: `When ${forms.find((f) => f.id === t.formId)?.name ?? "a form"} gets an answer`,
      schedule: `${t.every === "weekday" ? "Every weekday" : t.every === "week" ? `Every ${DAYS[t.day ?? 1]}` : "Every day"} at ${fmtTime(t.time ?? "09:00")}`,
    })[t.on];
  const thenText = (a: Action) =>
    ({
      assign: `assign ${who(a.value)}`,
      priority: `set the priority to ${a.value}`,
      status: `move it to ${a.value}`,
      field: `set ${fieldName(a.field)} to ${optName(a.field, a.value)}`,
      watcher: `add ${who(a.value)} as a watcher`,
      comment: `add the note "${a.value}"`,
      task: `make the task "${a.value || templates.data?.find((x) => x.id === a.templateId)?.name || "a task"}"${a.templateId ? " from its template" : ""}${a.listId ? ` in ${lists.find((l) => l.id === a.listId)?.name ?? "a list"}` : ""}`,
      move: `move it to ${lists.find((l) => l.id === a.listId)?.name ?? "another list"}`,
      ask: `ask ${who(a.value)} to start on it`,
      notify: `notify ${who(a.value)}`,
      chat: `post "${a.value}" in the Team chat`,
      email: `email ${a.to && a.to !== "assignees" ? a.to : "the assignees"}`,
      meeting: "add it to this week's meeting topics",
    })[a.do];
  const shown = (q.data ?? []).filter((a) => view === "all" || a.listId === c.listId || (!a.listId && (a.folderId === null || a.folderId === folderId)));
  const startNew = () => setEdit({ trigger: { on: "status", to: statuses[statuses.length - 1]?.name ?? "" }, action: { do: "assign", value: "" }, active: true, scope: c.listId ? "list" : "all" });
  const submit = (r: Rule) => {
    const listId = r.scope === "list" ? c.listId : null;
    const fid = r.scope === "folder" ? folderId : null;
    save.mutate({ organizationId: c.orgId, id: r.id, listId, folderId: fid, trigger: r.trigger, action: r.action, active: r.active });
  };
  const needsValue = (a: Action) => (a.do === "meeting" ? false : a.do === "task" ? !(a.value.trim() || a.templateId) : a.do === "move" ? !a.listId : a.do === "notify" ? !a.value.split("|")[0] : !a.value.trim());
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Automations">
      <div className="gp-mbox wide">
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>Automations</b>
          <span className="ld-row">
            {c.listId && (
              <select className="gp-fb sel" aria-label="Show" value={view} onChange={(e) => setView(e.target.value as "here" | "all")}>
                <option value="here">For {c.data.list?.name}</option>
                <option value="all">Every list</option>
              </select>
            )}
            {!edit && <button type="button" className="ld-btn" onClick={startNew}>Add</button>}
            <button type="button" className="ld-btn" onClick={onClose}>Close</button>
          </span>
        </div>
        <div style={{ padding: "6px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {edit && (
            <div className="gp-gl" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="ld-between">
                <b>{edit.id ? "Edit automation" : "New automation"}</b>
                <span className="ld-row">
                  <button type="button" className="ld-btn" onClick={() => setEdit(null)}>Cancel</button>
                  <button type="button" className="ld-btn p" disabled={save.isPending || needsValue(edit.action)} onClick={() => submit(edit)}>Save</button>
                </span>
              </div>
              <div className="gp-auto-grid">
                <div className="gp-pick" role="radiogroup" aria-label="When">
                  <span className="h">When</span>
                  {WHEN.map((w) => (
                    <button key={w.on} type="button" role="radio" aria-checked={edit.trigger.on === w.on} className={edit.trigger.on === w.on ? "on" : ""} onClick={() => setEdit({ ...edit, trigger: { on: w.on, ...(w.on === "schedule" ? { every: "day", time: "09:00" } : {}) }, action: w.on === "schedule" && !SCHEDULED_OK.includes(edit.action.do) ? { do: "chat", value: "" } : edit.action })}>
                      {w.label}
                    </button>
                  ))}
                </div>
                <div className="gp-pick" role="radiogroup" aria-label="Then">
                  <span className="h">Then</span>
                  {THEN.filter((t) => edit.trigger.on !== "schedule" || SCHEDULED_OK.includes(t.do)).map((t) => (
                    <button key={t.do} type="button" role="radio" aria-checked={edit.action.do === t.do} className={edit.action.do === t.do ? "on" : ""} onClick={() => setEdit({ ...edit, action: { do: t.do, value: "" } })}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="gp-xedit" style={{ alignContent: "start" }}>
                  <TriggerFields r={edit} set={setEdit} statuses={statuses} fields={fields} forms={forms} />
                  <ActionFields r={edit} set={setEdit} c={c} statuses={statuses} fields={fields} lists={lists} templates={(templates.data ?? []).filter((t) => t.kind === "task")} />
                  <label htmlFor="au-scope">Only for</label>
                  <select id="au-scope" className="ld-in xs" value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value as Rule["scope"] })}>
                    {c.listId && <option value="list">{c.data.list?.name}</option>}
                    {folderId && <option value="folder">Every list in {c.data.list?.folderName}</option>}
                    <option value="all">Every list</option>
                  </select>
                  <label htmlFor="au-on">Status</label>
                  <select id="au-on" className="ld-in xs" value={edit.active ? "on" : "off"} onChange={(e) => setEdit({ ...edit, active: e.target.value === "on" })}>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </div>
              </div>
              <span className="ld-small ld-muted">In notes, posts and emails, {"{task}"}, {"{assignees}"}, {"{list}"} and {"{due}"} fill in from the task.</span>
              <ErrorLine error={save.error} />
            </div>
          )}
          <div className="gp-gl">
            {shown.map((a) => (
              <div key={a.id} className="gp-rule">
                <span>
                  <span className="tg">{a.active ? "On" : "Off"} · {scopeText(a)}</span>
                  <br />
                  <b>{whenText(a.trigger)}</b>, then {thenText(a.action)}.
                </span>
                <button type="button" className="ld-btn sm" onClick={() => setEdit({ id: a.id, trigger: a.trigger, action: a.action, active: a.active, scope: a.listId ? "list" : a.folderId ? "folder" : "all" })}>Edit</button>
                <button type="button" className="ld-btn sm" onClick={() => remove.mutate({ organizationId: c.orgId, id: a.id })}>Remove</button>
              </div>
            ))}
            {!shown.length && <div className="gp-rule ld-muted"><span>No automations yet.</span></div>}
            {!edit && (
              <button type="button" className="gp-addrow" style={{ padding: "12px 16px" }} onClick={startNew}>
                + Add an automation
              </button>
            )}
          </div>
          <ErrorLine error={remove.error || q.error} />
        </div>
      </div>
    </div>
  );
}

const fmtTime = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

type St = { name: string };
type Fd = PjCtx["data"]["list"] extends infer L ? (L extends { fields: (infer X)[] } ? X : never) : never;

function TriggerFields({ r, set, statuses, fields, forms }: { r: Rule; set: (r: Rule) => void; statuses: St[]; fields: Fd[]; forms: { id: number; name: string }[] }) {
  const t = r.trigger;
  const put = (patch: Partial<Trigger>) => set({ ...r, trigger: { ...t, ...patch } });
  if (t.on === "status")
    return (
      <>
        <label htmlFor="au-to">Moves to</label>
        <select id="au-to" className="ld-in xs" value={t.to ?? ""} onChange={(e) => put({ to: e.target.value })}>
          <option value="">Any status</option>
          {statuses.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
      </>
    );
  if (t.on === "field") {
    const f = fields.find((x) => x.id === t.field);
    return (
      <>
        <label htmlFor="au-f">Field</label>
        <select id="au-f" className="ld-in xs" value={t.field ?? ""} onChange={(e) => put({ field: e.target.value, to: "" })}>
          <option value="">Pick a field</option>
          {fields.map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>
        <label htmlFor="au-fv">Changes to</label>
        {f?.options?.length ? (
          <select id="au-fv" className="ld-in xs" value={t.to ?? ""} onChange={(e) => put({ to: e.target.value })}>
            <option value="">Anything</option>
            {f.options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        ) : (
          <input id="au-fv" className="ld-in xs" placeholder="Anything" value={t.to ?? ""} onChange={(e) => put({ to: e.target.value })} />
        )}
      </>
    );
  }
  if (t.on === "form")
    return (
      <>
        <label htmlFor="au-form">Form</label>
        <select id="au-form" className="ld-in xs" value={t.formId ?? ""} onChange={(e) => put({ formId: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">Any form</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </>
    );
  if (t.on === "schedule")
    return (
      <>
        <label htmlFor="au-every">Every</label>
        <span className="ld-row">
          <select id="au-every" className="ld-in xs" style={{ width: 130 }} value={t.every ?? "day"} onChange={(e) => put({ every: e.target.value as Trigger["every"] })}>
            <option value="day">Day</option>
            <option value="weekday">Weekday</option>
            <option value="week">Week, on</option>
          </select>
          {t.every === "week" && (
            <select className="ld-in xs" style={{ width: 130 }} aria-label="Day" value={t.day ?? 1} onChange={(e) => put({ day: Number(e.target.value) })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          )}
          <input className="ld-in xs" style={{ width: 90 }} aria-label="Time (HH:MM, 24-hour)" value={t.time ?? "09:00"} onChange={(e) => put({ time: e.target.value })} />
        </span>
      </>
    );
  return null;
}

function ActionFields({ r, set, c, statuses, fields, lists, templates }: { r: Rule; set: (r: Rule) => void; c: PjCtx; statuses: St[]; fields: Fd[]; lists: { id: number; name: string }[]; templates: { id: number; name: string }[] }) {
  const a = r.action;
  const put = (patch: Partial<Action>) => set({ ...r, action: { ...a, ...patch } });
  const people = a.do === "ask" ? c.data.people.filter((p) => p.type === "employee") : a.do === "notify" ? c.data.people.filter((p) => p.type === "user") : c.data.people;
  if (a.do === "assign" || a.do === "watcher" || a.do === "ask" || a.do === "notify")
    return (
      <>
        <label htmlFor="au-who">{a.do === "ask" ? "Employee" : "Who"}</label>
        <select id="au-who" className="ld-in xs" value={a.value.split("|")[0]} onChange={(e) => put({ value: a.do === "notify" ? `${e.target.value}|${a.value.split("|")[1] ?? ""}` : e.target.value })}>
          <option value="">Pick {a.do === "ask" ? "an employee" : "someone"}</option>
          {people.map((p) => (
            <option key={`${p.type}:${p.id}`} value={`${p.type}:${p.id}`}>{p.name}</option>
          ))}
        </select>
        {a.do === "notify" && (
          <>
            <label htmlFor="au-msg">Message</label>
            <input id="au-msg" className="ld-in xs" placeholder='"{task}" needs a look' value={a.value.split("|")[1] ?? ""} onChange={(e) => put({ value: `${a.value.split("|")[0]}|${e.target.value}` })} />
          </>
        )}
      </>
    );
  if (a.do === "priority")
    return (
      <>
        <label htmlFor="au-pri">Priority</label>
        <select id="au-pri" className="ld-in xs" value={a.value} onChange={(e) => put({ value: e.target.value })}>
          <option value="">Pick one</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </>
    );
  if (a.do === "status")
    return (
      <>
        <label htmlFor="au-st">Status</label>
        <select id="au-st" className="ld-in xs" value={a.value} onChange={(e) => put({ value: e.target.value })}>
          <option value="">Pick one</option>
          {statuses.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
      </>
    );
  if (a.do === "field") {
    const f = fields.find((x) => x.id === a.field);
    return (
      <>
        <label htmlFor="au-sf">Field</label>
        <select id="au-sf" className="ld-in xs" value={a.field ?? ""} onChange={(e) => put({ field: e.target.value, value: "" })}>
          <option value="">Pick a field</option>
          {fields.map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>
        <label htmlFor="au-sv">Set to</label>
        {f?.options?.length ? (
          <select id="au-sv" className="ld-in xs" value={a.value} onChange={(e) => put({ value: e.target.value })}>
            <option value="">Pick one</option>
            {f.options.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        ) : (
          <input id="au-sv" className="ld-in xs" value={a.value} onChange={(e) => put({ value: e.target.value })} />
        )}
      </>
    );
  }
  if (a.do === "task")
    return (
      <>
        <label htmlFor="au-tn">Task name</label>
        <input id="au-tn" className="ld-in xs" placeholder={a.templateId ? "From the template" : "Weekly content batch"} value={a.value} onChange={(e) => put({ value: e.target.value })} />
        <label htmlFor="au-tt">Template</label>
        <select id="au-tt" className="ld-in xs" value={a.templateId ?? ""} onChange={(e) => put({ templateId: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">No template</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <label htmlFor="au-tl">In list</label>
        <select id="au-tl" className="ld-in xs" value={a.listId ?? ""} onChange={(e) => put({ listId: e.target.value ? Number(e.target.value) : undefined })}>
          <option value="">{r.trigger.on === "schedule" ? "Pick a list" : "The task's own list"}</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </>
    );
  if (a.do === "move")
    return (
      <>
        <label htmlFor="au-ml">To list</label>
        <select id="au-ml" className="ld-in xs" value={a.listId ?? ""} onChange={(e) => put({ listId: e.target.value ? Number(e.target.value) : undefined, value: e.target.value })}>
          <option value="">Pick a list</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </>
    );
  if (a.do === "email")
    return (
      <>
        <label htmlFor="au-et">To</label>
        <select id="au-et" className="ld-in xs" value={a.to && a.to !== "assignees" ? "address" : "assignees"} onChange={(e) => put({ to: e.target.value === "assignees" ? "assignees" : "" })}>
          <option value="assignees">The assignees</option>
          <option value="address">An email address</option>
        </select>
        {a.to !== undefined && a.to !== "assignees" && (
          <>
            <label htmlFor="au-ea">Address</label>
            <input id="au-ea" className="ld-in xs" type="email" value={a.to} onChange={(e) => put({ to: e.target.value })} />
          </>
        )}
        <label htmlFor="au-eb">Email</label>
        <input id="au-eb" className="ld-in xs" placeholder="{task} is due {due}" value={a.value} onChange={(e) => put({ value: e.target.value })} />
      </>
    );
  if (a.do === "comment" || a.do === "chat" || a.do === "meeting")
    return (
      <>
        <label htmlFor="au-txt">{a.do === "chat" ? "Post" : a.do === "meeting" ? "Topic" : "Note"}</label>
        <input id="au-txt" className="ld-in xs" placeholder={a.do === "chat" ? "⏰ {task} is due today and still open ({assignees})" : a.do === "meeting" ? "{task}" : "Send it to Caroline to paste in"} value={a.value} onChange={(e) => put({ value: e.target.value })} />
      </>
    );
  return null;
}
