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

async function ask(practice: typeof A, user: typeof admin, name: string, body: unknown = {}, secret = SECRET) {
  const chat = await import("./ehrChat");
  const token = chat.signChatToken({ ...practice, user }, secret);
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
});
