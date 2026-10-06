import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { pingsFor } from "./notify";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const systems: string[] = [];

const prompts: string[] = [];

async function mockAi(reply: string) {
  const llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "chat_decision") {
      systems.push(opts.system);
      prompts.push(opts.prompt);
      return { ...blank, reply } as any;
    }
    return {} as any;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("@tags in an employee's chat", () => {
  it("passes the message to a tagged AI employee's own chat, notifies a tagged person, and tells the employee who else has it", async () => {
    const { orgId, owner } = await makeWorkspace("tags");
    const caroline = await makeUser("caroline@tags.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: orgId, userId: caroline.id, role: "member" });
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    await mockAi("Noted.");
    const before = pingsFor(caroline.id, 0).latest;
    await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "@Nora add the webinar follow-up to the launch. @Caroline can you review it Friday?" });
    await vi.waitFor(async () => expect((await db.listChatMessages(orgId, nora.id, 5)).length).toBe(2));
    const inNora = await db.listChatMessages(orgId, nora.id, 5);
    expect(inNora[0].role).toBe("user");
    expect(inNora[0].authorName).toBe(owner.name);
    expect(inNora[0].content).toBe(`@Nora add the webinar follow-up to the launch. @Caroline can you review it Friday?\n\n(${owner.name} tagged you in Simone's chat.)`);
    // Caroline gets a notice that opens Simone's chat.
    expect(pingsFor(caroline.id, before).pings.map((p) => [p.title, p.url])).toEqual([[`${owner.name} tagged you in Simone's chat`, "/chats/coo"]]);
    // Simone is told who else has the message, so she does only her part; Nora's forwarded copy does not pass tags on again.
    const simoneSystem = systems.find((t) => t.startsWith("You are Simone"))!;
    const noraSystem = systems.find((t) => t.startsWith("You are Nora"))!;
    expect(simoneSystem).toContain("Tagged in this message: Nora (AI employee; they have this message in their own chat and answer there, so leave their part to them); Caroline Jones (a person; they were sent a notice). Do your own part only.");
    expect(noraSystem).not.toContain("Tagged in this message");
    expect(await db.listChatMessages(orgId, simone.id, 5)).toHaveLength(2);
  });

  it("replies on one message: the quote is saved, the employee reads it as what the reply answers, and tagged people see it too", async () => {
    const { orgId, owner } = await makeWorkspace("reply-to");
    const caroline = await makeUser("caroline@reply-to.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: orgId, userId: caroline.id, role: "member" });
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    await mockAi("Two things are open on the launch: the webinar follow-up and the press list.");
    const first = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "What is still open on the launch?" });
    systems.length = 0;
    prompts.length = 0;

    const before = pingsFor(caroline.id, 0).latest;
    await mockAi("Noted.");
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "@Nora take the first one. @Caroline the second is yours.", replyToId: first.reply.id });
    expect(r.user.replyToId).toBe(first.reply.id);

    const quote = `Simone: Two things are open on the launch: the webinar follow-up and the press list.`;
    expect(prompts.find((p) => p.includes("(Replying to this message"))).toContain(`${owner.name}: (Replying to this message: "${quote}")\n@Nora take the first one.`);
    await vi.waitFor(async () => expect((await db.listChatMessages(orgId, nora.id, 5)).length).toBe(2));
    const inNora = await db.listChatMessages(orgId, nora.id, 5);
    expect(inNora[0].content).toBe(`@Nora take the first one. @Caroline the second is yours.\n\n(${owner.name} tagged you in Simone's chat, replying to this message there: "${quote}".)`);
    expect(pingsFor(caroline.id, before).pings.map((p) => p.body)).toEqual([`@Nora take the first one. @Caroline the second is yours. (about: ${quote})`]);

    // A reply on a message from some other chat is ignored rather than quoted.
    const r2 = await caller(owner).chat.send({ organizationId: orgId, employeeId: nora.id, text: "Thanks.", replyToId: first.reply.id });
    expect(r2.user.replyToId).toBeNull();
  });
});
