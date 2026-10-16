import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
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

describe("Scene uploads: reference pictures and a script file (2026-10-16)", () => {
  it("keeps a picture in this workspace, reads a script file's words, and turns away anything else", async () => {
    const { orgId, owner } = await makeWorkspace("scene-upload");
    await db.createSession(owner.id, sha256("scene-up"), new Date(Date.now() + 3600_000), null);
    const send = (slot: string, name: string, body: Buffer, type: string) =>
      fetch(`${base}/api/upload/${slot}?organizationId=${orgId}&name=${encodeURIComponent(name)}`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=scene-up`, "content-type": type }, body });
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#1b6b4a" } }).png().toBuffer();
    const pic = await send("scene_ref", "office.png", png, "image/png");
    expect(pic.status).toBe(200);
    const p = await pic.json();
    expect(p.url).toMatch(new RegExp(`^/files/org-${orgId}/scenes/`));
    expect((await send("scene_ref", "notes.txt", Buffer.from("hello"), "text/plain")).status).toBe(400);

    const script = "MAYA: I need this done today.\nJORDAN: Then it's done today.";
    const doc = await send("scene_script", "script.txt", Buffer.from(script), "text/plain");
    expect(doc.status).toBe(200);
    expect((await doc.json()).text).toBe(script);
  });
});
