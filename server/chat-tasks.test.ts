import { beforeEach, describe, expect, it, vi } from "vitest";

let decision: any = null;
let searchResponse: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") return decision;
      if (opts.schemaName === "email_reply") return { whatTheyWant: "A meeting time.", urgency: "today", reply: "Hi, Tuesday works." };
      return {};
    }),
    searchJson: vi.fn(async () => searchResponse),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { nextRun, zonedToUtc, describeRule } from "./employees/schedule";
import { tick } from "./employees/runner";
import { fetchWebpage, htmlToText } from "./employees/files";

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "" };

describe("chat", () => {
  beforeEach(() => {
    decision = null;
  });

  it("answers in chat, runs the job when asked, and shows result cards", async () => {
    const { orgId, owner } = await makeWorkspace("chat");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;

    decision = { ...blank, reply: "I look for open grants and draft proposals." };
    const talk = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "What do you do?" });
    expect(talk.reply.content).toBe("I look for open grants and draft proposals.");
    expect(talk.reply.authorName).toBe("Morgan");
    expect(talk.user.authorName).toBe(owner.name);

    decision = { ...blank, reply: "Searching now.", action: "find_grants", focus: "workforce" };
    searchResponse = {
      queries: ["oklahoma workforce grant", "counseling supervision grant"],
      sources: [{ url: "https://funder.org/g", title: "G" }],
      data: { items: [{ title: "Workforce Grant", host: "Funder", deadline: "Jan 15, 2027", amount: "$50,000", equity: "", stage: "", eligibility: "OK", location: "", eventDate: "", audience: "", angle: "", summary: "", fitReason: "Fits", fitCall: "apply", fitScore: 90, sourceUrl: "https://funder.org/g" }] },
    };
    const work = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Find workforce grants" });
    expect(work.reply.content).toMatch(/2 searches and found 1 new open grant/);
    const cards = JSON.parse(work.reply.cards!);
    expect(cards[0]).toMatchObject({ type: "opportunity", title: "Workforce Grant", url: "https://funder.org/g", call: "apply", score: 90 });
    expect(JSON.parse(work.reply.searchQueries!)).toHaveLength(2);

    const list = await caller(owner).chat.list({ organizationId: orgId, employeeId: morgan.id });
    expect(list.map((m) => m.role)).toEqual(["user", "employee", "user", "employee"]);
    const summaries = await caller(owner).chat.summaries({ organizationId: orgId });
    expect(summaries.find((s) => s.employeeId === morgan.id)?.unread).toBe(0);
  });

  it("turns a pasted email into a reply waiting for approval", async () => {
    const { orgId, owner } = await makeWorkspace("chat-avery");
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    decision = { ...blank, action: "draft_reply", from: "Jane", subject: "Meeting", message: "Can we meet Tuesday?" };
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Jane wrote: Can we meet Tuesday?" });
    expect(JSON.parse(r.reply.cards!)[0]).toMatchObject({ type: "reply", subtitle: "Reply today" });
    const queue = await caller(owner).publishing.listApprovalQueue({ organizationId: orgId });
    expect(queue[0].status).toBe("pending_approval");
  });

  it("says plainly when it cannot do something instead of failing silently", async () => {
    const { orgId, owner } = await makeWorkspace("chat-err");
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    decision = { ...blank, action: "write_post", topic: "x" };
    // generateJson for social_post returns {} -> post with empty fields still saves; force an error by pausing
    await caller(owner).employees.toggleStatus({ organizationId: orgId, id: sienna.id, status: "paused" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text: "write a post" });
    expect(r.reply.content).toMatch(/paused/);
  });
});

