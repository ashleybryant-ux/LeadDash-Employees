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
      if (opts.schemaName === "speaker_pitch") return { subject: "Session proposal", body: "Hello committee." };
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

  it("Morgan saves only grants with a source from the search, skips duplicates, and records the searches", async () => {
    const { orgId, owner } = await makeWorkspace("grants");
    await db.createKnowledgeItem({ organizationId: orgId, title: "Entity", category: "mission_profile", content: "For-profit LLC in Oklahoma." });

    searchResponse = {
      queries: ["oklahoma behavioral health grant 2027"],
      sources: [{ url: "https://funder.org/grants/a", title: "A" }],
      data: {
        opportunities: [
          { title: "Grant A", funder: "Funder", deadline: "Jan 15, 2027", amount: "$50,000", eligibility: "OK providers", fitReason: "Fits", sourceUrl: "https://funder.org/grants/a", matchScore: 91 },
          { title: "Grant B", funder: "Nowhere", deadline: "", amount: "", eligibility: "", fitReason: "", sourceUrl: "", matchScore: 50 },
          { title: "Grant C", funder: "Memory", deadline: "", amount: "", eligibility: "", fitReason: "", sourceUrl: "https://never-searched.org/x", matchScore: 50 },
        ],
      },
    };
    const first = await caller(owner).grants.scoutOpportunities({ organizationId: orgId });
    expect(first.added).toBe(1);
    const second = await caller(owner).grants.scoutOpportunities({ organizationId: orgId });
    expect(second.added).toBe(0);

    const opps = await caller(owner).grants.listOpportunities({ organizationId: orgId });
    expect(opps).toHaveLength(1);
    expect(opps[0].sourceUrl).toBe("https://funder.org/grants/a");
    expect(JSON.parse(opps[0].searchQueries!)).toEqual(["oklahoma behavioral health grant 2027"]);

    // The Brain is in the instructions.
    expect(calls[0].system).toContain("For-profit LLC in Oklahoma.");
    expect(calls[0].system).toContain("Never use em dashes");

    // Start a proposal and draft a section.
    const proposal = await caller(owner).grants.startProposal({ organizationId: orgId, opportunityId: opps[0].id });
    expect(proposal.status).toBe("drafting");
    const again = await caller(owner).grants.startProposal({ organizationId: orgId, opportunityId: opps[0].id });
    expect(again.id).toBe(proposal.id);
    const drafted = await caller(owner).grants.generateSection({ organizationId: orgId, proposalId: proposal.id, sectionKey: "executiveSummary" });
    expect(drafted.content).toBe("Drafted section text.");
    expect(calls.at(-1)!.prompt).toContain("Grant A");

    const morgan = await db.getEmployeeByKind(orgId, "grants");
    expect(morgan?.tasksCompleted).toBe(3);
    expect(morgan?.status).toBe("active");
  });

  it("Des finds events, writes a pitch, and sends it to approval", async () => {
    const { orgId, owner } = await makeWorkspace("speaking");
    searchResponse = {
      queries: ["counseling conference call for proposals 2027"],
      sources: [{ url: "https://conf.org/cfp", title: "CFP" }],
      data: { events: [{ event: "State Conference", organizer: "Assoc", audience: "Counselors", deadline: "Nov 14, 2026", pays: "Honorarium", location: "OKC", angle: "Practice ops", sourceUrl: "https://conf.org/cfp" }] },
    };
    const found = await caller(owner).speaking.find({ organizationId: orgId });
    expect(found.added).toBe(1);
    const [event] = await caller(owner).speaking.list({ organizationId: orgId });
    const pitched = await caller(owner).speaking.writePitch({ organizationId: orgId, id: event.id });
    expect(JSON.parse(pitched!.data).pitch.subject).toBe("Session proposal");
    const queued = await caller(owner).speaking.sendToApproval({ organizationId: orgId, id: event.id });
    expect(queued.kind).toBe("speaking_pitch");
    expect(queued.status).toBe("pending_approval");
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
