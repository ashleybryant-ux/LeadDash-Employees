import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { fn: string; system: string; prompt: string }[] = [];
let searchResponse: any = null;

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async (opts: any) => {
      calls.push({ fn: "searchJson", system: opts.system, prompt: opts.prompt });
      return searchResponse;
    }),
    generateText: vi.fn(async (opts: any) => {
      calls.push({ fn: "generateText", system: opts.system, prompt: opts.prompt });
      return "Drafted section text.";
    }),
    generateJson: vi.fn(async (opts: any) => {
      calls.push({ fn: "generateJson", system: opts.system, prompt: opts.prompt });
      if (opts.schemaName === "email_reply") return { whatTheyWant: "A date", urgency: "today", reply: "Hi, Tuesday works." };
      if (opts.schemaName === "social_post") return { headline: "a headline", caption: "Caption.", xVersion: "", imagePrompt: "a desk" };
      if (opts.schemaName === "page_plan")
        return { page: "Couples", suggestedPath: "/couples", sections: [{ label: "Headline", heading: "Couples counseling", content: "Copy" }], callToAction: "Book a call" };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";

describe("employees do real work", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("Morgan saves only results with a source from the search, scores them, skips duplicates, and records the searches", async () => {
    const { orgId, owner } = await makeWorkspace("grants");
    await db.createKnowledgeItem({ organizationId: orgId, title: "Entity", category: "mission_profile", content: "For-profit LLC in Oklahoma." });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    const item = (o: any) => ({ equity: "", stage: "", eligibility: "", location: "", eventDate: "", audience: "", angle: "", summary: "", fitReason: "", fitCall: "apply", fitScore: 50, deadline: "", amount: "", ...o });
    searchResponse = {
      queries: ["oklahoma behavioral health grant 2027"],
      sources: [{ url: "https://funder.org/grants/a", title: "A" }],
      data: {
        items: [
          item({ title: "Grant A", host: "Funder", deadline: "Jan 15, 2027", amount: "$50,000", eligibility: "OK providers", fitReason: "Fits", sourceUrl: "https://funder.org/grants/a", fitScore: 91 }),
          item({ title: "Grant B", host: "Nowhere", sourceUrl: "" }),
          item({ title: "Grant C", host: "Memory", sourceUrl: "https://never-searched.org/x" }),
        ],
      },
    };
    const first = await caller(owner).opps.find({ organizationId: orgId, employee: "grants" });
    expect(first.added).toBe(1);
    const second = await caller(owner).opps.find({ organizationId: orgId, employee: "grants" });
    expect(second.added).toBe(0);

    const opps = await caller(owner).opps.list({ organizationId: orgId, employee: "grants" });
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ kind: "grant", host: "Funder", fitScore: 91, fitCall: "apply", sourceUrl: "https://funder.org/grants/a" });
    expect(JSON.parse(opps[0].searchQueries!)).toEqual(["oklahoma behavioral health grant 2027"]);

    // Skipping keeps it in the list (the screen shows it on the Skipped tab); Bring back makes it worth applying to again, with the reason kept.
    await caller(owner).opps.skip({ organizationId: orgId, id: opps[0].id });
    expect((await caller(owner).opps.list({ organizationId: orgId, employee: "grants" }))[0].status).toBe("dismissed");
    await db.updateOpp(opps[0].id, orgId, { fitCall: "skip", fitReason: "Too small." });
    const back = await caller(owner).opps.restore({ organizationId: orgId, id: opps[0].id });
    expect(back).toMatchObject({ status: "new", fitCall: "apply", fitScore: 91 });
    await db.updateOpp(opps[0].id, orgId, { fitCall: "skip", fitScore: 15 });
    expect((await caller(owner).opps.restore({ organizationId: orgId, id: opps[0].id })).fitScore).toBe(60); // stays Apply after the restart tidy-up
    expect(back.fitReason).toBe(`${owner.name} brought this back. Too small.`);

    // The Brain is in the instructions, and so is the entity rule.
    expect(calls[0].system).toContain("For-profit LLC in Oklahoma.");
    expect(calls[0].system).toContain("Never use em dashes");
    expect(calls[0].system).toContain("501(c)(3)");

    // Taylor's searches are speaking calls and stay on Taylor's list.
    searchResponse = {
      queries: ["counseling conference call for proposals 2027"],
      sources: [{ url: "https://conf.org/cfp", title: "CFP" }],
      data: { items: [item({ title: "State Conference", host: "Assoc", audience: "Counselors", amount: "Honorarium", angle: "Practice ops", sourceUrl: "https://conf.org/cfp", fitScore: 80 })] },
    };
    await caller(owner).opps.find({ organizationId: orgId, employee: "speaking" });
    const talks = await caller(owner).opps.list({ organizationId: orgId, employee: "speaking" });
    expect(talks.map((t) => t.kind)).toEqual(["speaking"]);
    expect((await caller(owner).opps.list({ organizationId: orgId, employee: "grants" })).map((o) => o.title)).toEqual(["Grant A"]);

    // Taylor is also the publicist: media searches land on Taylor's Media tab, with the publicist job in the instructions.
    calls.length = 0;
    searchResponse = {
      queries: ["therapist burnout journalist request"],
      sources: [{ url: "https://qwoted.com/req/1", title: "Request" }],
      data: { items: [item({ title: "Reporter needs a therapist on burnout", host: "Health desk", audience: "National readers", angle: "Burnout in group practices", sourceUrl: "https://qwoted.com/req/1", fitScore: 82 })] },
    };
    await caller(owner).opps.find({ organizationId: orgId, employee: "speaking", kind: "media" });
    expect(calls[0].system).toContain("You are the publicist");
    expect(calls[0].system).toContain("LeadDash Employees Handbook");
    const taylor = await caller(owner).opps.list({ organizationId: orgId, employee: "speaking" });
    expect(taylor.map((t) => t.kind).sort()).toEqual(["media", "speaking"]);
    vi.unstubAllGlobals();
  });

  it("Avery drafts a reply with urgency, Wren plans a page, Sienna writes a post without an image key", async () => {
    const { orgId, owner } = await makeWorkspace("others");
    const reply = await caller(owner).assistant.draftEmailReply({ organizationId: orgId, subject: "Meeting", recipient: "Jane", context: "Can we meet next week?" });
    expect(JSON.parse(reply.metadata!).urgency).toBe("today");

    const plan = await caller(owner).website.plan({ organizationId: orgId, page: "Couples", goal: "Book a call" });
    expect(JSON.parse(plan.data).sections).toHaveLength(1);

    const post = await caller(owner).social.generatePostAndCreative({ organizationId: orgId, topic: "First year", targetPlatforms: ["linkedin"], tone: "thought_leadership", generateImageFlag: true });
    expect(post.imageUrl).toBeNull();
    expect(JSON.parse(post.metadata!).imageError).toMatch(/OPENAI_API_KEY/);
  });

  it("a paused employee does not work", async () => {
    const { orgId, owner } = await makeWorkspace("paused");
    const avery = await db.getEmployeeByKind(orgId, "inbox");
    await caller(owner).employees.toggleStatus({ organizationId: orgId, id: avery!.id, status: "paused" });
    await expect(
      caller(owner).assistant.draftEmailReply({ organizationId: orgId, subject: "Hi", recipient: "Jane", context: "Hello there" })
    ).rejects.toThrow(/paused/);
  });
});

