/**
 * Scheduled messages (2026-10-24): a message written now that goes out later, to a team chat
 * channel or direct message, or to an AI employee's chat. The writer sees their waiting messages
 * above the box and can send one now, change its text or time, or delete it. The minute loop
 * sends what is due as the person who wrote it, through the same path as pressing Send, and
 * checks again at that moment that they still belong to the workspace.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { scheduledMessages, type ScheduledMessage } from "../drizzle/schema";
import * as db from "./db";
import * as threads from "./threads";

const MAX_AHEAD_MS = 366 * 24 * 3600_000;

export type Target = { target: "team"; channel: string } | { target: "employee"; employeeId: number };

export type ScheduledView = {
  id: number;
  content: string;
  attachmentCount: number;
  sendAt: Date;
  timezone: string | null;
  status: ScheduledMessage["status"];
  error: string | null;
};

function view(r: ScheduledMessage): ScheduledView {
  return { id: r.id, content: r.content, attachmentCount: ids(r).length, sendAt: r.sendAt, timezone: r.timezone, status: r.status, error: r.error };
}

function ids(r: Pick<ScheduledMessage, "attachmentIds">): number[] {
  try {
    const v = r.attachmentIds ? JSON.parse(r.attachmentIds) : [];
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

/** A send time has to be in the future (a minute of grace for slow clicks) and within a year. */
export function checkWhen(sendAt: Date, now = new Date()) {
  const t = sendAt.getTime();
  if (!Number.isFinite(t)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a date and time." });
  if (t < now.getTime() - 60_000) throw new TRPCError({ code: "BAD_REQUEST", message: "That time has already passed. Pick a later time." });
  if (t > now.getTime() + MAX_AHEAD_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "Messages can be scheduled up to a year ahead." });
}

function cleanZone(tz: string | null | undefined) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function targetWhere(orgId: number, userId: number, t: Target) {
  const base = [eq(scheduledMessages.organizationId, orgId), eq(scheduledMessages.userId, userId), eq(scheduledMessages.target, t.target)];
  if (t.target === "team") base.push(eq(scheduledMessages.channel, t.channel));
  else base.push(eq(scheduledMessages.employeeId, t.employeeId));
  return and(...base);
}

export function schedule(orgId: number, me: { id: number; name: string }, t: Target, input: { content: string; attachmentIds: number[]; sendAt: Date; timezone?: string | null }, now = new Date()) {
  checkWhen(input.sendAt, now);
  const content = input.content.trim();
  if (!content && !input.attachmentIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a message or attach a file." });
  const row = db
    .getDb()
    .insert(scheduledMessages)
    .values({
      organizationId: orgId,
      userId: me.id,
      authorName: me.name,
      target: t.target,
      channel: t.target === "team" ? t.channel : null,
      employeeId: t.target === "employee" ? t.employeeId : null,
      content,
      attachmentIds: input.attachmentIds.length ? JSON.stringify(input.attachmentIds.slice(0, 10)) : null,
      sendAt: input.sendAt,
      timezone: cleanZone(input.timezone),
    })
    .returning()
    .get();
  return view(row);
}

/** The person's own messages waiting to go out here (and any that could not be sent), soonest first. */
export function listFor(orgId: number, userId: number, t: Target): ScheduledView[] {
  return db
    .getDb()
    .select()
    .from(scheduledMessages)
    .where(and(targetWhere(orgId, userId, t), inArray(scheduledMessages.status, ["waiting", "sending", "failed"])))
    .orderBy(asc(scheduledMessages.sendAt))
    .all()
    .map(view);
}

function mine(orgId: number, userId: number, id: number) {
  const r = db.getDb().select().from(scheduledMessages).where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.organizationId, orgId), eq(scheduledMessages.userId, userId))).get();
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That scheduled message is gone." });
  if (r.status === "sent" || r.status === "sending") throw new TRPCError({ code: "BAD_REQUEST", message: "That message has already gone out." });
  return r;
}

