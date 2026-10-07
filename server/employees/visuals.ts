import sharp from "sharp";
import * as db from "../db";
import type { AIEmployee, ChatMessage } from "../../drizzle/schema";
import { generateJson, generateText, type JsonSchema } from "../_core/llm";
import { storagePut } from "../storage";
import { simpleDocx, DOCX_MIME } from "./docWriter";
import { systemPromptFor } from "./tasks";

/**
 * Two things every employee can make from a conversation: a document that
 * opens in the chat (a plan, a structure, a memo), and an org chart drawn as
 * a picture. Neither needs another employee.
 */

const recent = (history: ChatMessage[] = []) =>
  history
    .slice(-14)
    .map((m) => `${m.role === "user" ? m.authorName : m.role === "handoff" ? `Handoff from ${m.authorName}` : "You"}: ${m.content}`)
    .join("\n\n");

const safeName = (t: string) => t.replace(/[^\w\s.,()&-]/g, "").replace(/\s+/g, " ").trim().slice(0, 70) || "Document";

/** A Word document written from the conversation, shown as a card that opens in the chat. */
/** The team as it stands, so a document or chart never marks a known name or title "to confirm". */
async function teamLines(orgId: number) {
  const [emps, members] = await Promise.all([db.listEmployeesByOrg(orgId), db.listMembers(orgId)]);
  return [
    `People on the team: ${members.map((m) => m.name || m.email).filter(Boolean).join(", ") || "none listed"}.`,
    `AI employees and their titles: ${emps.map((e) => `${e.name} (${e.roleTitle})`).join(", ")}.`,
  ].join("\n");
}

export async function writeDoc(emp: AIEmployee, input: { title: string; notes: string; history?: ChatMessage[] }) {
  const title = input.title.trim() || "Document";
  const { system } = await systemPromptFor(
    emp,
    `Your job now: write "${title}" as a finished document the owner can keep and share.
- Use what was said in this conversation and the Brain. Every name, title and number comes from there; leave a fact out rather than guess it.
- Shape: first line "# ${title}", then "## " section headings, "- " bullet lines and short plain paragraphs. **Bold** only for a label at the start of a line.
- Write it like the person who runs this area would, plain and specific. No em dashes or en dashes. No preamble and no closing offer.
- Names and titles below are settled; use them and never write a placeholder like [TITLE TO CONFIRM]. Settle anything you can from the conversation, the Brain and the team list yourself; never list it as a decision for the owner. Only things that sign for her, spend money or post in her name are hers to decide.
- Tables are fine for schedules and comparisons ("| a | b |" with a "|---|---|" line). Numbered steps are "1. " lines, one per line.`
  );
  const raw = await generateText({ system, prompt: `${await teamLines(emp.organizationId)}\n\n${input.notes.trim() ? `What to put in it: ${input.notes.trim()}\n\n` : ""}Conversation so far:\n${recent(input.history)}`, maxTokens: 6000 });
  let text = raw.replace(/^```\w*\s*|```\s*$/g, "").replace(/\s*[–—]\s*/g, ", ").trim();
  if (!text.startsWith("# ")) text = `# ${title}\n\n${text}`;
  const buf = await simpleDocx(text);
  const name = `${safeName(title)}.docx`;
  const saved = await storagePut(`org-${emp.organizationId}/docs/${Date.now()}-${name.replace(/\s+/g, "-")}`, buf, DOCX_MIME);
  const file = db.createChatFile({ organizationId: emp.organizationId, employeeId: emp.id, name, mime: DOCX_MIME, size: buf.length, kind: "document", fileUrl: saved.url, text: text.slice(0, 200_000), pages: null });
  const parts = (text.match(/^## /gm) ?? []).length;
  return { file, card: { type: "doc" as const, id: file.id, title, subtitle: `Word document${parts ? ` · ${parts} ${parts === 1 ? "section" : "sections"}` : ""}` } };
}

export type ChartBox = { id: string; name: string; role: string; parent: string; group: string };

const CHART_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "boxes"],
  properties: {
    title: { type: "string" },
    boxes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "role", "parent", "group"],
        properties: {
          id: { type: "string", description: "Short unique id, like b1" },
          name: { type: "string", description: "The person's or team's name as it should read on the chart" },
          role: { type: "string", description: "Their title or what the group does, a few words" },
          parent: { type: "string", description: "The id of the box this one reports to; '' for the top" },
          group: { type: "string", description: "'' for a single person; for a team box, the members' names separated by commas" },
        },
      },
    },
  },
};

