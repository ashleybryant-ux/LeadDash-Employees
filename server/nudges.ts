import { TRPCError } from "@trpc/server";
import * as db from "./db";
import type { Express, Request, Response } from "express";
import type { AIEmployee, StaffNudge } from "../drizzle/schema";

/**
 * AN EMPLOYEE'S REMINDER REACHES THE PERSON IN LEADDASH EHR (2026-11-14)
 *
 * A reminder Camille sent went out as an email and a phone notice. The
 * person could not answer her, the administrator could not see whether it
 * was read, and "done" was whatever anyone remembered to say. Now each
 * reminder is also kept here for the person it is for:
 *
 *   - it comes up at the bottom of their screen in LeadDash EHR and sits in
 *     Team chat as a conversation with the employee;
 *   - Close leaves it open; Completed is the person saying it is done;
 *   - the employee does not take their word for it: she reads LeadDash EHR
 *     for that person (notes waiting on a signature, plans due) and tells
 *     the administrator what they said AND what she found;
 *   - the administrator sees where each reminder stands: not read, read,
 *     said completed, completed and checked, or not complete.
 *
 * WHO SEES WHAT. A person reads and answers only their own conversation:
 * every call names the workspace from the EHR's signed token and the
 * person's own staff id from that token, never from the request. What a
 * person types to an employee here is not answered by the AI (it would
 * answer from the practice's records, which are not theirs to ask about):
 * it is kept, acknowledged, and passed to the administrator's chat.
 * A reminder never names a client, so nothing here does.
 */

export type NudgeKind = "notes" | "plans" | "other";
type Work = { unsignedNotes: number; oldestUnsigned: string | null; plansDue: number };

/** What can be checked afterwards, from the reminder's own words. */
export function kindOf(subject: string, body: string): NudgeKind {
  const t = `${subject} ${body}`.toLowerCase();
  if (/\b(unsigned|sign(ed|ing)?|signature)\b/.test(t) && /\bnotes?\b/.test(t)) return "notes";
  if (/\b(treatment )?plans?\b/.test(t) && /\b(review|due|update)\b/.test(t)) return "plans";
  return "other";
}

/** Swapped in by tests. */
export const tools = {
  async work(orgId: number, staffId: string): Promise<Work | null> {
    const ehr = await import("./ehr");
    return ehr.staffWork(orgId, staffId);
  },
};

