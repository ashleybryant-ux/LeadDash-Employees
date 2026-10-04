import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as dev from "./employees/dev";
import { ENV } from "./_core/env";

let llm: typeof import("./_core/llm");
const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const before = ENV.githubToken;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (ENV as any).githubToken = before;
});

async function mockAi(decision: any, systems: string[] = []) {
  llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "chat_decision") {
      systems.push(opts.system);
      return { ...blank, ...decision } as any;
    }
    if (opts.schemaName === "dev_summary") return { points: ["The Book button is now a plain link, so iPhone Safari opens it.", "Tests pass."] } as any;
    if (opts.schemaName === "welcome_email") return { subject: "Welcome to LeadDash EHR", body: "Hi Margaret,\nWelcome aboard. Your go-live date is set.\nAshley" } as any;
    if (opts.schemaName === "launch_plan")
      return {
        name: "Obsidian onboarding",
        milestones: [{ name: "Kickoff", date: ymd(5) }, { name: "Go live", date: ymd(20) }],
        tasks: [
          { title: "Send the welcome email", details: "", doneWhen: "Welcome email sent", milestone: 0, owner: "onboarding", date: ymd(2), waitingOn: "" },
          { title: "Kickoff call", details: "", doneWhen: "Call held", milestone: 0, owner: "Owner", date: ymd(4), waitingOn: "" },
          { title: "Go-live check-in", details: "", doneWhen: "Check-in done", milestone: 1, owner: "onboarding", date: ymd(20), waitingOn: "" },
        ],
        kpis: [{ name: "Steps on time", target: 100, unit: "percent", source: "tasks_on_time" }],
      } as any;
    return {} as any;
  });
}

describe("Kai, the developer", () => {
  it("writes the fix up for Claude as an issue, opens the pull request when Claude finishes, and merges only when the owner says", async () => {
    (ENV as any).githubToken = "gh-test";
    const calls: { url: string; init: any }[] = [];
    let finished = false;
    vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
      const u = String(url).replace("https://api.github.com", "");
      calls.push({ url: u, init });
      if (u === "/repos/ashleybryant-ux/LeadDash-Employees/issues" && init.method === "POST") return json({ number: 42, html_url: "https://github.com/ashleybryant-ux/LeadDash-Employees/issues/42" });
      if (u.startsWith("/repos/ashleybryant-ux/LeadDash-Employees/issues/42/comments")) return json(finished ? [{ id: 9, body: "**Claude finished @ashley's task** in 3m. Made the Book button a plain link. Tests pass.", user: { login: "claude[bot]", type: "Bot" } }] : [{ id: 8, body: "Claude is working…", user: { login: "claude[bot]", type: "Bot" } }]);
      if (u.startsWith("/repos/ashleybryant-ux/LeadDash-Employees/pulls?state=open")) return json([]);
      if (u.startsWith("/repos/ashleybryant-ux/LeadDash-Employees/branches")) return json([{ name: "main" }, { name: "claude/issue-42-20261004" }]);
      if (u === "/repos/ashleybryant-ux/LeadDash-Employees") return json({ default_branch: "main" });
      if (u === "/repos/ashleybryant-ux/LeadDash-Employees/pulls" && init.method === "POST") return json({ number: 43, html_url: "https://github.com/ashleybryant-ux/LeadDash-Employees/pull/43", head: { ref: "claude/issue-42-20261004", sha: "abc" } });
      if (u.startsWith("/repos/ashleybryant-ux/LeadDash-Employees/pulls/43/files")) return json([{ filename: "server/employees/pages.ts" }, { filename: "server/pages.test.ts" }]);
      if (u.startsWith("/repos/ashleybryant-ux/LeadDash-Employees/commits/abc/check-runs")) return json({ check_runs: [] });
      if (u === "/repos/ashleybryant-ux/LeadDash-Employees/pulls/43/merge") return json({ merged: true });
      return json({ message: "no route " + u }, 404);
    });
    const { orgId, owner } = await makeWorkspace("kai");
    const kai = (await db.getEmployeeByKind(orgId, "developer"))!;
    expect(kai.name).toBe("Kai");
    const systems: string[] = [];
    await mockAi({ action: "fix_code", target: "LeadDash Employees", title: "Book button does nothing on iPhone", notes: "On Jordan's landing pages the Book button does nothing in iPhone Safari. Make it a plain link and add a test." }, systems);
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: kai.id, text: "The Book button on Jordan's pages does nothing on my iPhone." });
    expect(systems[0]).toContain("- LeadDash EHR: ashleybryant-ux/leaddash-ehr; cd /home/ssm-user/server && ./deploy.sh");
    expect(r.reply.content).toMatch(/^I wrote it up for Claude in LeadDash Employees/);
    const issue = JSON.parse(calls.find((c) => c.url.endsWith("/issues") && c.init.method === "POST")!.init.body);
    expect(issue.title).toBe("Book button does nothing on iPhone");
    expect(issue.body.startsWith("@claude On Jordan's landing pages")).toBe(true);
    expect(issue.body).toContain("never add or log client or patient data");
    const id = JSON.parse(r.reply.cards!)[0].id;

    // Claude still working: nothing changes.
    await dev.devTicks();
    expect(db.getDevChange(id, orgId)!.status).toBe("working");
    finished = true;
    await dev.devTicks();
    const ready = db.getDevChange(id, orgId)!;
    expect(ready).toMatchObject({ status: "ready", prNumber: 43, files: 2 });
    const pr = JSON.parse(calls.find((c) => c.url.endsWith("/pulls") && c.init.method === "POST")!.init.body);
    expect(pr).toMatchObject({ head: "claude/issue-42-20261004", base: "main" });
    expect(pr.body).not.toContain("@claude");
    const posted = (await db.listChatMessages(orgId, kai.id)).at(-1)!;
    expect(posted.content).toBe('The fix for "Book button does nothing on iPhone" is ready for you. Claude changed 2 files. Nothing is live until you merge it and run the deploy.');
    // Running the check again doesn't post twice.
    await dev.devTicks();
    expect((await db.listChatMessages(orgId, kai.id)).length).toBe(3);

    const merged = await caller(owner).dev.merge({ organizationId: orgId, id });
    expect(merged).toMatchObject({ status: "merged", deploy: "cd /home/ssm-user/employees && ./deploy.sh" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/pulls/43/merge"))!.init.body).merge_method).toBe("squash");
  });

  it("says plainly when GitHub isn't connected", async () => {
    (ENV as any).githubToken = "";
    const { orgId, owner } = await makeWorkspace("kai-off");
    const kai = (await db.getEmployeeByKind(orgId, "developer"))!;
    await mockAi({ action: "fix_code", target: "LeadDash Employees", title: "Fix", notes: "Fix it." });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: kai.id, text: "Fix the thing" });
    expect(r.reply.content).toBe("I couldn't start it: Kai isn't connected to GitHub yet: GITHUB_TOKEN is missing on the server.");
  });
});

