import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import type { Where } from "../pages/Projects";

/** Templates: saved tasks, lists and docs to reuse. */

const pad = (n: number) => String(n).padStart(2, "0");
const todayMdy = () => {
  const d = new Date();
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
};
const fromMdy = (s: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}` : null;
};
const KIND = { task: "Task", list: "List", doc: "Doc" } as const;

export function TemplatesPage({ orgId, onPick, onOpenTask, refresh }: { orgId: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void; refresh: () => Promise<unknown> }) {
  const q = trpc.pj.templates.useQuery({ organizationId: orgId });
  const tree = trpc.pj.tree.useQuery({ organizationId: orgId });
  const [kind, setKind] = React.useState<"" | "task" | "list" | "doc">("");
  const [using, setUsing] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<{ id: number; name: string; description: string } | null>(null);
  const update = trpc.pj.updateTemplate.useMutation({ onSuccess: () => { setEditing(null); void q.refetch(); } });
  const remove = trpc.pj.removeTemplate.useMutation({ onSuccess: () => { setEditing(null); void q.refetch(); } });
  const shown = (q.data ?? []).filter((t) => !kind || t.kind === kind);
  const tp = q.data?.find((t) => t.id === using);
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>Templates</span>
        </div>
      </div>
      <div className="gp-tool">
        <span className="gp-tool-l">
          {(["", "list", "task", "doc"] as const).map((k) => (
            <button key={k || "all"} type="button" className={`gp-fb ${kind === k ? "sel" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k ? `${KIND[k]}s` : "All"}
            </button>
          ))}
        </span>
        <span className="ld-small ld-muted">Save any task, list or doc as a template from its ··· menu.</span>
      </div>
      <div className="gp-canvas" style={{ display: "block" }}>
        <ErrorLine error={q.error || update.error || remove.error} />
        <div className="gp-tpls">
          {shown.map((t) =>
            editing?.id === t.id ? (
              <div key={t.id} className="gp-tpl">
                <input className="ld-in xs" aria-label="Template name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <textarea className="ld-ta" rows={2} aria-label="Description" placeholder="What it's for" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                <span className="ld-row">
                  <button type="button" className="ld-btn sm" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="ld-btn p sm" disabled={update.isPending} onClick={() => update.mutate({ organizationId: orgId, ...editing })}>Save</button>
                </span>
                <button type="button" className="gp-link danger" style={{ alignSelf: "flex-start" }} onClick={() => window.confirm(`Delete the template "${t.name}"?`) && remove.mutate({ organizationId: orgId, id: t.id })}>Delete template</button>
              </div>
            ) : (
              <div key={t.id} className="gp-tpl">
                <span className="ld-between">
                  <span className="gp-chip">{KIND[t.kind]}</span>
                  <span className="ld-small ld-muted">{t.folderName}</span>
                </span>
                <b>{t.name}</b>
                <span className="ld-small ld-muted">{t.description || t.summary}</span>
                <span className="ld-row" style={{ marginTop: 4 }}>
                  <button type="button" className="ld-btn sm" onClick={() => setUsing(t.id)}>Use</button>
                  <button type="button" className="ld-btn sm" onClick={() => setEditing({ id: t.id, name: t.name, description: t.description })}>Edit</button>
                </span>
              </div>
            )
          )}
        </div>
        {q.data && !shown.length && <div className="gp-gl gp-empty">No templates yet. Open a task or a list and pick "Save as a template" from its ··· menu.</div>}
      </div>
      {tp && (
        <UseTemplate
          orgId={orgId}
          t={tp}
          folders={tree.data?.folders.map((f) => ({ id: f.id, name: f.name })) ?? []}
          lists={[...(tree.data?.folders ?? []).flatMap((f) => f.lists.map((l) => ({ id: l.id, name: `${f.name} › ${l.name}` }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name }))]}
          onClose={() => setUsing(null)}
          onMade={async (r) => {
            setUsing(null);
            await refresh();
            if (r.kind === "list") onPick({ scope: "list", listId: r.id });
            else if (r.kind === "doc") onPick({ scope: "doc", id: r.id });
            else {
              onPick({ scope: "list", listId: r.listId! });
              onOpenTask(r.id);
            }
          }}
        />
      )}
    </>
  );
}

