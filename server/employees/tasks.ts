import { carriesClientInfo } from "../_core/baa";
import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, EmployeeKind } from "../../drizzle/schema";
import { generateJson, generateText, searchJson, type JsonSchema } from "../_core/llm";
import { generateImage, type ImageSize } from "../_core/imageGeneration";
import { loadBrain } from "./brain";
import { BASE_RULES, rosterEntry, CLIENT_INFO_KINDS, ROSTER, worksWithClientInfo } from "./roster";
import { guidelinesText } from "./interview";
import { handbookText, playbookText } from "./handbook";
import { findPassages, formatPassages } from "./kb";
import { recordTask, withUsage } from "../usage";

// ==========================================
// Shared helpers
// ==========================================

export async function employeeFor(organizationId: number, kind: EmployeeKind): Promise<AIEmployee> {
  const emp = await db.getEmployeeByKind(organizationId, kind);
  if (!emp) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `This workspace has no ${rosterEntry(kind)?.roleTitle ?? kind} employee.`,
    });
  }
  if (emp.status === "paused") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${emp.name} is paused. Resume them to continue.` });
  }
  return emp;
}

/**
 * Everything an employee knows for one task: the handbook, the job, the rules,
 * the owner's Guidelines, the Brain, and the passages from uploaded documents
 * and web pages (books, playbooks, guides) that best fit the task. `about` is
 * what the task is about (a post's topic, the person's message); the job text
 * is searched when it is missing.
 */
export async function systemPromptAbout(emp: AIEmployee, about: string, job: string) {
  return systemPromptFor(emp, job, about);
}

export async function systemPromptFor(emp: AIEmployee, job: string, about?: string) {
  const brain = await loadBrain(emp.organizationId);
  const orgName = brain.org?.name ?? "the workspace";
  const guides = guidelinesText(emp);
  const extra =
    (guides ? `\n\n# Guidelines from the owner for ${emp.name} (follow these; they come from onboarding, chat and the Guidelines tab)\n${guides}` : "") +
    (emp.systemPrompt?.trim() ? `\n\nMore instructions from the workspace:\n${emp.systemPrompt.trim()}` : "") +
    clientInfoRules(emp, brain.org?.orgType);
  return {
    brain,
    system: `You are ${emp.name}, the ${emp.roleTitle} employee for ${orgName}.\n\n${handbookText(emp.organizationId)}${playbookText(emp.kind) ? `\n\n${playbookText(emp.kind)}` : ""}\n\n# The task in front of you\n${job}\n\n${BASE_RULES}${extra}\n\n# Brain (everything you know about ${orgName})\n${brain.text}${await passagesFor(emp, about, job)}`,
  };
}

/**
 * In a healthcare practice, four employees work with client information and
 * every other one works without it. The rule goes in every prompt so it holds
 * in chat, in drafts and in notices.
 */
export function clientInfoRules(emp: Pick<AIEmployee, "kind" | "name">, orgType: string | null | undefined) {
  if (orgType !== "healthcare") return "";
  if (worksWithClientInfo(emp.kind, "healthcare")) {
    const photos = carriesClientInfo("anthropic") ? "" : `\n- A photo attached in this chat is kept as a file, but you do not read photos in this workspace yet (the provider that reads photos is not under a BAA). Ask for what it says in words.`;
    return `\n\n# Client information (this workspace is a healthcare practice)
- You work with client information as part of your job. It stays inside this app and LeadDash EHR. This replaces the general rule about client names: here, in chat and on your Work tab, call clients by name, because that is how the practice talks about them.
- In anything that leaves this app (an email, a text, a push notice, a document, a form on a website), a client appears by initials only ("J.M."), never by name, and never with anything from their record.
- Nothing from a client's message or record goes to web search or to any outside site.
- Never diagnose, never ask why someone is seeking care, and never put a clinical detail in writing outside the EHR.${photos}`;
  }
  const to = CLIENT_INFO_KINDS.map((k) => ROSTER.find((r) => r.kind === k)?.name).filter(Boolean).join(", ");
  return `\n\n# Client information (this workspace is a healthcare practice)
- You work without client information. If a message or file you are given contains a client's name, contact details or anything from their care, do not use it: say that client information goes to ${to}, and continue with the part of the task that does not need it.
- Never search the web for, write about, or store anything about a client.`;
}

