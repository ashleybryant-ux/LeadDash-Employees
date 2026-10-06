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
 * Nothing is written to the EHR. Clients are initials everywhere here; the
 * EHR holds the rest behind its own sign-in. Nothing from the snapshot ever
 * goes to web search.
 *
 * THE CONTRACT the EHR serves (its employeesApi.js module), all behind
 * `Authorization: Bearer <key>`:
 *   GET /api/employees/ping      -> { ok, practice, locationId }
 *   GET /api/employees/snapshot  -> EhrSnapshot (below)
 */

export type EhrClaim = { id: string; initials: string; dos: string; payer: string; status: "denied" | "rejected"; reason: string; fix: string; amountCents: number; url: string; at: string };
export type EhrUnpaid = { payer: string; count: number; oldest: string; amountCents: number; status: string; url: string };
export type EhrBalance = { id: string; initials: string; cents: number; lastPayment: string | null; cardOnFile: boolean; url: string };
export type EhrEligibility = { id: string; initials: string; session: string; clinician: string; result: string; ok: boolean; url: string };
export type EhrPaperwork = { id: string; initials: string; what: string; sent: string; due: string | null; status: string; daysOut: number; url: string };
export type EhrAppointment = { id: string; kind: "booked" | "confirmed" | "cancelled" | "reschedule_requested" | "no_show"; initials: string; clinician: string; start: string; reason: string; at: string; url: string };
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
  docs: EhrClinicianDocs[];
  totals: { collectedMonthCents: number; unpaid30Cents: number; balancesCents: number };
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
  fetchJson: async (url: string, key: string): Promise<unknown> => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`LeadDash EHR answered ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  },
};

export function baseUrl(raw: string) {
  const u = raw.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u)) throw new TRPCError({ code: "BAD_REQUEST", message: "The EHR address looks like https://ehr.leaddash.io" });
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

export function snapshotOf(orgId: number): { data: EhrSnapshot; fetchedAt: Date; error: string | null } | null {
  const row = db.ehr.snapshot(orgId);
  if (!row) return null;
  try {
    return { data: JSON.parse(row.data) as EhrSnapshot, fetchedAt: row.fetchedAt, error: row.error };
  } catch {
    return null;
  }
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

const empty = (): EhrSnapshot => ({ generatedAt: "", practice: "", claims: [], unpaid: [], balances: [], eligibility: [], paperwork: [], appointments: [], docs: [], totals: { collectedMonthCents: 0, unpaid30Cents: 0, balancesCents: 0 } });

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
    docs: arr<EhrClinicianDocs>(r.docs),
    totals: { ...base.totals, ...(r.totals ?? {}) },
  };
}

export type Changes = {
  claims: EhrClaim[];
  paperwork: EhrPaperwork[];
  appointments: EhrAppointment[];
  eligibility: EhrEligibility[];
  docs: { clinician: string; unsigned: number; before: number }[];
};

/** What is in the new snapshot that was not in the old one. The first read reports nothing, so a fresh connection does not post weeks of history. */
export function diff(before: EhrSnapshot | null, after: EhrSnapshot): Changes {
  const none: Changes = { claims: [], paperwork: [], appointments: [], eligibility: [], docs: [] };
  if (!before) return none;
  const had = (list: { id: string }[]) => new Set(list.map((x) => x.id));
  const claims = had(before.claims);
  const forms = new Set(before.paperwork.filter((p) => p.status === "overdue").map((p) => p.id));
  const appts = had(before.appointments);
  const elig = new Set(before.eligibility.filter((e) => !e.ok).map((e) => e.id));
  const docsBefore = new Map(before.docs.map((d) => [d.clinician, d.unsigned]));
  return {
    claims: after.claims.filter((c) => !claims.has(c.id)),
    paperwork: after.paperwork.filter((p) => p.status === "overdue" && !forms.has(p.id)),
    appointments: after.appointments.filter((a) => !appts.has(a.id)),
    eligibility: after.eligibility.filter((e) => !e.ok && !elig.has(e.id)),
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

/** Posts what changed, in the right chats, and tells the people who chose to hear about it. Clients by initials only. */
export async function announce(orgId: number, changes: Changes, tz = "America/Chicago") {
  const notes: { kind: EmployeeKind; text: string; title: string; url: string }[] = [];
  const harper = await emp(orgId, "billing");
  if (harper && (changes.claims.length || changes.eligibility.length)) {
    const lines: string[] = [];
    for (const c of changes.claims) lines.push(`- ${c.initials} · ${longDate(c.dos)} · ${c.payer} · ${c.status === "denied" ? "Denied" : "Rejected"}: ${c.reason}${c.fix ? `. Fix: ${c.fix}` : ""}${c.amountCents ? ` (${money(c.amountCents)})` : ""}`);
    for (const e of changes.eligibility) lines.push(`- ${e.initials} · session ${whenText(e.session, tz)} with ${e.clinician} · eligibility: ${e.result}`);
    const head = changes.claims.length ? `${changes.claims.length === 1 ? "A claim" : `${changes.claims.length} claims`} came back ${changes.claims.every((c) => c.status === "rejected") ? "rejected" : "denied or rejected"} from LeadDash EHR.` : `${changes.eligibility.length === 1 ? "An eligibility check" : `${changes.eligibility.length} eligibility checks`} need attention before the session.`;
    await post(harper, `${head}\n${lines.join("\n")}\n\nEach one opens in LeadDash EHR from my Claims tab; the fix happens there.`);
    notes.push({ kind: "billing", title: head, text: `${lines.length} item${lines.length === 1 ? "" : "s"} on Harper's Claims tab.`, url: "/chats/billing/work" });
  }
  const malik = await emp(orgId, "leads");
  if (malik && (changes.paperwork.length || changes.appointments.length)) {
    const lines: string[] = [];
    for (const p of changes.paperwork) lines.push(`- ${p.initials} · ${p.what} sent ${longDate(p.sent)}, ${p.daysOut} day${p.daysOut === 1 ? "" : "s"} out, not finished`);
    for (const a of changes.appointments) {
      const what = a.kind === "booked" ? "booked" : a.kind === "confirmed" ? "confirmed" : a.kind === "cancelled" ? `cancelled${a.reason ? ` (${a.reason})` : ""}` : a.kind === "no_show" ? "did not show" : `asked to reschedule${a.reason ? ` (${a.reason})` : ""}`;
      lines.push(`- ${a.initials} · ${whenText(a.start, tz)} with ${a.clinician} · ${what}`);
    }
    const head = [changes.paperwork.length ? `${changes.paperwork.length === 1 ? "One client has" : `${changes.paperwork.length} clients have`} paperwork past due` : "", changes.appointments.length ? `${changes.appointments.length} appointment change${changes.appointments.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
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
    after = normalize(await tools.fetchJson(`${s.url}/api/employees/snapshot`, keyOf(c)));
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    db.ehr.setError(orgId, why);
    throw new TRPCError({ code: "BAD_GATEWAY", message: `LeadDash EHR could not be read: ${why}` });
  }
  const changes = diff(before, after);
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
export async function ehrFacts(orgId: number) {
  const v = await view(orgId);
  if (!v.connected) return "\nLeadDash EHR: not connected. The practice connects it on Integrations with the key from Practice Settings, LeadDash Employees. Until then there are no claims, paperwork or notes to read.";
  const s = v.snapshot;
  if (!s) return `\nLeadDash EHR: connected as ${v.practice}${v.error ? `, but the last read failed (${v.error})` : ", first read pending"}.`;
  return `\nLeadDash EHR: connected as ${v.practice}, read ${v.fetchedAt ? v.fetchedAt.toISOString() : "recently"}. ${s.claims.length} denied or rejected claims, ${s.unpaid.reduce((n, u) => n + u.count, 0)} unpaid past 30 days (${money(s.totals.unpaid30Cents)}), ${s.balances.length} client balances (${money(s.totals.balancesCents)}), ${s.paperwork.filter((p) => p.status === "overdue").length} paperwork past due, ${s.docs.reduce((n, d) => n + d.unsigned, 0)} unsigned notes. Clients are initials; the detail is on the Desk tabs and in the EHR.`;
}
