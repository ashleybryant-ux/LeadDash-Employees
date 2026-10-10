import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as goals from "./work/goals";
import * as pj from "./work/projects";
import { cycleOf, isGoalTask } from "./work/clickupImport";

afterEach(() => vi.restoreAllMocks());

async function waitFor(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("Goals", () => {
  it("rolls quarter goals up to year goals, works out progress, pace and status, and keeps each workspace's goals to itself", async () => {
    const { orgId, owner } = await makeWorkspace("goals-basic");
    const me = caller(owner);
    const year = await me.goals.save({ organizationId: orgId, goal: { title: "$250,000 in revenue", description: "", level: "year", parentId: null, folderId: null, ownerType: "user", ownerId: owner.id, startDate: "2026-01-01", dueDate: "2026-12-31", period: "2026", color: "#1b6b4a", status: null, manualProgress: null, targets: [{ kind: "currency", name: "Revenue collected", startValue: 0, currentValue: 131900, targetValue: 250000, done: false, listId: null, measureId: null }] } });
    const q = await me.goals.save({ organizationId: orgId, goal: { title: "40 new paying practices", description: "", level: "quarter", parentId: year.id, folderId: null, ownerType: null, ownerId: null, startDate: "2026-10-01", dueDate: "2026-12-31", period: "Q4 2026", color: "#2563eb", status: null, manualProgress: null, targets: [{ kind: "number", name: "Paying practices", startValue: 0, currentValue: 13, targetValue: 40, done: false, listId: null, measureId: null }, { kind: "boolean", name: "Founding offer live", startValue: 0, currentValue: 0, targetValue: 0, done: true, listId: null, measureId: null }] } });
    let o = await me.goals.overview({ organizationId: orgId });
    const yr = o.goals.find((g) => g.goal.id === year.id)!;
    expect(yr.progress).toBe(53); // 131,900 of 250,000
    expect(yr.forecast).toMatchObject({ kind: "currency", current: 131900, target: 250000 });
    const qr = o.goals.find((g) => g.goal.id === q.id)!;
    expect(qr.progress).toBe(66); // (13/40 + 1) / 2
    expect(qr.goal.parentId).toBe(year.id);
    expect(["on", "risk", "off", "done"]).toContain(qr.status);
    // The owner's own call wins; an update counts too.
    await me.goals.addUpdate({ organizationId: orgId, goalId: q.id, status: "risk", body: "Demos are down this week.", fileIds: [] });
    o = await me.goals.overview({ organizationId: orgId });
    expect(o.goals.find((g) => g.goal.id === q.id)!.status).toBe("risk");
    expect(o.goals.find((g) => g.goal.id === q.id)!.lastUpdate).toMatchObject({ author: owner.name, body: "Demos are down this week." });
    // A new value is kept in the target's history for the chart.
    const target = o.goals.find((g) => g.goal.id === year.id)!.targets[0];
    await me.goals.setTarget({ organizationId: orgId, targetId: target.id, value: 140000 });
    o = await me.goals.overview({ organizationId: orgId });
    expect(o.goals.find((g) => g.goal.id === year.id)!.progress).toBe(56);
    // Another workspace never sees them.
    const other = await makeWorkspace("goals-other");
    expect((await caller(other.owner).goals.overview({ organizationId: other.orgId })).goals).toHaveLength(0);
    await expect(caller(other.owner).goals.overview({ organizationId: orgId })).rejects.toThrow();
    // Status from pace alone: far behind where it should be is off track.
    const g = db.work.goals.get(orgId, year.id)!;
    expect(goals.statusOf(g, 10, "2026-10-05", null)).toBe("off");
    expect(goals.statusOf(g, 74, "2026-10-05", null)).toBe("on");
    expect(goals.statusOf(g, 60, "2026-10-05", null)).toBe("risk");
  });

  it("keeps a weekly scorecard: typed-in numbers, three statuses, and three weeks under goal is off track", async () => {
    const { orgId, owner } = await makeWorkspace("goals-score");
    const me = caller(owner);
    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    await me.goals.saveScorecard({ organizationId: orgId, rows: [{ name: "Leads who book a demo", ownerType: "employee", ownerId: jada.id, weeklyGoal: 20, unit: "percent", direction: "up", kind: "leading", source: "manual", goalId: null }, { name: "Reply time to a new lead", ownerType: "employee", ownerId: jada.id, weeklyGoal: 1, unit: "hours", direction: "down", kind: "leading", source: "manual", goalId: null }] });
    let o = await me.goals.overview({ organizationId: orgId });
    const [book, reply] = o.scorecard.rows.map((r) => r.measure);
    const w = o.scorecard.thisWeek;
    for (const [i, v] of [15, 14, 19].entries()) await me.goals.setValue({ organizationId: orgId, measureId: book.id, weekStart: goals.addDays(w, -7 * (2 - i)), value: v });
    await me.goals.setValue({ organizationId: orgId, measureId: reply.id, weekStart: w, value: 1.05 });
    o = await me.goals.overview({ organizationId: orgId });
    expect(o.scorecard.rows[0]).toMatchObject({ value: 19, status: "off" }); // within 10% but 3 weeks under
    expect(o.scorecard.rows[1]).toMatchObject({ value: 1.05, status: "risk" });
    expect(o.scorecard.rows[0].owner?.name).toBe(jada.name);
    expect(goals.measureStatus(20, 20, "up", [10, 10])).toBe("on");
    // Removing a row in Edit takes it off the scorecard.
    await me.goals.saveScorecard({ organizationId: orgId, rows: [{ id: book.id, name: "Leads who book a demo", ownerType: "employee", ownerId: jada.id, weeklyGoal: 20, unit: "percent", direction: "up", kind: "leading", source: "manual", goalId: null }] });
    expect((await me.goals.overview({ organizationId: orgId })).scorecard.rows.map((r) => r.measure.name)).toEqual(["Leads who book a demo"]);
  });

  it("Simone reads the week, suggests a goal for the owner's OK, and drafts next year's goals as drafts", async () => {
    const { orgId, owner } = await makeWorkspace("goals-simone");
    const me = caller(owner);
    await me.goals.save({ organizationId: orgId, goal: { title: "$250,000 in revenue", description: "", level: "year", parentId: null, folderId: null, ownerType: "user", ownerId: owner.id, startDate: "2026-01-01", dueDate: "2026-12-31", period: "2026", color: "#1b6b4a", status: null, manualProgress: null } });
    await me.goals.saveScorecard({ organizationId: orgId, rows: [{ name: "Leads who book a demo", ownerType: null, ownerId: null, weeklyGoal: 20, unit: "percent", direction: "up", kind: "leading", source: "manual", goalId: null }] });
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "goal_read")
        return { note: "1 off track: leads who book a demo.", items: [{ status: "off", text: "Only 14% of leads book a demo.", action: "ask", goal: "", measure: "Leads who book a demo", employee: "Jada" }], suggest: [{ title: "Answer every new lead within an hour", why: "Leads who book a demo has been under 20% for 3 weeks.", dueDate: "2026-12-31", parentGoal: "$250,000 in revenue", measure: "Leads who book a demo" }] } as any;
      if (opts.schemaName === "year_draft") return { goals: [{ title: "$420,000 in revenue", why: "2026 is on pace for $255,000.", owner: owner.name, target: 420000, unit: "currency", targetName: "Revenue collected" }] } as any;
      return {} as any;
    });
    await me.goals.refreshRead({ organizationId: orgId });
    let o = await me.goals.overview({ organizationId: orgId });
    expect(o.read).toMatchObject({ note: "1 off track: leads who book a demo." });
    expect(o.read!.items[0]).toMatchObject({ status: "off", action: "ask:Jada", measureId: o.scorecard.rows[0].measure.id });
    const sug = o.goals.find((g) => g.goal.state === "suggested")!;
    expect(sug.goal).toMatchObject({ title: "Answer every new lead within an hour", level: "quarter", why: "Leads who book a demo has been under 20% for 3 weeks." });
    expect(sug.status).toBeNull();
    expect(sug.targets[0]).toMatchObject({ kind: "measure", targetValue: 20 });
    await me.goals.approve({ organizationId: orgId, id: sug.goal.id });
    expect(db.work.goals.get(orgId, sug.goal.id)).toMatchObject({ state: "active", agreedBy: owner.name });
    // Next year's draft.
    expect(await me.goals.draftYear({ organizationId: orgId, year: 2027 })).toEqual({ drafted: 1 });
    o = await me.goals.overview({ organizationId: orgId });
    const draft = o.goals.find((g) => g.goal.state === "draft")!;
    expect(draft.goal).toMatchObject({ title: "$420,000 in revenue", period: "2027", startDate: "2027-01-01", dueDate: "2027-12-31", ownerType: "user", ownerId: owner.id });
    expect(draft.targets[0]).toMatchObject({ kind: "currency", targetValue: 420000 });
    // A member can't approve; the owner can dismiss.
    const m = await makeUser("member@goals-simone.test");
    await db.addOrganizationMember({ organizationId: orgId, userId: m.id, role: "member" });
    await expect(caller(m).goals.approve({ organizationId: orgId, id: draft.goal.id })).rejects.toThrow(/role/);
    await me.goals.dismiss({ organizationId: orgId, id: draft.goal.id });
    expect(db.work.goals.get(orgId, draft.goal.id)!.state).toBe("dismissed");
    // Topics for the next meeting.
    expect(await me.goals.addTopic({ organizationId: orgId, text: "Demos held is off track" })).toEqual({ count: 1 });
  });

  it("attaches files to a goal and puts goals in folders", async () => {
    const { orgId, owner } = await makeWorkspace("goals-files");
    const me = caller(owner);
    const folder = await me.goals.saveFolder({ organizationId: orgId, name: "Revenue", color: "#1b6b4a", parentId: null });
    const g = await me.goals.save({ organizationId: orgId, goal: { title: "Launch the founding member offer", description: "", level: "quarter", parentId: null, folderId: folder!.id, ownerType: null, ownerId: null, startDate: "2026-10-01", dueDate: "2026-10-31", period: "Q4 2026", color: "#1b6b4a", status: null, manualProgress: 70 } });
    const f = db.createChatFile({ organizationId: orgId, employeeId: 0, userId: owner.id, name: "Offer terms.pdf", mime: "application/pdf", size: 10, kind: "document", fileUrl: "/files/x.pdf", text: "" });
    await me.goals.attach({ organizationId: orgId, itemType: "goal", itemId: g.id, fileIds: [f.id] });
    let o = await me.goals.overview({ organizationId: orgId });
    const row = o.goals.find((x) => x.goal.id === g.id)!;
    expect(row).toMatchObject({ progress: 70 });
    expect(row.goal.folderId).toBe(folder!.id);
    expect(row.files.map((x) => x.name)).toEqual(["Offer terms.pdf"]);
    await me.goals.detach({ organizationId: orgId, linkId: row.files[0].linkId });
    await me.goals.removeFolder({ organizationId: orgId, id: folder!.id });
    o = await me.goals.overview({ organizationId: orgId });
    expect(o.goals.find((x) => x.goal.id === g.id)!.files).toHaveLength(0);
    expect(o.goals.find((x) => x.goal.id === g.id)!.goal.folderId).toBeNull();
  });
});

