import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, DeskDecision, DeskWaiting, EmployeeKind, LaunchTask } from "../../drizzle/schema";
import { notify } from "../notify";
import { partsIn, zonedToUtc } from "./schedule";
import { handoff } from "./team";

/**
 * Avery's desk: one queue for everything that needs a person.
 *
 * - Decisions: what employees need decided. Approvals the employees already
 *   keep (posts, pitches, keyframes, applications, replies) are read live and
 *   grouped; everything else (a launch price from Nora, a still-waiting item)
 *   is a desk decision. Repeats from several employees become one request.
 * - Who decides: the owner, or anyone on the team (Caroline at LeadDash,
 *   Angela at Legacy). Some kinds are the owner's only; the server enforces it.
 * - Waiting: what others owe the owner, with the nudge Avery sends, and what
 *   the owner promised, with who is on it.
 * - Today: the top three, the day's meetings with their prep, what's off
 *   track, and what was handled. The 7:30 AM brief posts it in Avery's chat.
 * - People: what each person on the team did in the app, for the Activity page.
 */

const DAY = 86_400_000;

// ==========================================
// Rules
// ==========================================

export const CATEGORIES = [
  { key: "price", label: "Prices and fees" },
  { key: "contract", label: "Contracts" },
  { key: "press", label: "Reporters" },
  { key: "legal", label: "Legal" },
  { key: "clinical", label: "Clinical" },
  { key: "event", label: "Event pitches" },
  { key: "keyframes", label: "Keyframes" },
  { key: "guideline", label: "Employee guidelines" },
  { key: "post", label: "Posts and articles" },
  { key: "reply", label: "Replies and emails" },
  { key: "hiring", label: "Hiring" },
] as const;
export type Category = (typeof CATEGORIES)[number]["key"] | "spend" | "other";
const CATEGORY_KEYS = new Set<string>([...CATEGORIES.map((c) => c.key), "spend", "other"]);

export const DUTIES = [
  { key: "scheduling", label: "Scheduling emails" },
  { key: "move_internal", label: "Move internal meetings" },
  { key: "decline", label: "Decline by your rules" },
  { key: "followups", label: "Follow-ups" },
  { key: "handoffs", label: "Hand off requests" },
  { key: "accept_outside", label: "Accept outside meetings" },
  { key: "new_people", label: "Emails to someone new" },
  { key: "money", label: "Anything that costs money" },
] as const;
/** Duties that always ask first, whatever the rules say. */
const ALWAYS_ASK = new Set(["new_people", "money"]);
export const NEVER = "Contracts, prices and fees, reporters, legal questions, clinical calls. These are fixed.";

export type TimeRules = {
  meetFrom: string;
  meetTo: string;
  meetDays: number[];
  focusFrom: string;
  focusTo: string;
  focusDays: number[];
  maxHours: number | null;
  buffer: number | null;
  demoDays: number[];
  afterTalk: number | null;
};

export type DeskRules = {
  onlyYou: string[];
  spendLimitCents: number | null;
  /** duty key: "own" (does it on her own) or "ask" (asks first). */
  duties: Record<string, "own" | "ask">;
  time: TimeRules;
  first: string;
  normal: string;
  wait: string;
  briefTime: string;
  briefDays: number[];
};

export const DEFAULT_RULES: DeskRules = {
  onlyYou: ["price", "contract", "press", "legal", "clinical"],
  spendLimitCents: null,
  duties: { scheduling: "own", move_internal: "own", decline: "own", followups: "own", handoffs: "own", accept_outside: "ask", new_people: "ask", money: "ask" },
  time: { meetFrom: "09:00", meetTo: "17:00", meetDays: [1, 2, 3, 4, 5], focusFrom: "", focusTo: "", focusDays: [], maxHours: null, buffer: 15, demoDays: [], afterTalk: null },
  first: "Customers, founding members, reporters on a deadline, event planners booking you, family",
  normal: "Active leads, partners, vendors",
  wait: "Cold pitches, newsletters, invites with no agenda",
  briefTime: "07:30",
  briefDays: [1, 2, 3, 4, 5],
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const days = (v: unknown, fallback: number[]) => (Array.isArray(v) ? Array.from(new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))).sort() : fallback);
const num = (v: unknown, max: number) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : null);
const hhmm = (v: unknown, fallback: string) => (typeof v === "string" && (TIME_RE.test(v) || v === "") ? v : fallback);

export function rulesOf(orgId: number): DeskRules {
  let saved: Partial<DeskRules> = {};
  try {
    saved = JSON.parse(db.desk.getSettings(orgId)?.rules || "{}");
  } catch {
    saved = {};
  }
  return cleanRules(saved);
}

export function cleanRules(r: Partial<DeskRules>): DeskRules {
  const d = DEFAULT_RULES;
  const t: Partial<TimeRules> = r.time ?? {};
  const duties: Record<string, "own" | "ask"> = { ...d.duties };
  for (const k of DUTIES.map((x) => x.key)) {
    const v = r.duties?.[k];
    if (v === "own" || v === "ask") duties[k] = v;
    if (ALWAYS_ASK.has(k)) duties[k] = "ask";
  }
  const text = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim().slice(0, 400) : fallback);
  return {
    onlyYou: Array.isArray(r.onlyYou) ? Array.from(new Set(r.onlyYou.filter((k) => typeof k === "string" && CATEGORY_KEYS.has(k)))) : d.onlyYou,
    spendLimitCents: r.spendLimitCents === undefined ? d.spendLimitCents : num(r.spendLimitCents, 100_000_000),
    duties,
    time: {
      meetFrom: hhmm(t.meetFrom, d.time.meetFrom),
      meetTo: hhmm(t.meetTo, d.time.meetTo),
      meetDays: days(t.meetDays, d.time.meetDays),
      focusFrom: hhmm(t.focusFrom, d.time.focusFrom),
      focusTo: hhmm(t.focusTo, d.time.focusTo),
      focusDays: days(t.focusDays, d.time.focusDays),
      maxHours: t.maxHours === undefined ? d.time.maxHours : num(t.maxHours, 16),
      buffer: t.buffer === undefined ? d.time.buffer : num(t.buffer, 240),
      demoDays: days(t.demoDays, d.time.demoDays),
      afterTalk: t.afterTalk === undefined ? d.time.afterTalk : num(t.afterTalk, 24),
    },
    first: text(r.first, d.first),
    normal: text(r.normal, d.normal),
    wait: text(r.wait, d.wait),
    briefTime: hhmm(r.briefTime, d.briefTime) || d.briefTime,
    briefDays: days(r.briefDays, d.briefDays),
  };
}

export function saveRules(orgId: number, r: Partial<DeskRules>) {
  const next = cleanRules({ ...rulesOf(orgId), ...r, time: { ...rulesOf(orgId).time, ...(r.time ?? {}) } });
  db.desk.saveSettings(orgId, { rules: JSON.stringify(next) });
  return next;
}

export const label = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? (k === "spend" ? "Spending" : "Everything else");

/** "you" when only the owner may make it, "team" when anyone on the team may. */
export function whoDecides(rules: DeskRules, category: string, amountCents?: number | null): "you" | "team" {
  if (category === "spend" || (amountCents ?? 0) > 0) {
    if (rules.spendLimitCents !== null && (amountCents ?? 0) > rules.spendLimitCents) return "you";
    if (category === "spend") return rules.onlyYou.includes("spend") ? "you" : "team";
  }
  return rules.onlyYou.includes(category) ? "you" : "team";
}

