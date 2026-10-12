import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, EmployeeKind } from "../../drizzle/schema";
import { BASE_RULES, rosterEntry } from "./roster";
import * as interview from "./interview";

/**
 * The bench (2026-10-12). Every employee starts on the bench (status
 * "paused"); only the ones the owner brings on show in Chats and Huddle.
 * From the bench the owner reads a bio (free) or interviews the employee out
 * loud (each answer uses work hours), then brings them on with one click. A
 * new hire says thanks in their chat and offers to start onboarding.
 *
 * Limits:
 * - A workspace opened from LeadDash EHR with no work-hours plan yet is on the
 *   LeadDash EHR start: only the three who work with LeadDash EHR (Malik,
 *   Harper, Camille). A plan opens the full team.
 * - Everyone else starts with up to five, then brings on one more at a time:
 *   the next waits until the last one brought on from the bench finished
 *   onboarding.
 * - LeadDash's own workspaces have no limit.
 */

/** The three who read from LeadDash EHR: leads (not booked), claims and payments, team and licenses. */
export const EHR_KINDS: EmployeeKind[] = ["leads", "billing", "compliance"];
export const EHR_GROUP = "Works with LeadDash EHR";
export const START_LIMIT = 5;
/** Vacation lasts at least this long; a terminated employee is rehirable after TERMINATE_DAYS. */
export const VACATION_MIN_DAYS = 30;
export const TERMINATE_DAYS = 90;
export const TERMINATE_REASONS = ["Not a fit", "Don't need this work", "Costs too much", "Other"] as const;

/** Today as YYYY-MM-DD in a time zone. */
export const todayIn = (tz: string, now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: tz });
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const dayText = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

export type Bio = { pitch: string[]; support: string[]; works: string };

