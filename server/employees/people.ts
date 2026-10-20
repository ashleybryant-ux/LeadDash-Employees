import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, HrPerson } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import { notify } from "../notify";
import { withUsage } from "../usage";
import { employeeFor, systemPromptFor, working, actor } from "./tasks";
import { onboardingAnswers } from "./onboarding";
import { HUMAN_EMAIL } from "./human";
import { parse, type ChecklistItem, type NewHire } from "./hiring";

/**
 * Imani's people work: new hires from offer to their 90-day check-in, and
 * people leaving, from the news to their last day. Customer onboarding stays
 * in customers.ts.
 *
 * Lines Imani never crosses:
 * - No client names or clinical detail anywhere. A caseload handoff is counts only.
 * - She never changes a password or removes anyone's access. Access items are
 *   reminders for the owner or their admin on the last day.
 * - Every email waits in Approvals.
 */

export type Checkin = { days: number; date: string; posted: boolean };
export type Welcome = { outboundItemId: number; status: string };
export type Onboarding = NewHire & { role?: string; accounts?: ChecklistItem[]; planLaunchId?: number | null; welcome?: Welcome | null; checkins?: Checkin[] };
export type Offboarding = {
  /** YYYY-MM-DD. */
  lastDay: string;
  reason: string;
  /** null until the owner says whether they see clients. */
  caseload: boolean | null;
  /** YYYY-MM-DD, or null. */
  exitInterview: string | null;
  planLaunchId: number | null;
  clients: ChecklistItem[];
  access: ChecklistItem[];
  pay: ChecklistItem[];
  /** The last-day access reminder went out. */
  reminded?: boolean;
};
export type OnboardingList = "paperwork" | "credentialing" | "accounts";
export type OffboardingList = "clients" | "access" | "pay";

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const DAY = 86_400_000;
const CLINICIAN = /\b(LPC|LMFT|LCSW|LADC|LMHC|PSYD|PHD|MD|NP|LPC-?C|LMSW|CANDIDATE|therapist|counselor|clinician|psychologist|psychiatrist|social worker)\b/i;

const item = (text: string, detail = ""): ChecklistItem => ({ item: text, detail, status: "to_do" });

// ==========================================
// Dates
// ==========================================

/** "2026-10-26" or "10/26/2026" to "2026-10-26"; "" when it's neither. */
export function toYmd(v: string | null | undefined) {
  const s = (v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}
const toMdy = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;
export const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const ymdIn = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });
export const longDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
/** Monday to Friday: a Saturday or Sunday moves to the next Monday. */
const weekday = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return d === 6 ? addDays(ymd, 2) : d === 0 ? addDays(ymd, 1) : ymd;
};
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

// ==========================================
// People
// ==========================================

async function imaniOf(orgId: number) {
  return employeeFor(orgId, "onboarding");
}

async function post(emp: AIEmployee, content: string) {
  return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content });
}

/** Someone already in this workspace's people by name: exact first, then a first name that only one person has. */
export async function findPerson(orgId: number, name: string) {
  const n = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!n) return null;
  const all = (await db.listHrPeople(orgId)).filter((p) => p.source === "staff" || ["offer", "hired", "leaving", "left"].includes(p.stage));
  const exact = all.filter((p) => p.name.trim().toLowerCase() === n);
  if (exact.length) return exact.sort((a, b) => b.id - a.id)[0];
  const byFirst = all.filter((p) => p.name.trim().toLowerCase().startsWith(`${n} `));
  return byFirst.length === 1 ? byFirst[0] : null;
}

/** Their role here: what Quinn hired them for, or what the owner said in chat. */
async function roleOf(orgId: number, p: HrPerson) {
  const hire = parse<Onboarding>(p.onboarding, { paperwork: [], credentialing: [] });
  const off = parse<Partial<Offboarding>>(p.offboarding, {});
  const role = p.roleId ? (await db.getHrRole(p.roleId, orgId))?.title : null;
  if (role) return [role, p.credentials].filter(Boolean).join(", ");
  return hire.role || (off as { role?: string }).role || (p.source === "staff" ? p.currentRole : null) || p.credentials || "";
}

