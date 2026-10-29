import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-"));
process.env.DATABASE_PATH = path.join(tmp, "employees.db");
process.env.APP_URL = "https://employees.example.test";

const pb = await import("./playbook");
const { ENV } = await import("./_core/env");

const fields = {
  playbook_practice_name: "Healing Tree Counseling",
  playbook_city_state: "Tulsa, OK",
  playbook_stage: "Building (not full yet)",
  playbook_specialty: "teen girls with anxiety",
  playbook_payment: "Self-pay",
  playbook_inquiries: "10",
  playbook_booked: "5",
  playbook_fee: "$150",
  playbook_sessions: "8",
  playbook_response_time: "Next day",
  playbook_rate_found: "3",
  playbook_rate_booked: "4",
  playbook_rate_keep: "2",
  playbook_manual_steps: "4",
  playbook_channels: ["Phone calls", "Psychology Today"],
};

const good = {
  where: "You answer most inquiries the next day — and four of your five booking steps happen by hand.",
  steps: [
    { title: "Write your reply text", when: "Tonight", body: "Write the text you send every new inquiry." },
    { title: "Send paperwork at booking", when: "This week", body: "Send intake forms the moment someone books." },
    { title: "Add reminders", when: "Before your next billing cycle", body: "Three reminders with one-tap confirm." },
  ],
  words: { bestWith: "I help teen girls in Tulsa who can't turn off the worry.", referralNote: "Hi, this is Dana.", replyTitle: "Reply to a new inquiry", reply: "Thanks for reaching out." },
  fit: "LeadDash answers and books for you.",
  focus: "Start with Get booked tonight.",
};

describe("Full Caseload Playbook", () => {
  it("reads numbers the way people type them", () => {
    expect(pb.num("$1,200")).toBe(1200);
    expect(pb.num("about 10")).toBe(10);
    expect(pb.num("8-10")).toBe(9);
    expect(pb.num("a lot")).toBeNull();
    expect(pb.score("3 (sometimes)")).toBe(3);
    expect(pb.score("9")).toBeNull();
  });

  it("does the webinar math in code", () => {
    const a = pb.answersFrom(fields, { firstName: "Dana" });
    const n = pb.numbersFor(a);
    expect(n).toMatchObject({ missed: 5, monthly: 6000, yearly: 72000, recoverCount: 2, recovery: 2400, retention: 1200, sessionsAssumed: false });
    expect(pb.numberLines(a, n)[1]).toBe("5 x $150 x 8 sessions = $6,000 a month, or $72,000 a year.");
  });

  it("assumes 8 sessions when the form has none, and says so", () => {
    const a = pb.answersFrom({ ...fields, playbook_sessions: "" });
    const n = pb.numbersFor(a);
    expect(n.sessions).toBe(8);
    expect(pb.numberLines(a, n).join(" ")).toContain("We used 8 sessions");
  });

  it("starts on the lowest score, unless the answers say booking is the leak", () => {
    expect(pb.weakestStep(pb.answersFrom({ ...fields, playbook_response_time: "Within the hour", playbook_manual_steps: "1" }))).toEqual({ step: "keep", overridden: false });
    expect(pb.weakestStep(pb.answersFrom(fields))).toEqual({ step: "booked", overridden: true });
    expect(pb.weakestStep(pb.answersFrom({ playbook_rate_found: "2", playbook_rate_booked: "2", playbook_rate_keep: "2" })).step).toBe("booked");
    expect(pb.weakestStep(pb.answersFrom({})).step).toBe("booked");
  });

  it("takes out em and en dashes", () => {
    expect(pb.clean("one — two – three")).toBe("one, two, three");
  });

  it("checks the model's answer and falls back to built-in wording", async () => {
    const a = pb.answersFrom(fields, { firstName: "Dana" });
    const n = pb.numbersFor(a);
    const w = pb.weakestStep(a);
    const ok = await pb.writePlaybook(a, n, w, async () => JSON.stringify(good));
    expect(ok.byModel).toBe(true);
    expect(ok.written.where).not.toMatch(/[—–]/);
    const bad = await pb.writePlaybook(a, n, w, async () => '{"steps":[]}');
    expect(bad.byModel).toBe(false);
    expect(bad.written.steps[0].when).toBe("Tonight");
    expect(bad.written.words.reply).toContain("Dana");
    expect(JSON.stringify(bad.written)).not.toMatch(/[—–]/);
  });

  it("keeps one playbook per contact and reuses it when the answers are the same", async () => {
    let calls = 0;
    const call = async () => (calls++, JSON.stringify(good));
    const p1 = await pb.buildPlaybook("contactAbc123", fields, { firstName: "Dana" }, { call, webinarStart: "2026-11-03T19:00:00-06:00" });
    const p2 = await pb.buildPlaybook("contactAbc123", fields, { firstName: "Dana" }, { call });
    expect(p2.token).toBe(p1.token);
    expect(calls).toBe(1);
    expect(pb.loadPlaybook(p1.token)?.answers.practice).toBe("Healing Tree Counseling");
    expect(pb.loadPlaybook("../../etc/passwd")).toBeNull();
    expect(pb.playbookUrl(p1.token)).toBe(`https://employees.example.test/playbook/${p1.token}`);
  });

  it("ends the offer at midnight Central on the webinar night", () => {
    expect(new Date(pb.offerEnds("2026-11-03T19:00:00-06:00")).toISOString()).toBe("2026-11-04T06:00:00.000Z");
    expect(new Date(pb.offerEnds("2026-10-27T19:00:00-05:00")).toISOString()).toBe("2026-10-28T05:00:00.000Z");
  });

  it("finds the next Tuesday 7:00 PM Central", () => {
    expect(new Date(pb.nextSession(Date.parse("2026-10-29T18:00:00Z"))).toISOString()).toBe("2026-11-04T01:00:00.000Z");
    expect(new Date(pb.nextSession(Date.parse("2026-10-27T12:00:00Z"))).toISOString()).toBe("2026-10-28T00:00:00.000Z");
  });

  it("shows the $299 offer before midnight and the next session after", async () => {
    const p = await pb.buildPlaybook("contactXyz789", fields, { firstName: "Dana" }, { call: async () => JSON.stringify(good), webinarStart: "2026-11-03T19:00:00-06:00" });
    ENV.playbookCheckoutUrl = "https://link.example.test/checkout";
    const during = pb.pageHtml(p, Date.parse("2026-11-04T03:00:00Z"));
    expect(during).toContain("Start LeadDash at $299");
    expect(during).toContain("$6,000 a month");
    const after = pb.pageHtml(p, Date.parse("2026-11-04T07:00:00Z"));
    expect(after).not.toContain("Start LeadDash at $299");
    expect(after).toContain("Save my seat");
    expect(after).toContain("Tuesday, Nov 10, 2026");
    expect(after).not.toMatch(/[—–]/);
  });

  it("finds the contact id in the webhook body", () => {
    expect(pb.contactIdOf({ contact_id: "abcDEF123456" })).toBe("abcDEF123456");
    expect(pb.contactIdOf({ customData: { contactId: "abcDEF123456" } })).toBe("abcDEF123456");
    expect(pb.contactIdOf({ contact_id: "../x" })).toBe("");
  });
});
