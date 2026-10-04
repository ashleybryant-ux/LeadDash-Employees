import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import * as db from "./db";
import { ENV } from "./_core/env";
import { sha256, encryptJson, decryptJson } from "./_core/crypto";
import { KNOWLEDGE_CATEGORIES } from "../drizzle/schema";

/**
 * The Claude and ChatGPT connector (MCP, Streamable HTTP, stateless JSON replies).
 * Each person has one secret link per workspace, made on My account:
 *   https://employees.leaddash.io/mcp/<secret>
 * Pasted into Claude (custom connector) or ChatGPT (developer mode app), it lets
 * that assistant save what the owner tells it to the Brain, search the Brain,
 * talk to an employee and see what's waiting for approval. The link is checked on
 * every call, and the person must still be on the workspace. Anything that sends
 * or spends still waits for approval in the app, exactly as in chat.
 */

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Ctx = { orgId: number; userId: number; who: string; linkId: number; client: string };

export function linkUrl(token: string) {
  return `${(ENV.appUrl || "").replace(/\/$/, "")}/mcp/${token}`;
}

/** The person's link for this workspace, making one the first time. */
export function linkFor(userId: number, orgId: number, fresh = false) {
  let row = fresh ? null : db.getMcpLink(userId, orgId);
  if (!row) {
    const token = crypto.randomBytes(24).toString("base64url");
    row = db.replaceMcpLink({ userId, organizationId: orgId, tokenHash: sha256(token), tokenEncrypted: encryptJson({ token }) });
  }
  const token = decryptJson<{ token: string }>(row.tokenEncrypted)?.token ?? "";
  return { url: linkUrl(token), last4: token.slice(-4), lastUsedAt: row.lastUsedAt, lastClient: row.lastClient };
}

