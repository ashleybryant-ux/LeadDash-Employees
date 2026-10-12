import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as people from "./employees/people";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const mdy = (v: string) => `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

async function mockAi(decision: any = {}) {
  const llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "chat_decision") return { ...blank, ...decision } as any;
    if (opts.schemaName === "welcome_email") return { subject: "Welcome to the team, Jordan", body: "Hi Jordan,\nWe're glad you're joining us on your start date.\nAshley" } as any;
    if (opts.schemaName === "payers") return { payers: ["SoonerCare"] } as any;
    if (opts.schemaName === "launch_plan")
      return {
        name: "Plan",
        milestones: [{ name: "Ready for day one", date: ymd(5) }, { name: "End of week one", date: ymd(30) }],
        tasks: [
          { title: "Set up email and calendar", details: "", doneWhen: "Account works", milestone: 0, owner: "Owner", date: ymd(4), waitingOn: "" },
          { title: "Walk through the handbook", details: "", doneWhen: "Handbook signed", milestone: 1, owner: "Owner", date: ymd(6), waitingOn: "" },
        ],
        kpis: [],
      } as any;
    return {} as any;
  });
}

describe("Imani onboards new hires", () => {
  it("takes over when Quinn marks someone hired: accounts, check-ins, a first-week plan and the welcome email", async () => {
    await mockAi();
    const { orgId, owner } = await makeWorkspace("imani-hire");
    const start = ymd(14);
    const p = await db.createHrPerson({ organizationId: orgId, source: "applicant", stage: "offer", name: "Jordan Reyes", credentials: "LPC", email: "jordan@example.com", startDate: mdy(start) });
    await caller(owner).hiring.hire({ organizationId: orgId, id: p.id });
    await people.settled();

    const hired = (await db.getHrPerson(p.id, orgId))!;
    expect(hired.stage).toBe("hired");
    const h = JSON.parse(hired.onboarding!);
    expect(h.accounts.map((a: any) => a.item)).toEqual(["Email and calendar", "Practice software account", "Shadow two sessions"]);
    expect(h.paperwork.map((a: any) => a.item)).toContain("Form I-9");
    expect(h.paperwork.some((a: any) => /EHR account/.test(a.item))).toBe(false);
    expect(h.checkins).toEqual([30, 60, 90].map((days) => ({ days, date: people.addDays(start, days), posted: false })));
    expect((await db.getLaunch(h.planLaunchId, orgId))!.name).toBe("Jordan Reyes onboarding");
    const email = (await db.getOutboundItemForOrg(h.welcome.outboundItemId, orgId))!;
    expect(email).toMatchObject({ status: "pending_approval", title: "Welcome to the team, Jordan" });
    expect(JSON.parse(email.metadata!).email).toBe("jordan@example.com");

    const imani = (await db.getEmployeeByKind(orgId, "onboarding"))!;
    const msgs = await db.listChatMessages(orgId, imani.id);
    expect(msgs.some((m) => m.role === "handoff" && m.content.startsWith("Jordan Reyes is hired"))).toBe(true);
    expect(msgs.at(-1)!.content).toMatch(/^I set up Jordan's onboarding for .*: a first-week plan in Projects \(2 tasks\), the paperwork and accounts checklists, and check-ins on .*\. The welcome email is waiting for your OK in Approvals\.$/);

    // The Work tab: one new hire, and the hire's plan is not a customer onboarding.
    const v = await caller(owner).people.list({ organizationId: orgId });
    expect(v.hires).toHaveLength(1);
    expect(v.hires[0]).toMatchObject({ name: "Jordan Reyes", start, done: 0, total: h.paperwork.length + h.credentialing.length + 3, welcome: { status: "pending_approval" } });
    expect(v.hires[0].plan).toMatchObject({ name: "Jordan Reyes onboarding", tasks: 2 });
    expect(v.customers).toHaveLength(0);
    expect(await people.peopleFacts(orgId)).toContain("Customers being onboarded: none yet.");

    // Remind them: the open paperwork goes to Approvals as an email.
    const r = await caller(owner).people.remind({ organizationId: orgId, id: p.id });
    expect(r.queued).toBe(true);
    const reminder = (await db.listOutboundItemsByOrg(orgId, "email_draft")).find((m) => m.title === "A few things still open")!;
    expect(reminder.body).toContain("- Form I-9");

    // The 30-day check-in posts in Imani's chat on its day, once.
    await people.peopleTicksFor(orgId, new Date(`${people.addDays(start, 30)}T18:00:00Z`));
    await people.peopleTicksFor(orgId, new Date(`${people.addDays(start, 30)}T19:00:00Z`));
    const after = await db.listChatMessages(orgId, imani.id);
    expect(after.filter((m) => m.content.startsWith("Today is Jordan Reyes's 30-day check-in"))).toHaveLength(1);
    expect(JSON.parse((await db.getHrPerson(p.id, orgId))!.onboarding!).checkins[0].posted).toBe(true);
  });

  it("onboards someone named in chat, asking for the start date first", async () => {
    const { orgId, owner } = await makeWorkspace("imani-chat");
    const imani = (await db.getEmployeeByKind(orgId, "onboarding"))!;
    await mockAi({ action: "onboard_hire", target: "Sam Ortiz", title: "Front desk" });
    const ask = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: "Onboard Sam Ortiz, front desk" });
    expect(ask.reply.content).toBe("When does Sam start?");
    expect(await people.findPerson(orgId, "Sam Ortiz")).toBeNull();

    const start = ymd(21);
    await mockAi({ action: "onboard_hire", target: "Sam Ortiz", title: "Front desk", date: start });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: `Sam Ortiz starts ${start} as front desk` });
    expect(r.reply.content).toMatch(/^I set up Sam's onboarding for .*Send me Sam's email and I'll write the welcome\.$/);
    expect(JSON.parse(r.reply.cards!)[0]).toMatchObject({ type: "launch_plan", title: "Sam Ortiz onboarding" });
    const sam = (await people.findPerson(orgId, "sam"))!;
    expect(sam).toMatchObject({ source: "staff", stage: "hired", currentRole: "Front desk", startDate: mdy(start) });
    const h = JSON.parse(sam.onboarding!);
    expect(h.accounts.map((a: any) => a.item)).toEqual(["Email and calendar", "Practice software account"]);
    expect(h.welcome).toBeNull();
    // A staff row never shows as one of Quinn's candidates.
    expect((await caller(owner).hiring.people({ organizationId: orgId, source: "applicant" })).some((p) => p.id === sam.id)).toBe(false);
  });

  it("uses the owner's answers for accounts and training, and saves checklist edits", async () => {
    await mockAi();
    const { orgId, owner, reviewer } = await makeWorkspace("imani-edit");
    const imani = (await db.getEmployeeByKind(orgId, "onboarding"))!;
    await db.updateEmployee(imani.id, orgId, { onboarding: JSON.stringify({ hireAccounts: "Email and calendar, phone system", hireTraining: "HIPAA training; billing basics" }) });
    const r = await people.onboardHire(orgId, { name: "Lee Park", role: "Biller", startDate: ymd(10) });
    expect(r.onboarding.accounts!.map((a) => a.item)).toEqual(["Email and calendar", "Practice software account", "Phone system", "HIPAA training", "Billing basics"]);

    const c = caller(owner);
    const accounts = r.onboarding.accounts!.map((a, i) => (i === 0 ? { ...a, status: "done" as const } : a));
    await c.people.saveOnboarding({ organizationId: orgId, id: r.person.id, lists: { accounts: [...accounts, { item: "Badge", detail: "", status: "waiting" }, { item: " ", detail: "", status: "to_do" }] } });
    const v = await c.people.list({ organizationId: orgId });
    const lee = v.hires.find((x) => x.id === r.person.id)!;
    expect(lee.accounts.map((a) => a.item)).toEqual(["Email and calendar", "Practice software account", "Phone system", "HIPAA training", "Billing basics", "Badge"]);
    expect(lee.done).toBe(1);
    expect(lee.total).toBe(lee.paperwork.length + 6);
    await expect(caller(reviewer).people.saveOnboarding({ organizationId: orgId, id: r.person.id, lists: { accounts: [] } })).rejects.toThrow();
  });
});

describe("Imani offboards people who leave", () => {
  it("sets up the checklist, asks about a caseload, adds the handoff with no client names, and reminds on the last day", async () => {
    const { orgId, owner } = await makeWorkspace("imani-leave");
    const imani = (await db.getEmployeeByKind(orgId, "onboarding"))!;
    const lastDay = ymd(30);
    await mockAi({ action: "offboard", target: "Taylor Brooks", title: "Therapist, LMFT", date: lastDay, notes: "Moving out of state" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: `Taylor Brooks is leaving. Last day is ${lastDay}` });
    expect(r.reply.content).toBe(`I set up Taylor's offboarding for ${people.longDate(lastDay)}. Taylor sees clients: should I plan a handoff of their caseload?`);
    const cards = JSON.parse(r.reply.cards!);
    expect(cards.find((x: any) => x.type === "choices").options).toEqual(["Yes, plan the handoff", "No caseload"]);

    const taylor = (await people.findPerson(orgId, "Taylor Brooks"))!;
    expect(taylor).toMatchObject({ source: "staff", stage: "leaving", currentRole: "Therapist, LMFT" });
    let off = JSON.parse(taylor.offboarding!);
    expect(off).toMatchObject({ lastDay, reason: "Moving out of state", caseload: null, exitInterview: null, clients: [] });
    expect(off.access.map((a: any) => a.item)).toEqual(["Practice software access removed (last day)", "Email and calendar access removed", "Laptop and keys returned"]);
    expect(off.pay.map((a: any) => a.item)).toEqual(["Final paycheck date confirmed", "Benefits end letter"]);
    expect((await db.getLaunch(off.planLaunchId, orgId))!.name).toBe("Taylor Brooks offboarding");

    await mockAi({ action: "offboard", target: "Taylor Brooks", focus: "yes" });
    const yes = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: "Yes, plan the handoff" });
    expect(yes.reply.content).toBe("I added the caseload handoff to Taylor's offboarding: counts only, no client names.");
    off = JSON.parse((await db.getHrPerson(taylor.id, orgId))!.offboarding!);
    expect(off.caseload).toBe(true);
    expect(off.clients.map((a: any) => a.item)).toEqual(["Caseload handoff plan (counts only, no names)", "Notes signed and closed", "Clients told of the change"]);
    expect(off.clients.every((a: any) => a.detail === "")).toBe(true);
    // Still one plan.
    expect((await db.listLaunches(orgId)).filter((l) => l.name === "Taylor Brooks offboarding")).toHaveLength(1);

    const c = caller(owner);
    await c.people.saveOffboarding({ organizationId: orgId, id: taylor.id, lists: { pay: off.pay.map((a: any) => ({ ...a, status: "done" })) }, reason: "Moving to Denver", exitInterview: mdy(ymd(27)) });
    const v = await c.people.list({ organizationId: orgId });
    expect(v.leaving).toHaveLength(1);
    expect(v.leaving[0]).toMatchObject({ name: "Taylor Brooks", role: "Therapist, LMFT", lastDay, reason: "Moving to Denver", exitInterview: ymd(27), done: 2, total: 8 });
    expect(await c.people.list({ organizationId: orgId }).then((x) => x.hires.length)).toBe(0);

    // The last day: a reminder for the owner, once. Imani never removes access herself.
    await people.peopleTicksFor(orgId, new Date(`${lastDay}T18:00:00Z`));
    await people.peopleTicksFor(orgId, new Date(`${lastDay}T20:00:00Z`));
    const reminders = (await db.listChatMessages(orgId, imani.id)).filter((m) => m.content.startsWith("Today is Taylor Brooks's last day."));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].content).toContain("I don't change passwords or remove access myself.");
  });

  it("asks for the last day when it's missing", async () => {
    const { orgId, owner } = await makeWorkspace("imani-leave2");
    const imani = (await db.getEmployeeByKind(orgId, "onboarding"))!;
    await mockAi({ action: "offboard", target: "Pat Lee" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: "Pat Lee is leaving" });
    expect(r.reply.content).toBe("What's Pat's last day?");
    expect(await people.findPerson(orgId, "Pat Lee")).toBeNull();
  });
});
