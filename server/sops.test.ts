import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as sops from "./employees/sops";

/**
 * SOPs: the library with versions and review dates, a current SOP carried
 * into the Brain, and the three ways one is written: from chat, from a site
 * walk with a screenshot per step, and from a screen recording.
 */

let llm: typeof import("./_core/llm");
let decision: any = { reply: "", action: "none", choices: [] };
const blank = { focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [], remember_topic: "", remember_fact: "", remember_category: "" };
let prompts: string[] = [];

vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));

function mockAi() {
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "chat_decision") return { ...blank, ...decision } as any;
    if (opts.schemaName === "sop_steps") {
      prompts.push(opts.prompt);
      const site = /browser log|What I did in the browser/.test(opts.prompt);
      const rec = /screen recording|narration/.test(`${opts.system} ${opts.prompt}`);
      return {
        title: "Adding a clinician's availability",
        area: "admin",
        follows: "Practice manager",
        when: "When a clinician's hours change",
        steps: [
          { title: "Open Calendar and switch to the Availability view", detail: "The editor lives on the calendar.", at: site ? 2 : rec ? 3 : 0 },
          { title: "Pick the clinician", detail: "", at: site ? 3 : rec ? 20 : 0 },
          { title: "Add a weekly block and save", detail: "Office, video, or both.", at: site ? 5 : rec ? 41 : 0 },
        ],
      } as any;
    }
    return {} as any;
  });
}

beforeEach(async () => {
  llm = await import("./_core/llm");
  prompts = [];
  mockAi();
});
afterEach(() => vi.restoreAllMocks());

