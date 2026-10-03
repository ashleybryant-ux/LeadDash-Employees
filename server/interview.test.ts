import { describe, expect, it, vi } from "vitest";

const calls: { schema: string; system: string; prompt: string }[] = [];
let conflictsReply: any = { conflicts: [] };

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      calls.push({ schema: opts.schemaName, system: opts.system, prompt: opts.prompt });
      if (opts.schemaName === "voice_samples") return { samples: [{ label: "Warm and personal", text: "Most couples who call us are tired, not broken." }, { label: "Expert and direct", text: "Starting earlier works." }, { label: "Playful", text: "Come as you are." }] };
      if (opts.schemaName === "followups") return { questions: [{ q: "You picked Warm, but LinkedIn is for clinicians. Should LinkedIn sound more expert?", options: ["Same voice everywhere", "More expert on LinkedIn"], section: "writing" }] };
      if (opts.schemaName === "day_to_day") return { items: [{ when: "Weekdays", what: "Writes a post." }] };
      if (opts.schemaName === "conflicts") return conflictsReply;
      if (opts.schemaName === "style_lines") return { lines: ["Short sentences; opens with a plain observation.", "Avoid clickbait lists."] };
      if (opts.schemaName === "chat_decision") return { reply: "", action: "add_guideline", focus: "", topic: "", platforms: [], title: "", notes: "Never use exclamation points.", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "Writing style", to: "", date: "", time: "", attendees: "", teammate: "" };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { INTERVIEWS, allQuestions } from "./employees/interview-defs";
import * as interview from "./employees/interview";
import { systemPromptFor } from "./employees/tasks";
import type { EmployeeKind } from "../drizzle/schema";

describe("onboarding interview definitions", () => {
  it("every job starts with the Brain, ends with Working together, and feeds real Guidelines headings", () => {
    for (const kind of Object.keys(INTERVIEWS) as EmployeeKind[]) {
      const def = INTERVIEWS[kind];
      expect(def.sections[0].key).toBe("brain");
      expect(def.sections[def.sections.length - 1].key).toBe("working");
      const guides = new Set(def.guides.map((g) => g.key));
      const keys = allQuestions(kind).map((q) => q.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const q of allQuestions(kind)) expect(guides.has(q.guide), `${kind}.${q.key} -> ${q.guide}`).toBe(true);
    }
    // Answers other code reads keep their keys.
    const has = (k: EmployeeKind, key: string) => allQuestions(k).some((q) => q.key === key);
    expect(has("coo", "style") && has("coo", "always") && has("projects", "buffer") && has("projects", "how") && has("social", "platforms")).toBe(true);
    expect(["greatFit", "interviewHours", "interviewFormat", "panel"].every((k) => has("hiring", k))).toBe(true);
  });
});

