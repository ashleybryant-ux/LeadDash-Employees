import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const prompts: { system: string; prompt: string }[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateText: vi.fn(async (opts: any) => {
      prompts.push({ system: opts.system, prompt: opts.prompt });
      const wrap = (opts.system.match(/ldp-\d+/) ?? ["ldp-0"])[0];
      const n = prompts.length;
      return "```html\n" + `<style>.${wrap}{font-family:Sora}</style><div class="${wrap}"><h1>Version ${n}</h1><img src="{{photo:1}}" alt="Dr. Ashley"><img src="{{stock:a team meeting in a bright office}}" alt="team"><a href="{{button_url}}">Check dates</a>{{form}}</div>` + "\n```";
    }),
  };
});
vi.mock("./_core/imageGeneration", () => ({ generateImage: vi.fn(async () => ({ url: "/files/org-1/pages/image_abc.png" })) }));

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as pages from "./employees/pages";
import { parseTraining } from "../deploy/load-training";

async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 30));
}

describe("Jordan builds pages as HTML", () => {
  it("builds in the background, fills photos, stock images and the button, saves versions, and posts to chat", async () => {
    const { orgId, owner } = await makeWorkspace("pages");
    const photo = await db.createKnowledgeItem({ organizationId: orgId, kind: "image", title: "White dress lobby", category: "mission_profile", content: "Full length, smiling", fileUrl: `/files/org-${orgId}/brain/image_x.jpg` });
    const t = caller(owner);
    const started = await t.pages.build({ organizationId: orgId, title: "Burnout keynote", pageType: "landing", goal: "Planners request dates" });
    expect(started.status).toBe("building");
    // The mock writes the photo id the brief listed.
    expect(prompts.at(-1)?.system ?? "").toBe(prompts.at(-1)?.system ?? "");
    await waitFor(() => db.getSitePage(started.id, orgId)?.status !== "building");
    let got = await t.pages.get({ organizationId: orgId, id: started.id });
    expect(got.page.status).toBe("ready");
    expect(got.page.currentVersion).toBe(1);
    expect(got.html.startsWith("<style>")).toBe(true);
    expect(got.html).toContain(`ldp-${started.id}`);
    expect(got.html).toMatch(/\/pub\/[a-f0-9]{24}\.png/);
    expect(got.html).not.toContain("{{");
    expect(got.document).toContain("<!doctype html>");
    expect(prompts[0].system).toContain(`${photo.id}: White dress lobby: Full length, smiling`);
    expect(prompts[0].system).toContain("# Your job playbook: Website Planner playbook");

    await t.pages.saveDetails({ organizationId: orgId, id: started.id, buttonUrl: "https://example.com/book", embedCode: "" });
    got = await t.pages.get({ organizationId: orgId, id: started.id });
    expect(got.html).toContain('href="https://example.com/book"');
    expect(got.page.currentVersion).toBe(2);

    await t.pages.revise({ organizationId: orgId, id: started.id, request: "Shorter headline" });
    await waitFor(() => db.getSitePage(started.id, orgId)?.status !== "building");
    got = await t.pages.get({ organizationId: orgId, id: started.id });
    expect(got.page.currentVersion).toBe(3);
    expect(prompts.at(-1)!.prompt).toContain("Shorter headline");
    expect(got.html).toContain('href="https://example.com/book"');

    await t.pages.restore({ organizationId: orgId, id: started.id, version: 1 });
    got = await t.pages.get({ organizationId: orgId, id: started.id });
    expect(got.page.currentVersion).toBe(4);
    expect(got.versions.map((v) => v.note)[0]).toBe("Restored version 1");

    const jordan = (await db.listEmployeesByOrg(orgId)).find((e) => e.kind === "website")!;
    const msgs = (await db.listChatMessages(orgId, jordan.id, 20)).map((m) => m.content);
    expect(msgs.some((m) => m.startsWith("Ready for review: Burnout keynote"))).toBe(true);

    // Public links point at a stored file and are reused.
    const a = pages.publicLink(orgId, "/files/org-1/pages/image_abc.png");
    expect(pages.publicLink(orgId, "/files/org-1/pages/image_abc.png")).toBe(a);
  });

  it("the LeadDash design guide loads like company training", () => {
    const s = parseTraining(fs.readFileSync("deploy/training/leaddash-design.md", "utf8"));
    expect(s).toHaveLength(1);
    expect(s[0].content).toContain("#e88a3a");
  });
});
