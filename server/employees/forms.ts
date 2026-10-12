import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, Application, Opportunity, OpportunityFile } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import { storagePut, uploadsRoot } from "../storage";
import { systemPromptFor } from "./tasks";
import type { Question } from "./apply";

/**
 * The host's own forms, filled in their own format: Morgan reads every file in
 * an opportunity's package, decides which are forms the applicant fills in, and
 * after the answers are written fills each one from the Brain and the answers.
 * - Word (.docx): empty table cells next to a label, and blank lines (____).
 * - Excel (.xlsx): empty cells next to a label, and the empty grid under a header
 *   row (a budget template). Formulas are left alone and recalculate on open.
 * - Fillable PDF: its form fields. Not flattened, so it can still be edited.
 * - Flat or scanned PDF, or anything else: it can't be typed into, so the answers
 *   go in a Word copy in the form's order, and the row says so.
 * Signature lines are left blank and the form waits for the owner to sign it.
 */

export type FormKind = "docx" | "xlsx" | "pdf_fillable" | "pdf_flat" | "other";
export type FormStatus = "filled" | "word_copy" | "needs_signature" | "signed" | "failed";
/** The capability statement's row in an application's forms (not a host file). */
export const CAPABILITY_ID = -1;

export type FormEntry = { fileId: number; name: string; kind: FormKind; status: FormStatus; filledUrl: string | null; signedUrl: string | null; note: string };

const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as JsonSchema;
const str = { type: "string" };
const arr = (items: unknown) => ({ type: "array", items });

const SIGN = /signature|sign here|signed by|authorized sign|signatory/i;
const FORM_NAME = /form|attachment|appendix|exhibit|application|budget|template|certif|assurance|worksheet|cover sheet|w-?9|questionnaire/i;