async function practiceSoftware(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  if (org?.orgType !== "healthcare") return "Practice software account";
  const ehr = await import("../ehr");
  return (await ehr.connection(orgId)) ? "LeadDash EHR account" : "Practice software account";
}

/** "Email and calendar, phone system; payroll app" to one step each. */
function steps(text: string | undefined) {
  return (text ?? "")
    .split(/[,;\n]+/)
    .map((s) => s.replace(/^\s*(and|then)\s+/i, "").trim())
    .filter((s) => s.length > 1)
    .map((s) => (s[0].toUpperCase() + s.slice(1)).slice(0, 120))
    .slice(0, 10);
}

function addMissing(list: ChecklistItem[], extra: string[]) {
  const out = [...list];
  for (const e of extra) if (!out.some((x) => x.item.toLowerCase() === e.toLowerCase())) out.push(item(e));
  return out;
}

const counts = (lists: ChecklistItem[][]) => {
  const all = lists.flat();
  return { done: all.filter((i) => i.status === "done").length, total: all.length };
};

// ==========================================
// New hires
// ==========================================

function defaultPaperwork(healthcare: boolean, clinician: boolean): ChecklistItem[] {
  return [
    item("Offer letter signed"),
    item("Form I-9", "Section 2 is due within 3 business days of the start date"),
    item("Form W-4 or W-9"),
    item("Handbook acknowledgment"),
    ...(healthcare ? [item("HIPAA training certificate")] : []),
    ...(clinician ? [item("Malpractice insurance")] : []),
  ];
}

