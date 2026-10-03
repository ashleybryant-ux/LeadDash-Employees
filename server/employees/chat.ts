import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, ChatMessage } from "../../drizzle/schema";
import { generateJson, generateText, type JsonSchema } from "../_core/llm";
import * as tasks from "./tasks";
import * as apply from "./apply";
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
  type: "opportunity" | "application" | "question" | "submitted" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate" | "schedule_plan" | "prospect_sales" | "launch_plan" | "meeting_agenda" | "meeting_notes" | "onboarding" | "onboarding_q";
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
};

const ACTIONS: Record<string, string[]> = {
  grants: ["none", "report", "find_grants", "add_link", "apply", "find_and_apply", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  speaking: ["none", "report", "find_events", "add_link", "apply", "find_and_apply", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  video: ["none", "report", "find_videos", "ask_teammate", "add_guideline", "start_onboarding"],
  social: ["none", "report", "write_post", "schedule_posts", "ask_teammate", "add_guideline", "start_onboarding"],
  blog: ["none", "report", "write_article", "ask_teammate", "add_guideline", "start_onboarding"],
  website: ["none", "report", "plan_page", "ask_teammate", "add_guideline", "start_onboarding"],
  inbox: ["none", "report", "draft_reply", "write_email", "calendar_hold", "ask_teammate", "add_guideline", "start_onboarding"],
  hiring: ["none", "report", "find_people", "write_job_post", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  prospecting: ["none", "report", "find_prospects", "start_outreach", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  outreach: ["none", "report", "start_outreach", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  leads: ["none", "report", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  projects: ["none", "report", "plan_launch", "check_status", "move_launch", "send_report", "ask_teammate", "add_guideline", "start_onboarding"],
  coo: ["none", "report", "write_agenda", "schedule_meeting", "meeting_notes", "sat_in_notes", "join_or_skip", "send_notes", "check_status", "set_goal", "ask_teammate", "add_guideline", "start_onboarding"],
  custom: ["none", "report", "ask_teammate", "add_guideline", "start_onboarding"],
};

const ACTION_HELP: Record<string, string> = {
  plan_launch: "plan_launch: plan a launch back from its launch date. Put the launch name in `title`, the launch date as YYYY-MM-DD in `date`, and everything the person said about it (goals, targets, who does what) in `notes`.",
  move_launch: "move_launch: move a launch to a new date. Put the launch name in `target` ('' for the next launch) and the new date as YYYY-MM-DD in `date`.",
  send_report: "send_report: write the weekly status report for a launch now. Put the launch name in `target` ('' for the next launch).",
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
  find_grants: "find_grants: search the web now. Set `oppKind` to grant, pitch (pitch competitions), accelerator (accelerator or incubator programs) or bid (government or agency RFPs and bids); default grant. Put any focus the person gave in `focus`.",
  find_events: "find_events: search the web for speaking events taking proposals now. Set `oppKind` to speaking. Put any focus in `focus`.",
  add_link: "add_link: the person gave a link to an opportunity they found. Put the link in `url`.",
  apply: "apply: start the application for an opportunity already found. Put its name (or 'best' for the best fit not yet started) in `target`.",
  find_and_apply: "find_and_apply: search now, then start applications for the best fits (used by scheduled tasks like a morning search). Set `oppKind` and `focus` as for a search.",
  check_status: "check_status: report what is open, what is waiting for the person, what is submitted, and what is due soon.",
  find_videos: "find_videos: search for current short-form video trends and plan videos. Put any focus in `focus`.",
  write_post: "write_post: write a social post. Put the subject in `topic` and the platforms (linkedin, instagram, facebook, x, threads) in `platforms`; default to linkedin and instagram.",
  schedule_posts: "schedule_posts: the person wants upcoming posts put on the calendar for an account (for example \"schedule the next 12 posts on Facebook\"). Put the one account in `platforms` (facebook, instagram, linkedin, x or threads) and how many posts in `count` (default 8). You suggest the days and time; they confirm with a button.",
  write_article: "write_article: write a blog article. Put the title in `title` and points to cover in `notes`.",
  plan_page: "plan_page: plan a website page. Put the page name in `page` and its goal in `goal`.",
  draft_reply: "draft_reply: the person pasted a message they received. Put the sender in `from`, the subject in `subject` (make one up from the content if missing) and the full pasted message in `message`.",
};

function decisionSchema(kind: string): JsonSchema {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "action", "focus", "topic", "platforms", "count", "title", "notes", "page", "goal", "from", "subject", "message", "url", "oppKind", "target", "to", "date", "time", "attendees", "teammate"],
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
      oppKind: { type: "string", enum: ["", "grant", "pitch", "accelerator", "speaking", "bid"] },
      target: str,
      to: str,
      date: str,
      time: str,
      attendees: str,
      teammate: str,
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
};

function transcript(history: ChatMessage[]) {
  return history
    .slice(-12)
    .map((m) => `${m.role === "user" ? m.authorName : m.role === "handoff" ? `Handoff from ${m.authorName}` : "You"}: ${m.content}`)
    .join("\n\n");
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function worth(n: number, total: number) {
  if (n === 0) return total === 1 ? "It scored under 60, so I marked it Skip. You can still apply from the card." : "None scored 60 or higher, so I marked them Skip. You can still apply to any of them.";
  if (n === total) return total === 1 ? "It is worth applying to." : `All ${n} are worth applying to.`;
  return `${n} ${n === 1 ? "is" : "are"} worth applying to.`;
}

async function runAction(emp: AIEmployee, d: Decision): Promise<{ text: string; cards: ChatCard[]; queries: string[] }> {
  const org = emp.organizationId;
  switch (d.action) {
    case "find_grants":
    case "find_events":
    case "find_and_apply": {
      const empKind = emp.kind === "speaking" ? "speaking" : "grants";
      const r = await apply.findOpportunities(org, empKind, { kind: d.oppKind || undefined, focus: d.focus || undefined });
      const cards: ChatCard[] = r.created.map(oppCard);
      const thing = { grant: "open grant", pitch: "pitch competition", accelerator: "accelerator program", speaking: "event taking proposals", bid: "open bid" }[r.kind];
      let text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and found ${plural(r.created.length, `new ${thing}`)}. ${worth(r.created.filter((o) => o.fitCall === "apply").length, r.created.length)}`
        : `I ran ${plural(r.queries.length, "search", "searches")} and didn't find new ones beyond what's already on Opportunities.`;
      if (d.action === "find_and_apply") {
        const best = r.created.filter((o) => o.fitCall === "apply" && o.fitScore >= 75).sort((a, b) => b.fitScore - a.fitScore).slice(0, 2);
        for (const o of best) await apply.startApplication(org, o.id, null);
        if (best.length) text += ` I started ${best.length === 1 ? "the application for the best fit" : `applications for the ${best.length} best fits`} and will post ${best.length === 1 ? "it" : "each one"} here when it's ready for you.`;
      }
      return { text, cards, queries: r.queries };
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
      return { text: `I'm writing the ${pick.title} application now. I'll post it here when it's ready for you.`, cards: [apply.applicationCard(app, pick) as ChatCard], queries: [] };
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
      const m = await coo.nextMeetingFor(org, d.target);
      if (!m) return { text: "There's no meeting coming up. Add a repeating meeting on my Onboarding tab or ask me to schedule one.", cards: [], queries: [] };
      let next = await coo.buildAgenda(org, m.id);
      if (d.notes.trim()) {
        const items = JSON.parse(next.agenda || "[]") as coo.AgendaItem[];
        const extra = { item: d.notes.trim().slice(0, 160), who: "", minutes: 5 };
        next = await coo.editMeeting(org, m.id, { agenda: [...items.slice(0, -1), extra, ...items.slice(-1)], minutes: next.minutes });
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
      const m = await coo.lastMeetingFor(org, d.target);
      if (!m) return { text: "I don't have a past meeting to attach these to yet.", cards: [], queries: [] };
      const r = await coo.saveNotes(org, m.id, d.message || d.notes);
      const items = JSON.parse(r.actionItems || "[]") as coo.ActionItem[];
      const sent = items.some((i) => i.status === "in_clickup" || i.status === "task");
      return { text: `I found ${plural(items.length, "action item")} in your notes from ${m.title}${items.length ? `: ${items.map((i) => `${i.text} (${i.owner})`).join("; ")}` : ""}.${sent ? " Nora added them to the launch plan." : ""}`, cards: [], queries: [] };
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
      const a = await tasks.writeBlogArticle(org, { title: d.title || d.topic || "Untitled article", category: "Practice insights", outlineNotes: d.notes || undefined, generateBannerFlag: true });
      return {
        text: "The article is drafted and waiting for your approval. The full text is on the Articles tab.",
        cards: [{ type: "article", id: a.id, title: a.title, body: (a.body ?? "").replace(/[#*_>]/g, "").slice(0, 280), imageUrl: a.imageUrl }],
        queries: [],
      };
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

function oppCard(o: Opportunity): ChatCard {
  return apply.oppCardFor(o);
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
}) {
  const emp = await db.getEmployeeForOrg(opts.employeeId, opts.organizationId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });

  const userMsg = await db.createChatMessage({
    organizationId: opts.organizationId,
    employeeId: emp.id,
    role: "user",
    authorName: opts.authorName,
    userId: opts.userId,
    content: opts.text,
  });

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
    const { system } = await tasks.systemPromptFor(
      emp,
      `You are chatting with ${opts.authorName}. Answer questions about your work directly and briefly.
Right now it is ${await nowIn(opts.organizationId)}. Turn words like "today", "tomorrow" or "Friday" into exact dates.
When the message asks you to do your job now, choose the matching action and fill its fields. Otherwise choose "none" and answer in "reply".
Fill every field; use "" or [] for fields the action does not use.
Actions you can take:
${actions.map((a) => "- " + ACTION_HELP[a]).join("\n") || "- none"}`
    );
    const decision = await generateJson<Decision>({
      system,
      prompt: `Conversation so far:\n${transcript(history.slice(0, -1))}\n\n${opts.authorName}: ${opts.text}`,
      schemaName: "chat_decision",
      schema: decisionSchema(emp.kind),
      maxTokens: 2000,
    });

    if (!decision.action || decision.action === "none" || !actions.includes(decision.action)) {
      return { user: userMsg, reply: await reply(decision.reply || "Could you say a bit more about what you need?") };
    }
    const result = await runAction(emp, decision);
    return { user: userMsg, reply: await reply(result.text || decision.reply, result.cards, result.queries) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] ${emp.name} failed:`, message);
    return { user: userMsg, reply: await reply(`I couldn't do that. ${message}`) };
  }
}
