import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
  return { ...actual, generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? { ...blank, reply: "Two grants are due this month." } : {})) };
});

import express from "express";
import type { Server } from "node:http";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { registerMcp } from "./mcp";

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerMcp(app);
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server?.close());

const rpc = (url: string, method: string, params: unknown = {}, id: number | null = 1) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) });

describe("the Claude and ChatGPT connector", () => {
  it("connects with the secret link, lists tools, saves to the Brain, searches it and messages an employee", async () => {
    const { orgId, owner } = await makeWorkspace("mcp");
    const c = caller(owner);
    const link = await c.account.connector({ organizationId: orgId });
    const path = new URL(link.url.replace(/^[^/]*\/\/[^/]*/, "http://x")).pathname;
    const url = `${base}${path}`;

    const init = await (await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("leaddash-employees");
    expect((await rpc(url, "notifications/initialized", {}, null)).status).toBe(202);

    const tools = await (await rpc(url, "tools/list")).json();
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(["save_to_brain", "search_brain", "list_employees", "ask_employee", "whats_waiting"]);

    const saved = await (await rpc(url, "tools/call", { name: "save_to_brain", arguments: { topic: "Founding member pricing", fact: "Founding member pricing closes December 31, 2026.", category: "services_offers" } })).json();
    expect(saved.result.content[0].text).toBe("Saved in the Brain for every employee: Founding member pricing closes December 31, 2026.");
    const entry = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Learned: Founding member pricing")!;
    expect(entry.content).toMatch(/told Claude on /);
    const blocked = await (await rpc(url, "tools/call", { name: "save_to_brain", arguments: { topic: "Client", fact: "Her diagnosis is anxiety." } })).json();
    expect(blocked.result.isError).toBe(true);

    const found = await (await rpc(url, "tools/call", { name: "search_brain", arguments: { query: "founding member pricing" } })).json();
    expect(found.result.content[0].text).toContain("closes December 31, 2026");

    const asked = await (await rpc(url, "tools/call", { name: "ask_employee", arguments: { employee: "Morgan", message: "What's due this month?" } })).json();
    expect(asked.result.content[0].text).toMatch(/^Morgan: Two grants are due this month\./);
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    expect((await db.listChatMessages(orgId, morgan.id)).map((m) => m.role)).toEqual(["user", "employee"]);

    expect((await c.account.connector({ organizationId: orgId })).lastClient).toBe("Claude");

    // A new link turns the old one off.
    await c.account.newConnector({ organizationId: orgId });
    expect((await rpc(url, "tools/list")).status).toBe(404);
  });

  it("in a healthcare practice, keeps the employees who work with client information off the link and shows approvals as counts", async () => {
    const { orgId, owner } = await makeWorkspace("mcp-hc");
    const c = caller(owner);
    await c.organizations.update({ id: orgId, orgType: "healthcare" });
    const link = await c.account.connector({ organizationId: orgId });
    const url = `${base}${new URL(link.url.replace(/^[^/]*\/\/[^/]*/, "http://x")).pathname}`;
    await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
    const harper = (await db.getEmployeeByKind(orgId, "billing"))!;
    const asked = await (await rpc(url, "tools/call", { name: "ask_employee", arguments: { employee: harper.name, message: "How much came in today?" } })).json();
    expect(asked.result.isError).toBe(true);
    expect(asked.result.content[0].text).toBe(`${harper.name} works with client information, which stays inside LeadDash Employees. Ask ${harper.name} in the app.`);
    expect(await db.listChatMessages(orgId, harper.id)).toHaveLength(0);
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const ok = await (await rpc(url, "tools/call", { name: "ask_employee", arguments: { employee: morgan.name, message: "What's due this month?" } })).json();
    expect(ok.result.isError).toBeFalsy();

    // Only the owner can say the link is used only in the practice's BAA-covered ChatGPT workspace.
    const { makeUser } = await import("./test/helpers");
    const admin = await makeUser("admin@mcp-hc.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: admin.id, role: "admin" });
    await expect(caller(admin).account.setConnectorClientInfo({ organizationId: orgId, on: true })).rejects.toThrow(/cannot do that/);
    expect((await caller(admin).account.connector({ organizationId: orgId })).canSetClientInfo).toBe(false);
    const set = await c.account.setConnectorClientInfo({ organizationId: orgId, on: true });
    expect(set).toMatchObject({ on: true, by: owner.name });
    const view = await c.account.connector({ organizationId: orgId });
    expect(view).toMatchObject({ healthcare: true, canSetClientInfo: true, clientInfo: { on: true, by: owner.name } });
    const logged = (await db.listAuditLogsByOrg(orgId, 20)).find((l) => l.action === "Allowed client information on the Claude and ChatGPT link");
    expect(logged?.actorName).toBe(owner.name);
    const now = await (await rpc(url, "tools/call", { name: "ask_employee", arguments: { employee: harper.name, message: "How much came in today?" } })).json();
    expect(now.result.isError).toBeFalsy();
    expect(now.result.content[0].text).toMatch(new RegExp(`^${harper.name}: `));

    // Turned back off, the link is closed to Harper again.
    await c.account.setConnectorClientInfo({ organizationId: orgId, on: false });
    const off = await (await rpc(url, "tools/call", { name: "ask_employee", arguments: { employee: harper.name, message: "And yesterday?" } })).json();
    expect(off.result.isError).toBe(true);
  });

  it("offers the client information setting only in a healthcare workspace", async () => {
    const { orgId, owner } = await makeWorkspace("mcp-biz");
    const c = caller(owner);
    expect((await c.account.connector({ organizationId: orgId })).healthcare).toBe(false);
    await expect(c.account.setConnectorClientInfo({ organizationId: orgId, on: true })).rejects.toThrow(/healthcare workspaces/);
  });
});
