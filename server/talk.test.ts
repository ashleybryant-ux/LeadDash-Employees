import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as talk from "./employees/talk";
import { learnFact } from "./employees/learn";

afterEach(() => vi.restoreAllMocks());

describe("Taylor's talk scripts", () => {
  it("writes the whole talk timed to its real length and posts it in the chat as a Word file", async () => {
    const { orgId } = await makeWorkspace("talk-run");
    const llm = await import("./_core/llm");
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "talk_outline")
        return {
          title: "The Relational Skills HR Already Has",
          event: "HR2026 Arkansas SHRM, Thu, Oct 15, 2026, Room 203-204",
          // Adds up to 55: the script still comes out at exactly 60.
          sections: [
            { title: "Opening", minutes: 5, slide: "Title", covers: "Who I am" },
            { title: "Praise", minutes: 20, slide: "Praise", covers: "Praise yourself" },
            { title: "Plan", minutes: 30, slide: "Your next 30 days", covers: "Two actions" },
          ],
        } as any;
      return {} as any;
    });
    const text = vi.spyOn(llm, "generateText").mockResolvedValue("Good afternoon, everyone.\n\n[Pause. Let the room settle.]\n\nLet's start with a question.");
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    const r = await talk.writeTalkScript(taylor, { title: "SHRM Arkansas session", minutes: 60, notes: "", said: "write my SHRM talk" });
    expect(r.sections.reduce((a, s) => a + s.minutes, 0)).toBe(60);
    expect(text).toHaveBeenCalledTimes(3);
    const msgs = await db.listChatMessages(orgId, taylor.id, 5);
    const done = msgs.find((m) => /is ready: 60 minutes in 3 parts/.test(m.content))!;
    expect(JSON.parse(done.cards!)).toEqual([{ type: "doc", id: r.file.id, title: "The Relational Skills HR Already Has", subtitle: "Word document · 60 minutes · 3 parts" }]);
    expect(r.file.name).toMatch(/ - script\.docx$/);
    expect(r.file.size).toBeGreaterThan(1000);
    expect(db.getChatFiles(orgId, [r.file.id])[0].messageId).toBe(done.id);
    // What the chat shows when it's opened.
    expect(r.file.text).toMatch(/^# The Relational Skills HR Already Has/);
    expect(r.file.text).toMatch(/## 3\. Plan\n\*\*27:00 to 60:00 · Slide: Your next 30 days\*\*/);

    // The slides come from that script, with the speaker notes, and open in the chat too.
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      expect(opts.prompt).toMatch(/The script:\n# The Relational Skills/);
      return { title: "The Relational Skills HR Already Has", event: "HR2026", slides: [{ kind: "title", title: "The Relational Skills HR Already Has", points: [], notes: "0:00 Welcome" }, { kind: "points", title: "Praise", points: ["Name one win a day"], notes: "5:00 Talk about praise" }] } as any;
    });
    const d = await talk.buildSlides(taylor, { title: "", notes: "", said: "build the slides" });
    expect(d.file.name).toMatch(/ - slides\.pptx$/);
    expect(JSON.parse(d.file.text).slides[1]).toMatchObject({ title: "Praise", notes: "5:00 Talk about praise" });
    const deckMsg = (await db.listChatMessages(orgId, taylor.id, 5)).find((m) => /slides for .* are ready: 2 slides, with what you say on each one/.test(m.content))!;
    expect(JSON.parse(deckMsg.cards!)[0]).toMatchObject({ type: "deck", id: d.file.id });
  });

  it("times the talk from what she said, else from the Brain, never a guess", async () => {
    const { orgId } = await makeWorkspace("talk-len");
    await db.createKnowledgeItem({ organizationId: orgId, title: "Company training: SHRM Arkansas (HR2026) proposal", category: "speaking", kind: "fact", content: "The Relational Skills HR Already Has, and Almost Never Uses on Themselves. Length: 60 minutes each, the same session both times." });
    const title = "The Relational Skills HR Already Has, and Almost Never Uses on Themselves";
    expect(await talk.talkMinutes(orgId, title, ["can you write it now?"], 90)).toBe(60);
    expect(await talk.talkMinutes(orgId, title, ["make it a 45 minute version"], 90)).toBe(45);
    expect(await talk.talkMinutes(orgId, "A brand new keynote", ["write it"], 0)).toBe(0);
  });

  it("splits minutes so the parts add up to the talk", () => {
    const parts = talk.fitMinutes(
      [
        { title: "A", minutes: 10, slide: "", covers: "" },
        { title: "B", minutes: 10, slide: "", covers: "" },
        { title: "C", minutes: 10, slide: "", covers: "" },
      ],
      90
    );
    expect(parts.map((p) => p.minutes)).toEqual([30, 30, 30]);
  });

  it("doesn't save or announce the same Brain fact twice", async () => {
    const { orgId } = await makeWorkspace("talk-learn");
    const fact = { topic: "SHRM Arkansas session", fact: "The SHRM Arkansas HR2026 session was accepted.", who: "Ashley", via: "Taylor" };
    expect(await learnFact(orgId, fact)).not.toBeNull();
    expect(await learnFact(orgId, fact)).toBeNull();
    expect((await learnFact(orgId, { ...fact, fact: "The SHRM Arkansas HR2026 session was accepted, and it runs twice." }))?.replaced).toBe(true);
  });
});
