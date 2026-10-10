import React from "react";
import DOMPurify from "dompurify";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { Color } from "@tiptap/extension-color";
import TextStyle from "@tiptap/extension-text-style";
import Placeholder from "@tiptap/extension-placeholder";
import Mention from "@tiptap/extension-mention";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";
import { fmtAt, Menu } from "../goals/shared";
import { DocShare } from "./DocShare";
import type { Outputs } from "../types";
import type { Where } from "../pages/Projects";
import { SaveTemplate } from "./Templates";

/**
 * A doc: one page you type on, the way a Google Doc or Word doc works. The
 * toolbar has the usual tools, "/" opens the block menu, "@" mentions a task.
 * Read view shows the same page with Share and Edit; Edit opens the toolbar
 * with Save and Cancel in the header. Selected words in the read view become
 * a task or a comment. Sub-pages, linked tasks and comments sit at the right.
 */

type D = Outputs["pj"]["doc"];

/** The page's HTML, cleaned again here before it goes in the DOM. */
const clean = (html: string) => DOMPurify.sanitize(html, { ADD_ATTR: ["target", "colwidth"], FORBID_TAGS: ["style", "script", "iframe"] });

/** Headings on a page, in order, for the outline. */
function headingsOf(html: string) {
  const dom = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return Array.from(dom.querySelectorAll("h1, h2, h3")).map((h, i) => ({ i, level: Number(h.tagName[1]), text: h.textContent?.trim() ?? "" })).filter((h) => h.text);
}
const jumpTo = (box: HTMLElement | null, i: number) => box?.querySelectorAll("h1, h2, h3")[i]?.scrollIntoView({ behavior: "smooth", block: "start" });

