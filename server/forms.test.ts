import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Morgan's answers for each form, by the blank's label.
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "package_roles") return { files: [] };
      if (opts.schemaName === "form_values") {
        const lines: string[] = String(opts.prompt).split("Blanks:\n")[1].split("\n");
        const values = lines
          .map((l) => {
            const [id, ...rest] = l.split(": ");
            const label = rest.join(": ");
            if (/Organization name/i.test(label)) return { id, value: "Bright Path Counseling" };
            if (/EIN/.test(label)) return { id, value: "84-1234567" };
            if (/Personnel \/ Year 1/.test(label)) return { id, value: "$52,000" };
            if (/Supplies \/ Year 1/.test(label)) return { id, value: "3,000" };
            if (/Contact person/.test(label)) return { id, value: "Dana Whitfield" };
            if (/Nonprofit/.test(label)) return { id, value: "no" };
            if (/Signature/i.test(label)) return { id, value: "Dana Whitfield" };
            return null;
          })
          .filter(Boolean);
        return { values };
      }
      if (opts.schemaName === "form_copy") return { items: [{ label: "Applicant name", answer: "Bright Path Counseling" }, { label: "Authorized signature", answer: "" }] };
      if (opts.schemaName === "capability_statement")
        return { tagline: "Outpatient behavioral health · Denver, Colorado", overview: "Licensed outpatient practice serving adults, couples and families.", competencies: ["Individual therapy", "Couples therapy", "School-based services"], pastPerformance: ["Denver Public Schools, school-based counseling, 2025"], differentiators: ["Evening hours"], uei: "K1A2B3C4D5E6", cage: "", naics: "621330", certifications: "", contactEmail: "dana@brightpath.example", contactPhone: "" };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { storagePut, uploadsRoot } from "./storage";
import { docxSlots, fillDocx, fillHostForms, xlsxSlots, fillSheet, parseForms, saveSigned, CAPABILITY_ID } from "./employees/forms";
import * as cap from "./employees/capability";
import * as exportsFor from "./employees/exports";

const fileOf = (url: string) => fs.readFileSync(path.join(uploadsRoot(), url.replace(/^\/files\//, "")));

async function wordForm() {
  const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun } = await import("docx");
  const cell = (t: string) => new TableCell({ children: [new Paragraph({ children: t ? [new TextRun(t)] : [] })] });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun("Attachment C: Applicant Information")] }),
          new Table({ rows: [new TableRow({ children: [cell("Organization name"), cell("")] }), new TableRow({ children: [cell("EIN"), cell("")] })] }),
          new Paragraph({ children: [new TextRun("Contact person: ____________")] }),
          new Paragraph({ children: [new TextRun("Signature: ____________")] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function budgetSheet() {
  const JSZip = (await import("jszip")).default;
  const z = new JSZip();
  z.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>');
  z.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>');
  z.file("xl/sharedStrings.xml", '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Line item</t></si><si><t>Year 1</t></si><si><t>Year 2</t></si><si><t>Personnel</t></si><si><t>Supplies</t></si><si><t>Total</t></si></sst>');
  z.file("xl/worksheets/sheet1.xml", '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"/></row><row r="3"><c r="A3" t="s"><v>4</v></c></row><row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><f>SUM(B2:B3)</f></c></row></sheetData></worksheet>');
  return z.generateAsync({ type: "nodebuffer" });
}

async function fillablePdf() {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 400]);
  const form = pdf.getForm();
  form.createTextField("Organization name").addToPage(page, { x: 50, y: 300, width: 300, height: 20 });
  form.createCheckBox("Nonprofit").addToPage(page, { x: 50, y: 250, width: 15, height: 15 });
  form.createTextField("Signature").addToPage(page, { x: 50, y: 200, width: 300, height: 20 });
  return Buffer.from(await pdf.save());
}

async function flatPdf() {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]).drawText("Applicant name ______  Authorized signature ______", { x: 40, y: 300, size: 12 });
  return Buffer.from(await pdf.save());
}

