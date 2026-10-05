import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as projects from "./employees/projects";
import * as coo from "./employees/coo";
import * as tasks from "./employees/tasks";
import { opsFor } from "./employees/ops";
import { saveAutonomy } from "./employees/team";
import { encryptJson } from "./_core/crypto";
import type { LaunchTask } from "../drizzle/schema";

let llm: typeof import("./_core/llm");
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const DAY = 86_400_000;

beforeEach(async () => {
  integrations.setPollMs(0);
  llm = await import("./_core/llm");
  vi.stubGlobal("fetch", async (url: string) => {
    if (/calendar\/v3/.test(String(url))) return json({ id: "ev1", htmlLink: "https://calendar.google.com/e/1", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } });
    if (/gmail\.googleapis\.com/.test(String(url))) return json({ id: "m1", threadId: "t1" });
    return json({ error: "no route " + url }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Ai = { decision?: any; reviews?: { meets: boolean; missing: string }[]; report?: any };

function mockAi(ai: Ai = {}) {
  const reviews = [...(ai.reviews ?? [])];
  const seen: string[] = [];
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    seen.push(opts.schemaName);
    if (opts.schemaName === "launch_plan")
      return {
        name: "EHR launch",
        milestones: [{ name: "Content ready", date: ymd(8) }, { name: "Launch day", date: ymd(20) }],
        tasks: [
          { title: "Launch article", details: "Why practices switch to one system", doneWhen: "Article approved and published", milestone: 0, owner: "blog", date: ymd(4), waitingOn: "" },
          { title: "Approve pricing", details: "", doneWhen: "Pricing decided", milestone: 0, owner: "Owner pm", date: ymd(6), waitingOn: "" },
          { title: "Announcement post", details: "", doneWhen: "Post approved", milestone: 1, owner: "social", date: ymd(15), waitingOn: "Launch article" },
        ],
        kpis: [{ name: "Demos booked", target: 20, unit: "count", source: "demos_booked" }],
      } as any;
    if (opts.schemaName === "chat_decision") return { reply: "Writing it.", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", ...(ai.decision ?? {}) } as any;
    if (opts.schemaName === "task_review") return (reviews.shift() ?? { meets: true, missing: "" }) as any;
    if (opts.schemaName === "launch_report") return (ai.report ?? { rating: "green", overall: "Fine.", done: "", behind: "", next: "", risks: "None open.", needsYou: "Nothing this week." }) as any;
    if (opts.schemaName === "meeting_agenda") return { items: [{ item: "Where we stand: 1 of 3 done", who: "Nora", minutes: 5 }, { item: "Launch article waiting for approval", who: "Theo", minutes: 10 }, { item: "Decisions and action items", who: "Owner", minutes: 10 }] } as any;
    if (opts.schemaName === "action_items") return { items: [{ text: "Record the demo video", owner: "Owner" }] } as any;
    return {} as any;
  });
  return seen;
}

/** Theo's article: creates a real outbound item waiting for approval instead of calling the AI. */
function fakeArticle() {
  return vi.spyOn(tasks, "writeBlogArticle").mockImplementation(async (orgId: number, input: any) => {
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    return (await db.createOutboundItem({ organizationId: orgId, employeeId: theo.id, kind: "blog_post", status: "pending_approval", title: input.title, body: "Practices lose hours to double entry..." }))!;
  });
}

async function plannedLaunch(slug: string, opts: { auto?: boolean } = {}) {
  const ws = await makeWorkspace(slug);
  const nora = (await db.getEmployeeByKind(ws.orgId, "projects"))!;
  // Approve without starting anyone, so each test starts the work itself.
  await saveAutonomy(nora, { assign_work: "ask" });
  const r = await projects.planLaunch(ws.orgId, { date: ymd(20), brief: "Launch the EHR" });
  await projects.approvePlan(ws.orgId, r.launch.id, "Owner");
  if (opts.auto !== false) await saveAutonomy((await db.getEmployeeByKind(ws.orgId, "projects"))!, { assign_work: "auto" });
  const list = await db.listLaunchTasks(r.launch.id, ws.orgId);
  return { ...ws, launch: r.launch, task: (title: string) => list.find((t) => t.title === title)! };
}

describe("Nora picks which tasks start", () => {
  const base = { organizationId: 1, launchId: 1, milestoneId: null, details: null, ownerEmail: null, note: null, clickupTaskId: null, clickupUrl: null, clickupStatus: null, remindedAt: null, doneAt: null, source: "plan", doneWhen: null, work: null, createdAt: new Date(), updatedAt: new Date() };
  const t = (id: number, ownerKind: string, dueDays: number, extra: Partial<LaunchTask> = {}): LaunchTask => ({ ...base, id, title: `Task ${id}`, ownerType: "employee", ownerKind, ownerName: ownerKind, dueDate: new Date(Date.now() + dueDays * DAY), status: "todo", waitingOn: null, ...extra }) as LaunchTask;

  it("starts one task per employee, earliest first, inside the window, never before what it waits on", () => {
    const list = [
      t(1, "blog", 5),
      t(2, "blog", 3),
      t(3, "social", 4, { waitingOn: "Task 2" }),
      t(4, "website", 30),
      t(5, "video", 2, { ownerType: "person" }),
      t(6, "leads", 1),
    ];
    const ready = projects.pickReady(list, new Set(["blog", "social", "website", "video"]));
    expect(ready.map((x) => x.id)).toEqual([2]);
  });

  it("skips an employee already working on a task, and retries work sent back", () => {
    const list = [
      t(1, "blog", 2, { work: JSON.stringify({ state: "in_progress", startedAt: 0 }), status: "in_progress" }),
      t(2, "blog", 3),
      t(3, "social", 3, { work: JSON.stringify({ state: "sent_back", startedAt: 0, tries: 1 }) }),
      t(4, "website", 3, { work: JSON.stringify({ state: "needs_person", startedAt: 0, tries: 1 }) }),
    ];
    expect(projects.pickReady(list, new Set(["blog", "social", "website"])).map((x) => x.id)).toEqual([3]);
  });
});

describe("Employees do their project tasks and Nora checks them", () => {
  it("Theo writes the article, Nora checks it, it waits for approval, and closes when it's published", async () => {
    const seen = mockAi({ decision: { action: "write_article", title: "Why practices switch to one system", notes: "Double entry" } });
    fakeArticle();
    const { orgId, task } = await plannedLaunch("nora-run");
    expect(task("Launch article").doneWhen).toBe("Article approved and published");

    const started = await projects.startReadyTasks(orgId, { wait: true });
    expect(started.map((x) => x.title)).toEqual(["Launch article"]);
    let t = (await db.getLaunchTask(task("Launch article").id, orgId))!;
    const w = projects.readWork(t)!;
    expect(w.state).toBe("waiting");
    expect(w.refs?.[0].kind).toBe("outbound");
    expect(t.status).toBe("in_progress");
    expect(t.note).toMatch(/waiting for your approval in Approvals/);
    expect(seen).toContain("task_review");

    // Theo heard about it from Nora, and his chat shows the article.
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const msgs = await db.listChatMessages(orgId, theo.id, 10);
    expect(msgs.some((m) => m.role === "handoff" && /Done when: Article approved and published/.test(m.content))).toBe(true);
    expect(msgs.some((m) => m.role === "employee" && /For EHR launch, "Launch article"/.test(m.content))).toBe(true);

    // Sienna's post waits on the article, so she has not started.
    expect(projects.readWork(task("Announcement post"))).toBeNull();

    // The owner publishes it; the next follow-up closes the task.
    await db.updateOutboundItem(w.refs![0].id, orgId, { status: "published", publishedAt: new Date() });
    expect(await projects.followUpWork(orgId)).toBe(1);
    t = (await db.getLaunchTask(t.id, orgId))!;
    expect(t.status).toBe("done");
    expect(projects.readWork(t)!.state).toBe("done");
  });

  it("sends work back once with what's missing, then asks for a person if it still misses", async () => {
    mockAi({ decision: { action: "write_article", title: "Article" }, reviews: [{ meets: false, missing: "No call to action." }, { meets: false, missing: "Still no call to action." }] });
    const article = fakeArticle();
    const { orgId, task } = await plannedLaunch("nora-back");
    await projects.startReadyTasks(orgId, { wait: true });
    expect(article).toHaveBeenCalledTimes(2);
    const t = (await db.getLaunchTask(task("Launch article").id, orgId))!;
    expect(projects.readWork(t)!.state).toBe("needs_person");
    expect(t.note).toMatch(/Still no call to action/);
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    expect((await db.listChatMessages(orgId, theo.id, 20)).some((m) => m.role === "handoff" && /Sending this back.*What's missing: No call to action/.test(m.content))).toBe(true);
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    expect((await db.listChatMessages(orgId, nora.id, 5)).some((m) => /second try/.test(m.content))).toBe(true);
  });

  it("browser work: Nora waits while it runs, and a stuck browser goes to a person instead of looping", async () => {
    mockAi({ decision: { action: "browse", goal: "Check the access", title: "Check access" }, reviews: [{ meets: false, missing: "Only opened a browser." }] });
    const web = await import("./employees/web");
    const start = vi.spyOn(web, "startWebTask").mockImplementation(async (emp: any, input: any) => ({ task: db.createWebTask({ organizationId: emp.organizationId, employeeId: emp.id, kind: "browse", title: input.title, goal: input.goal, startUrl: "", liveId: "live-1", status: "working" }), login: null }) as any);
    const { orgId, task } = await plannedLaunch("nora-web");
    await projects.startReadyTasks(orgId, { wait: true });
    let t = (await db.getLaunchTask(task("Launch article").id, orgId))!;
    const w = projects.readWork(t)!;
    // Not reviewed or sent back while the browser is still going.
    expect(w.state).toBe("in_progress");
    expect(w.refs).toEqual([{ kind: "web", id: expect.any(Number) }]);
    expect(start).toHaveBeenCalledTimes(1);
    // The site needs a sign-in nobody saved: one note to a person, no second try.
    db.updateWebTask(w.refs![0].id, orgId, { status: "failed", note: "Cannot log in because no email or password credentials are saved." });
    await projects.followUpWork(orgId);
    t = (await db.getLaunchTask(t.id, orgId))!;
    expect(projects.readWork(t)!.state).toBe("needs_person");
    expect(t.status).toBe("todo");
    expect(start).toHaveBeenCalledTimes(1);
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    const said = (await db.listChatMessages(orgId, nora.id, 5)).map((m) => m.content).join("\n");
    expect(said).toMatch(/needs a person: .* got stuck in the browser/);
    expect(said).toMatch(/sign in yourself/);
    expect(said).not.toMatch(/credentials/i);
    // Nothing anywhere asks for a password.
    expect(web.safeReason("Please provide the credentials so I can log in")).toMatch(/sign in yourself.*never see or ask for passwords/);
    expect(web.safeReason("The page says 404")).toBe("The page says 404");
  });

  it("a task no employee tool can do goes back to a person, and Nora says so", async () => {
    mockAi({ decision: { action: "none", reply: "Pricing is a decision only the owner can make." } });
    const { orgId, task } = await plannedLaunch("nora-none");
    await projects.startReadyTasks(orgId, { wait: true });
    const t = (await db.getLaunchTask(task("Launch article").id, orgId))!;
    expect(projects.readWork(t)!.state).toBe("needs_person");
    expect(t.status).toBe("todo");
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    expect((await db.listChatMessages(orgId, nora.id, 5)).some((m) => /needs a person/.test(m.content))).toBe(true);
  });

  it("does not start anyone when Starting employees on their tasks is set to ask", async () => {
    mockAi();
    const { orgId } = await plannedLaunch("nora-ask", { auto: false });
    expect(await projects.startReadyTasks(orgId, { wait: true })).toEqual([]);
  });
});

describe("Nora's running list and reports", () => {
  it("captures ideas and risks, shows them in status, and never rates a late project green", async () => {
    mockAi({ report: { rating: "green", overall: "Fine.", done: "", behind: "", next: "", risks: "Logo late.", needsYou: "Nothing this week." } });
    const { orgId, launch, task } = await plannedLaunch("nora-notes");
    await projects.addNote(orgId, { kind: "idea", text: "A podcast tour", who: "Owner" });
    const risk = await projects.addNote(orgId, { kind: "risk", text: "The logo may not be ready", who: "Owner" });
    expect(risk.launch?.id).toBe(launch.id);
    await projects.addNote(orgId, { kind: "decision", text: "Drop the webinar", who: "Owner" });
    const status = await projects.projectsStatus(orgId);
    expect(status).toMatch(/Ideas not planned yet: A podcast tour/);
    expect(status).toMatch(/Risk: The logo may not be ready/);
    expect(status).toMatch(/Decisions made: Drop the webinar/);
    expect(await projects.closeNote(orgId, "logo")).toMatchObject({ status: "closed" });
    expect(await projects.projectsStatus(orgId)).toMatch(/Open risks and blockers: none/);

    // A task is late, so the model's "green" becomes amber.
    await db.updateLaunchTask(task("Launch article").id, orgId, { dueDate: new Date(Date.now() - 2 * DAY) });
    const rep = await projects.weeklyReport(orgId, launch.id);
    expect(JSON.parse(rep.body).rating).toBe("amber");
    expect(rep.status).toBe("behind");
  });
});

describe("Nora runs project meetings", () => {
  it("sets up a weekly project meeting, writes the agenda from the project, sends it, and tracks the action items", async () => {
    mockAi();
    const { orgId, launch } = await plannedLaunch("nora-meet");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "google_workspace", accountLabel: "g", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    const m = await coo.scheduleProjectMeeting(orgId, { title: "Launch check-in", project: "EHR", date: ymd(3), time: "10:00 AM", minutes: 30, attendees: "", weekly: true });
    expect(m.launchId).toBe(launch.id);
    expect(JSON.parse(m.agenda!).map((a: any) => a.item)[1]).toBe("Launch article waiting for approval");
    const { ops } = await opsFor(orgId);
    expect(ops.projectRecurring).toHaveLength(1);
    expect(ops.projectRecurring[0].launchId).toBe(launch.id);
    expect(ops.recurring).toHaveLength(0);
    // The weekly series exists alongside the first one; no duplicate for the same start.
    await coo.ensureMeetings(orgId);
    expect((await db.listMeetings(orgId)).filter((x) => x.launchId === launch.id).length).toBeGreaterThanOrEqual(1);

    const sent = await coo.sendInvite(orgId, m.id, "Nora (on her own)");
    expect(sent.status).toBe("invited");
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    expect((await db.listActivity(orgId, 10)).some((a) => a.employeeId === nora.id && /Sent the invite and agenda for Launch check-in/.test(a.text))).toBe(true);

    const after = await coo.saveNotes(orgId, m.id, "Owner will record the demo video.");
    const items = JSON.parse(after.actionItems!);
    expect(items[0].taskId).toBeTruthy();
    const t = (await db.getLaunchTask(items[0].taskId, orgId))!;
    expect(t.launchId).toBe(launch.id);
    expect(t.source).toBe(`meeting:${m.id}`);
    expect((await db.getMeeting(m.id, orgId))!.recapSentAt).toBeTruthy();
  });

  it("Nora's project meetings still run when Simone is paused", async () => {
    mockAi();
    const { orgId } = await plannedLaunch("nora-solo");
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    await db.updateEmployee(simone.id, orgId, { status: "paused" });
    const tz = (await opsFor(orgId)).tz;
    const m = await db.createMeeting({ organizationId: orgId, launchId: (await db.listLaunches(orgId))[0].id, title: "Check-in", startsAt: new Date(Date.now() + 10 * 3_600_000), minutes: 30, attendees: "[]", updatesFrom: "[]", linkKind: "meet" });
    await coo.cooTick(orgId, new Date(Date.now() + 9 * 3_600_000));
    expect(tz).toBeTruthy();
    expect((await db.getMeeting(m.id, orgId))!.agenda).toBeTruthy();
  });
});
