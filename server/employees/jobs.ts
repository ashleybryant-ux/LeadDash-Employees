import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import * as db from "../db";
import { hrRoles, type HrPerson, type HrRole, type Organization } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import { employeeFor, systemPromptFor, working, actor } from "./tasks";
import { onboardingAnswers } from "./onboarding";
import { addApplicant, FAIR, parse, roleSummary } from "./hiring";

/**
 * Quinn's job descriptions and where they are posted.
 *
 * Publish puts a role on the workspace's careers page (/careers/<workspace>/<job>,
 * with Google's job markup, in the sitemap and in the job feed Indeed reads; see
 * ../careers.ts) and on every outside channel the server is connected to. The
 * screen and the chat never name the channels: they see only whether the job is
 * live, since when, how many applied and the job page link.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });

/** The parts of a job description that have no column of their own (title, must have and nice to have do). */
export type JobDescription = { about: string; schedule: string; duties: string; howToApply: string; hoursPerWeek?: number };
type Channels = { frappe?: string };

/** No em or en dashes in anything people read. */
const plain = (s: string | null | undefined) => (s ?? "").replace(/\s*[\u2014\u2013]\s*/g, ", ").trim();

export function readJd(role: Pick<HrRole, "jd">): JobDescription | null {
  const jd = parse<Partial<JobDescription> | null>(role.jd, null);
  if (!jd) return null;
  return { about: jd.about ?? "", schedule: jd.schedule ?? "", duties: jd.duties ?? "", howToApply: jd.howToApply ?? "", ...(jd.hoursPerWeek ? { hoursPerWeek: jd.hoursPerWeek } : {}) };
}

