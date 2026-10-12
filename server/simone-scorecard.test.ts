import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

let decision: any = null;
let proposed: any = { measures: [] };
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return decision;
      if (opts.schemaName === "scorecard_measures") return proposed;
      return {};
    }),
  };
});

import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as goals from "./work/goals";
import * as sc from "./work/simoneScorecard";
import { askForNumbers } from "./work/simone";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [], count: 0 };

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  const priya = await makeUser(`priya@${slug}.test`, "user", "Priya Shah");
  await db.addOrganizationMember({ organizationId: ws.orgId, userId: priya.id, role: "member" });
  const goal = goals.saveGoal(ws.orgId, { title: "40 new clients", description: "", level: "year", parentId: null, folderId: null, ownerType: "user", ownerId: ws.owner.id, startDate: "2026-01-01", dueDate: "2026-12-31", period: "2026", color: "#1b6b4a", status: null, manualProgress: null, targets: [{ kind: "number", name: "New clients", startValue: 0, currentValue: 12, targetValue: 40, done: false, listId: null, measureId: null }] }, ws.owner.name!);
  const simone = (await db.getEmployeeByKind(ws.orgId, "coo"))!;
  const malik = (await db.getEmployeeByKind(ws.orgId, "leads"))!;
  const say = async (text: string, d: any) => {
    decision = { ...blank, ...d };
    return (await caller(ws.owner).chat.send({ organizationId: ws.orgId, employeeId: simone.id, text })).reply;
  };
  return { ...ws, priya, goal, simone, malik, say };
}

const choicesOf = (reply: { cards: string | null }) => (JSON.parse(reply.cards || "[]") as any[]).find((c) => c.type === "choices")?.options ?? [];

