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

import { caller, makeUser, makeWorkspace } from "./test/helpers";
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
    expect(systems[0]).toContain('Tulsa Pitch Night: READY for review; the owner\'s "approve" submits it (approve action). Questions: What problem are you solving?');

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

describe("every employee knows what's connected and works in Projects", () => {
  beforeEach(async () => {
    decision = null;
    systems = [];
    // An earlier test swapped the AI stub; put the standard one back.
    const llm = await import("./_core/llm");
    (llm.generateJson as any).mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        systems.push(opts.system);
        return decision;
      }
      return {};
    });
  });

  const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it("tells every employee which tools are connected and that tasks live in Projects, and Avery lists what's due and adds tasks there", async () => {
    const { orgId, owner } = await makeWorkspace("talk-avery");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "clickup", accountLabel: "ClickUp", status: "connected", settings: JSON.stringify({ teamId: "9", teamName: "LeadDash", userId: 7, spaces: [] }), secretsEncrypted: null, connectedAt: new Date(), lastCheckedAt: null });
    const bj = await makeUser("bj@talk-avery.test", "user", "BJ Bryant");
    await db.addOrganizationMember({ organizationId: orgId, userId: bj.id, role: "member" });
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const pj = await import("./work/projects");
    const admin = pj.saveList(orgId, { name: "Admin", folderId: null });
    const by = { type: "user" as const, id: owner.id, name: owner.name };
    await pj.createTask(orgId, { listId: admin.id, name: "Send W-9 to funder", dueDate: ymd(2), assignees: [{ type: "user", id: bj.id, name: "BJ Bryant" }] }, by);
    await pj.createTask(orgId, { listId: admin.id, name: "Late invoice", dueDate: ymd(-3), assignees: [{ type: "user", id: owner.id, name: owner.name }] }, by);
    await pj.createTask(orgId, { listId: admin.id, name: "Next month's thing", dueDate: ymd(30) }, by);

    decision = { ...blank, reply: "Yes." };
    await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Where do tasks live?" });
    expect(systems[0]).toContain("Tasks and projects live in Projects, this app's own task manager");
    expect(systems[0]).toContain("Connected tools on Integrations: ClickUp (only for importing old ClickUp tasks into Projects; nobody works in ClickUp anymore");
    expect(systems[0]).toContain("Never say a connected tool isn't connected");
    expect(systems[0]).not.toContain("clickup_due");
    expect(systems[0]).toContain("task_due:");
    expect(systems[0]).toContain("task_bulk:");

    decision = { ...blank, action: "task_due", count: 7 };
    const due = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "What's due this week?" });
    expect(due.reply.content).toMatch(/^2 open tasks in Projects due in the next 7 days, 1 overdue:/);
    expect(due.reply.content.indexOf("Late invoice")).toBeLessThan(due.reply.content.indexOf("Send W-9"));
    expect(due.reply.content).not.toContain("Next month's thing");

    decision = { ...blank, action: "task_add", title: "Book the venue", notes: "For the March workshop", date: "2026-11-02", to: "BJ", page: "Admin" };
    const add = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Add a task for BJ to book the venue by Nov 2" });
    expect(add.reply.content).toMatch(/Added "Book the venue" to Admin in Projects for BJ Bryant, due Nov 2, 2026/);
    expect(db.work.tasks.all(orgId).some((t) => t.name === "Book the venue" && JSON.parse(t.assignees)[0].id === bj.id)).toBe(true);

    // Every employee has the same Projects actions.
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    decision = { ...blank, action: "task_due", count: 7, target: "BJ" };
    const theoDue = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "What does BJ have due?" });
    expect(theoDue.reply.content).toMatch(/^1 open task in Projects for BJ due in the next 7 days:/);
  });
});

describe("employees remember new facts for the whole team", () => {
  beforeEach(async () => {
    decision = null;
    systems = [];
    const llm = await import("./_core/llm");
    (llm.generateJson as any).mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        systems.push(opts.system);
        return decision;
      }
      return {};
    });
  });

  it("saves a new fact to the Brain, replaces it when it changes, and never keeps passwords", async () => {
    const { orgId, owner } = await makeWorkspace("talk-learn");
    const riley = (await db.getEmployeeByKind(orgId, "prospecting"))!;
    decision = { ...blank, reply: "Got it.", remember_topic: "Practice plan price", remember_fact: "The Practice plan is $797 a month for up to 10 clinicians.", remember_category: "services_offers" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: riley.id, text: "FYI the Practice plan is $797 a month for up to 10 clinicians" });
    expect(systems[0]).toContain("Remembering for the whole team");
    expect(r.reply.content).toBe("Got it.\n\nSaved to the Brain for the whole team: The Practice plan is $797 a month for up to 10 clinicians.");
    const item = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Learned: Practice plan price")!;
    expect(item.category).toBe("services_offers");
    expect(item.content).toMatch(/told Riley on/);

    decision = { ...blank, reply: "Updated.", remember_topic: "Practice plan price", remember_fact: "The Practice plan is now $897 a month.", remember_category: "services_offers" };
    const again = await caller(owner).chat.send({ organizationId: orgId, employeeId: riley.id, text: "We raised the Practice plan to $897" });
    expect(again.reply.content).toMatch(/Updated the Brain for the whole team: The Practice plan is now \$897 a month\./);
    expect((await db.listKnowledgeByOrg(orgId)).filter((k) => k.title === "Learned: Practice plan price")).toHaveLength(1);

    decision = { ...blank, reply: "Noted.", remember_topic: "Portal password", remember_fact: "The portal password is hunter2.", remember_category: "mission_profile" };
    const pw = await caller(owner).chat.send({ organizationId: orgId, employeeId: riley.id, text: "the portal password is hunter2" });
    expect(pw.reply.content).toBe("Noted.");
    expect((await db.listKnowledgeByOrg(orgId)).some((k) => k.title === "Learned: Portal password")).toBe(false);
  });
});

