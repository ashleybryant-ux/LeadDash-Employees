import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as ehr from "./ehr";
import * as compliance from "./employees/compliance";
import { systemPromptFor } from "./employees/tasks";

/**
 * A healthcare practice: the organization type decides who is on the team,
 * the titles and departments, the client information rules in every prompt,
 * and what Harper, Malik and Camille read from LeadDash EHR.
 */

vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
afterEach(() => vi.restoreAllMocks());

const snapshot = (over: Partial<ehr.EhrSnapshot> = {}): ehr.EhrSnapshot => ({
  generatedAt: "2026-10-06T14:00:00.000Z",
  practice: "Legacy Family Services",
  claims: [{ id: "c1", initials: "J.M.", dos: "2026-09-22", payer: "BCBS of Oklahoma", status: "denied", reason: "CO-4: modifier missing", fix: "Add modifier 95, resubmit", amountCents: 12_000, url: "https://ehr.test/claims/c1", at: "2026-10-06T13:00:00.000Z" }],
  unpaid: [{ payer: "HealthChoice", count: 4, oldest: "2026-08-20", amountCents: 296_000, status: "Needs a call", url: "https://ehr.test/claims?payer=hc" }],
  balances: [{ id: "b1", initials: "A.P.", cents: 36_000, lastPayment: "2026-08-04", cardOnFile: true, url: "https://ehr.test/clients/b1/billing" }],
  eligibility: [{ id: "e1", initials: "R.T.", session: "2026-10-07T19:00:00.000Z", clinician: "Angela St. Ville", result: "Plan ended Aug 31, 2026", ok: false, url: "https://ehr.test/clients/e1" }],
  paperwork: [{ id: "p1", initials: "K.L.", what: "Intake packet", sent: "2026-09-28", due: "2026-10-05", status: "overdue", daysOut: 8, url: "https://ehr.test/clients/p1/paperwork" }],
  appointments: [{ id: "a1", kind: "booked", initials: "M.B.", clinician: "Dr. Ashley Bryant", start: "2026-10-08T15:00:00.000Z", reason: "", at: "2026-10-06T12:00:00.000Z", url: "https://ehr.test/appointments/a1" }],
  docs: [{ clinician: "Bentlee Smiley", unsigned: 2, oldestUnsigned: "2026-09-24", plansDue: 1, plansDueSoonest: "2026-10-15", measuresOverdue: 1, url: "https://ehr.test/notes?who=bs" }],
  totals: { collectedMonthCents: 2_498_000, unpaid30Cents: 842_000, balancesCents: 131_000 },
  ...over,
});

