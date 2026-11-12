import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as db from "./db";
import { ENV } from "./_core/env";

/**
 * The Group Partner team called from LeadDash EHR: the five employees, for a
 * practice administrator, in the practice's own workspace and no other.
 */

const SECRET = "test-link-secret-0123456789";
let server: http.Server;
let base = "";
beforeAll(async () => {
  (ENV as { ehrLinkSecret: string }).ehrLinkSecret = SECRET;
  const app = express();
  app.use(express.json());
  (await import("./ehrTeam")).registerEhrTeam(app);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  (await import("./ehrTeam")).setSenderForTests(null);
  server.close();
});

const A = { loc: "locAAAAteam000000001", practice: "Maple Crest Counseling", tz: "America/Chicago" };
const B = { loc: "locBBBBteam000000002", practice: "Cedar Row Therapy", tz: "America/Chicago" };
const C = { loc: "locCCCCteam000000003", practice: "Aspen Field Counseling", tz: "America/Chicago" };
const admin = { email: "owner@maple-team.test", name: "Sarah Chen", role: "admin" };
const second = { email: "manager@maple-team.test", name: "Priya Shah", role: "admin" };
const staff = { email: "front@maple-team.test", name: "Dana Ruiz", role: "front_desk" };
const other = { email: "owner@cedar-team.test", name: "Jordan Ellis", role: "admin" };

