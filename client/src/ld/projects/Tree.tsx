import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Menu } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";

/**
 * The sidebar, laid out like ClickUp's: a "+ New" button (task, folder, list,
 * doc, whiteboard, form), My tasks, Everything, Dashboards, Timesheets and
 * Templates, then each folder with its lists, docs, whiteboards and forms.
 * Each folder has a + for a new list and a ··· menu (Archive among them); each
 * list has a ··· menu. Archived folders and lists sit in an Archived section
 * at the bottom and open read only. On a phone it opens as a drawer. A guest
 * sees only the lists and docs shared with them.
 */
const COLORS = ["#1b6b4a", "#b45309", "#7c3aed", "#2563eb", "#0f766e", "#9a4f2c", "#c2253c", "#4b5563"];
type Tree = Outputs["pj"]["tree"];
type Kind = "folder" | "list" | "doc" | "board" | "form";
const ICON: Record<string, string> = { doc: "📄", board: "▢", form: "☰" };
const NOUN: Record<Kind, string> = { folder: "Folder", list: "List", doc: "Doc", board: "Whiteboard", form: "Form" };

/** The page can ask the tree to open a form: a new folder, a new list (in a folder), or editing a folder. */
export type Ask = { kind: "folder" | "list"; n: number; folderId?: number | null; id?: number } | null;

