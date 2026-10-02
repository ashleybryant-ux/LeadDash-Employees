import { ENV } from "../_core/env";
import { anthropicHeaders } from "../_core/llm";

/**
 * Reads the text out of the files people upload and the files hosts post
 * (RFPs, question sheets, budget templates, forms), in full.
 *
 * - PDF: text is read on this server. A scanned PDF (pages with almost no
 *   text) is sent to Claude, which reads the page images, when the Anthropic
 *   key is set.
 * - Word (.docx), Excel (.xlsx) and PowerPoint (.pptx): read from the file's
 *   XML on this server.
 * - Text, Markdown, CSV and HTML: read as text.
 */

export type ReadResult = {
  text: string;
  /** Pages for PDF and Word, sheets for Excel, slides for PowerPoint, words for text. */
  pages: number;
  unit: "pages" | "sheets" | "slides" | "words";
  /** Set when the text came from page images. */
  note: string | null;
};

export const FILE_KINDS: Record<string, { mime: string; label: string }> = {
  pdf: { mime: "application/pdf", label: "PDF" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint" },
  txt: { mime: "text/plain", label: "Text" },
  md: { mime: "text/markdown", label: "Text" },
  csv: { mime: "text/csv", label: "CSV" },
  html: { mime: "text/html", label: "Webpage" },
};

/** The file kind from its name, content type, or first bytes. */
export function fileKind(name: string, mime: string | null | undefined, buf?: Buffer): keyof typeof FILE_KINDS | null {
  const ext = name.toLowerCase().split("?")[0].split(".").pop() ?? "";
  if (buf && buf.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (ext in FILE_KINDS) return ext as keyof typeof FILE_KINDS;
  if (ext === "htm") return "html";
  const m = (mime || "").toLowerCase();
  for (const [k, v] of Object.entries(FILE_KINDS)) if (m.startsWith(v.mime)) return k as keyof typeof FILE_KINDS;
  if (m.includes("pdf")) return "pdf";
  if (buf && buf.subarray(0, 2).toString() === "PK") {
    // An Office file without a useful name: look inside.
    return null;
  }
  if (m.startsWith("text/")) return "txt";
  return null;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

async function readPdf(buf: Buffer): Promise<ReadResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const out = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(out.text) ? out.text : [String(out.text)];
  const text = pages.map((p, i) => `[Page ${i + 1}]\n${p.trim()}`).join("\n\n");
  const letters = pages.join("").replace(/\s/g, "").length;
  const perPage = letters / Math.max(1, pages.length);
  if (perPage < 80 && ENV.anthropicKey && buf.length <= 30_000_000 && pages.length <= 100) {
    const scanned = await readPdfImages(buf).catch((err) => {
      console.warn("[docs] reading scanned PDF failed:", (err as Error).message);
      return null;
    });
    if (scanned) return { text: scanned, pages: out.totalPages ?? pages.length, unit: "pages", note: "from the image" };
  }
  return { text, pages: out.totalPages ?? pages.length, unit: "pages", note: perPage < 80 ? "little text found; it may be a scan" : null };
}

/** Claude reads the pages of a scanned PDF. Nothing from a client chart is ever sent here. */
async function readPdfImages(buf: Buffer) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model: ENV.anthropicModel,
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
            {
              type: "text",
              text: "Transcribe all the text in this document, page by page. Start each page with [Page N]. Keep headings, lists and table rows (cells separated by | ). Output only the transcription.",
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`status ${res.status}: ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return text.trim() || null;
}

async function readDocx(buf: Buffer): Promise<ReadResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const paras = xml.split(/<\/w:p>/).map((p) => {
    const heading = /<w:pStyle w:val="(Heading|Title)/i.test(p);
    const runs = Array.from(p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)).map((m) => (m[1] !== undefined ? decodeXml(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n")).join("");
    return heading && runs.trim() ? `## ${runs.trim()}` : runs;
  });
  const text = paras.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const app = (await zip.file("docProps/app.xml")?.async("string")) ?? "";
  const pages = Number(app.match(/<Pages>(\d+)<\/Pages>/)?.[1]) || Math.max(1, Math.round(text.split(/\s+/).length / 500));
  return { text, pages, unit: "pages", note: null };
}

