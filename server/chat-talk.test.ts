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
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as pages from "./employees/pages";
import * as apply from "./employees/apply";
import { storagePut } from "./storage";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

async function attach(orgId: number, employeeId: number, name: string, kind: "image" | "document", text: string) {
  const saved = await storagePut(`org-${orgId}/chat/${name}`, Buffer.from(kind === "document" ? text : "img"), kind === "image" ? "image/jpeg" : "application/pdf");
  return db.createChatFile({ organizationId: orgId, employeeId, userId: null, name, mime: kind === "image" ? "image/jpeg" : "application/pdf", size: 1200, kind, fileUrl: saved.url, text, pages: kind === "document" ? 3 : null });
}

describe("every chat takes attachments and talks back", () => {
  beforeEach(() => {
    decision = null;
    systems = [];
  });

  it("sends files with a message, the employee reads them, and quick replies come back", async () => {
    const { orgId, owner } = await makeWorkspace("talk-files");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const f = await attach(orgId, theo.id, "Notes.pdf", "document", "Practices lose hours to double entry.");
    const other = await attach(orgId, sienna.id, "Other.pdf", "document", "Not for Theo.");

    decision = { ...blank, reply: "Your notes say practices lose hours to double entry. Want an article on it?", choices: ["Write the article", "Make it a post"] };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "", attachmentIds: [f.id, other.id] });
    // Only Theo's own file went with the message.
    expect(JSON.parse(r.user.attachments!).map((a: any) => a.name)).toEqual(["Notes.pdf"]);
    expect(db.getChatFiles(orgId, [f.id])[0].messageId).toBe(r.user.id);
    expect(db.getChatFiles(orgId, [other.id])[0].messageId).toBeNull();
    expect(systems[0]).toContain("--- Notes.pdf ---");
    expect(systems[0]).toContain("Practices lose hours to double entry.");
    expect(systems[0]).toContain("back and forth");
    expect(JSON.parse(r.reply.cards!)).toEqual([expect.objectContaining({ type: "choices", options: ["Write the article", "Make it a post"] })]);

    // The next message still sees the file it came with.
    decision = { ...blank, reply: "Saving them.", action: "save_files" };
    const saved = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Save that to the Brain" });
    expect(saved.reply.content).toMatch(/Saved Notes.pdf to the Brain/);
    expect((await db.listKnowledgeByOrg(orgId)).some((k) => k.title === "Notes.pdf" && k.content.includes("double entry"))).toBe(true);
  });

  it("needs a message or a file, and scheduled tasks never get quick replies", async () => {
    const { orgId, owner } = await makeWorkspace("talk-empty");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    await expect(caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "" })).rejects.toThrow(/Type a message or attach a file/);
    const { sendChatMessage } = await import("./employees/chat");
    decision = { ...blank, reply: "Done.", choices: ["More"] };
    const r = await sendChatMessage({ organizationId: orgId, employeeId: theo.id, text: "Weekly report", authorName: "Scheduled task: Weekly report", userId: null });
    expect(r.reply.cards).toBeNull();
    expect(systems[0]).toContain("never ask a question");
  });
});