/** What each employee says about themselves: the bio card and the first lines of an interview. */
export const BIOS: Partial<Record<EmployeeKind, Bio>> = {
  coo: {
    pitch: ["Hi, I'm Simone. I keep the whole team running on one rhythm. I write every meeting agenda from what actually happened this week, send the invites, and turn the notes into action items and a recap.", "Bring me off the bench if meetings end and nobody remembers who owns what. Every decision turns into a task with a name and a date."],
    support: ["Every meeting gets an agenda built from the week's real work.", "Decisions become action items with an owner and a date, and a recap goes out the same day.", "Your goals and weekly scorecard stay current without a spreadsheet."],
    works: "Gets meeting notes from Avery. Sends action items to Nora.",
  },
  projects: {
    pitch: ["Hi, I'm Nora. Give me a goal and a date and I plan it backward: every task, one owner, a due date. Then I start each teammate on their part and check it.", "Bring me off the bench if things get decided in a huddle and then quietly die. I follow every task until it's done."],
    support: ["Plans every project back from its date, one owner per task.", "Checks every morning what's due and nudges whoever is behind.", "Sends a weekly status report rated green, amber or red."],
    works: "Starts every teammate on their part and checks it. Gets action items from Simone.",
  },
  inbox: {
    pitch: ["Hi, I'm Avery. I read your inbox so you don't have to read all of it. For every message I tell you who it's from, what they want and how urgent it is, and I draft the reply.", "Bring me off the bench if your inbox decides your day. I also sit in on your calls and send the notes to Simone."],
    support: ["Every message gets a one-line summary: who it's from, what they want and how urgent it is.", "Replies and calendar holds are drafted for you to send.", "Sits in on your Zoom and Google Meet calls and writes the notes.", "Keeps track of what's due and overdue in Projects."],
    works: "Sends meeting notes to Simone and new tasks to Nora.",
  },
  leads: {
    pitch: ["Hey, I'm Malik. When someone fills out your form or messages you, I answer within minutes with your open times and book them right on your calendar.", "Most people who don't hear back in the first hour book with someone else. Bring me off the bench and nobody waits on you again. Ask me anything about how I'd work for you."],
    support: ["Answers new leads from your forms and the LeadDash platform within minutes.", "Offers your real open times and books straight onto your calendar.", "Follows up with anyone who goes quiet before booking."],
    works: "Gets warm replies from Jada. Books meetings on your calendar.",
  },
  billing: {
    pitch: ["Hi, I'm Harper. Every morning I read your claims and payments and tell you exactly what needs a person: each denial with its reason and fix, and unpaid claims by payer with a script for the call.", "Bring me off the bench if money is sitting in claims nobody has time to chase."],
    support: ["Every morning: each denial with the reason and the fix.", "Unpaid claims grouped by payer, with a script for the follow-up call.", "Client statements drafted for you; nothing is sent or charged on its own.", "Eligibility results for the week's sessions before clients arrive."],
    works: "Reads claims, payments and eligibility from LeadDash EHR.",
  },
  compliance: {
    pitch: ["Hi, I'm Camille. I track every date that can get you in trouble: license renewals, CAQH attestations, HIPAA training, payer enrollments and unsigned notes by clinician.", "Bring me off the bench if you've ever found out about an expired license from a payer. I remind your team before it's late."],
    support: ["License renewals, CAQH attestations, CE hours and HIPAA training, each with a due date.", "Unsigned notes and plans due for review, counted by clinician. Never what a note says.", "Payer enrollments and their status.", "Reminders to your team, written in chat and sent only when you say."],
    works: "Reads your team and their licenses from LeadDash EHR.",
  },
  grants: {
    pitch: ["Hi, I'm Morgan. I find open grants you actually qualify for, check the fine print, and draft the application from what you've already written.", "Bring me off the bench if you know there's money out there but never have the hours to apply."],
    support: ["Searches for open grants you qualify for, with sources.", "Checks the eligibility rules before you spend time on one.", "Drafts each section of the application; nothing is submitted without your approval."],
    works: "Writes from your Brain and Knowledge files.",
  },
  speaking: {
    pitch: ["Hi, I'm Taylor. I find the stages, podcasts and reporters looking for someone like you, track every deadline and write the proposal or pitch.", "Bring me off the bench if you want to be known for what you do without spending nights on applications."],
    support: ["Finds conferences taking speaker proposals, podcasts booking guests and reporters asking for sources.", "Tracks every deadline so nothing slips past.", "Writes each proposal and pitch in your voice."],
    works: "Sends pitches only after your approval.",
  },
  prospecting: {
    pitch: ["Hi, I'm Riley. Tell me who you want to reach, in your own words, and where. I come back with names, phone numbers and LinkedIn, each with a score for how good a fit they are.", "Bring me off the bench if you have open spots and you're tired of waiting for people to find you."],
    support: ["Searches for whoever you describe, in the area you name, from their own websites and official listings.", "Brings back contact names, phone numbers and LinkedIn profiles.", "Scores each fit with the reasons, and can repeat the search every week or month."],
    works: "Passes good fits to Jada for outreach.",
  },
  outreach: {
    pitch: ["Hi, I'm Jada. When Riley finds someone good, I write them three short, personal emails from your Gmail, and I stop the second they reply or book.", "Bring me off the bench and you get the meetings while I do the follow-up."],
    support: ["Writes a personal 3-email sequence for each prospect and sends it from your Gmail.", "Adds a LinkedIn connection step with the note ready.", "Stops the moment someone replies or books."],
    works: "Gets prospects from Riley. Passes replies to Malik.",
  },
  social: {
    pitch: ["Hi, I'm Sienna. I write posts that sound like you for LinkedIn, Instagram, Facebook and X, and I make the image for each one.", "Bring me off the bench if your pages go quiet whenever you get busy."],
    support: ["Writes posts for LinkedIn, Instagram, Facebook and X in your voice.", "Makes the image for every post.", "Plans the month so your pages never go quiet."],
    works: "Turns each new article from Theo into posts.",
  },
  blog: {
    pitch: ["Hi, I'm Theo. I write long articles people actually search for, add the photos, and post them to your WordPress site.", "Bring me off the bench if you want search engines sending you people every month."],
    support: ["Writes long-form articles around one keyword people search for.", "Adds a banner image and photos inside every article.", "Posts to your WordPress site, on his own if you allow it."],
    works: "Passes every new article to Sienna for posts.",
  },
  website: {
    pitch: ["Hi, I'm Jordan. I read your website the way a visitor does, tell you what's costing you, and mock up the new version right in our chat.", "Bring me off the bench when you need a landing page for a launch by Friday."],
    support: ["Audits your website from the real page and says what to change first.", "Mocks up the new version live in your chat.", "Builds landing pages with your photos and graphics."],
    works: "Hands finished pages to Zara for your funnels.",
  },
  video: {
    pitch: ["Hi, I'm Elena. Describe a video and I make it: b-roll with a voice-over, a slideshow of your photos, an explainer or you talking to camera.", "Bring me off the bench if video is the thing you keep meaning to start."],
    support: ["Makes any video you describe: b-roll with a voice-over, a slideshow or an explainer.", "Can put you on camera talking.", "Finds video formats that are working right now."],
    works: "Uses your photos and Brain files.",
  },
  ads: {
    pitch: ["Hi, I'm Reese. Give me one brief and I write the ads for each platform, to that platform's specs, with the picture for each, and split your budget across them.", "Bring me off the bench if you're paying for ads and guessing at what to say."],
    support: ["Writes ad creative for each platform, to that platform's specs, from one brief.", "Makes the picture for each ad, plus audio spots.", "Splits your budget across platforms with a per-day amount."],
    works: "You approve each platform before it goes in.",
  },
  hiring: {
    pitch: ["Hi, I'm Quinn. I write the job post, put it where people look, and score every applicant against your must-haves, with license and exclusion checks.", "Bring me off the bench before your next hire, not after a bad one."],
    support: ["Writes job descriptions and posts them to your careers page and job boards.", "Scores applicants against your must-haves.", "Runs license, NPI and exclusion checks.", "Reports each team member's hours and capacity."],
    works: "Hands new hires to Imani for onboarding.",
  },
  onboarding: {
    pitch: ["Hi, I'm Imani. When someone joins, I handle the checklist, the first-week plan, the welcome email and the check-ins, so nothing gets missed.", "Bring me off the bench if every new hire's first week depends on your memory."],
    support: ["Handles the paperwork, accounts and first-week plan for every new hire.", "Checks in at 30, 60 and 90 days.", "Offboards people who leave, and onboards new customers too."],
    works: "Builds each plan in Projects with Nora.",
  },
  developer: {
    pitch: ["Hi, I'm Kai. Tell me what's broken or what you want changed, and I write it up properly and bring you the finished change to approve.", "Bring me off the bench if you build your own tools."],
    support: ["Writes up bugs and changes clearly enough to fix the first time.", "Brings you the finished change to merge.", "Explains in plain words what changed."],
    works: "Brings you finished changes to approve.",
  },
  platform: {
    pitch: ["Hi, I'm Zara. I go through your workflows in the LeadDash platform, find what's broken, and fix it when you say so.", "Bring me off the bench if you're not sure your automations still work."],
    support: ["Audits your LeadDash platform workflows with one exact fix for each problem.", "Makes a fix only when you press Fix.", "Stays locked to your one sub-account."],
    works: "Builds Jordan's pages into your funnels.",
  },
};

