import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { decryptJson, encryptJson } from "./_core/crypto";
import { notify } from "./notify";
import type { AIEmployee, EmployeeKind } from "../drizzle/schema";

/**
 * LeadDash EHR, read by a healthcare practice's employees.
 *
 * The practice connects its EHR once from Integrations with a key the EHR
 * issued (Practice Settings, LeadDash Employees). Every 15 minutes the app
 * reads one snapshot from the EHR (claims, paperwork, appointments, notes,
 * balances, eligibility), keeps it for the Desk tabs, and compares it to the
 * last one: a claim newly denied goes to Harper, paperwork newly overdue and
 * bookings to Malik, notes newly unsigned to Camille, each in their chat and
 * as a notice to the people who chose to hear about it.
 *
 * Nothing is written to the EHR. Each client row carries the name and the
 * initials: the name is used inside this app and in chat, the initials in
 * anything that leaves it (push notices, emails, texts). The
 * EHR holds the rest behind its own sign-in. Nothing from the snapshot ever
 * goes to web search.
 *
 * THE CONTRACT the EHR serves (its employeesApi.js module), all behind
 * `Authorization: Bearer <key>`:
 *   GET /api/employees/ping      -> { ok, practice, locationId }
 *   GET /api/employees/snapshot  -> EhrSnapshot (below)
 */

export type EhrClaim = { id: string; name?: string; initials: string; dos: string; payer: string; status: "denied" | "rejected"; reason: string; fix: string; amountCents: number; url: string; at: string };
export type EhrUnpaid = { payer: string; count: number; oldest: string; amountCents: number; status: string; url: string };
export type EhrBalance = { id: string; name?: string; initials: string; cents: number; lastPayment: string | null; cardOnFile: boolean; url: string };
export type EhrEligibility = { id: string; name?: string; initials: string; session: string; clinician: string; result: string; ok: boolean; url: string };
export type EhrPaperwork = { id: string; name?: string; initials: string; what: string; sent: string; due: string | null; status: string; daysOut: number; url: string };
export type EhrAppointment = { id: string; kind: "booked" | "confirmed" | "cancelled" | "reschedule_requested" | "no_show"; name?: string; initials: string; clinician: string; start: string; reason: string; at: string; url: string };
/** An active client with no kept appointment in 30 days and nothing booked ahead. */
export type EhrLapsed = { id: string; name?: string; initials: string; lastSeen: string; days: number; clinician: string; url: string };
export type EhrClinicianDocs = { clinician: string; unsigned: number; oldestUnsigned: string | null; plansDue: number; plansDueSoonest: string | null; measuresOverdue: number; url: string };
export type EhrSnapshot = {
  generatedAt: string;
  practice: string;
  claims: EhrClaim[];
  unpaid: EhrUnpaid[];
  balances: EhrBalance[];
  eligibility: EhrEligibility[];
  paperwork: EhrPaperwork[];
  appointments: EhrAppointment[];
  lapsed: EhrLapsed[];
  docs: EhrClinicianDocs[];
  totals: { collectedMonthCents: number; unpaid30Cents: number; balancesCents: number; lapsed: number };
  /** Every client name an employee has seen, from snapshots and reads on request, so it can be shortened or hidden wherever it shows. */
  names: string[];
};

const PROVIDER = "leaddash_ehr" as const;
const EVERY_MS = 15 * 60_000;

function settingsOf(c: { settings: string | null } | null | undefined) {
  try {
    return JSON.parse(c?.settings ?? "{}") as { url?: string; practice?: string; locationId?: string };
  } catch {
    return {};
  }
}

function keyOf(c: { secretsEncrypted: string | null }) {
  return decryptJson<{ key: string }>(c.secretsEncrypted)?.key ?? "";
}

