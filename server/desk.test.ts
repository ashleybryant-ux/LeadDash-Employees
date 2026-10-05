import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as desk from "./employees/desk";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

beforeEach(() => {
  // No calendars are connected in these tests; nothing should reach the network.
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mockAi(decision: any) {
  const llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => (opts.schemaName === "chat_decision" ? ({ ...blank, ...decision } as any) : ({} as any)));
}

/** A workspace with Caroline on the team as an admin. */
async function team(slug: string) {
  const w = await makeWorkspace(slug);
  const caroline = await makeUser(`caroline@${slug}.test`, "user", "Caroline Mwangi");
  await db.addOrganizationMember({ organizationId: w.orgId, userId: caroline.id, role: "admin" });
  return { ...w, caroline };
}

const price = (orgId: number, from: any = "projects") =>
  desk.raiseDecision(orgId, {
    fromKind: from,
    title: "Pick the AI Employees launch price",
    why: "The landing page and the launch emails wait on it.",
    project: "AI Employees launch",
    options: [
      { label: "Option A", text: "[Price A] a month, every employee included", source: "Nora's plan" },
      { label: "Option B", text: "[Price B] a month for 5 employees", source: "Nora's plan" },
    ],
    suggested: 1,
    dueAt: new Date(Date.now() + 20 * 3_600_000),
  });

describe("Avery's desk", () => {
  it("merges the same ask from three employees, keeps prices for the owner, lets Caroline add a note, and tells everyone who asked", async () => {
    const { orgId, owner, caroline } = await team("desk1");
    const first = await price(orgId, "projects");
    expect(first.merged).toBe(false);
    expect(first.decision.category).toBe("price");
    const again = await desk.raiseDecision(orgId, { fromKind: "outreach", title: "Launch price for AI Employees: pick one" });
    expect(again.merged).toBe(true);
    await desk.raiseDecision(orgId, { fromKind: "website", title: "AI Employees launch price" });
    const c = caller(caroline);
    const view = await c.desk.decisions({ organizationId: orgId });
    const row = view.open.find((d) => d.source === "desk")!;
    expect(row.from).toEqual(["Nora", "Jada", "Jordan"]);
    expect(row.who).toBe("you");
    expect(row.canDecide).toBe(false);
    expect(row.urgency).toBe("today");

    // Caroline can't approve a price, but she can leave a note on it.
    await expect(c.desk.decide({ organizationId: orgId, id: row.id!, choice: "Option B" })).rejects.toThrow(/Only Owner can decide prices and fees/);
    await c.desk.note({ organizationId: orgId, id: row.id!, text: "Jada's emails are written for B. I'd go with B." });

    const o = caller(owner);
    const done = await o.desk.decide({ organizationId: orgId, id: row.id! });
    expect(done.choice).toBe("Option B");
    expect(done.decidedBy).toBe("Owner desk1");
    const after = await o.desk.decisions({ organizationId: orgId });
    expect(after.open.some((d) => d.key === row.key)).toBe(false);
    expect(after.decided[0]).toMatchObject({ result: "Decided", by: "Owner desk1" });
    expect(after.decided[0].title).toContain("Option B");

    // Each employee who asked hears it in their own chat.
    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    const msgs = await db.listChatMessages(orgId, jada.id, 10);
    expect(msgs.some((m) => m.role === "handoff" && /decided "Pick the AI Employees launch price": Option B/.test(m.content))).toBe(true);
  });

  it("puts the employees' approvals in the same queue, and blocks Caroline only on the kinds the owner keeps", async () => {
    const { orgId, owner, caroline } = await team("desk2");
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const posts = [];
    for (const t of ["Sleep and anxiety tip", "Monday check-in", "Office hours", "Boundaries at work"]) posts.push(await db.createOutboundItem({ organizationId: orgId, employeeId: sienna.id, kind: "social_post", status: "pending_approval", title: t, body: t, targetChannels: JSON.stringify(["linkedin"]) }));
    const q = await desk.queue(orgId);
    const row = q.find((d) => d.source === "approvals")!;
    expect(row).toMatchObject({ title: "4 social posts ready", who: "team", from: ["Sienna"], link: "/approvals", count: 4 });

    // By default Caroline may send a post back; with posts kept for the owner, she can't approve one.
    await caller(owner).desk.saveRules({ organizationId: orgId, rules: { onlyYou: ["price", "contract", "press", "legal", "clinical", "post"] } });
    await expect(caller(caroline).publishing.approveAndDispatch({ organizationId: orgId, itemId: posts[0].id, action: "approve_for_dispatch" })).rejects.toThrow(/Only Owner can decide posts and articles/);
    const back = await caller(caroline).publishing.approveAndDispatch({ organizationId: orgId, itemId: posts[1].id, action: "request_revisions", notes: "Lead with the tip." });
    expect(back?.status).toBe("changes_requested");
    const decided = await desk.decidedToday(orgId);
    expect(decided[0]).toMatchObject({ result: "Sent back", by: "Caroline Mwangi", title: "Monday check-in" });

    // Only the owner changes who decides; Caroline can still change the time rules.
    await expect(caller(caroline).desk.saveRules({ organizationId: orgId, rules: { onlyYou: [] } })).rejects.toThrow(/Only Owner can change who decides/);
    const saved = await caller(caroline).desk.saveRules({ organizationId: orgId, rules: { time: { focusFrom: "13:00", focusTo: "16:00", focusDays: [1, 3] } } });
    expect(saved.time).toMatchObject({ focusFrom: "13:00", focusTo: "16:00", focusDays: [1, 3], meetFrom: "09:00" });
    expect(saved.onlyYou).toContain("post");
    expect(saved.duties.money).toBe("ask");
  });

  it("turns Nora's person-owned plan tasks into decisions and meeting tasks into promises, and closes the task when it's decided", async () => {
    const { orgId, owner } = await team("desk3");
    const launch = await db.createLaunch({ organizationId: orgId, name: "AI Employees launch", launchDate: new Date(Date.now() + 30 * 86_400_000), status: "active", brief: "", approvedBy: "Owner", approvedAt: new Date() });
    const due = new Date(Date.now() + 3 * 86_400_000);
    const t1 = await db.createLaunchTask({ organizationId: orgId, launchId: launch.id, milestoneId: null, title: "Approve the launch pricing", ownerType: "person", ownerName: "Owner desk3", dueDate: due, source: "plan" });
    await db.createLaunchTask({ organizationId: orgId, launchId: launch.id, milestoneId: null, title: "Send pricing to Obsidian Therapy Group", ownerType: "person", ownerName: "Owner desk3", dueDate: due, source: "meeting:4" });
    await db.createLaunchTask({ organizationId: orgId, launchId: launch.id, milestoneId: null, title: "Logo files for the landing page", ownerType: "person", ownerName: "Dana Reyes", ownerEmail: "dana@vendor.example", dueDate: due, source: "plan" });
    await desk.syncFromNora(orgId);
    await desk.syncFromNora(orgId);
    const q = (await desk.queue(orgId)).filter((d) => d.source === "desk");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ title: "Approve the launch pricing", from: ["Nora"], project: "AI Employees launch", category: "price" });
    const w = await caller(owner).desk.waiting({ organizationId: orgId });
    expect(w.promises.map((p) => p.what)).toEqual(["Send pricing to Obsidian Therapy Group"]);
    expect(w.owed[0]).toMatchObject({ who: "Dana Reyes", email: "dana@vendor.example", blocks: "The AI Employees launch" });
    expect(w.owed[0].nudgeBody).toMatch(/^Hi Dana,\n\nChecking on Logo files for the landing page/);

    await caller(owner).desk.decide({ organizationId: orgId, id: q[0].id!, choice: "Option B" });
    expect((await db.getLaunchTask(t1.id, orgId))!.status).toBe("done");
  });

  it("tracks what people owe, nudges on the day, and brings it back as a decision when it's still not in", async () => {
    const { orgId, owner } = await team("desk4");
    const c = caller(owner);
    const expected = new Date(Date.now() - 2 * 86_400_000);
    const row = await c.desk.addWaiting({ organizationId: orgId, kind: "owed", who: "Missouri vendor office", what: "W-9 approval", blocks: "Your keynote invoice", expectedAt: expected.toISOString() });
    await expect(c.desk.sendNudge({ organizationId: orgId, id: row.id })).rejects.toThrow(/Add Missouri vendor office's email/);
    await c.desk.saveWaiting({ organizationId: orgId, id: row.id, email: "dana@mo.example" });
    // Follow-ups set to ask first: the nudge waits in Approvals instead of sending.
    await c.desk.saveRules({ organizationId: orgId, rules: { duties: { followups: "ask" } } });
    await desk.waitingTick(orgId);
    const drafts = (await db.listOutboundItemsByOrg(orgId)).filter((i) => i.kind === "email_draft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "pending_approval", title: "Checking on W-9 approval" });
    expect(JSON.parse(drafts[0].metadata!)).toMatchObject({ email: "dana@mo.example", nudge: row.id });
    await desk.waitingTick(orgId);
    expect((await db.listOutboundItemsByOrg(orgId)).filter((i) => i.kind === "email_draft")).toHaveLength(1);

    // Days later and still nothing: it comes back as a decision.
    await desk.waitingTick(orgId, new Date(Date.now() + 6 * 86_400_000));
    const q = await desk.queue(orgId);
    expect(q.find((d) => d.title === "Still waiting on Missouri vendor office: W-9 approval")).toBeTruthy();
    const done = await c.desk.finishWaiting({ organizationId: orgId, id: row.id, how: "done" });
    expect(done.status).toBe("done");
  });

  it("shows what Caroline did on the People tab, with a guideline change she can undo", async () => {
    const { orgId, owner, caroline } = await team("desk5");
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const c = caller(caroline);
    const g = await c.guidelines.get({ organizationId: orgId, employeeId: sienna.id });
    const section = g.sections[0].key;
    await caller(owner).guidelines.saveSection({ organizationId: orgId, employeeId: sienna.id, section, lines: [{ text: "Use 3 to 5 hashtags on every post." }] });
    await c.guidelines.saveSection({ organizationId: orgId, employeeId: sienna.id, section, lines: [{ text: "No more than one hashtag per post." }] });
    await db.createChatMessage({ organizationId: orgId, employeeId: (await db.getEmployeeByKind(orgId, "website"))!.id, role: "user", authorName: "Caroline Mwangi", userId: caroline.id, content: "Add a pricing section to the AI Employees landing page." });

    const view = await caller(owner).desk.people({ organizationId: orgId, person: "Caroline Mwangi" });
    expect(view.people.map((p) => p.name)).toEqual(expect.arrayContaining(["Owner desk5", "Caroline Mwangi"]));
    expect(view.rows.every((r) => r.who === "Caroline Mwangi")).toBe(true);
    expect(view.rows.find((r) => r.tag === "Chat")).toMatchObject({ tag: "Chat", text: 'Asked Jordan in chat: "Add a pricing section to the AI Employees landing page."' });
    const edit = view.rows.find((r) => r.tag === "Edited")!;
    expect(edit).toMatchObject({ before: ["Use 3 to 5 hashtags on every post."], after: ["No more than one hashtag per post."], canUndo: true });
    expect(edit.where).toMatch(/^Sienna, /);

    await caller(owner).desk.undo({ organizationId: orgId, logId: Number(edit.id.split(":")[1]) });
    const back = await c.guidelines.get({ organizationId: orgId, employeeId: sienna.id });
    expect(back.sections[0].items.map((i) => i.text)).toEqual(["Use 3 to 5 hashtags on every post."]);
    const again = await caller(owner).desk.people({ organizationId: orgId, person: "Caroline Mwangi" });
    expect(again.rows.find((r) => r.id === edit.id)!.canUndo).toBe(false);
  });

  it("posts the morning brief once at its time, and decides in chat for the person who said it", async () => {
    const { orgId, owner, caroline } = await team("desk6");
    await db.updateOrganization(orgId, { timezone: "America/Chicago" });
    await price(orgId);
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const mon730 = new Date("2026-10-05T12:31:00Z"); // 7:31 AM in Chicago, a Monday
    await desk.briefTick(new Date("2026-10-05T12:00:00Z"));
    expect((await db.listChatMessages(orgId, avery.id, 10)).length).toBe(0);
    await desk.briefTick(mon730);
    await desk.briefTick(new Date(mon730.getTime() + 60_000));
    const msgs = await db.listChatMessages(orgId, avery.id, 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toMatch(/^Good morning\. Monday, October 5, 2026: no meetings and 1 decision\./);
    const card = JSON.parse(msgs[0].cards!)[0];
    expect(card.type).toBe("avery_brief");
    expect(card.items[0]).toMatchObject({ title: "Pick the AI Employees launch price.", button: "Decide" });
    expect(card.items[0].body).toBe("Nora is waiting on it. Avery suggests Option B.");

    // Caroline asks Avery to approve it: Avery says only the owner can.
    await mockAi({ action: "decide", target: "launch price", focus: "Option B", reply: "On it." });
    const r1 = await caller(caroline).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Approve option B for the price" });
    expect(r1.reply.content).toMatch(/Only Owner can decide prices and fees/);
    const r2 = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Approve option B" });
    expect(r2.reply.content).toBe('Done. "Pick the AI Employees launch price": Option B. I told Nora.');

    // "Get Kai to fix the booking page": it goes to Nora as a task.
    await mockAi({ action: "to_nora", title: "Fix the booking page time zone", teammate: "Kai", date: "2026-10-06", reply: "Sending it to Nora." });
    const r3 = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Can you get Kai to fix the booking page today?" });
    expect(r3.reply.content).toMatch(/^I sent it to Nora, since she runs Kai's work\./);
    const launches = await db.listLaunches(orgId);
    const tasks = await db.listLaunchTasks(launches[0].id, orgId);
    expect(tasks[0]).toMatchObject({ title: "Fix the booking page time zone", ownerType: "employee", ownerKind: "developer" });
  });
});