/**
 * Passages from the workspace's documents and pages (and this employee's own
 * Knowledge) that match the task, so a 200-page book is used where it applies
 * instead of only its first pages. Kept to about 9,000 characters.
 */
async function passagesFor(emp: AIEmployee, about: string | undefined, job: string) {
  try {
    const query = `${about ?? ""} ${job}`.slice(0, 2000);
    const passages = await findPassages(emp.organizationId, query, { employeeId: emp.id, limit: 8 });
    if (!passages.length) return "";
    return `\n\n# From your documents (the passages that best fit this task; use what applies, in your own words, and never copy long stretches of a book word for word)\n${formatPassages(passages, 9_000)}`;
  } catch {
    return "";
  }
}

/** Marks the employee busy while a task runs, then counts the finished task. */
export async function working<T>(emp: AIEmployee, fn: () => Promise<T>): Promise<T> {
  const before = emp.status;
  await db.updateEmployee(emp.id, emp.organizationId, { status: "working" });
  try {
    const result = await withUsage({ orgId: emp.organizationId, employeeId: emp.id, kind: emp.kind }, fn);
    const minutes = rosterEntry(emp.kind)?.minutesPerTask ?? 15;
    await db.recordEmployeeTask(emp.id, emp.organizationId, minutes);
    await recordTask(emp.organizationId, emp.id, minutes);
    return result;
  } finally {
    await db.updateEmployee(emp.id, emp.organizationId, { status: before === "working" ? "active" : before });
  }
}

export const actor = (emp: AIEmployee) => `${emp.name} (${emp.roleTitle})`;

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items: JsonSchema): JsonSchema => ({ type: "array", items });

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
}

/**
 * Drops anything the model returned without a source link, and anything whose
 * link's site never appeared in the search results (a sign it came from memory).
 */
export function withRealSource<T extends { sourceUrl: string; foundOn?: string }>(items: T[] | undefined, sources: { url: string }[]) {
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const searchedHosts = new Set(sources.map((s) => host(s.url)).filter(Boolean));
  return (items ?? [])
    .filter((item) => isHttpUrl(item.sourceUrl))
    .map((item) => ({ ...item, sourceUrl: item.sourceUrl.trim() }))
    // Kept when its own page came up in the search, or when it was listed on a page that did
    // (a "pitch competitions this year" list); its own page is then downloaded and read.
    .filter((item) => searchedHosts.size === 0 || searchedHosts.has(host(item.sourceUrl)) || (item.foundOn ? searchedHosts.has(host(item.foundOn)) : false));
}

// ==========================================
// Morgan (grants, pitch competitions, accelerators) and Taylor (speaking)
// work through the applying engine in ./apply.ts.
// ==========================================

// ==========================================
// Wren: website
// ==========================================

type PagePlan = {
  page: string;
  suggestedPath: string;
  sections: { label: string; heading: string; content: string }[];
  callToAction: string;
};

export async function planWebsitePage(organizationId: number, page: string, goal: string) {
  const emp = await employeeFor(organizationId, "website");
  return working(emp, async () => {
    const { system } = await systemPromptAbout(
      emp,
      `${page} ${goal}`,
      `Your job: plan one website page, section by section, with the finished copy for each section.
- 4 to 7 sections in the order a visitor reads them. Each has a short label (Headline, How it works, ...), the on-page heading, and the copy.
- Use real names, services and details from the Brain; placeholders where facts are missing.
- One clear call to action that matches the goal.`
    );
    const plan = await generateJson<PagePlan>({
      system,
      prompt: `Page: ${page}\nGoal: ${goal}`,
      schemaName: "page_plan",
      schema: obj({
        page: str,
        suggestedPath: { type: "string", description: "URL path like /couples" },
        sections: arr(obj({ label: str, heading: str, content: str })),
        callToAction: str,
      }),
    });
    const item = await db.createWorkItem({
      organizationId,
      employeeId: emp.id,
      kind: "website_plan",
      status: "drafted",
      title: (plan.page || page).slice(0, 255),
      data: JSON.stringify({ ...plan, goal }),
    });
    await db.logAction({
      organizationId,
      actorType: "employee",
      actorName: actor(emp),
      action: "Planned website page",
      details: `Planned "${item.title}".`,
    });
    return item;
  });
}

// ==========================================
// Nico: video
// ==========================================

