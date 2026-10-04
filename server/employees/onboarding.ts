import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, EmployeeKind } from "../../drizzle/schema";
import { generateJson, generateText, type JsonSchema } from "../_core/llm";
import { loadBrain } from "./brain";
import { BASE_RULES } from "./roster";
import { INTERVIEWS, allQuestions } from "./interview-defs";
import { guidelinesText, readState } from "./interview";

/**
 * Onboarding: each employee asks what the owner wants from it and how the
 * day-to-day should go. Answers are fixed choices where possible, with a few
 * short typed answers. They go into every instruction the employee gets, and
 * "A day with ..." is written from them. Assignments are scheduled tasks.
 */

export type Question = { key: string; label: string; type: "choice" | "multi" | "text"; options?: string[]; placeholder?: string };
export type Template = { label: string; title: string; instructions: string; repeat: "daily" | "weekdays" | "weekly" | "monthly"; time: string; weekday?: number };


/** The interview's plain questions (no voice samples or examples), for code that reads one answer. */
export const QUESTIONS: Record<EmployeeKind, Question[]> = Object.fromEntries(
  (Object.keys(INTERVIEWS) as EmployeeKind[]).map((k) => [
    k,
    allQuestions(k)
      .filter((q) => q.type === "choice" || q.type === "multi" || q.type === "text")
      .map((q) => ({ key: q.key, label: q.label, type: q.type as Question["type"], options: q.options, placeholder: q.placeholder })),
  ])
) as Record<EmployeeKind, Question[]>;

const REPORT = (what: string): Template => ({ label: "Send me a report", title: "Daily report", instructions: `Send me a report: ${what}`, repeat: "daily", time: "09:00" });

export const TEMPLATES: Record<EmployeeKind, Template[]> = {
  grants: [
    REPORT("what you found, what you are writing, what is waiting on me, and deadlines in the next 30 days."),
    { label: "Find and apply", title: "Find grants and start the best", instructions: "Search for grants and pitch competitions that fit, then start applications for the best fits.", repeat: "weekly", time: "08:00", weekday: 1 },
    { label: "Check status", title: "Application status", instructions: "Check application status and tell me what changed.", repeat: "weekly", time: "08:30", weekday: 5 },
  ],
  speaking: [
    REPORT("new speaking calls and media requests, pitches waiting on me, and deadlines in the next 30 days."),
    { label: "Find events", title: "Find speaking calls", instructions: "Find events taking speaker proposals that fit and start pitches for the best.", repeat: "weekly", time: "08:00", weekday: 1 },
    { label: "Find press", title: "Find media opportunities", instructions: "Find journalist requests, podcasts booking guests and op-ed openings that fit my topics, and start pitches for the best.", repeat: "weekly", time: "08:00", weekday: 3 },
  ],
  social: [
    REPORT("posts waiting for approval and what went out this week."),
    { label: "Write posts", title: "Write today's post", instructions: "Write today's post for my main platforms.", repeat: "weekdays", time: "08:30" },
  ],
  blog: [
    REPORT("articles drafted and waiting for approval."),
    { label: "Write an article", title: "Weekly article", instructions: "Write this week's article on a topic I have not covered yet.", repeat: "weekly", time: "09:00", weekday: 2 },
  ],
  website: [REPORT("page plans finished and what to work on next."), { label: "Plan a page", title: "Plan a page", instructions: "Plan the next page on my list.", repeat: "weekly", time: "10:00", weekday: 3 }],
  video: [
    REPORT("video plans ready to film this week."),
    { label: "Find trends", title: "Weekly trend check", instructions: "Find video formats working this week and plan two videos.", repeat: "weekly", time: "10:00", weekday: 4 },
  ],
  inbox: [REPORT("replies waiting for approval and anything urgent.")],
  hiring: [
    REPORT("new applicants, outreach replies, interviews this week, and anything waiting on me."),
    { label: "Find people", title: "Find people and draft outreach", instructions: "Find licensed clinicians for my open roles and draft outreach for the best 5.", repeat: "weekly", time: "08:00", weekday: 2 },
    { label: "Check expirations", title: "Check team licenses and hours", instructions: "Send me a report: team licenses, certifications and supervision hours due in the next 90 days.", repeat: "weekly", time: "07:30", weekday: 1 },
  ],
  prospecting: [
    REPORT("new prospects, how many scored 70 or higher, and who moved to outreach."),
    { label: "Find prospects", title: "Find new prospects", instructions: "Find new prospects that fit and pass the good ones to Jada.", repeat: "weekly", time: "08:00", weekday: 1 },
  ],
  outreach: [REPORT("sequences sending, replies, and demos booked from outreach this week.")],
  developer: [REPORT("changes Claude is working on, changes ready for me to merge, and anything stuck.")],
  onboarding: [REPORT("customers being onboarded, steps due this week, and anything waiting on me.")],
  leads: [REPORT("new leads, who I replied to, and meetings booked this week.")],
  coo: [REPORT("this week's scorecard, meetings coming up, and open action items.")],
  projects: [REPORT("launches behind, tasks due this week, and KPIs off pace.")],
  custom: [REPORT("what you did and what is waiting on me.")],
};

