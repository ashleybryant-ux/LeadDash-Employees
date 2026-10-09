import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";

/**
 * One-on-ones happen in an employee's chat: the person presses Talk, speaks, and
 * the employee answers out loud (chat.send with spoken). Everything lands in the
 * chat as normal messages, so the employee can still do work mid-meeting. When the
 * person presses End meeting, the conversation since the meeting started becomes a
 * held meeting on Simone's Meetings tab, Simone pulls out the action items (Nora
 * tracks them when Simone sends items on her own), and the employee posts the notes
 * in the chat.
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

type Item = { text: string; owner: string; taskId: number | null; status: string };

function parse<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function endOneOnOne(orgId: number, employeeId: number, who: { id: number | null; name: string }, opts: { sinceId: number; startedAt: Date }) {
  const emp = await db.getEmployeeForOrg(employeeId, orgId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  const msgs = (await db.listChatMessages(orgId, emp.id, 300, who.id ?? null)).filter((m) => m.id >= opts.sinceId && (m.role === "user" || m.role === "employee"));
  if (!msgs.some((m) => m.role === "user") || msgs.length < 2) return { meetingId: null, reply: null };

  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  // A meeting can't start before its first line or in the future.
  const first = new Date(msgs[0].createdAt).getTime();
  const startedAt = new Date(Math.min(Date.now(), Math.max(opts.startedAt.getTime(), first - 10 * 60_000)));
  const minutes = Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 60_000));
  const owner = (await db.listMembers(orgId)).find((m) => m.userId === who.id);
  const lines = msgs.map((m) => `${m.authorName}: ${m.content}`).join("\n").slice(0, 30_000);

  const m = await db.createMeeting({
    organizationId: orgId,
    title: `One-on-one with ${emp.name}, ${startedAt.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" })}`,
    startsAt: startedAt,
    minutes,
    attendees: JSON.stringify(owner ? [{ name: owner.name || owner.email, email: owner.email }] : [{ name: who.name, email: "" }]),
    updatesFrom: JSON.stringify([emp.kind]),
    status: "held",
    linkKind: "meet",
  });

  let items: Item[] = [];
  try {
    const { saveNotes } = await import("./coo");
    items = parse<Item[]>((await saveNotes(orgId, m.id, lines, "transcript")).actionItems, []);
  } catch (err) {
    console.warn("[one-on-one] notes failed:", err instanceof Error ? err.message : err);
  }

  let points: string[] = [];
  try {
    const out = await generateJson<{ points: string[] }>({
      system: `Summarize a one-on-one between ${who.name} and ${emp.name}, an AI employee (${emp.roleTitle}). Give 1 to 4 short plain sentences: what was decided, what was learned, what happens next. No markdown, no em dashes, never a client's name or anything about a client's health.`,
      prompt: lines,
      schemaName: "one_on_one_summary",
      schema: obj({ points: { type: "array", items: str } }),
      maxTokens: 500,
    });
    points = (out.points ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 4);
  } catch (err) {
    console.warn("[one-on-one] summary failed:", err instanceof Error ? err.message : err);
  }

  const sent = items.filter((i) => i.taskId != null).length;
  const where = !items.length
    ? "The notes are on Simone's Meetings tab."
    : sent
      ? `The notes are on Simone's Meetings tab, and Nora is tracking ${sent === 1 ? "the action item" : `the ${sent} action items`}.`
      : `The notes are on Simone's Meetings tab, with ${items.length === 1 ? "1 action item" : `${items.length} action items`} ready to send to Nora.`;
  const content = [
    `Notes from our one-on-one · ${minutes} minute${minutes === 1 ? "" : "s"}`,
    points.length ? points.map((p) => `- ${p}`).join("\n") : "",
    items.length ? `Action items:\n${items.map((i) => `- ${i.text} (${i.owner})`).join("\n")}` : "",
    where,
  ]
    .filter(Boolean)
    .join("\n\n");
  const reply = await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, threadUserId: who.id ?? null, content });
  return { meetingId: m.id, reply };
}
