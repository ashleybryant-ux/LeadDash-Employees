import { TRPCError } from "@trpc/server";
import { Parser, parseDocument } from "htmlparser2";
import * as db from "../db";
import { generateText } from "../_core/llm";
import { createTask, parse, type Actor } from "./projects";

/**
 * Docs and whiteboards in Projects folders.
 *
 * A doc is a page of rich text, the way a Google Doc is: the editor saves
 * HTML, the server keeps only the tags and attributes a document needs (so
 * nothing anyone types can run as code when someone else opens it) and
 * derives the older block list from it for search, dashboards, the checklist
 * ticks and the public page. Docs written before the page editor keep their
 * blocks and get a page made from them when they open.
 *
 * A whiteboard is a canvas of sticky notes, shapes, freehand lines, text,
 * arrows between items and task cards; sticky notes can become tasks.
 */

export const BLOCK_TYPES = ["h1", "h2", "p", "bullet", "number", "check", "quote", "table", "image", "task", "divider"] as const;
export type Block = { id: string; type: (typeof BLOCK_TYPES)[number]; text: string; done?: boolean; rows?: string[][]; url?: string; taskId?: number };

const safeUrl = (u: string | undefined) => (u && (/^\/files\//.test(u) || /^https:\/\//.test(u)) ? u.slice(0, 600) : undefined);
const linkUrl = (u: string | undefined) => (u && (/^\/files\//.test(u) || /^https?:\/\//i.test(u) || /^mailto:/i.test(u)) ? u.slice(0, 600) : undefined);

// ==========================================
// The page: HTML in, safe HTML out
// ==========================================

const TAGS = new Set(["p", "h1", "h2", "h3", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "hr", "br", "table", "thead", "tbody", "tr", "th", "td", "img", "mark", "span", "code", "pre", "label", "input", "div"]);
const VOID = new Set(["hr", "br", "img", "input"]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only the styles the toolbar sets: color, highlight, size and alignment. */
function safeStyle(style: string) {
  const out: string[] = [];
  for (const part of style.split(";")) {
    const [k, v] = part.split(":").map((x) => (x ?? "").trim().toLowerCase());
    if (!k || !v) continue;
    if ((k === "color" || k === "background-color") && /^(#[0-9a-f]{3,8}|rgb\([\d\s,.]+\)|inherit|transparent|[a-z]{3,20})$/.test(v)) out.push(`${k}: ${v}`);
    else if (k === "font-size" && /^\d{1,2}(\.\d)?(px|pt|em|rem)$/.test(v)) out.push(`${k}: ${v}`);
    else if (k === "text-align" && /^(left|center|right|justify)$/.test(v)) out.push(`${k}: ${v}`);
  }
  return out.join("; ");
}

function safeAttrs(tag: string, a: Record<string, string>) {
  const out: string[] = [];
  const put = (k: string, v: string | undefined) => v !== undefined && out.push(`${k}="${esc(v)}"`);
  if (tag === "a") {
    put("href", linkUrl(a.href));
    out.push('target="_blank"', 'rel="noopener noreferrer"');
  }
  if (tag === "img") {
    const src = safeUrl(a.src);
    if (!src) return null;
    put("src", src);
    put("alt", (a.alt ?? "").slice(0, 300));
  }
  if (tag === "th" || tag === "td") {
    if (/^\d{1,2}$/.test(a.colspan ?? "")) put("colspan", a.colspan);
    if (/^\d{1,2}$/.test(a.rowspan ?? "")) put("rowspan", a.rowspan);
    if (/^[\d,]{1,40}$/.test(a.colwidth ?? "")) put("colwidth", a.colwidth);
  }
  if (tag === "input") {
    if (a.type !== "checkbox") return null;
    out.push('type="checkbox"');
    if (a.checked !== undefined) out.push('checked="checked"');
  }
  if (tag === "ul" && a["data-type"] === "taskList") put("data-type", "taskList");
  if (tag === "li" && a["data-type"] === "taskItem") {
    put("data-type", "taskItem");
    put("data-checked", a["data-checked"] === "true" ? "true" : "false");
  }
  if (tag === "span" && a["data-type"] === "mention" && /^\d{1,12}$/.test(a["data-id"] ?? "")) {
    put("data-type", "mention");
    put("data-id", a["data-id"]);
    put("data-label", (a["data-label"] ?? "").slice(0, 300));
    put("class", "gp-mention");
  }
  if (tag === "mark" && /^#[0-9a-f]{3,8}$/i.test(a["data-color"] ?? "")) put("data-color", a["data-color"]);
  if (tag === "code" && /^language-[a-z0-9]{1,20}$/i.test(a.class ?? "")) put("class", a.class);
  if (a.style) {
    const st = safeStyle(a.style);
    if (st) put("style", st);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

/** The HTML a doc page keeps: document tags only, safe links and pictures, no scripts, handlers or unknown attributes. */
export function sanitizeHtml(raw: string) {
  const html = String(raw ?? "").slice(0, 400_000);
  const out: string[] = [];
  const open: (string | null)[] = [];
  let skip = 0;
  const p = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (skip || !TAGS.has(tag)) {
          if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object" || tag === "embed" || tag === "svg" || tag === "math" || tag === "template" || skip) skip++;
          open.push(null);
          return;
        }
        const attrs = safeAttrs(tag, attribs);
        if (attrs === null) {
          open.push(null);
          return;
        }
        out.push(`<${tag}${attrs}>`);
        open.push(VOID.has(tag) ? null : tag);
      },
      ontext(text) {
        if (!skip) out.push(esc(text));
      },
      onclosetag() {
        if (skip) {
          skip--;
          open.pop();
          return;
        }
        const tag = open.pop();
        if (tag) out.push(`</${tag}>`);
      },
    },
    { decodeEntities: true }
  );
  p.write(html);
  p.end();
  return out.join("");
}

type Node = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: Node[] };
const textOf = (n: Node): string => (n.type === "text" ? n.data ?? "" : n.name === "br" ? "\n" : (n.children ?? []).map(textOf).join(""));
const kids = (n: Node) => (n.children ?? []).filter((c) => c.type === "tag" || c.type === "text");
const mentionsIn = (n: Node): Node[] => (n.type !== "tag" ? [] : n.attribs?.["data-type"] === "mention" ? [n] : kids(n).flatMap(mentionsIn));

/** The block list a page means, for search, dashboard cards, checklist ticks, the AI employees and templates. Check lines get ids k0, k1 ... in page order. */
export function blocksFromHtml(html: string): Block[] {
  const blocks: Block[] = [];
  let checks = 0;
  const push = (b: Omit<Block, "id">) => blocks.length < 600 && blocks.push({ id: b.type === "check" ? `k${checks++}` : `b${blocks.length}`, ...b } as Block);
  // A task mentioned in a line links the task to the doc.
  const tasks = (n: Node) => {
    for (const m of mentionsIn(n)) if (/^\d+$/.test(m.attribs?.["data-id"] ?? "")) push({ type: "task", text: m.attribs?.["data-label"] ?? "", taskId: Number(m.attribs!["data-id"]) });
  };
  const walk = (n: Node, list: "bullet" | "number" | "check" | null) => {
    if (n.type === "text") {
      const t = (n.data ?? "").trim();
      if (t) push({ type: "p", text: t });
      return;
    }
    if (n.type !== "tag") return;
    const tag = n.name ?? "";
    const text = () => textOf(n).replace(/\s+/g, " ").trim().slice(0, 8000);
    if (tag === "h1") return push({ type: "h1", text: text() }), tasks(n);
    if (tag === "h2" || tag === "h3") return push({ type: "h2", text: text() }), tasks(n);
    if (tag === "blockquote") return push({ type: "quote", text: text() }), tasks(n);
    if (tag === "hr") return push({ type: "divider", text: "" });
    if (tag === "img") return push({ type: "image", text: (n.attribs?.alt ?? "").slice(0, 300), url: safeUrl(n.attribs?.src) });
    if (tag === "pre") return push({ type: "p", text: textOf(n).slice(0, 8000) });
    if (tag === "table") {
      const rows: string[][] = [];
      const rowsOf = (m: Node) => {
        for (const c of kids(m)) {
          if (c.name === "tr") rows.push(kids(c).filter((x) => x.name === "td" || x.name === "th").slice(0, 10).map((x) => textOf(x).replace(/\s+/g, " ").trim().slice(0, 500)));
          else if (c.type === "tag") rowsOf(c);
        }
      };
      rowsOf(n);
      push({ type: "table", text: "", rows: rows.slice(0, 30) });
      return tasks(n);
    }
    if (tag === "ul" || tag === "ol") {
      const kind = tag === "ol" ? "number" : n.attribs?.["data-type"] === "taskList" ? "check" : "bullet";
      for (const li of kids(n)) if (li.name === "li") walk(li, kind);
      return;
    }
    if (tag === "li") {
      const own = kids(n).filter((c) => c.name !== "ul" && c.name !== "ol");
      const t = own.map(textOf).join("").replace(/\s+/g, " ").trim().slice(0, 8000);
      if (list === "check") push({ type: "check", text: t, done: n.attribs?.["data-checked"] === "true" });
      else push({ type: list ?? "bullet", text: t });
      for (const c of own) tasks(c);
      for (const c of kids(n)) if (c.name === "ul" || c.name === "ol") walk(c, null);
      return;
    }
    if (tag === "p" || tag === "div" || tag === "label" || tag === "span") {
      const t = text();
      if (t) push({ type: "p", text: t });
      tasks(n);
      return;
    }
    for (const c of kids(n)) walk(c, list);
  };
  for (const c of kids(parseDocument(html) as unknown as Node)) walk(c, null);
  return blocks;
}

/** **bold**, *italic* and [words](https://link) in a block's words, as HTML. */
function markHtml(text: string) {
  return esc(text)
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\*)(.+?)\*/g, "$1<em>$2</em>");
}

/** A page for a doc written as blocks before the page editor. */
export function htmlFromBlocks(blocks: Block[], tasks: { id: number; name: string }[] = []) {
  const out: string[] = [];
  let open: "ul" | "ol" | "task" | null = null;
  const close = () => {
    if (open === "ul") out.push("</ul>");
    if (open === "ol") out.push("</ol>");
    if (open === "task") out.push("</ul>");
    open = null;
  };
  for (const b of blocks) {
    const want = b.type === "bullet" ? "ul" : b.type === "number" ? "ol" : b.type === "check" ? "task" : null;
    if (want !== open) {
      close();
      if (want === "ul") out.push("<ul>");
      if (want === "ol") out.push("<ol>");
      if (want === "task") out.push('<ul data-type="taskList">');
      open = want;
    }
    if (b.type === "h1") out.push(`<h1>${markHtml(b.text)}</h1>`);
    else if (b.type === "h2") out.push(`<h2>${markHtml(b.text)}</h2>`);
    else if (b.type === "bullet" || b.type === "number") out.push(`<li><p>${markHtml(b.text)}</p></li>`);
    else if (b.type === "check") out.push(`<li data-type="taskItem" data-checked="${b.done ? "true" : "false"}"><label><input type="checkbox"${b.done ? ' checked="checked"' : ""}><span></span></label><div><p>${markHtml(b.text)}</p></div></li>`);
    else if (b.type === "quote") out.push(`<blockquote><p>${markHtml(b.text)}</p></blockquote>`);
    else if (b.type === "divider") out.push("<hr>");
    else if (b.type === "image") b.url && out.push(`<img src="${esc(b.url)}" alt="${esc(b.text || "")}">`);
    else if (b.type === "table") out.push(`<table><tbody>${(b.rows ?? []).map((r, ri) => `<tr>${r.map((c) => (ri === 0 ? `<th><p>${esc(c)}</p></th>` : `<td><p>${esc(c)}</p></td>`)).join("")}</tr>`).join("")}</tbody></table>`);
    else if (b.type === "task") {
      const t = tasks.find((x) => x.id === b.taskId);
      if (t) out.push(`<p><span data-type="mention" data-id="${t.id}" data-label="${esc(t.name)}" class="gp-mention">@${esc(t.name)}</span></p>`);
    } else out.push(`<p>${markHtml(b.text)}</p>`);
  }
  close();
  return out.join("");
}

/** The words on a page, for search and for the AI employees. */
export function textFromHtml(html: string) {
  return blocksFromHtml(html)
    .map((b) => (b.type === "table" ? (b.rows ?? []).map((r) => r.join(" | ")).join("\n") : b.type === "check" ? `[${b.done ? "x" : " "}] ${b.text}` : b.text))
    .filter(Boolean)
    .join("\n");
}

/** A doc's page: what it keeps, or one made from its blocks for docs older than the page editor. */
export function pageOf(orgId: number, d: { html: string; blocks: string }) {
  if (d.html) return d.html;
  const blocks = parse<Block[]>(d.blocks, []);
  const tasks = blocks.filter((b) => b.type === "task" && b.taskId).map((b) => db.work.tasks.get(orgId, b.taskId!)).filter((t): t is NonNullable<typeof t> => !!t);
  return htmlFromBlocks(blocks, tasks);
}

export function cleanBlocks(raw: Block[]): Block[] {
  return raw.slice(0, 600).map((b, i) => {
    const type = (BLOCK_TYPES as readonly string[]).includes(b.type) ? b.type : "p";
    return {
      id: String(b.id || `b${i}`).slice(0, 40),
      type,
      text: String(b.text ?? "").slice(0, 8000),
      ...(type === "check" ? { done: !!b.done } : {}),
      ...(type === "table" ? { rows: (b.rows ?? [["", ""], ["", ""]]).slice(0, 30).map((r) => r.slice(0, 10).map((c) => String(c ?? "").slice(0, 500))) } : {}),
      ...(type === "image" ? { url: safeUrl(b.url) } : {}),
      ...(type === "task" && b.taskId ? { taskId: Number(b.taskId) } : {}),
    };
  });
}

function mustDoc(orgId: number, id: number) {
  const d = db.work.docs.get(orgId, id);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That doc isn't in this workspace." });
  return d;
}

export function doc(orgId: number, id: number) {
  const d = mustDoc(orgId, id);
  const folder = d.folderId ? db.work.folders.get(orgId, d.folderId) : null;
  const parent = d.parentId ? db.work.docs.get(orgId, d.parentId) : null;
  const blocks = parse<Block[]>(d.blocks, []);
  const ids = Array.from(new Set([...parse<number[]>(d.taskIds, []), ...blocks.filter((b) => b.type === "task" && b.taskId).map((b) => b.taskId!)]));
  const lists = db.work.lists.all(orgId);
  const tasks = ids.map((tid) => db.work.tasks.get(orgId, tid)).filter((t): t is NonNullable<typeof t> => !!t);
  return {
    doc: { id: d.id, title: d.title, folderId: d.folderId, folderName: folder?.name ?? null, listId: d.listId, parentId: d.parentId, blocks, html: pageOf(orgId, d), editedBy: d.editedBy, updatedAt: d.updatedAt, private: d.private, workspaceWide: d.workspaceWide, link: !!d.shareToken, archived: !!d.archivedAt },
    parent: parent ? { id: parent.id, title: parent.title } : null,
    pages: db.work.docs.where(orgId, "parentId", d.id).sort((a, b) => a.sort - b.sort || a.id - b.id).map((p) => ({ id: p.id, title: p.title })),
    linked: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, closed: !!t.closedAt, listName: lists.find((l) => l.id === t.listId)?.name ?? "" })),
    explicit: parse<number[]>(d.taskIds, []),
    comments: db.work.docComments.where(orgId, "docId", d.id).sort((a, b) => a.id - b.id).map((c) => ({ id: c.id, quote: c.quote, body: c.body, authorName: c.authorName, authorId: c.authorId, at: c.createdAt })),
  };
}

/** The page (html) wins when both come in; blocks alone (older callers, templates, the employees) also make the page. */
function content(input: { html?: string; blocks?: Block[] }) {
  if (input.html !== undefined) {
    const html = sanitizeHtml(input.html);
    return { html, blocks: JSON.stringify(blocksFromHtml(html)) };
  }
  if (input.blocks) {
    const blocks = cleanBlocks(input.blocks);
    return { html: htmlFromBlocks(blocks), blocks: JSON.stringify(blocks) };
  }
  return null;
}

export function saveDoc(orgId: number, input: { id?: number; folderId?: number | null; listId?: number | null; parentId?: number | null; title: string; blocks?: Block[]; html?: string }, by: string, ownerUserId: number | null = null) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the doc." });
  if (input.parentId) mustDoc(orgId, input.parentId);
  if (input.id) {
    mustDoc(orgId, input.id);
    return db.work.docs.update(orgId, input.id, { title, ...(content(input) ?? {}), ...(input.folderId !== undefined ? { folderId: input.folderId } : {}), ...(input.listId !== undefined ? { listId: input.listId } : {}), editedBy: by })!;
  }
  const parent = input.parentId ? db.work.docs.get(orgId, input.parentId) : null;
  // A doc made on a list lives in that list's folder too.
  const onList = input.listId ? db.work.lists.get(orgId, input.listId) : null;
  return db.work.docs.insert({ organizationId: orgId, folderId: parent ? parent.folderId : onList ? onList.folderId : input.folderId ?? null, listId: parent ? parent.listId : input.listId ?? null, parentId: input.parentId ?? null, title, ...(content(input) ?? { html: "<p></p>", blocks: JSON.stringify([{ id: "b0", type: "p", text: "" }]) }), editedBy: by, sort: db.work.docs.all(orgId).length, ownerUserId: parent ? parent.ownerUserId : ownerUserId, private: parent ? parent.private : false, workspaceWide: parent ? parent.workspaceWide : false });
}