/** New text or a new time. A message that could not be sent goes back to waiting. */
export function change(orgId: number, userId: number, id: number, patch: { content?: string; sendAt?: Date; timezone?: string | null }, now = new Date()) {
  const r = mine(orgId, userId, id);
  const content = patch.content === undefined ? r.content : patch.content.trim();
  if (!content && !ids(r).length) throw new TRPCError({ code: "BAD_REQUEST", message: "Write a message or attach a file." });
  if (patch.sendAt) checkWhen(patch.sendAt, now);
  const row = db
    .getDb()
    .update(scheduledMessages)
    .set({ content, sendAt: patch.sendAt ?? r.sendAt, timezone: patch.timezone !== undefined ? cleanZone(patch.timezone) : r.timezone, status: "waiting", error: null })
    .where(eq(scheduledMessages.id, r.id))
    .returning()
    .get();
  return view(row);
}

export function remove(orgId: number, userId: number, id: number) {
  const r = mine(orgId, userId, id);
  db.getDb().delete(scheduledMessages).where(eq(scheduledMessages.id, r.id)).run();
  return { ok: true };
}

/** Send now: the message goes out right away instead of at its time. */
export async function sendNow(orgId: number, userId: number, id: number) {
  const r = mine(orgId, userId, id);
  return deliverOne(r.id);
}

/** Claims the row (waiting or failed to sending) so the minute loop and Send now never both send it. */
function claim(id: number) {
  const r = db.getDb().update(scheduledMessages).set({ status: "sending" }).where(and(eq(scheduledMessages.id, id), inArray(scheduledMessages.status, ["waiting", "failed"]))).returning().get();
  return r ?? null;
}

async function deliver(r: ScheduledMessage) {
  const user = await db.getUserById(r.userId);
  if (!user) throw new Error("The person who wrote it is no longer on LeadDash Employees.");
  const support = user.role === "admin";
  const membership = await db.getOrganizationMembership(r.organizationId, r.userId);
  if (!support && !membership) throw new Error("The person who wrote it is no longer on this workspace's team.");
  const name = user.name?.trim() || user.email || r.authorName;
  if (r.target === "team") {
    await (await import("./team")).send(r.organizationId, { id: r.userId, name }, r.channel ?? "everyone", r.content, ids(r));
    return;
  }
  if (!support && membership && !["owner", "admin", "member"].includes(membership.role)) throw new Error("Your role in this workspace cannot message the AI employees.");
  const viewer = { userId: r.userId, role: membership?.role ?? "owner", support };
  const visible = threads.visibleFor(viewer, support ? { mode: "all", users: [], workspace: true } : threads.accessOf(membership));
  const { sendChatMessage } = await import("./employees/chat");
  await sendChatMessage({ organizationId: r.organizationId, employeeId: r.employeeId ?? 0, text: r.content, authorName: name, userId: r.userId, threadUserId: r.userId, visible, attachmentIds: ids(r) });
  await db.markChatRead(r.organizationId, r.employeeId ?? 0, r.userId);
}

async function deliverOne(id: number) {
  const r = claim(id);
  if (!r) return { ok: false };
  try {
    await deliver(r);
    db.getDb().update(scheduledMessages).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(scheduledMessages.id, r.id)).run();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.getDb().update(scheduledMessages).set({ status: "failed", error: msg.slice(0, 500) }).where(eq(scheduledMessages.id, r.id)).run();
    console.warn(`[scheduled] message ${r.id} could not be sent:`, msg);
    return { ok: false, error: msg };
  }
}

/** The minute loop: every message whose time has come, team chat first (quick) and then employee chats. */
export async function sendDue(now = new Date()) {
  const due = db
    .getDb()
    .select({ id: scheduledMessages.id, target: scheduledMessages.target })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "waiting"), lte(scheduledMessages.sendAt, now)))
    .orderBy(asc(scheduledMessages.sendAt))
    .all();
  const order = [...due.filter((d) => d.target === "team"), ...due.filter((d) => d.target === "employee")];
  for (const d of order) await deliverOne(d.id);
  return order.length;
}

/** A message stuck in "sending" when the server restarted goes back to waiting, so it is sent once. */
export function resumeInterrupted() {
  db.getDb().update(scheduledMessages).set({ status: "waiting" }).where(eq(scheduledMessages.status, "sending")).run();
}