/** The bio for an employee: the roster's when it has one, else one made from the job description. The name in the first line follows the workspace's name for them. */
export function bioOf(emp: Pick<AIEmployee, "kind" | "name" | "description" | "capabilities">): Bio {
  const roster = rosterEntry(emp.kind);
  const b = BIOS[emp.kind];
  if (b && roster) return { ...b, pitch: b.pitch.map((p) => p.replaceAll(roster.name, emp.name)) };
  let caps: string[] = [];
  try {
    caps = JSON.parse(emp.capabilities || "[]");
  } catch {
    caps = [];
  }
  return { pitch: [`Hi, I'm ${emp.name}. ${emp.description ?? ""}`.trim()], support: caps.slice(0, 4), works: "" };
}

const hired = (e: Pick<AIEmployee, "status">) => e.status !== "paused";

/** "Avery", "Avery and Nora", "Simone, Nora and Avery". */
export const namesText = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Where the workspace stands: who can be brought on next, and why not. */
export async function limits(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "That workspace isn't here." });
  const emps = await db.listEmployeesByOrg(orgId);
  const team = emps.filter(hired);
  const { settingsOf } = await import("../workHours");
  const ehrStart = !org.internal && !!org.ehrLocationId && !settingsOf(org).plan;
  const onboarding = team.filter((e) => {
    const st = interview.readState(e);
    return !!st.hiredAt && !st.done;
  });
  const startFull = !org.internal && !ehrStart && team.length >= START_LIMIT && onboarding.length > 0;
  return {
    tz: org.timezone || "America/Chicago",
    internal: !!org.internal,
    healthcare: org.orgType === "healthcare",
    ehrStart,
    teamCount: team.length,
    startLimit: START_LIMIT,
    /** The person still onboarding who holds up the next hire, by name. */
    waitingOn: startFull ? onboarding.map((e) => e.name) : [],
    canBringOn(kind: string) {
      if (ehrStart) return EHR_KINDS.includes(kind as EmployeeKind);
      return !startFull;
    },
  };
}