/** Ticking a checklist line works from the read view. On a page the line is the nth check item (id k<n>). */
export function toggleCheck(orgId: number, id: number, blockId: string, done: boolean, by: string) {
  const d = mustDoc(orgId, id);
  const html = pageOf(orgId, d);
  const at = /^k(\d+)$/.test(blockId) ? Number(blockId.slice(1)) : -1;
  if (html && at >= 0) {
    let n = -1;
    const next = html.replace(/<li data-type="taskItem" data-checked="(?:true|false)"([^>]*)><label><input type="checkbox"(?: checked="checked")?>/g, (m, rest: string) => {
      n++;
      if (n !== at) return m;
      return `<li data-type="taskItem" data-checked="${done ? "true" : "false"}"${rest}><label><input type="checkbox"${done ? ' checked="checked"' : ""}>`;
    });
    db.work.docs.update(orgId, id, { html: next, blocks: JSON.stringify(blocksFromHtml(next)), editedBy: by });
    return;
  }
  const blocks = parse<Block[]>(d.blocks, []).map((b) => (b.id === blockId && b.type === "check" ? { ...b, done } : b));
  db.work.docs.update(orgId, id, { blocks: JSON.stringify(blocks), editedBy: by });
}

/** Nora writes a piece for the page: a draft of what the person asks for, with the doc's own words as context. Plain paragraphs come back. */
export async function askForDoc(orgId: number, id: number, input: { prompt: string; selection?: string }) {
  const d = mustDoc(orgId, id);
  const prompt = input.prompt.trim().slice(0, 2000);
  if (!prompt) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what Nora should write." });
  const org = await db.getOrganizationById(orgId);
  const words = textFromHtml(pageOf(orgId, d)).slice(0, 12_000);
  const text = await generateText({
    system: `You are Nora, the project manager at ${org?.name ?? "the company"}. You write the piece the person asks for so it drops straight into their doc. American English, plain words, no em dashes, no hype, no preamble and no sign-off. Write only the piece itself. Use short paragraphs and, where a list fits, lines starting with "- ". Headings go on their own line starting with "## ".`,
    prompt: `Doc title: ${d.title}\n\nWhat is on the page now:\n${words || "(empty)"}\n${input.selection ? `\nThe selected words:\n${input.selection.slice(0, 4000)}\n` : ""}\nWrite this: ${prompt}`,
    maxTokens: 1500,
    timeoutMs: 60_000,
  });
  return { text: text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",") };
}

