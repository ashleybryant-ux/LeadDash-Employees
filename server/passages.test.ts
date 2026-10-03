import { describe, expect, it } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { indexKnowledge } from "./employees/kb";
import { systemPromptAbout } from "./employees/tasks";

describe("books and playbooks: the right passages on every task", () => {
  it("a long book is searched for the passages that fit the task instead of pasted whole", async () => {
    const { orgId } = await makeWorkspace("passages");
    const filler = (word: string) => Array.from({ length: 400 }, (_, i) => `${word} sentence ${i}.`).join(" ");
    const book = [
      "# Chapter 1: Pricing\n" + filler("pricing"),
      "# Chapter 7: Guarantees\nA conditional guarantee removes the buyer's risk when they do the work. Stack bonuses and name the guarantee.\n" + filler("detail"),
      "# Chapter 12: Lead magnets\n" + filler("magnet"),
    ].join("\n\n");
    const item = await db.createKnowledgeItem({ organizationId: orgId, title: "Offers book", category: "services_offers", kind: "document", content: book, pages: 205, pagesUnit: "pages" });
    indexKnowledge(item);
    const sienna = (await db.listEmployeesByOrg(orgId)).find((e) => e.kind === "social")!;

    const { system } = await systemPromptAbout(sienna, "a post about our guarantee", "Your job: write one social post.");
    expect(system).toContain("# From your documents");
    expect(system).toContain("A conditional guarantee removes the buyer's risk");
    // The book itself is only listed in the Brain, not pasted into every task.
    expect(system).toContain("Document on file, 205 pages");
    expect(system).not.toContain("pricing sentence 1.");
  });
});
