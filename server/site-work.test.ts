import { describe, expect, it, vi } from "vitest";

const prompts: { system: string; prompt: string }[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateText: vi.fn(async (opts: any) => {
      prompts.push({ system: opts.system, prompt: opts.prompt });
      if (/You audit a page/.test(opts.system))
        return `# Website audit: Founding member offer
https://example.com/founding · Mon, Oct 5, 2026
_For: cold therapist audience_

## The short version
The page talks to people who already know LeadDash. A therapist who has never heard of it doesn't learn what it replaces.

## Change
- **Hero headline:** Now: "Join the founding members". Change to: "One login for your notes, billing and marketing". Why: it says what it is.
- **Button:** Now: "Join". Change to: "Claim a founding spot". Why: it names the action.

## Add
- **What it replaces:** under the hero, the three tools it replaces.

## Cut
- **Jargon:** "omnichannel". Why: therapists don't use the word.

## Order of the page
- Hero, what it replaces, price, FAQ.

## Images and design
- A real photo of a therapist at a desk.

## Before it goes live
- [THE SEAT LIMIT]`;
      const wrap = (opts.system.match(/ldp-\d+/) ?? ["ldp-0"])[0];
      return `<style>.${wrap}{font-family:Sora}</style><div class="${wrap}"><h1>One login</h1><img src="https://example.com/img/ashley.jpg" alt="Dr. Ashley"><img src="{{graphic:three app windows folding into one}}" alt=""><a href="{{button_url}}">Claim a founding spot</a></div>`;
    }),
  };
});
const images: string[] = [];
vi.mock("./_core/imageGeneration", () => ({ generateImage: vi.fn(async (o: any) => (images.push(o.prompt), { url: "/files/org-1/pages/image_g.png" })) }));

import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { leanHtml, readHtml } from "./employees/siteReader";
import * as sw from "./employees/siteWork";

const PAGE = `<!doctype html><html><head><title>Founding member offer | LeadDash</title><meta name="description" content="Be one of the first.">
<script>track()</script><style>.x{color:red}</style></head><body>
<header><nav><a href="/">Home</a><a href="/founding">Founding members</a><a href="/login">Log in</a></nav></header>
<section><h1>Join the founding members</h1><p>$299 for your first year. Omnichannel tools.</p>
<a class="btn btn-primary" href="/checkout">Join</a><img src="/img/ashley.jpg" alt="Dr. Ashley"><img src="data:image/png;base64,${"A".repeat(200)}"><img src="/px.gif?tracking=1">
<div style="background-image:url('/img/hero.jpg')"></div><form><input name="email"></form></section></body></html>`;

async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 150 && !fn(); i++) await new Promise((r) => setTimeout(r, 30));
}

describe("Jordan reads, audits and mocks up the owner's website", () => {
  it("reads a page's real HTML: words, headings, buttons, images and links", () => {
    const { page, links } = readHtml(PAGE, "https://example.com/founding");
    expect(page.title).toBe("Founding member offer | LeadDash");
    expect(page.description).toBe("Be one of the first.");
    expect(page.headings).toEqual(["H1: Join the founding members"]);
    expect(page.buttons).toEqual(["Join"]);
    expect(page.images).toEqual([
      { src: "https://example.com/img/ashley.jpg", alt: "Dr. Ashley" },
      { src: "https://example.com/img/hero.jpg", alt: "(background image)" },
    ]);
    expect(page.forms).toBe(1);
    expect(page.text).toContain("$299 for your first year.");
    expect(links.map((l) => l.url)).toContain("https://example.com/login");
    expect(page.html).not.toContain("track()");
    expect(leanHtml(PAGE)).toContain("data:...");
  });

  it("writes the audit from an attached HTML file as a document that opens in the chat, then mocks the page up with the audit's changes", async () => {
    const { orgId } = await makeWorkspace("site-work");
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    const html = [{ name: "founding.html", html: sw.keepHtml(PAGE) }];
    expect(sw.htmlFiles([{ name: "founding.html", text: "<p>x</p>", mime: "text/html" }, { name: "notes.pdf", text: "x", mime: "application/pdf" }])).toHaveLength(1);

    const said = "Complete a full website audit of the 299 dollar founding member offer page for a cold therapist audience";
    const r = await sw.writeSiteAudit(jordan, { url: "https://example.com/founding", about: "299 dollar founding member offer page", audience: "a cold therapist audience", said, html });
    expect(prompts[0].prompt).toContain("H1: Join the founding members");
    expect(prompts[0].prompt).toContain("https://example.com/img/ashley.jpg");
    expect(prompts[0].prompt).toMatch(/Today's date: \w{3}, \w{3} \d{1,2}, 20\d\d/);
    expect(r.file.name).toBe("Founding member offer - website audit.docx");
    expect(r.file.size).toBeGreaterThan(1000);
    const msg = (await db.listChatMessages(orgId, jordan.id, 5)).find((m) => m.content.startsWith("The audit of"))!;
    expect(msg.content).toBe('The audit of Founding member offer is ready: 2 things to change, 1 to add and 1 to cut for a cold therapist audience. Press Open to read it here. Say "mock it up" and I\'ll build the new version of the page with these changes, so you can see it before anything goes live.');
    expect(JSON.parse(msg.cards!)[0]).toMatchObject({ type: "doc", id: r.file.id, title: "Website audit: Founding member offer" });
    expect(sw.latestAudit(orgId, jordan.id)?.id).toBe(r.file.id);

    // "Mock it up": the new version is built from her real page and the audit.
    const m = await sw.startSiteMockup(jordan, { url: "https://example.com/founding", about: "Founding member offer", said: "mock it up", notes: "", pageType: "website", html, useAudit: true });
    expect(m.text).toMatch(/^Building the new version of Founding member offer now, with the changes from the audit, using your real words, your 2 images/);
    await waitFor(() => db.getSitePage(m.pageId!, orgId)?.status !== "building");
    const build = prompts.find((p) => /ldp-\d+/.test(p.system))!;
    expect(build.prompt).toContain("Make every change in this audit");
    expect(build.prompt).toContain('Change to: "One login for your notes, billing and marketing"');
    expect(build.prompt).toContain("https://example.com/img/ashley.jpg");
    expect(build.system).toContain("{{graphic:");
    const v = db.listSitePageVersions(m.pageId!, orgId)[0];
    expect(v.html).toMatch(/\/pub\/[a-f0-9]{24}\.png/); // the graphic she made
    expect(v.html).toContain("https://example.com/img/ashley.jpg"); // her own image, as it is
    expect(images[0]).toMatch(/^Flat modern vector illustration for a professional website section: three app windows folding into one\..*No text, letters, numbers or logos/);
    const card = (await db.listChatMessages(orgId, jordan.id, 10)).map((x) => (x.cards ? JSON.parse(x.cards) : [])).flat().find((c: any) => c.type === "page");
    expect(card).toMatchObject({ id: m.pageId, version: 1, title: "Founding member offer (new version)" });
  });

  it("asks for the address when there's no link, no file and no website on file", async () => {
    const { orgId } = await makeWorkspace("site-none");
    await db.updateOrganization(orgId, { website: null } as any);
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    expect(await sw.startSiteAudit(jordan, { url: "", about: "the offer page", audience: "", said: "audit my offer page" })).toMatch(/^What's the address of the page\?/);
  });
});
