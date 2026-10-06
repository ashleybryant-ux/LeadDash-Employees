import { TRPCError } from "@trpc/server";
import * as db from "./db";
import type { OutboundItem } from "../drizzle/schema";
import * as social from "./social";
import * as sales from "./employees/sales";
import * as team from "./employees/team";
import * as desk from "./employees/desk";
import * as tasks from "./employees/tasks";
import { postProblems } from "@shared/post-model";

/**
 * One decision on something waiting in Approvals, whether it comes from the
 * Approvals page or from a word in chat ("approved"). Approving posts or
 * sends it now, or schedules it when a later time is set.
 */
export type Decision = "approve_for_dispatch" | "approve_only" | "request_revisions" | "cancel" | "retry";

export async function decideItem(item: OutboundItem, opts: { reviewer: string; role: string; action: Decision; notes?: string }) {
  const orgId = item.organizationId;
  const { reviewer, action } = opts;
  if (item.status === "published") throw new TRPCError({ code: "BAD_REQUEST", message: "This has already gone out." });
  if (action === "approve_for_dispatch" || action === "approve_only") {
    await desk.assertDecide(orgId, opts.role, desk.categoryOfItem(item.kind));
  }

  if (action === "request_revisions" || action === "cancel") {
    const status = action === "request_revisions" ? "changes_requested" : "cancelled";
    const updated = await db.updateOutboundItem(item.id, orgId, { status, reviewerNotes: opts.notes ?? null, scheduledFor: status === "cancelled" ? null : item.scheduledFor });
    await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: reviewer, action: status === "changes_requested" ? "Sent back" : "Cancelled", details: `"${item.title}".${opts.notes ? ` Note: ${opts.notes}` : ""}` });
    return updated;
  }

  if (action === "retry" && item.status === "pending_approval") throw new TRPCError({ code: "BAD_REQUEST", message: "Approve it first." });
  if (item.kind === "social_post" && action !== "retry") {
    const problems = postProblems(item);
    if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${problems.join(". ")}.` });
  }
  const approval = item.approvedBy ? {} : { approvedBy: reviewer, approvedAt: new Date() };
  const later = item.kind === "social_post" && item.scheduledFor && new Date(item.scheduledFor).getTime() > Date.now() + 30_000;

  // Jada's sequences are approved as a whole.
  if (item.kind === "outreach_email" && action !== "retry") {
    const seq = (() => {
      try {
        return JSON.parse(item.metadata || "{}").sequence as string | undefined;
      } catch {
        return undefined;
      }
    })();
    if (seq) {
      await sales.approveSequence(orgId, seq, reviewer);
      return db.getOutboundItemForOrg(item.id, orgId);
    }
  }
  if (action !== "retry") await team.noteApproval(item);

  // Approved, waiting for a time; or approved for a time already set.
  if (action === "approve_only" || (action === "approve_for_dispatch" && later)) {
    if (item.kind !== "social_post" && action === "approve_only") throw new TRPCError({ code: "BAD_REQUEST", message: "Only posts can wait for a time." });
    const status = later ? "scheduled" : "approved";
    const updated = await db.updateOutboundItem(item.id, orgId, { status, reviewerNotes: opts.notes ?? item.reviewerNotes ?? null, ...approval });
    const tz = (await db.getOrganizationById(orgId))?.timezone || "America/Chicago";
    const when = later ? social.localParts(new Date(item.scheduledFor!), tz) : null;
    await db.logAction({ organizationId: orgId, actorType: "human_user", actorName: reviewer, action: "Approved", details: `"${item.title}". ${when ? `Scheduled for ${when.date} at ${when.time}.` : "Waiting for a time on the calendar."}` });
    return updated;
  }

  // Theo's approved article goes to Sienna for posts, unless Theo is set to ask.
  if (item.kind === "blog_post" && action === "approve_for_dispatch") {
    const theo = item.employeeId ? await db.getEmployeeForOrg(item.employeeId, orgId) : null;
    if (theo && team.gate(theo, "pass_to_social") === "auto") void tasks.postsFromArticle(orgId, item.id).catch((err) => console.warn("[team] posts from article failed:", err instanceof Error ? err.message : err));
  }

  // Approve (or try again): post or send to every connected channel it is meant for.
  return social.postNow(item, reviewer, "human_user", action === "retry" ? "Tried again" : "Approved", { ...approval, ...(item.kind === "social_post" ? { scheduledFor: item.scheduledFor ?? new Date() } : {}) }, opts.notes);
}

/** What this employee has waiting for the owner, newest first. */
export async function waitingFor(orgId: number, employeeId: number) {
  return (await db.listOutboundItemsByOrg(orgId)).filter((i) => i.employeeId === employeeId && i.status === "pending_approval").sort((a, b) => b.id - a.id);
}

/** Plain words for what an item is, for chat. */
export function itemKindLabel(kind: string) {
  const labels: Record<string, string> = { calendar_hold: "calendar hold", social_post: "post", blog_post: "article", outreach_email: "outreach email", lead_reply: "reply", email: "email", meeting_invite: "meeting invite", press_pitch: "pitch" };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

/** What came out of an approval: where it went, and any link (a calendar event, a meeting link, a post). */
export function outcomeOf(item: OutboundItem | null | undefined) {
  if (!item) return { text: "", url: null as string | null };
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(item.metadata || "{}");
  } catch {
    meta = {};
  }
  const meeting = meta.meeting as { platform?: string; url?: string } | undefined;
  const links: string[] = [];
  if (meeting?.url) links.push(`${meeting.platform === "zoom" ? "Zoom" : meeting.platform === "teams" ? "Teams" : "Google Meet"} link: ${meeting.url}`);
  if (item.externalReference && /^https?:\/\//.test(item.externalReference)) links.push(`${item.kind === "calendar_hold" ? "Calendar event" : "Link"}: ${item.externalReference}`);
  const status = item.status === "published" ? "It went out." : item.status === "scheduled" ? "It is scheduled." : item.status === "approved" ? "It is approved and waiting for its time." : item.status === "blocked_connection" ? `It did not go out: ${item.reviewerNotes || "a connection is missing; see Approvals"}.` : "";
  return { text: [status, ...links].filter(Boolean).join(" "), url: meeting?.url ?? item.externalReference ?? null };
}