/** Takes a new hire from Quinn or from chat: accounts and training, a first-week plan, the welcome email and 30, 60 and 90 day check-ins. */
export async function onboardHire(orgId: number, input: { personId?: number; name?: string; role?: string; startDate?: string; email?: string }) {
  const imani = await imaniOf(orgId);
  const org = await db.getOrganizationById(orgId);
  let person = input.personId ? await db.getHrPerson(input.personId, orgId) : await findPerson(orgId, input.name ?? "");
  if (input.personId && !person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const name = (person?.name ?? input.name ?? "").trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Who is starting?" });
  const start = toYmd(input.startDate) || toYmd(person?.startDate);
  if (!start) throw new TRPCError({ code: "BAD_REQUEST", message: `When does ${first(name)} start?` });
  const email = /@/.test(input.email ?? "") ? input.email!.trim().slice(0, 200) : person?.email ?? null;
  const role = (input.role ?? "").trim().slice(0, 120);
  if (!person) {
    person = await db.createHrPerson({ organizationId: orgId, source: "staff", stage: "hired", name, currentRole: role || null, email, startDate: toMdy(start) });
  } else {
    person = (await db.updateHrPerson(person.id, orgId, { stage: "hired", startDate: toMdy(start), email, ...(role && person.source === "staff" ? { currentRole: role } : {}) }))!;
  }
  const personId = person.id;
  const roleText = role || (await roleOf(orgId, person));
  const healthcare = org?.orgType === "healthcare";
  const clinician = CLINICIAN.test(`${roleText} ${person.credentials ?? ""}`);
  const answers = await onboardingAnswers(imani);
  const software = await practiceSoftware(orgId);

  const setup = await working(
    imani,
    async () => {
      const hire = parse<Onboarding>(person!.onboarding, { paperwork: [], credentialing: [] });
      // The practice software account is an account, not paperwork.
      const paperwork = (hire.paperwork.length ? hire.paperwork : defaultPaperwork(healthcare, clinician)).filter((i) => !/EHR account|practice software/i.test(i.item));
      const accounts = hire.accounts?.length
        ? hire.accounts
        : addMissing([item("Email and calendar"), item(software), ...(clinician ? [item("Shadow two sessions")] : [])], [...steps(answers.hireAccounts), ...steps(answers.hireTraining)]);
      const checkins = hire.checkins?.length ? hire.checkins : [30, 60, 90].map((days) => ({ days, date: addDays(start, days), posted: false }));
      let planLaunchId = hire.planLaunchId ?? null;
      let plan: { launch: Awaited<ReturnType<typeof db.getLaunch>>; counts: { milestones: number; tasks: number; owners: number }; auto: boolean } | null = null;
      if (!planLaunchId) {
        try {
          const pj = await import("./projects");
          const r = await pj.planLaunch(orgId, {
            name: `${name} onboarding`,
            date: weekday(addDays(start, 4)),
            brief: `New hire onboarding: ${name}${roleText ? `, ${roleText}` : ""}, starts ${longDate(start)}. Plan what happens before day one and through the first week, ending on the plan date. Keep it small: about 8 to 12 tasks.
Milestones: "Ready for day one" (the work day before ${longDate(start)}), "First day" (${longDate(start)}), and "End of week one" on the plan date.
${answers.hireFirstDay ? `The owner's first-day plan: ${answers.hireFirstDay}.\n` : ""}Accounts and training to finish: ${accounts.map((a) => a.item).join("; ")}.
Paperwork to collect: ${paperwork.map((p) => p.item).join("; ")}.
The onboarding specialist (job key: onboarding) owns the welcome email, paperwork reminders and check-ins. The owner or their admin sets up accounts and access and runs the first day. Never put a client's name or anything clinical in a task.`,
          });
          planLaunchId = r.launch.id;
          plan = { launch: r.launch, counts: await pj.planCounts(orgId, r.launch.id), auto: r.auto };
        } catch (err) {
          console.warn(`[people] no first-week plan for hire ${personId}:`, err instanceof Error ? err.message : err);
        }
      }
      return { paperwork, accounts, checkins, planLaunchId, plan, credentialing: hire.credentialing };
    },
    { job: "task", label: `Onboarding for ${name}` }
  );

  const fresh = (await db.getHrPerson(personId, orgId))!;
  const before = parse<Onboarding>(fresh.onboarding, { paperwork: [], credentialing: [] });
  let welcome = before.welcome ?? null;
  if (!welcome && email) welcome = await welcomeEmail(imani, { personId, name, email, role: roleText, start, firstDay: answers.hireFirstDay ?? "" }).catch((err) => {
    console.warn(`[people] no welcome email for hire ${personId}:`, err instanceof Error ? err.message : err);
    return null;
  });
  // Read again: the owner may have edited a checklist while the plan was being written.
  const latest = parse<Onboarding>((await db.getHrPerson(personId, orgId))!.onboarding, { paperwork: [], credentialing: [] });
  const next: Onboarding = {
    ...latest,
    role: roleText || latest.role,
    paperwork: latest.paperwork.length ? latest.paperwork.filter((i) => !/EHR account|practice software/i.test(i.item)) : setup.paperwork,
    credentialing: latest.credentialing?.length ? latest.credentialing : setup.credentialing ?? [],
    accounts: latest.accounts?.length ? latest.accounts : setup.accounts,
    checkins: latest.checkins?.length ? latest.checkins : setup.checkins,
    planLaunchId: latest.planLaunchId ?? setup.planLaunchId,
    welcome,
  };
  const saved = (await db.updateHrPerson(personId, orgId, { onboarding: JSON.stringify(next) }))!;
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(imani), action: "Started onboarding", details: name });
  return { person: saved, onboarding: next, plan: setup.plan, emailQueued: !!welcome && !before.welcome, start };
}

async function signerOf(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  return [org?.signerName, org?.name].filter(Boolean).join(", ") || "the team";
}