export function parseAnswers(raw: string | null | undefined): Record<string, string | string[]> {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Flat string answers, for code that needs one value (interview hours...). */
export async function onboardingAnswers(emp: AIEmployee): Promise<Record<string, string>> {
  const a = parseAnswers(emp.onboarding);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) out[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  return out;
}

/** The answers as lines (used where a short list is easier than the full Guidelines). */
export function onboardingLines(emp: AIEmployee) {
  const a = parseAnswers(emp.onboarding);
  return (QUESTIONS[emp.kind] ?? [])
    .map((q) => {
      const v = a[q.key];
      const val = Array.isArray(v) ? v.join(", ") : v;
      return val ? `${q.label} ${val}` : "";
    })
    .filter(Boolean);
}

/** Where the interview stands: parts done of all parts. */
export function progress(emp: AIEmployee) {
  const st = readState(emp);
  const total = INTERVIEWS[emp.kind].sections.length;
  return { answered: st.done ? total : Math.min(st.step, total), total, done: st.done };
}

export type DayItem = { when: string; what: string };

export async function writeDayToDay(emp: AIEmployee) {
  const brain = await loadBrain(emp.organizationId);
  const lines = [guidelinesText(emp)].filter(Boolean);
  const tasks = (await db.listScheduledTasks(emp.organizationId)).filter((t) => t.employeeId === emp.id && t.enabled);
  const out = await generateJson<{ items: DayItem[] }>({
    system: `You are ${emp.name}, the ${emp.roleTitle} employee for ${brain.org?.name ?? "the workspace"}. Describe your day-to-day for the owner in 3 to 5 lines: when (Every morning, Tue and Fri, After a reply, Every Monday...) and what you do then, in one plain sentence each, first person is not needed. Base it on the owner's answers and assignments. Do not promise anything you cannot do: you cannot send email or post on your own yet; everything waits for approval.\n\n${BASE_RULES}`,
    prompt: `Your job: ${emp.description ?? emp.roleTitle}\n\nGuidelines from onboarding:\n${lines.join("\n") || "(none yet)"}\n\nAssignments:\n${tasks.map((t) => `- ${t.title} (${t.repeat} at ${t.time})`).join("\n") || "(none)"}`,
    schemaName: "day_to_day",
    schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["when", "what"], properties: { when: { type: "string" }, what: { type: "string" } } } } } } as JsonSchema,
    maxTokens: 900,
  });
  const items = (out.items ?? []).slice(0, 6).map((i) => ({ when: i.when.slice(0, 40), what: i.what.slice(0, 300) }));
  await db.updateEmployee(emp.id, emp.organizationId, { dayToDay: JSON.stringify(items) });
  return items;
}

// ==========================================
// Reports ("Every day at 9:00, send me a report")
// ==========================================

