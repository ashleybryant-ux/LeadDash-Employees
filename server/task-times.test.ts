import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as tt from "./work/taskTimes";
import { zonedToUtc } from "./employees/schedule";

/**
 * Projects Home is the signed-in person's own work; owners and admins get All
 * tasks. Find time puts a task on the person's calendar inside their work
 * hours, around their other task times and (for the owner) the connected
 * calendars; a time that ends with the task open moves on; checking the task
 * off marks the time done.
 */

afterEach(() => vi.restoreAllMocks());

const TZ = "America/Chicago";
// Monday, Oct 19, 2026 at 8:00 AM in Chicago.
const MON_8 = zonedToUtc(2026, 10, 19, 8, 0, TZ);
const at = (d: number, h: number, m = 0) => zonedToUtc(2026, 10, d, h, m, TZ);

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  await db.updateOrganization(ws.orgId, { timezone: TZ });
  const me = caller(ws.owner);
  const list = await me.pj.saveList({ organizationId: ws.orgId, name: "Launch", folderId: null });
  const ab = { type: "user" as const, id: ws.owner.id, name: ws.owner.name ?? "Owner" };
  return { ...ws, me, list, ab };
}

describe("Find time", () => {
  it("finds the first open time inside work hours, around other task times and the owner's calendars", async () => {
    const { orgId, me, list, ab, owner } = await setup("ft-find");
    const a = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Write the terms", dueDate: "2026-10-21", assignees: [ab] });
    const b = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Draft the one-pager", dueDate: "2026-10-21", assignees: [ab] });
    // The owner's calendar has a meeting 9:00 to 10:30.
    const cal = vi.spyOn(tt.timeTools, "calendarBusy").mockResolvedValue([{ start: at(19, 9), end: at(19, 10, 30) }]);
    const first = await tt.findSlot(orgId, owner.id, 60, "first", { now: MON_8 });
    expect(first?.start.toISOString()).toBe(at(19, 10, 30).toISOString());
    expect(first?.calendars).toBe(true);
    tt.saveTime(orgId, owner.id, { taskId: a.id, start: first!.start, minutes: 60 });
    // The next task goes after it; "Another time" skips past the one shown.
    const second = await tt.findSlot(orgId, owner.id, 60, "first", { now: MON_8, skipTaskId: b.id });
    expect(second?.start.toISOString()).toBe(at(19, 11, 30).toISOString());
    const later = await tt.findSlot(orgId, owner.id, 60, "first", { now: MON_8, after: second!.start, skipTaskId: b.id });
    expect(later?.start.toISOString()).toBe(at(19, 11, 45).toISOString());
    // Tomorrow starts at 9:00 AM the next work day; a Friday afternoon rolls to Monday.
    expect((await tt.findSlot(orgId, owner.id, 60, "tomorrow", { now: MON_8 }))?.start.toISOString()).toBe(at(20, 9).toISOString());
    expect((await tt.findSlot(orgId, owner.id, 120, "first", { now: at(23, 16) }))?.start.toISOString()).toBe(at(26, 9).toISOString());

    // A member's time ignores the owner's calendars.
    const angela = await makeUser("angela@ft-find.test", "user", "Angela");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    cal.mockClear();
    const hers = await tt.findSlot(orgId, angela.id, 60, "first", { now: MON_8 });
    expect(hers?.start.toISOString()).toBe(at(19, 9).toISOString());
    expect(cal).not.toHaveBeenCalled();

    // Work hours and days are each person's own.
    tt.saveSettings(orgId, angela.id, { mode: "ask", minutes: 30, from: "13:00", to: "15:00", days: [2, 4] });
    expect((await tt.findSlot(orgId, angela.id, 30, "first", { now: MON_8 }))?.start.toISOString()).toBe(at(20, 13).toISOString());
    expect(() => tt.saveSettings(orgId, angela.id, { mode: "ask", minutes: 30, from: "15:00", to: "13:00", days: [2] })).toThrow(/start before the end/);
  });

  it("shows only my tasks on Home, with their times, and moves a time that ended with the task open", async () => {
    const { orgId, me, list, ab, owner } = await setup("ft-home");
    vi.spyOn(tt.timeTools, "calendarBusy").mockResolvedValue([]);
    const angela = await makeUser("angela@ft-home.test", "user", "Angela");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const tz = (await db.getOrganizationById(orgId))!.timezone!;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const mine = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Mine", dueDate: today, assignees: [ab] });
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Hers", dueDate: today, assignees: [{ type: "user", id: angela.id, name: "Angela" }] });
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Nobody's", dueDate: today });
    let h = await me.pj.home({ organizationId: orgId });
    expect(h.todayTasks.map((t) => t.name)).toEqual(["Mine"]);
    expect(h.attention).toEqual([]);

    // Find time, then Save.
    const s = await me.pj.findTime({ organizationId: orgId, taskId: mine.id, minutes: 60, when: "first" });
    expect(s.found).toBe(true);
    if (!s.found) return;
    expect(s.why).toMatch(/Open on your calendars and inside your work hours \(9:00 AM to 5:00 PM\)/);
    await me.pj.saveTime({ organizationId: orgId, taskId: mine.id, start: s.start, minutes: 60 });
    h = await me.pj.home({ organizationId: orgId });
    const row = [...h.todayTasks, ...h.week, ...h.later].find((t) => t.id === mine.id)!;
    expect(row.time?.text).toMatch(/to/);
    expect(row.time?.moves).toBe(0);

    // The time ends with the task still open: it moves on and says where it was.
    const time = tt.timeOf(orgId, owner.id, mine.id)!;
    const after = new Date(new Date(time.end).getTime() + 60_000);
    await tt.taskTimesTick(after);
    const moved = tt.timeOf(orgId, owner.id, mine.id)!;
    expect(moved.moves).toBe(1);
    expect(new Date(moved.movedFrom!).getTime()).toBe(new Date(time.start).getTime());
    expect(new Date(moved.start).getTime()).toBeGreaterThanOrEqual(after.getTime());
    // After three moves it needs the person.
    db.work.taskTimes.update(orgId, moved.id, { moves: 3 });
    h = await me.pj.home({ organizationId: orgId });
    expect(h.attention.map((t) => [t.name, t.why])).toEqual([["Mine", "Moved 3 times"]]);

    // Checking it off marks the time done; it stays under Today, checked, until tomorrow.
    const done = (await me.pj.home({ organizationId: orgId })).lists[0].statuses.find((x) => x.type === "done" || x.type === "closed")!;
    await me.pj.update({ organizationId: orgId, id: mine.id, patch: { status: done.name } });
    expect(tt.timeOf(orgId, owner.id, mine.id)).toBeNull();
    expect(db.work.taskTimes.where(orgId, "taskId", mine.id).some((x) => x.status === "done")).toBe(true);
    h = await me.pj.home({ organizationId: orgId });
    expect(h.todayTasks.find((t) => t.id === mine.id)?.closed).toBe(true);

    // The Calendar shows my task times, with the task to check off.
    const cal = await me.calendar.range({ organizationId: orgId, from: today, days: 14 });
    expect(cal.items.find((i) => i.kind === "tasktime")).toMatchObject({ title: "Mine", task: { id: mine.id, closed: true } });
  });

  it("finds time on its own for a person set to every new task, and only owners and admins get All tasks", async () => {
    const { orgId, me, list, ab, owner } = await setup("ft-auto");
    vi.spyOn(tt.timeTools, "calendarBusy").mockResolvedValue([]);
    await me.pj.saveFindTimeSettings({ organizationId: orgId, mode: "auto", minutes: 30, from: "09:00", to: "17:00", days: [1, 2, 3, 4, 5] });
    const t = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Plan the webinar", dueDate: "2026-10-23", assignees: [ab] });
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "No date yet", assignees: [ab] });
    const r = await tt.taskTimesTick(MON_8);
    expect(r.placed).toBe(1);
    expect(tt.timeOf(orgId, owner.id, t.id)).toMatchObject({ minutes: 30, start: at(19, 9) });
    // A time the person removed isn't put back.
    tt.clearTime(orgId, owner.id, t.id);
    expect((await tt.taskTimesTick(MON_8)).placed).toBe(0);

    expect((await me.pj.nav({ organizationId: orgId })).shown).toContain("all");
    const angela = await makeUser("angela@ft-auto.test", "user", "Angela");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const nav = await caller(angela).pj.nav({ organizationId: orgId });
    expect([...nav.shown, ...nav.more]).not.toContain("all");
    // An owner who takes All tasks off the sidebar keeps it off.
    await me.pj.setNav({ organizationId: orgId, shown: ["home", "mine", "everything"] });
    const after = await me.pj.nav({ organizationId: orgId });
    expect(after.shown).not.toContain("all");
    expect(after.more).toContain("all");
  });
});
