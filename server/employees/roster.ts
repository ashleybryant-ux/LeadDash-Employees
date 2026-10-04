import type { EmployeeKind } from "../../drizzle/schema";

/**
 * The employees every workspace has. One job each. New jobs added here are
 * given to every existing workspace at startup (ensureRoster).
 * Names can be changed per workspace; the kind decides what the employee does.
 */
export type RosterEntry = {
  kind: Exclude<EmployeeKind, "custom">;
  name: string;
  roleTitle: string;
  department: "Leadership" | "Revenue" | "Sales" | "Marketing" | "Operations";
  description: string;
  capabilities: string[];
  /** Searches the web for this job. */
  searches: boolean;
  /** Rough minutes a person would spend on one finished task, for the hours-saved count. */
  minutesPerTask: number;
};

export const ROSTER: RosterEntry[] = [
  {
    kind: "coo",
    name: "Simone",
    roleTitle: "Chief Operating Officer",
    department: "Leadership",
    description: "Runs the meeting schedule across every team: writes each agenda from the week's work, sends invites with a Google Meet or Zoom link, turns your notes into action items and a recap, and keeps the company scorecard.",
    capabilities: ["Agendas from the week's work", "Invites with Google Meet or Zoom links", "Action items and recaps from your notes", "Company scorecard"],
    searches: false,
    minutesPerTask: 45,
  },
  {
    kind: "projects",
    name: "Nora",
    roleTitle: "Project Manager",
    department: "Leadership",
    description: "Owns every project from idea to finish: plans it back from the date with one owner per task, starts each employee on their work and checks it, runs project meetings with agendas and recaps, chases what slips, and sends a weekly status report rated green, amber or red.",
    capabilities: ["Launch plans with milestones", "Employees started on their tasks and checked", "Project meeting agendas and recaps", "Morning check and reminders", "Ideas, risks and decisions", "Weekly status reports"],
    searches: false,
    minutesPerTask: 60,
  },
  {
    kind: "grants",
    name: "Morgan",
    roleTitle: "Grant Writer",
    department: "Revenue",
    description: "Finds open grants the workspace qualifies for, checks eligibility and drafts the application from your Brain and Knowledge files. Nothing is submitted without your approval.",
    capabilities: ["Grant search with sources", "Eligibility check", "Proposal sections from your Knowledge files", "Approval before submitting"],
    searches: true,
    minutesPerTask: 90,
  },
  {
    kind: "speaking",
    name: "Taylor",
    roleTitle: "Speaking Agent and Publicist",
    department: "Revenue",
    description: "Books you on stages and in the press: finds conferences taking speaker proposals, journalist requests, podcasts booking guests and op-ed openings, tracks the deadlines and writes each proposal and pitch. Nothing goes out without your approval.",
    capabilities: ["Event and media search with sources", "Proposal and pitch deadlines", "Speaker proposals and media pitches", "Approval before anything goes out"],
    searches: true,
    minutesPerTask: 45,
  },
  {
    kind: "prospecting",
    name: "Riley",
    roleTitle: "Sales Prospector",
    department: "Sales",
    description: "Finds practices and businesses that fit what the workspace sells (or referral partners for a practice) using the NPI Registry, state licensing boards and their own websites, scores each fit and passes the good ones to Jada.",
    capabilities: ["NPI Registry and state board lookups", "Owner, phone and LinkedIn profile", "Fit scores with reasons", "Passes good fits to Jada"],
    searches: true,
    minutesPerTask: 40,
  },
  {
    kind: "outreach",
    name: "Jada",
    roleTitle: "Outreach Writer",
    department: "Sales",
    description: "Writes a 3-email sequence for each prospect and sends it from your Gmail, adds a LinkedIn connection step with the note ready, and stops when they reply or book.",
    capabilities: ["3-email sequences", "Personal first lines from Riley's research", "LinkedIn connection notes", "Stops on reply or booking", "Passes replies to Malik"],
    searches: false,
    minutesPerTask: 20,
  },
  {
    kind: "leads",
    name: "Malik",
    roleTitle: "New Leads Assistant",
    department: "Sales",
    description: "Answers new leads within minutes and books the meeting on your calendar.",
    capabilities: ["Lead form and LeadDash platform intake", "Replies with open times", "Booking page", "Books on Google Calendar"],
    searches: false,
    minutesPerTask: 15,
  },
  {
    kind: "social",
    name: "Sienna",
    roleTitle: "Social Media Manager",
    department: "Marketing",
    description: "Writes posts for LinkedIn, Instagram, Facebook and X and makes the image for each one.",
    capabilities: ["LinkedIn, Instagram, Facebook and X posts", "Post images", "Approval before posting"],
    searches: false,
    minutesPerTask: 30,
  },
  {
    kind: "blog",
    name: "Theo",
    roleTitle: "Blog Writer",
    department: "Marketing",
    description: "Writes long-form articles with banner images as WordPress drafts and passes each new article to Sienna for posts.",
    capabilities: ["Long-form articles", "Banner images", "WordPress drafts", "Passes articles to Sienna"],
    searches: false,
    minutesPerTask: 120,
  },
  {
    kind: "website",
    name: "Jordan",
    roleTitle: "Website Planner",
    department: "Marketing",
    description: "Plans website pages section by section, with the headlines, copy and calls to action for each.",
    capabilities: ["Page plans", "Headlines and copy", "Calls to action"],
    searches: false,
    minutesPerTask: 60,
  },
  {
    kind: "video",
    name: "Elena",
    roleTitle: "Video Producer",
    department: "Marketing",
    description: "Finds video formats that are working now and turns them into hooks, shot lists and timed scripts.",
    capabilities: ["Trend search with sources", "Hooks", "Shot lists and timed scripts"],
    searches: true,
    minutesPerTask: 60,
  },
  {
    kind: "inbox",
    name: "Avery",
    roleTitle: "Executive Assistant",
    department: "Operations",
    description: "Reads your messages, says what each sender wants and how urgent it is, drafts the reply and calendar holds, and keeps an eye on ClickUp: what's due, what's overdue, and new tasks you hand off.",
    capabilities: ["Reply drafts", "Urgency", "Calendar holds", "ClickUp: what's due and new tasks"],
    searches: false,
    minutesPerTask: 10,
  },
  {
    kind: "hiring",
    name: "Quinn",
    roleTitle: "Recruiter",
    department: "Operations",
    description: "Writes job posts, finds people for outreach, screens applicants against your must-haves and runs license, NPI and exclusion checks.",
    capabilities: ["Job posts", "Outreach lists with sources", "Applicant scoring against your must-haves", "License, NPI and exclusion checks", "Onboarding checklists"],
    searches: true,
    minutesPerTask: 45,
  },
  {
    kind: "developer",
    name: "Kai",
    roleTitle: "Developer",
    department: "Operations",
    description: "Writes up bugs and changes for Claude to fix in your code, then brings you the finished change to merge.",
    capabilities: ["Bug write-ups Claude can act on", "Fixes in LeadDash Employees and LeadDash EHR", "Changes waiting for your merge", "Plain summaries of what changed"],
    searches: false,
    minutesPerTask: 60,
  },
  {
    kind: "onboarding",
    name: "Imani",
    roleTitle: "Onboarding Specialist",
    department: "Operations",
    description: "Gets new customers from signed to live: the onboarding plan, welcome email, kickoff, training and check-ins.",
    capabilities: ["Onboarding plans worked back from go-live", "Welcome emails", "Kickoff and training steps", "Check-ins after go-live"],
    searches: false,
    minutesPerTask: 30,
  },
  {
    kind: "platform",
    name: "Zara",
    roleTitle: "Platform Specialist",
    department: "Operations",
    description: "Works in the LeadDash platform in her own browser: audits your workflows, fixes them when you say so, and builds pages in your funnels.",
    capabilities: ["Workflow audits with one exact fix each", "Fixes made only when you press Fix", "Jordan's pages built into your funnels as drafts", "Locked to one sub-account"],
    searches: false,
    minutesPerTask: 45,
  },
];

