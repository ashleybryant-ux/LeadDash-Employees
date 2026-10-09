import { beforeEach, describe, expect, it, vi } from "vitest";

let decision: any = null;
let systems: string[] = [];
let prompts: string[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        systems.push(opts.system);
        prompts.push(opts.prompt);
        return decision;
      }
      return {};
    }),
  };
});

import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { accessOf, canSee, canWrite, pickable, accessLabel } from "./threads";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

describe("each person has their own conversation with each employee", () => {
  beforeEach(() => {
    decision = { ...blank, reply: "Sure." };
    systems = [];
    prompts = [];
  });

  it("keeps a member's conversation apart from the owner's, and the owner sees both", async () => {
    const { orgId, owner } = await makeWorkspace("threads-own");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const angela = await makeUser("angela@threads-own.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });

    decision = { ...blank, reply: "Two clients owe a balance." };
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Who owes a balance?" });
    decision = { ...blank, reply: "Here is the post." };
    await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Write a post" });

    // Each sees only their own.
    const ownerList = await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id });
    expect(ownerList.map((m) => m.content)).toEqual(["Who owes a balance?", "Two clients owe a balance."]);
    const angelaList = await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id });
    expect(angelaList.map((m) => m.content)).toEqual(["Write a post", "Here is the post."]);
    expect(angelaList.every((m) => m.threadUserId === angela.id)).toBe(true);

    // The owner can open Angela's; Angela cannot open the owner's.
    const seen = await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id, thread: angela.id });
    expect(seen.map((m) => m.content)).toEqual(["Write a post", "Here is the post."]);
    await expect(caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id, thread: owner.id })).rejects.toThrow(/your own conversation with Theo/);

    // The picker: the owner sees Angela and the Workspace conversation; Angela has nothing to pick.
    const ownerThreads = await caller(owner).chat.threads({ organizationId: orgId, employeeId: theo.id });
    expect(ownerThreads.people.map((p) => p.name)).toEqual(["Angela St. Ville"]);
    expect(ownerThreads.people[0].unread).toBe(1);
    expect(ownerThreads.workspace).not.toBeNull();
    expect(ownerThreads.canWriteOthers).toBe(true);
    const angelaThreads = await caller(angela).chat.threads({ organizationId: orgId, employeeId: theo.id });
    expect(angelaThreads.people).toEqual([]);
    expect(angelaThreads.workspace).toBeNull();
    expect(angelaThreads.canWriteOthers).toBe(false);

    // The employee answers from that conversation's history only.
    expect(prompts[1]).toContain("Write a post");
    expect(prompts[1]).not.toContain("Who owes a balance?");

    // The chat list preview is the person's own conversation.
    const sums = await caller(angela).chat.summaries({ organizationId: orgId });
    expect(sums.find((s) => s.employeeId === theo.id)?.content).toBe("Here is the post.");
  });

  it("lets an owner jump into a member's conversation, and the reply stays there", async () => {
    const { orgId, owner } = await makeWorkspace("threads-join");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const angela = await makeUser("angela@threads-join.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Draft the newsletter" });

    decision = { ...blank, reply: "Will do, Angela asked for it." };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, thread: angela.id, text: "Make it shorter" });
    expect(r.user.threadUserId).toBe(angela.id);
    expect(r.user.userId).toBe(owner.id);
    expect(r.reply.threadUserId).toBe(angela.id);
    expect(systems[1]).toContain("This is Angela St. Ville's conversation with you");

    const list = await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id });
    expect(list.map((m) => `${m.authorName}: ${m.content}`)).toContain(`Owner threads-join: Make it shorter`);
    // The owner's own conversation is untouched.
    expect(await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id })).toEqual([]);
  });

  it("opens more for a member from the Team page, read only", async () => {
    const { orgId, owner } = await makeWorkspace("threads-team");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const angela = await makeUser("angela@threads-team.test", "user", "Angela St. Ville");
    const bj = await makeUser("bj@threads-team.test", "user", "BJ");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    await db.addOrganizationMember({ organizationId: orgId, userId: bj.id, role: "member" });
    await caller(bj).chat.send({ organizationId: orgId, employeeId: theo.id, text: "BJ's question" });
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Owner's question" });

    // Angela: her own only.
    await expect(caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id, thread: bj.id })).rejects.toThrow(/your own conversation/);

    // Her own plus BJ's.
    await caller(owner).members.setChatAccess({ organizationId: orgId, userId: angela.id, mode: "some", users: [bj.id], workspace: false });
    const m = (await caller(owner).members.list({ organizationId: orgId })).find((x) => x.userId === angela.id)!;
    expect(accessLabel(m)).toBe("Own + 1");
    expect((await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id, thread: bj.id })).map((x) => x.content)).toContain("BJ's question");
    await expect(caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id, thread: owner.id })).rejects.toThrow(/your own conversation/);
    await expect(caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id, thread: "workspace" })).rejects.toThrow(/your own conversation/);
    // Read only: she cannot write in BJ's.
    await expect(caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, thread: bj.id, text: "Hi" })).rejects.toThrow(/switch to Mine/);
    const picks = await caller(angela).chat.threads({ organizationId: orgId, employeeId: theo.id });
    expect(picks.people.map((p) => p.name)).toEqual(["BJ"]);
    expect(picks.workspace).toBeNull();

    // Everyone's.
    await caller(owner).members.setChatAccess({ organizationId: orgId, userId: angela.id, mode: "all" });
    expect((await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id, thread: owner.id })).map((x) => x.content)).toContain("Owner's question");
    expect((await caller(angela).chat.threads({ organizationId: orgId, employeeId: theo.id })).workspace).not.toBeNull();

    // Only owners and admins set it, and never for an owner or admin.
    await expect(caller(angela).members.setChatAccess({ organizationId: orgId, userId: bj.id, mode: "all" })).rejects.toThrow(/cannot do that/);
    await expect(caller(owner).members.setChatAccess({ organizationId: orgId, userId: owner.id, mode: "own" })).rejects.toThrow(/always see every conversation/);
  });

  it("puts scheduled task reports in the Workspace conversation and unasked posts in the one that moved last", async () => {
    const { orgId, owner } = await makeWorkspace("threads-work");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const { sendChatMessage } = await import("./employees/chat");
    decision = { ...blank, reply: "Weekly numbers are in." };
    const r = await sendChatMessage({ organizationId: orgId, employeeId: theo.id, text: "Weekly report", authorName: "Scheduled task: Weekly report", userId: null, threadUserId: null });
    expect(r.user.threadUserId).toBeNull();
    expect(r.reply.threadUserId).toBeNull();
    expect((await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id, thread: "workspace" })).map((m) => m.content)).toEqual(["Weekly report", "Weekly numbers are in."]);
    expect(await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id })).toEqual([]);

    // An employee's own post with no one asking goes to the person who last talked with them (the owner before anyone has), never to Scheduled tasks.
    const first = await db.createChatMessage({ organizationId: orgId, employeeId: theo.id, role: "employee", authorName: theo.name, content: "Good morning." });
    expect(first.threadUserId).toBe(owner.id);
    const angela = await makeUser("angela@threads-work.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Start the article" });
    await sendChatMessage({ organizationId: orgId, employeeId: theo.id, text: "Evening report", authorName: "Scheduled task: Evening report", userId: null, threadUserId: null });
    const posted = await db.createChatMessage({ organizationId: orgId, employeeId: theo.id, role: "employee", authorName: theo.name, content: "The article is ready." });
    expect(posted.threadUserId).toBe(angela.id);
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Thanks" });
    expect((await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => m.content)).toContain("The article is ready.");
    expect((await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => m.content)).not.toContain("The article is ready.");

    // Read markers are per conversation.
    await caller(owner).chat.markRead({ organizationId: orgId, employeeId: theo.id, thread: "workspace" });
    const t = await caller(owner).chat.threads({ organizationId: orgId, employeeId: theo.id });
    expect(t.workspace?.unread).toBe(0);
  });

  it("applies the access rules", () => {
    const owner = { userId: 1, role: "owner" };
    const member = { userId: 2, role: "member" };
    const own = accessOf({ role: "member", chatAccess: "own", chatAccessList: null });
    const some = accessOf({ role: "member", chatAccess: "some", chatAccessList: JSON.stringify({ users: [3], workspace: true }) });
    const all = accessOf({ role: "member", chatAccess: "all", chatAccessList: null });
    expect(accessOf({ role: "admin", chatAccess: "own", chatAccessList: null }).mode).toBe("all");
    expect(accessOf({ role: "member", chatAccess: "some", chatAccessList: "{bad" })).toEqual({ mode: "some", users: [], workspace: false });
    expect(canSee(owner, own, 2)).toBe(true);
    expect(canSee(member, own, 2)).toBe(true);
    expect(canSee(member, own, 3)).toBe(false);
    expect(canSee(member, own, "workspace")).toBe(false);
    expect(canSee(member, some, 3)).toBe(true);
    expect(canSee(member, some, 4)).toBe(false);
    expect(canSee(member, some, "workspace")).toBe(true);
    expect(canSee(member, all, 4)).toBe(true);
    expect(canWrite(owner, 2)).toBe(true);
    expect(canWrite(member, 2)).toBe(true);
    expect(canWrite(member, 3)).toBe(false);
    expect(canWrite(member, "workspace")).toBe(false);
    expect(pickable(member, some, [1, 2, 3, 4])).toEqual({ users: [3], workspace: true });
    expect(pickable(owner, own, [1, 2, 3])).toEqual({ users: [2, 3], workspace: true });
    expect(accessLabel({ role: "member", chatAccess: "some", chatAccessList: JSON.stringify({ users: [], workspace: false }) })).toBe("Own only");
    expect(accessLabel({ role: "owner", chatAccess: "own", chatAccessList: null })).toBe("Everyone's");
  });
});