async function welcomeEmail(imani: AIEmployee, h: { personId: number; name: string; email: string; role: string; start: string; firstDay: string }): Promise<Welcome> {
  return working(
    imani,
    async () => {
      const { system } = await systemPromptFor(
        imani,
        `Your job: write the welcome email from the owner to a new hire before their first day.
- A short subject, then 4 to 7 short sentences: welcome them by first name, the start date, what the first day looks like (from the owner's first-day plan when there is one), what to bring (ID for the I-9), and who to reply to with questions. Sign with the owner's name from the Brain.
- Where something is the owner's to decide (an arrival time), use a bracketed placeholder.
- Never promise pay, benefits or anything the Brain doesn't state.

${HUMAN_EMAIL}`
      );
      const out = await generateJson<{ subject: string; body: string }>({
        system,
        prompt: `New hire: ${h.name}${h.role ? `, ${h.role}` : ""}\nStart date: ${longDate(h.start)}${h.firstDay ? `\nThe owner's first-day plan: ${h.firstDay}` : ""}\nSigner: ${await signerOf(imani.organizationId)}`,
        schemaName: "welcome_email",
        schema: obj({ subject: str, body: str }),
      });
      const row = await db.createOutboundItem({
        organizationId: imani.organizationId,
        employeeId: imani.id,
        kind: "email_draft",
        status: "pending_approval",
        title: out.subject || `Welcome, ${first(h.name)}`,
        body: out.body,
        targetChannels: JSON.stringify(["Gmail"]),
        metadata: JSON.stringify({ recipient: h.name, email: h.email, whatTheyWant: `Welcome to the team (${h.name})`, urgency: "today", newEmail: true, personId: h.personId }),
      });
      await db.logAction({ organizationId: imani.organizationId, actorType: "employee", actorName: actor(imani), action: "Drafted email", details: `Welcome email to ${h.name} is waiting for approval.` });
      return { outboundItemId: row.id, status: row.status };
    },
    { job: "email" }
  );
}

const pending = new Set<Promise<unknown>>();

/** Quinn marked someone hired: Imani takes over without holding up the Hired button. */
export function handOffHire(orgId: number, personId: number) {
  const run = (async () => {
    const p = await db.getHrPerson(personId, orgId);
    const imani = await db.getEmployeeByKind(orgId, "onboarding");
    if (!p || !imani || imani.status === "paused") return;
    const start = toYmd(p.startDate);
    const { handoff } = await import("./team");
    await handoff(orgId, "hiring", "onboarding", `${p.name} is hired${start ? `, starting ${longDate(start)}` : ""}. Over to you for onboarding.`, "/chats/onboarding/work");
    if (!start) {
      await post(imani, `Quinn marked ${p.name} hired. When does ${first(p.name)} start? Tell me and I'll set up the first week, the welcome email and the check-ins.`);
      return;
    }
    const r = await onboardHire(orgId, { personId });
    await post(imani, hireSummary(r));
  })().catch((err) => console.warn(`[people] onboarding hand-off for ${personId} failed:`, err instanceof Error ? err.message : err));
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

/** Tests wait for hand-offs that are still running. */
export async function settled() {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.all(Array.from(pending));
}

export function hireSummary(r: Awaited<ReturnType<typeof onboardHire>>) {
  const name = first(r.person.name);
  const checks = (r.onboarding.checkins ?? []).map((c) => longDate(c.date));
  const plan = r.plan ? `a first-week plan in Projects (${r.plan.counts.tasks} tasks${r.plan.auto ? "" : ", waiting for your OK on Nora's Projects tab"}), ` : "";
  return `I set up ${name}'s onboarding for ${longDate(r.start)}: ${plan}the paperwork and accounts checklists, and check-ins on ${checks.join(", ")}.${r.emailQueued ? " The welcome email is waiting for your OK in Approvals." : r.onboarding.welcome ? "" : ` Send me ${name}'s email and I'll write the welcome.`}`;
}

/** Reminds a new hire what's still open: an email for approval, or a note in chat when there's no email. */
export async function remindHire(orgId: number, personId: number) {
  const p = await db.getHrPerson(personId, orgId);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const imani = await imaniOf(orgId);
  const hire = parse<Onboarding>(p.onboarding, { paperwork: [], credentialing: [] });
  const open = [...hire.paperwork, ...(hire.credentialing ?? [])].filter((i) => i.status !== "done").map((i) => i.item);
  if (!open.length) return { queued: false, posted: false, open: 0 };
  const start = toYmd(p.startDate);
  if (p.email) {
    const body = `Hi ${first(p.name)},\n\nA quick reminder of what's still open${start ? ` before ${longDate(start)}` : ""}:\n${open.map((o) => `- ${o}`).join("\n")}\n\nReply here with any questions.\n\n${await signerOf(orgId)}`;
    await db.createOutboundItem({
      organizationId: orgId,
      employeeId: imani.id,
      kind: "email_draft",
      status: "pending_approval",
      title: "A few things still open",
      body,
      targetChannels: JSON.stringify(["Gmail"]),
      metadata: JSON.stringify({ recipient: p.name, email: p.email, whatTheyWant: `Onboarding reminder (${p.name})`, urgency: "today", newEmail: true, personId }),
    });
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(imani), action: "Drafted email", details: `Onboarding reminder to ${p.name} is waiting for approval.` });
    return { queued: true, posted: false, open: open.length };
  }
  await post(imani, `Reminder for ${p.name}: still open ${open.join(", ")}. I don't have ${first(p.name)}'s email, so pass it on or send me the email and I'll write it.`);
  return { queued: false, posted: true, open: open.length };
}

