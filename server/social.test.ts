import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as social from "./social";
import { storagePut } from "./storage";
import { encryptJson } from "./_core/crypto";
import { payloadFor, postProblems } from "@shared/post-model";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];

function json(body: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  routes = [];
  process.env.META_APP_ID = "m-id";
  process.env.META_APP_SECRET = "m-secret";
  process.env.THREADS_APP_ID = "t-id";
  process.env.THREADS_APP_SECRET = "t-secret";
  process.env.TIKTOK_CLIENT_KEY = "tt-key";
  process.env.TIKTOK_CLIENT_SECRET = "tt-secret";
  process.env.X_CLIENT_ID = "x-id";
  process.env.X_CLIENT_SECRET = "x-secret";
  process.env.LINKEDIN_CLIENT_ID = "li-id";
  process.env.LINKEDIN_CLIENT_SECRET = "li-secret";
  integrations.setPollMs(0);
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return json({ error: "no route " + url }, 500);
  });
});
afterEach(() => vi.unstubAllGlobals());

const BLANK = { name: "", w: 0, h: 0 };
const TT = { privacy: "" as const, allowComment: true, allowDuet: true, allowStitch: true, disclose: false, yourBrand: false, brandedContent: false };

async function connect(orgId: number, provider: "facebook" | "threads" | "tiktok" | "x" | "linkedin", settings: Record<string, unknown>, tokens: Record<string, unknown>) {
  await db.upsertExternalConnection({ organizationId: orgId, provider, accountLabel: "Acct", status: "connected", settings: JSON.stringify(settings), secretsEncrypted: encryptJson({ accessToken: "tok", ...tokens }), connectedAt: new Date(), lastCheckedAt: new Date() });
}

/** A fake 12 MB video stored for the workspace. */
async function video(orgId: number, bytes = 12 * 1024 * 1024) {
  return (await storagePut(`org-${orgId}/social/clip.mp4`, Buffer.alloc(bytes, 1))).url;
}

function future(days: number, tz = "America/Chicago") {
  const l = social.localParts(new Date(Date.now() + days * 86_400_000), tz);
  return l.date;
}

