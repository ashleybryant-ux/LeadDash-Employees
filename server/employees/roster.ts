import type { EmployeeKind, OrgType } from "../../drizzle/schema";

/**
 * The employees every workspace has. One job each. New jobs added here are
 * given to every existing workspace at startup (ensureRoster).
 * Names can be changed per workspace; the kind decides what the employee does.
 */
export type Department = "Leadership" | "Revenue" | "Sales" | "Marketing" | "Operations" | "Client care" | "Billing and compliance" | "Growth";

export type RosterEntry = {
  kind: Exclude<EmployeeKind, "custom">;
  name: string;
  roleTitle: string;
  department: Department;
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
    description: "Runs the meeting schedule across every team: writes each agenda from the week's work, sends invites with a Google Meet or Zoom link, turns Avery's meeting notes (or yours) into action items and a recap, and keeps the company scorecard.",
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
    kind: "ads",
    name: "Reese",
    roleTitle: "Ads Manager",
    department: "Marketing",
    description: "Writes the ad creative for each platform (Meta, Google Search, YouTube, Microsoft Ads, LinkedIn, TikTok, Reddit, Spotify, Nextdoor, Yelp) from one brief, one platform at a time, with the picture for each, and splits the budget across them. You approve every set and put it into the platform yourself.",
    capabilities: ["One creative set per platform, to each platform's specs", "Ad images and audio spots", "Budget split with a per-day amount", "Approval one platform at a time"],
    searches: false,
    minutesPerTask: 50,
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
    description: "Reads and audits your website from its real HTML, mocks up the new version as a live preview in the chat, and builds landing and website pages as HTML with your photos from the Brain and pictures and graphics she makes.",
    capabilities: ["Website audits", "Live mockups in the chat", "Pages as HTML to copy", "Pictures and graphics"],
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
    description: "Reads your messages, says what each sender wants and how urgent it is, drafts the reply and calendar holds, sits in on your Zoom and Google Meet meetings and sends the notes to Simone, and keeps an eye on Projects: what's due, what's overdue, and new tasks you hand off.",
    capabilities: ["Reply drafts", "Urgency", "Calendar holds", "Meeting notes for Simone", "Projects: what's due and new tasks"],
    searches: false,
    minutesPerTask: 10,
  },
  {
    kind: "hiring",
    name: "Quinn",
    roleTitle: "HR Director",
    department: "Operations",
    description: "Runs hiring and the people side: writes job posts, finds people for outreach, screens applicants against your must-haves, runs license, NPI and exclusion checks, and reports on each team member's hours, capacity and what they bring in, with a recommendation when a number crosses a line.",
    capabilities: ["Job posts", "Outreach lists with sources", "Applicant scoring against your must-haves", "License, NPI and exclusion checks", "Team report: hours, capacity, collected, no-shows", "Recommendations with the numbers behind them"],
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
  {
    kind: "billing",
    name: "Harper",
    roleTitle: "Billing Specialist",
    department: "Billing and compliance",
    description: "Reads claims, payments and eligibility from LeadDash EHR every morning and lays out what needs a person: denials with the reason and the fix, unpaid claims by payer with a follow-up script, client balances with statements drafted, and eligibility results for the week. Opens the claim in LeadDash EHR for the fix; never submits a claim, charges a card or sends a statement on her own.",
    capabilities: ["Denials with the reason and the fix", "Unpaid claims by payer, with a follow-up script", "Statements and reminders drafted, never sent on their own", "Eligibility results for the week's sessions", "Clients by initials outside the EHR"],
    searches: false,
    minutesPerTask: 30,
  },
  {
    kind: "compliance",
    name: "Camille",
    roleTitle: "Compliance Coordinator",
    department: "Billing and compliance",
    description: "Keeps the practice ready for an audit: CAQH attestations, license renewals and CE hours, HIPAA training, payer enrollments, SOP review dates, and from LeadDash EHR the counts of unsigned notes, treatment plans due for review and overdue measures by clinician. Sees that a note is unsigned, never what is in it. Reminders are drafted and wait for Send.",
    capabilities: ["Credentials, licenses and training with due dates", "Payer enrollments and their status", "Unsigned notes and plans due, by clinician, counts only", "SOPs past their review date", "Reminders drafted, never sent on their own"],
    searches: false,
    minutesPerTask: 30,
  },
];

