import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as ehr from "./ehr";
import * as rm from "./employees/reminders";

/**
 * Camille reads the practice's team from LeadDash EHR and writes reminders to
 * them in chat. Nothing goes out until a person says so; then LeadDash EHR
 * sends it. A reminder never names a client.
 */

vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
afterEach(() => {
  vi.restoreAllMocks();
  ehr.forgetTeam();
});

const TEAM: ehr.EhrTeamMember[] = [
  { id: "u1", name: "Dana Whitfield", email: "dana@brightpath.test", phone: "", role: "Clinician", seesClients: true, signsAs: "Dana Whitfield, LPC", npi: "", licenses: [{ type: "LPC", state: "CO", number: "123", expires: "2026-11-30", primary: true }] },
  { id: "u2", name: "Marcus Lee", email: "marcus@brightpath.test", phone: "", role: "Biller", seesClients: false, signsAs: "", npi: "", licenses: [] },
  { id: "u3", name: "Priya Shah", email: "", phone: "", role: "Intern", seesClients: true, signsAs: "", npi: "", licenses: [] },
  { id: "u4", name: "Dana Ortiz", email: "dortiz@brightpath.test", phone: "", role: "Practice Administrator", seesClients: false, signsAs: "", npi: "", licenses: [] },
];

async function practice(slug: string) {
  const { orgId, owner } = await makeWorkspace(slug);
  const me = caller(owner);
  await me.organizations.update({ id: orgId, orgType: "healthcare" });
  vi.spyOn(ehr.tools, "fetchJson").mockImplementation(async (url: string) => {
    if (url.endsWith("/api/employees/ping")) return { ok: true, practice: "Bright Path Counseling", locationId: "loc1" };
    if (url.endsWith("/api/employees/team")) return { ok: true, practice: "Bright Path Counseling", team: TEAM };
    return { generatedAt: "2026-10-12T14:00:00.000Z", practice: "Bright Path Counseling", claims: [], unpaid: [], balances: [], eligibility: [], paperwork: [], appointments: [], lapsed: [], docs: [], totals: {}, names: ["Avery Price"] };
  });
  await me.ehr.connect({ organizationId: orgId, url: "https://api.health.leaddash.io", key: "ld-emp-0123456789abcdefghij" });
  return { orgId, me };
}