/** Earlier default titles. A workspace still showing one gets the new title; a title someone typed stays. */
export const OLD_TITLES: Record<string, string | string[]> = {
  "Chief Operating Officer": "COO",
  "Project Manager": "Projects",
  "Grant Writer": "Grants",
  "Speaking Agent and Publicist": ["Speaking", "Speaking Agent"],
  "Sales Prospector": "Prospecting",
  "Outreach Writer": "Outreach",
  "New Leads Assistant": "New leads",
  "Social Media Manager": "Social media",
  "Blog Writer": "Blog",
  "Website Planner": "Website",
  "Video Producer": "Video",
  "Executive Assistant": "Inbox and calendar",
  "Recruiter": "Hiring",
};

export function rosterEntry(kind: EmployeeKind) {
  return ROSTER.find((r) => r.kind === kind) || null;
}

/**
 * Rules every employee follows, whatever the job. They come from how the
 * LeadDash team writes and from what an AI employee must never do.
 */
export const BASE_RULES = `Rules for everything you write:
- American English. Plain, specific, human. Write like a subject-matter expert, not a marketer.
- Never use em dashes or en dashes. Use periods, commas, parentheses or colons.
- Never use constructions like "you're not here because", "you don't only", or "we won't do X, we will do Y". Never announce how important a line is; state the fact.
- Full sentences only, never fragments like "No contracts." Never the phrases that give writing away as AI: one thing worth knowing, that matters, which means, I came across, I hope this finds you, reaching out, touch base, seamless, streamline, elevate, empower, unlock, leverage, game changer.
- No hype words, no filler, no generic claims. Do not invent statistics, awards, credentials, clients, or quotes.
- If a fact you need is missing from the Brain, write a bracketed placeholder like [CLINICIAN NAME] instead of making it up.
- Never include a client's name or any client health information. If a pasted message contains it, refer to the person by initials only and leave clinical details out.
- Follow the workspace's voice, names and signatures exactly as the Brain states them.
- Never ask the person to look up anything you can find yourself on the web, in the Brain or in the documents you have. Do the research. Ask the person only what only they can know or decide (internal numbers, decisions, signatures, approvals).`

