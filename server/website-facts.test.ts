import { describe, expect, it, vi } from "vitest";

let facts: any = {};
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, generateJson: vi.fn(async (opts: any) => (opts.schemaName === "website_facts" ? facts : {})) };
});
vi.mock("./employees/siteReader", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    readSite: vi.fn(async (url: string) => ({
      start: "https://legacyfamilyservices.example",
      pages: [
        { url: "https://legacyfamilyservices.example", title: "Legacy Family Services", description: "", headings: [], buttons: ["Book a call"], images: [], forms: 0, text: "Therapy in Oklahoma City.", html: '<a href="https://calendly.example/legacy/consult">Book a call</a>', rendered: false },
        { url: "https://legacyfamilyservices.example/services", title: "Services", description: "", headings: [], buttons: [], images: [], forms: 0, text: "Individual, couples and family therapy.", html: "", rendered: false },
      ],
      links: [{ url: "https://calendly.example/legacy/consult", text: "Book a call" }],
    })),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";

describe("Read my website", () => {
  it("reads the site, says what it found with the page each fact came from, keeps only what the owner ticks, and drops a booking link the site does not have", async () => {
    const { orgId, owner } = await makeWorkspace("site-facts");
    const me = caller(owner);
    await db.updateOrganization(orgId, { description: "Therapy practice" });
    facts = {
      description: { value: "Group therapy practice in Oklahoma City offering individual, couples and family therapy.", source: "https://legacyfamilyservices.example" },
      audience: { value: "Adults, couples and families in central Oklahoma.", source: "https://legacyfamilyservices.example/services" },
      services: { value: "Individual therapy, couples therapy, family therapy", source: "https://legacyfamilyservices.example/services" },
      bookingLink: { value: "https://calendly.example/legacy/consult", source: "https://legacyfamilyservices.example" },
      contact: { value: "(405) 555-0100, hello@legacyfamilyservices.example", source: "https://somewhere-else.example" },
      brandColors: { value: "Green", source: "https://legacyfamilyservices.example" },
      tone: { value: "Warm and personal, speaks to the reader as you.", source: "https://legacyfamilyservices.example" },
      team: { value: "", source: "" },
    };
    const r = await me.knowledge.readWebsite({ organizationId: orgId, url: "legacyfamilyservices.example" });
    expect(r.website).toBe("https://legacyfamilyservices.example");
    expect(r.pages).toHaveLength(2);
    expect(r.found.map((f) => f.key)).toEqual(["description", "audience", "services", "bookingLink", "contact", "tone"]);
    expect(r.found.find((f) => f.key === "description")).toMatchObject({ current: "Therapy practice", where: "Workspace", source: "https://legacyfamilyservices.example" });
    // A source that is not one of the pages read falls back to the site itself; colors without hex codes are not reported.
    expect(r.found.find((f) => f.key === "contact")!.source).toBe("https://legacyfamilyservices.example");
    expect(r.found.some((f) => f.key === "brandColors")).toBe(false);

    // A booking link the site does not link to is dropped.
    facts.bookingLink = { value: "https://calendly.example/not-on-the-site", source: "https://legacyfamilyservices.example" };
    const again = await me.knowledge.readWebsite({ organizationId: orgId, url: "https://legacyfamilyservices.example" });
    expect(again.found.some((f) => f.key === "bookingLink")).toBe(false);

    // Nothing was saved yet.
    expect((await db.getOrganizationById(orgId))!.description).toBe("Therapy practice");
    expect((await db.listKnowledgeByOrg(orgId)).some((k) => k.title === "Booking link")).toBe(false);

    // The owner keeps three of them.
    const saved = await me.knowledge.applyWebsite({ organizationId: orgId, website: r.website, keep: { description: r.found[0].value, bookingLink: "https://calendly.example/legacy/consult", tone: "Warm and personal, speaks to the reader as you." } });
    expect(saved.saved).toBe(3);
    const org = (await db.getOrganizationById(orgId))!;
    expect(org.website).toBe("https://legacyfamilyservices.example");
    expect(org.description).toBe("Group therapy practice in Oklahoma City offering individual, couples and family therapy.");
    expect(org.audience ?? "").toBe("");
    const entries = await db.listKnowledgeByOrg(orgId);
    expect(entries.find((k) => k.title === "Booking link")).toMatchObject({ category: "services_offers", content: "https://calendly.example/legacy/consult" });
    expect(entries.find((k) => k.title === "Voice and tone")).toMatchObject({ category: "voice_tone" });
    expect(entries.some((k) => k.title === "Services and offers")).toBe(false);
    // Reading again shows the booking link as already on file, so a second apply updates rather than duplicates.
    facts.bookingLink = { value: "https://calendly.example/legacy/consult", source: "https://legacyfamilyservices.example" };
    const third = await me.knowledge.readWebsite({ organizationId: orgId, url: r.website });
    expect(third.found.find((f) => f.key === "bookingLink")!.current).toBe("https://calendly.example/legacy/consult");
    await me.knowledge.applyWebsite({ organizationId: orgId, website: r.website, keep: { bookingLink: "https://calendly.example/legacy/book" } });
    expect((await db.listKnowledgeByOrg(orgId)).filter((k) => k.title === "Booking link")).toHaveLength(1);
    expect((await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Booking link")!.content).toBe("https://calendly.example/legacy/book");
  });
});