type Tpl = { id: number; kind: "task" | "list" | "doc"; name: string };
function UseTemplate({ orgId, t, folders, lists, onClose, onMade }: { orgId: number; t: Tpl; folders: { id: number; name: string }[]; lists: { id: number; name: string }[]; onClose: () => void; onMade: (r: { kind: string; id: number; listId: number | null }) => void }) {
  const use = trpc.pj.useTemplate.useMutation({ onSuccess: onMade });
  const [name, setName] = React.useState(t.kind === "list" ? `${t.name}: 2` : t.kind === "doc" ? t.name : "");
  const [folderId, setFolderId] = React.useState<number | null>(folders[0]?.id ?? null);
  const [listId, setListId] = React.useState<number | null>(lists[0]?.id ?? null);
  const [start, setStart] = React.useState(todayMdy());
  const [keep, setKeep] = React.useState({ assignees: true, dates: true, attachments: true, comments: false });
  const [err, setErr] = React.useState<string | null>(null);
  const go = () => {
    const startDate = start.trim() ? fromMdy(start) : null;
    if (start.trim() && !startDate) return setErr("Type the start date as MM/DD/YYYY.");
    setErr(null);
    use.mutate({ organizationId: orgId, id: t.id, name, folderId, listId: listId ?? undefined, startDate, keep });
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Use ${t.name}`}>
      <div className="gp-mbox" style={{ width: 640 }}>
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>Use "{t.name}"</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={use.isPending || (t.kind === "task" && !listId)} onClick={go}>Make it</button>
          </span>
        </div>
        <div className="gp-xedit" style={{ padding: "4px 20px 20px" }}>
          <label htmlFor="ut-name">{t.kind === "list" ? "New list name" : t.kind === "doc" ? "Doc title" : "Task name"}</label>
          <input id="ut-name" className="ld-in xs" placeholder={t.kind === "task" ? "Same as the template" : ""} value={name} onChange={(e) => setName(e.target.value)} />
          {t.kind === "task" ? (
            <>
              <label htmlFor="ut-list">List</label>
              <select id="ut-list" className="ld-in xs" value={listId ?? ""} onChange={(e) => setListId(Number(e.target.value))}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="ut-folder">Folder</label>
              <select id="ut-folder" className="ld-in xs" value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </>
          )}
          {t.kind !== "doc" && (
            <>
              <label htmlFor="ut-start">Start date</label>
              <input id="ut-start" className="ld-in xs" style={{ width: 140 }} placeholder="MM/DD/YYYY" value={start} onChange={(e) => setStart(e.target.value)} />
            </>
          )}
          {t.kind === "list" && (
            <>
              <span>Keep</span>
              <span className="ld-row ld-small" style={{ flexWrap: "wrap", gap: 14 }}>
                <label className="ld-row"><input type="checkbox" className="gp-cbx" checked={keep.assignees} onChange={(e) => setKeep({ ...keep, assignees: e.target.checked })} /> Assignees</label>
                <label className="ld-row"><input type="checkbox" className="gp-cbx" checked={keep.dates} onChange={(e) => setKeep({ ...keep, dates: e.target.checked })} /> Due dates, moved to the start date</label>
                <label className="ld-row"><input type="checkbox" className="gp-cbx" checked={keep.attachments} onChange={(e) => setKeep({ ...keep, attachments: e.target.checked })} /> Attachments</label>
                <label className="ld-row"><input type="checkbox" className="gp-cbx" checked={keep.comments} onChange={(e) => setKeep({ ...keep, comments: e.target.checked })} /> Comments</label>
              </span>
            </>
          )}
        </div>
        <div style={{ padding: "0 20px 16px" }}>
          <ErrorLine error={err ? { message: err } : use.error} />
        </div>
      </div>
    </div>
  );
}

/** Save a task, list or doc as a template. */
export function SaveTemplate({ orgId, kind, sourceId, name, onClose }: { orgId: number; kind: "task" | "list" | "doc"; sourceId: number; name: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const save = trpc.pj.saveTemplate.useMutation({ onSuccess: async () => { await utils.pj.templates.invalidate(); setDone(true); } });
  const [n, setN] = React.useState(name);
  const [desc, setDesc] = React.useState("");
  const [done, setDone] = React.useState(false);
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Save as a template">
      <div className="gp-mbox" style={{ width: 560 }}>
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>{done ? "Saved" : `Save this ${kind} as a template`}</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
            {!done && <button type="button" className="ld-btn p" disabled={save.isPending} onClick={() => save.mutate({ organizationId: orgId, kind, sourceId, name: n, description: desc })}>Save</button>}
          </span>
        </div>
        {done ? (
          <p className="ld-small" style={{ padding: "0 20px 20px", margin: 0 }}>It's in Templates. Use it from there, or from "+ Task ▾".</p>
        ) : (
          <div className="gp-xedit" style={{ padding: "4px 20px 20px" }}>
            <label htmlFor="st-name">Name</label>
            <input id="st-name" className="ld-in xs" placeholder="Same as now" value={n} onChange={(e) => setN(e.target.value)} />
            <label htmlFor="st-desc">What it's for</label>
            <input id="st-desc" className="ld-in xs" value={desc} onChange={(e) => setDesc(e.target.value)} />
            <span />
            <span className="ld-small ld-muted">{kind === "list" ? "Keeps its statuses, fields and tasks, with dates counted from the start." : kind === "task" ? "Keeps its subtasks, checklist, fields and how it repeats." : "Keeps the doc's pages and words."}</span>
            <ErrorLine error={save.error} />
          </div>
        )}
      </div>
    </div>
  );
}

/** "+ Task ▾ → From a template": pick a task template and a list. */
export function UseTaskTemplate({ orgId, listId, lists, onClose, onMade }: { orgId: number; listId: number | null; lists: { id: number; name: string }[]; onClose: () => void; onMade: (taskId: number) => void }) {
  const q = trpc.pj.templates.useQuery({ organizationId: orgId });
  const use = trpc.pj.useTemplate.useMutation({ onSuccess: (r) => onMade(r.id) });
  const tasks = (q.data ?? []).filter((t) => t.kind === "task");
  const [id, setId] = React.useState<number | null>(null);
  const [list, setList] = React.useState<number | null>(listId);
  React.useEffect(() => { if (!id && tasks[0]) setId(tasks[0].id); }, [tasks, id]);
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label="New task from a template">
      <div className="gp-mbox" style={{ width: 560 }}>
        <div className="ld-between gp-mhead">
          <b style={{ fontSize: 17 }}>New task from a template</b>
          <span className="ld-row">
            <button type="button" className="ld-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p" disabled={!id || !list || use.isPending} onClick={() => id && list && use.mutate({ organizationId: orgId, id, listId: list })}>Make it</button>
          </span>
        </div>
        <div className="gp-xedit" style={{ padding: "4px 20px 20px" }}>
          {q.data && !tasks.length ? (
            <span className="ld-small ld-muted" style={{ gridColumn: "1 / -1" }}>No task templates yet. Open a task and pick "Save as a template" from its ··· menu.</span>
          ) : (
            <>
              <label htmlFor="ut-t">Template</label>
              <select id="ut-t" className="ld-in xs" value={id ?? ""} onChange={(e) => setId(Number(e.target.value))}>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <label htmlFor="ut-l">List</label>
              <select id="ut-l" className="ld-in xs" value={list ?? ""} onChange={(e) => setList(Number(e.target.value))}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </>
          )}
          <ErrorLine error={use.error} />
        </div>
      </div>
    </div>
  );
}