export function removeDoc(orgId: number, id: number) {
  mustDoc(orgId, id);
  for (const p of db.work.docs.where(orgId, "parentId", id)) removeDoc(orgId, p.id);
  for (const c of db.work.docComments.where(orgId, "docId", id)) db.work.docComments.remove(orgId, c.id);
  db.work.docs.remove(orgId, id);
}

export function linkTask(orgId: number, docId: number, taskId: number, on: boolean) {
  const d = mustDoc(orgId, docId);
  if (!db.work.tasks.get(orgId, taskId)) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  const ids = parse<number[]>(d.taskIds, []).filter((x) => x !== taskId);
  db.work.docs.update(orgId, docId, { taskIds: JSON.stringify(on ? [...ids, taskId] : ids) });
}

/** Selected words in a doc become a task, linked back to the doc. */
export async function taskFromText(orgId: number, docId: number, input: { text: string; listId: number }, by: Actor) {
  const d = mustDoc(orgId, docId);
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "Select the words for the task first." });
  const t = await createTask(orgId, { listId: input.listId, name: text.slice(0, 120), description: `From the doc "${d.title}":\n\n${text}` }, by);
  linkTask(orgId, docId, t.id, true);
  return t;
}

export function docComment(orgId: number, docId: number, input: { quote: string; body: string }, by: { id: number; name: string }) {
  mustDoc(orgId, docId);
  if (!input.body.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a comment." });
  return db.work.docComments.insert({ organizationId: orgId, docId, quote: input.quote.slice(0, 500), body: input.body.trim().slice(0, 4000), authorName: by.name, authorId: by.id });
}
export function removeDocComment(orgId: number, id: number) {
  db.work.docComments.remove(orgId, id);
}

// ==========================================
// Whiteboards
// ==========================================

export const ITEM_KINDS = ["sticky", "rect", "circle", "text", "pen", "arrow", "task", "frame"] as const;
export type Item = { id: string; kind: (typeof ITEM_KINDS)[number]; x: number; y: number; w: number; h: number; color?: string; text?: string; from?: string; to?: string; taskId?: number; path?: string; z?: number };

const num = (n: unknown, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export function cleanItems(raw: Item[]): Item[] {
  return raw.slice(0, 800).map((it, i) => ({
    id: String(it.id || `i${i}`).slice(0, 40),
    kind: (ITEM_KINDS as readonly string[]).includes(it.kind) ? it.kind : "sticky",
    x: num(it.x, -5000, 20000),
    y: num(it.y, -5000, 20000),
    w: num(it.w, 0, 5000),
    h: num(it.h, 0, 5000),
    ...(it.color && /^#[0-9a-f]{6}$/i.test(it.color) ? { color: it.color } : {}),
    ...(it.text ? { text: String(it.text).slice(0, 2000) } : {}),
    ...(it.from ? { from: String(it.from).slice(0, 40) } : {}),
    ...(it.to ? { to: String(it.to).slice(0, 40) } : {}),
    ...(it.taskId ? { taskId: Number(it.taskId) } : {}),
    // A freehand line: "M x y L x y ..." numbers only.
    ...(it.path && /^[ML\d\s.-]+$/.test(it.path) ? { path: it.path.slice(0, 20000) } : {}),
    ...(it.z !== undefined ? { z: num(it.z, -1000, 100000) } : {}),
  }));
}

function mustBoard(orgId: number, id: number) {
  const b = db.work.boards.get(orgId, id);
  if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "That whiteboard isn't in this workspace." });
  return b;
}

export function board(orgId: number, id: number) {
  const b = mustBoard(orgId, id);
  const items = parse<Item[]>(b.items, []);
  const folder = b.folderId ? db.work.folders.get(orgId, b.folderId) : null;
  const lists = db.work.lists.all(orgId);
  const tasks = items.filter((i) => i.kind === "task" && i.taskId).map((i) => db.work.tasks.get(orgId, i.taskId!)).filter((t): t is NonNullable<typeof t> => !!t);
  return {
    board: { id: b.id, title: b.title, folderId: b.folderId, folderName: folder?.name ?? null, items, editedBy: b.editedBy, updatedAt: b.updatedAt },
    tasks: tasks.map((t) => ({ id: t.id, name: t.name, status: t.status, closed: !!t.closedAt, dueDate: t.dueDate, assignees: parse<{ name: string }[]>(t.assignees, []).map((a) => a.name), listName: lists.find((l) => l.id === t.listId)?.name ?? "" })),
  };
}

export function saveBoard(orgId: number, input: { id?: number; folderId?: number | null; listId?: number | null; title: string }, by: string) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the whiteboard." });
  if (input.id) {
    mustBoard(orgId, input.id);
    return db.work.boards.update(orgId, input.id, { title, ...(input.folderId !== undefined ? { folderId: input.folderId } : {}), ...(input.listId !== undefined ? { listId: input.listId } : {}), editedBy: by })!;
  }
  const onList = input.listId ? db.work.lists.get(orgId, input.listId) : null;
  return db.work.boards.insert({ organizationId: orgId, folderId: onList ? onList.folderId : input.folderId ?? null, listId: input.listId ?? null, title, items: "[]", editedBy: by, sort: db.work.boards.all(orgId).length });
}
export function saveItems(orgId: number, id: number, items: Item[], by: string) {
  mustBoard(orgId, id);
  db.work.boards.update(orgId, id, { items: JSON.stringify(cleanItems(items)), editedBy: by });
}
export function removeBoard(orgId: number, id: number) {
  mustBoard(orgId, id);
  db.work.boards.remove(orgId, id);
}

/** The picked sticky notes (and text) become tasks in a list, and turn into task cards where they were. */
export async function makeTasks(orgId: number, id: number, input: { itemIds: string[]; listId: number }, by: Actor) {
  const b = mustBoard(orgId, id);
  const items = parse<Item[]>(b.items, []);
  const made: number[] = [];
  const next: Item[] = [];
  for (const it of items) {
    if (input.itemIds.includes(it.id) && (it.kind === "sticky" || it.kind === "text" || it.kind === "rect" || it.kind === "circle") && it.text?.trim()) {
      const t = await createTask(orgId, { listId: input.listId, name: it.text.replace(/\s+/g, " ").trim().slice(0, 300), description: `From the whiteboard "${b.title}".` }, by);
      made.push(t.id);
      next.push({ id: it.id, kind: "task", x: it.x, y: it.y, w: Math.max(it.w, 220), h: 64, taskId: t.id, z: it.z });
    } else next.push(it);
  }
  db.work.boards.update(orgId, id, { items: JSON.stringify(next), editedBy: by.name });
  return { made: made.length };
}
