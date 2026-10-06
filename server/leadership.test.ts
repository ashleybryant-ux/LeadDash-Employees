import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as projects from "./employees/projects";
import * as coo from "./employees/coo";
import { saveOps } from "./employees/ops";
import { saveAutonomy } from "./employees/team";
import { encryptJson } from "./_core/crypto";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let llm: typeof import("./_core/llm");

beforeEach(async () => {
  calls = [];
  routes = [];
  integrations.setPollMs(0);
  llm = await import("./_core/llm");
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return json({ error: "no route " + url }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function mockAi() {
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "launch_plan")
      return {
        name: "EHR launch",
        milestones: [{ name: "Website ready", date: ymd(10) }, { name: "Launch day", date: ymd(20) }],
        tasks: [
          { title: "Pricing page", details: "Three plans", milestone: 0, owner: "website", date: ymd(2), waitingOn: "" },
          { title: "Approve pricing", details: "", milestone: 0, owner: "Ashley Bryant", date: ymd(8), waitingOn: "" },
          { title: "Launch article", details: "", milestone: 1, owner: "blog", date: ymd(15), waitingOn: "" },
        ],
        kpis: [{ name: "Demos booked", target: 20, unit: "count", source: "demos_booked" }, { name: "Practices signed", target: 8, unit: "count", source: "manual" }],
      } as any;
    if (opts.schemaName === "launch_report") return { overall: "Behind on one task.", done: "Nothing yet.", behind: "Pricing page.", next: "Article.", needsYou: "Approve pricing." } as any;
    if (opts.schemaName === "meeting_agenda") return { items: [{ item: "Numbers for the week", who: "Simone", minutes: 5 }, { item: "Pricing page is late", who: "Nora", minutes: 10 }, { item: "Decisions", who: "Ashley Bryant", minutes: 10 }] } as any;
    if (opts.schemaName === "action_items") return { items: [{ text: "Approve pricing page copy", owner: "Ashley" }, { text: "Test a shorter first email", owner: "Jada" }] } as any;
    if (opts.schemaName === "sort_items") {
      const lines: string[] = String(opts.prompt).split("\n");
      return { items: lines.map((line, index) => {
        const text = line.replace(/^\d+\. /, "");
        if (/pricing/i.test(text)) return { index, project: "EHR launch", title: "Approve the pricing page copy", duplicate: false };
        if (/email/i.test(text)) return { index, project: "Cold email", title: text.replace(/\.$/, ""), duplicate: false };
        if (/webinar/i.test(text)) return { index, project: "November 10 webinar", title: text.replace(/\.$/, "").slice(0, 60), duplicate: false };
        if (/Simone's ClickUp access/i.test(text)) return { index, project: "Team access", title: "Set up Simone's access", duplicate: index > 0 && lines.slice(0, index).some((l) => /Simone's ClickUp access/i.test(l)) };
        return { index, project: "Other", title: text.replace(/\.$/, ""), duplicate: false };
      }) } as any;
    }
    return {} as any;
  });
}

async function connect(orgId: number, provider: "google_workspace" | "zoom", settings: any = {}) {
  await db.upsertExternalConnection({ organizationId: orgId, provider, accountLabel: provider, status: "connected", settings: JSON.stringify(settings), secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
}

describe("Nora (Projects)", () => {
  it("plans a launch that waits for approval, then puts the list and tasks in Projects, and reads what the team closes there", async () => {
    mockAi();
    const { orgId, owner } = await makeWorkspace("pm-plan");
    const r = await projects.planLaunch(orgId, { date: ymd(20), brief: "20 demos by launch day" });
    expect(r.auto).toBe(false);
    expect(r.launch.status).toBe("planning");
    const tasks = await db.listLaunchTasks(r.launch.id, orgId);
    expect(tasks.map((t) => t.ownerName)).toEqual(["Jordan", "Ashley Bryant", "Theo"]);
    expect(db.work.lists.all(orgId)).toHaveLength(0);

    const c = caller(owner);
    const a = await c.projects.approvePlan({ organizationId: orgId, id: r.launch.id });
    expect(a.launch.status).toBe("active");
    expect(a.projects).toBe(true);
    expect(a.error).toBeNull();
    // A Launches folder with one list named after the launch, and a task per launch task with the owner on it.
    const folder = db.work.folders.all(orgId).find((f) => f.name === "Launches")!;
    const list = db.work.lists.get(orgId, a.launch.pjListId!)!;
    expect(list).toMatchObject({ name: "EHR launch", folderId: folder.id });
    const pjTasks = db.work.tasks.all(orgId).filter((t) => t.listId === list.id);
    expect(pjTasks.map((t) => t.name)).toEqual(["Pricing page", "Approve pricing", "Launch article"]);
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    expect(JSON.parse(pjTasks[0].assignees)).toEqual([{ type: "employee", id: jordan.id, name: "Jordan" }]);
    // A person the plan named who isn't on the team here stays by name.
    expect(JSON.parse(pjTasks[1].assignees)).toEqual([{ type: "name", id: 0, name: "Ashley Bryant" }]);
    expect(pjTasks[1].description).toContain("Milestone: Website ready");
    expect((await db.listLaunchTasks(r.launch.id, orgId)).map((t) => t.pjTaskId)).toEqual(pjTasks.map((t) => t.id));

    // Closing the task in Projects counts on the launch; Nora's "Mark done" shows in Projects too.
    const pj = await import("./work/projects");
    await pj.updateTask(orgId, pjTasks[0].id, { status: "complete" }, { type: "user", id: owner.id, name: owner.name });
    const v = await c.projects.launch({ organizationId: orgId, id: r.launch.id });
    expect(v.tasks.find((t) => t.title === "Pricing page")!.state.key).toBe("done");
    expect(v.kpis.map((k) => k.counted)).toEqual(["Malik: demos booked", "You enter it"]);
    await c.projects.markTask({ organizationId: orgId, taskId: tasks[2].id, done: true });
    expect(db.work.tasks.get(orgId, pjTasks[2].id)!.closedAt).not.toBeNull();
    // Moving the launch moves the open task in Projects with it.
    await projects.moveLaunch(orgId, r.launch.id, ymd(27));
    expect(db.work.tasks.get(orgId, pjTasks[1].id)!.dueDate).toBe(ymd(15));
    // Theo got a handoff line about his task.
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    expect((await db.listChatMessages(orgId, theo.id, 5)).some((m) => m.role === "handoff" && /Nora added a task/.test(m.content))).toBe(true);
  });

  it("morning check flags what is behind and the report is written", async () => {
    mockAi();
    const { orgId } = await makeWorkspace("pm-check");
    // Employees starting their own tasks is covered in nora.test.ts; here Nora only chases.
    await saveAutonomy((await db.getEmployeeByKind(orgId, "projects"))!, { assign_work: "ask" });
    const r = await projects.planLaunch(orgId, { date: ymd(20), brief: "Launch" });
    await projects.approvePlan(orgId, r.launch.id, "Ashley");
    const lines = await projects.morningCheck(orgId, { force: true });
    expect(lines?.[0]).toMatch(/1 task behind/);
    const t = (await db.listLaunchTasks(r.launch.id, orgId)).find((x) => x.title === "Pricing page")!;
    expect(t.note).toMatch(/reminded Jordan/);
    const rep = await projects.weeklyReport(orgId, r.launch.id);
    expect(rep.status).toBe("behind");
  });
});

describe("Nora's Projects tab", () => {
  it("sorts action items into projects, merges duplicates, resolves role names, lists project cards, moves a task, and sorts the old catch-all list once", async () => {
    mockAi();
    const { orgId, owner } = await makeWorkspace("pm-sort");
    const c = caller(owner);
    // The old catch-all list from before, with a duplicate and an owner written as a role.
    const old = await db.createLaunch({ organizationId: orgId, name: projects.TEAM_ITEMS, launchDate: new Date(Date.now() + 90 * 86_400_000), status: "active", brief: "", approvedBy: "Nora", approvedAt: new Date() });
    const mk = (title: string, owner: string) => db.createLaunchTask({ organizationId: orgId, launchId: old.id, milestoneId: null, title, ownerType: "person", ownerKind: null, ownerName: owner, ownerEmail: null, dueDate: new Date(Date.now() + 86_400_000), source: "meeting:1" });
    await mk("Build the full project plan for the November 10 webinar in ClickUp today.", "Nora");
    await mk("Set up Simone's ClickUp access", "project_manager");
    await mk("Set up Simone's ClickUp access once Avery has access", "Avery");
    await mk("Approve the pricing page copy", "Ashley");
    expect(await projects.sortTeamItems(orgId)).toBe(3);
    expect(await projects.sortTeamItems(orgId)).toBeNull(); // only once
    const cards = await c.projects.launches({ organizationId: orgId });
    expect(cards.map((x) => [x.name, x.ongoing, x.total]).sort()).toEqual([["EHR launch", true, 1], ["November 10 webinar", true, 1], ["Team access", true, 1]]);
    expect((await db.getLaunch(old.id, orgId))!.status).toBe("dropped");
    const access = (await db.listLaunchTasks(cards.find((x) => x.name === "Team access")!.id, orgId))[0];
    expect(access).toMatchObject({ title: "Set up Simone's access", ownerType: "employee", ownerName: "Nora", details: "Set up Simone's ClickUp access" });
    // Every project is a list in Projects' Launches folder with its task.
    const folder = db.work.folders.all(orgId).find((f) => f.name === "Launches")!;
    expect(db.work.lists.all(orgId).filter((l) => l.folderId === folder.id).map((l) => l.name).sort()).toEqual(["EHR launch", "November 10 webinar", "Team access"]);

    // A new project by hand, then a task moved into it (here and in Projects).
    const made = await c.projects.saveProject({ organizationId: orgId, name: "Spring open house", brief: "", launchDate: "03/14/2027" });
    const spring = (await db.getLaunch(made.id, orgId))!;
    expect(spring.ongoing).toBe(false);
    await expect(c.projects.saveProject({ organizationId: orgId, name: "spring open house" })).rejects.toThrow(/already a project/);
    await c.projects.moveTask({ organizationId: orgId, taskId: access.id, launchId: spring.id });
    expect((await db.getLaunchTask(access.id, orgId))!.launchId).toBe(spring.id);
    expect(db.work.tasks.get(orgId, (await db.getLaunchTask(access.id, orgId))!.pjTaskId!)!.listId).toBe(spring.pjListId);
    const after = await c.projects.launches({ organizationId: orgId });
    expect(after[0].name).toBe("Spring open house"); // launches with a date come before ongoing projects
    expect(after.map((x) => x.name).sort()).toEqual(["EHR launch", "November 10 webinar", "Spring open house", "Team access"]);
    // Setting a date on an ongoing project turns it into a launch; a bad date is refused.
    const web = cards.find((x) => x.name === "November 10 webinar")!;
    await c.projects.saveProject({ organizationId: orgId, id: web.id, name: "November 10 webinar", launchDate: "11/10/2026" });
    expect((await db.getLaunch(web.id, orgId))!.ongoing).toBe(false);
    await expect(c.projects.saveProject({ organizationId: orgId, id: web.id, name: "November 10 webinar", launchDate: "Nov 10" })).rejects.toThrow(/MM\/DD\/YYYY/);
  });
});

describe("Simone (COO)", () => {
  it("makes the repeating meeting, writes the agenda, sends the invite with a Meet link, and turns notes into tasks for Nora", async () => {
    mockAi();
    const { orgId, owner } = await makeWorkspace("coo");
    await connect(orgId, "google_workspace");
    routes.push([/calendar\/v3\/calendars\/primary\/events\?sendUpdates=all&conferenceDataVersion=1/, () => json({ id: "ev1", htmlLink: "https://calendar.google.com/e/1", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } })]);
    routes.push([/gmail\.googleapis\.com/, () => json({ id: "m1", threadId: "t1" })]);
    const email = (await db.listMembers(orgId))[0].email;
    await saveOps(orgId, { recurring: [{ id: "s1", name: "Weekly leadership meeting", day: new Date(Date.now() + 2 * 86_400_000).getDay(), time: "09:00", minutes: 45, attendees: [email], updatesFrom: ["projects"] }] });
    const made = await coo.ensureMeetings(orgId);
    expect(made).toHaveLength(1);
    expect(await coo.ensureMeetings(orgId)).toHaveLength(0);

    const c = caller(owner);
    const m = await coo.buildAgenda(orgId, made[0].id);
    expect(JSON.parse(m.agenda!).map((a: any) => a.at)).toEqual(["9:00", "9:05", "9:15"]);
    const sent = await c.coo.sendInvite({ organizationId: orgId, id: m.id });
    expect(sent.link).toBe("https://meet.google.com/abc-defg-hij");
    const ev = JSON.parse(calls.find((x) => x.url.includes("conferenceDataVersion=1"))!.init.body);
    expect(ev.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(ev.attendees).toEqual([{ email }]);

    // A launch is active, so action items become Nora's tasks.
    const r = await projects.planLaunch(orgId, { date: ymd(20), brief: "Launch" });
    await projects.approvePlan(orgId, r.launch.id, "Ashley");
    const after = await c.coo.saveNotes({ organizationId: orgId, id: m.id, notes: "Ashley approves pricing. Jada tests a shorter email." });
    const items = JSON.parse(after.actionItems!);
    expect(items.map((i: any) => i.status)).toEqual(["in_projects", "in_projects"]);
    // Each item went to the project it is about: pricing to the launch, the email test to a new ongoing project, both in Projects.
    const launch = (await db.getLaunch(r.launch.id, orgId))!;
    expect(db.work.tasks.all(orgId).filter((t) => t.listId === launch.pjListId).map((t) => t.name)).toContain("Approve the pricing page copy");
    const cold = (await db.listLaunches(orgId)).find((l) => l.name === "Cold email")!;
    expect(cold).toMatchObject({ ongoing: true, status: "active" });
    expect(cold.sourceNote).toMatch(/^started from Weekly leadership meeting on /);
    expect(db.work.tasks.all(orgId).filter((t) => t.listId === cold.pjListId).map((t) => t.name)).toEqual(["Test a shorter first email"]);
    expect((await db.listLaunchTasks(cold.id, orgId)).some((t) => t.source === `meeting:${m.id}` && t.ownerName === "Jada")).toBe(true);
    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    expect((await db.listChatMessages(orgId, jada.id, 5)).some((x) => x.role === "handoff" && /shorter first email/.test(x.content))).toBe(true);

    await c.coo.sendRecap({ organizationId: orgId, id: m.id });
    expect(calls.some((x) => x.url.includes("gmail.googleapis.com"))).toBe(true);
  });

  it("keeps a scorecard with goals set from chat", async () => {
    const { orgId, owner } = await makeWorkspace("coo-score");
    await coo.setGoal(orgId, "demos_booked", 4);
    const card = await caller(owner).coo.scorecard({ organizationId: orgId, weeksBack: 0 });
    const demos = card.rows.find((r) => r.key === "demos_booked")!;
    expect(demos.goal).toBe(4);
    expect(demos.thisWeek).toBe(0);
    expect(demos.met).toBe(false);
  });
});
