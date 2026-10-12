import { describe, expect, it } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { systemPromptFor } from "./employees/tasks";
import { googleQueries } from "./employees/apply";
import { playbookView, settingsOf } from "./employees/cold";
import { INTERVIEWS } from "./employees/interview-defs";
import { ROSTER } from "./employees/roster";

/** What must never reach a customer's employees: LeadDash's founder, her practice, her people and her brands. */
const HERS = /Ashley|Bryant|Legacy Family|Angela|St\. Ville|Bentlee|Caroline|\bBJ\b|Obsidian|SoonerCare|Oklahoma|\bOKC\b|Edmond|P\.U\.L\.S\.E|HealthChoice|\$299|double entry|9:47|green blazer|NABC|SHRM Arkansas|leaddash\.io\/founding/;

describe("A customer workspace carries none of the owner of LeadDash's information", () => {
  it("leaves her people, practice and brands out of every employee's instructions, and keeps them in LeadDash's own workspaces", async () => {
    const { orgId } = await makeWorkspace("no-owner-data");
    await db.updateOrganization(orgId, { state: "Colorado" });
    for (const r of ROSTER) {
      const emp = await db.getEmployeeByKind(orgId, r.kind);
      if (!emp) continue;
      const { system } = await systemPromptFor(emp, "Plan this week.");
      expect(system, `${r.name}'s instructions`).not.toMatch(HERS);
      expect(system).not.toMatch(/LeadDash's own workspaces:/);
    }
    // Reese's three brands and LeadDash angles are only in LeadDash's own workspaces.
    const own = await makeWorkspace("no-owner-data-own");
    await db.updateOrganization(own.orgId, { internal: true });
    const reese = (await db.getEmployeeByKind(own.orgId, "ads"))!;
    expect((await systemPromptFor(reese, "Plan this week.")).system).toMatch(/Legacy Family Services: therapy and couples inquiries/);
    const theirs = (await db.getEmployeeByKind(orgId, "ads"))!;
    expect((await systemPromptFor(theirs, "Plan this week.")).system).toMatch(/If the business runs more than one brand/);
  });

  it("uses made-up examples on every interview question", () => {
    expect(JSON.stringify(INTERVIEWS)).not.toMatch(HERS);
  });

  it("searches neutral categories for customers and LeadDash's own categories only in its own workspaces", () => {
    const theirs = ["pitch", "grant", "accelerator", "bid", "speaking", "media"].flatMap((k) => googleQueries(k as never, "Colorado"));
    expect(theirs.join(" ")).not.toMatch(/health tech|women founders|Black founders|electronic health record|practice management software|workplace wellbeing|HR conference/);
    expect(googleQueries("pitch", "", "", true).join(" ")).toMatch(/women founders/);
  });

  it("gives a customer's outreach playbook no LeadDash objections or battle cards", async () => {
    const { orgId } = await makeWorkspace("no-owner-cold");
    settingsOf(orgId);
    const plays = playbookView(orgId);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.some((p) => p.kind === "battle")).toBe(false);
    expect(JSON.stringify(plays)).not.toMatch(/LeadDash|SimplePractice/);
  });
});
