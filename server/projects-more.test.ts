import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as pj from "./work/projects";
import { tickOrg } from "./work/pjTicks";
import { evalFormula } from "@shared/formula";
import { submit } from "./work/pjForms";
import { blocksFromHtml, cleanBlocks, htmlFromBlocks, sanitizeHtml } from "./work/pjDocs";
import * as llm from "./_core/llm";

afterEach(() => vi.restoreAllMocks());

async function listWith(slug: string) {
  const ws = await makeWorkspace(slug);
  const me = caller(ws.owner);
  const folder = await me.pj.saveFolder({ organizationId: ws.orgId, name: "Offers", color: "#1b6b4a" });
  const list = await me.pj.saveList({ organizationId: ws.orgId, name: "Founding Members", folderId: folder.id });
  return { ...ws, me, folder, list };
}

describe("Projects, more like ClickUp", () => {
  it("repeats a task when it's done, with its dates moved to the next time", async () => {
    const { orgId, me, list } = await listWith("pj-repeat");
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Weekly content batch", startDate: "2026-10-05", dueDate: "2026-10-05" });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { repeat: { every: 1, unit: "week", days: [1], mode: "done", ends: "never", keep: { subtasks: true, checklist: true, assignees: true, comments: false } }, checklist: [{ text: "Draft", done: true }] } });
    await me.pj.create({ organizationId: orgId, listId: list.id, parentId: t.id, name: "Write captions" });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { status: "complete" } });
    const next = db.work.tasks.where(orgId, "listId", list.id).find((x) => x.name === "Weekly content batch" && x.id !== t.id)!;
    expect(next).toMatchObject({ dueDate: "2026-10-12", startDate: "2026-10-12", status: "to do" });
    expect(pj.parse<{ done: boolean }[]>(next.checklist, [])).toEqual([{ text: "Draft", done: false }]);
    expect(db.work.tasks.where(orgId, "parentId", next.id).map((s) => s.name)).toEqual(["Write captions"]);
    // Closing the old one again doesn't make a second copy.
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { status: "to do" } });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { status: "complete" } });
    expect(db.work.tasks.where(orgId, "listId", list.id).filter((x) => x.name === "Weekly content batch" && !x.parentId)).toHaveLength(2);
    // Next dates for other rules.
    const r = { every: 1, unit: "month", mode: "done", ends: "never", keep: { subtasks: false, checklist: false, assignees: true, comments: false } } as const;
    expect(pj.nextDate("2026-01-31", r)).toBe("2026-02-28");
    expect(pj.nextDate("2026-10-09", { ...r, unit: "week", days: [1, 3] })).toBe("2026-10-12");
    expect(pj.nextDate("2026-10-12", { ...r, unit: "week", days: [1, 3] })).toBe("2026-10-14");
  });

  it("makes repeat-on-schedule tasks when their date arrives, and fires due-date and scheduled automations once", async () => {
    const { orgId, me, list } = await listWith("pj-ticks");
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "End of day report", dueDate: "2026-10-05" });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { repeat: { every: 1, unit: "day", mode: "schedule", ends: "never", keep: { subtasks: false, checklist: false, assignees: true, comments: false } } } });
    await me.pj.saveAutomation({ organizationId: orgId, listId: list.id, trigger: { on: "due" }, action: { do: "priority", value: "urgent" }, active: true });
    await me.pj.saveAutomation({ organizationId: orgId, listId: null, trigger: { on: "schedule", every: "day", time: "09:00" }, action: { do: "chat", value: "Morning: check Projects." }, active: true });
    const at = new Date("2026-10-05T15:00:00Z"); // 10:00 AM in Chicago
    await db.updateOrganization(orgId, { timezone: "America/Chicago" } as never);
    const sent = vi.spyOn(db.team, "send");
    await tickOrg(orgId, at);
    await tickOrg(orgId, at);
    expect(db.work.tasks.get(orgId, t.id)!.priority).toBe("urgent");
    expect(db.work.tasks.where(orgId, "listId", list.id).filter((x) => x.name === "End of day report")).toHaveLength(2);
    expect(db.work.tasks.where(orgId, "listId", list.id).find((x) => x.id !== t.id)!.dueDate).toBe("2026-10-06");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toMatchObject({ channel: "everyone", content: "Morning: check Projects." });
  });

  it("keeps waiting-on tasks in order: no loops, moved dates carry over, and the waiting task hears when it's free", async () => {
    const { orgId, me, list } = await listWith("pj-deps");
    const copy = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Offer copy", startDate: "2026-10-05", dueDate: "2026-10-06" });
    const page = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Landing page", startDate: "2026-10-07", dueDate: "2026-10-08" });
    const post = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Launch post", startDate: "2026-10-09", dueDate: "2026-10-09" });
    await me.pj.addLink({ organizationId: orgId, taskId: page.id, otherId: copy.id, kind: "waits" });
    await me.pj.addLink({ organizationId: orgId, taskId: page.id, otherId: post.id, kind: "blocks" });
    await expect(me.pj.addLink({ organizationId: orgId, taskId: copy.id, otherId: post.id, kind: "waits" })).rejects.toThrow(/loop/);
    let d = await me.pj.task({ organizationId: orgId, id: page.id });
    expect(d.links.waitingOn.map((x) => x.name)).toEqual(["Offer copy"]);
    expect(d.links.blocking.map((x) => x.name)).toEqual(["Launch post"]);
    expect(d.task.blocked).toBe(true);
    // The copy slips two days: everything after it moves two days.
    await me.pj.shiftDates({ organizationId: orgId, id: copy.id, startDate: "2026-10-07", dueDate: "2026-10-08" });
    expect(db.work.tasks.get(orgId, page.id)).toMatchObject({ startDate: "2026-10-09", dueDate: "2026-10-10" });
    expect(db.work.tasks.get(orgId, post.id)).toMatchObject({ startDate: "2026-10-11", dueDate: "2026-10-11" });
    await me.pj.update({ organizationId: orgId, id: copy.id, patch: { status: "complete" } });
    d = await me.pj.task({ organizationId: orgId, id: page.id });
    expect(d.task.blocked).toBe(false);
    expect(d.comments.map((c) => c.body)).toContain('No longer waiting: "Offer copy" is done');
    await me.pj.addLink({ organizationId: orgId, taskId: copy.id, otherId: post.id, kind: "link" });
    expect((await me.pj.task({ organizationId: orgId, id: post.id })).links.linked.map((x) => x.name)).toEqual(["Offer copy"]);
    const v = await me.pj.view({ organizationId: orgId, listId: list.id, scope: "list", closed: true });
    expect(v.links).toEqual(expect.arrayContaining([{ from: copy.id, to: page.id }, { from: page.id, to: post.id }]));
  });

  it("tracks time with one timer per person, typed-in time, the weekly timesheet and workload", async () => {
    const { orgId, owner, me, list } = await listWith("pj-time");
    const a = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Landing page", startDate: "2026-10-05", dueDate: "2026-10-09", assignees: [{ type: "user", id: owner.id, name: owner.name! }] });
    await me.pj.update({ organizationId: orgId, id: a.id, patch: { timeEstimate: 600 } });
    const b = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Offer copy" });
    await me.pj.startTimer({ organizationId: orgId, taskId: a.id });
    await me.pj.startTimer({ organizationId: orgId, taskId: b.id });
    const running = db.work.time.all(orgId).filter((e) => e.minutes === null);
    expect(running.map((e) => e.taskId)).toEqual([b.id]);
    expect((await me.pj.me({ organizationId: orgId })).running?.taskName).toBe("Offer copy");
    await me.pj.stopTimer({ organizationId: orgId });
    await me.pj.addTime({ organizationId: orgId, taskId: a.id, day: "2026-10-19", minutes: 90, note: "Mock up version 1", billable: true });
    await me.pj.addTime({ organizationId: orgId, taskId: a.id, day: "2026-10-20", minutes: 45, note: "Copy review", billable: false });
    const ts = await me.pj.timesheet({ organizationId: orgId, weekStart: "2026-10-18" });
    const row = ts.rows.find((r) => r.taskId === a.id)!;
    expect(row.byDay).toEqual([0, 90, 45, 0, 0, 0, 0]);
    expect(ts.billable).toBeGreaterThanOrEqual(90);
    const billableOnly = await me.pj.timesheet({ organizationId: orgId, weekStart: "2026-10-18", billable: "yes" });
    expect(billableOnly.rows.find((r) => r.taskId === a.id)!.total).toBe(90);
    // 10 hours over 5 working days, all in the week of Oct 4, 2026.
    const wl = await me.pj.workload({ organizationId: orgId, start: "2026-10-04", weeks: 2 });
    const mine = wl.rows.find((r) => r.type === "user" && r.id === owner.id)!;
    expect(mine.hours).toBe(40);
    expect(mine.cells[0]).toMatchObject({ minutes: 600 });
    expect(mine.cells[1].minutes).toBe(0);
    await me.pj.setHours({ organizationId: orgId, type: "user", id: owner.id, hours: 30 });
    expect((await me.pj.workload({ organizationId: orgId, start: "2026-10-04", weeks: 1 })).rows.find((r) => r.id === owner.id && r.type === "user")!.hours).toBe(30);
  });

  it("supports the new field types, fields shared by a whole folder, and formulas", async () => {
    const { orgId, me, list, folder } = await listWith("pj-fields");
    const other = await me.pj.saveList({ organizationId: orgId, name: "AI Receptionist", folderId: folder.id });
    await me.pj.saveList({
      organizationId: orgId,
      id: list.id,
      name: list.name,
      folderId: folder.id,
      fields: [
        { id: "prog", name: "Progress", type: "dropdown", options: [{ id: "o1", name: "On Track", color: "#f76808" }], scope: "folder" },
        { id: "seats", name: "Seats sold", type: "number", scope: "list" },
        { id: "left", name: "Seats left", type: "formula", setup: "25 − Seats sold", scope: "list" },
        { id: "rate", name: "Effort", type: "rating", setup: "5", scope: "list" },
      ],
    });
    const v1 = await me.pj.view({ organizationId: orgId, listId: list.id, scope: "list", closed: false });
    expect(v1.list!.fields.map((f) => [f.name, f.scope])).toEqual([["Progress", "folder"], ["Seats sold", "list"], ["Seats left", "list"], ["Effort", "list"]]);
    const v2 = await me.pj.view({ organizationId: orgId, listId: other.id, scope: "list", closed: false });
    expect(v2.list!.fields.map((f) => f.name)).toEqual(["Progress"]);
    expect(evalFormula("25 − Seats sold", { "Seats sold": 7 })).toBe(18);
    expect(evalFormula("(Price * Seats) / 2", { Price: 299, Seats: 4 })).toBe(598);
    expect(evalFormula("Seats sold + process.exit()", { "Seats sold": 1 })).toBeNull();
    expect(evalFormula("Seats sold", { "Seats sold": null })).toBeNull();
  });

  it("saves a list as a template and makes a new list from it with the dates moved", async () => {
    const { orgId, me, list, folder } = await listWith("pj-templates");
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Welcome email", startDate: "2026-10-05", dueDate: "2026-10-07" });
    await me.pj.create({ organizationId: orgId, listId: list.id, parentId: t.id, name: "Write it" });
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Kickoff call", dueDate: "2026-10-12" });
    const tp = await me.pj.saveTemplate({ organizationId: orgId, kind: "list", sourceId: list.id, name: "Founding member onboarding", description: "" });
    expect((await me.pj.templates({ organizationId: orgId }))[0]).toMatchObject({ name: "Founding member onboarding", kind: "list", summary: "2 tasks · 3 statuses" });
    const made = await me.pj.useTemplate({ organizationId: orgId, id: tp.id, name: "Founding Members: cohort 2", folderId: folder.id, startDate: "2026-11-02", keep: { assignees: true, dates: true, attachments: true, comments: false } });
    const tasks = db.work.tasks.where(orgId, "listId", made.id);
    expect(tasks.find((x) => x.name === "Welcome email")).toMatchObject({ startDate: "2026-11-02", dueDate: "2026-11-04" });
    expect(tasks.find((x) => x.name === "Kickoff call")).toMatchObject({ dueDate: "2026-11-09" });
    expect(tasks.find((x) => x.name === "Write it")!.parentId).toBe(tasks.find((x) => x.name === "Welcome email")!.id);
    // A task template drops into any list.
    const tt = await me.pj.saveTemplate({ organizationId: orgId, kind: "task", sourceId: t.id, name: "", description: "" });
    const one = await me.pj.useTemplate({ organizationId: orgId, id: tt.id, listId: list.id, startDate: "2026-12-01" });
    expect(db.work.tasks.get(orgId, one.id)).toMatchObject({ name: "Welcome email", startDate: "2026-12-01", dueDate: "2026-12-03" });
  });

  it("keeps a doc as a page: safe HTML in, blocks derived, checklist ticks from the read view, older docs get a page, Nora writes into it", async () => {
    const { orgId, me, list, folder } = await listWith("pj-doc-page");
    const task = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Landing page final check" });
    // Scripts, handlers, unknown tags and unsafe links go; document tags, task items, mentions, tables and pictures stay.
    const page = sanitizeHtml(
      `<h2 style="text-align: center; position: fixed">Email 1</h2><script>alert(1)</script><p onclick="x()">Hi <strong>there</strong> <a href="javascript:alert(1)">bad</a> <a href="https://leaddash.io">good</a> <span style="color: #b4261f; font-size: 18px">red</span> <mark data-color="#fff3a3" style="background-color: #fff3a3">note</mark></p>` +
        `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Links tested</p></div></li><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Proofread</p></div></li></ul>` +
        `<p>Close with the <span data-type="mention" data-id="${task.id}" data-label="Landing page final check">@Landing page final check</span> link</p>` +
        `<table><tbody><tr><th colspan="1"><p>Email</p></th><th><p>Send</p></th></tr><tr><td><p>1, confirmation</p></td><td><p>Nov 7, 2026</p></td></tr></tbody></table><img src="javascript:alert(1)"><img src="/files/pic.png" alt="Pic"><iframe src="https://x"></iframe><custom>loose words</custom><ul><li><p>See <span data-type="mention" data-id="${task.id}" data-label="Landing page final check">@Landing page final check</span></p></li></ul>`
    );
    expect(page).not.toMatch(/script|onclick|iframe|javascript:|position/);
    expect(page).toContain('<h2 style="text-align: center">Email 1</h2>');
    expect(page).toContain('<a href="https://leaddash.io" target="_blank" rel="noopener noreferrer">good</a>');
    expect(page).toContain('<a target="_blank" rel="noopener noreferrer">bad</a>');
    expect(page).toContain('<span style="color: #b4261f; font-size: 18px">red</span>');
    expect(page).toContain('<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label>');
    expect(page).toContain(`<span data-type="mention" data-id="${task.id}" data-label="Landing page final check" class="gp-mention">@Landing page final check</span>`);
    expect(page).toContain('<th colspan="1"><p>Email</p></th>');
    expect(page).toContain('<img src="/files/pic.png" alt="Pic">');
    expect(page).not.toContain("javascript");
    expect(page).toContain("loose words");
    const blocks = blocksFromHtml(page);
    expect(blocks.map((b) => b.type)).toEqual(["h2", "p", "check", "check", "p", "task", "table", "image", "p", "bullet", "task"]);
    expect(blocks[2]).toMatchObject({ id: "k0", type: "check", text: "Links tested", done: false });
    expect(blocks[3]).toMatchObject({ id: "k1", done: true });
    expect(blocks[5]).toMatchObject({ type: "task", taskId: task.id });
    expect(blocks[6].rows).toEqual([["Email", "Send"], ["1, confirmation", "Nov 7, 2026"]]);
    // Saving the page keeps it and the blocks it means; the task mention links the task; search finds the words.
    const doc = await me.pj.saveDoc({ organizationId: orgId, folderId: folder.id, title: "Emails for webinar", html: page });
    let d = await me.pj.doc({ organizationId: orgId, id: doc.id });
    expect(d.doc.html).toBe(page);
    expect(d.doc.blocks.map((b) => b.type)).toEqual(blocks.map((b) => b.type));
    expect(d.linked.map((t) => t.id)).toEqual([task.id]);
    expect((await me.pj.allDocs({ organizationId: orgId, q: "confirmation" })).docs.map((x) => x.id)).toEqual([doc.id]);
    // Ticking the first checklist line from the read view changes the page and the blocks.
    await me.pj.toggleDocCheck({ organizationId: orgId, id: doc.id, blockId: "k0", done: true });
    d = await me.pj.doc({ organizationId: orgId, id: doc.id });
    expect(d.doc.html).toContain('<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Links tested</p>');
    expect(d.doc.blocks.filter((b) => b.type === "check").map((b) => b.done)).toEqual([true, true]);
    // A doc written as blocks before the page editor opens as a page.
    const old = await me.pj.saveDoc({ organizationId: orgId, folderId: folder.id, title: "Old FAQ", blocks: [{ id: "a", type: "h1", text: "Founding **member** FAQ" }, { id: "b", type: "bullet", text: "One" }, { id: "c", type: "bullet", text: "Two [link](https://leaddash.io)" }, { id: "d", type: "check", text: "Done", done: true }, { id: "e", type: "task", text: "", taskId: task.id }] });
    db.work.docs.update(orgId, old.id, { html: "" });
    const o = await me.pj.doc({ organizationId: orgId, id: old.id });
    expect(o.doc.html).toBe(htmlFromBlocks(o.doc.blocks, [{ id: task.id, name: task.name }]));
    expect(o.doc.html).toContain("<h1>Founding <strong>member</strong> FAQ</h1><ul><li><p>One</p></li><li><p>Two <a href=\"https://leaddash.io\" target=\"_blank\" rel=\"noopener noreferrer\">link</a></p></li></ul>");
    expect(o.doc.html).toContain(`data-id="${task.id}"`);
    // The public link shows the page.
    const { link } = await me.pj.setDocLink({ organizationId: orgId, id: doc.id, on: true });
    expect(db.docByShareToken(link!.split("/d/")[1])?.html).toContain("Links tested");
    // A template made from the doc carries the page.
    const tpl = await me.pj.saveTemplate({ organizationId: orgId, kind: "doc", sourceId: doc.id, name: "Webinar emails", description: "" });
    const made = await me.pj.useTemplate({ organizationId: orgId, id: tpl.id, name: "Emails for the next webinar", folderId: folder.id });
    expect((await me.pj.doc({ organizationId: orgId, id: made.id })).doc.html).toContain("Links tested");
    // Nora writes a piece from the page's own words, with no em dashes.
    const gen = vi.spyOn(llm, "generateText").mockResolvedValue("## Email 3\n\nSee you at noon \u2014 bring one number.\n\n- Links tested\n- Proofread");
    const r = await me.pj.docAsk({ organizationId: orgId, id: doc.id, prompt: "Write the third email" });
    expect(r.text).toBe("## Email 3\n\nSee you at noon, bring one number.\n\n- Links tested\n- Proofread");
    expect(gen.mock.calls[0][0].prompt).toContain("1, confirmation | Nov 7, 2026");
    expect(gen.mock.calls[0][0].prompt).toContain("[x] Links tested");
  });

  it("keeps docs as safe blocks, makes tasks from selected words, and turns whiteboard notes into tasks", async () => {
    const { orgId, me, list, folder } = await listWith("pj-docs");
    const blocks = cleanBlocks([
      { id: "a", type: "h1", text: "Founding member FAQ" },
      { id: "b", type: "image", text: "", url: "javascript:alert(1)" },
      { id: "c", type: "check", text: "Seat limit filled in", done: false },
      { id: "d", type: "script" as "p", text: "<script>x</script>" },
    ]);
    expect(blocks[1].url).toBeUndefined();
    expect(blocks[3].type).toBe("p");
    const doc = await me.pj.saveDoc({ organizationId: orgId, folderId: folder.id, title: "Founding member FAQ", blocks });
    await me.pj.toggleDocCheck({ organizationId: orgId, id: doc.id, blockId: "c", done: true });
    const made = await me.pj.docTask({ organizationId: orgId, id: doc.id, text: "Practices stop paying for a separate EHR", listId: list.id });
    let d = await me.pj.doc({ organizationId: orgId, id: doc.id });
    expect(d.doc.blocks.find((b) => b.id === "c")!.done).toBe(true);
    expect(d.linked.map((x) => x.id)).toEqual([made.id]);
    await me.pj.saveDoc({ organizationId: orgId, parentId: doc.id, title: "Demo call answers" });
    await me.pj.docComment({ organizationId: orgId, id: doc.id, quote: "separate EHR", body: "Name the EHRs?" });
    d = await me.pj.doc({ organizationId: orgId, id: doc.id });
    expect(d.pages.map((p) => p.title)).toEqual(["Demo call answers"]);
    expect(d.comments[0]).toMatchObject({ quote: "separate EHR", body: "Name the EHRs?" });
    const tree = await me.pj.tree({ organizationId: orgId });
    expect(tree.folders[0].items.map((i) => i.kind)).toEqual(["doc"]);

    const b = await me.pj.saveBoard({ organizationId: orgId, folderId: folder.id, title: "Launch whiteboard" });
    await me.pj.saveBoardItems({ organizationId: orgId, id: b.id, items: [{ id: "s1", kind: "sticky", x: 10, y: 10, w: 150, h: 100, color: "#fff3b0", text: "FAQ page" }, { id: "s2", kind: "sticky", x: 200, y: 10, w: 150, h: 100, text: "Seat counter" }, { id: "a1", kind: "arrow", x: 0, y: 0, w: 0, h: 0, from: "s1", to: "s2" }] });
    const r = await me.pj.boardTasks({ organizationId: orgId, id: b.id, itemIds: ["s1", "s2"], listId: list.id });
    expect(r.made).toBe(2);
    const bd = await me.pj.board({ organizationId: orgId, id: b.id });
    expect(bd.board.items.filter((i) => i.kind === "task")).toHaveLength(2);
    expect(bd.tasks.map((t) => t.name).sort()).toEqual(["FAQ page", "Seat counter"]);
  });

  it("turns a form answer into a task with its fields, files and assignee", async () => {
    const { orgId, me, list, folder } = await listWith("pj-forms");
    await me.pj.saveList({ organizationId: orgId, id: list.id, name: list.name, folderId: folder.id, fields: [{ id: "size", name: "Size", type: "dropdown", options: [{ id: "s1", name: "1 to 5", color: "#1090e0" }, { id: "s2", name: "6 or more", color: "#f76808" }] }, { id: "mail", name: "Contact", type: "email" }] });
    const f = await me.pj.saveForm({
      organizationId: orgId,
      folderId: folder.id,
      title: "Founding member interest",
      listId: list.id,
      questions: [
        { id: "q1", label: "Practice name", type: "text", required: true, mapTo: "name" },
        { id: "q2", label: "Email", type: "email", required: true, mapTo: "field:mail" },
        { id: "q3", label: "How many clinicians?", type: "dropdown", required: false, options: ["1 to 5", "6 or more"], mapTo: "field:size" },
        { id: "q4", label: "Current paperwork", type: "files", required: false, mapTo: "attachments" },
      ],
      settings: { intro: "25 seats.", status: "", assignTo: "", ask: "", thanks: "Thanks, Avery will reach out today." },
    });
    await expect(submit(f.token, { q2: "a@b.co" }, {})).rejects.toThrow(/Practice name/);
    await expect(submit(f.token, { q1: "Healing Trees", q2: "not an email" }, {})).rejects.toThrow(/email/);
    const r = await submit(f.token, { q1: "Healing Trees", q2: "melinda@example.com", q3: "6 or more" }, { q4: [{ name: "intake.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4 test").toString("base64") }] });
    expect(r.thanks).toBe("Thanks, Avery will reach out today.");
    const t = db.work.tasks.where(orgId, "listId", list.id)[0];
    expect(t.name).toBe("Healing Trees");
    expect(pj.parse<Record<string, unknown>>(t.fields, {})).toMatchObject({ mail: "melinda@example.com", size: "s2" });
    expect(db.work.files.all(orgId).filter((x) => x.itemType === "task" && x.itemId === t.id)).toHaveLength(1);
    const ans = await me.pj.formAnswers({ organizationId: orgId, id: f.id });
    expect(ans[0].items.find((i) => i.label === "How many clinicians?")!.value).toBe("6 or more");
  });

  it("works out dashboard cards", async () => {
    const { orgId, me, list } = await listWith("pj-dash");
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Late one", dueDate: "2020-01-01" });
    const done = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Done one" });
    await me.pj.update({ organizationId: orgId, id: done.id, patch: { status: "complete" } });
    const dash = await me.pj.saveDashboard({ organizationId: orgId, name: "Founding member launch" });
    const data = await me.pj.dashboardData({ organizationId: orgId, id: dash.id });
    expect(data.cards.find((c) => c.title === "Open tasks")).toMatchObject({ number: 1, sub: "1 overdue" });
    expect(data.cards.find((c) => c.title === "Done this week")).toMatchObject({ number: 1 });
    expect((data.cards.find((c) => c.type === "trend") as { done: number[] }).done.at(-1)).toBe(1);
  });

  it("runs the new automation triggers and actions", async () => {
    const { orgId, me, list, folder } = await listWith("pj-auto");
    await me.pj.saveList({ organizationId: orgId, id: list.id, name: list.name, folderId: folder.id, fields: [{ id: "prog", name: "Progress", type: "dropdown", options: [{ id: "d", name: "Danger", color: "#e5484d" }] }] });
    await me.pj.saveAutomation({ organizationId: orgId, listId: null, folderId: folder.id, trigger: { on: "field", field: "prog", to: "d" }, action: { do: "meeting", value: "{task} is in danger" }, active: true });
    await me.pj.saveAutomation({ organizationId: orgId, listId: list.id, trigger: { on: "comment" }, action: { do: "priority", value: "high" }, active: true });
    await expect(me.pj.saveAutomation({ organizationId: orgId, listId: null, trigger: { on: "schedule", every: "week", day: 1, time: "08:00" }, action: { do: "priority", value: "high" }, active: true })).rejects.toThrow(/scheduled/);
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Cold email" });
    await me.pj.update({ organizationId: orgId, id: t.id, patch: { fields: { prog: "d" } } });
    const topics = db.work.reads.all(orgId).find((r) => r.weekStart === "topics");
    expect(JSON.parse(topics!.items)[0].text).toBe("Cold email is in danger");
    await me.pj.comment({ organizationId: orgId, taskId: t.id, body: "Reply rate dropped.", fileIds: [] });
    expect(db.work.tasks.get(orgId, t.id)!.priority).toBe("high");
    expect((await me.pj.automations({ organizationId: orgId, listId: null, folderId: folder.id })).map((a) => a.trigger.on)).toEqual(["field"]);
  });

  it("shares lists: private lists, access levels, guests who see only their list, and a view-only link", async () => {
    const { orgId, owner, me, list, reviewer } = await listWith("pj-share");
    const secret = await me.pj.saveList({ organizationId: orgId, name: "Payroll changes", folderId: null });
    await me.pj.setPrivate({ organizationId: orgId, listId: secret.id, on: true });
    const member = await makeUser("member@pj-share.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: orgId, userId: member.id, role: "member" });
    const cj = caller(member);
    expect((await cj.pj.tree({ organizationId: orgId })).loose.map((l) => l.name)).not.toContain("Payroll changes");
    await expect(cj.pj.view({ organizationId: orgId, listId: secret.id, scope: "list", closed: false })).rejects.toThrow();
    await me.pj.share({ organizationId: orgId, listId: secret.id, kind: "user", id: member.id, level: "comment" });
    const t = await me.pj.create({ organizationId: orgId, listId: secret.id, name: "New hire paperwork" });
    expect((await cj.pj.view({ organizationId: orgId, listId: secret.id, scope: "list", closed: false })).list!.level).toBe("comment");
    await cj.pj.comment({ organizationId: orgId, taskId: t.id, body: "On it.", fileIds: [] });
    await expect(cj.pj.update({ organizationId: orgId, id: t.id, patch: { name: "x" } })).rejects.toThrow(/can't change/);
    // A reviewer only looks.
    await expect(caller(reviewer).pj.create({ organizationId: orgId, listId: list.id, name: "x" })).rejects.toThrow();

    // A guest sees only the list shared with them, and nothing else in the workspace.
    await me.pj.share({ organizationId: orgId, listId: list.id, email: "kim@designstudio.co", level: "edit" });
    const kim = (await db.getUserByEmail("kim@designstudio.co"))!;
    const g = caller(kim);
    const orgs = await g.organizations.list();
    expect(orgs.find((o) => o.id === orgId)).toMatchObject({ guest: true });
    const tree = await g.pj.tree({ organizationId: orgId });
    expect(tree.guest).toBe(true);
    expect([...tree.loose, ...tree.folders.flatMap((f) => f.lists)].map((l) => l.name)).toEqual(["Founding Members"]);
    const gt = await g.pj.create({ organizationId: orgId, listId: list.id, name: "Hero image" });
    expect(gt.name).toBe("Hero image");
    await expect(g.pj.create({ organizationId: orgId, listId: secret.id, name: "x" })).rejects.toThrow();
    await expect(g.pj.dashboards({ organizationId: orgId })).rejects.toThrow();
    await expect(g.goals.overview({ organizationId: orgId })).rejects.toThrow();
    await expect(g.pj.share({ organizationId: orgId, listId: list.id, email: "x@y.co", level: "edit" })).rejects.toThrow();
    const sh = await me.pj.shares({ organizationId: orgId, listId: list.id });
    expect(sh.people.find((p) => p.kind === "guest")).toMatchObject({ email: "kim@designstudio.co", level: "edit" });
    expect(sh.people.find((p) => p.id === owner.id)).toMatchObject({ level: "owner", fixed: true });

    // The view-only link.
    const { link } = await me.pj.setLink({ organizationId: orgId, listId: list.id, on: true });
    expect(link).toMatch(/\/share\//);
    expect(db.listByShareToken(link!.split("/share/")[1])!.id).toBe(list.id);
    await me.pj.setLink({ organizationId: orgId, listId: list.id, on: false });
    expect(db.work.lists.get(orgId, list.id)!.shareToken).toBeNull();
  });
  it("saved views, columns, quick fields, the folder Overview and the Docs page", async () => {
    const { orgId, me, folder, list, owner } = await listWith("pj-views");
    const caroline = await makeUser("caroline@pj-views.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: orgId, userId: caroline.id, role: "member" });
    const her = caller(caroline);
    const other = await me.pj.saveList({ organizationId: orgId, name: "AI Receptionist", folderId: folder.id });
    const t1 = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Landing page", dueDate: "2099-10-07", startDate: "2099-10-01", assignees: [{ type: "user", id: caroline.id, name: "Caroline Jones" }] });
    await me.pj.update({ organizationId: orgId, id: t1.id, patch: { priority: "urgent" } });
    const t2 = await me.pj.create({ organizationId: orgId, listId: other.id, name: "Greeting script", dueDate: "2026-12-15" });
    await me.pj.update({ organizationId: orgId, id: t2.id, patch: { status: "complete" } });

    // A new field straight from the + column menu, on the whole folder: every list in it gets the column.
    const f = await me.pj.addField({ organizationId: orgId, listId: list.id, scope: "folder", name: "Agency", type: "dropdown", options: ["ODMHSAS", "OHCA"] });
    expect(f.scope).toBe("folder");
    const v = await me.pj.view({ organizationId: orgId, listId: other.id, scope: "list" });
    expect(v.fields.map((x) => [x.name, x.scope])).toEqual([["Agency", "folder"]]);
    await me.pj.update({ organizationId: orgId, id: t1.id, patch: { fields: { [f.id]: f.options![0].id } } });

    // Columns chosen on the built-in List tab stay for everyone; a member with view access can't change them.
    await me.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "list", settings: { columns: ["assignee", "due", `f:${f.id}`, "nope"] } });
    expect((await her.pj.views({ organizationId: orgId, listId: list.id })).builtin.list.columns).toEqual(["assignee", "due", `f:${f.id}`]);

    // A saved view keeps its own filters and columns; a private one is hers alone.
    const sv = await me.pj.saveView({ organizationId: orgId, listId: list.id, name: "Caroline's week", kind: "board", settings: { who: `user:${caroline.id}:Caroline Jones`, group: "priority" }, private: false, pinned: true });
    const mine = await her.pj.saveView({ organizationId: orgId, listId: list.id, name: "Just me", kind: "list", settings: { closed: true }, private: true, pinned: false });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).saved.map((x) => x.name)).toEqual(["Caroline's week"]);
    expect((await her.pj.views({ organizationId: orgId, listId: list.id })).saved.map((x) => [x.name, x.kind, x.pinned, x.private])).toEqual([["Caroline's week", "board", true, false], ["Just me", "list", false, true]]);
    await expect(me.pj.removeView({ organizationId: orgId, id: mine.id })).rejects.toThrow(/someone else/);
    // With view-only access she can keep a private view but not make one for everyone, nor change the built-in columns.
    await me.pj.share({ organizationId: orgId, listId: list.id, kind: "user", id: caroline.id, level: "view" });
    await expect(her.pj.saveView({ organizationId: orgId, listId: list.id, name: "For all", kind: "list", settings: {}, private: false, pinned: false })).rejects.toThrow(/only you see/);
    await expect(her.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "list", settings: { columns: ["assignee"] } })).rejects.toThrow(/not change its views/);
    await me.pj.removeView({ organizationId: orgId, id: sv.id });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).saved).toEqual([]);

    // The folder shows every list's tasks together, and its Overview adds up.
    const fv = await me.pj.view({ organizationId: orgId, listId: null, folderId: folder.id, scope: "folder", closed: true });
    expect(fv.folder?.name).toBe("Offers");
    expect(fv.tasks.map((t) => t.name).sort()).toEqual(["Greeting script", "Landing page"]);
    const doc = await me.pj.saveDoc({ organizationId: orgId, title: "Offer FAQ", listId: list.id, blocks: [{ id: "b0", type: "p", text: "Twenty five seats at the founding price." }] });
    const ov = await me.pj.overview({ organizationId: orgId, folderId: folder.id });
    expect(ov.totals).toMatchObject({ open: 1, overdue: 0, total: 2 });
    expect(ov.lists.map((l) => [l.name, l.done, l.total, l.start, l.end, l.lead?.name ?? null, l.priority])).toEqual([["Founding Members", 0, 1, "2099-10-01", "2099-10-07", "Caroline Jones", "urgent"], ["AI Receptionist", 1, 1, "2026-12-15", "2026-12-15", null, null]]);
    expect(ov.items.map((i) => [i.kind, i.name])).toEqual([["doc", "Offer FAQ"]]);
    expect(ov.byPerson.map((p) => [p.name, p.n])).toEqual([["Caroline Jones", 1]]);
    // A doc made on a list sits under that list in the tree.
    const tree = await me.pj.tree({ organizationId: orgId });
    expect(tree.folders[0].lists.find((l) => l.id === list.id)!.items.map((i) => i.name)).toEqual(["Offer FAQ"]);
    expect(tree.folders[0].items).toEqual([]);

    // The Docs page lists everything, searches inside the text, and moves and tags.
    const all = await me.pj.allDocs({ organizationId: orgId, q: "" });
    expect(all.docs.map((d) => [d.kind, d.name, d.where?.name, d.mine])).toEqual([["doc", "Offer FAQ", "Founding Members", true]]);
    expect((await me.pj.allDocs({ organizationId: orgId, q: "founding price" })).docs.map((d) => d.name)).toEqual(["Offer FAQ"]);
    expect((await me.pj.allDocs({ organizationId: orgId, q: "pricing page" })).docs).toEqual([]);
    await me.pj.placeDoc({ organizationId: orgId, kind: "doc", id: doc.id, folderId: folder.id, listId: null, tags: ["SOP", "offers", "sop"] });
    const moved = (await me.pj.allDocs({ organizationId: orgId, q: "" })).docs[0];
    expect([moved.where?.kind, moved.where?.name, moved.tags]).toEqual(["folder", "Offers", ["sop", "offers"]]);
    expect((await her.pj.allDocs({ organizationId: orgId, q: "" })).counts).toMatchObject({ all: 1, mine: 0 });
    void owner;
  });
});
