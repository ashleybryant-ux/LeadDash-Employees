import type { Express, Request, Response } from "express";
import * as db from "./db";
import { authenticateRequest } from "./_core/context";
import { storagePut, storagePutStream } from "./storage";
import { describeImage } from "./_core/llm";
import { readFile, unsupportedNote } from "./employees/docs";
import { indexKnowledge } from "./employees/kb";
import { addOpportunity, parse, type Attachment, type Extras, type Award } from "./employees/apply";
import { addApplicant } from "./employees/hiring";
import { KNOWLEDGE_CATEGORIES } from "../drizzle/schema";

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
  video: 250_000_000,
  resume: 20_000_000,
  post_media: 250_000_000,
  chat: 20_000_000,
  brain_doc: 40_000_000,
  brain_image: 30_000_000,
  history: 400_000_000,
  take: 200_000_000,
  leads: 80_000_000,
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

/** A history export sent in parts: each part stays under the web server's 300 MB limit, so a large Claude or ChatGPT export still gets through. */
export const HISTORY_PART = 50_000_000;
export const HISTORY_MAX = 3_000_000_000;

export function registerUploads(app: Express) {
  app.post("/api/upload/history-part", async (req: Request, res: Response) => {
    const orgId = Number(req.query.organizationId);
    const name = String(req.query.name || "file").slice(0, 200);
    const uploadId = String(req.query.uploadId || "");
    const index = Number(req.query.index);
    const total = Number(req.query.total);
    const offset = Number(req.query.offset);
    try {
      const user = Number.isFinite(orgId) && orgId > 0 ? await access(req, orgId) : null;
      if (!user) return res.status(403).json({ error: "You cannot upload to this workspace." });
      if (user.role !== "admin") {
        const m = await db.getOrganizationMembership(orgId, user.id);
        if (!m || (m.role !== "owner" && m.role !== "admin")) return res.status(403).json({ error: "Only the workspace owner can import history." });
      }
      if (!/\.(zip|json)$/i.test(name)) return res.status(400).json({ error: "Upload the .zip or manifest .json that Claude or ChatGPT sent you." });
      if (!/^[a-f0-9]{16,64}$/.test(uploadId) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total || !Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: "That upload part is not valid." });
      if (offset + Number(req.headers["content-length"] || 0) > HISTORY_MAX) return res.status(400).json({ error: `Exports must be under ${HISTORY_MAX / 1_000_000_000} GB.` });
      const fs = await import("node:fs");
      const path = await import("node:path");
      const history = await import("./employees/history");
      const dir = path.dirname(history.holdingPath(orgId));
      const part = path.join(dir, `org-${orgId}-${uploadId}.part`);
      const have = index === 0 ? 0 : fs.existsSync(part) ? fs.statSync(part).size : -1;
      if (index === 0 && fs.existsSync(part)) fs.unlinkSync(part);
      if (have !== offset) return res.status(409).json({ error: "The upload got out of step. Press Upload export and try again." });
      const body = await readBody(req, HISTORY_PART + 1_000_000);
      await fs.promises.appendFile(part, body);
      if (index < total - 1) return res.json({ ok: true, received: offset + body.length });
      const dest = history.holdingPath(orgId);
      await fs.promises.rename(part, dest);
      const who = user.name?.trim() || user.email;
      const { imp, also } = await history.startEverywhere(orgId, { id: user.id, name: who }, name, dest);
      return res.json({ id: imp.id, also });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed." });
    }
  });

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

      // A Claude or ChatGPT export for the Brain: kept outside the served files and read in the background.
      if (slot === "history") {
        if (user.role !== "admin") {
          const m = await db.getOrganizationMembership(orgId, user.id);
          if (!m || (m.role !== "owner" && m.role !== "admin")) return res.status(403).json({ error: "Only the workspace owner can import history." });
        }
        if (!/\.(zip|json)$/i.test(name)) return res.status(400).json({ error: "Upload the .zip or manifest .json that Claude or ChatGPT sent you." });
        const history = await import("./employees/history");
        const dest = history.holdingPath(orgId);
        const fs = await import("node:fs");
        const declared = Number(req.headers["content-length"] || 0);
        if (declared > max) return res.status(400).json({ error: `Files must be under ${Math.round(max / 1_000_000)} MB.` });
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(dest);
          let size = 0;
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > max) {
              reject(new Error(`Files must be under ${Math.round(max / 1_000_000)} MB.`));
              req.destroy();
            }
          });
          req.on("error", reject);
          out.on("error", reject);
          out.on("finish", () => resolve());
          req.pipe(out);
        });
        const { imp, also } = await history.startEverywhere(orgId, { id: user.id, name: who }, name, dest);
        return res.json({ id: imp.id, also });
      }

      const old = unsupportedNote(name);
      if (old && slot !== "video" && slot !== "post_media" && slot !== "take") return res.status(400).json({ error: old });

      // Images and videos for Sienna's posts.
      if (slot === "post_media") {
        const isVideo = /^video\//.test(mime) || /\.(mp4|mov|m4v|webm)$/i.test(name);
        const isImage = /^image\/(jpeg|png|webp|gif)$/.test(mime) || /\.(jpe?g|png|webp|gif)$/i.test(name);
        if (!isVideo && !isImage) return res.status(400).json({ error: "Upload a JPG, PNG or WebP image, or an MP4 or MOV video." });
        const cap = isVideo ? max : 30_000_000;
        const declared = Number(req.headers["content-length"] || 0);
        if (declared > cap) return res.status(400).json({ error: `${isVideo ? "Videos" : "Images"} must be under ${Math.round(cap / 1_000_000)} MB.` });
        const saved = await storagePutStream(`org-${orgId}/social/${name}`, req, cap);
        if (saved.size === 0) return res.status(400).json({ error: "The file was empty." });
        return res.json({ url: saved.url, kind: isVideo ? "video" : "image", size: saved.size });
      }

      if (slot === "video") {
        const application = await db.getApplication(Number(req.query.applicationId), orgId);
        if (!application) return res.status(404).json({ error: "That application is not in this workspace." });
        if (!/^video\//.test(mime) && !/\.(mp4|mov|m4v|webm)$/i.test(name)) return res.status(400).json({ error: "Upload an MP4, MOV or WebM video." });
        const declared = Number(req.headers["content-length"] || 0);
        if (declared > max) return res.status(400).json({ error: `Files must be under ${Math.round(max / 1_000_000)} MB.` });
        const saved = await storagePutStream(`org-${orgId}/videos/${name}`, req, max);
        if (saved.size === 0) return res.status(400).json({ error: "The file was empty." });
        const extras = parse<Extras>(application.extras, {});
        await db.updateApplication(application.id, orgId, { extras: JSON.stringify({ ...extras, videoUrl: saved.url, videoName: name }) });
        return res.json({ url: saved.url });
      }

      const buf = await readBody(req, max);
      if (buf.length === 0) return res.status(400).json({ error: "The file was empty." });

      // Jada's cold email lead list: a CSV (a state license list, a LeadDash platform export).
      if (slot === "leads") {
        if (!/\.(csv|txt)$/i.test(name)) return res.status(400).json({ error: "Upload a .csv file. In Excel or Google Sheets, save or download it as CSV first." });
        const cold = await import("./employees/cold");
        try {
          const r = cold.importCsv(orgId, name, buf.toString("utf8"));
          await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: "Added cold email leads", details: `${r.added} added from ${name}` });
          return res.json(r);
        } catch (err) {
          return res.status(400).json({ error: err instanceof Error ? err.message : "That file couldn't be read." });
        }
      }

      // The owner's own take for one of Elena's shots: her performance and voice.
      if (slot === "take") {
        const dr = await import("./employees/drama");
        try {
          const ep = await dr.saveTake(orgId, Number(req.query.episodeId), Number(req.query.n), buf);
          return res.json(dr.episodeView(ep));
        } catch (err) {
          return res.status(400).json({ error: err instanceof Error ? err.message : "That take couldn't be saved." });
        }
      }

      // A file attached in an employee's chat: photos are described, documents are read.
      if (slot === "chat") {
        const emp = await db.getEmployeeForOrg(Number(req.query.employeeId), orgId);
        if (!emp) return res.status(404).json({ error: "That employee is not in this workspace." });
        const imageType = sniffImageType(buf);
        let text = "";
        let pages: number | null = null;
        if (!imageType) {
          const read = await readFile(buf, name, mime);
          text = read.text.slice(0, 3_000_000);
          pages = read.pages;
        }
        const saved = await storagePut(`org-${orgId}/chat/${name}`, buf, imageType ?? mime);
        if (imageType) text = await describeImage(buf, imageType).catch(() => "");
        const f = db.createChatFile({ organizationId: orgId, employeeId: emp.id, userId: user.id, name, mime: imageType ?? mime, size: buf.length, kind: imageType ? "image" : "document", fileUrl: saved.url, text, pages });
        return res.json({ id: f.id, name: f.name, size: f.size, kind: f.kind, url: f.fileUrl });
      }

      // The Brain: documents (PDF, Word, PowerPoint, Excel, text) and photos, sent as the raw file so size and type never trip the JSON limits.
      if (slot === "brain_doc" || slot === "brain_image") {
        const title = String(req.query.title || name.replace(/\.[^.]+$/, "")).trim().slice(0, 255) || name;
        if (slot === "brain_doc") {
          const cat = String(req.query.category || "mission_profile");
          const category = ((KNOWLEDGE_CATEGORIES as readonly string[]).includes(cat) ? cat : "mission_profile") as (typeof KNOWLEDGE_CATEGORIES)[number];
          let read;
          try {
            read = await readFile(buf, name, mime);
          } catch (err) {
            return res.status(400).json({ error: err instanceof Error ? err.message : "That file couldn't be read." });
          }
          const saved = await storagePut(`org-${orgId}/documents/${name}`, buf, mime);
          const item = await db.createKnowledgeItem({ organizationId: orgId, kind: "document", title, category, content: read.text.slice(0, 3_000_000) || "(No readable text was found in this file.)", fileUrl: saved.url, pages: read.pages, pagesUnit: read.unit, chars: read.text.length, readNote: read.note });
          indexKnowledge(item);
          await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: "Added document to Brain", details: title });
          return res.json({ id: item.id });
        }
        let img = buf;
        let type = sniffImageType(img);
        if (!type) {
          const heic = img.subarray(4, 12).toString().match(/^ftyp(heic|heix|hevc|mif1|msf1)/);
          return res.status(400).json({ error: heic ? "iPhone HEIC photos can't be read. On your phone, share the photo as JPG (or set Camera, Formats to Most Compatible), then upload it." : "Photos must be PNG, JPG, WebP or GIF." });
        }
        // Big photos are scaled down so employees and pages can use them.
        if (img.length > 8_000_000 && type !== "image/gif") {
          const sharp = (await import("sharp")).default;
          img = await sharp(img).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
          type = "image/jpeg";
        }
        const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" }[type];
        const saved = await storagePut(`org-${orgId}/brain/image${ext}`, img, type);
        const note = String(req.query.note || "").slice(0, 2000);
        const item = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", title, category: "mission_profile", content: note, fileUrl: saved.url });
        indexKnowledge(item);
        await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: who, action: "Added image to Brain", details: title });
        if (!note.trim()) {
          const finalType = type;
          void describeImage(img, finalType)
            .then(async (text) => {
              if (!text) return;
              const next = await db.updateKnowledgeItem(item.id, orgId, { content: text });
              if (next) indexKnowledge(next);
            })
            .catch(() => null);
        }
        return res.json({ id: item.id });
      }

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

      if (slot === "resume") {
        const read = await readFile(buf, name, mime);
        const saved = await storagePut(`org-${orgId}/resumes/${name}`, buf, mime);
        const roleId = Number(req.query.roleId) || null;
        const person = await addApplicant(orgId, { roleId, text: read.text, resumeUrl: saved.url, fileName: name });
        return res.json({ id: person.id, name: person.name, score: person.fitScore });
      }

      if (slot === "rfp") {
        const empKind = req.query.employee === "speaking" ? "speaking" : "grants";
        const opp = await addOpportunity(orgId, empKind, { file: { name, buf, mime } }, who);
        return res.json({ id: opp.id });
      }

      const appId = Number(req.query.applicationId);
      const application = await db.getApplication(appId, orgId);
      if (!application) return res.status(404).json({ error: "That application is not in this workspace." });

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

function sniffImageType(buf: Buffer) {
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString() === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(0, 3).toString() === "GIF") return "image/gif";
  return null;
}
