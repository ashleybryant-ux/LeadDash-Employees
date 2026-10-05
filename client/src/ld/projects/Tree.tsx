import React from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Menu } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";

/** The folder tree: Everything, My work, Nora's launches, and each folder with its lists. */
const COLORS = ["#1b6b4a", "#b45309", "#7c3aed", "#2563eb", "#0f766e", "#9a4f2c", "#c2253c", "#4b5563"];

export function Tree({ orgId, tree, where, onPick, refresh }: { orgId: number; tree: Outputs["pj"]["tree"] | undefined; where: Where; onPick: (w: Where) => void; refresh: () => Promise<unknown> }) {
  const [form, setForm] = React.useState<{ kind: "folder" | "list"; id?: number; folderId?: number | null; name: string; color: string } | null>(null);
  const [shut, setShut] = React.useState<Set<number>>(new Set());
  const saveFolder = trpc.pj.saveFolder.useMutation({ onSuccess: async () => { setForm(null); await refresh(); } });
  const removeFolder = trpc.pj.removeFolder.useMutation({ onSuccess: () => refresh() });
  const saveList = trpc.pj.saveList.useMutation({
    onSuccess: async (l) => {
      setForm(null);
      await refresh();
      if (l) onPick({ scope: "list", listId: l.id });
    },
  });
  const isList = (id: number) => where.scope === "list" && where.listId === id;
  const submit = () => {
    if (!form || !form.name.trim()) return;
    if (form.kind === "folder") saveFolder.mutate({ organizationId: orgId, id: form.id, name: form.name, color: form.color });
    else saveList.mutate({ organizationId: orgId, id: form.id, name: form.name, folderId: form.folderId ?? null });
  };
  const Form = (
    <div className="gp-tf-form">
      <input className="ld-in xs" autoFocus aria-label={form?.kind === "folder" ? "Folder name" : "List name"} placeholder={form?.kind === "folder" ? "Folder name" : "List name"} value={form?.name ?? ""} onChange={(e) => form && setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && submit()} />
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
      <ErrorLine error={saveFolder.error || saveList.error} />
    </div>
  );
  const listRow = (l: { id: number; name: string; open: number }) => (
    <button key={l.id} type="button" className={`gp-tl ${isList(l.id) ? "on" : ""}`} aria-current={isList(l.id) ? "page" : undefined} onClick={() => onPick({ scope: "list", listId: l.id })}>
      <span className="gp-ell">{l.name}</span>
      {l.open > 0 && <span className="n">{l.open}</span>}
    </button>
  );
  return (
    <aside className="gp-ptree" aria-label="Folders and lists">
      <div className="ph2">
        <span>Projects</span>
      </div>
      <button type="button" className={`gp-tl top ${where.scope === "everything" ? "on" : ""}`} onClick={() => onPick({ scope: "everything" })}>
        <span>⌂ Everything</span>
      </button>
      <button type="button" className={`gp-tl top ${where.scope === "mine" ? "on" : ""}`} onClick={() => onPick({ scope: "mine" })}>
        <span>☆ My work</span>
        {(tree?.mine ?? 0) > 0 && <span className="n">{tree?.mine}</span>}
      </button>
      <Link href="/tasks" className="gp-tl top">
        <span>◷ Nora's launches</span>
      </Link>
      <div className="ph2" style={{ marginTop: 8 }}>
        <span>Folders</span>
        <button type="button" className="gp-plus" aria-label="New folder" onClick={() => setForm({ kind: "folder", name: "", color: COLORS[(tree?.folders.length ?? 0) % COLORS.length] })}>+</button>
      </div>
      {form?.kind === "folder" && !form.id && Form}
      {(tree?.folders ?? []).map((f) => (
        <div key={f.id}>
          {form?.kind === "folder" && form.id === f.id ? (
            Form
          ) : (
            <div className="gp-tf">
              <button type="button" className="gp-tf-name" aria-expanded={!shut.has(f.id)} onClick={() => { const s = new Set(shut); s.has(f.id) ? s.delete(f.id) : s.add(f.id); setShut(s); }}>
                <span className="gp-fi" style={{ background: f.color }} />
                <span className="gp-ell">{f.name}</span>
              </button>
              <Menu label={`Folder options for ${f.name}`}>
                {(close) => (
                  <>
                    <button type="button" role="menuitem" onClick={() => { setForm({ kind: "list", folderId: f.id, name: "", color: "" }); close(); }}>New list</button>
                    <button type="button" role="menuitem" onClick={() => { setForm({ kind: "folder", id: f.id, name: f.name, color: f.color }); close(); }}>Rename or recolor</button>
                    <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Remove the ${f.name} folder? Its lists stay, out of the folder.`)) removeFolder.mutate({ organizationId: orgId, id: f.id }); close(); }}>Remove folder</button>
                  </>
                )}
              </Menu>
            </div>
          )}
          {form?.kind === "list" && form.folderId === f.id && !form.id && Form}
          {!shut.has(f.id) && f.lists.map(listRow)}
        </div>
      ))}
      {(tree?.loose.length ?? 0) > 0 && <div className="ph2" style={{ marginTop: 8 }}><span>Lists</span></div>}
      {tree?.loose.map(listRow)}
      {form?.kind === "list" && form.folderId === null && !form.id && Form}
      <button type="button" className="gp-tl add" onClick={() => setForm({ kind: "list", folderId: null, name: "", color: "" })}>+ New list</button>
      <button type="button" className={`gp-tl add ${where.scope === "import" ? "on" : ""}`} onClick={() => onPick({ scope: "import" })}>Move from ClickUp</button>
      <ErrorLine error={removeFolder.error} />
    </aside>
  );
}
