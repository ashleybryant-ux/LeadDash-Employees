import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { healthOf, nextWeekday, suggestFor } from "./work/pjHome";

afterEach(() => vi.restoreAllMocks());

async function listWith(slug: string) {
  const ws = await makeWorkspace(slug);
  const me = caller(ws.owner);
  const folder = await me.pj.saveFolder({ organizationId: ws.orgId, name: "Webinars", color: "#7c3aed" });
  const list = await me.pj.saveList({ organizationId: ws.orgId, name: "Grow Without Hiring", folderId: folder.id });
  return { ...ws, me, folder, list };
}

const today = () => new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("Projects Home, needs attention, and many tasks at once", () => {
  it("shows what needs a person with Nora's fix, by when, the AI team, and each project's health", async () => {
    const { orgId, me, list, owner } = await listWith("pj-home");
    const ab = { type: "user" as const, id: owner.id, name: `Owner pj-home` };
    const a = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Record webinar intro", dueDate: today(), assignees: [ab] });
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Reminder emails", dueDate: plus(2), assignees: [ab] });
    const late = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Book the booth", dueDate: plus(-3) });
    const noDate = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Approve the outline", assignees: [ab] });
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Landing page", dueDate: plus(30), assignees: [ab] });
    const h = await me.pj.home({ organizationId: orgId });
    // The late task sits in Needs attention, so Today holds only what is due today.
    expect(h.todayTasks.map((t) => t.name)).toEqual(["Record webinar intro"]);
    expect(h.week.map((t) => t.name)).toContain("Reminder emails");
    expect(h.later.map((t) => t.name)).toEqual(["Landing page"]);
    expect(h.undated).toBe(1);
    // Needs attention: the late task with no owner, and the one with no date.
    expect(h.attention.map((t) => [t.name, t.why])).toEqual([
      ["Book the booth", "No owner, Overdue"],
      ["Approve the outline", "No date"],
    ]);
    // Nora suggests the person who holds the most open tasks here, and the next weekday.
    const booth = h.attention.find((t) => t.id === late.id)!;
    expect(booth.suggestion?.patch.assignees).toEqual([ab]);
    expect(booth.suggestion?.patch.dueDate).toBe(nextWeekday(today()));
    expect(booth.suggestion?.say).toMatch(/^give it to Owner pj-home, move it to/);
    const outline = h.attention.find((t) => t.id === noDate.id)!;
    expect(outline.suggestion?.patch.dueDate).toBe(nextWeekday(today()));
    // Projects: one list, at risk because one of five open tasks is late.
    expect(h.projects).toEqual([expect.objectContaining({ name: "Grow Without Hiring", folderName: "Webinars", open: 5, overdue: 1, health: "risk", due: plus(30) })]);
    // The AI team is listed with what each did last.
    expect(h.team.length).toBeGreaterThan(0);
    expect(h.team.every((e) => typeof e.line === "string" && typeof e.active === "boolean")).toBe(true);
    expect(h.mineOnly).toBe(false);

    // Let Nora fix these: she applies her suggestions and says so on each task.
    const r = await me.pj.fixAttention({ organizationId: orgId, ids: null });
    expect(r.fixed).toBe(2);
    expect(db.work.tasks.get(orgId, late.id)).toMatchObject({ dueDate: nextWeekday(today()), assignees: JSON.stringify([ab]) });
    expect(db.work.tasks.get(orgId, noDate.id)!.dueDate).toBe(nextWeekday(today()));
    const nora = await db.getEmployeeByKind(orgId, "projects");
    const said = db.work.comments.where(orgId, "taskId", late.id).map((c) => c.body);
    expect(said.some((s) => s.startsWith(`${nora!.name} gave this to Owner pj-home`))).toBe(true);
    expect((await me.pj.home({ organizationId: orgId })).attention).toEqual([]);
    expect((await db.listActivity(orgId, 5))[0].text).toMatch(/^Groomed 2 tasks in Projects: dates on 2, owners on 1\./);

    // A member sees only their own work by when.
    const angela = await makeUser("angela@pj-home.test", "user", "Angela");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const hm = await caller(angela).pj.home({ organizationId: orgId });
    expect(hm.mineOnly).toBe(true);
    expect(hm.todayTasks).toEqual([]);
    await me.pj.update({ organizationId: orgId, id: a.id, patch: { assignees: [{ type: "user", id: angela.id, name: "Angela" }] } });
    expect((await caller(angela).pj.home({ organizationId: orgId })).todayTasks.map((t) => t.name)).toEqual(["Record webinar intro"]);
  });

  it("works out health, weekdays and suggestions", () => {
    expect(healthOf(0, 0)).toBe("done");
    expect(healthOf(5, 0)).toBe("on");
    expect(healthOf(5, 1)).toBe("risk");
    expect(healthOf(3, 1)).toBe("off");
    expect(nextWeekday("2026-10-10")).toBe("2026-10-12"); // Saturday to Monday
    expect(nextWeekday("2026-10-13")).toBe("2026-10-13");
    const t = { id: 1, listId: 1, assignees: "[]", dueDate: null, closedAt: null } as never;
    const sib = [{ id: 2, listId: 1, assignees: JSON.stringify([{ type: "employee", id: 4, name: "Theo" }]), dueDate: "2026-10-16", closedAt: null }] as never[];
    expect(suggestFor(t, ["owner", "date"], sib, "2026-10-09", null)).toEqual({ say: "give it to Theo, due Oct 16, 2026", patch: { assignees: [{ type: "employee", id: 4, name: "Theo" }], dueDate: "2026-10-16" } });
    expect(suggestFor(t, ["date"], [], "2026-10-09", null)).toEqual({ say: "due Oct 16, 2026", patch: { dueDate: "2026-10-16" } });
    expect(suggestFor(t, ["owner"], [], "2026-10-09", null)).toBeNull();
  });

  it("changes many tasks at once, skips what the person can't change, reorders rows, and keeps three tabs by default", async () => {
    const { orgId, me, list, folder } = await listWith("pj-bulk");
    const other = await me.pj.saveList({ organizationId: orgId, name: "Content Pipeline", folderId: folder.id, statuses: [{ name: "idea", color: "#888", type: "open" }, { name: "published", color: "#080", type: "done" }] });
    const t1 = await me.pj.create({ organizationId: orgId, listId: list.id, name: "One" });
    const t2 = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Two" });
    const t3 = await me.pj.create({ organizationId: orgId, listId: other.id, name: "Three" });
    const theo = { type: "employee" as const, id: 1, name: "Theo" };
    const r = await me.pj.bulk({ organizationId: orgId, ids: [t1.id, t2.id, t3.id], change: { action: "update", patch: { priority: "high", dueDate: "2026-10-16", assign: [theo] } } });
    expect(r).toEqual({ changed: 3, skipped: 0 });
    expect(db.work.tasks.get(orgId, t3.id)).toMatchObject({ priority: "high", dueDate: "2026-10-16", assignees: JSON.stringify([theo]) });
    // A status one list doesn't have is skipped there.
    const s = await me.pj.bulk({ organizationId: orgId, ids: [t1.id, t3.id], change: { action: "update", patch: { status: "in progress" } } });
    expect(s).toEqual({ changed: 1, skipped: 1 });
    expect(db.work.tasks.get(orgId, t3.id)!.status).toBe("idea");
    // Moving to another list takes that list's first status when the old one isn't there.
    await me.pj.bulk({ organizationId: orgId, ids: [t1.id], change: { action: "update", patch: { listId: other.id } } });
    expect(db.work.tasks.get(orgId, t1.id)).toMatchObject({ listId: other.id, status: "idea" });
    // Unassign, then delete.
    await me.pj.bulk({ organizationId: orgId, ids: [t2.id], change: { action: "update", patch: { unassign: [theo] } } });
    expect(db.work.tasks.get(orgId, t2.id)!.assignees).toBe("[]");
    await me.pj.bulk({ organizationId: orgId, ids: [t2.id], change: { action: "remove" } });
    expect(db.work.tasks.get(orgId, t2.id)).toBeNull();
    // A reviewer can't change anything.
    const { reviewer } = await makeWorkspace("pj-bulk-r");
    await db.addOrganizationMember({ organizationId: orgId, userId: reviewer.id, role: "reviewer" });
    await expect(caller(reviewer).pj.bulk({ organizationId: orgId, ids: [t1.id], change: { action: "update", patch: { priority: "low" } } })).rejects.toThrow(/could be changed/);

    // Reorder: the rows take the order given.
    const a = await me.pj.create({ organizationId: orgId, listId: list.id, name: "A" });
    const b = await me.pj.create({ organizationId: orgId, listId: list.id, name: "B" });
    const c = await me.pj.create({ organizationId: orgId, listId: list.id, name: "C" });
    await me.pj.reorder({ organizationId: orgId, ids: [c.id, a.id, b.id] });
    const v = await me.pj.view({ organizationId: orgId, listId: list.id, folderId: null, scope: "list" });
    expect(v.tasks.map((t) => t.name)).toEqual(["C", "A", "B"]);
    expect(v.lists.find((l) => l.id === list.id)).toMatchObject({ folderName: "Webinars", folderColor: "#7c3aed" });

    // Tabs: List, Board and Calendar to start; + View adds Gantt; it can be taken off again, the three never.
    const views = await me.pj.views({ organizationId: orgId, listId: list.id });
    expect(views.tabs).toEqual(["list", "board", "calendar"]);
    await me.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "gantt", settings: {} });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).tabs).toEqual(["list", "board", "calendar", "gantt"]);
    await me.pj.removeBuiltinView({ organizationId: orgId, listId: list.id, kind: "gantt" });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).tabs).toEqual(["list", "board", "calendar"]);
    await expect(me.pj.removeBuiltinView({ organizationId: orgId, listId: list.id, kind: "list" })).rejects.toThrow(/stay/);
    // Grouping by project is a view setting now.
    await me.pj.setBuiltinView({ organizationId: orgId, listId: null, kind: "list", settings: { group: "project" } });
    expect((await me.pj.views({ organizationId: orgId })).builtin.list.group).toBe("project");
  });
});
