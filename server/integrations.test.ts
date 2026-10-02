import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];

function json(body: any, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  calls = [];
  routes = [];
  process.env.GOOGLE_CLIENT_ID = "g-id";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  process.env.LINKEDIN_CLIENT_ID = "li-id";
  process.env.LINKEDIN_CLIENT_SECRET = "li-secret";
  process.env.META_APP_ID = "m-id";
  process.env.META_APP_SECRET = "m-secret";
  process.env.X_CLIENT_ID = "x-id";
  process.env.X_CLIENT_SECRET = "x-secret";
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return json({ error: "no route " + url }, 500);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("one-click connections", () => {
  it("builds the sign-in links each company expects, with PKCE for X", () => {
    const g = new URL(integrations.authorizeUrl("google", "st"));
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("scope")).toContain("gmail.send");
    expect(g.searchParams.get("scope")).not.toContain("gmail.readonly");
    expect(g.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/google\/callback$/);
    const x = new URL(integrations.authorizeUrl("x", "st", "verifier-verifier-verifier-verifier-verifier"));
    expect(x.searchParams.get("code_challenge_method")).toBe("S256");
    expect(x.searchParams.get("scope")).toContain("offline.access");
    expect(new URL(integrations.authorizeUrl("meta", "st")).searchParams.get("scope")).toContain("pages_manage_posts");
    expect(integrations.readyApps().linkedin).toBe(true);
  });

  it("connects LinkedIn, then Post on approval publishes and records the link; a second try never posts twice", async () => {
    const { orgId, owner } = await makeWorkspace("int-li");
    routes.push([/linkedin\.com\/oauth\/v2\/accessToken/, () => json({ access_token: "li-token", expires_in: 5184000 })]);
    routes.push([/api\.linkedin\.com\/v2\/userinfo/, () => json({ sub: "abc123", name: "Ashley Bryant", email: "a@b.com" })]);
    expect(await integrations.finishConnect(orgId, "linkedin", "code")).toBe("Ashley Bryant");
    const conn = await db.getConnectionByProvider(orgId, "linkedin");
    expect(conn?.status).toBe("connected");
    expect(conn?.secretsEncrypted).not.toContain("li-token"); // encrypted at rest
    const pub = await caller(owner).publishing.listConnections({ organizationId: orgId });
    expect(JSON.stringify(pub)).not.toContain("li-token");

    routes.push([/api\.linkedin\.com\/rest\/posts/, () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:999" } })]);
    const post = await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "pending_approval", title: "Intake", body: "We cut the wait to 4 days.", targetChannels: JSON.stringify(["linkedin", "facebook"]) });
    const done = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: post.id, action: "approve_for_dispatch" });
    const sent = calls.find((c) => c.url.includes("/rest/posts"))!;
    expect(sent.init.headers["LinkedIn-Version"]).toMatch(/^\d{6}$/);
    expect(JSON.parse(sent.init.body)).toMatchObject({ author: "urn:li:person:abc123", commentary: "We cut the wait to 4 days.", lifecycleState: "PUBLISHED" });
    // Facebook is not connected, so the item is approved but not fully posted.
    expect(done?.status).toBe("approved");
    const d = JSON.parse(done!.metadata!).dispatch;
    expect(d.find((x: any) => x.channel === "linkedin")).toMatchObject({ ok: true, url: "https://www.linkedin.com/feed/update/urn:li:share:999/" });
    expect(d.find((x: any) => x.channel === "facebook").error).toMatch(/not connected/);

    const before = calls.filter((c) => c.url.includes("/rest/posts")).length;
    await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: post.id, action: "retry" });
    expect(calls.filter((c) => c.url.includes("/rest/posts")).length).toBe(before);
  });

  it("connects Google, sends an approved hiring email from Gmail with a normal subject, and refreshes an expired token", async () => {
    const { orgId, owner } = await makeWorkspace("int-g");
    routes.push([/oauth2\.googleapis\.com\/token/, (_u, init) => json(String(init.body).includes("refresh_token=") && String(init.body).includes("grant_type=refresh_token") ? { access_token: "g-new", expires_in: 3600 } : { access_token: "g-old", refresh_token: "g-refresh", expires_in: -10 })]);
    routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: "ashley@legacy.com", name: "Ashley" })]);
    routes.push([/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => json({ id: "m1", threadId: "t1" })]);
    await integrations.finishConnect(orgId, "google", "code");
    const item = await db.createOutboundItem({ organizationId: orgId, kind: "hiring_email", status: "pending_approval", title: "Interview invite: Outpatient therapist", body: "Hi Jordan,\nWould Tuesday work?", metadata: JSON.stringify({ email: "jordan@example.com", purpose: "interview" }) });
    const done = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: item.id, action: "approve_for_dispatch" });
    expect(done?.status).toBe("published");
    const send = calls.find((c) => c.url.includes("messages/send"))!;
    expect(send.init.headers.authorization).toBe("Bearer g-new"); // refreshed first
    const raw = Buffer.from(JSON.parse(send.init.body).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: jordan@example.com");
    expect(raw).toContain("Subject: Interview for Outpatient therapist at Workspace int-g");
    expect(raw).toContain("Would Tuesday work?");
  });

  it("Facebook with several Pages waits for a Page choice, then posts to the Page and its Instagram", async () => {
    const { orgId, owner } = await makeWorkspace("int-m");
    routes.push([/oauth\/access_token/, () => json({ access_token: "fb-user", expires_in: 5000000 })]);
    routes.push([/\/me\?fields=id,name/, () => json({ id: "1", name: "Ashley Bryant" })]);
    routes.push([/\/me\/accounts/, () => json({ data: [{ id: "p1", name: "Legacy Family Services", access_token: "page-1", instagram_business_account: { id: "ig1", username: "legacyfamilyokc" } }, { id: "p2", name: "LeadDash", access_token: "page-2" }] })]);
    await integrations.finishConnect(orgId, "meta", "code");
    expect((await db.getConnectionByProvider(orgId, "facebook"))?.status).toBe("pending");
    expect((await integrations.channelState(orgId)).facebook).toBe(false);
    await caller(owner).publishing.choosePage({ organizationId: orgId, pageId: "p1" });
    const state = await integrations.channelState(orgId);
    expect(state.facebook && state.instagram).toBe(true);

    routes.push([/\/p1\/feed/, () => json({ id: "p1_55" })]);
    const post = await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "pending_approval", title: "Open house", body: "Join us.", targetChannels: JSON.stringify(["facebook", "instagram"]) });
    // Instagram needs an image, so approval stops and says so before anything posts.
    await expect(caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: post.id, action: "approve_for_dispatch" })).rejects.toThrow(/Instagram posts need an image/);
    expect(calls.some((c) => c.url.includes("/p1/feed"))).toBe(false);
    await db.updateOutboundItem(post.id, orgId, { targetChannels: JSON.stringify(["facebook"]) });
    const done = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: post.id, action: "approve_for_dispatch" });
    const feed = calls.find((c) => c.url.includes("/p1/feed"))!;
    expect(feed.init.headers.authorization).toBe("Bearer page-1");
    const d = JSON.parse(done!.metadata!).dispatch;
    expect(d.find((x: any) => x.channel === "facebook").ok).toBe(true);
    expect(done?.status).toBe("published");

    await caller(owner).publishing.disconnect({ organizationId: orgId, provider: "facebook" });
    expect((await db.getConnectionByProvider(orgId, "facebook"))?.secretsEncrypted).toBeNull();
  });

  it("holds an approved item when nothing it needs is connected, and reviewers cannot connect or disconnect", async () => {
    const { orgId, owner, reviewer } = await makeWorkspace("int-hold");
    const post = await db.createOutboundItem({ organizationId: orgId, kind: "social_post", status: "pending_approval", title: "Hold", body: "x", targetChannels: JSON.stringify(["x"]) });
    const done = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: post.id, action: "approve_for_dispatch" });
    expect(done?.status).toBe("blocked_connection");
    expect(calls.length).toBe(0);
    await expect(caller(reviewer).publishing.disconnect({ organizationId: orgId, provider: "x" })).rejects.toThrow();
    expect(integrations.toLocalDateTime("10/05/2026", "2:30 PM")).toBe("2026-10-05T14:30:00");
  });
});