export function parseForms(app: Pick<Application, "forms">): FormEntry[] {
  try {
    const v = JSON.parse(app.forms || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function localPath(fileUrl: string | null) {
  if (!fileUrl || !fileUrl.startsWith("/files/")) return null;
  const full = path.resolve(uploadsRoot(), fileUrl.slice("/files/".length));
  return full.startsWith(uploadsRoot()) && fs.existsSync(full) ? full : null;
}

const ext = (name: string) => path.extname(name).toLowerCase();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// ==========================================
// Which files are forms
// ==========================================

/** The file's role in the package: an uploaded file keeps the tag it was given; others are judged from their name and first page. */
export async function rolesFor(orgId: number, emp: AIEmployee, files: OpportunityFile[]) {
  const open = files.filter((f) => !f.role);
  if (open.length) {
    let judged: { id: number; role: string }[] = [];
    try {
      const { system } = await systemPromptFor(emp, "Your job now: sort the files that came with an opportunity. rfp = the host's RFP, notice, guidelines or rules. form = a form, template or attachment the applicant fills in and returns (an application form, budget template, certification, cover sheet). reference = anything else.");
      const r = await generateJson<{ files: { id: number; role: string }[] }>({
        system,
        prompt: open.map((f) => `id ${f.id}: ${f.name}\n${db.chunksOf(orgId, "opp_file", f.id).map((c) => c.text).join("\n").slice(0, 1500)}`).join("\n\n"),
        schemaName: "package_roles",
        schema: obj({ files: arr(obj({ id: { type: "integer" }, role: { type: "string", enum: ["rfp", "form", "reference"] } })) }),
        maxTokens: 800,
      });
      judged = r.files ?? [];
    } catch {
      judged = [];
    }
    for (const f of open) {
      const said = judged.find((j) => j.id === f.id)?.role;
      const role = (said === "rfp" || said === "form" || said === "reference" ? said : [".xlsx", ".docx"].includes(ext(f.name)) || FORM_NAME.test(f.name) ? "form" : files.indexOf(f) === 0 ? "rfp" : "reference") as "rfp" | "form" | "reference";
      db.setOppFileRole(f.id, orgId, role);
      f.role = role;
    }
  }
  return files;
}

// ==========================================
// Slots: the blanks in each kind of form
// ==========================================

type Slot = { id: string; label: string };
type Filled = { values: Map<string, string>; signature: boolean };

async function valuesFor(orgId: number, emp: AIEmployee, ctx: { opp: Opportunity; app: Application; questions: Question[] }, form: string, slots: Slot[]): Promise<Filled> {
  const signature = slots.some((s) => SIGN.test(s.label));
  if (!slots.length) return { values: new Map(), signature };
  const org = await db.getOrganizationById(orgId);
  const regs = await db.listRegistrations(orgId);
  const sam = regs.find((r) => r.kind === "sam");
  const samDetails = (() => {
    try {
      return JSON.parse(sam?.details || "{}") as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  })();
  const cap = (() => {
    try {
      return JSON.parse(org?.capability || "{}") as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const { system } = await systemPromptFor(
    emp,
    `Your job now: fill in the host's form "${form}" for the application to ${ctx.opp.title} (${ctx.opp.host}). Each blank has an id and its label.
- Use only facts from the Brain, the application answers and the company data below. Never invent a number, date, name, ID or dollar amount: leave a blank "" when you don't know it.
- Keep each value as short as the blank needs (a name, a number, a date, a sentence or two for a text box).
- Leave every signature and signature date blank (""): the owner signs.
- A number blank gets digits only (no $ or commas).`
  );
  const facts = [
    `Organization: ${org?.name ?? ""}`,
    org?.entity && `Legal entity: ${org.entity}`,
    org?.signerName && `Authorized signer: ${org.signerName}${org.signerTitle ? `, ${org.signerTitle}` : ""}`,
    org?.website && `Website: ${org.website}`,
    org?.state && `State: ${org.state}`,
    samDetails.uei && `UEI: ${samDetails.uei}`,
    cap.uei && `UEI: ${cap.uei}`,
    cap.cage && `CAGE: ${cap.cage}`,
    cap.naics && `NAICS: ${cap.naics}`,
    cap.contactEmail && `Contact email: ${cap.contactEmail}`,
    cap.contactPhone && `Contact phone: ${cap.contactPhone}`,
  ].filter(Boolean);
  const r = await generateJson<{ values: { id: string; value: string }[] }>({
    system,
    prompt: `Company data:\n${facts.join("\n")}\n\nApplication answers:\n${ctx.questions.map((q) => `- ${q.text}: ${(q.answer || "").slice(0, 1500)}`).join("\n").slice(0, 20_000)}\n\nBlanks:\n${slots.map((s) => `${s.id}: ${s.label}`).join("\n")}`,
    schemaName: "form_values",
    schema: obj({ values: arr(obj({ id: str, value: str })) }),
    maxTokens: 6000,
    timeoutMs: 180_000,
  });
  const values = new Map<string, string>();
  for (const v of r.values ?? []) {
    const slot = slots.find((s) => s.id === v.id);
    if (slot && v.value?.trim() && !SIGN.test(slot.label)) values.set(v.id, v.value.trim());
  }
  return { values, signature };
}

/** One paragraph, including an empty <w:p/>. */
const PARA = /<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g;

const textOf = (xml: string) => Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)).map((m) => unesc(m[1])).join("");

/** Word: blanks are empty table cells after a label, and runs of underscores. */
export function docxSlots(xml: string): Slot[] {
  const slots: Slot[] = [];
  let r = 0;
  for (const row of xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const cells = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [];
    cells.forEach((c, i) => {
      if (i > 0 && !textOf(c).trim() && textOf(cells[i - 1]).trim()) slots.push({ id: `t${r}_${i}`, label: textOf(cells[i - 1]).trim().slice(0, 200) });
    });
    r++;
  }
  let p = 0;
  for (const para of xml.match(PARA) ?? []) {
    const t = textOf(para);
    const n = (t.match(/_{3,}/g) ?? []).length;
    for (let k = 0; k < n; k++) {
      let at = -1;
      slots.push({ id: `u${p}_${k}`, label: t.replace(/_{3,}/g, () => (++at === k ? "[THIS BLANK]" : "___")).trim().slice(0, 240) });
    }
    p++;
  }
  return slots;
}

const run = (v: string) => `<w:r><w:t xml:space="preserve">${esc(v)}</w:t></w:r>`;

export function fillDocx(xml: string, values: Map<string, string>) {
  let p = 0;
  xml = xml.replace(PARA, (para) => {
    const here = p++;
    let k = 0;
    // Each run of underscores inside one text node becomes its answer.
    return para.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (_m, open: string, body: string, close: string) => {
      const out = body.replace(/_{3,}/g, (blank) => {
        const v = values.get(`u${here}_${k++}`);
        return v ? esc(v) : blank;
      });
      return `${open.includes("xml:space") ? open : open.replace("<w:t", '<w:t xml:space="preserve"')}${out}${close}`;
    });
  });
  let r = 0;
  xml = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    const here = r++;
    let i = 0;
    return row.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => {
      const v = values.get(`t${here}_${i++}`);
      if (!v) return cell;
      if (/<w:p\/>/.test(cell)) return cell.replace(/<w:p\/>/, `<w:p>${run(v)}</w:p>`);
      return cell.replace(/<\/w:p>/, `${run(v)}</w:p>`);
    });
  });
  return xml;
}

// Excel

const colNum = (ref: string) => ref.replace(/\d+/g, "").split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const rowNum = (ref: string) => Number(ref.replace(/[A-Z]+/g, ""));

type Cell = { ref: string; text: string; formula: boolean; empty: boolean };

function sheetCells(xml: string, shared: string[]) {
  const cells = new Map<string, Cell>();
  for (const m of Array.from(xml.matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g))) {
    const attrs = m[1];
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const inner = m[3] ?? "";
    const formula = /<f[\s>]/.test(inner);
    const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
    let text = "";
    if (t === "s" && v !== undefined) text = shared[Number(v)] ?? "";
    else if (t === "inlineStr") text = unesc(Array.from(inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)).map((x) => x[1]).join(""));
    else if (v !== undefined) text = v;
    cells.set(ref, { ref, text: text.trim(), formula, empty: !formula && !text.trim() });
  }
  return cells;
}

