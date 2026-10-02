import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, HrPerson, HrRole } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { generateJson, generateText, searchJson, type JsonSchema } from "../_core/llm";
import { uploadsRoot } from "../storage";
import { notify } from "../notify";
import { employeeFor, systemPromptFor, working, actor, withRealSource } from "./tasks";
import { onboardingAnswers } from "./onboarding";

/**
 * Quinn, the hiring employee: job posts, outreach lists, applicant screening,
 * license, NPI and exclusion checks, interview and offer drafts, and the new
 * hire checklist.
 *
 * Lines Quinn never crosses:
 * - Scores count only the role's must-haves and nice-to-haves. Age, race,
 *   gender, disability, pregnancy, religion, national origin and other
 *   protected traits are never considered, and gaps in work history are ignored.
 * - Outreach uses work facts people published themselves (role, employer,
 *   license, city, a public profile or team page). No home addresses, personal
 *   phones, family details or personal social accounts. Nobody logs into
 *   LinkedIn or automates it; the person sends LinkedIn messages themselves.
 * - Every message to a candidate waits in Approvals.
 */

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });

export type MustHave = { item: string; met: "yes" | "no" | "unknown"; kind: "must" | "nice" };
export type Check = { name: string; detail: string; status: "clear" | "flag" | "manual" | "needs_setup"; url: string | null; checkedAt: string };
export type Target = { name: string; status: "ready" | "posted"; url: string | null };
export type ChecklistItem = { item: string; detail: string; status: "to_do" | "waiting" | "pending" | "done" | "stuck" };
export type NewHire = { offerLetter?: string; paperwork: ChecklistItem[]; credentialing: ChecklistItem[] };

export function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const FAIR = `Fair hiring rules you always follow:
- Score only against the role's must-haves and nice-to-haves. Never consider or mention age, race, color, gender, sexual orientation, pregnancy, disability, religion, national origin, marital or family status, or any other protected trait, and never guess at them from names, photos, schools or dates.
- Ignore gaps in work history.
- Use only work facts. Never record a home address, personal phone number, family details or personal social accounts.`;

const today = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

async function quinn(orgId: number) {
  return employeeFor(orgId, "hiring");
}

