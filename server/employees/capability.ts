import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import { storagePut } from "../storage";
import { employeeFor, systemPromptFor, working } from "./tasks";
import { findPassages, formatPassages } from "./kb";

/**
 * The capability statement: the one page a business hands a government buyer or
 * a funder (what it does, what it has done, why it, and its company data). Morgan
 * drafts it from the Brain; the owner edits it; it downloads as Word and goes
 * into any application whose RFP asks for one.
 */

export type Capability = {
  name: string;
  tagline: string;
  overview: string;
  competencies: string[];
  pastPerformance: string[];
  differentiators: string[];
  uei: string;
  cage: string;
  naics: string;
  certifications: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  web: string;
  updatedAt: string | null;
};

const EMPTY: Capability = { name: "", tagline: "", overview: "", competencies: [], pastPerformance: [], differentiators: [], uei: "", cage: "", naics: "", certifications: "", contactName: "", contactEmail: "", contactPhone: "", web: "", updatedAt: null };

const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false }) as JsonSchema;
const str = { type: "string" };
const list = { type: "array", items: { type: "string" } };

const clean = (s: unknown, max = 600) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const lines = (v: unknown, n = 8) => (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, n);

/** The statement as saved, with the company data filled from the workspace where it's still blank. */
export async function get(orgId: number): Promise<Capability & { saved: boolean }> {
  const org = await db.getOrganizationById(orgId);
  let saved: Partial<Capability> | null = null;
  try {
    saved = org?.capability ? (JSON.parse(org.capability) as Partial<Capability>) : null;
  } catch {
    saved = null;
  }
  const sam = (await db.listRegistrations(orgId)).find((r) => r.kind === "sam");
  let samUei = "";
  try {
    samUei = (JSON.parse(sam?.details || "{}") as { uei?: string }).uei ?? "";
  } catch {
    samUei = "";
  }
  const c = { ...EMPTY, ...(saved ?? {}) };
  return {
    ...c,
    name: c.name || org?.name || "",
    uei: c.uei || samUei,
    contactName: c.contactName || [org?.signerName, org?.signerTitle].filter(Boolean).join(", "),
    web: c.web || (org?.website ?? "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    saved: !!saved,
  };
}

/** Saves the owner's edits. */
export async function save(orgId: number, input: Partial<Capability>) {
  const now = await get(orgId);
  const next: Capability = {
    name: clean(input.name ?? now.name, 160),
    tagline: clean(input.tagline ?? now.tagline, 200),
    overview: clean(input.overview ?? now.overview, 900),
    competencies: lines(input.competencies ?? now.competencies),
    pastPerformance: lines(input.pastPerformance ?? now.pastPerformance),
    differentiators: lines(input.differentiators ?? now.differentiators),
    uei: clean(input.uei ?? now.uei, 20),
    cage: clean(input.cage ?? now.cage, 10),
    naics: clean(input.naics ?? now.naics, 200),
    certifications: clean(input.certifications ?? now.certifications, 300),
    contactName: clean(input.contactName ?? now.contactName, 160),
    contactEmail: clean(input.contactEmail ?? now.contactEmail, 200),
    contactPhone: clean(input.contactPhone ?? now.contactPhone, 40),
    web: clean(input.web ?? now.web, 200),
    updatedAt: new Date().toISOString(),
  };
  await db.updateOrganization(orgId, { capability: JSON.stringify(next) });
  return get(orgId);
}

/**
 * Morgan writes (or rewrites) the words from the Brain: Shorter or Fuller. Company data
 * the owner typed (UEI, CAGE, NAICS, certifications, contact) is kept.
 */
export async function write(orgId: number, length: "shorter" | "fuller" | "first" = "first") {
  const emp = await employeeFor(orgId, "grants");
  const now = await get(orgId);
  return working(
    emp,
    async () => {
      const passages = await findPassages(orgId, "services clients contracts past performance results certifications awards team experience", { employeeId: emp.id, limit: 10 });
      const { system } = await systemPromptFor(
        emp,
        `Your job now: write this company's one-page capability statement, the page a government buyer or funder reads in a minute.
- Only facts from the Brain and the passages. Never invent a client, contract, year, number, certification or ID; leave a list short rather than pad it.
- Overview: 1 to 3 sentences on what the company does and for whom. Tagline: the kind of business and where, in under 10 words (for example "Outpatient behavioral health · Denver, Colorado").
- Core competencies: what it does best, 3 to 6 short lines. Past performance: who it did work for, what and when, one line each, only real ones. Differentiators: 2 to 4 short lines.
- Company data (UEI, CAGE, NAICS, certifications, contact) only when the Brain states it; otherwise "".
${length === "shorter" ? "- The owner asked for it shorter: tighter overview, the strongest lines only." : length === "fuller" ? "- The owner asked for it fuller: a fuller overview and every supported line, still one page." : ""}`
      );
      const r = await generateJson<Omit<Capability, "updatedAt" | "name" | "web" | "contactName">>({
        system,
        prompt: `Current statement (keep what is right):\n${JSON.stringify({ ...now, saved: undefined })}\n\nPassages:\n${formatPassages(passages, 9000)}`,
        schemaName: "capability_statement",
        schema: obj({ tagline: str, overview: str, competencies: list, pastPerformance: list, differentiators: list, uei: str, cage: str, naics: str, certifications: str, contactEmail: str, contactPhone: str }),
        maxTokens: 2500,
        timeoutMs: 120_000,
      });
      // What the owner typed in the company data wins over what was found.
      const keep = (mine: string, found: unknown) => mine || clean(found, 300);
      return save(orgId, {
        tagline: clean(r.tagline, 200) || now.tagline,
        overview: clean(r.overview, 900) || now.overview,
        competencies: lines(r.competencies).length ? lines(r.competencies) : now.competencies,
        pastPerformance: lines(r.pastPerformance).length ? lines(r.pastPerformance) : now.pastPerformance,
        differentiators: lines(r.differentiators).length ? lines(r.differentiators) : now.differentiators,
        uei: keep(now.uei, r.uei),
        cage: keep(now.cage, r.cage),
        naics: keep(now.naics, r.naics),
        certifications: keep(now.certifications, r.certifications),
        contactEmail: keep(now.contactEmail, r.contactEmail),
        contactPhone: keep(now.contactPhone, r.contactPhone),
      });
    },
    { job: "doc", label: "Capability statement" }
  );
}

/** The statement as a one-page Word file. */
export async function docx(orgId: number) {
  const c = await get(orgId);
  if (!c.overview && !c.competencies.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "There's no capability statement yet. Press Rewrite to have Morgan write it." });
  const buf = await docxBuffer(c);
  const name = `${(c.name || "Capability statement").replace(/[\\/:*?"<>|]+/g, " ").trim()} capability statement.docx`;
  const saved = await storagePut(`org-${orgId}/downloads/${name}`, buf);
  return { url: saved.url, name };
}