const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "They";
const dayText = (ymd: string | null) => {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return "";
  return new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const plural = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

/** Keeps a sent reminder for each person it reached, with what LeadDash EHR showed for them then. Never throws. */
export async function deliver(orgId: number, emp: AIEmployee, r: { id: number; subject: string; body: string }, people: { id: string; name: string }[]) {
  const kind = kindOf(r.subject, r.body);
  const made: StaffNudge[] = [];
  for (const p of people) {
    try {
      let baseline: Work | null = null;
      if (kind !== "other") baseline = await tools.work(orgId, p.id).catch(() => null);
      const n = db.nudges.add({ organizationId: orgId, employeeId: emp.id, reminderId: r.id, staffId: p.id, staffName: p.name, subject: r.subject, body: r.body, kind, baseline: JSON.stringify(baseline ?? {}) });
      db.nudges.say({ organizationId: orgId, employeeId: emp.id, staffId: p.id, side: "employee", content: r.body, nudgeId: n.id });
      made.push(n);
    } catch (err) {
      console.error("[nudges] could not keep a reminder for a team member:", err instanceof Error ? err.message : err);
    }
  }
  return made;
}

const isOpen = (n: StaffNudge) => n.status === "sent" || n.status === "read";

/** Everything for one person: what is still open, and the employees who have written to them. */
export async function mine(orgId: number, ids: string[]) {
  const all = db.nudges.forStaff(orgId, ids);
  const empIds = Array.from(new Set([...all.map((n) => n.employeeId), ...db.nudges.employeesFor(orgId, ids)]));
  const { withPortrait } = await import("./ehrLink");
  const emps = new Map<number, { id: number; name: string; title: string; avatar: string }>();
  for (const id of empIds) {
    const e = await db.getEmployeeForOrg(id, orgId);
    if (!e) continue;
    const p = withPortrait(e);
    emps.set(id, { id, name: e.name, title: e.roleTitle || "", avatar: p.avatar || `/avatars/${e.kind}.webp` });
  }
  const open = all.filter(isOpen).filter((n) => emps.has(n.employeeId)).reverse();
  return {
    open: open.map((n) => ({ id: n.id, employee: emps.get(n.employeeId)!, avatar: emps.get(n.employeeId)!.avatar, subject: n.subject, text: n.body, kind: n.kind, sentAt: n.createdAt })),
    threads: Array.from(emps.values()).map((e) => ({ employeeId: e.id, name: e.name, title: e.title, avatar: e.avatar, open: open.filter((n) => n.employeeId === e.id).length, unread: all.filter((n) => n.employeeId === e.id && n.status === "sent").length })),
  };
}

/** One person's conversation with one employee. Reading it marks their reminders from that employee read. */
export async function thread(orgId: number, ids: string[], employeeId: number) {
  const e = await db.getEmployeeForOrg(employeeId, orgId);
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "That conversation is not here." });
  if (!db.nudges.employeesFor(orgId, ids).includes(employeeId)) throw new TRPCError({ code: "NOT_FOUND", message: "That conversation is not here." });
  const all = db.nudges.forStaff(orgId, ids).filter((n) => n.employeeId === employeeId);
  const now = new Date();
  for (const n of all) if (n.status === "sent") db.nudges.update(orgId, n.id, { status: "read", readAt: now });
  const openIds = new Set(all.filter(isOpen).map((n) => n.id));
  const { withPortrait } = await import("./ehrLink");
  const kinds = new Map(all.map((n) => [n.id, n.kind]));
  return {
    employee: { id: e.id, name: e.name, title: e.roleTitle || "", avatar: withPortrait(e).avatar || `/avatars/${e.kind}.webp` },
    messages: db.nudges.thread(orgId, ids, employeeId).map((m) => ({ id: m.id, from: m.side, text: m.content, at: m.createdAt, nudgeId: m.nudgeId && openIds.has(m.nudgeId) && m.side === "employee" ? m.nudgeId : null, kind: m.nudgeId ? kinds.get(m.nudgeId) ?? "other" : null })),
  };
}

/** Marks one reminder read (the pop-up was shown). */
export function seen(orgId: number, ids: string[], nudgeId: number) {
  const n = db.nudges.get(orgId, nudgeId);
  if (!n || !ids.includes(n.staffId)) throw new TRPCError({ code: "NOT_FOUND", message: "That reminder is not yours." });
  if (n.status === "sent") db.nudges.update(orgId, n.id, { status: "read", readAt: new Date() });
  return { ok: true };
}

async function tellAdmin(orgId: number, employeeId: number, content: string, choices: string[] = []) {
  const e = await db.getEmployeeForOrg(employeeId, orgId);
  if (!e) return;
  const cards = choices.length ? JSON.stringify([{ type: "choices", id: Date.now(), title: "", options: choices }]) : null;
  await db.createChatMessage({ organizationId: orgId, employeeId: e.id, role: "employee", authorName: e.name, content, cards });
}

/** What the person typed to the employee: kept, acknowledged, and passed to the administrator. Not answered by the AI. */
export async function say(orgId: number, ids: string[], staffName: string, employeeId: number, text: string) {
  const e = await db.getEmployeeForOrg(employeeId, orgId);
  const words = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!e || !db.nudges.employeesFor(orgId, ids).includes(employeeId)) throw new TRPCError({ code: "NOT_FOUND", message: "That conversation is not here." });
  if (!words) throw new TRPCError({ code: "BAD_REQUEST", message: "Type a message." });
  const last = db.nudges.forStaff(orgId, ids).find((n) => n.employeeId === employeeId);
  const staffId = last?.staffId ?? ids[0];
  db.nudges.say({ organizationId: orgId, employeeId, staffId, side: "person", content: words });
  db.nudges.say({ organizationId: orgId, employeeId, staffId, side: "employee", content: "Thank you. I will pass that on to your administrator." });
  const who = staffName || last?.staffName || "A team member";
  // Their words are quoted only in the chat of an employee who works with client information (a person may type a client's name).
  const { CLIENT_INFO_KINDS } = await import("./employees/roster");
  await tellAdmin(orgId, employeeId, CLIENT_INFO_KINDS.includes(e.kind) ? `${who} answered my reminder: "${words}"` : `${who} answered my reminder.`);
  return { ok: true };
}

