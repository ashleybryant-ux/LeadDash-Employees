import type { Express, Request, Response } from "express";
import * as db from "./db";
import { authenticateRequest } from "./_core/context";
import { storagePut } from "./storage";
import { readFile, unsupportedNote } from "./employees/docs";
import { indexKnowledge } from "./employees/kb";
import { addOpportunity, parse, type Attachment, type Extras, type Award } from "./employees/apply";

/**
 * File uploads that are too big to send as JSON: Knowledge documents, a host's
 * RFP, signed forms and attachments, pitch videos and award letters. The body
 * is the raw file; everything else is in the query string. Every upload checks
 * the session and that the person is on the workspace.
 */

const LIMITS: Record<string, number> = {
  knowledge: 30_000_000,
  rfp: 30_000_000,
  attachment: 25_000_000,
  letter: 25_000_000,
  video: 300_000_000,
};

const KNOWLEDGE_CATEGORY: Record<string, string> = {
  "Past applications": "past_performance",
  Boilerplate: "mission_profile",
  Budgets: "financial_data",
  Attachments: "certifications_licenses",
  RFPs: "past_performance",
  "Talks and bios": "speaking",
  "Reviewer comments": "past_performance",
  Answers: "financial_data",
};

function readBody(req: Request, max: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > max) return reject(new Error(`Files must be under ${Math.round(max / 1_000_000)} MB.`));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error(`Files must be under ${Math.round(max / 1_000_000)} MB.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function access(req: Request, orgId: number) {
  const { user } = await authenticateRequest(req);
  if (!user) return null;
  if (user.role === "admin") return user;
  const m = await db.getOrganizationMembership(orgId, user.id);
  if (!m || m.role === "reviewer") return null;
  return user;
}

export function registerUploads(app: Express) {
  app.post("/api/upload/:slot", async (req: Request, res: Response) => {
    const slot = String(req.params.slot);
    const max = LIMITS[slot];
    if (!max) return res.status(404).json({ error: "Unknown upload." });
    const orgId = Number(req.query.organizationId);
    const name = String(req.query.name || "file").slice(0, 200);
    const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0];
    try {
      const user = Number.isFinite(orgId) && orgId > 0 ? await access(req, orgId) : null;
      if (!user) return res.status(403).json({ error: "You cannot upload to this workspace." });
      const who = user.name?.trim() || user.email;
      const old = unsupportedNote(name);
      if (old && slot !== "video") return res.status(400).json({ error: old });
      const buf = await readBody(req, max);
      if (buf.length === 0) return res.status(400).json({ error: "The file was empty." });

      if (slot === "knowledge") {
        const employeeId = Number(req.query.employeeId);
        const emp = await db.getEmployeeForOrg(employeeId, orgId);
        if (!emp) return res.status(404).json({ error: "That employee is not in this workspace." });
        const folder = String(req.query.folder || "Past applications").slice(0, 60);
        const read = await readFile(buf, name, mime);
        const saved = await storagePut(`org-${orgId}/knowledge/${name}`, buf, mime);
        const item = await db.createKnowledgeItem({
          organizationId: orgId,
          employeeId: emp.id,
          folder,
          kind: "document",
          category: (KNOWLEDGE_CATEGORY[folder] ?? "past_performance") as never,
          title: String(req.query.title || name).slice(0, 255),
          content: read.text.slice(0, 3_000_000) || "(No readable text was found in this file.)",
          fileUrl: saved.url,
          pages: read.pages,
          pagesUnit: read.unit,
          chars: read.text.length,
          readNote: read.note,
        });
        indexKnowledge(item);
        await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: `Added to ${emp.name}'s Knowledge`, details: item.title });
        return res.json({ id: item.id });
      }

      if (slot === "rfp") {
        const empKind = req.query.employee === "speaking" ? "speaking" : "grants";
        const opp = await addOpportunity(orgId, empKind, { file: { name, buf, mime } }, who);
        return res.json({ id: opp.id });
      }

      const appId = Number(req.query.applicationId);
      const application = await db.getApplication(appId, orgId);
      if (!application) return res.status(404).json({ error: "That application is not in this workspace." });

      if (slot === "video") {
        if (!/^video\//.test(mime) && !/\.(mp4|mov|m4v|webm)$/i.test(name)) return res.status(400).json({ error: "Upload an MP4, MOV or WebM video." });
        const saved = await storagePut(`org-${orgId}/videos/${name}`, buf, mime);
        const extras = parse<Extras>(application.extras, {});
        await db.updateApplication(appId, orgId, { extras: JSON.stringify({ ...extras, videoUrl: saved.url, videoName: name }) });
        return res.json({ url: saved.url });
      }

      if (slot === "letter") {
        const saved = await storagePut(`org-${orgId}/awards/${name}`, buf, mime);
        const award = parse<Award | null>(application.award, null);
        if (!award) return res.status(400).json({ error: "Record the award first." });
        await db.updateApplication(appId, orgId, { award: JSON.stringify({ ...award, letterUrl: saved.url }) });
        return res.json({ url: saved.url });
      }

      // An attachment (a signed form, proof of licensure, a headshot...).
      const attName = String(req.query.attachment || "");
      const atts = parse<Attachment[]>(application.attachments, []);
      const a = atts.find((x) => x.name === attName);
      if (!a) return res.status(404).json({ error: "That attachment is not on this application." });
      const saved = await storagePut(`org-${orgId}/attachments/${name}`, buf, mime);
      a.fileUrl = saved.url;
      a.source = "upload";
      await db.updateApplication(appId, orgId, { attachments: JSON.stringify(atts) });
      return res.json({ url: saved.url });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[upload] ${slot} failed:`, message);
      if (!res.headersSent) res.status(400).json({ error: message });
    }
  });
}