function roleSummary(role: HrRole) {
  const licenses = parse<string[]>(role.licenses, []);
  return [
    `Role: ${role.title}`,
    `Employment: ${role.employment === "w2" ? "W-2" : "1099"}, ${role.hours === "full" ? "full time" : "part time"}, ${role.place === "both" ? "in person and telehealth" : role.place === "telehealth" ? "telehealth" : "in person"}`,
    role.payFrom || role.payTo ? `Pay: ${[role.payFrom, role.payTo].filter(Boolean).join(" to ")}` : "",
    licenses.length ? `Licenses accepted: ${licenses.join(", ")}` : "",
    role.mustHave ? `Must have: ${role.mustHave}` : "",
    role.niceToHave ? `Nice to have: ${role.niceToHave}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function stateOf(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const m = (org?.state ?? "").match(/\b([A-Z]{2})\b\s*$/) ?? (org?.state ?? "").match(/,\s*([A-Z]{2})\b/);
  return m ? m[1] : "";
}

async function post(emp: AIEmployee, content: string, cards: unknown[] = []) {
  return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: cards.length ? JSON.stringify(cards) : null });
}

// ==========================================
// Roles and job posts
// ==========================================

const STANDARD_TARGETS: Target[] = [
  { name: "Indeed", status: "ready", url: "https://employers.indeed.com/" },
  { name: "LinkedIn Jobs", status: "ready", url: "https://www.linkedin.com/job-posting/" },
];

export async function writeJobPost(orgId: number, roleId: number) {
  const role = await db.getHrRole(roleId, orgId);
  if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "That role is not in this workspace." });
  const emp = await quinn(orgId);
  return working(emp, async () => {
    const answers = await onboardingAnswers(emp);
    const { system } = await systemPromptFor(
      emp,
      `Your job: write a job post for this role, and name the best places to post it.
- Title line, then 2 short paragraphs and a short list of what the person will do and what they need. Plain and specific: real pay, real hours, real setting, from the role and the Brain.
- Do not promise benefits the Brain does not list.
- Places to post: besides Indeed and LinkedIn Jobs, name 2 or 3 places that fit this role and region (for a clinician: graduate counseling program career offices nearby, the state counseling or social work association job board). Give each a page URL only if you are sure of it, otherwise "".
${FAIR}`
    );
    const out = await generateJson<{ title: string; post: string; places: { name: string; url: string }[] }>({
      system,
      prompt: `${roleSummary(role)}${answers.greatFit ? `\nWhat makes someone a great fit: ${answers.greatFit}` : ""}`,
      schemaName: "job_post",
      schema: obj({ title: str, post: str, places: arr(obj({ name: str, url: str })) }),
    });
    const extra: Target[] = (out.places ?? []).slice(0, 3).map((p) => ({ name: p.name.slice(0, 120), status: "ready", url: /^https?:\/\//.test(p.url) ? p.url : null }));
    const old = parse<Target[]>(role.targets, []);
    const targets = [...STANDARD_TARGETS, ...extra].map((t) => old.find((o) => o.name === t.name) ?? t);
    const saved = await db.updateHrRole(roleId, orgId, { post: `${out.title}\n\n${out.post}`.trim(), targets: JSON.stringify(targets) });
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Wrote job post", details: role.title });
    return saved!;
  });
}

// ==========================================
// Outreach
// ==========================================

type FoundPerson = {
  name: string;
  credentials: string;
  currentRole: string;
  location: string;
  foundOn: string;
  sourceUrl: string;
  workEmail: string;
  fitScore: number;
  fitReason: string;
};

export async function findProspects(orgId: number, opts: { roleId?: number | null; focus?: string } = {}) {
  const emp = await quinn(orgId);
  const roles = (await db.listHrRoles(orgId)).filter((r) => r.status === "open");
  const role = opts.roleId ? roles.find((r) => r.id === opts.roleId) ?? null : roles[0] ?? null;
  return working(emp, async () => {
    const { system, brain } = await systemPromptFor(
      emp,
      `Your job: find working professionals who could fit an open role, for the owner to reach out to.
- Search one angle at a time: LinkedIn profiles that appear in search results, group practice and clinic "Our team" pages, therapist directory profiles, conference speaker lists, and university faculty pages, near the workspace.
- Only people who publish their professional work. For each: name, license or credentials, current role and employer, city, which kind of page you found them on, that page's URL, and a work email only if it is printed on their practice or employer site (otherwise "").
- Score fit 0 to 100 against the role. Say why in one sentence using something real from their page.
- Return up to 8, best first.
${FAIR}`
    );
    const prompt = `${role ? roleSummary(role) : "No role is saved yet. Look for licensed clinicians who could join the practice."}
Workspace location: ${brain.org?.state ?? "not listed"}${opts.focus ? `\nFocus on: ${opts.focus}` : ""}`;
    const result = await searchJson<{ items: FoundPerson[] }>({
      system,
      prompt,
      schemaName: "prospects",
      schema: obj({
        items: arr(
          obj({
            name: str,
            credentials: str,
            currentRole: str,
            location: str,
            foundOn: { type: "string", description: "LinkedIn, Practice team page, Therapist directory, Conference speaker list, University page" },
            sourceUrl: str,
            workEmail: str,
            fitScore: int,
            fitReason: str,
          })
        ),
      }),
      maxUses: Math.max(ENV.searchMaxUses, 9),
    });
    const existing = await db.listHrPeople(orgId);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    const created: HrPerson[] = [];
    for (const f of withRealSource(result.data.items, result.sources)) {
      if (!f.name?.trim()) continue;
      if (existing.some((p) => norm(p.name) === norm(f.name))) continue; // includes Do not contact
      const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.workEmail ?? "") ? f.workEmail.trim() : null;
      created.push(
        await db.createHrPerson({
          organizationId: orgId,
          roleId: role?.id ?? null,
          source: "prospect",
          stage: "prospect",
          name: f.name.trim().slice(0, 160),
          credentials: f.credentials?.slice(0, 120) || null,
          currentRole: f.currentRole?.slice(0, 255) || null,
          location: f.location?.slice(0, 120) || null,
          foundOn: f.foundOn?.slice(0, 80) || null,
          sourceUrl: f.sourceUrl,
          email,
          fitScore: Math.max(0, Math.min(100, Math.round(f.fitScore || 0))),
          fitReason: f.fitReason?.slice(0, 600) || null,
          purgeAt: new Date(Date.now() + 90 * 86400_000),
        })
      );
    }
    if (created.length) await draftMessages(emp, role, created);
    await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Searched for people", details: `Ran ${result.queries.length} searches and added ${created.length}.` });
    return { created: await Promise.all(created.map((p) => db.getHrPerson(p.id, orgId))).then((l) => l.filter(Boolean) as HrPerson[]), queries: result.queries, role };
  });
}

async function signer(emp: AIEmployee) {
  const org = await db.getOrganizationById(emp.organizationId);
  return [org?.signerName, org?.name].filter(Boolean).join(", ") || "[YOUR NAME]";
}

async function draftMessages(emp: AIEmployee, role: HrRole | null, people: HrPerson[]) {
  const { system } = await systemPromptFor(
    emp,
    `Your job: write a short first message to each person, from the owner, about the role.
- 3 to 5 sentences. Mention one real thing from what you know about their work, then the role in one sentence (hours, setting, pay if listed), then ask for a 15-minute call.
- Warm and direct, like one professional writing to another. No flattery, no hype, no "I came across your impressive profile".
- Sign with the signer given.
${FAIR}`
  );
  const out = await generateJson<{ messages: { id: number; message: string }[] }>({
    system,
    prompt: `${role ? roleSummary(role) : "Role: licensed clinician at the practice"}
Signer: ${await signer(emp)}

People:
${people.map((p) => `- id ${p.id}: ${p.name}${p.credentials ? `, ${p.credentials}` : ""}. ${p.currentRole ?? ""}. ${p.location ?? ""}. Why they fit: ${p.fitReason ?? ""}`).join("\n")}`,
    schemaName: "outreach_messages",
    schema: obj({ messages: arr(obj({ id: int, message: str })) }),
  });
  for (const m of out.messages ?? []) {
    const p = people.find((x) => x.id === m.id);
    if (p && m.message?.trim()) await db.updateHrPerson(p.id, emp.organizationId, { message: m.message.trim() });
  }
}

export async function rewriteMessage(orgId: number, personId: number) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const emp = await quinn(orgId);
  const role = person.roleId ? await db.getHrRole(person.roleId, orgId) : null;
  await draftMessages(emp, role, [person]);
  return db.getHrPerson(personId, orgId);
}

/** The person sent the LinkedIn message themselves. */
export async function markContacted(orgId: number, personId: number) {
  return db.updateHrPerson(personId, orgId, { stage: "contacted", contactedAt: new Date(), followUpAt: new Date(Date.now() + 7 * 86400_000) });
}

/** Puts an outreach email in Approvals (for a work email printed on the person's practice site). */
export async function queueEmail(orgId: number, personId: number, purpose: "outreach" | "follow_up" | "interview" | "decline" | "offer") {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  if (!person.email) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "There is no work email for this person. Use Open profile and send the message there." });
  const emp = await quinn(orgId);
  const role = person.roleId ? await db.getHrRole(person.roleId, orgId) : null;
  let body = person.message ?? "";
  let title = `Outreach: ${role?.title ?? "Open role"}`;
  if (purpose !== "outreach" || !body) {
    const answers = await onboardingAnswers(emp);
    const org = await db.getOrganizationById(orgId);
    const { system } = await systemPromptFor(
      emp,
      `Your job: write one short email to a candidate, from the owner. Greeting, 2 to 5 sentences, sign-off with the signer. No subject line.
${FAIR}`
    );
    const ask: Record<string, string> = {
      outreach: "A first message about the role, asking for a 15-minute call.",
      follow_up: "A polite one-time follow-up to an earlier message about the role. Short. Make it easy to say no.",
      interview: `An interview invite. Offer these times and ask which works: ${await interviewTimes(orgId, answers.interviewHours, org?.timezone ?? "America/Chicago")}. Format: ${answers.interviewFormat || "video call"}.${answers.panel ? ` Also on the interview: ${answers.panel}.` : ""}`,
      decline: "A kind, brief note that the practice is not moving forward with their application for this role. Thank them. No reasons.",
      offer: "A short note that an offer letter is attached and you are glad to answer questions.",
    };
    body = await generateText({ system, prompt: `${role ? roleSummary(role) : ""}\nCandidate: ${person.name}${person.credentials ? `, ${person.credentials}` : ""}\nSigner: ${await signer(emp)}\nWrite: ${ask[purpose]}`, maxTokens: 800 });
    title = { outreach: title, follow_up: `Follow-up: ${role?.title ?? "Open role"}`, interview: `Interview invite: ${role?.title ?? "Open role"}`, decline: `Not moving forward: ${role?.title ?? "Open role"}`, offer: `Offer: ${role?.title ?? "Open role"}` }[purpose];
  }
  const item = await db.createOutboundItem({
    organizationId: orgId,
    employeeId: emp.id,
    kind: "hiring_email",
    status: "pending_approval",
    title,
    body: body.trim(),
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ personId: person.id, to: person.name, email: person.email, purpose }),
  });
  return item;
}

/** Three interview times inside the owner's interview hours, starting tomorrow. */
async function interviewTimes(orgId: number, hours: string | undefined, tz: string) {
  if (!hours?.trim()) return "[THREE TIMES THAT WORK FOR YOU]";
  const local = new Date().toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric", year: "numeric" });
  try {
    const out = await generateJson<{ times: string[] }>({
      system: "You pick meeting times. Return exactly 3 times inside the given hours, on 3 different days, starting tomorrow, within the next 10 days, skipping weekends unless the hours name them. Format each like \"Tue, Oct 6, 2026 at 1:00 PM\".",
      prompt: `Today is ${local} (${tz}). Interview hours: ${hours}`,
      schemaName: "times",
      schema: obj({ times: arr(str) }),
      maxTokens: 300,
    });
    return (out.times ?? []).slice(0, 3).join("; ") || "[THREE TIMES THAT WORK FOR YOU]";
  } catch {
    return "[THREE TIMES THAT WORK FOR YOU]";
  }
}

// ==========================================
// Applicants
// ==========================================

type Screen = {
  name: string;
  credentials: string;
  email: string;
  location: string;
  currentRole: string;
  fitScore: number;
  fitReason: string;
  mustHaves: MustHave[];
};

export async function addApplicant(orgId: number, input: { roleId: number | null; text: string; resumeUrl: string | null; fileName: string }) {
  const emp = await quinn(orgId);
  const role = input.roleId ? await db.getHrRole(input.roleId, orgId) : (await db.listHrRoles(orgId)).find((r) => r.status === "open") ?? null;
  if (!input.text.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: `No readable text was found in ${input.fileName}.` });
  const person = await working(emp, async () => {
    const s = await screen(emp, role, input.text);
    return db.createHrPerson({
      organizationId: orgId,
      roleId: role?.id ?? null,
      source: "applicant",
      stage: "new",
      name: s.name?.trim().slice(0, 160) || input.fileName.replace(/\.[a-z0-9]+$/i, ""),
      credentials: s.credentials?.slice(0, 120) || null,
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email ?? "") ? s.email.trim() : null,
      location: s.location?.slice(0, 120) || null,
      currentRole: s.currentRole?.slice(0, 255) || null,
      resumeUrl: input.resumeUrl,
      resumeText: input.text.slice(0, 200_000),
      fitScore: Math.max(0, Math.min(100, Math.round(s.fitScore || 0))),
      fitReason: s.fitReason?.slice(0, 800) || null,
      mustHaves: JSON.stringify((s.mustHaves ?? []).slice(0, 16)),
      appliedOn: today(),
    });
  });
  await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(emp), action: "Screened applicant", details: `${person.name} for ${role?.title ?? "an open role"}` });
  if (person.fitScore >= 60) runChecks(orgId, person.id).catch((err) => console.warn("[hiring] checks failed:", err));
  return person;
}

async function screen(emp: AIEmployee, role: HrRole | null, text: string) {
  const { system } = await systemPromptFor(
    emp,
    `Your job: read one resume or application and score it against the role.
- Pull out: name, license or credentials, work email, city, current role.
- List each must-have and nice-to-have from the role and mark it yes, no or unknown from what the resume says. Unknown when the resume does not say.
- Score 0 to 100: must-haves count most. A missing required license caps the score at 40.
- Why: 1 or 2 sentences on experience that matters for the role.
${FAIR}`
  );
  return generateJson<Screen>({
    system,
    prompt: `${role ? roleSummary(role) : "No role saved. Score against a licensed outpatient clinician role."}\n\nResume:\n${text.slice(0, 60_000)}`,
    schemaName: "screen",
    schema: obj({
      name: str,
      credentials: str,
      email: str,
      location: str,
      currentRole: str,
      fitScore: int,
      fitReason: str,
      mustHaves: arr(obj({ item: str, met: { type: "string", enum: ["yes", "no", "unknown"] }, kind: { type: "string", enum: ["must", "nice"] } })),
    }),
  });
}

export async function rescreen(orgId: number, personId: number) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person?.resumeText) throw new TRPCError({ code: "NOT_FOUND", message: "There is no resume on file for this person." });
  const emp = await quinn(orgId);
  const role = person.roleId ? await db.getHrRole(person.roleId, orgId) : null;
  const s = await screen(emp, role, person.resumeText);
  return db.updateHrPerson(personId, orgId, { fitScore: Math.max(0, Math.min(100, Math.round(s.fitScore || 0))), fitReason: s.fitReason || null, mustHaves: JSON.stringify(s.mustHaves ?? []) });
}

// ==========================================
// Checks: license, NPI, OIG exclusion list, SAM.gov
// ==========================================

function splitName(full: string) {
  const clean = full.replace(/,.*$/, "").replace(/\b(dr|mr|ms|mrs)\.?\s+/i, "").trim();
  const parts = clean.split(/\s+/);
  return { first: parts[0] ?? "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
}

const stamp = () => today();

async function npiCheck(name: string, state: string): Promise<Check & { taxonomy?: { license: string; state: string; desc: string } }> {
  const { first, last } = splitName(name);
  const base = { name: "NPI", checkedAt: stamp() };
  if (!first || !last) return { ...base, detail: "Need a first and last name to search", status: "manual", url: "https://npiregistry.cms.hhs.gov/search" };
  if (process.env.NODE_ENV === "test") return { ...base, detail: "Not checked in tests", status: "manual", url: null };
  try {
    const q = new URLSearchParams({ version: "2.1", first_name: first, last_name: last, enumeration_type: "NPI-1", limit: "10" });
    if (state) q.set("state", state);
    const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?${q}`, { signal: AbortSignal.timeout(15_000) });
    const data: any = await res.json();
    const results: any[] = data?.results ?? [];
    if (results.length === 0) return { ...base, detail: `No NPI found for ${first} ${last}${state ? ` in ${state}` : ""}`, status: "flag", url: "https://npiregistry.cms.hhs.gov/search" };
    if (results.length > 1) return { ...base, detail: `${results.length} people match; confirm the NPI with the candidate`, status: "manual", url: "https://npiregistry.cms.hhs.gov/search" };
    const r = results[0];
    const tax = (r.taxonomies ?? []).find((t: any) => t.primary) ?? r.taxonomies?.[0];
    return {
      ...base,
      detail: `${r.number}${tax?.desc ? ` · ${tax.desc}` : ""}`,
      status: "clear",
      url: `https://npiregistry.cms.hhs.gov/provider-view/${r.number}`,
      taxonomy: tax ? { license: String(tax.license ?? ""), state: String(tax.state ?? ""), desc: String(tax.desc ?? "") } : undefined,
    };
  } catch (err) {
    return { ...base, detail: "The NPI Registry did not answer; try again", status: "manual", url: "https://npiregistry.cms.hhs.gov/search" };
  }
}

