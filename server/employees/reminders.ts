import * as db from "../db";
import type { ComplianceReminder } from "../../drizzle/schema";
import { zonedToUtc } from "./schedule";

/**
 * Camille's reminders to the practice's team (2026-10-12).
 *
 * Everything happens in her chat: the person asks ("remind Dana about her
 * unsigned notes Monday at 9"), she drafts it and shows it, and it goes out
 * only when the person says so (now, or at the time they chose, and again
 * every week or month when they asked for that). They change, stop or list
 * them in chat the same way. She reads the team from LeadDash EHR, and the
 * EHR sends the reminder (email from the practice, push where it is on), so
 * staff addresses never leave it. A reminder carries counts, never a client.
 */

export type Repeat = "none" | "weekly" | "monthly";
export type Recipient = { id: string; name: string };
type Member = { id: string; name: string; email: string; role: string; seesClients: boolean };

const ehr = () => import("../ehr");

export function recipientsOf(r: Pick<ComplianceReminder, "recipients">): Recipient[] {
  try {
    const list = JSON.parse(r.recipients || "[]");
    return Array.isArray(list) ? list.filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: String(x.name ?? "") })) : [];
  } catch {
    return [];
  }
}

const NOT_WORD = new RegExp("[^\\p{L}\\p{N}' -]+", "gu");
const norm = (s: string) => s.toLowerCase().replace(NOT_WORD, " ").replace(/\s+/g, " ").trim();

const GROUPS: { re: RegExp; pick: (m: Member) => boolean }[] = [
  { re: /^(everyone|everybody|all|all staff|the team|whole team|the whole team|all of them|team)$/, pick: () => true },
  { re: /^(all )?(the )?(clinicians|therapists|counselors|providers)$/, pick: (m) => m.seesClients },
  { re: /^(all )?(the )?(admins|administrators|practice administrators)$/, pick: (m) => /administrator/i.test(m.role) },
  { re: /^(all )?(the )?(supervisors)$/, pick: (m) => /supervisor/i.test(m.role) },
  { re: /^(all )?(the )?(interns)$/, pick: (m) => /intern/i.test(m.role) },
  { re: /^(all )?(the )?(billers|billing)$/, pick: (m) => /biller/i.test(m.role) },
  { re: /^(all )?(the )?(front desk)$/, pick: (m) => /front desk/i.test(m.role) },
];

/**
 * Who "Dana, Marcus Lee and the interns" means on the team. Names match whole
 * (first, last or full); a first name two people share is not guessed.
 */
