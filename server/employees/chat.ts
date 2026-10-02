import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, ChatMessage } from "../../drizzle/schema";
import { generateJson, type JsonSchema } from "../_core/llm";
import * as tasks from "./tasks";

/**
 * Chat with an employee. Each message is answered in two steps:
 * 1. The employee reads the conversation and decides whether the message asks
 *    it to do its job now (find grants, write a post...) or just to talk.
 * 2. If there is a job, the server runs it with the same task code the Work
 *    tabs use, and the reply carries cards for whatever was created.
 */

export type ChatCard = {
  type: "grant" | "event" | "video" | "page" | "post" | "article" | "reply";
  id: number;
  title: string;
  subtitle?: string;
  body?: string;
  url?: string | null;
  imageUrl?: string | null;
};

const ACTIONS: Record<string, string[]> = {
  grants: ["none", "find_grants"],
  speaking: ["none", "find_events"],
  video: ["none", "find_videos"],
  social: ["none", "write_post"],
  blog: ["none", "write_article"],
  website: ["none", "plan_page"],
  inbox: ["none", "draft_reply"],
  custom: ["none"],
};

const ACTION_HELP: Record<string, string> = {
  find_grants: "find_grants: search the web for open grants now. Put any focus the person gave in `focus`.",
  find_events: "find_events: search the web for speaking events taking proposals now. Put any focus in `focus`.",
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
    required: ["reply", "action", "focus", "topic", "platforms", "title", "notes", "page", "goal", "from", "subject", "message"],
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
};

function transcript(history: ChatMessage[]) {
  return history
    .slice(-12)
    .map((m) => `${m.role === "user" ? m.authorName : "You"}: ${m.content}`)
    .join("\n\n");
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

async function runAction(emp: AIEmployee, d: Decision): Promise<{ text: string; cards: ChatCard[]; queries: string[] }> {
  const org = emp.organizationId;
  switch (d.action) {
    case "find_grants": {
      const r = await tasks.findGrants(org, d.focus || undefined);
      const cards: ChatCard[] = r.created.map((g) => ({
        type: "grant",
        id: g.id,
        title: g.title,
        subtitle: [g.funder, g.fundingAmount, g.deadline && `Due ${g.deadline}`].filter(Boolean).join(" · "),
        body: g.fitReason ?? g.summary ?? "",
        url: g.sourceUrl,
      }));
      const text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and found ${plural(r.created.length, "new open grant")}. They're also on the Opportunities tab.`
        : `I ran ${plural(r.queries.length, "search", "searches")} and didn't find new grants that fit beyond what's already on Opportunities.`;
      return { text, cards, queries: r.queries };
    }
    case "find_events": {
      const r = await tasks.findSpeakingEvents(org, d.focus || undefined);
      const cards: ChatCard[] = r.created.map((e) => {
        const data = JSON.parse(e.data || "{}");
        return {
          type: "event",
          id: e.id,
          title: e.title,
          subtitle: [data.organizer, data.audience, data.deadline && `Proposals due ${data.deadline}`].filter(Boolean).join(" · "),
          body: data.angle ?? "",
          url: e.sourceUrl,
        };
      });
      const text = r.created.length
        ? `I ran ${plural(r.queries.length, "search", "searches")} and found ${plural(r.created.length, "event")} taking proposals. Say the word and I'll write the pitches.`
        : `I ran ${plural(r.queries.length, "search", "searches")} and didn't find new events that fit beyond what's already on Pitches.`;
      return { text, cards, queries: r.queries };
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