describe("employees reach out first and onboard in chat", () => {
  it("posts one welcome per employee, runs the interview in chat, and writes Guidelines lines", async () => {
    const { orgId, owner } = await makeWorkspace("interview-chat");
    const c = caller(owner);
    await interview.interviewTick(orgId);
    await interview.interviewTick(orgId);
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    let msgs = await db.listChatMessages(orgId, sienna.id, 50);
    expect(msgs.filter((m) => (m.cards ?? "").includes('"onboarding"'))).toHaveLength(1);
    expect(msgs[0].content).toMatch(/I'm Sienna, your social media manager/);
    expect((await db.listEmployeesByOrg(orgId)).every((e) => !!interview.readState(e).welcomedAt)).toBe(true);

    await c.onboarding.startChat({ organizationId: orgId, employeeId: sienna.id });
    msgs = await db.listChatMessages(orgId, sienna.id, 50);
    expect(msgs.some((m) => m.role === "user" && m.content === "Start my onboarding")).toBe(true);
    expect(msgs[msgs.length - 1].cards).toContain('"title":"brain"');

    await c.onboarding.chatAnswer({ organizationId: orgId, employeeId: sienna.id, key: "brain", value: { booking: "https://book.example.com" } });
    const brain = await db.listKnowledgeByOrg(orgId);
    expect(brain.find((k) => k.title === "Booking link")?.content).toBe("https://book.example.com");
    msgs = await db.listChatMessages(orgId, sienna.id, 50);
    expect(msgs[msgs.length - 1].content).toMatch(/Part 2 of 7: The job/);
    expect(msgs[msgs.length - 1].cards).toContain('"title":"goal"');

    await c.onboarding.chatAnswer({ organizationId: orgId, employeeId: sienna.id, key: "goal", value: ["Bring in clients"] });
    await c.onboarding.chatAnswer({ organizationId: orgId, employeeId: sienna.id, key: "success90", value: "__skip" });
    msgs = await db.listChatMessages(orgId, sienna.id, 50);
    expect(msgs[msgs.length - 1].cards).toContain('"title":"first"');

    const g = await c.guidelines.get({ organizationId: orgId, employeeId: sienna.id });
    const themes = g.sections.find((s) => s.key === "themes")!;
    expect(themes.items[0]).toMatchObject({ text: "Main goal: Bring in clients", source: "interview" });

    // Later: a reminder the next morning.
    await c.onboarding.later({ organizationId: orgId, employeeId: sienna.id });
    const st = interview.readState((await db.getEmployeeForOrg(sienna.id, orgId))!);
    expect(st.remindAt).toBeTruthy();
    await interview.interviewTick(orgId, new Date(new Date(st.remindAt!).getTime() + 60_000));
    msgs = await db.listChatMessages(orgId, sienna.id, 50);
    expect(msgs[msgs.length - 1].content).toMatch(/Ready to pick up my onboarding\? We're at part 2 of 7/);
  });
});

describe("the interview on the Onboarding tab", () => {
  it("goes part by part with voice samples, examples and follow-ups, then finishes into Guidelines the prompt uses", async () => {
    const { orgId, owner } = await makeWorkspace("interview-tab");
    const c = caller(owner);
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const id = { organizationId: orgId, employeeId: sienna.id };
    await c.onboarding.saveBrain({ ...id, facts: { brandColors: "Green #1b6b4a" }, advance: true });
    expect((await db.getOrganizationById(orgId))?.brandColors).toBe("Green #1b6b4a");
    await c.onboarding.savePart({ ...id, section: "job", answers: { goal: ["Bring in clients"], success90: "3 posts a week", first: "Instagram" }, advance: true });
    const samples = await c.onboarding.samples(id);
    expect(samples).toHaveLength(3);
    await c.onboarding.savePart({ ...id, section: "voice", answers: { samples: "Warm and personal", formality: "Conversational", wordsAvoid: "crazy, broken", emoji: "None" }, advance: true });
    await c.onboarding.savePart({ ...id, section: "audience", answers: { platforms: ["Instagram", "LinkedIn"] }, advance: true });
    await c.onboarding.savePart({ ...id, section: "content", answers: { imageStyle: "Photos", avoid: "Client stories" }, advance: true });
    await c.onboarding.examples({ ...id, examples: [{ liked: true, text: "Most couples who call us aren't in crisis." }, { liked: false, text: "5 signs your marriage is doomed" }] });
    let v = await c.onboarding.savePart({ ...id, section: "examples", answers: { dislikeWhy: ["Clickbait"] }, advance: true });
    expect(v.state.followups).toHaveLength(1);
    await c.onboarding.followup({ ...id, index: 0, answer: "More expert on LinkedIn" });
    v = await c.onboarding.savePart({ ...id, section: "working", answers: { report: "A weekly summary" }, advance: true });
    expect(v.state.done).toBe(true);
    const emp = (await db.getEmployeeForOrg(sienna.id, orgId))!;
    expect(emp.onboardedAt).toBeTruthy();

    const g = await c.guidelines.get(id);
    const writing = g.sections.find((s) => s.key === "writing")!;
    expect(writing.items.map((i) => i.text)).toEqual(expect.arrayContaining(['Sounds like this (Warm and personal): "Most couples who call us are tired, not broken."', "Formality: Conversational", "Never say: crazy, broken", "You picked Warm, but LinkedIn is for clinicians. Should LinkedIn sound more expert: More expert on LinkedIn"]));
    const { system } = await systemPromptFor(emp, "Write a post.");
    expect(system).toContain("### Writing style");
    expect(system).toContain("Never post: Client stories");
    expect(system).toContain("Examples the owner liked");
    // Sienna still reads her platforms from the answer key other code uses.
    expect(JSON.parse(emp.onboarding!).platforms).toEqual(["Instagram", "LinkedIn"]);
  });
});

describe("Guidelines", () => {
  it("edits a section, adds a rule from chat, learns from examples, and settles a conflict", async () => {
    const { orgId, owner } = await makeWorkspace("guidelines");
    const c = caller(owner);
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const id = { organizationId: orgId, employeeId: avery.id };
    await c.onboarding.savePart({ ...id, section: "calendar", answers: { slots: "30 minutes", hours: "No meetings before 9:30 AM" }, advance: false });
    let g = await c.guidelines.get(id);
    const cal = g.sections.find((s) => s.key === "calendar")!;
    expect(cal.items.map((i) => i.text)).toEqual(["Meeting length: 30 minutes", "Meeting hours: No meetings before 9:30 AM"]);

    // Rewriting an interview line makes it yours and clears that answer.
    g = await c.guidelines.saveSection({ ...id, section: "calendar", lines: [{ id: cal.items[0].id, text: cal.items[0].text }, { id: cal.items[1].id, text: "No meetings before 10:00 AM or on Wednesdays" }, { text: "Volunteer work only Sunday afternoons" }] });
    const after = g.sections.find((s) => s.key === "calendar")!.items;
    expect(after.map((i) => i.source)).toEqual(["interview", "you", "you"]);
    expect(JSON.parse((await db.getEmployeeForOrg(avery.id, orgId))!.onboarding!).hours).toBe("");

    // "From now on..." in chat.
    const { sendChatMessage } = await import("./employees/chat");
    const r = await sendChatMessage({ organizationId: orgId, employeeId: avery.id, text: "From now on, never use exclamation points.", authorName: "Ashley Bryant", userId: owner.id });
    expect(r.reply.content).toMatch(/added that to my Guidelines under "How should I write emails\?"/);
    g = await c.guidelines.get(id);
    expect(g.sections.find((s) => s.key === "writing")!.items.at(-1)).toMatchObject({ text: "Never use exclamation points.", source: "chat" });

    // Learn from examples.
    await expect(c.guidelines.learn(id)).rejects.toThrow(/Add examples/);
    await interview.setExamples((await db.getEmployeeForOrg(avery.id, orgId))!, [{ liked: true, text: "Hi Soror Jones, here is what I found so far." }]);
    g = await c.guidelines.learn(id);
    expect(g.sections.find((s) => s.key === "writing")!.items.filter((i) => i.source === "learned")).toHaveLength(2);

    // A conflict, settled with a fixed choice.
    const items = g.sections.find((s) => s.key === "calendar")!.items;
    conflictsReply = { conflicts: [{ text: "Line 2 says 10:00 AM; line 3 allows Sundays only.", itemIds: [items[1].id, items[2].id], options: [{ label: "Keep 10:00 AM", keep: "No meetings before 10:00 AM" }, { label: "Keep Sundays", keep: "Sundays only" }] }] };
    g = await c.guidelines.check(id);
    expect(g.conflicts).toHaveLength(1);
    g = await c.guidelines.resolve({ ...id, conflictId: g.conflicts[0].id, option: 0 });
    expect(g.conflicts).toHaveLength(0);
    expect(g.sections.find((s) => s.key === "calendar")!.items.map((i) => [i.text, i.source])).toEqual([["Meeting length: 30 minutes", "interview"], ["No meetings before 10:00 AM", "settled"]]);
    conflictsReply = { conflicts: [] };
  });

  it("keeps the old three Guidelines fields as lines", async () => {
    const { orgId } = await makeWorkspace("guidelines-legacy");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const updated = (await db.updateEmployee(theo.id, orgId, { guidelines: JSON.stringify({ focus: "Couples counseling", avoid: "Politics", signAs: "Dr. Ashley" }) }))!;
    const view = interview.guidelinesView(updated);
    expect(view.sections[0].items.map((i) => i.text)).toEqual(["Couples counseling", "Avoid: Politics", "Sign as: Dr. Ashley"]); // Theo has no rules section, so Avoid joins the first one
    const { system } = await systemPromptFor(updated, "Write.");
    expect(system).toContain("Politics");
  });
});
