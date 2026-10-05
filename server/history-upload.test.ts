import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import JSZip from "jszip";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { sha256 } from "./_core/crypto";
import { SESSION_COOKIE } from "../shared/const";
import { registerUploads } from "./uploads";

let base = "";
let server: ReturnType<express.Express["listen"]>;
beforeAll(async () => {
  const app = express();
  registerUploads(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function exportZip() {
  const zip = new JSZip();
  const convos = Array.from({ length: 40 }, (_, i) => ({ uuid: `c${i}`, name: `Chat ${i}`, created_at: "2026-03-16T12:00:00Z", chat_messages: [{ sender: "human", text: `Question ${i} ${"x".repeat(2000)}` }, { sender: "assistant", text: `Answer ${i}` }] }));
  zip.file("conversations.json", JSON.stringify(convos));
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

describe("history export uploads in parts", () => {
  it("puts the parts back together in order and starts the import; a part out of step is refused", async () => {
    const { orgId, owner, reviewer } = await makeWorkspace("history-parts");
    await db.createSession(owner.id, sha256("parts-token"), new Date(Date.now() + 3600_000), null);
    await db.createSession(reviewer.id, sha256("reviewer-token"), new Date(Date.now() + 3600_000), null);
    const cookie = `${SESSION_COOKIE}=parts-token`;
    const file = await exportZip();
    const size = Math.ceil(file.length / 3);
    const parts = [file.subarray(0, size), file.subarray(size, 2 * size), file.subarray(2 * size)];
    const id = "0123456789abcdef0123456789abcdef";
    const send = (index: number, offset: number, body: Buffer, c = cookie) =>
      fetch(`${base}/api/upload/history-part?organizationId=${orgId}&name=data-export.zip&uploadId=${id}&index=${index}&total=3&offset=${offset}`, { method: "POST", headers: { cookie: c, "content-type": "application/octet-stream" }, body });

    expect((await send(0, 0, parts[0], `${SESSION_COOKIE}=reviewer-token`)).status).toBe(403);
    expect((await send(0, 0, parts[0])).status).toBe(200);
    const skipped = await send(2, 2 * size, parts[2]);
    expect(skipped.status).toBe(409);
    expect((await send(1, size, parts[1])).status).toBe(200);
    const last = await send(2, 2 * size, parts[2]);
    const data = await last.json();
    expect(last.status).toBe(200);
    const imp = db.getHistoryImport(data.id, orgId)!;
    expect(imp.fileName).toBe("data-export.zip");
    const saved = fs.existsSync(imp.filePath) ? fs.readFileSync(imp.filePath) : null;
    if (saved) expect(Buffer.compare(saved, file)).toBe(0);
    expect(fs.readdirSync(require("node:path").dirname(imp.filePath)).some((f: string) => f.includes(id))).toBe(false);
  });
});
