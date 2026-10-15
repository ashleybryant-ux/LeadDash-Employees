import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { sha256 } from "./_core/crypto";
import { SESSION_COOKIE } from "../shared/const";
import { registerUploads } from "./uploads";
import { uploadsRoot } from "./storage";
import { SVG_HEADERS, cleanSvg, isSvg, svgToPng } from "./svg";
import * as drama from "./employees/drama";

const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" width="200" height="100" onload="alert(1)">
  <script>alert('x')</script>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#1b6b4a"/><stop offset="1" stop-color="#22a865"/></linearGradient></defs>
  <rect x="10" y="10" width="180" height="80" rx="16" fill="url(#g)" onclick="steal()"/>
  <use xlink:href="#g"/>
  <a href="javascript:alert(2)"><text x="30" y="60">LeadDash</text></a>
  <image href="https://evil.example/track.png" width="1" height="1"/>
  <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
</svg>`;

let base = "";
let server: ReturnType<express.Express["listen"]>;
beforeAll(() => {
  const app = express();
  registerUploads(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("SVG files", () => {
  it("knows an SVG by its contents and cleans out anything that could run, keeping the picture", async () => {
    expect(isSvg(Buffer.from(LOGO))).toBe(true);
    expect(isSvg(Buffer.from("<html><svg></svg></html>"))).toBe(false);
    expect(isSvg(Buffer.from("not a picture"))).toBe(false);
    const out = cleanSvg(LOGO);
    expect(out).not.toMatch(/script|onload|onclick|javascript:|evil\.example|foreignObject|<!DOCTYPE|ENTITY/i);
    // Everything that draws stays: the gradient, the shape, the text and the inside link.
    expect(out).toContain('<rect x="10" y="10" width="180" height="80" rx="16" fill="url(#g)"');
    expect(out).toContain('xlink:href="#g"');
    expect(out).toContain(">LeadDash</text>");
    // The tools that can't read SVG get a sharp PNG that keeps the see-through background.
    const png = await svgToPng(Buffer.from(out));
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(Math.min(meta.width!, meta.height!)).toBeGreaterThanOrEqual(1024);
    expect((await drama.bigEnough(Buffer.from(out), "image/svg+xml")).mime).toBe("image/png");
    // Served as a picture that can't run anything.
    expect(SVG_HEADERS["Content-Type"]).toBe("image/svg+xml");
    expect(SVG_HEADERS["Content-Security-Policy"]).toMatch(/default-src 'none'.*sandbox/);
  });

  it("an SVG shared in Projects, team chat and the Brain is kept as a clean picture", async () => {
    const { orgId, owner } = await makeWorkspace("svg-upload");
    await db.createSession(owner.id, sha256("svg-token"), new Date(Date.now() + 3600_000), null);
    const headers = { cookie: `${SESSION_COOKIE}=svg-token`, "content-type": "image/svg+xml" };
    const send = (slot: string, name: string, extra = "") => fetch(`${base}/api/upload/${slot}?organizationId=${orgId}&name=${encodeURIComponent(name)}${extra}`, { method: "POST", headers, body: Buffer.from(LOGO) });

    for (const slot of ["work", "team"]) {
      const r = await send(slot, "logo.svg");
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ kind: "image", name: "logo.svg" });
      expect(body.url).toMatch(/\.svg$/);
      const stored = fs.readFileSync(path.join(uploadsRoot(), body.url.replace(/^\/files\//, "")), "utf8");
      expect(stored).toContain("<rect");
      expect(stored).not.toMatch(/script|onload|evil\.example/i);
    }

    const b = await send("brain_image", "logo.svg", "&title=Logo&note=Our%20logo");
    expect(b.status).toBe(200);
    const item = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Logo")!;
    expect(item.kind).toBe("image");
    expect(item.fileUrl).toMatch(/\.svg$/);
  });
});
