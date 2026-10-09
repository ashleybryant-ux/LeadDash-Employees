import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { Menu } from "../goals/shared";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";
import { DocShare } from "./DocShare";

/**
 * Docs, all in one place, the way ClickUp's Docs hub works: every doc,
 * whiteboard and form the person can see, in tabs (all, mine, shared with
 * me, private, whiteboards, forms, archived), with stars, folder and tag
 * filters, a search that looks inside the text, and Copy link and Share on
 * each row. A lock marks a private doc.
 */

type Tab = "all" | "mine" | "shared" | "private" | "boards" | "forms" | "archived";
const TABS: [Tab, string][] = [["all", "All"], ["mine", "Mine"], ["shared", "Shared with me"], ["private", "Private"], ["boards", "Whiteboards"], ["forms", "Forms"], ["archived", "Archived"]];
const ICON = { doc: "D", board: "W", form: "F" } as const;
const fmtAt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

export function DocsHub({ orgId, onPick, refresh }: { orgId: number; onPick: (w: Where) => void; refresh: () => Promise<unknown> }) {
  const [q, setQ] = React.useState("");
  const [tab, setTab] = React.useState<Tab>("all");
  const [folder, setFolder] = React.useState<number | "">("");
  const [tag, setTag] = React.useState("");
  const [sort, setSort] = React.useState<"updated" | "name">("updated");
  const [moving, setMoving] = React.useState<{ kind: "doc" | "board"; id: number; name: string; tags: string[] } | null>(null);
  const [making, setMaking] = React.useState<null | "doc" | "board">(null);
  const [sharing, setSharing] = React.useState<{ id: number; name: string } | null>(null);
  const [copied, setCopied] = React.useState<string>("");
  const utils = trpc.useUtils();
  const data = trpc.pj.allDocs.useQuery({ organizationId: orgId, q: q.trim() });
  const tree = trpc.pj.tree.useQuery({ organizationId: orgId });
  const done = async () => {
    await Promise.all([utils.pj.allDocs.invalidate(), refresh()]);
  };
  const removeDoc = trpc.pj.removeDoc.useMutation({ onSuccess: done });
  const removeBoard = trpc.pj.removeBoard.useMutation({ onSuccess: done });
  const removeForm = trpc.pj.removeForm.useMutation({ onSuccess: done });
  const archive = trpc.pj.archiveDoc.useMutation({ onSuccess: done });
  const star = trpc.pj.star.useMutation({ onSuccess: () => utils.pj.allDocs.invalidate() });
  const d = data.data;
  const rows = (d?.docs ?? [])
    .filter((x) => (tab === "archived" ? x.archived : !x.archived))
    .filter((x) => (tab === "all" || tab === "archived" ? true : tab === "boards" ? x.kind === "board" : tab === "forms" ? x.kind === "form" : tab === "shared" ? x.shared : tab === "private" ? x.private : x.mine))
    .filter((x) => !folder || (x.where?.kind === "folder" && x.where.id === folder) || (x.where?.kind === "list" && listFolder(tree.data, x.where.id) === folder))
    .filter((x) => !tag || x.tags.includes(tag))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : (b.at ?? "").localeCompare(a.at ?? "")));
  const starred = (d?.docs ?? []).filter((x) => x.starred && !x.archived);
  const open = (x: (typeof rows)[number]) => onPick({ scope: x.kind, id: x.id });
  const linkOf = (x: (typeof rows)[number]) => `${window.location.origin}/projects?page=${x.kind}&id=${x.id}`;
  const copy = (x: (typeof rows)[number]) => {
    void navigator.clipboard?.writeText(linkOf(x));
    setCopied(`${x.kind}${x.id}`);
    setTimeout(() => setCopied(""), 1500);
  };
  const counts = d?.counts;
  const count = (k: Tab) => (k === "all" ? counts?.all : k === "mine" ? counts?.mine : k === "shared" ? counts?.shared : k === "private" ? counts?.private : k === "boards" ? counts?.boards : k === "forms" ? counts?.forms : counts?.archived) ?? 0;
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 0 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>Docs</span>
          <span className="ld-row">
            <Menu label="New" button="+ New doc ▾" buttonClass="ld-btn p gp-auto">
              {(close) => (
                <>
                  <button type="button" role="menuitem" onClick={() => { setMaking("doc"); close(); }}>Doc</button>
                  <button type="button" role="menuitem" onClick={() => { setMaking("board"); close(); }}>Whiteboard</button>
                </>
              )}
            </Menu>
          </span>
        </div>
        <div className="gp-views" role="tablist" aria-label="Docs">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`gp-vw ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
              {k === "private" ? "🔒 " : ""}{label} <span className="ld-small ld-muted" style={{ fontWeight: 600 }}>{count(k)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="gp-tool">
        <span className="gp-tool-l">
          <select className="gp-fb" aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Folder: any</option>
            {(d?.folders ?? []).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <select className="gp-fb" aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Tag: any</option>
            {(d?.tags ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select className="gp-fb" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as "updated" | "name")}>
            <option value="updated">Sort: Updated</option>
            <option value="name">Sort: Name</option>
          </select>
        </span>
        <span className="gp-tool-r">
          <input className="gp-srch" style={{ width: 280 }} placeholder="Search docs and what is in them" aria-label="Search docs" value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
      </div>
      <div className="gp-canvas" style={{ flexDirection: "column" }}>
        <ErrorLine error={data.error} />
        {starred.length > 0 && tab !== "archived" && (
          <div className="gp-starred" aria-label="Starred">
            {starred.slice(0, 6).map((x) => (
              <button key={`${x.kind}${x.id}`} type="button" className="gp-starcard" onClick={() => open(x)}>
                <span className="gp-star on">★</span>
                <span style={{ minWidth: 0 }}>
                  <b className="gp-ell" style={{ display: "block" }}>{x.name}</b>
                  <span className="ld-small ld-muted gp-ell" style={{ display: "block" }}>{x.where?.name ?? "Not in a folder"}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="gp-gl" style={{ width: "100%" }}>
          <div className="gp-drow h"><span>Name</span><span>Location</span><span>Tags</span><span>Updated</span><span>Owner</span><span /></div>
          {rows.map((x) => (
            <div key={`${x.kind}${x.id}`} className="gp-drow" role="button" tabIndex={0} onClick={() => open(x)} onKeyDown={(e) => e.key === "Enter" && open(x)}>
              <span className="gp-dnm">
                <span className={`gp-dicon ${x.kind}`} aria-hidden="true">{ICON[x.kind]}</span>
                <button type="button" className={`gp-star ${x.starred ? "on" : ""}`} aria-label={x.starred ? "Remove the star" : "Star"} aria-pressed={x.starred} onClick={(e) => { e.stopPropagation(); star.mutate({ organizationId: orgId, kind: x.kind, id: x.id, on: !x.starred }); }}>★</button>
                <b className="gp-ell">{x.name}</b>
                {x.private && <span className="ld-small ld-muted" title="Private">🔒</span>}
                {x.pages > 0 && <span className="ld-small ld-muted">{x.pages} page{x.pages === 1 ? "" : "s"}</span>}
                <span className="gp-dacts" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="ld-btn sm gp-auto" onClick={() => copy(x)}>{copied === `${x.kind}${x.id}` ? "Copied" : "Copy link"}</button>
                  {x.kind === "doc" && <button type="button" className="ld-btn sm gp-auto" onClick={() => setSharing({ id: x.id, name: x.name })}>Share</button>}
                </span>
              </span>
              <span className="gp-ell ld-muted">{x.where ? `${x.where.kind === "folder" ? "📁" : "☰"} ${x.where.name}` : "–"}</span>
              <span className="gp-ell">{x.tags.length ? x.tags.map((t) => <span key={t} className="gp-chip" style={{ marginRight: 4 }}>{t}</span>) : <span className="ld-muted">–</span>}</span>
              <span className="ld-muted">{fmtAt(x.at)}</span>
              <span className="gp-ell ld-muted">{x.by || "–"}</span>
              <span onClick={(e) => e.stopPropagation()}>
                <Menu label={`Options for ${x.name}`}>
                  {(close) => (
                    <>
                      <button type="button" role="menuitem" onClick={() => { open(x); close(); }}>Open</button>
                      {x.kind !== "form" && <button type="button" role="menuitem" onClick={() => { setMoving({ kind: x.kind, id: x.id, name: x.name, tags: x.tags }); close(); }}>Move or tag</button>}
                      {x.kind === "doc" && <button type="button" role="menuitem" onClick={() => { archive.mutate({ organizationId: orgId, id: x.id, on: !x.archived }); close(); }}>{x.archived ? "Restore" : "Archive"}</button>}
                      <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete "${x.name}"?`)) { if (x.kind === "doc") removeDoc.mutate({ organizationId: orgId, id: x.id }); else if (x.kind === "board") removeBoard.mutate({ organizationId: orgId, id: x.id }); else removeForm.mutate({ organizationId: orgId, id: x.id }); } close(); }}>Delete</button>
                    </>
                  )}
                </Menu>
              </span>
            </div>
          ))}
          {!rows.length && <div className="gp-empty">{q ? "Nothing matches." : tab === "archived" ? "Nothing archived." : tab === "shared" ? "Nothing shared with you yet." : "No docs yet. Make one with + New doc, or from a folder or list."}</div>}
        </div>
      </div>
      {moving && <MoveDoc orgId={orgId} item={moving} tree={tree.data} onClose={() => setMoving(null)} onDone={async () => { setMoving(null); await done(); }} />}
      {making && <NewDoc orgId={orgId} kind={making} tree={tree.data} onClose={() => setMaking(null)} onMade={async (w) => { setMaking(null); await done(); onPick(w); }} />}
      {sharing && <DocShare orgId={orgId} docId={sharing.id} name={sharing.name} canChange onClose={() => { setSharing(null); void done(); }} />}
    </>
  );
}

