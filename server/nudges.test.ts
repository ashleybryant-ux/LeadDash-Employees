import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as db from "./db";
import { ENV } from "./_core/env";
import * as nudges from "./nudges";

/**
 * A reminder an employee sent reaches the person inside LeadDash EHR: they
 * read it, press Completed, and the employee checks LeadDash EHR before she
 * tells the administrator. A person sees only their own; a practice sees
 * only its own.
 */

const SECRET = "test-link-secret-0123456789";
let server: http.Server;
let base = "";
const realWork = nudges.tools.work;
let work: { unsignedNotes: number; oldestUnsigned: string | null; plansDue: number } | null = { unsignedNotes: 12, oldestUnsigned: "2026-10-28", plansDue: 0 };
beforeAll(async () => {
  (ENV as { ehrLinkSecret: string }).ehrLinkSecret = SECRET;
  nudges.tools.work = async () => work;
  const app = express();
  app.use(express.json());
  (await import("./ehrTeam")).registerEhrTeam(app);
  nudges.registerNudges(app);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  nudges.tools.work = realWork;
  server.close();
});

const A = { loc: "locAAAAnudge00000001", practice: "Maple Crest Counseling", tz: "America/Chicago" };
const B = { loc: "locBBBBnudge00000002", practice: "Cedar Row Therapy", tz: "America/Chicago" };
const admin = { email: "owner@maple-nudge.test", name: "Sarah Chen", role: "admin" };
const otherAdmin = { email: "owner@cedar-nudge.test", name: "Jordan Ellis", role: "admin" };
const dana = { id: "u-dana", ids: ["u-dana", "u-dana-2"], email: "dana@maple-nudge.test", name: "Dana Ruiz", role: "staff" };
const marcus = { id: "u-marcus", email: "marcus@maple-nudge.test", name: "Marcus Lee", role: "staff" };

