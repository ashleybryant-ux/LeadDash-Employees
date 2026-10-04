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
    return {} as any;
  });
}

async function connect(orgId: number, provider: "clickup" | "google_workspace" | "zoom", settings: any = {}) {
  await db.upsertExternalConnection({ organizationId: orgId, provider, accountLabel: provider, status: "connected", settings: JSON.stringify(settings), secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
}

describe("Nora (Projects)", () => {
  it("plans a launch that waits for approval, then creates the ClickUp list and tasks", async () => {
    mockAi();
    const { orgId, owner } = await makeWorkspace("pm-plan");
    await connect(orgId, "clickup", { teamId: "9", teamName: "LeadDash", userId: 7, spaces: [{ id: "s1", name: "Marketing" }], spaceId: "s1", spaceName: "Marketing" });
    routes.push([/\/space\/s1\/list$/, () => json({ id: "L1", statuses: [] })]);
    routes.push([/\/list\/L1$/, () => json({ id: "L1", statuses: [{ status: "to do", type: "open" }, { status: "complete", type: "closed" }] })]);
    routes.push([/\/team$/, () => json({ teams: [{ id: "9", members: [{ user: { id: 7, email: "owner@pm-plan.test", username: "Ashley" } }] }] })]);
    let n = 0;
    routes.push([/\/list\/L1\/task$/, () => json({ id: `T${++n}`, url: `https://app.clickup.com/t/T${n}`, status: { status: "to do" } })]);
    routes.push([/\/list\/L1\/task\?/, () => json({ tasks: [{ id: "T1", status: { status: "complete", type: "closed" }, date_closed: String(Date.now()) }], last_page: true })]);

    const r = await projects.planLaunch(orgId, { date: ymd(20), brief: "20 demos by launch day" });
    expect(r.auto).toBe(false);
    expect(r.launch.status).toBe("planning");
    const tasks = await db.listLaunchTasks(r.launch.id, orgId);
    expect(tasks.map((t) => t.ownerName)).toEqual(["Jordan", "Ashley Bryant", "Theo"]);
    expect(calls.some((c) => c.url.includes("clickup"))).toBe(false);

    const c = caller(owner);
    const a = await c.projects.approvePlan({ organizationId: orgId, id: r.launch.id });
    expect(a.launch.status).toBe("active");
    expect(a.launch.clickupListUrl).toBe("https://app.clickup.com/9/v/li/L1");
    expect(calls.filter((x) => /\/list\/L1\/task$/.test(x.url))).toHaveLength(3);
    const first = JSON.parse(calls.find((x) => /\/list\/L1\/task$/.test(x.url))!.init.body);
    expect(first.assignees).toEqual([7]);

    const v = await c.projects.launch({ organizationId: orgId, id: r.launch.id });
    expect(v.tasks.find((t) => t.title === "Pricing page")!.state.key).toBe("done");
    expect(v.kpis.map((k) => k.counted)).toEqual(["Malik: demos booked", "You enter it"]);
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
    expect(items.map((i: any) => i.status)).toEqual(["task", "task"]);
    expect((await db.listLaunchTasks(r.launch.id, orgId)).some((t) => t.source === `meeting:${m.id}` && t.ownerName === "Jada")).toBe(true);
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
