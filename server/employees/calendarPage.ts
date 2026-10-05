import * as db from "../db";
import * as integrations from "../integrations";
import type { AIEmployee, LaunchTask, OutboundItem } from "../../drizzle/schema";
import { schedule, type EventExtra } from "./calendars";
import { nextRun, partsIn, zonedToUtc } from "./schedule";

/**
 * The Calendar page: every connected calendar, the tasks and deadlines in the
 * app, and what the AI team has on, in one Day, Week or Month view. Also the
 * next meeting to join, and who is working on what.
 *
 * Busy-times-only calendars stay that way here: "Busy", with no name, link,
 * place or guests.
 */

const DAY = 86_400_000;
const MIN = 60_000;

export const TASK_COLOR = "#b4610f";
export const TEAM_COLOR = "#5b6b64";
export const FOCUS_COLOR = "#7c8a84";

export type CalItem = {
  key: string;
  /** event: a calendar event or a meeting Simone set. task: a due date. team: what an employee has on. focus: focus time from Avery's rules. */
  kind: "event" | "task" | "team" | "focus";
  /** Which checkbox shows it: "cal:<id>", "tasks", "team" or "focus". */
  source: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  calendar: string;
  color: string;
  busy: boolean;
  /** Who it belongs to (a task's owner, the employee). */
  who: string | null;
  /** Where Open goes in the app. */
  link: string | null;
  meeting: { platform: "zoom" | "meet"; url: string } | null;
  host: boolean;
  location: string;
  guests: string[];
  /** Avery's notetaker for this meeting. */
  notes: { id: number; status: string; choice: string; locked: boolean } | null;
  precallId: number | null;
  late: boolean;
};

export type Source = { key: string; name: string; color: string };

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

async function tzOf(orgId: number) {
  return (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
}

/** Midnight where the workspace is, for a YYYY-MM-DD plus some days. */
function midnight(ymd: string, plus: number, tz: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + plus, 12));
  return zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz);
}

