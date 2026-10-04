import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as sales from "./employees/sales";
import { findTells } from "./employees/human";

afterEach(() => vi.restoreAllMocks());

const AI_EMAIL = `Hi Matt,

Your team page shows six therapists and an active hiring link, which means your per-clinician software costs are climbing with every new hire.

LeadDash replaces your EHR, billing, fax, phone, texting, telehealth and marketing tools with one platform and one bill. No per-clinician pricing. Built by a licensed therapist who runs her own group practice on it.

Would you have 20 minutes to see how it fits a group your size?`;

describe("emails that sound like the owner, not like AI", () => {
  it("catches what gives a draft away and leaves a plain one alone", () => {
    expect(findTells(AI_EMAIL)).toEqual(expect.arrayContaining(["which means", "a group your size", "a long list of features", "a sentence fragment"]));
    expect(findTells("One thing worth knowing: we include eFax. For a group like yours, that matters.")).toEqual(["One thing worth knowing", "that matters"]);
    expect(findTells("Hi Matt, I noticed your team is hiring and has a solid team of six. Happy to connect.")).toEqual(["I noticed", "happy to connect", "solid team"]);
    expect(findTells("One platform for Oklahoma Counseling Group")).toEqual(["a slogan subject line"]);
    const plain = "Hi Matt,\n\nI saw you're hiring a sixth therapist. We run our own group practice on LeadDash, and the price stays the same when you add a clinician.\n\nWant me to show you how it works? Here's my calendar: https://example.com/book";
    expect(findTells(plain, "your hiring post")).toEqual([]);
  });

  it("gives a draft that still sounds like AI one more pass, and rewrites sequences waiting for approval", async () => {
    const llm = await import("./_core/llm");
    let n = 0;
    const prompts: string[] = [];
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName !== "outreach_sequence") return {} as any;
      prompts.push(opts.prompt);
      n++;
      // Odd calls are first drafts with AI tells; even calls are the fixed pass.
      return (n % 2 === 1
        ? { subject: "One platform for Bayou", email1: "Hi Kevin,\nOne thing worth knowing: it streamlines everything.\nBook: link", email2: "That matters.", email3: "Closing the loop." }
        : { subject: `your hiring post ${n}`, email1: "Hi Kevin,\nI saw you're hiring. Want me to show you how it works?\nBook: link", email2: "Following up on my note.", email3: "Should I close this out for now?" }) as any;
    });
    const { orgId, owner } = await makeWorkspace("human-email");
    await caller(owner).sales.saveSettings({ organizationId: orgId, sells: "software" });
    const p = await db.createProspect({ organizationId: orgId, name: "Bayou Family Therapy", email: "kevin@bayou.example", contactName: "Kevin Tran", fitScore: 86, stage: "new" });
    await caller(owner).sales.startOutreach({ organizationId: orgId, ids: [p.id] });
    for (let i = 0; i < 100 && (await db.listOutboundItemsByOrg(orgId, "outreach_email")).length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    const items = await db.listOutboundItemsByOrg(orgId, "outreach_email");
    expect(items).toHaveLength(3);
    expect(prompts[1]).toContain("read like AI wrote them");
    expect(prompts[1]).toContain("One thing worth knowing");
    expect(items.find((m) => JSON.parse(m.metadata!).step === 1)!.title).toBe("your hiring post 2");

    // "These sound like AI": Jada rewrites everything still waiting, with the owner's note.
    const done = await sales.rewriteWaiting(orgId, "Sound more casual");
    expect(done).toBe(1);
    expect(prompts[2]).toContain("The owner asked for this change: Sound more casual");
    const after = await db.listOutboundItemsByOrg(orgId, "outreach_email");
    expect(after.find((m) => JSON.parse(m.metadata!).step === 1)!.title).toBe("your hiring post 4");
    expect(after.find((m) => JSON.parse(m.metadata!).step === 3)!.body).toBe("Should I close this out for now?");
    expect(after.every((m) => m.status === "pending_approval")).toBe(true);
  });
});