type VideoIdea = {
  trend: { name: string; whyItWorks: string; sourceUrl: string };
  plan: {
    title: string;
    platform: string;
    lengthSeconds: number;
    hook: string;
    shots: { time: string; shot: string; say: string }[];
    caption: string;
  };
};

export async function findVideoIdeas(organizationId: number, focus?: string) {
  const emp = await employeeFor(organizationId, "video");
  return working(emp, async () => {
    const { system } = await systemPromptFor(
      emp,
      `Your job: find short-form video formats that are working right now (TikTok, Instagram Reels, YouTube Shorts) and turn each into a plan this workspace can film.
- Search for current trends and formats. Each trend needs the page you found it on.
- For each trend, write a hook for the first two seconds, a shot list with timestamps, what to say on each shot, and a caption.
- 15 to 45 seconds. Vertical. Return 2 or 3 ideas.`
    );
    const result = await searchJson<{ ideas: VideoIdea[] }>({
      system,
      prompt: `Find video ideas for this workspace.${focus ? `\nFocus on: ${focus}` : ""}`,
      schemaName: "video_ideas",
      schema: obj({
        ideas: arr(
          obj({
            trend: obj({ name: str, whyItWorks: str, sourceUrl: str }),
            plan: obj({
              title: str,
              platform: str,
              lengthSeconds: { type: "integer" },
              hook: str,
              shots: arr(obj({ time: str, shot: str, say: str })),
              caption: str,
            }),
          })
        ),
      }),
    });
    const created = [];
    for (const idea of result.data.ideas ?? []) {
      if (!idea?.plan?.title || !isHttpUrl(idea?.trend?.sourceUrl)) continue;
      created.push(
        await db.createWorkItem({
          organizationId,
          employeeId: emp.id,
          kind: "video_plan",
          status: "drafted",
          title: idea.plan.title.slice(0, 255),
          sourceUrl: idea.trend.sourceUrl,
          searchQueries: JSON.stringify(result.queries),
          data: JSON.stringify(idea),
        })
      );
    }
    await db.logAction({
      organizationId,
      actorType: "employee",
      actorName: actor(emp),
      action: "Planned videos",
      details: `Ran ${result.queries.length} searches and planned ${created.length} videos.`,
    });
    return { created, queries: result.queries };
  });
}

// ==========================================
// Avery: inbox and calendar
// ==========================================

export async function draftEmailReply(
  organizationId: number,
  input: { subject: string; recipient: string; context: string; desiredOutcome?: string }
) {
  const emp = await employeeFor(organizationId, "inbox");
  return working(emp, async () => {
    const { system } = await systemPromptFor(
      emp,
      `Your job: read a message the workspace received, say what the sender wants and how urgent it is, and draft the reply.
- The reply is ready to send: greeting, body, sign-off. No subject line, no notes to the reviewer inside it.
- Answer only what you can from the Brain and the message. Where a decision belongs to the owner, put a bracketed placeholder.`
    );
    const out = await generateJson<{ whatTheyWant: string; urgency: "today" | "this_week" | "later"; reply: string }>({
      system,
      prompt: `From: ${input.recipient}
Subject: ${input.subject}
Message:
${input.context}
${input.desiredOutcome ? `\nWhat the owner wants to happen: ${input.desiredOutcome}` : ""}`,
      schemaName: "email_reply",
      schema: obj({
        whatTheyWant: str,
        urgency: { type: "string", enum: ["today", "this_week", "later"] },
        reply: str,
      }),
    });
    const created = await db.createOutboundItem({
      organizationId,
      employeeId: emp.id,
      kind: "email_draft",
      status: "pending_approval",
      title: input.subject.startsWith("Re:") ? input.subject : `Re: ${input.subject}`,
      body: out.reply,
      targetChannels: JSON.stringify(["Gmail"]),
      metadata: JSON.stringify({
        recipient: input.recipient,
        threadSubject: input.subject,
        whatTheyWant: out.whatTheyWant,
        urgency: out.urgency,
      }),
    });
    await db.logAction({
      organizationId,
      actorType: "employee",
      actorName: actor(emp),
      action: "Drafted email reply",
      details: `Reply to "${input.subject}" is waiting for approval.`,
    });
    return created;
  });
}