describe("A healthcare practice workspace", () => {
  it("gets its own roster, titles and departments when the organization type is set, and back again", async () => {
    const { orgId, owner } = await makeWorkspace("hc-roster");
    const me = caller(owner);
    const before = await me.employees.list({ organizationId: orgId });
    expect(before.map((e) => e.kind)).not.toContain("billing");
    expect(before.find((e) => e.kind === "hiring")!.roleTitle).toBe("HR Director");
    expect((await db.listAllEmployeesByOrg(orgId)).filter((e) => !e.onTeam).map((e) => e.kind).sort()).toEqual(["billing", "compliance"]);

    await me.organizations.update({ id: orgId, orgType: "healthcare" });
    const list = await me.employees.list({ organizationId: orgId });
    const kinds = list.map((e) => e.kind).sort();
    expect(kinds).toContain("billing");
    expect(kinds).toContain("compliance");
    expect(kinds).not.toContain("prospecting");
    expect(kinds).not.toContain("outreach");
    expect(kinds).not.toContain("developer");
    expect(list).toHaveLength(16);
    const by = (k: string) => list.find((e) => e.kind === k)!;
    expect(by("leads")).toMatchObject({ name: "Malik", roleTitle: "Intake Coordinator", department: "Client care" });
    expect(by("inbox").department).toBe("Client care");
    expect(by("billing")).toMatchObject({ name: "Harper", roleTitle: "Billing Specialist", department: "Billing and compliance" });
    expect(by("compliance")).toMatchObject({ name: "Camille", roleTitle: "Compliance Coordinator" });
    expect(by("onboarding").roleTitle).toBe("Clinician Onboarding Specialist");
    expect(by("social").department).toBe("Growth");
    expect(by("hiring").department).toBe("Operations");

    // The rules land in every prompt: those four work with client information, everyone else without it.
    const avery = (await systemPromptFor(by("inbox"), "Draft a reply")).system;
    expect(avery).toContain("You work with client information");
    expect(avery).toContain("initials only");
    const sienna = (await systemPromptFor(by("social"), "Write a post")).system;
    expect(sienna).toContain("You work without client information");
    expect(sienna).toContain("goes to Avery, Malik, Harper, Camille");

    // Back to business: Sales returns, Harper and Camille step off, the titles go back.
    await me.organizations.update({ id: orgId, orgType: "business" });
    const back = await me.employees.list({ organizationId: orgId });
    expect(back.map((e) => e.kind)).toContain("prospecting");
    expect(back.map((e) => e.kind)).not.toContain("billing");
    expect(back.find((e) => e.kind === "leads")!.roleTitle).toBe("New Leads Assistant");
    expect((await systemPromptFor(back.find((e) => e.kind === "social")!, "Write a post")).system).not.toContain("client information (this workspace");
  });

  it("connects LeadDash EHR, reads a snapshot, and tells Harper, Malik and Camille only what changed", async () => {
    const { orgId, owner } = await makeWorkspace("hc-ehr");
    const me = caller(owner);
    await me.organizations.update({ id: orgId, orgType: "healthcare" });
    let served: ehr.EhrSnapshot = snapshot();
    const calls: string[] = [];
    vi.spyOn(ehr.tools, "fetchJson").mockImplementation(async (url: string, key: string) => {
      calls.push(`${url} ${key}`);
      if (url.endsWith("/api/employees/ping")) {
        if (key !== "ld-emp-0123456789abcdefghij") throw new Error("LeadDash EHR answered 401: bad key");
        return { ok: true, practice: "Legacy Family Services", locationId: "loc_1" };
      }
      return served;
    });
    await expect(me.ehr.connect({ organizationId: orgId, url: "https://ehr.leaddash.io/", key: "wrong-key-wrong-key-wrong" })).rejects.toThrow(/did not accept that key/);
    await expect(me.ehr.connect({ organizationId: orgId, url: "ehr.leaddash.io", key: "ld-emp-0123456789abcdefghij" })).rejects.toThrow(/looks like https/);
    const r = await me.ehr.connect({ organizationId: orgId, url: "https://ehr.leaddash.io/", key: "ld-emp-0123456789abcdefghij" });
    expect(r.practice).toBe("Legacy Family Services");
    expect(calls[0]).toBe("https://ehr.leaddash.io/api/employees/ping wrong-key-wrong-key-wrong");
    // Connecting does the first read; a first read never posts history.
    const v = await me.ehr.view({ organizationId: orgId });
    expect(v).toMatchObject({ connected: true, practice: "Legacy Family Services" });
    expect(v.snapshot!.claims).toHaveLength(1);
    const harper = (await db.getEmployeeByKind(orgId, "billing"))!;
    expect(await db.listChatMessages(orgId, harper.id, 10)).toHaveLength(0);
    expect(await ehr.ehrFacts(orgId)).toContain("1 denied or rejected claims, 4 unpaid past 30 days ($8,420)");
    expect(await ehr.ehrFacts(orgId)).toContain("0 clients not booked in 30 days");
    expect(await ehr.ehrFacts(orgId, "billing")).toContain("Client balances, largest first: A.P. $360 (card on file), last paid Aug 4, 2026");

    // The next read: a rejected claim, paperwork newly overdue, a cancellation and more unsigned notes.
    served = snapshot({
      claims: [...snapshot().claims, { id: "c2", name: "Rosa Tran", initials: "R.T.", dos: "2026-09-18", payer: "HealthChoice", status: "rejected", reason: "Member ID does not match", fix: "Check the card, resubmit", amountCents: 9_500, url: "https://ehr.test/claims/c2", at: "2026-10-06T14:30:00.000Z" }],
      paperwork: [...snapshot().paperwork, { id: "p2", initials: "D.W.", what: "Consent forms", sent: "2026-09-30", due: "2026-10-06", status: "overdue", daysOut: 6, url: "https://ehr.test/clients/p2/paperwork" }],
      appointments: [...snapshot().appointments, { id: "a2", kind: "cancelled", initials: "A.P.", clinician: "Angela St. Ville", start: "2026-10-07T21:00:00.000Z", reason: "Schedule conflict", at: "2026-10-06T14:20:00.000Z", url: "https://ehr.test/appointments/a2" }],
      lapsed: [{ id: "l1", name: "Tom Reed", initials: "T.R.", lastSeen: "2026-08-20", days: 47, clinician: "Angela St. Ville", url: "https://ehr.test/patients/l1" }],
      docs: [{ ...snapshot().docs[0], unsigned: 4 }],
    });
    const second = await me.ehr.refresh({ organizationId: orgId });
    expect(second.posted).toBe(3);
    const h = (await db.listChatMessages(orgId, harper.id, 10)).pop()!;
    expect(h.content).toContain("A claim came back rejected from LeadDash EHR.");
    expect(h.content).toContain("- Rosa Tran · Sep 18, 2026 · HealthChoice · Rejected: Member ID does not match. Fix: Check the card, resubmit ($95)");
    expect(h.content).not.toContain("J.M.");
    const malik = (await db.getEmployeeByKind(orgId, "leads"))!;
    const m = (await db.listChatMessages(orgId, malik.id, 10)).pop()!;
    expect(m.content).toContain("One client has paperwork past due and 1 appointment change and one client not booked in 30 days");
    expect(m.content).toContain("- Tom Reed · last seen Aug 20, 2026 with Angela St. Ville, 47 days ago, nothing booked");
    expect(await ehr.ehrFacts(orgId, "leads")).toContain("Not booked in 30 days, longest first: Tom Reed last seen Aug 20, 2026 with Angela St. Ville (47 days)");
    // A row without a name (an older EHR) still shows by initials; push notices never carry a client.
    expect(m.content).toContain("- D.W. · Consent forms sent Sep 30, 2026");
    expect(m.content).toContain("- D.W. · Consent forms sent Sep 30, 2026, 6 days out, not finished");
    expect(m.content).toContain("A.P. · Wed, Oct 7, 2026, 4:00 PM with Angela St. Ville · cancelled (Schedule conflict)");
    const camille = (await db.getEmployeeByKind(orgId, "compliance"))!;
    const c = (await db.listChatMessages(orgId, camille.id, 10)).pop()!;
    expect(c.content).toContain("A clinician has more unsigned notes than yesterday.");
    expect(c.content).toContain("- Bentlee Smiley: 4 unsigned notes past the limit (was 2)");

    // Nothing new: nothing posted.
    const third = await me.ehr.refresh({ organizationId: orgId });
    expect(third.posted).toBe(0);
    expect(await db.listChatMessages(orgId, harper.id, 10)).toHaveLength(1);

    // Camille's desk shows the EHR counts next to her own dates.
    const desk = await me.compliance.desk({ organizationId: orgId });
    expect(desk.counts).toMatchObject({ unsigned: 4, plansDue: 1 });
    expect(desk.ehr.connected).toBe(true);

    await me.ehr.disconnect({ organizationId: orgId });
    expect((await me.ehr.view({ organizationId: orgId })).connected).toBe(false);
    expect(await ehr.ehrFacts(orgId)).toContain("not connected");
  });

  it("keeps Camille's dates: due in 30 days, overdue, done", async () => {
    const { orgId, owner } = await makeWorkspace("hc-dates");
    const me = caller(owner);
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const mdy = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
    const a = await me.compliance.add({ organizationId: orgId, kind: "caqh", title: "CAQH attestation", who: "Angela St. Ville", due: mdy(soon) });
    await me.compliance.add({ organizationId: orgId, kind: "license", title: "LPC renewal, Oklahoma", who: "Bentlee Smiley", due: mdy(far), note: "16 of 20 CE hours on file" });
    const late = await me.compliance.add({ organizationId: orgId, kind: "training", title: "HIPAA training", who: "Delicia Porter", due: "09/30/2026" });
    await expect(me.compliance.add({ organizationId: orgId, kind: "other", title: "x", due: "Oct 6" })).rejects.toThrow(/MM\/DD\/YYYY/);
    const desk = await me.compliance.desk({ organizationId: orgId });
    expect(desk.due30.map((i) => i.title)).toEqual(["HIPAA training", "CAQH attestation"]);
    expect(desk.counts).toMatchObject({ due30: 2, overdue: 1, unsigned: 0, sopsDue: 0 });
    expect(desk.ehr.connected).toBe(false);
    expect(desk.items.find((i) => i.id === late.id)).toMatchObject({ overdue: true, kindLabel: "Training" });
    expect(await compliance.complianceFacts(orgId)).toContain("- CAQH attestation: CAQH attestation (Angela St. Ville), due");
    await me.compliance.setDone({ organizationId: orgId, id: a.id, done: true });
    expect((await me.compliance.desk({ organizationId: orgId })).counts.due30).toBe(1);
    await me.compliance.save({ organizationId: orgId, id: late.id, kind: "training", title: "HIPAA training", who: "Delicia Porter", due: mdy(far) });
    expect((await me.compliance.desk({ organizationId: orgId })).counts.overdue).toBe(0);
    expect((await me.compliance.remove({ organizationId: orgId, id: late.id })).ok).toBe(true);
  });

  it("a connection whose first read failed shows no read time and still lets the employees talk", async () => {
    const { orgId, owner } = await makeWorkspace("hc-ehr-fail");
    const me = caller(owner);
    await me.organizations.update({ id: orgId, orgType: "healthcare" });
    vi.spyOn(ehr.tools, "fetchJson").mockImplementation(async (url: string) => {
      if (url.endsWith("/api/employees/ping")) return { ok: true, practice: "Legacy Family Services", locationId: "loc_1" };
      throw new Error("The operation was aborted due to timeout");
    });
    await me.ehr.connect({ organizationId: orgId, url: "https://api.health.leaddash.io", key: "ld-emp-0123456789abcdefghij" });
    const v = await me.ehr.view({ organizationId: orgId });
    expect(v).toMatchObject({ connected: true, fetchedAt: null, snapshot: null, error: "The operation was aborted due to timeout" });
    expect(await ehr.ehrFacts(orgId, "billing")).toContain("but the last read failed (The operation was aborted due to timeout)");
  });

  it("Harper reads what came in today and last Thursday from LeadDash EHR and answers from it, on the BAA route", async () => {
    const { orgId, owner } = await makeWorkspace("hc-ehr-money");
    const me = caller(owner);
    await me.organizations.update({ id: orgId, orgType: "healthcare" });
    const asked: string[] = [];
    vi.spyOn(ehr.tools, "fetchJson").mockImplementation(async (url: string) => {
      asked.push(url);
      if (url.endsWith("/api/employees/ping")) return { ok: true, practice: "Legacy Family Services", locationId: "loc_1" };
      if (url.includes("/api/employees/payments")) {
        return {
          ok: true, from: "2026-10-01", to: "2026-10-08", today: "2026-10-08",
          days: [
            { date: "2026-10-01", weekday: "Thursday", insuranceCents: 0, clientCents: 40_000, refundsCents: 0, netCents: 40_000, payments: 3 },
            { date: "2026-10-08", weekday: "Thursday", insuranceCents: 12_050, clientCents: 9_500, refundsCents: 0, netCents: 21_550, payments: 2 },
          ],
          totals: { insuranceCents: 12_050, clientCents: 49_500, refundsCents: 0, netCents: 61_550, payments: 5 },
          payments: [{ date: "2026-10-08", kind: "insurance", payer: "BCBS of Oklahoma", method: "era", name: "Jane Moore", initials: "J.M.", amountCents: 12_050, unappliedCents: 0 }],
          paymentsTotal: 5, refunds: [],
        };
      }
      return snapshot();
    });
    await me.ehr.connect({ organizationId: orgId, url: "https://api.health.leaddash.io", key: "ld-emp-0123456789abcdefghij" });
    const harper = (await db.getEmployeeByKind(orgId, "billing"))!;
    const blank = { reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
    const prompts: string[] = [];
    const routes: unknown[] = [];
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName !== "chat_decision") return {} as any;
      prompts.push(opts.prompt);
      routes.push(opts.clientInfo);
      // No plan on the read: the answer still comes from what it found.
      if (prompts.length === 1) return { ...blank, action: "ehr_read", target: "payments", date: "2026-10-01", count: 8, reply: "Checking." } as any;
      return { ...blank, reply: "$215.50 came in today, against $400.00 last Thursday." } as any;
    });
    const r = await me.chat.send({ organizationId: orgId, employeeId: harper.id, text: "Harper, how much money came in today compared to last Thursday?" });
    expect(asked).toContain("https://api.health.leaddash.io/api/employees/payments?from=2026-10-01&to=2026-10-08");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Thursday Oct 8, 2026: $215.50 net (insurance $120.50, clients $95.00), 2 payments");
    expect(prompts[1]).toContain("Thursday Oct 1, 2026: $400.00 net");
    expect(prompts[1]).toContain("Insurance (BCBS of Oklahoma) · Jane Moore · $120.50");
    expect(routes).toEqual([true, true]);
    expect(r.reply!.content).toContain("$215.50 came in today, against $400.00 last Thursday.");
    expect(r.reply!.content).not.toContain("I read payments");
  });

  it("Avery reads tomorrow's sessions from the LeadDash EHR calendar, with each client's balance and paperwork, when the practice has no personal calendar connected", async () => {
    const { orgId, owner } = await makeWorkspace("hc-ehr-sessions");
    const me = caller(owner);
    await me.organizations.update({ id: orgId, orgType: "healthcare" });
    const asked: string[] = [];
    vi.spyOn(ehr.tools, "fetchJson").mockImplementation(async (url: string) => {
      asked.push(url);
      if (url.endsWith("/api/employees/ping")) return { ok: true, practice: "Legacy Family Services", locationId: "loc_1" };
      if (url.includes("/api/employees/appointments")) {
        return {
          ok: true, from: "2026-10-09", to: "2026-10-09", byStatus: { confirmed: 2 }, byClinician: { "Dr. Ashley Bryant": 2 },
          appointments: [
            { id: "ap1", date: "2026-10-09", start: "2026-10-09T15:00:00.000Z", status: "confirmed", clinician: "Dr. Ashley Bryant", name: "Avery Price", initials: "A.P.", url: "https://ehr.test/patients/b1" },
            { id: "ap2", date: "2026-10-09", start: "2026-10-09T16:00:00.000Z", status: "confirmed", clinician: "Dr. Ashley Bryant", name: "Kim Lee", initials: "K.L.", url: "https://ehr.test/patients/p1" },
          ],
          appointmentsShown: 2, appointmentsTotal: 2,
        };
      }
      // The snapshot's balance is on client b1 and the overdue intake packet on client p1.
      return snapshot({ paperwork: [{ id: "p1", initials: "K.L.", what: "Intake Questionnaire", packet: "Your paperwork", sent: "2026-09-28", due: "2026-10-05", status: "overdue", daysOut: 8, url: "https://ehr.test/patients/p1?tab=paperwork" }, { id: "p2", initials: "K.L.", what: "Consent for Treatment", packet: "Your paperwork", sent: "2026-09-28", due: null, status: "not_started", daysOut: 8, url: "https://ehr.test/patients/p1?tab=paperwork" }] });
    });
    await me.ehr.connect({ organizationId: orgId, url: "https://api.health.leaddash.io", key: "ld-emp-0123456789abcdefghij" });
    await me.ehr.refresh({ organizationId: orgId });
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const blank = { reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
    const prompts: string[] = [];
    const systems: string[] = [];
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName !== "chat_decision") return {} as any;
      prompts.push(opts.prompt);
      systems.push(opts.system);
      // The model reaches for the personal calendar; with none connected, the EHR calendar is the one the practice means.
      if (prompts.length === 1) return { ...blank, action: "check_schedule", date: "2026-10-09", count: 1, reply: "Checking." } as any;
      return { ...blank, reply: "Two sessions tomorrow. Avery Price owes $360 and has a card on file; Kim Lee's intake packet is overdue." } as any;
    });
    const r = await me.chat.send({ organizationId: orgId, employeeId: avery.id, text: "Looking at the appointments scheduled for tomorrow, does anyone have a balance or forms that were sent and not completed?" });
    expect(asked).toContain("https://api.health.leaddash.io/api/employees/appointments?from=2026-10-09&to=2026-10-09");
    expect(systems[0]).toContain("ehr_read: read LeadDash EHR");
    expect(systems[0]).toContain("no personal calendar is connected, so a question about appointments or sessions always means the EHR");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Of these clients, 1 has a balance ($360.00 in all) and 1 has paperwork sent and not finished");
    expect(prompts[1]).toContain("Avery Price · Dr. Ashley Bryant · confirmed · balance $360.00 (card on file) · no paperwork out");
    expect(prompts[1]).toContain("Kim Lee · Dr. Ashley Bryant · confirmed · no balance · paperwork out: Intake Questionnaire (in Your paperwork), sent Sep 28, 2026 (overdue); Consent for Treatment (in Your paperwork), sent Sep 28, 2026");
    expect(r.reply!.content).toContain("Avery Price owes $360");
    expect(r.reply!.content).not.toContain("I don't have a calendar");
  });

  it("the Show, Initial or Hide switch changes how client names reach the screen, in chat and on the Work tabs, for that person only", async () => {
    const { orgId, owner } = await makeWorkspace("hc-ehr-names");
    const me = caller(owner);
    await me.organizations.update({ id: orgId, orgType: "healthcare" });
    vi.spyOn(ehr.tools, "fetchJson").mockImplementation(async (url: string) => {
      if (url.endsWith("/api/employees/ping")) return { ok: true, practice: "Legacy Family Services", locationId: "loc_1" };
      return snapshot({ balances: [{ id: "b1", name: "Avery Price", initials: "A.P.", cents: 36_000, lastPayment: "2026-08-04", cardOnFile: true, url: "https://ehr.test/patients/b1" }], lapsed: [{ id: "l1", name: "Ann Lee-Parker", initials: "A.L.", lastSeen: "2026-08-20", days: 49, clinician: "Dr. Ashley Bryant", url: "https://ehr.test/patients/l1" }] });
    });
    await me.ehr.connect({ organizationId: orgId, url: "https://api.health.leaddash.io", key: "ld-emp-0123456789abcdefghij" });
    await me.ehr.refresh({ organizationId: orgId });
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    await db.createChatMessage({ organizationId: orgId, employeeId: avery.id, role: "employee", authorName: "Avery", content: "Avery Price owes $360 and Ann Lee-Parker has not booked since Aug 20, 2026. avery price confirmed by text." });

    // Full names until the person chooses otherwise.
    expect((await me.ehr.nameMode()).mode).toBe("show");
    expect((await me.chat.list({ organizationId: orgId, employeeId: avery.id })).at(-1)!.content).toContain("Avery Price owes $360 and Ann Lee-Parker");

    await me.ehr.setNameMode({ mode: "initial" });
    const initial = await me.chat.list({ organizationId: orgId, employeeId: avery.id });
    expect(initial.at(-1)!.content).toBe("A. Price owes $360 and A. Lee-Parker has not booked since Aug 20, 2026. A. Price confirmed by text.");
    const v1 = await me.ehr.view({ organizationId: orgId });
    expect(v1.snapshot!.balances[0].name).toBe("A. Price");
    expect(v1.snapshot!.lapsed[0].name).toBe("A. Lee-Parker");
    expect((await me.chat.summaries({ organizationId: orgId })).find((x) => x.employeeId === avery.id)?.content).toContain("A. Price owes");

    await me.ehr.setNameMode({ mode: "hide" });
    const hidden = (await me.chat.list({ organizationId: orgId, employeeId: avery.id })).at(-1)!.content;
    expect(hidden).toBe(`${ehr.HIDDEN} owes $360 and ${ehr.HIDDEN} has not booked since Aug 20, 2026. ${ehr.HIDDEN} confirmed by text.`);
    expect(hidden).not.toContain("Price");
    const v2 = await me.ehr.view({ organizationId: orgId });
    expect(v2.snapshot!.balances[0]).toMatchObject({ name: ehr.HIDDEN, cents: 36_000, url: "https://ehr.test/patients/b1" });

    // The choice is the person's own: a teammate still sees full names, and the stored message is untouched.
    const { reviewer } = await makeWorkspace("hc-ehr-names-other");
    await db.addOrganizationMember({ organizationId: orgId, userId: reviewer.id, role: "member" });
    expect((await caller(reviewer).chat.list({ organizationId: orgId, employeeId: avery.id })).at(-1)!.content).toContain("Avery Price owes $360");
    expect((await db.listChatMessages(orgId, avery.id)).at(-1)!.content).toContain("Avery Price owes $360");

    // A name learned from a read on request is remembered too.
    ehr.rememberNames(orgId, ["Kim Lee"]);
    expect(ehr.forScreen(orgId, "hide", "Kim Lee at 11:00 AM; Kimberly Lee-Smith is not a known client.")).toBe(`${ehr.HIDDEN} at 11:00 AM; Kimberly Lee-Smith is not a known client.`);
    expect(ehr.initialForm("Cher")).toBe("Cher");
  });
});
