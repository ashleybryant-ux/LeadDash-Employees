import { describe, expect, it, vi } from "vitest";

const calls: { schema: string; system: string; prompt: string }[] = [];

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "prospects")
        return {
          queries: ["LPC Oklahoma City group practice team", "LinkedIn LPC Edmond"],
          sources: [{ url: "https://www.linkedin.com/in/dana-whitfield-lpc", title: "Dana" }, { url: "https://okcounseling.example.com/team", title: "Team" }],
          data: {
            items: [
              { name: "Dana Whitfield", credentials: "LPC", currentRole: "Therapist, community mental health center", location: "Edmond, OK", foundOn: "LinkedIn", sourceUrl: "https://www.linkedin.com/in/dana-whitfield-lpc", workEmail: "", fitScore: 88, fitReason: "Six years with adolescents and families.", },
              { name: "Marcus Reyes", credentials: "LPC, LADC", currentRole: "Clinician, group practice", location: "Oklahoma City, OK", foundOn: "Practice team page", sourceUrl: "https://okcounseling.example.com/team", workEmail: "marcus@okcounseling.example.com", fitScore: 84, fitReason: "Dual licensed.", },
              { name: "Made Up", credentials: "LPC", currentRole: "", location: "", foundOn: "LinkedIn", sourceUrl: "https://notsearched.example.org/x", workEmail: "", fitScore: 90, fitReason: "No source." },
            ],
          },
        };
      return { queries: [], sources: [], data: {} };
    }),
    generateJson: vi.fn(async (opts: any) => {
      calls.push({ schema: opts.schemaName, system: opts.system, prompt: opts.prompt });
      if (opts.schemaName === "outreach_messages") {
        const ids = Array.from(String(opts.prompt).matchAll(/id (\d+):/g)).map((m) => Number(m[1]));
        return { messages: ids.map((id) => ({ id, message: `Hi, a short note for ${id}.` })) };
      }
      if (opts.schemaName === "screen")
        return { name: "Jordan Ellis", credentials: "LPC", email: "jordan@example.com", location: "Norman, OK", currentRole: "Therapist", fitScore: 91, fitReason: "Five years in family therapy.", mustHaves: [{ item: "Oklahoma license", met: "yes", kind: "must" }, { item: "Spanish", met: "no", kind: "nice" }] };
      if (opts.schemaName === "job_post") return { title: "Outpatient Therapist", post: "Legacy is hiring.", places: [{ name: "State counseling association job board", url: "" }] };
      if (opts.schemaName === "day_to_day") return { items: [{ when: "Every morning", what: "Reads new applicants and runs checks." }] };
      if (opts.schemaName === "times") return { times: ["Tue, Oct 6, 2026 at 1:00 PM", "Thu, Oct 8, 2026 at 10:00 AM", "Tue, Oct 13, 2026 at 11:00 AM"] };
      if (opts.schemaName === "payers") return { payers: ["SoonerCare", "BCBS of Oklahoma"] };
      if (opts.schemaName === "chat_decision") return { reply: "", action: "report", focus: "", topic: "", platforms: [], title: "", notes: "applicants and replies", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "" };
      return {};
    }),
    generateText: vi.fn(async (opts: any) => {
      calls.push({ schema: "text", system: opts.system, prompt: opts.prompt });
      return "Report: 1 new applicant is waiting on you.";
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { ensureAllRosters } from "./employees/roster-sync";
import { runTaskNow } from "./employees/runner";

describe("every workspace has every employee", () => {
  it("adds a new roster job (Quinn) to workspaces that were created before it existed", async () => {
    const { orgId } = await makeWorkspace("roster");
    const quinn = (await db.getEmployeeByKind(orgId, "hiring"))!;
    expect(quinn.name).toBe("Quinn");
    // Simulate an older workspace without Quinn.
    db.getDb().delete((await import("../drizzle/schema")).aiEmployees).where((await import("drizzle-orm")).eq((await import("../drizzle/schema")).aiEmployees.id, quinn.id)).run();
    expect(await db.getEmployeeByKind(orgId, "hiring")).toBeNull();
    expect(await ensureAllRosters()).toBeGreaterThanOrEqual(1);
    expect((await db.getEmployeeByKind(orgId, "hiring"))?.roleTitle).toBe("Recruiter");
    expect(await ensureAllRosters()).toBe(0);
  });
});

describe("onboarding and assignments", () => {
  it("saves fixed-choice answers, writes the day-to-day, feeds the answers into instructions, and runs a 9:00 report", async () => {
    const { orgId, owner } = await makeWorkspace("onboard");
    const c = caller(owner);
    const quinn = (await db.getEmployeeByKind(orgId, "hiring"))!;
    const before = await c.onboarding.get({ organizationId: orgId, employeeId: quinn.id });
    expect(before.interview.sections.find((s) => s.key === "interviews")?.questions.find((q) => q.key === "interviewHours")?.type).toBe("text");
    expect(before.templates[0].label).toBe("Send me a report");

    await c.onboarding.saveBrain({ organizationId: orgId, employeeId: quinn.id, facts: { state: "Oklahoma" }, advance: true });
    await c.onboarding.savePart({ organizationId: orgId, employeeId: quinn.id, section: "job", answers: { goal: ["Licensed clinicians", "Not an option"], often: "Twice a week" }, advance: true });
    await c.onboarding.savePart({ organizationId: orgId, employeeId: quinn.id, section: "interviews", answers: { interviewHours: "Tue and Thu, 10:00 AM to 2:00 PM", screening: "made up" }, advance: false });
    const after = await c.onboarding.get({ organizationId: orgId, employeeId: quinn.id });
    expect(after.interview.answers.goal).toEqual(["Licensed clinicians"]); // only real options are kept
    expect(after.interview.answers.screening).toBe("");
    expect(after.progress.answered).toBe(2);
    await c.onboarding.rewriteDay({ organizationId: orgId, employeeId: quinn.id });
    expect((await c.onboarding.get({ organizationId: orgId, employeeId: quinn.id })).dayToDay[0].when).toBe("Every morning");

    const task = await c.tasks.save({ organizationId: orgId, employeeId: quinn.id, title: "Daily report", instructions: "Send me a report: new applicants and replies.", repeat: "daily", time: "09:00", notify: "push" });
    expect(task.notify).toBe("push");
    expect((await c.onboarding.get({ organizationId: orgId, employeeId: quinn.id })).assignments).toHaveLength(1);

    calls.length = 0;
    const run = await runTaskNow(task, true);
    expect(run?.reply.content).toContain("Report:");
    // The chat decision saw the onboarding answers.
    expect(calls.find((x) => x.schema === "chat_decision")?.system).toContain("Hours: Tue and Thu, 10:00 AM to 2:00 PM");
  });
});

describe("Quinn: hiring", () => {
  it("finds prospects with real sources only, drafts messages, and keeps Do not contact people out of later searches", async () => {
    const { orgId, owner } = await makeWorkspace("hire1");
    const c = caller(owner);
    await c.hiring.saveRole({ organizationId: orgId, title: "Outpatient therapist", employment: "w2", hours: "part", place: "both", payFrom: "$40 an hour", payTo: "$55 an hour", licenses: ["LPC", "LMFT"], mustHave: "Oklahoma license", niceToHave: "Spanish" });
    const r = await c.hiring.find({ organizationId: orgId });
    expect(r.added).toBe(2); // the one whose site never came up in search is dropped
    const people = await c.hiring.people({ organizationId: orgId, source: "prospect" });
    const dana = people.find((p) => p.name === "Dana Whitfield")!;
    const marcus = people.find((p) => p.name === "Marcus Reyes")!;
    expect(dana.message).toContain("short note");
    expect(dana.email).toBeNull();
    expect(dana.purgeAt).toBeTruthy();
    // Fair-hiring rules are in every prompt.
    expect(calls.find((x) => x.schema === "outreach_messages")?.system).toContain("Never consider or mention age, race");

    await expect(c.hiring.emailPerson({ organizationId: orgId, id: dana.id, purpose: "outreach" })).rejects.toThrow(/no work email/);
    const item = await c.hiring.emailPerson({ organizationId: orgId, id: marcus.id, purpose: "outreach" });
    expect(item.kind).toBe("hiring_email");
    expect(item.status).toBe("pending_approval");
    expect((await c.hiring.people({ organizationId: orgId })).find((p) => p.id === marcus.id)?.queued).toBe(true);

    await c.hiring.markSent({ organizationId: orgId, id: dana.id });
    await c.hiring.move({ organizationId: orgId, id: dana.id, stage: "dnc" });
    const again = await c.hiring.find({ organizationId: orgId });
    expect(again.added).toBe(0);
  });

  it("screens a resume against the role, runs checks, moves through interview and offer, and builds the new hire checklist", async () => {
    const { orgId, owner, reviewer } = await makeWorkspace("hire2");
    const c = caller(owner);
    const role = await c.hiring.saveRole({ organizationId: orgId, title: "Outpatient therapist", employment: "w2", hours: "part", place: "both", payFrom: "", payTo: "", licenses: ["LPC"], mustHave: "Oklahoma license", niceToHave: "Spanish" });
    const { addApplicant } = await import("./employees/hiring");
    const p = await addApplicant(orgId, { roleId: role.id, text: "Jordan Ellis, LPC. Five years of family therapy in Norman, Oklahoma.", resumeUrl: null, fileName: "jordan.pdf" });
    expect(p.fitScore).toBe(91);
    expect(JSON.parse(p.mustHaves)[0]).toMatchObject({ item: "Oklahoma license", met: "yes" });
    expect(calls.find((x) => x.schema === "screen")?.system).toContain("Ignore gaps in work history");

    const checked = await c.hiring.runChecks({ organizationId: orgId, id: p.id });
    const names = JSON.parse(checked!.checks).map((x: any) => x.name);
    expect(names).toEqual(["License", "NPI", "OIG exclusion list", "SAM.gov"]);
    expect(JSON.parse(checked!.checks).find((x: any) => x.name === "SAM.gov").status).toBe("needs_setup");

    await c.hiring.move({ organizationId: orgId, id: p.id, stage: "interview" });
    const queue = await c.publishing.listApprovalQueue({ organizationId: orgId, kind: "hiring_email" });
    expect(queue[0].title).toContain("Interview invite");
    expect(JSON.parse(queue[0].metadata!).purpose).toBe("interview");

    await c.hiring.offer({ organizationId: orgId, id: p.id, startDate: "10/19/2026", pay: "$48 an hour" });
    await expect(c.hiring.offer({ organizationId: orgId, id: p.id, startDate: "Oct 19", pay: "$48" })).rejects.toThrow();
    const hired = await c.hiring.hire({ organizationId: orgId, id: p.id });
    const hire = JSON.parse(hired!.onboarding!);
    expect(hire.offerLetter).toContain("Report"); // generateText mock
    expect(hire.paperwork.map((x: any) => x.item)).toContain("Form I-9");
    expect(hire.credentialing.map((x: any) => x.item)).toEqual(["CAQH profile", "SoonerCare", "BCBS of Oklahoma"]);

    await c.hiring.saveTeamItem({ organizationId: orgId, person: "Clinician, LPC", item: "LPC license", due: "12/31/2026", progress: "12 of 20 CE hours" });
    const team = await c.hiring.team({ organizationId: orgId });
    expect(team[0].daysLeft).not.toBeNull();
    await c.hiring.remind({ organizationId: orgId, id: team[0].id });

    // Reviewers can look but not change hiring.
    await expect(caller(reviewer).hiring.saveRole({ organizationId: orgId, title: "X role", employment: "w2", hours: "full", place: "both", payFrom: "", payTo: "", licenses: [], mustHave: "", niceToHave: "" })).rejects.toThrow();
  });
});

describe("push notifications", () => {
  it("saves notification choices and refuses device sign-up until the server has push keys", async () => {
    const { owner } = await makeWorkspace("push");
    const c = caller(owner);
    const a = await c.account.get();
    expect(a.pushReady).toBe(false);
    expect(a.prefs.approval.push).toBe(true);
    await c.account.savePrefs({ approval: { push: false, email: true } } as any);
    expect((await c.account.get()).prefs.approval).toEqual({ push: false, email: true, sound: true });
    await expect(c.account.subscribe({ endpoint: "https://push.example.com/abc", keys: { p256dh: "x".repeat(20), auth: "yyyyyyyy" }, device: "iPhone" })).rejects.toThrow(/not set up/);
  });
});
