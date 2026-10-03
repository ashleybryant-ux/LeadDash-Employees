import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { loadTraining, parseTraining } from "../deploy/load-training";
import { loadBrain } from "./employees/brain";

describe("company training", () => {
  it("the LeadDash training file parses into Brain sections with real categories", () => {
    const s = parseTraining(fs.readFileSync("deploy/training/leaddash.md", "utf8"));
    expect(s.map((x) => x.title)).toContain("Company training: The products");
    expect(s.every((x) => x.content.length > 100 && x.content.length < 6000)).toBe(true);
    expect(s.some((x) => /—/.test(x.content))).toBe(false);
  });

  it("the Dr. Ashley Bryant personal brand file parses the same way", () => {
    const s = parseTraining(fs.readFileSync("deploy/training/dr-ashley-bryant.md", "utf8"));
    expect(s.map((x) => x.title)).toContain("Company training: Keynotes and workshops");
    expect(s.every((x) => x.content.length > 100 && x.content.length < 6000)).toBe(true);
    expect(s.some((x) => /\u2014/.test(x.content))).toBe(false);
  });

  it("loads into one workspace's Brain, and loading again updates instead of duplicating", async () => {
    const { orgId } = await makeWorkspace("training");
    const text = fs.readFileSync("deploy/training/leaddash.md", "utf8");
    const first = await loadTraining(orgId, text);
    expect(first.created).toBe(8);
    const again = await loadTraining(orgId, text);
    expect(again).toMatchObject({ created: 0, updated: 8 });
    expect((await db.listKnowledgeByOrg(orgId)).filter((k) => k.title.startsWith("Company training:"))).toHaveLength(8);
    const brain = await loadBrain(orgId);
    expect(brain.text).toContain("Never call it an \"AI receptionist\"");
  });
});
