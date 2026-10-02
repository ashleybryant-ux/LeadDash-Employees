import type { EmployeeKind } from "../../drizzle/schema";

/**
 * The seven employees every new workspace starts with. One job each.
 * Names can be changed per workspace; the kind decides what the employee does.
 */
export type RosterEntry = {
  kind: Exclude<EmployeeKind, "custom">;
  name: string;
  roleTitle: string;
  department: "Revenue" | "Marketing" | "Operations";
  description: string;
  capabilities: string[];
  /** Searches the web for this job. */
  searches: boolean;
  /** Rough minutes a person would spend on one finished task, for the hours-saved count. */
  minutesPerTask: number;
};

export const ROSTER: RosterEntry[] = [
  {
    kind: "grants",
    name: "Morgan",
    roleTitle: "Grants",
    department: "Revenue",
    description: "Finds open grants the workspace qualifies for and drafts the application.",
    capabilities: ["Grant search with sources", "Eligibility check", "Proposal sections", "Approval before submitting"],
    searches: true,
    minutesPerTask: 90,
  },
  {
    kind: "speaking",
    name: "Des",
    roleTitle: "Speaking",
    department: "Revenue",
    description: "Finds conferences and events taking speaker proposals and writes the pitch.",
    capabilities: ["Event search with sources", "Proposal deadlines", "Pitch emails"],
    searches: true,
    minutesPerTask: 45,
  },
  {
    kind: "social",
    name: "Sienna",
    roleTitle: "Social media",
    department: "Marketing",
    description: "Writes posts for each platform and makes the image.",
    capabilities: ["LinkedIn, Instagram, Facebook and X posts", "Post images", "Approval before posting"],
    searches: false,
    minutesPerTask: 30,
  },
  {
    kind: "blog",
    name: "Theo",
    roleTitle: "Blog",
    department: "Marketing",
    description: "Writes long-form articles and banners for the workspace's WordPress site.",
    capabilities: ["Long-form articles", "Banner images", "WordPress drafts"],
    searches: false,
    minutesPerTask: 120,
  },
  {
    kind: "website",
    name: "Wren",
    roleTitle: "Website",
    department: "Marketing",
    description: "Plans website pages section by section, with the copy for each.",
    capabilities: ["Page plans", "Headlines and copy", "Calls to action"],
    searches: false,
    minutesPerTask: 60,
  },
  {
    kind: "video",
    name: "Nico",
    roleTitle: "Video",
    department: "Marketing",
    description: "Finds video formats that are working now and turns them into a shot list and script.",
    capabilities: ["Trend search with sources", "Hooks", "Shot lists and timed scripts"],
    searches: true,
    minutesPerTask: 60,
  },
  {
    kind: "inbox",
    name: "Avery",
    roleTitle: "Inbox and calendar",
    department: "Operations",
    description: "Reads messages, says what each sender wants, and drafts the reply and calendar holds.",
    capabilities: ["Reply drafts", "Urgency", "Calendar holds"],
    searches: false,
    minutesPerTask: 10,
  },
];

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
- No hype words, no filler, no generic claims. Do not invent statistics, awards, credentials, clients, or quotes.
- If a fact you need is missing from the Brain, write a bracketed placeholder like [CLINICIAN NAME] instead of making it up.
- Never include a client's name or any client health information. If a pasted message contains it, refer to the person by initials only and leave clinical details out.
- Follow the workspace's voice, names and signatures exactly as the Brain states them.`;