// ==========================================
// People leaving
// ==========================================

function clientItems(): ChecklistItem[] {
  return [item("Caseload handoff plan (counts only, no names)"), item("Notes signed and closed"), item("Clients told of the change")];
}

/** Someone is leaving: the checklist, a plan in Projects, and the last-day access reminder. Never client names. */
export async function offboard(orgId: number, input: { name: string; lastDay?: string; reason?: string; caseload?: boolean | null; role?: string }) {
  const imani = await imaniOf(orgId);
  const org = await db.getOrganizationById(orgId);
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "Who is leaving?" });
  let person = await findPerson(orgId, name);
  const existing = person ? parse<Offboarding | null>(person.offboarding, null) : null;
  const lastDay = toYmd(input.lastDay) || existing?.lastDay || "";
  if (!lastDay) throw new TRPCError({ code: "BAD_REQUEST", message: `What's ${first(name)}'s last day?` });
  const role = (input.role ?? "").trim().slice(0, 120);
  if (!person) person = await db.createHrPerson({ organizationId: orgId, source: "staff", stage: "leaving", name, currentRole: role || null });
  else person = (await db.updateHrPerson(person.id, orgId, { stage: "leaving", ...(role && person.source === "staff" ? { currentRole: role } : {}) }))!;
  const personId = person.id;
  const roleText = role || (await roleOf(orgId, person));
  const reason = (input.reason ?? "").trim().slice(0, 300);
  const caseload = typeof input.caseload === "boolean" ? input.caseload : existing?.caseload ?? null;

  if (existing) {
    // Already set up: only what changed. A caseload answer adds or drops the client steps.
    const clients = caseload === true ? (existing.clients.length ? existing.clients : clientItems()) : caseload === false ? [] : existing.clients;
    const next: Offboarding = { ...existing, lastDay, reason: reason || existing.reason, caseload, clients, reminded: lastDay === existing.lastDay ? existing.reminded : false };
    const saved = (await db.updateHrPerson(personId, orgId, { offboarding: JSON.stringify(next) }))!;
    return { person: saved, offboarding: next, plan: null, created: false, ask: askCaseload(org?.orgType, roleText, caseload) };
  }

  const answers = await onboardingAnswers(imani);
  const software = await practiceSoftware(orgId);
  const built = await working(
    imani,
    async () => {
      const off: Offboarding = {
        lastDay,
        reason,
        caseload,
        exitInterview: null,
        planLaunchId: null,
        clients: caseload ? clientItems() : [],
        access: [item(`${software.replace(/ account$/, "")} access removed (last day)`), item("Email and calendar access removed"), item("Laptop and keys returned")],
        pay: addMissing([item("Final paycheck date confirmed"), item("Benefits end letter")], steps(answers.leaveSteps)),
      };
      let plan: { launch: Awaited<ReturnType<typeof db.getLaunch>>; counts: { milestones: number; tasks: number; owners: number }; auto: boolean } | null = null;
      try {
        const pj = await import("./projects");
        const r = await pj.planLaunch(orgId, {
          name: `${name} offboarding`,
          date: lastDay,
          brief: `Offboarding: ${name}${roleText ? `, ${roleText}` : ""}, last day ${longDate(lastDay)}${reason ? ` (${reason})` : ""}. Plan the steps from today through the last day, which is the plan date. Keep it small: about 8 to 12 tasks.
Milestones: "Exit interview set", "Work handed off", and "Last day" on the plan date.
Steps: ${[...off.clients, ...off.access, ...off.pay].map((i) => i.item).join("; ")}.
Access removal happens on the last day and is done by the owner or their admin; the onboarding specialist (job key: onboarding) only reminds them and never changes passwords. A caseload handoff is counts only. Never put a client's name or anything clinical in a task.`,
        });
        off.planLaunchId = r.launch.id;
        plan = { launch: r.launch, counts: await pj.planCounts(orgId, r.launch.id), auto: r.auto };
      } catch (err) {
        console.warn(`[people] no offboarding plan for ${personId}:`, err instanceof Error ? err.message : err);
      }
      return { off, plan };
    },
    { job: "task", label: `Offboarding for ${name}` }
  );
  const saved = (await db.updateHrPerson(personId, orgId, { offboarding: JSON.stringify(built.off) }))!;
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(imani), action: "Started offboarding", details: name });
  return { person: saved, offboarding: built.off, plan: built.plan, created: true, ask: askCaseload(org?.orgType, roleText, caseload) };
}