describe("everything needed is on the row", () => {
  it("leaves out closed, unclear and past-due bids, keeps the contact, and downloads each package", async () => {
    calls.length = 0;
    const { orgId, owner } = await makeWorkspace("bid-details");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const item = (o: any) => ({ equity: "", stage: "", eligibility: "", location: "", eventDate: "", audience: "", angle: "", summary: "", fitReason: "Fits", fitCall: "apply", fitScore: 80, deadline: "Dec 1, 2099", amount: "", status: "open", howToSubmit: "", contact: { name: "", title: "", phone: "", email: "" }, ...o });
    const src = (n: string) => `https://county.gov/bids/${n}`;
    searchResponse = {
      queries: ["oklahoma county counseling rfp"],
      sources: ["open", "closed", "unclear", "past"].map((n) => ({ url: src(n), title: n })),
      data: {
        items: [
          item({ title: "Open bid", host: "County", sourceUrl: src("open"), howToSubmit: "bids@county.gov", contact: { name: "Pat Lee", title: "Buyer", phone: "(405) 555-0100", email: "pat@county.gov" } }),
          item({ title: "Closed bid", host: "County", sourceUrl: src("closed"), status: "closed" }),
          item({ title: "Unclear bid", host: "County", sourceUrl: src("unclear"), status: "unclear", deadline: "" }),
          item({ title: "Past bid", host: "County", sourceUrl: src("past"), deadline: "Sep 5, 2025" }),
        ],
      },
    };
    const r = await caller(owner).opps.find({ organizationId: orgId, employee: "grants", kind: "bid" });
    expect(r.added).toBe(1);
    const [o] = await caller(owner).opps.list({ organizationId: orgId, employee: "grants" });
    expect(o.title).toBe("Open bid");
    const reqs = JSON.parse(o.requirements!);
    expect(reqs.contact).toMatchObject({ name: "Pat Lee", phone: "(405) 555-0100", email: "pat@county.gov" });
    expect(reqs.channelDetail).toBe("bids@county.gov");
    expect(calls[0].system).toContain("Never tell the person to call");
    const { idle } = await import("./employees/apply");
    await idle();
    // The package download ran (the stubbed site fails, so it says so instead of staying blank).
    const after = (await db.getOpp(o.id, orgId))!;
    expect(after.packageStatus).toBe("failed");
    expect(JSON.parse(after.requirements!).contact.email).toBe("pat@county.gov");
  });
});

describe("job titles", () => {
  it("gives existing workspaces the new titles but keeps one the owner typed", async () => {
    const { orgId } = await makeWorkspace("titles");
    const { ensureRoster } = await import("./employees/roster-sync");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    expect(morgan.roleTitle).toBe("Grant Writer");
    await db.updateEmployee(morgan.id, orgId, { roleTitle: "Grants" });
    await db.updateEmployee(taylor.id, orgId, { roleTitle: "Keynote Booker" });
    await ensureRoster(orgId);
    expect((await db.getEmployeeByKind(orgId, "grants"))!.roleTitle).toBe("Grant Writer");
    expect((await db.getEmployeeByKind(orgId, "speaking"))!.roleTitle).toBe("Keynote Booker");
  });
});
