import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, ChatFile, ChatMessage } from "../../drizzle/schema";
import { generateJson, generateText, type JsonSchema } from "../_core/llm";
import * as tasks from "./tasks";
import * as apply from "./apply";
import * as pages from "./pages";
import * as hiring from "./hiring";
import { writeReport } from "./onboarding";
import type { Opportunity, OppKind } from "../../drizzle/schema";
import { channelName, planSchedule, postNow, type Plan } from "../social";
import * as sales from "./sales";
import { askTeammate, gate } from "./team";
import * as projects from "./projects";
import * as coo from "./coo";
import * as notetaker from "./notetaker";
import * as interview from "./interview";

/**
 * Chat with an employee. Each message is answered in two steps:
 * 1. The employee reads the conversation and decides whether the message asks
 *    it to do its job now (find grants, write a post...) or just to talk.
 * 2. If there is a job, the server runs it with the same task code the Work
 *    tabs use, and the reply carries cards for whatever was created.
 */

export type ChatCard = {
  type: "opportunity" | "application" | "application_draft" | "answer" | "question" | "submitted" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate" | "schedule_plan" | "prospect_sales" | "launch_plan" | "meeting_agenda" | "meeting_notes" | "onboarding" | "onboarding_q" | "browser_live" | "choices" | "layout_choice";
  id: number;
  title: string;
  subtitle?: string;
  body?: string;
  url?: string | null;
  imageUrl?: string | null;
  call?: string;
  score?: number;
  status?: string;
  options?: string[];
  plan?: Plan;
  /** A page card's version, so an older message keeps showing that version. */
  version?: number;
  /** An answer card: the answer before the rewrite, so "Go back to the old one" can restore it. */
  before?: string;
};

/** Quick replies under an employee's message: fixed answers the person taps instead of typing. */
export function choicesCard(options: string[]): ChatCard {
  return { type: "choices", id: Date.now(), title: "", options: options.map((o) => o.trim().slice(0, 60)).filter(Boolean).slice(0, 4) };
}

/** The three page layouts Jordan offers before a first build. */
export const LAYOUTS = [
  { key: "split", title: "Photo beside headline", sub: "Your photo carries the page" },
  { key: "bold", title: "Big headline first", sub: "The promise carries the page" },
  { key: "story", title: "Story first", sub: "Opens with the problem and why it matters" },
];