export function Tree({ orgId, tree, where, onPick, refresh, onNewTask, onHome, ask, drawer, onCloseDrawer }: { orgId: number; tree: Tree | undefined; where: Where; onPick: (w: Where) => void; refresh: () => Promise<unknown>; onNewTask: () => void; onHome?: () => void; ask: Ask; drawer: boolean; onCloseDrawer: () => void }) {
  const [form, setForm] = React.useState<{ kind: Kind; id?: number; folderId?: number | null; name: string; color: string } | null>(null);
  // The page can ask for a new folder or list (from the empty state).
  React.useEffect(() => {
    if (!ask) return;
    if (ask.kind === "folder" && ask.id) {
      const f = tree?.folders.find((x) => x.id === ask.id);
      if (f) setForm({ kind: "folder", id: f.id, name: f.name, color: f.color });
      return;
    }
    setForm(ask.kind === "folder" ? { kind: "folder", name: "", color: COLORS[(tree?.folders.length ?? 0) % COLORS.length] } : { kind: "list", folderId: ask.folderId ?? null, name: "", color: "" });
  }, [ask]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shut, setShut] = React.useState<Set<number>>(new Set());
  const [showArchived, setShowArchived] = React.useState(false);
  const guest = !!tree?.guest;
  const archivedQ = trpc.pj.archived.useQuery({ organizationId: orgId }, { enabled: showArchived && !guest });
  const archiveList = trpc.pj.archiveList.useMutation({ onSuccess: async () => { await refresh(); void archivedQ.refetch(); } });
  const archiveFolder = trpc.pj.archiveFolder.useMutation({ onSuccess: async () => { await refresh(); void archivedQ.refetch(); } });
  const done = async () => {
    setForm(null);
    await refresh();
  };
  const saveFolder = trpc.pj.saveFolder.useMutation({ onSuccess: done });
  const removeFolder = trpc.pj.removeFolder.useMutation({ onSuccess: () => refresh() });
  const removeList = trpc.pj.removeList.useMutation({ onSuccess: () => { onPick({ scope: "everything" }); void refresh(); } });
  const saveList = trpc.pj.saveList.useMutation({ onSuccess: async (l) => { await done(); if (l) onPick({ scope: "list", listId: l.id }); } });
  const saveDoc = trpc.pj.saveDoc.useMutation({ onSuccess: async (d) => { await done(); onPick({ scope: "doc", id: d.id }); } });
  const saveBoard = trpc.pj.saveBoard.useMutation({ onSuccess: async (b) => { await done(); onPick({ scope: "board", id: b.id }); } });
  const saveForm = trpc.pj.saveForm.useMutation({ onSuccess: async (f) => { await done(); onPick({ scope: "form", id: f.id }); } });
  const on = (w: Where) => JSON.stringify(w) === JSON.stringify(where) || (w.scope === "list" && where.scope === "list" && w.listId === where.listId) || (w.scope === "dash" && where.scope === "dash") || (w.scope === "folder" && where.scope === "folder" && w.folderId === where.folderId);
  const submit = () => {
    if (!form || !form.name.trim()) return;
    const folderId = form.folderId ?? null;
    if (form.kind === "folder") saveFolder.mutate({ organizationId: orgId, id: form.id, name: form.name, color: form.color });
    else if (form.kind === "list") saveList.mutate({ organizationId: orgId, id: form.id, name: form.name, folderId });
    else if (form.kind === "doc") saveDoc.mutate({ organizationId: orgId, title: form.name, folderId });
    else if (form.kind === "board") saveBoard.mutate({ organizationId: orgId, title: form.name, folderId });
    else saveForm.mutate({ organizationId: orgId, title: form.name, folderId });
  };
  const Form = (
    <div className="gp-tf-form">
      <input className="ld-in xs" autoFocus aria-label={`${NOUN[form?.kind ?? "list"]} name`} placeholder={`${NOUN[form?.kind ?? "list"]} name`} value={form?.name ?? ""} onChange={(e) => form && setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && submit()} />
      {form?.kind === "folder" && (
        <span className="ld-row" style={{ flexWrap: "wrap" }} role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={form.color === c} aria-label={c} className={`gp-sw sm ${form.color === c ? "on" : ""}`} style={{ background: c }} onClick={() => setForm({ ...form, color: c })} />
          ))}
        </span>
      )}
      <span className="ld-row">
        <button type="button" className="ld-btn sm" onClick={() => setForm(null)}>Cancel</button>
        <button type="button" className="ld-btn p sm" onClick={submit} disabled={!form?.name.trim()}>Save</button>
      </span>
      <ErrorLine error={saveFolder.error || saveList.error || saveDoc.error || saveBoard.error || saveForm.error} />
    </div>
  );
  const listRow = (l: { id: number; name: string; open: number; private: boolean; folderId?: number | null; items?: { kind: "doc" | "board"; id: number; name: string }[] }, folderId: number | null) =>
    form?.kind === "list" && form.id === l.id ? (
      <div key={`l${l.id}`}>{Form}</div>
    ) : (
      <div key={`l${l.id}`}>
      <div className={`gp-tlr ${on({ scope: "list", listId: l.id }) ? "on" : ""}`}>
        <button type="button" className={`gp-tl ${on({ scope: "list", listId: l.id }) ? "on" : ""}`} aria-current={on({ scope: "list", listId: l.id }) ? "page" : undefined} onClick={() => pickAnd({ scope: "list", listId: l.id })}>
          <span className="gp-ell">{l.private ? "🔒 " : ""}{l.name}</span>
          {l.open > 0 && <span className="n">{l.open}</span>}
        </button>
        {!guest && (
          <Menu label={`List options for ${l.name}`}>
            {(close) => (
              <>
                <button type="button" role="menuitem" onClick={() => { setForm({ kind: "list", id: l.id, folderId, name: l.name, color: "" }); close(); }}>Rename</button>
                <button type="button" role="menuitem" onClick={() => { archiveList.mutate({ organizationId: orgId, id: l.id, on: true }); if (where.scope === "list" && where.listId === l.id) onPick({ scope: "everything" }); close(); }}>Archive</button>
                <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete the ${l.name} list and its tasks?`)) removeList.mutate({ organizationId: orgId, id: l.id }); close(); }}>Delete list</button>
              </>
            )}
          </Menu>
        )}
      </div>
      {(l.items ?? []).map((i) => itemRow(i, true))}
      </div>
    );
  const itemRow = (i: { kind: "doc" | "board" | "form"; id: number; name: string }, under = false) => {
    const w = { scope: i.kind, id: i.id } as Where;
    return (
      <button key={`${i.kind}${i.id}`} type="button" className={`gp-tl ${on(w) ? "on" : ""}`} style={under ? { paddingLeft: 46 } : undefined} aria-current={on(w) ? "page" : undefined} onClick={() => pickAnd(w)}>
        <span className="gp-ell">
          <span aria-hidden="true">{ICON[i.kind]} </span>
          {i.name}
        </span>
      </button>
    );
  };
  const adds = (folderId: number | null, close: () => void) =>
    (["list", "doc", "board", "form"] as const).map((k) => (
      <button key={k} type="button" role="menuitem" onClick={() => { setForm({ kind: k, folderId, name: "", color: "" }); close(); }}>
        {NOUN[k]}
      </button>
    ));
  const pickAnd = (w: Where) => { onPick(w); onCloseDrawer(); };
  return (
    <>
      {drawer && <div className="gp-drawer-bg" onClick={onCloseDrawer} aria-hidden="true" />}
      <aside className={`gp-ptree ${drawer ? "open" : ""}`} aria-label="Folders and lists">
        {guest ? (
          <div className="ph2">
            <span>Shared with you</span>
          </div>
        ) : (
          <>
            <Menu label="Create" align="left" button="+ New" buttonClass="ld-btn p gp-new">
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { onNewTask(); onCloseDrawer(); close(); }}>Task</button>
                  <button type="button" role="menuitem" onClick={() => { setForm({ kind: "folder", name: "", color: COLORS[(tree?.folders.length ?? 0) % COLORS.length] }); close(); }}>Folder</button>
                  {adds(null, close)}
                </>
              )}
            </Menu>
            {onHome && (
              <button type="button" className={`gp-tl top ${where.scope === "home" ? "on" : ""}`} onClick={() => { onHome(); onCloseDrawer(); }}>
                <span>⌂ Home</span>
              </button>
            )}
            <button type="button" className={`gp-tl top ${where.scope === "mine" ? "on" : ""}`} onClick={() => pickAnd({ scope: "mine" })}>
              <span>☆ My tasks</span>
              {(tree?.mine ?? 0) > 0 && <span className="n">{tree?.mine}</span>}
            </button>
            <button type="button" className={`gp-tl top ${where.scope === "everything" ? "on" : ""}`} onClick={() => pickAnd({ scope: "everything" })}>
              <span>▤ Everything</span>
            </button>
            <button type="button" className={`gp-tl top ${where.scope === "docs" ? "on" : ""}`} onClick={() => pickAnd({ scope: "docs" })}>
              <span>📄 Docs</span>
            </button>
            <button type="button" className={`gp-tl top ${where.scope === "portfolios" || where.scope === "portfolio" ? "on" : ""}`} onClick={() => pickAnd({ scope: "portfolios" })}>
              <span>▦ Portfolios</span>
            </button>
            <button type="button" className={`gp-tl top ${where.scope === "dash" ? "on" : ""}`} onClick={() => pickAnd({ scope: "dash" })}>
              <span>▥ Dashboards</span>
            </button>
            <button type="button" className={`gp-tl top ${where.scope === "time" ? "on" : ""}`} onClick={() => pickAnd({ scope: "time" })}>
              <span>◷ Timesheets</span>
            </button>
            <button type="button" className={`gp-tl top ${where.scope === "templates" ? "on" : ""}`} onClick={() => pickAnd({ scope: "templates" })}>
              <span>❏ Templates</span>
            </button>
            <div className="ph2" style={{ marginTop: 10 }}>
              <span>Folders</span>
              <button type="button" className="gp-plus" aria-label="New folder" title="New folder" onClick={() => setForm({ kind: "folder", name: "", color: COLORS[(tree?.folders.length ?? 0) % COLORS.length] })}>+</button>
            </div>
          </>
        )}
        {form?.kind === "folder" && !form.id && Form}
        {(tree?.folders ?? []).map((f) => (
          <div key={f.id}>
            {form?.kind === "folder" && form.id === f.id ? (
              Form
            ) : (
              <div className={`gp-tf ${on({ scope: "folder", folderId: f.id }) ? "on" : ""}`}>
                <button type="button" className="gp-car" aria-label={shut.has(f.id) ? `Show ${f.name}` : `Hide ${f.name}`} aria-expanded={!shut.has(f.id)} onClick={() => { const s = new Set(shut); s.has(f.id) ? s.delete(f.id) : s.add(f.id); setShut(s); }}>{shut.has(f.id) ? "▸" : "▾"}</button>
                <button type="button" className="gp-tf-name" aria-current={on({ scope: "folder", folderId: f.id }) ? "page" : undefined} onClick={() => (guest ? undefined : pickAnd({ scope: "folder", folderId: f.id, tab: "overview" }))}>
                  <span className="gp-fi" style={{ background: f.color }} />
                  <span className="gp-ell">{f.name}</span>
                </button>
                {!guest && (
                  <span className="gp-tf-acts">
                    <button type="button" className="gp-plus sm" aria-label={`New list in ${f.name}`} title="New list" onClick={() => { setShut((s) => { const n = new Set(s); n.delete(f.id); return n; }); setForm({ kind: "list", folderId: f.id, name: "", color: "" }); }}>+</button>
                    <Menu label={`Folder options for ${f.name}`}>
                      {(close) => (
                        <>
                          {adds(f.id, close)}
                          <button type="button" role="menuitem" onClick={() => { setForm({ kind: "folder", id: f.id, name: f.name, color: f.color }); close(); }}>Rename or recolor</button>
                          <button type="button" role="menuitem" onClick={() => { if (window.confirm(`Archive the ${f.name} folder and every list in it?`)) { archiveFolder.mutate({ organizationId: orgId, id: f.id, on: true }); if (where.scope === "folder" && where.folderId === f.id) onPick({ scope: "everything" }); } close(); }}>Archive folder</button>
                          <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Remove the ${f.name} folder? What's in it stays, out of the folder.`)) removeFolder.mutate({ organizationId: orgId, id: f.id }); close(); }}>Remove folder</button>
                        </>
                      )}
                    </Menu>
                  </span>
                )}
              </div>
            )}
            {form && form.kind !== "folder" && form.folderId === f.id && !form.id && Form}
            {!shut.has(f.id) && (
              <>
                {f.lists.map((l) => listRow(l, f.id))}
                {f.items.map((i) => itemRow(i))}
                {!guest && !f.lists.length && !f.items.length && !(form && form.folderId === f.id) && (
                  <button type="button" className="gp-tl add" style={{ paddingLeft: 30 }} onClick={() => setForm({ kind: "list", folderId: f.id, name: "", color: "" })}>+ New list</button>
                )}
              </>
            )}
          </div>
        ))}
        {((tree?.loose.length ?? 0) > 0 || (tree?.looseItems.length ?? 0) > 0) && <div className="ph2" style={{ marginTop: 8 }}><span>{guest ? "Lists" : "Not in a folder"}</span></div>}
        {tree?.loose.map((l) => listRow(l, null))}
        {tree?.looseItems.map((i) => itemRow(i))}
        {form && form.kind !== "folder" && form.folderId === null && !form.id && Form}
        {guest && (tree?.sharedDocs.length ?? 0) > 0 && (
          <>
            <div className="ph2" style={{ marginTop: 8 }}><span>Docs</span></div>
            {tree!.sharedDocs.map((d) => itemRow({ kind: "doc", id: d.id, name: d.name }))}
          </>
        )}
        {!guest && (tree?.archived ?? 0) > 0 && (
          <>
            <div className="ph2" style={{ marginTop: 10 }}>
              <button type="button" className="gp-tf-name" style={{ padding: 0, font: "inherit", color: "inherit", textTransform: "inherit", letterSpacing: "inherit" }} aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
                Archived <span style={{ fontWeight: 600 }}>{tree?.archived}</span> {showArchived ? "▾" : "▸"}
              </button>
            </div>
            {showArchived &&
              archivedQ.data?.folders.map((f) => (
                <div key={`af${f.id}`}>
                  <div className="gp-tf">
                    <span className="gp-car" />
                    <span className="gp-tf-name ld-muted"><span className="gp-fi" style={{ background: f.color, opacity: 0.5 }} /><span className="gp-ell">{f.name}</span></span>
                    <span className="gp-tf-acts">
                      <Menu label={`Options for the archived ${f.name} folder`}>
                        {(close) => (
                          <>
                            <button type="button" role="menuitem" onClick={() => { archiveFolder.mutate({ organizationId: orgId, id: f.id, on: false }); close(); }}>Restore folder</button>
                            <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Remove the ${f.name} folder for good? What's in it stays, out of the folder.`)) removeFolder.mutate({ organizationId: orgId, id: f.id }); close(); }}>Delete for good</button>
                          </>
                        )}
                      </Menu>
                    </span>
                  </div>
                  {f.lists.map((l) => (
                    <button key={`al${l.id}`} type="button" className={`gp-tl ld-muted ${on({ scope: "list", listId: l.id }) ? "on" : ""}`} onClick={() => pickAnd({ scope: "list", listId: l.id })}><span className="gp-ell">{l.name}</span></button>
                  ))}
                </div>
              ))}
            {showArchived &&
              archivedQ.data?.lists.map((l) => (
                <button key={`al${l.id}`} type="button" className={`gp-tl top ld-muted ${on({ scope: "list", listId: l.id }) ? "on" : ""}`} style={{ paddingLeft: 30 }} onClick={() => pickAnd({ scope: "list", listId: l.id })}><span className="gp-ell">{l.name}</span></button>
              ))}
            {showArchived && archivedQ.data && !archivedQ.data.folders.length && !archivedQ.data.lists.length && <span className="ld-small ld-muted" style={{ padding: "4px 10px" }}>Nothing archived.</span>}
          </>
        )}
        {!guest && (
          <button type="button" className={`gp-tl add ${where.scope === "import" ? "on" : ""}`} style={{ marginTop: 10 }} onClick={() => pickAnd({ scope: "import" })}>⇩ Import from ClickUp</button>
        )}
        <ErrorLine error={removeFolder.error || removeList.error || archiveList.error || archiveFolder.error} />
      </aside>
    </>
  );
}
