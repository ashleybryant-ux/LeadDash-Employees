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

describe("every employee knows what's connected; Avery works in ClickUp", () => {
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

  it("tells every employee which tools are connected, and Avery lists what's due and adds tasks in ClickUp", async () => {
    const { orgId, owner } = await makeWorkspace("talk-avery");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "clickup", accountLabel: "ClickUp", status: "connected", settings: JSON.stringify({ teamId: "9", teamName: "LeadDash", userId: 7, spaces: [{ id: "s1", name: "Ops" }], spaceId: "s1", spaceName: "Ops" }), secretsEncrypted: (await import("./_core/crypto")).encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const integrations = await import("./integrations");
    const calls: string[] = [];
    const soon = Date.now() + 2 * 86_400_000;
    vi.spyOn(integrations, "clickup").mockImplementation(async (_o: number, path: string, init: any = {}) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      if (path.startsWith("/team/9/task")) return { tasks: [{ name: "Send W-9 to funder", due_date: String(soon), status: { status: "to do" }, list: { name: "Admin" }, assignees: [{ username: "BJ Bryant" }] }, { name: "Late invoice", due_date: String(Date.now() - 86_400_000), status: { status: "to do" }, list: { name: "Admin" }, assignees: [] }], last_page: true };
      if (path === "/team") return { teams: [{ id: "9", members: [{ user: { id: 42, email: "bj@legacy.test", username: "BJ Bryant" } }] }] };
      if (path.startsWith("/space/s1/list?")) return { lists: [] };
      if (path === "/space/s1/list") return { id: "L9" };
      if (path === "/list/L9/task") return { id: "T1", url: "https://app.clickup.com/t/T1" };
      return {};
    });

    vi.spyOn(integrations, "clickupMembers").mockResolvedValue([{ id: 42, email: "bj@legacy.test", name: "BJ Bryant" }]);
    decision = { ...blank, reply: "Yes, it's connected." };
    await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Do you have access to ClickUp?" });
    expect(systems[0]).toContain("Connected tools on Integrations: ClickUp (every employee has full access: what's due, finding any task or list, adding tasks, marking done, changing dates and owners, commenting; Nora also tracks launches there)");
    expect(systems[0]).toContain("Never say a connected tool isn't connected");

    decision = { ...blank, action: "clickup_due", count: 7 };
    const due = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "What's due this week in ClickUp?" });
    expect(due.reply.content).toMatch(/2 open ClickUp tasks due in the next 7 days, 1 overdue/);
    expect(due.reply.content.indexOf("Late invoice")).toBeLessThan(due.reply.content.indexOf("Send W-9"));

    decision = { ...blank, action: "clickup_add", title: "Book the venue", notes: "For the March workshop", date: "2026-11-02", to: "BJ" };
    const add = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Add a task for BJ to book the venue by Nov 2" });
    expect(add.reply.content).toMatch(/Added "Book the venue" to ClickUp \(LeadDash Employees tasks\) for BJ Bryant, due Mon, Nov 2, 2026/);
    expect(calls).toContain("POST /space/s1/list");
    expect(calls).toContain("POST /list/L9/task");

    // Every employee has the same ClickUp actions.
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    decision = { ...blank, action: "clickup_due", count: 7, target: "BJ" };
    const theoDue = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "What does BJ have due in ClickUp?" });
    expect(theoDue.reply.content).toMatch(/1 open ClickUp task for BJ due in the next 7 days/);
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