/** The check, in words. `ok` null: nothing in LeadDash EHR can say either way. */
export function judge(n: Pick<StaffNudge, "kind" | "baseline" | "staffName">, now: Work | null): { ok: boolean | null; found: string } {
  if (n.kind === "other" || !now) return { ok: null, found: n.kind === "other" ? "This is not something I can check in LeadDash EHR." : "I could not read LeadDash EHR to check it just now." };
  let before: Partial<Work> = {};
  try { before = JSON.parse(n.baseline || "{}") as Partial<Work>; } catch { before = {}; }
  if (n.kind === "notes") {
    const was = Number(before.unsignedNotes) || 0;
    if (now.unsignedNotes === 0) return { ok: true, found: `I checked LeadDash EHR: ${was > 0 ? `all ${was} are signed` : "no notes are waiting on a signature"}.${now.plansDue === 0 ? " Nothing else is waiting on them." : ""}` };
    const of = was > now.unsignedNotes ? ` of the ${was}` : "";
    return { ok: false, found: `LeadDash EHR still shows ${now.unsignedNotes}${of} unsigned.${now.oldestUnsigned ? ` The oldest is from ${dayText(now.oldestUnsigned)}.` : ""}` };
  }
  const was = Number(before.plansDue) || 0;
  if (now.plansDue === 0) return { ok: true, found: `I checked LeadDash EHR: ${was > 0 ? `all ${plural(was, "plan is", "plans are")} reviewed` : "no treatment plans are due"}.` };
  return { ok: false, found: `LeadDash EHR still shows ${plural(now.plansDue, "treatment plan", "treatment plans")} due for review.` };
}

/**
 * The person pressed Completed. Their word is recorded, the employee thanks
 * them, checks LeadDash EHR for that person, and tells the administrator
 * what they said and what she found.
 */
export async function done(orgId: number, ids: string[], nudgeId: number) {
  const n = db.nudges.get(orgId, nudgeId);
  if (!n || !ids.includes(n.staffId)) throw new TRPCError({ code: "NOT_FOUND", message: "That reminder is not yours." });
  if (!isOpen(n)) return { ok: true, already: true };
  const at = new Date();
  const staffId = n.staffId;
  db.nudges.update(orgId, n.id, { status: "said_done", doneAt: at, readAt: n.readAt ?? at });
  db.nudges.say({ organizationId: orgId, employeeId: n.employeeId, staffId, side: "person", content: "Completed", nudgeId: n.id });
  const name = first(n.staffName);
  db.nudges.say({ organizationId: orgId, employeeId: n.employeeId, staffId, side: "employee", content: `Thank you${n.staffName ? `, ${name}` : ""}. I will check LeadDash EHR and let your administrator know.` });
  const now = n.kind === "other" ? null : await tools.work(orgId, staffId).catch(() => null);
  const v = judge(n, now);
  const status = v.ok === true ? "verified" : v.ok === false ? "not_done" : "unverifiable";
  db.nudges.update(orgId, n.id, { status, checkedAt: new Date(), result: v.found });
  const who = n.staffName || "A team member";
  const what = n.kind === "notes" ? "their notes" : n.kind === "plans" ? "their treatment plans" : `"${n.subject}"`;
  if (v.ok === false) await tellAdmin(orgId, n.employeeId, `${who} marked ${what} completed, but ${v.found}`, [`Remind ${name} again`, "Leave it"]);
  else await tellAdmin(orgId, n.employeeId, `${who} marked ${what} completed. ${v.found}`);
  return { ok: true, status };
}

const WORDS: Record<StaffNudge["status"], string> = { sent: "Not read yet", read: "Read", said_done: "Said completed", verified: "Completed and checked", not_done: "Said completed, not complete", unverifiable: "Said completed" };