export function xlsxSlots(sheetName: string, xml: string, shared: string[]): Slot[] {
  const cells = sheetCells(xml, shared);
  const isLabel = (c?: Cell) => !!c && !c.formula && !!c.text && Number.isNaN(Number(c.text));
  const slots: Slot[] = [];
  const seen = new Set<string>();
  const add = (ref: string, label: string) => {
    if (seen.has(ref) || slots.length >= 120) return;
    const c = cells.get(ref);
    if (c && !c.empty) return;
    seen.add(ref);
    slots.push({ id: `${sheetName}!${ref}`, label: `${sheetName}: ${label}`.slice(0, 220) });
  };
  // A header row: the first row with three or more labels.
  const rows = new Map<number, Cell[]>();
  for (const c of Array.from(cells.values())) rows.set(rowNum(c.ref), [...(rows.get(rowNum(c.ref)) ?? []), c]);
  const headerRow = Array.from(rows.keys()).sort((a, b) => a - b).find((n) => (rows.get(n) ?? []).filter(isLabel).length >= 3);
  const headers = headerRow ? (rows.get(headerRow) ?? []).filter(isLabel) : [];
  for (const [n, rowCells] of Array.from(rows.entries()).sort((a, b) => a[0] - b[0])) {
    const first = rowCells.sort((a, b) => colNum(a.ref) - colNum(b.ref))[0];
    if (!isLabel(first)) continue;
    if (headerRow && n > headerRow && headers.length) {
      for (const h of headers) if (colNum(h.ref) > colNum(first.ref)) add(`${colName(colNum(h.ref))}${n}`, `${first.text} / ${h.text}`);
    } else {
      add(`${colName(colNum(first.ref) + 1)}${n}`, first.text);
    }
  }
  return slots;
}