const ACTIONS: Record<string, string[]> = {
  grants: ["none", "report", "check_bidprime", "find_grants", "add_link", "add_file", "revise_answer", "restore_answer", "apply", "find_and_apply", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  speaking: ["none", "report", "find_events", "add_link", "add_file", "revise_answer", "restore_answer", "apply", "find_and_apply", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  video: ["none", "report", "find_videos", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  social: ["none", "report", "write_post", "schedule_posts", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  blog: ["none", "report", "write_article", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  website: ["none", "report", "ask_layout", "build_page", "restore_page", "change_page", "plan_page", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  inbox: ["none", "report", "draft_reply", "write_email", "calendar_hold", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  hiring: ["none", "report", "find_people", "write_job_post", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  prospecting: ["none", "report", "find_prospects", "start_outreach", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  outreach: ["none", "report", "start_outreach", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  leads: ["none", "report", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  projects: ["none", "report", "plan_launch", "check_status", "move_launch", "send_report", "capture", "close_item", "start_task", "project_meeting", "write_agenda", "meeting_notes", "set_deadlines", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  coo: ["none", "report", "write_agenda", "schedule_meeting", "meeting_notes", "set_deadlines", "sat_in_notes", "join_or_skip", "send_notes", "check_status", "set_goal", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  custom: ["none", "report", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
};

const ACTION_HELP: Record<string, string> = {
  save_files: "save_files: the person wants the files they attached in this chat kept in the Brain so every employee can use them.",
  add_file: "add_file: the person attached an RFP, call for proposals or opportunity document and wants you to look at it or add it. It is added to Opportunities and scored.",
  revise_answer: "revise_answer: change one answer on an application you wrote. Put words from the question (\"problem\", \"traction\") in `target`, the application's name in `title` ('' for the most recent), what to change in `notes`, and concise or detailed in `to` when they ask for shorter or longer ('' otherwise).",
  restore_answer: "restore_answer: the person wants the answer you just rewrote put back the way it was (\"go back to the old one\").",
  set_deadlines: "set_deadlines: give every action item from a meeting or huddle a due date and make sure each one is a tracked task with its owner (\"assign deadlines from the last meeting\"). Put the meeting's name in `target` ('' for the most recent, huddles included) and any timing the person gave (\"by Friday\", \"next week\") in `notes`.",
  restore_page: "restore_page: the person wants the page you built put back to the version before (\"go back to the last version\"). Put the page's name in `target` ('' for the most recent page).",
  ask_layout: "ask_layout: before building a NEW page, ask the person to pick a layout and where the button goes. In `reply`, say in one or two sentences what you took from what they gave you (attachments included), then ask them to pick a layout.",
  plan_launch: "plan_launch: plan a launch back from its launch date. Put the launch name in `title`, the launch date as YYYY-MM-DD in `date`, and everything the person said about it (goals, targets, who does what) in `notes`.",
  move_launch: "move_launch: move a launch to a new date. Put the launch name in `target` ('' for the next launch) and the new date as YYYY-MM-DD in `date`.",
  send_report: "send_report: write the weekly status report for a launch now. Put the launch name in `target` ('' for the next launch).",
  capture: "capture: write down an idea, risk, blocker or decision so it is never lost (\"new idea: a podcast tour\", \"we decided to drop the webinar\", \"the pricing page is blocked on the logo\"). Put idea, risk, blocker or decision in `target`, the one line in `notes`, and the project's name in `title` ('' for an idea, or for the next launch).",
  close_item: "close_item: a risk, blocker or idea you wrote down is handled or no longer needed. Put words from it in `target`.",
  start_task: "start_task: the person wants an employee to start a project task now (\"have Theo start the launch article\"). Put the task's name in `target`.",
  project_meeting: "project_meeting: set up a meeting about a project (kickoff, check-in, weekly project meeting). Put its name in `title`, the project's name in `notes` ('' for the next launch), the date as YYYY-MM-DD in `date`, the start time like 10:00 AM in `time`, the length in minutes in `count` (15, 30, 45, 60 or 90), who attends (names or emails, '' for everyone) in `attendees`, and \"weekly\" or \"once\" in `to`.",
  write_agenda: "write_agenda: write or rewrite the agenda for an upcoming meeting. Put the meeting name in `target` ('' for the next one) and anything to add or change in `notes`.",
  schedule_meeting: "schedule_meeting: set up a one-time meeting. Put its name in `title`, the date as YYYY-MM-DD in `date`, the start time like 10:00 AM in `time`, the length in minutes in `count` (15, 30, 45, 60 or 90), who attends (names or emails) in `attendees`, and employees whose updates belong on the agenda (names, comma-separated) in `notes`.",
  meeting_notes: "meeting_notes: the person pasted notes from a meeting. Put the meeting name in `target` ('' for the most recent) and the full notes in `message`.",
  sat_in_notes: "sat_in_notes: the person asks about a meeting you sat in on and took notes for (what was decided, who agreed to what). Put the meeting name, company or person in `target` ('' for the most recent) and the question in `message`.",
  join_or_skip: "join_or_skip: the person wants you to skip, or to sit in on, an upcoming meeting on their calendar. Put the meeting name or its start time (like 4:00 PM) in `target`, and \"join\" or \"skip\" in `to`.",
  send_notes: "send_notes: email the notes from a meeting you sat in on. Put the meeting name in `target` ('' for the most recent).",
  set_goal: "set_goal: set a weekly goal on the scorecard. Put one of practices_contacted, demos_booked, reply_minutes, posts_published, articles_published, grant_apps_sent, tasks_on_time, approvals_waiting in `target` and the goal number in `count`.",
  add_guideline: "add_guideline: the person states a standing rule or preference for how you work (\"from now on...\", \"always...\", \"never...\", \"don't...\"). Put the rule as one plain sentence in `notes`, and the Guidelines heading it belongs under in `target` (one of the headings in your Guidelines).",
  start_onboarding: "start_onboarding: the person wants to start, continue or redo your onboarding interview.",
  ask_teammate: "ask_teammate: the person asks you to check with another employee (\"ask Theo what he published\", \"how many demos does Malik have\"). Put that employee's name or job in `teammate` and the question in `message`.",
  find_prospects: "find_prospects: search the web now for businesses (or referral partners) that fit. Put any area, type or size the person gave in `focus`.",
  start_outreach: "start_outreach: pass prospects to outreach so email sequences start. Put a prospect's name in `target`, or '' for every new prospect scoring 70 or higher.",
  write_email: "write_email: the person wants a NEW email sent to someone (not a reply to a pasted message). Put the email address in `to`, the person's name if given in `from`, and everything the email should say or ask, with exact dates and times written out (for example Friday, October 2, 2026 at 3:00 PM), in `message`. It waits for their approval, then sends from their connected Gmail.",
  calendar_hold: "calendar_hold: the person wants a meeting or hold on their calendar. Put a short title in `title`, the date as YYYY-MM-DD in `date`, the start time like 3:00 PM in `time`, attendee emails comma-separated in `attendees`, and the agenda in `notes`. It waits for their approval, then goes on their connected Google Calendar.",
  report: "report: the person (or a scheduled task) asks for a report, summary or update on your work. Put what they want covered in `notes`.",
  find_people: "find_people: search the web for professionals to reach out to for an open role. Put the role or any focus (city, license, specialty) in `focus`.",
  write_job_post: "write_job_post: write or rewrite the job post for a role. Put the role title in `target` ('' for the newest open role).",
  check_bidprime: "check_bidprime: the person asks about BidPrime (their leads inbox, saved bids, \"did you look in BidPrime\", \"check BidPrime\"). You sign in to their BidPrime account with the sign-in saved on Integrations; you never need them to share a login.",
  find_grants: "find_grants: search the web now. Set `oppKind` to grant, pitch (pitch competitions), accelerator (accelerator or incubator programs) or bid (government or agency RFPs and bids); default grant. Put any focus the person gave in `focus`.",
  find_events: "find_events: search the web now. Set `oppKind` to speaking (events taking speaker proposals) or media (press: journalist source requests, podcasts booking guests, reporters covering the topic, op-ed and contributed article openings). Put any focus in `focus`.",
  add_link: "add_link: the person gave a link to an opportunity they found. Put the link in `url`.",
  apply: "apply: start the application for an opportunity already found. Put its name (or 'best' for the best fit not yet started) in `target`.",
  find_and_apply: "find_and_apply: search now, then start applications for the best fits (used by scheduled tasks like a morning search). Set `oppKind` and `focus` as for a search.",
  check_status: "check_status: report what is open, what is waiting for the person, what is submitted, and what is due soon.",
  find_videos: "find_videos: search for current short-form video trends and plan videos. Put any focus in `focus`.",
  write_post: "write_post: write a social post. Put the subject in `topic` and the platforms (linkedin, instagram, facebook, x, threads) in `platforms`; default to linkedin and instagram.",
  schedule_posts: "schedule_posts: the person wants upcoming posts put on the calendar for an account (for example \"schedule the next 12 posts on Facebook\"). Put the one account in `platforms` (facebook, instagram, linkedin, x or threads) and how many posts in `count` (default 8). You suggest the days and time; they confirm with a button.",
  write_article: "write_article: write a blog article. Put the title in `title` and points to cover in `notes`.",
  plan_page: "plan_page: only when the person asks for a plan or outline of a page (not the page itself). Put the page name in `page` and its goal in `goal`.",
  build_page: "build_page: build a landing page or website page as HTML. Put the page name or offer in `page`, the goal in `goal`, `landing` or `website` in `target` (landing unless they say website or a page of their site), the layout they picked in `focus`, where the button goes in `to`, and everything else they told you about the page in `notes`.",
  change_page: "change_page: change a page you already built. Put the page's name in `target` ('' for the most recent page) and exactly what to change in `notes`.",
  draft_reply: "draft_reply: the person pasted a message they received. Put the sender in `from`, the subject in `subject` (make one up from the content if missing) and the full pasted message in `message`.",
};

function decisionSchema(kind: string): JsonSchema {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "action", "focus", "topic", "platforms", "count", "title", "notes", "page", "goal", "from", "subject", "message", "url", "oppKind", "target", "to", "date", "time", "attendees", "teammate", "choices"],
    properties: {
      reply: { type: "string", description: "What you say back. If you are about to do a job, one short sentence saying what you are doing." },
      action: { type: "string", enum: ACTIONS[kind] ?? ["none"] },
      focus: str,
      topic: str,
      platforms: { type: "array", items: { type: "string", enum: ["linkedin", "instagram", "facebook", "x", "threads"] } },
      count: { type: "integer", description: "How many posts, for schedule_posts. 0 otherwise." },
      title: str,
      notes: str,
      page: str,
      goal: str,
      from: str,
      subject: str,
      message: str,
      url: str,
      oppKind: { type: "string", enum: ["", "grant", "pitch", "accelerator", "speaking", "bid", "media"] },
      target: str,
      to: str,
      date: str,
      time: str,
      attendees: str,
      teammate: str,
      choices: { type: "array", items: str, description: "Up to 4 short quick replies the person can tap, written as what they would say. [] when none fit." },
    },
  };
}

type Decision = {
  reply: string;
  action: string;
  focus: string;
  topic: string;
  platforms: ("linkedin" | "instagram" | "facebook" | "x" | "threads")[];
  count?: number;
  title: string;
  notes: string;
  page: string;
  goal: string;
  from: string;
  subject: string;
  message: string;
  url: string;
  oppKind: "" | OppKind;
  target: string;
  to: string;
  date: string;
  time: string;
  attendees: string;
  teammate?: string;
  choices?: string[];
};

function transcript(history: ChatMessage[]) {
  return history
    .slice(-12)
    .map((m) => {
      const files = parseList<{ name: string }>(m.attachments).map((f) => f.name);
      return `${m.role === "user" ? m.authorName : m.role === "handoff" ? `Handoff from ${m.authorName}` : "You"}: ${m.content}${files.length ? ` [attached: ${files.join(", ")}]` : ""}`;
    })
    .join("\n\n");
}

function parseList<T>(raw: string | null | undefined): T[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The files this chat can see: the ones sent with this message, else the latest ones sent here. */
function filesText(files: ChatFile[]) {
  if (!files.length) return "";
  let budget = 40_000;
  const parts = files.map((f) => {
    const take = Math.max(0, Math.min(budget, f.kind === "image" ? 600 : 16_000));
    budget -= take;
    const body = f.kind === "image" ? `Photo. ${f.text || "No description yet."}` : `${f.pages ? `${f.pages} pages. ` : ""}${f.text.slice(0, take) || "(No readable text.)"}`;
    return `--- ${f.name} ---\n${body}`;
  });
  return `\nFiles the person attached in this chat (read them; never repeat a client's name from them):\n${parts.join("\n\n")}`;
}

async function readStored(fileUrl: string) {
  const { uploadsRoot } = await import("../storage");
  const fs = await import("node:fs");
  const path = await import("node:path");
  return fs.promises.readFile(path.join(uploadsRoot(), fileUrl.replace(/^\/files\//, "")));
}

/** What Morgan or Taylor knows about their opportunities and applications, so they can explain scores and revise answers. */
async function applyFacts(emp: AIEmployee) {
  if (emp.kind !== "grants" && emp.kind !== "speaking") return "";
  const kinds = apply.KINDS_FOR[emp.kind === "speaking" ? "speaking" : "grants"];
  const opps = (await db.listOpps(emp.organizationId, kinds)).filter((o) => o.status === "new" || o.status === "applying").sort((a, b) => b.fitScore - a.fitScore).slice(0, 25);
  const apps = (await db.listApplications(emp.organizationId)).filter((a) => a.employeeId === emp.id && !["submitted", "awarded", "declined"].includes(a.status)).slice(0, 8);
  const lines = opps.map((o) => `- ${o.title} (${o.host ?? "host"}): fit ${o.fitScore}, ${o.fitCall}; ${o.amount ?? ""}; due ${o.deadline ?? "not posted"}. Why: ${(o.fitReason ?? o.summary ?? "").slice(0, 300)}${o.eligibility ? ` Eligibility: ${o.eligibility.slice(0, 200)}` : ""}`);
  const appLines = apps.map((a) => `- ${a.title} (${a.status}): questions: ${apply.parse<{ text: string }[]>(a.questions, []).map((q) => q.text.slice(0, 80)).join(" | ")}`);
  return `${lines.length ? `\nOpen opportunities you found (explain a score from these facts only):\n${lines.join("\n")}` : ""}${appLines.length ? `\nApplications in progress:\n${appLines.join("\n")}` : ""}`;
}

/** Simone and Nora see recent meetings, huddles and their action items (and Nora her projects), so they never say they have no notes. */
async function leadershipFacts(emp: AIEmployee) {
  if (emp.kind !== "coo" && emp.kind !== "projects") return "";
  const parts = [await coo.recentMeetingsFacts(emp.organizationId).catch(() => "")];
  if (emp.kind === "projects") parts.push((await projects.projectsStatus(emp.organizationId).catch(() => "")).slice(0, 3000));
  return `\n${parts.filter(Boolean).join("\n")}`;
}

const TALK = `Talk with the person like a colleague, back and forth, not like a form.
- When the request is unclear in a way that would waste real work if you guessed, choose "none", ask one short question in "reply", and put 2 to 4 short fixed answers in "choices".
- Otherwise do the job. After you finish or answer, put up to 4 short next steps the person is likely to want in "choices" (each under 6 words, written as what they would say). Leave "choices" empty when nothing obvious comes next.
- Questions about your work, a result or a score get a plain, specific answer from your facts.`;

const TALK_BY_KIND: Partial<Record<string, string>> = {
  website: `- Before you build a NEW page, if the person has not picked a layout earlier in this conversation, choose ask_layout. When they answer, choose build_page with their layout in "focus" and where the button goes in "to". To change a page you built, choose change_page with exactly what to change.
- When they say a page looks good, say what's left (button link, Approve, Copy HTML) in one sentence.`,
  grants: `- Before a search the person asks for in chat, if they did not say where (a state, a region or nationwide), choose "none" and ask, with choices like "Oklahoma first", "Nationwide", "Both".
- To change an answer on an application, choose revise_answer. After you showed a rewritten answer: "Use this" keeps it (say it's saved), "Make it shorter" is revise_answer with "to" concise, "Go back to the old one" is restore_answer.
- An attached RFP or opportunity file: choose add_file.`,
};
TALK_BY_KIND.speaking = TALK_BY_KIND.grants;

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function worth(n: number, total: number) {
  if (n === 0) return total === 1 ? "It scored under 60, so I marked it Skip. You can still apply from the card." : "None scored 60 or higher, so I marked them Skip. You can still apply to any of them.";
  if (n === total) return total === 1 ? "It is worth applying to." : `All ${n} are worth applying to.`;
  return `${n} ${n === 1 ? "is" : "are"} worth applying to.`;
}

/** Where an action's output lives, so Nora can follow a task's work until it is approved. */
type Ref = projects.WorkRef;
type ActionResult = { text: string; cards: ChatCard[]; queries: string[]; refs?: Ref[]; choices?: string[] };
type RunCtx = { who?: string; files?: ChatFile[]; history?: ChatMessage[] };

async function runAction(emp: AIEmployee, d: Decision, ctx: RunCtx = {}): Promise<ActionResult> {
  const org = emp.organizationId;
  const who = ctx.who ?? "the owner";
  const files = ctx.files ?? [];
  const docText = files.filter((f) => f.kind === "document").map((f) => `${f.name}:\n${f.text.slice(0, 6000)}`).join("\n\n");
  switch (d.action) {
    case "find_grants":
    case "find_events":
    case "find_and_apply": {
      const empKind = emp.kind === "speaking" ? "speaking" : "grants";
      const r = await apply.findOpportunities(org, empKind, { kind: d.oppKind || undefined, focus: d.focus || undefined });
      const best = [...r.created].sort((a, b) => b.fitScore - a.fitScore);
      const top = best.slice(0, 3);
      const cards: ChatCard[] = top.map(oppCard);
      const thing = { grant: "open grant", pitch: "pitch competition", accelerator: "accelerator program", speaking: "event taking proposals", bid: "open bid", media: "media opportunity" }[r.kind];
      let text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and found ${plural(r.created.length, `new ${thing}`)}. ${worth(r.created.filter((o) => o.fitCall === "apply").length, r.created.length)}${r.created.length > 3 ? ` The best 3 are below; the other ${r.created.length - 3} ${r.created.length - 3 === 1 ? "is" : "are"} on Opportunities.` : ""}`
        : `I ran ${plural(r.queries.length, "search", "searches")} and didn't find new ones beyond what's already on Opportunities.`;
      const worthIt = top.filter((o) => o.fitCall !== "skip");
      const choices = worthIt.length ? [`Start ${worthIt[0].title.slice(0, 40)}`, ...(worthIt.length > 1 ? ["Start the top 2"] : []), "Tell me more about each"] : r.created.length ? ["Search somewhere else", "Tell me more about each"] : ["Search nationwide", "Try another focus"];
      if (r.more) text += " There's more out there, so I'm still searching. New finds will show up here as I go.";
      if (d.action === "find_and_apply") {
        const best = r.created.filter((o) => o.fitCall === "apply" && o.fitScore >= 75).sort((a, b) => b.fitScore - a.fitScore).slice(0, 2);
        for (const o of best) await apply.startApplication(org, o.id, null);
        if (best.length) text += ` I started ${best.length === 1 ? "the application for the best fit" : `applications for the ${best.length} best fits`} and will post ${best.length === 1 ? "it" : "each one"} here when it's ready for you.`;
      }
      return { text, cards, queries: r.queries, choices: d.action === "find_and_apply" ? [] : choices };
    }
    case "add_file": {
      const doc = files.find((f) => f.kind === "document");
      if (!doc) return { text: "Attach the RFP or the opportunity's file and I'll read it.", cards: [], queries: [] };
      const o = await apply.addOpportunity(org, emp.kind === "speaking" ? "speaking" : "grants", { file: { name: doc.name, buf: await readStored(doc.fileUrl), mime: doc.mime } }, who);
      const fresh = (await db.getOpp(o.id, org)) ?? o;
      const verdict = fresh.fitCall === "skip" ? "I'd skip it" : fresh.fitCall === "partner" ? "it fits best with a nonprofit partner leading" : "I'd apply";
      return {
        text: `I read ${doc.name}${doc.pages ? ` (${doc.pages} pages)` : ""} and added it to Opportunities. It scores ${fresh.fitScore}, so ${verdict}.${fresh.fitReason ? ` ${fresh.fitReason}` : ""}`,
        cards: [oppCard(fresh)],
        queries: [],
        choices: fresh.fitCall === "skip" ? ["Apply anyway", "Skip it", "Save the file to the Brain"] : ["Start the application", "Save the file to the Brain", "Skip it"],
      };
    }
    case "save_files": {
      const list = files.length ? files : db.recentChatFiles(org, emp.id, 10).slice(0, 10);
      if (!list.length) return { text: "There's nothing attached in this chat yet.", cards: [], queries: [] };
      const { indexKnowledge } = await import("./kb");
      for (const f of list) {
        const item = await db.createKnowledgeItem({ organizationId: org, kind: f.kind === "image" ? "image" : "document", title: f.name.slice(0, 255), category: "mission_profile", content: f.text || (f.kind === "image" ? "" : "(No readable text was found in this file.)"), fileUrl: f.fileUrl, chars: f.text.length });
        indexKnowledge(item);
      }
      return { text: `Saved ${list.length === 1 ? list[0].name : `${list.length} files`} to the Brain, so every employee can use ${list.length === 1 ? "it" : "them"}.`, cards: [], queries: [] };
    }
    case "revise_answer": {
      const apps = (await db.listApplications(org)).filter((a) => a.employeeId === emp.id && !["submitted", "awarded", "declined", "writing"].includes(a.status));
      const tt = d.title.trim().toLowerCase();
      const app = (tt && apps.find((a) => a.title.toLowerCase().includes(tt))) || apps[0];
      if (!app) return { text: "I don't have an application in progress to change.", cards: [], queries: [] };
      const qs = apply.parse<apply.Question[]>(app.questions, []);
      const words = d.target.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const q = qs.find((x) => words.length && words.every((w) => x.text.toLowerCase().includes(w))) ?? qs.find((x) => words.some((w) => x.text.toLowerCase().includes(w)));
      if (!q) return { text: `Which question on ${app.title}? ${qs.map((x) => x.text.slice(0, 60)).join("; ")}`, cards: [], queries: [] };
      const style = d.to === "concise" || d.to === "detailed" ? d.to : undefined;
      const after = await apply.rewriteQuestion(org, app.id, q.id, d.notes || undefined, style);
      const nq = apply.parse<apply.Question[]>(after?.questions, []).find((x) => x.id === q.id) ?? q;
      const count = nq.answer.split(/\s+/).filter(Boolean).length;
      return {
        text: d.reply || `Here's the new answer. I changed what you asked and kept the rest.`,
        cards: [{ type: "answer", id: app.id, call: q.id, title: q.text, subtitle: `${count}${q.maxWords ? ` of ${q.maxWords}` : ""} words`, body: nq.answer, before: q.answer }],
        queries: [],
        choices: ["Use this", "Make it shorter", "Go back to the old one"],
      };
    }
    case "restore_answer": {
      const last = [...(ctx.history ?? [])].reverse().flatMap((m) => parseList<ChatCard>(m.cards)).find((c) => c.type === "answer" && c.call && c.before !== undefined);
      if (!last) return { text: "I don't have an earlier version to put back.", cards: [], queries: [] };
      await apply.saveAnswer(org, last.id, last.call!, last.before ?? "");
      return { text: `I put the old answer to "${last.title.slice(0, 80)}" back.`, cards: [], queries: [] };
    }
    case "restore_page": {
      const list = db.listSitePages(org).filter((x) => x.currentVersion > 1);
      const t = d.target.trim().toLowerCase();
      const p = (t && list.find((x) => x.title.toLowerCase().includes(t))) || list[0];
      if (!p) return { text: "There's no earlier version to go back to.", cards: [], queries: [] };
      const versions = db.listSitePageVersions(p.id, org);
      const prev = versions.find((v) => v.version < p.currentVersion);
      if (!prev) return { text: "There's no earlier version to go back to.", cards: [], queries: [] };
      const back = pages.restoreVersion(org, p.id, prev.version)!;
      return { text: `I put ${p.title} back to how version ${prev.version} looked. It's saved as version ${back.currentVersion}, so nothing is lost.`, cards: [pages.pageCard(back) as ChatCard], queries: [], choices: ["Looks good", "Make a change"] };
    }
    case "ask_layout": {
      return {
        text: d.reply || "Before I build, pick the layout you want.",
        cards: [{ type: "layout_choice", id: Date.now(), title: "Layout", options: LAYOUTS.map((l) => l.title) }],
        queries: [],
        choices: ["Your booking form", "An email to you", "A form on the page"],
      };
    }
    case "check_bidprime": {
      const bids = await import("./bids");
      const v = await bids.bidprimeView(org);
      if (!v.connected) return { text: "BidPrime isn't connected for this workspace yet. Add your BidPrime email and password on Integrations, Applying, BidPrime, and I'll sign in and read your leads inbox and saved bids.", cards: [], queries: [] };
      if (v.checking) {
        const { liveView } = await import("./browser");
        const l = liveView(org);
        return { text: `I'm already in BidPrime as ${v.email} and still working. Watch here, or take over if I look stuck.`, cards: l.id ? [bids.liveCard(l.id, `${emp.name}'s browser`) as ChatCard] : [], queries: [] };
      }
      // Asking again always starts a fresh sign-in, even if an earlier one stopped for a code.
      await bids.clearWaiting(org);
      const liveId = bids.newLiveId();
      bids.queueCheck(org, true, new Date(), liveId);
      const fromBp = (await db.listOpps(org, ["bid"])).filter((o) => o.source === "BidPrime" && o.status === "new");
      const last = v.lastError ? ` My last check stopped: ${v.lastError}.` : "";
      return {
        text: `Signing in to BidPrime as ${v.email} now to read your leads inbox and saved bids. You can watch here and take over any time.${last}`,
        cards: [bids.liveCard(liveId, `${emp.name}'s browser`) as ChatCard],
        queries: [],
      };
    }
    case "add_link": {
      if (!/\S+\.\S+/.test(d.url)) return { text: "Send me the link to the opportunity's page and I'll add it.", cards: [], queries: [] };
      const o = await apply.addOpportunity(org, emp.kind === "speaking" ? "speaking" : "grants", { url: d.url }, "Chat");
      return { text: `I added ${o.title} and I'm downloading the host's package now.`, cards: [oppCard(o)], queries: [] };
    }
    case "apply": {
      const kinds = apply.KINDS_FOR[emp.kind === "speaking" ? "speaking" : "grants"];
      const open = (await db.listOpps(org, kinds)).filter((o) => o.status === "new");
      const t = d.target.trim().toLowerCase();
      const pick =
        t && t !== "best"
          ? open.find((o) => o.title.toLowerCase().includes(t) || t.includes(o.title.toLowerCase())) ?? open.find((o) => t.split(/\s+/).filter((w) => w.length > 3).every((w) => o.title.toLowerCase().includes(w)))
          : open.filter((o) => o.fitCall !== "skip").sort((a, b) => b.fitScore - a.fitScore)[0];
      if (!pick) return { text: "I couldn't find that one on Opportunities. Tell me its name, or ask me to search first.", cards: [], queries: [] };
      const app = await apply.startApplication(org, pick.id, null);
      return { text: `I'm writing the ${pick.title} application now. I'll post it here when it's ready for you.`, cards: [apply.applicationCard(app, pick) as ChatCard], queries: [], refs: [{ kind: "application", id: app.id }] };
    }
    case "report": {
      const text = await writeReport(emp, d.notes || d.reply || "Send me a report.");
      return { text, cards: [], queries: [] };
    }
    case "find_people": {
      const r = await hiring.findProspects(org, { focus: d.focus || undefined });
      const best = [...r.created].sort((a, b) => b.fitScore - a.fitScore);
      const text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and found ${plural(r.created.length, "person", "people")} with public work profiles that fit${r.role ? ` the ${r.role.title} role` : ""}. ${best.length > 2 ? "The best 2 are below. The rest are on Outreach with a message drafted for each." : "Messages are drafted on Outreach."}`
        : `I ran ${plural(r.queries.length, "search", "searches")} and didn't find anyone new. Try a nearby city or another license type.`;
      return { text, cards: best.slice(0, 2).map((p) => hiring.personCard(p) as ChatCard), queries: r.queries };
    }
    case "write_job_post": {
      const roles = (await db.listHrRoles(org)).filter((r) => r.status === "open");
      const t = d.target.trim().toLowerCase();
      const role = (t && roles.find((r) => r.title.toLowerCase().includes(t))) || roles[0];
      if (!role) return { text: "Add the role first on Hiring, then Roles, and I'll write the post.", cards: [], queries: [] };
      await hiring.writeJobPost(org, role.id);
      return { text: `The ${role.title} post is written. It's on Hiring, then Roles, with the places to post it.`, cards: [], queries: [] };
    }
    case "add_guideline": {
      const r = await interview.addGuideline(emp, d.target, d.notes || d.message);
      return { text: `Got it. I added that to my Guidelines under "${r.section}".`, cards: [], queries: [] };
    }
    case "start_onboarding": {
      if (interview.readState(emp).done) await interview.redo(emp);
      return { text: "", cards: [interview.onboardingCard(emp) as ChatCard], queries: [] };
    }
    case "ask_teammate": {
      const answer = await askTeammate(emp, d.teammate || d.target || "", d.message || d.reply);
      return { text: answer ?? "That's me. What would you like to know?", cards: [], queries: [] };
    }
    case "find_prospects": {
      const r = await sales.findProspects(org, { focus: d.focus || undefined });
      const top = (await Promise.all(r.created.slice(0, 2).map((p) => db.getProspect(p.id, org)))).filter((p): p is NonNullable<typeof p> => !!p);
      const text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and found ${plural(r.created.length, "new prospect")}. ${r.good} scored 70 or higher${r.passed ? ` and I passed ${r.passed === 1 ? "it" : "them"} to Jada` : ""}. ${top.length ? "The best are below; all of them are on Prospects with what I found about each." : ""}`.trim()
        : `I ran ${plural(r.queries.length, "search", "searches")} and didn't find new ones beyond what's already on Prospects. Try another area or type.`;
      return { text, cards: top.map((p) => sales.prospectCard(p) as ChatCard), queries: r.queries };
    }
    case "start_outreach": {
      const ps = (await db.listProspects(org)).filter((p) => p.stage === "new");
      const t = d.target.trim().toLowerCase();
      const pick = t ? ps.filter((p) => p.name.toLowerCase().includes(t) || t.includes(p.name.toLowerCase())) : ps.filter((p) => p.fitScore >= 70);
      const withEmail = pick.filter((p) => p.email);
      if (!withEmail.length) return { text: pick.length ? "Riley didn't find an email for those. Add one on Prospects and I'll start." : "There are no new prospects to start. Ask Riley to find some.", cards: [], queries: [] };
      await sales.passToOutreach(org, withEmail.map((p) => p.id));
      return { text: `Starting email sequences for ${plural(withEmail.length, "prospect")}. They'll be on the Outreach tab in a minute.`, cards: [], queries: [] };
    }
    case "plan_launch": {
      const r = await projects.planLaunch(org, { name: d.title || undefined, date: d.date, brief: [d.notes, d.message].filter(Boolean).join("\n") || d.reply });
      const counts = await projects.planCounts(org, r.launch.id);
      const text = r.auto
        ? `I planned ${r.launch.name} with ${plural(counts.milestones, "milestone")} and ${plural(counts.tasks, "task")}, and started it${r.launch.clickupListId ? " in ClickUp" : ""}. I'll check it every morning.`
        : `I worked back from the launch date and built ${plural(counts.milestones, "milestone")} and ${plural(counts.tasks, "task")} with ${plural(counts.owners, "owner")}. Once you approve, ${(await db.getConnectionByProvider(org, "clickup"))?.status === "connected" ? "I'll create the list in ClickUp and " : "I'll "}check it every morning.`;
      return { text, cards: [projects.planCard(r.launch, counts) as ChatCard], queries: [] };
    }
    case "move_launch": {
      const l = await projects.findLaunch(org, d.target);
      if (!l) return { text: "There's no launch to move yet.", cards: [], queries: [] };
      const r = await projects.moveLaunch(org, l.id, d.date);
      return { text: `I moved ${r.launch.name} ${Math.abs(r.days)} day${Math.abs(r.days) === 1 ? "" : "s"} ${r.days >= 0 ? "later" : "earlier"} and shifted ${plural(r.moved, "open task")} with it${r.launch.clickupListId ? " in ClickUp too" : ""}.`, cards: [], queries: [] };
    }
    case "send_report": {
      const l = await projects.findLaunch(org, d.target);
      if (!l || l.status !== "active") return { text: "There's no active launch to report on yet.", cards: [], queries: [] };
      const r = await projects.weeklyReport(org, l.id);
      const b = JSON.parse(r.body);
      return { text: `Week ${r.week} of ${r.weeks}: ${r.status === "behind" ? "behind" : "on track"}. ${b.overall} The full report is on Launches, Reports.`, cards: [], queries: [] };
    }
    case "write_agenda": {
      await coo.ensureMeetings(org);
      const m = await coo.nextMeetingFor(org, d.target, emp.kind === "projects" ? "project" : "all");
      if (!m) return { text: emp.kind === "projects" ? "There's no project meeting coming up. Ask me to set one up." : "There's no meeting coming up. Add a repeating meeting on my Onboarding tab or ask me to schedule one.", cards: [], queries: [] };
      let next = await coo.buildAgenda(org, m.id);
      if (d.notes.trim()) {
        const items = JSON.parse(next.agenda || "[]") as coo.AgendaItem[];
        const extra = { item: d.notes.trim().slice(0, 160), who: "", minutes: 5 };
        next = await coo.editMeeting(org, m.id, { agenda: [...items.slice(0, -1), extra, ...items.slice(-1)], minutes: next.minutes });
      }
      if (emp.kind === "projects" && next.status !== "invited" && gate(emp, "meetings") === "auto") {
        const sent = await coo.sendInvite(org, next.id, `${emp.name} (on her own)`).catch((err) => err instanceof Error ? err.message : String(err));
        if (typeof sent === "string") return { text: `Here's the agenda for ${next.title}. I couldn't send it: ${sent}`, cards: [coo.meetingCard(next) as ChatCard], queries: [] };
        return { text: `Here's the agenda for ${next.title}. I sent it to everyone attending with the meeting link.`, cards: [coo.meetingCard(sent) as ChatCard], queries: [] };
      }
      return { text: `Here's the agenda for ${next.title}.${next.status === "invited" ? " The invite already went out, so I updated the calendar event." : " Press Send invite and it goes out with the meeting link."}`, cards: [coo.meetingCard(next) as ChatCard], queries: [] };
    }
    case "schedule_meeting": {
      const emps = await db.listEmployeesByOrg(org);
      const ups = emps.filter((e) => d.notes.toLowerCase().includes(e.name.toLowerCase())).map((e) => e.kind);
      const m = await coo.scheduleMeeting(org, { title: d.title || "Meeting", date: d.date, time: d.time, minutes: Number(d.count) || 30, attendees: d.attendees, updatesFrom: ups });
      return { text: `I set up ${m.title} and wrote the agenda. Press Send invite and it goes out with the meeting link.`, cards: [coo.meetingCard(m) as ChatCard], queries: [] };
    }
    case "meeting_notes": {
      const m = await coo.lastMeetingFor(org, d.target, emp.kind === "projects" ? "project" : "all");
      if (!m) return { text: "I don't have a past meeting to attach these to yet.", cards: [], queries: [] };
      const r = await coo.saveNotes(org, m.id, d.message || d.notes);
      const items = JSON.parse(r.actionItems || "[]") as coo.ActionItem[];
      const sent = items.some((i) => i.status === "in_clickup" || i.status === "task");
      return { text: `I found ${plural(items.length, "action item")} in your notes from ${m.title}${items.length ? `: ${items.map((i) => `${i.text} (${i.owner})`).join("; ")}` : ""}.${sent ? (emp.kind === "projects" ? " I added them to the launch plan and I'll track each one." : " Nora added them to the launch plan.") : ""}`, cards: [], queries: [] };
    }
    case "set_deadlines": {
      const m = await coo.lastMeetingFor(org, d.target, emp.kind === "projects" ? "project" : "all");
      if (!m) return { text: "I don't have a past meeting or huddle with action items yet.", cards: [], queries: [] };
      const items = await coo.setDeadlines(org, m.id, d.notes);
      if (!items.length) return { text: `${m.title} has no action items to date.`, cards: [], queries: [] };
      const day = (ymd?: string) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "no date");
      return {
        text: `Done. Every action item from ${m.title} has an owner and a due date, and I let each employee know theirs:\n${items.map((i) => `- ${i.text} (${i.owner}, due ${day(i.due)})`).join("\n")}\nNora is tracking them as tasks and will chase anything that slips.`,
        cards: [],
        queries: [],
        choices: ["Move a date", "Send the recap", "Looks good"],
      };
    }
    case "capture": {
      const kind = (["idea", "risk", "blocker", "decision"] as const).find((k) => d.target.trim().toLowerCase().startsWith(k)) ?? "idea";
      const r = await projects.addNote(org, { kind, text: d.notes || d.message || d.reply, project: d.title, who });
      const where = r.launch ? ` on ${r.launch.name}` : "";
      const said = { idea: "Saved the idea. Say the word when you want me to plan it.", risk: `Logged that risk${where}. I'll track it until it's handled.`, blocker: `Logged that blocker${where}. I'll push to clear it and keep it on the agenda until it is.`, decision: `Recorded that decision${where}.` }[kind];
      return { text: said, cards: [], queries: [] };
    }
    case "close_item": {
      const n = await projects.closeNote(org, d.target || d.notes);
      return { text: n ? `Closed: ${n.text}` : "I couldn't find an open item like that.", cards: [], queries: [] };
    }
    case "start_task": {
      const r = await projects.startTaskByName(org, d.target);
      return { text: r.started && r.task ? `${r.task.ownerName} is starting "${r.task.title}" now. I'll check it when it's done.` : r.why, cards: [], queries: [] };
    }
    case "project_meeting": {
      const m = await coo.scheduleProjectMeeting(org, { title: d.title || "Project meeting", project: d.notes, date: d.date, time: d.time, minutes: Number(d.count) || 30, attendees: d.attendees, weekly: d.to.trim().toLowerCase() === "weekly" });
      const auto = gate(emp, "meetings") === "auto";
      const sent = auto ? await coo.sendInvite(org, m.id, `${emp.name} (on her own)`).catch((err) => err instanceof Error ? err.message : String(err)) : null;
      const repeat = d.to.trim().toLowerCase() === "weekly" ? " It repeats every week, and I'll write each agenda from where the project stands." : "";
      if (typeof sent === "string") return { text: `I set up ${m.title} and wrote the agenda, but couldn't send it: ${sent}${repeat}`, cards: [coo.meetingCard(m) as ChatCard], queries: [] };
      return { text: sent ? `I set up ${m.title}, wrote the agenda and sent it with the meeting link.${repeat}` : `I set up ${m.title} and wrote the agenda. Press Send invite and it goes out with the meeting link.${repeat}`, cards: [coo.meetingCard(sent ?? m) as ChatCard], queries: [] };
    }
    case "sat_in_notes": {
      const r = await notetaker.findMeeting(org, d.target, "notes");
      if (!r) return { text: "I don't have notes from a meeting like that yet. I only have notes from meetings I sat in on.", cards: [], queries: [] };
      const tz = (await db.getOrganizationById(org))?.timezone || "America/Chicago";
      const { system } = await tasks.systemPromptFor(emp, "Answer the question from these meeting notes only, in 1 to 3 plain sentences. If the notes don't say, say so.");
      const answer = await generateText({ system, prompt: `Notes:\n${notetaker.notesText(r, tz)}\n\nQuestion: ${d.message || "What happened in this meeting?"}`, maxTokens: 400 });
      return { text: answer.trim(), cards: [notetaker.notesCard(r) as ChatCard], queries: [] };
    }
    case "join_or_skip": {
      const r = await notetaker.findMeeting(org, d.target, "upcoming");
      if (!r) return { text: "I couldn't find that meeting among the ones with a Zoom or Google Meet link in the next two days.", cards: [], queries: [] };
      const choice = d.to.trim().toLowerCase() === "join" ? "join" : "skip";
      const next = await notetaker.setChoice(org, r.id, choice);
      return { text: choice === "join" ? (next.status === "scheduled" ? `I'll sit in on ${r.title}.` : `I'll sit in on ${r.title} once it's close enough to book.`) : `I'll skip ${r.title}.`, cards: [], queries: [] };
    }
    case "send_notes": {
      const r = await notetaker.findMeeting(org, d.target, "notes");
      if (!r) return { text: "I don't have finished notes from a meeting like that yet.", cards: [], queries: [] };
      const members = await db.listMembers(org);
      const owner = members.find((m) => m.role === "owner") ?? members[0];
      await notetaker.sendRecap(org, r.id, { name: owner?.name || owner?.email || "Owner", email: owner?.email ?? "" });
      return { text: `I emailed the notes from ${r.title}.`, cards: [], queries: [] };
    }
    case "set_goal": {
      const row = await coo.setGoal(org, d.target, Number.isFinite(Number(d.count)) ? Number(d.count) : null);
      return { text: `The weekly goal for ${row.label.toLowerCase()} is now ${d.count}${row.unit}.`, cards: [], queries: [] };
    }
    case "check_status": {
      if (emp.kind === "projects") return { text: await projects.projectsStatus(org), cards: [], queries: [] };
      if (emp.kind === "coo") return { text: await coo.cooStatus(org), cards: [], queries: [] };
      if (emp.kind === "prospecting" || emp.kind === "outreach" || emp.kind === "leads") return { text: await sales.salesStatus(org, emp.kind), cards: [], queries: [] };
      if (emp.kind === "hiring") {
        const facts = await hiring.hiringFacts(org);
        const fresh = (await db.listHrPeople(org, "applicant")).filter((p) => p.stage === "new").slice(0, 3);
        return { text: facts.split("\n").join(". ") + ".", cards: fresh.map((p) => hiring.personCard(p) as ChatCard), queries: [] };
      }
      const apps = (await db.listApplications(org)).filter((a) => a.employeeId === emp.id);
      const by = (st: string[]) => apps.filter((a) => st.includes(a.status));
      const waiting = by(["ready", "needs_answer", "needs_setup"]);
      const lines = [
        `${plural(by(["writing"]).length, "application")} being written`,
        `${waiting.length} waiting for you`,
        `${by(["approved"]).length} approved to send`,
        `${by(["submitted"]).length} submitted`,
        `${by(["awarded"]).length} won`,
      ];
      return { text: `Here's where things stand: ${lines.join(", ")}.`, cards: waiting.slice(0, 4).map((a) => apply.applicationCard(a, null) as ChatCard), queries: [] };
    }
    case "find_videos": {
      const r = await tasks.findVideoIdeas(org, d.focus || undefined);
      const cards: ChatCard[] = r.created.map((v) => {
        const data = JSON.parse(v.data || "{}");
        return {
          type: "video",
          id: v.id,
          title: v.title,
          subtitle: [data.plan?.platform, data.plan?.lengthSeconds && `${data.plan.lengthSeconds} seconds`].filter(Boolean).join(" · "),
          body: data.plan?.hook ? `Hook: ${data.plan.hook}` : "",
          url: v.sourceUrl,
        };
      });
      const text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and planned ${plural(r.created.length, "video")} from formats working right now. Shot lists and scripts are on the Videos tab.`
        : `I ran ${plural(r.queries.length, "search", "searches")} but couldn't build a plan with a source I trust. Try giving me a topic.`;
      return { text, cards, queries: r.queries };
    }
    case "write_post": {
      const platforms = d.platforms?.length ? d.platforms : (["linkedin", "instagram"] as Decision["platforms"]);
      const p = await tasks.writeSocialPost(org, { topic: d.topic || d.reply, targetPlatforms: platforms, tone: "thought_leadership", generateImageFlag: true });
      const meta = JSON.parse(p.metadata || "{}");
      return {
        text: `Here's a post for ${platforms.join(", ")}. It's waiting for your approval.${meta.imageError ? " I couldn't make the image: " + meta.imageError : ""}`,
        cards: [{ type: "post", id: p.id, title: p.title, body: (p.body ?? "").slice(0, 280), imageUrl: p.imageUrl }],
        queries: [],
      };
    }
    case "schedule_posts": {
      const channel = d.platforms?.[0] ?? "facebook";
      const count = Math.max(1, Math.min(30, Number(d.count) || 8));
      const plan = await planSchedule(org, channel, count);
      const name = channelName(channel);
      if (plan.rows.length === 0) return { text: `I couldn't find open days for ${name} posts. Check the calendar on my Work tab.`, cards: [], queries: [] };
      const waiting = plan.rows.filter((r) => r.needsApproval).length;
      const parts = [
        `I suggest ${plan.label.replace(/^Every weekday/, "every weekday")}. ${plan.reason}`,
        plan.written ? `I wrote ${plural(plan.written, "new draft")} to fill the plan; ${plan.written === 1 ? "its image is" : "their images are"} on the way.` : "",
        waiting ? `${waiting} of these ${plan.rows.length} still need your approval; they post only after you approve them.` : `All ${plan.rows.length} are approved and post on their own once scheduled.`,
      ];
      return { text: parts.filter(Boolean).join(" "), cards: [{ type: "schedule_plan", id: Date.now(), title: `${plural(plan.rows.length, `${name} post`)}${plan.account ? ` · ${plan.account}` : ""}`, plan }], queries: [] };
    }
    case "write_article": {
      const a = await tasks.writeBlogArticle(org, { title: d.title || d.topic || "Untitled article", category: "Practice insights", outlineNotes: [d.notes, docText].filter(Boolean).join("\n\n") || undefined, generateBannerFlag: true });
      return {
        text: "The article is drafted and waiting for your approval. The full text is on the Articles tab.",
        cards: [{ type: "article", id: a.id, title: a.title, body: (a.body ?? "").replace(/[#*_>]/g, "").slice(0, 280), imageUrl: a.imageUrl }],
        queries: [],
      };
    }
    case "build_page": {
      const photos = files.filter((f) => f.kind === "image").map((f) => ({ url: pages.publicLink(org, f.fileUrl), text: f.text, name: f.name }));
      const p = await pages.startPage(org, { title: d.page || d.topic || "New page", pageType: /website/i.test(d.target) ? "website" : "landing", goal: d.goal || "Book a call" }, { layout: d.focus, button: d.to, notes: [d.notes, docText].filter(Boolean).join("\n\n"), photos });
      return { text: d.reply || `Building the ${p.title} page now. It takes a couple of minutes, and I'll show it to you right here.`, cards: [], queries: [], refs: [{ kind: "page", id: p.id }] };
    }
    case "change_page": {
      const list = db.listSitePages(org).filter((x) => x.currentVersion > 0);
      const t = d.target.trim().toLowerCase();
      const p = (t && list.find((x) => x.title.toLowerCase().includes(t))) || list[0];
      if (!p) return { text: "I haven't built a page yet. Tell me the offer and the goal and I'll build one.", cards: [], queries: [] };
      const extra = files.filter((f) => f.kind === "image").map((f) => `Use this attached photo: ${pages.publicLink(org, f.fileUrl)} (${f.text || f.name})`).join("\n");
      await pages.revisePage(org, p.id, [d.notes || d.message || d.reply, extra, docText].filter(Boolean).join("\n\n"));
      return { text: `Making those changes to ${p.title} now. The new version will show up here when it's ready.`, cards: [], queries: [], refs: [{ kind: "page", id: p.id }] };
    }
    case "plan_page": {
      const item = await tasks.planWebsitePage(org, d.page || d.topic || "New page", d.goal || "Book a consultation");
      const data = JSON.parse(item.data || "{}");
      return {
        text: `Here's the plan for the ${item.title} page, section by section. It's on the Pages tab with the copy for each section.`,
        cards: [{ type: "page", id: item.id, title: item.title, subtitle: data.suggestedPath ?? "", body: `${(data.sections ?? []).length} sections · ${data.callToAction ?? ""}` }],
        queries: [],
      };
    }
    case "write_email": {
      const to = (d.to.match(/[^\s<>"',;]+@[^\s<>"',;]+\.[a-z]{2,}/i) ?? [])[0];
      if (!to) return { text: "Who should it go to? Send me their email address.", cards: [], queries: [] };
      let o = await tasks.composeEmail(org, { to, toName: d.from || undefined, purpose: d.message || d.reply });
      const live = (await db.getConnectionByProvider(org, "google_workspace"))?.status === "connected";
      await db.updateOutboundItem(o.id, org, { metadata: JSON.stringify({ ...JSON.parse(o.metadata || "{}"), rule: "new_email" }) });
      if (live && gate(emp, "new_email") === "auto") {
        o = (await postNow((await db.getOutboundItemForOrg(o.id, org))!, `${emp.name} (on its own)`, "system", "Sent an email", { approvedBy: `${emp.name} (on its own)`, approvedAt: new Date() }))!;
        return { text: o.status === "published" ? `I sent the email to ${to} from your Gmail.` : `I tried to send it to ${to}, but it did not go out. It's in Approvals with the reason.`, cards: [{ type: "reply", id: o.id, title: o.title, subtitle: `To ${to}`, body: (o.body ?? "").slice(0, 280) }], queries: [] };
      }
      return {
        text: live ? `The email to ${to} is ready. Press Send in Approvals and it goes out from your Gmail.` : `The email to ${to} is ready in Approvals. Connect Google on Integrations and Send will mail it from your Gmail.`,
        cards: [{ type: "reply", id: o.id, title: o.title, subtitle: `To ${to}`, body: (o.body ?? "").slice(0, 280) }],
        queries: [],
      };
    }
    case "calendar_hold": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { text: "What day should it go on? Tell me the date and time.", cards: [], queries: [] };
      const h = await tasks.createCalendarHold(org, { title: d.title || "Meeting", date: d.date, time: d.time || "9:00 AM", attendees: d.attendees || "", agenda: d.notes || "" });
      const when = new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return {
        text: `The hold is ready for ${when} at ${d.time || "9:00 AM"}. Press Add in Approvals and it goes on your Google Calendar.`,
        cards: [{ type: "reply", id: h.id, title: h.title, subtitle: `${when} at ${d.time || "9:00 AM"}`, body: d.attendees ? `With ${d.attendees}` : "" }],
        queries: [],
      };
    }
    case "draft_reply": {
      if (!d.message.trim() && docText) d.message = docText;
      if (!d.message.trim()) return { text: "Paste the message you got and I'll draft the reply.", cards: [], queries: [] };
      const o = await tasks.draftEmailReply(org, { subject: d.subject || "Your message", recipient: d.from || "Sender", context: d.message });
      const meta = JSON.parse(o.metadata || "{}");
      return {
        text: `${meta.whatTheyWant ? meta.whatTheyWant + " " : ""}The reply is drafted and waiting for your approval.`,
        cards: [{ type: "reply", id: o.id, title: o.title, subtitle: meta.urgency === "today" ? "Reply today" : meta.urgency === "this_week" ? "Reply this week" : "No rush", body: (o.body ?? "").slice(0, 280) }],
        queries: [],
      };
    }
    default:
      return { text: "", cards: [], queries: [] };
  }
}

/** Actions that only talk about the work; a project task needs one that does it. */
const NOT_WORK = new Set(["none", "report", "check_status", "ask_teammate", "add_guideline", "start_onboarding", "close_item", "sat_in_notes", "join_or_skip", "save_files", "add_file", "restore_answer", "ask_layout", "restore_page"]);

/**
 * An employee does a project task Nora assigned, with the same actions their
 * chat uses. The result posts in their chat. "none" means no action of theirs
 * can do it, and `text` says what a person needs to do instead.
 */
export async function doTask(emp: AIEmployee, task: { title: string; details: string; doneWhen: string; project: string; due: string; feedback: string; from: string }) {
  const actions = (ACTIONS[emp.kind] ?? []).filter((a) => !NOT_WORK.has(a));
  if (!actions.length) return { action: "none", text: "", cards: [] as ChatCard[], refs: [] as Ref[] };
  const request = `Task: ${task.title}${task.details ? `\nDetails: ${task.details}` : ""}${task.doneWhen ? `\nDone when: ${task.doneWhen}` : ""}\nProject: ${task.project}\nDue: ${task.due}${task.feedback ? `\nSent back because: ${task.feedback}. Fix exactly that.` : ""}`;
  const { system } = await tasks.systemPromptAbout(
    emp,
    `${task.title} ${task.details}`,
    `${task.from}, your project manager, assigned you a task on the ${task.project} project. Do it now: choose the action that produces what the task asks for and fill its fields so the result meets "Done when". Put everything the task says into the fields (topic, title, notes, goal, focus).
Right now it is ${await nowIn(emp.organizationId)}.
If none of your actions can produce it, choose "none" and say in "reply", in one sentence, what a person needs to do instead.
Fill every field; use "" or [] for fields the action does not use.
Actions you can take:
${actions.map((a) => "- " + ACTION_HELP[a]).join("\n")}`
  );
  const decision = await generateJson<Decision>({ system, prompt: request, schemaName: "chat_decision", schema: decisionSchema(emp.kind), maxTokens: 2000 });
  if (!decision?.action || !actions.includes(decision.action)) return { action: "none", text: decision?.reply ?? "", cards: [] as ChatCard[], refs: [] as Ref[] };
  const result = await runAction(emp, decision, { who: task.from });
  const refs: Ref[] = [...(result.refs ?? []), ...result.cards.filter((c) => c.type === "post" || c.type === "article" || c.type === "reply").map((c) => ({ kind: "outbound" as const, id: c.id }))];
  const text = result.text || decision.reply;
  await db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `For ${task.project}, "${task.title}": ${text}`, cards: result.cards.length ? JSON.stringify(result.cards) : null, searchQueries: result.queries.length ? JSON.stringify(result.queries) : null });
  return { action: decision.action, text, cards: result.cards, refs };
}

function oppCard(o: Opportunity): ChatCard {
  return apply.oppCardFor(o);
}

/** What an employee is doing right now in the background, for the "working" line in chat. */
export async function workingOn(orgId: number, emp: AIEmployee): Promise<{ busy: boolean; what: string }> {
  if (emp.kind === "grants") {
    const bids = await import("./bids");
    const { liveView } = await import("./browser");
    const v = await bids.bidprimeView(orgId);
    const l = liveView(orgId);
    if (l.state === "waiting") return { busy: true, what: "Waiting for you to take over the browser" };
    if (l.state === "control") return { busy: true, what: "Paused while you have the browser" };
    if (l.state === "starting" || l.state === "running") return { busy: true, what: l.step || "Opening the browser" };
    if (v.connected && v.checking) return { busy: true, what: "Reading BidPrime" };
  }
  const kinds = apply.KINDS_FOR[emp.kind === "speaking" ? "speaking" : "grants"];
  if (emp.kind === "grants" || emp.kind === "speaking") {
    const looking = apply.stillLooking(orgId, emp.kind === "speaking" ? "speaking" : "grants");
    if (looking) return { busy: true, what: looking };
    const writing = (await db.listApplications(orgId)).find((a) => a.employeeId === emp.id && a.status === "writing");
    if (writing) return { busy: true, what: `${writing.progress || "Writing"}: ${writing.title}` };
    const fetching = (await db.listOpps(orgId, kinds)).find((o) => o.packageStatus === "fetching");
    if (fetching) return { busy: true, what: `Downloading and reading the documents for ${fetching.title}` };
  }
  if (emp.kind === "website") {
    const building = db.listSitePages(orgId).find((p) => p.status === "building");
    if (building) return { busy: true, what: `${building.progress || "Building"}: ${building.title}` };
  }
  if (emp.status === "working") return { busy: true, what: "Working on your request" };
  return { busy: false, what: "" };
}

/** What Morgan knows about the BidPrime connection, so she answers from it instead of guessing. */
async function bidprimeFacts(emp: AIEmployee) {
  if (emp.kind !== "grants") return "";
  const v = await (await import("./bids")).bidprimeView(emp.organizationId);
  if (!v.connected) return "\nBidPrime: not connected for this workspace.";
  const when = v.lastCheckedAt ? `last read ${new Date(v.lastCheckedAt).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })}, ${v.lastFound} new` : "not read yet";
  return `\nBidPrime: connected as ${v.email}; ${when}${v.lastError ? `; last check stopped: ${v.lastError}` : ""}${v.waitingCode ? "; waiting for a sign-in code" : ""}. You can sign in and read it any time with check_bidprime.`;
}

async function nowIn(orgId: number) {
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  const d = new Date();
  const local = d.toLocaleString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const iso = d.toLocaleDateString("en-CA", { timeZone: tz });
  return `${local} (${iso}, ${tz})`;
}

export async function sendChatMessage(opts: {
  organizationId: number;
  employeeId: number;
  text: string;
  authorName: string;
  userId: number | null;
  attachmentIds?: number[];
}) {
  const emp = await db.getEmployeeForOrg(opts.employeeId, opts.organizationId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  // Only this chat's own unsent files can go with the message.
  const sent = db.getChatFiles(opts.organizationId, (opts.attachmentIds ?? []).slice(0, 10)).filter((f) => f.employeeId === emp.id && f.messageId == null);
  if (!opts.text.trim() && !sent.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Type a message or attach a file." });

  const userMsg = await db.createChatMessage({
    organizationId: opts.organizationId,
    employeeId: emp.id,
    role: "user",
    authorName: opts.authorName,
    userId: opts.userId,
    content: opts.text,
    attachments: sent.length ? JSON.stringify(sent.map((f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, url: f.fileUrl }))) : null,
  });
  db.attachChatFiles(opts.organizationId, sent.map((f) => f.id), userMsg.id);

  const reply = async (content: string, cards: ChatCard[] = [], queries: string[] = []) =>
    db.createChatMessage({
      organizationId: opts.organizationId,
      employeeId: emp.id,
      role: "employee",
      authorName: emp.name,
      content,
      cards: cards.length ? JSON.stringify(cards) : null,
      searchQueries: queries.length ? JSON.stringify(queries) : null,
    });

  if (emp.status === "paused") {
    return { user: userMsg, reply: await reply(`I'm paused right now. Press Resume at the top and send that again.`) };
  }

  try {
    const history = await db.listChatMessages(opts.organizationId, emp.id, 30);
    const actions = (ACTIONS[emp.kind] ?? ["none"]).filter((a) => a !== "none");
    // The files this message can use: the ones sent with it, else the latest ones sent in this chat.
    const recentIds = new Set(history.slice(-12).map((m) => m.id));
    const files = sent.length ? sent : db.recentChatFiles(opts.organizationId, emp.id, 6).filter((f) => f.messageId != null && recentIds.has(f.messageId)).slice(0, 4);
    const scheduled = /^Scheduled task/.test(opts.authorName);
    const said = opts.text.trim() || `(attached ${sent.map((f) => f.name).join(", ")})`;
    const { system } = await tasks.systemPromptAbout(
      emp,
      `${opts.text} ${sent.map((f) => f.name).join(" ")}`,
      `You are chatting with ${opts.authorName}. Answer questions about your work directly and briefly.
Right now it is ${await nowIn(opts.organizationId)}. Turn words like "today", "tomorrow" or "Friday" into exact dates.
When the message asks you to do your job now, choose the matching action and fill its fields. Otherwise choose "none" and answer in "reply".
Fill every field; use "" or [] for fields the action does not use.
Never ask the person for a password or login in chat; sign-ins are saved on Integrations.${await bidprimeFacts(emp)}${await applyFacts(emp)}${await leadershipFacts(emp)}
${scheduled ? "This message comes from a scheduled task: never ask a question and leave choices empty; do the job." : `${TALK}${TALK_BY_KIND[emp.kind] ? `\n${TALK_BY_KIND[emp.kind]}` : ""}`}${filesText(files)}
Actions you can take:
${actions.map((a) => "- " + ACTION_HELP[a]).join("\n") || "- none"}`
    );
    const decision = await generateJson<Decision>({
      system,
      prompt: `Conversation so far:\n${transcript(history.slice(0, -1))}\n\n${opts.authorName}: ${said}`,
      schemaName: "chat_decision",
      schema: decisionSchema(emp.kind),
      maxTokens: 2000,
    });
    const quick = (list?: string[]) => (!scheduled && list?.length ? [choicesCard(list)] : []);

    if (!decision.action || decision.action === "none" || !actions.includes(decision.action)) {
      return { user: userMsg, reply: await reply(decision.reply || "Could you say a bit more about what you need?", quick(decision.choices)) };
    }
    const result = await runAction(emp, decision, { who: opts.authorName, files: sent.length ? sent : files, history });
    const cards = [...result.cards, ...quick(result.choices ?? decision.choices)];
    return { user: userMsg, reply: await reply(result.text || decision.reply, cards, result.queries) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] ${emp.name} failed:`, message);
    return { user: userMsg, reply: await reply(`I couldn't do that. ${message}`) };
  }
}