/** A new email (not a reply) to someone, from the owner. Waits in Approvals; Send goes out through the connected Gmail. */
export async function composeEmail(organizationId: number, input: { to: string; toName?: string; purpose: string }) {
  const emp = await employeeFor(organizationId, "inbox");
  return working(emp, async () => {
    const { system } = await systemPromptFor(
      emp,
      `Your job: write a new email from the owner to the person named, for the purpose given.
- A short, specific subject line, then the email: greeting, 2 to 5 sentences, sign-off with the owner's name from the Brain.
- Use the exact dates and times given. Where a decision belongs to the owner, put a bracketed placeholder.`
    );
    const out = await generateJson<{ subject: string; body: string }>({
      system,
      prompt: `To: ${input.toName ? `${input.toName} <${input.to}>` : input.to}\nWhat the owner wants: ${input.purpose}`,
      schemaName: "new_email",
      schema: obj({ subject: str, body: str }),
    });
    const created = await db.createOutboundItem({
      organizationId,
      employeeId: emp.id,
      kind: "email_draft",
      status: "pending_approval",
      title: out.subject || "New email",
      body: out.body,
      targetChannels: JSON.stringify(["Gmail"]),
      metadata: JSON.stringify({ recipient: input.toName || input.to, email: input.to, whatTheyWant: input.purpose, urgency: "today", newEmail: true }),
    });
    await db.logAction({ organizationId, actorType: "employee", actorName: actor(emp), action: "Drafted email", details: `To ${input.to}: "${created.title}" is waiting for approval.` });
    return created;
  });
}

export async function createCalendarHold(
  organizationId: number,
  input: { title: string; date: string; time: string; attendees: string; agenda: string; linkId?: number | null; video?: "zoom" | null }
) {
  const emp = await employeeFor(organizationId, "inbox");
  const created = await db.createOutboundItem({
    organizationId,
    employeeId: emp.id,
    kind: "calendar_hold",
    status: "pending_approval",
    title: input.title,
    body: `Agenda:\n${input.agenda}\n\nTime: ${input.date} at ${input.time}\nAttendees: ${input.attendees}`,
    targetChannels: JSON.stringify(["Google Calendar"]),
    metadata: JSON.stringify({
      date: input.date,
      time: input.time,
      attendees: input.attendees.split(",").map((a) => a.trim()).filter(Boolean),
      linkId: input.linkId ?? null,
      ...(input.video ? { video: input.video } : {}),
    }),
  });
  await db.logAction({
    organizationId,
    actorType: "employee",
    actorName: actor(emp),
    action: "Created calendar hold",
    details: `"${input.title}" on ${input.date} at ${input.time} is waiting for approval.`,
  });
  return created;
}

// ==========================================
// Sienna: social
// ==========================================

const TONES = {
  thought_leadership: "thought leadership",
  community_announcement: "community announcement",
  clinical_advocacy: "clinical advocacy",
  event_invitation: "event invitation",
} as const;

export type WritePlatform = "linkedin" | "instagram" | "facebook" | "x" | "threads";