export function matchRecipients(team: Member[], said: string): { found: Recipient[]; missing: string[] } {
  const parts = said
    .split(/,|;|\band\b|&|\n/i)
    .map((p) => norm(p).replace(/^(to |for )/, "").replace(/'s$/, ""))
    .filter(Boolean);
  const found = new Map<string, Recipient>();
  const missing: string[] = [];
  for (const p of parts) {
    const group = GROUPS.find((g) => g.re.test(p));
    if (group) {
      const hit = team.filter(group.pick);
      if (!hit.length) missing.push(p);
      hit.forEach((m) => found.set(m.id, { id: m.id, name: m.name }));
      continue;
    }
    const full = team.filter((m) => norm(m.name) === p);
    const byWord = full.length ? full : team.filter((m) => norm(m.name).split(" ").includes(p) || norm(m.name).startsWith(`${p} `));
    if (byWord.length === 1) found.set(byWord[0].id, { id: byWord[0].id, name: byWord[0].name });
    else missing.push(p);
  }
  return { found: Array.from(found.values()), missing };
}

/** "9:00 AM", "9am", "14:30", "2:30 pm" as hours and minutes. */
export function parseTime(raw: string): { h: number; mi: number } | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const ap = m[3]?.[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

function localYmd(d: Date, tz: string) {
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

/** The send time for a date and time in the workspace's zone; null for "when I say". A time with no date is the next one coming. */
export function sendTimeOf(date: string, time: string, tz: string, now = new Date()): Date | null {
  const t = time ? parseTime(time) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) && !t) return null;
  const at = t ?? { h: 9, mi: 0 };
  let ymd = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localYmd(now, tz);
  const make = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return zonedToUtc(y, m, d, at.h, at.mi, tz);
  };
  let when = make(ymd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) && when.getTime() <= now.getTime()) {
    const next = new Date(`${ymd}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    ymd = next.toISOString().slice(0, 10);
    when = make(ymd);
  }
  return when;
}

/** The next time a repeating reminder goes out: same weekday or same day of the month, same time of day, in the workspace's zone. */
export function nextAfter(when: Date, repeat: Repeat, tz: string): Date | null {
  if (repeat === "none") return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(when);
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const day = new Date(Date.UTC(y, m - 1, d, 12));
  if (repeat === "weekly") day.setUTCDate(day.getUTCDate() + 7);
  else {
    const last = new Date(Date.UTC(y, m + 1, 0, 12)).getUTCDate();
    day.setUTCDate(1);
    day.setUTCMonth(m);
    day.setUTCDate(Math.min(d, last));
  }
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), get("hour"), get("minute"), tz);
}

export function whenLine(r: Pick<ComplianceReminder, "sendAt" | "repeat">, tz: string) {
  const at = r.sendAt ? new Date(r.sendAt) : null;
  const text = at ? at.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const again = r.repeat === "weekly" ? "every week" : r.repeat === "monthly" ? "every month" : "";
  if (!at) return again ? `as soon as you say, then ${again}` : "as soon as you say";
  return again ? `${text}, then ${again}` : text;
}

const names = (list: Recipient[]) => (list.length <= 2 ? list.map((r) => r.name).join(" and ") : `${list.slice(0, -1).map((r) => r.name).join(", ")} and ${list[list.length - 1].name}`);

/** The reminder as Camille shows it in chat. */
export function showText(r: ComplianceReminder, tz: string) {
  return `To: ${names(recipientsOf(r))}\nWhen: ${whenLine(r, tz)}\nSubject: ${r.subject}\n\n${r.body}`;
}

/** A client of the practice named in the text (the names the employees have seen in LeadDash EHR). */
async function namesAClient(orgId: number, text: string) {
  const e = await ehr();
  const known = e.knownNames(orgId);
  return known.length > 0 && e.redactText("hide", text, known) !== text;
}

async function tzOf(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}

/** The team, or a sentence saying why it can't be read. */
async function teamOrWhy(orgId: number): Promise<{ team: Member[] } | { why: string }> {
  try {
    const t = await (await ehr()).team(orgId);
    if (!t) return { why: "LeadDash EHR isn't connected yet, so I can't see the team. Connect it on Integrations." };
    return { team: t };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { why: /404/.test(m) ? "LeadDash EHR doesn't share the team yet. It needs its latest update deployed." : `I couldn't read the team from LeadDash EHR: ${m}` };
  }
}

export type DraftInput = { to: string; subject: string; body: string; date: string; time: string; repeat: string };
export type Outcome = { ok: boolean; text: string; reminder?: ComplianceReminder; ask?: string[] };

const repeatOf = (s: string): Repeat => (/week/i.test(s) ? "weekly" : /month/i.test(s) ? "monthly" : "none");

/** Writes the reminder and keeps it as a draft for the person to approve in chat. */
export async function draft(orgId: number, input: DraftInput): Promise<Outcome> {
  const subject = input.subject.replace(/\s+/g, " ").trim().slice(0, 140);
  const body = input.body.trim().slice(0, 4000);
  if (!input.to.trim()) return { ok: false, text: "Who should get it?", ask: ["All clinicians", "Everyone"] };
  if (!subject || !body) return { ok: false, text: "What should the reminder say?" };
  if (await namesAClient(orgId, `${subject} ${body}`)) return { ok: false, text: "That reminder names a client. Reminders to staff carry counts only, so I left it unsent. Want me to write it with counts instead?", ask: ["Use counts only"] };
  const t = await teamOrWhy(orgId);
  if ("why" in t) return { ok: false, text: t.why };
  const { found, missing } = matchRecipients(t.team, input.to);
  if (!found.length) return { ok: false, text: `I couldn't find ${missing.join(", ") || "them"} on the team in LeadDash EHR. Who should get it?`, ask: ["All clinicians", "Everyone"] };
  const tz = await tzOf(orgId);
  const r = db.reminders.add({ organizationId: orgId, recipients: JSON.stringify(found), subject, body, sendAt: sendTimeOf(input.date, input.time, tz), repeat: repeatOf(input.repeat), status: "draft" });
  const noEmail = found.filter((f) => !t.team.find((m) => m.id === f.id)?.email);
  const notes = [missing.length ? `I couldn't find ${missing.join(", ")} on the team, so they're left off.` : "", noEmail.length ? `${names(noEmail)} ${noEmail.length === 1 ? "has" : "have"} no email in LeadDash EHR, so only a push reaches them.` : ""].filter(Boolean).join(" ");
  return { ok: true, reminder: r, text: `Here's the reminder. It goes out when you say.\n\n${showText(r, tz)}${notes ? `\n\n${notes}` : ""}`, ask: ["Send it", "Change it", "Cancel it"] };
}

const OPEN = new Set(["draft", "scheduled", "failed"]);

/** The reminder the person means: words from its subject or someone it goes to, or the newest one still open. */
export function findOpen(orgId: number, words: string) {
  const open = db.reminders.list(orgId).filter((r) => OPEN.has(r.status));
  const w = norm(words);
  if (!w) return open[0] ?? null;
  return open.find((r) => norm(r.subject).includes(w) || recipientsOf(r).some((p) => norm(p.name).includes(w))) ?? open.find((r) => w.split(" ").some((x) => x.length > 2 && norm(r.subject).includes(x))) ?? null;
}

export type ChangeInput = Partial<DraftInput> & { target: string };

/** Changes a reminder that hasn't finished: who, what, when, or how often. */
export async function change(orgId: number, input: ChangeInput): Promise<Outcome> {
  const r = findOpen(orgId, input.target);
  if (!r) return { ok: false, text: "I don't have a reminder waiting to change. Want me to write one?" };
  const tz = await tzOf(orgId);
  const patch: Partial<ComplianceReminder> = {};
  if (input.to?.trim()) {
    const t = await teamOrWhy(orgId);
    if ("why" in t) return { ok: false, text: t.why };
    const { found, missing } = matchRecipients(t.team, input.to);
    if (!found.length) return { ok: false, text: `I couldn't find ${missing.join(", ")} on the team in LeadDash EHR.` };
    patch.recipients = JSON.stringify(found);
  }
  if (input.subject?.trim()) patch.subject = input.subject.replace(/\s+/g, " ").trim().slice(0, 140);
  if (input.body?.trim()) patch.body = input.body.trim().slice(0, 4000);
  if (input.date || input.time) patch.sendAt = sendTimeOf(input.date ?? "", input.time ?? "", tz);
  if (input.repeat?.trim()) patch.repeat = /stop|once|none|no longer/i.test(input.repeat) ? "none" : repeatOf(input.repeat);
  if (await namesAClient(orgId, `${patch.subject ?? r.subject} ${patch.body ?? r.body}`)) return { ok: false, text: "That change names a client. Reminders to staff carry counts only, so I kept it as it was." };
  if (r.status === "scheduled" && patch.sendAt === null) patch.status = "draft";
  if (r.status === "failed") patch.status = "draft";
  const next = db.reminders.update(r.id, patch);
  const waiting = next.status === "scheduled" ? "It stays on the schedule." : "It goes out when you say.";
  return { ok: true, reminder: next, text: `Changed. ${waiting}\n\n${showText(next, tz)}`, ask: next.status === "scheduled" ? ["Looks good", "Cancel it"] : ["Send it", "Change it", "Cancel it"] };
}

/** The person said to send it: now, or at the time on it. */
export async function approve(orgId: number, target: string, by: string): Promise<Outcome> {
  const r = findOpen(orgId, target);
  if (!r) return { ok: false, text: "I don't have a reminder waiting. Want me to write one?" };
  const tz = await tzOf(orgId);
  if (r.sendAt && new Date(r.sendAt).getTime() > Date.now() + 60_000) {
    const next = db.reminders.update(r.id, { status: "scheduled", approvedBy: by });
    return { ok: true, reminder: next, text: `Scheduled. "${next.subject}" goes to ${names(recipientsOf(next))} ${whenLine(next, tz)}.` };
  }
  const sent = await sendNow(db.reminders.update(r.id, { approvedBy: by }), tz);
  return { ok: sent.ok, reminder: sent.reminder, text: sent.text };
}

/** Sends one reminder now through LeadDash EHR and records what happened. A repeating one is set for its next time. */
export async function sendNow(r: ComplianceReminder, tz: string, now = new Date()): Promise<Outcome> {
  const people = recipientsOf(r);
  try {
    const res = await (await ehr()).remind(r.organizationId, { userIds: people.map((p) => p.id), subject: r.subject, text: r.body });
    const when = now;
    const reached = res.sent.map((s) => s.name || people.find((p) => p.id === s.id)?.name || "someone");
    const missed = res.skipped.map((s) => `${s.name || people.find((p) => p.id === s.id)?.name || "someone"} (${s.reason})`);
    const result = [reached.length ? `Sent to ${reached.join(", ")}` : "", missed.length ? `Not sent to ${missed.join(", ")}` : ""].filter(Boolean).join(". ");
    if (!reached.length) {
      const next = db.reminders.update(r.id, { status: "failed", lastResult: result || "Nobody could be reached." });
      return { ok: false, reminder: next, text: `It didn't go out. ${next.lastResult}.` };
    }
    let after = nextAfter(r.sendAt && new Date(r.sendAt).getTime() <= when.getTime() ? new Date(r.sendAt) : when, r.repeat, tz);
    // A server that was down past several times sends once, then picks up at the next time still ahead.
    for (let i = 0; after && after.getTime() <= when.getTime() && i < 60; i++) after = nextAfter(after, r.repeat, tz);
    const next = db.reminders.update(r.id, { status: after ? "scheduled" : "sent", sendAt: after ?? r.sendAt, lastSentAt: when, sentCount: r.sentCount + 1, lastResult: result });
    return { ok: true, reminder: next, text: `${result}.${after ? ` Next one goes out ${whenLine(next, tz)}.` : ""}` };
  } catch (err) {
    const m = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const next = db.reminders.update(r.id, { status: "failed", lastResult: m });
    return { ok: false, reminder: next, text: /404/.test(m) ? "LeadDash EHR can't send reminders yet. It needs its latest update deployed." : `It didn't go out: ${m}` };
  }
}

/** Stops a reminder: a draft, a scheduled one, or the rest of a repeating one. */
export function cancel(orgId: number, target: string): Outcome {
  const r = findOpen(orgId, target);
  if (!r) return { ok: false, text: "There's no reminder waiting to stop." };
  const next = db.reminders.update(r.id, { status: "cancelled" });
  return { ok: true, reminder: next, text: `Stopped. "${next.subject}" won't go out${next.repeat !== "none" ? " again" : ""}.` };
}

/** What's waiting and what went out lately, for chat. */
export async function listText(orgId: number) {
  const tz = await tzOf(orgId);
  const all = db.reminders.list(orgId);
  const open = all.filter((r) => OPEN.has(r.status));
  const done = all.filter((r) => r.status === "sent" || (r.status === "scheduled" && r.sentCount > 0)).slice(0, 5);
  const label = (r: ComplianceReminder) => (r.status === "draft" ? "waiting for you" : r.status === "failed" ? `didn't go out (${r.lastResult})` : whenLine(r, tz));
  const lines = [
    open.length ? "Waiting:" : "Nothing waiting.",
    ...open.map((r) => `- "${r.subject}" to ${names(recipientsOf(r))}: ${label(r)}`),
    ...(done.length ? ["Sent lately:", ...done.map((r) => `- "${r.subject}" to ${names(recipientsOf(r))}, last sent ${r.lastSentAt ? new Date(r.lastSentAt).toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }) : ""}`)] : []),
  ];
  return lines.join("\n");
}

/** Lines for Camille's prompt: the team and its licenses, and her reminders. */
export async function remindersFacts(orgId: number) {
  const tz = await tzOf(orgId);
  let teamLine = "";
  try {
    const t = await (await ehr()).team(orgId);
    if (t) {
      const today = localYmd(new Date(), tz);
      const soon = new Date(`${today}T12:00:00Z`);
      soon.setUTCDate(soon.getUTCDate() + 90);
      const limit = soon.toISOString().slice(0, 10);
      const { longDate } = await ehr();
      const lic = t.flatMap((m) => m.licenses.filter((l) => l.expires && l.expires.slice(0, 10) <= limit).map((l) => `${m.name}: ${[l.type, l.state].filter(Boolean).join(" ")} license ${l.expires!.slice(0, 10) < today ? "expired" : "expires"} ${longDate(l.expires!.slice(0, 10))}`));
      teamLine = `\nThe team in LeadDash EHR (${t.length}): ${t.map((m) => `${m.name} (${m.role}${m.seesClients ? ", sees clients" : ""}${m.licenses.length ? `; ${m.licenses.map((l) => [l.type, l.state].filter(Boolean).join(" ") + (l.expires ? ` to ${longDate(l.expires.slice(0, 10))}` : ", no expiry on file")).join(", ")}` : ""}${m.email ? "" : "; no email on file"})`).join("; ")}.\nLicenses expired or expiring in the next 90 days: ${lic.join("; ") || "none on file"}.`;
    }
  } catch {
    teamLine = "\nThe team couldn't be read from LeadDash EHR just now.";
  }
  const all = db.reminders.list(orgId);
  const open = all.filter((r) => OPEN.has(r.status)).slice(0, 10);
  return `${teamLine}\nYour reminders: ${open.map((r) => `"${r.subject}" to ${names(recipientsOf(r))} (${r.status === "draft" ? "draft, waiting for the person" : r.status === "failed" ? "failed" : whenLine(r, tz)})`).join("; ") || "none waiting"}.`;
}

/** Scheduled reminders whose time has come, every workspace; each result is posted in Camille's chat. */
export async function remindersTick(now = new Date()) {
  let n = 0;
  for (const r of db.reminders.due(now)) {
    const tz = await tzOf(r.organizationId);
    const out = await sendNow(r, tz, now);
    n++;
    const camille = await db.getEmployeeByKind(r.organizationId, "compliance");
    if (camille) await db.createChatMessage({ organizationId: r.organizationId, employeeId: camille.id, role: "employee", authorName: camille.name, content: `Reminder "${r.subject}": ${out.text}`, cards: null });
  }
  return n;
}
