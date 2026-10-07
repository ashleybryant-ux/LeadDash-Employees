import { beforeEach, describe, expect, it, vi } from "vitest";

// Every model call is recorded: chat decisions return the scripted decision, the agenda writer returns two items.
let decision: any = null;
const calls: any[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      calls.push(opts);
      if (opts.schemaName === "chat_decision") return decision;
      if (opts.schemaName === "meeting_agenda") {
        return { items: [{ item: "Webinar: registration page and CTA link", who: "Nora", minutes: 20 }, { item: "Black Friday founding offer page", who: "Caroline", minutes: 20 }] };
      }
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as coo from "./employees/coo";
import { saveOps } from "./employees/ops";
import { reasoningReady } from "./_core/llm";

const blank = { thinking: "", reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

describe("employees reason before they act", () => {
  beforeEach(() => {
    decision = null;
    calls.length = 0;
  });

  it("each chat decision asks the model to think first and answer last, and a healthcare workspace stays on the BAA route", async () => {
    const { orgId, owner } = await makeWorkspace("reason-chat");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    decision = { ...blank, thinking: "She only wants to know when the next article is due.", reply: "Thursday." };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "when is the next article due?" });
    expect(r.reply.content).toBe("Thursday.");

    const ask = calls.find((c) => c.schemaName === "chat_decision");
    expect(ask.reason).toBe(true);
    expect(ask.clientInfo).toBe(false);
    const order = ask.schema.required as string[];
    expect(order[0]).toBe("thinking");
    expect(order[order.length - 1]).toBe("reply");
    expect(Object.keys(ask.schema.properties)[0]).toBe("thinking");
    expect(ask.system).toMatch(/What the person told you earlier in this chat still holds/);
    // The thinking is never shown to the person.
    expect(r.reply.content).not.toContain("She only wants");

    calls.length = 0;
    await caller(owner).organizations.update({ id: orgId, orgType: "healthcare" });
    await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "when is the next article due?" });
    expect(calls.find((c) => c.schemaName === "chat_decision").clientInfo).toBe(true);
  });

  it("the reasoning route is off in tests and needs the Anthropic key", () => {
    expect(reasoningReady(false)).toBe(false);
  });

  it("Simone writes the agenda around what the owner said instead of adding it as a line", async () => {
    const { orgId, owner } = await makeWorkspace("reason-agenda");
    const email = (await db.listMembers(orgId))[0].email;
    await saveOps(orgId, { recurring: [{ id: "s1", name: "Nov Launch Team Huddle", day: new Date(Date.now() + 86_400_000).getDay(), time: "10:00", minutes: 60, attendees: [email], updatesFrom: ["projects"] }] });
    await coo.ensureMeetings(orgId);
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const said = "Write the agenda now. I'll send the link later. Also, tomorrow is only about the webinar launch and Black Friday offer. All other things can wait till next meeting";
    decision = { ...blank, action: "write_agenda", target: "Nov Launch Team Huddle", notes: "Only the webinar launch and the Black Friday offer; everything else waits.", reply: "Writing it now." };

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: said });
    const writer = calls.find((c) => c.schemaName === "meeting_agenda");
    expect(writer.system).toMatch(/overrides every other rule here/);
    expect(writer.system).toContain("only about the webinar launch and Black Friday offer");
    expect(writer.reason).toBe(true);

    const m = (await coo.nextMeetingFor(orgId, "Nov Launch"))!;
    const items = (typeof m.agenda === "string" ? JSON.parse(m.agenda) : m.agenda).map((a: any) => a.item);
    expect(items).toEqual(["Webinar: registration page and CTA link", "Black Friday founding offer page"]);
    expect(items.join(" ")).not.toMatch(/Only the webinar launch/);
    expect(r.reply.content).toMatch(/agenda/);
  });
});