export async function writeSocialPost(
  organizationId: number,
  input: {
    topic: string;
    targetPlatforms: WritePlatform[];
    tone: keyof typeof TONES;
    generateImageFlag: boolean;
  }
) {
  const emp = await employeeFor(organizationId, "social");
  return working(emp, async () => {
    const wantsX = input.targetPlatforms.includes("x");
    const wantsThreads = input.targetPlatforms.includes("threads");
    const { system } = await systemPromptAbout(
      emp,
      input.topic,
      `Your job: write one social post and describe the image for it.
- Opening line that earns the next line. Short paragraphs. A clear call to action. 3 to 5 relevant hashtags at the end.
- Keep it under 1,300 characters so it fits LinkedIn, Instagram and Facebook.
- If X is a target, also give an X version under 280 characters. If Threads is a target, also give a Threads version under 500 characters with at most one hashtag.
- The headline is 3 to 8 words, lowercase unless the Brain's voice says otherwise.
- The image prompt is one concrete visual idea that shows the post's point (a visual metaphor or a small scene with a clear subject and action, never a generic stock shot), plus how it's drawn (bright flat vector illustration, playful editorial cartoon, soft 3D clay render or warm candid editorial photo). No words, letters, numbers or logos in the image; the subject in the center.`
    );
    const out = await generateJson<{ headline: string; caption: string; xVersion: string; threadsVersion: string; imagePrompt: string }>({
      system,
      prompt: `Topic: ${input.topic}\nPlatforms: ${input.targetPlatforms.join(", ")}\nTone: ${TONES[input.tone]}`,
      schemaName: "social_post",
      schema: obj({
        headline: str,
        caption: str,
        xVersion: { type: "string", description: "Empty string if X is not a target" },
        threadsVersion: { type: "string", description: "Empty string if Threads is not a target" },
        imagePrompt: str,
      }),
    });

    let imageUrl: string | null = null;
    let imageError: string | null = null;
    let imageMeta: { w: number; h: number } | null = null;
    if (input.generateImageFlag) {
      try {
        const size: ImageSize = input.targetPlatforms.includes("instagram") ? "1024x1536" : "1024x1024";
        imageUrl = (await generateImage({ prompt: `${out.imagePrompt}. No text, letters or logos in the image.`, size, folder: `org-${organizationId}/social` })).url;
        const [w, h] = size.split("x").map(Number);
        imageMeta = { w, h };
      } catch (err) {
        imageError = (err as Error).message;
        console.warn("[social] image failed:", imageError);
      }
    }

    // X and Threads get their own shorter text, so the post is "different for each account".
    // No imageUrl on a variant means it uses the main image.
    const variants: Record<string, { text: string }> = {};
    if (wantsX && out.xVersion?.trim()) variants.x = { text: out.xVersion.trim() };
    if (wantsThreads && out.threadsVersion?.trim()) variants.threads = { text: out.threadsVersion.trim() };
    const different = Object.keys(variants).length > 0;

    // When Sienna posts on her own, the post goes on the calendar at the next good time.
    const { gate } = await import("./team");
    const auto = gate(emp, "posts") === "auto" && (!input.targetPlatforms.includes("instagram") || !!imageUrl);
    const at = auto ? (await (await import("../social")).planTimes(organizationId, input.targetPlatforms[0] as never, 1))[0] ?? null : null;
    const created = await db.createOutboundItem({
      organizationId,
      employeeId: emp.id,
      kind: "social_post",
      status: auto && at ? "scheduled" : "pending_approval",
      scheduledFor: auto ? at : null,
      ...(auto && at ? { approvedBy: `${emp.name} (on her own)`, approvedAt: new Date() } : {}),
      title: out.headline || input.topic,
      body: out.caption,
      targetChannels: JSON.stringify(input.targetPlatforms),
      imagePrompt: out.imagePrompt,
      imageUrl,
      metadata: JSON.stringify({
        platforms: input.targetPlatforms,
        tone: input.tone,
        topic: input.topic,
        headline: out.headline,
        imageError,
        rule: "posts",
        post: { type: "post", mode: different ? "different" : "same", variants, imageMeta },
      }),
    });
    await db.logAction({
      organizationId,
      actorType: "employee",
      actorName: actor(emp),
      action: "Wrote social post",
      details: `"${created.title}" for ${input.targetPlatforms.join(", ")} is waiting for approval.`,
    });
    return created;
  });
}

/**
 * Theo passed Sienna an approved article: she writes 3 posts from it and puts
 * them on the calendar (as drafts, or scheduled when she posts on her own).
 */
