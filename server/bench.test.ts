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
import * as bench from "./employees/bench";
import * as runner from "./employees/runner";

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

    // Terminate: off the team, out of huddles, nothing deleted, rehirable in 90 days.
    await me.bench.terminate({ organizationId: orgId, employeeId: avery.id, reason: "Not a fit" });
    expect(await onTeam(orgId)).not.toContain("inbox");
    const h = await me.huddle.start({ organizationId: orgId });
    expect(h.kinds).not.toContain("inbox");
    expect(h.kinds).toContain("coo");
    expect((await db.listChatMessages(orgId, avery.id)).length).toBeGreaterThan(0);
    let card = (await me.bench.view({ organizationId: orgId })).employees.find((e) => e.kind === "inbox")!;
    expect(card.away).toMatchObject({ kind: "terminated", reason: "Not a fit", canReturn: false });
    expect(card.canBringOn).toBe(false);
    await expect(me.bench.bringOn({ organizationId: orgId, employeeId: avery.id })).rejects.toThrow(/Avery will be rehirable on [A-Z][a-z]{2} \d{1,2}, \d{4}\./);
    await expect(me.employees.toggleStatus({ organizationId: orgId, id: avery.id, status: "active" })).rejects.toThrow(/rehirable/);

    // 90 days later: rehired with everything kept, a hello and no onboarding card.
    const st = interview.readState((await db.getEmployeeForOrg(avery.id, orgId))!);
    await db.updateEmployee(avery.id, orgId, { interview: JSON.stringify({ ...st, done: true, away: { ...st.away!, since: bench.addDays(st.away!.since, -91), until: bench.addDays(st.away!.until, -91) } }) });
    await db.updateEmployee(jordan.id, orgId, { interview: JSON.stringify({ ...interview.readState((await db.getEmployeeForOrg(jordan.id, orgId))!), done: true }) });
    card = (await me.bench.view({ organizationId: orgId })).employees.find((e) => e.kind === "inbox")!;
    expect(card.away!.canReturn).toBe(true);
    await me.bench.bringOn({ organizationId: orgId, employeeId: avery.id });
    const back = (await db.listChatMessages(orgId, avery.id)).at(-1)!;
    expect(back.content).toMatch(/^Thank you for bringing me back onto the team!/);
    expect(back.cards).toBeNull();
    expect(interview.readState((await db.getEmployeeForOrg(avery.id, orgId))!).away).toBeUndefined();
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

  it("sends an onboarded employee on vacation for at least 30 days, frees the spot, skips scheduled work and brings them back on the date", async () => {
    const { orgId, owner } = await makeWorkspace("bench-vacation");
    const me = caller(owner);
    await me.setup.finish({ organizationId: orgId, bench: true });
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    await me.bench.bringOn({ organizationId: orgId, employeeId: sienna.id });
    const today = (await me.bench.view({ organizationId: orgId })).today;

    // Only after onboarding, and never sooner than 30 days.
    await expect(me.bench.vacation({ organizationId: orgId, employeeId: sienna.id, back: bench.addDays(today, 40) })).rejects.toThrow(/after onboarding/);
    await db.updateEmployee(sienna.id, orgId, { interview: JSON.stringify({ ...interview.readState((await db.getEmployeeForOrg(sienna.id, orgId))!), done: true }) });
    await expect(me.bench.vacation({ organizationId: orgId, employeeId: sienna.id, back: bench.addDays(today, 10) })).rejects.toThrow(/Pick a return date on or after/);
    await me.bench.vacation({ organizationId: orgId, employeeId: sienna.id, back: bench.addDays(today, 30) });
    expect(await onTeam(orgId)).not.toContain("social");
    let card = (await me.bench.view({ organizationId: orgId })).employees.find((e) => e.kind === "social")!;
    expect(card.away).toMatchObject({ kind: "vacation", until: bench.addDays(today, 30), canReturn: false });
    await expect(me.bench.bringOn({ organizationId: orgId, employeeId: sienna.id })).rejects.toThrow(/on vacation and can come back on/);

    // The date moves later, not earlier.
    await expect(me.bench.changeReturn({ organizationId: orgId, employeeId: sienna.id, back: bench.addDays(today, 20) })).rejects.toThrow(/on or after/);
    await me.bench.changeReturn({ organizationId: orgId, employeeId: sienna.id, back: bench.addDays(today, 45) });

    // Her scheduled work doesn't run while she's away: the task moves to its next time.
    const task = await db.createScheduledTask({ organizationId: orgId, createdBy: "Owner", employeeId: sienna.id, title: "Weekly posts", instructions: "Plan this week's posts.", repeat: "daily", time: "09:00", weekday: null, monthDay: null, onDate: null, enabled: true, nextRunAt: new Date(Date.now() - 60_000), notify: "push" });
    await runner.tick(new Date());
    const after = (await db.listScheduledTasks(orgId)).find((x) => x.id === task.id)!;
    expect(after.lastRunAt).toBeNull();
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect((await db.listChatMessages(orgId, sienna.id)).some((m) => m.authorName === "Scheduled task: Weekly posts")).toBe(false);

    // On the return date she's back on her own, with a hello.
    const st = interview.readState((await db.getEmployeeForOrg(sienna.id, orgId))!);
    await db.updateEmployee(sienna.id, orgId, { interview: JSON.stringify({ ...st, away: { ...st.away!, since: bench.addDays(today, -45), until: today } }) });
    await bench.vacationTick(orgId);
    expect(await onTeam(orgId)).toContain("social");
    const hello = (await db.listChatMessages(orgId, sienna.id)).at(-1)!;
    expect(hello.content).toMatch(/^I'm back from vacation!/);
    card = (await me.bench.view({ organizationId: orgId })).employees.find((e) => e.kind === "social")!;
    expect(card.away).toBeNull();
  });

  it("once, in a workspace already in use, moves employees never onboarded and not in use to the bench and keeps the rest", async () => {
    const { orgId, owner } = await makeWorkspace("bench-sweep");
    const me = caller(owner);
    // A workspace in use from before the bench: everyone active.
    await db.updateOrganization(orgId, { setupAt: new Date() });
    const get = async (k: string) => (await db.getEmployeeByKind(orgId, k as any))!;
    const avery = await get("inbox"); // onboarded
    await db.updateEmployee(avery.id, orgId, { interview: JSON.stringify({ ...interview.readState(avery), done: true }) });
    const sienna = await get("social"); // someone wrote to her
    await me.chat.send({ organizationId: orgId, employeeId: sienna.id, text: "Plan this week's posts." }).catch(() => null);
    const nora = await get("projects"); // scheduled work on
    await db.createScheduledTask({ organizationId: orgId, createdBy: "Owner", employeeId: nora.id, title: "Status", instructions: "Weekly status.", repeat: "weekly", time: "09:00", weekday: 1, monthDay: null, onDate: null, enabled: true, nextRunAt: new Date(Date.now() + 86_400_000), notify: "push" });
    const morgan = await get("grants"); // never used, never onboarded

    const moved = await bench.benchUnused(orgId);
    expect(moved).toContain("Morgan");
    expect(moved).not.toContain("Avery");
    expect(moved).not.toContain("Nora");
    expect((await db.getEmployeeForOrg(morgan.id, orgId))!.status).toBe("paused");
    expect((await db.getEmployeeForOrg(avery.id, orgId))!.status).not.toBe("paused");
    expect((await db.getEmployeeForOrg(nora.id, orgId))!.status).not.toBe("paused");
    if ((await db.listChatMessages(orgId, sienna.id)).some((m) => m.role === "user" && m.userId)) expect(moved).not.toContain("Sienna");

    // Only once: bringing Morgan back on and running it again changes nothing.
    await db.updateEmployee(morgan.id, orgId, { status: "active" });
    expect(await bench.benchUnused(orgId)).toEqual([]);
    expect((await db.getEmployeeForOrg(morgan.id, orgId))!.status).toBe("active");
  });
});
