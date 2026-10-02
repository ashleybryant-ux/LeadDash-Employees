import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { AIEmployee, EmployeeKind } from "../../drizzle/schema";
import { generateJson, generateText, searchJson, type JsonSchema } from "../_core/llm";
import { generateImage, type ImageSize } from "../_core/imageGeneration";
import { loadBrain } from "./brain";
import { BASE_RULES, GUIDELINE_LABELS, parseGuidelines, rosterEntry } from "./roster";
import { onboardingLines } from "./onboarding";

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

export async function systemPromptFor(emp: AIEmployee, job: string) {
  const brain = await loadBrain(emp.organizationId);
  const orgName = brain.org?.name ?? "the workspace";
  const g = parseGuidelines(emp.guidelines);
  const labels = emp.kind !== "custom" ? GUIDELINE_LABELS[emp.kind] : { focus: "Focus on", avoid: "Avoid", signAs: "Sign as" };
  const guideLines = [
    g.focus && `${labels.focus}: ${g.focus}`,
    g.avoid && `${labels.avoid}: ${g.avoid}`,
    g.signAs && `${labels.signAs}: ${g.signAs}`,
    emp.systemPrompt?.trim(),
  ].filter(Boolean);
  const onboard = onboardingLines(emp);
  const extra =
    (guideLines.length ? `\n\nGuidelines from the workspace for ${emp.name} (follow these):\n${guideLines.join("\n")}` : "") +
    (onboard.length ? `\n\nWhat the owner told you during onboarding (follow these):\n${onboard.join("\n")}` : "");
  return {
    brain,
    system: `You are ${emp.name}, the ${emp.roleTitle} employee for ${orgName}.\n\n${job}\n\n${BASE_RULES}${extra}\n\n# Brain (everything you know about ${orgName})\n${brain.text}`,
  };
}

/** Marks the employee busy while a task runs, then counts the finished task. */
export async function working<T>(emp: AIEmployee, fn: () => Promise<T>): Promise<T> {
  const before = emp.status;
  await db.updateEmployee(emp.id, emp.organizationId, { status: "working" });
  try {
    const result = await fn();
    await db.recordEmployeeTask(emp.id, emp.organizationId, rosterEntry(emp.kind)?.minutesPerTask ?? 15);
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
export function withRealSource<T extends { sourceUrl: string }>(items: T[] | undefined, sources: { url: string }[]) {
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
    .filter((item) => searchedHosts.size === 0 || searchedHosts.has(host(item.sourceUrl)));
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
    const { system } = await systemPromptFor(
      emp,
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
  input: { title: string; date: string; time: string; attendees: string; agenda: string }
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

export async function writeSocialPost(
  organizationId: number,
  input: {
    topic: string;
    targetPlatforms: ("linkedin" | "instagram" | "facebook" | "x")[];
    tone: keyof typeof TONES;
    generateImageFlag: boolean;
  }
) {
  const emp = await employeeFor(organizationId, "social");
  return working(emp, async () => {
    const { system } = await systemPromptFor(
      emp,
      `Your job: write one social post and describe the image for it.
- Opening line that earns the next line. Short paragraphs. A clear call to action. 3 to 5 relevant hashtags at the end.
- Keep it under 1,300 characters so it fits LinkedIn, Instagram and Facebook; if X is a target, also give an X version under 280 characters.
- The headline is 3 to 8 words, lowercase unless the Brain's voice says otherwise.
- The image prompt describes a scene only (no words or letters in the image).`
    );
    const out = await generateJson<{ headline: string; caption: string; xVersion: string; imagePrompt: string }>({
      system,
      prompt: `Topic: ${input.topic}\nPlatforms: ${input.targetPlatforms.join(", ")}\nTone: ${TONES[input.tone]}`,
      schemaName: "social_post",
      schema: obj({
        headline: str,
        caption: str,
        xVersion: { type: "string", description: "Empty string if X is not a target" },
        imagePrompt: str,
      }),
    });

    let imageUrl: string | null = null;
    let imageError: string | null = null;
    if (input.generateImageFlag) {
      try {
        const size: ImageSize = input.targetPlatforms.includes("instagram") ? "1024x1536" : "1024x1024";
        imageUrl = (await generateImage({ prompt: `${out.imagePrompt}. No text, letters or logos in the image.`, size, folder: `org-${organizationId}/social` })).url;
      } catch (err) {
        imageError = (err as Error).message;
        console.warn("[social] image failed:", imageError);
      }
    }

    const created = await db.createOutboundItem({
      organizationId,
      employeeId: emp.id,
      kind: "social_post",
      status: "pending_approval",
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
        xVersion: out.xVersion || null,
        imageError,
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
    const { system } = await systemPromptFor(
      emp,
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