describe("Threads and TikTok connections", () => {
  it("builds the Threads and TikTok sign-in links (TikTok uses client_key)", () => {
    const t = new URL(integrations.authorizeUrl("threads", "st"));
    expect(t.origin).toBe("https://threads.net");
    expect(t.searchParams.get("scope")).toBe("threads_basic,threads_content_publish");
    const k = new URL(integrations.authorizeUrl("tiktok", "st"));
    expect(k.searchParams.get("client_key")).toBe("tt-key");
    expect(k.searchParams.get("client_id")).toBeNull();
    expect(k.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(integrations.readyApps().threads && integrations.readyApps().tiktok).toBe(true);
  });

  it("connects Threads with a 60-day token, and TikTok with the creator's name", async () => {
    const { orgId } = await makeWorkspace("so-conn");
    routes.push([/graph\.threads\.net\/oauth\/access_token/, () => json({ access_token: "short", user_id: "777" })]);
    routes.push([/graph\.threads\.net\/access_token\?/, (u) => json(u.includes("th_exchange_token") ? { access_token: "long", expires_in: 5184000 } : {})]);
    routes.push([/graph\.threads\.net\/v1\.0\/me/, () => json({ id: "777", username: "legacyfamilyokc" })]);
    expect(await integrations.finishConnect(orgId, "threads", "code")).toBe("@legacyfamilyokc");

    routes.push([/open\.tiktokapis\.com\/v2\/oauth\/token/, (_u, init) => {
      expect(String(init.body)).toContain("client_key=tt-key");
      return json({ access_token: "tt-acc", refresh_token: "tt-ref", expires_in: 86400, open_id: "o1" });
    }]);
    routes.push([/creator_info\/query/, () => json({ data: { creator_nickname: "Legacy Family", creator_username: "legacyfamilyokc", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } })]);
    expect(await integrations.finishConnect(orgId, "tiktok", "code")).toBe("@legacyfamilyokc");
    const state = await integrations.channelState(orgId);
    expect(state.threads && state.tiktok).toBe(true);
  });
});

describe("posting each kind of post", () => {
  it("posts text and image to Threads, and crops Instagram images to 4:5", async () => {
    const { orgId, owner } = await makeWorkspace("so-th");
    await connect(orgId, "threads", { userId: "777", username: "legacyfamilyokc" }, { expiresAt: Date.now() + 30 * 86_400_000 });
    routes.push([/\/777\/threads\b(?!_)/, () => json({ id: "c1" })]);
    routes.push([/\/c1\?fields=status/, () => json({ status: "FINISHED" })]);
    routes.push([/\/777\/threads_publish/, () => json({ id: "m1" })]);
    routes.push([/\/m1\?fields=permalink/, () => json({ permalink: "https://www.threads.net/@legacyfamilyokc/post/abc" })]);
    const post = await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "pending_approval", title: "T", body: "A".repeat(700), targetChannels: JSON.stringify(["threads"]) });
    const done = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: post.id, action: "approve_for_dispatch" });
    expect(done?.status).toBe("published");
    const body = new URLSearchParams(calls.find((c) => /\/777\/threads$/.test(c.url))!.init.body);
    expect(body.get("media_type")).toBe("TEXT");
    expect(body.get("text")!.length).toBeLessThanOrEqual(500); // fitted to Threads' limit

    expect(integrations.igCropBox(1024, 1536)).toEqual({ left: 0, top: 128, width: 1024, height: 1280 });
    expect(integrations.igCropBox(1080, 1350)).toBeNull();
    expect(integrations.igCropBox(3000, 1000)).toEqual({ left: 545, top: 0, width: 1910, height: 1000 });
  });

  it("posts a Reel to Instagram and Facebook, and video to X, LinkedIn and TikTok, in the background", async () => {
    const { orgId, owner } = await makeWorkspace("so-reel");
    const vid = await video(orgId);
    await connect(orgId, "facebook", { pageId: "p1", pageName: "Legacy", igId: "ig1", igUsername: "legacyfamilyokc" }, { pageToken: "page-1" });
    await connect(orgId, "x", { username: "legacy" }, {});
    await connect(orgId, "linkedin", { personUrn: "urn:li:person:1" }, {});
    await connect(orgId, "tiktok", { username: "legacyfamilyokc" }, { refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
    // Instagram
    routes.push([/\/ig1\/media$/, () => json({ id: "igc" })]);
    routes.push([/\/igc\?fields=status_code/, () => json({ status_code: "FINISHED" })]);
    routes.push([/\/ig1\/media_publish/, () => json({ id: "igm" })]);
    routes.push([/\/igm\?fields=permalink/, () => json({ permalink: "https://instagram.com/reel/1" })]);
    // Facebook
    routes.push([/\/p1\/video_reels/, (_u, init) => json(String(init.body).includes("upload_phase=start") ? { video_id: "v9", upload_url: "x" } : { success: true })]);
    routes.push([/rupload\.facebook\.com/, () => json({ success: true })]);
    routes.push([/\/v9\?fields=status/, () => json({ status: { video_status: "ready" } })]);
    // X
    routes.push([/media\/upload\/initialize/, () => json({ data: { id: "xm" } })]);
    routes.push([/media\/upload\/xm\/append/, () => json({})]);
    routes.push([/media\/upload\/xm\/finalize/, () => json({ data: { id: "xm", processing_info: { state: "pending" } } })]);
    routes.push([/media\/upload\?media_id=xm/, () => json({ data: { processing_info: { state: "succeeded" } } })]);
    routes.push([/api\.x\.com\/2\/tweets/, () => json({ data: { id: "55" } })]);
    // LinkedIn
    routes.push([/rest\/videos\?action=initializeUpload/, () => json({ value: { video: "urn:li:video:1", uploadToken: "", uploadInstructions: [{ uploadUrl: "https://upload.li/1", firstByte: 0, lastByte: 12 * 1024 * 1024 - 1 }] } })]);
    routes.push([/upload\.li\/1/, () => new Response(null, { status: 200, headers: { etag: '"e1"' } })]);
    routes.push([/rest\/videos\?action=finalizeUpload/, () => json({})]);
    routes.push([/rest\/videos\/urn/, () => json({ status: "AVAILABLE" })]);
    routes.push([/rest\/posts/, () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } })]);
    // TikTok
    routes.push([/creator_info\/query/, () => json({ data: { creator_nickname: "Legacy", creator_username: "legacyfamilyokc", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } })]);
    routes.push([/video\/init/, () => json({ data: { publish_id: "pub1", upload_url: "https://upload.tiktok/1" }, error: { code: "ok" } })]);
    routes.push([/upload\.tiktok\/1/, () => new Response(null, { status: 201 })]);
    routes.push([/status\/fetch/, () => json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [123] }, error: { code: "ok" } })]);

    const saved = await caller(owner).social.savePost({
      organizationId: orgId,
      type: "reel",
      mode: "same",
      channels: ["instagram", "facebook", "x", "linkedin", "tiktok"],
      text: "3 habits that help couples argue less",
      imageUrl: null,
      imageMeta: null,
      variants: {},
      videoUrl: vid,
      videoMeta: { ...BLANK, w: 1080, h: 1920, seconds: 42 },
      coverUrl: null,
      coverMs: 3000,
      tiktok: TT,
      date: "",
      time: "",
    });
    // TikTok requires a viewing choice before it can go out.
    await expect(caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: saved.id, action: "approve_for_dispatch" })).rejects.toThrow(/who can view/);
    await caller(owner).social.savePost({ organizationId: orgId, itemId: saved.id, type: "reel", mode: "same", channels: ["instagram", "facebook", "x", "linkedin", "tiktok"], text: "3 habits that help couples argue less", imageUrl: null, imageMeta: null, variants: {}, videoUrl: vid, videoMeta: { w: 1080, h: 1920, seconds: 42 }, coverUrl: null, coverMs: 3000, tiktok: { ...TT, privacy: "PUBLIC_TO_EVERYONE" }, date: "", time: "" });

    const started = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: saved.id, action: "approve_for_dispatch" });
    expect(started?.status).toBe("approved");
    expect(JSON.parse(started!.metadata!).postingSince).toBeTruthy(); // shows "Posting" while it runs
    await social.settled();
    const done = (await db.getOutboundItemForOrg(saved.id, orgId))!;
    const d = JSON.parse(done.metadata!).dispatch;
    expect(d.filter((x: any) => !x.ok)).toEqual([]);
    expect(done.status).toBe("published");

    const ig = new URLSearchParams(calls.find((c) => /\/ig1\/media$/.test(c.url))!.init.body);
    expect(ig.get("media_type")).toBe("REELS");
    expect(ig.get("thumb_offset")).toBe("3000");
    expect(ig.get("video_url")).toMatch(/\/media\//);
    expect(calls.find((c) => c.url.includes("rupload.facebook.com"))!.init.headers.file_url).toMatch(/\/media\//);
    expect(calls.filter((c) => c.url.includes("/append")).length).toBe(3); // 12 MB in 4 MB pieces
    expect(JSON.parse(calls.find((c) => c.url.includes("/2/tweets"))!.init.body).media.media_ids).toEqual(["xm"]);
    const tInit = JSON.parse(calls.find((c) => c.url.includes("video/init"))!.init.body);
    expect(tInit.post_info).toMatchObject({ privacy_level: "PUBLIC_TO_EVERYONE", disable_comment: false, video_cover_timestamp_ms: 3000, brand_organic_toggle: false });
    expect(tInit.source_info).toMatchObject({ source: "FILE_UPLOAD", video_size: 12 * 1024 * 1024, total_chunk_count: 1 });
    expect(calls.find((c) => c.url.includes("upload.tiktok"))!.init.headers["content-range"]).toBe(`bytes 0-${12 * 1024 * 1024 - 1}/${12 * 1024 * 1024}`);
    expect(d.find((x: any) => x.channel === "tiktok").url).toBe("https://www.tiktok.com/@legacyfamilyokc/video/123");
    expect(integrations.tiktokChunks(25 * 1024 * 1024)).toEqual({ chunkSize: 10 * 1024 * 1024, count: 2 });
  });
});