export async function docxBuffer(c: Capability) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, BorderStyle } = await import("docx");
  const head = (t: string) => new Paragraph({ spacing: { before: 140, after: 40 }, children: [new TextRun({ text: t.toUpperCase(), bold: true, size: 18, color: "1B6B4A" })] });
  const bullets = (xs: string[]) => xs.map((x) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: x, size: 20 })] }));
  const kv = (k: string, v: string) => (v ? [new Paragraph({ children: [new TextRun({ text: `${k}  `, bold: true, size: 19 }), new TextRun({ text: v, size: 19 })] })] : []);
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const borders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  const left = [
    head("Company overview"),
    new Paragraph({ children: [new TextRun({ text: c.overview, size: 20 })] }),
    ...(c.competencies.length ? [head("Core competencies"), ...bullets(c.competencies)] : []),
    ...(c.pastPerformance.length ? [head("Past performance"), ...bullets(c.pastPerformance)] : []),
    ...(c.differentiators.length ? [head("Differentiators"), ...bullets(c.differentiators)] : []),
  ];
  const right = [
    head("Company data"),
    ...kv("UEI", c.uei),
    ...kv("CAGE", c.cage),
    ...kv("NAICS", c.naics),
    ...kv("Certified", c.certifications),
    head("Contact"),
    ...kv("Name", c.contactName),
    ...kv("Email", c.contactEmail),
    ...kv("Phone", c.contactPhone),
    ...kv("Web", c.web),
  ];
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri" } } } },
    sections: [
      {
        properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } },
        children: [
          new Paragraph({ children: [new TextRun({ text: c.name, bold: true, size: 36 })] }),
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: [c.tagline, "Capability statement"].filter(Boolean).join(" · "), color: "555555", size: 20 })] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders,
            rows: [new TableRow({ children: [new TableCell({ width: { size: 62, type: WidthType.PERCENTAGE }, borders, children: left }), new TableCell({ width: { size: 38, type: WidthType.PERCENTAGE }, borders, children: right })] })],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** Whether an opportunity's requirements ask for a capability statement. */
export function asksForIt(text: string) {
  return /capabilit(y|ies) statement/i.test(text);
}