describe("full ClickUp access for every employee", () => {
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

  it("finds tasks anywhere, shows the lists, marks a task done, moves its date and comments", async () => {
    const { orgId, owner } = await makeWorkspace("talk-cu-full");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "clickup", accountLabel: "ClickUp", status: "connected", settings: JSON.stringify({ teamId: "9", teamName: "LeadDash", userId: 7, spaces: [{ id: "s1", name: "Ops" }], spaceId: "s1", spaceName: "Ops" }), secretsEncrypted: (await import("./_core/crypto")).encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const integrations = await import("./integrations");
    const calls: { path: string; init: any }[] = [];
    vi.spyOn(integrations, "clickupMembers").mockResolvedValue([{ id: 42, email: "bj@legacy.test", name: "BJ Bryant" }]);
    vi.spyOn(integrations, "clickup").mockImplementation(async (_o: number, path: string, init: any = {}) => {
      calls.push({ path, init });
      if (path.startsWith("/team/9/task")) return { tasks: [
        { id: "a1", name: "October newsletter", due_date: String(Date.now() + 86_400_000), status: { status: "in progress", type: "custom" }, list: { id: "L1", name: "Content calendar" }, folder: { name: "Marketing" }, space: { id: "s1" }, assignees: [{ username: "Caroline" }] },
        { id: "a2", name: "Instagram reels plan", due_date: null, status: { status: "to do", type: "open" }, list: { id: "L1", name: "Content calendar" }, folder: { name: "Marketing" }, space: { id: "s1" }, assignees: [] },
        { id: "a3", name: "Renew liability insurance", due_date: String(Date.now() + 5 * 86_400_000), status: { status: "to do", type: "open" }, list: { id: "L2", name: "Admin" }, folder: { hidden: true }, space: { id: "s1" }, assignees: [{ username: "BJ Bryant" }] },
      ], last_page: true };
      if (path === "/team/9/space?archived=false") return { spaces: [{ id: "s1", name: "Ops" }] };
      if (path === "/space/s1/folder?archived=false") return { folders: [{ name: "Marketing", lists: [{ id: "L1", name: "Content calendar" }] }] };
      if (path === "/space/s1/list?archived=false") return { lists: [{ id: "L2", name: "Admin" }] };
      if (path === "/list/L1") return { statuses: [{ status: "to do", type: "open" }, { status: "in progress", type: "custom" }, { status: "complete", type: "closed" }] };
      if (path === "/list/L1/task") return { id: "n1", url: "https://app.clickup.com/t/n1" };
      return {};
    });
    const send = (text: string) => caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text });

    decision = { ...blank, action: "clickup_find", target: "marketing" };
    const found = await send("What's in the marketing folder in ClickUp?");
    expect(found.reply.content).toMatch(/^2 open ClickUp tasks matching "marketing":/);
    expect(found.reply.content).toMatch(/October newsletter \(Ops › Marketing › Content calendar; Caroline; in progress; due /);

    decision = { ...blank, action: "clickup_lists" };
    const lists = await send("What lists do I have?");
    expect(lists.reply.content).toBe("Here's your ClickUp:\n- Ops: Marketing › Content calendar, Admin");

    decision = { ...blank, action: "clickup_change", target: "October newsletter", focus: "done", date: "2026-10-09", notes: "Sent to the list." };
    const done = await send("Mark the October newsletter done and note it went out");
    expect(done.reply.content).toMatch(/^Updated "October newsletter" in ClickUp: status complete, due Fri, Oct 9, 2026, comment added\./);
    const put = calls.find((c) => c.path === "/task/a1" && c.init.method === "PUT")!;
    expect(put.init.body.status).toBe("complete");
    expect(calls.find((c) => c.path === "/task/a1/comment")!.init.body.comment_text).toBe("Sent to the list. (from Sienna, LeadDash Employees)");

    decision = { ...blank, action: "clickup_change", target: "content calendar", focus: "done" };
    const many = await send("mark the content calendar task done");
    expect(many.reply.content).toBe('More than one task fits "content calendar". Which one?');

    decision = { ...blank, action: "clickup_add", title: "Holiday post ideas", page: "Content calendar" };
    const add = await send("Add holiday post ideas to the content calendar");
    expect(add.reply.content).toMatch(/Added "Holiday post ideas" to ClickUp \(Content calendar\)/);
  });
  it("closes every overdue task in one go without asking first, posts when done, and reopens them on request", async () => {
    const { orgId, owner } = await makeWorkspace("talk-cu-bulk");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "clickup", accountLabel: "ClickUp", status: "connected", settings: JSON.stringify({ teamId: "9", teamName: "LeadDash", userId: 7, spaces: [{ id: "s1", name: "Ops" }], spaceId: "s1", spaceName: "Ops" }), secretsEncrypted: (await import("./_core/crypto")).encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const integrations = await import("./integrations");
    const puts: { path: string; body: any }[] = [];
    let limited = false;
    const day = 86_400_000;
    const task = (id: string, name: string, due: number | null, list = "L1") => ({ id, name, due_date: due ? String(due) : null, status: { status: "to do", type: "open" }, list: { id: list, name: list === "L1" ? "Goals + Tactics" : "PR + Publicity" }, folder: { hidden: true }, space: { id: "s1" }, assignees: [] });
    vi.spyOn(integrations, "clickup").mockImplementation(async (_o: number, path: string, init: any = {}) => {
      if (path.startsWith("/team/9/task")) return { tasks: [task("o1", "Claim Seat", Date.now() - 30 * day), task("o2", "Pitch Documents", Date.now() - 20 * day, "L2"), task("f1", "Next week's post", Date.now() + 5 * day), task("n1", "No date", null)], last_page: true };
      if (path.startsWith("/list/")) return { statuses: [{ status: "to do", type: "open" }, { status: "complete", type: "closed" }] };
      if (init.method === "PUT") {
        // ClickUp says slow down once; the change still goes through on the retry.
        if (!limited) {
          limited = true;
          throw new Error("ClickUp error 429: Rate limit reached");
        }
        puts.push({ path, body: init.body });
        return {};
      }
      return {};
    });
    const send = (text: string) => caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text });
    const until = async (fn: () => Promise<boolean>) => {
      for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 5));
    };

    decision = { ...blank, action: "clickup_bulk", goal: "overdue", focus: "done" };
    const r = await send("Close everything overdue");
    expect(systems[0]).toContain("Don't ask questions first");
    expect(r.reply.content).toMatch(/^On it: closing 2 overdue tasks in ClickUp\./);
    await until(async () => (await db.listChatMessages(orgId, avery.id)).length >= 3);
    const posted = (await db.listChatMessages(orgId, avery.id)).at(-1)!;
    expect(posted.content).toBe("Done. Closing worked for 2 tasks in ClickUp.");
    expect(puts.map((p) => `${p.path} ${p.body.status}`)).toEqual(["/task/o1 complete", "/task/o2 complete"]);
    expect(JSON.parse(posted.cards!)[0]).toMatchObject({ type: "choices", options: ["Reopen them", "What's still open?"], undo: ["o1", "o2"] });

    puts.length = 0;
    decision = { ...blank, action: "clickup_undo" };
    const undo = await send("Reopen them");
    expect(undo.reply.content).toBe("Reopening 2 tasks in ClickUp now. I'll post here when it's done.");
    await until(async () => (await db.listChatMessages(orgId, avery.id)).at(-1)!.content.startsWith("Reopened"));
    expect(puts.map((p) => `${p.path} ${p.body.status}`)).toEqual(["/task/o1 to do", "/task/o2 to do"]);
  });
});