describe("Camille's reminders", () => {
  it("matches people, groups and leaves out names it can't place", () => {
    expect(rm.matchRecipients(TEAM, "Marcus and Priya").found.map((r) => r.id)).toEqual(["u2", "u3"]);
    expect(rm.matchRecipients(TEAM, "all clinicians").found.map((r) => r.id)).toEqual(["u1", "u3"]);
    expect(rm.matchRecipients(TEAM, "everyone").found).toHaveLength(4);
    expect(rm.matchRecipients(TEAM, "Dana Whitfield").found.map((r) => r.id)).toEqual(["u1"]);
    // Two Danas: not guessed.
    expect(rm.matchRecipients(TEAM, "Dana")).toEqual({ found: [], missing: ["dana"] });
    expect(rm.matchRecipients(TEAM, "Marcus, Jordan").missing).toEqual(["jordan"]);
  });

  it("works out send times in the workspace's zone and the next one for a repeat", () => {
    const now = new Date("2026-10-12T15:00:00Z"); // 10:00 AM in Chicago
    expect(rm.sendTimeOf("2026-10-19", "9:00 AM", "America/Chicago", now)?.toISOString()).toBe("2026-10-19T14:00:00.000Z");
    expect(rm.sendTimeOf("", "9am", "America/Chicago", now)?.toISOString()).toBe("2026-10-13T14:00:00.000Z");
    expect(rm.sendTimeOf("", "", "America/Chicago", now)).toBeNull();
    expect(rm.nextAfter(new Date("2026-10-19T14:00:00Z"), "weekly", "America/Chicago")?.toISOString()).toBe("2026-10-26T14:00:00.000Z");
    // Across the end of daylight saving time, still 9:00 AM local.
    expect(rm.nextAfter(new Date("2026-10-31T14:00:00Z"), "weekly", "America/Chicago")?.toISOString()).toBe("2026-11-07T15:00:00.000Z");
    expect(rm.nextAfter(new Date("2027-01-31T15:00:00Z"), "monthly", "America/Chicago")?.toISOString()).toBe("2027-02-28T15:00:00.000Z");
  });

  it("drafts, changes, sends through LeadDash EHR only when approved, and repeats", async () => {
    const { orgId } = await practice("rm-flow");
    const post = vi.spyOn(ehr.tools, "postJson").mockImplementation(async (_url: string, _key: string, body: unknown) => {
      const b = body as { userIds: string[] };
      return { ok: true, sent: b.userIds.filter((id) => id !== "u3").map((id) => ({ id, name: TEAM.find((t) => t.id === id)!.name, email: true, push: 0 })), skipped: b.userIds.includes("u3") ? [{ id: "u3", name: "Priya Shah", reason: "no email on file" }] : [] };
    });

    const d = await rm.draft(orgId, { to: "Dana Whitfield", subject: "Notes to sign", body: "Hi Dana, you have 3 notes past 48 hours. Camille", date: "", time: "", repeat: "" });
    expect(d.ok).toBe(true);
    expect(d.text).toContain("To: Dana Whitfield");
    expect(d.ask).toEqual(["Send it", "Change it", "Cancel it"]);
    expect(post).not.toHaveBeenCalled();

    const c = await rm.change(orgId, { target: "", to: "Dana Whitfield, Priya", repeat: "" });
    expect(c.text).toContain("Dana Whitfield and Priya Shah");

    const s = await rm.approve(orgId, "notes", "Owner");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("https://api.health.leaddash.io/api/employees/remind");
    expect(post.mock.calls[0][2]).toEqual({ userIds: ["u1", "u3"], subject: "Notes to sign", text: "Hi Dana, you have 3 notes past 48 hours. Camille" });
    expect(s.text).toContain("Sent to Dana Whitfield");
    expect(s.text).toContain("Not sent to Priya Shah (no email on file)");
    expect(s.reminder!.status).toBe("sent");

    // Scheduled and weekly: approving schedules it; the tick sends it and sets the next week.
    const w = await rm.draft(orgId, { to: "all clinicians", subject: "Sign this week's notes", body: "A Monday reminder to sign notes from last week.", date: "2030-01-07", time: "9:00 AM", repeat: "weekly" });
    const a = await rm.approve(orgId, "this week", "Owner");
    expect(a.reminder!.status).toBe("scheduled");
    expect(a.text).toMatch(/Mon, Jan 7, 2030.*every week/);
    expect(await rm.remindersTick(new Date("2030-01-06T00:00:00Z"))).toBe(0);
    expect(await rm.remindersTick(new Date("2030-01-07T15:05:00Z"))).toBe(1);
    const after = db.reminders.get(orgId, w.reminder!.id)!;
    expect(after).toMatchObject({ status: "scheduled", sentCount: 1 });
    expect(new Date(after.sendAt!).toISOString()).toBe("2030-01-14T15:00:00.000Z");
    const camille = await db.getEmployeeByKind(orgId, "compliance");
    const msgs = await db.listChatMessages(orgId, camille!.id);
    expect(msgs.some((m) => m.content.includes('Reminder "Sign this week\'s notes"'))).toBe(true);

    expect(rm.cancel(orgId, "this week").text).toContain("won't go out again");
    expect(await rm.listText(orgId)).toContain("Sent lately");
  });

  it("refuses a reminder that names a client, and says why when the EHR can't send", async () => {
    const { orgId } = await practice("rm-safe");
    ehr.rememberNames(orgId, ["Avery Price"]);
    const bad = await rm.draft(orgId, { to: "Marcus", subject: "Balance", body: "Please call Avery Price about the balance.", date: "", time: "", repeat: "" });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("names a client");
    expect(db.reminders.list(orgId)).toHaveLength(0);

    vi.spyOn(ehr.tools, "postJson").mockRejectedValue(new Error("LeadDash EHR answered 404: Cannot POST"));
    await rm.draft(orgId, { to: "Marcus", subject: "Statements", body: "Statements go out Friday.", date: "", time: "", repeat: "" });
    const s = await rm.approve(orgId, "", "Owner");
    expect(s.ok).toBe(false);
    expect(s.text).toContain("needs its latest update deployed");
    expect(s.reminder!.status).toBe("failed");
  });

  it("gives Camille the team, expiring licenses and her reminders", async () => {
    const { orgId } = await practice("rm-prompt");
    await rm.draft(orgId, { to: "everyone", subject: "HIPAA training", body: "HIPAA training is due by Oct 30, 2026.", date: "", time: "", repeat: "" });
    const facts = await rm.remindersFacts(orgId);
    expect(facts).toContain("The team in LeadDash EHR (4)");
    expect(facts).toContain("Dana Whitfield: LPC CO license expires Nov 30, 2026");
    expect(facts).toContain("Priya Shah (Intern, sees clients; no email on file)");
    expect(facts).toContain('"HIPAA training" to Dana Whitfield, Marcus Lee, Priya Shah and Dana Ortiz (draft, waiting for the person)');
  });
});