describe("Simone keeps the Goals page scorecard", () => {
  beforeEach(() => {
    decision = null;
    proposed = { measures: [] };
  });

  it("builds the scorecard from the goals: linked measures, counted owners, and asks who gives the typed-in number", async () => {
    const { orgId, goal, malik, priya, say, owner } = await setup("sc-build");
    proposed = {
      measures: [
        { goalId: goal.id, name: "New inquiries", source: "new_leads", weeklyGoal: 12, kind: "leading", unit: "number", direction: "up" },
        { goalId: goal.id, name: "Consults booked", source: "demos_booked", weeklyGoal: 6, kind: "leading", unit: "number", direction: "up" },
        { goalId: goal.id, name: "Intakes completed", source: "manual", weeklyGoal: 4, kind: "result", unit: "number", direction: "up" },
        { goalId: 999999, name: "Another workspace's goal", source: "manual", weeklyGoal: 1, kind: "result", unit: "number", direction: "up" },
      ],
    };
    const r = await say("Build my scorecard from my goals", { action: "build_scorecard" });
    expect(r.content).toMatch(/^For "40 new clients by Dec 31, 2026" I added three measures to your Goals scorecard: New inquiries \(counted from Malik's leads\), Consults booked \(counted from Malik's bookings\) and Intakes completed\./);
    expect(r.content).toMatch(/Intakes completed isn't counted anywhere in the app yet\. Who should give me that number each Friday\?/);
    expect(choicesOf(r)).toEqual(["Me", "Priya", "Skip that one"]);
    const ms = db.work.measures.all(orgId).filter((m) => m.active);
    expect(ms.map((m) => [m.name, m.source, m.goalId, m.weeklyGoal, m.ownerType, m.ownerId])).toEqual([
      ["New inquiries", "new_leads", goal.id, 12, "employee", malik.id],
      ["Consults booked", "demos_booked", goal.id, 6, "employee", malik.id],
      ["Intakes completed", "manual", goal.id, 4, null, null],
    ]);
    // The Goals page shows them.
    const o = await caller(owner).goals.overview({ organizationId: orgId });
    expect(o.scorecard.rows.map((x) => [x.measure.name, x.owner?.name ?? null, x.goal])).toEqual([["New inquiries", "Malik", "40 new clients"], ["Consults booked", "Malik", "40 new clients"], ["Intakes completed", null, "40 new clients"]]);

    // The owner taps Priya.
    const done = await say("Priya", { action: "set_measure_owner", target: "Intakes completed", to: "Priya" });
    expect(done.content).toBe("Done. Priya owns Intakes completed, and I'll ask for it each Friday. It's on your Goals page, Scorecard.");
    expect(db.work.measures.all(orgId).find((m) => m.name === "Intakes completed")).toMatchObject({ ownerType: "user", ownerId: priya.id });

    // Building again skips what's already there.
    const again = await say("Build my scorecard", { action: "build_scorecard" });
    expect(again.content).toMatch(/already has the measures/);
    expect(db.work.measures.all(orgId).filter((m) => m.active)).toHaveLength(3);
  });

  it("with no goals, asks what they want to reach and offers to draft them", async () => {
    const { orgId } = await makeWorkspace("sc-empty");
    const r = await sc.buildScorecard(orgId);
    expect(r.text).toMatch(/no goals on your Goals page yet.*What do you want to reach in \d{4}\?/);
    expect(r.choices[0]).toMatch(/^Draft my \d{4} goals$/);
    expect(db.work.measures.all(orgId)).toHaveLength(0);
  });

  it("sets a measure's weekly goal on the Goals page, records a typed-in number, and offers to add what it doesn't track", async () => {
    const { orgId, owner, goal, say } = await setup("sc-goal");
    await caller(owner).goals.saveScorecard({ organizationId: orgId, rows: [
      { name: "Consults booked", ownerType: null, ownerId: null, weeklyGoal: 4, unit: "number", direction: "up", kind: "leading", source: "demos_booked", goalId: goal.id },
      { name: "Intakes completed", ownerType: null, ownerId: null, weeklyGoal: 4, unit: "number", direction: "up", kind: "result", source: "manual", goalId: goal.id },
    ] });
    const r = await say("Set the weekly goal for consults to 6", { action: "set_goal", target: "consults", count: 6 });
    expect(r.content).toBe("The weekly goal for Consults booked is now 6. It's on your Goals page, Scorecard.");
    expect(db.work.measures.all(orgId).find((m) => m.name === "Consults booked")!.weeklyGoal).toBe(6);
    // The old fixed scorecard isn't touched.
    expect(JSON.parse((await db.getOrganizationById(orgId))!.ops || "{}").goals ?? {}).toEqual({});

    const n = await say("Intakes were 3 this week", { action: "record_number", target: "intakes", notes: "3" });
    expect(n.content).toMatch(/^Saved Intakes completed: 3 for the week of .+, under the goal of 4\.$/);
    const o = await caller(owner).goals.overview({ organizationId: orgId });
    expect(o.scorecard.rows.find((x) => x.measure.name === "Intakes completed")).toMatchObject({ value: 3, status: "off" });

    const miss = await say("Set the weekly goal for referrals to 5", { action: "set_goal", target: "referrals", count: 5 });
    expect(miss.content).toBe("I don't track that yet. Want me to add it?");
    expect(choicesOf(miss)).toEqual(["Add referrals", "No thanks"]);
  });

  it("adds, changes and removes measures from chat", async () => {
    const { orgId, goal, priya, say } = await setup("sc-edit");
    const a = await say("Add referrals to the scorecard", { action: "add_measure", title: "Referrals", focus: "manual", count: 3, goal: "new clients" });
    expect(a.content).toMatch(/^Added Referrals to your Goals scorecard, typed in each week, with a weekly goal of 3\. It moves "40 new clients"\.\nReferrals isn't counted anywhere/);
    let m = db.work.measures.all(orgId).find((x) => x.name === "Referrals")!;
    expect(m).toMatchObject({ source: "manual", weeklyGoal: 3, goalId: goal.id, ownerType: null });
    const c = await say("Priya owns referrals, goal 5", { action: "change_measure", target: "referrals", count: 5, to: "Priya" });
    expect(c.content).toBe("Done. Referrals: the weekly goal is 5, Priya Shah owns it. It's on your Goals page, Scorecard.");
    m = db.work.measures.get(orgId, m.id)!;
    expect(m).toMatchObject({ weeklyGoal: 5, ownerType: "user", ownerId: priya.id });
    const r = await say("Take referrals off", { action: "remove_measure", target: "referrals" });
    expect(r.content).toBe("I took Referrals off your Goals scorecard.");
    expect(db.work.measures.get(orgId, m.id)!.active).toBe(false);
  });

  it("asks the owners of typed-in measures for this week's number on Friday", async () => {
    const { orgId, priya, goal, owner } = await setup("sc-friday");
    await caller(owner).goals.saveScorecard({ organizationId: orgId, rows: [{ name: "Intakes completed", ownerType: "user", ownerId: priya.id, weeklyGoal: 4, unit: "number", direction: "up", kind: "result", source: "manual", goalId: goal.id }] });
    const { fridayAsk } = await import("./work/simone");
    const tz = await goals.zoneOf(orgId);
    expect(await fridayAsk(orgId, tz)).toBe(1);
    // Once a week.
    expect(await fridayAsk(orgId, tz)).toBe(0);
    // The marker never shows up as Simone's read on the Goals page.
    expect((await caller(owner).goals.overview({ organizationId: orgId })).read).toBeNull();
    expect(await askForNumbers(orgId, goals.sundayOf(goals.todayYmd(tz)), "this")).toBe(1);
  });

  it("Simone's Meetings tab no longer has a scorecard, and the old route is gone", async () => {
    const src = readFileSync(new URL("../client/src/ld/work/Meetings.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/coo\.scorecard|"scorecard"/);
    const { appRouter } = await import("./routers");
    const paths = Object.keys((appRouter as any)._def.procedures);
    expect(paths).toContain("coo.meetings");
    expect(paths).not.toContain("coo.scorecard");
  });
});