/** Hooks tests use in place of the network. */
export const tools = {
  fetchJson: async (url: string, key: string, timeoutMs = 30_000): Promise<unknown> => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`LeadDash EHR answered ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  },
};

export function baseUrl(raw: string) {
  const u = raw.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u)) throw new TRPCError({ code: "BAD_REQUEST", message: "The EHR address looks like https://api.health.leaddash.io" });
  return u;
}

export async function connect(orgId: number, input: { url: string; key: string }) {
  const url = baseUrl(input.url);
  const key = input.key.trim();
  if (key.length < 20) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste the whole key from LeadDash EHR, Practice Settings, LeadDash Employees." });
  let ping: { ok?: boolean; practice?: string; locationId?: string };
  try {
    ping = (await tools.fetchJson(`${url}/api/employees/ping`, key)) as typeof ping;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new TRPCError({ code: "BAD_REQUEST", message: /401|403/.test(m) ? "LeadDash EHR did not accept that key. Copy it again from Practice Settings, LeadDash Employees." : `Could not reach LeadDash EHR: ${m}` });
  }
  if (!ping?.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "LeadDash EHR did not answer the way it should. Check the address." });
  await db.upsertExternalConnection({
    organizationId: orgId,
    provider: PROVIDER,
    accountLabel: ping.practice || "LeadDash EHR",
    accountHandle: ping.locationId ?? null,
    status: "connected",
    settings: JSON.stringify({ url, practice: ping.practice ?? "", locationId: ping.locationId ?? "" }),
    secretsEncrypted: encryptJson({ key }),
    connectedAt: new Date(),
    lastCheckedAt: new Date(),
  });
  await refresh(orgId).catch(() => null);
  return { practice: ping.practice ?? "LeadDash EHR" };
}

export async function connection(orgId: number) {
  const c = await db.getConnectionByProvider(orgId, PROVIDER);
  return c && c.status === "connected" ? c : null;
}

/**
 * The last read. A connection whose reads have only failed has a row with an
 * error and no data (saved as "{}" at the epoch): that is no snapshot and no
 * read time, never an empty snapshot dated Dec 31, 1969.
 */
export function snapshotOf(orgId: number): { data: EhrSnapshot | null; fetchedAt: Date | null; error: string | null } | null {
  const row = db.ehr.snapshot(orgId);
  if (!row) return null;
  const read = row.fetchedAt && new Date(row.fetchedAt).getTime() > 0 ? row.fetchedAt : null;
  let data: EhrSnapshot | null = null;
  try {
    const parsed = JSON.parse(row.data) as Partial<EhrSnapshot> | null;
    data = read && parsed && parsed.generatedAt ? normalize(parsed) : null;
  } catch {
    data = null;
  }
  return { data, fetchedAt: data ? read : null, error: row.error };
}

/** What the Desk tabs and the chat see: connected or not, the practice, when it was last read, and the snapshot. */
export async function view(orgId: number) {
  const c = await connection(orgId);
  const snap = snapshotOf(orgId);
  const s = settingsOf(c);
  return { connected: Boolean(c), practice: s.practice || c?.accountLabel || null, url: s.url ?? null, fetchedAt: snap?.fetchedAt ?? null, error: snap?.error ?? null, snapshot: snap?.data ?? null };
}

export async function disconnect(orgId: number) {
  const c = await db.getConnectionByProvider(orgId, PROVIDER);
  if (c) await db.upsertExternalConnection({ organizationId: orgId, provider: PROVIDER, accountLabel: c.accountLabel, status: "disconnected", settings: c.settings, secretsEncrypted: null });
  db.ehr.clear(orgId);
}

// ==========================================
// Reading, and what changed since last time
// ==========================================

const empty = (): EhrSnapshot => ({ generatedAt: "", practice: "", claims: [], unpaid: [], balances: [], eligibility: [], paperwork: [], appointments: [], lapsed: [], docs: [], totals: { collectedMonthCents: 0, unpaid30Cents: 0, balancesCents: 0, lapsed: 0 }, names: [] });

function normalize(raw: unknown): EhrSnapshot {
  const r = (raw ?? {}) as Partial<EhrSnapshot>;
  const base = empty();
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    generatedAt: String(r.generatedAt ?? new Date().toISOString()),
    practice: String(r.practice ?? ""),
    claims: arr<EhrClaim>(r.claims),
    unpaid: arr<EhrUnpaid>(r.unpaid),
    balances: arr<EhrBalance>(r.balances),
    eligibility: arr<EhrEligibility>(r.eligibility),
    paperwork: arr<EhrPaperwork>(r.paperwork),
    appointments: arr<EhrAppointment>(r.appointments),
    lapsed: arr<EhrLapsed>(r.lapsed),
    docs: arr<EhrClinicianDocs>(r.docs),
    totals: { ...base.totals, ...(r.totals ?? {}), lapsed: arr<EhrLapsed>(r.lapsed).length },
    names: arr<string>(r.names).filter((n) => typeof n === "string" && n.trim()).slice(0, 5000),
  };
}

// ==========================================
// How client names show: Show, Initial or Hide (2026-10-08)
// ------------------------------------------
// A switch in the employee header, per person. The employees always reason
// over the real names (on providers under the BAA); this changes only what
// reaches the screen: chat, the Work tabs and the chat list. Emails, texts
// and push notices carry initials whatever the switch says.
// ==========================================

export const NAME_MODES = ["show", "initial", "hide"] as const;
export type NameMode = (typeof NAME_MODES)[number];
/** What a hidden name looks like: a small black box, in any font. */
export const HIDDEN = "\u2588\u2588\u2588\u2588";

/** The person's choice, kept with their notice settings. */
export function nameModeOf(raw: string | null | undefined): NameMode {
  try {
    const v = (raw ? JSON.parse(raw) : {})._clientNames;
    return (NAME_MODES as readonly string[]).includes(v) ? (v as NameMode) : "show";
  } catch {
    return "show";
  }
}

/** "Avery Price" as "A. Price". One word stays as it is. */
export function initialForm(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name.trim();
  return `${parts[0][0].toUpperCase()}. ${parts[parts.length - 1]}`;
}

export function displayName(mode: NameMode, name: string | null | undefined, initials: string) {
  const full = (name ?? "").trim();
  if (mode === "hide") return HIDDEN;
  if (!full) return initials;
  return mode === "initial" ? initialForm(full) : full;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every client name in a text, shortened or hidden. Names are matched whole
 * (word boundaries, any case), longest first so "Ann Lee-Parker" is not cut at
 * "Ann Lee"; the "A. Price" form of each name is matched too, so a reply
 * already shortened hides cleanly.
 */
export function redactText(mode: NameMode, text: string, names: Iterable<string>) {
  if (mode === "show" || !text) return text;
  const list = Array.from(new Set(Array.from(names).map((n) => n.trim()).filter((n) => n.split(/\s+/).length >= 2))).sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of list) {
    const forms = [name, initialForm(name)];
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(re, mode === "hide" ? HIDDEN : initialForm(name));
  }
  return out;
}

const rowNames = (s: EhrSnapshot | null): string[] =>
  s ? [...s.claims, ...s.balances, ...s.eligibility, ...s.paperwork, ...s.appointments, ...s.lapsed].map((r) => (r.name ?? "").trim()).filter(Boolean) : [];

/** Every client name this workspace's employees have seen. */
export function knownNames(orgId: number): string[] {
  const row = db.ehr.snapshot(orgId);
  if (!row) return [];
  let parsed: Partial<EhrSnapshot> | null = null;
  try {
    parsed = JSON.parse(row.data) as Partial<EhrSnapshot>;
  } catch {
    parsed = null;
  }
  if (!parsed) return [];
  const s = normalize(parsed);
  return Array.from(new Set([...s.names, ...rowNames(s)]));
}

/** Names seen in a read are kept, so a name in an old chat message can still be shortened or hidden later. */
export function rememberNames(orgId: number, names: Iterable<string>) {
  const fresh = Array.from(new Set(Array.from(names).map((n) => (n ?? "").trim()).filter((n) => n.split(/\s+/).length >= 2)));
  if (!fresh.length) return;
  const row = db.ehr.snapshot(orgId);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = row ? (JSON.parse(row.data) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  const had = Array.isArray(parsed.names) ? (parsed.names as string[]) : [];
  const merged = Array.from(new Set([...had, ...fresh])).slice(-5000);
  if (merged.length === had.length && fresh.every((n) => had.includes(n))) return;
  db.ehr.saveData(orgId, JSON.stringify({ ...parsed, names: merged }));
}

/** A text for one person's screen: the workspace's client names shown the way they chose. */
export function forScreen(orgId: number, mode: NameMode, text: string) {
  return mode === "show" ? text : redactText(mode, text, knownNames(orgId));
}

/** The Work tabs for one person: every client row named the way they chose. */
export async function viewFor(orgId: number, mode: NameMode) {
  const v = await view(orgId);
  if (!v.snapshot || mode === "show") return v;
  const s = v.snapshot;
  const name = <T extends { name?: string; initials: string }>(r: T): T => ({ ...r, name: displayName(mode, r.name, r.initials) });
  return { ...v, snapshot: { ...s, claims: s.claims.map(name), balances: s.balances.map(name), eligibility: s.eligibility.map(name), paperwork: s.paperwork.map(name), appointments: s.appointments.map(name), lapsed: s.lapsed.map(name), names: [] } };
}

export type Changes = {
  claims: EhrClaim[];
  paperwork: EhrPaperwork[];
  appointments: EhrAppointment[];
  eligibility: EhrEligibility[];
  lapsed: EhrLapsed[];
  docs: { clinician: string; unsigned: number; before: number }[];
};

/** What is in the new snapshot that was not in the old one. The first read reports nothing, so a fresh connection does not post weeks of history. */
export function diff(before: EhrSnapshot | null, after: EhrSnapshot): Changes {
  const none: Changes = { claims: [], paperwork: [], appointments: [], eligibility: [], lapsed: [], docs: [] };
  if (!before) return none;
  const had = (list: { id: string }[]) => new Set(list.map((x) => x.id));
  const claims = had(before.claims);
  const lapsed = had(before.lapsed);
  const forms = new Set(before.paperwork.filter((p) => p.status === "overdue").map((p) => p.id));
  const appts = had(before.appointments);
  const elig = new Set(before.eligibility.filter((e) => !e.ok).map((e) => e.id));
  const docsBefore = new Map(before.docs.map((d) => [d.clinician, d.unsigned]));
  return {
    claims: after.claims.filter((c) => !claims.has(c.id)),
    paperwork: after.paperwork.filter((p) => p.status === "overdue" && !forms.has(p.id)),
    appointments: after.appointments.filter((a) => !appts.has(a.id)),
    eligibility: after.eligibility.filter((e) => !e.ok && !elig.has(e.id)),
    lapsed: after.lapsed.filter((l) => !lapsed.has(l.id)),
    docs: after.docs.filter((d) => d.unsigned > (docsBefore.get(d.clinician) ?? 0)).map((d) => ({ clinician: d.clinician, unsigned: d.unsigned, before: docsBefore.get(d.clinician) ?? 0 })),
  };
}

export const money = (cents: number) => `$${(Math.round(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function longDate(ymd: string | null | undefined) {
  if (!ymd) return "";
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(ymd);
}
export function whenText(iso: string, tz = "America/Chicago") {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

async function emp(orgId: number, kind: EmployeeKind) {
  return db.getEmployeeByKind(orgId, kind);
}

async function post(e: AIEmployee, content: string) {
  return db.createChatMessage({ organizationId: e.organizationId, employeeId: e.id, role: "employee", authorName: e.name, content, cards: null });
}

/** The client's name for this app and its chat; the initials when the row carries no name. */
export const who = (x: { name?: string; initials: string }) => (x.name && x.name.trim()) || x.initials;

/** Posts what changed, in the right chats (clients by name), and tells the people who chose to hear about it (push notices carry counts, never a client). */
export async function announce(orgId: number, changes: Changes, tz = "America/Chicago") {
  const notes: { kind: EmployeeKind; text: string; title: string; url: string }[] = [];
  const harper = await emp(orgId, "billing");
  if (harper && (changes.claims.length || changes.eligibility.length)) {
    const lines: string[] = [];
    for (const c of changes.claims) lines.push(`- ${who(c)} · ${longDate(c.dos)} · ${c.payer} · ${c.status === "denied" ? "Denied" : "Rejected"}: ${c.reason}${c.fix ? `. Fix: ${c.fix}` : ""}${c.amountCents ? ` (${money(c.amountCents)})` : ""}`);
    for (const e of changes.eligibility) lines.push(`- ${who(e)} · session ${whenText(e.session, tz)} with ${e.clinician} · eligibility: ${e.result}`);
    const head = changes.claims.length ? `${changes.claims.length === 1 ? "A claim" : `${changes.claims.length} claims`} came back ${changes.claims.every((c) => c.status === "rejected") ? "rejected" : "denied or rejected"} from LeadDash EHR.` : `${changes.eligibility.length === 1 ? "An eligibility check" : `${changes.eligibility.length} eligibility checks`} need attention before the session.`;
    await post(harper, `${head}\n${lines.join("\n")}\n\nEach one opens in LeadDash EHR from my Claims tab; the fix happens there.`);
    notes.push({ kind: "billing", title: head, text: `${lines.length} item${lines.length === 1 ? "" : "s"} on Harper's Claims tab.`, url: "/chats/billing/work" });
  }
  const malik = await emp(orgId, "leads");
  if (malik && (changes.paperwork.length || changes.appointments.length || changes.lapsed.length)) {
    const lines: string[] = [];
    for (const p of changes.paperwork) lines.push(`- ${who(p)} · ${p.what} sent ${longDate(p.sent)}, ${p.daysOut} day${p.daysOut === 1 ? "" : "s"} out, not finished`);
    for (const a of changes.appointments) {
      const what = a.kind === "booked" ? "booked" : a.kind === "confirmed" ? "confirmed" : a.kind === "cancelled" ? `cancelled${a.reason ? ` (${a.reason})` : ""}` : a.kind === "no_show" ? "did not show" : `asked to reschedule${a.reason ? ` (${a.reason})` : ""}`;
      lines.push(`- ${who(a)} · ${whenText(a.start, tz)} with ${a.clinician} · ${what}`);
    }
    for (const l of changes.lapsed) lines.push(`- ${who(l)} · last seen ${longDate(l.lastSeen)}${l.clinician ? ` with ${l.clinician}` : ""}, ${l.days} days ago, nothing booked`);
    const head = [
      changes.paperwork.length ? `${changes.paperwork.length === 1 ? "One client has" : `${changes.paperwork.length} clients have`} paperwork past due` : "",
      changes.appointments.length ? `${changes.appointments.length} appointment change${changes.appointments.length === 1 ? "" : "s"}` : "",
      changes.lapsed.length ? `${changes.lapsed.length === 1 ? "one client" : `${changes.lapsed.length} clients`} not booked in 30 days` : "",
    ].filter(Boolean).join(" and ");
    await post(malik, `From LeadDash EHR: ${head}.\n${lines.join("\n")}\n\nThe reminders the practice set keep going on their own; tell me if you want me to reach out by name.`);
    notes.push({ kind: "leads", title: `${head[0].toUpperCase()}${head.slice(1)}`, text: `On Malik's Leads tab.`, url: "/chats/leads/work" });
  }
  const camille = await emp(orgId, "compliance");
  if (camille && changes.docs.length) {
    const lines = changes.docs.map((d) => `- ${d.clinician}: ${d.unsigned} unsigned note${d.unsigned === 1 ? "" : "s"} past the limit (was ${d.before})`);
    const head = `${changes.docs.length === 1 ? "A clinician has" : `${changes.docs.length} clinicians have`} more unsigned notes than yesterday.`;
    await post(camille, `${head}\n${lines.join("\n")}\n\nCounts only; I never read a note. The reminder is drafted on my Compliance tab and waits for Send.`);
    notes.push({ kind: "compliance", title: head, text: lines.join(" "), url: "/chats/compliance/work" });
  }
  for (const n of notes) await notify(orgId, "ehr", { title: n.title, body: n.text, url: n.url, tag: `ehr-${n.kind}` }).catch(() => null);
  return notes.length;
}

/** Reads one snapshot now, keeps it, and announces what changed. */
export async function refresh(orgId: number) {
  const c = await connection(orgId);
  if (!c) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect LeadDash EHR on Integrations first." });
  const s = settingsOf(c);
  const before = snapshotOf(orgId)?.data ?? null;
  let after: EhrSnapshot;
  try {
    // A large practice's first read pulls a year of calendar events, which can take more than a minute.
    after = normalize(await tools.fetchJson(`${s.url}/api/employees/snapshot`, keyOf(c), 120_000));
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    db.ehr.setError(orgId, why);
    throw new TRPCError({ code: "BAD_GATEWAY", message: `LeadDash EHR could not be read: ${why}` });
  }
  const changes = diff(before, after);
  // Names carry over: a client off this snapshot's lists is still named in older chat messages.
  after.names = Array.from(new Set([...(before?.names ?? []), ...rowNames(before), ...rowNames(after)])).slice(-5000);
  db.ehr.save(orgId, JSON.stringify(after));
  const org = await db.getOrganizationById(orgId);
  const posted = await announce(orgId, changes, org?.timezone || "America/Chicago");
  return { changes, posted, fetchedAt: new Date() };
}

let lastTick = 0;
const busy = new Set<number>();

/** Every 15 minutes, every connected workspace. */
export async function ehrTicks(now = Date.now()) {
  if (now - lastTick < EVERY_MS) return 0;
  lastTick = now;
  let n = 0;
  for (const orgId of await db.listAllOrganizationIds()) {
    if (busy.has(orgId)) continue;
    if (!(await connection(orgId))) continue;
    busy.add(orgId);
    try {
      await refresh(orgId);
      n++;
    } catch (err) {
      console.warn(`[ehr] workspace ${orgId}:`, err instanceof Error ? err.message : err);
    } finally {
      busy.delete(orgId);
    }
  }
  return n;
}

/** A line for the employees' prompts: connected, and what is in the snapshot. */
export async function ehrFacts(orgId: number, kind: EmployeeKind | "" = "") {
  const v = await view(orgId);
  if (!v.connected) return "\nLeadDash EHR: not connected. The practice connects it on Integrations with the key from Practice Settings, LeadDash Employees. Until then there are no claims, paperwork or notes to read.";
  const s = v.snapshot;
  if (!s) return `\nLeadDash EHR: connected as ${v.practice}${v.error ? `, but the last read failed (${v.error})` : ", first read pending"}.`;
  const head = `\nLeadDash EHR: connected as ${v.practice}, read ${v.fetchedAt ? v.fetchedAt.toISOString() : "recently"}. ${s.claims.length} denied or rejected claims, ${s.unpaid.reduce((n, u) => n + u.count, 0)} unpaid past 30 days (${money(s.totals.unpaid30Cents)}), ${s.balances.length} client balances (${money(s.totals.balancesCents)}), ${s.paperwork.filter((p) => p.status === "overdue").length} paperwork past due, ${s.lapsed.length} clients not booked in 30 days, ${s.docs.reduce((n, d) => n + d.unsigned, 0)} unsigned notes. Clients are named here and in chat; use initials in anything that leaves this app. The detail is on the Work tabs and in the EHR.`;
  const detail: string[] = [];
  if (kind === "billing" && s.balances.length) detail.push(`Client balances, largest first: ${s.balances.slice(0, 20).map((b) => `${who(b)} ${money(b.cents)}${b.cardOnFile ? " (card on file)" : ""}${b.lastPayment ? `, last paid ${longDate(b.lastPayment)}` : ""}`).join("; ")}${s.balances.length > 20 ? `; and ${s.balances.length - 20} more on the Balances tab` : ""}.`);
  if (kind === "leads" && s.lapsed.length) detail.push(`Not booked in 30 days, longest first: ${s.lapsed.slice(0, 20).map((l) => `${who(l)} last seen ${longDate(l.lastSeen)}${l.clinician ? ` with ${l.clinician}` : ""} (${l.days} days)`).join("; ")}${s.lapsed.length > 20 ? `; and ${s.lapsed.length - 20} more on the Not booked tab` : ""}. The practice decides who is reached out to; the chart opens in the EHR.`);
  return `${head}${detail.length ? `\n${detail.join("\n")}` : ""}`;
}

// ==========================================
// Reads on request: an employee asked a question reads exactly the days it needs
// ==========================================

export const READS = ["payments", "claims", "appointments"] as const;
export type EhrRead = (typeof READS)[number];
/** The most days one read covers, as the EHR allows. */
export const READ_MAX_DAYS: Record<EhrRead, number> = { payments: 400, claims: 400, appointments: 120 };

const dollars = (cents: number) => `$${(Math.round(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads one range from LeadDash EHR (payments, claims or appointments) and
 * returns it as plain lines for the employee to answer from. Read-only, on the
 * practice's own days. Clients are named: the lines go only to the employee's
 * chat, which runs on providers under a BAA.
 */
export async function read(orgId: number, what: EhrRead, from: string, to: string): Promise<{ text: string; facts: string }> {
  const c = await connection(orgId);
  if (!c) return { text: "LeadDash EHR isn't connected yet. Connect it on Integrations with the key from LeadDash EHR, and I can read it.", facts: "" };
  if (!DAY.test(from) || !DAY.test(to)) return { text: "Which days should I read?", facts: "" };
  const [a, b] = from <= to ? [from, to] : [to, from];
  const s = settingsOf(c);
  let raw: Record<string, unknown>;
  try {
    raw = (await tools.fetchJson(`${s.url}/api/employees/${what}?from=${a}&to=${b}`, keyOf(c), 90_000)) as Record<string, unknown>;
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    return { text: /404/.test(why) ? "LeadDash EHR doesn't have that read yet. It needs its latest update deployed." : `I couldn't read LeadDash EHR: ${why}`, facts: "" };
  }
  if (!raw || raw.ok === false) return { text: `LeadDash EHR said: ${String(raw?.error ?? "no answer")}`, facts: "" };
  rememberNames(orgId, [...rows(raw.payments), ...rows(raw.refunds), ...rows(raw.claims), ...rows(raw.appointments)].map((r) => String(r.name ?? "")));
  const range = a === b ? longDate(a) : `${longDate(a)} to ${longDate(b)}`;
  // Sessions carry each client's balance and paperwork still out, from the last snapshot, so one read answers "who tomorrow owes or has forms out".
  const snap = what === "appointments" ? (snapshotOf(orgId)?.data ?? null) : null;
  return { text: `I read ${what} for ${range} from LeadDash EHR.`, facts: formatRead(what, raw, range, snap) };
}

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const n = (v: unknown) => Number(v) || 0;
const named = (r: Row) => String(r.name || "").trim() || String(r.initials || "a client");

/** The client id an EHR link points at, so a session row can be matched to a balance or paperwork row. */
const clientOf = (url: unknown) => (String(url ?? "").match(/\/patients\/([^/?#]+)/) ?? [])[1] ?? "";

/** The read as lines: totals first, then each row, so the employee can add up, compare and name what matters. */
export function formatRead(what: EhrRead, raw: Row, range: string, snap: EhrSnapshot | null = null): string {
  if (what === "payments") {
    const days = rows(raw.days);
    const t = (raw.totals ?? {}) as Row;
    const list = rows(raw.payments);
    const lines = [
      `Money in from LeadDash EHR, ${range} (the practice's days; today is ${longDate(String(raw.today || ""))}). Every receipt counts the day it arrived, applied to a session or not. Net is insurance plus client payments minus refunds and payer takebacks.`,
      `Total: ${dollars(n(t.netCents))} net from ${n(t.payments)} payments (insurance ${dollars(n(t.insuranceCents))}, clients ${dollars(n(t.clientCents))}, refunds ${dollars(n(t.refundsCents))}).`,
      "By day:",
      ...days.map((d) => `- ${d.weekday} ${longDate(String(d.date))}: ${dollars(n(d.netCents))} net (insurance ${dollars(n(d.insuranceCents))}, clients ${dollars(n(d.clientCents))}${n(d.refundsCents) ? `, refunds ${dollars(n(d.refundsCents))}` : ""}), ${n(d.payments)} payments`),
      list.length ? "Each payment, newest first:" : "No payments in this range.",
      ...list.slice(0, 150).map((p) => `- ${longDate(String(p.date))} · ${p.kind === "insurance" ? `Insurance (${p.payer})` : "Client"} · ${named(p)} · ${dollars(n(p.amountCents))}${p.method ? ` · ${p.method}` : ""}${n(p.unappliedCents) > 0 ? ` · ${dollars(n(p.unappliedCents))} not applied yet` : ""}${p.recurring ? " · recurring" : ""}`),
      ...(n(raw.paymentsTotal) > 150 ? [`(and ${n(raw.paymentsTotal) - 150} more; the totals above count all of them)`] : []),
      ...rows(raw.refunds).slice(0, 40).map((r) => `- Refund ${longDate(String(r.date))} · ${r.label} · ${named(r)} · ${dollars(n(r.amountCents))}`),
    ];
    return lines.join("\n");
  }
  if (what === "claims") {
    const list = rows(raw.claims);
    return [
      `Claims from LeadDash EHR by date of service, ${range}: ${n(raw.claimsTotal)} claims.`,
      "By status:",
      ...rows(raw.byStatus).map((s) => `- ${s.status}: ${n(s.count)} claims, billed ${dollars(n(s.billedCents))}, paid ${dollars(n(s.paidCents))}`),
      list.length ? "Each claim, newest date of service first:" : "No claims in this range.",
      ...list.slice(0, 150).map((c) => `- ${longDate(String(c.dos))} · ${named(c)} · ${c.payer} · ${c.status} · billed ${dollars(n(c.billedCents))}${n(c.paidCents) ? `, paid ${dollars(n(c.paidCents))}` : ""}${c.paid ? ` on ${longDate(String(c.paid))}` : ""}${c.reason ? ` · ${c.reason}` : ""}`),
      ...(n(raw.claimsTotal) > 150 ? [`(and ${n(raw.claimsTotal) - 150} more; the counts above include all of them)`] : []),
    ].join("\n");
  }
  const list = rows(raw.appointments);
  const byStatus = Object.entries((raw.byStatus ?? {}) as Record<string, number>);
  const byClin = Object.entries((raw.byClinician ?? {}) as Record<string, number>);
  // What each client on the calendar owes and still has out, from the last snapshot.
  const balanceBy = new Map<string, EhrBalance>();
  const paperBy = new Map<string, EhrPaperwork[]>();
  for (const b of snap?.balances ?? []) balanceBy.set(String(b.id), b);
  for (const p of snap?.paperwork ?? []) {
    const id = clientOf(p.url);
    if (id) paperBy.set(id, [...(paperBy.get(id) ?? []), p]);
  }
  const extras = (x: Row) => {
    const id = clientOf(x.url);
    if (!id || !snap) return "";
    const b = balanceBy.get(id);
    const p = paperBy.get(id) ?? [];
    const parts = [
      b ? `balance ${dollars(n(b.cents))}${b.cardOnFile ? " (card on file)" : ""}` : "no balance",
      p.length ? `paperwork out: ${p.map((f) => `${f.what}, sent ${longDate(f.sent)}${f.status === "overdue" ? " (overdue)" : ""}`).join("; ")}` : "no paperwork out",
    ];
    return ` · ${parts.join(" · ")}`;
  };
  const owing = snap ? list.filter((x) => balanceBy.has(clientOf(x.url))) : [];
  const outstanding = snap ? list.filter((x) => paperBy.has(clientOf(x.url))) : [];
  return [
    `Sessions on the calendar from LeadDash EHR, ${range}: ${n(raw.appointmentsTotal)}.`,
    `By status: ${byStatus.map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
    `By clinician: ${byClin.map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
    snap
      ? `Of these clients, ${owing.length} ${owing.length === 1 ? "has" : "have"} a balance${owing.length ? ` (${dollars(owing.reduce((t, x) => t + n(balanceBy.get(clientOf(x.url))?.cents), 0))} in all)` : ""} and ${outstanding.length} ${outstanding.length === 1 ? "has" : "have"} paperwork sent and not finished, as of the last EHR read${snap.generatedAt ? ` (${longDate(snap.generatedAt.slice(0, 10))})` : ""}.`
      : "Balances and paperwork have not been read from the EHR yet, so they are not on these lines.",
    ...list.slice(0, 150).map((x) => `- ${whenText(String(x.start))} · ${named(x)} · ${x.clinician || "Unassigned"} · ${x.status}${extras(x)}`),
    ...(n(raw.appointmentsTotal) > 150 ? [`(and ${n(raw.appointmentsTotal) - 150} more; the counts above include all of them)`] : []),
  ].join("\n");
}