type TreeOut = Outputs["pj"]["tree"] | undefined;
function listFolder(tree: TreeOut, listId: number) {
  return tree?.folders.find((f) => f.lists.some((l) => l.id === listId))?.id ?? null;
}

/** Where a doc or whiteboard lives, and its tags. */
function MoveDoc({ orgId, item, tree, onClose, onDone }: { orgId: number; item: { kind: "doc" | "board"; id: number; name: string; tags: string[] }; tree: TreeOut; onClose: () => void; onDone: () => Promise<unknown> }) {
  const [place, setPlace] = React.useState("");
  const [tags, setTags] = React.useState(item.tags.join(", "));
  const save = trpc.pj.placeDoc.useMutation({ onSuccess: () => void onDone() });
  const go = () => {
    const [kind, idRaw] = place.split(":");
    const id = Number(idRaw);
    save.mutate({ organizationId: orgId, kind: item.kind, id: item.id, ...(place === "" ? {} : kind === "none" ? { folderId: null, listId: null } : kind === "folder" ? { folderId: id, listId: null } : { listId: id }), tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={`Move or tag ${item.name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox" style={{ width: 480 }}>
        <div className="ld-between gp-mhead"><b>{item.name}</b></div>
        <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="ld-small" style={{ fontWeight: 700 }}>Where it lives</label>
          <select className="ld-in xs" aria-label="Where" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">Leave where it is</option>
            <option value="none:0">Not in a folder</option>
            {tree?.folders.map((f) => (
              <React.Fragment key={f.id}>
                <option value={`folder:${f.id}`}>📁 {f.name}</option>
                {f.lists.map((l) => (
                  <option key={l.id} value={`list:${l.id}`}>　☰ {l.name}</option>
                ))}
              </React.Fragment>
            ))}
            {tree?.loose.map((l) => (
              <option key={l.id} value={`list:${l.id}`}>☰ {l.name}</option>
            ))}
          </select>
          <label className="ld-small" style={{ fontWeight: 700 }}>Tags</label>
          <input className="ld-in xs" aria-label="Tags" placeholder="sop, intake" value={tags} onChange={(e) => setTags(e.target.value)} />
          <span className="ld-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={save.isPending} onClick={go}>Save</button>
          </span>
          <ErrorLine error={save.error} />
        </div>
      </div>
    </div>
  );
}

/** New doc or whiteboard from the Docs page: name it and say where it goes. */
function NewDoc({ orgId, kind, tree, onClose, onMade }: { orgId: number; kind: "doc" | "board"; tree: TreeOut; onClose: () => void; onMade: (w: Where) => Promise<unknown> }) {
  const [title, setTitle] = React.useState("");
  const [place, setPlace] = React.useState("none:0");
  const saveDoc = trpc.pj.saveDoc.useMutation({ onSuccess: (d) => void onMade({ scope: "doc", id: d.id }) });
  const saveBoard = trpc.pj.saveBoard.useMutation({ onSuccess: (b) => void onMade({ scope: "board", id: b.id }) });
  const go = () => {
    if (!title.trim()) return;
    const [k, idRaw] = place.split(":");
    const id = Number(idRaw);
    const at = k === "folder" ? { folderId: id } : k === "list" ? { listId: id } : { folderId: null };
    if (kind === "doc") saveDoc.mutate({ organizationId: orgId, title, ...at });
    else saveBoard.mutate({ organizationId: orgId, title, ...at });
  };
  return (
    <div className="gp-modal" role="dialog" aria-modal="true" aria-label={kind === "doc" ? "New doc" : "New whiteboard"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox" style={{ width: 480 }}>
        <div className="ld-between gp-mhead"><b>{kind === "doc" ? "New doc" : "New whiteboard"}</b></div>
        <div style={{ padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <input className="ld-in xs" autoFocus aria-label="Name" placeholder={kind === "doc" ? "Doc name" : "Whiteboard name"} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          <label className="ld-small" style={{ fontWeight: 700 }}>Where it goes</label>
          <select className="ld-in xs" aria-label="Where" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="none:0">Not in a folder</option>
            {tree?.folders.map((f) => (
              <React.Fragment key={f.id}>
                <option value={`folder:${f.id}`}>📁 {f.name}</option>
                {f.lists.map((l) => (
                  <option key={l.id} value={`list:${l.id}`}>　☰ {l.name}</option>
                ))}
              </React.Fragment>
            ))}
            {tree?.loose.map((l) => (
              <option key={l.id} value={`list:${l.id}`}>☰ {l.name}</option>
            ))}
          </select>
          <span className="ld-row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="ld-btn sm" onClick={onClose}>Cancel</button>
            <button type="button" className="ld-btn p sm" disabled={!title.trim() || saveDoc.isPending || saveBoard.isPending} onClick={go}>Make it</button>
          </span>
          <ErrorLine error={saveDoc.error || saveBoard.error} />
        </div>
      </div>
    </div>
  );
}