export function limitMessage(l: Awaited<ReturnType<typeof limits>>, name: string) {
  if (l.ehrStart) return `${name} isn't in your plan yet. Your plan includes the three who work with LeadDash EHR. Add the full team to bring on ${name} and anyone else on the bench.`;
  return `Your first ${l.startLimit} are on the team. Finish onboarding with ${namesText(l.waitingOn)} first, then bring on one more at a time.`;
}

/** The bench page: every employee, the bios, the limits and what an interview answer uses. */
export async function benchView(orgId: number) {
  const l = await limits(orgId);
  const { withPortrait } = await import("../ehrLink");
  const { JOBS } = await import("../workHours");
  const emps = (await db.listEmployeesByOrg(orgId)).map(withPortrait);
  const today = todayIn(l.tz);
  return {
    today,
    vacationMinDays: VACATION_MIN_DAYS,
    terminateDays: TERMINATE_DAYS,
    reasons: TERMINATE_REASONS,
    healthcare: l.healthcare,
    ehrStart: l.ehrStart,
    ehrKinds: l.healthcare ? EHR_KINDS : [],
    teamCount: l.teamCount,
    startLimit: l.internal || l.ehrStart ? null : l.startLimit,
    waitingOn: l.waitingOn,
    interviewMinutes: JOBS.interview.minutes,
    employees: emps.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      roleTitle: e.roleTitle,
      department: e.department,
      avatar: e.avatar,
      onTeam: hired(e),
      canBringOn: !hired(e) && !interview.readState(e).away && l.canBringOn(e.kind),
      onboarded: interview.readState(e).done,
      away: awayView(e, today),
      bio: bioOf(e),
    })),
  };
}

/** One click: the employee joins the team and, in their chat, thanks the owner and offers to start onboarding. */
export async function bringOn(orgId: number, employeeId: number) {
  const emp = await db.getEmployeeForOrg(employeeId, orgId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  if (hired(emp)) return emp;
  const l = await limits(orgId);
  const away = interview.readState(emp).away;
  if (away) {
    const a = awayView(emp, todayIn(l.tz))!;
    if (!a.canReturn) throw new TRPCError({ code: "PRECONDITION_FAILED", message: away.kind === "vacation" ? `${emp.name} is on vacation and can come back on ${dayText(a.returnFrom)}.` : `${emp.name} will be rehirable on ${dayText(away.until)}.` });
  }
  if (!l.canBringOn(emp.kind)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: limitMessage(l, emp.name) });
  const on = (await db.updateEmployee(emp.id, orgId, { status: "active" }))!;
  if (away) return interview.welcomeBack(on, away.kind);
  return interview.welcomeFromBench(on);
}

/** Where an away employee stands: back or rehirable on which day, and whether they can come back today. */
export function awayView(emp: AIEmployee, today: string) {
  const a = interview.readState(emp).away;
  if (!a) return null;
  // A vacation can end early once 30 days have passed; a termination ends on its rehirable day.
  const returnFrom = a.kind === "vacation" ? addDays(a.since, VACATION_MIN_DAYS) : a.until;
  return { kind: a.kind, since: a.since, until: a.until, reason: a.reason ?? "", waiting: !!a.waiting, returnFrom, canReturn: today >= returnFrom };
}