/** Ask about a caseload only when nobody said and the person may see clients. */
function askCaseload(orgType: string | null | undefined, role: string, caseload: boolean | null) {
  if (caseload !== null) return null;
  if (CLINICIAN.test(role)) return "sees";
  return orgType === "healthcare" ? "maybe" : null;
}

// ==========================================
// Checklist edits
// ==========================================

export async function saveOnboarding(orgId: number, personId: number, lists: Partial<Record<OnboardingList, ChecklistItem[]>>) {
  const p = await db.getHrPerson(personId, orgId);
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const hire = parse<Onboarding>(p.onboarding, { paperwork: [], credentialing: [] });
  const next: Onboarding = { ...hire };
  for (const k of ["paperwork", "credentialing", "accounts"] as const) if (lists[k]) next[k] = lists[k]!.filter((i) => i.item.trim());
  return db.updateHrPerson(personId, orgId, { onboarding: JSON.stringify(next) });
}

export async function saveOffboarding(orgId: number, personId: number, input: { lists: Partial<Record<OffboardingList, ChecklistItem[]>>; reason?: string; exitInterview?: string | null }) {
  const p = await db.getHrPerson(personId, orgId);
  const off = p ? parse<Offboarding | null>(p.offboarding, null) : null;
  if (!p || !off) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not leaving in this workspace." });
  const next: Offboarding = { ...off };
  for (const k of ["clients", "access", "pay"] as const) if (input.lists[k]) next[k] = input.lists[k]!.filter((i) => i.item.trim());
  if (typeof input.reason === "string") next.reason = input.reason.trim().slice(0, 300);
  if (input.exitInterview !== undefined) next.exitInterview = toYmd(input.exitInterview) || null;
  return db.updateHrPerson(personId, orgId, { offboarding: JSON.stringify(next) });
}

// ==========================================
// The Work tab and Imani's chat facts
// ==========================================

async function planOf(orgId: number, id: number | null | undefined) {
  if (!id) return null;
  const l = await db.getLaunch(id, orgId);
  if (!l) return null;
  return { id: l.id, name: l.name, status: l.status, tasks: (await db.listLaunchTasks(l.id, orgId)).length, listId: l.pjListId ?? null };
}

async function welcomeOf(orgId: number, w: Welcome | null | undefined) {
  if (!w) return null;
  const row = await db.getOutboundItemForOrg(w.outboundItemId, orgId);
  if (!row) return null;
  const at = row.publishedAt ?? row.approvedAt ?? null;
  return { status: row.status, at: at ? at.toISOString() : null };
}