const TOOLS = [
  {
    name: "save_to_brain",
    title: "Save to the LeadDash Brain",
    description:
      "Save a lasting fact about the user's business to their LeadDash Employees Brain, so their AI employees know it without being told again. Use it when the user tells you something lasting (an offer or price, a decision, who the customers are, a team member, a tool, a date, how work should be done) or asks you to send something to their Brain or team. One fact per call, in one plain sentence. Never save anything about a client or patient, passwords or codes.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "2 to 5 words, like 'Founding member pricing'. Saving the same topic again replaces the old fact." },
        fact: { type: "string", description: "The fact in one plain sentence." },
        category: { type: "string", enum: [...KNOWLEDGE_CATEGORIES], description: "Where it belongs in the Brain." },
      },
      required: ["topic", "fact"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_brain",
    title: "Search the LeadDash Brain",
    description: "Search the user's LeadDash Employees Brain (company facts, documents and what employees have learned) to answer a question about their business.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for." } }, required: ["query"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_employees",
    title: "List the AI employees",
    description: "List the user's AI employees in LeadDash Employees: each one's name, job and what they do.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask_employee",
    title: "Message an AI employee",
    description:
      "Send a message to one of the user's AI employees (by name, like Morgan or Avery) and return their reply. It's the same as messaging them in the app: they can answer questions or start work. Anything they would send or post still waits for the user's approval in the app.",
    inputSchema: {
      type: "object",
      properties: { employee: { type: "string", description: "The employee's name or job, like 'Morgan' or 'grant writer'." }, message: { type: "string", description: "What to say to them." } },
      required: ["employee", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "whats_waiting",
    title: "What's waiting for approval",
    description: "List what the AI employees have waiting for the user's approval in LeadDash Employees (emails, posts, outreach), newest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  const s = (k: string) => String(args[k] ?? "").trim();
  switch (name) {
    case "save_to_brain": {
      const { learnFact } = await import("./employees/learn");
      const r = await learnFact(ctx.orgId, { topic: s("topic"), fact: s("fact"), category: s("category") || undefined, who: ctx.who, via: ctx.client });
      if (!r) return text("Not saved. The Brain never keeps client details, passwords or codes, and it needs a topic and a fact.", true);
      return text(`${r.replaced ? "Updated" : "Saved"} in the Brain for every employee: ${r.fact}`);
    }
    case "search_brain": {
      const { findPassages } = await import("./employees/kb");
      const q = s("query");
      const passages = q ? await findPassages(ctx.orgId, q, { limit: 8 }) : [];
      const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const facts = (await db.listKnowledgeByOrg(ctx.orgId))
        .filter((k) => k.kind !== "image" && k.content.length < 6000 && words.some((w) => `${k.title} ${k.content}`.toLowerCase().includes(w)))
        .slice(0, 8);
      const out = [...facts.map((k) => `${k.title}: ${k.content.slice(0, 800)}`), ...passages.map((p) => `${p.source}${p.heading ? `, ${p.heading}` : ""}: ${p.text.slice(0, 800)}`)];
      return text(out.length ? Array.from(new Set(out)).slice(0, 12).join("\n\n") : "Nothing in the Brain matches that yet.");
    }
    case "list_employees": {
      const emps = (await db.listEmployeesByOrg(ctx.orgId)).filter((e) => e.status !== "paused");
      return text(emps.map((e) => `${e.name}, ${e.roleTitle}: ${e.description ?? ""}`).join("\n"));
    }
    case "ask_employee": {
      const want = s("employee").toLowerCase();
      const emps = await db.listEmployeesByOrg(ctx.orgId);
      const emp = emps.find((e) => e.name.toLowerCase() === want) ?? emps.find((e) => want.includes(e.name.toLowerCase()) || e.roleTitle.toLowerCase().includes(want) || e.kind === want);
      if (!emp) return text(`There's no employee called "${s("employee")}". The team: ${emps.map((e) => `${e.name} (${e.roleTitle})`).join(", ")}.`, true);
      const { sendChatMessage } = await import("./employees/chat");
      const r = await sendChatMessage({ organizationId: ctx.orgId, employeeId: emp.id, text: `${s("message")}\n(Sent from ${ctx.client})`, authorName: ctx.who, userId: ctx.userId });
      const cards = (() => {
        try {
          return (JSON.parse(r.reply.cards || "[]") as { type: string; title?: string; options?: string[] }[]).filter((c) => c.type !== "choices" && c.title).map((c) => `- ${c.title}`);
        } catch {
          return [];
        }
      })();
      return text(`${emp.name}: ${r.reply.content}${cards.length ? `\n\nIn the app:\n${cards.join("\n")}` : ""}\n\n(This conversation is also in ${emp.name}'s chat in LeadDash Employees.)`);
    }
    case "whats_waiting": {
      const items = (await db.listOutboundItemsByOrg(ctx.orgId)).filter((m) => m.status === "pending_approval").slice(0, 25);
      if (!items.length) return text("Nothing is waiting for approval.");
      const emps = await db.listEmployeesByOrg(ctx.orgId);
      return text(`${items.length} waiting in Approvals:\n${items.map((m) => `- ${m.title} (${emps.find((e) => e.id === m.employeeId)?.name ?? "an employee"})`).join("\n")}\nApprove them in LeadDash Employees, Approvals.`);
    }
  }
  return null;
}

async function handle(ctx: Ctx, msg: any): Promise<any | null> {
  const id = msg?.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  // Notifications get no reply.
  if (id === undefined || id === null) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      const client = String(msg.params?.clientInfo?.name ?? "");
      const label = /claude/i.test(client) ? "Claude" : /openai|chatgpt/i.test(client) ? "ChatGPT" : client.slice(0, 40) || null;
      if (label) db.touchMcpLink(ctx.linkId, label);
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "leaddash-employees", title: "LeadDash Employees", version: "1.0.0" },
        instructions: "This is the user's LeadDash Employees workspace: their AI employees and their company Brain. When the user tells you a lasting fact about their business, save it with save_to_brain so their employees know it. Never save client or patient details.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      try {
        const r = await callTool(ctx, name, (msg.params?.arguments ?? {}) as Record<string, unknown>);
        return r ? reply(r) : fail(-32602, `Unknown tool: ${name}`);
      } catch (err) {
        return reply(text(`That didn't work: ${err instanceof Error ? err.message : String(err)}`, true));
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
  }
  return fail(-32601, `Method not found: ${msg.method}`);
}

const hits = new Map<number, { n: number; reset: number }>();

export function registerMcp(app: Express) {
  app.all("/mcp/:token", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" || req.method === "DELETE") return res.status(405).set("Allow", "POST").json({ error: "Use POST." });
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
    const link = db.mcpLinkByHash(sha256(String(req.params.token || "")));
    if (!link) return res.status(404).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This connector link isn't valid. Make a new one on My account in LeadDash Employees." } });
    const user = await db.getUserById(link.userId);
    const member = user && (user.role === "admin" || (await db.getOrganizationMembership(link.organizationId, user.id)));
    if (!user || !member || (typeof member === "object" && member.role === "reviewer")) return res.status(403).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "You're no longer on this workspace." } });
    // At most 120 calls a minute per link.
    const now = Date.now();
    const h = hits.get(link.id);
    if (!h || h.reset < now) hits.set(link.id, { n: 1, reset: now + 60_000 });
    else if (++h.n > 120) return res.status(429).json({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "Too many calls. Wait a minute." } });
    db.touchMcpLink(link.id, null);
    const ctx: Ctx = { orgId: link.organizationId, userId: user.id, who: user.name?.trim() || user.email, linkId: link.id, client: link.lastClient || "Claude or ChatGPT" };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(ctx, m)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handle(ctx, body);
    return out ? res.json(out) : res.status(202).end();
  });
}