export async function ownerName(orgId: number) {
  const members = await db.listMembers(orgId);
  const owner = members.find((m) => m.role === "owner");
  const org = await db.getOrganizationById(orgId);
  // "Dr. Ashley Bryant" is Ashley, not "Dr.".
  return (owner?.name || org?.signerName || "the owner").trim().replace(/^(dr|mr|mrs|ms|mx)\.?\s+/i, "").split(" ")[0];
}

/** Throws unless this role may make a decision of this kind. Owners and LeadDash support always may. */
export async function assertDecide(orgId: number, role: string, category: string, amountCents?: number | null) {
  if (role === "owner") return;
  if (whoDecides(rulesOf(orgId), category, amountCents) === "you") {
    throw new TRPCError({ code: "FORBIDDEN", message: `Only ${await ownerName(orgId)} can decide ${label(category).toLowerCase()}. You can add a note on Avery's Decisions tab.` });
  }
}

/** The category for an item in Approvals. */
export function categoryOfItem(kind: string): Category {
  if (kind === "social_post" || kind === "blog_post") return "post";
  if (kind === "speaking_pitch") return "event";
  if (kind === "hiring_email") return "hiring";
  if (kind === "calendar_hold") return "other";
  return "reply";
}

/** A guess at the category from the words, for decisions an employee raises. */
export function categoryOfText(text: string): Category {
  const t = text.toLowerCase();
  if (/\b(price|pricing|fee|fees|rate|discount|charge)\b/.test(t)) return "price";
  if (/\b(contract|agreement|sign|signature|terms|nda|baa)\b/.test(t)) return "contract";
  if (/\b(reporter|journalist|press|media|interview|quote)\b/.test(t)) return "press";
  if (/\b(legal|lawyer|attorney|lawsuit|subpoena|trademark)\b/.test(t)) return "legal";
  if (/\b(clinical|diagnos|treatment|client care)\b/.test(t)) return "clinical";
  if (/\b(budget|spend|purchase|buy|invoice|pay for)\b/.test(t)) return "spend";
  if (/\b(hire|hiring|candidate|job offer)\b/.test(t)) return "hiring";
  if (/\b(keyframe)/.test(t)) return "keyframes";
  if (/\b(speak|keynote|conference|event)\b/.test(t)) return "event";
  if (/\b(post|article|blog)\b/.test(t)) return "post";
  return "other";
}

// ==========================================
// Decisions
// ==========================================

type Option = { label: string; text: string; source: string };
type Note = { by: string; text: string; at: string };

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for", "with", "this", "that", "our", "your"].includes(w)));
/** Two titles that ask for the same thing. */
export function sameAsk(a: string, b: string) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of Array.from(x)) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.7;
}

export type RaiseInput = {
  fromKind: EmployeeKind | "avery" | "person";
  title: string;
  why?: string;
  category?: Category;
  urgency?: "now" | "today" | "week";
  dueAt?: Date | null;
  project?: string;
  minutes?: number | null;
  amountCents?: number | null;
  options?: Option[];
  suggested?: number | null;
  suggestedWhy?: string;
  link?: string | null;
  sourceKey?: string | null;
};

/** An employee needs a decision. A repeat of an open one (same source, or the same ask from another employee) is merged into it. */
export async function raiseDecision(orgId: number, input: RaiseInput) {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "A decision needs a title." });
  const open = db.desk.decisions.list(orgId).filter((d) => d.status === "open" || d.status === "later");
  const same = (input.sourceKey ? db.desk.decisionBySource(orgId, input.sourceKey) : null) ?? open.find((d) => sameAsk(d.title, title)) ?? null;
  if (same && same.status !== "decided" && same.status !== "sent_back") {
    const from = Array.from(new Set([...parse<string[]>(same.fromKinds, []), input.fromKind]));
    const merged = db.desk.decisions.update(same.id, orgId, {
      fromKinds: JSON.stringify(from),
      why: same.why || input.why?.slice(0, 1000) || "",
      dueAt: input.dueAt && (!same.dueAt || input.dueAt < new Date(same.dueAt)) ? input.dueAt : same.dueAt,
      urgency: rank(input.urgency ?? "week") < rank(same.urgency) ? input.urgency : same.urgency,
      options: parse<Option[]>(same.options, []).length ? same.options : JSON.stringify((input.options ?? []).slice(0, 4)),
      ...(same.status === "later" && input.urgency === "now" ? { status: "open" as const } : {}),
    })!;
    return { decision: merged, merged: true };
  }
  if (same) return { decision: same, merged: true };
  const category = input.category ?? categoryOfText(`${title} ${input.why ?? ""}`);
  const created = db.desk.decisions.create({
    organizationId: orgId,
    title,
    why: (input.why ?? "").slice(0, 1000),
    category,
    urgency: input.urgency ?? urgencyFor(input.dueAt ?? null, orgId),
    dueAt: input.dueAt ?? null,
    fromKinds: JSON.stringify([input.fromKind]),
    project: (input.project ?? "").slice(0, 160),
    minutes: input.minutes ?? null,
    amountCents: input.amountCents ?? null,
    options: JSON.stringify((input.options ?? []).slice(0, 4).map((o) => ({ label: o.label.slice(0, 40), text: o.text.slice(0, 300), source: (o.source ?? "").slice(0, 80) }))),
    suggested: input.suggested ?? null,
    suggestedWhy: (input.suggestedWhy ?? "").slice(0, 400),
    link: input.link ?? null,
    sourceKey: input.sourceKey ?? null,
  });
  await tellDeciders(orgId, created).catch(() => null);
  return { decision: created, merged: false };
}

const rank = (u: string) => (u === "now" ? 0 : u === "today" ? 1 : 2);

function urgencyFor(due: Date | null, orgId?: number): "now" | "today" | "week" {
  if (!due) return "week";
  const h = (new Date(due).getTime() - Date.now()) / 3_600_000;
  void orgId;
  if (h <= 6) return "now";
  if (h <= 36) return "today";
  return "week";
}

/** A push notice for a new decision, only to the people who may make it. */
async function tellDeciders(orgId: number, d: DeskDecision) {
  const rules = rulesOf(orgId);
  const members = await db.listMembers(orgId);
  const who = whoDecides(rules, d.category, d.amountCents);
  const ids = members.filter((m) => m.role === "owner" || (who === "team" && m.role !== "reviewer" && m.role !== "chat")).map((m) => m.userId);
  await notify(orgId, "approval", { title: "Avery: a decision is waiting", body: d.title, url: "/chats/inbox/work?tab=decisions", tag: `desk-${d.id}` }, { only: ids });
}

export type QueueItem = {
  key: string;
  source: "desk" | "approvals" | "application" | "keyframes" | "press" | "cold";
  id: number | null;
  title: string;
  why: string;
  from: string[];
  category: string;
  categoryLabel: string;
  who: "you" | "team";
  urgency: "now" | "today" | "week";
  dueAt: Date | null;
  link: string | null;
  project: string;
  minutes: number | null;
  options: Option[];
  suggested: number | null;
  suggestedWhy: string;
  notes: Note[];
  count: number;
};

const NOUN: Record<string, [string, string]> = {
  social_post: ["social post ready", "social posts ready"],
  blog_post: ["article ready", "articles ready"],
  email_draft: ["email draft", "email drafts"],
  calendar_hold: ["calendar hold", "calendar holds"],
  speaking_pitch: ["event pitch", "event pitches"],
  hiring_email: ["hiring email", "hiring emails"],
  outreach_email: ["outreach sequence", "outreach sequences"],
  lead_reply: ["reply to a new lead", "replies to new leads"],
};