// ==========================================
// Who is on the team, by organization type
// ==========================================

/** Roster kinds an organization type leaves off the team. A healthcare practice does no outbound sales and has no code to fix; a business has no claims or credentials. */
export const OFF_TEAM: Record<OrgType, EmployeeKind[]> = {
  business: ["billing", "compliance"],
  nonprofit: ["billing", "compliance"],
  healthcare: ["prospecting", "outreach", "developer"],
};

/** Titles that change with the organization type. */
export const TITLES_BY_TYPE: Record<OrgType, Partial<Record<EmployeeKind, string>>> = {
  business: {},
  nonprofit: {},
  healthcare: { leads: "Intake Coordinator", onboarding: "Clinician Onboarding Specialist" },
};

/** Departments by organization type: a practice groups its team the way it runs. */
export const DEPARTMENTS_BY_TYPE: Record<OrgType, Partial<Record<EmployeeKind, Department>>> = {
  business: {},
  nonprofit: {},
  healthcare: { inbox: "Client care", leads: "Client care", grants: "Growth", speaking: "Growth", social: "Growth", ads: "Growth", blog: "Growth", website: "Growth", video: "Growth", hiring: "Operations", onboarding: "Operations", platform: "Operations" },
};

/** The order departments show in the chat list, by organization type. */
export const DEPARTMENT_ORDER: Record<OrgType, Department[]> = {
  business: ["Leadership", "Revenue", "Sales", "Marketing", "Operations"],
  nonprofit: ["Leadership", "Revenue", "Sales", "Marketing", "Operations"],
  healthcare: ["Leadership", "Client care", "Billing and compliance", "Growth", "Operations"],
};

/** In a healthcare practice, the employees that work with client information (only on providers under a signed BAA). */
export const CLIENT_INFO_KINDS: EmployeeKind[] = ["inbox", "leads", "billing", "compliance"];

export function onTeam(kind: EmployeeKind, orgType: OrgType) {
  return !OFF_TEAM[orgType].includes(kind);
}

export function titleFor(entry: Pick<RosterEntry, "kind" | "roleTitle">, orgType: OrgType) {
  return TITLES_BY_TYPE[orgType][entry.kind] ?? entry.roleTitle;
}

export function departmentFor(entry: Pick<RosterEntry, "kind" | "department">, orgType: OrgType): Department {
  return DEPARTMENTS_BY_TYPE[orgType][entry.kind] ?? entry.department;
}

export function worksWithClientInfo(kind: EmployeeKind, orgType: OrgType) {
  return orgType === "healthcare" && CLIENT_INFO_KINDS.includes(kind);
}

/** Every title a roster kind has had, by type, so a workspace whose type changes gets retitled and a title someone typed stays. */
export function defaultTitles(entry: Pick<RosterEntry, "kind" | "roleTitle">) {
  const old = OLD_TITLES[entry.roleTitle];
  return [entry.roleTitle, ...(Array.isArray(old) ? old : old ? [old] : []), ...Object.values(TITLES_BY_TYPE).map((t) => t[entry.kind]).filter((t): t is string => Boolean(t))];
}

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
  "HR Director": ["Hiring", "Recruiter"],
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
  ads: { focus: "Offers and audiences to lead with", avoid: "Never say in an ad", signAs: "Brand name in ads" },
  billing: { focus: "Flag first", avoid: "Never do on my own", signAs: "Sign statements as" },
  compliance: { focus: "Track first", avoid: "Never do on my own", signAs: "Sign reminders as" },
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
