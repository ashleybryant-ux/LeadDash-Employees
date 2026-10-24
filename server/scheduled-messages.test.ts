import { describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? { reply: "Got it, I'll have the report ready.", action: "none", choices: [] } : {})),
    generateText: vi.fn(async () => ""),
  };
});
vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));

import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { sendDue } from "./scheduledMessages";

const HOUR = 3600_000;

describe("Scheduled messages", () => {
  it("holds a team chat message until its time, then posts it as the person who wrote it", async () => {
    const { orgId, owner } = await makeWorkspace("sched-team");
    const me = caller(owner);
    const sendAt = Date.now() + HOUR;
    const s = await me.scheduled.create({ organizationId: orgId, channel: "everyone", content: "Staff meeting moved to 10:00.", sendAt, timezone: "America/Los_Angeles" });
    expect(s.status).toBe("waiting");
    expect(s.timezone).toBe("America/Los_Angeles");

    // Not yet: nothing in the channel, and it shows above the box.
    expect(await sendDue(new Date())).toBe(0);
    let msgs = await me.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(msgs.messages.some((m) => m.content.includes("Staff meeting moved"))).toBe(false);
    expect((await me.scheduled.list({ organizationId: orgId, channel: "everyone" })).map((r) => r.id)).toEqual([s.id]);

    // Its time comes: posted under the owner, and gone from the waiting list.
    expect(await sendDue(new Date(sendAt + 1000))).toBe(1);
    msgs = await me.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    const posted = msgs.messages.find((m) => m.content.includes("Staff meeting moved"));
    expect(posted?.userId).toBe(owner.id);
    expect(await me.scheduled.list({ organizationId: orgId, channel: "everyone" })).toEqual([]);
    expect(await sendDue(new Date(sendAt + 120_000))).toBe(0);
  });

  it("sends a message to an AI employee at its time, and the employee answers in the chat", async () => {
    const { orgId, owner } = await makeWorkspace("sched-emp");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const me = caller(owner);
    const sendAt = Date.now() + 2 * HOUR;
    await me.scheduled.create({ organizationId: orgId, employeeId: theo.id, content: "Send me this week's blog report.", sendAt });
    expect(await me.scheduled.list({ organizationId: orgId, employeeId: theo.id })).toHaveLength(1);
    await sendDue(new Date(sendAt + 1000));
    const chat = await me.chat.list({ organizationId: orgId, employeeId: theo.id });
    const asked = chat.find((m) => m.content === "Send me this week's blog report.");
    expect(asked?.userId).toBe(owner.id);
    expect(chat.some((m) => m.role !== "user" && m.content.includes("report ready"))).toBe(true);
  });

  it("Send now, Edit and Delete work only on your own, and a time that has passed is refused", async () => {
    const { orgId, owner } = await makeWorkspace("sched-edit");
    const angela = await makeUser("angela@sched-edit.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const me = caller(owner);
    const her = caller(angela);

    await expect(me.scheduled.create({ organizationId: orgId, channel: "everyone", content: "Too late", sendAt: Date.now() - 10 * 60_000 })).rejects.toThrow(/already passed/);

    const a = await me.scheduled.create({ organizationId: orgId, channel: "everyone", content: "First draft", sendAt: Date.now() + HOUR });
    // Angela neither sees nor touches the owner's scheduled message.
    expect(await her.scheduled.list({ organizationId: orgId, channel: "everyone" })).toEqual([]);
    await expect(her.scheduled.remove({ organizationId: orgId, id: a.id })).rejects.toThrow(/gone/);

    const later = Date.now() + 5 * HOUR;
    const edited = await me.scheduled.update({ organizationId: orgId, id: a.id, content: "Final wording", sendAt: later });
    expect(edited.content).toBe("Final wording");
    expect(new Date(edited.sendAt).getTime()).toBe(Math.floor(later / 1000) * 1000);

    await me.scheduled.sendNow({ organizationId: orgId, id: a.id });
    const msgs = await me.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(msgs.messages.some((m) => m.content === "Final wording")).toBe(true);
    await expect(me.scheduled.sendNow({ organizationId: orgId, id: a.id })).rejects.toThrow(/already gone out/);

    const b = await me.scheduled.create({ organizationId: orgId, channel: "everyone", content: "Never mind", sendAt: Date.now() + HOUR });
    await me.scheduled.remove({ organizationId: orgId, id: b.id });
    expect(await me.scheduled.list({ organizationId: orgId, channel: "everyone" })).toEqual([]);
  });

  it("does not send for someone who has left the team; it shows as not sent", async () => {
    const { orgId, owner } = await makeWorkspace("sched-left");
    const angela = await makeUser("angela@sched-left.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const sendAt = Date.now() + HOUR;
    const s = await caller(angela).scheduled.create({ organizationId: orgId, channel: "everyone", content: "Bye", sendAt });
    await db.removeMember(orgId, angela.id);
    await sendDue(new Date(sendAt + 1000));
    const msgs = await caller(owner).teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(msgs.messages.some((m) => m.content === "Bye")).toBe(false);
    const { getDb } = db;
    const row = getDb().$client.prepare("select status, error from scheduled_messages where id = ?").get(s.id) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no longer on this workspace/);
  });
});

describe("Time zone that follows the device", () => {
  it("moves the workspace's time zone when the owner's device reports a new one", async () => {
    const { orgId, owner } = await makeWorkspace("tz-travel");
    const me = caller(owner);
    // Workspaces follow their owner's device by default.
    await db.updateOrganization(orgId, { timezoneFollowUserId: owner.id, timezone: "America/Chicago" });
    const r = await me.auth.deviceZone({ timezone: "America/Los_Angeles" });
    expect(r.changed).toContain(orgId);
    expect((await db.getOrganizationById(orgId))?.timezone).toBe("America/Los_Angeles");
    expect((await db.getUserById(owner.id))?.timezone).toBe("America/Los_Angeles");

    // A fixed time zone stays put.
    await me.organizations.update({ id: orgId, timezone: "America/New_York", followMyDevice: false });
    await me.auth.deviceZone({ timezone: "Europe/London" });
    expect((await db.getOrganizationById(orgId))?.timezone).toBe("America/New_York");

    // Following again picks up the zone the device is in now.
    await me.organizations.update({ id: orgId, followMyDevice: true });
    expect((await db.getOrganizationById(orgId))?.timezone).toBe("Europe/London");

    // Nonsense from a device changes nothing.
    await me.auth.deviceZone({ timezone: "Not/AZone" });
    expect((await db.getOrganizationById(orgId))?.timezone).toBe("Europe/London");
  });
});