// The OIG list (LEIE) is a public file, refreshed monthly. Kept on disk and in memory.
let leie: { at: number; byName: Map<string, { state: string; type: string; date: string; reinstated: string }[]> } | null = null;

function csvRow(line: string) {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function loadLeie() {
  if (leie && Date.now() - leie.at < 7 * 86400_000) return leie;
  const file = path.join(uploadsRoot(), "cache", "leie.csv");
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 30 * 86400_000;
  if (!fresh) {
    const res = await fetch("https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv", { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`OIG list download failed (${res.status})`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const head = csvRow(lines[0] ?? "").map((h) => h.trim().toUpperCase());
  const col = (n: string) => head.indexOf(n);
  const [L, F, S, T, D, R] = ["LASTNAME", "FIRSTNAME", "STATE", "EXCLTYPE", "EXCLDATE", "REINDATE"].map(col);
  const byName = new Map<string, { state: string; type: string; date: string; reinstated: string }[]>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = csvRow(lines[i]);
    const last = (r[L] ?? "").trim().toUpperCase();
    const first = (r[F] ?? "").trim().toUpperCase();
    if (!last || !first) continue;
    const key = `${last}|${first}`;
    const list = byName.get(key) ?? [];
    list.push({ state: (r[S] ?? "").trim(), type: (r[T] ?? "").trim(), date: (r[D] ?? "").trim(), reinstated: (r[R] ?? "").trim() });
    byName.set(key, list);
  }
  leie = { at: Date.now(), byName };
  return leie;
}

async function oigCheck(name: string, state: string): Promise<Check> {
  const base = { name: "OIG exclusion list", checkedAt: stamp(), url: "https://exclusions.oig.hhs.gov/" };
  const { first, last } = splitName(name);
  if (!first || !last) return { ...base, detail: "Need a first and last name to search", status: "manual" };
  if (process.env.NODE_ENV === "test") return { ...base, detail: "Not checked in tests", status: "manual" };
  try {
    const list = (await loadLeie()).byName.get(`${last.toUpperCase()}|${first.toUpperCase()}`) ?? [];
    const active = list.filter((x) => !x.reinstated || x.reinstated === "00000000");
    if (active.length === 0) return { ...base, detail: `Not listed, checked ${stamp()}`, status: "clear" };
    const here = active.filter((x) => !state || x.state === state);
    return { ...base, detail: `${active.length} listing${active.length === 1 ? "" : "s"} with this name${here.length ? ` (${here.length} in ${state})` : ""}. Confirm it is not this person on the OIG site.`, status: "flag" };
  } catch (err) {
    return { ...base, detail: "The OIG list could not be downloaded; search it by hand", status: "manual" };
  }
}

async function samCheck(name: string): Promise<Check> {
  const base = { name: "SAM.gov", checkedAt: stamp(), url: "https://sam.gov/search/?index=ex" };
  if (!ENV.samApiKey) return { ...base, detail: "Add a SAM.gov API key on the server to check this", status: "needs_setup" };
  if (process.env.NODE_ENV === "test") return { ...base, detail: "Not checked in tests", status: "manual" };
  try {
    const { first, last } = splitName(name);
    const q = new URLSearchParams({ api_key: ENV.samApiKey, exclusionName: `${first} ${last}`.trim(), classification: "Individual" });
    const res = await fetch(`https://api.sam.gov/entity-information/v4/exclusions?${q}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ...base, detail: `SAM.gov answered ${res.status}; search it by hand`, status: "manual" };
    const data: any = await res.json();
    const total = Number(data?.totalRecords ?? data?.excludedEntity?.length ?? 0);
    return total === 0 ? { ...base, detail: `Not excluded, checked ${stamp()}`, status: "clear" } : { ...base, detail: `${total} exclusion record${total === 1 ? "" : "s"} with this name. Confirm it is not this person.`, status: "flag" };
  } catch {
    return { ...base, detail: "SAM.gov did not answer; search it by hand", status: "manual" };
  }
}

async function licenseCheck(emp: AIEmployee, person: HrPerson, state: string, npiLicense?: { license: string; state: string; desc: string }): Promise<Check> {
  const base = { name: "License", checkedAt: stamp() };
  if (process.env.NODE_ENV === "test") return { ...base, detail: "Not checked in tests", status: "manual", url: null };
  if (!ENV.anthropicKey) return { ...base, detail: npiLicense?.license ? `License ${npiLicense.license} (${npiLicense.state}) on the NPI record; confirm on the state lookup` : "Confirm on the state board's lookup", status: "manual", url: null };
  try {
    const { system } = await systemPromptFor(emp, `Your job: look up one person's professional license on the state licensing board's public lookup and report what it shows. If the lookup is a form search engines cannot read, say "unknown" and give the lookup page URL.`);
    const r = await searchJson<{ status: "active" | "expired" | "not_found" | "unknown"; licenseType: string; expires: string; url: string }>({
      system,
      prompt: `Person: ${person.name}${person.credentials ? `, ${person.credentials}` : ""}\nState: ${npiLicense?.state || state || "the workspace's state"}${npiLicense?.license ? `\nLicense number on their NPI record: ${npiLicense.license}` : ""}`,
      schemaName: "license",
      schema: obj({ status: { type: "string", enum: ["active", "expired", "not_found", "unknown"] }, licenseType: str, expires: { type: "string", description: "Mon D, YYYY or ''" }, url: str }),
      maxUses: 3,
      maxTokens: 1500,
    });
    const d = r.data;
    const url = /^https?:\/\//.test(d.url) ? d.url : null;
    if (d.status === "active") return { ...base, detail: `${d.licenseType || "License"}, active${d.expires ? `, expires ${d.expires}` : ""}`, status: "clear", url };
    if (d.status === "expired") return { ...base, detail: `${d.licenseType || "License"} lapsed${d.expires ? ` ${d.expires}` : ""}`, status: "flag", url };
    if (d.status === "not_found") return { ...base, detail: "No license found on the state lookup", status: "flag", url };
    return { ...base, detail: npiLicense?.license ? `License ${npiLicense.license} on the NPI record; confirm on the state lookup` : "Confirm on the state lookup", status: "manual", url };
  } catch {
    return { ...base, detail: "Confirm on the state lookup", status: "manual", url: null };
  }
}

export async function runChecks(orgId: number, personId: number) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const emp = await quinn(orgId);
  const state = await stateOf(orgId);
  const npi = await npiCheck(person.name, state);
  const [lic, oig, sam] = await Promise.all([licenseCheck(emp, person, state, npi.taxonomy), oigCheck(person.name, state), samCheck(person.name)]);
  const { taxonomy: _t, ...npiRow } = npi;
  const checks: Check[] = [lic, npiRow, oig, sam];
  return db.updateHrPerson(personId, orgId, { checks: JSON.stringify(checks) });
}

// ==========================================
// Stages, offer, new hire checklist
// ==========================================

export async function moveTo(orgId: number, personId: number, stage: HrPerson["stage"]) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  if (stage === "interview" && person.source === "prospect") {
    // A prospect who said yes becomes an applicant.
    await db.updateHrPerson(personId, orgId, { source: "applicant", appliedOn: person.appliedOn ?? today(), purgeAt: null });
  }
  const updated = await db.updateHrPerson(personId, orgId, { stage, ...(stage === "replied" || stage === "dnc" ? { purgeAt: null, followUpAt: null } : {}) });
  if (stage === "interview" && person.email) await queueEmail(orgId, personId, "interview");
  if (stage === "passed" && person.source === "applicant" && person.email) await queueEmail(orgId, personId, "decline");
  return updated;
}

export async function draftOffer(orgId: number, personId: number, input: { startDate: string; pay: string }) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const emp = await quinn(orgId);
  const role = person.roleId ? await db.getHrRole(person.roleId, orgId) : null;
  const { system } = await systemPromptFor(
    emp,
    `Your job: write an offer letter from the practice. Date, greeting, the role, employment type, hours, pay, start date, who they report to if the Brain says, at-will language for a W-2 role or contractor language for a 1099 role, what to do to accept, and a signature line for the signer. Missing facts become bracketed placeholders. This is a draft for the owner and their attorney to review.`
  );
  const letter = await generateText({ system, prompt: `${role ? roleSummary(role) : ""}\nCandidate: ${person.name}${person.credentials ? `, ${person.credentials}` : ""}\nStart date: ${input.startDate}\nPay: ${input.pay}\nSigner: ${await signer(emp)}\nToday: ${today()}`, maxTokens: 2500 });
  const hire = parse<NewHire>(person.onboarding, { paperwork: [], credentialing: [] });
  return db.updateHrPerson(personId, orgId, { stage: "offer", startDate: input.startDate, onboarding: JSON.stringify({ ...hire, offerLetter: letter.trim() }) });
}

export async function markHired(orgId: number, personId: number) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const emp = await quinn(orgId);
  const hire = parse<NewHire>(person.onboarding, { paperwork: [], credentialing: [] });
  const clinician = /\b(LPC|LMFT|LCSW|LADC|LMHC|PSYD|PHD|MD|NP|LPC-?C|LMSW|CANDIDATE)\b/i.test(`${person.credentials ?? ""} ${person.name}`);
  const paperwork: ChecklistItem[] = hire.paperwork.length
    ? hire.paperwork
    : [
        { item: "Offer letter signed", detail: "", status: "to_do" },
        { item: "Form I-9", detail: "Section 2 is due within 3 business days of the start date", status: "to_do" },
        { item: "Form W-4 or W-9", detail: "", status: "to_do" },
        { item: "Handbook acknowledgment", detail: "", status: "to_do" },
        { item: "HIPAA training certificate", detail: "", status: "to_do" },
        ...(clinician ? [{ item: "Malpractice insurance", detail: "", status: "to_do" as const }, { item: "Supervision agreement (if under supervision)", detail: "", status: "to_do" as const }] : []),
        { item: "LeadDash EHR account", detail: "Set the role and access", status: "to_do" },
      ];
  let credentialing: ChecklistItem[] = hire.credentialing;
  if (clinician && credentialing.length === 0) {
    credentialing = [{ item: "CAQH profile", detail: "", status: "to_do" }];
    try {
      const { system } = await systemPromptFor(emp, "List the insurance payers this practice is in network with, exactly as the Brain names them. If the Brain names none, return an empty list.");
      const out = await generateJson<{ payers: string[] }>({ system, prompt: "Which payers?", schemaName: "payers", schema: obj({ payers: arr(str) }), maxTokens: 400 });
      for (const p of (out.payers ?? []).slice(0, 12)) credentialing.push({ item: p, detail: "", status: "to_do" });
    } catch {
      /* the owner can add payers by hand */
    }
  }
  return db.updateHrPerson(personId, orgId, { stage: "hired", onboarding: JSON.stringify({ ...hire, paperwork, credentialing }) });
}

export async function updateChecklist(orgId: number, personId: number, list: "paperwork" | "credentialing", items: ChecklistItem[]) {
  const person = await db.getHrPerson(personId, orgId);
  if (!person) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
  const hire = parse<NewHire>(person.onboarding, { paperwork: [], credentialing: [] });
  return db.updateHrPerson(personId, orgId, { onboarding: JSON.stringify({ ...hire, [list]: items }) });
}

// ==========================================
// Team expirations and the daily job
// ==========================================

function daysUntil(mmddyyyy: string | null, now = new Date()) {
  const m = (mmddyyyy ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return Math.ceil((d.getTime() - now.getTime()) / 86400_000);
}
export { daysUntil };

export async function remindTeamItem(orgId: number, id: number) {
  const item = await db.getHrTeamItem(id, orgId);
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in this workspace." });
  const emp = await quinn(orgId);
  const days = daysUntil(item.due);
  const text = `${item.person}: ${item.item}${item.due ? ` ${days !== null && days < 0 ? "expired" : "expires"} ${item.due}` : ""}${item.progress ? ` (${item.progress})` : ""}.`;
  await post(emp, `Reminder: ${text}`);
  await notify(orgId, "team_due", { title: "Team reminder from Quinn", body: text, url: "/chats/hiring/work", tag: `team-${id}` });
  await db.markHrTeamItemReminded(id, orgId);
  return { success: true };
}

let lastHiringDay = "";

/** Once a day: drop stale prospect cards, draft one follow-up, and flag team items due in 60 or 30 days. */
export async function hiringDaily(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (day === lastHiringDay) return;
  lastHiringDay = day;
  await db.purgeHrProspects(now);
  for (const orgId of await db.listAllOrganizationIds()) {
    const emp = await db.getEmployeeByKind(orgId, "hiring");
    if (!emp || emp.status === "paused") continue;
    const due = (await db.listHrPeople(orgId, "prospect")).filter((p) => p.stage === "contacted" && p.followUpAt && p.followUpAt < now);
    for (const p of due) {
      await db.updateHrPerson(p.id, orgId, { followUpAt: null });
      if (p.email) await queueEmail(orgId, p.id, "follow_up").catch(() => {});
    }
    if (due.length) await post(emp, `${plural(due.length, "person")} I reached out to a week ago ${due.length === 1 ? "has" : "have"} not replied. ${due.some((p) => p.email) ? "Follow-up emails are in Approvals. " : ""}Follow up once on LinkedIn for the rest, then I stop.`);
    for (const t of await db.listHrTeamItems(orgId)) {
      const days = daysUntil(t.due, now);
      if (days === null || !(days === 60 || days === 30 || days === 7 || days === 0)) continue;
      await remindTeamItem(orgId, t.id).catch(() => {});
    }
  }
}

// ==========================================
// Chat cards and the status report
// ==========================================

export function personCard(p: HrPerson) {
  return {
    type: p.source === "prospect" ? ("prospect" as const) : ("candidate" as const),
    id: p.id,
    title: [p.name, p.credentials].filter(Boolean).join(", "),
    subtitle: p.source === "prospect" ? [p.currentRole, p.location, p.foundOn && `Found on ${p.foundOn}`].filter(Boolean).join(" · ") : [p.appliedOn && `Applied ${p.appliedOn}`, p.location].filter(Boolean).join(" · "),
    body: p.fitReason ?? "",
    url: p.sourceUrl,
    score: p.fitScore,
    status: p.stage,
  };
}

export async function hiringFacts(orgId: number) {
  const people = await db.listHrPeople(orgId);
  const roles = await db.listHrRoles(orgId);
  const count = (pred: (p: HrPerson) => boolean) => people.filter(pred).length;
  const weekAgo = new Date(Date.now() - 7 * 86400_000);
  return [
    `Open roles: ${roles.filter((r) => r.status === "open").map((r) => r.title).join(", ") || "none"}`,
    `New applicants waiting for a decision: ${count((p) => p.source === "applicant" && p.stage === "new")}`,
    `Applicants added this week: ${count((p) => p.source === "applicant" && p.createdAt > weekAgo)}`,
    `In interview: ${count((p) => p.stage === "interview")}; on hold: ${count((p) => p.stage === "hold")}; offers out: ${count((p) => p.stage === "offer")}`,
    `Outreach prospects not yet contacted: ${count((p) => p.stage === "prospect")}; contacted: ${count((p) => p.stage === "contacted")}; replied: ${count((p) => p.stage === "replied")}`,
    `New hires onboarding: ${count((p) => p.stage === "hired")}`,
  ].join("\n");
}