async function empNames(orgId: number) {
  const emps = await db.listEmployeesByOrg(orgId);
  const byKind = new Map(emps.map((e) => [e.kind as string, e.name]));
  const byId = new Map(emps.map((e) => [e.id, e]));
  byKind.set("avery", byKind.get("inbox") ?? "Avery");
  return { emps, byKind, byId, name: (k: string) => byKind.get(k) ?? (k === "person" ? "The team" : k) };
}

/** Everything open that needs a person, in one list, most urgent first. */
export async function queue(orgId: number): Promise<QueueItem[]> {
  const rules = rulesOf(orgId);
  const names = await empNames(orgId);
  const out: QueueItem[] = [];
  const now = Date.now();
  const base = (x: Partial<QueueItem> & Pick<QueueItem, "key" | "source" | "title" | "category">): QueueItem => ({
    id: null,
    why: "",
    from: [],
    who: whoDecides(rules, x.category),
    categoryLabel: label(x.category),
    urgency: "week",
    dueAt: null,
    link: null,
    project: "",
    minutes: null,
    options: [],
    suggested: null,
    suggestedWhy: "",
    notes: [],
    count: 1,
    ...x,
  });

  // Decisions employees raised.
  for (const d of db.desk.decisions.list(orgId)) {
    if (d.status === "decided" || d.status === "sent_back") continue;
    if (d.status === "later" && d.laterUntil && new Date(d.laterUntil).getTime() > now) continue;
    out.push(
      base({
        key: `desk:${d.id}`,
        source: "desk",
        id: d.id,
        title: d.title,
        why: d.why,
        from: parse<string[]>(d.fromKinds, []).map(names.name),
        category: d.category,
        who: whoDecides(rules, d.category, d.amountCents),
        urgency: d.dueAt ? urgencyFor(new Date(d.dueAt)) : d.urgency,
        dueAt: d.dueAt ? new Date(d.dueAt) : null,
        link: d.link,
        project: d.project,
        minutes: d.minutes,
        options: parse<Option[]>(d.options, []),
        suggested: d.suggested,
        suggestedWhy: d.suggestedWhy,
        notes: parse<Note[]>(d.notes, []),
      })
    );
  }

  // Approvals the employees keep, grouped by employee and kind.
  const pending = (await db.listOutboundItemsByOrg(orgId)).filter((i) => i.status === "pending_approval" && !(i.kind === "outreach_email" && (parse<{ step?: number }>(i.metadata, {}).step ?? 1) > 1));
  const groups = new Map<string, typeof pending>();
  for (const i of pending) {
    const k = `${i.employeeId ?? 0}:${i.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const [k, items] of Array.from(groups.entries())) {
    const emp = items[0].employeeId ? names.byId.get(items[0].employeeId) : null;
    const [one, many] = NOUN[items[0].kind] ?? ["item waiting", "items waiting"];
    const cat = categoryOfItem(items[0].kind);
    const soonest = items.map((i) => (i.scheduledFor ? new Date(i.scheduledFor) : null)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    out.push(
      base({
        key: `approvals:${k}`,
        source: "approvals",
        title: items.length === 1 ? `${items[0].title.slice(0, 90)} (${one})` : `${items.length} ${many}`,
        why: items.length === 1 ? "" : items.slice(0, 3).map((i) => i.title).join("; "),
        from: emp ? [emp.name] : [],
        category: cat,
        urgency: items[0].kind === "lead_reply" || items[0].kind === "email_draft" ? "today" : soonest ? urgencyFor(soonest) : "week",
        dueAt: soonest,
        link: "/approvals",
        count: items.length,
      })
    );
  }

  // Applications that need a signature.
  for (const a of (await db.listApplications(orgId)).filter((x) => x.status === "ready")) {
    const opp = await db.getOpportunityForOrg(a.opportunityId, orgId).catch(() => null);
    const due = opp?.deadline ? new Date(`${opp.deadline}T23:59:00`) : null;
    const emp = a.employeeId ? names.byId.get(a.employeeId) : null;
    out.push(base({ key: `application:${a.id}`, source: "application", id: a.id, title: `Sign and submit: ${a.title}`, category: "contract", from: emp ? [emp.name] : [], dueAt: due && !Number.isNaN(due.getTime()) ? due : null, urgency: due && !Number.isNaN(due.getTime()) ? urgencyFor(due) : "week", link: "/approvals" }));
  }

  // Elena's keyframes.
  for (const e of db.listDramaEpisodes(orgId).filter((x) => x.status === "keyframes")) {
    out.push(base({ key: `keyframes:${e.id}`, source: "keyframes", id: e.id, title: `Keyframes for ${e.kind === "campaign" ? e.title : `Episode ${e.number}`}`, category: "keyframes", from: [names.name("video")], link: `/chats/video/work?tab=${e.kind === "campaign" ? "campaigns" : "episodes"}` }));
  }

  // Taylor's pitches and reporter replies.
  const pitches = db.press.pitches.list(orgId).filter((p) => p.status === "ready" || p.status === "weak");
  if (pitches.length) out.push(base({ key: "press:pitches", source: "press", title: `${pitches.length} pitch${pitches.length === 1 ? "" : "es"} to reporters`, category: "press", from: [names.name("speaking")], link: "/chats/speaking/work", count: pitches.length, urgency: "today" }));
  const pressReplies = db.press.replies.list(orgId).filter((r) => r.status === "open" && r.draft?.trim());
  if (pressReplies.length) out.push(base({ key: "press:replies", source: "press", title: `${pressReplies.length} answer${pressReplies.length === 1 ? "" : "s"} to reporters`, category: "press", from: [names.name("speaking")], link: "/chats/speaking/work", count: pressReplies.length, urgency: "now" }));

  // Jada's cold email replies that wait for a person.
  const cold = db.cold.replies.list(orgId).filter((r) => r.status === "open" && r.draft?.trim());
  if (cold.length) {
    const hot = cold.filter((r) => r.kind === "hot" || r.kind === "demo").length;
    out.push(base({ key: "cold:replies", source: "cold", title: `${cold.length} cold email repl${cold.length === 1 ? "y" : "ies"} to answer${hot ? ` (${hot} hot)` : ""}`, category: "reply", from: [names.name("outreach")], link: "/chats/outreach/work", count: cold.length, urgency: hot ? "today" : "week" }));
  }

  return out.sort((a, b) => rank(a.urgency) - rank(b.urgency) || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
}

/** What was decided today, and by whom. */
export async function decidedToday(orgId: number) {
  const tz = await tzOf(orgId);
  const start = startOfDay(new Date(), tz);
  const names = await empNames(orgId);
  const out: { key: string; result: "Approved" | "Sent back" | "Decided"; title: string; from: string; by: string; at: Date; link: string | null }[] = [];
  for (const d of db.desk.decisions.list(orgId)) {
    if (!d.decidedAt || new Date(d.decidedAt) < start || (d.status !== "decided" && d.status !== "sent_back")) continue;
    out.push({ key: `desk:${d.id}`, result: d.status === "sent_back" ? "Sent back" : "Decided", title: d.choice ? `${d.title}: ${d.choice}` : d.title, from: parse<string[]>(d.fromKinds, []).map(names.name).join(", "), by: d.decidedBy ?? "", at: new Date(d.decidedAt), link: d.link });
  }
  const items = await db.listOutboundItemsByOrg(orgId);
  for (const l of db.desk.peopleLog(orgId, start)) {
    if (l.action !== "Approved" && l.action !== "Sent back") continue;
    const m = /"([^"]+)"/.exec(l.details ?? "");
    const title = m?.[1] ?? l.details ?? "";
    const item = items.find((i) => i.title === title);
    const emp = item?.employeeId ? names.byId.get(item.employeeId) : null;
    out.push({ key: `log:${l.id}`, result: l.action as "Approved" | "Sent back", title, from: emp?.name ?? "", by: l.actorName, at: new Date(l.createdAt), link: "/approvals" });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 30);
}

async function decisionFor(orgId: number, id: number) {
  const d = db.desk.decisions.get(id, orgId);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That decision isn't on Avery's desk." });
  return d;
}

/** A person decides. The employees who asked hear about it, and a Nora task it came from is closed. */
export async function decide(orgId: number, id: number, input: { choice?: string; by: string; role: string; userId?: number | null }) {
  const d = await decisionFor(orgId, id);
  if (d.status === "decided") throw new TRPCError({ code: "BAD_REQUEST", message: "That one is already decided." });
  await assertDecide(orgId, input.role, d.category, d.amountCents);
  const options = parse<Option[]>(d.options, []);
  const picked = input.choice?.trim() ? options.find((o) => o.label.toLowerCase() === input.choice!.trim().toLowerCase())?.label ?? input.choice.trim().slice(0, 200) : options[d.suggested ?? -1]?.label ?? "Approved";
  const next = db.desk.decisions.update(id, orgId, { status: "decided", choice: picked, decidedBy: input.by, decidedAt: new Date() })!;
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: input.by, userId: input.userId ?? null, action: "Decided", details: `${d.title}: ${picked}.`, data: JSON.stringify({ kind: "decision", id }) });
  await closeSource(orgId, d, `${input.by} decided: ${picked}.`);
  for (const k of parse<string[]>(d.fromKinds, [])) {
    if (k === "avery" || k === "person" || k === "inbox") continue;
    await handoff(orgId, "inbox", k as EmployeeKind, `${input.by} decided "${d.title}": ${picked}.`).catch(() => null);
  }
  return next;
}

export async function sendBack(orgId: number, id: number, input: { note: string; by: string; role: string; userId?: number | null }) {
  const d = await decisionFor(orgId, id);
  await assertDecide(orgId, input.role, d.category, d.amountCents);
  const notes = [...parse<Note[]>(d.notes, []), { by: input.by, text: input.note.trim().slice(0, 600), at: new Date().toISOString() }].filter((n) => n.text);
  const next = db.desk.decisions.update(id, orgId, { status: "sent_back", notes: JSON.stringify(notes), decidedBy: input.by, decidedAt: new Date() })!;
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: input.by, userId: input.userId ?? null, action: "Sent back", details: `"${d.title}".${input.note ? ` Note: ${input.note}` : ""}` });
  for (const k of parse<string[]>(d.fromKinds, [])) {
    if (k === "avery" || k === "person" || k === "inbox") continue;
    await handoff(orgId, "inbox", k as EmployeeKind, `${input.by} sent back "${d.title}"${input.note ? `: ${input.note}` : "."}`).catch(() => null);
  }
  return next;
}

/** Later: off the list until tomorrow at the brief time. Anyone on the team may do it. */
export async function later(orgId: number, id: number, by: string) {
  const d = await decisionFor(orgId, id);
  const until = new Date(Date.now() + DAY);
  const next = db.desk.decisions.update(id, orgId, { status: "later", laterUntil: until })!;
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: by, action: "Moved to later", details: `"${d.title}" until tomorrow.` });
  return next;
}

/** A note on a decision. Anyone on the team may add one, including on decisions only the owner makes. */
export async function addNote(orgId: number, id: number, by: string, text: string) {
  const d = await decisionFor(orgId, id);
  const t = text.trim().slice(0, 600);
  if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "Type a note first." });
  const notes = [...parse<Note[]>(d.notes, []), { by, text: t, at: new Date().toISOString() }];
  const next = db.desk.decisions.update(id, orgId, { notes: JSON.stringify(notes) })!;
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: by, action: "Added a note", details: `On "${d.title}": ${t}` });
  return next;
}

async function closeSource(orgId: number, d: DeskDecision, note: string) {
  const m = /^task:(\d+)$/.exec(d.sourceKey ?? "");
  if (m) {
    const t = await db.getLaunchTask(Number(m[1]), orgId);
    if (t && t.status !== "done") await db.updateLaunchTask(t.id, orgId, { status: "done", doneAt: new Date(), note });
  }
  const w = /^waiting:(\d+):escalate$/.exec(d.sourceKey ?? "");
  if (w) db.desk.waiting.update(Number(w[1]), orgId, { escalateAt: new Date(Date.now() + 3 * DAY) });
}

// ==========================================
// From Nora: work only a person can do
// ==========================================

/**
 * Nora's plan tasks owned by a person (a price, a signature, an approval)
 * become decisions from Nora; tasks a person took on in a meeting become
 * promises; and tasks someone outside owes become waiting items.
 */
export async function syncFromNora(orgId: number) {
  const members = await db.listMembers(orgId);
  const firsts = new Set(members.map((m) => (m.name || "").trim().split(" ")[0].toLowerCase()).filter(Boolean));
  const emails = new Set(members.map((m) => m.email.toLowerCase()));
  const isMember = (t: LaunchTask) => (t.ownerEmail && emails.has(t.ownerEmail.toLowerCase())) || firsts.has(t.ownerName.trim().split(" ")[0].toLowerCase()) || /^(you|the owner|owner)$/i.test(t.ownerName.trim());
  for (const launch of (await db.listLaunches(orgId)).filter((l) => l.status === "active")) {
    for (const t of await db.listLaunchTasks(launch.id, orgId)) {
      const key = `task:${t.id}`;
      if (t.status === "done") {
        const d = db.desk.decisionBySource(orgId, key);
        if (d && (d.status === "open" || d.status === "later")) db.desk.decisions.update(d.id, orgId, { status: "decided", choice: "Done in the plan", decidedBy: t.ownerName, decidedAt: t.doneAt ?? new Date() });
        const w = db.desk.waitingBySource(orgId, key);
        if (w && w.status === "open") db.desk.waiting.update(w.id, orgId, { status: "done", doneAt: t.doneAt ?? new Date(), doneBy: t.ownerName });
        continue;
      }
      if (t.ownerType === "person" && isMember(t)) {
        if (t.source === "plan" || t.source.startsWith("launch")) {
          if (!db.desk.decisionBySource(orgId, key)) await raiseDecision(orgId, { fromKind: "projects", title: t.title, why: t.details ?? t.doneWhen ?? "", project: launch.name, dueAt: new Date(t.dueDate), link: "/chats/projects/work", sourceKey: key });
        } else if (!db.desk.waitingBySource(orgId, key)) {
          addWaiting(orgId, { kind: "promise", who: launch.name === "Team action items" ? "The team" : launch.name, what: t.title, owner: "you", expectedAt: new Date(t.dueDate), heardIn: t.source.startsWith("meeting") ? "Meeting notes" : "", plan: t.details ?? "", sourceKey: key, mine: t.ownerName });
        }
      } else if (t.ownerType === "person" && !db.desk.waitingBySource(orgId, key)) {
        addWaiting(orgId, { kind: "owed", who: t.ownerName, email: t.ownerEmail ?? "", what: t.title, blocks: launch.name === "Team action items" ? "" : /launch$/i.test(launch.name) ? `The ${launch.name}` : `The ${launch.name} launch`, askedAt: new Date(t.createdAt), owner: "avery", expectedAt: new Date(t.dueDate), sourceKey: key });
      }
    }
  }
}

// ==========================================
// Waiting: what others owe, what the owner promised
// ==========================================

export function nudgeText(input: { who: string; what: string; askedAt?: Date | null; expectedAt?: Date | null; blocks?: string; owner: string; tz: string }) {
  const first = input.who.trim().split(" ")[0] || "there";
  const d = (x: Date) => x.toLocaleDateString("en-US", { timeZone: input.tz, month: "long", day: "numeric" });
  const asked = input.askedAt ? ` from ${d(input.askedAt)}` : "";
  const due = input.expectedAt ? ` Is it still on track for ${d(input.expectedAt)}?` : " Is it still on track?";
  const blocks = input.blocks ? ` ${input.blocks} is ready to move once it comes in.` : "";
  return {
    subject: `Checking on ${input.what.slice(0, 80)}`,
    body: `Hi ${first},\n\nChecking on ${input.what}${asked}.${due}${blocks}\n\nThank you,\nAvery, for ${input.owner}`,
  };
}

export function addWaiting(
  orgId: number,
  input: { kind: "owed" | "promise"; who: string; email?: string; what: string; blocks?: string; owner?: string; askedAt?: Date | null; expectedAt?: Date | null; heardIn?: string; plan?: string; sourceKey?: string | null; mine?: string }
) {
  const what = input.what.trim().slice(0, 300);
  if (!what) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what's owed." });
  const expected = input.expectedAt && !Number.isNaN(new Date(input.expectedAt).getTime()) ? new Date(input.expectedAt) : null;
  const nudgeAt = input.kind === "owed" && expected ? new Date(expected.getTime() + DAY) : null;
  return db.desk.waiting.create({
    organizationId: orgId,
    kind: input.kind,
    who: input.who.trim().slice(0, 160) || "Someone",
    email: (input.email ?? "").trim().slice(0, 200),
    what,
    blocks: (input.blocks ?? "").slice(0, 300),
    owner: (input.owner ?? (input.kind === "owed" ? "avery" : "you")).slice(0, 40),
    heardIn: (input.heardIn ?? "").slice(0, 400),
    plan: (input.plan ?? (input.mine ? `${input.mine} has it.` : "")).slice(0, 600),
    askedAt: input.askedAt ?? new Date(),
    expectedAt: expected,
    nudgeAt,
    escalateAt: nudgeAt ? new Date(nudgeAt.getTime() + 4 * DAY) : null,
    sourceKey: input.sourceKey ?? null,
  });
}

async function waitingFor(orgId: number, id: number) {
  const w = db.desk.waiting.get(id, orgId);
  if (!w) throw new TRPCError({ code: "NOT_FOUND", message: "That item isn't on Avery's list." });
  return w;
}

export async function saveWaiting(orgId: number, id: number, input: { who?: string; email?: string; what?: string; blocks?: string; expectedAt?: Date | null; nudgeAt?: Date | null; nudgeSubject?: string; nudgeBody?: string; plan?: string; owner?: string }) {
  await waitingFor(orgId, id);
  const data: Partial<DeskWaiting> = {};
  if (input.who !== undefined) data.who = input.who.trim().slice(0, 160);
  if (input.email !== undefined) data.email = input.email.trim().slice(0, 200);
  if (input.what !== undefined && input.what.trim()) data.what = input.what.trim().slice(0, 300);
  if (input.blocks !== undefined) data.blocks = input.blocks.slice(0, 300);
  if (input.expectedAt !== undefined) data.expectedAt = input.expectedAt;
  if (input.nudgeAt !== undefined) data.nudgeAt = input.nudgeAt;
  if (input.nudgeSubject !== undefined) data.nudgeSubject = input.nudgeSubject.slice(0, 200);
  if (input.nudgeBody !== undefined) data.nudgeBody = input.nudgeBody.slice(0, 4000);
  if (input.plan !== undefined) data.plan = input.plan.slice(0, 600);
  if (input.owner !== undefined) data.owner = input.owner.slice(0, 40);
  return db.desk.waiting.update(id, orgId, data)!;
}

export async function finishWaiting(orgId: number, id: number, how: "done" | "dismissed" | "mine", by: string) {
  const w = await waitingFor(orgId, id);
  const next =
    how === "mine"
      ? db.desk.waiting.update(id, orgId, { owner: "you", plan: `${by} is doing it.` })!
      : db.desk.waiting.update(id, orgId, { status: how, doneBy: by, doneAt: new Date() })!;
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: by, action: how === "done" ? "Marked done" : how === "mine" ? "Took it on" : "Not a promise", details: `"${w.what}"${w.kind === "owed" ? ` from ${w.who}` : ` to ${w.who}`}.` });
  return next;
}

/** The nudge goes out now as an email from the owner's Gmail. A person pressed Send, so it's approved. */
export async function sendNudge(orgId: number, id: number, by: string | null) {
  const w = await waitingFor(orgId, id);
  if (w.kind !== "owed") throw new TRPCError({ code: "BAD_REQUEST", message: "Only things someone owes get a nudge." });
  if (!w.email) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Add ${w.who}'s email with Edit nudge first.` });
  const avery = await db.getEmployeeByKind(orgId, "inbox");
  const tz = await tzOf(orgId);
  const t = nudgeText({ who: w.who, what: w.what, askedAt: w.askedAt, expectedAt: w.expectedAt, blocks: w.blocks, owner: await fullOwnerName(orgId), tz });
  const item = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: avery?.id ?? null,
    kind: "email_draft",
    status: by ? "approved" : "pending_approval",
    title: w.nudgeSubject || t.subject,
    body: w.nudgeBody || t.body,
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ recipient: w.who, email: w.email, whatTheyWant: `Nudge: ${w.what}`, urgency: "today", newEmail: true, nudge: w.id }),
    ...(by ? { approvedBy: by, approvedAt: new Date() } : {}),
  });
  db.desk.waiting.update(id, orgId, { nudgedAt: new Date(), nudgeAt: new Date(Date.now() + 3 * DAY) });
  if (by) {
    const { postNow } = await import("../social");
    await postNow(item, by, "human_user", "Sent a nudge").catch((err) => {
      throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "The nudge didn't send." });
    });
  }
  return { item, sent: !!by };
}