export async function factsFor(emp: AIEmployee) {
  const org = emp.organizationId;
  const since = new Date(Date.now() - 7 * 86400_000);
  const logs = (await db.listAuditLogsByOrg(org, 200)).filter((l) => l.actorName.startsWith(emp.name) && l.createdAt > since);
  const waiting = (await db.listOutboundItemsByOrg(org)).filter((i) => i.employeeId === emp.id && i.status === "pending_approval");
  const lines = [
    `Work logged in the last 7 days (${logs.length}):`,
    ...logs.slice(0, 25).map((l) => `- ${new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}: ${l.action}${l.details ? ` (${l.details})` : ""}`),
    `Waiting for the owner's approval: ${waiting.length}${waiting.length ? ` (${waiting.slice(0, 6).map((w) => w.title).join("; ")})` : ""}`,
  ];
  if (emp.kind === "grants" || emp.kind === "speaking") {
    const apps = (await db.listApplications(org)).filter((a) => a.employeeId === emp.id);
    const opps = await db.listOpps(org);
    const by = (s: string[]) => apps.filter((a) => s.includes(a.status));
    lines.push(
      `Applications: ${by(["writing"]).length} being written, ${by(["ready", "needs_answer", "needs_setup"]).length} waiting on the owner, ${by(["approved"]).length} approved to send, ${by(["submitted"]).length} submitted, ${by(["awarded"]).length} won`,
      `Open opportunities not started: ${opps.filter((o) => o.status === "new" && o.employeeId === emp.id && o.fitCall !== "skip").length}`,
      `Deadlines: ${opps.filter((o) => o.employeeId === emp.id && o.deadline && o.status !== "dismissed").slice(0, 8).map((o) => `${o.title} (${o.deadline})`).join("; ") || "none listed"}`
    );
  }
  const fmt = (d: Date | number | string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "");
  if (emp.kind === "social" || emp.kind === "blog") {
    const items = (await db.listOutboundItemsByOrg(org, emp.kind === "social" ? "social_post" : "blog_post")).filter((i) => i.status !== "cancelled");
    lines.push(
      `Published: ${items.filter((i) => i.status === "published").slice(0, 10).map((i) => `${i.title} (${fmt(i.publishedAt)})`).join("; ") || "none"}`,
      `Scheduled: ${items.filter((i) => i.status === "scheduled").slice(0, 10).map((i) => `${i.title} (${fmt(i.scheduledFor)})`).join("; ") || "none"}`,
      `Drafts: ${items.filter((i) => ["pending_approval", "approved", "changes_requested"].includes(i.status) && !i.publishedAt).slice(0, 10).map((i) => i.title).join("; ") || "none"}`
    );
  }
  if (emp.kind === "prospecting" || emp.kind === "outreach") {
    const ps = await db.listProspects(org);
    const count = (st: string) => ps.filter((p) => p.stage === st).length;
    lines.push(`Prospects: ${count("new")} new, ${count("outreach")} in outreach, ${count("replied")} replied, ${count("booked")} booked, ${count("not_fit")} not a fit`);
    if (emp.kind === "outreach") {
      const mails = (await db.listOutboundItemsByOrg(org, "outreach_email")).filter((i) => i.status !== "cancelled");
      lines.push(`Outreach emails: ${mails.filter((m) => m.status === "published").length} sent, ${mails.filter((m) => m.status === "scheduled").length} scheduled, ${mails.filter((m) => m.status === "pending_approval").length} waiting for approval`);
    }
  }
  if (emp.kind === "leads") {
    const leads = await db.listLeads(org);
    const weekEnd = new Date(Date.now() + 7 * 86400_000);
    const booked = leads.filter((l) => l.bookedFor && new Date(l.bookedFor) > new Date() && new Date(l.bookedFor) < weekEnd);
    lines.push(
      `Leads: ${leads.filter((l) => l.status === "new").length} new, ${leads.filter((l) => l.status === "replied").length} replied, ${leads.filter((l) => l.status === "booked").length} booked, ${leads.filter((l) => l.status === "closed").length} closed`,
      `Meetings booked in the next 7 days: ${booked.map((l) => `${l.company || l.name} (${fmt(l.bookedFor)}, came from ${l.source})`).join("; ") || "none"}`
    );
  }
  if (emp.kind === "projects") {
    const { projectsStatus } = await import("./projects");
    lines.push(await projectsStatus(org));
  }
  if (emp.kind === "coo") {
    const { cooStatus } = await import("./coo");
    lines.push(await cooStatus(org));
  }
  if (emp.kind === "hiring") {
    const { hiringFacts } = await import("./hiring");
    lines.push(await hiringFacts(org));
    const team = await db.listHrTeamItems(org);
    if (team.length) lines.push(`Team items: ${team.map((t) => `${t.person}: ${t.item}${t.due ? ` due ${t.due}` : ""}${t.progress ? ` (${t.progress})` : ""}`).join("; ")}`);
  }
  return lines.join("\n");
}

export async function writeReport(emp: AIEmployee, ask: string) {
  const brain = await loadBrain(emp.organizationId);
  const facts = await factsFor(emp);
  const text = await generateText({
    system: `You are ${emp.name}, the ${emp.roleTitle} employee for ${brain.org?.name ?? "the workspace"}. Write the report the owner asked for, from the facts given and nothing else. Lead with what needs the owner today, then what you did, then what is coming up. Short lines. If nothing happened, say so in one sentence. Never include a client's name.\n\n${BASE_RULES}`,
    prompt: `The owner asked: ${ask}\n\nFacts:\n${facts}`,
    maxTokens: 900,
  });
  return text.trim();
}

export function assertKind(emp: AIEmployee | null): asserts emp is AIEmployee {
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
}