/** For the administrator: every reminder, who it went to and where it stands. */
export function board(orgId: number) {
  return db.nudges.list(orgId, 200).map((n) => ({
    id: n.id, employeeId: n.employeeId, to: n.staffName || "A team member", subject: n.subject, text: n.body, sentAt: n.createdAt,
    status: n.status, words: WORDS[n.status], at: n.checkedAt ?? n.doneAt ?? n.readAt ?? null, result: n.result,
    good: n.status === "verified" || n.status === "read" || n.status === "unverifiable" || n.status === "said_done", bad: n.status === "not_done" || n.status === "sent",
  }));
}

export type Standing = { who: string; status: StaffNudge["status"]; words: string; at: Date | null; bad: boolean };
/**
 * Under a message in the administrator's chat: where the reminder it is
 * about stands. Under "Sent to ...", one line for each person it went to
 * (not read yet, read, said completed, checked). Under the employee's report
 * that someone marked it completed, when she checked and what she found.
 * Times go as times: the screen writes them in the reader's own zone.
 */
export function standing(orgId: number, employeeId: number, at: Date, text: string): Standing[] {
  const sentMsg = /^(Reminder ".*": )?Sent to /.test(text);
  const report = / marked .* completed/.test(text);
  if (!sentMsg && !report) return [];
  const when = new Date(at).getTime();
  const all = db.nudges.list(orgId, 200).filter((n) => n.employeeId === employeeId);
  if (report) {
    return all.filter((n) => n.checkedAt && Math.abs(new Date(n.checkedAt).getTime() - when) < 60_000 && text.startsWith(n.staffName || "A team member"))
      .slice(0, 1).map((n) => ({ who: first(n.staffName), status: n.status, words: n.status === "not_done" ? "Checked, not complete" : n.status === "verified" ? "Checked" : "Not checked", at: n.checkedAt, bad: n.status === "not_done" }));
  }
  return all.filter((n) => Math.abs(new Date(n.createdAt).getTime() - when) < 90_000).reverse().map((n) => ({
    who: first(n.staffName), status: n.status, words: WORDS[n.status], at: n.checkedAt ?? n.doneAt ?? n.readAt ?? null, bad: n.status === "sent" || n.status === "not_done",
  }));
}

/**
 * The door a team member's own reminders come through. The EHR's server
 * signs the same short-lived token Team chat uses; the workspace is the one
 * that practice is linked to, and the person is the staff id (and the ids
 * that are the same person) the EHR put in the token from their session.
 * Nothing in the request body can name another person or workspace.
 */
export async function nudgeCall(t: import("./ehrChat").ChatToken, name: string, raw: unknown) {
  const org = await db.getOrganizationByEhrLocation(t.loc);
  if (!org || org.chatOnly) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your LeadDash employees are not turned on for this practice yet." });
  const ids = Array.from(new Set([t.user.id, ...(Array.isArray(t.user.ids) ? t.user.ids : [])].map((x) => String(x || "").trim()).filter(Boolean))).slice(0, 12);
  if (!ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "That request does not say who you are." });
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new TRPCError({ code: "BAD_REQUEST", message: "That request is missing a number it needs." });
    return n;
  };
  if (name === "mine") return mine(org.id, ids);
  if (name === "thread") return thread(org.id, ids, int(i.employeeId));
  if (name === "seen") return seen(org.id, ids, int(i.nudgeId));
  if (name === "say") return say(org.id, ids, String(t.user.name || "").trim(), int(i.employeeId), String(i.text ?? ""));
  if (name === "done") return done(org.id, ids, int(i.nudgeId));
  throw new TRPCError({ code: "NOT_FOUND", message: "Not found." });
}

const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 };

export function registerNudges(app: Express) {
  app.post("/api/ehr-nudge/:name", async (req: Request, res: Response) => {
    const { readChatToken } = await import("./ehrChat");
    const read = readChatToken(String(req.headers["x-ehr-chat"] || ""));
    if ("error" in read) return res.status(401).json({ ok: false, error: read.error });
    try {
      const result = await nudgeCall(read.token, String(req.params.name || ""), req.body);
      res.json({ ok: true, result: result ?? null });
    } catch (err) {
      if (err instanceof TRPCError) return res.status(STATUS[err.code] ?? 400).json({ ok: false, error: err.message, code: err.code });
      console.error("[nudges] call failed:", err instanceof Error ? err.message : err);
      res.status(500).json({ ok: false, error: "That could not be done. Try again." });
    }
  });
}