async function call(path: "ehr-team" | "ehr-nudge", practice: typeof A, user: Record<string, unknown>, name: string, body: unknown = {}) {
  const chat = await import("./ehrChat");
  const token = chat.signChatToken({ ...practice, scope: "all", user } as never, SECRET);
  const res = await fetch(`${base}/api/${path}/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-ehr-chat": token }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; result?: any; error?: string } };
}
const open = async (p: typeof A, user: typeof admin) => (await import("./ehrLink")).openFromEhr({ ...p, url: "https://api.health.leaddash.io", key: "ldemp_test_key", user, iat: 0, exp: 0 });

describe("An employee's reminder inside LeadDash EHR", () => {
  it("works out what can be checked from the reminder's own words", () => {
    expect(nudges.kindOf("Notes to sign", "You have 12 unsigned notes.")).toBe("notes");
    expect(nudges.kindOf("Treatment plans", "3 treatment plans are due for review.")).toBe("plans");
    expect(nudges.kindOf("License", "Your license renewal is coming up.")).toBe("other");
  });

  it("says what the check found, and never claims a check it could not make", () => {
    const base = { staffName: "Dana Ruiz", baseline: JSON.stringify({ unsignedNotes: 12 }) };
    expect(nudges.judge({ ...base, kind: "notes" }, { unsignedNotes: 0, oldestUnsigned: null, plansDue: 0 })).toEqual({ ok: true, found: "I checked LeadDash EHR: all 12 are signed. Nothing else is waiting on them." });
    const not = nudges.judge({ ...base, kind: "notes" }, { unsignedNotes: 5, oldestUnsigned: "2026-10-28", plansDue: 0 });
    expect(not.ok).toBe(false);
    expect(not.found).toBe("LeadDash EHR still shows 5 of the 12 unsigned. The oldest is from Oct 28, 2026.");
    expect(nudges.judge({ ...base, kind: "notes" }, null).ok).toBeNull();
    expect(nudges.judge({ ...base, kind: "other" }, { unsignedNotes: 0, oldestUnsigned: null, plansDue: 0 }).ok).toBeNull();
  });

  it("reaches the person, is theirs alone, and is checked before the administrator hears it is done", async () => {
    await open(A, admin);
    await open(B, otherAdmin);
    const team = (await call("ehr-team", A, admin, "team")).json.result.team as { id: number; kind: string; name: string }[];
    const camilleA = team.find((e) => e.kind === "compliance")!;
    const orgA = (await db.getOrganizationByEhrLocation(A.loc))!.id;
    const emp = (await db.getEmployeeForOrg(camilleA.id, orgA))!;

    // Nothing yet: an empty answer, not an error.
    expect((await call("ehr-nudge", A, dana, "mine")).json.result).toEqual({ open: [], threads: [] });

    work = { unsignedNotes: 12, oldestUnsigned: "2026-10-28", plansDue: 0 };
    // Sent to Dana's second staff record: the same person, so it reaches her.
    const [n] = await nudges.deliver(orgA, emp, { id: 1, subject: "Notes to sign", body: "Hi Dana, you have 12 unsigned notes. The oldest is from Oct 28, 2026. Camille" }, [{ id: "u-dana-2", name: "Dana Ruiz" }]);
    expect(n.kind).toBe("notes");

    const mine = (await call("ehr-nudge", A, dana, "mine")).json.result;
    expect(mine.open).toHaveLength(1);
    expect(mine.open[0]).toMatchObject({ id: n.id, subject: "Notes to sign", kind: "notes" });
    expect(mine.open[0].employee.name).toBe(camilleA.name);
    expect(mine.threads).toHaveLength(1);
    expect(mine.threads[0]).toMatchObject({ employeeId: camilleA.id, open: 1, unread: 1 });

    // Another team member, and another practice, see nothing of it and cannot act on it.
    expect((await call("ehr-nudge", A, marcus, "mine")).json.result).toEqual({ open: [], threads: [] });
    expect((await call("ehr-nudge", A, marcus, "thread", { employeeId: camilleA.id })).status).toBe(404);
    expect((await call("ehr-nudge", A, marcus, "done", { nudgeId: n.id })).status).toBe(404);
    expect((await call("ehr-nudge", A, marcus, "seen", { nudgeId: n.id })).status).toBe(404);
    expect((await call("ehr-nudge", B, { ...dana }, "mine")).json.result).toEqual({ open: [], threads: [] });
    expect((await call("ehr-nudge", B, { ...dana }, "done", { nudgeId: n.id })).status).toBe(404);
    expect(db.nudges.get(orgA, n.id)!.status).toBe("sent");
    // A token that names nobody is refused.
    expect((await call("ehr-nudge", A, { email: "x@maple-nudge.test", role: "staff" }, "mine")).status).toBe(400);

    // The administrator sees it has not been read.
    let board = (await call("ehr-team", A, admin, "nudges")).json.result.reminders;
    expect(board[0]).toMatchObject({ to: "Dana Ruiz", words: "Not read yet", from: camilleA.name });

    // She opens the conversation: read.
    const thread = (await call("ehr-nudge", A, dana, "thread", { employeeId: camilleA.id })).json.result;
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ from: "employee", nudgeId: n.id, kind: "notes" });
    expect(db.nudges.get(orgA, n.id)!.status).toBe("read");

    // She writes back: kept, acknowledged without the AI, and passed to the administrator.
    expect((await call("ehr-nudge", A, dana, "say", { employeeId: camilleA.id, text: "I will finish them tonight." })).json.ok).toBe(true);
    let adminChat = (await call("ehr-team", A, admin, "messages", { employeeId: camilleA.id })).json.result.messages as { text: string; choices: string[]; standing: string[] }[];
    expect(adminChat[adminChat.length - 1].text).toBe('Dana Ruiz answered my reminder: "I will finish them tonight."');

    // She presses Completed, but 5 are still unsigned: the administrator is told both, with a choice.
    work = { unsignedNotes: 5, oldestUnsigned: "2026-11-02", plansDue: 0 };
    expect((await call("ehr-nudge", A, dana, "done", { nudgeId: n.id })).json.result).toMatchObject({ ok: true, status: "not_done" });
    adminChat = (await call("ehr-team", A, admin, "messages", { employeeId: camilleA.id })).json.result.messages;
    const last = adminChat[adminChat.length - 1];
    expect(last.text).toBe("Dana Ruiz marked their notes completed, but LeadDash EHR still shows 5 of the 12 unsigned. The oldest is from Nov 2, 2026.");
    expect(last.choices).toEqual(["Remind Dana again", "Leave it"]);
    expect(last.standing).toMatchObject([{ words: "Checked, not complete", bad: true }]);
    // Gone for her once she pressed Completed; the conversation stays.
    const after = (await call("ehr-nudge", A, dana, "mine")).json.result;
    expect(after.open).toEqual([]);
    expect(after.threads[0]).toMatchObject({ open: 0, unread: 0 });
    expect((await call("ehr-nudge", A, dana, "done", { nudgeId: n.id })).json.result).toMatchObject({ already: true });
    board = (await call("ehr-team", A, admin, "nudges")).json.result.reminders;
    expect(board[0]).toMatchObject({ words: "Said completed, not complete", bad: true });

    // A second reminder, and this time the notes really are signed.
    work = { unsignedNotes: 5, oldestUnsigned: "2026-11-02", plansDue: 0 };
    const [n2] = await nudges.deliver(orgA, emp, { id: 2, subject: "Notes to sign", body: "Hi Dana, 5 notes are still unsigned. Camille" }, [{ id: "u-dana", name: "Dana Ruiz" }]);
    work = { unsignedNotes: 0, oldestUnsigned: null, plansDue: 0 };
    expect((await call("ehr-nudge", A, dana, "done", { nudgeId: n2.id })).json.result).toMatchObject({ status: "verified" });
    adminChat = (await call("ehr-team", A, admin, "messages", { employeeId: camilleA.id })).json.result.messages;
    expect(adminChat[adminChat.length - 1].text).toBe("Dana Ruiz marked their notes completed. I checked LeadDash EHR: all 5 are signed. Nothing else is waiting on them.");
    expect(adminChat[adminChat.length - 1].choices).toEqual([]);
    expect(adminChat[adminChat.length - 1].standing).toMatchObject([{ who: "Dana", words: "Checked", bad: false }]);

    // Something LeadDash EHR cannot confirm is reported as her word only.
    const [n3] = await nudges.deliver(orgA, emp, { id: 3, subject: "License renewal", body: "Hi Dana, your license renewal is coming up. Camille" }, [{ id: "u-dana", name: "Dana Ruiz" }]);
    expect((await call("ehr-nudge", A, dana, "done", { nudgeId: n3.id })).json.result).toMatchObject({ status: "unverifiable" });
    adminChat = (await call("ehr-team", A, admin, "messages", { employeeId: camilleA.id })).json.result.messages;
    expect(adminChat[adminChat.length - 1].text).toBe('Dana Ruiz marked "License renewal" completed. This is not something I can check in LeadDash EHR.');

    // The other practice's administrator sees none of it.
    expect((await call("ehr-team", B, otherAdmin, "nudges")).json.result.reminders).toEqual([]);
    // A team member who is not an administrator cannot read the list.
    expect((await call("ehr-team", A, { ...dana, role: "staff" }, "nudges")).status).toBe(403);
  });
});