describe("Imani, the onboarding specialist", () => {
  it("plans a new customer's onboarding back from go-live for Nora to track and drafts the welcome email for approval", async () => {
    vi.stubGlobal("fetch", async () => json({}, 500));
    const { orgId, owner } = await makeWorkspace("imani");
    const imani = (await db.getEmployeeByKind(orgId, "onboarding"))!;
    expect(imani.name).toBe("Imani");
    const goLive = ymd(20);
    await mockAi({ action: "onboard_customer", title: "Obsidian Therapy Group", to: "Margaret", from: "margaret@obsidian.test", date: goLive });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: "Onboard Obsidian Therapy Group" });
    expect(r.reply.content).toMatch(/^Here's their onboarding plan, worked back from .*: 2 steps and 3 tasks\. Nora will track every step/);
    expect(r.reply.content).toContain("The welcome email is waiting for your OK in Approvals.");
    expect(JSON.parse(r.reply.cards!)[0]).toMatchObject({ type: "launch_plan", title: "Obsidian Therapy Group onboarding" });
    const email = (await db.listOutboundItemsByOrg(orgId, "email_draft")).find((m) => m.employeeId === imani.id)!;
    expect(email).toMatchObject({ status: "pending_approval", title: "Welcome to LeadDash EHR" });
    expect(JSON.parse(email.metadata!).email).toBe("margaret@obsidian.test");

    // Without a go-live date she asks for it.
    await mockAi({ action: "onboard_customer", title: "Another Practice", date: "" });
    const ask = await caller(owner).chat.send({ organizationId: orgId, employeeId: imani.id, text: "Onboard Another Practice" });
    expect(ask.reply.content).toBe("When should they go live?");
  });
});
