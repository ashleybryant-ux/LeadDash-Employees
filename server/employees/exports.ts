import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { storagePut, uploadsRoot } from "../storage";
import { channelLabel, parse, type Attachment, type Award, type Extras, type Question } from "./apply";

/**
 * Downloads: the application as a Word file, the host's package as a zip,
 * the pitch deck as PowerPoint. Each is written under a random file name and
 * returned as a link, like every other generated file.
 */

const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "file";

function localPath(fileUrl: string | null) {
  if (!fileUrl || !fileUrl.startsWith("/files/")) return null;
  const full = path.resolve(uploadsRoot(), fileUrl.slice("/files/".length));
  return full.startsWith(uploadsRoot()) && fs.existsSync(full) ? full : null;
}

export async function applicationDocx(orgId: number, appId: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const opp = await db.getOpp(app.opportunityId, orgId);
  const org = await db.getOrganizationById(orgId);
  const qs = parse<Question[]>(app.questions, []);
  const atts = parse<Attachment[]>(app.attachments, []);
  const extras = parse<Extras>(app.extras, {});
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");

  const para = (text: string) =>
    text.split(/\n{2,}/).map(
      (block) =>
        new Paragraph({
          spacing: { after: 160 },
          children: block.split("\n").flatMap((line, i) => (i ? [new TextRun({ text: line, break: 1 })] : [new TextRun({ text: line })])),
        })
    );

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(app.title)] }),
    new Paragraph({ children: [new TextRun({ text: [opp?.host, opp?.amount, opp?.deadline && `Due ${opp.deadline}`].filter(Boolean).join(" · "), color: "555555" })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: `${org?.name ?? ""}${org?.signerName ? ` · Signed by ${org.signerName}${org.signerTitle ? `, ${org.signerTitle}` : ""}` : ""}`, color: "555555" })] }),
  ];
  qs.forEach((q, i) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(`${i + 1}. ${q.text}`)] }));
    if (q.limit) children.push(new Paragraph({ children: [new TextRun({ text: `Limit: ${q.limit}`, italics: true, color: "555555" })] }));
    if (app.mode === "outline" && !q.answer.trim()) {
      for (const o of q.outline) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(o)] }));
    } else {
      children.push(...para(q.answer || "(not written yet)"));
    }
  });
  for (const a of atts.filter((x) => x.source === "made" && x.content)) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(a.name)] }));
    children.push(...para(a.content!));
  }
  if (extras.videoScript) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Pitch video script")] }));
    children.push(...para(extras.videoScript));
  }
  if (extras.financials) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Financial summary")] }));
    children.push(...para(extras.financials));
  }
  if (atts.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Attachments")] }));
    for (const a of atts) {
      const state = a.source === "brain" || a.source === "upload" ? "attached" : a.source === "made" ? "included above" : a.needsSignature ? "needs signature" : "missing";
      children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(`${a.name}: ${state}`)] }));
    }
  }
  children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: channelLabel(app.channel, app.channelDetail), color: "555555" })] }));

  const doc = new Document({ styles: { default: { document: { run: { font: "Calibri", size: 24 } } } }, sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  const saved = await storagePut(`org-${orgId}/downloads/${safe(app.title)}.docx`, buf);
  return { url: saved.url, name: `${safe(app.title)}.docx` };
}

/** The application (Word) plus every attachment on file, in one zip. */
export async function applicationZip(orgId: number, appId: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const docx = await applicationDocx(orgId, appId);
  const docPath = localPath(docx.url);
  if (docPath) zip.file(docx.name, fs.readFileSync(docPath));
  for (const a of parse<Attachment[]>(app.attachments, [])) {
    const p = localPath(a.fileUrl);
    if (p) zip.file(`Attachments/${safe(a.name)}${path.extname(p)}`, fs.readFileSync(p));
  }
  const extras = parse<Extras>(app.extras, {});
  if (extras.deck?.length) {
    const deck = await deckPptx(orgId, appId);
    const p = localPath(deck.url);
    if (p) zip.file(deck.name, fs.readFileSync(p));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
  const saved = await storagePut(`org-${orgId}/downloads/${safe(app.title)}.zip`, buf);
  return { url: saved.url, name: `${safe(app.title)}.zip` };
}

/** Every file Morgan or Taylor downloaded from the host, in one zip. */
export async function packageZip(orgId: number, oppId: number) {
  const opp = await db.getOpp(oppId, orgId);
  if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
  const files = await db.listOppFiles(orgId, oppId);
  if (files.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No files have been downloaded for this one yet." });
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  let added = 0;
  for (const f of files) {
    const p = localPath(f.fileUrl);
    if (p) {
      zip.file(safe(f.name), fs.readFileSync(p));
      added++;
    }
  }
  if (added === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The host's files are not on the server. Press Try again on the package." });
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const saved = await storagePut(`org-${orgId}/downloads/${safe(opp.title)} package.zip`, buf);
  return { url: saved.url, name: `${safe(opp.title)} package.zip` };
}

export async function deckPptx(orgId: number, appId: number) {
  const app = await db.getApplication(appId, orgId);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
  const extras = parse<Extras>(app.extras, {});
  if (!extras.deck?.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "There is no deck on this application yet." });
  const org = await db.getOrganizationById(orgId);
  const colors = (org?.brandColors ?? "").match(/#[0-9a-f]{6}/gi) ?? [];
  const dark = (colors[0] ?? "#0d3b2e").slice(1);
  const accent = (colors[1] ?? "#e88a3a").slice(1);
  const PptxGenJS = (await import("pptxgenjs")).default as unknown as new () => any;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  extras.deck.forEach((s, i) => {
    const slide = pptx.addSlide();
    if (i === 0) {
      slide.background = { color: dark };
      slide.addText(s.title, { x: 0.8, y: 2.4, w: 11.5, h: 1.2, fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Calibri" });
      if (s.bullets.length) slide.addText(s.bullets.join("\n"), { x: 0.8, y: 3.7, w: 11.5, h: 1.5, fontSize: 20, color: "E6F2EC", fontFace: "Calibri" });
      return;
    }
    slide.background = { color: "FFFFFF" };
    slide.addShape("rect", { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: accent } });
    slide.addText(s.title, { x: 0.7, y: 0.5, w: 12, h: 0.9, fontSize: 30, bold: true, color: dark, fontFace: "Calibri" });
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      { x: 0.9, y: 1.6, w: 11.6, h: 5.2, fontSize: 20, color: "24332C", fontFace: "Calibri", valign: "top", paraSpaceAfter: 10 }
    );
  });
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const saved = await storagePut(`org-${orgId}/downloads/${safe(app.title)} deck.pptx`, buf);
  return { url: saved.url, name: `${safe(app.title)} deck.pptx` };
}

export async function reportDocx(orgId: number, appId: number, index: number) {
  const app = await db.getApplication(appId, orgId);
  const award = parse<Award | null>(app?.award, null);
  const report = award?.reports[index];
  if (!app || !report?.draft) throw new TRPCError({ code: "NOT_FOUND", message: "That report has not been drafted yet." });
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 24 } } } },
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(report.name)] }),
          new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: `${app.title} · Due ${report.due}`, color: "555555" })] }),
          ...report.draft.split(/\n{2,}/).map((b) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun(b)] })),
        ],
      },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  const saved = await storagePut(`org-${orgId}/downloads/${safe(report.name)}.docx`, buf);
  return { url: saved.url, name: `${safe(report.name)}.docx` };
}
