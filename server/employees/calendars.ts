import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { decryptJson, encryptJson } from "../_core/crypto";
import * as integrations from "../integrations";
import type { AccountLink } from "../../drizzle/schema";
import { zonedToUtc } from "./schedule";

/**
 * Several calendars, one schedule. Avery checks every calendar connected on
 * Integrations (Google accounts, and Outlook or iCloud calendars by their
 * private link), lists them together tagged by calendar, warns when two
 * overlap, and puts holds on the calendar you name.
 *
 * A calendar set to "busy times only" gives Avery when you're booked and never
 * what the event is, so client names on a practice calendar stay out of the AI.
 *
 * The same table holds sending addresses: a second Gmail some employees send
 * from (outreach on its own domain).
 */

export const COLORS = ["#1b6b4a", "#3c4a8a", "#a1432a", "#7a3b6e", "#0f6e74", "#6b4f1d", "#8a2f3a", "#2f5d8a"];

export type CalendarEntry = { id: string; name: string; primary: boolean; include: boolean };
export type Event = { start: Date; end: Date; allDay: boolean; title: string; calendar: string; color: string; sourceId: number };

const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function calendarsOf(l: Pick<AccountLink, "calendars">) {
  return parse<CalendarEntry[]>(l.calendars, []);
}

function nextColor(orgId: number) {
  const used = new Set(db.listAccountLinks(orgId, "calendar").map((l) => l.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[db.listAccountLinks(orgId, "calendar").length % COLORS.length];
}

// ==========================================
// Connecting
// ==========================================

/** After Google sign-in for an extra account: save it (or refresh the one being reconnected). */
export async function finishLink(orgId: number, code: string, link: integrations.LinkStart) {
  const d = await integrations.exchange("google", code);
  const tokens = { accessToken: d.access_token as string, refreshToken: (d.refresh_token as string) ?? null, expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null };
  const { data: me } = await integrations.api("https://openidconnect.googleapis.com/v1/userinfo", { token: tokens.accessToken });
  const email: string | null = me.email ?? null;
  const existing = link.id ? db.getAccountLink(link.id, orgId) : null;
  if (link.purpose === "send") {
    const row = { email, secretsEncrypted: encryptJson(tokens), status: "connected" as const, error: null };
    if (existing) return db.updateAccountLink(existing.id, orgId, row)!;
    return db.createAccountLink({ organizationId: orgId, purpose: "send", kind: "google", name: link.name || email || "Sending address", sendsFor: JSON.stringify(["outreach", "leads"]), ...row });
  }
  const found = await googleCalendars(tokens.accessToken);
  // Keep the choices already made on a reconnect; new calendars start unchecked, the main one checked.
  const before = existing ? calendarsOf(existing) : [];
  const calendars = found.map((c) => ({ ...c, include: before.find((b) => b.id === c.id)?.include ?? c.primary }));
  const row = { email, secretsEncrypted: encryptJson(tokens), calendars: JSON.stringify(calendars), status: "connected" as const, error: null };
  if (existing) return db.updateAccountLink(existing.id, orgId, row)!;
  const first = !db.listAccountLinks(orgId, "calendar").some((l) => l.holds === "default");
  return db.createAccountLink({ organizationId: orgId, purpose: "calendar", kind: "google", name: link.name || email || "Google calendar", color: nextColor(orgId), holds: first ? "default" : "yes", detail: "full", ...row });
}

/** Every calendar in a Google account. Without the calendar-list permission, just the main one. */
async function googleCalendars(token: string): Promise<Omit<CalendarEntry, "include">[]> {
  try {
    const { data } = await integrations.api("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=100", { token });
    const list = (data.items ?? []).map((c: any) => ({ id: String(c.id), name: String(c.summaryOverride || c.summary || c.id), primary: Boolean(c.primary) }));
    if (list.length) return list.sort((a: { primary: boolean }, b: { primary: boolean }) => Number(b.primary) - Number(a.primary));
  } catch {
    /* fall through to the main calendar */
  }
  return [{ id: "primary", name: "Main calendar", primary: true }];
}

/** An Outlook or iCloud calendar by its private link. The link is checked before it's saved. */
export async function saveLink(orgId: number, input: { id?: number; name: string; url?: string }) {
  const name = input.name.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the calendar a name." });
  const existing = input.id ? db.getAccountLink(input.id, orgId) : null;
  if (input.id && (!existing || existing.kind !== "link")) throw new TRPCError({ code: "NOT_FOUND", message: "That calendar isn't in this workspace." });
  let url = (input.url ?? "").trim().replace(/^webcals?:\/\//i, "https://");
  if (!url && existing) return db.updateAccountLink(existing.id, orgId, { name })!;
  if (!/^https:\/\/\S+$/i.test(url)) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the calendar's private link. It starts with https:// or webcal://" });
  await icsEvents(url, new Date(), new Date(Date.now() + 86400_000)).catch((err) => {
    throw new TRPCError({ code: "BAD_REQUEST", message: `That link didn't open as a calendar (${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}).` });
  });
  const secrets = encryptJson({ url });
  if (existing) return db.updateAccountLink(existing.id, orgId, { name, secretsEncrypted: secrets, status: "connected", error: null })!;
  return db.createAccountLink({ organizationId: orgId, purpose: "calendar", kind: "link", name, color: nextColor(orgId), secretsEncrypted: secrets, calendars: JSON.stringify([{ id: "link", name, primary: true, include: true }]), holds: "no", detail: "full" });
}

/** Edit: the name, which calendars Avery checks, what he sees, and where holds go. */
export function saveCalendar(orgId: number, id: number, input: { name: string; include: string[]; detail: "full" | "busy"; holds: "default" | "yes" | "no" }) {
  const l = db.getAccountLink(id, orgId);
  if (!l || l.purpose !== "calendar") throw new TRPCError({ code: "NOT_FOUND", message: "That calendar isn't in this workspace." });
  const holds = l.kind === "link" ? "no" : input.holds;
  if (holds === "default") for (const o of db.listAccountLinks(orgId, "calendar")) if (o.id !== id && o.holds === "default") db.updateAccountLink(o.id, orgId, { holds: "yes" });
  const calendars = calendarsOf(l).map((c) => ({ ...c, include: l.kind === "link" ? true : input.include.includes(c.id) }));
  return db.updateAccountLink(id, orgId, { name: input.name.trim() || l.name, detail: input.detail, holds, calendars: JSON.stringify(calendars) })!;
}

export function saveSender(orgId: number, id: number, input: { name: string; sendsFor: string[] }) {
  const l = db.getAccountLink(id, orgId);
  if (!l || l.purpose !== "send") throw new TRPCError({ code: "NOT_FOUND", message: "That address isn't in this workspace." });
  // One address per job: an employee moved here stops sending from any other.
  for (const o of db.listAccountLinks(orgId, "send")) {
    if (o.id === id) continue;
    const rest = parse<string[]>(o.sendsFor, []).filter((k) => !input.sendsFor.includes(k));
    db.updateAccountLink(o.id, orgId, { sendsFor: JSON.stringify(rest) });
  }
  return db.updateAccountLink(id, orgId, { name: input.name.trim() || l.name, sendsFor: JSON.stringify(Array.from(new Set(input.sendsFor))) })!;
}

export function remove(orgId: number, id: number) {
  const l = db.getAccountLink(id, orgId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That isn't in this workspace." });
  db.deleteAccountLink(id, orgId);
  // Holds need a home: the next Google calendar takes over.
  if (l.holds === "default") {
    const next = db.listAccountLinks(orgId, "calendar").find((o) => o.kind === "google" && o.holds === "yes");
    if (next) db.updateAccountLink(next.id, orgId, { holds: "default" });
  }
}

export function view(orgId: number) {
  return {
    calendars: db.listAccountLinks(orgId, "calendar").map((l) => ({ id: l.id, kind: l.kind, name: l.name, color: l.color, email: l.email, calendars: calendarsOf(l), detail: l.detail, holds: l.holds, status: l.status, error: l.error })),
    senders: db.listAccountLinks(orgId, "send").map((l) => ({ id: l.id, name: l.name, email: l.email, sendsFor: parse<string[]>(l.sendsFor, []), status: l.status, error: l.error })),
  };
}

// ==========================================
// Reading the schedule
// ==========================================

function day(d: { dateTime?: string; date?: string } | undefined, tz: string) {
  if (d?.dateTime) return { at: new Date(d.dateTime), allDay: false };
  if (d?.date) {
    const [y, m, dd] = d.date.split("-").map(Number);
    // Midnight where the workspace is.
    return { at: zonedToUtc(y, m, dd, 0, 0, tz), allDay: true };
  }
  return null;
}

async function googleEvents(token: string, calendarId: string, from: Date, to: Date, tz: string) {
  const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  const { data } = await integrations.api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { token });
  const out: { start: Date; end: Date; allDay: boolean; title: string }[] = [];
  for (const e of data.items ?? []) {
    if (e.status === "cancelled" || e.transparency === "transparent") continue;
    const s = day(e.start, tz);
    const en = day(e.end, tz);
    if (s && en) out.push({ start: s.at, end: en.at, allDay: s.allDay, title: String(e.summary || "Busy") });
  }
  return out;
}

export async function icsEvents(url: string, from: Date, to: Date) {
  const res = await fetch(url, { headers: { accept: "text/calendar, */*" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("not a calendar");
  const ical = (await import("node-ical")).default;
  const data = ical.sync.parseICS(text);
  const out: { start: Date; end: Date; allDay: boolean; title: string }[] = [];
  for (const e of Object.values(data) as any[]) {
    if (!e || e.type !== "VEVENT" || e.status === "CANCELLED" || e.transparency === "TRANSPARENT") continue;
    const occ = ical.expandRecurringEvent(e, { from, to });
    for (const o of occ as any[]) {
      const start = new Date(o.start);
      const end = new Date(o.end ?? o.start);
      if (end > from && start < to) out.push({ start, end, allDay: Boolean(o.isFullDay), title: String(o.summary ?? e.summary ?? "Busy") });
    }
  }
  return out;
}

/** Every event on every calendar Avery checks, in order. Calendars that fail are named, not hidden. */
export async function schedule(orgId: number, from: Date, to: Date) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const links = db.listAccountLinks(orgId, "calendar");
  const events: Event[] = [];
  const failed: string[] = [];
  let sources = 0;
  if (!links.length) {
    // Nothing added yet: the main Google connection's calendar.
    const token = await integrations.mainGoogleToken(orgId);
    if (token) {
      sources = 1;
      try {
        for (const e of await googleEvents(token, "primary", from, to, tz)) events.push({ ...e, calendar: "Google Calendar", color: COLORS[0], sourceId: 0 });
      } catch {
        failed.push("Google Calendar");
      }
    }
  }
  for (const l of links) {
    const included = calendarsOf(l).filter((c) => c.include);
    if (!included.length) continue;
    sources++;
    try {
      const got =
        l.kind === "link"
          ? await icsEvents(decryptJson<{ url: string }>(l.secretsEncrypted)?.url ?? "", from, to)
          : await (async () => {
              const token = await integrations.linkToken(l);
              const all = [];
              for (const c of included) all.push(...(await googleEvents(token, c.id, from, to, tz)));
              return all;
            })();
      for (const e of got) events.push({ ...e, title: l.detail === "busy" ? "Busy" : e.title, calendar: l.name, color: l.color, sourceId: l.id });
      if (l.status === "error") db.updateAccountLink(l.id, orgId, { status: "connected", error: null });
    } catch (err) {
      failed.push(l.name);
      db.updateAccountLink(l.id, orgId, { status: "error", error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't read it" });
    }
  }
  events.sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay));
  return { events, failed, sources, tz };
}

/** Pairs of timed events on different calendars that overlap. */
export function overlaps(events: Event[]) {
  const timed = events.filter((e) => !e.allDay);
  const out: [Event, Event][] = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (b.start >= a.end) continue;
      if (a.sourceId !== b.sourceId) out.push([a, b]);
    }
  return out;
}

/** Busy times across every calendar (Malik offers only times that are open on all of them). */
export async function busyAll(orgId: number, from: Date, to: Date) {
  const { events } = await schedule(orgId, from, to);
  return events.map((e) => ({ start: e.start, end: e.end }));
}

// ==========================================
// Holds
// ==========================================

/** Which calendar a hold goes on: the one named, else the default. Null means the main Google connection. */
export function holdCalendarFor(orgId: number, words: string) {
  const usable = db.listAccountLinks(orgId, "calendar").filter((l) => l.kind === "google" && l.holds !== "no");
  const w = words.trim().toLowerCase();
  if (w) {
    const named = db.listAccountLinks(orgId, "calendar").find((l) => l.name.toLowerCase() === w || l.name.toLowerCase().includes(w) || w.includes(l.name.toLowerCase()));
    if (named && (named.kind !== "google" || named.holds === "no")) return { link: null, refused: named };
    if (named) return { link: named, refused: null };
  }
  return { link: usable.find((l) => l.holds === "default") ?? null, refused: null };
}

/** The token and calendar for a hold being added. */
export async function holdTarget(orgId: number, linkId: number | null) {
  const l = linkId ? db.getAccountLink(linkId, orgId) : holdCalendarFor(orgId, "").link;
  if (!l || l.kind !== "google") return null;
  const cal = calendarsOf(l).find((c) => c.primary) ?? calendarsOf(l)[0];
  return { token: await integrations.linkToken(l), calendarId: cal?.id ?? "primary", name: l.name };
}

// ==========================================
// For Avery's chat
// ==========================================

const fmtDay = (d: Date, tz: string) => d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fmtTime = (d: Date, tz: string) => d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });

export function whenText(e: Pick<Event, "start" | "end" | "allDay">, tz: string) {
  if (e.allDay) return "All day";
  const a = fmtTime(e.start, tz);
  const b = fmtTime(e.end, tz);
  const ap = (s: string) => s.slice(-2);
  return ap(a) === ap(b) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}

/** Midnight to midnight where the workspace is, for a YYYY-MM-DD and a number of days. */
export function range(ymd: string, days: number, tz: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const at = (dd: number) => {
    const n = new Date(Date.UTC(y, m - 1, dd, 12));
    return zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz);
  };
  return { from: at(d), to: at(d + Math.max(1, Math.min(14, days))) };
}

export async function scheduleReply(orgId: number, ymd: string, days: number) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const { from, to } = range(ymd, days, tz);
  const s = await schedule(orgId, from, to);
  if (!s.sources) return { text: "I don't have a calendar to check yet. Add your calendars on Integrations under Calendars.", events: [] as Event[], tz };
  const label = days > 1 ? `${fmtDay(from, tz)} through ${fmtDay(new Date(to.getTime() - 3600_000), tz)}` : fmtDay(from, tz);
  const cals = new Set(s.events.map((e) => e.calendar)).size;
  const clash = overlaps(s.events);
  const parts = [
    s.events.length
      ? `${label} has ${s.events.length === 1 ? "one thing" : `${s.events.length} things`}${s.sources > 1 ? ` across ${cals === 1 ? "one of your calendars" : `${cals} calendars`}` : ""}.`
      : `${label} is open on ${s.sources > 1 ? "all your calendars" : "your calendar"}.`,
  ];
  if (clash.length) {
    const [a, b] = clash[0];
    parts.push(`${clash.length === 1 ? "Two of them overlap" : `${clash.length} pairs overlap`}${days > 1 ? ` (first on ${fmtDay(a.start, tz)})` : ""}: ${a.title === "Busy" ? `a busy block on ${a.calendar}` : `${a.title} on ${a.calendar}`} and ${b.title === "Busy" ? `a busy block on ${b.calendar}` : `${b.title} on ${b.calendar}`} at ${fmtTime(b.start, tz)}.`);
  }
  if (s.failed.length) parts.push(`I couldn't read ${s.failed.join(" and ")}. Reconnect ${s.failed.length === 1 ? "it" : "them"} on Integrations.`);
  return { text: parts.join(" "), events: s.events, tz, clash };
}

/** For a hold: is that hour open on every calendar? */
export async function freeAt(orgId: number, start: Date, minutes = 60) {
  const s = await schedule(orgId, start, new Date(start.getTime() + minutes * 60_000));
  const busy = s.events.filter((e) => !e.allDay);
  return { open: busy.length === 0, busy, sources: s.sources };
}
