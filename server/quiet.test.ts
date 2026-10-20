import { describe, expect, it } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as runner from "./employees/runner";
import * as desk from "./employees/desk";

describe("Work on their own (quiet workspaces)", () => {
  it("is switched by an owner or admin only, and logged in plain words", async () => {
    const { orgId, owner, reviewer } = await makeWorkspace("quiet-switch");
    await expect(caller(reviewer).organizations.update({ id: orgId, quiet: true })).rejects.toThrow();
    expect(db.isQuiet(orgId)).toBe(false);
    await caller(owner).organizations.update({ id: orgId, quiet: true });
    expect(db.isQuiet(orgId)).toBe(true);
    expect(await db.listAwakeOrganizationIds()).not.toContain(orgId);
    const list = await caller(owner).organizations.list();
    expect(list.find((o) => o.id === orgId)?.quiet).toBe(true);
    await caller(owner).organizations.update({ id: orgId, quiet: false });
    expect(await db.listAwakeOrganizationIds()).toContain(orgId);
  });

  it("holds scheduled tasks while quiet: each moves to its next time without running", async () => {
    const { orgId, owner } = await makeWorkspace("quiet-tasks");
    await caller(owner).organizations.update({ id: orgId, quiet: true });
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    const task = await db.createScheduledTask({ organizationId: orgId, createdBy: "Owner", employeeId: nora.id, title: "Daily status", instructions: "Send me a status report.", repeat: "daily", time: "09:00", weekday: null, monthDay: null, onDate: null, enabled: true, nextRunAt: new Date(Date.now() - 60_000), notify: "push" });
    await runner.tick(new Date());
    const after = (await db.listScheduledTasks(orgId)).find((x) => x.id === task.id)!;
    expect(after.lastRunAt).toBeNull();
    expect(after.enabled).toBe(true);
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect((await db.listChatMessages(orgId, nora.id)).some((m) => m.authorName === "Scheduled task: Daily status")).toBe(false);
  });

  it("posts no morning brief while quiet, and posts it again once switched back on", async () => {
    const { orgId, owner } = await makeWorkspace("quiet-brief");
    await db.updateOrganization(orgId, { timezone: "America/Chicago" });
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    await db.updateEmployee(avery.id, orgId, { status: "active" });
    const mon = new Date("2026-10-05T12:31:00Z"); // 7:31 AM in Chicago, a Monday
    await caller(owner).organizations.update({ id: orgId, quiet: true });
    await desk.briefTick(mon);
    expect(await db.listChatMessages(orgId, avery.id, 10)).toHaveLength(0);
    await caller(owner).organizations.update({ id: orgId, quiet: false });
    await desk.briefTick(new Date(mon.getTime() + 60_000));
    expect(await db.listChatMessages(orgId, avery.id, 10)).toHaveLength(1);
  });
});