async function ask(practice: typeof A, user: typeof admin, name: string, body: unknown = {}, secret = SECRET) {
  const chat = await import("./ehrChat");
  const token = chat.signChatToken({ ...practice, scope: "all", user }, secret);
  const res = await fetch(`${base}/api/ehr-team/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-ehr-chat": token }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; result?: any; error?: string } };
}
const open = async (p: typeof A, user: typeof admin) => (await import("./ehrLink")).openFromEhr({ ...p, url: "https://api.health.leaddash.io", key: "ldemp_test_key", user, iat: 0, exp: 0 });

describe("The Group Partner team called from LeadDash EHR", () => {
  it("refuses a call with no token or a forged one", async () => {
    const none = await fetch(`${base}/api/ehr-team/team`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
    expect((await ask(A, admin, "team", {}, "another-secret")).status).toBe(401);
  });

  it("says the team is not turned on where the practice has no workspace or only Team chat, and makes nothing", async () => {
    const r = await ask(C, admin, "team");
    expect(r.status).toBe(412);
    expect(r.json.error).toContain("not turned on");
    expect(await db.getOrganizationByEhrLocation(C.loc)).toBeNull();
    // A Team chat only workspace: still not on, and still no employees in it.
    const chat = await import("./ehrChat");
    await chat.seat({ ...C, use: "chat", scope: "all", user: admin, iat: 0, exp: 0 });
    expect((await ask(C, admin, "team")).status).toBe(412);
    expect(await db.listAllEmployeesByOrg((await db.getOrganizationByEhrLocation(C.loc))!.id)).toHaveLength(0);
  });

  it("is for practice administrators only", async () => {
    await open(A, admin);
    const r = await ask(A, staff, "team");
    expect(r.status).toBe(403);
  });

  it("lists the five, in order, and nobody else in the workspace", async () => {
    const r = await ask(A, admin, "team");
    expect(r.status).toBe(200);
    expect(r.json.result.team.map((e: any) => e.name)).toEqual(["Harper", "Avery", "Malik", "Camille", "Quinn"]);
    expect(r.json.result.team[0].area).toBe("Billing and collections");
    expect(r.json.result.team.every((e: any) => typeof e.avatar === "string" && e.avatar.length > 0)).toBe(true);
    const org = (await db.getOrganizationByEhrLocation(A.loc))!;
    expect((await db.listAllEmployeesByOrg(org.id)).length).toBeGreaterThan(5);
  });

  it("refuses an employee outside the five, and one from another practice", async () => {
    const org = (await db.getOrganizationByEhrLocation(A.loc))!;
    const outside = (await db.listAllEmployeesByOrg(org.id)).find((e) => !["billing", "inbox", "leads", "compliance", "hiring"].includes(e.kind))!;
    expect((await ask(A, admin, "messages", { employeeId: outside.id })).status).toBe(404);
    expect((await ask(A, admin, "send", { employeeId: outside.id, text: "hello" })).status).toBe(404);
    await open(B, other);
    const harperA = (await ask(A, admin, "team")).json.result.team[0];
    // Another practice's administrator names Maple Crest's Harper: not found in their own workspace.
    expect((await ask(B, other, "messages", { employeeId: harperA.id })).status).toBe(404);
    expect((await ask(B, other, "send", { employeeId: harperA.id, text: "hello" })).status).toBe(404);
  });

  it("brings an employee onto the team, sends a message and reads the reply, in the sender's own name", async () => {
    const team = await import("./ehrTeam");
    const said: { org: number; emp: number; text: string; author: string }[] = [];
    team.setSenderForTests(async (o) => {
      said.push({ org: o.organizationId, emp: o.employeeId, text: o.text, author: o.authorName });
      await db.createChatMessage({ organizationId: o.organizationId, employeeId: o.employeeId, role: "user", authorName: o.authorName, userId: o.userId, threadUserId: o.userId, content: o.text });
      await db.createChatMessage({ organizationId: o.organizationId, employeeId: o.employeeId, role: "employee", authorName: "Harper", userId: null, threadUserId: o.userId, content: "Three claims are past 45 days.", cards: JSON.stringify([{ type: "report", title: "Unpaid claims by payer" }, { type: "choices", title: "ignored" }]) });
    });
    const harper = (await ask(A, admin, "team")).json.result.team[0];
    if (!harper.onTeam) {
      expect((await ask(A, admin, "send", { employeeId: harper.id, text: "hello" })).status).toBe(412);
      expect((await ask(A, admin, "bringOn", { employeeId: harper.id })).status).toBe(200);
    }
    expect((await ask(A, admin, "team")).json.result.team[0].onTeam).toBe(true);
    expect((await ask(A, admin, "send", { employeeId: harper.id, text: "   " })).status).toBe(400);
    const sent = await ask(A, admin, "send", { employeeId: harper.id, text: "What is stuck this week?", organizationId: 999, userId: 999 });
    expect(sent.status).toBe(200);
    expect(sent.json.result.answered).toBe(true);
    const org = (await db.getOrganizationByEhrLocation(A.loc))!;
    expect(said[said.length - 1]).toMatchObject({ org: org.id, emp: harper.id, author: "Sarah Chen" });
    const read = await ask(A, admin, "messages", { employeeId: harper.id });
    const tail = read.json.result.messages.slice(-2);
    expect(tail[0]).toMatchObject({ from: "person", mine: true, text: "What is stuck this week?" });
    expect(tail[1]).toMatchObject({ from: "employee", author: "Harper", cards: ["Unpaid claims by payer"] });
  });

  it("someone who administers the practice in the EHR but whom the workspace's owner seated as a team member reads only their own conversation", async () => {
    const harper = (await ask(A, admin, "team")).json.result.team[0];
    // The owner gave this person a team member's seat in the workspace; a workspace with the employees keeps the roles its owner set.
    const org = (await db.getOrganizationByEhrLocation(A.loc))!;
    const u = (await db.getUserByEmail(second.email)) ?? (await db.createUser({ email: second.email, role: "user", name: second.name }));
    await db.addOrganizationMember({ organizationId: org.id, userId: u.id, role: "member", title: "Manager" });
    const r = await ask(A, second, "messages", { employeeId: harper.id });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json.result.messages)).not.toContain("What is stuck this week?");
  });

  it("a slow employee does not hold the answer: the send says the reply is still coming", async () => {
    const team = await import("./ehrTeam");
    team.setSenderForTests(() => new Promise((r) => setTimeout(r, 30_000)));
    const harper = (await ask(A, admin, "team")).json.result.team[0];
    const started = Date.now();
    const sent = await ask(A, admin, "send", { employeeId: harper.id, text: "Run the full report." });
    expect(sent.status).toBe(200);
    expect(sent.json.result.answered).toBe(false);
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 20_000);

  it("refuses a request it does not know", async () => {
    expect((await ask(A, admin, "terminate", { employeeId: 1 })).status).toBe(404);
  });
});