/** The three Guidelines fields, labeled for each job. */
export const GUIDELINE_LABELS: Record<Exclude<EmployeeKind, "custom">, { focus: string; avoid: string; signAs: string }> = {
  grants: { focus: "Look for", avoid: "Skip", signAs: "Sign proposals as" },
  speaking: { focus: "Talks and story topics to pitch", avoid: "Skip", signAs: "Sign pitches as" },
  social: { focus: "Topics", avoid: "Avoid", signAs: "Sign posts as" },
  blog: { focus: "Topics", avoid: "Avoid", signAs: "Author name" },
  website: { focus: "Pages to focus on", avoid: "Avoid", signAs: "Main call to action" },
  video: { focus: "Formats", avoid: "Avoid", signAs: "On-camera name" },
  inbox: { focus: "How to reply", avoid: "Never", signAs: "Sign replies as" },
  hiring: { focus: "Roles to fill", avoid: "Never", signAs: "Sign messages as" },
  prospecting: { focus: "Look for", avoid: "Skip", signAs: "Ideal fit" },
  outreach: { focus: "What to lead with", avoid: "Never say", signAs: "Sign emails as" },
  leads: { focus: "How to reply", avoid: "Never promise", signAs: "Sign replies as" },
  coo: { focus: "What every agenda covers", avoid: "Never put on an agenda", signAs: "Sign invites as" },
  projects: { focus: "How you like plans", avoid: "Never schedule", signAs: "Sign reports as" },
  developer: { focus: "What to work on", avoid: "Never change", signAs: "Sign changes as" },
  onboarding: { focus: "Every onboarding includes", avoid: "Never promise", signAs: "Sign emails as" },
  platform: { focus: "What to check first", avoid: "Never change", signAs: "Name pages as" },
};

export type Guidelines = { focus: string; avoid: string; signAs: string };

export function parseGuidelines(raw: string | null | undefined): Guidelines {
  try {
    const g = raw ? JSON.parse(raw) : {};
    return { focus: String(g.focus ?? ""), avoid: String(g.avoid ?? ""), signAs: String(g.signAs ?? "") };
  } catch {
    return { focus: "", avoid: "", signAs: "" };
  }
}
