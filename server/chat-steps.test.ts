import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as calendars from "./employees/calendars";
import { zonedToUtc } from "./employees/schedule";

const blank = { reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

afterEach(() => vi.restoreAllMocks());

/** The employee's decisions, one per call, with every prompt kept so the test can see what each step was shown. */
async function mockSteps(decisions: any[]) {
  const prompts: string[] = [];
  const llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName !== "chat_decision") return {} as any;
    prompts.push(opts.prompt);
    const d = decisions[Math.min(prompts.length - 1, decisions.length - 1)];
    return { ...blank, ...d } as any;
  });
  return prompts;
}

const TZ = "America/Chicago";
const tomorrow = () => {
  const d = new Date(Date.now() + 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
};
const at = (ymd: string, h: number, m = 0) => {
  const [y, mo, d] = ymd.split("-").map(Number);
  return zonedToUtc(y, mo, d, h, m, TZ);
};

describe("A request that takes several steps", () => {
  it("Simone reads the calendars, picks an open hour, books the meeting and sums it up in one reply", async () => {
    const { orgId, owner } = await makeWorkspace("steps");
    await db.updateOrganization(orgId, { timezone: TZ });
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const day = tomorrow();
    const ev = (title: string, h1: number, h2: number, m2 = 0) => ({ start: at(day, h1), end: at(day, h2, m2), allDay: false, title, calendar: "Legacy Family Services", color: "#155c3e", sourceId: 1 });
    vi.spyOn(calendars, "scheduleReply").mockResolvedValue({
      text: "Tomorrow has 4 things across one of your calendars.",
      events: [ev("Individual Therapy For Adults", 9, 9, 50), ev("Individual Therapy For Adults", 10, 10, 50), ev("Individual Therapy For Adults", 11, 11, 50), ev("Individual Therapy For Adults", 15, 15, 50)],
      tz: TZ,
      clash: [],
    } as any);

    const prompts = await mockSteps([
      { action: "check_schedule", date: day, count: 1, plan: "pick the best open hour, then schedule_meeting with Nora's updates and write the agenda", reply: "Checking tomorrow." },
      { action: "schedule_meeting", title: "Launch huddle", date: day, time: "1:00 PM", count: 30, attendees: owner.name, notes: "Nora", plan: "sum up", reply: "Booking it." },
      { action: "none", reply: "Tomorrow is open from 12:00 PM to 3:00 PM, so I booked the Launch huddle for 1:00 PM, 30 minutes, with the agenda built from Nora's launch updates. Press Send invite on the card and it goes out with the meeting link.", choices: ["Send the invite", "Move it to 2:00 PM"] },
    ]);

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "We need a huddle tomorrow about the launch decisions. Check my schedule for the best time, set it up and have Nora's updates on the agenda." });

    // The second decision was shown what the first step found: the busy blocks and the open stretches.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("Your plan after the last step was: pick the best open hour, then schedule_meeting with Nora's updates and write the agenda.");
    expect(prompts[1]).toContain(`Step 1: check_schedule (date: ${day}, count: 1). Result: Tomorrow has 4 things across one of your calendars.`);
    expect(prompts[1]).toMatch(/busy 9:00 to 9:50 AM Individual Therapy For Adults \(Legacy Family Services\); 10:00 to 10:50 AM/);
    expect(prompts[1]).toContain("Open between 8:00 AM and 6:00 PM: 8:00 AM to 9:00 AM, 11:50 AM to 3:00 PM, 3:50 PM to 6:00 PM.");
    // The third decision saw the booking.
    expect(prompts[2]).toContain("Step 2: schedule_meeting (title: Launch huddle");
    expect(prompts[2]).toContain("Result: I set up Launch huddle and wrote the agenda.");

    // One reply: the summary, with the meeting card and without the calendar dump.
    expect(r.reply.content).toBe("Tomorrow is open from 12:00 PM to 3:00 PM, so I booked the Launch huddle for 1:00 PM, 30 minutes, with the agenda built from Nora's launch updates. Press Send invite on the card and it goes out with the meeting link.");
    const cards = JSON.parse(r.reply.cards!);
    expect(cards.map((c: any) => c.type)).toEqual(["meeting_agenda", "choices"]);
    const m = (await db.listMeetings(orgId)).find((x) => x.title === "Launch huddle")!;
    expect(new Date(m.startsAt).getTime()).toBe(at(day, 13).getTime());
    expect(m.minutes).toBe(30);
  });

  it("a one-step request still answers in one go, and a lookup with nothing after it shows the calendar", async () => {
    const { orgId, owner } = await makeWorkspace("steps-one");
    await db.updateOrganization(orgId, { timezone: TZ });
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const day = tomorrow();
    vi.spyOn(calendars, "scheduleReply").mockResolvedValue({ text: "Tomorrow has one thing.", events: [{ start: at(day, 9), end: at(day, 10), allDay: false, title: "Board prep", calendar: "LeadDash", color: "#155c3e", sourceId: 1 }], tz: TZ, clash: [] } as any);
    const prompts = await mockSteps([{ action: "check_schedule", date: day, count: 1, plan: "", reply: "Here is tomorrow." }]);
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "what's on tomorrow?" });
    expect(prompts).toHaveLength(1);
    expect(r.reply.content).toBe("Tomorrow has one thing.");
    expect(JSON.parse(r.reply.cards!)[0].type).toBe("schedule");
  });

  it("stops when the employee repeats a step, and never runs more than five", async () => {
    const { orgId, owner } = await makeWorkspace("steps-loop");
    await db.updateOrganization(orgId, { timezone: TZ });
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const day = tomorrow();
    const spy = vi.spyOn(calendars, "scheduleReply").mockResolvedValue({ text: "Tomorrow is open on your calendar.", events: [], tz: TZ, clash: [] } as any);
    const prompts = await mockSteps([{ action: "check_schedule", date: day, count: 1, plan: "then decide", reply: "Looking." }]);
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "is tomorrow open?" });
    // The same step chosen again ends the loop; the lookup's own text is the reply since no summary came.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(2);
    expect(r.reply.content).toBe("Tomorrow is open on your calendar.");
  });
});
