import { describe, expect, it, vi } from "vitest";

const prompts: Record<string, string[]> = {};
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      (prompts[opts.schemaName] ??= []).push(`${opts.system}\n${opts.prompt}`);
      if (opts.schemaName === "work_plan") {
        return {
          answers: [
            { key: "goal", value: "", values: ["Conferences", "Podcasts", "Not an option"], guess: false },
            { key: "success90", value: "Three paid talks booked and two podcast interviews recorded.", values: [], guess: true },
            { key: "first", value: "Spring conferences taking speaker proposals.", values: [], guess: false },
            { key: "made-up", value: "ignored", values: [], guess: false },
          ],
        };
      }
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as setup from "./employees/setup";
import * as interview from "./employees/interview";
import { guidelinesText } from "./employees/interview";

describe("Set up your team", () => {
  it("opens once for a fresh workspace, saves the business to the Brain, starts three, and leaves a first job in each chat", async () => {
    const { orgId, owner } = await makeWorkspace("team-setup");
    const me = caller(owner);
    await db.updateOrganization(orgId, { orgType: "healthcare" });
    let v = await me.setup.get({ organizationId: orgId });
    expect(v.done).toBe(false);
    expect(v.inUse).toBe(false);
    expect(v.team.filter((e) => e.suggested).map((e) => e.kind).sort()).toEqual(["inbox", "leads", "projects"]);
    expect(v.team.find((e) => e.kind === "leads")!.firstJob).toMatch(/reply new leads get within five minutes/);

    v = await me.setup.saveBusiness({ organizationId: orgId, website: "legacyfamilyservices.example", description: "Group therapy practice in Oklahoma City.", audience: "Adults, couples and families.", bookingLink: "https://calendly.example/legacy", brandColors: "Green #1b6b4a", tone: "Warm and personal" });
    expect(v.business).toMatchObject({ website: "legacyfamilyservices.example", description: "Group therapy practice in Oklahoma City.", bookingLink: "https://calendly.example/legacy", tone: "Warm and personal" });
    const entries = await db.listKnowledgeByOrg(orgId);
    expect(entries.find((e) => e.title === "Booking link")!.content).toBe("https://calendly.example/legacy");
    expect(entries.find((e) => e.title === "Voice and tone")!.category).toBe("voice_tone");

    const picks = v.team.filter((e) => e.suggested).map((e) => e.id);
    v = await me.setup.pickTeam({ organizationId: orgId, employeeIds: picks });
    expect(v.team.filter((e) => e.status !== "paused").map((e) => e.id).sort()).toEqual([...picks].sort());
    expect(v.team.filter((e) => e.status === "paused").length).toBe(v.team.length - 3);

    v = await me.setup.finish({ organizationId: orgId });
    expect(v.done).toBe(true);
    const malik = (await db.getEmployeeByKind(orgId, "leads"))!;
    const msgs = await db.listChatMessages(orgId, malik.id);
    const hello = msgs.find((m) => /My first job/.test(m.content))!;
    expect(hello.content).toContain("Hi Owner.");
    expect(setup.FIRST_JOBS.leads.ask).toMatch(/five minutes/);
    expect(JSON.parse(hello.cards!)[0]).toMatchObject({ type: "choices", options: ["Write the reply new leads get within five minutes, in my voice, for me to approve."] });
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    expect((await db.listChatMessages(orgId, simone.id)).some((m) => /My first job/.test(m.content))).toBe(false);
    // Finishing again never posts the job twice.
    await me.setup.finish({ organizationId: orgId });
    expect((await db.listChatMessages(orgId, malik.id)).filter((m) => /My first job/.test(m.content))).toHaveLength(1);
    expect((await db.getOrganizationById(orgId))!.setupAt).toBeTruthy();
  });

  it("drafts how an employee will work from the Brain, marks guesses, and Looks right finishes onboarding with the owner's changes and a first assignment", async () => {
    const { orgId, owner } = await makeWorkspace("work-plan");
    const me = caller(owner);
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    let v = await me.onboarding.draftPlan({ organizationId: orgId, employeeId: taylor.id });
    expect(prompts.work_plan[0]).toContain("filling in your own onboarding");
    expect(prompts.work_plan[0]).toMatch(/- goal \(multi\)/);
    const rows = v.plan!.rows;
    expect(rows.map((r) => r.key)).toEqual(["goal", "success90", "first"]);
    expect(rows.find((r) => r.key === "goal")).toMatchObject({ value: ["Conferences", "Podcasts"], guess: false, section: "The job" });
    expect(rows.find((r) => r.key === "success90")!.guess).toBe(true);
    expect(v.state.done).toBe(false);

    v = await me.onboarding.acceptPlan({ organizationId: orgId, employeeId: taylor.id, changes: { success90: "Two paid talks booked.", goal: ["Podcasts"] } });
    expect(v.state.done).toBe(true);
    expect(v.answers).toMatchObject({ goal: ["Podcasts"], success90: "Two paid talks booked.", first: "Spring conferences taking speaker proposals." });
    const fresh = (await db.getEmployeeForOrg(taylor.id, orgId))!;
    expect(guidelinesText(fresh)).toContain("Success in 90 days: Two paid talks booked.");
    expect(guidelinesText(fresh)).toContain("Main goal: Podcasts");
    expect(interview.readState(fresh).plan!.answers.goal).toEqual(["Podcasts"]);
    const tasks = (await db.listScheduledTasks(orgId)).filter((t) => t.employeeId === taylor.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Daily report", repeat: "daily", time: "09:00", enabled: true });
    // Approving again changes the lines without a second assignment.
    await me.onboarding.acceptPlan({ organizationId: orgId, employeeId: taylor.id, changes: { first: "Podcasts for practice owners." } });
    expect(guidelinesText((await db.getEmployeeForOrg(taylor.id, orgId))!)).toContain("Start with: Podcasts for practice owners.");
    expect((await db.listScheduledTasks(orgId)).filter((t) => t.employeeId === taylor.id)).toHaveLength(1);
  });
});