async function readXlsx(buf: Buffer): Promise<ReadResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const shared = ((await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "")
    .split(/<\/si>/)
    .map((si) => Array.from(si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((m) => decodeXml(m[1])).join(""));
  const wb = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
  const names = Array.from(wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)).map((m) => decodeXml(m[1]));
  const sheetFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const parts: string[] = [];
  for (let i = 0; i < sheetFiles.length; i++) {
    const xml = await zip.file(sheetFiles[i])!.async("string");
    const rows = xml.split(/<\/row>/).map((row) =>
      Array.from(row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g))
        .map((c) => {
          const attrs = c[1];
          const inner = c[2] ?? "";
          const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          const inline = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
          if (/t="s"/.test(attrs) && v !== undefined) return shared[Number(v)] ?? "";
          if (inline !== undefined) return decodeXml(inline);
          return v !== undefined ? decodeXml(v) : "";
        })
        .filter((x) => x !== "")
        .join(" | ")
    );
    parts.push(`## Sheet: ${names[i] ?? `Sheet ${i + 1}`}\n${rows.filter(Boolean).join("\n")}`);
  }
  return { text: parts.join("\n\n"), pages: sheetFiles.length, unit: "sheets", note: null };
}

async function readPptx(buf: Buffer): Promise<ReadResult> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
  const parts: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i])!.async("string");
    const paras = xml.split(/<\/a:p>/).map((p) => Array.from(p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) => decodeXml(m[1])).join("")).filter(Boolean);
    parts.push(`[Slide ${i + 1}]\n${paras.join("\n")}`);
  }
  return { text: parts.join("\n\n"), pages: slides.length, unit: "slides", note: null };
}

/** Reads a file's text in full. Throws a plain message when the file cannot be read. */
export async function readFile(buf: Buffer, name: string, mime?: string | null): Promise<ReadResult> {
  let kind = fileKind(name, mime, buf);
  if (!kind && buf.subarray(0, 2).toString() === "PK") {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf).catch(() => null);
    if (zip?.file("word/document.xml")) kind = "docx";
    else if (zip?.file("xl/workbook.xml")) kind = "xlsx";
    else if (zip?.file("ppt/presentation.xml")) kind = "pptx";
  }
  if (!kind) throw new Error("This file type cannot be read. Use PDF, Word, Excel, PowerPoint or text.");
  let out: ReadResult;
  if (kind === "pdf") out = await readPdf(buf);
  else if (kind === "docx") out = await readDocx(buf);
  else if (kind === "xlsx") out = await readXlsx(buf);
  else if (kind === "pptx") out = await readPptx(buf);
  else {
    const raw = buf.toString("utf8");
    const text = kind === "html" ? (await import("./files")).htmlToText(raw) : raw;
    out = { text, pages: text.split(/\s+/).filter(Boolean).length, unit: "words", note: null };
  }
  out.text = out.text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  return out;
}

/** Old .doc and .xls files are not readable here; this says so plainly. */
export function unsupportedNote(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "doc") return "Older .doc files cannot be read. Save it as .docx.";
  if (ext === "xls") return "Older .xls files cannot be read. Save it as .xlsx.";
  if (ext === "ppt") return "Older .ppt files cannot be read. Save it as .pptx.";
  return null;
}

// ---------- Splitting into passages ----------

const HEADING = /^(#{1,3} .+|\[(Page|Slide) \d+\]|(?:section|part|article)\s+[\divx]+\b.*|\d{1,2}(\.\d{1,2})*\.?\s+[A-Z].{2,80}|[A-Z][A-Z0-9 ,&:/()'-]{4,80})$/i;

/**
 * Splits text into passages of about 1,200 characters, breaking at headings
 * and paragraph ends, and carries the nearest heading with each passage so a
 * search hit says where in the document it came from.
 */
export function chunkText(text: string, target = 1200): { heading: string | null; text: string }[] {
  const lines = text.split("\n");
  const chunks: { heading: string | null; text: string }[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) chunks.push({ heading, text: t });
    buf = [];
    size = 0;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const isHeading = line.trim().length > 0 && line.trim().length <= 90 && HEADING.test(line.trim()) && !/[.;,]$/.test(line.trim());
    if (isHeading && size > target * 0.4) flush();
    if (isHeading) heading = line.trim().replace(/^#+\s*/, "").slice(0, 120);
    if (size + line.length > target * 1.5 && size > 0) flush();
    // Very long lines (no newlines in the source) are cut at sentence ends.
    if (line.length > target * 1.5) {
      const sentences = line.match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g) ?? [line];
      for (const s of sentences) {
        if (size + s.length > target && size > 0) flush();
        buf.push(s);
        size += s.length;
      }
      continue;
    }
    buf.push(line);
    size += line.length + 1;
    if (size >= target && line.trim() === "") flush();
  }
  flush();
  return chunks;
}
