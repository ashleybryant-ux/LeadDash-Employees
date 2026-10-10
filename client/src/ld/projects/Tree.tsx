import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine, WorkspaceHead } from "../ui";
import { Menu } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";
import { useLocation } from "wouter";
import { NAV, NAV_ICONS, navIcon, navLabel, type NavKey } from "./Sidebar";

/**
 * The sidebar, laid out like ClickUp's: a "+ New" button (task, folder, list,
 * doc, whiteboard, form), the items each person chose to show (Home, My tasks,
 * Everything, Docs, Portfolios, Dashboards to start) with the rest under More
 * (Customize sidebar is there too), Favorites, then each folder with its
 * lists, docs, whiteboards and forms.
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

export function Tree({ orgId, tree, where, onPick, onPickView, refresh, onNewTask, onHome, ask, drawer, onCloseDrawer }: { orgId: number; tree: Tree | undefined; where: Where; onPick: (w: Where) => void; onPickView?: (w: Where, kind: string, savedId: number | null) => void; refresh: () => Promise<unknown>; onNewTask: () => void; onHome?: () => void; ask: Ask; drawer: boolean; onCloseDrawer: () => void }) {
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
  // Folders start collapsed. Opening one is remembered on this device, and the folder holding the open list opens itself.
  const [opened, setOpened] = React.useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("ld.pj.open") ?? "[]") as number[]);
    } catch {
      return new Set();
    }
  });
  const shut = React.useMemo(() => new Set((tree?.folders ?? []).map((f) => f.id).filter((id) => !opened.has(id))), [tree?.folders, opened]);
  const setShut = (next: Set<number> | ((s: Set<number>) => Set<number>)) => {
    const n = typeof next === "function" ? next(shut) : next;
    const all = (tree?.folders ?? []).map((f) => f.id);
    const op = new Set(all.filter((id) => !n.has(id)));
    setOpened(op);
    try { localStorage.setItem("ld.pj.open", JSON.stringify(Array.from(op))); } catch { /* ignore */ }
  };
  React.useEffect(() => {
    const id = where.scope === "list" ? tree?.folders.find((f) => f.lists.some((l) => l.id === where.listId))?.id : where.scope === "folder" ? where.folderId : null;
    if (id && !opened.has(id)) setOpened((o) => { const n = new Set(o); n.add(id); return n; });
  }, [where, tree?.folders]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showArchived, setShowArchived] = React.useState(false);
  // The sidebar's width: drag its right edge; the choice is remembered on this device.
  const [width, setWidth] = React.useState(() => {
    try {
      const w = Number(localStorage.getItem("ld.pj.tree"));
      return w >= 180 && w <= 480 ? w : 250;
    } catch {
      return 250;
    }
  });
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => setWidth(Math.max(180, Math.min(480, w0 + ev.clientX - x0)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidth((w) => { try { localStorage.setItem("ld.pj.tree", String(w)); } catch { /* ignore */ } return w; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [moving, setMoving] = React.useState<{ id: number; name: string; folderId: number | null } | null>(null);
  const [, go] = useLocation();
  const navQ = trpc.pj.nav.useQuery({ organizationId: orgId }, { enabled: orgId > 0 && !tree?.guest });
  const favQ = trpc.pj.favorites.useQuery({ organizationId: orgId }, { enabled: orgId > 0 && !tree?.guest });
  const [more, setMore] = React.useState(false);
  const shownNav = (navQ.data?.shown ?? ["home", "mine", "everything", "docs", "portfolios", "dash"]) as NavKey[];
  const moreNav = (navQ.data?.more ?? NAV.map((n) => n.key).filter((k) => !shownNav.includes(k))) as NavKey[];
  const navWhere = (k: NavKey): Where | null =>
    k === "home" ? { scope: "home" } : k === "mine" ? { scope: "mine" } : k === "everything" ? { scope: "everything" } : k === "docs" ? { scope: "docs" } : k === "portfolios" ? { scope: "portfolios" } : k === "dash" ? { scope: "dash" } : k === "time" ? { scope: "time" } : k === "templates" ? { scope: "templates" } : k === "boards" ? { scope: "docs", tab: "boards" } : k === "forms" ? { scope: "docs", tab: "forms" } : k === "import" ? { scope: "import" } : null;
  const navOn = (k: NavKey) =>
    k === "home" ? where.scope === "home" : k === "mine" ? where.scope === "mine" : k === "everything" ? where.scope === "everything" : k === "docs" ? where.scope === "docs" && !where.tab : k === "portfolios" ? where.scope === "portfolios" || where.scope === "portfolio" : k === "dash" ? where.scope === "dash" : k === "time" ? where.scope === "time" : k === "templates" ? where.scope === "templates" : k === "boards" ? where.scope === "docs" && where.tab === "boards" : k === "forms" ? where.scope === "docs" && where.tab === "forms" : k === "import" ? where.scope === "import" : false;
  const goNav = (k: NavKey) => {
    setMore(false);
    if (k === "goals") { go("/goals"); return; }
    if (k === "home" && onHome) { onHome(); onCloseDrawer(); return; }
    const w = navWhere(k);
    if (w) pickAnd(w);
  };
  const navBtn = (k: NavKey, inMore = false) => (
    <button key={k} type="button" className={`gp-tl top ${navOn(k) ? "on" : ""}`} style={inMore ? { paddingLeft: 8 } : undefined} onClick={() => goNav(k)}>
      <span><span className="gp-nic">{navIcon(k)}</span>{navLabel(k)}</span>
      {k === "mine" && (tree?.mine ?? 0) > 0 && <span className="n">{tree?.mine}</span>}
    </button>
  );
  const favWhere = (f: NonNullable<typeof favQ.data>[number]): Where =>
    f.kind === "dash" ? { scope: "dash", id: f.id } : f.kind === "doc" ? { scope: "doc", id: f.id } : f.kind === "board" ? { scope: "board", id: f.id } : f.kind === "form" ? { scope: "form", id: f.id } : f.listId ? { scope: "list", listId: f.listId } : f.folderId ? { scope: "folder", folderId: f.folderId } : { scope: "everything" };
  const moveList = trpc.pj.saveList.useMutation({ onSuccess: async () => { setMoving(null); await refresh(); } });
  // Add to portfolio: a list, or every list in a folder, from the ··· menu.
  const [toPortfolio, setToPortfolio] = React.useState<{ kind: "list" | "folder"; id: number; name: string; portfolioId: number | "" } | null>(null);
  const portfoliosQ = trpc.pj.portfolios.useQuery({ organizationId: orgId }, { enabled: !!toPortfolio });
  const utils = trpc.useUtils();
  const afterPortfolio = async () => { setToPortfolio(null); await Promise.all([utils.pj.portfolios.invalidate(), utils.pj.portfolio.invalidate()]); };
  const addWork = trpc.pj.addWork.useMutation({ onSuccess: afterPortfolio });
  const addFolder = trpc.pj.addFolderToPortfolio.useMutation({ onSuccess: afterPortfolio });
  const PortfolioForm = toPortfolio && (
    <div className="gp-tf-form">
      <span className="ld-small ld-muted">Add {toPortfolio.name} to</span>
      <select className="ld-in xs" aria-label="Portfolio" value={toPortfolio.portfolioId} onChange={(e) => setToPortfolio({ ...toPortfolio, portfolioId: e.target.value ? Number(e.target.value) : "" })}>
        <option value="">Pick a portfolio</option>
        {(portfoliosQ.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {portfoliosQ.data && !portfoliosQ.data.length && <span className="ld-small ld-muted">No portfolios yet. Make one under Portfolios.</span>}
      <span className="ld-row">
        <button type="button" className="ld-btn sm" onClick={() => setToPortfolio(null)}>Cancel</button>
        <button type="button" className="ld-btn p sm" disabled={!toPortfolio.portfolioId || addWork.isPending || addFolder.isPending} onClick={() => { if (!toPortfolio.portfolioId) return; if (toPortfolio.kind === "list") addWork.mutate({ organizationId: orgId, portfolioId: toPortfolio.portfolioId, kind: "list", itemId: toPortfolio.id }); else addFolder.mutate({ organizationId: orgId, portfolioId: toPortfolio.portfolioId, folderId: toPortfolio.id }); }}>Add</button>
      </span>
      <ErrorLine error={portfoliosQ.error || addWork.error || addFolder.error} />
    </div>
  );
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
                <button type="button" role="menuitem" onClick={() => { setMoving({ id: l.id, name: l.name, folderId }); close(); }}>Move to folder</button>
                <button type="button" role="menuitem" onClick={() => { setToPortfolio({ kind: "list", id: l.id, name: l.name, portfolioId: "" }); close(); }}>Add to portfolio</button>
                <button type="button" role="menuitem" onClick={() => { archiveList.mutate({ organizationId: orgId, id: l.id, on: true }); if (where.scope === "list" && where.listId === l.id) onPick({ scope: "everything" }); close(); }}>Archive</button>
                <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete the ${l.name} list and its tasks?`)) removeList.mutate({ organizationId: orgId, id: l.id }); close(); }}>Delete list</button>
              </>
            )}
          </Menu>
        )}
      </div>
      {toPortfolio?.kind === "list" && toPortfolio.id === l.id && PortfolioForm}
      {moving?.id === l.id && (
        <div className="gp-tf-form">
          <select className="ld-in xs" aria-label="Folder" value={moving.folderId ?? ""} onChange={(e) => setMoving({ ...moving, folderId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Not in a folder</option>
            {(tree?.folders ?? []).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <span className="ld-row">
            <button type="button" className="ld-btn sm" onClick={() => setMoving(null)}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={moveList.isPending} onClick={() => moveList.mutate({ organizationId: orgId, id: l.id, name: l.name, folderId: moving.folderId })}>Move</button>
          </span>
          <ErrorLine error={moveList.error} />
        </div>
      )}
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
      <aside className={`gp-ptree ${drawer ? "open" : ""}`} aria-label="Folders and lists" style={{ width }}>
        {guest ? (
          <div className="ph2">
            <span>Shared with you</span>
          </div>
        ) : (
          <>
            <WorkspaceHead />
            <Menu label="Create" align="left" button="+ New" buttonClass="ld-btn p gp-new">
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { onNewTask(); onCloseDrawer(); close(); }}>Task</button>
                  <button type="button" role="menuitem" onClick={() => { setForm({ kind: "folder", name: "", color: COLORS[(tree?.folders.length ?? 0) % COLORS.length] }); close(); }}>Folder</button>
                  {adds(null, close)}
                </>
              )}
            </Menu>
            {shownNav.map((k) => navBtn(k))}
            <div className="gp-more">
              <button type="button" className={`gp-tl top ${more ? "on" : ""}`} aria-expanded={more} onClick={() => setMore((v) => !v)}>
                <span><span className="gp-nic">{NAV_ICONS.more}</span>More</span>
              </button>
              {more && (
                <div className="gp-morebox" role="menu">
                  {moreNav.map((k) => navBtn(k, true))}
                  <div className="gp-csep" style={{ margin: "4px 0" }} />
                  <button type="button" className={`gp-tl top ${where.scope === "sidebar" ? "on" : ""}`} onClick={() => { setMore(false); pickAnd({ scope: "sidebar" }); }}>
                    <span><span className="gp-nic">{NAV_ICONS.settings}</span>Customize sidebar</span>
                  </button>
                </div>
              )}
            </div>
            {(favQ.data?.length ?? 0) > 0 && (
              <>
                <div className="ph2" style={{ marginTop: 10 }}><span>Favorites</span></div>
                {favQ.data!.map((f) => {
                  const w = favWhere(f);
                  const isOn = f.kind === "view" ? false : on(w);
                  return (
                    <button key={`${f.kind}${f.id}`} type="button" className={`gp-tl top ${isOn ? "on" : ""}`} title={`${f.name} · ${f.note}`} onClick={() => { if (f.kind === "view" && f.viewKind) onPickView?.(w, f.viewKind, f.savedId ?? null); else pickAnd(w); onCloseDrawer(); }}>
                      <span className="gp-ell"><span className="gp-nic" aria-hidden="true">★</span>{f.name}</span>
                      <span className="n gp-ell" style={{ maxWidth: 90 }}>{f.note}</span>
                    </button>
                  );
                })}
              </>
            )}
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
                          <button type="button" role="menuitem" onClick={() => { setToPortfolio({ kind: "folder", id: f.id, name: f.name, portfolioId: "" }); close(); }}>Add to portfolio</button>
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
            {toPortfolio?.kind === "folder" && toPortfolio.id === f.id && PortfolioForm}
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
        <ErrorLine error={removeFolder.error || removeList.error || archiveList.error || archiveFolder.error} />
      </aside>
      <div className="gp-tree-grip" role="separator" aria-orientation="vertical" aria-label="Drag to resize the sidebar" title="Drag to resize" onPointerDown={startDrag} />
    </>
  );
}