describe("Projects", () => {
  it("keeps folders, lists with their own statuses, tasks, subtasks, checklists and comments; closes a task on a done status", async () => {
    const { orgId, owner } = await makeWorkspace("pj-basic");
    const me = caller(owner);
    const folder = await me.pj.saveFolder({ organizationId: orgId, name: "Social Media", color: "#b45309" });
    const list = await me.pj.saveList({ organizationId: orgId, name: "Content Pipeline", folderId: folder.id, statuses: [{ name: "Idea", color: "#87909e", type: "open" }, { name: "needs review", color: "#f8ae00", type: "active" }, { name: "published", color: "#12a594", type: "done" }] });
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Founding member launch post", dueDate: "2026-10-07" });
    expect(t.status).toBe("idea");
    const sub = await me.pj.create({ organizationId: orgId, listId: list.id, parentId: t.id, name: "Write the caption" });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { priority: "high", checklist: [{ text: "Price matches the site", done: true }, { text: "Link works", done: false }], tags: ["Launch"] } });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { status: "published" } });
    let d = await me.pj.task({ organizationId: orgId, id: t.id });
    expect(d.task).toMatchObject({ status: "published", closed: true, priority: "high", subtasks: 1, checklist: { done: 1, total: 2 }, tags: ["launch"] });
    expect(d.subtasks.map((s) => s.id)).toEqual([sub.id]);
    expect(d.comments.filter((c) => c.kind === "activity").map((c) => c.body)).toContain(`${owner.name} moved this from idea to published`);
    await expect(me.pj.update({ organizationId: orgId, id: t.id, patch: { status: "shipped" } })).rejects.toThrow(/isn't a status/);
    await me.pj.comment({ organizationId: orgId, taskId: t.id, body: "Looks good.", fileIds: [] });
    d = await me.pj.task({ organizationId: orgId, id: t.id });
    expect(d.comments.filter((c) => c.kind === "comment").map((c) => c.body)).toEqual(["Looks good."]);
    const tree = await me.pj.tree({ organizationId: orgId });
    expect(tree.folders[0]).toMatchObject({ name: "Social Media", lists: [{ name: "Content Pipeline", open: 0 }] });
    const v = await me.pj.view({ organizationId: orgId, listId: list.id, scope: "list", closed: true });
    expect(v.tasks.map((x) => x.name)).toEqual(["Founding member launch post"]); // subtasks sit under their task
    expect(v.statuses.map((s) => s.name)).toEqual(["idea", "needs review", "published"]);
    // The Gantt drag moves the dates.
    await me.pj.shiftDates({ organizationId: orgId, id: t.id, startDate: "2026-10-05", dueDate: "2026-10-09" });
    expect(db.work.tasks.get(orgId, t.id)).toMatchObject({ startDate: "2026-10-05", dueDate: "2026-10-09" });
    // Another workspace can't reach it.
    const other = await makeWorkspace("pj-other");
    await expect(caller(other.owner).pj.task({ organizationId: other.orgId, id: t.id })).rejects.toThrow(/isn't in this workspace/);
    await me.pj.removeList({ organizationId: orgId, id: list.id });
    expect(db.work.tasks.all(orgId)).toHaveLength(0);
  });

  it("an employee given a task starts on it and comments what it did; automations run on a status", async () => {
    const { orgId, owner } = await makeWorkspace("pj-emp");
    const me = caller(owner);
    const list = await me.pj.saveList({ organizationId: orgId, name: "Founding Members", folderId: null });
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    const chat = await import("./employees/chat");
    const doTask = vi.spyOn(chat, "doTask").mockResolvedValue({ action: "build_page", text: "Built the founding member page.", cards: [{ type: "page", id: 1, title: "Founding member offer", subtitle: "Draft 1", body: "Headline: Join the founding 12.", url: "https://leaddash.io/founding" }, { type: "choices", id: 2, title: "", options: ["Publish it"] }], refs: [] } as any);
    await me.pj.saveAutomation({ organizationId: orgId, listId: list.id, trigger: { on: "status", to: "complete" }, action: { do: "comment", value: "Send it to Caroline to paste in." }, active: true });
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Founding member landing page", assignees: [{ type: "employee", id: jordan.id, name: jordan.name }] });
    await waitFor(() => db.work.comments.where(orgId, "taskId", t.id).some((c) => c.kind === "comment"));
    expect(doTask).toHaveBeenCalledTimes(1);
    expect(doTask.mock.calls[0][1]).toMatchObject({ title: "Founding member landing page", project: "Founding Members" });
    const d = await me.pj.task({ organizationId: orgId, id: t.id });
    // What it made is on the task itself: the words, then each card's title, body and link (quick-reply choices left out).
    expect(d.comments.find((c) => c.kind === "comment")).toMatchObject({ authorName: jordan.name, body: "Built the founding member page. What I made is in the description." });
    expect(d.task.description).toBe(`What ${jordan.name} made\nFounding member offer (Draft 1)\nHeadline: Join the founding 12.\nhttps://leaddash.io/founding`);
    expect(d.comments.some((c) => c.kind === "activity" && c.body === `${jordan.name} started on it`)).toBe(true);
    expect(d.task.status).toBe("in progress"); // started
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { status: "complete" } });
    expect(db.work.comments.where(orgId, "taskId", t.id).some((c) => c.body === "Send it to Caroline to paste in.")).toBe(true);
    // An employee's chat action adds and finds tasks.
    expect(pj.find(orgId, { words: "landing", includeDone: true })[0]).toMatchObject({ name: "Founding member landing page", list: "Founding Members" });
  });
});