describe("Jordan designs with you in chat", () => {
  beforeEach(() => {
    decision = null;
    systems = [];
  });

  it("asks for a layout first, then builds with the layout, the button and the attached photo", async () => {
    const { orgId, owner } = await makeWorkspace("talk-jordan");
    const jordan = (await db.getEmployeeByKind(orgId, "website"))!;
    const photo = await attach(orgId, jordan.id, "Lobby.jpg", "image", "The person in a white dress in a lobby.");
    const sheet = await attach(orgId, jordan.id, "One-sheet.pdf", "document", "Three takeaways. 45 or 60 minutes.");

    decision = { ...blank, action: "ask_layout", reply: "I read your one-sheet: three takeaways and a 45 or 60 minute talk. Pick the layout you want." };
    const ask = await caller(owner).chat.send({ organizationId: orgId, employeeId: jordan.id, text: "Build a landing page for my keynote", attachmentIds: [photo.id, sheet.id] });
    expect(systems[0]).toContain("choose ask_layout");
    const cards = JSON.parse(ask.reply.cards!);
    expect(cards[0]).toMatchObject({ type: "layout_choice", options: ["Photo beside headline", "Big headline first", "Story first"] });
    expect(cards[1]).toMatchObject({ type: "choices", options: ["Your booking form", "An email to you", "A form on the page"] });

    const start = vi.spyOn(pages, "startPage").mockImplementation(async (o: number, input: any) => ({ id: 77, title: input.title }) as any);
    decision = { ...blank, action: "build_page", page: "Keynote", goal: "Request dates", target: "landing", focus: "Photo beside headline", to: "Your booking form", reply: "Building it now." };
    const built = await caller(owner).chat.send({ organizationId: orgId, employeeId: jordan.id, text: "Photo beside headline. Booking form." });
    expect(built.reply.content).toBe("Building it now.");
    const extra = start.mock.calls[0][2]!;
    expect(extra.layout).toBe("Photo beside headline");
    expect(extra.button).toBe("Your booking form");
    expect(extra.notes).toContain("Three takeaways");
    expect(extra.photos?.[0].text).toContain("white dress");
    expect(extra.photos?.[0].url).toMatch(/\/pub\//);
  });
});

describe("Morgan talks it through", () => {
  beforeEach(() => {
    decision = null;
    systems = [];
  });

  it("explains scores from her facts, rewrites one answer, and puts the old one back", async () => {
    const { orgId, owner } = await makeWorkspace("talk-morgan");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const opp = await db.createOpp({ organizationId: orgId, employeeId: morgan.id, kind: "pitch", title: "Love's Cup", host: "i2E", fitScore: 62, fitCall: "apply", fitReason: "Favors university-affiliated teams." } as any);
    const app = await db.createApplication({
      organizationId: orgId,
      employeeId: morgan.id,
      opportunityId: opp.id,
      title: "Tulsa Pitch Night",
      status: "ready",
      questions: JSON.stringify([{ id: "q1", text: "What problem are you solving?", limit: "", maxWords: 150, answer: "Two systems that don't talk.", outline: [], facts: [], sources: [], status: "done" }]),
    } as any);

    decision = { ...blank, reply: "Judges give 20 points for a university tie." };
    await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Why is Love's Cup a 62?" });
    expect(systems[0]).toContain("Love's Cup (i2E): fit 62");
    expect(systems[0]).toContain("Favors university-affiliated teams.");
    expect(systems[0]).toContain("Tulsa Pitch Night (ready): questions: What problem are you solving?");

    vi.spyOn(apply, "rewriteQuestion").mockImplementation(async (o: number, id: number, qid: string) => {
      const a = (await db.getApplication(id, o))!;
      const qs = JSON.parse(a.questions);
      qs[0].answer = "A front desk can lose hours every week. Two systems that don't talk.";
      return db.updateApplication(id, o, { questions: JSON.stringify(qs) });
    });
    decision = { ...blank, action: "revise_answer", target: "problem", notes: "Lead with the cost", reply: "Here's the new problem answer." };
    const rev = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Make the problem answer stronger" });
    const cards = JSON.parse(rev.reply.cards!);
    expect(cards[0]).toMatchObject({ type: "answer", id: app.id, call: "q1", before: "Two systems that don't talk.", subtitle: "13 of 150 words" });
    expect(cards[1].options).toEqual(["Use this", "Make it shorter", "Go back to the old one"]);

    decision = { ...blank, action: "restore_answer" };
    const back = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Go back to the old one" });
    expect(back.reply.content).toMatch(/put the old answer/);
    expect(JSON.parse((await db.getApplication(app.id, orgId))!.questions)[0].answer).toBe("Two systems that don't talk.");
  });

  it("asks where to search when a person doesn't say, and offers to start the best fit after a search", async () => {
    const { orgId, owner } = await makeWorkspace("talk-search");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    decision = { ...blank, reply: "Quick choice so I search the right places:", choices: ["Oklahoma first", "Nationwide", "Both"] };
    const ask = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Find pitch competitions" });
    expect(systems[0]).toContain('"Oklahoma first", "Nationwide", "Both"');
    expect(JSON.parse(ask.reply.cards!)[0].options).toEqual(["Oklahoma first", "Nationwide", "Both"]);

    const made = await Promise.all(
      [90, 70, 50, 40].map((score, i) => db.createOpp({ organizationId: orgId, employeeId: morgan.id, kind: "pitch", title: `Comp ${i + 1}`, host: "Host", fitScore: score, fitCall: score >= 60 ? "apply" : "skip" } as any))
    );
    vi.spyOn(apply, "findOpportunities").mockResolvedValue({ created: made, queries: ["a", "b"], kind: "pitch", more: false } as any);
    decision = { ...blank, action: "find_grants", oppKind: "pitch" };
    const found = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Both" });
    expect(found.reply.content).toMatch(/The best 3 are below; the other 1 is on Opportunities/);
    const cards = JSON.parse(found.reply.cards!);
    expect(cards.filter((c: any) => c.type === "opportunity").map((c: any) => c.title)).toEqual(["Comp 1", "Comp 2", "Comp 3"]);
    expect(cards.at(-1).options).toEqual(["Start Comp 1", "Start the top 2", "Tell me more about each"]);
  });
});

describe("Simone works from her meeting notes", () => {
  beforeEach(() => {
    decision = null;
    systems = [];
  });

  it("sees the last huddle's action items in chat, and gives each one an owner, a due date and a tracked task even with no project running", async () => {
    const { orgId, owner } = await makeWorkspace("talk-simone");
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const m = await db.createMeeting({ organizationId: orgId, title: "Team huddle, Sat, Oct 3, 2026", startsAt: new Date("2026-10-03T23:00:00Z"), minutes: 20, attendees: "[]", updatesFrom: "[]", status: "held", linkKind: "meet", notes: "Owner: Morgan, send the OCAST letter. Theo, draft the launch article.", actionItems: JSON.stringify([{ text: "Send the OCAST letter", owner: "Morgan", ownerKind: "grants", taskId: null, status: "open" }, { text: "Draft the launch article", owner: "Theo", ownerKind: "blog", taskId: null, status: "open" }]) });

    decision = { ...blank, reply: "Checking." };
    await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "What came out of the last huddle?" });
    expect(systems[0]).toContain("Team huddle, Sat, Oct 3, 2026: 2 action items");
    expect(systems[0]).toContain("Send the OCAST letter (owner: Morgan; no due date; not a task yet)");

    const later = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const llm = await import("./_core/llm");
    (llm.generateJson as any).mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return { ...blank, action: "set_deadlines", target: "", notes: "" };
      if (opts.schemaName === "item_dates") return { dates: [later(3), later(7)] };
      return {};
    });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "Assign deadlines to everyone with tasks from the last huddle" });
    expect(r.reply.content).toMatch(/Send the OCAST letter \(Morgan, due /);
    const items = JSON.parse((await db.getMeeting(m.id, orgId))!.actionItems!);
    expect(items.map((i: any) => i.due)).toEqual([later(3), later(7)]);
    expect(items.every((i: any) => i.taskId)).toBe(true);
    const launch = (await db.listLaunches(orgId)).find((l) => l.name === "Team action items")!;
    expect(launch.status).toBe("active");
    const tasks = await db.listLaunchTasks(launch.id, orgId);
    expect(tasks.map((t) => t.ownerName).sort()).toEqual(["Morgan", "Theo"]);
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    expect((await db.listChatMessages(orgId, morgan.id, 10)).some((x) => x.role === "handoff" && /^Due .*Send the OCAST letter/.test(x.content))).toBe(true);
  });
});
