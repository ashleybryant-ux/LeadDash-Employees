import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt, Menu } from "../goals/shared";
import { DocShare } from "./DocShare";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";
import { SaveTemplate } from "./Templates";

/**
 * A doc: headings, paragraphs, lists, checklists, quotes, tables, pictures and
 * task links, kept as blocks. Read view with Edit (Save or Cancel), selected
 * words become a task or a comment, sub-pages, linked tasks and comments.
 */

type D = Outputs["pj"]["doc"];
type Block = D["doc"]["blocks"][number];
/** A numbered line's number: how many numbered lines in a row end here. */
const numberAt = (blocks: { type: string }[], i: number) => {
  let k = i;
  while (k >= 0 && blocks[k].type === "number") k--;
  return i - k;
};
const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** **bold**, *italic* and [words](https://link), as React. */
export function Marks({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<b key={i++}>{m[1]}</b>);
    else if (m[2]) out.push(<i key={i++}>{m[2]}</i>);
    else out.push(<a key={i++} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function DocPage({ orgId, id, onPick, onOpenTask, refresh }: { orgId: number; id: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void; refresh: () => Promise<unknown> }) {
  const q = trpc.pj.doc.useQuery({ organizationId: orgId, id });
  const [editing, setEditing] = React.useState(false);
  const [saveTpl, setSaveTpl] = React.useState(false);
  const removeDoc = trpc.pj.removeDoc.useMutation({ onSuccess: async () => { await refresh(); onPick({ scope: "everything" }); } });
  const addPage = trpc.pj.saveDoc.useMutation({ onSuccess: async (d) => { await refresh(); onPick({ scope: "doc", id: d.id }); } });
  React.useEffect(() => {
    setEditing(false);
  }, [id]);
  const d = q.data;
  const [sharing, setSharing] = React.useState(false);
  const archive = trpc.pj.archiveDoc.useMutation({ onSuccess: async () => { await refresh(); void q.refetch(); } });
  if (!d) return <div className="gp-canvas"><ErrorLine error={q.error} />{q.isLoading && <span className="ld-muted">Opening the doc</span>}</div>;
  const canEdit = d.level === "edit";
  return (
    <>
      <div className="gp-head" style={{ paddingBottom: 14 }}>
        <div className="gp-hrow">
          <span className="gp-ttl" style={{ fontSize: 18 }}>
            {(d.parent || d.doc.folderName) && (
              <span className="crumb" style={{ fontSize: 14, marginLeft: 0 }}>
                {d.parent ? (
                  <button type="button" className="gp-link" onClick={() => onPick({ scope: "doc", id: d.parent!.id })}>{d.parent.title}</button>
                ) : (
                  d.doc.folderName
                )}{" "}
                /
              </span>
            )}
            {d.doc.title}
          </span>
          {!editing && (
            <span className="ld-row">
              {d.doc.private && <span className="gp-chip" title="Only the people it is shared with see it">🔒 Private</span>}
              <button type="button" className="ld-btn" onClick={() => setSharing(true)}>Share</button>
              {canEdit && !d.doc.archived && <button type="button" className="ld-btn" onClick={() => setEditing(true)}>Edit</button>}
              <Menu label="Doc options">
                {(close) => (
                  <>
                    <button type="button" role="menuitem" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/projects?page=doc&id=${d.doc.id}`); close(); }}>Copy link</button>
                    <button type="button" role="menuitem" onClick={() => { window.print(); close(); }}>Print or save as PDF</button>
                    {canEdit && <button type="button" role="menuitem" onClick={() => { addPage.mutate({ organizationId: orgId, parentId: d.doc.id, title: "New page" }); close(); }}>Add a page</button>}
                    {canEdit && <button type="button" role="menuitem" onClick={() => { setSaveTpl(true); close(); }}>Save as a template</button>}
                    {canEdit && <button type="button" role="menuitem" onClick={() => { archive.mutate({ organizationId: orgId, id: d.doc.id, on: !d.doc.archived }); close(); }}>{d.doc.archived ? "Restore" : "Archive"}</button>}
                    {canEdit && <button type="button" role="menuitem" className="danger" onClick={() => { if (window.confirm(`Delete "${d.doc.title}"${d.pages.length ? " and its pages" : ""}?`)) removeDoc.mutate({ organizationId: orgId, id: d.doc.id }); close(); }}>Delete doc</button>}
                  </>
                )}
              </Menu>
            </span>
          )}
        </div>
      </div>
      {d.doc.archived && (
        <div className="gp-archbar">
          <span>This doc is archived. It stays out of the Docs list until it is restored.</span>
          {canEdit && <button type="button" className="ld-btn sm gp-auto" onClick={() => archive.mutate({ organizationId: orgId, id: d.doc.id, on: false })}>Restore</button>}
        </div>
      )}
      <div className="gp-canvas">
        <div className="gp-docwrap">
          {editing ? <DocEdit orgId={orgId} d={d} onDone={() => setEditing(false)} refresh={refresh} /> : <DocRead orgId={orgId} d={d} onOpenTask={onOpenTask} />}
          <DocSide orgId={orgId} d={d} onPick={onPick} onOpenTask={onOpenTask} addPage={() => addPage.mutate({ organizationId: orgId, parentId: d.doc.id, title: "New page" })} />
        </div>
        <ErrorLine error={removeDoc.error || addPage.error} />
      </div>
      {saveTpl && <SaveTemplate orgId={orgId} kind="doc" sourceId={d.doc.id} name={d.doc.title} onClose={() => setSaveTpl(false)} />}
      {sharing && <DocShare orgId={orgId} docId={d.doc.id} name={d.doc.title} canChange={canEdit} onClose={() => { setSharing(false); void q.refetch(); }} />}
    </>
  );
}

function DocRead({ orgId, d, onOpenTask }: { orgId: number; d: D; onOpenTask: (id: number) => void }) {
  const utils = trpc.useUtils();
  const box = React.useRef<HTMLDivElement>(null);
  const [sel, setSel] = React.useState<{ text: string; x: number; y: number } | null>(null);
  const [mode, setMode] = React.useState<"" | "task" | "comment">("");
  const [listId, setListId] = React.useState<number | "">("");
  const [note, setNote] = React.useState("");
  const tree = trpc.pj.tree.useQuery({ organizationId: orgId });
  const lists = [...(tree.data?.folders ?? []).flatMap((f) => f.lists.map((l) => ({ id: l.id, name: `${f.name} › ${l.name}` }))), ...(tree.data?.loose ?? []).map((l) => ({ id: l.id, name: l.name }))];
  const toggle = trpc.pj.toggleDocCheck.useMutation({ onSuccess: () => utils.pj.doc.invalidate() });
  const makeTask = trpc.pj.docTask.useMutation({ onSuccess: async (t) => { setSel(null); setMode(""); await utils.pj.doc.invalidate(); onOpenTask(t.id); } });
  const comment = trpc.pj.docComment.useMutation({ onSuccess: async () => { setSel(null); setMode(""); setNote(""); await utils.pj.doc.invalidate(); } });
  React.useEffect(() => {
    const h = () => {
      if (mode) return;
      const s = window.getSelection();
      const text = s?.toString().trim() ?? "";
      if (!s || !text || !box.current || !s.anchorNode || !box.current.contains(s.anchorNode)) return setSel(null);
      const r = s.getRangeAt(0).getBoundingClientRect();
      const b = box.current.getBoundingClientRect();
      setSel({ text, x: Math.max(0, Math.min(r.left - b.left, b.width - 330)), y: r.bottom - b.top + 8 });
    };
    document.addEventListener("selectionchange", h);
    return () => document.removeEventListener("selectionchange", h);
  }, [mode]);
  let n = 0;
  return (
    <div className="gp-doc" ref={box}>
      <div className="ld-small ld-muted" style={{ marginBottom: 14 }}>
        {d.doc.folderName ? `${d.doc.folderName} · ` : ""}Doc{d.doc.editedBy ? ` · Edited by ${d.doc.editedBy}, ${fmtAt(d.doc.updatedAt)}` : ""}
      </div>
      <h1>{d.doc.title}</h1>
      {d.doc.blocks.map((b, i) => {
        n = b.type === "number" ? n + 1 : 0;
        const id = `blk-${b.id}`;
        if (b.type === "h1") return <h2 key={b.id} id={id} className="h1"><Marks text={b.text} /></h2>;
        if (b.type === "h2") return <h3 key={b.id} id={id}><Marks text={b.text} /></h3>;
        if (b.type === "bullet") return <p key={b.id} className="li">• <Marks text={b.text} /></p>;
        if (b.type === "number") return <p key={b.id} className="li">{n}. <Marks text={b.text} /></p>;
        if (b.type === "check")
          return (
            <label key={b.id} className="ck">
              <input type="checkbox" checked={!!b.done} onChange={(e) => toggle.mutate({ organizationId: orgId, id: d.doc.id, blockId: b.id, done: e.target.checked })} />
              <span style={b.done ? { textDecoration: "line-through", color: "#5b6b64" } : undefined}><Marks text={b.text} /></span>
            </label>
          );
        if (b.type === "quote") return <blockquote key={b.id}><Marks text={b.text} /></blockquote>;
        if (b.type === "divider") return <hr key={b.id} />;
        if (b.type === "image") return b.url ? <img key={b.id} src={b.url} alt={b.text || ""} className="img" /> : null;
        if (b.type === "table")
          return (
            <div key={b.id} className="gp-doctbl">
              <table>
                <tbody>
                  {(b.rows ?? []).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (ri === 0 ? <th key={ci}>{c}</th> : <td key={ci}>{c}</td>))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        if (b.type === "task") {
          const t = d.linked.find((x) => x.id === b.taskId);
          return t ? (
            <p key={b.id}>
              <button type="button" className="gp-tlink" onClick={() => onOpenTask(t.id)}>↔ {t.name}{t.closed ? " ✓" : ""}</button>
            </p>
          ) : null;
        }
        return b.text ? <p key={b.id || i}><Marks text={b.text} /></p> : <p key={b.id || i} className="empty" />;
      })}
      {sel && (
        <div className="gp-pop" style={{ left: sel.x, top: sel.y }} onMouseDown={(e) => e.preventDefault()}>
          {!mode ? (
            <>
              <button type="button" className="on" onClick={() => { setMode("task"); setListId(lists[0]?.id ?? ""); }}>✓ Make a task</button>
              <button type="button" onClick={() => setMode("comment")}>Comment</button>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(sel.text); setSel(null); }}>Copy</button>
            </>
          ) : mode === "task" ? (
            <span className="gp-pop-form">
              <select className="ld-in xs" aria-label="List for the task" value={listId} onChange={(e) => setListId(Number(e.target.value))}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <button type="button" onClick={() => setMode("")}>Cancel</button>
              <button type="button" className="on" disabled={!listId || makeTask.isPending} onClick={() => listId && makeTask.mutate({ organizationId: orgId, id: d.doc.id, text: sel.text, listId })}>Make it</button>
            </span>
          ) : (
            <span className="gp-pop-form">
              <input className="ld-in xs" autoFocus aria-label="Comment" placeholder="Comment" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && note.trim() && comment.mutate({ organizationId: orgId, id: d.doc.id, quote: sel.text, body: note })} />
              <button type="button" onClick={() => setMode("")}>Cancel</button>
              <button type="button" className="on" disabled={!note.trim() || comment.isPending} onClick={() => comment.mutate({ organizationId: orgId, id: d.doc.id, quote: sel.text, body: note })}>Post</button>
            </span>
          )}
        </div>
      )}
      <ErrorLine error={toggle.error || makeTask.error || comment.error} />
    </div>
  );
}

function DocSide({ orgId, d, onPick, onOpenTask, addPage }: { orgId: number; d: D; onPick: (w: Where) => void; onOpenTask: (id: number) => void; addPage: () => void }) {
  const utils = trpc.useUtils();
  const [linking, setLinking] = React.useState(false);
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: false }, { enabled: linking });
  const link = trpc.pj.linkDocTask.useMutation({ onSuccess: () => { setLinking(false); void utils.pj.doc.invalidate(); } });
  const rmComment = trpc.pj.removeDocComment.useMutation({ onSuccess: () => utils.pj.doc.invalidate() });
  const heads = d.doc.blocks.filter((b) => (b.type === "h1" || b.type === "h2") && b.text.trim());
  return (
    <aside className="gp-docside">
      {heads.length > 0 && (
        <>
          <h4>In this doc</h4>
          {heads.map((h) => (
            <button key={h.id} type="button" className="gp-doc-out" style={h.type === "h2" ? { paddingLeft: 12 } : undefined} onClick={() => document.getElementById(`blk-${h.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              {h.text.replace(/\*+/g, "")}
            </button>
          ))}
        </>
      )}
      <h4 className="ld-between">
        Linked tasks
        {!linking && <button type="button" className="gp-link" onClick={() => setLinking(true)}>+ Link</button>}
      </h4>
      {d.linked.map((t) => (
        <span key={t.id} className="ld-between">
          <button type="button" className="gp-tlink gp-ell" onClick={() => onOpenTask(t.id)}>↔ {t.name}</button>
          {d.explicit.includes(t.id) && <button type="button" className="gp-x" aria-label={`Unlink ${t.name}`} onClick={() => link.mutate({ organizationId: orgId, id: d.doc.id, taskId: t.id, on: false })}>×</button>}
        </span>
      ))}
      {!d.linked.length && !linking && <span className="ld-small ld-muted">None yet. Select words in the doc to make one.</span>}
      {linking && (
        <span className="ld-row">
          <select className="ld-in xs" aria-label="Task to link" defaultValue="" onChange={(e) => e.target.value && link.mutate({ organizationId: orgId, id: d.doc.id, taskId: Number(e.target.value), on: true })}>
            <option value="">Pick a task</option>
            {v.data?.tasks.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button type="button" className="ld-btn sm" onClick={() => setLinking(false)}>Cancel</button>
        </span>
      )}
      <h4>Pages</h4>
      {d.parent && <button type="button" className="gp-doc-out" onClick={() => onPick({ scope: "doc", id: d.parent!.id })}>↑ {d.parent.title}</button>}
      <span className="gp-doc-out on">{d.doc.title}</span>
      {d.pages.map((p) => (
        <button key={p.id} type="button" className="gp-doc-out" style={{ paddingLeft: 12 }} onClick={() => onPick({ scope: "doc", id: p.id })}>· {p.title}</button>
      ))}
      <button type="button" className="gp-doc-out add" onClick={addPage}>+ Add a page</button>
      {d.comments.length > 0 && (
        <>
          <h4>Comments</h4>
          {d.comments.map((c) => (
            <div key={c.id} className="gp-doc-cm">
              {c.quote && <span className="q">"{c.quote}"</span>}
              <span>{c.body}</span>
              <span className="ld-small ld-muted ld-between">
                {c.authorName} · {fmtAt(c.at)}
                <button type="button" className="gp-x" aria-label="Remove comment" onClick={() => rmComment.mutate({ organizationId: orgId, id: c.id })}>×</button>
              </span>
            </div>
          ))}
        </>
      )}
      <h4>Who can see it</h4>
      <span className="ld-small ld-muted">Everyone in this workspace can read and edit it. Guests don't see docs.</span>
      <ErrorLine error={link.error || rmComment.error} />
    </aside>
  );
}

const TOOLS: { type: Block["type"]; label: string }[] = [
  { type: "h1", label: "H1" },
  { type: "h2", label: "H2" },
  { type: "bullet", label: "• List" },
  { type: "number", label: "1. List" },
  { type: "check", label: "☐ Checklist" },
  { type: "quote", label: "Quote" },
  { type: "table", label: "Table" },
  { type: "image", label: "Image" },
  { type: "task", label: "@ Task" },
  { type: "divider", label: "Divider" },
];

function DocEdit({ orgId, d, onDone, refresh }: { orgId: number; d: D; onDone: () => void; refresh: () => Promise<unknown> }) {
  const utils = trpc.useUtils();
  const save = trpc.pj.saveDoc.useMutation({ onSuccess: async () => { await Promise.all([utils.pj.doc.invalidate(), refresh()]); onDone(); } });
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: false });
  const [title, setTitle] = React.useState(d.doc.title);
  const [blocks, setBlocks] = React.useState<Block[]>(d.doc.blocks.length ? d.doc.blocks : [{ id: uid(), type: "p", text: "" }]);
  const [focus, setFocus] = React.useState(0);
  const refs = React.useRef<(HTMLTextAreaElement | null)[]>([]);
  // Each text box grows to fit its words.
  React.useLayoutEffect(() => {
    for (const el of refs.current) {
      if (!el) continue;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [blocks]);
  const put = (i: number, patch: Partial<Block>) => setBlocks(blocks.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  const insert = (at: number, b: Block) => {
    const next = [...blocks.slice(0, at), b, ...blocks.slice(at)];
    setBlocks(next);
    setFocus(at);
    setTimeout(() => refs.current[at]?.focus(), 0);
  };
  const add = (type: Block["type"]) => {
    const cur = blocks[focus];
    // A tool on an empty text block turns it into that block.
    if (cur && !cur.text && ["p", "h1", "h2", "bullet", "number", "check", "quote"].includes(cur.type) && ["h1", "h2", "bullet", "number", "check", "quote", "p"].includes(type)) return put(focus, { type });
    insert(focus + 1, { id: uid(), type, text: "", ...(type === "table" ? { rows: [["", "", ""], ["", "", ""], ["", "", ""]] } : {}), ...(type === "check" ? { done: false } : {}) });
  };
  const wrap = (mark: string) => {
    const el = refs.current[focus];
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    if (a === b) return;
    put(focus, { text: `${value.slice(0, a)}${mark}${value.slice(a, b)}${mark}${value.slice(b)}` });
  };
  const keyDown = (i: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const b = blocks[i];
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Keep making list lines; an empty list line ends the list.
      if (["bullet", "number", "check"].includes(b.type) && !b.text) return put(i, { type: "p" });
      insert(i + 1, { id: uid(), type: ["bullet", "number", "check"].includes(b.type) ? b.type : "p", text: "", ...(b.type === "check" ? { done: false } : {}) });
    } else if (e.key === "Backspace" && !b.text && blocks.length > 1) {
      e.preventDefault();
      setBlocks(blocks.filter((_, k) => k !== i));
      setFocus(Math.max(0, i - 1));
      setTimeout(() => refs.current[Math.max(0, i - 1)]?.focus(), 0);
    }
  };
  return (
    <div className="gp-doc editing">
      <div className="gp-doc-tools" role="toolbar" aria-label="Formatting">
        <button type="button" className="gp-fb" onClick={() => wrap("**")} aria-label="Bold">B</button>
        <button type="button" className="gp-fb" onClick={() => wrap("*")} aria-label="Italic"><i>I</i></button>
        {TOOLS.map((t) => (
          <button key={t.type} type="button" className="gp-fb" onClick={() => add(t.type)}>{t.label}</button>
        ))}
        <span style={{ marginLeft: "auto" }} className="ld-row">
          <button type="button" className="ld-btn sm" onClick={onDone}>Cancel</button>
          <button type="button" className="ld-btn p sm" disabled={save.isPending || !title.trim()} onClick={() => save.mutate({ organizationId: orgId, id: d.doc.id, title, blocks: blocks.map((b) => ({ ...b, url: b.url ?? undefined, taskId: b.taskId ?? undefined, done: b.done ?? undefined, rows: b.rows ?? undefined })) })}>Save</button>
        </span>
      </div>
      <input className="gp-doc-title" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      {blocks.map((b, i) => (
        <div key={b.id} className={`gp-eb t-${b.type} ${focus === i ? "on" : ""}`}>
          {b.type === "table" ? (
            <div className="gp-doctbl">
              <table>
                <tbody>
                  {(b.rows ?? []).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td key={ci}>
                          <input className="ld-in xs" aria-label={`Row ${ri + 1}, column ${ci + 1}`} value={c} onFocus={() => setFocus(i)} onChange={(e) => put(i, { rows: (b.rows ?? []).map((rr, x) => (x === ri ? rr.map((cc, y) => (y === ci ? e.target.value : cc)) : rr)) })} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <span className="ld-row">
                <button type="button" className="gp-link" onClick={() => put(i, { rows: [...(b.rows ?? []), (b.rows?.[0] ?? ["", ""]).map(() => "")] })}>+ Row</button>
                <button type="button" className="gp-link" onClick={() => put(i, { rows: (b.rows ?? []).map((r) => [...r, ""]) })}>+ Column</button>
                <button type="button" className="gp-link danger" onClick={() => setBlocks(blocks.filter((_, k) => k !== i))}>Remove table</button>
              </span>
            </div>
          ) : b.type === "image" ? (
            <ImageBlock orgId={orgId} b={b} onChange={(p) => put(i, p)} onRemove={() => setBlocks(blocks.filter((_, k) => k !== i))} />
          ) : b.type === "task" ? (
            <span className="ld-row">
              <select className="ld-in xs" aria-label="Task" value={b.taskId ?? ""} onChange={(e) => put(i, { taskId: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">Pick a task</option>
                {v.data?.tasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.listName})</option>
                ))}
              </select>
              <button type="button" className="ld-btn sm" onClick={() => setBlocks(blocks.filter((_, k) => k !== i))}>Remove</button>
            </span>
          ) : b.type === "divider" ? (
            <span className="ld-row" style={{ alignItems: "center" }}>
              <hr style={{ flex: 1 }} />
              <button type="button" className="gp-x" aria-label="Remove divider" onClick={() => setBlocks(blocks.filter((_, k) => k !== i))}>×</button>
            </span>
          ) : (
            <span className="ld-row" style={{ alignItems: "flex-start" }}>
              {b.type === "bullet" && <span className="mk">•</span>}
              {b.type === "number" && <span className="mk">{numberAt(blocks, i)}.</span>}
              {b.type === "check" && <input type="checkbox" className="mk" aria-label="Done" checked={!!b.done} onChange={(e) => put(i, { done: e.target.checked })} />}
              <textarea
                ref={(el) => { refs.current[i] = el; }}
                rows={1}
                aria-label={b.type === "h1" ? "Heading" : b.type === "h2" ? "Subheading" : "Text"}
                placeholder={i === 0 && !b.text ? "Start writing" : b.type === "p" ? "" : b.type === "h1" ? "Heading" : b.type === "h2" ? "Subheading" : ""}
                value={b.text}
                onFocus={() => setFocus(i)}
                onKeyDown={(e) => keyDown(i, e)}
                onChange={(e) => {
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                  put(i, { text: e.target.value });
                }}
                style={{ height: "auto" }}
              />
            </span>
          )}
        </div>
      ))}
      <ErrorLine error={save.error} />
    </div>
  );
}

function ImageBlock({ orgId, b, onChange, onRemove }: { orgId: number; b: Block; onChange: (p: Partial<Block>) => void; onRemove: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <div className="ld-row" style={{ flexWrap: "wrap" }}>
      {b.url ? <img src={b.url} alt="" style={{ maxHeight: 160, borderRadius: 8 }} /> : <span className="ld-small ld-muted">No picture yet.</span>}
      <label className="ld-btn sm" style={{ width: 128 }}>
        {busy ? "Uploading" : b.url ? "Change picture" : "Add a picture"}
        <input
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            setBusy(true);
            setErr(null);
            try {
              const { uploadFile } = await import("../meta");
              const r = await uploadFile("work", f, { organizationId: orgId, employeeId: 0 });
              onChange({ url: r.url, text: f.name });
            } catch (x) {
              setErr((x as Error).message);
            }
            setBusy(false);
          }}
        />
      </label>
      <button type="button" className="ld-btn sm" onClick={onRemove}>Remove</button>
      {err && <span className="ld-small" role="alert" style={{ color: "#b42318" }}>{err}</span>}
    </div>
  );
}
