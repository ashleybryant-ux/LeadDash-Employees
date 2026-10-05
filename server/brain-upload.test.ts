import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import JSZip from "jszip";
import sharp from "sharp";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { sha256 } from "./_core/crypto";
import { SESSION_COOKIE } from "../shared/const";
import { registerUploads } from "./uploads";

let base = "";
let server: ReturnType<express.Express["listen"]>;
beforeAll(() => {
  const app = express();
  registerUploads(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function docx(text: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Brain uploads send the raw file", () => {
  it("reads a Word document, scales a big photo down, and explains an iPhone HEIC photo", async () => {
    const { orgId, owner } = await makeWorkspace("brain-upload");
    await db.createSession(owner.id, sha256("brain-token"), new Date(Date.now() + 3600_000), null);
    const headers = { cookie: `${SESSION_COOKIE}=brain-token`, "content-type": "application/octet-stream" };
    const send = (slot: string, name: string, body: Buffer, extra = "") => fetch(`${base}/api/upload/${slot}?organizationId=${orgId}&name=${encodeURIComponent(name)}${extra}`, { method: "POST", headers, body });

    const d = await send("brain_doc", "one-sheet.docx", await docx("Dr. Ashley Bryant speaks on HR burnout."), "&title=Speaker%20one%20sheet&category=speaking");
    expect(d.status).toBe(200);
    const doc = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Speaker one sheet")!;
    expect(doc.kind).toBe("document");
    expect(doc.category).toBe("speaking");
    expect(doc.content).toContain("HR burnout");

    const noise = Buffer.alloc(2000 * 2000 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const bigPng = await sharp(noise, { raw: { width: 2000, height: 2000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(bigPng.length).toBeGreaterThan(8_000_000);
    const i = await send("brain_image", "stage.png", bigPng, "&title=On%20stage&note=Keynote%20photo");
    expect(i.status).toBe(200);
    const img = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "On stage")!;
    expect(img.kind).toBe("image");
    expect(img.fileUrl).toMatch(/\.jpg$/);

    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(100)]);
    const h = await send("brain_image", "IMG_0001.HEIC", heic);
    expect(h.status).toBe(400);
    expect((await h.json()).error).toMatch(/HEIC/);
  });
});