async function fullOwnerName(orgId: number) {
  const members = await db.listMembers(orgId);
  const org = await db.getOrganizationById(orgId);
  return org?.signerName || members.find((m) => m.role === "owner")?.name || "the owner";
}

/** Due nudges and escalations. Avery sends follow-ups on his own when the rules say so; otherwise the nudge waits in Approvals. */
export async function waitingTick(orgId: number, now = new Date()) {
  const rules = rulesOf(orgId);
  const avery = await db.getEmployeeByKind(orgId, "inbox");
  if (!avery || avery.status === "paused") return;
  for (const w of db.desk.waiting.list(orgId).filter((x) => x.status === "open" && x.kind === "owed")) {
    if (w.owner === "avery" && w.email && w.nudgeAt && new Date(w.nudgeAt) <= now && (!w.nudgedAt || new Date(w.nudgedAt).getTime() < new Date(w.nudgeAt).getTime() - DAY)) {
      if (rules.duties.followups === "own") {
        const r = await sendNudge(orgId, w.id, null).catch(() => null);
        if (r) {
          const { postNow } = await import("../social");
          await postNow(r.item, avery.name, "system", "Sent a nudge", { status: "approved", approvedBy: avery.name, approvedAt: now }).catch(() => null);
          await db.logAction({ organizationId: orgId, actorType: "employee", actorName: avery.name, action: "Sent a nudge", details: `To ${w.who}: ${w.what}` });
        }
      } else await sendNudge(orgId, w.id, null).catch(() => null);
    }
    if (w.escalateAt && new Date(w.escalateAt) <= now) {
      await raiseDecision(orgId, { fromKind: "avery", title: `Still waiting on ${w.who}: ${w.what}`, why: `Expected ${w.expectedAt ? new Date(w.expectedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "a while ago"} and still not in.${w.blocks ? ` It holds up ${w.blocks}.` : ""}`, urgency: "today", category: "other", sourceKey: `waiting:${w.id}:escalate`, link: "/chats/inbox/work?tab=waiting" });
      db.desk.waiting.update(w.id, orgId, { escalateAt: null });
    }
  }
}