describe("Avery writes new emails and holds from chat", () => {
  it("turns 'send an email to x and ask for a meeting today at 3pm' into a Gmail-ready draft", async () => {
    const llm = await import("./_core/llm");
    const spy = vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision")
        return { reply: "", action: "write_email", focus: "", topic: "", platforms: [], title: "", notes: "", page: "", goal: "", from: "Ashley", subject: "", message: "Ask for a meeting Friday, October 2, 2026 at 3:00 PM.", url: "", oppKind: "", target: "", to: "ashley@legacyfs.org", date: "", time: "", attendees: "" } as any;
      if (opts.schemaName === "new_email") return { subject: "Meeting today at 3:00 PM", body: "Hi Ashley,\nCould we meet today at 3:00 PM?" } as any;
      return {} as any;
    });
    const { orgId, owner } = await makeWorkspace("int-avery");
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "send an email to ashley@legacyfs.org and ask for a meeting today at 3pm" });
    expect(r.reply.content).toContain("ashley@legacyfs.org");
    const q = await caller(owner).publishing.listApprovalQueue({ organizationId: orgId, kind: "email_draft" });
    expect(q[0].title).toBe("Meeting today at 3:00 PM");
    expect(JSON.parse(q[0].metadata!).email).toBe("ashley@legacyfs.org");
    spy.mockRestore();
  });
});
