import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as db from "./db";
import { ENV } from "./_core/env";
import { caller, makeUser } from "./test/helpers";

/**
 * The door from LeadDash EHR: a practice opens LeadDash Employees with a pass
 * the EHR signed, and the EHR's agency screen sets portraits and voices for
 * every workspace with the same secret.
 */

const SECRET = "test-link-secret-0123456789";
let server: http.Server;
let base = "";
beforeAll(async () => {
  (ENV as { ehrLinkSecret: string }).ehrLinkSecret = SECRET;
  const app = express();
  app.use(express.json({ limit: "16mb" }));
  (await import("./ehrLink")).registerEhrLink(app);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const PRACTICE = { loc: "puLPmzfdCvfQRANPM2WA", practice: "Legacy Family Services, Inc", tz: "America/Chicago", url: "https://api.health.leaddash.io/", key: "ld-emp-0123456789abcdefghij" };

describe("Opening LeadDash Employees from LeadDash EHR", () => {
  it("refuses a pass that is not signed with the shared secret, or has expired", async () => {
    const link = await import("./ehrLink");
    const forged = link.signPass({ ...PRACTICE, user: { email: "x@legacy.test" } }, "another-secret");
    expect(link.readPass(forged)).toEqual({ error: "That link was not signed by LeadDash EHR." });
    const old = link.signPass({ ...PRACTICE, user: { email: "x@legacy.test" } }, SECRET, -10);
    expect("error" in link.readPass(old) && link.readPass(old)).toMatchObject({ error: expect.stringContaining("expired") });
    expect(link.readPass("nonsense")).toEqual({ error: "That link is not a LeadDash EHR pass." });
    const res = await fetch(`${base}/from-ehr?pass=${encodeURIComponent(forged)}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("was not signed by LeadDash EHR");
  });

  it("makes the practice's workspace on first open, connects the EHR, signs the person in, and opens the same workspace next time", async () => {
    const link = await import("./ehrLink");
    const pass = link.signPass({ ...PRACTICE, user: { email: "Ashley@Legacy.test", name: "Dr. Ashley Bryant", role: "admin" } });
    const first = await fetch(`${base}/from-ehr?pass=${encodeURIComponent(pass)}`, { redirect: "manual" });
    expect(first.status).toBe(302);
    const org = await db.getOrganizationByEhrLocation(PRACTICE.loc);
    expect(org).toMatchObject({ name: "Legacy Family Services, Inc", orgType: "healthcare", timezone: "America/Chicago" });
    expect(first.headers.get("location")).toBe(`/welcome?org=${org!.id}`);
    expect(first.headers.get("set-cookie")).toMatch(/session=/);
    // The owner is the administrator who opened it; the roster is on the team; the EHR is connected with the key the EHR minted.
    const ashley = (await db.getUserByEmail("ashley@legacy.test"))!;
    expect(ashley.name).toBe("Dr. Ashley Bryant");
    expect((await db.getOrganizationMembership(org!.id, ashley.id))?.role).toBe("owner");
    expect((await db.listEmployeesByOrg(org!.id)).some((e) => e.kind === "billing")).toBe(true);
    const ehr = await import("./ehr");
    const v = await ehr.view(org!.id);
    expect(v).toMatchObject({ connected: true, practice: "Legacy Family Services, Inc", url: "https://api.health.leaddash.io", viaEhr: true });

    // A biller opens it later: same workspace, as a member; the owner stays the owner.
    const again = link.signPass({ ...PRACTICE, user: { email: "angela@legacy.test", name: "Angela St. Ville", role: "biller" } });
    const second = await fetch(`${base}/from-ehr?pass=${encodeURIComponent(again)}`, { redirect: "manual" });
    expect(second.headers.get("location")).toBe(`/chats?org=${org!.id}`);
    const angela = (await db.getUserByEmail("angela@legacy.test"))!;
    expect((await db.getOrganizationMembership(org!.id, angela.id))?.role).toBe("member");
    expect(await db.getOrganizationByEhrLocation(PRACTICE.loc)).toMatchObject({ id: org!.id });
    expect((await db.listOrganizationsForUser(ashley.id)).length).toBe(1);
    // Integrations shows it came from the EHR, so nobody is asked for a key.
    expect((await caller(ashley).ehr.view({ organizationId: org!.id })).viaEhr).toBe(true);
  });

  it("lets the EHR's agency screen set a portrait and a voice for an employee in every workspace, with the shared secret only", async () => {
    const link = await import("./ehrLink");
    const noSecret = await fetch(`${base}/api/ehr-link/roster`);
    expect(noSecret.status).toBe(401);
    const headers = { "x-leaddash-link": SECRET, "content-type": "application/json" };
    const roster = (await (await fetch(`${base}/api/ehr-link/roster`, { headers })).json()) as { roster: { kind: string; name: string; avatarUrl: string | null; voiceId: string | null }[] };
    const harper = roster.roster.find((r) => r.kind === "billing")!;
    expect(harper).toMatchObject({ name: "Harper", avatarUrl: null, voiceId: null });

    // A one-pixel PNG as the portrait, and a voice from the account.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const put = await fetch(`${base}/api/ehr-link/roster/billing`, { method: "PUT", headers, body: JSON.stringify({ portrait: png, voiceId: "v_warm_1", voiceName: "Warm", by: "Ashley Bryant" }) });
    const saved = (await put.json()) as { ok: boolean; employee: { avatarUrl: string | null; voiceId: string | null; voiceName: string | null; updatedBy: string | null } };
    expect(saved.ok).toBe(true);
    expect(saved.employee.avatarUrl).toMatch(/\/files\/roster\/billing\/portrait-\d+_[a-f0-9]+\.png$/);
    expect(saved.employee).toMatchObject({ voiceId: "v_warm_1", voiceName: "Warm", updatedBy: "Ashley Bryant" });

    // Every workspace's Harper shows the chosen portrait unless that workspace uploaded its own, and speaks with the chosen voice.
    const org = (await db.getOrganizationByEhrLocation(PRACTICE.loc))!;
    const ashley = (await db.getUserByEmail("ashley@legacy.test"))!;
    const list = await caller(ashley).employees.list({ organizationId: org.id });
    expect(list.find((e) => e.kind === "billing")?.avatar).toBe(saved.employee.avatarUrl);
    expect(list.find((e) => e.kind === "inbox")?.avatar).toBeNull();
    const huddle = await import("./employees/huddle");
    expect(await huddle.elevenVoiceFor("billing")).toBe("v_warm_1");

    // Clearing the portrait goes back to the bundled one; an unknown employee is refused.
    const clear = await fetch(`${base}/api/ehr-link/roster/billing`, { method: "PUT", headers, body: JSON.stringify({ clearPortrait: true }) });
    expect(((await clear.json()) as { employee: { avatarUrl: string | null; voiceId: string | null } }).employee).toMatchObject({ avatarUrl: null, voiceId: "v_warm_1" });
    expect((await fetch(`${base}/api/ehr-link/roster/nobody`, { method: "PUT", headers, body: "{}" })).status).toBe(404);
    expect(link.roleFor("admin", false)).toBe("owner");
    expect(link.roleFor("front_desk", true)).toBe("member");
    vi.restoreAllMocks();
    await makeUser("unused@x.test");
  });
});