export async function postsFromArticle(organizationId: number, articleId: number) {
  const article = await db.getOutboundItemForOrg(articleId, organizationId);
  if (!article || article.kind !== "blog_post") return [];
  const sienna = await employeeFor(organizationId, "social");
  const { handoff, gate, logActivity } = await import("./team");
  const theo = article.employeeId ? await db.getEmployeeForOrg(article.employeeId, organizationId) : null;
  await handoff(organizationId, "blog", "social", `${theo?.name ?? "Theo"} passed you his new article, ${article.title}.`);
  const answers = (() => {
    try {
      return JSON.parse(sienna.onboarding || "{}");
    } catch {
      return {};
    }
  })();
  const fromAnswers = (Array.isArray(answers.platforms) ? answers.platforms : []).map((x: string) => x.toLowerCase()).filter((x: string) => ["facebook", "instagram", "linkedin", "x", "threads"].includes(x));
  let channels: string[] = fromAnswers.length ? fromAnswers : ["facebook", "instagram", "linkedin"];
  if (!article.imageUrl) channels = channels.filter((c) => c !== "instagram");
  if (!channels.length) channels = ["facebook"];
  const posts = await working(sienna, async () => {
    const { system } = await systemPromptFor(
      sienna,
      `Your job: turn one article into 3 different social posts for the coming weeks.
- Each post takes a different angle from the article (a tip, a question readers ask, a myth it corrects).
- Opening line that earns the next line. Short paragraphs. A clear call to action. Up to 3 hashtags.
- Under 1,300 characters each. The headline is 3 to 8 words.`
    );
    const out = await generateJson<{ posts: { headline: string; caption: string }[] }>({
      system,
      prompt: `Article title: ${article.title}\n\nArticle:\n${(article.body ?? "").slice(0, 12_000)}`,
      schemaName: "posts_from_article",
      schema: obj({ posts: arr(obj({ headline: str, caption: str })) }),
      maxTokens: 3000,
    });
    return (out.posts ?? []).filter((p) => p.caption?.trim()).slice(0, 3);
  });
  const social = await import("../social");
  const times = await social.planTimes(organizationId, channels[0] as never, posts.length);
  const auto = gate(sienna, "posts") === "auto";
  const created = [];
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    created.push(
      await db.createOutboundItem({
        organizationId,
        employeeId: sienna.id,
        kind: "social_post",
        status: auto ? "scheduled" : "pending_approval",
        title: p.headline || article.title,
        body: p.caption,
        targetChannels: JSON.stringify(channels),
        imageUrl: article.imageUrl,
        scheduledFor: times[i] ?? null,
        ...(auto ? { approvedBy: `${sienna.name} (on her own)`, approvedAt: new Date() } : {}),
        metadata: JSON.stringify({ platforms: channels, headline: p.headline, fromArticle: article.id, rule: "posts", post: { type: "post", mode: "same", variants: {} } }),
      })
    );
  }
  if (created.length) {
    const tz = (await db.getOrganizationById(organizationId))?.timezone || "America/Chicago";
    const dates = times.slice(0, created.length).map((t) => t.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }));
    const text = `I wrote ${created.length} posts from ${theo?.name ?? "Theo"}'s article and put them on the calendar${dates.length ? ` for ${dates.join(", ")}` : ""}${auto ? "." : ". They post once you approve them."}`;
    await db.createChatMessage({ organizationId, employeeId: sienna.id, role: "employee", authorName: sienna.name, content: text });
    await logActivity(sienna, "done", `Wrote ${created.length} posts from ${theo?.name ?? "Theo"}'s article and put them on the calendar.`, "/chats/social/work");
  }
  return created;
}

const CHANNEL_NAMES: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", x: "X", threads: "Threads", tiktok: "TikTok", google_business: "Google Business Profile" };
const CHANNEL_CHARS: Record<string, number> = { x: 270, threads: 480, instagram: 1_300, facebook: 1_300, linkedin: 1_300, google_business: 1_400 };

/**
 * Several drafts at once for one account (when the person asks Sienna to fill
 * the calendar). The text comes back right away; images follow in the
 * background, one at a time, so the chat is not held up.
 */