describe("Moving from ClickUp", () => {
  it("reads the 12 Week Year cycle and its goals", () => {
    expect(cycleOf("12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)")).toEqual({ name: "Cycle 1, 2026", start: "2026-04-03", end: "2026-06-19" });
    expect(isGoalTask({ name: "🟢 LeadDash — 12 Mid-Tier Founding Members by Jun 19" })).toBe(true);
    expect(isGoalTask({ name: "Set up Facebook ad campaign in Meta Ads Manager" })).toBe(false);
  });

  it("brings Spaces over: folders, lists with statuses and fields, tasks, subtasks, people, comments, and the 12 Week Year into Goals; running it again doesn't copy twice", async () => {
    const { orgId, owner } = await makeWorkspace("pj-import");
    const caroline = await makeUser("caroline@pj-import.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: orgId, userId: caroline.id, role: "admin" });
    const integrations = await import("./integrations");
    vi.spyOn(integrations, "clickupSettings").mockResolvedValue({ teamId: "1", teamName: "Workspace", userId: 1, userEmail: null, spaces: [], spaceId: null, spaceName: null });
    const api: Record<string, unknown> = {
      "/team/1/space?archived=false": { spaces: [{ id: "10", name: "LeadDash" }, { id: "20", name: "Annual Planning" }] },
      "/space/10/folder?archived=false": { folders: [{ id: "100", name: "Social Media", lists: [{ id: "1000", name: "Content Pipeline" }] }] },
      "/space/10/list?archived=false": { lists: [{ id: "1001", name: "Client Success" }] },
      "/space/20/folder?archived=false": { folders: [{ id: "200", name: "12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)", lists: [{ id: "2000", name: "🎯 Goals + Tactics" }, { id: "2001", name: "📊 Weekly Execution Score" }] }] },
      "/space/20/list?archived=false": { lists: [] },
      "/list/1000": { content: "", statuses: [{ status: "idea", color: "#87909e", type: "open" }, { status: "needs review", color: "#f8ae00", type: "custom" }, { status: "published", color: "#12a594", type: "closed" }] },
      "/list/1001": { content: "", statuses: [] },
      "/list/2000": { content: "", statuses: [{ status: "to do", type: "open" }, { status: "complete", type: "done" }, { status: "cancelled", type: "closed" }] },
      "/list/2001": { content: "", statuses: [{ status: "to do", type: "open" }, { status: "complete", type: "done" }] },
      "/list/1000/field": { fields: [{ id: "f1", name: "Progress", type: "drop_down", type_config: { options: [{ id: "o1", name: "On Track", color: "#f76808", orderindex: 2 }] } }] },
      "/list/1001/field": { fields: [] },
      "/list/2000/field": { fields: [] },
      "/list/2001/field": { fields: [] },
      "/list/1000/task?include_closed=true&subtasks=true&archived=false&page=0": { last_page: true, tasks: [{ id: "t1", name: "Batch-write next nurture emails", status: { status: "idea" }, priority: { priority: "high" }, due_date: "1787562000000", assignees: [{ username: "Caroline Mukirai", email: "c@elsewhere.com" }], tags: [{ name: "email" }], custom_fields: [{ id: "f1", value: 2 }], checklists: [{ name: "Steps", items: [{ name: "Draft", resolved: true }] }] }, { id: "t2", name: "Subject lines", parent: "t1", status: { status: "idea" } }] },
      "/list/1001/task?include_closed=true&subtasks=true&archived=false&page=0": { last_page: true, tasks: [] },
      "/list/2000/task?include_closed=true&subtasks=true&archived=false&page=0": { last_page: true, tasks: [{ id: "g1", name: "🟢 LeadDash — 12 Mid-Tier Founding Members by Jun 19", status: { status: "complete", type: "done" } }, { id: "g2", name: "Set up Facebook ad campaign", status: { status: "complete", type: "done" } }] },
      "/list/2001/task?include_closed=true&subtasks=true&archived=false&page=0": { last_page: true, tasks: [{ id: "s1", name: "Week 3: 82%", status: { status: "complete", type: "done" }, due_date: String(Date.parse("2026-04-22T17:00:00Z")) }] },
    };
    vi.spyOn(integrations, "clickup").mockImplementation(async (_org: number, path: string) => {
      if (path.startsWith("/task/") && path.endsWith("/comment")) return path.includes("t1") ? { comments: [{ id: "c1", comment_text: "Drafts are in the doc.", user: { username: "Caroline Mukirai" }, date: "1787000000000" }] } : { comments: [] };
      if (path.startsWith("/task/")) {
        const id = path.split("/")[2].split("?")[0];
        for (const v of Object.values(api)) for (const t of ((v as any).tasks ?? []) as any[]) if (t.id === id) return { ...t, markdown_description: id === "t1" ? "For the PPH list." : "" };
        return {};
      }
      if (!(path in api)) throw new Error(`404: ${path}`);
      return api[path];
    });
    const me = caller(owner);
    const s = await me.pj.clickupSpaces({ organizationId: orgId });
    expect(s.spaces.map((x) => [x.name, x.lists, x.goalsLike])).toEqual([["LeadDash", 2, false], ["Annual Planning", 2, true]]);
    expect(s.workspaces.map((w) => w.id)).toContain(orgId);
    const run = async () => {
      const r = await me.pj.startImport({ organizationId: orgId, picks: [{ spaceId: "10", name: "LeadDash", orgId, mode: "projects" }, { spaceId: "20", name: "Annual Planning", orgId, mode: "goals" }] });
      await waitFor(() => db.work.imports.get(orgId, r.id)?.status !== "running");
      return db.work.imports.get(orgId, r.id)!;
    };
    const done = await run();
    expect(done.status).toBe("done");
    expect(JSON.parse(done.counts)).toMatchObject({ lists: 4, tasks: 5, comments: 1, goals: 1 });
    const tree = await me.pj.tree({ organizationId: orgId });
    expect(tree.folders.map((f) => f.name)).toEqual(["Social Media", "Annual Planning: 12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)"]);
    expect(tree.loose.map((l) => l.name)).toEqual(["Client Success"]);
    const list = db.work.lists.all(orgId).find((l) => l.name === "Content Pipeline")!;
    expect(JSON.parse(list.statuses).map((x: any) => [x.name, x.type])).toEqual([["idea", "open"], ["needs review", "active"], ["published", "closed"]]);
    const t1 = db.work.tasks.all(orgId).find((t) => t.clickupId === "t1")!;
    expect(JSON.parse(t1.assignees)).toEqual([{ type: "user", id: caroline.id, name: "Caroline Jones" }]); // matched by first name
    expect(t1).toMatchObject({ priority: "high", description: "For the PPH list." });
    expect(JSON.parse(t1.fields)).toEqual({ f1: "o1" });
    expect(JSON.parse(t1.checklist)).toEqual([{ text: "Draft", done: true }]);
    expect(db.work.tasks.all(orgId).find((t) => t.clickupId === "t2")!.parentId).toBe(t1.id);
    expect(db.work.comments.where(orgId, "taskId", t1.id).find((c) => c.kind === "comment")).toMatchObject({ authorName: "Caroline Jones", body: "Drafts are in the doc." });
    const g = db.work.goals.all(orgId).find((x) => x.clickupId === "g1")!;
    expect(g).toMatchObject({ title: "LeadDash — 12 Mid-Tier Founding Members by Jun 19", level: "cycle", period: "Cycle 1, 2026", startDate: "2026-04-03", dueDate: "2026-06-19", state: "done", status: "on" });
    const score = db.work.measures.all(orgId).find((m) => m.name === "Weekly execution score")!;
    expect(db.work.values.where(orgId, "measureId", score.id)[0]).toMatchObject({ weekStart: "2026-04-19", value: 82 });
    // Again: nothing doubles.
    const again = await run();
    expect(again.status).toBe("done");
    expect(db.work.tasks.all(orgId)).toHaveLength(5);
    expect(db.work.lists.all(orgId)).toHaveLength(4);
    expect(db.work.comments.where(orgId, "taskId", t1.id).filter((c) => c.kind === "comment")).toHaveLength(1);
  });
  it("imports from ClickUp connected in another of the owner's workspaces, and says so when none has it", async () => {
    const { orgId: here, owner } = await makeWorkspace("pj-import-here");
    const other = await caller((await db.getUserByEmail("staff@leaddash.io"))!).organizations.create({ name: "Workspace with ClickUp", slug: "pj-import-there", plan: "growth", state: "Oklahoma", ownerEmail: owner.email });
    const there = other.id!;
    const integrations = await import("./integrations");
    const me = caller(owner);
    vi.spyOn(integrations, "clickupSettings").mockResolvedValue(null);
    expect(await me.pj.clickupSpaces({ organizationId: here })).toMatchObject({ connected: false, spaces: [] });
    await expect(me.pj.startImport({ organizationId: here, picks: [{ spaceId: "10", name: "Ops", orgId: here, mode: "projects" }] })).rejects.toThrow(/Connect ClickUp/);
    vi.spyOn(integrations, "clickupSettings").mockImplementation(async (id: number) => (id === there ? { teamId: "1", teamName: "T", userId: 1, userEmail: null, spaces: [], spaceId: null, spaceName: null } : null));
    const read: number[] = [];
    vi.spyOn(integrations, "clickup").mockImplementation(async (org: number, path: string) => {
      read.push(org);
      if (path === "/team/1/space?archived=false") return { spaces: [{ id: "10", name: "Ops" }] };
      if (path === "/space/10/folder?archived=false") return { folders: [] };
      if (path === "/space/10/list?archived=false") return { lists: [{ id: "500", name: "Errands" }] };
      if (path === "/list/500") return { content: "", statuses: [] };
      if (path === "/list/500/field") return { fields: [] };
      if (path.startsWith("/list/500/task")) return { last_page: true, tasks: [{ id: "x1", name: "Call the bank", status: { status: "to do" } }] };
      if (path.endsWith("/comment")) return { comments: [] };
      if (path.startsWith("/task/")) return { id: "x1", name: "Call the bank", status: { status: "to do" } };
      throw new Error(`404: ${path}`);
    });
    const s = await me.pj.clickupSpaces({ organizationId: here });
    expect(s).toMatchObject({ connected: true, from: "Workspace with ClickUp" });
    expect(s.spaces.map((x) => x.name)).toEqual(["Ops"]);
    const r = await me.pj.startImport({ organizationId: here, picks: [{ spaceId: "10", name: "Ops", orgId: here, mode: "projects" }] });
    await waitFor(() => db.work.imports.get(here, r.id)?.status !== "running");
    expect(db.work.imports.get(here, r.id)!.status).toBe("done");
    expect(new Set(read)).toEqual(new Set([there]));
    expect(db.work.tasks.all(here).map((t) => t.name)).toEqual(["Call the bank"]);
  });
  it("imports a ClickUp CSV export: each Space to its own workspace, folders, lists with their statuses, subtasks, checklists, comments and the 12 Week Year goals; running it again doesn't copy twice", async () => {
    const { orgId: lead, owner } = await makeWorkspace("pj-csv-lead");
    const legacy = (await caller((await db.getUserByEmail("staff@leaddash.io"))!).organizations.create({ name: "Legacy Family Services", slug: "pj-csv-legacy", plan: "growth", state: "Oklahoma", ownerEmail: owner.email })).id!;
    const caroline = await makeUser("caroline@pj-csv.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: lead, userId: caroline.id, role: "admin" });
    const H = "Task ID,Task Link,Task Type,Task Name,Task Content,Status,Date Created,Date Created Text,Due Date,Due Date Text,Start Date,Start Date Text,Parent ID,Subtasks IDs,Attachments,Assignees,Tags,Priority,List Name,Folder Name/Path,Space Name,Time Estimated,Time Estimated Text,Checklists,Comments,Assigned Comments,Time Spent,Time Spent Text,Rolled Up Time,Rolled Up Time Text,Home Location ID,Home Location,Other Location IDs,Other Locations";
    const row = (o: Record<string, string>) => H.split(",").map((k) => { const v = o[k] ?? ""; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(",");
    const csv = [H,
      row({ "Task ID": "a1", "Task Name": "Pitch Documents", "Task Content": "Write the master pitch.\\nSections: hook, body.", Status: "complete", "Date Created": "1774117017690", "Due Date": "1775293200000", "Parent ID": "null", "Subtasks IDs": "a2", Attachments: "[]", Assignees: "[Ashley Bryant]", Tags: "[]", Priority: "1", "List Name": "PR + Publicity", "Folder Name/Path": '["PR: Trademark"]', "Space Name": "LeadDash", Checklists: '{"Steps":["Hook","Bio"]}', Comments: '[{"text":"Sent.","by":"caroline@pj-csv.test","assigned":false,"date":"3/25/2026, 9:00:00 AM CDT","resolved":"N/A"},{"text":"Drafts are in the doc.","by":"caroline@pj-csv.test","assigned":false,"date":"3/24/2026, 1:20:14 PM CDT","resolved":"N/A"}]', "Home Location ID": "9017" }),
      row({ "Task ID": "a2", "Task Name": "Black Business podcasts", "Task Content": "", Status: "in progress", "Date Created": "1774117104891", "Due Date": "null", "Parent ID": "a1", "Subtasks IDs": "", Attachments: "[]", Assignees: "[]", Tags: "[]", Priority: "null", "List Name": "PR + Publicity", "Folder Name/Path": '["PR: Trademark"]', "Space Name": "LeadDash", Checklists: "{}", Comments: "[]", "Home Location ID": "9017" }),
      row({ "Task ID": "b1", "Task Name": "Post: Monday reel", "Task Content": "", Status: "published", "Date Created": "1774117104891", "Due Date": "null", "Parent ID": "null", "Subtasks IDs": "", Attachments: "[]", Assignees: "[Caroline Jones, Ashley Bryant]", Tags: "[]", Priority: "2", "List Name": "Social Posts", "Folder Name/Path": '["Social Media"]', "Space Name": "LeadDash", Checklists: "{}", Comments: "[]", "Home Location ID": "9018" }),
      row({ "Task ID": "c1", "Task Name": "Renew the facility license", "Task Content": "", Status: "to do", "Date Created": "1774117104891", "Due Date": "1780650000000", "Parent ID": "null", "Subtasks IDs": "", Attachments: "[]", Assignees: "[]", Tags: "[]", Priority: "null", "List Name": "Licensing & Corporate Setup", "Folder Name/Path": '["Compliance and QA"]', "Space Name": "Legacy Family Services, Inc", Checklists: "{}", Comments: "[]", "Home Location ID": "9019" }),
      row({ "Task ID": "g1", "Task Name": "🟢 LeadDash — 12 Mid-Tier Founding Members by Jun 19", "Task Content": "", Status: "cancelled", "Date Created": "1774117104891", "Due Date": "1781758800000", "Parent ID": "null", "Subtasks IDs": "g2", Attachments: "[]", Assignees: "[]", Tags: "[]", Priority: "null", "List Name": "🎯 Goals + Tactics", "Folder Name/Path": '["12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)"]', "Space Name": "Annual Planning", Checklists: "{}", Comments: "[]", "Home Location ID": "9020" }),
      row({ "Task ID": "g2", "Task Name": "Set up Facebook ad campaign", "Task Content": "", Status: "cancelled", "Date Created": "1774117104891", "Due Date": "null", "Parent ID": "g1", "Subtasks IDs": "", Attachments: "[]", Assignees: "[]", Tags: "[]", Priority: "null", "List Name": "🎯 Goals + Tactics", "Folder Name/Path": '["12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)"]', "Space Name": "Annual Planning", Checklists: "{}", Comments: "[]", "Home Location ID": "9020" }),
      row({ "Task ID": "s1", "Task Name": "Week 3: 82%", "Task Content": "", Status: "complete", "Date Created": "1774117104891", "Due Date": String(Date.parse("2026-04-22T17:00:00Z")), "Parent ID": "null", "Subtasks IDs": "", Attachments: "[]", Assignees: "[]", Tags: "[]", Priority: "null", "List Name": "📊 Weekly Execution Score", "Folder Name/Path": '["12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)"]', "Space Name": "Annual Planning", Checklists: "{}", Comments: "[]", "Home Location ID": "9021" }),
    ].join("\n");
    const me = caller(owner);
    const read = await me.pj.csvSpaces({ organizationId: lead, csv });
    expect(read.rows).toBe(7);
    expect(read.spaces.map((s) => [s.name, s.folders, s.lists, s.tasks, s.goalsLike])).toEqual([["LeadDash", 2, 2, 3, false], ["Legacy Family Services, Inc", 1, 1, 1, false], ["Annual Planning", 1, 2, 3, true]]);
    await expect(me.pj.csvSpaces({ organizationId: lead, csv: "Name,Email\nA,b@c.d" })).rejects.toThrow(/ClickUp task export/);
    const picks = [
      { spaceId: "csv:LeadDash", name: "LeadDash", orgId: lead, mode: "projects" as const },
      { spaceId: "csv:Legacy Family Services, Inc", name: "Legacy Family Services, Inc", orgId: legacy, mode: "projects" as const },
      { spaceId: "csv:Annual Planning", name: "Annual Planning", orgId: lead, mode: "goals" as const },
    ];
    const run = async () => {
      const r = await me.pj.startCsvImport({ organizationId: lead, csv, picks });
      await waitFor(() => db.work.imports.get(lead, r.id)?.status !== "running");
      return db.work.imports.get(lead, r.id)!;
    };
    const done = await run();
    expect(done.status).toBe("done");
    expect(JSON.parse(done.counts)).toMatchObject({ folders: 4, lists: 5, tasks: 7, comments: 2, goals: 1 });
    // LeadDash keeps its folders as they are; Annual Planning's carry the Space name; Legacy got its own.
    expect((await me.pj.tree({ organizationId: lead })).folders.map((f) => f.name)).toEqual(["PR: Trademark", "Social Media", "Annual Planning: 12 Week Year — Cycle 1 (Apr 3 – Jun 19, 2026)"]);
    expect((await me.pj.tree({ organizationId: legacy })).folders.map((f) => [f.name, f.lists.map((l) => l.name)])).toEqual([["Compliance and QA", ["Licensing & Corporate Setup"]]]);
    const posts = db.work.lists.all(lead).find((l) => l.name === "Social Posts")!;
    expect(JSON.parse(posts.statuses).map((x: any) => [x.name, x.type])).toEqual([["to do", "open"], ["published", "done"]]);
    const a1 = db.work.tasks.all(lead).find((t) => t.clickupId === "a1")!;
    expect(a1).toMatchObject({ priority: "urgent", description: "Write the master pitch.\nSections: hook, body.", status: "complete", dueDate: "2026-04-04" }); // ClickUp's "\n" becomes a line break
    expect(a1.closedAt).not.toBeNull();
    expect(JSON.parse(a1.assignees)).toEqual([{ type: "name", id: 0, name: "Ashley Bryant" }]); // nobody on this team by that name: kept as a name
    expect(JSON.parse(a1.checklist)).toEqual([{ text: "Hook", done: false }, { text: "Bio", done: false }]);
    expect(db.work.tasks.all(lead).find((t) => t.clickupId === "a2")!.parentId).toBe(a1.id);
    const cs = db.work.comments.where(lead, "taskId", a1.id).filter((c) => c.kind === "comment").sort((a, b) => a.id - b.id);
    expect(cs.map((c) => [c.authorName, c.body])).toEqual([["Caroline Jones", "Drafts are in the doc."], ["Caroline Jones", "Sent."]]); // oldest first, whatever order the file had
    expect(new Date(cs[0].createdAt).toISOString()).toBe("2026-03-24T18:20:14.000Z"); // 1:20 PM CDT
    expect(JSON.parse(db.work.tasks.all(lead).find((t) => t.clickupId === "b1")!.assignees)).toEqual([{ type: "user", id: caroline.id, name: "Caroline Jones" }, { type: "name", id: 0, name: "Ashley Bryant" }]);
    expect(db.work.tasks.all(legacy).map((t) => t.name)).toEqual(["Renew the facility license"]);
    const g = db.work.goals.all(lead).find((x) => x.clickupId === "g1")!;
    expect(g).toMatchObject({ title: "LeadDash — 12 Mid-Tier Founding Members by Jun 19", period: "Cycle 1, 2026", startDate: "2026-04-03", dueDate: "2026-06-19", state: "archived" });
    const score = db.work.measures.all(lead).find((m) => m.name === "Weekly execution score")!;
    expect(db.work.values.where(lead, "measureId", score.id)[0]).toMatchObject({ weekStart: "2026-04-19", value: 82 });
    // Again: nothing doubles.
    const again = await run();
    expect(again.status).toBe("done");
    expect(db.work.tasks.all(lead)).toHaveLength(6);
    expect(db.work.lists.all(lead)).toHaveLength(4);
    expect(db.work.comments.where(lead, "taskId", a1.id).filter((c) => c.kind === "comment")).toHaveLength(2);
  });
});