/** An org chart drawn from the conversation, saved as a PNG. */
export async function orgChart(emp: AIEmployee, input: { title: string; notes: string; history?: ChatMessage[] }) {
  const { system } = await systemPromptFor(
    emp,
    `Your job now: lay out an org chart for the owner.
- Use the structure from this conversation and the Brain, with the exact names and titles used there. Never invent a person.
- One box per person who leads something. Put several AI employees who share a lead in one team box (name the team, list the members in "group") so the chart stays readable.
- Exactly one box has parent ''. At most 14 boxes.`
  );
  const r = await generateJson<{ title: string; boxes: ChartBox[] }>({
    system,
    prompt: `${await teamLines(emp.organizationId)}\n\n${input.title.trim() ? `Chart: ${input.title.trim()}\n` : ""}${input.notes.trim() ? `What to show: ${input.notes.trim()}\n\n` : ""}Conversation so far:\n${recent(input.history)}`,
    schemaName: "org_chart",
    schema: CHART_SCHEMA,
    maxTokens: 3000,
    reason: true,
  });
  const title = (input.title.trim() || r.title || "Org chart").slice(0, 80);
  const png = await renderOrgChart(title, r.boxes ?? []);
  const name = `${safeName(title)}.png`;
  const saved = await storagePut(`org-${emp.organizationId}/charts/${Date.now()}-${name.replace(/\s+/g, "-")}`, png, "image/png");
  const file = db.createChatFile({ organizationId: emp.organizationId, employeeId: emp.id, name, mime: "image/png", size: png.length, kind: "image", fileUrl: saved.url, text: (r.boxes ?? []).map((b) => `${b.name}, ${b.role}${b.group ? ` (${b.group})` : ""}`).join("\n"), pages: null });
  return { file, card: { type: "image" as const, id: file.id, title, imageUrl: saved.url } };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Splits text into lines of at most `max` characters, on word breaks. */
function lines(text: string, max: number, limit: number) {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= max) cur += " " + word;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  if (out.length > limit) {
    out.length = limit;
    out[limit - 1] = out[limit - 1].replace(/.{0,2}$/, "...");
  }
  return out;
}

/**
 * Draws a top-down tree: one row per level, each box centered over its
 * reports, lines from each box to its lead. Boxes that point at an unknown
 * lead hang from the top box.
 */
