import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, ChatMessage } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as tasks from "./tasks";
import * as apply from "./apply";
import * as hiring from "./hiring";
import { writeReport } from "./onboarding";
import type { Opportunity, OppKind } from "../../drizzle/schema";
import { channelName, planSchedule, postNow, type Plan } from "../social";
import * as sales from "./sales";
import { askTeammate, gate } from "./team";

/**
 * Chat with an employee. Each message is answered in two steps:
 * 1. The employee reads the conversation and decides whether the message asks
 *    it to do its job now (find grants, write a post...) or just to talk.
 * 2. If there is a job, the server runs it with the same task code the Work
 *    tabs use, and the reply carries cards for whatever was created.
 */

export type ChatCard = {
  type: "opportunity" | "application" | "question" | "submitted" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate" | "schedule_plan" | "prospect_sales";
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
  grants: ["none", "report", "find_grants", "add_link", "apply", "find_and_apply", "check_status", "ask_teammate"],
  speaking: ["none", "report", "find_events", "add_link", "apply", "find_and_apply", "check_status", "ask_teammate"],
  video: ["none", "report", "find_videos", "ask_teammate"],
  social: ["none", "report", "write_post", "schedule_posts", "ask_teammate"],
  blog: ["none", "report", "write_article", "ask_teammate"],
  website: ["none", "report", "plan_page", "ask_teammate"],
  inbox: ["none", "report", "draft_reply", "write_email", "calendar_hold", "ask_teammate"],
  hiring: ["none", "report", "find_people", "write_job_post", "check_status", "ask_teammate"],
  prospecting: ["none", "report", "find_prospects", "start_outreach", "check_status", "ask_teammate"],
  outreach: ["none", "report", "start_outreach", "check_status", "ask_teammate"],
  leads: ["none", "report", "check_status", "ask_teammate"],
  custom: ["none", "report", "ask_teammate"],
};

const ACTION_HELP: Record<string, string> = {
  ask_teammate: "ask_teammate: the person asks you to check with another employee (\"ask Theo what he published\", \"how many demos does Malik have\"). Put that employee's name or job in `teammate` and the question in `message`.",
  find_prospects: "find_prospects: search the web now for businesses (or referral partners) that fit. Put any area, type or size the person gave in `focus`.",
  start_outreach: "start_outreach: pass prospects to outreach so email sequences start. Put a prospect's name in `target`, or '' for every new prospect scoring 70 or higher.",
  write_email: "write_email: the person wants a NEW email sent to someone (not a reply to a pasted message). Put the email address in `to`, the person's name if given in `from`, and everything the email should say or ask, with exact dates and times written out (for example Friday, October 2, 2026 at 3:00 PM), in `message`. It waits for their approval, then sends from their connected Gmail.",
  calendar_hold: "calendar_hold: the person wants a meeting or hold on their calendar. Put a short title in `title`, the date as YYYY-MM-DD in `date`, the start time like 3:00 PM in `time`, attendee emails comma-separated in `attendees`, and the agenda in `notes`. It waits for their approval, then goes on their connected Google Calendar.",
  report: "report: the person (or a scheduled task) asks for a report, summary or update on your work. Put what they want covered in `notes`.",
  find_people: "find_people: search the web for professionals to reach out to for an open role. Put the role or any focus (city, license, specialty) in `focus`.",
  write_job_post: "write_job_post: write or rewrite the job post for a role. Put the role title in `target` ('' for the newest open role).",
  find_grants: "find_grants: search the web now. Set `oppKind` to grant, pitch (pitch competitions) or accelerator (accelerator or incubator programs); default grant. Put any focus the person gave in `focus`.",
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
      oppKind: { type: "string", enum: ["", "grant", "pitch", "accelerator", "speaking"] },
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
      const thing = { grant: "open grant", pitch: "pitch competition", accelerator: "accelerator program", speaking: "event taking proposals" }[r.kind];
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
    case "check_status": {
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
  return {
    type: "opportunity",
    id: o.id,
    title: o.title,
    subtitle: [o.host, o.amount, o.deadline && `Due ${o.deadline}`].filter(Boolean).join(" · "),
    body: o.fitReason ?? o.summary ?? "",
    url: o.sourceUrl,
    call: o.fitCall,
    score: o.fitScore,
  };
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
