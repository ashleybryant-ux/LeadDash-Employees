import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as db from "./db";
import { ENV } from "./_core/env";

/**
 * Team chat for LeadDash EHR: the EHR's server calls for a person with a
 * token it signed. The workspace is the one the token's practice names.
 */

const SECRET = "test-link-secret-0123456789";
let server: http.Server;
let base = "";
beforeAll(async () => {
  (ENV as { ehrLinkSecret: string }).ehrLinkSecret = SECRET;
  const app = express();
  app.use(express.json());
  (await import("./ehrChat")).registerEhrChat(app);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const A = { loc: "locAAAAchat000000001", practice: "Maple Crest Counseling", tz: "America/Chicago" };
const B = { loc: "locBBBBchat000000002", practice: "Cedar Row Therapy", tz: "America/Chicago" };
const admin = { email: "owner@maple-chat.test", name: "Sarah Chen", role: "admin" };
const staff = { email: "front@maple-chat.test", name: "Dana Ruiz", role: "front_desk" };
const other = { email: "owner@cedar-chat.test", name: "Jordan Ellis", role: "admin" };

async function ask(practice: typeof A, user: typeof admin, name: string, body: unknown = {}, secret = SECRET, scope: "all" | "admins" = "all") {
  const chat = await import("./ehrChat");
  const token = chat.signChatToken({ ...practice, scope, user }, secret);
  const res = await fetch(`${base}/api/ehr-chat/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-ehr-chat": token }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; result?: any; error?: string } };
}

describe("Team chat called from LeadDash EHR", () => {
  it("refuses a call with no token, a forged one, an expired one, or the Open pass", async () => {
    const chat = await import("./ehrChat");
    const none = await fetch(`${base}/api/ehr-chat/channels`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
    expect((await ask(A, admin, "channels", {}, "another-secret")).status).toBe(401);
    expect(chat.readChatToken(chat.signChatToken({ ...A, user: admin }, SECRET, -10))).toMatchObject({ error: expect.stringContaining("expired") });
    // The pass that opens LeadDash Employees is not a Team chat token.
    const pass = (await import("./ehrLink")).signPass({ ...A, url: "https://api.health.leaddash.io", key: "k", user: admin }, SECRET);
    expect(chat.readChatToken(pass)).toMatchObject({ error: expect.stringContaining("not a LeadDash EHR Team chat token") });
    expect(await db.getOrganizationByEhrLocation(A.loc)).toBeNull();
  });

  it("makes a team chat only workspace with no AI employees, and seats people by their EHR role", async () => {
    const first = await ask(A, admin, "channels");
    expect(first.status).toBe(200);
    expect(first.json.result.channels.map((c: any) => c.key)).toContain("everyone");
    const org = (await db.getOrganizationByEhrLocation(A.loc))!;
    expect(org.chatOnly).toBe(true);
    expect(org.quiet).toBe(true);
    expect(await db.listAllEmployeesByOrg(org.id)).toHaveLength(0);
    // The roster pass that runs at every start leaves it alone.
    expect(await (await import("./employees/roster-sync")).ensureRoster(org.id)).toBe(0);
    expect(await db.listAllEmployeesByOrg(org.id)).toHaveLength(0);

    await ask(A, staff, "channels");
    const roles = Object.fromEntries((await db.listMembers(org.id)).map((m) => [m.email, m.role]));
    expect(roles[admin.email]).toBe("owner");
    expect(roles[staff.email]).toBe("chat");
  });

  it("carries a message between two people at the practice, with a thread and a reaction", async () => {
    const sent = await ask(A, admin, "send", { channel: "everyone", content: "Room 3 projector is fixed." });
    expect(sent.status).toBe(200);
    const seen = await ask(A, staff, "messages", { channel: "everyone" });
    const text = JSON.stringify(seen.json.result);
    expect(text).toContain("Room 3 projector is fixed.");
    const id = sent.json.result.id;
    expect((await ask(A, staff, "send", { channel: "everyone", content: "Thank you.", threadOf: id })).status).toBe(200);
    expect((await ask(A, staff, "react", { messageId: id, emoji: "👍" })).status).toBe(200);
    expect(JSON.stringify((await ask(A, admin, "thread", { messageId: id })).json.result)).toContain("Thank you.");
    // A direct message is between the two of them.
    const people = (await ask(A, admin, "people")).json.result as { userId: number; name: string }[];
    const me = (await ask(A, admin, "me")).json.result.userId as number;
    const dana = people.find((p) => p.name === "Dana Ruiz")!;
    const dm = `dm:${Math.min(me, dana.userId)}-${Math.max(me, dana.userId)}`;
    expect((await ask(A, admin, "send", { channel: dm, content: "Can you cover the desk at 4:00?" })).status).toBe(200);
    expect(JSON.stringify((await ask(A, staff, "messages", { channel: dm })).json.result)).toContain("cover the desk");
  });

  it("keeps one practice's chat out of another's", async () => {
    const mine = await ask(B, other, "messages", { channel: "everyone" });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.json.result)).not.toContain("Room 3 projector");
    const a = (await db.getOrganizationByEhrLocation(A.loc))!;
    const b = (await db.getOrganizationByEhrLocation(B.loc))!;
    expect(a.id).not.toBe(b.id);
    // A body that names another workspace changes nothing: the token's practice is the workspace.
    const tried = await ask(B, other, "messages", { channel: "everyone", organizationId: a.id });
    expect(JSON.stringify(tried.json.result)).not.toContain("Room 3 projector");
    // Someone at the other practice cannot read a direct message between two people here.
    const people = (await ask(A, admin, "people")).json.result as { userId: number; name: string }[];
    const ids = people.map((p) => p.userId).sort((x, y) => x - y);
    const peek = await ask(B, other, "messages", { channel: `dm:${ids[0]}-${ids[1]}` });
    expect(JSON.stringify(peek.json)).not.toContain("cover the desk");
    expect((await ask(B, other, "people")).json.result.map((p: any) => p.name)).toEqual(["Jordan Ellis"]);
  });

  it("administrators only: channels are for everyone, and a team member direct messages administrators and nobody else", async () => {
    const C = { loc: "locCCCCchat000000003", practice: "Birch Lane Counseling", tz: "America/Chicago" };
    const boss = { email: "owner@birch-chat.test", name: "Riley Stone", role: "admin" };
    const one = { email: "one@birch-chat.test", name: "Casey Park", role: "staff" };
    const two = { email: "two@birch-chat.test", name: "Morgan Diaz", role: "staff" };
    const lim = (u: typeof boss, name: string, body: unknown = {}) => ask(C, u, name, body, SECRET, "admins");
    // Everyone is seated; a token with no scope at all is treated the same as "admins".
    const bossId = (await lim(boss, "me")).json.result.userId as number;
    const oneId = (await lim(one, "me")).json.result.userId as number;
    const twoId = (await lim(two, "me")).json.result.userId as number;
    const chat = await import("./ehrChat");
    const bare = chat.signChatToken({ ...C, user: one }, SECRET);
    const noScope = await fetch(`${base}/api/ehr-chat/channels`, { method: "POST", headers: { "content-type": "application/json", "x-ehr-chat": bare }, body: "{}" });
    expect(((await noScope.json()) as any).result.scope).toBe("admins");

    const dm = (a: number, b: number) => `dm:${Math.min(a, b)}-${Math.max(a, b)}`;
    // A team member sees the channels, and for direct messages the administrator only.
    const mine = (await lim(one, "channels")).json.result;
    expect(mine.channels.map((c: any) => c.name)).toEqual(["general"]);
    expect(mine.scope).toBe("admins");
    expect(mine.dms.map((d: any) => d.name)).toEqual(["Riley Stone"]);
    expect((await lim(one, "people")).json.result.map((p: any) => p.name).sort()).toEqual(["Casey Park", "Riley Stone"]);
    // The administrator sees everyone.
    expect((await lim(boss, "channels")).json.result.dms.map((d: any) => d.name).sort()).toEqual(["Casey Park", "Morgan Diaz"]);

    // Team member to administrator, and back: allowed.
    const sent = await lim(one, "send", { channel: dm(oneId, bossId), content: "Can I move my 3:00 PM?" });
    expect(sent.status).toBe(200);
    expect(JSON.stringify((await lim(boss, "messages", { channel: dm(oneId, bossId) })).json.result)).toContain("move my 3:00 PM");
    expect((await lim(boss, "send", { channel: dm(oneId, bossId), content: "Yes.", threadOf: sent.json.result.id })).status).toBe(200);
    expect((await lim(one, "react", { messageId: sent.json.result.id, emoji: "👍" })).status).toBe(200);

    // Team member to team member: refused, whatever the screen sends.
    for (const [name, body] of [
      ["send", { channel: dm(oneId, twoId), content: "hi" }],
      ["messages", { channel: dm(oneId, twoId) }],
      ["details", { channel: dm(oneId, twoId) }],
      ["muteDm", { channel: dm(oneId, twoId), muted: true }],
      ["createChannel", { name: "side", private: true, memberIds: [twoId] }],
      ["search", { q: "move" }],
    ] as const) {
      const r = await lim(one, name, body);
      expect(r.status, name).toBe(403);
      expect(r.json.error).toContain("administrators only");
    }
    // Channels are for everyone: a team member reads and writes in # general, and so does the other team member.
    const hello = await lim(one, "send", { channel: "everyone", content: "Good morning all" });
    expect(hello.status).toBe(200);
    expect(JSON.stringify((await lim(two, "messages", { channel: "everyone" })).json.result)).toContain("Good morning all");
    expect((await lim(two, "react", { messageId: hello.json.result.id, emoji: "👋" })).status).toBe(200);
    // An administrator sets up a channel and adds people; a team member cannot add anyone to it.
    const made = await lim(boss, "createChannel", { name: "front desk", private: true, memberIds: [oneId] });
    expect(made.status).toBe(200);
    expect((await lim(one, "addMembers", { channelId: made.json.result.id, userIds: [twoId] })).status).toBe(403);
    expect((await lim(one, "channels")).json.result.channels.map((c: any) => c.name).sort()).toEqual(["front-desk", "general"].sort());
    // A private channel stays closed to someone who is not in it.
    expect((await lim(two, "channels")).json.result.channels.map((c: any) => c.name)).toEqual(["general"]);
    expect((await lim(two, "messages", { channel: made.json.result.key })).status).toBe(404);
    // Someone else's conversation with the administrator cannot be read or reacted to by its message id.
    expect((await lim(two, "thread", { messageId: sent.json.result.id })).status).toBe(403);
    expect((await lim(two, "react", { messageId: sent.json.result.id, emoji: "👀" })).status).toBe(403);
    // The administrator posts in # general too.
    expect((await lim(boss, "send", { channel: "everyone", content: "hello" })).status).toBe(200);

    // Opened to the whole team: channels and team member to team member work.
    expect((await ask(C, one, "send", { channel: dm(oneId, twoId), content: "Lunch?" })).status).toBe(200);
    expect((await ask(C, one, "send", { channel: "everyone", content: "Morning." })).status).toBe(200);
    expect((await ask(C, two, "channels")).json.result.scope).toBe("all");

    // The EHR is the record of who administers: a team member made an administrator there is one here.
    await lim({ ...two, role: "admin" }, "me");
    const org = (await db.getOrganizationByEhrLocation(C.loc))!;
    expect((await db.getOrganizationMembership(org.id, twoId))?.role).toBe("admin");
    expect((await lim(one, "channels")).json.result.dms.map((d: any) => d.name).sort()).toEqual(["Morgan Diaz", "Riley Stone"]);
    await lim(two, "me");
    expect((await db.getOrganizationMembership(org.id, twoId))?.role).toBe("chat");
  });

  it("refuses a request it does not know", async () => {
    expect((await ask(A, admin, "slackImport")).status).toBe(404);
  });

  it("opening LeadDash Employees later keeps the channels and brings the employees in", async () => {
    const link = await import("./ehrLink");
    const { org } = await link.openFromEhr({ ...A, url: "https://api.health.leaddash.io", key: "ldemp_test_key", user: admin, iat: 0, exp: 0 });
    expect(org.chatOnly).toBe(false);
    expect((await db.listAllEmployeesByOrg(org.id)).length).toBeGreaterThan(0);
    expect(JSON.stringify((await ask(A, staff, "messages", { channel: "everyone" })).json.result)).toContain("Room 3 projector is fixed.");
  });
  it("a send answers with who should hear about it and the start of the message, and leaves out a muted or on-screen conversation", async () => {
    const D = { loc: "locDDDDchat000000004", practice: "Aspen Field Counseling", tz: "America/Chicago" };
    const boss = { email: "owner@aspen-chat.test", name: "Avery Holt", role: "admin" };
    const one = { email: "one@aspen-chat.test", name: "Quinn Marsh", role: "staff" };
    const two = { email: "two@aspen-chat.test", name: "Devon Reyes", role: "staff" };
    const bossId = (await ask(D, boss, "me")).json.result.userId as number;
    const oneId = (await ask(D, one, "me")).json.result.userId as number;
    await ask(D, two, "me");
    const key = `dm:${Math.min(oneId, bossId)}-${Math.max(oneId, bossId)}`;

    // A direct message: the other person only, by email, with a count and the start of the message.
    const first = (await ask(D, one, "send", { channel: key, content: "Zebra crossing at noon" })).json.result;
    expect(first.notices).toEqual([{ email: boss.email, kind: "dm", from: "Quinn Marsh", channel: "", key, unread: 1, text: "Zebra crossing at noon" }]);
    const second = (await ask(D, one, "send", { channel: key, content: "And again " + "x".repeat(400) })).json.result;
    expect(second.notices[0].unread).toBe(2);
    expect(second.notices[0].text.length).toBe(200);
    // The third person, who is not in this conversation, is not on the list.
    expect(second.notices.map((n: any) => n.email)).toEqual([boss.email]);

    // A channel: everyone but the sender.
    const all = (await ask(D, boss, "send", { channel: "everyone", content: "Staff meeting moved" })).json.result;
    expect(all.notices.map((n: any) => n.email).sort()).toEqual([one.email, two.email]);
    expect(all.notices[0].kind).toBe("channel");
    expect(all.notices[0].channel).toBe("general");

    // The administrator has the conversation open on screen: no notice for it.
    await ask(D, boss, "messages", { channel: key });
    expect((await ask(D, one, "send", { channel: key, content: "Still there?" })).json.result.notices).toEqual([]);
    // They look at something else: notices come back.
    await ask(D, boss, "messages", { channel: "everyone" });
    expect((await ask(D, one, "send", { channel: key, content: "One more" })).json.result.notices.length).toBe(1);

    // Muted by the administrator: the message arrives, no notice, and the list says Muted.
    expect((await ask(D, boss, "muteDm", { channel: key, muted: true })).json.result).toEqual({ channel: key, muted: true });
    expect((await ask(D, one, "send", { channel: key, content: "Quiet one" })).json.result.notices).toEqual([]);
    const rows = (await ask(D, boss, "channels")).json.result;
    expect(rows.dms.find((d: any) => d.key === key).muted).toBe(true);
    expect((await ask(D, boss, "messages", { channel: "everyone" })).status).toBe(200);
    // Only their own mute: the sender's side is not muted.
    expect((await ask(D, one, "channels")).json.result.dms.find((d: any) => d.key === key).muted).toBe(false);
    await ask(D, boss, "muteDm", { channel: key, muted: false });
    expect((await ask(D, one, "send", { channel: key, content: "Loud one" })).json.result.notices.length).toBe(1);

    // Administrators only: a team member cannot mute a conversation that is not theirs with an administrator.
    const twoId = (await ask(D, two, "me")).json.result.userId as number;
    const side = `dm:${Math.min(oneId, twoId)}-${Math.max(oneId, twoId)}`;
    expect((await ask(D, one, "muteDm", { channel: side, muted: true }, SECRET, "admins")).status).toBe(403);
    // A channel is muted from the channel.
    expect((await ask(D, one, "muteDm", { channel: "everyone", muted: true })).status).toBe(400);
  });
  it("lists the practice's whole team from the EHR's signed list, before anyone else has opened Team chat", async () => {
    const E = { loc: "locEEEEchat000000005", practice: "Juniper Way Counseling", tz: "America/Chicago" };
    const F = { loc: "locFFFFchat000000006", practice: "Willow Bend Therapy", tz: "America/Chicago" };
    const boss = { email: "owner@juniper-chat.test", name: "Harper Lane", role: "admin" };
    const chat = await import("./ehrChat");
    const team = [
      { email: boss.email, name: "Harper Lane", admin: true },
      { email: "Kai@Juniper-chat.test", name: "Kai Monroe", admin: false },
      { email: "sage@juniper-chat.test", name: "Sage Ortiz", admin: true },
    ];
    const names = async (u: typeof boss, scope: "all" | "admins" = "all") => ((await ask(E, u, "channels", {}, SECRET, scope)).json.result.dms as any[]).map((d) => d.name).sort();

    // Alone at first.
    expect(await names(boss)).toEqual([]);
    // A list signed with another secret, one for another practice, or a plain array from a browser: ignored.
    await ask(E, boss, "channels", { roster: chat.signRosterToken(E.loc, team, "some-other-secret-000000000") });
    await ask(E, boss, "channels", { roster: chat.signRosterToken(F.loc, team, SECRET) });
    await ask(E, boss, "channels", { roster: team });
    expect(await names(boss)).toEqual([]);
    // The EHR's own list for this practice: everyone is there, though only one person has ever opened Team chat.
    await ask(E, boss, "channels", { roster: chat.signRosterToken(E.loc, team, SECRET) });
    expect(await names(boss)).toEqual(["Kai Monroe", "Sage Ortiz"]);
    // Administrators only: a team member sees the administrators, including the one who has never signed in.
    const kai = { email: "kai@juniper-chat.test", name: "Kai Monroe", role: "staff" };
    expect(await names(kai, "admins")).toEqual(["Harper Lane", "Sage Ortiz"]);
    // Nobody landed in another practice.
    expect(((await ask(F, { email: "owner@willow-chat.test", name: "Remy Vale", role: "admin" }, "channels")).json.result.dms as any[]).length).toBe(0);

    // Who is who, for the EHR to add pictures: everyone for an administrator, administrators and self for a team member.
    const dir = (await ask(E, boss, "directory")).json.result as any[];
    expect(dir.map((d) => d.email).sort()).toEqual(["kai@juniper-chat.test", boss.email, "sage@juniper-chat.test"].sort());
    expect(((await ask(E, kai, "directory", {}, SECRET, "admins")).json.result as any[]).map((d) => d.email).sort()).toEqual(["kai@juniper-chat.test", boss.email, "sage@juniper-chat.test"].sort());

    // Someone leaves the practice: they are off the list. Someone made a team member is no longer an administrator.
    const smaller = [team[0], { ...team[2], admin: false }];
    await ask(E, boss, "channels", { roster: chat.signRosterToken(E.loc, smaller, SECRET) });
    expect(await names(boss)).toEqual(["Sage Ortiz"]);
    const org = (await db.getOrganizationByEhrLocation(E.loc))!;
    expect((await db.listMembers(org.id)).find((m) => m.email === "sage@juniper-chat.test")!.role).toBe("chat");
    // A list that does not hold the person asking takes nobody away.
    await ask(E, boss, "channels", { roster: chat.signRosterToken(E.loc, [{ email: "new@juniper-chat.test", name: "Noel Park", admin: false }], SECRET) });
    expect(await names(boss)).toEqual(["Noel Park", "Sage Ortiz"]);
  });
});