describe("planning and scheduling", () => {
  it("saves a different post per account, and checks what each account needs", async () => {
    const { orgId, owner } = await makeWorkspace("so-diff");
    const img = (await storagePut(`org-${orgId}/social/a.png`, Buffer.from("x"))).url;
    const p = await caller(owner).social.savePost({ organizationId: orgId, type: "post", mode: "different", channels: ["facebook", "x", "instagram", "threads"], text: "Long caption for Facebook", imageUrl: img, imageMeta: { w: 1080, h: 1350 }, variants: { x: { text: "Short for X", imageUrl: img }, threads: { text: "No picture here", imageUrl: null } }, videoUrl: null, videoMeta: null, coverUrl: null, coverMs: 0, tiktok: TT, date: "", time: "" });
    expect(payloadFor(p, "x").text).toBe("Short for X");
    expect(payloadFor(p, "x").imageUrl).toBe(img);
    expect(payloadFor(p, "threads").imageUrl).toBeNull();
    expect(payloadFor(p, "facebook").text).toBe("Long caption for Facebook");
    expect(postProblems(p)).toEqual([]);
    await expect(caller(owner).social.savePost({ organizationId: orgId, type: "post", mode: "same", channels: ["facebook"], text: "x", imageUrl: "/files/org-999/social/b.png", imageMeta: null, variants: {}, videoUrl: null, videoMeta: null, coverUrl: null, coverMs: 0, tiktok: TT, date: "", time: "" })).rejects.toThrow(/not in this workspace/);
    expect(postProblems({ ...p, targetChannels: JSON.stringify(["tiktok"]) })).toContain("TikTok takes videos only. Switch to Reel or remove TikTok");
  });

  it("a draft with a time waits for approval; approving schedules it; it posts when the time comes", async () => {
    const { orgId, owner } = await makeWorkspace("so-sched");
    await connect(orgId, "facebook", { pageId: "p1", pageName: "Legacy" }, { pageToken: "page-1" });
    routes.push([/\/p1\/feed/, () => json({ id: "p1_9" })]);
    const date = future(3);
    const p = await caller(owner).social.savePost({ organizationId: orgId, type: "post", mode: "same", channels: ["facebook"], text: "Open house Saturday.", imageUrl: null, imageMeta: null, variants: {}, videoUrl: null, videoMeta: null, coverUrl: null, coverMs: 0, tiktok: TT, date, time: "11:30 AM" });
    expect(p.status).toBe("pending_approval");
    expect(social.localParts(new Date(p.scheduledFor!), "America/Chicago")).toMatchObject({ date, time: "11:30 AM" });
    // Not approved yet: the runner leaves it alone even after its time.
    expect(await social.postDue(new Date(Date.now() + 10 * 86_400_000))).toBe(0);

    const ok = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: p.id, action: "approve_for_dispatch" });
    expect(ok?.status).toBe("scheduled");
    expect(calls.length).toBe(0);
    expect(await social.postDue(new Date())).toBe(0); // not yet
    expect(await social.postDue(new Date(Date.now() + 4 * 86_400_000))).toBe(1);
    await social.settled();
    expect((await db.getOutboundItemForOrg(p.id, orgId))?.status).toBe("published");
    expect(await social.postDue(new Date(Date.now() + 4 * 86_400_000))).toBe(0); // never twice

    // Unschedule and move.
    const q = await caller(owner).social.savePost({ organizationId: orgId, type: "post", mode: "same", channels: ["facebook"], text: "Second", imageUrl: null, imageMeta: null, variants: {}, videoUrl: null, videoMeta: null, coverUrl: null, coverMs: 0, tiktok: TT, date: "", time: "" });
    await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: q.id, action: "approve_only" });
    expect((await db.getOutboundItemForOrg(q.id, orgId))?.status).toBe("approved");
    const moved = await caller(owner).social.schedule({ organizationId: orgId, itemId: q.id, date: future(5) });
    expect(moved?.status).toBe("scheduled");
    expect((await caller(owner).social.unschedule({ organizationId: orgId, itemId: q.id }))?.status).toBe("approved");
    await expect(caller(owner).social.schedule({ organizationId: orgId, itemId: q.id, date: "01/01/2020" })).rejects.toThrow(/later than now/);
  });

  it("suggests a time from defaults, or from the Facebook Page's own engagement", async () => {
    const { orgId, owner } = await makeWorkspace("so-best");
    const s = await caller(owner).social.suggestTime({ organizationId: orgId, channels: ["linkedin"], type: "post" });
    expect(s.time).toBe("9:00 AM");
    expect(s.reason).toMatch(/general starting point for LinkedIn/);
    expect([2, 3]).toContain(new Date(`${s.date} 12:00`).getDay());

    await connect(orgId, "facebook", { pageId: "p1", pageName: "Legacy" }, { pageToken: "page-1" });
    // 12 posts: Mondays and Fridays at 7 PM Chicago time do best.
    const posts = [];
    for (let i = 0; i < 12; i++) {
      const k = Math.floor(i / 3);
      const kind = i % 3; // Monday 7 PM, Friday 7 PM (both do well), Tuesday 10 AM (does poorly)
      const at = kind === 0 ? Date.UTC(2026, 7, 4 + 7 * k, 0) : kind === 1 ? Date.UTC(2026, 7, 8 + 7 * k, 0) : Date.UTC(2026, 7, 4 + 7 * k, 15);
      posts.push({ created_time: new Date(at).toISOString(), reactions: { summary: { total_count: kind === 2 ? 2 : 50 } }, comments: { summary: { total_count: 0 } } });
    }
    routes.push([/\/p1\/published_posts/, () => json({ data: posts })]);
    const best = await social.bestPattern(orgId, "facebook", "post");
    expect(best.fromData).toBe(true);
    expect(best.reason).toMatch(/Your last 12 Facebook posts/);
    expect(best.pattern).toEqual({ days: [1, 5], h: 19, mi: 30 });
    expect(best.reason).toMatch(/Mondays and Fridays around 7 PM/);
  });

  it("Sienna plans the next posts for one account from the drafts, approved first, and Schedule all puts them on the calendar", async () => {
    const llm = await import("./_core/llm");
    const spy = vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return { reply: "", action: "schedule_posts", focus: "", topic: "", platforms: ["facebook"], count: 3, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "" } as any;
      if (opts.schemaName === "social_batch") return { posts: [{ headline: "fall check-in", caption: "How is your fall going?", imagePrompt: "a park" }] } as any;
      return {} as any;
    });
    const { orgId, owner } = await makeWorkspace("so-plan");
    const a = await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "pending_approval", title: "Needs approval", body: "x", targetChannels: JSON.stringify(["facebook"]) });
    const b = await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "approved", title: "Approved one", body: "y", targetChannels: JSON.stringify(["facebook", "linkedin"]) });
    await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "approved", title: "LinkedIn only", body: "z", targetChannels: JSON.stringify(["linkedin"]) });
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text: "Schedule the next 3 posts on Facebook" });
    expect(r.reply.content).toMatch(/I suggest Tuesdays and Thursdays at 11:30 AM/);
    expect(r.reply.content).toMatch(/2 of these 3 still need your approval/);
    const card = JSON.parse(r.reply.cards!)[0];
    expect(card.type).toBe("schedule_plan");
    expect(card.plan.rows.map((x: any) => x.itemId).slice(0, 2)).toEqual([b.id, a.id]);
    expect(card.plan.written).toBe(1);
    expect(card.plan.rows[0].time).toBe("11:30 AM");

    const other = await caller(owner).social.schedulePlan({ organizationId: orgId, channel: "facebook", itemIds: card.plan.rows.map((x: any) => x.itemId), patternKey: "tue_thu_1830" });
    expect(other.rows.every((x) => x.time === "6:30 PM")).toBe(true);
    const applied = await caller(owner).social.applyPlan({ organizationId: orgId, rows: other.rows.map((x) => ({ itemId: x.itemId, at: x.at })) });
    expect(applied).toEqual({ scheduled: 1, waiting: 2 });
    expect((await db.getOutboundItemForOrg(b.id, orgId))?.status).toBe("scheduled");
    expect((await db.getOutboundItemForOrg(a.id, orgId))?.scheduledFor).toBeTruthy();
    spy.mockRestore();
  });
});