function ymdOf(d: Date, tz: string) {
  const p = partsIn(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

const base = (x: Pick<CalItem, "key" | "kind" | "source" | "title" | "start" | "end" | "allDay" | "calendar" | "color"> & Partial<CalItem>): CalItem => ({
  busy: false,
  who: null,
  link: null,
  meeting: null,
  host: false,
  location: "",
  guests: [],
  notes: null,
  precallId: null,
  late: false,
  ...x,
});

const NOUN: Record<string, [string, string]> = {
  social_post: ["post", "posts"],
  blog_post: ["article", "articles"],
  email_draft: ["email", "emails"],
  outreach_email: ["outreach email", "outreach emails"],
  speaking_pitch: ["pitch", "pitches"],
  hiring_email: ["hiring email", "hiring emails"],
  lead_reply: ["lead reply", "lead replies"],
};

function empLink(e: Pick<AIEmployee, "id" | "kind">, work = false) {
  return e.kind === "custom" ? `/chats/e/${e.id}` : `/chats/${e.kind}${work ? "/work" : ""}`;
}

/** Meetings with a link: the notetaker row and the pre-call report that go with each. */
function decorate(orgId: number, items: CalItem[], extras: Map<string, EventExtra | undefined>, notetaker: Awaited<ReturnType<typeof db.listNotetaker>>) {
  const reports = db.cold.precall.list(orgId).filter((r) => r.status === "ready" || r.status === "done");
  for (const it of items) {
    if (it.kind !== "event" || it.allDay || it.busy) continue;
    const x = extras.get(it.key);
    const row = (x?.eventId && notetaker.find((n) => n.eventId === x.eventId)) || notetaker.find((n) => Math.abs(n.startsAt.getTime() - it.start.getTime()) < 5 * MIN && n.title === it.title);
    if (row) it.notes = { id: row.id, status: row.status, choice: row.choice, locked: !!row.lockReason };
    const r = reports.find((p) => (p.meetingAt && Math.abs(new Date(p.meetingAt).getTime() - it.start.getTime()) < 45 * MIN) || (p.practice && it.title.toLowerCase().includes(p.practice.toLowerCase())));
    if (r) it.precallId = r.id;
  }
}

/** Calendar events, plus Simone's meetings that aren't on a connected calendar yet. */
async function eventsIn(orgId: number, from: Date, to: Date) {
  const s = await schedule(orgId, from, to).catch(() => ({ events: [], failed: ["Calendars"], sources: 0, tz: "" }));
  const items: CalItem[] = [];
  const extras = new Map<string, EventExtra | undefined>();
  const sources = new Map<string, Source>();
  for (const e of s.events) {
    if (e.end <= from || e.start >= to) continue;
    const key = `e:${e.sourceId}:${e.extra?.eventId ?? ""}:${e.start.getTime()}:${e.title}`;
    const src = `cal:${e.sourceId}`;
    if (!sources.has(src)) sources.set(src, { key: src, name: e.calendar, color: e.color });
    extras.set(key, e.extra);
    items.push(
      base({
        key,
        kind: "event",
        source: src,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        calendar: e.calendar,
        color: e.color,
        busy: !e.extra,
        meeting: e.extra?.meeting ?? null,
        host: e.extra?.host ?? false,
        location: e.extra?.location ?? "",
        guests: e.extra?.guests ?? [],
      })
    );
  }
  for (const m of await db.listMeetings(orgId)) {
    const start = new Date(m.startsAt);
    if (m.status === "cancelled" || start < new Date(from.getTime() - DAY) || start >= to) continue;
    const end = new Date(start.getTime() + m.minutes * MIN);
    if (end <= from) continue;
    if (items.some((e) => !e.allDay && Math.abs(e.start.getTime() - start.getTime()) < 10 * MIN && (e.title === m.title || (m.calendarEventId && extras.get(e.key)?.eventId === m.calendarEventId)))) continue;
    if (!sources.has("cal:meetings")) sources.set("cal:meetings", { key: "cal:meetings", name: "Meetings", color: "#1b6b4a" });
    const people = parse<{ name: string; email: string }[]>(m.attendees, []);
    items.push(
      base({
        key: `m:${m.id}`,
        kind: "event",
        source: "cal:meetings",
        title: m.title,
        start,
        end,
        allDay: false,
        calendar: "Meetings",
        color: "#1b6b4a",
        meeting: m.link && /^https:\/\//.test(m.link) ? { platform: m.linkKind, url: m.link } : null,
        host: true,
        guests: people.map((p) => p.name || p.email).slice(0, 30),
        link: "/chats/coo/work",
      })
    );
  }
  return { items, extras, sources: Array.from(sources.values()), failed: s.failed, connected: s.sources > 0 || items.length > 0 };
}

/** Everything due: project tasks, decisions with a date, application deadlines, and promises. */
async function dueIn(orgId: number, from: Date, to: Date, now: Date) {
  const out: CalItem[] = [];
  const emps = await db.listEmployeesByOrg(orgId);
  const inRange = (d: Date) => d >= from && d < to;
  const allDay = (d: Date, tz: string) => {
    const s = midnight(ymdOf(d, tz), 0, tz);
    return { start: s, end: new Date(s.getTime() + DAY) };
  };
  const tz = await tzOf(orgId);
  for (const t of await db.listOrgLaunchTasks(orgId)) {
    if (t.status === "done") continue;
    const due = new Date(t.dueDate);
    if (!inRange(due)) continue;
    out.push(base({ key: `t:${t.id}`, kind: "task", source: "tasks", title: t.title, ...allDay(due, tz), allDay: true, calendar: "Tasks and deadlines", color: TASK_COLOR, who: t.ownerName, link: "/chats/projects/work", late: due.getTime() < now.getTime() }));
  }
  const owner = await (await import("./desk")).ownerName(orgId);
  for (const d of db.desk.decisions.list(orgId)) {
    if (d.status !== "open" && d.status !== "later") continue;
    if (!d.dueAt || !inRange(new Date(d.dueAt))) continue;
    out.push(base({ key: `d:${d.id}`, kind: "task", source: "tasks", title: `Decide: ${d.title}`, ...allDay(new Date(d.dueAt), tz), allDay: true, calendar: "Tasks and deadlines", color: "#a1432a", who: owner, link: "/chats/inbox/work?tab=decisions", late: new Date(d.dueAt).getTime() < now.getTime() }));
  }
  for (const o of await db.listOpps(orgId)) {
    if (o.status !== "applying" || !o.deadline || !/^\d{4}-\d{2}-\d{2}$/.test(o.deadline)) continue;
    const due = midnight(o.deadline, 0, tz);
    if (!inRange(due)) continue;
    const emp = emps.find((e) => e.id === o.employeeId);
    out.push(base({ key: `o:${o.id}`, kind: "task", source: "tasks", title: `Deadline: ${o.title}`, start: due, end: new Date(due.getTime() + DAY), allDay: true, calendar: "Tasks and deadlines", color: TASK_COLOR, who: emp?.name ?? null, link: emp ? empLink(emp, true) : "/approvals" }));
  }
  for (const w of db.desk.waiting.list(orgId)) {
    if (w.status !== "open" || w.kind !== "promise" || !w.expectedAt || !inRange(new Date(w.expectedAt))) continue;
    out.push(base({ key: `w:${w.id}`, kind: "task", source: "tasks", title: `Promised ${w.who}: ${w.what}`, ...allDay(new Date(w.expectedAt), tz), allDay: true, calendar: "Tasks and deadlines", color: TASK_COLOR, who: owner, link: "/chats/inbox/work?tab=waiting", late: new Date(w.expectedAt).getTime() < now.getTime() }));
  }
  return out;
}

/** Each scheduled task's runs between two times. */
function runsBetween(t: { repeat: any; time: string; weekday: number | null; monthDay: number | null; onDate: string | null }, tz: string, from: Date, to: Date) {
  const out: Date[] = [];
  let at = nextRun(t, tz, new Date(from.getTime() - 1));
  while (at && at < to && out.length < 62) {
    out.push(at);
    at = nextRun(t, tz, at);
  }
  return out;
}

/** What the AI team has on: scheduled tasks and the posts, articles and emails going out, one chip per employee and day. */
async function teamIn(orgId: number, from: Date, to: Date) {
  const tz = await tzOf(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const out: CalItem[] = [];
  for (const t of await db.listScheduledTasks(orgId)) {
    if (!t.enabled) continue;
    const emp = emps.find((e) => e.id === t.employeeId);
    if (!emp) continue;
    for (const at of runsBetween(t, tz, from, to)) {
      const s = midnight(ymdOf(at, tz), 0, tz);
      out.push(base({ key: `r:${t.id}:${at.getTime()}`, kind: "team", source: "team", title: `${emp.name}: ${t.title}`, start: s, end: new Date(s.getTime() + DAY), allDay: true, calendar: "Team work", color: TEAM_COLOR, who: emp.name, link: "/tasks" }));
    }
  }
  const groups = new Map<string, OutboundItem[]>();
  for (const i of await db.listOutboundItemsByOrg(orgId)) {
    if (!NOUN[i.kind] || !i.employeeId) continue;
    if (!["pending_approval", "approved", "scheduled", "published"].includes(i.status)) continue;
    const when = i.status === "published" && i.publishedAt ? new Date(i.publishedAt) : i.scheduledFor ? new Date(i.scheduledFor) : null;
    if (!when || when < from || when >= to) continue;
    const k = `${i.employeeId}:${i.kind}:${ymdOf(when, tz)}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const [k, list] of Array.from(groups.entries())) {
    const emp = emps.find((e) => e.id === list[0].employeeId);
    if (!emp) continue;
    const [one, many] = NOUN[list[0].kind];
    const s = midnight(k.split(":")[2], 0, tz);
    const waiting = list.filter((i) => i.status === "pending_approval").length;
    out.push(
      base({
        key: `p:${k}`,
        kind: "team",
        source: "team",
        title: `${emp.name}: ${list.length === 1 ? list[0].title.slice(0, 60) : `${list.length} ${many}`}${list.length === 1 ? ` (${one})` : ""}`,
        start: s,
        end: new Date(s.getTime() + DAY),
        allDay: true,
        calendar: "Team work",
        color: TEAM_COLOR,
        who: emp.name,
        link: waiting ? "/approvals" : empLink(emp, true),
      })
    );
  }
  return out;
}

/** Focus time from Avery's rules, on the days it applies. */
async function focusIn(orgId: number, fromYmd: string, days: number, tz: string) {
  const { rulesOf } = await import("./desk");
  const r = rulesOf(orgId).time;
  if (!r.focusFrom || !r.focusTo || !r.focusDays.length) return [];
  const out: CalItem[] = [];
  const [fh, fm] = r.focusFrom.split(":").map(Number);
  const [th, tm] = r.focusTo.split(":").map(Number);
  for (let i = 0; i < days; i++) {
    const day = midnight(fromYmd, i, tz);
    const p = partsIn(new Date(day.getTime() + 12 * 3600_000), tz);
    if (!r.focusDays.includes(p.wd)) continue;
    const start = zonedToUtc(p.y, p.m, p.d, fh, fm, tz);
    const end = zonedToUtc(p.y, p.m, p.d, th, tm, tz);
    if (end > start) out.push(base({ key: `f:${p.y}-${p.m}-${p.d}`, kind: "focus", source: "focus", title: "Focus time", start, end, allDay: false, calendar: "Focus time", color: FOCUS_COLOR, link: "/chats/inbox/work?tab=rules" }));
  }
  return out;
}

/** Everything for the days shown, from a YYYY-MM-DD for 1 to 42 days. */
export async function calendarRange(orgId: number, fromYmd: string, days: number, now = new Date()) {
  const tz = await tzOf(orgId);
  const n = Math.max(1, Math.min(42, Math.round(days)));
  const from = midnight(fromYmd, 0, tz);
  const to = midnight(fromYmd, n, tz);
  const [ev, due, team, focus, notetaker] = await Promise.all([eventsIn(orgId, from, to), dueIn(orgId, from, to, now), teamIn(orgId, from, to), focusIn(orgId, fromYmd, n, tz), db.listNotetaker(orgId)]);
  decorate(orgId, ev.items, ev.extras, notetaker);
  const items = [...ev.items, ...focus, ...due, ...team].sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay));
  const sources: Source[] = [...ev.sources];
  if (focus.length) sources.push({ key: "focus", name: "Focus time", color: FOCUS_COLOR });
  sources.push({ key: "tasks", name: "Tasks and deadlines", color: TASK_COLOR }, { key: "team", name: "Team work", color: TEAM_COLOR });
  return { tz, today: ymdOf(now, tz), from, to, items, sources, failed: ev.failed, connected: ev.connected };
}

// ==========================================
// The next meeting to join
// ==========================================

/** The next meeting with a Zoom or Meet link in the coming week, or the one going on now. */
export async function nextMeeting(orgId: number, now = new Date()) {
  const tz = await tzOf(orgId);
  const from = new Date(now.getTime() - 4 * 3600_000);
  const to = new Date(now.getTime() + 7 * DAY);
  const [ev, notetaker] = await Promise.all([eventsIn(orgId, from, to), db.listNotetaker(orgId)]);
  const list = ev.items.filter((e) => !e.allDay && e.meeting && e.end.getTime() > now.getTime()).sort((a, b) => a.start.getTime() - b.start.getTime());
  const next = list[0];
  if (!next) return { tz, meeting: null };
  decorate(orgId, [next], ev.extras, notetaker);
  return { tz, meeting: next };
}

/** For Start on Zoom: the host's start link when the owner's Zoom account runs the meeting, else the join link. */
export async function startLink(orgId: number, url: string, canStart: boolean) {
  const clean = url.trim();
  if (!/^https:\/\/([\w-]+\.)?(zoom\.us|meet\.google\.com)\//i.test(clean)) return { url: null, started: false };
  const id = clean.match(/zoom\.us\/(?:j|w|s)\/(\d{9,12})/i)?.[1];
  if (!id || !canStart) return { url: clean, started: false };
  if ((await db.getConnectionByProvider(orgId, "zoom"))?.status !== "connected") return { url: clean, started: false };
  try {
    const s = await integrations.zoomStartUrl(orgId, id);
    if (s) return { url: s, started: true };
  } catch {
    /* Not this account's meeting, or Zoom is down: join instead. */
  }
  return { url: clean, started: false };
}

// ==========================================
// Who's on what
// ==========================================

export type WhoRow = {
  key: string;
  group: "people" | "ai";
  name: string;
  role: string;
  kind: string | null;
  avatarUrl: string | null;
  now: string;
  next: string;
  status: { label: string; tone: "green" | "amber" | "red" | "grey" };
  needsYou: number;
  due: { title: string; at: Date; late: boolean }[];
  waiting: string[];
  done: string[];
  doneCount: number;
  calendar: { title: string; at: Date }[];
  chat: string | null;
  work: string | null;
};

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member", reviewer: "Reviewer" };

function fmtWhen(d: Date, tz: string) {
  return d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDay(d: Date, tz: string) {
  return d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function ownsTask(t: LaunchTask, m: { name: string | null; email: string }) {
  if (t.ownerType !== "person") return false;
  if (t.ownerEmail && m.email && t.ownerEmail.toLowerCase() === m.email.toLowerCase()) return true;
  const full = (m.name ?? "").trim().toLowerCase();
  const own = t.ownerName.trim().toLowerCase();
  return !!full && (own === full || own === full.split(" ")[0]);
}

export async function whoView(orgId: number, now = new Date()) {
  const tz = await tzOf(orgId);
  const desk = await import("./desk");
  const { taskState } = await import("./projects");
  const [members, emps, tasks, queue, activity, logs, scheduled, ownerName] = await Promise.all([
    db.listMembers(orgId),
    db.listEmployeesByOrg(orgId),
    db.listOrgLaunchTasks(orgId),
    desk.queue(orgId),
    db.listActivity(orgId, 400),
    db.listAuditLogsByOrg(orgId, 400),
    db.listScheduledTasks(orgId),
    desk.ownerName(orgId),
  ]);
  const week = now.getTime() - 7 * DAY;
  const open = tasks.filter((t) => t.status !== "done").sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  const rows: WhoRow[] = [];

  // Today's calendar, for the owner's "now".
  const day = midnight(ymdOf(now, tz), 0, tz);
  const today = (await eventsIn(orgId, day, new Date(day.getTime() + DAY)).catch(() => null))?.items.filter((e) => e.kind === "event" && !e.allDay) ?? [];
  const current = today.find((e) => e.start <= now && e.end > now);
  const coming = today.find((e) => e.start > now);

  for (const m of members.filter((x) => x.role !== "reviewer")) {
    const mine = open.filter((t) => ownsTask(t, m));
    const behind = mine.filter((t) => taskState(t, now).key === "behind");
    const isOwner = m.role === "owner";
    const decisions = isOwner ? queue.filter((q) => q.who === "you") : queue.filter((q) => q.who === "team");
    const doing = mine.find((t) => t.status === "in_progress") ?? mine[0];
    const nowText = isOwner && current ? `${current.busy ? "Busy" : current.title}, until ${current.end.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}` : doing ? doing.title : isOwner && today.length ? "No meeting right now" : "Nothing assigned";
    const nextTask = mine.find((t) => t !== doing);
    const nextText = isOwner && coming ? `${coming.busy ? "Busy" : coming.title}, ${coming.start.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}` : nextTask ? `${nextTask.title}, due ${fmtDay(new Date(nextTask.dueDate), tz)}` : decisions.length ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"} waiting` : "";
    const status: WhoRow["status"] =
      isOwner && decisions.length ? { label: `${decisions.length} decision${decisions.length === 1 ? "" : "s"} waiting`, tone: "amber" } : behind.length ? { label: "Behind", tone: "red" } : mine.length ? { label: "On track", tone: "green" } : { label: "Nothing assigned", tone: "grey" };
    rows.push({
      key: `m:${m.userId}`,
      group: "people",
      name: m.name || m.email,
      role: ROLE[m.role] ?? m.role,
      kind: null,
      avatarUrl: m.avatarUrl,
      now: nowText,
      next: nextText,
      status,
      needsYou: 0,
      due: mine.slice(0, 5).map((t) => ({ title: t.title, at: new Date(t.dueDate), late: new Date(t.dueDate).getTime() < now.getTime() })),
      waiting: decisions.slice(0, 4).map((q) => q.title),
      done: tasks.filter((t) => t.status === "done" && ownsTask(t, m) && t.doneAt && new Date(t.doneAt).getTime() > week).slice(0, 3).map((t) => t.title),
      doneCount: tasks.filter((t) => t.status === "done" && ownsTask(t, m) && t.doneAt && new Date(t.doneAt).getTime() > week).length,
      calendar: isOwner ? today.filter((e) => e.start > now).slice(0, 3).map((e) => ({ title: e.busy ? "Busy" : e.title, at: e.start })) : [],
      chat: null,
      work: isOwner ? "/chats/inbox/work?tab=decisions" : null,
    });
  }

  for (const e of emps) {
    const mine = open.filter((t) => t.ownerType === "employee" && (t.ownerKind === e.kind || t.ownerName === e.name));
    const behind = mine.filter((t) => taskState(t, now).key === "behind");
    const asks = queue.filter((q) => q.from.includes(e.name));
    const lines = [
      ...activity.filter((a) => a.employeeId === e.id).map((a) => ({ at: new Date(a.createdAt), text: a.text, done: a.kind !== "handoff" })),
      ...logs.filter((l) => l.actorType === "employee" && l.actorName === e.name).map((l) => ({ at: new Date(l.createdAt), text: l.details ? `${l.action}: ${l.details}` : l.action, done: true })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const recent = lines.find((l) => l.at.getTime() > now.getTime() - 36 * 3600_000);
    const doneWeek = lines.filter((l) => l.done && l.at.getTime() > week);
    const runs = scheduled
      .filter((t) => t.enabled && t.employeeId === e.id)
      .flatMap((t) => runsBetween(t, tz, now, new Date(now.getTime() + 7 * DAY)).slice(0, 3).map((at) => ({ title: t.title, at })))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const firstDue = mine[0];
    const nextText = runs[0] ? `${runs[0].title}, ${fmtWhen(runs[0].at, tz)}` : firstDue ? `${firstDue.title}, due ${fmtDay(new Date(firstDue.dueDate), tz)}` : "";
    const status: WhoRow["status"] =
      e.status === "paused"
        ? { label: "Paused", tone: "grey" }
        : asks.length
          ? { label: "Needs you", tone: "red" }
          : behind.length
            ? { label: "Behind", tone: "amber" }
            : e.status === "working"
              ? { label: "Working", tone: "green" }
              : { label: "Ready", tone: "green" };
    rows.push({
      key: `e:${e.id}`,
      group: "ai",
      name: e.name,
      role: e.roleTitle,
      kind: e.kind,
      avatarUrl: e.avatar ?? null,
      now: recent ? recent.text.slice(0, 140) : e.status === "paused" ? "Paused" : "Nothing yet today",
      next: nextText,
      status,
      needsYou: asks.length,
      due: mine.slice(0, 5).map((t) => ({ title: t.title, at: new Date(t.dueDate), late: new Date(t.dueDate).getTime() < now.getTime() })),
      waiting: asks.slice(0, 4).map((q) => q.title),
      done: doneWeek.slice(0, 3).map((l) => l.text.slice(0, 140)),
      doneCount: doneWeek.length,
      calendar: runs.slice(0, 3),
      chat: empLink(e),
      work: e.kind === "custom" ? null : empLink(e, true),
    });
  }
  return { tz, owner: ownerName, rows };
}