export function fillSheet(xml: string, sheetName: string, values: Map<string, string>) {
  const mine = Array.from(values.entries()).filter(([id]) => id.startsWith(`${sheetName}!`)).map(([id, v]) => ({ ref: id.slice(sheetName.length + 1), v }));
  if (!mine.length) return xml;
  const cellXml = (ref: string, v: string, style: string) => {
    const num = v.replace(/[$,\s]/g, "");
    return /^-?\d+(\.\d+)?$/.test(num) ? `<c r="${ref}"${style}><v>${num}</v></c>` : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  };
  for (const { ref, v } of mine) {
    const r = rowNum(ref);
    const existing = new RegExp(`<c r="${ref}"([^>]*?)(/>|>[\\s\\S]*?</c>)`);
    const hit = existing.exec(xml);
    if (hit) {
      if (/<f[\s>]/.test(hit[2])) continue;
      const style = /\ss="\d+"/.exec(hit[1])?.[0] ?? "";
      xml = xml.replace(existing, cellXml(ref, v, style));
      continue;
    }
    const rowRe = new RegExp(`<row\\b[^>]*\\br="${r}"[^>]*?(/>|>[\\s\\S]*?</row>)`);
    const row = rowRe.exec(xml);
    if (row) {
      const open = row[0].replace(/(\/>|>[\s\S]*<\/row>)$/, "").replace(/\sspans="[^"]*"/, "");
      const inner = row[1] === "/>" ? "" : row[1].slice(1, -"</row>".length);
      const list = Array.from(inner.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)).map((m) => m[0]);
      list.push(cellXml(ref, v, ""));
      list.sort((a, b) => colNum(/r="([A-Z]+)\d+"/.exec(a)![1]) - colNum(/r="([A-Z]+)\d+"/.exec(b)![1]));
      xml = xml.replace(rowRe, `${open}>${list.join("")}</row>`);
    } else {
      const rows = Array.from(xml.matchAll(/<row\b[^>]*\br="(\d+)"/g));
      const after = rows.filter((m) => Number(m[1]) > r)[0];
      const newRow = `<row r="${r}">${cellXml(ref, v, "")}</row>`;
      xml = after ? xml.slice(0, after.index) + newRow + xml.slice(after.index) : xml.replace(/<\/sheetData>|<sheetData\/>/, (m) => (m === "<sheetData/>" ? `<sheetData>${newRow}</sheetData>` : `${newRow}</sheetData>`));
    }
  }
  return xml;
}

// ==========================================
// Filling one form
// ==========================================