export async function waitingView(orgId: number) {
  const tz = await tzOf(orgId);
  const owner = await fullOwnerName(orgId);
  const names = await empNames(orgId);
  const open = db.desk.waiting.list(orgId).filter((w) => w.status === "open");
  const ownerLabel = (o: string) => (o === "avery" ? null : o === "you" ? "You" : o === "nora" || o === "projects" ? "Nora tracks it" : `${names.name(o)} follows up`);
  const row = (w: DeskWaiting) => {
    const t = nudgeText({ who: w.who, what: w.what, askedAt: w.askedAt, expectedAt: w.expectedAt, blocks: w.blocks, owner, tz });
    return {
      id: w.id,
      kind: w.kind,
      who: w.who,
      email: w.email,
      what: w.what,
      blocks: w.blocks,
      owner: w.owner,
      ownerLabel: ownerLabel(w.owner),
      heardIn: w.heardIn,
      plan: w.plan,
      askedAt: w.askedAt,
      expectedAt: w.expectedAt,
      nudgeAt: w.owner === "avery" ? w.nudgeAt : null,
      nudgedAt: w.nudgedAt,
      escalateAt: w.escalateAt,
      nudgeSubject: w.nudgeSubject || t.subject,
      nudgeBody: w.nudgeBody || t.body,
    };
  };
  const by = (a: DeskWaiting, b: DeskWaiting) => (a.expectedAt ? new Date(a.expectedAt).getTime() : Infinity) - (b.expectedAt ? new Date(b.expectedAt).getTime() : Infinity);
  return { owed: open.filter((w) => w.kind === "owed").sort(by).map(row), promises: open.filter((w) => w.kind === "promise").sort(by).map(row) };
}

