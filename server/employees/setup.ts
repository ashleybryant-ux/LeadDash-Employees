import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { EmployeeKind } from "../../drizzle/schema";
import { applyWebsite } from "./websiteFacts";

/**
 * Set up your team, once: the business (saved to the Brain so no employee asks
 * again), who starts first, and a first job waiting in each chat. A new
 * workspace opens here; a workspace already in use never sees it unless the
 * owner opens Team setup from the Workspace page.
 */

/** The three to start with, by kind of business. The rest wait paused in Chats. */
const STARTERS: Record<string, EmployeeKind[]> = {
  healthcare: ["leads", "inbox", "projects"],
  nonprofit: ["grants", "inbox", "projects"],
  business: ["inbox", "projects", "coo"],
};

/** The first job each employee can do right now: the line on the setup screen and the words the owner sends by pressing it. */
export const FIRST_JOBS: Record<EmployeeKind, { line: string; ask: string }> = {
  coo: { line: "set up your weekly team meeting: day, time and a first agenda from what is in the Brain.", ask: "Set up our weekly team meeting and write the first agenda." },
  projects: { line: "list the three projects you are carrying in your head so she can track them.", ask: "Here are the projects I am carrying right now. Ask me for each one and set them up." },
  grants: { line: "find five open grants that fit and say which are worth your time.", ask: "Find five open grants that fit us and tell me which ones are worth applying for." },
  speaking: { line: "find the conferences and podcasts taking proposals this season.", ask: "Find the conferences and podcasts taking proposals this season that fit me." },
  prospecting: { line: "build a first list of twenty prospects that match who you sell to.", ask: "Build a first list of twenty prospects that match who we sell to." },
  outreach: { line: "write the first outreach message in your voice, for you to approve.", ask: "Write the first outreach message in my voice for me to approve." },
  leads: { line: "write the reply new leads get within five minutes, in your voice, for you to approve.", ask: "Write the reply new leads get within five minutes, in my voice, for me to approve." },
  social: { line: "plan this week's posts and draft the first three for approval.", ask: "Plan this week's posts and draft the first three for me to approve." },
  ads: { line: "write a first ad plan: who it reaches, the offer and a starting budget.", ask: "Write a first ad plan: who it reaches, the offer and a starting budget." },
  blog: { line: "outline three articles your readers would search for.", ask: "Outline three articles our readers would search for." },
  website: { line: "audit the home page and say what to change first.", ask: "Audit our home page and tell me what to change first." },
  video: { line: "plan a first short video: the hook, the shots and the script.", ask: "Plan a first short video: the hook, the shots and the script." },
  inbox: { line: "connect Google on Integrations, then a morning brief of what in your inbox needs you.", ask: "Give me a brief of what in my inbox needs me today." },
  hiring: { line: "write the job post for the next role you need to fill.", ask: "Write the job post for the next role I need to fill. Ask me what it is." },
  developer: { line: "read the codebase and list what is fragile.", ask: "Read the codebase and list what is fragile." },
  onboarding: { line: "write the welcome email a new customer gets on day one.", ask: "Write the welcome email a new customer gets on day one." },
  platform: { line: "check the booking calendar and workflows and report what is off.", ask: "Check the booking calendar and workflows and report what is off." },
  billing: { line: "read this week's claims and say what is unpaid or about to be denied.", ask: "Read this week's claims and tell me what is unpaid or about to be denied." },
  compliance: { line: "list every license and credential expiring in the next 90 days.", ask: "List every license and credential expiring in the next 90 days." },
  custom: { line: "tell you what it can take off your plate this week.", ask: "Tell me what you can take off my plate this week." },
};

export async function setupView(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That workspace isn't here." });
  const entries = await db.listKnowledgeByOrg(orgId);
  const entry = (title: string) => entries.find((e) => e.title.trim().toLowerCase() === title.toLowerCase())?.content.trim() ?? "";
  const starters = STARTERS[org.orgType ?? "business"] ?? STARTERS.business;
  const emps = await db.listEmployeesByOrg(orgId);
  return {
    done: !!org.setupAt,
    inUse: db.hasAnyChat(orgId),
    business: {
      name: org.name,
      orgType: org.orgType ?? "business",
      website: org.website ?? "",
      description: org.description ?? "",
      audience: org.audience ?? "",
      bookingLink: entry("Booking link"),
      brandColors: org.brandColors ?? "",
      tone: entry("Voice and tone"),
    },
    team: emps.map((e) => ({ id: e.id, name: e.name, roleTitle: e.roleTitle, kind: e.kind, avatar: e.avatar, status: e.status, description: e.description ?? "", suggested: starters.includes(e.kind), firstJob: FIRST_JOBS[e.kind]?.line ?? FIRST_JOBS.custom.line })),
  };
}

export async function saveBusiness(orgId: number, input: { website: string; description: string; audience: string; bookingLink: string; brandColors: string; tone: string }) {
  await applyWebsite(orgId, input.website, { description: input.description, audience: input.audience, bookingLink: input.bookingLink, brandColors: input.brandColors, tone: input.tone });
  // A field cleared on purpose is cleared.
  const patch: Record<string, string> = {};
  if (!input.description.trim()) patch.description = "";
  if (!input.audience.trim()) patch.audience = "";
  if (!input.brandColors.trim()) patch.brandColors = "";
  if (Object.keys(patch).length) await db.updateOrganization(orgId, patch);
  return setupView(orgId);
}

/** The picked employees start; the others wait paused until the owner starts them from Chats. */
export async function pickTeam(orgId: number, employeeIds: number[]) {
  if (!employeeIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one employee to start with." });
  for (const e of await db.listEmployeesByOrg(orgId)) {
    const on = employeeIds.includes(e.id);
    if (on && e.status === "paused") await db.updateEmployee(e.id, orgId, { status: "active" });
    if (!on && e.status !== "paused") await db.updateEmployee(e.id, orgId, { status: "paused" });
  }
  return setupView(orgId);
}

/** Setup is done: each starting employee gets its first job as a message the owner can send with one press. */
export async function finishSetup(orgId: number, by: string, skipped = false) {
  const org = await db.getOrganizationById(orgId);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That workspace isn't here." });
  const first = !org.setupAt;
  await db.updateOrganization(orgId, { setupAt: new Date() });
  if (!first || skipped) return setupView(orgId);
  const firstName = by.trim().replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "").split(" ")[0] || "there";
  for (const e of await db.listEmployeesByOrg(orgId)) {
    if (e.status === "paused") continue;
    const job = FIRST_JOBS[e.kind] ?? FIRST_JOBS.custom;
    await db.createChatMessage({
      organizationId: orgId,
      employeeId: e.id,
      role: "employee",
      authorName: e.name,
      content: `Hi ${firstName}. I read the Brain, so I know the business. My first job, if you want it: ${job.line} Press the button or tell me something else.`,
      cards: JSON.stringify([{ type: "choices", id: Date.now(), title: "First job", options: [job.ask] }]),
    });
  }
  return setupView(orgId);
}
