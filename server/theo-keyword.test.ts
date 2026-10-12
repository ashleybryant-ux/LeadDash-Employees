import { beforeEach, describe, expect, it, vi } from "vitest";

let decision: any = null;
let keywords: any = { fitting: [], suggested: [] };
const calls: { schemaName: string; system: string; prompt: string }[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      calls.push({ schemaName: opts.schemaName, system: opts.system, prompt: opts.prompt });
      if (opts.schemaName === "chat_decision") return decision;
      if (opts.schemaName === "blog_keywords") return keywords;
      if (opts.schemaName === "blog_article")
        return {
          body: "Signs of anxiety in teenagers can look like worry.\n\n## Signs of anxiety in teenagers to watch for\n\nSleep, school and friends.",
          metaDescription: "Learn the signs of anxiety in teenagers, what is normal worry and what is not, and when a first counseling session can help your teen feel more like themselves again.",
        };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as tasks from "./employees/tasks";
import { fitMetaDescription, keywordQuestionChoices, savedSearchTerms } from "./employees/blogKeywords";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

async function withSavedTerms(orgId: number, terms: string) {
  const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
  return (await db.updateEmployee(theo.id, orgId, { onboarding: JSON.stringify({ keywords: terms, reader: "Clients and families" }) }))!;
}

describe("Theo's main keyword", () => {
  beforeEach(() => {
    decision = null;
    keywords = { fitting: [], suggested: [] };
    calls.length = 0;
  });

  it("reads the saved search terms from his onboarding answer", () => {
    expect(savedSearchTerms({ onboarding: JSON.stringify({ keywords: "teen anxiety therapy Denver, family counseling Lakewood\n- couples therapy Denver; Teen anxiety therapy Denver" }) })).toEqual([
      "teen anxiety therapy Denver",
      "family counseling Lakewood",
      "couples therapy Denver",
    ]);
    expect(savedSearchTerms({ onboarding: JSON.stringify({ keywords: ["a, b", "c"] }) })).toEqual(["a", "b", "c"]);
    expect(savedSearchTerms({ onboarding: null })).toEqual([]);
  });

  it("offers up to 3 terms and No keyword, and keeps the meta description to 160 characters", () => {
    expect(keywordQuestionChoices({ saved: ["one", "two"], suggested: ["three"] })).toEqual(["one", "two", "three", "No keyword"]);
    const long = "word ".repeat(60);
    expect(fitMetaDescription(long).length).toBeLessThanOrEqual(160);
  });

  it("asks which search term to rank for, with saved terms that fit and his suggestions", async () => {
    const { orgId, owner } = await makeWorkspace("theo-kw-ask");
    const theo = await withSavedTerms(orgId, "teen anxiety therapy Denver, couples therapy Denver");
    keywords = { fitting: ["Teen anxiety therapy Denver", "made up term"], suggested: ["signs of anxiety in teenagers", "counseling for teens", "teen anxiety help"] };
    decision = { ...blank, action: "write_article", title: "Anxiety in teens", target: "" };
    const write = vi.spyOn(tasks, "writeBlogArticle");

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Write a post about anxiety in teens" });
    expect(r.reply.content).toBe("Which search term should this rank for?");
    expect(JSON.parse(r.reply.cards!)).toEqual([
      expect.objectContaining({ type: "choices", options: ["teen anxiety therapy Denver", "signs of anxiety in teenagers", "counseling for teens", "No keyword"] }),
    ]);
    expect(write).not.toHaveBeenCalled();
    const ask = calls.find((c) => c.schemaName === "blog_keywords")!;
    expect(ask.prompt).toContain("- teen anxiety therapy Denver");
    expect(ask.system).toMatch(/Never state or guess a search volume/);
    // His chat rules say every article has a main keyword.
    expect(calls.find((c) => c.schemaName === "chat_decision")!.system).toMatch(/Every article has a main keyword/);
    write.mockRestore();
  });

  it("writes with the keyword they picked, in the prompt and saved on the article", async () => {
    const { orgId, owner } = await makeWorkspace("theo-kw-write");
    const theo = await withSavedTerms(orgId, "teen anxiety therapy Denver");
    decision = { ...blank, action: "write_article", title: "How to tell if your teen's worry is anxiety", target: "signs of anxiety in teenagers" };
    vi.spyOn(await import("./_core/imageGeneration"), "generateImage").mockResolvedValue({ url: "https://img.test/banner.png" } as any);

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "signs of anxiety in teenagers" });
    expect(r.reply.content).toMatch(/waiting for your approval/);
    const article = calls.find((c) => c.schemaName === "blog_article")!;
    expect(article.prompt).toContain("Main keyword: signs of anxiety in teenagers");
    expect(article.system).toMatch(/The main keyword is "signs of anxiety in teenagers".*title line, in the first paragraph, in one ## heading, and in metaDescription/);
    expect(calls.some((c) => c.schemaName === "blog_keywords")).toBe(false);

    const [item] = await db.listOutboundItemsByOrg(orgId, "blog_post");
    const meta = JSON.parse(item.metadata!);
    expect(meta.keyword).toBe("signs of anxiety in teenagers");
    expect(meta.metaDescription.length).toBeGreaterThanOrEqual(150);
    expect(meta.metaDescription.length).toBeLessThanOrEqual(160);
    expect(item.body).toMatch(/^Signs of anxiety in teenagers/);
  });

  it("\"No keyword\" writes without one", async () => {
    const { orgId, owner } = await makeWorkspace("theo-kw-none");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    decision = { ...blank, action: "write_article", title: "Our new office hours", target: "No keyword" };
    vi.spyOn(await import("./_core/imageGeneration"), "generateImage").mockResolvedValue({ url: "https://img.test/banner.png" } as any);
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "No keyword" });
    const article = calls.find((c) => c.schemaName === "blog_article")!;
    expect(article.prompt).not.toContain("Main keyword");
    const [item] = await db.listOutboundItemsByOrg(orgId, "blog_post");
    expect(JSON.parse(item.metadata!).keyword).toBe("");
  });

  it("the Articles tab route takes the keyword", async () => {
    const { orgId, owner } = await makeWorkspace("theo-kw-route");
    const item = await caller(owner).blog.draftWordPressArticle({ organizationId: orgId, title: "How to tell if your teen's worry is anxiety", keyword: "  signs of anxiety in teenagers ", outlineNotes: "When to get help", generateBannerFlag: false });
    expect(JSON.parse(item!.metadata!).keyword).toBe("signs of anxiety in teenagers");
    expect(calls.find((c) => c.schemaName === "blog_article")!.prompt).toContain("Main keyword: signs of anxiety in teenagers");
  });
});
