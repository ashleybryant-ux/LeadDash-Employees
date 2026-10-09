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
import { accessOf, accessLabel, canSee, fileUnder, visibleFor } from "./threads";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

describe("one chat per employee, and each person sees what they may", () => {
  beforeEach(() => {
    decision = { ...blank, reply: "Sure." };
    systems = [];
    prompts = [];
  });

  it("shows the owner everything in one chat, and a member only their own messages and the answers to them", async () => {
    const { orgId, owner } = await makeWorkspace("chat-see-own");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const angela = await makeUser("angela@chat-see-own.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });

    decision = { ...blank, reply: "Two clients owe a balance." };
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Who owes a balance?" });
    decision = { ...blank, reply: "Here is the post." };
    await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Write a post" });

    // The owner sees both exchanges in the one chat, in order, each saying who said it.
    const ownerList = await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id });
    expect(ownerList.map((m) => `${m.authorName}: ${m.content}`)).toEqual([
      `Owner chat-see-own: Who owes a balance?`,
      "Theo: Two clients owe a balance.",
      "Angela St. Ville: Write a post",
      "Theo: Here is the post.",
    ]);
    // Angela sees only her own exchange.
    const angelaList = await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id });
    expect(angelaList.map((m) => m.content)).toEqual(["Write a post", "Here is the post."]);
    expect(angelaList.every((m) => m.threadUserId === angela.id)).toBe(true);

    // The employee answered Angela from what she can see, not from the owner's exchange.
    expect(prompts[1]).toContain("Write a post");
    expect(prompts[1]).not.toContain("Who owes a balance?");

    // The chat list preview follows the same rule.
    expect((await caller(angela).chat.summaries({ organizationId: orgId })).find((s) => s.employeeId === theo.id)?.content).toBe("Here is the post.");
    expect((await caller(owner).chat.summaries({ organizationId: orgId })).find((s) => s.employeeId === theo.id)?.content).toBe("Here is the post.");
  });

  it("files an owner's Reply to a member's message under that member, so the member sees the answer", async () => {
    const { orgId, owner } = await makeWorkspace("chat-reply");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const angela = await makeUser("angela@chat-reply.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const asked = await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Draft the newsletter" });

    decision = { ...blank, reply: "Shorter it is." };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Make it shorter", replyToId: asked.user.id });
    expect(r.user.threadUserId).toBe(angela.id);
    expect(r.user.userId).toBe(owner.id);
    expect(r.reply.threadUserId).toBe(angela.id);
    expect(systems[1]).toContain("They are answering Angela St. Ville");
    expect((await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => `${m.authorName}: ${m.content}`)).toContain(`Owner chat-reply: Make it shorter`);

    // Without Reply, the owner's message is their own: Angela does not see it.
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "A note to self" });
    expect((await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => m.content)).not.toContain("A note to self");
    // The owner still sees the whole chat.
    expect((await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => m.content)).toEqual(["Draft the newsletter", "Sure.", "Make it shorter", "Shorter it is.", "A note to self", "Shorter it is."]);
  });

  it("opens more for a member from the Team page", async () => {
    const { orgId, owner } = await makeWorkspace("chat-team");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const angela = await makeUser("angela@chat-team.test", "user", "Angela St. Ville");
    const bj = await makeUser("bj@chat-team.test", "user", "BJ");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    await db.addOrganizationMember({ organizationId: orgId, userId: bj.id, role: "member" });
    await caller(bj).chat.send({ organizationId: orgId, employeeId: theo.id, text: "BJ's question" });
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Owner's question" });
    const { sendChatMessage } = await import("./employees/chat");
    await sendChatMessage({ organizationId: orgId, employeeId: theo.id, text: "Weekly report", authorName: "Scheduled task: Weekly report", userId: null, threadUserId: null });
    const seen = async (who: any) => (await caller(who).chat.list({ organizationId: orgId, employeeId: theo.id })).filter((m) => m.role === "user").map((m) => m.content);

    // Angela: her own only (nothing yet).
    expect(await seen(angela)).toEqual([]);

    // Her own plus BJ's.
    await caller(owner).members.setChatAccess({ organizationId: orgId, userId: angela.id, mode: "some", users: [bj.id], workspace: false });
    const m = (await caller(owner).members.list({ organizationId: orgId })).find((x) => x.userId === angela.id)!;
    expect(accessLabel(m)).toBe("Own + 1");
    expect(await seen(angela)).toEqual(["BJ's question"]);

    // Plus the scheduled task reports.
    await caller(owner).members.setChatAccess({ organizationId: orgId, userId: angela.id, mode: "some", users: [bj.id], workspace: true });
    expect(await seen(angela)).toEqual(["BJ's question", "Weekly report"]);

    // Everything.
    await caller(owner).members.setChatAccess({ organizationId: orgId, userId: angela.id, mode: "all" });
    expect(await seen(angela)).toEqual(["BJ's question", "Owner's question", "Weekly report"]);
    // A member replying to someone else's message keeps the reply under their own name; only owners and admins file it under the other person.
    const bjMsg = (await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id })).find((x) => x.content === "BJ's question")!;
    const r = await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Following up", replyToId: bjMsg.id });
    expect(r.user.threadUserId).toBe(angela.id);

    // Only owners and admins set it, and never for an owner or admin.
    await expect(caller(angela).members.setChatAccess({ organizationId: orgId, userId: bj.id, mode: "all" })).rejects.toThrow(/cannot do that/);
    await expect(caller(owner).members.setChatAccess({ organizationId: orgId, userId: owner.id, mode: "own" })).rejects.toThrow(/always see everything/);
  });

  it("files scheduled task reports under nobody and an employee's own posts under the person who last talked with it", async () => {
    const { orgId, owner } = await makeWorkspace("chat-work");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const { sendChatMessage } = await import("./employees/chat");
    const r = await sendChatMessage({ organizationId: orgId, employeeId: theo.id, text: "Weekly report", authorName: "Scheduled task: Weekly report", userId: null, threadUserId: null });
    expect(r.user.threadUserId).toBeNull();
    expect(r.reply.threadUserId).toBeNull();
    // The owner sees it in the chat; a member does not unless opened for them.
    expect((await caller(owner).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => m.content)).toEqual(["Weekly report", "Sure."]);
    const angela = await makeUser("angela@chat-work.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    expect(await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id })).toEqual([]);

    // An employee's own post with nobody asking goes to the person who last talked with it (the owner before anyone has), never under nobody.
    const first = await db.createChatMessage({ organizationId: orgId, employeeId: theo.id, role: "employee", authorName: theo.name, content: "Good morning." });
    expect(first.threadUserId).toBe(owner.id);
    await caller(angela).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Start the article" });
    await sendChatMessage({ organizationId: orgId, employeeId: theo.id, text: "Evening report", authorName: "Scheduled task: Evening report", userId: null, threadUserId: null });
    const posted = await db.createChatMessage({ organizationId: orgId, employeeId: theo.id, role: "employee", authorName: theo.name, content: "The article is ready." });
    expect(posted.threadUserId).toBe(angela.id);
    expect((await caller(angela).chat.list({ organizationId: orgId, employeeId: theo.id })).map((m) => m.content)).toContain("The article is ready.");
  });

  it("applies the access rules", () => {
    const owner = { userId: 1, role: "owner" };
    const member = { userId: 2, role: "member" };
    const own = accessOf({ role: "member", chatAccess: "own", chatAccessList: null });
    const some = accessOf({ role: "member", chatAccess: "some", chatAccessList: JSON.stringify({ users: [3], workspace: true }) });
    const all = accessOf({ role: "member", chatAccess: "all", chatAccessList: null });
    expect(accessOf({ role: "admin", chatAccess: "own", chatAccessList: null }).mode).toBe("all");
    expect(accessOf({ role: "member", chatAccess: "some", chatAccessList: "{bad" })).toEqual({ mode: "some", users: [], workspace: false });
    expect(visibleFor(owner, own)).toBe("all");
    expect(visibleFor(member, own)).toEqual([2]);
    expect(visibleFor(member, some)).toEqual([2, 3, null]);
    expect(visibleFor(member, all)).toBe("all");
    expect(canSee([2, 3, null], 3)).toBe(true);
    expect(canSee([2, 3, null], null)).toBe(true);
    expect(canSee([2], 3)).toBe(false);
    expect(canSee("all", 9)).toBe(true);
    expect(fileUnder(owner, { threadUserId: 2 })).toBe(2);
    expect(fileUnder(owner, { threadUserId: null })).toBeNull();
    expect(fileUnder(owner, null)).toBe(1);
    expect(fileUnder(member, { threadUserId: 3 })).toBe(2);
    expect(accessLabel({ role: "member", chatAccess: "some", chatAccessList: JSON.stringify({ users: [], workspace: false }) })).toBe("Own only");
    expect(accessLabel({ role: "owner", chatAccess: "own", chatAccessList: null })).toBe("Everything");
  });
});
