import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, ChatMessage } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as tasks from "./tasks";
import * as apply from "./apply";
import * as hiring from "./hiring";
import { writeReport } from "./onboarding";
import type { Opportunity, OppKind } from "../../drizzle/schema";

/**
 * Chat with an employee. Each message is answered in two steps:
 * 1. The employee reads the conversation and decides whether the message asks
 *    it to do its job now (find grants, write a post...) or just to talk.
 * 2. If there is a job, the server runs it with the same task code the Work
 *    tabs use, and the reply carries cards for whatever was created.
 */

export type ChatCard = {
  type: "opportunity" | "application" | "question" | "submitted" | "video" | "page" | "post" | "article" | "reply" | "prospect" | "candidate";
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
};

const ACTIONS: Record<string, string[]> = {
  grants: ["none", "report", "find_grants", "add_link", "apply", "find_and_apply", "check_status"],
  speaking: ["none", "report", "find_events", "add_link", "apply", "find_and_apply", "check_status"],
  video: ["none", "report", "find_videos"],
  social: ["none", "report", "write_post"],
  blog: ["none", "report", "write_article"],
  website: ["none", "report", "plan_page"],
  inbox: ["none", "report", "draft_reply"],
  hiring: ["none", "report", "find_people", "write_job_post", "check_status"],
  custom: ["none", "report"],
};

const ACTION_HELP: Record<string, string> = {
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
  write_post: "write_post: write a social post. Put the subject in `topic` and the platforms (linkedin, instagram, facebook, x) in `platforms`; default to linkedin and instagram.",
  write_article: "write_article: write a blog article. Put the title in `title` and points to cover in `notes`.",
  plan_page: "plan_page: plan a website page. Put the page name in `page` and its goal in `goal`.",
  draft_reply: "draft_reply: the person pasted a message they received. Put the sender in `from`, the subject in `subject` (make one up from the content if missing) and the full pasted message in `message`.",
};

function decisionSchema(kind: string): JsonSchema {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply", "action", "focus", "topic", "platforms", "title", "notes", "page", "goal", "from", "subject", "message", "url", "oppKind", "target"],
    properties: {
      reply: { type: "string", description: "What you say back. If you are about to do a job, one short sentence saying what you are doing." },
      action: { type: "string", enum: ACTIONS[kind] ?? ["none"] },
      focus: str,
      topic: str,
      platforms: { type: "array", items: { type: "string", enum: ["linkedin", "instagram", "facebook", "x"] } },
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
    },
  };
}

type Decision = {
  reply: string;
  action: string;
  focus: string;
  topic: string;
  platforms: ("linkedin" | "instagram" | "facebook" | "x")[];
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
};

function transcript(history: ChatMessage[]) {
  return history
    .slice(-12)
    .map((m) => `${m.role === "user" ? m.authorName : "You"}: ${m.content}`)
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
    case "check_status": {
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