/** Duties as one line each, without bullet marks. */
export function lines(text: string | null | undefined) {
  return (text ?? "")
    .split(/\r?\n|;\s+/)
    .map((l) => l.replace(/^\s*([-*\u2022]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

/** The plain-text post (Copy post) made from the description. */
export function postText(role: Pick<HrRole, "title" | "mustHave" | "niceToHave">, jd: JobDescription) {
  const list = (t: string | null | undefined) => lines(t).map((l) => `- ${l}`).join("\n");
  return [
    role.title,
    jd.about,
    jd.schedule ? `Schedule and pay: ${jd.schedule}` : "",
    jd.duties ? `What you'll do\n${list(jd.duties)}` : "",
    role.mustHave ? `Must have\n${list(role.mustHave)}` : "",
    role.niceToHave ? `Nice to have\n${list(role.niceToHave)}` : "",
    jd.howToApply ? `How to apply\n${jd.howToApply}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function quinn(orgId: number) {
  return employeeFor(orgId, "hiring");
}

async function findRole(orgId: number, roleId: number) {
  const role = await db.getHrRole(roleId, orgId);
  if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "That role is not in this workspace." });
  return role;
}

// ==========================================
// Writing the description
// ==========================================

type Written = { about: string; schedule: string; duties: string[]; mustHave: string; niceToHave: string; howToApply: string };

/** Quinn writes (or rewrites) the role's job description from the role and the Brain. `notes` are the owner's own words from chat. */
export async function writeJobDescription(orgId: number, roleId: number, notes = "") {
  const role = await findRole(orgId, roleId);
  const emp = await quinn(orgId);
  const saved = await working(
    emp,
    async () => {
      const answers = await onboardingAnswers(emp);
      const old = readJd(role);
      const { system } = await systemPromptFor(
        emp,
        `Your job: write the job description for this role, the way a good practice manager writes one. Plain, specific, human words; no hype, no "rockstar", no "fast-paced environment".
- about: 2 short sentences: who the practice is (from the Brain) and what this person does there.
- schedule: one line with the hours and the pay, like "20 hours a week, $18 to $20 an hour". Use the role's pay and hours and what the owner said. Never invent pay: leave pay out when it is not set.
- duties: 4 to 6 short lines, each one thing the person will do, starting with a verb ("Greet clients and answer calls").
- mustHave: the role's must-haves in one short line (keep the owner's words when the role has them). When the role has none, the 1 or 2 things this job truly needs.
- niceToHave: the role's nice-to-haves in one short line, or "" when there are none.
- howToApply: one short line. "Apply on the job page" unless the Brain says otherwise.
- Never promise benefits the Brain does not list. Never use em dashes or en dashes.
${FAIR}`
      );
      const out = await generateJson<Written>({
        system,
        prompt: `${roleSummary(role)}${old?.hoursPerWeek ? `\nHours a week: ${old.hoursPerWeek}` : ""}${answers.greatFit ? `\nWhat makes someone a great fit: ${answers.greatFit}` : ""}${notes.trim() ? `\nWhat the owner said: ${notes.trim()}` : ""}${old?.duties ? `\nThe current description, to improve on:\n${old.schedule}\n${old.duties}` : ""}`,
        schemaName: "job_description",
        schema: obj({ about: str, schedule: str, duties: arr(str), mustHave: str, niceToHave: str, howToApply: str }),
      });
      const jd: JobDescription = {
        about: plain(out.about).slice(0, 600),
        schedule: plain(out.schedule).slice(0, 200),
        duties: (out.duties ?? []).map(plain).filter(Boolean).slice(0, 8).join("\n"),
        howToApply: plain(out.howToApply).slice(0, 300) || "Apply on the job page",
        ...(old?.hoursPerWeek ? { hoursPerWeek: old.hoursPerWeek } : {}),
      };
      const mustHave = role.mustHave || plain(out.mustHave).slice(0, 1000) || null;
      const niceToHave = role.niceToHave || plain(out.niceToHave).slice(0, 1000) || null;
      const updated = await db.updateHrRole(roleId, orgId, { jd: JSON.stringify(jd), mustHave, niceToHave, post: postText({ title: role.title, mustHave, niceToHave }, jd) });
      await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Wrote job description", details: role.title });
      return updated!;
    },
    { job: "doc", label: "Job description" }
  );
  await resync(orgId, saved);
  return saved;
}

/** The owner's Edit on the Roles tab. */
export async function saveDescription(orgId: number, roleId: number, input: { title: string; schedule: string; duties: string; mustHave: string; niceToHave: string }) {
  const role = await findRole(orgId, roleId);
  const jd: JobDescription = { ...(readJd(role) ?? { about: "", howToApply: "Apply on the job page" }), schedule: plain(input.schedule), duties: plain(input.duties) } as JobDescription;
  const next = { title: plain(input.title), mustHave: plain(input.mustHave) || null, niceToHave: plain(input.niceToHave) || null };
  const saved = (await db.updateHrRole(roleId, orgId, { ...next, jd: JSON.stringify(jd), post: postText(next, jd) }))!;
  await resync(orgId, saved);
  return saved;
}

// ==========================================
// "We need a part-time front desk person" in chat
// ==========================================

type FromChat = {
  title: string;
  employment: "w2" | "1099";
  hours: "full" | "part";
  place: "in_person" | "telehealth" | "both";
  hoursPerWeek: number;
  payFrom: string;
  payTo: string;
  mustHave: string;
  niceToHave: string;
  ask: string;
  choices: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Finds the role the owner means (or adds it), fills in what they said and what
 * the Brain answers, and asks only for what is still missing: the hours and the
 * pay, with choices. Once nothing is missing it writes the description.
 */
export async function roleFromChat(orgId: number, input: { title: string; notes: string }) {
  const emp = await quinn(orgId);
  const open = (await db.listHrRoles(orgId)).filter((r) => r.status === "open");
  const t = norm(input.title);
  let role = (t && open.find((r) => norm(r.title) === t || norm(r.title).includes(t) || t.includes(norm(r.title)))) || null;
  if (!role && !t) role = open[0] ?? null;
  const { system } = await systemPromptFor(
    emp,
    `Your job: set up a role from what the owner said in chat, so you can write its job description.
- Fill each field from what the owner said, then from the Brain (pay ranges, hours, in person or telehealth, location). Keep what the role already has unless the owner changed it.
- title: a clear job title applicants search for, with "(part time)" for a part-time role, like "Front desk coordinator (part time)".
- payFrom and payTo: like "$18 an hour" or "$60,000 a year", or "" when neither the owner nor the Brain gives the pay. Never guess pay.
- hoursPerWeek: the hours a week when said or in the Brain, else 0.
- ask: when the pay is still unknown, or a part-time role's hours a week are, one short question asking only for what is missing, like "How many hours a week, and what's the pay?". Otherwise "".
- choices: with a question, 2 short answers that fit this role and region, written as the owner would say them, like "20 hours, $18 to $20". [] otherwise.
${FAIR}`
  );
  const out = await generateJson<FromChat>({
    system,
    prompt: `${role ? `The role so far:\n${roleSummary(role)}${readJd(role)?.hoursPerWeek ? `\nHours a week: ${readJd(role)!.hoursPerWeek}` : ""}` : "No role is saved yet."}\nThe owner said: ${[input.title, input.notes].filter(Boolean).join(". ")}`,
    schemaName: "role_from_chat",
    schema: obj({
      title: str,
      employment: { type: "string", enum: ["w2", "1099"] },
      hours: { type: "string", enum: ["full", "part"] },
      place: { type: "string", enum: ["in_person", "telehealth", "both"] },
      hoursPerWeek: int,
      payFrom: str,
      payTo: str,
      mustHave: str,
      niceToHave: str,
      ask: str,
      choices: arr(str),
    }),
  });
  const pick = (v: string | undefined, was: string | null | undefined) => plain(v).slice(0, 1000) || was || null;
  const data = {
    title: plain(out.title).slice(0, 120) || role?.title || plain(input.title).slice(0, 120) || "New role",
    employment: out.employment === "1099" ? ("1099" as const) : ("w2" as const),
    hours: out.hours === "full" ? ("full" as const) : ("part" as const),
    place: (["in_person", "telehealth", "both"] as const).includes(out.place) ? out.place : role?.place ?? "both",
    payFrom: pick(out.payFrom, role?.payFrom)?.slice(0, 60) ?? null,
    payTo: pick(out.payTo, role?.payTo)?.slice(0, 60) ?? null,
    mustHave: pick(out.mustHave, role?.mustHave),
    niceToHave: pick(out.niceToHave, role?.niceToHave),
  };
  const hoursPerWeek = out.hoursPerWeek > 0 && out.hoursPerWeek <= 80 ? Math.round(out.hoursPerWeek) : readJd(role ?? { jd: null })?.hoursPerWeek;
  const jd = { ...(readJd(role ?? { jd: null }) ?? {}), ...(hoursPerWeek ? { hoursPerWeek } : {}) };
  const jdText = Object.keys(jd).length ? JSON.stringify(jd) : role?.jd ?? null;
  if (role) role = (await db.updateHrRole(role.id, orgId, { ...data, jd: jdText }))!;
  else {
    role = await db.createHrRole({ organizationId: orgId, ...data, jd: jdText });
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Added role", details: role.title });
  }
  const missing = !data.payFrom && !data.payTo ? true : data.hours === "part" && !hoursPerWeek;
  if (missing && plain(out.ask)) {
    const choices = (out.choices ?? []).map(plain).filter(Boolean).slice(0, 3);
    return { role, ask: plain(out.ask), choices: [...choices, "I'll type it"] };
  }
  const written = await writeJobDescription(orgId, role.id, input.notes);
  return { role: written, ask: "", choices: [] as string[] };
}

// ==========================================
// Publishing
// ==========================================

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "job";

export function jobUrl(org: Pick<Organization, "slug">, role: Pick<HrRole, "slug">) {
  return `${ENV.appUrl}/careers/${org.slug}/${role.slug}`;
}

/** All the screen ever learns about where a job is posted. */
export function jobView(org: Pick<Organization, "slug">, role: Pick<HrRole, "slug" | "publishedAt" | "status">, applicants: number) {
  const live = !!role.publishedAt && role.status === "open" && !!role.slug;
  return { live, liveSince: live ? role.publishedAt : null, applicants, jobUrl: live ? jobUrl(org, role) : null };
}

async function applicantsFor(orgId: number, roleId: number) {
  return (await db.listHrPeople(orgId, "applicant")).filter((p) => p.roleId === roleId).length;
}

export async function publish(orgId: number, roleId: number) {
  let role = await findRole(orgId, roleId);
  if (!readJd(role)?.duties) role = await writeJobDescription(orgId, roleId);
  const org = (await db.getOrganizationById(orgId))!;
  let slug = role.slug;
  if (!slug) {
    const taken = new Set((await db.listHrRoles(orgId)).filter((r) => r.id !== roleId).map((r) => r.slug));
    slug = slugify(role.title);
    if (taken.has(slug)) slug = `${slug}-${roleId}`;
  }
  role = (await db.updateHrRole(roleId, orgId, { slug, status: "open", publishedAt: role.publishedAt ?? new Date() }))!;
  await toChannels(org, role, "publish");
  const emp = await quinn(orgId);
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Published job", details: role.title });
  return jobView(org, (await db.getHrRole(roleId, orgId))!, await applicantsFor(orgId, roleId));
}

export async function unpublish(orgId: number, roleId: number) {
  const role = await findRole(orgId, roleId);
  const org = (await db.getOrganizationById(orgId))!;
  const saved = (await db.updateHrRole(roleId, orgId, { publishedAt: null }))!;
  if (role.publishedAt) await toChannels(org, role, "unpublish");
  return jobView(org, saved, await applicantsFor(orgId, roleId));
}

/** After an edit or a rewrite, a live job is sent again so every channel shows the new words. */
async function resync(orgId: number, role: HrRole) {
  if (!role.publishedAt || role.status !== "open") return;
  const org = await db.getOrganizationById(orgId);
  if (org) await toChannels(org, role, "publish");
}

/** Every published, open role in every workspace (the sitemap and the job feed). */
export async function listPublished() {
  const rows = db.getDb().select().from(hrRoles).where(and(isNotNull(hrRoles.publishedAt), eq(hrRoles.status, "open"))).all();
  const orgs = new Map<number, Organization | null>();
  const out: { org: Organization; role: HrRole }[] = [];
  for (const role of rows) {
    if (!role.slug) continue;
    if (!orgs.has(role.organizationId)) orgs.set(role.organizationId, await db.getOrganizationById(role.organizationId));
    const org = orgs.get(role.organizationId);
    if (org) out.push({ org, role });
  }
  return out;
}

// ==========================================
// Applicants from the job page and outside channels
// ==========================================

/**
 * One application: lands in Candidates, scored like an uploaded resume. Never
 * lost: when scoring can't run (no readable text, no work hours left), the
 * applicant is still saved, unscored.
 */
export async function acceptApplication(orgId: number, roleId: number, input: { name: string; email: string; phone: string; text: string; resumeUrl: string | null; fileName: string }) {
  const email = input.email.trim().toLowerCase();
  const existing = (await db.listHrPeople(orgId, "applicant")).find((p) => p.roleId === roleId && (p.email ?? "").toLowerCase() === email);
  if (existing) return existing;
  const facts = { name: input.name.trim().slice(0, 160), email, ...(input.phone.trim() ? { phone: input.phone.trim().slice(0, 40) } : {}) };
  let person: HrPerson | null = null;
  try {
    person = await addApplicant(orgId, { roleId, text: input.text.trim() || `${facts.name}\n${email}`, resumeUrl: input.resumeUrl, fileName: input.fileName });
    person = await db.updateHrPerson(person.id, orgId, facts);
  } catch (err) {
    console.warn(`[jobs] scoring an applicant in workspace ${orgId} failed:`, err instanceof Error ? err.message : err);
    person = await db.createHrPerson({
      organizationId: orgId,
      roleId,
      source: "applicant",
      stage: "new",
      ...facts,
      resumeUrl: input.resumeUrl,
      resumeText: input.text.slice(0, 200_000) || null,
      appliedOn: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    });
  }
  return person!;
}

// ==========================================
// Channels
// ==========================================
// The careers page, its job markup, the sitemap and the job feed Indeed reads are
// served from ../careers.ts for every published role; they need nothing here.
// Channels that hold their own copy of a job are below. Another one (an ATS with
// a confirmed API, OpenCATS say) plugs in as one more entry in CHANNELS.

type Channel = {
  key: keyof Channels;
  enabled: () => boolean;
  publish: (org: Organization, role: HrRole, id: string | undefined) => Promise<string>;
  unpublish: (org: Organization, role: HrRole, id: string) => Promise<void>;
};

async function toChannels(org: Organization, role: HrRole, what: "publish" | "unpublish") {
  const ids = parse<Channels>(role.channels, {});
  let changed = false;
  for (const ch of CHANNELS) {
    if (!ch.enabled()) continue;
    try {
      if (what === "publish") {
        const id = await ch.publish(org, role, ids[ch.key]);
        if (id && id !== ids[ch.key]) {
          ids[ch.key] = id;
          changed = true;
        }
      } else if (ids[ch.key]) await ch.unpublish(org, role, ids[ch.key]!);
    } catch (err) {
      // A channel never blocks publishing.
      console.warn(`[jobs] ${ch.key} ${what} failed for role ${role.id}:`, err instanceof Error ? err.message : err);
    }
  }
  if (changed) await db.updateHrRole(role.id, role.organizationId, { channels: JSON.stringify(ids) });
}

// ---------- Frappe HR (REST API, token auth) ----------
// Job Opening: job_title, company and designation are required (Link fields);
// Job Applicant: applicant_name, email_id, status required, job_title links the opening.

const frappeOn = () => !!(ENV.frappeUrl && ENV.frappeApiKey && ENV.frappeApiSecret);
const R = (doctype: string) => `/api/resource/${encodeURIComponent(doctype)}`;

async function frappe<T = any>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENV.frappeUrl}${path}`, {
    method,
    headers: { Authorization: `token ${ENV.frappeApiKey}:${ENV.frappeApiSecret}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  // Only the method and path go in errors and logs, never the key.
  if (!res.ok) throw new Error(`Frappe HR answered ${res.status} to ${method} ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

const q = (o: Record<string, unknown>) => `?${Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))}`).join("&")}`;

async function frappeName(doctype: string, field: string, value: string) {
  const r = await frappe<{ data: { name: string }[] }>("GET", `${R(doctype)}${q({ fields: ["name"], filters: [[field, "=", value]], limit_page_length: 1 })}`);
  return r.data?.[0]?.name ?? null;
}

/** Yearly pay as numbers, for the opening's salary range (Frappe HR keeps pay per month or year only). */
export function payNumbers(from: string | null, to: string | null) {
  const num = (s: string | null) => {
    const m = (s ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k\b)?/i);
    return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
  };
  const a = num(from);
  const b = num(to);
  if (a === null && b === null) return null;
  const text = `${from ?? ""} ${to ?? ""}`.toLowerCase();
  const max = Math.max(a ?? 0, b ?? 0);
  const unit: "HOUR" | "YEAR" = /hour|hr\b|\/h/.test(text) ? "HOUR" : /year|yr\b|annual|salary/.test(text) ? "YEAR" : max < 300 ? "HOUR" : "YEAR";
  return { min: a ?? b!, max: b ?? a!, unit };
}

const frappeChannel: Channel = {
  key: "frappe",
  enabled: frappeOn,
  async publish(org, role, id) {
    const company = await frappeName("Company", "company_name", org.name);
    if (!company) throw new Error(`no Company named "${org.name}" in Frappe HR; add it there first`);
    let designation = await frappeName("Designation", "designation_name", role.title);
    if (!designation) designation = (await frappe<{ data: { name: string } }>("POST", R("Designation"), { designation_name: role.title })).data.name;
    const pay = payNumbers(role.payFrom, role.payTo);
    const jd = readJd(role);
    const body = {
      job_title: role.title,
      company,
      designation,
      status: "Open",
      description: jobHtml(role, jd),
      employment_type: role.employment === "1099" ? "Contract" : role.hours === "full" ? "Full-time" : "Part-time",
      publish: 1,
      ...(pay?.unit === "YEAR" ? { currency: "USD", lower_range: pay.min, upper_range: pay.max, salary_per: "Year", publish_salary_range: 1 } : {}),
    };
    if (id) {
      await frappe("PUT", `${R("Job Opening")}/${encodeURIComponent(id)}`, body);
      return id;
    }
    return (await frappe<{ data: { name: string } }>("POST", R("Job Opening"), body)).data.name;
  },
  async unpublish(_org, _role, id) {
    await frappe("PUT", `${R("Job Opening")}/${encodeURIComponent(id)}`, { status: "Closed" });
  },
};

const CHANNELS: Channel[] = [frappeChannel];

/** The description as simple HTML (the job page's markup, the feed and outside channels). */
export function jobHtml(role: Pick<HrRole, "mustHave" | "niceToHave">, jd: JobDescription | null) {
  const e = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const ul = (t: string | null | undefined) => `<ul>${lines(t).map((l) => `<li>${e(l)}</li>`).join("")}</ul>`;
  return [
    jd?.about ? `<p>${e(jd.about)}</p>` : "",
    jd?.schedule ? `<p><b>Schedule and pay:</b> ${e(jd.schedule)}</p>` : "",
    jd?.duties ? `<h3>What you'll do</h3>${ul(jd.duties)}` : "",
    role.mustHave ? `<h3>Must have</h3>${ul(role.mustHave)}` : "",
    role.niceToHave ? `<h3>Nice to have</h3>${ul(role.niceToHave)}` : "",
    jd?.howToApply ? `<h3>How to apply</h3><p>${e(jd.howToApply)}</p>` : "",
  ]
    .filter(Boolean)
    .join("");
}

type FrappeApplicant = { name: string; applicant_name: string; email_id: string; phone_number?: string | null; resume_attachment?: string | null; resume_link?: string | null; cover_letter?: string | null; job_title: string };

/** Applicants who applied on Frappe HR come into Candidates (each workspace's own openings only). */
export async function pullFrappeApplicants() {
  if (!frappeOn()) return 0;
  const byOpening = new Map<string, { orgId: number; roleId: number }>();
  for (const { role } of await listPublished()) {
    const id = parse<Channels>(role.channels, {}).frappe;
    if (id) byOpening.set(id, { orgId: role.organizationId, roleId: role.id });
  }
  if (!byOpening.size) return 0;
  const r = await frappe<{ data: FrappeApplicant[] }>(
    "GET",
    `${R("Job Applicant")}${q({ fields: ["name", "applicant_name", "email_id", "phone_number", "resume_attachment", "resume_link", "cover_letter", "job_title"], filters: [["job_title", "in", Array.from(byOpening.keys())]], limit_page_length: 500 })}`
  );
  let added = 0;
  for (const a of r.data ?? []) {
    const where = byOpening.get(a.job_title);
    if (!where || !a.email_id) continue;
    const seen = (await db.listHrPeople(where.orgId, "applicant")).some((p) => p.roleId === where.roleId && (p.email ?? "").toLowerCase() === a.email_id.toLowerCase());
    if (seen) continue;
    let text = "";
    let resumeUrl: string | null = null;
    let fileName = `${a.applicant_name || "applicant"}.txt`;
    if (a.resume_attachment && a.resume_attachment.startsWith("/")) {
      try {
        const res = await fetch(`${ENV.frappeUrl}${a.resume_attachment}`, { headers: { Authorization: `token ${ENV.frappeApiKey}:${ENV.frappeApiSecret}` }, signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length <= 10_000_000) {
            fileName = a.resume_attachment.split("/").pop() || fileName;
            const { readFile } = await import("./docs");
            text = (await readFile(buf, fileName, res.headers.get("content-type"))).text;
            const { storagePut } = await import("../storage");
            resumeUrl = (await storagePut(`org-${where.orgId}/resumes/${Date.now()}-${fileName.replace(/[^\w.-]+/g, "_")}`, buf)).url;
          }
        }
      } catch (err) {
        console.warn("[jobs] could not read a resume from Frappe HR:", err instanceof Error ? err.message : err);
      }
    }
    if (!text) text = [a.applicant_name, a.email_id, a.cover_letter, a.resume_link ? `Resume: ${a.resume_link}` : ""].filter(Boolean).join("\n");
    await acceptApplication(where.orgId, where.roleId, { name: a.applicant_name || a.email_id, email: a.email_id, phone: a.phone_number ?? "", text, resumeUrl, fileName });
    added++;
  }
  return added;
}

let lastPull = 0;

/** Once an hour: applicants from outside channels. */
export async function jobsTick(now = Date.now()) {
  if (now - lastPull < 3600_000) return;
  lastPull = now;
  await pullFrappeApplicants().catch((err) => console.warn("[jobs] Frappe HR applicants:", err instanceof Error ? err.message : err));
}