/** Hire plans are "<Name> onboarding" too; the Customers tab leaves them out. */
async function hirePlanIds(orgId: number) {
  return new Set((await db.listHrPeople(orgId)).map((p) => parse<Onboarding>(p.onboarding, { paperwork: [], credentialing: [] }).planLaunchId).filter((x): x is number => !!x));
}

export async function customerLaunches(orgId: number) {
  const hires = await hirePlanIds(orgId);
  return (await db.listLaunches(orgId)).filter((l) => / onboarding$/i.test(l.name) && l.status !== "dropped" && !hires.has(l.id));
}

export async function view(orgId: number) {
  const people = await db.listHrPeople(orgId);
  const recent = Date.now() - 120 * DAY;
  const hires = [];
  for (const p of people.filter((x) => x.stage === "hired").sort((a, b) => (toYmd(a.startDate) || "9").localeCompare(toYmd(b.startDate) || "9"))) {
    const start = toYmd(p.startDate);
    if (start && Date.parse(`${start}T12:00:00Z`) < recent) continue;
    const h = parse<Onboarding>(p.onboarding, { paperwork: [], credentialing: [] });
    const lists = { paperwork: h.paperwork ?? [], credentialing: h.credentialing ?? [], accounts: h.accounts ?? [] };
    hires.push({ id: p.id, name: p.name, role: await roleOf(orgId, p), start: start || null, email: p.email, ...lists, ...counts(Object.values(lists)), checkins: h.checkins ?? [], plan: await planOf(orgId, h.planLaunchId), welcome: await welcomeOf(orgId, h.welcome) });
  }
  const leaving = [];
  for (const p of people.filter((x) => x.stage === "leaving")) {
    const o = parse<Offboarding | null>(p.offboarding, null);
    if (!o) continue;
    const lists = { clients: o.clients ?? [], access: o.access ?? [], pay: o.pay ?? [] };
    leaving.push({ id: p.id, name: p.name, role: await roleOf(orgId, p), lastDay: o.lastDay, reason: o.reason, caseload: o.caseload, exitInterview: o.exitInterview, ...lists, ...counts(Object.values(lists)), plan: await planOf(orgId, o.planLaunchId) });
  }
  leaving.sort((a, b) => a.lastDay.localeCompare(b.lastDay));
  const customers = [];
  for (const l of await customerLaunches(orgId)) {
    const tasks = await db.listLaunchTasks(l.id, orgId);
    customers.push({ id: l.id, name: l.name.replace(/ onboarding$/i, ""), goLive: l.launchDate.toISOString(), status: l.status, done: tasks.filter((t) => t.status === "done").length, total: tasks.length, listId: l.pjListId ?? null });
  }
  return { hires, leaving, customers };
}

/** What Imani knows in chat: new hires, people leaving, then customers. Never client names. */
export async function peopleFacts(orgId: number) {
  const v = await view(orgId);
  const hires = v.hires.map((h) => {
    const next = h.checkins.find((c) => !c.posted);
    return `- ${h.name}${h.role ? `, ${h.role}` : ""}: starts ${h.start ? longDate(h.start) : "date not set"}, ${h.done} of ${h.total} done${next ? `, next check-in ${longDate(next.date)}` : ""}${h.welcome ? "" : h.email ? "" : ", no email on file"}`;
  });
  const leaving = v.leaving.map((l) => `- ${l.name}${l.role ? `, ${l.role}` : ""}: last day ${longDate(l.lastDay)}, ${l.done} of ${l.total} done${l.caseload === null ? ", caseload not asked yet" : l.caseload ? ", caseload handoff planned" : ", no caseload"}`);
  const { customersFacts } = await import("./customers");
  return `\nNew hires onboarding (your New hires tab):\n${hires.join("\n") || "- none"}\nPeople leaving (your Leaving tab):\n${leaving.join("\n") || "- none"}${await customersFacts(orgId)}`;
}