export async function writeSocialBatch(organizationId: number, channel: string, count: number, avoid: string[]) {
  const emp = await employeeFor(organizationId, "social");
  const name = CHANNEL_NAMES[channel] ?? channel;
  const limit = CHANNEL_CHARS[channel] ?? 1_300;
  const n = Math.max(1, Math.min(20, count));
  const created = await working(emp, async () => {
    const { system } = await systemPromptFor(
      emp,
      `Your job: write ${n} different ${name} posts for the coming weeks, each on its own topic that fits the practice.
- Opening line that earns the next line. Short paragraphs. A clear call to action. Up to 3 relevant hashtags at the end.
- Each caption is under ${limit} characters.
- The headline is 3 to 8 words, lowercase unless the Brain's voice says otherwise.
- The image prompt describes a scene only (no words or letters in the image), with the subject in the center.
- Do not repeat these topics already planned: ${avoid.slice(0, 40).join("; ") || "none"}.`
    );
    const out = await generateJson<{ posts: { headline: string; caption: string; imagePrompt: string }[] }>({
      system,
      prompt: `Write ${n} ${name} posts.`,
      schemaName: "social_batch",
      schema: obj({ posts: arr(obj({ headline: str, caption: str, imagePrompt: str })) }),
      maxTokens: 6000,
    });
    const list = [];
    for (const p of (out.posts ?? []).slice(0, n)) {
      if (!p.caption?.trim()) continue;
      list.push(
        await db.createOutboundItem({
          organizationId,
          employeeId: emp.id,
          kind: "social_post",
          status: "pending_approval",
          title: p.headline || p.caption.slice(0, 60),
          body: p.caption.slice(0, limit + 200),
          targetChannels: JSON.stringify([channel]),
          imagePrompt: p.imagePrompt,
          metadata: JSON.stringify({ platforms: [channel], tone: "thought_leadership", headline: p.headline, imagePending: true, post: { type: "post", mode: "same", variants: {} } }),
        })
      );
    }
    return list;
  });
  if (created.length) {
    await db.logAction({ organizationId, actorType: "employee", actorName: actor(emp), action: "Wrote social posts", details: `${created.length} ${name} drafts are waiting for approval.` });
    void (async () => {
      for (const item of created) {
        try {
          const size: ImageSize = channel === "instagram" ? "1024x1536" : "1024x1024";
          const img = await generateImage({ prompt: `${item.imagePrompt}. No text, letters or logos in the image.`, size, folder: `org-${organizationId}/social` });
          const fresh = await db.getOutboundItemForOrg(item.id, organizationId);
          if (!fresh || fresh.imageUrl || fresh.status === "published" || fresh.status === "cancelled") continue;
          const meta = JSON.parse(fresh.metadata || "{}");
          const [w, h] = size.split("x").map(Number);
          await db.updateOutboundItem(item.id, organizationId, { imageUrl: img.url, metadata: JSON.stringify({ ...meta, imagePending: false, post: { ...(meta.post ?? {}), imageMeta: { w, h } } }) });
        } catch (err) {
          const fresh = await db.getOutboundItemForOrg(item.id, organizationId);
          if (fresh) await db.updateOutboundItem(item.id, organizationId, { metadata: JSON.stringify({ ...JSON.parse(fresh.metadata || "{}"), imagePending: false, imageError: (err as Error).message }) });
        }
      }
    })();
  }
  return created;
}

// ==========================================
// Theo: blog
// ==========================================

export async function writeBlogArticle(
  organizationId: number,
  input: { title: string; category: string; outlineNotes?: string; generateBannerFlag: boolean }
) {
  const emp = await employeeFor(organizationId, "blog");
  const wp = await db.getConnectionByProvider(organizationId, "wordpress");
  return working(emp, async () => {
    const { system } = await systemPromptAbout(
      emp,
      `${input.title} ${input.outlineNotes ?? ""}`,
      `Your job: write a publication-ready blog article in markdown.
- 900 to 1,500 words. Open with the point, not a warm-up. Use ## headings. End with practical takeaways.
- No made-up studies or numbers. If a claim needs a source you do not have, leave it out.`
    );
    const body = await generateText({
      system,
      prompt: `Title: ${input.title}\nCategory: ${input.category}\nPoints to cover: ${input.outlineNotes || "Use your judgment from the Brain."}`,
      maxTokens: 4000,
      temperature: 0.5,
    });

    const bannerPrompt = `Editorial horizontal banner photograph for an article titled "${input.title}". Calm, natural light, real setting. No text, letters or logos.`;
    let imageUrl: string | null = null;
    let imageError: string | null = null;
    if (input.generateBannerFlag) {
      try {
        imageUrl = (await generateImage({ prompt: bannerPrompt, size: "1536x1024", folder: `org-${organizationId}/blog` })).url;
      } catch (err) {
        imageError = (err as Error).message;
        console.warn("[blog] banner failed:", imageError);
      }
    }

    const created = await db.createOutboundItem({
      organizationId,
      employeeId: emp.id,
      kind: "blog_post",
      status: "pending_approval",
      title: input.title,
      body,
      targetChannels: JSON.stringify([wp?.accountHandle ? `WordPress (${wp.accountHandle})` : "WordPress"]),
      imagePrompt: bannerPrompt,
      imageUrl,
      metadata: JSON.stringify({
        category: input.category,
        slug: input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        statusOnWordPress: "draft",
        targetEndpoint: wp?.accountHandle || null,
        imageError,
      }),
    });
    await db.logAction({
      organizationId,
      actorType: "employee",
      actorName: actor(emp),
      action: "Wrote blog article",
      details: `"${input.title}" is waiting for approval.`,
    });
    return created;
  });
}