async function fillOne(orgId: number, emp: AIEmployee, ctx: { opp: Opportunity; app: Application; questions: Question[] }, f: OpportunityFile): Promise<FormEntry> {
  const base = { fileId: f.id, name: f.name, filledUrl: null, signedUrl: null };
  const p = localPath(f.fileUrl);
  const e = ext(f.name);
  const save = async (buf: Buffer, suffix: string) => (await storagePut(`org-${orgId}/applications/${path.basename(f.name, e)} (filled)${suffix}`, buf)).url;
  try {
    if (p && e === ".docx") {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(p));
      const xml = await zip.file("word/document.xml")?.async("string");
      if (!xml) throw new Error("No document inside");
      const slots = docxSlots(xml);
      if (!slots.length) return wordCopy(orgId, emp, ctx, f, "No blanks to type into: answers are in a Word copy, in the form's order.");
      const { values, signature } = await valuesFor(orgId, emp, ctx, f.name, slots);
      zip.file("word/document.xml", fillDocx(xml, values));
      const url = await save(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), ".docx");
      return { ...base, kind: "docx", status: signature ? "needs_signature" : "filled", filledUrl: url, note: `${values.size} of ${slots.length} blanks filled.` };
    }
    if (p && e === ".xlsx") {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(fs.readFileSync(p));
      const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
      const shared = Array.from(sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)).map((m) => unesc(Array.from(m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)).map((x) => x[1]).join("")));
      const wb = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
      const rels = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
      const sheets = Array.from(wb.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)).map((m) => ({ name: unesc(m[1]), target: /Target="([^"]+)"/.exec(new RegExp(`<Relationship\\b[^>]*Id="${m[2]}"[^>]*>`).exec(rels)?.[0] ?? "")?.[1] ?? "" }));
      const paths = sheets.map((s) => ({ name: s.name, file: `xl/${s.target.replace(/^\/?xl\//, "").replace(/^\//, "")}` }));
      const slots: Slot[] = [];
      for (const s of paths) {
        const x = await zip.file(s.file)?.async("string");
        if (x) slots.push(...xlsxSlots(s.name, x, shared));
      }
      if (!slots.length) return wordCopy(orgId, emp, ctx, f, "No blanks found in the sheets: answers are in a Word copy.");
      const { values, signature } = await valuesFor(orgId, emp, ctx, f.name, slots);
      for (const s of paths) {
        const x = await zip.file(s.file)?.async("string");
        if (x) zip.file(s.file, fillSheet(x, s.name, values));
      }
      // Totals and other formulas work out again when the file is opened.
      zip.file("xl/workbook.xml", /<calcPr\b/.test(wb) ? wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a: string) => (/fullCalcOnLoad/.test(a) ? m : `<calcPr${a} fullCalcOnLoad="1"/>`)) : wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>'));
      zip.remove("xl/calcChain.xml");
      const url = await save(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), ".xlsx");
      return { ...base, kind: "xlsx", status: signature ? "needs_signature" : "filled", filledUrl: url, note: `${values.size} of ${slots.length} cells filled.` };
    }
    if (p && e === ".pdf") {
      const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } = await import("pdf-lib");
      const pdf = await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });
      const fields = pdf.getForm().getFields();
      if (!fields.length) return wordCopy(orgId, emp, ctx, f, "Flat PDF: it can't be typed into, so the answers are in a Word copy, in the form's order.");
      const slots: Slot[] = fields.map((fl, i) => {
        const opts = fl instanceof PDFDropdown ? ` (choose one of: ${fl.getOptions().join(", ")})` : fl instanceof PDFRadioGroup ? ` (choose one of: ${fl.getOptions().join(", ")})` : fl instanceof PDFCheckBox ? " (yes or no)" : "";
        return { id: `f${i}`, label: `${fl.getName()}${opts}` };
      });
      const { values, signature } = await valuesFor(orgId, emp, ctx, f.name, slots);
      fields.forEach((fl, i) => {
        const v = values.get(`f${i}`);
        if (!v) return;
        try {
          if (fl instanceof PDFTextField) fl.setText(v);
          else if (fl instanceof PDFCheckBox) (/^(yes|true|x|checked)$/i.test(v) ? fl.check() : fl.uncheck());
          else if (fl instanceof PDFDropdown && fl.getOptions().includes(v)) fl.select(v);
          else if (fl instanceof PDFRadioGroup && fl.getOptions().includes(v)) fl.select(v);
        } catch {
          /* a field that won't take the value stays blank */
        }
      });
      const url = await save(Buffer.from(await pdf.save()), ".pdf");
      return { ...base, kind: "pdf_fillable", status: signature ? "needs_signature" : "filled", filledUrl: url, note: `${values.size} of ${slots.length} fields filled.` };
    }
    return wordCopy(orgId, emp, ctx, f, "This file can't be typed into: answers are in a Word copy, in the form's order.");
  } catch (err) {
    return { ...base, kind: e === ".docx" ? "docx" : e === ".xlsx" ? "xlsx" : e === ".pdf" ? "pdf_flat" : "other", status: "failed", note: `Couldn't fill it: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}` };
  }
}

