import { beforeEach, describe, expect, it, vi } from "vitest";

let decision: any = null;
let systems: string[] = [];
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        systems.push(opts.system);
        return decision;
      }
      if (opts.schemaName === "action_items") return { items: [{ text: "Send the Tulsa draft for review", owner: "Morgan" }] };
      if (opts.schemaName === "one_on_one_summary") return { points: ["The Tulsa draft now has the traction number.", "Morgan sends it by Wednesday."] };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { spokenText } from "./employees/chat";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

describe("one-on-ones in the chat", () => {
  beforeEach(() => {
    decision = null;
    systems = [];
  });

  it("answers spoken lines briefly and out loud, keeps them as chat messages, and ends with notes in the chat and on Simone's Meetings tab", async () => {
    const { orgId, owner } = await makeWorkspace("one-on-one");
    const c = caller(owner);
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;

    // A line before the meeting is not part of it.
    decision = { ...blank, reply: "Morning!" };
    const before = await c.chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Morning" });
    expect(before.user.spoken).toBe(false);
    expect(systems[0]).not.toContain("live one-on-one");
    const startedAt = Date.now();

    decision = { ...blank, reply: "The draft is done except one number. How many practices use LeadDash now?" };
    const r = await c.chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Morgan where are we on Tulsa", spoken: true });
    expect(systems[1]).toContain("live one-on-one");
    expect(r.user.spoken).toBe(true);
    expect(r.reply.spoken).toBe(true);
    expect(r.audioUrl).toBeNull(); // no voice in tests; the words still show

    decision = { ...blank, reply: "Will do. You'll have it Wednesday afternoon." };
    await c.chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Great, send it to me to review by Thursday", spoken: true });

    const ended = await c.chat.endMeeting({ organizationId: orgId, employeeId: morgan.id, sinceId: r.user.id, startedAt });
    const m = (await db.getMeeting(ended.meetingId!, orgId))!;
    expect(m.title).toMatch(/^One-on-one with Morgan, /);
    expect(m.status).toBe("held");
    expect(m.notes).toContain("Morgan where are we on Tulsa");
    expect(m.notes).not.toContain("Morning");
    expect(JSON.parse(m.actionItems!)[0].text).toBe("Send the Tulsa draft for review");
    expect(ended.reply!.content).toMatch(/^Notes from our one-on-one · \d+ minutes?/);
    expect(ended.reply!.content).toContain("- Morgan sends it by Wednesday.");
    expect(ended.reply!.content).toContain("- Send the Tulsa draft for review (Morgan)");
    expect(ended.reply!.content).toContain("Simone's Meetings tab");
    const last = (await db.listChatMessages(orgId, morgan.id)).at(-1)!;
    expect(last.id).toBe(ended.reply!.id);

    // Ending with nothing said makes no meeting.
    const empty = await c.chat.endMeeting({ organizationId: orgId, employeeId: morgan.id, sinceId: last.id + 1, startedAt: Date.now() });
    expect(empty).toEqual({ meetingId: null, reply: null });
  });

  it("reads chat replies aloud without markdown, links or lists", () => {
    expect(spokenText("**Done.** Here's the page: https://example.com/p\n- First thing\n- Second thing\n\nWant changes?")).toBe("Done. Here's the page: First thing. Second thing. Want changes?");
    expect(spokenText("See [the draft](https://x.y/z) — it's ready")).toBe("See the draft, it's ready");
    const long = spokenText(Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" "));
    expect(long.length).toBeLessThan(760);
    expect(long.endsWith("The rest is in the chat.")).toBe(true);
  });
});