async function onTeamOrThrow(orgId: number, employeeId: number) {
  const emp = await db.getEmployeeForOrg(employeeId, orgId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  if (!hired(emp)) throw new TRPCError({ code: "BAD_REQUEST", message: `${emp.name} isn't on your team.` });
  const org = await db.getOrganizationById(orgId);
  return { emp, today: todayIn(org?.timezone || "America/Chicago") };
}

/** Vacation: onboarded employees only, back on a day at least 30 days out. Off Chats and Huddle, no scheduled work, no spot on the team. */
export async function sendOnVacation(orgId: number, employeeId: number, back: string) {
  const { emp, today } = await onTeamOrThrow(orgId, employeeId);
  if (!interview.readState(emp).done) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${emp.name} can go on vacation after onboarding.` });
  const earliest = addDays(today, VACATION_MIN_DAYS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(back) || back < earliest) throw new TRPCError({ code: "BAD_REQUEST", message: `Pick a return date on or after ${dayText(earliest)}.` });
  const off = (await db.updateEmployee(emp.id, orgId, { status: "paused" }))!;
  return interview.setAway(off, { kind: "vacation", since: today, until: back });
}

/** A new return date: later anytime, earlier only once 30 days have passed (never before today). */
export async function changeReturn(orgId: number, employeeId: number, back: string) {
  const emp = await db.getEmployeeForOrg(employeeId, orgId);
  const away = emp ? interview.readState(emp).away : undefined;
  if (!emp || away?.kind !== "vacation") throw new TRPCError({ code: "BAD_REQUEST", message: "That employee isn't on vacation." });
  const org = await db.getOrganizationById(orgId);
  const today = todayIn(org?.timezone || "America/Chicago");
  const earliest = [addDays(away.since, VACATION_MIN_DAYS), today].sort().at(-1)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(back) || back < earliest) throw new TRPCError({ code: "BAD_REQUEST", message: `Pick a return date on or after ${dayText(earliest)}.` });
  return interview.setAway(emp, { ...away, until: back, waiting: false });
}

/** Terminate: off the team now, everything stored, rehirable in 90 days. */
export async function terminate(orgId: number, employeeId: number, reason: string) {
  const { emp, today } = await onTeamOrThrow(orgId, employeeId);
  const off = (await db.updateEmployee(emp.id, orgId, { status: "paused" }))!;
  return interview.setAway(off, { kind: "terminated", since: today, until: addDays(today, TERMINATE_DAYS), reason: reason.slice(0, 60) });
}

/** Every minute: vacations whose return date has come end, when there's room on the team. */
export async function vacationTick(orgId: number) {
  const l = await limits(orgId);
  const today = todayIn(l.tz);
  for (const e of await db.listEmployeesByOrg(orgId)) {
    const a = interview.readState(e).away;
    if (e.status !== "paused" || a?.kind !== "vacation" || a.until > today) continue;
    if ((await limits(orgId)).canBringOn(e.kind)) {
      const on = (await db.updateEmployee(e.id, orgId, { status: "active" }))!;
      await interview.welcomeBack(on, "vacation");
      await db.logAction({ organizationId: orgId, actorType: "system", actorName: e.name, action: "Back from vacation", details: e.name });
    } else if (!a.waiting) {
      await interview.setAway(e, { ...a, waiting: true });
      await db.logAction({ organizationId: orgId, actorType: "system", actorName: e.name, action: "Back from vacation when there's room on the team", details: e.name });
      const { notify } = await import("../notify");
      await notify(orgId, "report", { title: `${e.name} is back from vacation`, body: `Your team is full, so ${e.name} waits on the bench. Make room to bring ${e.name} back.`, url: "/bench", tag: `vacation-${e.id}` }).catch(() => null);
    }
  }
}

export async function vacationTicks() {
  for (const id of await db.listAllOrganizationIds()) await vacationTick(id).catch((err) => console.warn("[bench] vacation tick failed:", err instanceof Error ? err.message : err));
}

export type InterviewLine = { me: boolean; text: string };

/**
 * One answer in an interview. With no question it is the opening: the
 * employee's own pitch. Every answer uses work hours (the interview job),
 * charged only when the answer came back.
 */
export async function interviewAnswer(orgId: number, employeeId: number, history: InterviewLine[], question: string) {
  const emp = await db.getEmployeeForOrg(employeeId, orgId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  const org = await db.getOrganizationById(orgId);
  const hours = await import("../workHours");
  await hours.gate(orgId);
  const bio = bioOf(emp);
  let text = bio.pitch.join(" ");
  if (question.trim()) {
    const { generateText } = await import("../_core/llm");
    const transcript = history.slice(-12).map((h) => `${h.me ? "Owner" : emp.name}: ${h.text}`).join("\n");
    text = await generateText({
      system: `You are ${emp.name}, the ${emp.roleTitle} on LeadDash Employees. You are on the bench at ${org?.name ?? "this workspace"}${org?.description ? ` (${org.description})` : ""}, and the owner is interviewing you to decide whether to bring you onto the team.

What you do: ${emp.description ?? ""}
What you can do: ${bio.support.join(" ")}
Who you work with: ${bio.works}

Answer as yourself, out loud, in 2 to 4 short sentences: warm, specific and plain. No lists, no headings, no markdown. Only claim what is in your job above; if something isn't part of your job, say so and say who on the team does it, if anyone. If asked what this costs: this interview uses work hours for each answer, reading your bio on the bench is free, and once you're on the team, chatting with you is free and only finished work uses hours. If the owner wants to bring you on, tell them to press Bring on.

${BASE_RULES}`,
      prompt: `${transcript ? `The interview so far:\n${transcript}\n\n` : ""}Owner: ${question.trim()}`,
      maxTokens: 400,
      temperature: 0.6,
    });
    text = text.replace(/[\u2013\u2014]/g, ",").trim();
  }
  await hours.charge(orgId, emp.id, "interview", 1, emp.name);
  return { emp, text };
}
