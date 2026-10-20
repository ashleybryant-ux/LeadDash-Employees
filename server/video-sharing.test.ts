import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { sha256 } from "./_core/crypto";
import { SESSION_COOKIE } from "../shared/const";
import { registerUploads } from "./uploads";
import { registerVideoPages } from "./video-pages";
import { fileOwner, storagePut, uploadsRoot } from "./storage";
import { fmtLength, sniffVideo, VIDEO_MAX, videoKind, videoName } from "./chatVideos";
import { blocksFromHtml, sanitizeHtml, textFromHtml } from "./work/pjDocs";
import { preview } from "./work/pjPreview";
import * as shares from "./videoShares";
import { ffmpegPath } from "./employees/drama";
import { dramaEpisodes, videoEdits, videos } from "../drizzle/schema";

/**
 * Sharing videos (2026-10-20): videos attached in team chat, an employee's chat, tasks and docs
 * play in place for the workspace only; Elena's finished videos get a watch link on Share that
 * anyone can open, which stops working on Stop sharing.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ld-video-share-"));
let mp4: Buffer;
let mov: Buffer;
let base = "";
let server: http.Server;

beforeAll(() => {
  const ff = ffmpegPath();
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x284:rate=15", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "2", "-pix_fmt", "yuv420p", "-shortest", path.join(dir, "clip.mp4")]);
  execFileSync(ff, ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15", "-t", "1", "-pix_fmt", "yuv420p", "-f", "mov", path.join(dir, "IMG_0042.MOV")]);
  mp4 = fs.readFileSync(path.join(dir, "clip.mp4"));
  mov = fs.readFileSync(path.join(dir, "IMG_0042.MOV"));
  const app = express();
  registerUploads(app);
  registerVideoPages(app);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const stored = (url: string) => path.join(uploadsRoot(), url.replace(/^\/files\//, ""));

async function signedIn(slug: string) {
  const w = await makeWorkspace(slug);
  await db.createSession(w.owner.id, sha256(`${slug}-token`), new Date(Date.now() + 3600_000), null);
  const cookie = `${SESSION_COOKIE}=${slug}-token`;
  const send = (slot: string, name: string, body: Buffer, type: string, extra = "") =>
    fetch(`${base}/api/upload/${slot}?organizationId=${w.orgId}&name=${encodeURIComponent(name)}${extra}`, { method: "POST", headers: { cookie, "content-type": type }, body });
  return { ...w, cookie, send };
}

describe("videos in chats, tasks and docs", () => {
  it("knows which files are videos it can play, and names them so they are served as video", () => {
    expect(videoKind("clip.mp4", "application/octet-stream")).toBe("ok");
    expect(videoKind("IMG_0042.MOV", "video/quicktime")).toBe("ok");
    expect(videoKind("talk.webm", "video/webm")).toBe("ok");
    expect(videoKind("recording", "video/quicktime")).toBe("ok");
    expect(videoKind("old.avi", "video/x-msvideo")).toBe("other");
    expect(videoKind("movie.mkv", "application/octet-stream")).toBe("other");
    expect(videoKind("notes.pdf", "application/pdf")).toBeNull();
    expect(videoName("recording", "video/quicktime")).toBe("recording.mov");
    expect(videoName("IMG_0042.MOV", "video/quicktime")).toBe("IMG_0042.MOV");
    expect(sniffVideo(mp4.subarray(0, 12))).toBe(true);
    expect(sniffVideo(mov.subarray(0, 12))).toBe(true);
    expect(sniffVideo(Buffer.from("this is not a video"))).toBe(false);
    expect(fmtLength(59.6)).toBe("1:00");
    expect(fmtLength(125)).toBe("2:05");
    expect(VIDEO_MAX).toBe(250_000_000);
  });

  it("takes a phone's MP4 or MOV in team chat, tasks and an employee's chat, with its length and first frame", async () => {
    const w = await signedIn("vid-upload");
    for (const slot of ["team", "work"]) {
      const r = await w.send(slot, "clip.mp4", mp4, "video/mp4");
      expect(r.status).toBe(200);
      const f = await r.json();
      expect(f).toMatchObject({ kind: "video", name: "clip.mp4", size: mp4.length });
      expect(f.seconds).toBe(2);
      expect(f.url).toMatch(new RegExp(`^/files/org-${w.orgId}/${slot}/clip_[a-f0-9]{16}\\.mp4$`));
      expect(fs.readFileSync(stored(f.url)).equals(mp4)).toBe(true);
      expect(f.poster).toMatch(/-poster\.jpg$/);
      expect(fs.statSync(stored(f.poster)).size).toBeGreaterThan(0);
      // Only people on this workspace can open either file (the /files rule).
      expect(fileOwner(f.url.replace(/^\/files/, ""))).toEqual({ kind: "org", id: w.orgId });
      expect(fileOwner(f.poster.replace(/^\/files/, ""))).toEqual({ kind: "org", id: w.orgId });
    }
    const iphone = await (await w.send("team", "IMG_0042.MOV", mov, "video/quicktime")).json();
    expect(iphone).toMatchObject({ kind: "video", name: "IMG_0042.MOV" });
    expect(db.getChatFiles(w.orgId, [iphone.id])[0].mime).toBe("video/quicktime");

    // An employee's chat: the employee learns the name and length only. Nothing is watched or transcribed.
    const emp = (await db.listEmployeesByOrg(w.orgId))[0];
    const c = await (await w.send("chat", "clip.mp4", mp4, "video/mp4", `&employeeId=${emp.id}`)).json();
    const row = db.getChatFiles(w.orgId, [c.id])[0];
    expect(row).toMatchObject({ kind: "video", employeeId: emp.id, seconds: 2 });
    expect(row.text).toContain("0:02 long");
    expect(row.text).toContain("can't watch or hear it");
  });

  it("refuses other video formats, files that only claim to be video, oversize videos and people off the workspace", async () => {
    const w = await signedIn("vid-refuse");
    const avi = await w.send("team", "old.avi", Buffer.from("RIFF....AVI LIST"), "video/x-msvideo");
    expect(avi.status).toBe(400);
    expect((await avi.json()).error).toBe("Videos must be MP4, MOV or WebM.");

    const fake = await w.send("work", "virus.mp4", Buffer.from("MZ this is not a video at all"), "video/mp4");
    expect(fake.status).toBe(400);
    expect((await fake.json()).error).toMatch(/isn't a video that can play here/);
    expect(fs.readdirSync(path.join(uploadsRoot(), `org-${w.orgId}`, "work")).filter((f) => f.startsWith("virus"))).toHaveLength(0);

    // Over 250 MB is turned away from its size alone, before the file is read.
    const tooBig = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(`${base}/api/upload/team?organizationId=${w.orgId}&name=big.mp4`);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST", headers: { cookie: w.cookie, "content-type": "video/mp4", "content-length": String(VIDEO_MAX + 1) } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", () => null);
      req.write(mp4.subarray(0, 64), () => null);
      setTimeout(() => reject(new Error("no answer")), 5000).unref();
    });
    expect(tooBig.status).toBe(400);
    expect(JSON.parse(tooBig.body).error).toBe("Videos must be under 250 MB.");

    // Someone who isn't on the workspace can't upload to it.
    const stranger = await makeUser("stranger@vid-refuse.test");
    await db.createSession(stranger.id, sha256("stranger-token"), new Date(Date.now() + 3600_000), null);
    const out = await fetch(`${base}/api/upload/team?organizationId=${w.orgId}&name=clip.mp4`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=stranger-token`, "content-type": "video/mp4" }, body: mp4 });
    expect(out.status).toBe(403);

    // Ordinary files still keep their 20 MB limit and kinds.
    const doc = await (await w.send("team", "notes.txt", Buffer.from("hello"), "text/plain")).json();
    expect(doc.kind).toBe("document");
  });

  it("a video sent in team chat carries its picture and length in the message, and previews as a video on a task", async () => {
    const w = await signedIn("vid-team");
    const f = await (await w.send("team", "clip.mp4", mp4, "video/mp4")).json();
    const team = await import("./team");
    const msg = await team.send(w.orgId, { id: w.owner.id, name: "Owner" }, "everyone", "", [f.id]);
    const att = JSON.parse(msg.attachments!);
    expect(att).toEqual([{ id: f.id, name: "clip.mp4", size: mp4.length, kind: "video", url: f.url, poster: f.poster, seconds: 2 }]);
    const p = await preview(w.orgId, { kind: "member", userId: w.owner.id, role: "owner", name: "Owner" }, f.id);
    expect(p).toEqual({ kind: "video", url: f.url, poster: f.poster });
  });

  it("a doc keeps a video from the workspace's files and plays it, and drops anything else", () => {
    const html = sanitizeHtml(
      `<p>Watch this</p><video src="/files/org-1/work/clip_ab.mp4" poster="/files/org-1/work/clip_ab-poster.jpg" title="Intro.mov" onerror="steal()" autoplay controls></video>` +
        `<video src="https://evil.example/x.mp4"></video><video src="javascript:alert(1)"></video><video src="/files/x.mp4&quot; onload=&quot;x"></video>`
    );
    expect(html).toBe(`<p>Watch this</p><video src="/files/org-1/work/clip_ab.mp4" poster="/files/org-1/work/clip_ab-poster.jpg" title="Intro.mov" controls="" playsinline="" preload="metadata"></video>`);
    const blocks = blocksFromHtml(html);
    expect(blocks[1]).toMatchObject({ type: "video", text: "Intro.mov", url: "/files/org-1/work/clip_ab.mp4" });
    expect(textFromHtml(html)).toBe("Watch this\nVideo: Intro.mov");
  });
});

describe("sharing Elena's videos", () => {
  async function readyVideo(orgId: number, title: string, status: "ready" | "draft" = "ready") {
    const saved = await storagePut(`org-${orgId}/videos/made.mp4`, mp4, "video/mp4");
    const emp = (await db.listEmployeesByOrg(orgId))[0];
    return db
      .getDb()
      .insert(videos)
      .values({ organizationId: orgId, employeeId: emp.id, title, status, size: "vertical", sizes: '["vertical"]', videoUrls: status === "ready" ? JSON.stringify({ vertical: saved.url }) : "{}", videoUrl: status === "ready" ? saved.url : null })
      .returning()
      .get();
  }

  it("Share makes a random watch link anyone can open; Stop sharing turns it off", async () => {
    const w = await makeWorkspace("vid-share");
    const v = await readyVideo(w.orgId, "Private working title");
    const me = caller(w.owner);
    expect((await me.videoShares.get({ organizationId: w.orgId, source: "video", id: v.id })).link).toBeNull();
    const { link } = await me.videoShares.set({ organizationId: w.orgId, source: "video", id: v.id, on: true });
    expect(link).toMatch(/^\/watch\/[A-Za-z0-9_-]{24}$/);
    // Pressing Share again keeps the same link.
    expect((await me.videoShares.set({ organizationId: w.orgId, source: "video", id: v.id, on: true })).link).toBe(link);
    expect((await me.videoShares.get({ organizationId: w.orgId, source: "video", id: v.id })).link).toBe(link);

    const page = await fetch(`${base}${link}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Workspace vid-share");
    expect(html).toContain(`${link}/9x16.mp4`);
    expect(html).toContain("playsinline");
    expect(html).toContain("Download");
    // Nothing else private: not the title, not the stored file's address.
    expect(html).not.toContain("Private working title");
    expect(html).not.toContain("/files/");

    const file = await fetch(`${base}${link}/9x16.mp4`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("video/mp4");
    expect(Buffer.from(await file.arrayBuffer()).equals(mp4)).toBe(true);
    // Phones ask for the video in pieces.
    const part = await fetch(`${base}${link}/9x16.mp4`, { headers: { range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(`${base}${link}/16x9.mp4`)).status).toBe(404);

    expect((await me.videoShares.set({ organizationId: w.orgId, source: "video", id: v.id, on: false })).link).toBeNull();
    expect((await fetch(`${base}${link}`)).status).toBe(404);
    expect((await fetch(`${base}${link}/9x16.mp4`)).status).toBe(404);

    // Sharing again makes a new link; the old one stays dead.
    const again = (await me.videoShares.set({ organizationId: w.orgId, source: "video", id: v.id, on: true })).link!;
    expect(again).not.toBe(link);
    expect((await fetch(`${base}${link}`)).status).toBe(404);
    expect((await fetch(`${base}${again}`)).status).toBe(200);
  });

  it("works for Edit my video and Scenes too, with every size they were cut in", async () => {
    const w = await makeWorkspace("vid-kinds");
    const a = await storagePut(`org-${w.orgId}/edits/out.mp4`, mp4, "video/mp4");
    const b = await storagePut(`org-${w.orgId}/edits/out-wide.mp4`, mp4, "video/mp4");
    const edit = db.getDb().insert(videoEdits).values({ organizationId: w.orgId, title: "My talk", status: "ready", videoUrls: JSON.stringify({ vertical: a.url, wide: b.url }), videoUrl: a.url }).returning().get();
    const scene = db.getDb().insert(dramaEpisodes).values({ organizationId: w.orgId, number: 1, title: "A scene", kind: "scene", status: "ready", versions: JSON.stringify({ "9:16": a.url }), videoUrl: a.url }).returning().get();
    const editLink = shares.setShared(w.orgId, "edit", edit.id, true, "Owner")!;
    const html = await (await fetch(`${base}${editLink}`)).text();
    expect(html).toContain(">9:16</a>");
    expect(html).toContain(">16:9</a>");
    expect((await fetch(`${base}${editLink}/16x9.mp4`)).status).toBe(200);
    const sceneLink = shares.setShared(w.orgId, "scene", scene.id, true, "Owner")!;
    expect((await fetch(`${base}${sceneLink}/9x16.mp4`)).status).toBe(200);
    // Each video has its own link: turning one off leaves the other.
    shares.setShared(w.orgId, "edit", edit.id, false, "Owner");
    expect((await fetch(`${base}${editLink}`)).status).toBe(404);
    expect((await fetch(`${base}${sceneLink}`)).status).toBe(200);
  });

  it("links can't be guessed: random tokens, never the video's id", async () => {
    const tokens = new Set(Array.from({ length: 200 }, () => shares.newToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const w = await makeWorkspace("vid-guess");
    const v = await readyVideo(w.orgId, "Guess me");
    const link = shares.setShared(w.orgId, "video", v.id, true, "Owner")!;
    expect(link).not.toContain(String(v.id).padStart(24, "0"));
    expect((await fetch(`${base}/watch/${v.id}`)).status).toBe(404);
    expect((await fetch(`${base}/watch/${"A".repeat(24)}`)).status).toBe(404);
    expect((await fetch(`${base}/watch/../../files`)).status).toBe(404);
    expect(shares.byToken("short")).toBeNull();
  });

  it("only people on the workspace can share, and only a finished video", async () => {
    const w = await makeWorkspace("vid-perm");
    const other = await makeWorkspace("vid-perm-other");
    const v = await readyVideo(w.orgId, "Ours");
    const draft = await readyVideo(w.orgId, "Not made yet", "draft");
    await expect(caller(w.reviewer).videoShares.set({ organizationId: w.orgId, source: "video", id: v.id, on: true })).rejects.toThrow();
    await expect(caller(other.owner).videoShares.set({ organizationId: w.orgId, source: "video", id: v.id, on: true })).rejects.toThrow(/not an authorized member/);
    await expect(caller(other.owner).videoShares.get({ organizationId: w.orgId, source: "video", id: v.id })).rejects.toThrow(/not an authorized member/);
    // Another workspace naming this video's id under its own workspace finds nothing to share.
    await expect(caller(other.owner).videoShares.set({ organizationId: other.orgId, source: "video", id: v.id, on: true })).rejects.toThrow("You can share it once it's finished.");
    await expect(caller(w.owner).videoShares.set({ organizationId: w.orgId, source: "video", id: draft.id, on: true })).rejects.toThrow("You can share it once it's finished.");
    // A deleted video's link stops working.
    const link = shares.setShared(w.orgId, "video", v.id, true, "Owner")!;
    expect((await fetch(`${base}${link}`)).status).toBe(200);
    const { eq } = await import("drizzle-orm");
    db.getDb().delete(videos).where(eq(videos.id, v.id)).run();
    expect((await fetch(`${base}${link}`)).status).toBe(404);
  });
});