export function DocPage({ orgId, id, onPick, onOpenTask, refresh }: { orgId: number; id: number; onPick: (w: Where) => void; onOpenTask: (id: number) => void; refresh: () => Promise<unknown> }) {
  const q = trpc.pj.doc.useQuery({ organizationId: orgId, id });
  const [editing, setEditing] = React.useState(false);
  const [saveTpl, setSaveTpl] = React.useState(false);
  const removeDoc = trpc.pj.removeDoc.useMutation({ onSuccess: async () => { await refresh(); onPick({ scope: "everything" }); } });
  const addPage = trpc.pj.saveDoc.useMutation({ onSuccess: async (d) => { await refresh(); onPick({ scope: "doc", id: d.id }); } });
  const editRef = React.useRef<{ save: () => void; busy: boolean; canSave: boolean } | null>(null);
  const [, bump] = React.useState(0);
  const changed = React.useCallback(() => bump((n) => n + 1), []);
  React.useEffect(() => {
    setEditing(false);
  }, [id]);
  const d = q.data;
  const [sharing, setSharing] = React.useState(false);
  const archive = trpc.pj.archiveDoc.useMutation({ onSuccess: async () => { await refresh(); void q.refetch(); } });
  const pageRef = React.useRef<HTMLDivElement>(null);
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
          {editing ? (
            <span className="ld-row">
              <button type="button" className="ld-btn" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" className="ld-btn p" disabled={!editRef.current || editRef.current.busy || !editRef.current.canSave} onClick={() => editRef.current?.save()}>Save</button>
            </span>
          ) : (
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
      <div className="gp-canvas gp-doccanvas">
        <div className="gp-docwrap">
          {editing ? (
            <DocEdit orgId={orgId} d={d} handle={editRef} pageRef={pageRef} onChange={changed} onDone={() => setEditing(false)} refresh={refresh} />
          ) : (
            <DocRead orgId={orgId} d={d} pageRef={pageRef} onOpenTask={onOpenTask} />
          )}
          <DocSide orgId={orgId} d={d} onPick={onPick} onOpenTask={onOpenTask} heads={editing && pageRef.current ? headingsOf(pageRef.current.innerHTML) : headingsOf(d.doc.html)} onJump={(i) => jumpTo(pageRef.current, i)} addPage={() => addPage.mutate({ organizationId: orgId, parentId: d.doc.id, title: "New page" })} />
        </div>
        <ErrorLine error={removeDoc.error || addPage.error} />
      </div>
      {saveTpl && <SaveTemplate orgId={orgId} kind="doc" sourceId={d.doc.id} name={d.doc.title} onClose={() => setSaveTpl(false)} />}
      {sharing && <DocShare orgId={orgId} docId={d.doc.id} name={d.doc.title} canChange={canEdit} onClose={() => { setSharing(false); void q.refetch(); }} />}
    </>
  );
}

// ==========================================
// Read view: the page, with selected words becoming a task or a comment
// ==========================================

function DocRead({ orgId, d, pageRef, onOpenTask }: { orgId: number; d: D; pageRef: React.RefObject<HTMLDivElement | null>; onOpenTask: (id: number) => void }) {
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
  const canTick = d.level === "edit" || d.level === "comment";
  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const mention = el.closest(".gp-mention") as HTMLElement | null;
    if (mention?.dataset.id) return onOpenTask(Number(mention.dataset.id));
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      const items = Array.from(pageRef.current?.querySelectorAll('li[data-type="taskItem"]') ?? []);
      const i = items.findIndex((li) => li.contains(el));
      if (!canTick || i < 0) return e.preventDefault();
      toggle.mutate({ organizationId: orgId, id: d.doc.id, blockId: `k${i}`, done: el.checked });
    }
  };
  return (
    <div className="gp-docmain" ref={box}>
      <div className="gp-doc" onClick={click}>
        <div className="ld-small ld-muted" style={{ marginBottom: 14 }}>
          {d.doc.folderName ? `${d.doc.folderName} · ` : ""}Doc{d.doc.editedBy ? ` · Edited by ${d.doc.editedBy}, ${fmtAt(d.doc.updatedAt)}` : ""}
        </div>
        <h1 className="gp-doc-h">{d.doc.title}</h1>
        <div className="gp-page" ref={pageRef} dangerouslySetInnerHTML={{ __html: clean(d.doc.html) }} />
      </div>
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

// ==========================================
// The right column: outline, linked tasks, pages, comments
// ==========================================

function DocSide({ orgId, d, onPick, onOpenTask, heads, onJump, addPage }: { orgId: number; d: D; onPick: (w: Where) => void; onOpenTask: (id: number) => void; heads: { i: number; level: number; text: string }[]; onJump: (i: number) => void; addPage: () => void }) {
  const utils = trpc.useUtils();
  const [linking, setLinking] = React.useState(false);
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: false }, { enabled: linking });
  const link = trpc.pj.linkDocTask.useMutation({ onSuccess: () => { setLinking(false); void utils.pj.doc.invalidate(); } });
  const rmComment = trpc.pj.removeDocComment.useMutation({ onSuccess: () => utils.pj.doc.invalidate() });
  return (
    <aside className="gp-docside">
      {heads.length > 0 && (
        <>
          <h4>Outline</h4>
          {heads.map((h) => (
            <button key={h.i} type="button" className="gp-doc-out gp-ell" style={{ paddingLeft: (h.level - 1) * 12 }} onClick={() => onJump(h.i)}>
              {h.text}
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
      {!d.linked.length && !linking && <span className="ld-small ld-muted">None yet. Select words in the doc to make one, or type @ while editing.</span>}
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

// ==========================================
// The editor
// ==========================================

type PopItem = { id?: number; label: string; sub?: string; icon?: string; run?: (e: Editor) => void };
type PopState = { items: PopItem[]; index: number; rect: DOMRect | null; command: (item: PopItem) => void; title: string } | null;

/** The "/" and "@" menus: the Suggestion plugin tells the component what to show, and the component draws it. */
function popRender(title: string, set: (s: PopState) => void) {
  return () => {
    let cur: SuggestionProps<PopItem> | null = null;
    let index = 0;
    const show = () => cur && set({ items: cur.items, index, rect: cur.clientRect?.() ?? null, command: (it) => cur?.command(it), title });
    return {
      onStart: (p: SuggestionProps<PopItem>) => { cur = p; index = 0; show(); },
      onUpdate: (p: SuggestionProps<PopItem>) => { cur = p; index = Math.min(index, Math.max(0, p.items.length - 1)); show(); },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (!cur) return false;
        if (event.key === "Escape") { set(null); return true; }
        if (event.key === "ArrowDown") { index = (index + 1) % Math.max(1, cur.items.length); show(); return true; }
        if (event.key === "ArrowUp") { index = (index - 1 + cur.items.length) % Math.max(1, cur.items.length); show(); return true; }
        if (event.key === "Enter" || event.key === "Tab") { const it = cur.items[index]; if (it) cur.command(it); return true; }
        return false;
      },
      onExit: () => { cur = null; set(null); },
    };
  };
}

const SLASH: PopItem[] = [
  { label: "Text", sub: "Plain paragraph", icon: "T", run: (e) => e.chain().focus().setParagraph().run() },
  { label: "Heading 1", sub: "Big section title", icon: "H1", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", sub: "Section title", icon: "H2", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", sub: "Small title", icon: "H3", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Bulleted list", icon: "•", run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", icon: "1.", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Checklist", icon: "☑", run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Table", sub: "3 columns, 3 rows", icon: "▦", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Quote", icon: "“", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Code", icon: "<>", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { label: "Divider", icon: "—", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

/** Text size as an inline style on the words, next to color. */
const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [{ types: ["textStyle"], attributes: { fontSize: { default: null, parseHTML: (el: HTMLElement) => el.style.fontSize || null, renderHTML: (a: { fontSize?: string | null }) => (a.fontSize ? { style: `font-size: ${a.fontSize}` } : {}) } } }];
  },
});

const COLORS = ["#14221c", "#1b6b4a", "#1d4fb8", "#b4261f", "#b36a00", "#6b3fb8", "#5b6b64"];
const HIGHLIGHTS = ["#fff3a3", "#d8f3e3", "#dbe8ff", "#ffd9d6", "#ffe2b8", "#eadcff"];
const SIZES = ["11px", "12px", "13px", "14px", "15px", "16px", "18px", "20px", "24px", "28px", "32px"];

/** A toolbar button. Mouse down is swallowed so the words stay selected in the page. */
function B({ on, label, onClick, children }: { on?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`gp-tb ${on ? "on" : ""}`} aria-label={label} title={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

function DocEdit({ orgId, d, handle, pageRef, onChange, onDone, refresh }: { orgId: number; d: D; handle: React.MutableRefObject<{ save: () => void; busy: boolean; canSave: boolean } | null>; pageRef: React.RefObject<HTMLDivElement | null>; onChange: () => void; onDone: () => void; refresh: () => Promise<unknown> }) {
  const utils = trpc.useUtils();
  const save = trpc.pj.saveDoc.useMutation({ onSuccess: async () => { await Promise.all([utils.pj.doc.invalidate(), refresh()]); onDone(); } });
  const ask = trpc.pj.docAsk.useMutation();
  const v = trpc.pj.view.useQuery({ organizationId: orgId, listId: null, scope: "everything", closed: false });
  const tasksRef = React.useRef<{ id: number; name: string; listName: string }[]>([]);
  tasksRef.current = v.data?.tasks ?? [];
  const [title, setTitle] = React.useState(d.doc.title);
  const [pop, setPop] = React.useState<PopState>(null);
  const [tool, setTool] = React.useState<"" | "link" | "color" | "mark" | "nora">("");
  const [href, setHref] = React.useState("");
  const [want, setWant] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      TextStyle,
      Color,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" } }),
      Image.configure({ inline: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder: "Start writing. Type / for a block, @ for a task." }),
      Extension.create({
        name: "slash",
        addProseMirrorPlugins() {
          return [
            Suggestion<PopItem, PopItem>({
              editor: this.editor,
              char: "/",
              allowSpaces: false,
              items: ({ query }) => SLASH.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
              command: ({ editor: e, range, props }) => { e.chain().focus().deleteRange(range).run(); props.run?.(e); },
              render: popRender("Blocks", setPop),
            }),
          ];
        },
      }),
      Mention.configure({
        HTMLAttributes: { class: "gp-mention" },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        suggestion: {
          char: "@",
          items: ({ query }) => tasksRef.current.filter((t) => t.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map((t) => ({ id: t.id, label: t.name, sub: t.listName })),
          command: ({ editor: e, range, props }) => e.chain().focus().insertContentAt(range, [{ type: "mention", attrs: { id: String(props.id), label: props.label } }, { type: "text", text: " " }]).run(),
          render: popRender("Tasks", setPop),
        },
      }),
    ],
    content: d.doc.html || "<p></p>",
    onUpdate: onChange,
    onSelectionUpdate: onChange,
  });
  const doSave = React.useCallback(() => {
    if (!editor || !title.trim()) return;
    save.mutate({ organizationId: orgId, id: d.doc.id, title, html: editor.getHTML() });
  }, [editor, title, orgId, d.doc.id, save]);
  handle.current = { save: doSave, busy: save.isPending, canSave: !!editor && !!title.trim() };
  React.useEffect(() => { onChange(); }, [title, save.isPending, editor, onChange]);
  if (!editor) return null;
  const block = editor.isActive("heading", { level: 1 }) ? "h1" : editor.isActive("heading", { level: 2 }) ? "h2" : editor.isActive("heading", { level: 3 }) ? "h3" : editor.isActive("blockquote") ? "quote" : editor.isActive("codeBlock") ? "code" : "p";
  const setBlock = (b: string) => {
    const c = editor.chain().focus();
    if (b === "h1" || b === "h2" || b === "h3") c.setHeading({ level: Number(b[1]) as 1 | 2 | 3 }).run();
    else if (b === "quote") c.setParagraph().setBlockquote().run();
    else if (b === "code") c.setCodeBlock().run();
    else c.clearNodes().setParagraph().run();
  };
  const size = (editor.getAttributes("textStyle").fontSize as string | undefined) ?? "15px";
  const insertNora = (text: string) => {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const parts = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const html = parts
      .map((p) => {
        if (/^## /.test(p)) return `<h2>${esc(p.slice(3))}</h2>`;
        if (p.split("\n").every((l) => /^- /.test(l))) return `<ul>${p.split("\n").map((l) => `<li><p>${esc(l.slice(2))}</p></li>`).join("")}</ul>`;
        return `<p>${esc(p).replace(/\n/g, "<br>")}</p>`;
      })
      .join("");
    editor.chain().focus().insertContent(html).run();
  };
  const upload = async (f: File) => {
    setUploading(true);
    setErr(null);
    try {
      const { uploadFile } = await import("../meta");
      const r = await uploadFile("work", f, { organizationId: orgId, employeeId: 0 });
      editor.chain().focus().setImage({ src: r.url, alt: f.name }).run();
    } catch (x) {
      setErr((x as Error).message);
    }
    setUploading(false);
  };
  const inTable = editor.isActive("table");
  return (
    <div className="gp-docmain editing">
      <div className="gp-dtb" role="toolbar" aria-label="Formatting">
        <B label="Undo" onClick={() => editor.chain().focus().undo().run()}>↶</B>
        <B label="Redo" onClick={() => editor.chain().focus().redo().run()}>↷</B>
        <span className="sep" />
        <select className="gp-tb sel" aria-label="Text style" value={block} onChange={(e) => setBlock(e.target.value)}>
          <option value="p">Normal text</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="quote">Quote</option>
          <option value="code">Code</option>
        </select>
        <select className="gp-tb sel sm" aria-label="Text size" value={SIZES.includes(size) ? size : "15px"} onChange={(e) => (e.target.value === "15px" ? editor.chain().focus().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run() : editor.chain().focus().setMark("textStyle", { fontSize: e.target.value }).run())}>
          {SIZES.map((s) => (
            <option key={s} value={s}>{s.replace("px", "")}</option>
          ))}
        </select>
        <span className="sep" />
        <B label="Bold" on={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></B>
        <B label="Italic" on={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></B>
        <B label="Underline" on={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></B>
        <B label="Strikethrough" on={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></B>
        <span className="gp-tbwrap">
          <B label="Text color" on={tool === "color"} onClick={() => setTool(tool === "color" ? "" : "color")}><span className="ink" style={{ borderBottomColor: (editor.getAttributes("textStyle").color as string) || "var(--ld-ink)" }}>A</span></B>
          {tool === "color" && (
            <span className="gp-swatches" onMouseDown={(e) => e.preventDefault()}>
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={`Color ${c}`} style={{ background: c }} onClick={() => { editor.chain().focus().setColor(c).run(); setTool(""); }} />
              ))}
              <button type="button" className="none" onClick={() => { editor.chain().focus().unsetColor().run(); setTool(""); }}>Default</button>
            </span>
          )}
        </span>
        <span className="gp-tbwrap">
          <B label="Highlight" on={tool === "mark" || editor.isActive("highlight")} onClick={() => setTool(tool === "mark" ? "" : "mark")}><span className="hl">A</span></B>
          {tool === "mark" && (
            <span className="gp-swatches" onMouseDown={(e) => e.preventDefault()}>
              {HIGHLIGHTS.map((c) => (
                <button key={c} type="button" aria-label={`Highlight ${c}`} style={{ background: c }} onClick={() => { editor.chain().focus().setHighlight({ color: c }).run(); setTool(""); }} />
              ))}
              <button type="button" className="none" onClick={() => { editor.chain().focus().unsetHighlight().run(); setTool(""); }}>None</button>
            </span>
          )}
        </span>
        <span className="sep" />
        <span className="gp-tbwrap">
          <B label="Link" on={editor.isActive("link")} onClick={() => { setHref((editor.getAttributes("link").href as string) ?? ""); setTool(tool === "link" ? "" : "link"); }}>🔗</B>
          {tool === "link" && (
            <form className="gp-tbform" onSubmit={(e) => { e.preventDefault(); if (href.trim()) editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run(); else editor.chain().focus().extendMarkRange("link").unsetLink().run(); setTool(""); }}>
              <input className="ld-in xs" autoFocus aria-label="Link address" placeholder="https://" value={href} onChange={(e) => setHref(e.target.value)} />
              <button type="submit" className="ld-btn p sm">Apply</button>
              {editor.isActive("link") && <button type="button" className="ld-btn sm" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setTool(""); }}>Remove</button>}
            </form>
          )}
        </span>
        <label className="gp-tb" title="Picture" aria-label="Picture" onMouseDown={(e) => e.preventDefault()}>
          {uploading ? "…" : "🖼"}
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        </label>
        <B label="Mention a task" onClick={() => editor.chain().focus().insertContent("@").run()}>@</B>
        <span className="sep" />
        <B label="Align left" on={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()}>≡</B>
        <B label="Align center" on={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}>☰</B>
        <B label="Align right" on={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}>⇔</B>
        <span className="sep" />
        <B label="Bulleted list" on={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</B>
        <B label="Numbered list" on={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</B>
        <B label="Checklist" on={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}>☑ List</B>
        <B label="Outdent" onClick={() => (editor.can().liftListItem("taskItem") ? editor.chain().focus().liftListItem("taskItem").run() : editor.chain().focus().liftListItem("listItem").run())}>⇤</B>
        <B label="Indent" onClick={() => (editor.can().sinkListItem("taskItem") ? editor.chain().focus().sinkListItem("taskItem").run() : editor.chain().focus().sinkListItem("listItem").run())}>⇥</B>
        <span className="sep" />
        <B label="Table" on={inTable} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦ Table</B>
        <B label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>— Divider</B>
        <B label="Quote" on={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>“ Quote</B>
        <B label="Code" on={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>&lt;&gt; Code</B>
        <span className="sep" />
        <span className="gp-tbwrap">
          <B label="Ask Nora" on={tool === "nora"} onClick={() => setTool(tool === "nora" ? "" : "nora")}>✎ Ask Nora</B>
          {tool === "nora" && (
            <form className="gp-tbform col" onSubmit={(e) => { e.preventDefault(); if (!want.trim()) return; const selection = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, " "); ask.mutate({ organizationId: orgId, id: d.doc.id, prompt: want, selection: selection || undefined }, { onSuccess: (r) => { insertNora(r.text); setWant(""); setTool(""); } }); }}>
              <textarea className="ld-in" autoFocus aria-label="What should Nora write" placeholder="What should Nora write here? Select words first to have her work from them." value={want} onChange={(e) => setWant(e.target.value)} rows={3} />
              <span className="ld-row">
                <button type="button" className="ld-btn sm" onClick={() => setTool("")}>Cancel</button>
                <button type="submit" className="ld-btn p sm" disabled={ask.isPending || !want.trim()}>{ask.isPending ? "Writing" : "Write it"}</button>
              </span>
              <ErrorLine error={ask.error} />
            </form>
          )}
        </span>
      </div>
      {inTable && (
        <div className="gp-dtb sub" role="toolbar" aria-label="Table">
          <B label="Add a row below" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</B>
          <B label="Add a column after" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</B>
          <B label="Remove this row" onClick={() => editor.chain().focus().deleteRow().run()}>Remove row</B>
          <B label="Remove this column" onClick={() => editor.chain().focus().deleteColumn().run()}>Remove column</B>
          <B label="Header row" on={editor.isActive("tableHeader")} onClick={() => editor.chain().focus().toggleHeaderRow().run()}>Header row</B>
          <B label="Remove the table" onClick={() => editor.chain().focus().deleteTable().run()}>Remove table</B>
        </div>
      )}
      <div className="gp-doc editing" onClick={() => setTool("")}>
        <input className="gp-doc-title" aria-label="Title" placeholder="Untitled doc" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div ref={pageRef} className="gp-page">
          <EditorContent editor={editor} />
        </div>
      </div>
      {pop && pop.items.length > 0 && (
        <div className="gp-slash" style={{ left: Math.min(pop.rect?.left ?? 0, window.innerWidth - 300), top: (pop.rect?.bottom ?? 0) + 6 }} role="listbox" aria-label={pop.title} onMouseDown={(e) => e.preventDefault()}>
          <span className="t">{pop.title}</span>
          {pop.items.map((it, i) => (
            <button key={`${it.label}${it.id ?? ""}`} type="button" role="option" aria-selected={i === pop.index} className={i === pop.index ? "on" : ""} onClick={() => pop.command(it)}>
              {it.icon && <i>{it.icon}</i>}
              <span>
                <b>{it.label}</b>
                {it.sub && <small>{it.sub}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
      <ErrorLine error={save.error} />
      {err && <span className="ld-small" role="alert" style={{ color: "var(--ld-bad)" }}>{err}</span>}
    </div>
  );
}
