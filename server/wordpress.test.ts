import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as wp from "./wordpress";

/**
 * Theo on the workspace's own WordPress: saving the site address, username and
 * application password signs in to check them; an approved article goes up as
 * a draft with its banner and meta description; the owner publishes it there.
 */

vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
afterEach(() => vi.restoreAllMocks());

type Call = { url: string; init: RequestInit };

function site(opts: { pretty?: boolean; password?: string } = {}) {
  const calls: Call[] = [];
  const pretty = opts.pretty ?? true;
  vi.spyOn(wp.wpTools, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    url = decodeURIComponent(url);
    if (url.includes("/wp-json") && !pretty) return new Response("<html>Not found</html>", { status: 404 });
    if (url.startsWith("https://img.test/")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    const authOk = String((init.headers as Record<string, string>)?.authorization ?? "") === `Basic ${Buffer.from(`editor:${(opts.password ?? "abcd efgh ijkl mnop").replace(/\s+/g, "")}`).toString("base64")}`;
    if (!authOk) return Response.json({ code: "incorrect_password", message: "The provided password is an invalid application password." }, { status: 401 });
    if (url.includes("users/me")) return Response.json({ id: 3, name: "Dana Whitfield", capabilities: { edit_posts: true } });
    if (url.includes("/wp/v2/media")) return Response.json({ id: 77, source_url: "https://brightpath.test/wp-content/uploads/banner.png" }, { status: 201 });
    if (url.includes("/wp/v2/posts")) return Response.json({ id: 512, status: "draft", link: "https://brightpath.test/?p=512" }, { status: 201 });
    return new Response("", { status: 404 });
  });
  return calls;
}

const save = (owner: Parameters<typeof caller>[0], orgId: number, handle: string, password = "abcd efgh ijkl mnop") =>
  caller(owner).publishing.updateConnection({ organizationId: orgId, provider: "wordpress", accountLabel: "Practice blog", accountHandle: handle, status: "pending", settings: JSON.stringify({ username: "editor", appPassword: password }) });

describe("Theo and WordPress", () => {
  it("reads the site address however it's typed", () => {
    expect(wp.siteOf("brightpath.test")).toBe("https://brightpath.test");
    expect(wp.siteOf("https://brightpath.test/wp-json/wp/v2/")).toBe("https://brightpath.test");
    expect(wp.siteOf("https://brightpath.test/blog/wp-admin/")).toBe("https://brightpath.test/blog");
  });

  it("connects only when the site accepts the application password, over https", async () => {
    const { orgId, owner } = await makeWorkspace("wp-connect");
    site({ password: "right right right right" });
    await expect(save(owner, orgId, "https://brightpath.test", "wrong wrong")).rejects.toThrow(/didn't accept that username and application password/);
    expect((await db.getConnectionByProvider(orgId, "wordpress"))?.status ?? "none").not.toBe("connected");
    await expect(save(owner, orgId, "http://brightpath.test", "right right right right")).rejects.toThrow(/https/);
    const ok = await save(owner, orgId, "https://brightpath.test/wp-json/wp/v2", "right right right right");
    expect(ok?.status).toBe("connected");
    const row = (await db.getConnectionByProvider(orgId, "wordpress"))!;
    expect(row.accountHandle).toBe("brightpath.test");
    expect(JSON.parse(row.settings!)).toMatchObject({ site: "https://brightpath.test", signedInAs: "Dana Whitfield", username: "editor" });
  });

  it("works on a site without pretty permalinks", async () => {
    const { orgId, owner } = await makeWorkspace("wp-plain");
    const calls = site({ pretty: false });
    expect((await save(owner, orgId, "brightpath.test"))?.status).toBe("connected");
    expect(calls.some((c) => c.url.includes("?rest_route=%2Fwp%2Fv2%2Fusers%2Fme"))).toBe(true);
  });

  it("puts an approved article on the site as a draft with its banner and meta description", async () => {
    const { orgId, owner } = await makeWorkspace("wp-post");
    const calls = site();
    await save(owner, orgId, "https://brightpath.test");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const item = (await db.createOutboundItem({
      organizationId: orgId,
      employeeId: theo.id,
      kind: "blog_post",
      status: "pending_approval",
      title: "Sleep and anxiety",
      body: "Sleep matters.\n\n## What helps\n\n- A set bedtime\n- Less caffeine",
      imageUrl: "https://img.test/banner.png",
      metadata: JSON.stringify({ slug: "sleep-and-anxiety", metaDescription: "What actually helps with sleep when anxiety keeps you up, in plain steps you can start tonight.", keyword: "sleep and anxiety" }),
    }))!;
    const done = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: item.id, action: "approve_for_dispatch" });
    expect(done?.status).toBe("published");
    expect(done?.externalReference).toBe("https://brightpath.test/wp-admin/post.php?post=512&action=edit");
    const media = calls.find((c) => c.url === "https://brightpath.test/wp-json/wp/v2/media")!;
    expect(media.init.body).toBeInstanceOf(FormData);
    const post = calls.find((c) => c.url === "https://brightpath.test/wp-json/wp/v2/posts")!;
    const body = JSON.parse(String(post.init.body));
    expect(body).toMatchObject({ title: "Sleep and anxiety", status: "draft", slug: "sleep-and-anxiety", featured_media: 77, excerpt: expect.stringContaining("What actually helps") });
    expect(body.content).toContain("<h2>What helps</h2>");
    expect(body.content).toContain("<li>A set bedtime</li>");
  });

  it("holds the article until WordPress is connected, then sends it on Try again", async () => {
    const { orgId, owner } = await makeWorkspace("wp-wait");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const item = (await db.createOutboundItem({ organizationId: orgId, employeeId: theo.id, kind: "blog_post", status: "pending_approval", title: "Burnout", body: "Rest is work." }))!;
    const held = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: item.id, action: "approve_for_dispatch" });
    expect(held?.status).toBe("blocked_connection");
    site();
    await save(owner, orgId, "https://brightpath.test");
    const sent = await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: item.id, action: "retry" });
    expect(sent?.status).toBe("published");
  });
});