describe("scheduled tasks", () => {
  it("computes the next run in the workspace time zone, across daylight saving", () => {
    // Monday Oct 5, 2026 8:00 AM Central = 13:00 UTC (CDT)
    const after = new Date("2026-10-02T12:00:00Z"); // Friday
    expect(nextRun({ repeat: "weekly", weekday: 1, time: "08:00" }, "America/Chicago", after)?.toISOString()).toBe("2026-10-05T13:00:00.000Z");
    // After DST ends (Nov 1, 2026) 8:00 AM Central = 14:00 UTC
    expect(nextRun({ repeat: "weekly", weekday: 1, time: "08:00" }, "America/Chicago", new Date("2026-11-03T00:00:00Z"))?.toISOString()).toBe("2026-11-09T14:00:00.000Z");
    expect(nextRun({ repeat: "weekdays", time: "08:30" }, "America/Chicago", after)?.toISOString()).toBe("2026-10-02T13:30:00.000Z"); // Friday, same day
    expect(nextRun({ repeat: "monthly", monthDay: 1, time: "09:00" }, "America/Chicago", after)?.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(nextRun({ repeat: "once", onDate: "2026-09-01", time: "09:00" }, "America/Chicago", after)).toBeNull();
    expect(zonedToUtc(2026, 3, 8, 3, 0, "America/Chicago").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(describeRule({ repeat: "weekly", weekday: 1, time: "08:00" })).toBe("Every Monday, 8:00 AM");
  });

  it("saves a task, runs it when due, and moves the next run forward", async () => {
    const { orgId, owner } = await makeWorkspace("tasks");
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const t = await caller(owner).tasks.save({
      organizationId: orgId,
      employeeId: avery.id,
      title: "Morning check",
      instructions: "Tell me what needs a reply today.",
      repeat: "daily",
      time: "08:00",
    });
    expect(t.nextRunAt).toBeTruthy();
    decision = { ...blank, reply: "Nothing needs a reply today." };
    await db.updateScheduledTask(t.id, orgId, { nextRunAt: new Date(Date.now() - 1000) });
    expect(await tick()).toBe(1);
    const after = await db.getScheduledTaskForOrg(t.id, orgId);
    expect(after?.lastStatus).toBe("ok");
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const chat = await caller(owner).chat.list({ organizationId: orgId, employeeId: avery.id });
    expect(chat[0].authorName).toBe("Scheduled task: Morning check");
    expect(chat[1].content).toBe("Nothing needs a reply today.");
    const listed = await caller(owner).tasks.list({ organizationId: orgId });
    expect(listed[0]).toMatchObject({ repeatLabel: "Every day, 8:00 AM", employeeName: "Avery" });
  });
});

describe("Brain inputs", () => {
  it("refuses links to private addresses and the cloud metadata service", async () => {
    await expect(fetchWebpage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private/);
    await expect(fetchWebpage("http://127.0.0.1:4100/")).rejects.toThrow(/private/);
    await expect(fetchWebpage("file:///etc/passwd")).rejects.toThrow(/http/);
  });

  it("turns HTML into readable text", () => {
    expect(htmlToText("<html><head><style>x{}</style></head><body><h1>Hi &amp; welcome</h1><script>bad()</script><p>Line two</p></body></html>")).toBe("Hi & welcome\nLine two");
  });

  it("stores an uploaded text document so employees can read it", async () => {
    const { orgId, owner } = await makeWorkspace("docs");
    const item = await caller(owner).knowledge.uploadDocument({
      organizationId: orgId,
      title: "Rate sheet",
      fileName: "rates.txt",
      mimeType: "text/plain",
      data: Buffer.from("Individual session: $150").toString("base64"),
    });
    expect(item.kind).toBe("document");
    expect(item.content).toContain("$150");
    expect(item.fileUrl).toMatch(/^\/files\/org-\d+\/documents\/rates_[0-9a-f]+\.txt$/);
    await expect(
      caller(owner).knowledge.uploadImage({ organizationId: orgId, title: "Not an image", data: Buffer.from("hello").toString("base64") })
    ).rejects.toThrow(/PNG, JPG/);
  });
});