/** A form that can't be typed into: its questions and answers, in order, as Word. */
async function wordCopy(orgId: number, emp: AIEmployee, ctx: { opp: Opportunity; app: Application; questions: Question[] }, f: OpportunityFile, note: string): Promise<FormEntry> {
  const text = db.chunksOf(orgId, "opp_file", f.id).map((c) => c.text).join("\n").slice(0, 30_000);
  const { system } = await systemPromptFor(emp, `Your job now: the host's form "${f.name}" can't be typed into. List every blank or question on it in order, with the answer, using only the Brain and the application answers. Leave a signature or anything you don't know as "".`);
  const r = await generateJson<{ items: { label: string; answer: string }[] }>({
    system,
    prompt: `The form:\n${text}\n\nApplication answers:\n${ctx.questions.map((q) => `- ${q.text}: ${(q.answer || "").slice(0, 1200)}`).join("\n").slice(0, 15_000)}`,
    schemaName: "form_copy",
    schema: obj({ items: arr(obj({ label: str, answer: str })) }),
    maxTokens: 6000,
    timeoutMs: 180_000,
  });
  const items = r.items ?? [];
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(f.name.replace(/\.[^.]+$/, ""))] }), new Paragraph({ children: [new TextRun({ text: `Answers for ${ctx.opp.title}, in the form's order.`, color: "555555" })] })];
  for (const it of items) {
    children.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ text: it.label, bold: true })] }));
    children.push(new Paragraph({ children: [new TextRun(it.answer || "")] }));
  }
  const buf = await Packer.toBuffer(new Document({ styles: { default: { document: { run: { font: "Calibri", size: 22 } } } }, sections: [{ children }] }));
  const url = (await storagePut(`org-${orgId}/applications/${path.basename(f.name, ext(f.name))} (answers).docx`, buf)).url;
  const signature = items.some((it) => SIGN.test(it.label));
  return { fileId: f.id, name: f.name, kind: ext(f.name) === ".pdf" ? "pdf_flat" : "other", status: signature ? "needs_signature" : "word_copy", filledUrl: url, signedUrl: null, note };
}

/** Fills every one of the host's forms for this application. A form already signed keeps its signed copy. */
export async function fillHostForms(orgId: number, emp: AIEmployee, ctx: { opp: Opportunity; app: Application; questions: Question[] }, onProgress?: (what: string) => Promise<unknown>) {
  const files = await rolesFor(orgId, emp, await db.listOppFiles(orgId, ctx.opp.id));
  const forms = files.filter((f) => f.role === "form" && f.fileUrl);
  const before = parseForms(ctx.app);
  const out: FormEntry[] = [];
  for (const f of forms) {
    const prev = before.find((x) => x.fileId === f.id);
    if (prev?.signedUrl) {
      out.push(prev);
      continue;
    }
    if (onProgress) await onProgress(`Filling ${f.name}`);
    out.push(await fillOne(orgId, emp, ctx, f));
  }
  await db.updateApplication(ctx.app.id, orgId, { forms: JSON.stringify(out) });
  return out;
}

/** The owner's signed copy of one form. */
export async function saveSigned(orgId: number, appId: number, fileId: number, file: { name: string; buf: Buffer; mime: string }) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const forms = parseForms(app);
  const f = forms.find((x) => x.fileId === fileId);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That form is not on this application." });
  const saved = await storagePut(`org-${orgId}/applications/${path.basename(f.name, ext(f.name))} (signed)${ext(file.name) || ".pdf"}`, file.buf, file.mime);
  f.signedUrl = saved.url;
  f.status = "signed";
  await db.updateApplication(appId, orgId, { forms: JSON.stringify(forms) });
  return f;
}

/** What each status reads as on the row. */
export const FORM_LABEL: Record<FormStatus, string> = { filled: "Filled", word_copy: "Filled in Word", needs_signature: "Needs your signature", signed: "Signed", failed: "Couldn't fill" };
