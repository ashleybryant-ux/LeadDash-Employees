import { describe, expect, it, vi } from "vitest";

const asked: string[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateText: vi.fn(async (opts: any) => {
      asked.push(`${opts.system}\n${opts.prompt}`);
      return "Either way, your call. I can book straight onto your calendar or send you each one to approve first — most owners start with approve-first.";
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as hours from "./workHours";
import * as interview from "./employees/interview";
import { ensureRoster } from "./employees/roster-sync";

const onTeam = async (orgId: number) => (await db.listEmployeesByOrg(orgId)).filter((e) => e.status !== "paused").map((e) => e.kind).sort();

describe("The bench", () => {
  it("starts everyone on the bench, brings one on with a thank-you and the onboarding card, and holds the sixth until onboarding is done", async () => {
    const { orgId, owner } = await makeWorkspace("bench-start");
    const me = caller(owner);
    await me.setup.finish({ organizationId: orgId, bench: true });
    expect(await onTeam(orgId)).toEqual([]);

    let v = await me.bench.view({ organizationId: orgId });
    expect(v.startLimit).toBe(5);
    expect(v.ehrKinds).toEqual([]);
    const avery = v.employees.find((e) => e.kind === "inbox")!;
    expect(avery.onTeam).toBe(false);
    expect(avery.canBringOn).toBe(true);
    expect(avery.bio.pitch[0]).toMatch(/^Hi, I'm Avery\./);
    expect(avery.bio.support.length).toBeGreaterThan(1);

    await me.bench.bringOn({ organizationId: orgId, employeeId: avery.id });
    expect(await onTeam(orgId)).toEqual(["inbox"]);
    const hello = (await db.listChatMessages(orgId, avery.id)).at(-1)!;
    expect(hello.content).toMatch(/^Thank you for bringing me onto the team! Can we start the onboarding\?/);
    expect(JSON.parse(hello.cards!)[0]).toMatchObject({ type: "onboarding" });
    expect(interview.readState((await db.getEmployeeForOrg(avery.id, orgId))!).hiredAt).toBeTruthy();

    for (const kind of ["coo", "projects", "social", "blog"]) {
      const e = v.employees.find((x) => x.kind === kind)!;
      await me.bench.bringOn({ organizationId: orgId, employeeId: e.id });
    }
    expect(await onTeam(orgId)).toHaveLength(5);
    v = await me.bench.view({ organizationId: orgId });
    const jordan = v.employees.find((e) => e.kind === "website")!;
    expect(jordan.canBringOn).toBe(false);
    expect(v.waitingOn).toContain("Avery");
    await expect(me.bench.bringOn({ organizationId: orgId, employeeId: jordan.id })).rejects.toThrow(/Your first 5 are on the team. Finish onboarding with/);
    // The same limit holds on the employee's own Resume button.
    await expect(me.employees.toggleStatus({ organizationId: orgId, id: jordan.id, status: "active" })).rejects.toThrow(/Your first 5/);

    // Once everyone brought on from the bench is onboarded, the next one comes on.
    for (const e of await db.listEmployeesByOrg(orgId)) {
      if (e.status === "paused") continue;
      await db.updateEmployee(e.id, orgId, { interview: JSON.stringify({ ...interview.readState(e), done: true }) });
    }
    await me.bench.bringOn({ organizationId: orgId, employeeId: jordan.id });
    expect(await onTeam(orgId)).toContain("website");

    // Send to bench: off the team, out of huddles, nothing deleted.
    await me.bench.sendToBench({ organizationId: orgId, employeeId: avery.id });
    expect(await onTeam(orgId)).not.toContain("inbox");
    const h = await me.huddle.start({ organizationId: orgId });
    expect(h.kinds).not.toContain("inbox");
    expect(h.kinds).toContain("coo");
    expect((await db.listChatMessages(orgId, avery.id)).length).toBeGreaterThan(0);

    // Back on after onboarding: a short hello, no onboarding card. (Jordan finished onboarding too, so nobody holds the next one up.)
    for (const id of [avery.id, jordan.id]) await db.updateEmployee(id, orgId, { interview: JSON.stringify({ ...interview.readState((await db.getEmployeeForOrg(id, orgId))!), done: true }) });
    await me.bench.bringOn({ organizationId: orgId, employeeId: avery.id });
    const back = (await db.listChatMessages(orgId, avery.id)).at(-1)!;
    expect(back.content).toMatch(/^Thank you for bringing me back onto the team!/);
    expect(back.cards).toBeNull();
  });

  it("uses work hours for every interview answer: the pitch first, then answers in the employee's own words", async () => {
    const { orgId, owner } = await makeWorkspace("bench-interview");
    const me = caller(owner);
    await me.setup.finish({ organizationId: orgId, bench: true });
    const malik = (await db.getEmployeeByKind(orgId, "leads"))!;
    const before = (await hours.balance(orgId)).usedMinutes;

    const open = await me.bench.interview({ organizationId: orgId, employeeId: malik.id });
    expect(open.text).toMatch(/^Hey, I'm Malik\./);
    expect((await hours.balance(orgId)).usedMinutes).toBe(before + hours.JOBS.interview.minutes);

    const r = await me.bench.interview({ organizationId: orgId, employeeId: malik.id, question: "Can you book people on my Google Calendar?", history: [{ me: false, text: open.text }] });
    expect(r.text).toContain("Either way, your call.");
    expect(r.text).not.toMatch(/[–—]/);
    expect(asked.at(-1)).toContain("the owner is interviewing you");
    expect(asked.at(-1)).toContain("Owner: Can you book people on my Google Calendar?");
    expect((await hours.balance(orgId)).usedMinutes).toBe(before + 2 * hours.JOBS.interview.minutes);
    // Interviewing doesn't put anyone on the team.
    expect((await db.getEmployeeForOrg(malik.id, orgId))!.status).toBe("paused");
  });

  it("on the LeadDash EHR start, the three who work with LeadDash EHR start on the team and nobody else can come on until there is a plan", async () => {
    const { orgId, owner } = await makeWorkspace("bench-ehr");
    const me = caller(owner);
    await db.updateOrganization(orgId, { orgType: "healthcare", ehrLocationId: "loc-bench" });
    await ensureRoster(orgId);
    await me.setup.finish({ organizationId: orgId, bench: true });
    expect(await onTeam(orgId)).toEqual(["billing", "compliance", "leads"]);

    const v = await me.bench.view({ organizationId: orgId });
    expect(v.ehrStart).toBe(true);
    expect(v.startLimit).toBeNull();
    expect(v.ehrKinds).toEqual(["leads", "billing", "compliance"]);
    const avery = v.employees.find((e) => e.kind === "inbox")!;
    expect(avery.canBringOn).toBe(false);
    await expect(me.bench.bringOn({ organizationId: orgId, employeeId: avery.id })).rejects.toThrow(/Avery isn't in your plan yet/);

    // A work-hours plan opens the full team.
    await db.updateOrganization(orgId, { workHours: JSON.stringify({ plan: "practice_growth" }) });
    await me.bench.bringOn({ organizationId: orgId, employeeId: avery.id });
    expect(await onTeam(orgId)).toContain("inbox");
  });
});