// ==========================================
// Today
// ==========================================

async function tzOf(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}
export function startOfDay(d: Date, tz: string) {
  const p = partsIn(d, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}
const at = (d: Date, hm: string, tz: string) => {
  const p = partsIn(d, tz);
  const [h, mi] = hm.split(":").map(Number);
  return zonedToUtc(p.y, p.m, p.d, h, mi, tz);
};
const timeText = (d: Date, tz: string) => d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
const range = (a: Date, b: Date, tz: string) => {
  const x = timeText(a, tz);
  const y = timeText(b, tz);
  const ax = x.slice(-2);
  return ax === y.slice(-2) ? `${x.slice(0, -3)} to ${y}` : `${x} to ${y}`;
};

type TodayEvent = { key: string; when: string; title: string; calendar: string; color: string; status: "Brief ready" | "Agenda ready" | "Protected" | null; link: string | null; start: Date };

async function todaysEvents(orgId: number, tz: string, now = new Date()): Promise<{ events: TodayEvent[]; failed: string[] }> {
  const from = startOfDay(now, tz);
  const to = new Date(from.getTime() + DAY);
  const out: TodayEvent[] = [];
  let failed: string[] = [];
  const reports = db.cold.precall.list(orgId).filter((r) => r.status === "ready" && r.meetingAt);
  const meetings = (await db.listMeetings(orgId)).filter((m) => new Date(m.startsAt) >= from && new Date(m.startsAt) < to);
  try {
    const { schedule } = await import("./calendars");
    const s = await schedule(orgId, from, to);
    failed = s.failed;
    for (const e of s.events) {
      if (e.allDay) continue;
      const start = new Date(e.start);
      const brief = reports.find((r) => Math.abs(new Date(r.meetingAt!).getTime() - start.getTime()) < 45 * 60_000 || (r.practice && e.title.toLowerCase().includes(r.practice.toLowerCase())));
      const agenda = meetings.find((m) => Math.abs(new Date(m.startsAt).getTime() - start.getTime()) < 10 * 60_000 && m.agenda);
      out.push({ key: `e:${start.getTime()}:${e.title}`, when: range(start, new Date(e.end), tz), title: e.title, calendar: e.calendar, color: e.color, status: brief ? "Brief ready" : agenda ? "Agenda ready" : null, link: brief ? "/chats/outreach/work?tab=precall" : agenda ? "/chats/coo/work" : null, start });
    }
  } catch {
    failed = ["Calendars"];
  }
  // Simone's meetings that aren't on a connected calendar yet.
  for (const m of meetings) {
    const start = new Date(m.startsAt);
    if (out.some((e) => Math.abs(e.start.getTime() - start.getTime()) < 10 * 60_000)) continue;
    out.push({ key: `m:${m.id}`, when: range(start, new Date(start.getTime() + m.minutes * 60_000), tz), title: m.title, calendar: "Meetings", color: "#1b6b4a", status: m.agenda ? "Agenda ready" : null, link: "/chats/coo/work", start });
  }
  const r = rulesOf(orgId).time;
  const wd = partsIn(now, tz).wd;
  if (r.focusFrom && r.focusTo && r.focusDays.includes(wd)) {
    const a = at(now, r.focusFrom, tz);
    out.push({ key: "focus", when: range(a, at(now, r.focusTo, tz), tz), title: "Focus time", calendar: "Your rules", color: "#5b6b64", status: "Protected", link: null, start: a });
  }
  return { events: out.sort((a, b) => a.start.getTime() - b.start.getTime()), failed };
}

type OffTrack = { key: string; who: string; text: string; link: string | null };

async function offTrack(orgId: number, now = new Date()): Promise<OffTrack[]> {
  const names = await empNames(orgId);
  const out: OffTrack[] = [];
  for (const e of db.listDramaEpisodes(orgId)) {
    const name = e.kind === "campaign" ? `"${e.title}"` : `Episode ${e.number}`;
    if (e.status === "failed") out.push({ key: `drama:${e.id}`, who: names.name("video"), text: `${name} stopped: ${(e.error ?? "").slice(0, 140)}`, link: "/chats/video/work" });
    else if (e.status === "making" && /Waiting for the video service/.test(e.progress ?? "")) out.push({ key: `drama:${e.id}`, who: names.name("video"), text: `${name} is waiting for the video service to come back. She picks it up again on her own.`, link: "/chats/video/work" });
  }
  const { taskState } = await import("./projects");
  for (const l of (await db.listLaunches(orgId)).filter((x) => x.status === "active" && x.name !== "Team action items")) {
    const behind = (await db.listLaunchTasks(l.id, orgId)).filter((t) => taskState(t, now).key === "behind");
    if (behind.length) out.push({ key: `launch:${l.id}`, who: names.name("projects"), text: `${l.name}: ${behind.length} task${behind.length === 1 ? "" : "s"} behind (${behind.slice(0, 2).map((t) => t.title).join("; ")}).`, link: "/chats/projects/work" });
  }
  for (const t of (await db.listScheduledTasks(orgId)).filter((x) => x.enabled && x.lastStatus === "failed")) {
    const emp = names.byId.get(t.employeeId);
    out.push({ key: `task:${t.id}`, who: emp?.name ?? "A task", text: `The scheduled task "${t.title}" failed on its last run.`, link: "/tasks" });
  }
  for (const w of db.desk.waiting.list(orgId).filter((x) => x.status === "open" && x.kind === "owed" && x.expectedAt && new Date(x.expectedAt).getTime() < now.getTime() - 3 * DAY)) {
    out.push({ key: `waiting:${w.id}`, who: names.name("inbox"), text: `${w.who} still owes ${w.what}.`, link: "/chats/inbox/work?tab=waiting" });
  }
  return out.slice(0, 8);
}

type Handled = { key: string; text: string; lines: { at: Date; text: string; who: string }[] };

async function handled(orgId: number, tz: string, now = new Date()) {
  const p = partsIn(now, tz);
  // Since the last workday started: Friday on a Monday.
  const back = p.wd === 1 ? 3 : p.wd === 0 ? 2 : 1;
  const since = startOfDay(new Date(now.getTime() - back * DAY), tz);
  const sinceLabel = since.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const today = startOfDay(now, tz);
  const names = await empNames(orgId);
  const members = await db.listMembers(orgId);
  const out: Handled[] = [];
  const logs = db.desk.peopleLog(orgId, today);
  for (const m of members.filter((x) => x.role !== "owner" && x.name)) {
    const lines = logs.filter((l) => l.actorName === m.name && (l.action === "Approved" || l.action === "Decided"));
    if (lines.length) out.push({ key: `person:${m.userId}`, text: `${m.name!.split(" ")[0]} approved ${lines.length} thing${lines.length === 1 ? "" : "s"} today`, lines: lines.map((l) => ({ at: new Date(l.createdAt), text: l.details ?? "", who: l.actorName })) });
  }
  const acts = (await db.listActivity(orgId, 400)).filter((a) => new Date(a.createdAt) >= since);
  const sent = acts.filter((a) => a.kind === "sent");
  const hand = acts.filter((a) => a.kind === "handoff");
  const who = (id: number | null) => (id ? names.byId.get(id)?.name ?? "" : "");
  if (sent.length) out.push({ key: "sent", text: `${sent.length} thing${sent.length === 1 ? "" : "s"} sent for you`, lines: sent.map((a) => ({ at: new Date(a.createdAt), text: a.text, who: who(a.employeeId) })) });
  if (hand.length) out.push({ key: "handoffs", text: `${hand.length} request${hand.length === 1 ? "" : "s"} handed to the right employee`, lines: hand.map((a) => ({ at: new Date(a.createdAt), text: a.text, who: who(a.employeeId) })) });
  const nudges = (await db.listAuditLogsByOrg(orgId, 300)).filter((l) => l.action === "Sent a nudge" && new Date(l.createdAt) >= since);
  if (nudges.length) out.push({ key: "nudges", text: `${nudges.length} follow-up${nudges.length === 1 ? "" : "s"} sent on things people owe you`, lines: nudges.map((l) => ({ at: new Date(l.createdAt), text: l.details ?? "", who: l.actorName })) });
  const total = out.reduce((t, h) => t + h.lines.length, 0);
  return { since: sinceLabel, rows: out, total };
}

export type TopItem = { key: string; title: string; body: string; button: "Decide" | "Read brief" | "Review" | "Open"; link: string | null; decisionKey: string | null };

export async function today(orgId: number, now = new Date()) {
  const tz = await tzOf(orgId);
  void syncFromNora(orgId).catch(() => null);
  const q = await queue(orgId);
  const { events, failed } = await todaysEvents(orgId, tz, now);
  const waiting = await waitingView(orgId);
  const h = await handled(orgId, tz, now);
  const off = await offTrack(orgId, now);
  const top: TopItem[] = [];
  const asTop = (d: QueueItem): TopItem => ({
    key: d.key,
    title: `${d.title.replace(/\.$/, "")}.`,
    body: d.from.length ? `${d.from.join(", ")} ${d.from.length === 1 ? "is" : "are"} waiting on it.${d.suggested !== null && d.options[d.suggested] ? ` Avery suggests ${d.options[d.suggested].label}.` : ""}` : "",
    button: d.source === "desk" ? "Decide" : "Review",
    link: d.source === "desk" ? null : d.link,
    decisionKey: d.key,
  });
  const meetingsWithPrep = events.filter((e) => e.status === "Brief ready" && e.start.getTime() > now.getTime() - 30 * 60_000);
  for (const d of q.filter((x) => x.urgency === "now")) top.push(asTop(d));
  for (const e of meetingsWithPrep) top.push({ key: e.key, title: `${e.title} at ${timeText(e.start, tz)}.`, body: "The pre-call report is ready.", button: "Read brief", link: e.link, decisionKey: null });
  for (const d of q.filter((x) => x.urgency !== "now")) top.push(asTop(d));
  const dateLabel = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
  return {
    date: dateLabel,
    top: top.slice(0, 3),
    counts: { decisions: q.length, meetings: events.filter((e) => e.status !== "Protected").length, waiting: waiting.owed.length + waiting.promises.length, handled: h.total },
    events: events.map(({ start, ...e }) => ({ ...e, start })),
    calendarsFailed: failed,
    offTrack: off,
    handled: h,
  };
}

// ==========================================
// The morning brief
// ==========================================

export async function briefText(orgId: number, now = new Date()) {
  const t = await today(orgId, now);
  const tz = await tzOf(orgId);
  const long = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const n = (x: number, one: string, many: string) => `${x === 0 ? "no" : x} ${x === 1 ? one : many}`;
  const head = `Good morning. ${long}: ${n(t.counts.meetings, "meeting", "meetings")} and ${n(t.counts.decisions, "decision", "decisions")}.${t.top.length ? ` Here ${t.top.length === 1 ? "is the one that matters" : `are the ${t.top.length} that matter`} most.` : " Nothing needs you right now."}`;
  const tail = `${t.handled.total ? `The team handled ${t.handled.total} thing${t.handled.total === 1 ? "" : "s"} since ${t.handled.since}.` : ""}${t.offTrack.length ? ` Off track: ${t.offTrack.slice(0, 2).map((o) => o.text).join(" ")}` : " Nothing is off track."}`;
  return { t, head, tail: tail.trim() };
}

/** 7:30 AM (or the time in the rules) on brief days: Avery posts the brief in his chat and sends a push notice. */
export async function briefTick(now = new Date()) {
  for (const orgId of await db.listAllOrganizationIds()) {
    try {
      const avery = await db.getEmployeeByKind(orgId, "inbox");
      if (!avery || avery.status === "paused") continue;
      await waitingTick(orgId, now).catch((err) => console.warn("[desk] waiting tick failed:", err instanceof Error ? err.message : err));
      const rules = rulesOf(orgId);
      const tz = await tzOf(orgId);
      const p = partsIn(now, tz);
      const ymd = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
      const [bh, bm] = rules.briefTime.split(":").map(Number);
      if (!rules.briefDays.includes(p.wd) || p.h * 60 + p.mi < bh * 60 + bm || db.desk.getSettings(orgId)?.lastBrief === ymd) continue;
      db.desk.saveSettings(orgId, { lastBrief: ymd });
      await postBrief(orgId, avery, now);
    } catch (err) {
      console.warn("[desk] brief failed:", err instanceof Error ? err.message : err);
    }
  }
}

export async function postBrief(orgId: number, avery: AIEmployee, now = new Date()) {
  const { t, head, tail } = await briefText(orgId, now);
  const msg = await db.createChatMessage({
    organizationId: orgId,
    employeeId: avery.id,
    role: "employee",
    authorName: avery.name,
    content: `${head}${tail ? `\n\n${tail}` : ""}`,
    cards: JSON.stringify([{ type: "avery_brief", id: 0, title: t.date, items: t.top, counts: t.counts }, { type: "choices", id: 0, title: "", options: ["Show all decisions", "What did you handle?"] }]),
  });
  await notify(orgId, "report", { title: `${avery.name}: your morning brief`, body: t.top.map((x) => x.title).join(" ") || "Nothing needs you right now.", url: "/chats/inbox", tag: `brief-${orgId}` });
  return msg;
}

// ==========================================
// What Avery knows in chat
// ==========================================

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayList = (d: number[]) => (d.length ? d.map((x) => DAY_NAMES[x]).join(", ") : "not set");

export async function deskFacts(orgId: number) {
  const rules = rulesOf(orgId);
  const q = await queue(orgId);
  const w = await waitingView(orgId);
  const owner = await ownerName(orgId);
  const t = rules.time;
  const own = DUTIES.filter((d) => rules.duties[d.key] === "own").map((d) => d.label.toLowerCase());
  const ask = DUTIES.filter((d) => rules.duties[d.key] === "ask").map((d) => d.label.toLowerCase());
  return `
Your desk (the Today, Decisions, Waiting and Rules tabs on your Work page):
- Open decisions (${q.length}): ${q.slice(0, 12).map((d) => `"${d.title}" from ${d.from.join(", ") || "the team"}, ${d.who === "you" ? `only ${owner} decides` : "anyone on the team decides"}${d.options.length ? `, options: ${d.options.map((o) => `${o.label} (${o.text})`).join("; ")}` : ""}${d.suggested !== null && d.options[d.suggested] ? `, you suggest ${d.options[d.suggested].label}` : ""}`).join(" | ") || "none"}.
- Waiting on others: ${w.owed.slice(0, 8).map((x) => `${x.who} owes ${x.what}`).join("; ") || "nothing"}. ${owner}'s promises: ${w.promises.slice(0, 8).map((x) => `${x.what} to ${x.who}`).join("; ") || "none"}.
- Only ${owner} decides: ${rules.onlyYou.map(label).join(", ") || "nothing extra"}${rules.spendLimitCents !== null ? `, and spending over $${(rules.spendLimitCents / 100).toFixed(0)}` : ""}. Anyone on the team decides everything else, and every decision shows who made it. Never: ${NEVER}
- You do on your own: ${own.join(", ") || "nothing"}. You ask first: ${ask.join(", ")}.
- ${owner}'s time: meetings ${t.meetFrom || "?"} to ${t.meetTo || "?"} on ${dayList(t.meetDays)}; focus time ${t.focusFrom && t.focusTo ? `${t.focusFrom} to ${t.focusTo} on ${dayList(t.focusDays)}` : "not set"}; at most ${t.maxHours ?? "no limit on"} hours of meetings a day; ${t.buffer ?? 0} minutes between meetings; demos on ${dayList(t.demoDays)}; ${t.afterTalk ? `nothing for ${t.afterTalk} hours after a talk` : "no rule after talks"}.
- Who comes first: ${rules.first}. Normal: ${rules.normal}. Can wait: ${rules.wait}.
- You own the owner's attention, calendar, promises and the decision queue. Nora owns projects, tasks and deadlines: when someone asks you to get an employee to do work, choose to_nora, never assign it yourself. Simone runs meetings and the scorecard. You sit in on the owner's Zoom and Google Meet meetings as the notetaker (never client sessions) and send the notes to Simone, who sends the recap and the action items.`;
}

/** A decision named in chat ("approve option B", "the launch price"). */
export async function findDecision(orgId: number, words: string) {
  const open = (await queue(orgId)).filter((d) => d.source === "desk");
  const w = words.trim();
  if (!w) return open[0] ?? null;
  return open.find((d) => sameAsk(d.title, w) || d.title.toLowerCase().includes(w.toLowerCase())) ?? open[0] ?? null;
}

// ==========================================
// People: what each person did in the app
// ==========================================

type PeopleRow = { id: string; at: Date; who: string; text: string; tag: string; link: string | null; before: string[] | null; after: string[] | null; where: string | null; canUndo: boolean };

function tagOf(action: string) {
  const a = action.toLowerCase();
  if (/approv|decided|submitted/.test(a)) return "Approved";
  if (/sent back|cancel/.test(a)) return "Sent back";
  if (/guideline|edited|changed|rewrote|saved/.test(a)) return "Edited";
  if (/task|assign/.test(a)) return "Assigned";
  if (/meeting|huddle|agenda|recap|notes/.test(a)) return "Meeting";
  if (/team member|invite|role/.test(a)) return "Team";
  if (/setting|turned|connect|schedule|rule/.test(a)) return "Settings";
  return "Done";
}

export async function peopleView(orgId: number, person?: string | null, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const names = await empNames(orgId);
  const members = await db.listMembers(orgId);
  const rows: PeopleRow[] = [];
  for (const l of db.desk.peopleLog(orgId, since)) {
    const data = parse<{ kind?: string; employeeId?: number; section?: string; sectionTitle?: string; before?: string[]; after?: string[]; undone?: boolean }>(l.data, {});
    const emp = data.employeeId ? names.byId.get(data.employeeId) : null;
    rows.push({
      id: `log:${l.id}`,
      at: new Date(l.createdAt),
      who: l.actorName,
      text: `${l.action}${l.details ? `: ${l.details}` : ""}`.slice(0, 400),
      tag: tagOf(l.action),
      link: emp ? `/chats/${emp.kind}/guidelines` : /approv|sent back/i.test(l.action) ? "/approvals" : null,
      before: data.kind === "guideline" ? data.before ?? [] : null,
      after: data.kind === "guideline" ? data.after ?? [] : null,
      where: data.kind === "guideline" && emp ? `${emp.name}, ${data.sectionTitle ?? data.section ?? "Guidelines"}` : null,
      canUndo: data.kind === "guideline" && !data.undone,
    });
  }
  for (const m of db.desk.peopleChats(orgId, since)) {
    if (!m.userId || /^Scheduled task/.test(m.authorName)) continue;
    const emp = names.byId.get(m.employeeId);
    if (!emp) continue;
    const snippet = m.content.replace(/\s+/g, " ").trim();
    rows.push({ id: `chat:${m.id}`, at: new Date(m.createdAt), who: m.authorName, text: `Asked ${emp.name} in chat: "${snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet}"`, tag: "Chat", link: emp.kind === "custom" ? `/chats/e/${emp.id}` : `/chats/${emp.kind}`, before: null, after: null, where: null, canUndo: false });
  }
  const people = members.map((m) => ({ userId: m.userId, name: m.name || m.email, role: m.role }));
  const shown = person ? rows.filter((r) => r.who === person || r.who.split(" ")[0] === person.split(" ")[0]) : rows;
  return { people, rows: shown.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 200), total: rows.length };
}

/** Puts a guideline back the way it was before a person's change. */
export async function undoGuideline(orgId: number, logId: number, by: string) {
  const l = db.desk.auditLine(orgId, logId);
  const data = parse<{ kind?: string; employeeId?: number; section?: string; before?: string[]; undone?: boolean }>(l?.data, {});
  if (!l || data.kind !== "guideline" || !data.employeeId || !data.section) throw new TRPCError({ code: "NOT_FOUND", message: "That change can't be undone." });
  if (data.undone) throw new TRPCError({ code: "BAD_REQUEST", message: "That change was already undone." });
  const emp = await db.getEmployeeForOrg(data.employeeId, orgId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee isn't in this workspace." });
  const { saveGuideSection } = await import("./interview");
  await saveGuideSection(emp, data.section, (data.before ?? []).map((text) => ({ text })));
  db.desk.markUndone(orgId, logId);
  await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: by, action: "Undid a guideline change", details: `${emp.name}: back to how it was before ${l.actorName}'s change.` });
  return true;
}