describe("The SOP library", () => {
  it("creates, saves versions, moves through review, and carries a current SOP into the Brain", async () => {
    const { orgId, owner } = await makeWorkspace("sops-lib");
    const me = caller(owner);
    const s = await me.sops.create({ organizationId: orgId, title: "Booking a first session", area: "front_desk", ownerKind: "leads", follows: "Front desk", when: "Every new inquiry", steps: [{ title: "Open the inquiry", detail: "", imageUrl: null }, { title: "Offer two times", detail: "Inside the clinician's hours.", imageUrl: null }] });
    expect(s).toMatchObject({ status: "draft", version: 1, ownerName: "Malik", areaLabel: "Front desk", statusLabel: "Draft" });
    expect(s.steps).toHaveLength(2);

    const v2 = await me.sops.save({ organizationId: orgId, id: s.id, title: "Booking a first session", area: "front_desk", ownerKind: "leads", follows: "Front desk", when: "Every new inquiry", nextReview: "10/06/2027", steps: [...s.steps, { title: "Send the paperwork link", detail: "", imageUrl: null }] });
    expect(v2.version).toBe(2);
    expect(v2.nextReview).toBe("2027-10-06");
    await expect(me.sops.save({ organizationId: orgId, id: s.id, title: "x", area: "front_desk", nextReview: "Oct 6", steps: [] })).rejects.toThrow(/MM\/DD\/YYYY/);

    const r = await me.sops.setStatus({ organizationId: orgId, id: s.id, status: "review" });
    expect(r.statusLabel).toBe("In review");
    const c = await me.sops.setStatus({ organizationId: orgId, id: s.id, status: "current" });
    expect(c.status).toBe("current");
    expect(c.reviewedAt).toBe(sops.today());
    expect(c.nextReview).toBe("2027-10-06");
    // The Brain now carries it as a procedure every employee reads.
    const brain = (await db.listKnowledgeByOrg(orgId)).filter((k) => k.category === "procedures");
    expect(brain).toHaveLength(1);
    expect(brain[0].title).toBe("SOP: Booking a first session");
    expect(brain[0].content).toContain("3. Send the paperwork link");

    const got = await me.sops.get({ organizationId: orgId, id: s.id });
    expect(got.history.map((h) => h.note)).toEqual(["Approved", "Sent for review", "Edited", "Created"]);
    expect(got.history[0].version).toBe(2);

    // Retiring takes it out of the Brain; the list leaves it out.
    await me.sops.setStatus({ organizationId: orgId, id: s.id, status: "retired" });
    expect((await db.listKnowledgeByOrg(orgId)).filter((k) => k.category === "procedures")).toHaveLength(0);
    expect((await me.sops.list({ organizationId: orgId })).sops).toHaveLength(0);
  });

  it("shows Review due when the date has passed, and a Team chat only person can read but not write", async () => {
    const { orgId, owner } = await makeWorkspace("sops-due");
    const me = caller(owner);
    const s = sops.create(orgId, { title: "Handling a crisis call", area: "front_desk", steps: [{ title: "Stay on the line", detail: "", imageUrl: null }] }, "Ashley");
    db.sops.update(s.id, { status: "current", reviewedAt: "2026-03-03", nextReview: "2026-09-03" });
    const list = await me.sops.list({ organizationId: orgId });
    expect(list.sops[0]).toMatchObject({ statusLabel: "Review due", reviewDue: true, ownerName: "Simone" });
    expect(list.reviewDue).toBe(1);
    expect(list.counts).toMatchObject({ all: 1, front_desk: 1, billing: 0 });
    const after = await me.sops.reviewed({ organizationId: orgId, id: s.id });
    expect(after.reviewDue).toBe(false);
    expect(after.nextReview).toBe(sops.yearAfter(sops.today()));

    const delicia = await makeUser("delicia@sops-due.test", "user", "Delicia Porter");
    await db.addOrganizationMember({ organizationId: orgId, userId: delicia.id, role: "chat" });
    const her = caller(delicia);
    const seen = await her.sops.list({ organizationId: orgId });
    expect(seen.sops).toHaveLength(1);
    expect(seen.canEdit).toBe(false);
    expect((await her.sops.get({ organizationId: orgId, id: s.id })).title).toBe("Handling a crisis call");
    await expect(her.sops.create({ organizationId: orgId, title: "x", area: "admin", steps: [] })).rejects.toThrow(/cannot do that/);
  });

  it("is written from chat when the owner says how it goes", async () => {
    const { orgId, owner } = await makeWorkspace("sops-chat");
    const me = caller(owner);
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    decision = { reply: "", action: "sop_write", title: "Adding a clinician's availability", notes: "Open the calendar, switch to Availability, pick the clinician, add a weekly block and save.", focus: "admin", target: "Practice manager" };
    const r = await me.chat.send({ organizationId: orgId, employeeId: simone.id, text: "Write up how we add a clinician's availability: open the calendar, switch to Availability, pick the clinician, add a weekly block and save." });
    expect(r.reply.content).toContain('I wrote "Adding a clinician\'s availability" as 3 steps');
    expect(r.reply.content).toContain("send it to review");
    const cards = JSON.parse(r.reply.cards!);
    expect(cards[0].type).toBe("sop");
    const s = db.sops.get(orgId, cards[0].id)!;
    expect(s).toMatchObject({ status: "draft", sourceKind: "chat", area: "admin", follows: "Practice manager", ownerKind: "coo" });
    expect(sops.stepsOf(s).map((x) => x.imageUrl)).toEqual([null, null, null]);
    expect(prompts[0]).toContain("add a weekly block and save");
  });

  it("is written from a site walk with the screenshot of each step", async () => {
    const { orgId } = await makeWorkspace("sops-site");
    const zara = (await db.getEmployeeByKind(orgId, "platform"))!;
    const t = db.createWebTask({ organizationId: orgId, employeeId: zara.id, kind: "sop", title: "SOP: Adding a clinician's availability", goal: sops.siteGoal("Adding a clinician's availability"), startUrl: "https://demo.leaddash.io/calendar", ref: JSON.stringify({ shots: `org-${orgId}/sops` }) });
    db.sops.addJob({ organizationId: orgId, kind: "site", title: "Adding a clinician's availability", status: "working", stages: "[]", webTaskId: t.id, createdBy: "Ashley" });
    const log = [
      { step: 1, action: "click", detail: "Clicked Calendar", url: "https://demo.leaddash.io/calendar", title: "Calendar", screenshotUrl: "/files/s1.png" },
      { step: 2, action: "click", detail: "Clicked Availability", url: "https://demo.leaddash.io/calendar/availability", title: "Availability", screenshotUrl: "/files/s2.png" },
      { step: 3, action: "select", detail: "Picked Angela St. Ville", url: "https://demo.leaddash.io/calendar/availability", title: "Availability", screenshotUrl: "/files/s3.png" },
      { step: 4, action: "click", detail: "Clicked Add block", url: "https://demo.leaddash.io/calendar/availability", title: "Availability", screenshotUrl: null },
      { step: 5, action: "type", detail: "Typed 9:00 AM", url: "https://demo.leaddash.io/calendar/availability", title: "Add availability", screenshotUrl: "/files/s5.png" },
      { step: 6, action: "done", detail: "Goal reached", url: "https://demo.leaddash.io/calendar/availability" },
    ];
    const res = { status: "done" as const, result: JSON.stringify({ answer: "Calendar, then Availability, pick the clinician, Add block, then Save.", pending: "Save" }), note: "", storageState: null, downloads: [], log, screenshotUrl: "/files/s5.png", helped: [], url: log[4].url };
    const s = (await sops.finishFromSite(zara, t, res))!;
    expect(s).toMatchObject({ title: "Adding a clinician's availability", sourceKind: "site", sourceUrl: "https://demo.leaddash.io/calendar", ownerKind: "platform", status: "draft" });
    expect(sops.stepsOf(s).map((x) => x.imageUrl)).toEqual(["/files/s2.png", "/files/s3.png", "/files/s5.png"]);
    expect(prompts[0]).toContain("Step 3: Picked Angela St. Ville (page: Availability) [screenshot]");
    expect(db.sops.jobForWebTask(orgId, t.id)).toMatchObject({ status: "done", sopId: s.id });
  });

  it("is written from a screen recording: narration transcribed, a frame per screen change, Simone posts the draft", async () => {
    const { orgId } = await makeWorkspace("sops-rec");
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sop-rec-"));
    const file = path.join(tmp, "rec.webm");
    fs.writeFileSync(file, Buffer.alloc(20_000, 1));
    const frames = vi.spyOn(sops.tools, "frames").mockImplementation(async (_video, dir) => {
      const out: { at: number; file: string }[] = [];
      for (const at of [0, 4, 19, 40]) {
        const f = path.join(dir, `frame-${at}.png`);
        fs.writeFileSync(f, Buffer.from("png"));
        out.push({ at, file: f });
      }
      return out;
    });
    vi.spyOn(sops.tools, "audio").mockImplementation(async (_video, dir) => {
      const f = path.join(dir, "audio.mp3");
      fs.writeFileSync(f, Buffer.from("mp3"));
      return f;
    });
    vi.spyOn(sops.tools, "transcribe").mockResolvedValue({
      text: "First open the calendar and switch to availability. Then pick the clinician. Then add a weekly block and save.",
      seconds: 48,
      words: [
        ...["First", "open", "the", "calendar", "and", "switch", "to", "availability."].map((w, i) => ({ text: w, start: 2 + i * 0.4, end: 2.3 + i * 0.4 })),
        ...["Then", "pick", "the", "clinician."].map((w, i) => ({ text: w, start: 19 + i * 0.4, end: 19.3 + i * 0.4 })),
        ...["Then", "add", "a", "weekly", "block", "and", "save."].map((w, i) => ({ text: w, start: 40 + i * 0.4, end: 40.3 + i * 0.4 })),
      ],
    });

    const job = sops.startFromRecording(orgId, { title: "Adding a clinician's availability", filePath: file, by: "Ashley" });
    await sops.settled();
    const done = db.sops.job(orgId, job.id)!;
    expect(done.status).toBe("done");
    expect(done.seconds).toBe(48);
    expect(sops.jobView(done).stages.map((s) => s.label)).toEqual(["Recording saved", "Your words transcribed", "4 screens found", "Writing the steps"]);
    expect(frames).toHaveBeenCalledTimes(1);
    const s = db.sops.get(orgId, done.sopId!)!;
    expect(s).toMatchObject({ sourceKind: "record", ownerKind: "coo", status: "draft" });
    expect(s.sourceNote).toContain("0:48");
    expect(s.sourceUrl).toMatch(/\/files\/org-\d+\/sops\/recording-\d+[^/]*\.webm$/);
    // Each step gets the frame nearest after the second it starts: 3 -> frame at 4, 20 -> none after 19 within a second, so 40; 41 -> 40.
    const urls = sops.stepsOf(s).map((x) => x.imageUrl!);
    expect(urls[0]).toMatch(/-0004[^/]*\.png$/);
    expect(urls[1]).toMatch(/-0019[^/]*\.png$/);
    expect(urls[2]).toMatch(/-0040[^/]*\.png$/);
    expect(prompts[0]).toContain("[2s] First open the calendar and switch to availability.");
    expect(prompts[0]).toContain("The screen changed at these seconds: 0, 4, 19, 40");
    expect(fs.existsSync(file)).toBe(false);
    const msgs = await db.listChatMessages(orgId, simone.id, 5);
    const last = msgs[msgs.length - 1];
    expect(last.content).toContain('Your recording for "Adding a clinician\'s availability" is written up: 3 steps');
    expect(JSON.parse(last.cards!)[0]).toMatchObject({ type: "sop", id: s.id });
  });

  it("parses typed dates and groups transcript words into timed lines", () => {
    expect(sops.dateIn("10/06/2027")).toBe("2027-10-06");
    expect(sops.dateIn("2027-10-06")).toBe("2027-10-06");
    expect(sops.dateIn("Oct 6")).toBe("");
    expect(sops.yearAfter("2026-02-28")).toBe("2027-02-28");
    expect(sops.mmss(188)).toBe("3:08");
    expect(sops.groupWords([{ text: "Open", start: 1.2, end: 1.5 }, { text: "it.", start: 1.6, end: 1.8 }, { text: "Then", start: 9.7, end: 9.9 }, { text: "save", start: 10, end: 10.2 }])).toBe("[1s] Open it.\n[10s] Then save");
  });
});
