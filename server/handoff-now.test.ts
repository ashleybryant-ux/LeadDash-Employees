import { describe, expect, it, vi } from "vitest";

const seen: { who: string; prompt: string; actions: string[] }[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName !== "chat_decision") return {};
      const who = /You are (\w+)/.exec(opts.system)?.[1] ?? "";
      seen.push({ who, prompt: opts.prompt, actions: opts.schema.properties.action.enum });
      const blank = { thinking: "", reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
      if (who === "Quinn") return { ...blank, action: "hand_off", teammate: "Simone", message: "Set up the weekly Grants meeting on Zoom, Mondays 10:00 AM, with Caroline, and put the agenda on it.", reply: "Handing it to Simone." };
      return { ...blank, reply: "Done: the Grants meeting is on Zoom for Mondays at 10:00 AM with Caroline, and the agenda is on the invite." };
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";

describe("handing work to a teammate", () => {
  it("the teammate does it right away with the documents, and the reply says what they did, not just that a task was added", async () => {
    const { orgId, owner } = await makeWorkspace("handoff-now");
    const quinn = (await db.getEmployeeByKind(orgId, "hiring"))!;
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const file = db.createChatFile({ organizationId: orgId, employeeId: quinn.id, name: "Grants Standing Meeting Agenda.docx", mime: "application/msword", size: 10, kind: "document", fileUrl: "/files/x.docx", text: "# Grants Standing Meeting Agenda\n\n- Open opportunities\n- Deadlines this week", pages: null });
    await db.createChatMessage({ organizationId: orgId, employeeId: quinn.id, role: "employee", authorName: "Quinn", content: "Here's the agenda.", cards: JSON.stringify([{ type: "doc", id: file.id, title: "Grants Standing Meeting Agenda" }]) });

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: quinn.id, text: "Add these to zoom and invite the right people and attach the agenda to the meeting" });
    expect(r.reply.content).toBe("I handed it to Simone, who did it right away. Simone: Done: the Grants meeting is on Zoom for Mondays at 10:00 AM with Caroline, and the agenda is on the invite.");

    const toSimone = seen.find((x) => x.who === "Simone")!;
    expect(toSimone.prompt).toContain("Set up the weekly Grants meeting on Zoom");
    expect(toSimone.prompt).toContain("Deadlines this week");
    // Simone can't hand it on again.
    expect(toSimone.actions).not.toContain("hand_off");
    expect((await db.listChatMessages(orgId, simone.id, 5)).some((m) => m.authorName.startsWith("Quinn, for"))).toBe(true);
  });
});
