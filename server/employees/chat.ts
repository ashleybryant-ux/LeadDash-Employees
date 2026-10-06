import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, ChatFile, ChatMessage, OutboundItem } from "../../drizzle/schema";
import { generateJson, generateText, type JsonSchema } from "../_core/llm";
import * as tasks from "./tasks";
import * as apply from "./apply";
import * as pages from "./pages";
import * as hiring from "./hiring";
import { writeReport } from "./onboarding";
import { KNOWLEDGE_CATEGORIES, type Opportunity, type OppKind } from "../../drizzle/schema";
import { learnFact } from "./learn";
import { channelName, planSchedule, postNow, type Plan } from "../social";
import * as sales from "./sales";
import { askTeammate, findTeammate, gate, handoff } from "./team";
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
  type: "opportunity" | "application" | "application_draft" | "answer" | "question" | "submitted" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate" | "schedule_plan" | "prospect_sales" | "launch_plan" | "meeting_agenda" | "meeting_notes" | "onboarding" | "onboarding_q" | "browser_live" | "choices" | "layout_choice" | "avatar_video" | "dev_change" | "web_task" | "web_code" | "platform_findings" | "platform_page" | "schedule" | "drama_season" | "drama_episode" | "drama_keyframes" | "campaign_directions" | "press_brief" | "press_story" | "press_campaign" | "cold_hot" | "cold_review" | "precall" | "avery_brief" | "doc" | "deck" | "ad_budget" | "ad_set" | "sop";
  id: number;
  /** On a choices card after a bulk close in Projects: the task ids, so "Reopen them" can undo it. */
  undo?: string[];
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
  /** A schedule card: each event, already worded for the workspace's time zone. */
  events?: { when: string; day?: string; title: string; calendar: string; color: string; clash?: boolean }[];
  /** Avery's brief: the top three and the day's counts. */
  items?: { key: string; title: string; body: string; button: string; link: string | null; decisionKey: string | null }[];
  counts?: { decisions: number; meetings: number; waiting: number; handled: number };
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
  speaking: ["none", "report", "show_talk", "write_talk", "write_slides", "slide_notes", "slide_picture", "slide_graphic", "press_campaign", "press_scout", "press_brief", "find_events", "add_link", "add_file", "revise_answer", "restore_answer", "apply", "find_and_apply", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  video: ["none", "report", "find_videos", "write_campaign", "pick_direction", "approve_keyframes", "make_plates", "write_episodes", "rewrite_episode", "make_episode", "avatar_script", "make_avatar", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  social: ["none", "report", "write_post", "schedule_posts", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  blog: ["none", "report", "write_article", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  website: ["none", "report", "site_audit", "mockup_site", "ask_layout", "build_page", "restore_page", "change_page", "plan_page", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  inbox: ["none", "report", "draft_reply", "write_email", "check_schedule", "calendar_hold", "meeting_link", "sat_in_notes", "join_or_skip", "send_notes", "desk_brief", "decide", "send_back", "add_waiting", "add_promise", "to_nora", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  developer: ["none", "report", "fix_code", "merge_change", "change_request", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  onboarding: ["none", "report", "onboard_customer", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  hiring: ["none", "report", "find_people", "write_job_post", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  prospecting: ["none", "report", "find_prospects", "start_outreach", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  outreach: ["none", "report", "cold_campaign", "cold_research", "cold_review", "cold_replies", "start_outreach", "rewrite_outreach", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  leads: ["none", "report", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  projects: ["none", "report", "plan_launch", "check_status", "move_launch", "send_report", "capture", "close_item", "start_task", "project_meeting", "write_agenda", "meeting_notes", "set_deadlines", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  coo: ["none", "report", "write_agenda", "schedule_meeting", "meeting_notes", "set_deadlines", "sat_in_notes", "join_or_skip", "send_notes", "check_status", "set_goal", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  platform: ["none", "report", "audit_workflows", "fix_workflow", "platform_page", "check_status", "ask_teammate", "add_guideline", "start_onboarding"],
  ads: ["none", "report", "ads_campaign", "ads_note", "ads_rewrite", "ads_approve", "ads_skip", "ads_platform", "ads_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  billing: ["none", "report", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  compliance: ["none", "report", "check_status", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
  custom: ["none", "report", "ask_teammate", "add_guideline", "save_files", "start_onboarding"],
};
// Every employee has a browser, can run the Pre-call report skill, and works in Projects and Goals.
for (const list of Object.values(ACTIONS)) list.push("browse", "precall_report", "sop_site", "sop_write", "task_due", "task_find", "task_lists", "task_add", "task_change", "task_bulk", "task_undo", "goal_update");

const ACTION_HELP: Record<string, string> = {
  ads_campaign: "ads_campaign: start an ad campaign once you know all four: the goal, who it is for, the page or offer the ads go to, and the budget. Put a short campaign name in `title`, the goal in `goal`, who it is for in `target`, the page or offer in `url`, the platforms they named in `notes` (their words; \"all\" for every platform), the total budget in whole dollars in `count`, the start date as YYYY-MM-DD in `date` and the end date as YYYY-MM-DD in `time` ('' when they gave no dates). You then work out the budget split and post it as a card; nothing is written until they take a split.",
  ads_note: "ads_note: the person gives a standing instruction for the rest of the campaign's ads (\"make the headlines shorter\", \"always mention the founding rate\"), not a change to the one in front of them. Put it as one plain sentence in `notes`. It applies to every set written after.",
  ads_rewrite: "ads_rewrite: the person wants the set in front of them written again, a different version (\"another version\", \"try again with a softer hook\", \"rewrite the Meta one\"). Put what to change in `notes` ('' for simply another version) and the platform's name in `target` ('' for the one waiting now).",
  ads_approve: "ads_approve: the person approves the set in front of them in words (\"approved\", \"that works, next\", \"good, go on\"). Put the platform's name in `target` ('' for the one waiting now). Approving one set is what brings the next platform.",
  ads_skip: "ads_skip: the person does not want the platform in front of them (\"skip TikTok\", \"leave that one out\"). Put the platform's name in `target` ('' for the one waiting now).",
  ads_platform: "ads_platform: the person asks you to write a platform you left out or that failed (\"write Nextdoor anyway\", \"try Spotify again\"). Put the platform's name in `target`.",
  ads_status: "ads_status: the person asks where a campaign stands, what is waiting for them, or what is finished.",
  task_due: "task_due: the person asks what's due or overdue in Projects (for everyone, or for one person). Put the person's name in `target` ('' for everyone) and how many days ahead to look in `count` (default 7).",
  task_find: "task_find: look up tasks in Projects (this app's own folders, lists and tasks, where all the team's work lives): by words in the task, list or folder name, by person, or what's due. Put the words in `target` ('' for all), the person in `to` ('' for anyone), a last due date as YYYY-MM-DD in `date` ('' for any), and \"all\" in `focus` to include finished tasks.",
  task_lists: "task_lists: the person asks what's in Projects (folders and lists) or where something lives.",
  task_add: "task_add: add a task in Projects. Put the task in `title`, details in `notes`, the due date as YYYY-MM-DD in `date` ('' for none), who it's for (a person's or an employee's name, \"me\" for yourself) in `to` ('' for no one), and the list's name in `page` ('' for the newest list).",
  task_change: "task_change: change ONE task in Projects: its status (like \"complete\" or \"in progress\"), due date, who it's for, or add a comment. Put words from the task's name in `target`, the new status in `focus` (''), the new due date as YYYY-MM-DD in `date` (''), who to assign in `to` (''), and a comment in `notes` ('').",
  task_bulk: "task_bulk: change MANY tasks in Projects at once, like \"close everything overdue\" or \"push everything in Goals + Tactics to next Friday\". Put which tasks in `goal`: overdue (past due), all (every open task that matches), or a date YYYY-MM-DD for tasks due before it. Words to narrow by list, folder or task name in `target` ('' for every list), a person in `to` (''), the new status in `focus` (done, open... or ''), and a new due date YYYY-MM-DD in `date` (''). Do it when they say so; never ask first. Never use task_change for more than one task.",
  task_undo: "task_undo: reopen the tasks you just closed with task_bulk (\"Reopen them\", \"undo that\").",
  goal_update: "goal_update: post an update on a goal on the Goals page (\"we're at 13 practices\", \"the webinar is behind\"). Put words from the goal's title in `target`, how it's going in `focus` (on, risk or off), the update in `notes`, and the new number for its main target in `count` (0 when there's no new number).",
  sop_site: "sop_site: write an SOP (a standard operating procedure, a how-to for staff) by doing the steps yourself on a website in your browser and keeping a screenshot of each one (\"write the SOP for adding a clinician's availability in LeadDash EHR\", \"document how to add a contact in the platform, with screenshots\"). Use it when the procedure happens on a site a saved Website login covers or a web address in this conversation. Put the SOP's name in `title` (as a task: 'Adding a clinician's availability'), the web address in `url` ('' when a saved login covers it), and the saved login's name in `target` ('' for none). For LeadDash EHR use the demo practice login, never a real chart.",
  sop_write: "sop_write: write an SOP (a standard operating procedure, a how-to for staff) from what the person told you in this conversation, for a procedure that is not on a screen or that they described in words (\"write up how we handle a crisis call\", \"turn what I just said into an SOP\"). Only once you know how it is done step by step: if they only named it, ask how it goes, one question at a time, with 3 or 4 fixed choices where they fit. Put the SOP's name in `title`, everything they said about how it is done in `notes` (their words, in order), the area in `focus` (front_desk, billing, clinical, marketing or admin) and who follows it in `target`.",
  precall_report: "precall_report: run the Pre-call report skill before a meeting with a practice or person (\"run a pre-call report on Bayou Family Therapy\", \"brief me before my call with Dr. Tran\"). Put the person's name in `target`, the practice in `title`, a website in `url` and the meeting date in `date` (YYYY-MM-DD) and `time` (HH:MM) when given. Public business information only; it posts here when ready.",
  cold_campaign: "cold_campaign: write a new cold email campaign for the lead list. Put the angle key in `focus` (switcher, missed_calls, too_many, group_ops, growing or owner_time; pick the closest) and anything else she wants in `notes`. It's a draft until she presses Start.",
  cold_research: "cold_research: research the next best leads on the list (progressive enrichment). Put how many in `count` (default 100, at most 1000) and a state in `target` if she named one.",
  cold_review: "cold_review: she asks how cold email is doing, what's working, or for the weekly review now.",
  cold_replies: "cold_replies: check Instantly for new replies now.",
  desk_brief: "desk_brief: the person asks what needs them, for the brief, for their decisions or what you handled (\"what needs me?\", \"show all decisions\", \"what did you handle?\"). Put \"handled\" in `focus` when they ask what was handled, else \"\".",
  decide: "decide: the person makes a decision on your desk in chat (\"approve option B\", \"go with A for the price\"). Put words from the decision's title in `target` and the option label they picked in `focus` ('' to take your suggestion).",
  send_back: "send_back: the person says no to a decision on your desk or wants it changed. Put words from its title in `target` and what they said in `notes`.",
  add_waiting: "add_waiting: someone owes the owner something (\"Dana owes me the W-9 by Wednesday\"). Put who in `target`, their email in `to` if given, what they owe in `title`, the date it's expected in `date` (YYYY-MM-DD) and what it holds up in `notes`.",
  add_promise: "add_promise: the owner promised someone something (\"I told Obsidian I'd send pricing Friday\"). Put who it's for in `target`, what in `title` and the date in `date` (YYYY-MM-DD).",
  to_nora: "to_nora: the person wants an employee to do some work (\"get Kai to fix the booking page today\"). Nora runs the team's work, so it goes to her as a task. Put the task in `title`, the employee's job key or name in `teammate`, the due date in `date` (YYYY-MM-DD, '' if none) and details in `notes`.",
  browse: "browse: do something on a website in your own browser: read a page, look something up on a site, check a portal or account, fill in a form. Never use it for an app connected on Integrations (Gmail, Google Calendar, Zoom, social accounts) or for tasks (those live in Projects): use the matching actions. Never use it for an account that needs signing in unless a saved Website login covers it, and never ask anyone for a password. Put the whole job in `goal`, with exactly what to bring back. Put the web address in `url` only when it appeared in this conversation, on a saved opportunity, or in a search result; never guess a domain. Leave `url` '' when you don't have it (your browser looks the site up from the goal) or when a saved Website login covers it. the saved login's name in `target` ('' for none), and a short title in `title`. You do everything up to a Save, Submit, Send or Publish button and the owner presses Finish it to approve it. Use it instead of saying you can't open a website.",
  audit_workflows: "audit_workflows: open every workflow in the LeadDash platform, read the trigger and each step, change nothing, and list what needs fixing with one exact fix each.",
  fix_workflow: "fix_workflow: make the fix for a finding you listed, only when the owner says to (\"fix it\", \"fix the first two\", \"fix the reminders one\"). Put words from the workflow's name in `target` ('' when they gave a count), and in `focus` put fix_now (every one marked Fix now), all (every open one), or how many from the top (\"2\"); '' for one.",
  platform_page: "platform_page: put one of Jordan's pages into a funnel in the LeadDash platform, as a draft. Put the page's name in `page` ('' for Jordan's newest), the funnel's name in `target` (ask if they didn't say), and the path in `url` ('' to make one from the title). It's never published until the owner presses Publish.",
  save_files: "save_files: the person wants the files they attached in this chat kept in the Brain so every employee can use them.",
  add_file: "add_file: the person attached an RFP, call for proposals or opportunity document and wants you to look at it or add it. It is added to Opportunities and scored.",
  revise_answer: "revise_answer: change one answer on an application you wrote. Put words from the question (\"problem\", \"traction\") in `target`, the application's name in `title` ('' for the most recent), what to change in `notes`, and concise or detailed in `to` when they ask for shorter or longer ('' otherwise).",
  restore_answer: "restore_answer: the person wants the answer you just rewrote put back the way it was (\"go back to the old one\").",
  fix_code: "fix_code: have Claude fix a bug or make a change in the owner's code. Put which code in `target` (the code's name from your list), a short title in `title` (under 10 words), and in `notes` a clear write-up for Claude: what's wrong or wanted, where it shows up (screen, button, who sees it), what should happen instead, and how to check it's fixed. Never put client data in it. Do it as soon as you know which code and what's wrong; ask only if you can't tell.",
  merge_change: "merge_change: merge a change Claude finished, when the owner says to (\"merge it\", \"looks good, merge\"). Words from its title in `target` ('' for the newest one ready).",
  change_request: "change_request: send a finished change back to Claude with what to change. Words from its title in `target` ('' for the newest), what to change in `notes`.",
  onboard_customer: "onboard_customer: start onboarding a new customer. The practice name in `title`, the contact's name in `to`, their email in `from` ('' if not given), the go-live date as YYYY-MM-DD in `date`, anything else in `notes`. If there's no go-live date, ask for it.",
  write_campaign: "write_campaign: a branded video or ad (a commercial, a campaign, a promo, a brand film, a video about LeadDash or one of the AI employees). Put everything she said about it in `notes`. You write the campaign goal and three creative directions first; nothing is generated yet.",
  pick_direction: "pick_direction: she picked one of the three directions (\"use the second one\", \"go with The 9:47 PM Desk\"). Put its number (1, 2 or 3) in `count` and words from the campaign's title in `target` ('' for the newest). You then write the script, storyboard and shot list and make the keyframes for her approval.",
  approve_keyframes: "approve_keyframes: she approves the keyframes in so many words (\"animate it\", \"approved\", \"looks good, go\"), or asks to see them (\"show me the images\"). Put words from the title in `target` ('' for the newest one waiting). Seeing them never approves them.",
  rewrite_episode: "rewrite_episode: she wants an episode you already wrote changed (\"use me as the therapist\", \"I should be talking\", \"rewrite episode 1\"). Put the episode number in `count` (0 for the newest) and everything she wants changed in `notes`. The old keyframes are cleared and new ones wait for her approval.",
  make_plates: "make_plates: make the owner's character plates (standard images of her: front, walking, seated, profile, waist-up, full body, green blazer, black suit, evening attire) from her photos, so her face holds across campaigns.",
  write_episodes: "write_episodes: write episodes of the owner's cinematic micro drama series (a drama, micro drama, mini drama, series, season or more episodes). Put everything she said about the story, characters, setting and tone in `notes`, and how many episodes in `count` (default 3, at most 10). The first time, you also create the series and its cast; she plays herself.",
  make_episode: "make_episode: make an episode you wrote into a finished video (\"make episode 1\", \"make it\"). Put the episode number in `count` (0 for the next one not made yet).",
  avatar_script: "avatar_script: write a video of the owner talking, made by AI from her photo and her own voice. Put a short title in `title` and the exact words she says in `message`, written the way she talks out loud (about 2.5 words a second, so 110 words is about 45 seconds; aim for the length she asked for, 30 to 60 seconds if she didn't say). No stage directions, no labels, only her words. Several scripts at once: write the first and offer the rest.",
  make_avatar: "make_avatar: make the video from a script you wrote (\"Make it\", \"make the video\", \"make the double entry one\"). Put words from its title in `target` ('' for the newest script).",
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
  sat_in_notes: "sat_in_notes: the person asks about a meeting Avery sat in on and took notes for (Avery takes them, Simone gets them; what was decided, who agreed to what). Put the meeting name, company or person in `target` ('' for the most recent) and the question in `message`.",
  join_or_skip: "join_or_skip: the person wants Avery (the notetaker) to skip, or to sit in on, an upcoming meeting on their calendar. Put the meeting name or its start time (like 4:00 PM) in `target`, and \"join\" or \"skip\" in `to`.",
  send_notes: "send_notes: email the notes from a meeting Avery sat in on. Put the meeting name in `target` ('' for the most recent).",
  set_goal: "set_goal: set a weekly goal on the scorecard. Put one of practices_contacted, demos_booked, reply_minutes, posts_published, articles_published, grant_apps_sent, tasks_on_time, approvals_waiting in `target` and the goal number in `count`.",
  add_guideline: "add_guideline: the person states a standing rule or preference for how you work (\"from now on...\", \"always...\", \"never...\", \"don't...\"). Put the rule as one plain sentence in `notes`, and the Guidelines heading it belongs under in `target` (one of the headings in your Guidelines).",
  start_onboarding: "start_onboarding: the person wants to start, continue or redo your onboarding interview.",
  ask_teammate: "ask_teammate: the person asks you to check with another employee (\"ask Theo what he published\", \"how many demos does Malik have\"). Put that employee's name or job in `teammate` and the question in `message`.",
  find_prospects: "find_prospects: search the web now for businesses (or referral partners) that fit. Put any area, type or size the person gave in `focus`.",
  rewrite_outreach: "rewrite_outreach: rewrite every email sequence still waiting for approval (when the owner says they sound off, robotic, like AI, or asks for a rewrite). Put what to change in `notes` ('' if they didn't say).",
  start_outreach: "start_outreach: pass prospects to outreach so email sequences start. Put a prospect's name in `target`, or '' for every new prospect scoring 70 or higher.",
  write_email: "write_email: the person wants a NEW email sent to someone (not a reply to a pasted message). Put the email address in `to`, the person's name if given in `from`, and everything the email should say or ask, with exact dates and times written out (for example Friday, October 2, 2026 at 3:00 PM), in `message`. It waits for their approval, then sends from their connected Gmail.",
  slide_notes: "slide_notes: add to or change the presenter notes on one slide of the deck you built (\"add to the notes on slide 4: ...\"). Put the slide number in `count`, the words in `notes`, and \"replace\" in `focus` when they want the old notes replaced ('' to add to them).",
  slide_picture: "slide_picture: a new picture on one slide of the deck you built (\"new picture on slide 4, a woman at her desk after work\"). Put the slide number in `count` and what the picture should show in `notes` ('' to make another of the same). Put \"illustration\" in `focus` when they want a drawn illustration, \"photo\" for a realistic photo ('' to keep the slide's style).",
  slide_graphic: "slide_graphic: turn one slide of the deck you built into a graphic (\"make slide 6 a chart\", \"turn slide 3 into steps\", \"use an illustration on slide 5\", \"make that a timeline\"). Put the slide number in `count`, the graphic they named in `focus` (framework, stat, steps, compare, chart, timeline or illustration; '' to let you pick the best fit), and anything they said about what it should show in `notes`. Charts and statistics only use numbers in the script or the Brain, or numbers they give you here.",
  show_talk: "show_talk: the person wants to see, open or find a script or slides you ALREADY made (\"put it in the chat\", \"show me the script\", \"where is it\", \"I can't see it\"). Put \"slides\" in `focus` for the deck, '' for the script. It shows the existing one; it never writes a new one.",
  write_talk: "write_talk: write a NEW full word-for-word script (only when there isn't one yet, or they ask for a new version or a different length; to see one you already wrote, use show_talk) for a talk, keynote, workshop or session the owner is giving (\"write my talk\", \"write the script for my SHRM session\"). Put the talk's title in `title`, anything they asked for in `notes`, and its length in minutes in `count`: from what they said, else from the Brain (accepted sessions list their length). Never guess the length: when neither says, put 0 in `count`. It runs in the background and arrives in this chat, where it opens right there.",
  write_slides: "write_slides: build the slide deck (PowerPoint) for a talk (\"build the slides\", \"make the PPT\"). It uses the latest script you wrote, with what she says on each slide in the speaker notes; without a script it builds from the Brain. Put the talk's title in `title` and anything they asked for in `notes`. It arrives in this chat, where she can flip through it right there.",
  meeting_link: "meeting_link: about a meeting you already booked: the person asks for its Zoom or Meet link, or wants it on Zoom (\"put it on Zoom\", \"did you add it to Zoom?\"). Put words from its title or a guest's name or email in `target`, its date as YYYY-MM-DD in `date` when they say it (''), and \"zoom\" in `focus` when they want it on Zoom ('' when they only want the link). Use this, never calendar_hold or browse, for a meeting that's already booked.",
  calendar_hold: "calendar_hold: the person wants a NEW meeting or hold on their calendar (for one you already booked, use meeting_link). Put \"zoom\" in `focus` when they ask for it on Zoom. Put a short title in `title`, the date as YYYY-MM-DD in `date`, the start time like 3:00 PM in `time`, attendee emails comma-separated in `attendees`, the agenda in `notes`, and the calendar's name in `target` when they name one ('' for the usual one). It waits for their approval, then goes on that calendar. With guests it is a call: it gets a Zoom link (or Google Meet when Zoom isn't the meeting link) and the invites go out once approved, and Avery sits in to take notes.",
  check_schedule: "check_schedule: the person asks what's on their calendar or schedule (today, tomorrow, a day, this week, \"am I free Friday at 2\"). Put the first day as YYYY-MM-DD in `date` and how many days in `count` (1 for a day, 7 for a week). You check every calendar connected on Integrations.",
  report: "report: the person (or a scheduled task) asks for a report, summary or update on your work. Put what they want covered in `notes`.",
  find_people: "find_people: search the web for professionals to reach out to for an open role. Put the role or any focus (city, license, specialty) in `focus`.",
  write_job_post: "write_job_post: write or rewrite the job post for a role. Put the role title in `target` ('' for the newest open role).",
  check_bidprime: "check_bidprime: the person asks about BidPrime (their leads inbox, saved bids, \"did you look in BidPrime\", \"check BidPrime\"). You sign in to their BidPrime account with the sign-in saved on Integrations; you never need them to share a login.",
  find_grants: "find_grants: search the web now. Set `oppKind` to grant, pitch (pitch competitions), accelerator (accelerator or incubator programs) or bid (government or agency RFPs and bids); default grant. Put any focus the person gave in `focus`.",
  press_campaign: "press_campaign: she wants a media campaign or a media list for a story, launch or topic (\"build a media list for the LeadDash Employees launch\", \"pitch me on burnout\"). Put what it's about in `notes`. You plan it (goal, story, angles), then match reporters and write pitches; every pitch waits for her approval.",
  press_scout: "press_scout: she wants you to find reporters and stories now (\"who's covering AI in healthcare this week\", \"scout the news\"). Put any focus in `focus`.",
  press_brief: "press_brief: she asks for the weekly press briefing or what's going on with the press desk.",
  find_events: "find_events: search the web now for NEW opportunities, only when the person asks you to look for some. A question about a talk, proposal, event or pitch she already has (\"do you have the info on my SHRM Arkansas presentation?\") is never a search: choose none and answer from the Brain, your documents and your Opportunities. Set `oppKind` to speaking (events taking speaker proposals) or media (press: journalist source requests, podcasts booking guests, reporters covering the topic, op-ed and contributed article openings). Put any focus in `focus`.",
  add_link: "add_link: the person gave a link to an opportunity they found. Put the link in `url`.",
  apply: "apply: start the application for an opportunity already found. Put its name (or 'best' for the best fit not yet started) in `target`.",
  find_and_apply: "find_and_apply: search now, then start applications for the best fits (used by scheduled tasks like a morning search). Set `oppKind` and `focus` as for a search.",
  check_status: "check_status: report what is open, what is waiting for the person, what is submitted, and what is due soon.",
  find_videos: "find_videos: search for current short-form video trends and plan videos. Put any focus in `focus`.",
  write_post: "write_post: write a social post. Put the subject in `topic` and the platforms (linkedin, instagram, facebook, x, threads) in `platforms`; default to linkedin and instagram.",
  schedule_posts: "schedule_posts: the person wants upcoming posts put on the calendar for an account (for example \"schedule the next 12 posts on Facebook\"). Put the one account in `platforms` (facebook, instagram, linkedin, x or threads) and how many posts in `count` (default 8). You suggest the days and time; they confirm with a button.",
  write_article: "write_article: write a blog article. Put the title in `title` and points to cover in `notes`.",
  plan_page: "plan_page: only when the person asks for a plan or outline of a page (not the page itself). Put the page name in `page` and its goal in `goal`.",
  site_audit: "site_audit: read a page of the owner's existing website (its real HTML, words, buttons and images) and write an audit of what to change, add and cut, as a document that opens in the chat. Use it for any website audit, review, critique or read-through, never browse. Put the page's address in `url` when it's in this conversation or on a handoff ('' to use the workspace's website and find the page from `topic`), which page or offer it is in `topic` (like \"299 dollar founding member offer page\"), and the audience in `target` (like \"cold therapist audience\").",
  mockup_site: "mockup_site: mock up a new version of a page of the owner's existing website (\"mock up my website\", \"mock it up\", \"redesign this page\", \"show me what the page should look like\"): you read the page's real HTML, words and images and build the new version as a live preview in the chat with the HTML to copy, using her images, photos from the Brain, and pictures and graphics you make. Put the address in `url` ('' for the page you audited last, else the workspace's website), the page or offer in `topic`, `landing` or `website` in `target`, \"audit\" in `focus` when they want the audit's changes made (always after an audit unless they say otherwise), and anything else they asked for in `notes`.",
  build_page: "build_page: build a landing page or website page as HTML. Put the page name or offer in `page`, the goal in `goal`, `landing` or `website` in `target` (landing unless they say website or a page of their site), the layout they picked in `focus`, where the button goes in `to`, and everything else they told you about the page in `notes`.",
  change_page: "change_page: change a page you already built. Put the page's name in `target` ('' for the most recent page) and exactly what to change in `notes`.",
  draft_reply: "draft_reply: the person pasted a message they received. Put the sender in `from`, the subject in `subject` (make one up from the content if missing) and the full pasted message in `message`.",
};

function decisionSchema(kind: string): JsonSchema {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "action", "focus", "topic", "platforms", "count", "title", "notes", "page", "goal", "from", "subject", "message", "url", "oppKind", "target", "to", "date", "time", "attendees", "teammate", "choices", "remember_topic", "remember_fact", "remember_category"],
    properties: {
      reply: { type: "string", description: "What you say back. If you are about to do a job, one short sentence saying what you are doing." },
      action: { type: "string", enum: ACTIONS[kind] ?? ["none"] },
      focus: str,
      topic: str,
      platforms: { type: "array", items: { type: "string", enum: ["linkedin", "instagram", "facebook", "x", "threads"] } },
      count: { type: "integer", description: "A number the action asks for (posts for schedule_posts, days for check_schedule and task_due). 0 otherwise." },
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
      remember_topic: { type: "string", description: "2 to 5 words naming a new lasting fact to save to the Brain, or ''." },
      remember_fact: { type: "string", description: "The fact as one plain sentence, or ''." },
      remember_category: { type: "string", enum: ["", ...KNOWLEDGE_CATEGORIES] },
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
  remember_topic?: string;
  remember_fact?: string;
  remember_category?: string;
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

const TOOL_NAMES: Record<string, string> = { google_workspace: "Google (Gmail and Calendar)", clickup: "ClickUp", zoom: "Zoom", recall: "Recall.ai (meeting bot)", linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram", threads: "Threads", x: "X", tiktok: "TikTok", wordpress: "WordPress", google_business: "Google Business Profile", submittable: "Submittable", sessionize: "Sessionize" };
const TOOL_USERS: Record<string, string> = { clickup: "only for importing old ClickUp tasks into Projects; nobody works in ClickUp anymore, every task lives in Projects here", recall: "Avery sits in on Zoom and Google Meet meetings and sends the notes to Simone; the team joins huddles", zoom: "Simone uses it for meeting links", google_workspace: "Avery, Simone and Nora use it for email and calendar" };

/** Which tools are connected on Integrations, so no employee ever says a connected tool isn't there. */
async function connectedFacts(emp: AIEmployee) {
  const on = (await db.listConnectionsByOrg(emp.organizationId)).filter((c) => c.status === "connected").map((c) => c.provider);
  const tasksLine = "\nTasks and projects live in Projects, this app's own task manager (folders, lists, tasks, launches): use the task_ actions for them. It replaced ClickUp; never send work to ClickUp.";
  if (!on.length) return `${tasksLine}\nConnected tools on Integrations: none yet.`;
  return `${tasksLine}\nConnected tools on Integrations: ${on.map((p) => `${TOOL_NAMES[p] ?? p}${TOOL_USERS[p] ? ` (${TOOL_USERS[p]})` : ""}`).join("; ")}. Never say a connected tool isn't connected. If none of your actions use it, say it's connected and which teammate works in it.`;
}

/** Simone and Nora see recent meetings (Avery's notes), huddles and their action items (and Nora her projects), so they never say they have no notes. */
/** Kai's code list and changes, Imani's customers. */
async function teamFacts(emp: AIEmployee) {
  if (emp.kind === "developer") {
    const dev = await import("./dev");
    const repos = dev.settingsOf(emp).repos;
    const changes = db.listDevChanges(emp.organizationId, 10);
    const linkOnly = !(await import("../_core/env")).ENV.githubToken;
    return `${linkOnly ? "\nGitHub isn't connected, by the owner's choice: you write each fix up and she posts it on GitHub from your link, then reviews and merges Claude's change there. You can't see progress on GitHub, so never say you'll tell her when it's ready; tell her to watch the issue on GitHub. Never ask her for a GitHub token." : ""}\nCode you work on (name: repo; deploy command after a merge):\n${repos.map((r) => `- ${r.label}: ${r.repo}; ${r.deploy}`).join("\n")}\nRecent changes:\n${changes.map((c) => `- ${c.title} (${c.label}): ${c.status}${c.prNumber ? `, change #${c.prNumber}` : ""}`).join("\n") || "- none yet"}`;
  }
  if (emp.kind === "onboarding") return (await import("./customers")).customersFacts(emp.organizationId);
  if (emp.kind === "platform") return (await import("./platform")).platformFacts(emp.organizationId);
  if (emp.kind === "video") return (await import("./drama")).dramaFacts(emp.organizationId);
  if (emp.kind === "outreach") return (await import("./cold")).coldFacts(emp.organizationId);
  if (emp.kind === "speaking") return `${(await import("./press")).pressFacts(emp.organizationId)}${await (await import("./newsroom")).newsroomFacts(emp.organizationId)}`;
  if (emp.kind === "billing" || emp.kind === "compliance") {
    const ehr = await import("../ehr");
    const extra = emp.kind === "compliance" ? await (await import("./compliance")).complianceFacts(emp.organizationId) : "";
    return `${await ehr.ehrFacts(emp.organizationId)}${extra}`;
  }
  if (emp.kind === "leads") {
    const org = await db.getOrganizationById(emp.organizationId);
    if (org?.orgType === "healthcare") return (await import("../ehr")).ehrFacts(emp.organizationId);
  }
  if (emp.kind === "inbox") {
    const cals = db.listAccountLinks(emp.organizationId, "calendar");
    const desk = await (await import("./desk")).deskFacts(emp.organizationId).catch(() => "");
    return `${cals.length ? `\nCalendars you check: ${cals.map((c) => `${c.name}${c.holds === "default" ? " (holds go here unless another is named)" : c.holds === "no" ? " (never put holds here)" : ""}${c.detail === "busy" ? " (busy times only: you never see event names)" : ""}`).join("; ")}.` : ""}${desk}`;
  }
  return "";
}

/** Whether the owner's Claude or ChatGPT history is in the Brain yet, so "it's in the Brain" gets an honest answer. */
export function historyFacts(orgId: number) {
  const list = db.listHistoryImports(orgId, 20);
  const running = list.find((i) => i.status === "reading" || i.status === "running");
  const done = list.filter((i) => i.status === "done");
  const where = "on the Brain, Import history";
  const state = running
    ? `Her Claude or ChatGPT chat history is being imported into the Brain right now (${running.done} of ${running.total || "?"} chats read), so some of what she has worked on isn't in the Brain yet.`
    : done.length
      ? "Her Claude or ChatGPT chat history has been imported into the Brain (the \"Learned:\" entries)."
      : `Her Claude and ChatGPT chat history has NOT been imported into the Brain yet, so past work she did in those chats (proposals, talks, pitches, plans) isn't here. She uploads her export ${where}.`;
  return `\n${state} When she asks about something she says is in the Brain and you can't find it in the Brain or your documents, say plainly it isn't there${done.length ? "" : `, that it may be in her Claude history, which isn't imported yet (${where})`}, and ask her to attach the file or paste it. Never run a search instead.`;
}

/** Website logins every employee can use in their browser (names only; passwords never reach the AI). */
async function webFacts(emp: AIEmployee) {
  const logins = await db.listPortalLogins(emp.organizationId);
  return `\nYou have your own web browser (the browse action). Website logins saved on Integrations that you can sign in with: ${logins.map((l) => `${l.name}${l.lockName ? ` (only the ${l.lockName} sub-account)` : ""}`).join("; ") || "none yet"}.`;
}

async function leadershipFacts(emp: AIEmployee) {
  if (emp.kind !== "coo" && emp.kind !== "projects") return "";
  const parts = [await coo.recentMeetingsFacts(emp.organizationId).catch(() => "")];
  if (emp.kind === "projects") parts.push((await projects.projectsStatus(emp.organizationId).catch(() => "")).slice(0, 3000));
  return `\n${parts.filter(Boolean).join("\n")}`;
}

const REMEMBER = `Remembering for the whole team:
- When the person tells you something new and lasting about the business that the Brain doesn't already say (an offer or price, who the customers are, a person on the team, a tool they use, a date that matters, how the whole team should do something), fill remember_topic, remember_fact and remember_category, whatever action you also take. Saying a topic again with new details replaces the old one, so use the same topic name for corrections (for example "Practice plan price").
- Don't remember: one-off requests, things already in the Brain, a rule only for your own work (that's add_guideline), client names, anything about a client's health, passwords or codes.`;

const TALK = `Talk with the person like a colleague, back and forth, not like a form.
- When the request is unclear in a way that would waste real work if you guessed, choose "none", ask one short question in "reply", and put 2 to 4 short fixed answers in "choices".
- Otherwise do the job. After you finish or answer, put up to 4 short next steps the person is likely to want in "choices" (each under 6 words, written as what they would say). Leave "choices" empty when nothing obvious comes next.
- Questions about your work, a result or a score get a plain, specific answer from your facts.
- When the person tells you plainly what to do, do it now. Don't ask questions first unless a wrong guess would do something that can't be undone. Closing or moving tasks can be undone, so just do it.
- Never say you're writing, making, sending or doing something ("I'll have it in a moment", "writing it now") unless you chose the action that does it in this same reply. If none of your actions can do it, say so plainly and say what can.`;

const TALK_BY_KIND: Partial<Record<string, string>> = {
  website: `- Before you build a NEW page, if the person has not picked a layout earlier in this conversation, choose ask_layout. When they answer, choose build_page with their layout in "focus" and where the button goes in "to". To change a page you built, choose change_page with exactly what to change.
- When they say a page looks good, say what's left (button link, Approve, Copy HTML) in one sentence.`,
  grants: `- Before a search the person asks for in chat, if they did not say where (a state, a region or nationwide), choose "none" and ask, with choices like "Oklahoma first", "Nationwide", "Both".
- To change an answer on an application, choose revise_answer. After you showed a rewritten answer: "Use this" keeps it (say it's saved), "Make it shorter" is revise_answer with "to" concise, "Go back to the old one" is restore_answer.
- An attached RFP or opportunity file: choose add_file.`,
};
TALK_BY_KIND.speaking = `${TALK_BY_KIND.grants}
- You are also the publicist, running this workspace's press desk in a newsroom the owner may share across her workspaces. A media campaign or media list for a story is press_campaign; finding reporters and stories now is press_scout; "what's happening with press" is press_brief. Speaking events stay find_events.
- Never invent a reporter, an article, an email, a quote or a statistic. Every pitch waits for her approval (unless she raised the sending level), and a reporter another desk pitched in the cooling period is left alone.`;
TALK_BY_KIND.ads = `- You write ads; you never run them. A campaign starts from four things: the goal, who it is for, the page or offer the ads go to, and the budget (with dates when they give them). Take what the person's message already says. For each one still missing, choose "none" and ask for that ONE thing with 3 or 4 fixed choices in "choices" (for the goal: sign-ups, demo requests, new clients, webinar registrations; for the audience: the audiences the Brain names; for the page: the offers and pages the Brain names), one question per message, in that order. Once you have all four, choose ads_campaign.
- One platform at a time: a set waits in the chat until the person approves it, asks for another version, edits it or skips it. Never write two platforms in one message.
- Never invent a result, a cost per click or a platform rule. The platforms' specs come from your training; a number the person did not give you is a question, not a guess.`;

TALK_BY_KIND.inbox = `- You are the owner's executive assistant. You protect her time and attention: you sort what comes in, decide whether she needs it, and keep the one list of decisions for her and her team.
- Lead with a recommendation, not a pile of options: "Nov 17 works and Nov 19 clashes with your board call. I suggest Nov 17 and can confirm it."
- Some decisions only the owner makes (see your desk); anyone on the team can make the rest, and you always say who decided.
- You don't do another employee's job: work for an employee goes to Nora (to_nora), sales follow-ups to Jada, speaking and press to Taylor.`;
TALK_BY_KIND.outreach = `- You run two kinds of outreach: warm sequences for prospects Riley finds (from Gmail), and cold email to the owner's lead list through Instantly. Cold email work is cold_campaign, cold_research, cold_review and cold_replies.
- Cold email rules: business facts only, never personal details. Never claim a price, offer, migration, result or statistic that isn't in the playbook, the Brain or the website pricing. Opt-outs are honored at once. Every email carries the mailing address and an opt-out line.
- Any employee can run the Pre-call report (precall_report) before a meeting; you run it on your own when a lead books.`;
TALK_BY_KIND.developer = `- You never write or change code yourself. Claude does, from your write-up, and the owner merges. Say that plainly when it matters.
- Nothing goes live until the owner merges the change and runs the deploy. After a merge, give her the deploy command for that code from your list.
- Keep it plain: what's broken, what changed, how to check. No jargon unless she uses it.`;
TALK_BY_KIND.platform = `- You work in the LeadDash platform in your own browser, with a login locked to one sub-account. You can't open any other sub-account, and you never ask for the password in chat.
- An audit only reads. You change a workflow only when the owner says to fix it (fix_workflow) or presses Fix. Never fix something on your own.
- Pages go in as drafts. They go live only when the owner presses Publish on the page card.
- Call it the LeadDash platform. Plain words: what's wrong, what you'll change, what stays the same.`;
TALK_BY_KIND.onboarding = `- You onboard new customers (practices) onto LeadDash EHR, from signed to live. Not new hires.
- Every email to a customer waits for the owner's approval. Never promise a date, price or feature the Brain doesn't state.
- Nora tracks each onboarding plan as a project; you own the customer-facing steps.`;
TALK_BY_KIND.video = `- The owner's photos are in the Brain under "Images on file". When she asks about her photos, name the ones there and how many. Never say you can't get to her photos when they're listed there. When none are, ask her to attach them right here with the paperclip (up to 10 at a time) and save them to the Brain with save_files.
- You make videos of the owner from her photo and her own ElevenLabs voice yourself: choose avatar_script to write one, and make_avatar when she says to make it. Never recommend HeyGen, Synthesia or any other tool; this is how it's made.
- Three kinds of video. A branded campaign or ad is write_campaign (three directions first), then pick_direction, then she approves the keyframes (approve_keyframes) before anything is animated. A micro drama (story, scenes, characters, cinematic, episodes, a series) is write_episodes, then make_episode: a cinematic episode cut from 10 to 16 shots with camera moves, the cast's faces matched in every shot, and each line spoken in that character's voice. A video of the owner talking to camera (a tip, an announcement) is avatar_script, then make_avatar. When she asks for a drama, never write a talking-to-camera script, but she is the lead and she talks: her character is always played from her own photos and speaks in her own ElevenLabs voice (spoken lines lip synced to her face, and voice-over). Never cast anyone else as her. If she says she isn't in it or isn't talking, that's rewrite_episode.
- Episodes are written as 3 to 5 scenes; shots in a scene follow straight on from each other, a script supervisor pass fixes anything that doesn't follow, each keyframe carries the room, light and wardrobe from the shot before it, a continuous camera move ends on the next keyframe, and the cut uses soft cuts inside a scene, a dip to black between scenes, crossfaded sound and one room tone per scene. If she says an episode was choppy or made no sense, that's rewrite_episode.
- Nothing is animated without her clear approval. Asking to see the keyframes is never approval. Drama episodes are on the Episodes tab of your Videos tab; campaigns are on the Campaigns tab. Never send her to the wrong tab. For a shot where she speaks on camera, the most believable result is her own take: she presses Add take on that keyframe (in chat or on the Campaigns tab) and records herself saying the line on her phone, and her movement, expressions and real voice go onto the polished keyframe. Shots with one person are animated with Kling; shots with two or more people with Seedance, which holds several faces better. After a shot is animated she can press Redo with Seedance or Redo with Kling to try the other model on the same keyframe.
- No markdown symbols like ** or #. Plain sentences, and number options as 1., 2., 3.`;

/** The owner's own message says yes to animating, not just "show me". */
export function approves(said: string) {
  const t = said.toLowerCase();
  if (/\b(don'?t|do not|not yet|wait|hold|stop|no)\b/.test(t)) return false;
  return /\b(approve[ds]?|animate|go ahead|looks? good|go for it|make (the|it a) video|yes)\b/.test(t);
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const fmtYmd = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });

function worth(n: number, total: number) {
  if (n === 0) return total === 1 ? "It scored under 60, so I marked it Skip. You can still apply from the card." : "None scored 60 or higher, so I marked them Skip. You can still apply to any of them.";
  if (n === total) return total === 1 ? "It is worth applying to." : `All ${n} are worth applying to.`;
  return `${n} ${n === 1 ? "is" : "are"} worth applying to.`;
}

/** Where an action's output lives, so Nora can follow a task's work until it is approved. */
type Ref = projects.WorkRef;
type ActionResult = { text: string; cards: ChatCard[]; queries: string[]; refs?: Ref[]; choices?: string[] };
type RunCtx = { who?: string; files?: ChatFile[]; history?: ChatMessage[]; said?: string; userId?: number | null };

async function runAction(emp: AIEmployee, d: Decision, ctx: RunCtx = {}): Promise<ActionResult> {
  const org = emp.organizationId;
  const who = ctx.who ?? "the owner";
  const files = ctx.files ?? [];
  const docText = files.filter((f) => f.kind === "document").map((f) => `${f.name}:\n${f.text.slice(0, 6000)}`).join("\n\n");
  switch (d.action) {
    case "task_due":
    case "task_find":
    case "task_lists":
    case "task_add":
    case "task_change":
    case "task_bulk":
    case "task_undo":
    case "goal_update": {
      return projectsAction(emp, d, who);
    }
    case "sop_site": {
      const sops = await import("./sops");
      const web = await import("./web");
      try {
        const { task, login, job } = await sops.startFromSite(emp, { title: d.title || d.goal || d.message, url: d.url, login: d.target, by: who });
        return { text: `On it. I'll go through "${job.title}" in ${login ? login.name : "my browser"} screen by screen, keep a screenshot of each step, and write it up. You can watch or take over.`, cards: [web.liveCard(task.liveId!, `${emp.name}'s browser`)], queries: [], refs: [{ kind: "web", id: task.id }] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "sop_write": {
      const sops = await import("./sops");
      const talk = await import("./talk");
      const lines = talk.userLines(ctx.history, ctx.said ?? "").reverse();
      const said = [d.notes, ...lines].filter(Boolean).join("\n");
      const sop = await sops.writeFromChat(emp, { title: d.title, said: said || d.message, area: d.focus, follows: d.target, by: who });
      const n = sops.stepsOf(sop).length;
      const rev = await sops.reviewer(org);
      return { text: `I wrote "${sop.title}" as ${n} step${n === 1 ? "" : "s"} from what you told me. It's a draft on the SOPs tab: read it, fix anything, then send it to ${rev && rev.id !== emp.id ? rev.name : "review"}.`, cards: [sops.card(sop)], queries: [] };
    }
    case "precall_report": {
      const precall = await import("./precall");
      const at = d.date ? new Date(`${d.date}T${/^\d{2}:\d{2}$/.test(d.time) ? d.time : "12:00"}:00`) : null;
      const r = await precall.startPrecall(org, { person: d.target || undefined, practice: d.title || undefined, website: /^https?:/.test(d.url) ? d.url : undefined, meetingAt: at && !Number.isNaN(at.getTime()) ? at : null, runBy: `${emp.name}, from chat`, employeeKind: emp.kind });
      return { text: `I'm putting together the pre-call report on ${r.person || r.practice} from public business information. It takes a few minutes; I'll post it here when it's ready.`, cards: [], queries: [] };
    }
    case "cold_campaign": {
      const cold = await import("./cold");
      const key = (cold.ANGLES.find((a) => a.key === d.focus.trim()) ?? cold.ANGLES[0]).key;
      const c = await cold.writeCampaign(org, key, { guidance: d.notes || undefined });
      const v = cold.campaignView(c);
      return { text: `I wrote "${v.name}": 4 short emails for ${v.whoText}, with a second subject line to test on email 1. It's a draft on my Campaigns tab. Read it there and press Start when it looks right; it sends from your Instantly inboxes.`, cards: [], queries: [] };
    }
    case "cold_research": {
      const cold = await import("./cold");
      const n = Math.min(1000, Math.max(1, d.count || 100));
      cold.job(`research-${org}`, () => cold.research(org, n, { state: d.target || undefined }));
      return { text: `I'm researching the next ${n} best leads${d.target ? ` in ${d.target}` : ""}: their practice website first, a web search when there isn't one. Scores update on my Lead list tab as I go.`, cards: [], queries: [] };
    }
    case "cold_review": {
      const cold = await import("./cold");
      const r = await cold.weeklyReview(org);
      if (!r) return { text: "Nothing has gone out yet, so there's nothing to review. Start a campaign on my Campaigns tab first.", cards: [], queries: [] };
      return { text: "Here's the review.", cards: [], queries: [] };
    }
    case "desk_brief": {
      const desk = await import("./desk");
      if (d.focus === "handled") {
        const t = await desk.today(org);
        const rows = t.handled.rows;
        return { text: rows.length ? `Since ${t.handled.since}: ${rows.map((r) => r.text).join("; ")}. Each one is under Handled for you on my Today tab.` : `Nothing new since ${t.handled.since}.`, cards: [], queries: [] };
      }
      const { t, head, tail } = await desk.briefText(org);
      return { text: `${head}${tail ? `\n\n${tail}` : ""}`, cards: [{ type: "avery_brief", id: 0, title: t.date, items: t.top, counts: t.counts }], queries: [], choices: ["Show all decisions", "What did you handle?"] };
    }
    case "decide":
    case "send_back": {
      const desk = await import("./desk");
      if (!ctx.userId) return { text: "A person has to make that call, so I left it on the Decisions tab.", cards: [], queries: [] };
      const m = await db.getOrganizationMembership(org, ctx.userId);
      const role = m?.role ?? ((await db.getUserById(ctx.userId))?.role === "admin" ? "owner" : "reviewer");
      const item = await desk.findDecision(org, d.target || d.title);
      if (!item || item.id === null) return { text: "There's nothing on my Decisions tab like that. Everything waiting is on the Decisions tab.", cards: [], queries: [] };
      const who = ctx.who ?? "You";
      if (d.action === "send_back") {
        await desk.sendBack(org, item.id, { note: d.notes, by: who, role, userId: ctx.userId });
        return { text: `Sent back "${item.title}"${item.from.length ? ` to ${item.from.join(", ")}` : ""}${d.notes ? ` with your note` : ""}.`, cards: [], queries: [] };
      }
      const done = await desk.decide(org, item.id, { choice: d.focus || undefined, by: who, role, userId: ctx.userId });
      return { text: `Done. "${item.title}": ${done.choice}.${item.from.length ? ` I told ${item.from.join(", ")}.` : ""}`, cards: [], queries: [] };
    }
    case "add_waiting":
    case "add_promise": {
      const desk = await import("./desk");
      const when = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? new Date(`${d.date}T17:00:00`) : null;
      const w = desk.addWaiting(org, { kind: d.action === "add_waiting" ? "owed" : "promise", who: d.target || "Someone", email: /@/.test(d.to) ? d.to : "", what: d.title || d.notes, blocks: d.action === "add_waiting" ? d.notes : "", expectedAt: when, heardIn: `Chat with ${ctx.who ?? "you"}`, owner: d.action === "add_waiting" ? "avery" : "you" });
      const tz = (await db.getOrganizationById(org))?.timezone || "America/Chicago";
      const fmtD = (x: Date) => x.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return {
        text:
          w.kind === "owed"
            ? `Got it. ${w.who} owes ${w.what}${w.expectedAt ? ` by ${fmtD(new Date(w.expectedAt))}` : ""}. ${w.email ? `I'll nudge them${w.nudgeAt ? ` on ${fmtD(new Date(w.nudgeAt))}` : ""} if it hasn't come in.` : "Add their email on my Waiting tab and I'll nudge them if it doesn't come in."}`
            : `Added to your promises: ${w.what} to ${w.who}${w.expectedAt ? ` by ${fmtD(new Date(w.expectedAt))}` : ""}. It's on my Waiting tab.`,
        cards: [],
        queries: [],
      };
    }
    case "to_nora": {
      const mate = d.teammate ? await findTeammate(org, d.teammate) : null;
      const owner = mate?.kind ?? (d.teammate || "projects");
      const due = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? new Date(`${d.date}T17:00:00`) : undefined;
      await projects.addActionItems(org, [{ text: d.title || d.notes, owner, due }], `Avery, for ${ctx.who ?? "the owner"}`);
      const nora = await db.getEmployeeByKind(org, "projects");
      await handoff(org, "inbox", "projects", `${ctx.who ?? "The owner"} asked for this${mate ? ` from ${mate.name}` : ""}: ${d.title || d.notes}${due ? `, due ${fmtYmd(d.date)}` : ""}.${d.notes && d.title ? ` ${d.notes}` : ""}`).catch(() => null);
      return { text: `I sent it to ${nora?.name ?? "Nora"}, since she runs ${mate ? `${mate.name}'s` : "the team's"} work. It's on her task list${due ? ` for ${fmtYmd(d.date)}` : ""}, and she'll tell me when it's done.`, cards: [], queries: [] };
    }
    case "cold_replies": {
      const r = await (await import("./coldreply")).checkReplies(org);
      return { text: r.read ? `I read ${plural(r.read, "new reply", "new replies")}. They're sorted on my Replies tab.` : "No new replies right now.", cards: [], queries: [] };
    }
    case "press_campaign": {
      const pitching = await import("./pitching");
      if (!db.press.getSettings(org)) db.press.saveSettings(org, {});
      const c = await pitching.planCampaign(org, d.notes || d.focus || d.title || "A media campaign");
      const v = pitching.campaignView(org, c);
      return { text: `I planned "${v.title}": ${v.plan.story} Here are five angles; I picked the two strongest. Change the plan or the angles on my Campaigns tab, then press Add reporters and I'll match the right reporters and write each a pitch. Nothing goes out until you approve it.`, cards: [{ type: "press_campaign", id: v.id, title: v.title }], queries: [] };
    }
    case "press_scout": {
      const newsroom = await import("./newsroom");
      if (!db.press.getSettings(org)) db.press.saveSettings(org, {});
      const r = await newsroom.scout(org, { focus: d.focus || undefined, quiet: true });
      return { text: `I scouted the news: ${plural(r.added, "new reporter")} with recent articles as proof${r.moved ? `, ${plural(r.moved, "reporter")} changed outlets` : ""}, ${plural(r.stories, "story", "stories")} routed to the desk each fits best${r.coverage ? `, and ${plural(r.coverage, "new coverage mention")}` : ""}. It's all on my Newsroom tab.`, cards: [{ type: "press_brief", id: Date.now(), title: "Newsroom" }], queries: [] };
    }
    case "press_brief": {
      if (!db.press.getSettings(org)) db.press.saveSettings(org, {});
      return { text: "Here's where the press desk stands this week.", cards: [{ type: "press_brief", id: Date.now(), title: "This week" }], queries: [] };
    }
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
    case "rewrite_outreach": {
      const n = await sales.rewriteWaiting(org, d.notes || undefined);
      return { text: n ? `I rewrote ${plural(n, "waiting sequence")} so they sound like you typed them. They're on my Outreach tab for you to look over.` : "There's nothing waiting for approval to rewrite.", cards: [], queries: [] };
    }
    case "plan_launch": {
      const r = await projects.planLaunch(org, { name: d.title || undefined, date: d.date, brief: [d.notes, d.message].filter(Boolean).join("\n") || d.reply });
      const counts = await projects.planCounts(org, r.launch.id);
      const text = r.auto
        ? `I planned ${r.launch.name} with ${plural(counts.milestones, "milestone")} and ${plural(counts.tasks, "task")}, and started it in Projects. I'll check it every morning.`
        : `I worked back from the launch date and built ${plural(counts.milestones, "milestone")} and ${plural(counts.tasks, "task")} with ${plural(counts.owners, "owner")}. Once you approve, I'll put the list in Projects and check it every morning.`;
      return { text, cards: [projects.planCard(r.launch, counts) as ChatCard], queries: [] };
    }
    case "move_launch": {
      const l = await projects.findLaunch(org, d.target);
      if (!l) return { text: "There's no launch to move yet.", cards: [], queries: [] };
      const r = await projects.moveLaunch(org, l.id, d.date);
      return { text: `I moved ${r.launch.name} ${Math.abs(r.days)} day${Math.abs(r.days) === 1 ? "" : "s"} ${r.days >= 0 ? "later" : "earlier"} and shifted ${plural(r.moved, "open task")} with it in Projects.`, cards: [], queries: [] };
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
      const sent = items.some((i) => i.status === "in_projects" || i.status === "task");
      return { text: `I found ${plural(items.length, "action item")} in your notes from ${m.title}${items.length ? `: ${items.map((i) => `${i.text} (${i.owner})`).join("; ")}` : ""}.${sent ? (emp.kind === "projects" ? " I added them to the launch plan and I'll track each one." : " Nora added them to the launch plan.") : ""}`, cards: [], queries: [] };
    }
    case "fix_code": {
      const dev = await import("./dev");
      try {
        const ch = await dev.askClaude(org, { label: d.target, title: d.title, request: d.notes || d.message || d.reply });
        const text =
          ch.status === "handed_off"
            ? `I wrote it up for Claude in ${ch.label} with what's broken, where to look and how to check the fix. Press Post on GitHub, then Submit new issue. Claude starts as soon as it's posted, and you'll review and merge the change on GitHub.`
            : `I wrote it up for Claude in ${ch.label} with what's broken, where to look and how to check the fix. Claude is working on it now. I'll tell you when the change is ready for you to look at.`;
        return { text, cards: [{ type: "dev_change", id: ch.id, title: ch.title }], queries: [] };
      } catch (err) {
        return { text: `I couldn't start it: ${err instanceof Error ? err.message : String(err)}`, cards: [], queries: [] };
      }
    }
    case "merge_change":
    case "change_request": {
      const dev = await import("./dev");
      const t = d.target.trim().toLowerCase();
      const all = db.listDevChanges(org, 50);
      const ch = (t ? all.find((x) => x.title.toLowerCase().includes(t) && x.status === "ready") : null) ?? all.find((x) => x.status === "ready");
      if (!ch) return { text: "Nothing is ready yet. I'll tell you as soon as Claude finishes.", cards: [], queries: [] };
      try {
        if (d.action === "merge_change") {
          await dev.merge(org, ch.id);
          const r = dev.settingsOf(emp).repos.find((x) => x.repo === ch.repo);
          return { text: `Merged "${ch.title}" into ${ch.label}. It goes live when you run the deploy:\n${r?.deploy || "your usual deploy command"}`, cards: [{ type: "dev_change", id: ch.id, title: ch.title }], queries: [] };
        }
        await dev.askForChanges(org, ch.id, d.notes || d.message);
        return { text: `I sent it back to Claude with your changes. I'll tell you when it's ready again.`, cards: [{ type: "dev_change", id: ch.id, title: ch.title }], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [{ type: "dev_change", id: ch.id, title: ch.title }], queries: [] };
      }
    }
    case "browse": {
      // Jordan reads and reviews websites from their real HTML, not by clicking around a browser.
      if (emp.kind === "website" && !d.target && /\b(audit|review|critique|read|look (?:at|over)|feedback|flag|assess|evaluate)\b/i.test(`${d.goal} ${d.notes} ${d.title}`)) {
        const sw = await import("./siteWork");
        const goal = d.goal || d.notes || d.message;
        const text = await sw.startSiteAudit(emp, { url: d.url, about: d.title || goal, audience: (goal.match(/\bfor (?:a |an |the )?([^,.;]{3,60}?audience)\b/i) ?? [])[1] ?? "", said: goal, html: sw.htmlFiles(files) });
        return { text, cards: [], queries: [] };
      }
      const web = await import("./web");
      try {
        const { task, login } = await web.startWebTask(emp, { goal: d.goal || d.notes || d.message, url: d.url, login: d.target, title: d.title });
        return { text: `Opening ${login ? login.name : "it"} in my browser now. You can watch or take over.`, cards: [web.liveCard(task.liveId!, `${emp.name}'s browser`)], queries: [], refs: [{ kind: "web", id: task.id }] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "audit_workflows": {
      const pf = await import("./platform");
      const web = await import("./web");
      try {
        const { task, already } = await pf.startAudit(org);
        const text = already
          ? "I'm already reading your workflows. Here's my browser."
          : "Signing in to the LeadDash platform now. I'll open each workflow, read the trigger and every step, and change nothing. Watch here or take over any time.";
        return { text, cards: [web.liveCard(task.liveId!, `${emp.name}'s browser`)], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "fix_workflow": {
      const pf = await import("./platform");
      const web = await import("./web");
      const list = pf.pickFindings(org, d.target, d.focus.trim().toLowerCase());
      if (!list.length) return { text: "There's nothing open to fix. Ask me to audit your workflows and I'll list what needs fixing.", cards: [], queries: [] };
      const started: string[] = [];
      let liveId = "";
      for (const f of list) {
        try {
          const r = await pf.startFix(org, f.id);
          started.push(f.workflow);
          liveId ||= r.task.liveId ?? "";
        } catch {
          /* one that's already fixing is skipped */
        }
      }
      if (!started.length) return { text: "I'm already working on those.", cards: [], queries: [] };
      return { text: `Fixing ${started.length === 1 ? `"${started[0]}"` : `${started.length} workflows, one at a time: ${started.map((n) => `"${n}"`).join(", ")}`}. I'll make only the change I described and save. I'll post here when ${started.length === 1 ? "it's" : "each one is"} done.`, cards: liveId ? [web.liveCard(liveId, `${emp.name}'s browser`)] : [], queries: [] };
    }
    case "platform_page": {
      const pf = await import("./platform");
      const web = await import("./web");
      if (!d.target.trim()) return { text: "Which funnel should it go in?", cards: [], queries: [] };
      try {
        const { task, page } = await pf.startPage(org, { page: d.page, funnel: d.target, path: d.url });
        return { text: `Putting Jordan's "${page.title}" page into your ${d.target.trim()} funnel now, as a draft. Nothing goes live until you press Publish.`, cards: [web.liveCard(task.liveId!, `${emp.name}'s browser`)], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "onboard_customer": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { text: "When should they go live?", cards: [], queries: [] };
      const cust = await import("./customers");
      try {
        const r = await cust.onboardCustomer(org, { practice: d.title, contact: d.to, email: d.from, goLive: d.date, notes: d.notes });
        const text = `Here's their onboarding plan, worked back from ${fmtYmd(d.date)}: ${plural(r.counts.milestones, "step")} and ${plural(r.counts.tasks, "task")}. Nora will track every step${r.auto ? " and it's started" : " once you approve it"}.${r.email ? " The welcome email is waiting for your OK in Approvals." : " Send me their email and I'll write the welcome."}`;
        return { text, cards: [projects.planCard(r.launch, r.counts) as ChatCard], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "write_episodes": {
      const dr = await import("./drama");
      try {
        const org0 = await db.getOrganizationById(org);
        const r = await dr.writeEpisodes(org, { brief: d.notes || d.message || d.topic || "", count: d.count || 3, ownerName: org0?.signerName || who });
        if (!r.episodes.length) return { text: "I couldn't write those episodes. Tell me a little more about the story and I'll try again.", cards: [], queries: [] };
        const first = r.episodes[0];
        const est = r.episodes.reduce((s, e) => s + e.costCents, 0) / r.episodes.length;
        const owner = r.cast.find((c) => c.kind === "owner");
        return {
          text: `I wrote ${r.episodes.length === 1 ? "an episode" : `${r.episodes.length} episodes`} of ${r.series.title}. Each opens on a hook and ends on a cliffhanger, cut from about ${Math.round(dr.shotsOf(first).length)} shots with real camera moves. ${owner ? `You play ${owner.name}, from your photo and your voice. ` : ""}${(() => { const n = r.cast.filter((c) => c.kind === "made_up").length; return n === 1 ? "The other character is" : `The other ${n} characters are`; })()} made up, and no real clients or client stories are used. Each episode costs about $${(est / 100).toFixed(2)} to make.`,
          cards: [{ type: "drama_season", id: first.id, title: r.series.title }],
          queries: [],
          choices: [`Make episode ${first.number}`, "Change a character", "Write more episodes"],
        };
      } catch (err) {
        return { text: `I couldn't write it: ${err instanceof Error ? err.message : String(err)}`, cards: [], queries: [] };
      }
    }
    case "write_campaign": {
      const cp = await import("./campaign");
      try {
        const ep = await cp.writeDirections(org, d.notes || d.message || d.topic || "");
        return { text: "Here are three directions. Pick one and I'll write the script, the shot list, the sound plan and the edit, then show you the keyframes before anything is animated.", cards: [{ type: "campaign_directions", id: ep.id, title: ep.title }], queries: [] };
      } catch (err) {
        return { text: `I couldn't write the directions: ${err instanceof Error ? err.message : String(err)}`, cards: [], queries: [] };
      }
    }
    case "pick_direction": {
      const cp = await import("./campaign");
      const dr = await import("./drama");
      const ep = cp.campaignFor(org, d.target);
      if (!ep) return { text: "There's no campaign yet. Tell me what the video should be about.", cards: [], queries: [] };
      try {
        const planned = await cp.planCampaign(org, ep.id, d.count || 1, who);
        const started = await dr.startEpisode(org, planned.id);
        const v = dr.episodeView(started);
        return { text: `"${v.title}" is planned: ${v.shots.length} shots, ${v.length}, voice-over in your voice, a score, captions and the call to action "${v.plan.cta}". I'm making the keyframes now (about $${(v.shots.length * 0.15).toFixed(2)}). You'll approve them before anything is animated.`, cards: [{ type: "drama_keyframes", id: v.id, title: v.title }], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "approve_keyframes": {
      const dr = await import("./drama");
      const w = d.target.trim().toLowerCase();
      const waiting = db.listDramaEpisodes(org).filter((e) => e.status === "keyframes");
      const ep = (w ? waiting.find((e) => e.title.toLowerCase().includes(w)) : null) ?? waiting[waiting.length - 1];
      if (!ep) return { text: "Nothing is waiting for approval right now.", cards: [], queries: [] };
      // Only her own words approve: asking to see them, or anything less than a clear yes, just shows them.
      if (!approves(ctx.said ?? "")) {
        return { text: `Here are the keyframes for ${ep.kind === "campaign" ? `"${ep.title}"` : `episode ${ep.number}, "${ep.title}"`}. Press Redo on any that aren't right. Nothing is animated until you press Animate it or tell me it's approved.`, cards: [{ type: "drama_keyframes", id: ep.id, title: ep.title }], queries: [] };
      }
      try {
        const v = dr.episodeView(await dr.approveKeyframes(org, ep.id));
        return { text: `Animating "${v.title}" now: ${v.shots.length} shots, ${v.animateCost}. I'll post it here when it's cut.`, cards: [{ type: "drama_episode", id: v.id, title: v.title }], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "rewrite_episode": {
      const dr = await import("./drama");
      const eps = db.listDramaEpisodes(org).filter((e) => e.kind === "drama");
      const ep = (d.count ? eps.find((e) => e.number === d.count) : null) ?? eps[eps.length - 1];
      if (!ep) return { text: "There are no episodes yet. Tell me about the story and I'll write them.", cards: [], queries: [] };
      if (ep.status === "making") return { text: `Episode ${ep.number} is being made right now. Once it finishes I can rewrite it.`, cards: [], queries: [] };
      try {
        const org0 = await db.getOrganizationById(org);
        const r = await dr.writeEpisodes(org, { brief: d.notes || d.message || ctx.said || "", count: 1, ownerName: org0?.signerName || who, replace: ep });
        const e = r.episodes[0];
        if (!e) return { text: "I couldn't rewrite it. Tell me a little more about what to change.", cards: [], queries: [] };
        const shots = dr.shotsOf(e);
        const owner = r.cast.find((c) => c.kind === "owner");
        const talks = shots.filter((x) => x.line && owner && x.line.who === owner.name).length;
        const thinks = shots.filter((x) => x.vo).length;
        return { text: `I rewrote episode ${e.number}, "${e.title}." ${owner ? `You play ${owner.name} in ${shots.filter((x) => x.cast.includes(owner.name)).length} of the ${shots.length} shots, from your photos, and you speak in your own voice: ${talks} spoken ${talks === 1 ? "line" : "lines"} lip synced to your face and ${thinks} voice-over ${thinks === 1 ? "line" : "lines"}. ` : ""}Say make episode ${e.number} and I'll make the keyframes. You approve them before anything is animated.`, cards: [{ type: "drama_season", id: e.id, title: r.series.title }], queries: [], choices: [`Make episode ${e.number}`, "Change a line"] };
      } catch (err) {
        return { text: `I couldn't rewrite it: ${err instanceof Error ? err.message : String(err)}`, cards: [], queries: [] };
      }
    }
    case "make_plates": {
      const dr = await import("./drama");
      try {
        const plates = await dr.makePlates(org);
        return { text: `I made ${plates.length} character plates of you: ${plates.map((p) => p.label.toLowerCase()).join(", ")}. Every shot with you now names the plate it uses. They're on my Cast tab.`, cards: [], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "make_episode": {
      const dr = await import("./drama");
      const eps = db.listDramaEpisodes(org).filter((e) => e.kind === "drama");
      const ep = (d.count ? eps.find((e) => e.number === d.count) : null) ?? eps.find((e) => e.status === "script" || e.status === "failed");
      if (!ep) return { text: eps.length ? "Every episode I wrote is made. Want me to write the next ones?" : "There are no episodes yet. Tell me about the story and I'll write them.", cards: [], queries: [] };
      try {
        const started = await dr.startEpisode(org, ep.id);
        const v = dr.episodeView(started);
        return { text: v.plan.approved ? `Making episode ${ep.number}, "${ep.title}." That's ${v.shots.length} shots, ${v.cost}. I'll post it here when it's cut.` : `Making the keyframes for episode ${ep.number}, "${ep.title}": one still for each of the ${v.shots.length} shots. You'll approve them before anything is animated.`, cards: [{ type: "drama_keyframes", id: ep.id, title: ep.title }], queries: [] };
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
    }
    case "avatar_script": {
      const av = await import("./avatar");
      const words = (d.message || d.notes || "").trim();
      if (!words) return { text: "What should the video say? Give me the topic and I'll write it.", cards: [], queries: [] };
      const v = await av.draft(org, { title: d.title || "Video", script: words });
      const pics = await av.photos(org);
      const photo = pics.find((p) => p.id === v.imageId);
      const secs = Math.round(av.estimateTenths(v.script) / 10);
      const text = photo
        ? `Here's the script. It's about ${secs} seconds in your voice, using "${photo.title}" from the Brain. Read it over, then press Make it.`
        : `Here's the script, about ${secs} seconds. I need a photo of you to make it: attach one here with the paperclip, facing the camera in good light, and I'll save it to the Brain.`;
      return { text, cards: [{ type: "avatar_video", id: v.id, title: v.title }], queries: [] };
    }
    case "make_avatar": {
      const av = await import("./avatar");
      const t = d.target.trim().toLowerCase();
      const all = db.listAvatarVideos(org, 50);
      const v = (t ? all.find((x) => x.title.toLowerCase().includes(t) && x.status !== "making") : null) ?? all.find((x) => x.status === "draft" || x.status === "failed") ?? all[0];
      if (!v) return { text: "There's no script yet. Tell me what the video should be about and I'll write it.", cards: [], queries: [] };
      try {
        const made = await av.make(org, v.id);
        return { text: `Making "${made.title}" now. It usually takes 3 to 8 minutes, and I'll post it here when it's done.`, cards: [{ type: "avatar_video", id: made.id, title: made.title }], queries: [] };
      } catch (err) {
        return { text: `I couldn't start it: ${err instanceof Error ? err.message : String(err)}`, cards: [{ type: "avatar_video", id: v.id, title: v.title }], queries: [] };
      }
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
      if (!r) return { text: "I don't have notes from a meeting like that yet. I only have notes from meetings Avery sat in on.", cards: [], queries: [] };
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
      const who = emp.kind === "inbox" ? "I'll" : "Avery will";
      return { text: choice === "join" ? (next.status === "scheduled" ? `${who} sit in on ${r.title}.` : `${who} sit in on ${r.title} once it's close enough to book.`) : `${who} skip ${r.title}.`, cards: [], queries: [] };
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
      if (emp.kind === "platform") {
        const o = await (await import("./platform")).overview(org);
        const open = o.findings.filter((f) => f.status === "open");
        const fixed = o.findings.filter((f) => f.status === "fixed");
        const text = !o.login
          ? "I can't get into the LeadDash platform yet. Add it on Integrations under Website logins, locked to the LeadDash sub-account."
          : o.auditing
            ? "I'm reading your workflows now. I'll post what I find when I'm done."
            : o.auditedAt
              ? `${plural(open.length, "workflow")} ${open.length === 1 ? "needs" : "need"} fixing and I've fixed ${fixed.length}. My last audit read ${plural(o.workflows.length, "workflow")}.`
              : "I haven't audited your workflows yet. Say the word and I'll start.";
        return { text, cards: open.length ? [{ type: "platform_findings", id: 0, title: "Still to fix" }] : [], queries: [] };
      }
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
    case "ads_campaign":
    case "ads_note":
    case "ads_rewrite":
    case "ads_approve":
    case "ads_skip":
    case "ads_platform":
    case "ads_status": {
      return adsAction(emp, d, { id: ctx.userId ?? 0, name: who });
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
    case "site_audit": {
      const sw = await import("./siteWork");
      const text = await sw.startSiteAudit(emp, { url: d.url, about: d.topic || d.page || d.title, audience: d.target, said: [ctx.said, d.notes].filter(Boolean).join("\n"), html: sw.htmlFiles(files) });
      return { text, cards: [], queries: [] };
    }
    case "mockup_site": {
      const sw = await import("./siteWork");
      const photos = files.filter((f) => f.kind === "image").map((f) => ({ url: pages.publicLink(org, f.fileUrl), text: f.text, name: f.name }));
      try {
        const r = await sw.startSiteMockup(emp, { url: d.url, about: d.topic || d.page || d.title, said: ctx.said ?? "", notes: d.notes, pageType: /landing/i.test(d.target) ? "landing" : "website", html: sw.htmlFiles(files), photos, useAudit: /audit/i.test(d.focus) || !!sw.latestAudit(org, emp.id) && !/without|ignore|skip/i.test(`${d.focus} ${ctx.said ?? ""}`) });
        return { text: r.text, cards: [], queries: [], refs: r.pageId ? [{ kind: "page", id: r.pageId }] : [] };
      } catch (err) {
        return { text: `${err instanceof Error ? err.message : String(err)}. Attach the page's HTML file here and I'll build from that.`, cards: [], queries: [] };
      }
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
    case "check_schedule": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { text: "Which day should I check?", cards: [], queries: [] };
      const cal = await import("./calendars");
      const days = Math.max(1, Math.min(14, d.count || 1));
      try {
        const r = await cal.scheduleReply(org, d.date, days);
        if (!r.events.length) return { text: r.text, cards: [], queries: [] };
        const clashing = new Set((r.clash ?? []).flat());
        const events = r.events.slice(0, 40).map((e) => ({ when: cal.whenText(e, r.tz), day: days > 1 ? e.start.toLocaleDateString("en-US", { timeZone: r.tz, weekday: "short", month: "short", day: "numeric", year: "numeric" }) : undefined, title: e.title, calendar: e.calendar, color: e.color, clash: clashing.has(e) }));
        return { text: r.text, cards: [{ type: "schedule", id: Date.now(), title: "Schedule", events }], queries: [] };
      } catch (err) {
        return { text: `I couldn't read your calendars: ${err instanceof Error ? err.message : String(err)}`, cards: [], queries: [] };
      }
    }
    case "calendar_hold": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { text: "What day should it go on? Tell me the date and time.", cards: [], queries: [] };
      const cal = await import("./calendars");
      const pick = cal.holdCalendarFor(org, d.target || "");
      if (pick.refused) return { text: pick.refused.kind === "link" ? `I can read ${pick.refused.name} but can't add to it. Want it on another calendar?` : `${pick.refused.name} is set to never take holds. Want it on another calendar, or change that on Integrations?`, cards: [], queries: [] };
      const time = d.time || "9:00 AM";
      const wantsZoom = d.focus.toLowerCase() === "zoom" || /\bzoom\b/i.test(`${d.title} ${d.notes}`);
      // The same meeting asked for again (same day, time and guests) isn't booked twice.
      const same = findHold(await db.listOutboundItemsByOrg(org, "calendar_hold"), { date: d.date, time, attendees: d.attendees || "" });
      if (same) {
        const integ = await import("../integrations");
        const r = await integ.meetingOnHold(org, same, wantsZoom ? "zoom" : "any").catch((err) => ({ text: `I couldn't get the link: ${err instanceof Error ? err.message : String(err)}`, url: null }));
        return { text: `That's the same meeting as "${same.title}", so I didn't book it twice. ${r.text}`, cards: [], queries: [] };
      }
      const h = await tasks.createCalendarHold(org, { title: d.title || "Meeting", date: d.date, time, attendees: d.attendees || "", agenda: d.notes || "", linkId: pick.link?.id ?? null, video: wantsZoom ? "zoom" : null });
      const when = new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      // Is that hour open on every calendar?
      let check = "";
      try {
        const orgRow = await db.getOrganizationById(org);
        const tz = orgRow?.timezone || "America/Chicago";
        const local = (await import("../integrations")).toLocalDateTime(d.date, time);
        if (local) {
          const [Y, M, D] = local.slice(0, 10).split("-").map(Number);
          const [hh, mm] = local.slice(11, 16).split(":").map(Number);
          const start = (await import("./schedule")).zonedToUtc(Y, M, D, hh, mm, tz);
          const f = await cal.freeAt(org, start);
          if (f.sources > 1 && f.open) check = `${when} at ${time} is open on all your calendars. `;
          else if (f.sources && f.open) check = `${when} at ${time} is open. `;
          else if (f.busy.length) check = `Heads up: ${when} at ${time} overlaps ${f.busy[0].title === "Busy" ? "a busy block" : f.busy[0].title} on ${f.busy[0].calendar}. `;
        }
      } catch {
        /* the hold still goes to Approvals */
      }
      const where = pick.link?.name ?? "your Google Calendar";
      return {
        text: `${check}The hold for ${where} is waiting for your OK in Approvals.`,
        cards: [{ type: "reply", id: h.id, title: h.title, subtitle: `${when} at ${time} · ${where}`, body: d.attendees ? `With ${d.attendees}` : "" }],
        queries: [],
      };
    }
    case "slide_notes":
    case "slide_picture":
    case "slide_graphic": {
      const talk = await import("./talk");
      const deck = talk.latestDeck(org, emp.id);
      if (!deck) return { text: "I haven't built slides yet. Say \"build the slides\" and I'll make them from the script.", cards: [], queries: [] };
      const n = Math.round(d.count ?? 0);
      if (!(n >= 1)) return { text: "Which slide? Tell me the number.", cards: [], queries: [] };
      try {
        if (d.action === "slide_notes") await talk.setSlideNotes(org, deck.id, n - 1, d.notes, d.focus.toLowerCase() === "replace" ? "replace" : "add");
        else if (d.action === "slide_graphic") await talk.newSlideGraphic(org, deck.id, n - 1, d.notes, d.focus);
        else await talk.newSlidePicture(org, deck.id, n - 1, d.notes, /illustrat/i.test(d.focus) ? "illustration" : /photo/i.test(d.focus) ? "photo" : undefined);
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
      }
      const fresh = (await talk.showLatest(emp, "slides"))!;
      const after = d.action === "slide_graphic" ? talk.slideKindName(org, deck.id, n - 1) : "";
      return {
        text:
          d.action === "slide_notes"
            ? `Done. The presenter notes on slide ${n} are updated, in the deck below and the PowerPoint file.`
            : d.action === "slide_graphic"
              ? `Done. Slide ${n} is ${after} now, built in your colors so you can edit it in PowerPoint. The deck below and the PowerPoint file are updated.`
              : `Done. Slide ${n} has a new picture${d.notes ? `: ${d.notes.replace(/\.$/, "")}` : ""}. The deck below and the PowerPoint file are updated.`,
        cards: [fresh.card],
        queries: [],
      };
    }
    case "show_talk": {
      const talk = await import("./talk");
      const r = await talk.showLatest(emp, d.focus.toLowerCase().includes("slide") ? "slides" : "script");
      if (!r) return { text: d.focus.toLowerCase().includes("slide") ? "I haven't built slides yet. Say \"build the slides\" and I'll make them from the script." : "I haven't written a script yet. Say \"write the script\" and tell me how long the talk is.", cards: [], queries: [] };
      return { text: r.text, cards: [r.card], queries: [] };
    }
    case "write_talk": {
      const talk = await import("./talk");
      // Asked to see it, not for a new one: show the script that's already there.
      if (talk.wantsToSee(ctx.said ?? "")) {
        const shown = await talk.showLatest(emp, "script");
        if (shown) return { text: shown.text, cards: [shown.card], queries: [] };
      }
      const mins = await talk.talkMinutes(org, d.title, talk.userLines(ctx.history, ctx.said ?? ""), d.count ?? 0);
      if (!(mins > 0)) return { text: "How long is the talk? I'll time the script to it.", cards: [], queries: [], choices: ["45 minutes", "60 minutes", "90 minutes"] };
      const r = talk.startTalkScript(emp, { title: d.title, minutes: mins, notes: d.notes, said: ctx.said ?? "" });
      return { text: r.text, cards: [], queries: [] };
    }
    case "write_slides": {
      const talk = await import("./talk");
      if (talk.wantsToSee(ctx.said ?? "")) {
        const shown = await talk.showLatest(emp, "slides");
        if (shown) return { text: shown.text, cards: [shown.card], queries: [] };
      }
      const r = talk.startSlides(emp, { title: d.title, notes: d.notes, said: ctx.said ?? "" });
      return { text: r.text, cards: [], queries: [] };
    }
    case "meeting_link": {
      const holds = (await db.listOutboundItemsByOrg(org, "calendar_hold")).filter((i) => i.status !== "cancelled");
      const words = d.target.toLowerCase().split(/[^a-z0-9@.]+/).filter((w) => w.length > 2);
      const metaOf = (i: (typeof holds)[number]) => JSON.parse(i.metadata || "{}") as { date?: string; attendees?: string[] };
      const scored = holds
        .map((i) => {
          const m = metaOf(i);
          const hay = `${i.title} ${(m.attendees ?? []).join(" ")}`.toLowerCase();
          return { i, score: words.filter((w) => hay.includes(w)).length + (d.date && m.date === d.date ? 3 : 0) };
        })
        .sort((a, b) => b.score - a.score || b.i.id - a.i.id);
      const hit = scored[0] && (scored[0].score > 0 || (!words.length && !d.date)) ? scored[0].i : null;
      if (!hit) return { text: "I don't see a meeting I booked that matches. Which one do you mean?", cards: [], queries: [] };
      const integ = await import("../integrations");
      try {
        const r = await integ.meetingOnHold(org, hit, d.focus.toLowerCase() === "zoom" ? "zoom" : "any");
        return { text: r.text, cards: [], queries: [] };
      } catch (err) {
        return { text: `I couldn't change "${hit.title}": ${err instanceof Error ? err.message : String(err)}`, cards: [], queries: [] };
      }
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

/** A hold already booked for the same day, time and guests (or the same day and time with no guests on either). */
export function findHold(holds: OutboundItem[], want: { date: string; time: string; attendees: string }) {
  const norm = (t: string) => t.replace(/\s+/g, "").toUpperCase();
  const people = want.attendees.toLowerCase().split(",").map((a) => a.trim()).filter(Boolean);
  return (
    holds.find((i) => {
      if (i.status === "cancelled") return false;
      const m = JSON.parse(i.metadata || "{}") as { date?: string; time?: string; attendees?: string[] };
      if (m.date !== want.date || norm(m.time ?? "") !== norm(want.time)) return false;
      const theirs = (m.attendees ?? []).map((a) => a.toLowerCase());
      return people.length === 0 && theirs.length === 0 ? true : people.some((p) => theirs.some((t) => t.includes(p) || p.includes(t)));
    }) ?? null
  );
}

/** Actions that only talk about the work; a project task needs one that does it. */
const NOT_WORK = new Set(["task_find", "task_due", "task_lists", "task_undo", "none", "report", "check_status", "ads_status", "ads_note", "ads_approve", "ads_skip", "ask_teammate", "add_guideline", "start_onboarding", "close_item", "sat_in_notes", "join_or_skip", "save_files", "add_file", "restore_answer", "ask_layout", "restore_page"]);

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
Apps connected on Integrations are reached through their own actions, never the browser. Tasks live in Projects in this app: use task_lists or task_find to see them and task_add or task_change to work them. If the task means reading someone's email or signing in to an account you can't reach with your actions (like checking whether an invite arrived), choose "none" and say who needs to check it. Never ask for a password or try to sign in to someone's account.
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
  if (emp.kind === "speaking") {
    const t = (await import("./talk")).talkInProgress(orgId);
    if (t) return { busy: true, what: `Working on ${t}` };
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

/** A live one-on-one: the person talks and the reply is read out loud. */
export const ONE_ON_ONE = `This is a live one-on-one meeting: the person is talking to you out loud and your "reply" is read aloud in your voice.
- Keep "reply" to 1 to 3 short spoken sentences, like a colleague across the table. No lists, headings, markdown, links, emojis or em dashes.
- Their words come from speech-to-text, so read past small transcription mistakes and odd spellings of names.
- You can still take actions: say the headline out loud and let the card under your message hold the details.
- If they agree to something or ask you to do something later, say so plainly ("I'll have it to you Wednesday"); the meeting notes turn it into a task.`;

/** Chat words made easy to listen to: no markdown, links or lists, and not too long. */
export function spokenText(content: string) {
  let t = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/([.!?:,;])?[ \t]*\n+\s*/g, (_m, p: string | undefined) => (p ? `${p} ` : ". "))
    .replace(/\s{2,}/g, " ")
    .trim();
  if (t.length > 700) {
    const cut = t.slice(0, 700);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = `${end > 200 ? cut.slice(0, end + 1) : cut} The rest is in the chat.`;
  }
  return t;
}

export async function sendChatMessage(opts: {
  organizationId: number;
  employeeId: number;
  text: string;
  authorName: string;
  userId: number | null;
  attachmentIds?: number[];
  /** Said out loud in a one-on-one: the reply is kept short and conversational, and is played. */
  spoken?: boolean;
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
    spoken: !!opts.spoken,
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
      spoken: !!opts.spoken,
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
Never ask the person for a password or login in chat; sign-ins are saved on Integrations.${await connectedFacts(emp)}${historyFacts(emp.organizationId)}${await webFacts(emp)}${await bidprimeFacts(emp)}${await applyFacts(emp)}${await leadershipFacts(emp)}${await teamFacts(emp)}
${scheduled ? "This message comes from a scheduled task: never ask a question and leave choices empty; do the job." : `${TALK}${TALK_BY_KIND[emp.kind] ? `\n${TALK_BY_KIND[emp.kind]}` : ""}\n${REMEMBER}`}${opts.spoken ? `\n${ONE_ON_ONE}` : ""}${filesText(files)}
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
    // Something new and lasting: saved to the Brain so nobody has to be told twice.
    let learned = "";
    if (!scheduled && decision.remember_topic?.trim() && decision.remember_fact?.trim()) {
      const r = await learnFact(opts.organizationId, { topic: decision.remember_topic, fact: decision.remember_fact, category: decision.remember_category, who: opts.authorName, via: emp.name }).catch(() => null);
      if (r) learned = `\n\n${r.replaced ? "Updated the Brain" : "Saved to the Brain"} for the whole team: ${r.fact}`;
    }

    if (!decision.action || decision.action === "none" || !actions.includes(decision.action)) {
      return { user: userMsg, reply: await reply(`${decision.reply || "Could you say a bit more about what you need?"}${learned}`, quick(decision.choices)) };
    }
    const result = await runAction(emp, decision, { who: opts.authorName, files: sent.length ? sent : files, history, said: opts.text, userId: opts.userId ?? null });
    const cards = [...result.cards, ...quick(result.choices ?? decision.choices)];
    return { user: userMsg, reply: await reply(`${result.text || decision.reply}${learned}`, cards, result.queries) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] ${emp.name} failed:`, message);
    return { user: userMsg, reply: await reply(`I couldn't do that. ${message}`) };
  }
}


/** Reese's work from chat: the brief becomes a campaign; approvals, notes and rewrites move the open set along. */
async function adsAction(emp: AIEmployee, d: Decision, me: { id: number; name: string }): Promise<ActionResult> {
  const ads = await import("./ads");
  const org = emp.organizationId;
  const none = { cards: [] as ChatCard[], queries: [] as string[] };
  const current = ads.currentCampaign(org);
  const platformNamed = (text: string) => ads.platformFromWords(text).filter((p) => !/\b(all|every)\b/i.test(text))[0] ?? null;
  const openSet = (c: import("../db").AdCampaignRow | null, named: string) => {
    if (!c) return null;
    const p = platformNamed(named) ?? (c.currentPlatform as import("../../drizzle/schema").AdPlatform | null);
    const sets = db.ads.sets(c.id).filter((s) => s.status !== "replaced");
    return (p ? sets.filter((s) => s.platform === p).slice(-1)[0] : null) ?? sets.filter((s) => s.status === "review").slice(-1)[0] ?? null;
  };
  switch (d.action) {
    case "ads_campaign": {
      const platforms = ads.platformFromWords(d.notes || "all");
      const budgetCents = Math.round((Number(d.count) || 0) * 100);
      const c = await ads.createCampaign(org, me, {
        name: d.title || d.goal || "New campaign",
        goal: d.goal,
        audience: d.target,
        page: d.url,
        platforms: platforms.length ? platforms : ads.ORDER,
        budgetCents,
        startDate: ads.dateIn(d.date),
        endDate: ads.dateIn(d.time),
      }, { quiet: true });
      const v = ads.campaignView(c);
      const left = v.rows.filter((r) => r.leftOut);
      const text = `Here is the split for ${v.budget}${v.days ? ` over ${v.days} days` : ""}.${left.length ? ` ${left.map((r) => r.name).join(" and ")} ${left.length === 1 ? "is" : "are"} left out: ${(v.leftOutWhy || "they reach neighbors, not this audience").replace(/\.$/, "")}.` : ""} Use it, change it, or split it evenly, and I start writing.`;
      return { text, cards: [{ type: "ad_budget", id: c.id, title: c.name }], queries: [] };
    }
    case "ads_note": {
      if (!current) return { text: "There's no campaign open yet. Tell me the goal, who it's for, the page and the budget and I'll start one.", ...none };
      ads.addNote(org, current.id, d.notes);
      const names = ads.platformsOf(current).map((p) => ads.PLATFORM[p].name);
      return { text: `Noted for the rest of the set: ${d.notes.trim().replace(/\.$/, "")}. It applies to every platform I write from here${names.length ? "" : ""}.`, ...none };
    }
    case "ads_rewrite": {
      const s = openSet(current, d.target);
      if (!s || !current) return { text: "There's no set in front of you to rewrite right now.", ...none };
      await ads.rewriteSet(org, me, s.id, d.notes);
      return { text: `Writing another ${ads.PLATFORM[s.platform].name} version${d.notes.trim() ? ` with that in mind` : ""}. It lands here in a moment.`, ...none };
    }
    case "ads_approve": {
      const s = openSet(current, d.target);
      if (!s || !current) return { text: "Nothing is waiting for your approval right now.", ...none };
      if (s.status !== "review") return { text: `The ${ads.PLATFORM[s.platform].name} set is already ${s.status}.`, ...none };
      await ads.approveSet(org, me, s.id);
      return { text: `${ads.PLATFORM[s.platform].name} approved.`, ...none };
    }
    case "ads_skip": {
      const s = openSet(current, d.target);
      if (!s || !current) return { text: "Nothing is waiting right now.", ...none };
      if (s.status !== "review") return { text: `The ${ads.PLATFORM[s.platform].name} set is already ${s.status}.`, ...none };
      await ads.skipSet(org, me, s.id);
      return { text: `${ads.PLATFORM[s.platform].name} skipped.`, ...none };
    }
    case "ads_platform": {
      const p = platformNamed(d.target);
      if (!p || !current) return { text: "Which platform, and for which campaign?", ...none };
      await ads.writePlatform(org, current.id, p);
      return { text: `Writing ${ads.PLATFORM[p].name} for ${current.name} now.`, ...none };
    }
    case "ads_status": {
      const all = db.ads.campaigns(org);
      if (!all.length) return { text: "No campaigns yet. Tell me the goal, who it's for, the page and the budget and I'll start one.", ...none };
      const lines = all.slice(0, 6).map((c) => {
        const v = ads.campaignView(c);
        const waiting = v.rows.find((r) => r.set?.status === "review");
        return `${v.name}: ${v.counts.approved} of ${v.counts.platforms} approved${waiting ? `, ${waiting.name} waiting for you` : v.status === "writing" ? ", writing" : v.status === "budget" ? ", the split waits for you" : v.status === "done" ? ", finished" : ""}.`;
      });
      return { text: lines.join("\n"), ...none };
    }
  }
  return { text: d.reply, ...none };
}

/** Projects and Goals from chat, for every employee. */
async function projectsAction(emp: AIEmployee, d: Decision, who: string): Promise<ActionResult> {
  const org = emp.organizationId;
  const pj = await import("../work/projects");
  const g = await import("../work/goals");
  const by = { type: "employee" as const, id: emp.id, name: emp.name };
  // An employee sees the lists that aren't private, and private ones shared with it.
  const me = { kind: "employee" as const, employeeId: emp.id, name: emp.name };
  const people = await g.owners(org);
  const findOwner = (name: string) => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    if (n === "me" || n === "myself") return people.find((p) => p.type === "employee" && p.id === emp.id) ?? null;
    return people.find((p) => p.name.toLowerCase() === n) ?? people.find((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]) ?? null;
  };
  const fmt = (ymd: string) => g.fmtDay(ymd);
  try {
    const statusNamed = (list: { statuses: string }, want: string) => {
      const w = want.trim().toLowerCase();
      const st = pj.statusesOf(list);
      if (!w) return null;
      if (/^(done|complete|completed|close|closed|finished)$/.test(w)) return st.find((x) => x.type === "done") ?? st.find((x) => x.type === "closed") ?? null;
      if (/^(open|reopen|to do|todo|not started)$/.test(w)) return st.find((x) => x.type === "open") ?? st[0] ?? null;
      return st.find((x) => x.name === w) ?? st.find((x) => x.name.includes(w)) ?? null;
    };
    const today = g.todayYmd(await g.zoneOf(org));
    if (d.action === "task_due") {
      const days = Number(d.count) || 7;
      const by = pj.addDaysYmd(today, days);
      const list = pj.find(org, { who: d.target, dueBy: by }, me).filter((t) => t.due !== "no due date");
      if (!list.length) return { text: `Nothing is due in Projects${d.target ? ` for ${d.target}` : ""} in the next ${days} days.`, cards: [], queries: [] };
      const late = list.filter((t) => (db.work.tasks.get(org, t.id)?.dueDate ?? "9999") < today);
      const order = [...late, ...list.filter((t) => !late.includes(t))];
      return {
        text: `${list.length} open task${list.length === 1 ? "" : "s"} in Projects${d.target ? ` for ${d.target}` : ""} due in the next ${days} days${late.length ? `, ${late.length} overdue` : ""}:\n${order.slice(0, 15).map((t) => `- ${t.name} (${t.assignees.join(", ") || "no one assigned"}, ${late.includes(t) ? "overdue since " : "due "}${t.due}, ${t.list})`).join("\n")}${list.length > 15 ? `\nand ${list.length - 15} more in Projects.` : ""}`,
        cards: [],
        queries: [],
        choices: late.length ? ["Remind them", "Add a task", "Just the overdue ones"] : ["Add a task", "Look 2 weeks ahead"],
      };
    }
    if (d.action === "task_lists") {
      const acc = await import("../work/pjAccess");
      const lists = acc.visibleLists(org, me).map((x) => x.list);
      const folders = db.work.folders.all(org);
      if (!lists.length) return { text: "Projects is empty so far. Say what to add and I'll make the first list.", cards: [], queries: [] };
      const byFolder = new Map<string, string[]>();
      for (const f of folders) if (lists.some((l) => l.folderId === f.id)) byFolder.set(f.name, []);
      for (const l of lists) {
        const f = folders.find((x) => x.id === l.folderId)?.name ?? "No folder";
        byFolder.set(f, [...(byFolder.get(f) ?? []), l.name]);
      }
      return { text: `Here's Projects:\n${Array.from(byFolder.entries()).map(([f, ls]) => `- ${f}: ${ls.join(", ")}`).join("\n")}`, cards: [], queries: [], choices: ["What's due this week?", "Add a task"] };
    }
    if (d.action === "task_bulk") {
      const goal = d.goal.trim().toLowerCase();
      const overdue = goal === "overdue" || (!goal && !d.target.trim() && !d.to.trim());
      const dueBefore = /^\d{4}-\d{2}-\d{2}$/.test(goal) ? goal : overdue ? pj.addDaysYmd(today, -1) : undefined;
      const status = d.focus.trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : "";
      if (!status && !date) return { text: "What should I change on them: mark them done, or move the due date?", cards: [], queries: [], choices: ["Mark them done", "Move to next Friday"] };
      const hits = pj.find(org, { words: d.target, who: d.to, dueBy: dueBefore }, me).filter((t) => !dueBefore || t.due !== "no due date").slice(0, 500);
      if (!hits.length) return { text: `I didn't find any open tasks in Projects that fit${overdue ? " and are past due" : ""}.`, cards: [], queries: [] };
      const closing = /^(done|complete|completed|close|closed|finished)$/i.test(status);
      const changed: number[] = [];
      const failed: string[] = [];
      for (const h of hits) {
        const t = db.work.tasks.get(org, h.id);
        if (!t) continue;
        const list = db.work.lists.get(org, t.listId)!;
        const patch: Parameters<typeof pj.updateTask>[2] = {};
        if (status) {
          const st = statusNamed(list, status);
          if (!st) {
            failed.push(`${t.name} (${list.name} has no "${status}" status)`);
            continue;
          }
          patch.status = st.name;
        }
        if (date) patch.dueDate = date;
        await pj.updateTask(org, t.id, patch, by, { quiet: true });
        changed.push(t.id);
      }
      const what = [status ? (closing ? "closed" : `set to ${status}`) : "", date ? `moved to ${fmt(date)}` : ""].filter(Boolean).join(" and ");
      const lines = [`Done: ${what} ${changed.length} ${overdue ? "overdue " : ""}task${changed.length === 1 ? "" : "s"} in Projects.`];
      if (failed.length) lines.push(`${failed.length} didn't change:\n${failed.slice(0, 8).map((f) => `- ${f}`).join("\n")}`);
      const cards: ChatCard[] = closing && changed.length ? [{ ...choicesCard(["Reopen them", "What's still open?"]), undo: changed.map(String) }] : [choicesCard(["What's still open?"])];
      return { text: lines.join("\n\n"), cards, queries: [] };
    }
    if (d.action === "task_undo") {
      const last = (await db.listChatMessages(org, emp.id, 40)).reverse().find((m) => m.role === "employee" && parseList<ChatCard>(m.cards).some((c) => c.undo?.length));
      const ids = last ? parseList<ChatCard>(last.cards).find((c) => c.undo?.length)!.undo!.map(Number) : [];
      if (!ids.length) return { text: "I don't have a recent batch of closed tasks to reopen.", cards: [], queries: [] };
      let n = 0;
      for (const id of ids) {
        const t = db.work.tasks.get(org, id);
        if (!t) continue;
        const st = statusNamed(db.work.lists.get(org, t.listId)!, "open");
        if (!st) continue;
        await pj.updateTask(org, t.id, { status: st.name }, by, { quiet: true });
        n++;
      }
      return { text: `Reopened ${n} task${n === 1 ? "" : "s"} in Projects.`, cards: [], queries: [] };
    }
    if (d.action === "task_find") {
      const list = pj.find(org, { words: d.target, who: d.to, dueBy: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : undefined, includeDone: d.focus.toLowerCase() === "all" }, me);
      if (!list.length) return { text: "I didn't find any tasks like that in Projects.", cards: [], queries: [] };
      return { text: `${list.length} task${list.length === 1 ? "" : "s"} in Projects:\n${list.slice(0, 20).map((t) => `- ${t.name} (${t.list}; ${t.assignees.join(", ") || "no one assigned"}; ${t.status}; due ${t.due})`).join("\n")}`, cards: [], queries: [] };
    }
    if (d.action === "task_add") {
      if (!d.title.trim()) return { text: "What should the task say?", cards: [], queries: [] };
      const acc = await import("../work/pjAccess");
      let list = pj.listNamed(org, d.page, me) ?? acc.visibleLists(org, me).map((x) => x.list).sort((a, b) => b.id - a.id)[0] ?? null;
      if (!list) list = pj.saveList(org, { name: "Tasks", folderId: null });
      const o = findOwner(d.to);
      const t = await pj.createTask(org, { listId: list.id, name: d.title, description: d.notes, dueDate: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null, assignees: o ? [{ type: o.type, id: o.id, name: o.name }] : [] }, by);
      return { text: `Added "${t.name}" to ${list.name} in Projects${o ? ` for ${o.name}` : ""}${t.dueDate ? `, due ${fmt(t.dueDate)}` : ""}.${d.to && !o ? ` I couldn't find ${d.to} on the team, so it's unassigned.` : ""}`, cards: [], queries: [] };
    }
    if (d.action === "task_change") {
      const hits = pj.find(org, { words: d.target, includeDone: true }, me);
      if (!hits.length) return { text: `I couldn't find a task like "${d.target}" in Projects.`, cards: [], queries: [] };
      if (hits.length > 1 && !hits.some((h) => h.name.toLowerCase() === d.target.toLowerCase())) return { text: `Which one?\n${hits.slice(0, 8).map((h) => `- ${h.name} (${h.list})`).join("\n")}`, cards: [], queries: [] };
      const hit = hits.find((h) => h.name.toLowerCase() === d.target.toLowerCase()) ?? hits[0];
      const t = db.work.tasks.get(org, hit.id)!;
      const list = db.work.lists.get(org, t.listId)!;
      const patch: Parameters<typeof pj.updateTask>[2] = {};
      if (d.focus.trim()) {
        const want = d.focus.trim().toLowerCase();
        const st = pj.statusesOf(list);
        const s = st.find((x) => x.name === want) ?? (/done|complete|finish/.test(want) ? st.find((x) => x.type === "done") : null) ?? st.find((x) => x.name.includes(want));
        if (!s) return { text: `${list.name} has these statuses: ${st.map((x) => x.name).join(", ")}. Which one?`, cards: [], queries: [] };
        patch.status = s.name;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(d.date)) patch.dueDate = d.date;
      if (d.to.trim()) {
        const o = findOwner(d.to);
        if (!o) return { text: `I couldn't find ${d.to} on the team.`, cards: [], queries: [] };
        const cur = pj.parse<{ type: "user" | "employee" | "name"; id: number; name: string }[]>(t.assignees, []);
        if (!cur.some((a) => a.type === o.type && a.id === o.id)) patch.assignees = [...cur, { type: o.type, id: o.id, name: o.name }];
      }
      await pj.updateTask(org, t.id, patch, by);
      if (d.notes.trim()) await pj.comment(org, t.id, d.notes, by);
      const said = [patch.status && `moved it to ${patch.status}`, patch.dueDate && `set the due date to ${fmt(patch.dueDate)}`, patch.assignees && `assigned ${d.to}`, d.notes.trim() && "added your comment"].filter(Boolean);
      return { text: `Done: "${t.name}"${said.length ? `, ${said.join(", ")}` : ""}.`, cards: [], queries: [] };
    }
    // goal_update
    const goals = db.work.goals.all(org).filter((x) => x.state === "active");
    const words = d.target.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const goal = goals.find((x) => x.title.toLowerCase() === d.target.toLowerCase()) ?? goals.find((x) => words.length > 0 && words.every((w) => x.title.toLowerCase().includes(w))) ?? goals.find((x) => words.some((w) => x.title.toLowerCase().includes(w)));
    if (!goal) return { text: goals.length ? `Which goal? ${goals.slice(0, 8).map((x) => x.title).join("; ")}.` : "There are no goals on the Goals page yet.", cards: [], queries: [] };
    const status = (["on", "risk", "off"] as const).find((x) => x === d.focus.trim().toLowerCase()) ?? null;
    g.addUpdate(org, goal.id, { authorType: "employee", authorId: emp.id, authorName: emp.name, status, body: d.notes || d.reply || `Update from ${who}` });
    const main = db.work.targets.where(org, "goalId", goal.id).find((x) => x.kind === "number" || x.kind === "currency");
    const n = d.count ?? 0;
    if (main && n > 0) g.setTargetValue(org, main.id, n);
    return { text: `Posted the update on "${goal.title}"${main && n > 0 ? ` and set ${main.name} to ${n.toLocaleString("en-US")}` : ""}.`, cards: [], queries: [] };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), cards: [], queries: [] };
  }
}