describe("Morgan fills the host's own forms", () => {
  it("finds the blanks in Word and Excel forms, fills them in place, and leaves formulas and signatures alone", async () => {
    const JSZip = (await import("jszip")).default;
    const xml = (await (await JSZip.loadAsync(await wordForm())).file("word/document.xml")!.async("string"));
    const slots = docxSlots(xml);
    expect(slots.map((s) => s.label)).toEqual(["Organization name", "EIN", "Contact person: [THIS BLANK]", "Signature: [THIS BLANK]"]);
    const out = fillDocx(xml, new Map([[slots[0].id, "Bright Path Counseling"], [slots[2].id, "Dana Whitfield"]]));
    expect(out).toContain("Bright Path Counseling");
    expect(out).toContain("Contact person: Dana Whitfield");
    expect(out).toContain("Signature: ____________");

    const sheet = await (await JSZip.loadAsync(await budgetSheet())).file("xl/worksheets/sheet1.xml")!.async("string");
    const shared = ["Line item", "Year 1", "Year 2", "Personnel", "Supplies", "Total"];
    const cells = xlsxSlots("Budget", sheet, shared);
    expect(cells.map((c) => c.id)).toEqual(["Budget!B2", "Budget!C2", "Budget!B3", "Budget!C3", "Budget!C4"]);
    const filled = fillSheet(sheet, "Budget", new Map([["Budget!B2", "$52,000"], ["Budget!B3", "3,000"], ["Budget!C3", "Bulk order"]]));
    expect(filled).toContain('<c r="B2" s="1"><v>52000</v></c>');
    expect(filled).toContain('<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>3000</v></c><c r="C3" t="inlineStr"><is><t xml:space="preserve">Bulk order</t></is></c></row>');
    expect(filled).toContain("<f>SUM(B2:B3)</f>");
  });

  it("fills every form on an application in its own format, a flat PDF as a Word copy, takes the signed copy, and puts it all in Download all with the capability statement", async () => {
    const { orgId, owner } = await makeWorkspace("forms");
    await db.updateOrganization(orgId, { name: "Bright Path Counseling" });
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const opp = await db.createOpp({ organizationId: orgId, kind: "grant", title: "Community Mental Health Services", host: "County Health Department", requirements: "{}", packageStatus: "ready" });
    const add = async (name: string, buf: Buffer, role: "rfp" | "form") => {
      const saved = await storagePut(`org-${orgId}/packages/${name}`, buf);
      return db.createOppFile({ organizationId: orgId, opportunityId: opp.id, name, fileUrl: saved.url, status: "read", role });
    };
    await add("Community Mental Health RFP 2027.pdf", await flatPdf(), "rfp");
    const word = await add("Attachment C Applicant Information.docx", await wordForm(), "form");
    await add("Attachment B Budget Template.xlsx", await budgetSheet(), "form");
    await add("Attachment D Certification.pdf", await fillablePdf(), "form");
    await add("Attachment E Assurances.pdf", await flatPdf(), "form");
    const app = await db.createApplication({ organizationId: orgId, opportunityId: opp.id, employeeId: morgan.id, title: "Community Mental Health Services", status: "ready", channel: "form", questions: JSON.stringify([{ id: "q1", text: "Describe your organization", answer: "We serve adults, couples and families.", limit: "", maxWords: 0, outline: [], facts: [], sources: [], status: "done" }]), attachments: "[]" });

    const forms = await fillHostForms(orgId, morgan, { opp, app, questions: JSON.parse(app.questions) });
    expect(forms.map((f) => [f.name, f.kind, f.status])).toEqual([
      ["Attachment C Applicant Information.docx", "docx", "needs_signature"],
      ["Attachment B Budget Template.xlsx", "xlsx", "filled"],
      ["Attachment D Certification.pdf", "pdf_fillable", "needs_signature"],
      ["Attachment E Assurances.pdf", "pdf_flat", "needs_signature"],
    ]);
    // The Word form keeps its own layout with the answers typed in; the signature line stays blank.
    const JSZip = (await import("jszip")).default;
    const doc = await (await JSZip.loadAsync(fileOf(forms[0].filledUrl!))).file("word/document.xml")!.async("string");
    expect(doc).toContain("Bright Path Counseling");
    expect(doc).toContain("84-1234567");
    expect(doc).toContain("Signature: ____________");
    const book = await JSZip.loadAsync(fileOf(forms[1].filledUrl!));
    expect(await book.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('<c r="B2" s="1"><v>52000</v></c>');
    expect(await book.file("xl/workbook.xml")!.async("string")).toContain('fullCalcOnLoad="1"');
    const { PDFDocument } = await import("pdf-lib");
    const pdf = (await PDFDocument.load(fileOf(forms[2].filledUrl!))).getForm();
    expect(pdf.getTextField("Organization name").getText()).toBe("Bright Path Counseling");
    expect(pdf.getTextField("Signature").getText() ?? "").toBe("");
    expect(forms[3].note).toMatch(/Flat PDF: it can't be typed into, so the answers are in a Word copy/);
    expect(forms[3].filledUrl).toMatch(/\.docx$/);

    // The owner signs Attachment C and adds it.
    await saveSigned(orgId, app.id, word.id, { name: "signed.pdf", buf: Buffer.from("%PDF signed"), mime: "application/pdf" });
    expect(parseForms((await db.getApplication(app.id, orgId))!)[0]).toMatchObject({ status: "signed" });

    // The capability statement: written from the Brain, edited, and in the download.
    const c = caller(owner);
    expect((await c.capability.get({ organizationId: orgId })).name).toBe("Bright Path Counseling");
    await c.capability.rewrite({ organizationId: orgId, length: "first" });
    const saved = await c.capability.save({ organizationId: orgId, ...(await c.capability.get({ organizationId: orgId })), cage: "9ZX12" });
    expect(saved).toMatchObject({ uei: "K1A2B3C4D5E6", cage: "9ZX12", competencies: ["Individual therapy", "Couples therapy", "School-based services"] });
    expect((await c.capability.download({ organizationId: orgId })).name).toBe("Bright Path Counseling capability statement.docx");
    const withCap = parseForms((await db.getApplication(app.id, orgId))!);
    withCap.push({ fileId: CAPABILITY_ID, name: "Capability statement", kind: "docx", status: "filled", filledUrl: null, signedUrl: null, note: "" });
    await db.updateApplication(app.id, orgId, { forms: JSON.stringify(withCap) });

    const zipped = await JSZip.loadAsync(fileOf((await exportsFor.applicationZip(orgId, app.id)).url));
    expect(Object.keys(zipped.files).filter((n) => !zipped.files[n].dir).sort()).toEqual([
      "Capability statement.docx",
      "Community Mental Health Services.docx",
      "Forms/Attachment B Budget Template (filled).xlsx",
      "Forms/Attachment C Applicant Information (signed).pdf",
      "Forms/Attachment D Certification (filled).pdf",
      "Forms/Attachment E Assurances (answers).docx",
    ]);
  });

  it("says when there's no capability statement to download yet", async () => {
    const { orgId } = await makeWorkspace("forms-cap");
    await expect(cap.docx(orgId)).rejects.toThrow(/There's no capability statement yet/);
  });
});
