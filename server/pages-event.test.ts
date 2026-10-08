import { afterEach, describe, expect, it, vi } from "vitest";

let decision: any = null;
const pageSystems: string[] = [];
const pagePrompts: string[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? decision : {})),
    generateText: vi.fn(async (opts: any) => {
      pageSystems.push(opts.system);
      pagePrompts.push(opts.prompt);
      const wrap = String(opts.system).match(/\.(ldp-\d+)/)?.[1] ?? "ldp-0";
      return `<style>.${wrap}{color:#000}</style><div class="${wrap}"><h1>Register</h1></div>`;
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as pages from "./employees/pages";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

afterEach(() => vi.restoreAllMocks());

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("Jordan's webinar pages", () => {
  it("finds the page by its name and never edits a different page in its place", () => {
    const list = [{ id: 2, title: "299 dollar founding member offer page (new version)", goal: "Book a demo" }, { id: 5, title: "Couples counseling", goal: "Book a call" }] as any[];
    expect(pages.pageNamed(list, "webinar landing page")).toBeNull();
    expect(pages.pageNamed(list, "founding member page")?.id).toBe(2);
    expect(pages.pageNamed(list, "")?.id).toBe(2);
    expect(pages.isEventPage("Webinar Landing Page, November 10, 2026")).toBe(true);
    expect(pages.isEventPage("Couples counseling", "Book a call")).toBe(false);
  });

  it("builds a webinar page as its own new page, with registration-only rules and the planned outline", async () => {
    const { orgId, owner } = await makeWorkspace("pages-event");
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    const offer = db.createSitePage({ organizationId: orgId, employeeId: jordan.id, title: "299 dollar founding member offer page", pageType: "landing", goal: "Book a demo", status: "ready", progress: null });
    db.updateSitePage(offer.id, orgId, { currentVersion: 1 });
    db.addSitePageVersion({ organizationId: orgId, pageId: offer.id, version: 1, html: `<div class="ldp-${offer.id}">Offer</div>`, note: "First build" });
    await db.createWorkItem({ organizationId: orgId, employeeId: jordan.id, kind: "website_plan", status: "drafted", title: "Webinar Landing Page, November 10, 2026", data: JSON.stringify({ sections: [{ label: "Hero", heading: "How Busy Practice Owners Build a Practice That Works 24/7", content: "Free live training on Nov 10, 2026." }], callToAction: "Save my seat" }) });

    decision = { ...blank, action: "change_page", target: "webinar landing page", focus: "Big headline first", notes: "Big headline first", reply: "On it." };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: jordan.id, text: "Big headline first" });
    expect(r.reply.content).toContain("isn't built yet, so I'm building it now as its own page");

    const built = db.listSitePages(orgId).find((p) => p.title === "webinar landing page")!;
    expect(built).toBeTruthy();
    expect(built.goal).toBe("Register for the event");
    await until(() => db.getSitePage(built.id, orgId)?.status === "ready");
    // The offer page was not touched.
    expect(db.getSitePage(offer.id, orgId)!.currentVersion).toBe(1);
    const system = pageSystems.find((x) => x.includes(`ldp-${built.id}`))!;
    expect(system).toContain("This is an event registration page");
    expect(system).toContain("Leave off: any paid offer, discount, price, plan");
    expect(system).toContain("The brand guide sets the look (colors, fonts, feel) only");
    const prompt = pagePrompts[pageSystems.indexOf(system)];
    expect(prompt).toContain("The outline already planned for this page");
    expect(prompt).toContain("How Busy Practice Owners Build a Practice That Works 24/7");
  });
});