export async function renderOrgChart(title: string, raw: ChartBox[]) {
  const boxes = raw.filter((b) => b.id && b.name).slice(0, 20);
  if (!boxes.length) throw new Error("The chart came back empty");
  const ids = new Set(boxes.map((b) => b.id));
  const root = boxes.find((b) => !b.parent || !ids.has(b.parent)) ?? boxes[0];
  const parentOf = (b: ChartBox) => (b === root ? "" : ids.has(b.parent) && b.parent !== b.id ? b.parent : root.id);
  const kids = new Map<string, ChartBox[]>();
  for (const b of boxes) if (b !== root) kids.set(parentOf(b), [...(kids.get(parentOf(b)) ?? []), b]);

  const W = 250;
  const GAP = 28;
  const ROW = 70;
  const roleLines = (b: ChartBox) => lines(b.role, 34, 2);
  const heightOf = (b: ChartBox) => 62 + (roleLines(b).length - 1) * 17 + Math.min(4, lines(b.group, 34, 4).length) * 17 + (b.group ? 8 : 0);

  // Width each subtree needs (a box already on the path counts as a leaf, so a loop can't recurse), then x positions from the left.
  const spans = new Map<string, number>();
  const span = (b: ChartBox, path: Set<string> = new Set()): number => {
    if (spans.has(b.id)) return spans.get(b.id)!;
    if (path.has(b.id)) return W;
    const next = new Set(path).add(b.id);
    const ks = kids.get(b.id) ?? [];
    const w = Math.max(W, ks.reduce((n, k) => n + span(k, next), 0) + GAP * Math.max(0, ks.length - 1));
    spans.set(b.id, w);
    return w;
  };
  const pos = new Map<string, { x: number; depth: number }>();
  const place = (b: ChartBox, left: number, depth: number) => {
    if (pos.has(b.id)) return;
    pos.set(b.id, { x: left + span(b) / 2, depth });
    let x = left;
    for (const k of kids.get(b.id) ?? []) {
      place(k, x, depth + 1);
      x += span(k) + GAP;
    }
  };
  place(root, 0, 0);
  // Anything not reachable from the top (a loop in the answer) hangs in a row under it.
  let spare = span(root) + GAP;
  for (const b of boxes) if (!pos.has(b.id)) {
    pos.set(b.id, { x: spare + W / 2, depth: 1 });
    spare += W + GAP;
  }

  const depths = Math.max(...Array.from(pos.values()).map((p) => p.depth)) + 1;
  const rowH = Array.from({ length: depths }, (_, d) => Math.max(...boxes.filter((b) => pos.get(b.id)!.depth === d).map(heightOf), 62));
  const rowY: number[] = [];
  let y = 96;
  for (let d = 0; d < depths; d++) {
    rowY.push(y);
    y += rowH[d] + ROW;
  }
  const xs = Array.from(pos.values()).map((p) => p.x);
  const minX = Math.min(...xs) - W / 2;
  const width = Math.max(640, Math.max(...xs) + W / 2 - minX + 96);
  const height = y - ROW + 56;
  const ox = 48 - minX;

  const GREEN = "#155F3C";
  const parts: string[] = [];
  for (const b of boxes) {
    if (b === root) continue;
    const p = pos.get(parentOf(b));
    const c = pos.get(b.id)!;
    if (!p) continue;
    const x1 = p.x + ox, y1 = rowY[p.depth] + rowH[p.depth];
    const x2 = c.x + ox, y2 = rowY[c.depth];
    const mid = y1 + (y2 - y1) / 2;
    parts.push(`<path d="M${x1} ${y1} V${mid} H${x2} V${y2}" fill="none" stroke="#9fb5aa" stroke-width="2"/>`);
  }
  for (const b of boxes) {
    const p = pos.get(b.id)!;
    const x = p.x + ox - W / 2, top = rowY[p.depth];
    const h = heightOf(b);
    const isRoot = b === root;
    parts.push(`<rect x="${x}" y="${top}" width="${W}" height="${h}" rx="10" fill="${isRoot ? GREEN : "#ffffff"}" stroke="${isRoot ? GREEN : "#cfdcd5"}" stroke-width="1.5"/>`);
    if (!isRoot) parts.push(`<rect x="${x}" y="${top}" width="5" height="${h}" rx="2" fill="#ff914c"/>`);
    const fg = isRoot ? "#ffffff" : "#0e1c14";
    const sub = isRoot ? "#d6eadf" : "#4a5a52";
    parts.push(`<text x="${x + W / 2}" y="${top + 27}" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="16" font-weight="700" fill="${fg}" text-anchor="middle">${esc(lines(b.name, 26, 1)[0] ?? "")}</text>`);
    const rl = roleLines(b);
    rl.forEach((l, i) => parts.push(`<text x="${x + W / 2}" y="${top + 48 + i * 17}" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="13" fill="${sub}" text-anchor="middle">${esc(l)}</text>`));
    lines(b.group, 34, 4).forEach((l, i) => parts.push(`<text x="${x + W / 2}" y="${top + 72 + (rl.length - 1) * 17 + i * 17}" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="12.5" fill="${sub}" text-anchor="middle">${esc(l)}</text>`));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#F8FAFB"/>
<text x="48" y="54" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="24" font-weight="700" fill="#0e1c14">${esc(title)}</text>
${parts.join("\n")}
</svg>`;
  return sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
}