describe("full Projects access for every employee", () => {
  beforeEach(async () => {
    decision = null;
    systems = [];
    const llm = await import("./_core/llm");
    (llm.generateJson as any).mockImplementation(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        systems.push(opts.system);
        return decision;
      }
      return {};
    });
  });
  const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  it("finds tasks anywhere, shows the lists, marks a task done, moves its date and comments", async () => {
    const { orgId, owner } = await makeWorkspace("talk-pj-full");
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const pj = await import("./work/projects");
    const by = { type: "user" as const, id: owner.id, name: owner.name };
    const marketing = pj.saveFolder(orgId, { name: "Marketing", color: "#1b6b4a" });
    const cal = pj.saveList(orgId, { name: "Content calendar", folderId: marketing.id });
    const admin = pj.saveList(orgId, { name: "Admin", folderId: null });
    await pj.createTask(orgId, { listId: cal.id, name: "October newsletter", dueDate: ymd(1), status: "in progress", assignees: [{ type: "user", id: owner.id, name: owner.name }] }, by);
    await pj.createTask(orgId, { listId: cal.id, name: "Instagram reels plan" }, by);
    await pj.createTask(orgId, { listId: admin.id, name: "Renew liability insurance", dueDate: ymd(5) }, by);
    const send = (text: string) => caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text });

    decision = { ...blank, action: "task_find", target: "content calendar" };
    const found = await send("What's on the content calendar?");
    expect(found.reply.content).toMatch(/^2 tasks in Projects:/);
    expect(found.reply.content).toMatch(/October newsletter \(Content calendar; Owner talk-pj-full; in progress; due /);

    decision = { ...blank, action: "task_lists" };
    const lists = await send("What lists do I have?");
    expect(lists.reply.content).toBe("Here's Projects:\n- Marketing: Content calendar\n- No folder: Admin");

    decision = { ...blank, action: "task_change", target: "October newsletter", focus: "done", date: "2026-10-09", notes: "Sent to the list." };
    const done = await send("Mark the October newsletter done and note it went out");
    expect(done.reply.content).toBe('Done: "October newsletter", moved it to complete, set the due date to Oct 9, 2026, added your comment.');
    const t = db.work.tasks.all(orgId).find((x) => x.name === "October newsletter")!;
    expect(t.closedAt).not.toBeNull();
    expect(t.dueDate).toBe("2026-10-09");
    expect(db.work.comments.where(orgId, "taskId", t.id).some((c) => c.kind === "comment" && c.body === "Sent to the list." && c.authorName === "Sienna")).toBe(true);

    decision = { ...blank, action: "task_change", target: "plan", focus: "done" };
    await pj.createTask(orgId, { listId: admin.id, name: "Holiday plan" }, by);
    const many = await send("mark the plan task done");
    expect(many.reply.content).toMatch(/^Which one\?/);

    decision = { ...blank, action: "task_add", title: "Holiday post ideas", page: "Content calendar" };
    const add = await send("Add holiday post ideas to the content calendar");
    expect(add.reply.content).toMatch(/Added "Holiday post ideas" to Content calendar in Projects/);
  });

  it("closes every overdue task in one go without asking first, and reopens them on request", async () => {
    const { orgId, owner } = await makeWorkspace("talk-pj-bulk");
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const pj = await import("./work/projects");
    const by = { type: "user" as const, id: owner.id, name: owner.name };
    const goals = pj.saveList(orgId, { name: "Goals + Tactics", folderId: null });
    const other = pj.saveList(orgId, { name: "Admin", folderId: null });
    await pj.createTask(orgId, { listId: goals.id, name: "Claim Seat", dueDate: ymd(-30) }, by);
    await pj.createTask(orgId, { listId: other.id, name: "Pitch Documents", dueDate: ymd(-20) }, by);
    await pj.createTask(orgId, { listId: goals.id, name: "Next week's post", dueDate: ymd(5) }, by);
    await pj.createTask(orgId, { listId: goals.id, name: "No date yet" }, by);
    const send = (text: string) => caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text });

    decision = { ...blank, action: "task_bulk", goal: "overdue", focus: "done" };
    const r = await send("Close everything overdue");
    expect(systems[0]).toContain("Don't ask questions first");
    expect(r.reply.content).toMatch(/^Done: closed 2 overdue tasks in Projects\./);
    const closed = db.work.tasks.all(orgId).filter((t) => t.closedAt).map((t) => t.name).sort();
    expect(closed).toEqual(["Claim Seat", "Pitch Documents"]);
    expect(JSON.parse(r.reply.cards!)[0]).toMatchObject({ type: "choices", options: ["Reopen them", "What's still open?"] });
    expect(JSON.parse(r.reply.cards!)[0].undo).toHaveLength(2);

    decision = { ...blank, action: "task_undo" };
    const undo = await send("Reopen them");
    expect(undo.reply.content).toBe("Reopened 2 tasks in Projects.");
    expect(db.work.tasks.all(orgId).filter((t) => t.closedAt)).toHaveLength(0);

    // Moving a list's open tasks to a date.
    decision = { ...blank, action: "task_bulk", goal: "all", target: "Goals + Tactics", date: "2026-11-06" };
    const moved = await send("Push everything in Goals + Tactics to Nov 6");
    expect(moved.reply.content).toMatch(/^Done: moved to Nov 6, 2026 3 tasks in Projects\./);
    expect(db.work.tasks.all(orgId).filter((t) => t.listId === goals.id).every((t) => t.dueDate === "2026-11-06")).toBe(true);
  });
});
