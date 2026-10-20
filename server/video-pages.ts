/**
 * Public video pages, reached by a private link (2026-10-15):
 * - /v/:key            one of Simone's videos, watchable by anyone with the link, no sign-in
 * - /v/:key/:size.mp4  the video file itself, so the page's player (and a download) works signed out
 * The key is random and lives only while the owner keeps "Share with anyone" on; turning it off
 * clears the key, so an old link stops working.
 *
 * And Elena's finished videos, shared with Share (2026-10-20):
 * - /watch/:token            plays it for anyone with the link, showing only the workspace's name
 * - /watch/:token/:ratio.mp4 the file itself (9x16, 1x1 or 16x9), for the player and Download
 * Stop sharing deletes the token, so both stop working.
 */
import fs from "node:fs";
import type { Express } from "express";
import * as db from "./db";
import { byPublicKey, SIZES, sizesOf, urlsOf, type Size } from "./employees/demoVideos";
import { localFile } from "./employees/broll";
import { byToken } from "./videoShares";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `*{box-sizing:border-box}body{margin:0;background:#F8FAFB;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;color:#14221c}
.wrap{max-width:1040px;margin:0 auto;padding:32px 16px 48px}.card{background:#fff;border:1px solid #e3e9e6;border-radius:16px;padding:20px 22px;display:flex;flex-direction:column;gap:14px}
h1{font-size:22px;margin:0;font-weight:800}p{font-size:14px;line-height:1.6;color:#3d4c45;margin:0}.muted{color:#5b6b64;font-size:13px}
video{width:100%;max-height:78vh;background:#000;border-radius:12px;display:block}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
a.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:10px;border:1px solid #cfd9d4;background:#fff;color:#14221c;font-weight:700;font-size:14px;text-decoration:none}
a.btn.on{background:#1b6b4a;border-color:#1b6b4a;color:#fff}`;

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
const notFound = () => shell("Not found", `<div class="card"><h1>Not found</h1><p>This link isn't active.</p></div>`);

export function registerVideoPages(app: Express) {
  app.get("/v/:key", async (req, res) => {
    const d = byPublicKey(String(req.params.key));
    const urls = d ? urlsOf(d) : {};
    const sizes = d ? sizesOf(d).filter((s) => urls[s]) : [];
    if (!d || !sizes.length) return res.status(404).send(notFound());
    const want = String(req.query.size ?? "");
    const size: Size = sizes.includes(want as Size) ? (want as Size) : sizes[0];
    const org = await db.getOrganizationById(d.organizationId);
    const pick = sizes.length > 1 ? `<div class="row">${sizes.map((s) => `<a class="btn${s === size ? " on" : ""}" href="/v/${esc(d.publicKey!)}?size=${s}">${SIZES[s].ratio}</a>`).join("")}</div>` : "";
    res.setHeader("Cache-Control", "no-store");
    res.send(
      shell(
        d.title,
        `<div class="card"><div><h1>${esc(d.title)}</h1><p class="muted">${esc(org?.name ?? "")}</p></div><video controls playsinline preload="metadata" src="/v/${esc(d.publicKey!)}/${size}.mp4"></video>${pick}<div class="row"><a class="btn" href="/v/${esc(d.publicKey!)}/${size}.mp4" download="${esc(d.title)} ${SIZES[size].ratio.replace(":", "x")}.mp4">Download</a></div></div>`
      )
    );
  });

  app.get("/watch/:token", async (req, res) => {
    const found = byToken(String(req.params.token));
    if (!found) return res.status(404).setHeader("Cache-Control", "no-store").send(notFound());
    const { share, files } = found;
    const want = String(req.query.size ?? "");
    const f = files.find((x) => x.slug === want) ?? files[0];
    const org = await db.getOrganizationById(share.organizationId);
    const name = org?.name ?? "";
    const base = `/watch/${esc(share.token)}`;
    const pick = files.length > 1 ? `<div class="row">${files.map((x) => `<a class="btn${x.slug === f.slug ? " on" : ""}" href="${base}?size=${x.slug}">${x.ratio}</a>`).join("")}</div>` : "";
    const title = name ? `A video from ${name}` : "A video";
    res.setHeader("Cache-Control", "no-store");
    res.send(
      shell(
        title,
        `<div class="card"><div><h1>${esc(name || "Video")}</h1></div><video controls playsinline preload="metadata" src="${base}/${f.slug}.mp4#t=0.1"></video>${pick}<div class="row"><a class="btn" href="${base}/${f.slug}.mp4" download="${esc(name || "video")} ${f.slug}.mp4">Download</a></div></div>`
      ).replace("<title>", `<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="video.other"><title>`)
    );
  });

  app.get("/watch/:token/:slug.mp4", (req, res) => {
    const found = byToken(String(req.params.token));
    const f = found?.files.find((x) => x.slug === String(req.params.slug));
    const file = f ? localFile(f.url) : null;
    if (!file || !fs.existsSync(file)) return res.status(404).send("Not found");
    // Never kept in a shared cache: once sharing stops, the next request is refused.
    res.setHeader("Cache-Control", "private, no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(file, { headers: { "Content-Type": "video/mp4" } });
  });

  app.get("/v/:key/:size.mp4", (req, res) => {
    const d = byPublicKey(String(req.params.key));
    const size = String(req.params.size) as Size;
    const url = d && size in SIZES ? urlsOf(d)[size] : null;
    const file = url ? localFile(url) : null;
    if (!d || !file || !fs.existsSync(file)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(file, { headers: { "Content-Type": "video/mp4" } });
  });
}