export async function peopleStatus(orgId: number) {
  const v = await view(orgId);
  const parts = [
    v.hires.length ? `${v.hires.length === 1 ? "1 new hire" : `${v.hires.length} new hires`} onboarding: ${v.hires.map((h) => `${h.name} (${h.done} of ${h.total} done)`).join(", ")}` : "No new hires onboarding",
    v.leaving.length ? `${v.leaving.length === 1 ? "1 person" : `${v.leaving.length} people`} leaving: ${v.leaving.map((l) => `${l.name} (last day ${longDate(l.lastDay)}, ${l.done} of ${l.total} done)`).join(", ")}` : "nobody leaving",
    `${v.customers.length === 1 ? "1 customer" : `${v.customers.length} customers`} onboarding`,
  ];
  return `${parts.join("; ")}.`;
}

// ==========================================
// Check-ins and last days
// ==========================================

let lastRun = "";

/** Once an hour: check-ins that came due and last-day access reminders post in Imani's chat. */
export async function peopleTicks(now = new Date()) {
  const hour = now.toISOString().slice(0, 13);
  if (hour === lastRun) return;
  lastRun = hour;
  for (const orgId of await db.listAwakeOrganizationIds()) await withUsage({ orgId, kind: "onboarding" }, () => peopleTicksFor(orgId, now)).catch((err) => console.warn(`[people] workspace ${orgId}:`, err instanceof Error ? err.message : err));
}

export async function peopleTicksFor(orgId: number, now = new Date()) {
  const imani = await db.getEmployeeByKind(orgId, "onboarding");
  if (!imani || imani.status === "paused") return;
  const org = await db.getOrganizationById(orgId);
  const today = ymdIn(now, org?.timezone || "America/Chicago");
  const weekAgo = addDays(today, -7);
  for (const p of await db.listHrPeople(orgId)) {
    if (p.stage === "hired" && p.onboarding) {
      const h = parse<Onboarding>(p.onboarding, { paperwork: [], credentialing: [] });
      const due = (h.checkins ?? []).filter((c) => !c.posted && c.date <= today);
      if (!due.length) continue;
      // Old ones (set up late) are marked without a message.
      for (const c of due.filter((x) => x.date >= weekAgo)) {
        const open = [...h.paperwork, ...(h.credentialing ?? []), ...(h.accounts ?? [])].filter((i) => i.status !== "done").map((i) => i.item);
        const text = `Today is ${p.name}'s ${c.days}-day check-in (${longDate(c.date)}). Ask how it's going, what's unclear and what they need.${open.length ? ` Still open: ${open.join(", ")}.` : ""}`;
        await post(imani, text);
        await notify(orgId, "deadline", { title: `${c.days}-day check-in: ${p.name}`, body: text.slice(0, 220), url: "/chats/onboarding/work", tag: `checkin-${p.id}-${c.days}` }).catch(() => {});
      }
      const checkins = (h.checkins ?? []).map((c) => (c.date <= today ? { ...c, posted: true } : c));
      await db.updateHrPerson(p.id, orgId, { onboarding: JSON.stringify({ ...h, checkins }) });
    }
    if (p.stage === "leaving" && p.offboarding) {
      const o = parse<Offboarding | null>(p.offboarding, null);
      if (!o) continue;
      if (!o.reminded && o.lastDay <= today) {
        const open = o.access.filter((i) => i.status !== "done").map((i) => i.item);
        if (o.lastDay >= weekAgo && open.length) {
          const text = `Today is ${p.name}'s last day. For you or your admin: ${open.join(", ")}. I don't change passwords or remove access myself.`;
          await post(imani, text);
          await notify(orgId, "deadline", { title: `Last day: ${p.name}`, body: text.slice(0, 220), url: "/chats/onboarding/work", tag: `lastday-${p.id}` }).catch(() => {});
        }
        await db.updateHrPerson(p.id, orgId, { offboarding: JSON.stringify({ ...o, reminded: true }) });
      }
      // Once the last day has passed and everything is done, they've left.
      const all = [...o.clients, ...o.access, ...o.pay];
      if (o.lastDay < today && all.every((i) => i.status === "done")) await db.updateHrPerson(p.id, orgId, { stage: "left" });
    }
  }
}
