import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import type { TrpcContext } from "./_core/context";
import { requestCode, signOut, verifyCode } from "./_core/auth";
import { aiStatus, describeImage } from "./_core/llm";
import { decryptJson, encryptJson, hasSecretsKey } from "./_core/crypto";
import * as db from "./db";
import {
  SOP_AREAS,
  ORG_TYPES,
  COMPLIANCE_KINDS,
  KNOWLEDGE_CATEGORIES,
  OPP_KINDS,
  OUTBOUND_KINDS,
  PROVIDERS,
  REGISTRATION_KINDS,
  type User,
} from "../drizzle/schema";
import { ROSTER } from "./employees/roster";
import { ensureRoster } from "./employees/roster-sync";
import * as tasks from "./employees/tasks";
import { sendChatMessage, spokenText, workingOn } from "./employees/chat";
import * as apply from "./employees/apply";
import * as exportsFor from "./employees/exports";
import { indexKnowledge } from "./employees/kb";
import { describeRule, isValidTimeZone, nextRun } from "./employees/schedule";
import { runTaskNow } from "./employees/runner";
import { fetchWebpage, saveDocument, saveImage, savePhoto } from "./employees/files";
import { usageSummary } from "./usage";
import * as bids from "./employees/bids";
import * as browserLive from "./employees/browser";

/** Live-browser errors (session ended, not in control) reach the person as plain messages. */
async function liveCall<T>(fn: () => T | Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message });
  }
}
import { sendEmail } from "./_core/email";
import { ENV } from "./_core/env";
import { REPEATS, HR_STAGES, EMPLOYEE_KINDS } from "../drizzle/schema";
import * as hiring from "./employees/hiring";
import { TEMPLATES, progress as onboardingProgress, writeDayToDay } from "./employees/onboarding";
import * as interview from "./employees/interview";
import * as integrations from "./integrations";
import * as review from "./review";
import * as handbook from "./employees/handbook";
import * as pages from "./employees/pages";
import * as social from "./social";
import * as sales from "./employees/sales";
import * as team from "./employees/team";
import * as projects from "./employees/projects";
import * as coo from "./employees/coo";
import * as notetaker from "./employees/notetaker";
import * as huddle from "./employees/huddle";
import { endOneOnOne } from "./employees/oneonone";
import * as avatar from "./employees/avatar";
import * as newsroom from "./employees/newsroom";
import * as cold from "./employees/cold";
import * as coldreply from "./employees/coldreply";
import * as desk from "./employees/desk";
import * as precall from "./employees/precall";
import * as pitching from "./employees/pitching";
import * as presslib from "./employees/presslib";
import * as history from "./employees/history";
import { linkFor } from "./mcp";
import * as dev from "./employees/dev";
import { opsFor, saveOps, MEETING_MINUTES } from "./employees/ops";
import { KPI_SOURCES } from "../drizzle/schema";
import { postProblems, SOCIAL_CHANNELS, TIKTOK_PRIVACY, type SocialChannel } from "@shared/post-model";
import { isStaffEmail } from "./_core/auth";
import { EVENT_LABELS, NOTIFY_EVENTS, SOUNDS, notify, pingsFor, pushReady, pushTo, readPrefs, readSound, type Prefs, type SoundSettings } from "./notify";

// ==========================================
// Access rules
// ==========================================

type Role = "owner" | "admin" | "member" | "chat" | "reviewer";
/** chat (team chat only) sits below every other role: it reaches the team chat, the Team page and the person's own account, nothing else. */
const RANK: Record<Role, number> = { chat: 0, reviewer: 1, member: 2, admin: 3, owner: 4 };
const ROLE_WORD: Record<Role, string> = { owner: "an owner", admin: "an admin", member: "a member", chat: "team chat only", reviewer: "a reviewer" };

/**
 * Throws unless the signed-in person belongs to the workspace (with at least
 * the given role). LeadDash staff (users.role = admin) get support access to
 * every workspace without being added to its team.
 */
/** Taylor's long newsroom jobs run in the background; a failure is posted in her chat. */
const pressBusy = new Set<string>();
function press_bg(orgId: number, label: string, job: () => Promise<unknown>, quiet = false) {
  const key = `${orgId}:${label}`;
  if (pressBusy.has(key)) throw new TRPCError({ code: "BAD_REQUEST", message: `Taylor is already ${label}.` });
  pressBusy.add(key);
  void job()
    .catch(async (err) => {
      if (quiet) return;
      const emp = await db.getEmployeeByKind(orgId, "speaking");
      if (emp) await db.createChatMessage({ organizationId: orgId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `I stopped ${label}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` });
    })
    .finally(() => pressBusy.delete(key));
}

/** The workspaces where this person is an owner or admin. */
async function adminWorkspaces(userId: number) {
  const out: { id: number; name: string }[] = [];
  for (const o of await db.listOrganizationsForUser(userId)) {
    const m = await db.getOrganizationMembership(o.id, userId);
    if (m && ["owner", "admin"].includes(m.role)) out.push({ id: o.id, name: o.name });
  }
  return out;
}

async function requireMember(ctx: TrpcContext & { user: User }, organizationId: number, minRole: Role = "reviewer") {
  if (ctx.user.role === "admin") return { role: "owner" as Role, support: true };
  // The app reviewer only ever reaches the demo workspace.
  if (review.isReviewUser(ctx.user) && !review.isDemoOrg(organizationId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `Access denied: you are not an authorized member of organization #${organizationId}.` });
  }
  const membership = await db.getOrganizationMembership(organizationId, ctx.user.id);
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access denied: you are not an authorized member of organization #${organizationId}.`,
    });
  }
  if (RANK[membership.role as Role] < RANK[minRole]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Your role in this workspace cannot do that." });
  }
  return { role: membership.role as Role, support: false };
}

/** Who is looking at Projects: a member (by role), or a guest on shared lists. */
async function pjViewer(ctx: TrpcContext & { user: User }, organizationId: number): Promise<import("./work/pjAccess").Viewer> {
  try {
    const m = await requireMember(ctx, organizationId);
    return { kind: "member", userId: ctx.user.id, role: m.role, name: personName(ctx.user) };
  } catch (err) {
    if (!review.isReviewUser(ctx.user) && db.guestSharesForUser(ctx.user.id).some((g) => g.organizationId === organizationId)) return { kind: "guest", userId: ctx.user.id, name: personName(ctx.user) };
    throw err;
  }
}
const pjActor = (ctx: { user: User }) => ({ type: "user" as const, id: ctx.user.id, name: personName(ctx.user) });

/** The app reviewer can look around the demo workspace but cannot change its team. */
function blockReviewer(ctx: TrpcContext & { user: User }) {
  if (review.isReviewUser(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: "The review account cannot change the team." });
}

/** A member who may make this kind of decision (some are the owner's only, per Avery's Rules). */
async function requireDecide(ctx: TrpcContext & { user: User }, organizationId: number, category: string, minRole: Role = "member") {
  const m = await requireMember(ctx, organizationId, minRole);
  await desk.assertDecide(organizationId, m.role, category);
  return m;
}

/** The employee for a member of the workspace, or NOT_FOUND. */
async function empFor(ctx: { user: User } & Parameters<typeof requireMember>[0], organizationId: number, employeeId: number) {
  await requireMember(ctx, organizationId, "member");
  const emp = await db.getEmployeeForOrg(employeeId, organizationId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  return emp;
}

/** Writes a description for an uploaded image in the background. */
async function describeSaved(orgId: number, itemId: number, dataUrl: string) {
  try {
    const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!m) return;
    const text = await describeImage(Buffer.from(m[2], "base64"), m[1]);
    if (!text) return;
    const item = await db.updateKnowledgeItem(itemId, orgId, { content: text });
    if (item) indexKnowledge(item);
  } catch (err) {
    console.warn("[brain] describe image failed:", err instanceof Error ? err.message : err);
  }
}

/** The person's real name for the audit trail and approvals. */
function personName(user: User) {
  return user.name?.trim() || user.email;
}

const orgInput = z.object({ organizationId: z.number().int().positive() });
const ymdZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const assigneeZ = z.object({ type: z.enum(["user", "employee", "name"]), id: z.number().int(), name: z.string().max(120) });
const statusZ = z.object({ name: z.string().max(40), color: z.string().max(9), type: z.enum(["open", "active", "done", "closed"]) });
const fieldZ = z.object({
  id: z.string().max(60),
  name: z.string().max(80),
  type: z.enum(["text", "number", "money", "date", "checkbox", "dropdown", "labels", "people", "email", "phone", "website", "rating", "progress", "formula", "files", "relationship"]),
  options: z.array(z.object({ id: z.string().max(60), name: z.string().max(80), color: z.string().max(9) })).max(50).optional(),
  setup: z.string().max(300).optional(),
  scope: z.enum(["list", "folder"]).optional(),
});
const repeatZ = z.object({
  every: z.number().int().min(1).max(365),
  unit: z.enum(["day", "week", "month", "year"]),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  mode: z.enum(["done", "schedule"]),
  ends: z.enum(["never", "date", "count"]),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  count: z.number().int().min(1).max(1000).optional(),
  keep: z.object({ subtasks: z.boolean(), checklist: z.boolean(), assignees: z.boolean(), comments: z.boolean() }),
  made: z.number().int().optional(),
  spawned: z.boolean().optional(),
});
const levelZ = z.enum(["full", "edit", "comment", "view"]);
const triggerZ = z.object({
  on: z.enum(["created", "status", "due", "overdue", "field", "assigned", "comment", "subtasks", "unblocked", "form", "schedule"]),
  to: z.string().max(80).optional(),
  field: z.string().max(60).optional(),
  formId: z.number().int().optional(),
  every: z.enum(["day", "weekday", "week"]).optional(),
  day: z.number().int().min(0).max(6).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});
const actionZ = z.object({
  do: z.enum(["assign", "priority", "status", "field", "watcher", "comment", "task", "move", "ask", "notify", "chat", "email", "meeting"]),
  value: z.string().max(500),
  field: z.string().max(60).optional(),
  listId: z.number().int().optional(),
  templateId: z.number().int().optional(),
  to: z.string().max(200).optional(),
});
const viewKindZ = z.enum(["list", "board", "calendar", "gantt", "table", "workload", "timeline", "mindmap"]);
const viewSettingsZ = z.object({ group: z.enum(["status", "priority", "assignee", "none"]).optional(), who: z.string().max(160).optional(), priority: z.string().max(20).optional(), closed: z.boolean().optional(), q: z.string().max(120).optional(), columns: z.array(z.string().max(60)).max(40).optional(), sort: z.string().max(40).optional() });
const blockZ = z.object({ id: z.string().max(40), type: z.string().max(20), text: z.string().max(8000), done: z.boolean().optional(), rows: z.array(z.array(z.string().max(500)).max(10)).max(30).optional(), url: z.string().max(600).optional(), taskId: z.number().int().optional() });
const itemZ = z.object({ id: z.string().max(40), kind: z.string().max(10), x: z.number(), y: z.number(), w: z.number(), h: z.number(), color: z.string().max(9).optional(), text: z.string().max(2000).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(), taskId: z.number().int().optional(), path: z.string().max(20000).optional(), z: z.number().optional() });
const questionZ = z.object({ id: z.string().max(40), label: z.string().max(200), type: z.enum(["text", "longtext", "email", "phone", "number", "dropdown", "labels", "date", "files"]), required: z.boolean(), options: z.array(z.string().max(80)).max(40).optional(), mapTo: z.string().max(80) });
const cardZ = z.object({
  id: z.string().max(40),
  type: z.enum(["count", "status", "person", "overdue", "time", "workload", "trend", "burndown", "tasks", "goal", "doc", "fieldsum"]),
  title: z.string().max(80),
  scope: z.object({ kind: z.enum(["everything", "folder", "list", "me"]), id: z.number().int().optional() }),
  options: z.object({ which: z.enum(["open", "overdue", "done", "all"]).optional(), field: z.string().max(60).optional(), goalId: z.number().int().optional(), docId: z.number().int().optional() }).optional(),
  size: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});
const mediaMeta = z.object({ name: z.string().max(200).optional(), w: z.number().optional(), h: z.number().optional(), seconds: z.number().optional(), size: z.number().optional() });

const SECRET_KEYS = ["clientSecret", "appSecret", "appPassword", "accessToken", "refreshToken", "apiKey"];

function publicConnection<T extends { secretsEncrypted: string | null }>(conn: T) {
  const { secretsEncrypted, ...rest } = conn;
  let secretFields: string[] = [];
  try {
    secretFields = Object.keys(decryptJson(secretsEncrypted) ?? {});
  } catch {
    secretFields = [];
  }
  return { ...rest, savedSecrets: secretFields };
}

/** Loads a work item and checks it is the expected kind in this workspace. */
async function workItemOf(organizationId: number, id: number, kind: "website_plan" | "video_plan") {
  const item = await db.getWorkItemForOrg(id, organizationId);
  if (!item || item.kind !== kind) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in this workspace." });
  return item;
}

/** Gives a new workspace every employee on the roster. */
async function deployRoster(organizationId: number) {
  await ensureRoster(organizationId);
}

export const appRouter = router({
  system: systemRouter,

  // ==========================================
  // Sign-in
  // ==========================================
  auth: router({
    me: publicProcedure.query(({ ctx }) =>
      ctx.user
        ? { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, avatarUrl: ctx.user.avatarUrl ?? null, role: ctx.user.role, reviewer: review.isReviewUser(ctx.user) }
        : null
    ),

    requestCode: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320) }))
      .mutation(({ input }) => requestCode(input.email)),

    verifyCode: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320), code: z.string().min(6).max(12) }))
      .mutation(async ({ ctx, input }) => {
        const user = await verifyCode(input.email, input.code, ctx.req, ctx.res);
        return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl ?? null, role: user.role, reviewer: review.isReviewUser(user) };
      }),

    logout: publicProcedure.mutation(async ({ ctx }) => {
      await signOut(ctx.sessionTokenHash, ctx.req, ctx.res);
      return { success: true } as const;
    }),

    updateProfile: protectedProcedure
      .input(z.object({ name: z.string().trim().min(1).max(120) }))
      .mutation(async ({ ctx, input }) => {
        const user = await db.updateUser(ctx.user.id, { name: input.name });
        return { id: user!.id, email: user!.email, name: user!.name, avatarUrl: user!.avatarUrl ?? null, role: user!.role };
      }),

    /** Your photo, shown instead of your initials. */
    uploadPhoto: protectedProcedure
      .input(z.object({ data: z.string().max(12_000_000) }))
      .mutation(async ({ ctx, input }) => {
        const saved = await savePhoto(ctx.user.id, input.data);
        const user = await db.updateUser(ctx.user.id, { avatarUrl: saved.url });
        return { avatarUrl: user?.avatarUrl ?? null };
      }),

    removePhoto: protectedProcedure.mutation(async ({ ctx }) => {
      await db.updateUser(ctx.user.id, { avatarUrl: null });
      return { avatarUrl: null };
    }),
  }),

  /** Which AI services are configured on this server (no secrets returned). */
  status: protectedProcedure.query(() => ({ ai: aiStatus(), secretsKey: hasSecretsKey() })),

  // ==========================================
  // Workspaces
  // ==========================================
  organizations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      if (ctx.user.role === "admin") return (await db.listOrganizations()).map((o) => ({ ...o, guest: false }));
      const mine = await db.listOrganizationsForUser(ctx.user.id);
      if (review.isReviewUser(ctx.user)) return mine.filter((o) => review.isDemoOrg(o.id)).map((o) => ({ ...o, guest: false }));
      // Each workspace carries the person's role there, so the app knows what to show (team chat only people see the chat, the Team page and their account).
      const withRole = [] as (typeof mine[number] & { guest: boolean; role?: string })[];
      for (const o of mine) withRole.push({ ...o, guest: false, role: (await db.getOrganizationMembership(o.id, ctx.user.id))?.role ?? "member" });
      // Workspaces where this person is only a guest on shared Projects lists.
      const guestOf = await (await import("./work/pjAccess")).guestWorkspaces(ctx.user.id);
      return [...withRole, ...guestOf.map((o) => ({ ...o, guest: true }))];
    }),

    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.id);
      const org = await db.getOrganizationById(input.id);
      if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found." });
      return org;
    }),

    /** LeadDash staff create workspaces, then add the practice's owner. */
    create: adminProcedure
      .input(
        z.object({
          name: z.string().trim().min(2).max(255),
          slug: z
            .string()
            .trim()
            .min(2)
            .max(100)
            .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes"),
          plan: z.enum(["starter", "growth", "enterprise"]).default("growth"),
          orgType: z.enum(ORG_TYPES).default("business"),
          focusAreas: z.string().max(2000).optional(),
          ein: z.string().max(30).optional(),
          annualBudget: z.string().max(100).optional(),
          website: z.string().max(255).optional(),
          state: z.string().max(50).optional(),
          ownerEmail: z.string().trim().email().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (await db.getOrganizationBySlug(input.slug)) {
          throw new TRPCError({ code: "CONFLICT", message: "That workspace address is taken." });
        }
        const org = await db.createOrganization({
          name: input.name,
          slug: input.slug,
          plan: input.plan,
          orgType: input.orgType,
          focusAreas: input.focusAreas || null,
          ein: input.ein || null,
          annualBudget: input.annualBudget || null,
          website: input.website || null,
          state: input.state || null,
        });
        if (input.ownerEmail) {
          let owner = await db.getUserByEmail(input.ownerEmail);
          if (!owner) owner = await db.createUser({ email: input.ownerEmail });
          await db.addOrganizationMember({ organizationId: org.id, userId: owner.id, role: "owner", title: "Owner" });
        }
        // No owner named: the person making it is the owner, on its team, so team chat and "notes for <owner>" work from day one.
        if (!input.ownerEmail && !(await db.getOrganizationMembership(org.id, ctx.user.id))) await db.addOrganizationMember({ organizationId: org.id, userId: ctx.user.id, role: "owner", title: "Owner" });
        await deployRoster(org.id);
        await db.logAction({
          organizationId: org.id,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Workspace created",
          details: `Created ${org.name} with ${ROSTER.length} employees.`,
        });
        return { success: true, id: org.id };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().trim().min(2).max(255).optional(),
          focusAreas: z.string().max(2000).optional(),
          ein: z.string().max(30).optional(),
          annualBudget: z.string().max(100).optional(),
          website: z.string().max(255).optional(),
          state: z.string().max(50).optional(),
          description: z.string().max(4000).optional(),
          audience: z.string().max(2000).optional(),
          entity: z.string().max(255).optional(),
          brandColors: z.string().max(500).optional(),
          fonts: z.string().max(255).optional(),
          timezone: z.string().max(64).optional(),
          signerName: z.string().max(120).optional(),
          signerTitle: z.string().max(120).optional(),
          orgType: z.enum(ORG_TYPES).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.id, "admin");
        const { id, ...data } = input;
        if (data.timezone && !isValidTimeZone(data.timezone)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That time zone is not recognized. Use a name like America/Chicago." });
        }
        const before = await db.getOrganizationById(id);
        const updated = await db.updateOrganization(id, data);
        // A new organization type changes who is on the team, the titles and the departments.
        if (data.orgType && before && before.orgType !== data.orgType) await deployRoster(id);
        await db.logAction({
          organizationId: id,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Workspace profile updated",
          details: `Updated: ${Object.keys(data).join(", ") || "nothing"}.`,
        });
        return updated;
      }),

    uploadLogo: protectedProcedure
      .input(z.object({ id: z.number(), data: z.string().max(12_000_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.id, "admin");
        const saved = await saveImage(input.id, input.data, "logo");
        return db.updateOrganization(input.id, { logoUrl: saved.url });
      }),

    removeLogo: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.id, "admin");
        return db.updateOrganization(input.id, { logoUrl: null });
      }),
  }),

  // ==========================================
  // Team (people, not AI employees)
  // ==========================================
  members: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return db.listMembers(input.organizationId);
    }),

    add: protectedProcedure
      .input(
        orgInput.extend({
          email: z.string().trim().email(),
          name: z.string().trim().max(120).optional(),
          role: z.enum(["admin", "member", "chat", "reviewer"]).default("member"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        blockReviewer(ctx);
        await requireMember(ctx, input.organizationId, "admin");
        let user = await db.getUserByEmail(input.email);
        if (!user) user = await db.createUser({ email: input.email, name: input.name || null });
        if (user.role === "admin" || (await db.getOrganizationMembership(input.organizationId, user.id))) {
          throw new TRPCError({ code: "CONFLICT", message: "That person cannot be added to this workspace." });
        }
        await db.addOrganizationMember({ organizationId: input.organizationId, userId: user.id, role: input.role });
        const org = await db.getOrganizationById(input.organizationId);
        void sendEmail(
          user.email,
          `You've been added to ${org?.name ?? "a workspace"} on LeadDash Employees`,
          `${personName(ctx.user)} added you to ${org?.name ?? "a workspace"} on LeadDash Employees (${ROLE_WORD[input.role]}).${input.role === "chat" ? " You can read and write in the team channels and direct messages." : ""}\n\nSign in with this email address at ${ENV.appUrl}/signin`
        ).catch((err) => console.error("[team] invite email failed:", err));
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Team member added",
          details: `Added ${input.name || input.email} (${ROLE_WORD[input.role]}).`,
        });
        return { success: true };
      }),

    updateRole: protectedProcedure
      .input(orgInput.extend({ userId: z.number(), role: z.enum(["owner", "admin", "member", "chat", "reviewer"]) }))
      .mutation(async ({ ctx, input }) => {
        blockReviewer(ctx);
        const members = await db.listMembers(input.organizationId).catch(() => []);
        const target = members.find((m) => m.userId === input.userId);
        // Making or unmaking an owner takes an owner.
        await requireMember(ctx, input.organizationId, input.role === "owner" || target?.role === "owner" ? "owner" : "admin");
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not on this workspace." });
        if (target.role === "owner" && input.role !== "owner" && members.filter((m) => m.role === "owner").length === 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A workspace needs at least one owner." });
        }
        await db.updateMemberRole(input.organizationId, input.userId, input.role);
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Team role changed",
          details: `${target.name || target.email} is now ${ROLE_WORD[input.role]}.`,
        });
        return { success: true };
      }),

    remove: protectedProcedure
      .input(orgInput.extend({ userId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        blockReviewer(ctx);
        await requireMember(ctx, input.organizationId, "admin");
        const members = await db.listMembers(input.organizationId);
        const target = members.find((m) => m.userId === input.userId);
        if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not on this workspace." });
        if (target.role === "owner") await requireMember(ctx, input.organizationId, "owner");
        if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A workspace needs at least one owner." });
        }
        await db.removeMember(input.organizationId, input.userId);
        if ((await db.countMembershipsForUser(input.userId)) === 0) await db.revokeSessionsForUser(input.userId);
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Team member removed",
          details: `Removed ${target.name || target.email}.`,
        });
        return { success: true };
      }),
  }),

  // ==========================================
  // AI employees
  // ==========================================
  employees: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listEmployeesByOrg(input.organizationId);
    }),

    get: protectedProcedure
      .input(z.object({ id: z.number(), organizationId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        return db.getEmployeeForOrg(input.id, input.organizationId);
      }),

    toggleStatus: protectedProcedure
      .input(z.object({ id: z.number(), organizationId: z.number(), status: z.enum(["active", "idle", "working", "paused"]) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const emp = await db.updateEmployee(input.id, input.organizationId, { status: input.status });
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Employee not found in this workspace." });
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: input.status === "paused" ? "Paused employee" : "Resumed employee",
          details: `${emp.name} is now ${input.status}.`,
        });
        return emp;
      }),

    /** Rename an employee or add workspace-specific instructions. */
    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          organizationId: z.number(),
          name: z.string().trim().min(1).max(100).optional(),
          systemPrompt: z.string().max(4000).nullable().optional(),
          guidelines: z
            .object({ focus: z.string().max(2000), avoid: z.string().max(2000), signAs: z.string().max(200) })
            .optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { id, organizationId, guidelines, ...rest } = input;
        const data = { ...rest, ...(guidelines ? { guidelines: JSON.stringify(guidelines) } : {}) };
        const emp = await db.updateEmployee(id, organizationId, data);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Employee not found in this workspace." });
        return emp;
      }),

    create: protectedProcedure
      .input(
        z.object({
          organizationId: z.number(),
          name: z.string().trim().min(2).max(100),
          roleTitle: z.string().trim().min(2).max(100),
          department: z.string().trim().min(2).max(100),
          description: z.string().max(2000),
          capabilities: z.array(z.string().max(200)).max(20),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        await db.createEmployee({
          organizationId: input.organizationId,
          kind: "custom",
          name: input.name,
          avatar: null,
          roleTitle: input.roleTitle,
          department: input.department,
          status: "active",
          efficiency: 97,
          description: input.description,
          capabilities: JSON.stringify(input.capabilities),
          systemPrompt: null,
        });
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Hired employee",
          details: `Added ${input.name} as ${input.roleTitle}.`,
        });
        return { success: true };
      }),
  }),

  // ==========================================
  // Applying: Morgan (grants, pitch competitions, accelerators) and
  // Taylor (speaking), one engine
  // ==========================================
  opps: router({
    list: protectedProcedure
      .input(orgInput.extend({ employee: z.enum(["grants", "speaking"]) }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const list = await db.listOpps(input.organizationId, apply.KINDS_FOR[input.employee]);
        const files = await db.listOppFilesForOrg(input.organizationId);
        // Skipped ones (by the employee's call or by a person) come along: the screen keeps them on their own tab.
        return list
          .map((o) => ({
            ...o,
            files: files.filter((f) => f.opportunityId === o.id).map((f) => ({ id: f.id, name: f.name, pages: f.pages, pagesUnit: f.pagesUnit, status: f.status, note: f.note, fileUrl: f.fileUrl })),
          }));
      }),

    find: protectedProcedure
      .input(orgInput.extend({ employee: z.enum(["grants", "speaking"]), kind: z.enum(OPP_KINDS).optional(), focus: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const r = await apply.findOpportunities(input.organizationId, input.employee, { kind: input.kind, focus: input.focus });
        return { added: r.created.length, queries: r.queries };
      }),

    addLink: protectedProcedure
      .input(orgInput.extend({ employee: z.enum(["grants", "speaking"]), url: z.string().trim().min(4).max(2000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.addOpportunity(input.organizationId, input.employee, { url: input.url }, personName(ctx.user));
      }),

    refreshPackage: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const opp = await db.getOpp(input.id, input.organizationId);
        if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
        await db.updateOpp(opp.id, input.organizationId, { packageStatus: "fetching" });
        apply.enqueue(`package-${opp.id}`, () => apply.fetchPackage(input.organizationId, opp.id));
        return { success: true };
      }),

    skip: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const opp = await db.updateOpp(input.id, input.organizationId, { status: "dismissed" });
        if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
        return opp;
      }),
    // Bring a skipped one back: it counts as worth applying to from now on, with the old reason kept.
    restore: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const have = await db.getOpp(input.id, input.organizationId);
        if (!have) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
        // A person's call beats the score: the score is lifted to the Apply line so a restart's tidy-up doesn't skip it again.
        const opp = await db.updateOpp(input.id, input.organizationId, { status: "new", fitCall: have.fitCall === "skip" ? "apply" : have.fitCall, fitScore: have.fitCall === "skip" ? Math.max(60, have.fitScore) : have.fitScore, fitReason: have.fitCall === "skip" ? `${personName(ctx.user)} brought this back. ${have.fitReason ?? ""}`.trim() : have.fitReason });
        return opp!;
      }),

    downloadPackage: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        return exportsFor.packageZip(input.organizationId, input.id);
      }),

    /** A question for the buyer, drafted as an email to the address in the bid; it waits in Approvals. */
    ask: protectedProcedure
      .input(orgInput.extend({ id: z.number(), question: z.string().trim().min(5).max(2000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return bids.askQuestion(input.organizationId, input.id, input.question);
      }),
  }),

  /** BidPrime: Morgan signs in with the saved account and reads new bids every morning. */
  /** Watching an employee's browser in chat, and taking over. */
  browser: router({
    live: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return browserLive.liveView(input.organizationId);
    }),
    takeOver: protectedProcedure.input(orgInput.extend({ id: z.string().max(40) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return liveCall(() => browserLive.liveTakeOver(input.organizationId, input.id));
    }),
    handBack: protectedProcedure.input(orgInput.extend({ id: z.string().max(40) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return liveCall(() => browserLive.liveHandBack(input.organizationId, input.id));
    }),
    stop: protectedProcedure.input(orgInput.extend({ id: z.string().max(40) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return liveCall(() => browserLive.liveStop(input.organizationId, input.id));
    }),
    input: protectedProcedure
      .input(
        orgInput.extend({
          id: z.string().max(40),
          kind: z.enum(["click", "type", "key", "scroll"]),
          x: z.number().min(0).max(1).default(0),
          y: z.number().min(0).max(1).default(0),
          text: z.string().max(500).default(""),
          key: z.string().max(20).default(""),
          dy: z.number().min(-2000).max(2000).default(0),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const i =
          input.kind === "click" ? { kind: "click" as const, x: input.x, y: input.y } : input.kind === "type" ? { kind: "type" as const, text: input.text } : input.kind === "key" ? { kind: "key" as const, key: input.key } : { kind: "scroll" as const, dy: input.dy };
        return liveCall(() => browserLive.liveInput(input.organizationId, input.id, i));
      }),
  }),

  bidprime: router({
    get: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return bids.bidprimeView(input.organizationId);
    }),
    save: protectedProcedure
      .input(orgInput.extend({ email: z.string().trim().email().max(320), password: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const v = await bids.saveBidPrime(input.organizationId, input.email, input.password);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved BidPrime sign-in", details: input.email });
        bids.queueCheck(input.organizationId, true);
        return v;
      }),
    disconnect: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return bids.disconnectBidPrime(input.organizationId);
    }),
    check: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return { queued: bids.queueCheck(input.organizationId, true) };
    }),
    code: protectedProcedure
      .input(orgInput.extend({ code: z.string().trim().min(4).max(20) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return bids.submitBidPrimeCode(input.organizationId, input.code);
      }),
    portalCode: protectedProcedure
      .input(orgInput.extend({ portalId: z.number(), applicationId: z.number(), code: z.string().trim().min(4).max(20) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return bids.submitPortalCode(input.organizationId, input.portalId, input.applicationId, input.code);
      }),
  }),

  applications: router({
    list: protectedProcedure
      .input(orgInput.extend({ employee: z.enum(["grants", "speaking"]).optional() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const [apps, opps, questions] = await Promise.all([
          db.listApplications(input.organizationId),
          db.listOpps(input.organizationId),
          db.listOpenQuestions(input.organizationId),
        ]);
        const kinds = input.employee ? apply.KINDS_FOR[input.employee] : null;
        const out = [];
        for (const a of apps) {
          const opp = opps.find((o) => o.id === a.opportunityId) ?? null;
          if (kinds && (!opp || !kinds.includes(opp.kind))) continue;
          out.push({
            ...a,
            opp: opp && { id: opp.id, kind: opp.kind, host: opp.host, amount: opp.amount, deadline: opp.deadline, sourceUrl: opp.sourceUrl, eventDate: opp.eventDate },
            openQuestions: questions.filter((q) => q.applicationId === a.id).length,
            blockers: await apply.blockers(input.organizationId, a),
          });
        }
        return out;
      }),

    get: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const app = await db.getApplication(input.id, input.organizationId);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
        const opp = await db.getOpp(app.opportunityId, input.organizationId);
        const files = opp ? await db.listOppFiles(input.organizationId, opp.id) : [];
        const org = await db.getOrganizationById(input.organizationId);
        return {
          app,
          opp,
          files,
          questions: await db.listOpenQuestions(input.organizationId, app.id),
          blockers: await apply.blockers(input.organizationId, app),
          sending: await bids.readiness(input.organizationId, app),
          signer: { name: org?.signerName ?? null, title: org?.signerTitle ?? null, org: org?.name ?? "" },
        };
      }),

    start: protectedProcedure
      .input(orgInput.extend({ opportunityId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.startApplication(input.organizationId, input.opportunityId, personName(ctx.user));
      }),

    rewrite: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.rewriteApplication(input.organizationId, input.id);
      }),

    saveAnswer: protectedProcedure
      .input(orgInput.extend({ id: z.number(), questionId: z.string().max(20), answer: z.string().max(60_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.saveAnswer(input.organizationId, input.id, input.questionId, input.answer);
      }),

    rewriteQuestion: protectedProcedure
      .input(orgInput.extend({ id: z.number(), questionId: z.string().max(20), style: z.enum(["detailed", "concise"]).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.rewriteQuestion(input.organizationId, input.id, input.questionId, undefined, input.style);
      }),

    review: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.reviewApplication(input.organizationId, input.id);
      }),

    fix: protectedProcedure
      .input(orgInput.extend({ id: z.number(), fixId: z.string().max(20) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.applyFix(input.organizationId, input.id, input.fixId);
      }),

    answer: protectedProcedure
      .input(orgInput.extend({ questionId: z.number(), answer: z.string().max(1000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.answerQuestion(input.organizationId, input.questionId, input.answer, personName(ctx.user));
      }),

    /** "Look it up": the employee researches the question instead of the person. */
    research: protectedProcedure
      .input(orgInput.extend({ questionId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.researchQuestion(input.organizationId, input.questionId);
      }),

    /** The person's Submit tap: they certify the application, then it goes in. */
    submit: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireDecide(ctx, input.organizationId, "contract");
        return apply.submitApplication(input.organizationId, input.id, personName(ctx.user));
      }),

    sendBack: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "reviewer");
        const app = await db.getApplication(input.id, input.organizationId);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "That application is not in this workspace." });
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Sent application back", details: app.title });
        return apply.rewriteApplication(input.organizationId, input.id);
      }),

    /** Try sending an approved response again (after adding a portal sign-in or fixing what stopped it). */
    sendNow: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const app = await db.getApplication(input.id, input.organizationId);
        if (!app || app.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Only an approved application can be sent." });
        apply.enqueue(`submit-${app.id}`, () => bids.autoSubmit(input.organizationId, app.id));
        return { queued: true };
      }),

    markSubmitted: protectedProcedure
      .input(orgInput.extend({ id: z.number(), confirmation: z.string().max(120).default("") }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.markSubmitted(input.organizationId, input.id, input.confirmation, personName(ctx.user));
      }),

    decide: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number(),
          result: z.enum(["awarded", "declined"]),
          amount: z.string().max(60).optional(),
          period: z.string().max(120).optional(),
          restrictions: z.string().max(500).optional(),
          reports: z.array(z.object({ name: z.string().max(120), due: z.string().max(40) })).max(20).optional(),
          reapplyDate: z.string().max(40).optional(),
          comments: z.string().max(40_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, ...rest } = input;
        return apply.recordDecision(organizationId, id, rest, personName(ctx.user));
      }),

    updateAward: protectedProcedure
      .input(orgInput.extend({ id: z.number(), spent: z.number().min(0).max(1e10).optional(), total: z.number().min(0).max(1e10).optional(), restrictions: z.string().max(500).optional(), period: z.string().max(120).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, ...patch } = input;
        return apply.updateAward(organizationId, id, patch);
      }),

    draftReport: protectedProcedure
      .input(orgInput.extend({ id: z.number(), index: z.number().int().min(0) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.draftReport(input.organizationId, input.id, input.index);
      }),

    download: protectedProcedure
      .input(orgInput.extend({ id: z.number(), what: z.enum(["docx", "zip", "deck", "report"]), index: z.number().int().min(0).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        if (input.what === "docx") return exportsFor.applicationDocx(input.organizationId, input.id);
        if (input.what === "deck") return exportsFor.deckPptx(input.organizationId, input.id);
        if (input.what === "report") return exportsFor.reportDocx(input.organizationId, input.id, input.index ?? 0);
        return exportsFor.applicationZip(input.organizationId, input.id);
      }),
  }),

  // ==========================================
  // Registrations (SAM.gov, Grants.gov...) and saved portal sign-ins
  // ==========================================
  registrations: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const rows = await db.listRegistrations(input.organizationId);
      return REGISTRATION_KINDS.map((kind) => rows.find((r) => r.kind === kind) ?? { id: 0, organizationId: input.organizationId, kind, status: "not_started" as const, details: "{}", expires: null, createdAt: null, updatedAt: null });
    }),

    save: protectedProcedure
      .input(
        orgInput.extend({
          kind: z.enum(REGISTRATION_KINDS),
          status: z.enum(["active", "set_up", "not_verified", "not_started", "expired"]),
          details: z.record(z.string(), z.string().max(300)),
          expires: z.string().regex(/^(\d{2}\/\d{2}\/\d{4})?$/, "Type the date as MM/DD/YYYY").optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const saved = await db.upsertRegistration(input.organizationId, input.kind, { status: input.status, details: JSON.stringify(input.details), expires: input.expires || null });
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Updated registration", details: input.kind });
        return saved;
      }),
  }),

  // Website logins: every employee can sign in with these in their browser
  portals: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/logins")).listView(input.organizationId);
    }),

    save: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().optional(),
          name: z.string().trim().min(2).max(120),
          url: z.string().trim().max(500).optional(),
          username: z.string().trim().min(1).max(200),
          password: z.string().max(500).optional(),
          lockName: z.string().trim().max(120).optional(),
          lockAddress: z.string().trim().max(800).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, ...rest } = input;
        const saved = await (await import("./employees/logins")).save(organizationId, rest);
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved website login", details: `${input.name}${saved?.lockName ? ` (only the ${saved.lockName} sub-account)` : ""}` });
        return { success: true };
      }),

    remove: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        await db.deletePortalLogin(input.id, input.organizationId);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Removed website login", details: String(input.id) });
        return { success: true };
      }),
  }),

  // Elena's mini drama studio
  drama: router({
    studio: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/drama")).studio(input.organizationId);
    }),
    episode: protectedProcedure.input(orgInput.extend({ id: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const dr = await import("./employees/drama");
      const e = db.getDramaEpisode(input.id, input.organizationId);
      return e ? dr.episodeView(e) : null;
    }),
    make: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const dr = await import("./employees/drama");
      return dr.episodeView(await dr.startEpisode(input.organizationId, input.id));
    }),
    stop: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const dr = await import("./employees/drama");
      return dr.episodeView(dr.stopEpisode(input.organizationId, input.id));
    }),
    remakeShot: protectedProcedure.input(orgInput.extend({ id: z.number(), n: z.number().int().min(1).max(30) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const dr = await import("./employees/drama");
      return dr.episodeView(await dr.remakeShot(input.organizationId, input.id, input.n));
    }),
    animateWith: protectedProcedure.input(orgInput.extend({ id: z.number(), n: z.number().int().min(1).max(30), engine: z.enum(["kling", "seedance"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const dr = await import("./employees/drama");
      return dr.episodeView(await dr.animateWith(input.organizationId, input.id, input.n, input.engine));
    }),
    clearTake: protectedProcedure.input(orgInput.extend({ id: z.number(), n: z.number().int().min(1).max(30) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const dr = await import("./employees/drama");
      return dr.episodeView(dr.clearTake(input.organizationId, input.id, input.n));
    }),
    pickDirection: protectedProcedure.input(orgInput.extend({ id: z.number(), pick: z.number().int().min(1).max(3) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const dr = await import("./employees/drama");
      const planned = await (await import("./employees/campaign")).planCampaign(input.organizationId, input.id, input.pick, personName(ctx.user));
      return dr.episodeView(await dr.startEpisode(input.organizationId, planned.id));
    }),
    approveKeyframes: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "keyframes");
      const dr = await import("./employees/drama");
      return dr.episodeView(await dr.approveKeyframes(input.organizationId, input.id));
    }),
    saveScript: protectedProcedure
      .input(orgInput.extend({ id: z.number(), cta: z.string().max(80), shots: z.array(z.object({ n: z.number().int(), vo: z.string().max(300), caption: z.string().max(120) })).max(20) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const dr = await import("./employees/drama");
        return dr.episodeView(dr.saveScript(input.organizationId, input.id, input));
      }),
    makePlates: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/drama")).makePlates(input.organizationId);
    }),
    savePack: protectedProcedure.input(orgInput.extend({ ids: z.array(z.number()).max(40) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await (await import("./employees/drama")).savePack(input.organizationId, input.ids);
      return { success: true };
    }),
    saveStyleRef: protectedProcedure
      .input(orgInput.extend({ id: z.string().max(20).optional(), name: z.string().trim().min(1).max(100), link: z.string().max(500), likes: z.array(z.string().max(30)).max(8), words: z.string().max(300) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return (await import("./employees/drama")).saveStyleRef(organizationId, rest);
      }),
    removeStyleRef: protectedProcedure.input(orgInput.extend({ id: z.string().max(20) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./employees/drama")).removeStyleRef(input.organizationId, input.id);
      return { success: true };
    }),
    saveCast: protectedProcedure
      .input(orgInput.extend({ id: z.number(), name: z.string().trim().min(1).max(80), role: z.string().max(120), look: z.string().max(500), voiceId: z.string().max(80).nullable(), voiceName: z.string().max(120).nullable() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, ...rest } = input;
        (await import("./employees/drama")).saveCast(organizationId, id, rest);
        return { success: true };
      }),
  }),

  // Calendars Avery checks, and sending addresses (extra Google accounts)
  // Taylor's newsroom: shared reporters, stories, campaigns, pitches, replies, interviews, coverage, library.
  // Jada's cold email: the lead list, campaigns through Instantly, replies, playbook and pre-call reports.
  cold: router({
    overview: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return cold.overview(input.organizationId);
    }),
    connect: protectedProcedure.input(orgInput.extend({ key: z.string().min(1).max(500) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const r = await cold.connect(input.organizationId, input.key);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Connected Instantly", details: "" });
      return r;
    }),
    disconnect: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      cold.disconnect(input.organizationId);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Disconnected Instantly", details: "" });
      return { success: true };
    }),
    saveSettings: protectedProcedure
      .input(orgInput.extend({ level: z.number().int().min(1).max(4), perInbox: z.number().int().min(1).max(50), rampPct: z.number().int().min(0).max(50), bounceRest: z.number().int().min(1).max(20), signature: z.string().max(200), address: z.string().max(300), optOut: z.string().max(300), alwaysNeedsYou: z.string().max(500), plan: z.enum(["growth", "hypergrowth", "lightspeed", "custom"]), contactsLimit: z.number().int().min(100).max(10_000_000).optional(), emailsLimit: z.number().int().min(500).max(100_000_000).optional(), website: z.string().max(300) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, ...rest } = input;
        const s = cold.saveSettings(organizationId, rest);
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Changed cold email settings", details: `Level ${s.level}, ${s.perInbox} per inbox` });
        return { success: true };
      }),
    pause: protectedProcedure.input(orgInput.extend({ paused: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      cold.setPaused(input.organizationId, input.paused);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: input.paused ? "Paused cold email" : "Resumed cold email", details: "" });
      return { success: true };
    }),
    checkSite: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const site = await cold.refreshSite(input.organizationId);
      return { found: site?.plans.length ?? 0 };
    }),
    syncInboxes: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await cold.syncInboxes(input.organizationId);
      return { success: true };
    }),
    restInbox: protectedProcedure.input(orgInput.extend({ id: z.number().int(), rest: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      if (input.rest) await cold.restInbox(input.organizationId, input.id);
      else await cold.resumeInbox(input.organizationId, input.id);
      return { success: true };
    }),

    leads: protectedProcedure
      .input(orgInput.extend({ q: z.string().max(100).optional(), segment: z.string().max(40).optional(), state: z.string().max(30).optional(), license: z.string().max(30).optional(), stage: z.enum(["new", "queued", "in_campaign", "replied", "booked", "finished", "not_fit", "dnc"]).optional(), tier: z.enum(["top", "mid", "test", "low"]).optional(), page: z.number().int().min(0).max(5000).default(0) }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const { organizationId, page, ...f } = input;
        return cold.leadsView(organizationId, f, page);
      }),
    importInstantly: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return cold.importFromInstantly(input.organizationId);
    }),
    research: protectedProcedure.input(orgInput.extend({ count: z.number().int().min(1).max(1000), state: z.string().max(30).optional(), license: z.string().max(30).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      if (cold.isResearching(input.organizationId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Jada is already researching leads." });
      cold.job(`research-${input.organizationId}`, () => cold.research(input.organizationId, input.count, { state: input.state, license: input.license }));
      return { started: true };
    }),
    stopLead: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await cold.stopLead(input.organizationId, input.id);
      return { success: true };
    }),
    doNotContact: protectedProcedure.input(orgInput.extend({ emails: z.array(z.string().max(200)).min(1).max(500), reason: z.string().max(200).default("Added by you") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      for (const e of input.emails) await cold.doNotContact(input.organizationId, e, input.reason);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Added to cold email do not contact", details: `${input.emails.length} ${input.emails.length === 1 ? "person" : "people"}` });
      return { success: true };
    }),
    suppressList: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const rows = db.cold.suppressList(input.organizationId);
      const csv = ["email,reason,added", ...rows.map((r) => `${r.email},"${r.reason.replace(/"/g, '""')}",${r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : ""}`)].join("\n");
      const { storagePut } = await import("./storage");
      const saved = await storagePut(`org-${input.organizationId}/downloads/Do not contact.csv`, Buffer.from(csv, "utf8"));
      return { url: saved.url, name: "Do not contact.csv" };
    }),

    campaigns: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return { list: cold.campaignsView(input.organizationId), angles: cold.ANGLES.map((a) => ({ key: a.key, name: a.name, idea: a.idea })), segments: Object.entries(cold.SEGMENT_LABEL).map(([key, label]) => ({ key, label })) };
    }),
    newCampaign: protectedProcedure.input(orgInput.extend({ angle: z.enum(["switcher", "missed_calls", "too_many", "group_ops", "growing", "owner_time"]), guidance: z.string().max(500).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const c = await cold.writeCampaign(input.organizationId, input.angle, { guidance: input.guidance });
      return cold.campaignView(c);
    }),
    saveCampaign: protectedProcedure
      .input(orgInput.extend({ id: z.number().int(), name: z.string().max(120), offer: z.string().max(500), ask: z.string().max(300), share: z.number().int().min(0).max(100), who: z.object({ segments: z.array(z.string().max(40)).max(6), minFit: z.number().int().min(0).max(100), states: z.array(z.string().max(30)).max(20), licenses: z.array(z.string().max(30)).max(10) }), steps: z.array(z.object({ day: z.number().int(), subject: z.string().max(200), subjectB: z.string().max(200), body: z.string().max(4000) })).length(4) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, ...rest } = input;
        return cold.campaignView(await cold.saveCampaign(organizationId, id, rest));
      }),
    startCampaign: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const c = await cold.startCampaign(input.organizationId, input.id);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Started a cold email campaign", details: c.name });
      return cold.campaignView(c);
    }),
    pauseCampaign: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return cold.campaignView(await cold.pauseCampaign(input.organizationId, input.id));
    }),
    removeCampaign: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      cold.removeCampaign(input.organizationId, input.id);
      return { success: true };
    }),
    pickWinner: protectedProcedure.input(orgInput.extend({ id: z.number().int(), version: z.enum(["a", "b"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return cold.campaignView(await cold.pickWinner(input.organizationId, input.id, input.version));
    }),
    applyReview: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await cold.applyReview(input.organizationId, input.id);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Approved Jada's weekly changes", details: "" });
      return { success: true };
    }),
    dismissReview: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      cold.dismissReview(input.organizationId, input.id);
      return { success: true };
    }),
    review: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const r = db.cold.reviews.get(input.id, input.organizationId);
      if (!r) return null;
      return { id: r.id, at: r.createdAt, status: r.status, points: cold.parse<string[]>(r.points, []), changes: cold.parse<cold.Change[]>(r.changes, []).map((c) => ({ ...c, campaign: db.cold.campaigns.get(c.campaignId, input.organizationId)?.name ?? "" })) };
    }),

    replies: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return coldreply.repliesView(input.organizationId);
    }),
    reply: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const r = db.cold.replies.get(input.id, input.organizationId);
      return r ? coldreply.replyView(input.organizationId, r) : null;
    }),
    checkReplies: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return coldreply.checkReplies(input.organizationId);
    }),
    saveDraft: protectedProcedure.input(orgInput.extend({ id: z.number().int(), text: z.string().max(6000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      coldreply.saveDraft(input.organizationId, input.id, input.text);
      return { success: true };
    }),
    sendReply: protectedProcedure.input(orgInput.extend({ id: z.number().int(), text: z.string().max(6000).optional() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "reply");
      await coldreply.send(input.organizationId, input.id, input.text ?? null, personName(ctx.user));
      return { success: true };
    }),
    takeOver: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      coldreply.takeOver(input.organizationId, input.id);
      return { success: true };
    }),

    playbook: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return cold.playbookView(input.organizationId);
    }),
    savePlay: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), kind: z.enum(["objection", "battle", "fact", "never", "example"]), title: z.string().max(300), body: z.record(z.string(), z.string().max(4000)) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return cold.savePlay(organizationId, rest);
    }),
    removePlay: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      cold.removePlay(input.organizationId, input.id);
      return { success: true };
    }),
  }),

  // The Pre-call report: a skill any employee can run before a meeting.
  // Avery's desk: Today, Decisions, Waiting and Rules, and the People tab on Activity.
  desk: router({
    today: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return desk.today(input.organizationId);
    }),
    decisions: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId);
      await desk.syncFromNora(input.organizationId).catch(() => null);
      const open = await desk.queue(input.organizationId);
      const may = (who: string) => m.role === "owner" || (who === "team" && m.role !== "reviewer");
      const owner = await desk.ownerName(input.organizationId);
      const others = (await db.listMembers(input.organizationId)).filter((x) => x.userId !== ctx.user.id && x.role !== "reviewer" && x.role !== "chat").map((x) => (x.name || x.email).split(" ")[0]);
      const label = (who: string) => (who === "you" ? (m.role === "owner" ? "Only you" : `Only ${owner}`) : others.length && others.length <= 2 ? `You or ${others.join(" or ")}` : "Anyone on the team");
      return { open: open.map((d) => ({ ...d, canDecide: may(d.who), whoLabel: label(d.who) })), decided: await desk.decidedToday(input.organizationId), owner, role: m.role };
    }),
    decide: protectedProcedure.input(orgInput.extend({ id: z.number().int(), choice: z.string().max(200).optional() })).mutation(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId, "member");
      return desk.decide(input.organizationId, input.id, { choice: input.choice, by: personName(ctx.user), role: m.role, userId: ctx.user.id });
    }),
    sendBack: protectedProcedure.input(orgInput.extend({ id: z.number().int(), note: z.string().max(600).default("") })).mutation(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId, "member");
      return desk.sendBack(input.organizationId, input.id, { note: input.note, by: personName(ctx.user), role: m.role, userId: ctx.user.id });
    }),
    later: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return desk.later(input.organizationId, input.id, personName(ctx.user));
    }),
    note: protectedProcedure.input(orgInput.extend({ id: z.number().int(), text: z.string().max(600) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "reviewer");
      return desk.addNote(input.organizationId, input.id, personName(ctx.user), input.text);
    }),
    waiting: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      await desk.syncFromNora(input.organizationId).catch(() => null);
      return desk.waitingView(input.organizationId);
    }),
    addWaiting: protectedProcedure
      .input(orgInput.extend({ kind: z.enum(["owed", "promise"]), who: z.string().trim().min(1).max(160), email: z.string().trim().max(200).default(""), what: z.string().trim().min(1).max(300), blocks: z.string().max(300).default(""), expectedAt: z.string().max(40).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const exp = input.expectedAt ? new Date(input.expectedAt) : null;
        return desk.addWaiting(input.organizationId, { kind: input.kind, who: input.who, email: input.email, what: input.what, blocks: input.blocks, expectedAt: exp && !Number.isNaN(exp.getTime()) ? exp : null, heardIn: `Added by ${personName(ctx.user)}` });
      }),
    saveWaiting: protectedProcedure
      .input(orgInput.extend({ id: z.number().int(), who: z.string().max(160).optional(), email: z.string().max(200).optional(), what: z.string().max(300).optional(), blocks: z.string().max(300).optional(), expectedAt: z.string().max(40).nullable().optional(), nudgeAt: z.string().max(40).nullable().optional(), nudgeSubject: z.string().max(200).optional(), nudgeBody: z.string().max(4000).optional(), plan: z.string().max(600).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const when = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v === "" ? null : Number.isNaN(new Date(v).getTime()) ? undefined : new Date(v));
        const { organizationId, id, expectedAt, nudgeAt, ...rest } = input;
        return desk.saveWaiting(organizationId, id, { ...rest, expectedAt: when(expectedAt), nudgeAt: when(nudgeAt) });
      }),
    finishWaiting: protectedProcedure.input(orgInput.extend({ id: z.number().int(), how: z.enum(["done", "dismissed", "mine"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return desk.finishWaiting(input.organizationId, input.id, input.how, personName(ctx.user));
    }),
    sendNudge: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "reply");
      const r = await desk.sendNudge(input.organizationId, input.id, personName(ctx.user));
      return { sent: r.sent };
    }),
    rules: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId);
      const team = (await db.listMembers(input.organizationId)).filter((x) => x.role !== "owner" && x.role !== "reviewer").map((x) => (x.name || x.email).split(" ")[0]);
      return { rules: desk.rulesOf(input.organizationId), categories: desk.CATEGORIES, duties: desk.DUTIES, never: desk.NEVER, owner: await desk.ownerName(input.organizationId), role: m.role, team };
    }),
    saveRules: protectedProcedure.input(orgInput.extend({ rules: z.record(z.string(), z.unknown()) })).mutation(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId, "admin");
      const r = input.rules as Partial<desk.DeskRules>;
      const cur = desk.rulesOf(input.organizationId);
      const changesWho = (r.onlyYou !== undefined && JSON.stringify([...r.onlyYou].sort()) !== JSON.stringify([...cur.onlyYou].sort())) || (r.spendLimitCents !== undefined && r.spendLimitCents !== cur.spendLimitCents);
      if (changesWho && m.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: `Only ${await desk.ownerName(input.organizationId)} can change who decides.` });
      const saved = desk.saveRules(input.organizationId, r);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), userId: ctx.user.id, action: "Changed Avery's rules", details: changesWho ? "Who decides" : "Rules" });
      return saved;
    }),
    people: protectedProcedure.input(orgInput.extend({ person: z.string().max(160).nullable().optional() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return desk.peopleView(input.organizationId, input.person ?? null);
    }),
    undo: protectedProcedure.input(orgInput.extend({ logId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "guideline");
      return desk.undoGuideline(input.organizationId, input.logId, personName(ctx.user));
    }),
  }),

  // Team chat: channels, direct messages and threads in a workspace, like Slack
  // ==========================================
  // LeadDash EHR: the connection and what Harper, Malik and Camille read from it
  // ==========================================
  ehr: router({
    view: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./ehr")).view(input.organizationId);
    }),
    connect: protectedProcedure.input(orgInput.extend({ url: z.string().min(8).max(300), key: z.string().min(1).max(500) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const r = await (await import("./ehr")).connect(input.organizationId, { url: input.url, key: input.key });
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Connected LeadDash EHR", details: `Connected as ${r.practice}. Key checked with the EHR and saved encrypted.` });
      return r;
    }),
    disconnect: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      await (await import("./ehr")).disconnect(input.organizationId);
      return { ok: true };
    }),
    refresh: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await (await import("./ehr")).refresh(input.organizationId);
      return { posted: r.posted, fetchedAt: r.fetchedAt };
    }),
  }),

  // ==========================================
  // Camille: compliance dates, the EHR counts and SOPs due
  // ==========================================
  compliance: router({
    desk: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/compliance")).deskView(input.organizationId);
    }),
    add: protectedProcedure.input(orgInput.extend({ kind: z.enum(COMPLIANCE_KINDS), title: z.string().trim().min(1).max(160), who: z.string().max(120).optional(), due: z.string().max(12).optional(), note: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return (await import("./employees/compliance")).add(organizationId, rest);
    }),
    save: protectedProcedure.input(orgInput.extend({ id: z.number().int(), kind: z.enum(COMPLIANCE_KINDS), title: z.string().trim().min(1).max(160), who: z.string().max(120).optional(), due: z.string().max(12).optional(), note: z.string().max(1000).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const { organizationId, id, ...rest } = input;
      return (await import("./employees/compliance")).save(organizationId, id, rest);
    }),
    setDone: protectedProcedure.input(orgInput.extend({ id: z.number().int(), done: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/compliance")).setDone(input.organizationId, input.id, input.done);
    }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return { ok: (await import("./employees/compliance")).remove(input.organizationId, input.id) };
    }),
  }),

  // ==========================================
  // SOPs: the library, versions, and the three ways one gets written
  // ==========================================
  sops: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId, "chat");
      const sops = await import("./employees/sops");
      const jobs = db.sops.jobs(input.organizationId).filter((j) => j.status === "queued" || j.status === "working" || (j.status === "failed" && Date.now() - new Date(j.updatedAt).getTime() < 24 * 3600_000)).map((j) => sops.jobView(j));
      return { ...sops.listView(input.organizationId), jobs, canEdit: RANK[m.role] >= RANK.member };
    }),
    get: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      const sops = await import("./employees/sops");
      const s = db.sops.get(input.organizationId, input.id);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That SOP is gone." });
      const rev = await sops.reviewer(input.organizationId);
      return { ...sops.view(s), reviewerName: rev?.name ?? null, history: sops.history(input.organizationId, input.id) };
    }),
    job: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      const sops = await import("./employees/sops");
      const j = db.sops.job(input.organizationId, input.id);
      if (!j) throw new TRPCError({ code: "NOT_FOUND", message: "That job is gone." });
      return sops.jobView(j);
    }),
    create: protectedProcedure
      .input(orgInput.extend({ title: z.string().trim().min(1).max(160), area: z.enum(SOP_AREAS), ownerKind: z.string().max(40).optional(), follows: z.string().max(300).optional(), when: z.string().max(300).optional(), nextReview: z.string().max(12).optional(), steps: z.array(z.object({ title: z.string().max(240), detail: z.string().max(2000), imageUrl: z.string().max(500).nullable() })).max(60) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const sops = await import("./employees/sops");
        const { organizationId, ...rest } = input;
        return sops.view(sops.create(organizationId, rest, ctx.user.name || ctx.user.email));
      }),
    save: protectedProcedure
      .input(orgInput.extend({ id: z.number().int(), title: z.string().trim().min(1).max(160), area: z.enum(SOP_AREAS), ownerKind: z.string().max(40).optional(), follows: z.string().max(300).optional(), when: z.string().max(300).optional(), nextReview: z.string().max(12).optional(), note: z.string().max(200).optional(), steps: z.array(z.object({ title: z.string().max(240), detail: z.string().max(2000), imageUrl: z.string().max(500).nullable() })).max(60) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const sops = await import("./employees/sops");
        const { organizationId, id, note, ...rest } = input;
        return sops.view(await sops.save(organizationId, id, rest, ctx.user.name || ctx.user.email, note));
      }),
    setStatus: protectedProcedure.input(orgInput.extend({ id: z.number().int(), status: z.enum(["draft", "review", "current", "retired"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const sops = await import("./employees/sops");
      return sops.view(await sops.setStatus(input.organizationId, input.id, input.status, ctx.user.name || ctx.user.email));
    }),
    reviewed: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const sops = await import("./employees/sops");
      return sops.view(await sops.markReviewed(input.organizationId, input.id, ctx.user.name || ctx.user.email));
    }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const sops = await import("./employees/sops");
      return { ok: await sops.remove(input.organizationId, input.id) };
    }),
    /** Send an employee to a site to write one (the same as asking in chat). */
    fromSite: protectedProcedure.input(orgInput.extend({ title: z.string().trim().min(1).max(160), url: z.string().max(500).optional(), login: z.string().max(100).optional(), employeeKind: z.string().max(40).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const sops = await import("./employees/sops");
      const emp = (await db.getEmployeeByKind(input.organizationId, (input.employeeKind || "platform") as never)) ?? (await db.getEmployeeByKind(input.organizationId, "coo" as never));
      if (!emp) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No employee can do that in this workspace yet." });
      const { task, job } = await sops.startFromSite(emp, { title: input.title, url: input.url, login: input.login, by: ctx.user.name || ctx.user.email });
      return { jobId: job.id, taskId: task.id, employeeId: emp.id, employeeName: emp.name };
    }),
  }),

  // ==========================================
  // Ads (Reese): campaigns, one creative set per platform, the budget split
  // ==========================================
  ads: router({
    campaigns: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const ads = await import("./employees/ads");
      return db.ads.campaigns(input.organizationId).map((c) => ads.campaignView(c));
    }),
    campaign: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const ads = await import("./employees/ads");
      const c = db.ads.campaign(input.organizationId, input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is gone." });
      return ads.campaignView(c);
    }),
    set: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const ads = await import("./employees/ads");
      const s = db.ads.set(input.organizationId, input.id);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "That set is gone." });
      const c = db.ads.campaign(input.organizationId, s.campaignId)!;
      const v = ads.campaignView(c);
      return { ...ads.setView(s), campaignName: c.name, page: c.page, text: ads.setText(s, c), position: { n: v.rows.filter((r) => !r.leftOut).findIndex((r) => r.platform === s.platform) + 1, of: v.counts.platforms }, done: v.rows.filter((r) => r.set?.status === "approved" || r.set?.status === "skipped").map((r) => r.platform) };
    }),
    create: protectedProcedure
      .input(
        orgInput.extend({
          name: z.string().max(120),
          goal: z.string().max(300).default(""),
          audience: z.string().max(500).default(""),
          page: z.string().max(500).default(""),
          platforms: z.array(z.enum(["meta", "google", "youtube", "microsoft", "linkedin", "tiktok", "reddit", "spotify", "nextdoor", "yelp"])).max(10),
          budget: z.string().max(20).default(""),
          startDate: z.string().max(12).default(""),
          endDate: z.string().max(12).default(""),
          splitMode: z.enum(["reese", "even"]).default("reese"),
          formats: z.string().max(80).default("any"),
          versions: z.number().int().min(1).max(3).default(1),
          mustSay: z.string().max(500).default(""),
          neverSay: z.string().max(500).default(""),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const ads = await import("./employees/ads");
        const cents = Math.round(Number(input.budget.replace(/[^0-9.]/g, "")) * 100) || 0;
        const c = await ads.createCampaign(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, { ...input, budgetCents: cents, startDate: ads.dateIn(input.startDate), endDate: ads.dateIn(input.endDate) });
        return { id: c.id };
      }),
    save: protectedProcedure
      .input(orgInput.extend({ id: z.number().int(), name: z.string().max(120).optional(), goal: z.string().max(300).optional(), audience: z.string().max(500).optional(), page: z.string().max(500).optional(), platforms: z.array(z.enum(["meta", "google", "youtube", "microsoft", "linkedin", "tiktok", "reddit", "spotify", "nextdoor", "yelp"])).max(10).optional(), mustSay: z.string().max(500).optional(), neverSay: z.string().max(500).optional(), formats: z.string().max(80).optional(), versions: z.number().int().min(1).max(3).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const ads = await import("./employees/ads");
        const { organizationId, id, ...patch } = input;
        return ads.campaignView(ads.saveCampaign(organizationId, id, patch));
      }),
    saveBudget: protectedProcedure
      .input(orgInput.extend({ id: z.number().int(), budget: z.string().max(20), startDate: z.string().max(12), endDate: z.string().max(12), shares: z.record(z.string(), z.number()), mode: z.enum(["reese", "even", "custom"]) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const ads = await import("./employees/ads");
        const cents = Math.round(Number(input.budget.replace(/[^0-9.]/g, "")) * 100) || 0;
        return ads.campaignView(ads.saveBudget(input.organizationId, input.id, { budgetCents: cents, startDate: ads.dateIn(input.startDate), endDate: ads.dateIn(input.endDate), shares: input.shares, mode: input.mode }));
      }),
    start: protectedProcedure.input(orgInput.extend({ id: z.number().int(), mode: z.enum(["reese", "even", "custom"]).default("reese") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const ads = await import("./employees/ads");
      return ads.campaignView(await ads.startWriting(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.id, input.mode));
    }),
    approve: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/ads")).approveSet(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.id);
    }),
    skip: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/ads")).skipSet(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.id);
    }),
    rewrite: protectedProcedure.input(orgInput.extend({ id: z.number().int(), note: z.string().max(300).default("") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/ads")).rewriteSet(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.id, input.note);
    }),
    saveSet: protectedProcedure.input(orgInput.extend({ id: z.number().int(), content: z.record(z.string(), z.union([z.string().max(4000), z.array(z.string().max(400)).max(30)])) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/ads")).saveSet(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.id, input.content);
    }),
    note: protectedProcedure.input(orgInput.extend({ id: z.number().int(), note: z.string().max(300) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const ads = await import("./employees/ads");
      return ads.campaignView(ads.addNote(input.organizationId, input.id, input.note));
    }),
    writePlatform: protectedProcedure.input(orgInput.extend({ id: z.number().int(), platform: z.enum(["meta", "google", "youtube", "microsoft", "linkedin", "tiktok", "reddit", "spotify", "nextdoor", "yelp"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/ads")).writePlatform(input.organizationId, input.id, input.platform);
    }),
    download: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/ads")).zipCampaign(input.organizationId, input.id);
    }),
  }),

  teamChat: router({
    /** Unread counts in every workspace the person is in, for the switcher and the badge on the workspace name. */
    unreadEverywhere: protectedProcedure.query(async ({ ctx }) => (await import("./team")).unreadEverywhere(ctx.user.id)),
    channels: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).channels(input.organizationId, ctx.user.id);
    }),
    messages: protectedProcedure.input(orgInput.extend({ channel: z.string().max(40) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).messages(input.organizationId, ctx.user.id, input.channel);
    }),
    thread: protectedProcedure.input(orgInput.extend({ messageId: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).thread(input.organizationId, ctx.user.id, input.messageId);
    }),
    details: protectedProcedure.input(orgInput.extend({ channel: z.string().max(40) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).details(input.organizationId, ctx.user.id, input.channel);
    }),
    send: protectedProcedure
      .input(orgInput.extend({ channel: z.string().max(40), content: z.string().max(8000), attachmentIds: z.array(z.number().int()).max(10).default([]), threadOf: z.number().int().nullable().optional(), alsoToChannel: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "chat");
        const m = await (await import("./team")).send(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.channel, input.content, input.attachmentIds, { threadOf: input.threadOf ?? null, alsoToChannel: !!input.alsoToChannel });
        return { id: m.id };
      }),
    edit: protectedProcedure.input(orgInput.extend({ messageId: z.number().int(), content: z.string().max(8000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      await (await import("./team")).edit(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.messageId, input.content);
      return { ok: true };
    }),
    remove: protectedProcedure.input(orgInput.extend({ messageId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      await (await import("./team")).remove(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.messageId);
      return { ok: true };
    }),
    hidePreview: protectedProcedure.input(orgInput.extend({ messageId: z.number().int(), url: z.string().max(2000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).hidePreview(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.messageId, input.url);
    }),
    react: protectedProcedure.input(orgInput.extend({ messageId: z.number().int(), emoji: z.string().max(16) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).react(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.messageId, input.emoji);
    }),
    pin: protectedProcedure.input(orgInput.extend({ messageId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).pin(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.messageId);
    }),
    save: protectedProcedure.input(orgInput.extend({ messageId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).save(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.messageId);
    }),
    markRead: protectedProcedure.input(orgInput.extend({ channel: z.string().max(40), lastId: z.number().int().min(0) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      (await import("./team")).markRead(input.organizationId, ctx.user.id, input.channel, input.lastId);
      return { ok: true };
    }),
    createChannel: protectedProcedure
      .input(orgInput.extend({ name: z.string().max(80), purpose: z.string().max(300).default(""), private: z.boolean().default(false), memberIds: z.array(z.number().int()).max(200).default([]), aiAllowed: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "chat");
        const ch = await (await import("./team")).createChannel(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input);
        return { id: ch.id, key: ch.key, name: ch.name };
      }),
    updateChannel: protectedProcedure
      .input(orgInput.extend({ channelId: z.number().int(), name: z.string().max(80).optional(), purpose: z.string().max(300).optional(), aiAllowed: z.boolean().optional(), private: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "chat");
        const { channelId, organizationId, ...patch } = input;
        const ch = await (await import("./team")).updateChannel(organizationId, { id: ctx.user.id, name: personName(ctx.user) }, channelId, patch);
        return { id: ch.id, key: ch.key, name: ch.name };
      }),
    archiveChannel: protectedProcedure.input(orgInput.extend({ channelId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      await (await import("./team")).archiveChannel(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.channelId);
      return { ok: true };
    }),
    addMembers: protectedProcedure.input(orgInput.extend({ channelId: z.number().int(), userIds: z.array(z.number().int()).max(200) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).addMembers(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.channelId, input.userIds);
    }),
    leaveChannel: protectedProcedure.input(orgInput.extend({ channelId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).leaveChannel(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.channelId);
    }),
    joinChannel: protectedProcedure.input(orgInput.extend({ channelId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).joinChannel(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.channelId);
    }),
    setNotify: protectedProcedure.input(orgInput.extend({ channelId: z.number().int(), notify: z.enum(["all", "mentions", "none"]), muted: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      return (await import("./team")).setNotify(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.channelId, input.notify, input.muted);
    }),
    search: protectedProcedure
      .input(orgInput.extend({ q: z.string().max(200), from: z.number().int().nullable().optional(), in: z.string().max(40).nullable().optional(), files: z.boolean().optional(), days: z.number().int().nullable().optional() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "chat");
        return (await import("./team")).search(input.organizationId, ctx.user.id, input.q, { from: input.from, in: input.in, files: input.files, days: input.days });
      }),
    view: protectedProcedure.input(orgInput.extend({ kind: z.enum(["unreads", "mentions", "saved"]) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "chat");
      const t = await import("./team");
      if (input.kind === "unreads") return { kind: "unreads" as const, groups: await t.unreads(input.organizationId, ctx.user.id) };
      if (input.kind === "mentions") return { kind: "mentions" as const, messages: await t.mentions(input.organizationId, ctx.user.id) };
      return { kind: "saved" as const, messages: await t.saved(input.organizationId, ctx.user.id) };
    }),
    // Slack import: the zip goes through /api/upload/slack, which returns a plan; this runs it.
    slackPlan: protectedProcedure.input(orgInput.extend({ token: z.string().max(80) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return (await import("./teamImport")).plan(input.organizationId, input.token);
    }),
    slackImport: protectedProcedure
      .input(
        orgInput.extend({
          token: z.string().max(80),
          channels: z.array(z.object({ id: z.string().max(40), take: z.boolean(), name: z.string().max(80) })).max(500),
          people: z.array(z.object({ id: z.string().max(40), userId: z.number().int().nullable() })).max(2000),
          dms: z.array(z.object({ id: z.string().max(40), take: z.boolean() })).max(5000).default([]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        return (await import("./teamImport")).run(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.token, input.channels, input.people, input.dms);
      }),
  }),

  // Goals: each workspace's own, set by the owner and Simone together
  goals: router({
    overview: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/goals")).overview(input.organizationId);
    }),
    updates: protectedProcedure.input(orgInput.extend({ goalId: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/goals")).goalUpdates(input.organizationId, input.goalId);
    }),
    save: protectedProcedure
      .input(
        orgInput.extend({
          goal: z.object({
            id: z.number().int().optional(),
            title: z.string().max(200),
            description: z.string().max(4000).default(""),
            level: z.enum(["company", "year", "quarter", "cycle"]),
            parentId: z.number().int().nullable(),
            folderId: z.number().int().nullable(),
            ownerType: z.enum(["user", "employee"]).nullable(),
            ownerId: z.number().int().nullable(),
            startDate: ymdZ,
            dueDate: ymdZ,
            period: z.string().max(40),
            color: z.string().max(9),
            status: z.enum(["on", "risk", "off", "done"]).nullable(),
            manualProgress: z.number().min(0).max(100).nullable(),
            targets: z
              .array(z.object({ id: z.number().int().optional(), kind: z.enum(["number", "currency", "boolean", "tasks", "measure"]), name: z.string().max(120), startValue: z.number(), currentValue: z.number(), targetValue: z.number(), done: z.boolean(), listId: z.number().int().nullable(), measureId: z.number().int().nullable() }))
              .max(20)
              .optional(),
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return (await import("./work/goals")).saveGoal(input.organizationId, input.goal, personName(ctx.user));
      }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/goals")).removeGoal(input.organizationId, input.id);
      return { ok: true };
    }),
    approve: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return (await import("./work/goals")).approveGoal(input.organizationId, input.id, personName(ctx.user));
    }),
    dismiss: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      (await import("./work/goals")).dismissGoal(input.organizationId, input.id);
      return { ok: true };
    }),
    addUpdate: protectedProcedure.input(orgInput.extend({ goalId: z.number().int(), status: z.enum(["on", "risk", "off", "done"]).nullable(), body: z.string().max(4000), fileIds: z.array(z.number().int()).max(10).default([]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const g = await import("./work/goals");
      const u = g.addUpdate(input.organizationId, input.goalId, { authorType: "user", authorId: ctx.user.id, authorName: personName(ctx.user), status: input.status, body: input.body });
      g.attach(input.organizationId, "update", u.id, input.fileIds, personName(ctx.user));
      return u;
    }),
    setTarget: protectedProcedure.input(orgInput.extend({ targetId: z.number().int(), value: z.number().nullable(), done: z.boolean().optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./work/goals")).setTargetValue(input.organizationId, input.targetId, input.value, input.done);
    }),
    saveFolder: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), name: z.string().max(80), color: z.string().max(9), parentId: z.number().int().nullable().default(null) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./work/goals")).saveFolder(input.organizationId, input);
    }),
    removeFolder: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/goals")).removeFolder(input.organizationId, input.id);
      return { ok: true };
    }),
    saveScorecard: protectedProcedure
      .input(orgInput.extend({ rows: z.array(z.object({ id: z.number().int().optional(), name: z.string().max(120), ownerType: z.enum(["user", "employee"]).nullable(), ownerId: z.number().int().nullable(), weeklyGoal: z.number().nullable(), unit: z.enum(["number", "currency", "percent", "hours"]), direction: z.enum(["up", "down"]), kind: z.enum(["leading", "result"]), source: z.string().max(60), goalId: z.number().int().nullable() })).max(40) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        (await import("./work/goals")).saveScorecard(input.organizationId, input.rows);
        return { ok: true };
      }),
    setValue: protectedProcedure.input(orgInput.extend({ measureId: z.number().int(), weekStart: ymdZ, value: z.number().nullable() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await (await import("./work/goals")).setMeasureValue(input.organizationId, input.measureId, input.weekStart, input.value, personName(ctx.user));
      return { ok: true };
    }),
    saveLayout: protectedProcedure
      .input(orgInput.extend({ cards: z.array(z.object({ id: z.string().max(20), type: z.enum(["revenue", "measure", "goals", "scorecard", "chart", "read", "donut", "bars", "funnel"]), span: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]), goalId: z.number().int().nullable().optional(), measureIds: z.array(z.number().int()).max(8).optional(), title: z.string().max(80).optional() })).max(30) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        (await import("./work/goals")).saveLayout(input.organizationId, input.cards);
        return { ok: true };
      }),
    attach: protectedProcedure.input(orgInput.extend({ itemType: z.enum(["goal", "task"]), itemId: z.number().int(), fileIds: z.array(z.number().int()).min(1).max(10) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const ok = input.itemType === "goal" ? db.work.goals.get(input.organizationId, input.itemId) : db.work.tasks.get(input.organizationId, input.itemId);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "That isn't in this workspace." });
      return { added: (await import("./work/goals")).attach(input.organizationId, input.itemType, input.itemId, input.fileIds, personName(ctx.user)) };
    }),
    detach: protectedProcedure.input(orgInput.extend({ linkId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/goals")).detach(input.organizationId, input.linkId);
      return { ok: true };
    }),
    refreshRead: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await (await import("./work/simone")).weeklyRead(input.organizationId);
      return { ok: true };
    }),
    draftYear: protectedProcedure.input(orgInput.extend({ year: z.number().int().min(2024).max(2100) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return { drafted: (await (await import("./work/simone")).draftYear(input.organizationId, input.year)).length };
    }),
    makeTask: protectedProcedure.input(orgInput.extend({ text: z.string().min(1).max(300), goalId: z.number().int().nullable() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const pjm = await import("./work/projects");
      const list = pjm.listNamed(input.organizationId, "Goal follow-ups") ?? pjm.saveList(input.organizationId, { name: "Goal follow-ups", folderId: null });
      const t = await pjm.createTask(input.organizationId, { listId: list.id, name: input.text, goalId: input.goalId }, { type: "user", id: ctx.user.id, name: personName(ctx.user) });
      return { id: t.id, listId: list.id };
    }),
    addTopic: protectedProcedure.input(orgInput.extend({ text: z.string().min(1).max(300) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return { count: (await import("./work/simone")).addTopic(input.organizationId, input.text, personName(ctx.user)) };
    }),
  }),

  // Projects: folders, lists and tasks, in place of ClickUp
  pj: router({
    /** Who I am in Projects here: a member or a guest, and my running timer. */
    me: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const t = await import("./work/pjTime");
      return { guest: v.kind === "guest", role: v.kind === "member" ? v.role : "guest", userId: ctx.user.id, name: personName(ctx.user), running: t.runningFor(input.organizationId, { type: "user", id: ctx.user.id, name: personName(ctx.user) }) };
    }),
    tree: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/projects")).tree(input.organizationId, v, { type: "user", id: ctx.user.id, name: personName(ctx.user) });
    }),
    view: protectedProcedure.input(orgInput.extend({ listId: z.number().int().nullable(), folderId: z.number().int().nullable().optional(), scope: z.enum(["list", "everything", "mine", "folder"]), closed: z.boolean().default(false) })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/projects")).view(input.organizationId, v, { listId: input.listId, folderId: input.folderId ?? null, scope: input.scope, me: { type: "user", id: ctx.user.id, name: personName(ctx.user) }, closed: input.closed });
    }),
    // Quick: one custom field, onto a list or its whole folder
    addField: protectedProcedure.input(orgInput.extend({ listId: z.number().int().nullable().optional(), folderId: z.number().int().nullable().optional(), scope: z.enum(["list", "folder"]), name: z.string().max(80), type: fieldZ.shape.type, options: z.array(z.string().max(60)).max(30).optional(), setup: z.string().max(200).optional() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      if (input.listId) acc.mustLevel(input.organizationId, v, input.listId, "full");
      else await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return (await import("./work/projects")).addField(organizationId, rest);
    }),
    // A file preview in the app instead of a download
    preview: protectedProcedure.input(orgInput.extend({ fileId: z.number().int() })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjPreview")).preview(input.organizationId, v, input.fileId);
    }),
    // Saved views, the folder Overview and the Docs page
    views: protectedProcedure.input(orgInput.extend({ listId: z.number().int().nullable().optional(), folderId: z.number().int().nullable().optional() })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjViews")).views(input.organizationId, v, input);
    }),
    setBuiltinView: protectedProcedure.input(orgInput.extend({ listId: z.number().int().nullable().optional(), folderId: z.number().int().nullable().optional(), kind: viewKindZ, settings: viewSettingsZ })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjViews")).setBuiltin(input.organizationId, v, input, input.kind, input.settings);
      return { ok: true };
    }),
    saveView: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), listId: z.number().int().nullable().optional(), folderId: z.number().int().nullable().optional(), name: z.string().max(60), kind: viewKindZ, settings: viewSettingsZ, private: z.boolean().default(false), pinned: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const { organizationId, ...rest } = input;
      return (await import("./work/pjViews")).saveView(organizationId, v, rest, personName(ctx.user));
    }),
    removeView: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjViews")).removeView(input.organizationId, v, input.id);
      return { ok: true };
    }),
    overview: protectedProcedure.input(orgInput.extend({ folderId: z.number().int() })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjViews")).overview(input.organizationId, v, input.folderId);
    }),
    allDocs: protectedProcedure.input(orgInput.extend({ q: z.string().max(120).default("") })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjViews")).allDocs(input.organizationId, v, input.q);
    }),
    placeDoc: protectedProcedure.input(orgInput.extend({ kind: z.enum(["doc", "board"]), id: z.number().int(), folderId: z.number().int().nullable().optional(), listId: z.number().int().nullable().optional(), tags: z.array(z.string().max(30)).max(10).optional() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const { organizationId, ...rest } = input;
      (await import("./work/pjViews")).placeDoc(organizationId, v, rest);
      return { ok: true };
    }),
    task: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/projects")).detail(input.organizationId, v, input.id);
    }),
    saveFolder: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), name: z.string().max(80), color: z.string().max(9) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./work/projects")).saveFolder(input.organizationId, input);
    }),
    removeFolder: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      (await import("./work/projects")).removeFolder(input.organizationId, input.id);
      return { ok: true };
    }),
    saveList: protectedProcedure
      .input(orgInput.extend({ id: z.number().int().optional(), name: z.string().max(120), folderId: z.number().int().nullable(), description: z.string().max(2000).optional(), statuses: z.array(statusZ).max(20).optional(), fields: z.array(fieldZ).max(40).optional() }))
      .mutation(async ({ ctx, input }) => {
        const v = await pjViewer(ctx, input.organizationId);
        const acc = await import("./work/pjAccess");
        if (input.id) acc.mustLevel(input.organizationId, v, input.id, "full");
        else await requireMember(ctx, input.organizationId, "member");
        return (await import("./work/projects")).saveList(input.organizationId, input);
      }),
    removeList: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      (await import("./work/projects")).removeList(input.organizationId, input.id);
      return { ok: true };
    }),
    create: protectedProcedure
      .input(orgInput.extend({ listId: z.number().int(), parentId: z.number().int().nullable().default(null), name: z.string().min(1).max(300), status: z.string().max(40).optional(), dueDate: ymdZ.nullable().optional(), startDate: ymdZ.nullable().optional(), assignees: z.array(assigneeZ).max(20).optional(), goalId: z.number().int().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        const v = await pjViewer(ctx, input.organizationId);
        (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "edit");
        const { organizationId, ...rest } = input;
        return (await import("./work/projects")).createTask(organizationId, rest, pjActor(ctx));
      }),
    update: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().int(),
          patch: z.object({
            name: z.string().max(300).optional(),
            description: z.string().max(20_000).optional(),
            status: z.string().max(40).optional(),
            priority: z.enum(["urgent", "high", "normal", "low"]).nullable().optional(),
            startDate: ymdZ.nullable().optional(),
            dueDate: ymdZ.nullable().optional(),
            timeEstimate: z.number().int().min(0).max(100_000).nullable().optional(),
            tags: z.array(z.string().max(40)).max(20).optional(),
            assignees: z.array(assigneeZ).max(20).optional(),
            watchers: z.array(assigneeZ).max(30).optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
            checklist: z.array(z.object({ text: z.string().max(300), done: z.boolean() })).max(100).optional(),
            goalId: z.number().int().nullable().optional(),
            listId: z.number().int().optional(),
            sort: z.number().optional(),
            repeat: repeatZ.nullable().optional(),
            parentId: z.number().int().nullable().optional(),
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const v = await pjViewer(ctx, input.organizationId);
        const acc = await import("./work/pjAccess");
        // Ticking a checklist line is something a commenter can do; everything else takes edit.
        const onlyChecks = Object.keys(input.patch).every((k) => k === "checklist" || k === "watchers");
        acc.mustTaskLevel(input.organizationId, v, input.id, onlyChecks ? "comment" : "edit");
        if (input.patch.listId) acc.mustLevel(input.organizationId, v, input.patch.listId, "edit");
        if (input.patch.parentId) acc.mustTaskLevel(input.organizationId, v, input.patch.parentId, "edit");
        return (await import("./work/projects")).updateTask(input.organizationId, input.id, input.patch, pjActor(ctx));
      }),
    shiftDates: protectedProcedure.input(orgInput.extend({ id: z.number().int(), startDate: ymdZ.nullable(), dueDate: ymdZ.nullable() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.id, "edit");
      (await import("./work/projects")).shiftDates(input.organizationId, input.id, input.startDate, input.dueDate, pjActor(ctx));
      return { ok: true };
    }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.id, "edit");
      (await import("./work/projects")).removeTask(input.organizationId, input.id);
      return { ok: true };
    }),
    comment: protectedProcedure.input(orgInput.extend({ taskId: z.number().int(), body: z.string().max(10_000), fileIds: z.array(z.number().int()).max(10).default([]) })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.taskId, "comment");
      return (await import("./work/projects")).comment(input.organizationId, input.taskId, input.body, pjActor(ctx), input.fileIds);
    }),
    attach: protectedProcedure.input(orgInput.extend({ taskId: z.number().int(), fileIds: z.array(z.number().int()).min(1).max(10) })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.taskId, "edit");
      for (const f of db.getChatFiles(input.organizationId, input.fileIds)) db.work.files.insert({ organizationId: input.organizationId, itemType: "task", itemId: input.taskId, fileId: f.id, addedBy: personName(ctx.user) });
      return { ok: true };
    }),
    detach: protectedProcedure.input(orgInput.extend({ taskId: z.number().int(), linkId: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.taskId, "edit");
      const l = db.work.files.get(input.organizationId, input.linkId);
      if (l && l.itemType === "task" && l.itemId === input.taskId) db.work.files.remove(input.organizationId, l.id);
      return { ok: true };
    }),
    addLink: protectedProcedure.input(orgInput.extend({ taskId: z.number().int(), otherId: z.number().int(), kind: z.enum(["waits", "blocks", "link"]) })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      acc.mustTaskLevel(input.organizationId, v, input.taskId, "edit");
      acc.mustTaskLevel(input.organizationId, v, input.otherId, "view");
      (await import("./work/projects")).addLink(input.organizationId, input.taskId, input.otherId, input.kind, pjActor(ctx));
      return { ok: true };
    }),
    removeLink: protectedProcedure.input(orgInput.extend({ taskId: z.number().int(), linkId: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.taskId, "edit");
      const l = db.work.links.get(input.organizationId, input.linkId);
      if (l && (l.taskId === input.taskId || l.otherId === input.taskId)) (await import("./work/projects")).removeLink(input.organizationId, input.linkId);
      return { ok: true };
    }),
    // Time
    startTimer: protectedProcedure.input(orgInput.extend({ taskId: z.number().int(), note: z.string().max(200).default("") })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.taskId, "edit");
      return (await import("./work/pjTime")).startTimer(input.organizationId, input.taskId, { type: "user", id: ctx.user.id, name: personName(ctx.user) }, input.note);
    }),
    stopTimer: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjTime")).stopTimer(input.organizationId, { type: "user", id: ctx.user.id, name: personName(ctx.user) });
    }),
    addTime: protectedProcedure
      .input(orgInput.extend({ taskId: z.number().int(), who: z.object({ type: z.enum(["user", "employee"]), id: z.number().int(), name: z.string().max(120) }).optional(), day: ymdZ, minutes: z.number().int().min(1).max(1440), note: z.string().max(200).default(""), billable: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const v = await pjViewer(ctx, input.organizationId);
        (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, input.taskId, "edit");
        const me = { type: "user" as const, id: ctx.user.id, name: personName(ctx.user) };
        // Members can log time for anyone on the team; a guest only for themself.
        const who = v.kind === "guest" || !input.who ? me : input.who;
        return (await import("./work/pjTime")).addTime(input.organizationId, input.taskId, { who, day: input.day, minutes: input.minutes, note: input.note, billable: input.billable }, me);
      }),
    updateTime: protectedProcedure.input(orgInput.extend({ id: z.number().int(), minutes: z.number().int().min(1).max(1440).optional(), note: z.string().max(200).optional(), billable: z.boolean().optional(), day: ymdZ.optional() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const e = db.work.time.get(input.organizationId, input.id);
      if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "That time isn't here anymore." });
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, e.taskId, "edit");
      const { organizationId, id, ...patch } = input;
      (await import("./work/pjTime")).updateTime(organizationId, id, patch);
      return { ok: true };
    }),
    removeTime: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const e = db.work.time.get(input.organizationId, input.id);
      if (!e) return { ok: true };
      (await import("./work/pjAccess")).mustTaskLevel(input.organizationId, v, e.taskId, "edit");
      (await import("./work/pjTime")).removeTime(input.organizationId, input.id);
      return { ok: true };
    }),
    timesheet: protectedProcedure.input(orgInput.extend({ weekStart: ymdZ.optional(), whoType: z.enum(["user", "employee"]).optional(), whoId: z.number().int().optional(), billable: z.enum(["any", "yes", "no"]).default("any") })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = await pjViewer(ctx, input.organizationId);
      const { organizationId, ...rest } = input;
      return (await import("./work/pjTime")).timesheet(organizationId, v, rest);
    }),
    workload: protectedProcedure.input(orgInput.extend({ start: ymdZ.optional(), weeks: z.number().int().min(1).max(12).default(6), listId: z.number().int().nullable().default(null) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjTime")).workload(input.organizationId, v, input);
    }),
    setHours: protectedProcedure.input(orgInput.extend({ type: z.enum(["user", "employee"]), id: z.number().int(), hours: z.number().min(0).max(100).nullable() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, input.type === "user" && input.id === ctx.user.id ? "member" : "admin");
      (await import("./work/pjTime")).setHours(input.organizationId, input.type, input.id, input.hours);
      return { ok: true };
    }),
    // Templates
    templates: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/pjTemplates")).templates(input.organizationId);
    }),
    saveTemplate: protectedProcedure.input(orgInput.extend({ kind: z.enum(["task", "list", "doc"]), sourceId: z.number().int(), name: z.string().max(120), description: z.string().max(500).default("") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const tp = await import("./work/pjTemplates");
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      const args = { name: input.name, description: input.description };
      if (input.kind === "task") {
        acc.mustTaskLevel(input.organizationId, v, input.sourceId, "view");
        return tp.saveTaskTemplate(input.organizationId, input.sourceId, args, personName(ctx.user));
      }
      if (input.kind === "list") {
        acc.mustLevel(input.organizationId, v, input.sourceId, "view");
        return tp.saveListTemplate(input.organizationId, input.sourceId, args, personName(ctx.user));
      }
      return tp.saveDocTemplate(input.organizationId, input.sourceId, args, personName(ctx.user));
    }),
    updateTemplate: protectedProcedure.input(orgInput.extend({ id: z.number().int(), name: z.string().max(120), description: z.string().max(500) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjTemplates")).updateTemplate(input.organizationId, input.id, input);
      return { ok: true };
    }),
    removeTemplate: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjTemplates")).removeTemplate(input.organizationId, input.id);
      return { ok: true };
    }),
    useTemplate: protectedProcedure
      .input(orgInput.extend({ id: z.number().int(), listId: z.number().int().optional(), folderId: z.number().int().nullable().default(null), name: z.string().max(200).default(""), startDate: ymdZ.nullable().default(null), keep: z.object({ assignees: z.boolean(), dates: z.boolean(), attachments: z.boolean(), comments: z.boolean() }).default({ assignees: true, dates: true, attachments: true, comments: false }) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const tp = await import("./work/pjTemplates");
        const row = db.work.templates.get(input.organizationId, input.id);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That template isn't here anymore." });
        if (row.kind === "task") {
          if (!input.listId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the list for the task." });
          const v = await pjViewer(ctx, input.organizationId);
          (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "edit");
          const t = await tp.useTaskTemplate(input.organizationId, input.id, { listId: input.listId, name: input.name || undefined, startDate: input.startDate }, pjActor(ctx));
          return { kind: "task" as const, id: t.id, listId: t.listId };
        }
        if (row.kind === "list") {
          const l = await tp.useListTemplate(input.organizationId, input.id, { name: input.name, folderId: input.folderId, startDate: input.startDate, keep: input.keep }, pjActor(ctx));
          return { kind: "list" as const, id: l.id, listId: l.id };
        }
        const d = tp.useDocTemplate(input.organizationId, input.id, { title: input.name, folderId: input.folderId }, personName(ctx.user));
        return { kind: "doc" as const, id: d.id, listId: null };
      }),
    // Docs
    doc: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/pjDocs")).doc(input.organizationId, input.id);
    }),
    saveDoc: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), folderId: z.number().int().nullable().optional(), listId: z.number().int().nullable().optional(), parentId: z.number().int().nullable().optional(), title: z.string().max(200), blocks: z.array(blockZ).max(600).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return (await import("./work/pjDocs")).saveDoc(organizationId, rest as Parameters<typeof import("./work/pjDocs").saveDoc>[1], personName(ctx.user));
    }),
    removeDoc: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjDocs")).removeDoc(input.organizationId, input.id);
      return { ok: true };
    }),
    toggleDocCheck: protectedProcedure.input(orgInput.extend({ id: z.number().int(), blockId: z.string().max(40), done: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjDocs")).toggleCheck(input.organizationId, input.id, input.blockId, input.done, personName(ctx.user));
      return { ok: true };
    }),
    linkDocTask: protectedProcedure.input(orgInput.extend({ id: z.number().int(), taskId: z.number().int(), on: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjDocs")).linkTask(input.organizationId, input.id, input.taskId, input.on);
      return { ok: true };
    }),
    docTask: protectedProcedure.input(orgInput.extend({ id: z.number().int(), text: z.string().max(2000), listId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "edit");
      const t = await (await import("./work/pjDocs")).taskFromText(input.organizationId, input.id, { text: input.text, listId: input.listId }, pjActor(ctx));
      return { id: t.id };
    }),
    docComment: protectedProcedure.input(orgInput.extend({ id: z.number().int(), quote: z.string().max(500).default(""), body: z.string().max(4000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./work/pjDocs")).docComment(input.organizationId, input.id, input, { id: ctx.user.id, name: personName(ctx.user) });
    }),
    removeDocComment: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId, "member");
      const c = db.work.docComments.get(input.organizationId, input.id);
      if (c && (c.authorId === ctx.user.id || m.role === "owner" || m.role === "admin")) (await import("./work/pjDocs")).removeDocComment(input.organizationId, input.id);
      return { ok: true };
    }),
    // Whiteboards
    board: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/pjDocs")).board(input.organizationId, input.id);
    }),
    saveBoard: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), folderId: z.number().int().nullable().optional(), listId: z.number().int().nullable().optional(), title: z.string().max(200) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return (await import("./work/pjDocs")).saveBoard(organizationId, rest, personName(ctx.user));
    }),
    saveBoardItems: protectedProcedure.input(orgInput.extend({ id: z.number().int(), items: z.array(itemZ).max(800) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const d = await import("./work/pjDocs");
      d.saveItems(input.organizationId, input.id, input.items as Parameters<typeof d.saveItems>[2], personName(ctx.user));
      return { ok: true };
    }),
    removeBoard: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjDocs")).removeBoard(input.organizationId, input.id);
      return { ok: true };
    }),
    boardTasks: protectedProcedure.input(orgInput.extend({ id: z.number().int(), itemIds: z.array(z.string().max(40)).min(1).max(100), listId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "edit");
      return (await import("./work/pjDocs")).makeTasks(input.organizationId, input.id, { itemIds: input.itemIds, listId: input.listId }, pjActor(ctx));
    }),
    // Forms
    form: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/pjForms")).form(input.organizationId, input.id);
    }),
    saveForm: protectedProcedure
      .input(orgInput.extend({ id: z.number().int().optional(), folderId: z.number().int().nullable().optional(), title: z.string().max(200), listId: z.number().int().nullable().optional(), questions: z.array(questionZ).max(50).optional(), settings: z.object({ intro: z.string().max(1000), status: z.string().max(40), assignTo: z.string().max(40), ask: z.string().max(1000), thanks: z.string().max(500) }).optional(), active: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return (await import("./work/pjForms")).saveForm(organizationId, rest);
      }),
    removeForm: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjForms")).removeForm(input.organizationId, input.id);
      return { ok: true };
    }),
    formAnswers: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/pjForms")).answers(input.organizationId, input.id);
    }),
    // Dashboards
    dashboards: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/pjDash")).dashboards(input.organizationId);
    }),
    saveDashboard: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), name: z.string().max(120), cards: z.array(cardZ).max(40).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return (await import("./work/pjDash")).saveDashboard(organizationId, rest);
    }),
    removeDashboard: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./work/pjDash")).removeDashboard(input.organizationId, input.id);
      return { ok: true };
    }),
    dashboardData: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjDash")).data(input.organizationId, v, input.id, { type: "user", id: ctx.user.id, name: personName(ctx.user) });
    }),
    cardChoices: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = await pjViewer(ctx, input.organizationId);
      return (await import("./work/pjDash")).cardChoices(input.organizationId, v);
    }),
    // Automations
    automations: protectedProcedure.input(orgInput.extend({ listId: z.number().int().nullable(), folderId: z.number().int().nullable().optional(), all: z.boolean().default(false) })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      if (input.listId) (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "view");
      else await requireMember(ctx, input.organizationId);
      return (await import("./work/projects")).automations(input.organizationId, input);
    }),
    saveAutomation: protectedProcedure.input(orgInput.extend({ id: z.number().int().optional(), listId: z.number().int().nullable(), folderId: z.number().int().nullable().optional(), trigger: triggerZ, action: actionZ, active: z.boolean() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      if (input.listId) (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "full");
      else await requireMember(ctx, input.organizationId, "member");
      const { organizationId, ...rest } = input;
      return (await import("./work/projects")).saveAutomation(organizationId, rest);
    }),
    removeAutomation: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const a = db.work.automations.get(input.organizationId, input.id);
      if (a?.listId) (await import("./work/pjAccess")).mustLevel(input.organizationId, v, a.listId, "full");
      else await requireMember(ctx, input.organizationId, "member");
      (await import("./work/projects")).removeAutomation(input.organizationId, input.id);
      return { ok: true };
    }),
    // Sharing
    shares: protectedProcedure.input(orgInput.extend({ listId: z.number().int() })).query(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      (await import("./work/pjAccess")).mustLevel(input.organizationId, v, input.listId, "view");
      return (await import("./work/pjAccess")).sharesOf(input.organizationId, input.listId);
    }),
    share: protectedProcedure
      .input(orgInput.extend({ listId: z.number().int(), level: levelZ, email: z.string().max(200).optional(), kind: z.enum(["user", "employee"]).optional(), id: z.number().int().optional() }))
      .mutation(async ({ ctx, input }) => {
        blockReviewer(ctx);
        const v = await pjViewer(ctx, input.organizationId);
        const acc = await import("./work/pjAccess");
        acc.mustLevel(input.organizationId, v, input.listId, "full");
        if (input.kind && input.id) return acc.share(input.organizationId, input.listId, { kind: input.kind, id: input.id, level: input.level }, personName(ctx.user));
        if (!input.email) throw new TRPCError({ code: "BAD_REQUEST", message: "Add an email address or pick someone." });
        return acc.share(input.organizationId, input.listId, { email: input.email, level: input.level }, personName(ctx.user));
      }),
    setShareLevel: protectedProcedure.input(orgInput.extend({ listId: z.number().int(), shareId: z.number().int(), level: levelZ })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      acc.mustLevel(input.organizationId, v, input.listId, "full");
      const s = db.work.shares.get(input.organizationId, input.shareId);
      if (s?.listId === input.listId) acc.setShareLevel(input.organizationId, input.shareId, input.level);
      return { ok: true };
    }),
    unshare: protectedProcedure.input(orgInput.extend({ listId: z.number().int(), shareId: z.number().int() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      acc.mustLevel(input.organizationId, v, input.listId, "full");
      const s = db.work.shares.get(input.organizationId, input.shareId);
      if (s?.listId === input.listId) acc.unshare(input.organizationId, input.shareId);
      return { ok: true };
    }),
    setPrivate: protectedProcedure.input(orgInput.extend({ listId: z.number().int(), on: z.boolean() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      acc.mustLevel(input.organizationId, v, input.listId, "full");
      acc.setPrivate(input.organizationId, input.listId, input.on);
      return { ok: true };
    }),
    setLink: protectedProcedure.input(orgInput.extend({ listId: z.number().int(), on: z.boolean() })).mutation(async ({ ctx, input }) => {
      const v = await pjViewer(ctx, input.organizationId);
      const acc = await import("./work/pjAccess");
      acc.mustLevel(input.organizationId, v, input.listId, "full");
      return { link: acc.setLink(input.organizationId, input.listId, input.on) };
    }),
    // Moving from ClickUp
    clickupSpaces: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const mine = await adminWorkspaces(ctx.user.id);
      const imp = await import("./work/clickupImport");
      const src = await imp.clickupSource(input.organizationId, mine.map((w) => w.id));
      if (!src) return { connected: false as const, spaces: [], workspaces: mine, from: null };
      const spaces = await imp.spaces(src);
      return { connected: true as const, spaces, workspaces: mine, from: mine.find((w) => w.id === src)?.name ?? null };
    }),
    // From a ClickUp CSV export, for one ClickUp Workspace split across several of ours
    csvSpaces: protectedProcedure.input(orgInput.extend({ csv: z.string().max(12_000_000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const imp = await import("./work/clickupImport");
      return { ...imp.csvSpaces(input.csv), workspaces: await adminWorkspaces(ctx.user.id) };
    }),
    startCsvImport: protectedProcedure.input(orgInput.extend({ csv: z.string().max(12_000_000), picks: z.array(z.object({ spaceId: z.string().max(200), name: z.string().max(200), orgId: z.number().int(), mode: z.enum(["projects", "goals"]) })).min(1).max(20) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      for (const p of input.picks) await requireMember(ctx, p.orgId, "admin");
      return (await import("./work/clickupImport")).startCsvImport(input.organizationId, input.csv, input.picks, { id: ctx.user.id, name: personName(ctx.user) });
    }),
    importStatus: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./work/clickupImport")).latestImport(input.organizationId);
    }),
    startImport: protectedProcedure.input(orgInput.extend({ picks: z.array(z.object({ spaceId: z.string().max(40), name: z.string().max(200), orgId: z.number().int(), mode: z.enum(["projects", "goals"]) })).min(1).max(20) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      for (const p of input.picks) await requireMember(ctx, p.orgId, "admin");
      const imp = await import("./work/clickupImport");
      const src = await imp.clickupSource(input.organizationId, (await adminWorkspaces(ctx.user.id)).map((w) => w.id));
      if (!src) throw new TRPCError({ code: "BAD_REQUEST", message: "Connect ClickUp first." });
      return imp.startImport(input.organizationId, input.picks, { id: ctx.user.id, name: personName(ctx.user) }, src);
    }),
  }),

  // The Calendar page: Day, Week, Month, the next meeting, and who's on what
  calendar: router({
    range: protectedProcedure.input(orgInput.extend({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.number().int().min(1).max(42) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/calendarPage")).calendarRange(input.organizationId, input.from, input.days);
    }),
    next: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/calendarPage")).nextMeeting(input.organizationId);
    }),
    start: protectedProcedure.input(orgInput.extend({ url: z.string().max(600) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      // Anyone in the workspace can start the meeting as host.
      return (await import("./employees/calendarPage")).startLink(input.organizationId, input.url, true);
    }),
    who: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/calendarPage")).whoView(input.organizationId);
    }),
  }),

  precall: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return precall.precallsView(input.organizationId);
    }),
    get: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const r = db.cold.precall.get(input.id, input.organizationId);
      return r ? precall.precallView(input.organizationId, r) : null;
    }),
    run: protectedProcedure.input(orgInput.extend({ person: z.string().max(160).optional(), practice: z.string().max(200).optional(), website: z.string().max(300).optional(), email: z.string().max(200).optional(), meetingAt: z.string().max(60).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const at = input.meetingAt ? new Date(input.meetingAt) : null;
      const r = await precall.startPrecall(input.organizationId, { person: input.person, practice: input.practice, website: input.website, email: input.email, meetingAt: at && !Number.isNaN(at.getTime()) ? at : null, runBy: `${personName(ctx.user)}, from the Pre-call tab` });
      return { id: r.id };
    }),
    forLead: protectedProcedure.input(orgInput.extend({ leadId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await precall.startPrecall(input.organizationId, { leadId: input.leadId, runBy: `${personName(ctx.user)}, from the Lead list` });
      return { id: r.id };
    }),
    refresh: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = db.cold.precall.get(input.id, input.organizationId);
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That report isn't here." });
      db.cold.precall.update(r.id, input.organizationId, { status: "running" });
      void precall.runPrecall(input.organizationId, r.id, "outreach", true);
      return { success: true };
    }),
    afterCall: protectedProcedure.input(orgInput.extend({ id: z.number().int(), notes: z.string().max(30000).default("") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await precall.afterCall(input.organizationId, input.id, input.notes);
      return { success: true };
    }),
    saveAfter: protectedProcedure.input(orgInput.extend({ id: z.number().int(), changes: z.array(z.object({ what: z.string().max(200), before: z.string().max(500), after: z.string().max(500) })).max(20), nextStep: z.string().max(1000), notesFrom: z.string().max(100) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      precall.saveAfter(input.organizationId, input.id, { changes: input.changes, nextStep: input.nextStep, notesFrom: input.notesFrom });
      return { success: true };
    }),
    approveAfter: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      precall.approveAfter(input.organizationId, input.id);
      return { success: true };
    }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      precall.removePrecall(input.organizationId, input.id);
      return { success: true };
    }),
    docx: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return precall.precallDocx(input.organizationId, input.id);
    }),
  }),

  newsroom: router({
    view: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = await newsroom.newsroomView(input.organizationId);
      const mine = await db.listOrganizationsForUser(ctx.user.id);
      return { ...v, myWorkspaces: mine.map((o) => ({ id: o.id, name: o.name })) };
    }),
    scout: protectedProcedure.input(orgInput.extend({ focus: z.string().max(300).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      if (newsroom.settingsOf(input.organizationId).paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This desk is paused. Resume it in Press settings first." });
      if (!db.press.getSettings(input.organizationId)) db.press.saveSettings(input.organizationId, {});
      press_bg(input.organizationId, "scouting", () => newsroom.scout(input.organizationId, { focus: input.focus }));
      return { started: true };
    }),
    saveSettings: protectedProcedure
      .input(orgInput.extend({ shared: z.array(z.number().int()).max(10), coolingDays: z.number().int().min(0).max(120), level: z.number().int().min(1).max(5), alwaysNeedsYou: z.string().max(500), stopWords: z.string().max(500), owns: z.string().max(500).optional(), beats: z.array(z.string().max(60)).max(20).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, ...rest } = input;
        const st = await newsroom.saveSettings(organizationId, ctx.user.id, ctx.user.role === "admin", rest);
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Changed press settings", details: `Level ${st.level}, cooling ${st.coolingDays} days` });
        return { success: true };
      }),
    resume: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      newsroom.resume(input.organizationId);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Resumed the press desk", details: "" });
      return { success: true };
    }),
    moveStory: protectedProcedure.input(orgInput.extend({ id: z.number(), to: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      newsroom.moveStory(input.organizationId, input.id, input.to);
      return { success: true };
    }),
    dismissStory: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      newsroom.dismissStory(input.organizationId, input.id);
      return { success: true };
    }),
    pitchStory: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const story = db.press.stories.get(input.id, input.organizationId);
      if (!story) throw new TRPCError({ code: "NOT_FOUND", message: "That story isn't on this desk." });
      press_bg(input.organizationId, "writing pitches", () => pitching.rapidResponse(story));
      return { started: true };
    }),
    contacts: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const pitches = db.press.pitches.list(input.organizationId).filter((p) => !p.campaignId && !p.storyId);
      return newsroom.contactsFor(input.organizationId).map((c) => ({ ...newsroom.contactView(input.organizationId, c), pitch: (() => { const p = pitches.filter((x) => x.contactId === c.id && x.status !== "sent").sort((a, b) => b.id - a.id)[0]; return p ? pitching.pitchView(input.organizationId, p) : null; })() }));
    }),
    saveContact: protectedProcedure
      .input(orgInput.extend({ id: z.number().optional(), name: z.string().trim().min(1).max(120), outlet: z.string().max(160), title: z.string().max(160), email: z.string().max(200), beats: z.array(z.string().max(60)).max(10), relationship: z.enum(newsroom.RELATIONSHIPS), notes: z.string().max(1000), doNotContact: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const email = input.email.trim().toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new TRPCError({ code: "BAD_REQUEST", message: "That email doesn't look right." });
        const data = { name: input.name.trim(), outlet: input.outlet.trim(), title: input.title.trim(), beats: JSON.stringify(input.beats.map((b) => b.trim()).filter(Boolean)), relationship: input.relationship, notes: input.notes.trim() || null, doNotContact: input.doNotContact };
        if (input.id) {
          const c = newsroom.contactFor(input.organizationId, input.id);
          if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
          newsroom.updateContact(input.organizationId, input.id, { ...data, ...(email !== (c.email ?? "") ? { email: email || null, emailSource: email ? `Added by ${personName(ctx.user)}` : null } : {}) } as never);
          return { id: input.id };
        }
        const made = db.press.contacts.create({ organizationId: input.organizationId, ...data, email: email || null, emailSource: email ? `Added by ${personName(ctx.user)}` : null, why: `Added by ${personName(ctx.user)}. Taylor checks their recent articles before any pitch.` });
        press_bg(input.organizationId, "checking a reporter", () => newsroom.recheck(input.organizationId, made.id), true);
        return { id: made.id };
      }),
    recheck: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return newsroom.contactView(input.organizationId, await newsroom.recheck(input.organizationId, input.id));
    }),
    removeContact: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const c = newsroom.contactFor(input.organizationId, input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
      db.press.contacts.remove(c.id, c.organizationId);
      return { success: true };
    }),
    pitchContact: protectedProcedure.input(orgInput.extend({ id: z.number(), angle: z.string().max(400).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      if (newsroom.settingsOf(input.organizationId).paused) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This desk is paused. Resume it in Press settings first." });
      const c = newsroom.contactFor(input.organizationId, input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That reporter isn't in this newsroom." });
      const p = await pitching.writePitch(input.organizationId, input.id, { angle: input.angle || JSON.parse(c.profile || "{}").strongest || undefined });
      return pitching.pitchView(input.organizationId, p);
    }),
    campaigns: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.press.campaigns.list(input.organizationId).map((c) => pitching.campaignView(input.organizationId, c));
    }),
    planCampaign: protectedProcedure.input(orgInput.extend({ brief: z.string().trim().min(3).max(1000), storyId: z.number().optional(), startsOn: z.string().max(40).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const c = await pitching.planCampaign(input.organizationId, input.brief, { storyId: input.storyId, startsOn: input.startsOn });
      return pitching.campaignView(input.organizationId, c);
    }),
    planMoment: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const m = db.press.library.get(input.id, input.organizationId);
      if (!m || m.kind !== "moment") throw new TRPCError({ code: "NOT_FOUND", message: "That moment isn't on this desk's calendar." });
      const meta = JSON.parse(m.meta || "{}");
      const c = await pitching.planCampaign(input.organizationId, `${m.topic}. ${m.text}`, { startsOn: meta.pitchBy, title: m.topic });
      return pitching.campaignView(input.organizationId, c);
    }),
    saveCampaign: protectedProcedure
      .input(orgInput.extend({ id: z.number(), title: z.string().trim().min(1).max(200), plan: z.object({ goal: z.string().max(600), audience: z.string().max(600), story: z.string().max(600), founderAngle: z.string().max(600), proof: z.string().max(600), beats: z.array(z.string().max(60)).max(12), neverSay: z.string().max(600), order: z.string().max(600) }), angles: z.array(z.object({ text: z.string().max(400), use: z.boolean() })).max(5) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return pitching.campaignView(input.organizationId, pitching.saveCampaign(input.organizationId, input.id, input));
      }),
    addReporters: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const camp = db.press.campaigns.get(input.id, input.organizationId);
      if (!camp) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign isn't on this desk." });
      if (!JSON.parse(camp.angles || "[]").some((a: { use: boolean }) => a.use)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one story angle first." });
      press_bg(input.organizationId, "matching reporters", () => pitching.addReporters(input.organizationId, input.id));
      return { started: true };
    }),
    approveReady: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "press");
      return pitching.approveReady(input.organizationId, input.id, personName(ctx.user));
    }),
    finishCampaign: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      pitching.finishCampaign(input.organizationId, input.id);
      return { success: true };
    }),
    makeKit: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return presslib.libraryView(await presslib.makeKit(input.organizationId, input.id));
    }),
    pitches: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.press.pitches.list(input.organizationId).map((p) => pitching.pitchView(input.organizationId, p));
    }),
    editPitch: protectedProcedure.input(orgInput.extend({ id: z.number(), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return pitching.pitchView(input.organizationId, await pitching.editPitch(input.organizationId, input.id, input));
    }),
    approvePitch: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "press");
      return pitching.pitchView(input.organizationId, await pitching.approvePitch(input.organizationId, input.id, personName(ctx.user)));
    }),
    replies: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.press.replies.list(input.organizationId).map((r) => pitching.replyView(input.organizationId, r));
    }),
    editReply: protectedProcedure.input(orgInput.extend({ id: z.number(), draft: z.string().max(4000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return pitching.replyView(input.organizationId, await pitching.editReply(input.organizationId, input.id, input.draft));
    }),
    approveReply: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireDecide(ctx, input.organizationId, "press");
      return pitching.replyView(input.organizationId, await pitching.approveReply(input.organizationId, input.id, personName(ctx.user)));
    }),
    doneReply: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return pitching.replyView(input.organizationId, pitching.doneReply(input.organizationId, input.id));
    }),
    interviews: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.press.interviews.list(input.organizationId).map((i) => presslib.interviewView(input.organizationId, i));
    }),
    addInterview: protectedProcedure.input(orgInput.extend({ contactId: z.number().nullable(), title: z.string().trim().min(1).max(200), at: z.string().max(40), place: z.string().max(200) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const at = input.at ? new Date(input.at) : null;
      if (at && Number.isNaN(at.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the date and time like 10/08/2026 10:00 AM." });
      return presslib.interviewView(input.organizationId, await presslib.createInterview(input.organizationId, { contactId: input.contactId, title: input.title, at, place: input.place }));
    }),
    saveInterview: protectedProcedure
      .input(orgInput.extend({ id: z.number(), title: z.string().trim().min(1).max(200), at: z.string().max(40), place: z.string().max(200), briefing: z.object({ reporter: z.string().max(2000), points: z.array(z.string().max(400)).max(5), likely: z.array(z.string().max(400)).max(8), hard: z.array(z.object({ q: z.string().max(400), answer: z.string().max(2000), approved: z.boolean() })).max(8), dontClaim: z.string().max(1000), where: z.string().max(300), bio: z.string().max(300), after: z.string().max(600) }) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const at = input.at ? new Date(input.at) : null;
        if (at && Number.isNaN(at.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the date and time like 10/08/2026 10:00 AM." });
        return presslib.interviewView(input.organizationId, presslib.saveBriefing(input.organizationId, input.id, { title: input.title, at, place: input.place, briefing: input.briefing }));
      }),
    rebuildBriefing: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return presslib.interviewView(input.organizationId, await presslib.buildBriefing(input.organizationId, input.id));
    }),
    finishInterview: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return presslib.interviewView(input.organizationId, presslib.finishInterview(input.organizationId, input.id));
    }),
    briefingDocx: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return presslib.briefingDocx(input.organizationId, input.id);
    }),
    coverage: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return { stats: presslib.coverageStats(input.organizationId), list: db.press.coverage.list(input.organizationId).map((c) => presslib.coverageView(input.organizationId, c)) };
    }),
    addCoverage: protectedProcedure.input(orgInput.extend({ url: z.string().trim().url().max(1000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return presslib.coverageView(input.organizationId, await presslib.addCoverage(input.organizationId, input.url));
    }),
    saveCoverage: protectedProcedure
      .input(orgInput.extend({ id: z.number(), headline: z.string().trim().min(1).max(255), outlet: z.string().max(160), ranOn: z.string().max(40), details: z.object({ quotesUsed: z.string().max(100).optional(), messagesIn: z.string().max(600).optional(), messagesMissed: z.string().max(600).optional(), backlink: z.boolean().optional(), visits: z.number().int().min(0).max(100_000_000).optional(), demos: z.number().int().min(0).max(1_000_000).optional() }) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return presslib.coverageView(input.organizationId, presslib.saveCoverage(input.organizationId, input.id, input));
      }),
    removeCoverage: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      presslib.removeCoverage(input.organizationId, input.id);
      return { success: true };
    }),
    library: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.press.library.list(input.organizationId).map(presslib.libraryView);
    }),
    saveLibrary: protectedProcedure
      .input(orgInput.extend({ id: z.number().optional(), kind: z.enum(["quote", "bio", "story", "moment", "kit", "answer"]), topic: z.string().max(200), text: z.string().max(8000), meta: z.record(z.string(), z.unknown()), approved: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return presslib.libraryView(presslib.saveLibrary(organizationId, rest as never));
      }),
    removeLibrary: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      presslib.removeLibrary(input.organizationId, input.id);
      return { success: true };
    }),
    fillLibrary: protectedProcedure.input(orgInput.extend({ what: z.enum(["bios", "stories", "calendar"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return { added: await presslib.fillLibrary(input.organizationId, input.what) };
    }),
    kitDocx: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return presslib.kitDocx(input.organizationId, input.id);
    }),
  }),

  // Taylor's press inbox: HARO, Source of Sources, Qwoted and Featured requests by email.
  press: router({
    view: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/press")).pressView(input.organizationId);
    }),
    save: protectedProcedure
      .input(orgInput.extend({ email: z.string().trim().max(200), password: z.string().max(200).optional(), host: z.string().trim().max(200).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const view = await (await import("./employees/press")).savePressInbox(input.organizationId, input);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Connected the press inbox", details: input.email });
        return view;
      }),
    remove: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      (await import("./employees/press")).removePressInbox(input.organizationId);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Removed the press inbox", details: "" });
      return { success: true };
    }),
    checkNow: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/press")).checkPress(input.organizationId);
    }),
  }),

  accounts: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/calendars")).view(input.organizationId);
    }),
    saveCalendar: protectedProcedure
      .input(orgInput.extend({ id: z.number(), name: z.string().trim().min(1).max(80), include: z.array(z.string().max(300)).max(100), detail: z.enum(["full", "busy"]), holds: z.enum(["default", "yes", "no"]) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, id, ...rest } = input;
        (await import("./employees/calendars")).saveCalendar(organizationId, id, rest);
        return { success: true };
      }),
    saveLink: protectedProcedure
      .input(orgInput.extend({ id: z.number().optional(), name: z.string().trim().min(1).max(80), url: z.string().trim().max(2000).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const row = await (await import("./employees/calendars")).saveLink(input.organizationId, input);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved a calendar link", details: row.name });
        return { success: true };
      }),
    saveSender: protectedProcedure
      .input(orgInput.extend({ id: z.number(), name: z.string().trim().min(1).max(80), sendsFor: z.array(z.enum(EMPLOYEE_KINDS)).max(20) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        (await import("./employees/calendars")).saveSender(input.organizationId, input.id, input);
        return { success: true };
      }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      (await import("./employees/calendars")).remove(input.organizationId, input.id);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Removed a calendar or sending address", details: String(input.id) });
      return { success: true };
    }),
  }),

  // Jobs an employee does in their browser, from chat
  web: router({
    get: protectedProcedure.input(orgInput.extend({ id: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/web")).view(input.organizationId, input.id);
    }),
    approve: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await (await import("./employees/web")).approve(input.organizationId, input.id);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Approved a browser step", details: String(input.id) });
      return r;
    }),
    code: protectedProcedure.input(orgInput.extend({ id: z.number(), code: z.string().trim().min(4).max(20) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return (await import("./employees/web")).submitCode(input.organizationId, input.id, input.code);
    }),
  }),

  // Zara: the LeadDash platform (workflows and pages)
  platform: router({
    overview: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/platform")).overview(input.organizationId);
    }),
    audit: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await (await import("./employees/platform")).startAudit(input.organizationId);
      return { liveId: r.task.liveId, already: r.already };
    }),
    fix: protectedProcedure.input(orgInput.extend({ findingId: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await (await import("./employees/platform")).startFix(input.organizationId, input.findingId);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Approved a workflow fix", details: r.finding.workflow });
      return { liveId: r.task.liveId };
    }),
    dismiss: protectedProcedure.input(orgInput.extend({ findingId: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      (await import("./employees/platform")).dismiss(input.organizationId, input.findingId);
      return { success: true };
    }),
    page: protectedProcedure.input(orgInput.extend({ id: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await import("./employees/platform")).pageView(input.organizationId, input.id);
    }),
    publish: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await (await import("./employees/platform")).startPublish(input.organizationId, input.id);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Approved publishing a platform page", details: String(input.id) });
      return r;
    }),
  }),

  // ==========================================
  // Wren: website
  // ==========================================
  // Jordan's pages: built as HTML, previewed, copied into the site builder
  pages: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listSitePages(input.organizationId);
    }),
    get: protectedProcedure.input(orgInput.extend({ id: z.number(), version: z.number().int().min(1).optional() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const page = db.getSitePage(input.id, input.organizationId);
      if (!page) throw new TRPCError({ code: "NOT_FOUND", message: "That page is not in this workspace." });
      const versions = db.listSitePageVersions(input.id, input.organizationId);
      const current = (input.version ? versions.find((v) => v.version === input.version) : null) ?? versions.find((v) => v.version === page.currentVersion) ?? versions[0] ?? null;
      return {
        page,
        html: current?.html ?? "",
        version: current?.version ?? 0,
        document: current ? pages.fullDocument(page.title, current.html) : "",
        versions: versions.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt })),
      };
    }),
    build: protectedProcedure
      .input(orgInput.extend({ title: z.string().trim().min(2).max(200), pageType: z.enum(["landing", "website"]), goal: z.string().trim().min(2).max(500) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return pages.startPage(input.organizationId, { title: input.title, pageType: input.pageType, goal: input.goal });
      }),
    revise: protectedProcedure
      .input(orgInput.extend({ id: z.number(), request: z.string().trim().min(2).max(2000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        try {
          return await pages.revisePage(input.organizationId, input.id, input.request);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not start the change." });
        }
      }),
    restore: protectedProcedure.input(orgInput.extend({ id: z.number(), version: z.number().int().min(1) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      try {
        return pages.restoreVersion(input.organizationId, input.id, input.version);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not restore." });
      }
    }),
    approve: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return pages.approvePage(input.organizationId, input.id);
    }),
    saveDetails: protectedProcedure
      .input(orgInput.extend({ id: z.number(), buttonUrl: z.string().trim().max(2000), embedCode: z.string().max(20_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        if (input.buttonUrl && !/^https?:\/\/\S+$/i.test(input.buttonUrl)) throw new TRPCError({ code: "BAD_REQUEST", message: "The button link must start with https://" });
        try {
          return pages.saveDetails(input.organizationId, input.id, { buttonUrl: input.buttonUrl, embedCode: input.embedCode });
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not save." });
        }
      }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      db.deleteSitePage(input.id, input.organizationId);
      return { ok: true };
    }),
  }),

  website: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await db.listWorkItems(input.organizationId, "website_plan")).filter((i) => i.status !== "dismissed");
    }),
    plan: protectedProcedure
      .input(orgInput.extend({ page: z.string().trim().min(2).max(200), goal: z.string().trim().min(2).max(500) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return tasks.planWebsitePage(input.organizationId, input.page, input.goal);
      }),
    updateSection: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number(),
          index: z.number().int().min(0),
          heading: z.string().max(500),
          content: z.string().max(10_000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const item = await db.getWorkItemForOrg(input.id, input.organizationId);
        if (!item || item.kind !== "website_plan") throw new TRPCError({ code: "NOT_FOUND", message: "That page plan is not in this workspace." });
        const data = JSON.parse(item.data || "{}");
        if (!Array.isArray(data.sections) || !data.sections[input.index]) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That section does not exist." });
        }
        data.sections[input.index] = { ...data.sections[input.index], heading: input.heading, content: input.content };
        return db.updateWorkItem(input.id, input.organizationId, { data: JSON.stringify(data) });
      }),
    dismiss: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        await workItemOf(input.organizationId, input.id, "website_plan");
        return db.updateWorkItem(input.id, input.organizationId, { status: "dismissed" });
      }),
  }),

  // ==========================================
  // Nico: video
  // ==========================================
  // ==========================================
  // Elena: videos of the owner made from her photo and voice
  // ==========================================
  avatar: router({
    settings: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const emp = await db.getEmployeeByKind(input.organizationId, "video");
      const s = emp ? avatar.settingsOf(emp) : avatar.settingsOf({ studio: null });
      const [photos, voices, spent] = await Promise.all([avatar.photos(input.organizationId), avatar.voices(), avatar.spentThisMonth(input.organizationId)]);
      return { ...s, photos, voices, spentCents: spent, rates: avatar.RATE_CENTS, ready: { fal: !!ENV.falKey, voice: !!ENV.elevenLabsKey } };
    }),
    saveSettings: protectedProcedure
      .input(orgInput.extend({ imageId: z.number().int().nullable(), voiceId: z.string().max(80).nullable(), voiceName: z.string().max(120).nullable(), quality: z.enum(["standard", "pro"]), limitCents: z.number().int().min(0).max(1_000_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return avatar.saveSettings(organizationId, rest);
      }),
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const photos = await avatar.photos(input.organizationId);
      return db.listAvatarVideos(input.organizationId).map((v) => avatar.view(v, photos.find((p) => p.id === v.imageId)?.title));
    }),
    get: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = db.getAvatarVideo(input.id, input.organizationId);
      if (!v) return null;
      const photos = await avatar.photos(input.organizationId);
      return avatar.view(v, photos.find((p) => p.id === v.imageId)?.title);
    }),
    make: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return avatar.view(await avatar.make(input.organizationId, input.id));
    }),
    again: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return avatar.view(await avatar.again(input.organizationId, input.id));
    }),
    updateScript: protectedProcedure.input(orgInput.extend({ id: z.number().int(), title: z.string().max(120), script: z.string().min(1).max(2400) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return avatar.view(await avatar.updateScript(input.organizationId, input.id, { title: input.title, script: input.script }));
    }),
    remove: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      db.deleteAvatarVideo(input.id, input.organizationId);
      return { success: true };
    }),
  }),

  video: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await db.listWorkItems(input.organizationId, "video_plan")).filter((i) => i.status !== "dismissed");
    }),
    find: protectedProcedure
      .input(orgInput.extend({ focus: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const r = await tasks.findVideoIdeas(input.organizationId, input.focus);
        return { added: r.created.length, queries: r.queries };
      }),
    dismiss: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        await workItemOf(input.organizationId, input.id, "video_plan");
        return db.updateWorkItem(input.id, input.organizationId, { status: "dismissed" });
      }),
  }),

  // ==========================================
  // Avery: inbox and calendar
  // ==========================================
  assistant: router({
    listItems: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const emails = await db.listOutboundItemsByOrg(input.organizationId, "email_draft");
      const holds = await db.listOutboundItemsByOrg(input.organizationId, "calendar_hold");
      return [...emails, ...holds];
    }),

    draftEmailReply: protectedProcedure
      .input(
        orgInput.extend({
          subject: z.string().trim().min(2).max(300),
          recipient: z.string().trim().min(3).max(300),
          context: z.string().trim().min(5).max(20_000),
          desiredOutcome: z.string().max(2000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return tasks.draftEmailReply(organizationId, rest);
      }),

    scheduleAppointmentHold: protectedProcedure
      .input(
        orgInput.extend({
          title: z.string().trim().min(2).max(255),
          date: z.string().max(40),
          time: z.string().max(40),
          attendees: z.string().max(2000),
          agenda: z.string().max(5000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return tasks.createCalendarHold(organizationId, rest);
      }),
  }),

  // ==========================================
  // Sienna: social
  // ==========================================
  social: router({
    listPosts: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listOutboundItemsByOrg(input.organizationId, "social_post");
    }),

    generatePostAndCreative: protectedProcedure
      .input(
        orgInput.extend({
          topic: z.string().trim().min(3).max(1000),
          targetPlatforms: z.array(z.enum(["linkedin", "instagram", "facebook", "x", "threads"])).min(1),
          tone: z.enum(["thought_leadership", "community_announcement", "clinical_advocacy", "event_invitation"]),
          generateImageFlag: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return tasks.writeSocialPost(organizationId, rest);
      }),

    /** The post editor: a new post, or changes to one (text, images, video, accounts, time). */
    savePost: protectedProcedure
      .input(
        orgInput.extend({
          itemId: z.number().int().positive().optional(),
          type: z.enum(["post", "reel"]),
          mode: z.enum(["same", "different"]),
          channels: z.array(z.string().max(30)).max(10),
          text: z.string().max(70_000),
          imageUrl: z.string().max(500).nullable(),
          imageMeta: mediaMeta.nullable(),
          variants: z.record(z.string(), z.object({ text: z.string().max(70_000), imageUrl: z.string().max(500).nullable(), imageMeta: mediaMeta.nullable().optional() })),
          videoUrl: z.string().max(500).nullable(),
          videoMeta: mediaMeta.nullable(),
          coverUrl: z.string().max(500).nullable(),
          coverMs: z.number().min(0).max(36_000_000),
          tiktok: z.object({
            privacy: z.union([z.enum(TIKTOK_PRIVACY), z.literal("")]),
            allowComment: z.boolean(),
            allowDuet: z.boolean(),
            allowStitch: z.boolean(),
            disclose: z.boolean(),
            yourBrand: z.boolean(),
            brandedContent: z.boolean(),
          }),
          date: z.string().max(20),
          time: z.string().max(20),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return social.savePost(organizationId, rest, personName(ctx.user));
      }),

    /** Dragged onto a day, or moved to another day. */
    schedule: protectedProcedure
      .input(orgInput.extend({ itemId: z.number().int().positive(), date: z.string().max(20), time: z.string().max(20).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return social.schedulePost(input.organizationId, input.itemId, input.date, input.time || null, personName(ctx.user));
      }),

    unschedule: protectedProcedure.input(orgInput.extend({ itemId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return social.unschedulePost(input.organizationId, input.itemId);
    }),

    suggestTime: protectedProcedure
      .input(orgInput.extend({ channels: z.array(z.string().max(30)).max(10), type: z.enum(["post", "reel"]), itemId: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const chans = input.channels.filter((c): c is SocialChannel => (SOCIAL_CHANNELS as readonly string[]).includes(c));
        return social.suggestTime(input.organizationId, chans.length ? chans : ["facebook"], input.type, input.itemId);
      }),

    /** What TikTok lets this account post right now (asked each time the editor opens, as TikTok requires). */
    tiktokCreator: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      try {
        return { ok: true as const, creator: await integrations.tiktokCreator(input.organizationId) };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message.slice(0, 200) : "TikTok did not answer" };
      }
    }),

    /** Other times: lays the same drafts on a different pattern. */
    schedulePlan: protectedProcedure
      .input(orgInput.extend({ channel: z.enum(SOCIAL_CHANNELS), itemIds: z.array(z.number().int().positive()).min(1).max(30), patternKey: z.string().max(40) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return social.planSchedule(input.organizationId, input.channel, input.itemIds.length, { patternKey: input.patternKey, itemIds: input.itemIds, writeMore: false });
      }),

    applyPlan: protectedProcedure
      .input(orgInput.extend({ rows: z.array(z.object({ itemId: z.number().int().positive(), at: z.string().max(40) })).min(1).max(30) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return social.applyPlan(input.organizationId, input.rows, personName(ctx.user));
      }),
  }),

  // ==========================================
  // Theo: blog
  // ==========================================
  blog: router({
    listArticles: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listOutboundItemsByOrg(input.organizationId, "blog_post");
    }),

    draftWordPressArticle: protectedProcedure
      .input(
        orgInput.extend({
          title: z.string().trim().min(5).max(255),
          category: z.string().max(100).default("Practice insights"),
          outlineNotes: z.string().max(5000).optional(),
          generateBannerFlag: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return tasks.writeBlogArticle(organizationId, rest);
      }),
  }),

  // ==========================================
  // Connections and the approval queue
  // ==========================================
  publishing: router({
    listConnections: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await db.listConnectionsByOrg(input.organizationId)).map(publicConnection);
    }),

    /**
     * Saves connection settings. Secret values are split out and encrypted;
     * they are never returned to the browser. A connection stays "pending"
     * until the server has verified it with the provider (sending is round 2).
     */
    updateConnection: protectedProcedure
      .input(
        orgInput.extend({
          provider: z.enum(PROVIDERS),
          accountLabel: z.string().trim().min(2).max(255),
          accountHandle: z.string().max(255).optional(),
          status: z.enum(["connected", "disconnected", "pending", "error"]),
          settings: z.string().max(20_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const existing = await db.getConnectionByProvider(input.organizationId, input.provider);

        let settings: Record<string, unknown> = {};
        try {
          settings = input.settings ? JSON.parse(input.settings) : {};
        } catch {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Connection settings were not valid JSON." });
        }
        const newSecrets: Record<string, string> = {};
        for (const key of SECRET_KEYS) {
          const value = settings[key];
          delete settings[key];
          if (typeof value === "string" && value.trim() && !/^[•*]+$/.test(value)) newSecrets[key] = value.trim();
        }
        let secretsEncrypted = existing?.secretsEncrypted ?? null;
        if (Object.keys(newSecrets).length > 0) {
          let previous: Record<string, string> = {};
          try {
            previous = decryptJson<Record<string, string>>(secretsEncrypted) ?? {};
          } catch {
            // SECRETS_KEY changed since these were saved; they cannot be read, so they are replaced.
            previous = {};
          }
          const merged = { ...previous, ...newSecrets };
          secretsEncrypted = encryptJson(merged);
        }

        const disconnect = input.status === "disconnected";
        const conn = await db.upsertExternalConnection({
          organizationId: input.organizationId,
          provider: input.provider,
          accountLabel: input.accountLabel,
          accountHandle: input.accountHandle || null,
          status: disconnect ? "disconnected" : "pending",
          settings: JSON.stringify(settings),
          secretsEncrypted: disconnect ? null : secretsEncrypted,
          connectedAt: null,
          lastCheckedAt: new Date(),
        });
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: disconnect ? "Disconnected channel" : "Saved channel settings",
          details: `${input.accountLabel} (${input.provider}).${disconnect ? " Saved secrets were deleted." : " Waiting for verification."}`,
        });
        return conn ? publicConnection(conn) : null;
      }),

    listApprovalQueue: protectedProcedure
      .input(orgInput.extend({ kind: z.enum(OUTBOUND_KINDS).optional() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        return db.listOutboundItemsByOrg(input.organizationId, input.kind);
      }),

    updateItem: protectedProcedure
      .input(orgInput.extend({ itemId: z.number(), title: z.string().max(255).optional(), body: z.string().max(50_000).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const item = await db.getOutboundItemForOrg(input.itemId, input.organizationId);
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Outbound item not found in this organization." });
        if (item.status === "published") throw new TRPCError({ code: "BAD_REQUEST", message: "This has already gone out." });
        const { organizationId, itemId, ...data } = input;
        return db.updateOutboundItem(itemId, organizationId, data);
      }),

    approveAndDispatch: protectedProcedure
      .input(
        orgInput.extend({
          itemId: z.number(),
          // approve_only: approved, waiting for a time (Sienna's drafts). approve_for_dispatch posts now, or schedules when a later time is set.
          action: z.enum(["approve_for_dispatch", "approve_only", "request_revisions", "cancel", "retry"]),
          reviewerName: z.string().optional(), // ignored: the signed-in person is the reviewer
          notes: z.string().max(5000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const m = await requireMember(ctx, input.organizationId, "reviewer");
        const item = await db.getOutboundItemForOrg(input.itemId, input.organizationId);
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Outbound item not found in this organization." });
        return (await import("./approvals")).decideItem(item, { reviewer: personName(ctx.user), role: m.role, action: input.action, notes: input.notes });
      }),

    /** Which Connect buttons work, and what each workspace has connected. */
    connectInfo: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return { apps: integrations.readyApps(), channels: await integrations.channelState(input.organizationId) };
    }),

    choosePage: protectedProcedure.input(orgInput.extend({ pageId: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const conn = await integrations.choosePage(input.organizationId, input.pageId).catch((e) => {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : "Could not save the Page." });
      });
      return conn ? publicConnection(conn) : null;
    }),

    disconnect: protectedProcedure.input(orgInput.extend({ provider: z.enum(PROVIDERS) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      // Booked bots would still join after the key is gone: cancel them first.
      if (input.provider === "recall") await notetaker.cancelAll(input.organizationId).catch(() => null);
      await integrations.disconnect(input.organizationId, input.provider);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Disconnected account", details: input.provider });
      return { success: true };
    }),
  }),

  // ==========================================
  // Chats
  // ==========================================
  chat: router({
    working: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        return workingOn(input.organizationId, emp);
      }),

    summaries: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.chatSummaries(input.organizationId, ctx.user.id);
    }),

    list: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        return db.listChatMessages(input.organizationId, input.employeeId);
      }),

    /** Presenter notes on one slide of a deck an employee made. */
    saveSlideNotes: protectedProcedure.input(orgInput.extend({ id: z.number().int(), index: z.number().int().min(0).max(300), notes: z.string().max(6000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      try {
        await (await import("./employees/talk")).setSlideNotes(input.organizationId, input.id, input.index, input.notes);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
      }
      return { ok: true };
    }),
    newSlidePicture: protectedProcedure.input(orgInput.extend({ id: z.number().int(), index: z.number().int().min(0).max(300), describe: z.string().max(600).default("") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      try {
        await (await import("./employees/talk")).newSlidePicture(input.organizationId, input.id, input.index, input.describe);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
      }
      return { ok: true };
    }),

    /** One slide redrawn as a graphic (Taylor's pick when no kind is given). */
    newSlideGraphic: protectedProcedure.input(orgInput.extend({ id: z.number().int(), index: z.number().int().min(0).max(300), ask: z.string().max(600).default(""), kind: z.string().max(30).default("") })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      try {
        await (await import("./employees/talk")).newSlideGraphic(input.organizationId, input.id, input.index, input.ask, input.kind);
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
      }
      return { ok: true };
    }),

    /** A file an employee made (a talk script, a deck), to open right in the chat. */
    fileView: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const f = db.getChatFiles(input.organizationId, [input.id])[0];
      if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That file isn't in this workspace." });
      return { id: f.id, name: f.name, url: f.fileUrl, mime: f.mime, size: f.size, text: f.text };
    }),

    markRead: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        await db.markChatRead(input.organizationId, input.employeeId, ctx.user.id);
        return { success: true };
      }),

    send: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), text: z.string().trim().max(20_000), attachmentIds: z.array(z.number().int()).max(10).default([]), spoken: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const result = await sendChatMessage({
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          text: input.text,
          authorName: personName(ctx.user),
          userId: ctx.user.id,
          attachmentIds: input.attachmentIds,
          spoken: input.spoken,
        });
        await db.markChatRead(input.organizationId, input.employeeId, ctx.user.id);
        // In a one-on-one the answer is also said out loud in the employee's voice.
        let audioUrl: string | null = null;
        let voiceError: string | null = null;
        if (input.spoken && result.reply?.content) {
          const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
          const id = emp ? await huddle.speak(emp.kind, spokenText(result.reply.content)) : null;
          audioUrl = id ? `/api/voice/audio/${id}` : null;
          voiceError = id ? null : huddle.lastSpeechError();
        }
        return { ...result, audioUrl, voiceError };
      }),

    /** Ends a one-on-one: notes and action items from the chat since it started, posted back in the chat. */
    endMeeting: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), sinceId: z.number().int().min(0), startedAt: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return endOneOnOne(input.organizationId, input.employeeId, { id: ctx.user.id, name: personName(ctx.user) }, { sinceId: input.sinceId, startedAt: new Date(input.startedAt) });
      }),
  }),

  // ==========================================
  // Team huddles: talk out loud with the employees
  // ==========================================
  huddle: router({
    current: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const list = db.listHuddles(input.organizationId, 5);
      const live = list.find((h) => h.status === "live");
      const last = list.find((h) => h.status === "ended");
      return { live: live ? huddle.huddleView(live) : null, last: last ? huddle.huddleView(last) : null };
    }),
    start: protectedProcedure.input(orgInput.extend({ kinds: z.array(z.string().max(30)).max(20).default([]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return huddle.huddleView(await huddle.startHuddle(input.organizationId, { id: ctx.user.id, name: personName(ctx.user) }, input.kinds));
    }),
    members: protectedProcedure.input(orgInput.extend({ id: z.number(), kinds: z.array(z.string().max(30)).min(1).max(20) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return huddle.huddleView(huddle.setMembers(input.organizationId, input.id, input.kinds)!);
    }),
    listenToken: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return huddle.listenToken();
    }),
    say: protectedProcedure.input(orgInput.extend({ id: z.number(), text: z.string().trim().min(1).max(2000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await huddle.say(input.organizationId, input.id, personName(ctx.user), input.text);
      const silent = r.replies.some((x) => !x.audioId);
      return { huddle: huddle.huddleView(r.huddle), replies: r.replies.map((x) => ({ ...x, audioUrl: x.audioId ? `/api/voice/audio/${x.audioId}` : null })), voiceError: silent ? huddle.lastSpeechError() : null };
    }),
    bring: protectedProcedure.input(orgInput.extend({ id: z.number(), url: z.string().trim().min(10).max(1000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      try {
        return huddle.huddleView((await huddle.bringToMeeting(input.organizationId, input.id, input.url))!);
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "The team couldn't join that meeting." });
      }
    }),
    takeOut: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return huddle.huddleView((await huddle.takeOut(input.organizationId, input.id))!);
    }),
    end: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const h = await huddle.endHuddle(input.organizationId, input.id);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Held a team huddle", details: `${huddle.linesOf(h).length} lines` });
      return huddle.huddleView(h);
    }),
  }),

  // ==========================================
  // Scheduled tasks
  // ==========================================
  tasks: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const [list, employees] = await Promise.all([db.listScheduledTasks(input.organizationId), db.listEmployeesByOrg(input.organizationId)]);
      return list.map((t) => ({
        ...t,
        repeatLabel: describeRule(t),
        employeeName: employees.find((e) => e.id === t.employeeId)?.name ?? "Employee",
        employeeKind: employees.find((e) => e.id === t.employeeId)?.kind ?? "custom",
      }));
    }),

    runs: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const [runs, list] = await Promise.all([db.listTaskRuns(input.organizationId), db.listScheduledTasks(input.organizationId)]);
      return runs.map((r) => ({ ...r, title: list.find((t) => t.id === r.taskId)?.title ?? "Deleted task" }));
    }),

    save: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().optional(),
          employeeId: z.number(),
          title: z.string().trim().min(2).max(200),
          instructions: z.string().trim().min(5).max(4000),
          repeat: z.enum(REPEATS),
          weekday: z.number().int().min(0).max(6).nullable().optional(),
          monthDay: z.number().int().min(1).max(28).nullable().optional(),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:30"),
          onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          enabled: z.boolean().default(true),
          notify: z.enum(["push", "email", "chat"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        const org = await db.getOrganizationById(input.organizationId);
        const rule = { repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, monthDay: input.monthDay ?? null, onDate: input.onDate ?? null };
        const next = input.enabled ? nextRun(rule, org?.timezone || "America/Chicago") : null;
        if (input.enabled && !next) throw new TRPCError({ code: "BAD_REQUEST", message: "That date and time has already passed." });
        const data = {
          employeeId: input.employeeId,
          title: input.title,
          instructions: input.instructions,
          ...rule,
          enabled: input.enabled,
          nextRunAt: next,
          ...(input.notify ? { notify: input.notify } : {}),
        };
        const saved = input.id
          ? await db.updateScheduledTask(input.id, input.organizationId, data)
          : await db.createScheduledTask({ organizationId: input.organizationId, createdBy: personName(ctx.user), ...data });
        if (!saved) throw new TRPCError({ code: "NOT_FOUND", message: "That task is not in this workspace." });
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: input.id ? "Edited task" : "Added task",
          details: `${input.title} (${describeRule(rule)}, ${emp.name})`,
        });
        return saved;
      }),

    delete: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const task = await db.getScheduledTaskForOrg(input.id, input.organizationId);
        if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task is not in this workspace." });
        await db.deleteScheduledTask(input.id, input.organizationId);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Deleted task", details: task.title });
        return { success: true };
      }),

    runNow: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const task = await db.getScheduledTaskForOrg(input.id, input.organizationId);
        if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "That task is not in this workspace." });
        const result = await runTaskNow(task, true);
        if (!result) throw new TRPCError({ code: "CONFLICT", message: "That task is already running." });
        return { employeeId: task.employeeId, reply: result.reply };
      }),
  }),

  // ==========================================
  // Brain
  // ==========================================
  // ==========================================
  // Kai: code changes made by Claude
  // ==========================================
  dev: router({
    repos: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return dev.repoStatus(input.organizationId);
    }),
    saveRepos: protectedProcedure
      .input(orgInput.extend({ repos: z.array(z.object({ label: z.string().max(60), repo: z.string().max(140), deploy: z.string().max(300) })).max(6) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        await dev.saveSettings(input.organizationId, input.repos);
        return dev.repoStatus(input.organizationId);
      }),
    connect: protectedProcedure.input(orgInput.extend({ repo: z.string().max(140) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return dev.connectRepo(input.organizationId, input.repo);
    }),
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listDevChanges(input.organizationId).map(dev.view);
    }),
    get: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const ch = db.getDevChange(input.id, input.organizationId);
      return ch ? dev.view(ch) : null;
    }),
    merge: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      const ch = await dev.merge(input.organizationId, input.id);
      const emp = await db.getEmployeeByKind(input.organizationId, "developer");
      const deploy = emp ? dev.settingsOf(emp).repos.find((r) => r.repo === ch.repo)?.deploy ?? "" : "";
      if (emp) await db.createChatMessage({ organizationId: input.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content: `Merged "${ch.title}" into ${ch.label}. It goes live when you run the deploy:\n${deploy || "your usual deploy command"}` });
      return { ...dev.view(ch), deploy };
    }),
    askForChanges: protectedProcedure.input(orgInput.extend({ id: z.number().int(), notes: z.string().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return dev.view(await dev.askForChanges(input.organizationId, input.id, input.notes));
    }),
  }),

  // ==========================================
  // Brain: company history from the owner's Claude and ChatGPT exports
  // ==========================================
  history: router({
    latest: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const last = db.listHistoryImports(input.organizationId, 1)[0];
      return last ? history.view(last) : null;
    }),
    stop: protectedProcedure.input(orgInput.extend({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return history.view(history.stop(input.organizationId, input.id));
    }),
    removeFact: protectedProcedure.input(orgInput.extend({ id: z.number().int(), knowledgeId: z.number().int() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return history.view(await history.removeFact(input.organizationId, input.id, input.knowledgeId));
    }),
  }),

  knowledge: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listKnowledgeByOrg(input.organizationId);
    }),

    create: protectedProcedure
      .input(
        orgInput.extend({
          title: z.string().trim().min(2).max(255),
          category: z.enum(KNOWLEDGE_CATEGORIES),
          content: z.string().trim().min(5).max(20_000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        indexKnowledge(await db.createKnowledgeItem(input));
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Added to Brain",
          details: input.title,
        });
        return { success: true };
      }),

    update: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number(),
          title: z.string().trim().min(2).max(255).optional(),
          category: z.enum(KNOWLEDGE_CATEGORIES).optional(),
          content: z.string().trim().min(1).max(20_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { id, organizationId, ...data } = input;
        const item = await db.updateKnowledgeItem(id, organizationId, data);
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "That Brain entry is not in this workspace." });
        indexKnowledge(item);
        await db.logAction({
          organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Edited Brain",
          details: item.title,
        });
        return item;
      }),

    delete: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        await db.deleteKnowledgeItem(input.id, input.organizationId);
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Removed from Brain",
          details: `Entry #${input.id}`,
        });
        return { success: true };
      }),

    addWebpage: protectedProcedure
      .input(orgInput.extend({ url: z.string().trim().min(4).max(2000), title: z.string().trim().max(255).optional(), category: z.enum(KNOWLEDGE_CATEGORIES).default("mission_profile") }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const page = await fetchWebpage(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
        if (page.text.length < 20) throw new TRPCError({ code: "BAD_REQUEST", message: "That page had no readable text." });
        const item = await db.createKnowledgeItem({
          organizationId: input.organizationId,
          kind: "webpage",
          title: (input.title || page.title).slice(0, 255),
          category: input.category,
          content: page.text,
          sourceUrl: page.url,
          chars: page.text.length,
        });
        indexKnowledge(item);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Added webpage to Brain", details: page.url });
        return item;
      }),

    uploadImage: protectedProcedure
      .input(orgInput.extend({ title: z.string().trim().min(1).max(255), note: z.string().max(2000).default(""), data: z.string().max(12_000_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const saved = await saveImage(input.organizationId, input.data);
        const item = await db.createKnowledgeItem({
          organizationId: input.organizationId,
          kind: "image",
          title: input.title,
          category: "mission_profile",
          content: input.note,
          fileUrl: saved.url,
        });
        indexKnowledge(item);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Added image to Brain", details: input.title });
        // No note typed: describe the photo so employees can pick the right one later.
        if (!input.note.trim()) void describeSaved(input.organizationId, item.id, input.data);
        return item;
      }),

    uploadDocument: protectedProcedure
      .input(
        orgInput.extend({
          title: z.string().trim().min(1).max(255),
          fileName: z.string().max(255),
          mimeType: z.string().max(100),
          category: z.enum(KNOWLEDGE_CATEGORIES).default("mission_profile"),
          data: z.string().max(14_000_000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const saved = await saveDocument(input.organizationId, input.data, input.fileName, input.mimeType);
        const item = await db.createKnowledgeItem({
          organizationId: input.organizationId,
          kind: "document",
          title: input.title,
          category: input.category,
          content: saved.text || "(No readable text was found in this file.)",
          fileUrl: saved.url,
          pages: saved.pages,
          pagesUnit: saved.unit,
          chars: saved.text.length,
          readNote: saved.note,
        });
        indexKnowledge(item);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Added document to Brain", details: input.title });
        return item;
      }),
  }),

  // ==========================================
  // Each employee's own Knowledge (files go through /api/upload/knowledge)
  // ==========================================
  employeeKnowledge: router({
    list: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const items = await db.listEmployeeKnowledge(input.organizationId, input.employeeId);
        const apps = await db.listApplications(input.organizationId);
        return items.map((k) => ({
          ...k,
          content: k.content.slice(0, 4000),
          sections: Array.from(new Set(db.chunksOf(input.organizationId, "knowledge", k.id).map((c) => c.heading).filter((h): h is string => Boolean(h) && h !== k.title && !/^\[(Page|Slide) \d+\]$/.test(h!)))).slice(0, 12),
          usedIn: apps.filter((a) => (a.questions || "").includes(`"${k.title}"`)).map((a) => a.title).slice(0, 5),
        }));
      }),

    addText: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), title: z.string().trim().min(2).max(255), folder: z.string().max(60), content: z.string().trim().min(5).max(200_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        const item = await db.createKnowledgeItem({ organizationId: input.organizationId, employeeId: emp.id, folder: input.folder, kind: "fact", category: "mission_profile", title: input.title, content: input.content, chars: input.content.length, pages: input.content.split(/\s+/).length, pagesUnit: "words" });
        indexKnowledge(item);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: `Added to ${emp.name}'s Knowledge`, details: input.title });
        return item;
      }),

    addLink: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), url: z.string().trim().min(4).max(2000), title: z.string().trim().max(255).optional(), folder: z.string().max(60) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        const page = await fetchWebpage(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
        if (page.text.length < 20) throw new TRPCError({ code: "BAD_REQUEST", message: "That page had no readable text." });
        const item = await db.createKnowledgeItem({ organizationId: input.organizationId, employeeId: emp.id, folder: input.folder, kind: "webpage", category: "mission_profile", title: (input.title || page.title).slice(0, 255), content: page.text, sourceUrl: page.url, chars: page.text.length });
        indexKnowledge(item);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: `Added to ${emp.name}'s Knowledge`, details: page.url });
        return item;
      }),

    update: protectedProcedure
      .input(orgInput.extend({ id: z.number(), title: z.string().trim().min(2).max(255), folder: z.string().max(60) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const item = await db.getKnowledgeItem(input.id, input.organizationId);
        if (!item || !item.employeeId) throw new TRPCError({ code: "NOT_FOUND", message: "That entry is not in this workspace." });
        return db.updateKnowledgeItem(input.id, input.organizationId, { title: input.title, folder: input.folder });
      }),

    remove: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const item = await db.getKnowledgeItem(input.id, input.organizationId);
        if (!item || !item.employeeId) throw new TRPCError({ code: "NOT_FOUND", message: "That entry is not in this workspace." });
        await db.deleteKnowledgeItem(input.id, input.organizationId);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Removed from Knowledge", details: item.title });
        return { success: true };
      }),
  }),

  // ==========================================
  // My account: name, push devices, "Tell me when"
  // ==========================================
  account: router({
    /** The Claude and ChatGPT connector link for this workspace. */
    connector: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return linkFor(ctx.user.id, input.organizationId);
    }),
    newConnector: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return linkFor(ctx.user.id, input.organizationId, true);
    }),
    get: protectedProcedure.query(async ({ ctx }) => {
      const devices = await db.listPushSubscriptions([ctx.user.id]);
      const me = (await db.getUserById(ctx.user.id)) ?? ctx.user;
      return {
        name: me.name,
        avatarUrl: me.avatarUrl ?? null,
        email: me.email,
        staff: me.role === "admin",
        prefs: readPrefs(me.notifyPrefs),
        sound: readSound(me.notifyPrefs),
        events: NOTIFY_EVENTS.map((k) => ({ key: k, label: EVENT_LABELS[k] })),
        pushReady: pushReady(),
        vapidPublicKey: ENV.vapidPublicKey || null,
        devices: devices.map((d) => ({ id: d.id, device: d.device, endpoint: d.endpoint, createdAt: d.createdAt, lastSentAt: d.lastSentAt })),
      };
    }),

    savePrefs: protectedProcedure
      .input(
        z.object({
          ...Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, z.object({ push: z.boolean(), email: z.boolean(), sound: z.boolean().optional() }).optional()])),
          sound: z.object({ kind: z.enum(SOUNDS), volume: z.number().int().min(0).max(100) }).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { sound, ...events } = input as Record<string, unknown> & { sound?: SoundSettings };
        const clean = Object.fromEntries(Object.entries(events).filter(([, v]) => v)) as Partial<Prefs>;
        const me = (await db.getUserById(ctx.user.id)) ?? ctx.user;
        const before = readPrefs(me.notifyPrefs);
        const prefs = { ...before } as Prefs;
        for (const [k, v] of Object.entries(clean) as [keyof Prefs, Prefs[keyof Prefs]][]) prefs[k] = { ...before[k], ...v, sound: v.sound ?? before[k].sound };
        await db.updateUser(ctx.user.id, { notifyPrefs: JSON.stringify({ ...prefs, _sound: sound ?? readSound(me.notifyPrefs) }) });
        return prefs;
      }),

    /** New in-app notices since the last one the app saw, for the pop-up and the sound. */
    pings: protectedProcedure.input(z.object({ after: z.number().int().min(0) })).query(async ({ ctx, input }) => {
      return pingsFor(ctx.user.id, input.after);
    }),

    subscribe: protectedProcedure
      .input(
        z.object({
          endpoint: z.string().url().max(2000),
          keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(4).max(200) }),
          device: z.string().trim().min(1).max(80),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (!pushReady()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Push is not set up on the server yet." });
        if (!/^https:\/\//.test(input.endpoint)) throw new TRPCError({ code: "BAD_REQUEST", message: "That push address is not valid." });
        await db.savePushSubscription({ userId: ctx.user.id, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, device: input.device });
        return { success: true };
      }),

    removeDevice: protectedProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await db.deletePushSubscription(input.id, ctx.user.id);
      return { success: true };
    }),

    testPush: protectedProcedure.mutation(async ({ ctx }) => {
      const sent = await pushTo([ctx.user.id], { title: "LeadDash Employees", body: "Push notifications are on for this device.", url: "/account", tag: "test" });
      if (!sent) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No device took the test. Turn push on here first." });
      return { sent };
    }),
  }),

  // ==========================================
  // Handbook: the LeadDash base plus each workspace's additions
  // ==========================================
  handbook: router({
    view: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      const m = await requireMember(ctx, input.organizationId);
      const base = handbook.baseHandbook();
      const extra = handbook.additionsFor(input.organizationId);
      return {
        canEdit: m.role === "owner" || m.role === "admin",
        parts: base.map((p) => ({ key: p.key, title: p.title, lead: p.lead, sections: p.sections, ruleCount: handbook.ruleCount(p), additions: extra[p.key] ?? [] })),
      };
    }),

    saveAdditions: protectedProcedure
      .input(orgInput.extend({ partKey: z.string().max(40), rules: handbook.additionsSchema }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        blockReviewer(ctx);
        try {
          return { rules: handbook.saveAdditions(input.organizationId, input.partKey, input.rules, personName(ctx.user)) };
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not save." });
        }
      }),

    base: adminProcedure.query(async () => {
      const base = handbook.baseHandbook();
      const workspaces = (await db.listAllOrganizationIds()).length;
      return {
        workspaces,
        parts: base.map((p) => ({ key: p.key, title: p.title, lead: p.lead, sections: p.sections, ruleCount: handbook.ruleCount(p), updatedBy: p.updatedBy, updatedAt: p.updatedAt })),
        playbooks: handbook.playbooks().map((p) => ({ key: p.key, kind: p.kind, title: p.title, lead: p.lead, sections: p.sections, ruleCount: handbook.ruleCount(p), updatedBy: p.updatedBy, updatedAt: p.updatedAt })),
        changes: db.listHandbookChanges(null, 100).map((c) => ({ id: c.id, part: handbook.partTitle(c.partKey), actorName: c.actorName, summary: c.summary, createdAt: c.createdAt })),
      };
    }),

    saveBase: adminProcedure
      .input(z.object({ partKey: z.string().max(40), part: handbook.partSchema }))
      .mutation(({ ctx, input }) => {
        try {
          const p = handbook.saveBasePart(input.partKey, input.part, personName(ctx.user));
          return { key: p.key };
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not save." });
        }
      }),

    resetBase: adminProcedure.input(z.object({ partKey: z.string().max(40) })).mutation(({ ctx, input }) => {
      try {
        handbook.resetBasePart(input.partKey, personName(ctx.user));
        return { ok: true };
      } catch (err) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not reset." });
      }
    }),
  }),

  // ==========================================
  // App review access (LeadDash staff only)
  // ==========================================
  review: router({
    get: adminProcedure.query(() => review.reviewView()),

    save: adminProcedure
      .input(
        z.object({
          enabled: z.boolean(),
          email: z.string().trim().email().max(320),
          endsOn: z.string().trim().max(10).nullable(),
        })
      )
      .mutation(async ({ input }) => {
        const taken = async (email: string) => {
          if (isStaffEmail(email)) return true;
          const user = await db.getUserByEmail(email);
          if (!user) return false;
          if (user.role === "admin") return true;
          const orgs = await db.listOrganizationsForUser(user.id);
          return orgs.some((o) => !review.isDemoOrg(o.id));
        };
        try {
          return await review.saveReview({ enabled: input.enabled, email: input.email, endsOn: input.endsOn || null }, taken);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not save." });
        }
      }),

    newCode: adminProcedure.mutation(() => review.newReviewCode()),
  }),

  // ==========================================
  // Onboarding (every employee)
  // ==========================================
  // ==========================================
  // Sales: Riley, Jada, Malik
  // ==========================================
  sales: router({
    settings: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const { settings } = await sales.salesSettings(input.organizationId);
      const google = (await db.getConnectionByProvider(input.organizationId, "google_workspace"))?.status === "connected";
      const { token, ...rest } = settings;
      return { ...rest, links: sales.salesLinks(token), google, partnerOptions: [...sales.PARTNER_TYPES] };
    }),

    saveSettings: protectedProcedure
      .input(
        orgInput.extend({
          sells: z.enum(["software", "therapy"]).optional(),
          partnerTypes: z.array(z.string().max(60)).max(10).optional(),
          area: z.string().max(200).optional(),
          meetingMinutes: z.number().int().optional(),
          hoursFrom: z.string().regex(/^\d{2}:\d{2}$/).optional(),
          hoursTo: z.string().regex(/^\d{2}:\d{2}$/).optional(),
          days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
          linkedin: z.object({ on: z.boolean(), when: z.enum(["next_day", "same_day"]), note: z.boolean() }).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, ...rest } = input;
        const saved = await sales.saveSalesSettings(organizationId, rest);
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved sales settings", details: saved.sells === "therapy" ? "Sells therapy to clients" : "Sells to practices" });
        return { ok: true };
      }),

    prospects: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listProspects(input.organizationId);
    }),

    startOutreach: protectedProcedure.input(orgInput.extend({ ids: z.array(z.number().int().positive()).min(1).max(30) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const ps = (await Promise.all(input.ids.map((id) => db.getProspect(id, input.organizationId)))).filter(Boolean);
      if (ps.some((p) => !p!.email)) throw new TRPCError({ code: "BAD_REQUEST", message: "Riley did not find an email for this one. Add it before starting outreach." });
      const n = await sales.passToOutreach(input.organizationId, input.ids);
      return { passed: n };
    }),

    updateProspect: protectedProcedure
      .input(orgInput.extend({ id: z.number().int().positive(), contactName: z.string().max(160).optional(), email: z.string().max(200).optional(), phone: z.string().max(40).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const p = await db.getProspect(input.id, input.organizationId);
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That prospect is not in this workspace." });
        if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid email." });
        return db.updateProspect(p.id, input.organizationId, { contactName: input.contactName?.trim() || p.contactName, email: input.email?.trim() || p.email, phone: input.phone?.trim() || p.phone });
      }),

    notFit: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return sales.skipProspect(input.organizationId, input.id);
    }),

    sequences: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return sales.listSequences(input.organizationId);
    }),

    linkedin: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return sales.listLinkedIn(input.organizationId);
    }),

    linkedinAction: protectedProcedure.input(orgInput.extend({ prospectId: z.number().int().positive(), action: z.enum(["done", "skip"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return sales.linkedinAction(input.organizationId, input.prospectId, input.action);
    }),

    linkedinNote: protectedProcedure.input(orgInput.extend({ prospectId: z.number().int().positive(), note: z.string().max(400) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return sales.updateLinkedInNote(input.organizationId, input.prospectId, input.note);
    }),

    approveSequence: protectedProcedure.input(orgInput.extend({ sequence: z.string().max(40) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "reviewer");
      const n = await sales.approveSequence(input.organizationId, input.sequence, personName(ctx.user));
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Approved an email sequence", details: `${n} emails scheduled.` });
      return { approved: n };
    }),

    updateStep: protectedProcedure
      .input(orgInput.extend({ itemId: z.number().int().positive(), title: z.string().min(1).max(255), body: z.string().min(1).max(20_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return sales.updateStep(input.organizationId, input.itemId, input.title, input.body);
      }),

    stop: protectedProcedure.input(orgInput.extend({ prospectId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return sales.skipProspect(input.organizationId, input.prospectId);
    }),

    replied: protectedProcedure.input(orgInput.extend({ prospectId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return sales.markReplied(input.organizationId, input.prospectId);
    }),

    leads: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const leads = await db.listLeads(input.organizationId);
      const replies = await db.listOutboundItemsByOrg(input.organizationId, "lead_reply");
      return leads.map((l) => {
        const meta = (() => {
          try {
            return JSON.parse(l.meta || "{}");
          } catch {
            return {};
          }
        })();
        const reply = replies.find((r) => r.id === meta.replyItemId) ?? null;
        return { ...l, reply: reply ? { id: reply.id, title: reply.title, body: reply.body, status: reply.status, publishedAt: reply.publishedAt, scheduledFor: reply.scheduledFor } : null, eventUrl: meta.eventUrl ?? null };
      });
    }),

    closeLead: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return sales.closeLead(input.organizationId, input.id);
    }),
  }),

  // ==========================================
  // Team: Activity across employees
  // ==========================================
  // ==========================================
  // Nora (Projects): launches
  // ==========================================
  projects: router({
    launches: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return projects.projectsOverview(input.organizationId);
    }),
    saveProject: protectedProcedure
      .input(orgInput.extend({ id: z.number().int().positive().optional(), name: z.string().max(120), brief: z.string().max(2000).optional(), launchDate: z.string().max(10).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        const l = await projects.saveProject(organizationId, rest, personName(ctx.user));
        return { id: l.id, name: l.name };
      }),
    moveTask: protectedProcedure.input(orgInput.extend({ taskId: z.number().int().positive(), launchId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await projects.moveTask(input.organizationId, input.taskId, input.launchId);
      return { ok: true };
    }),
    launch: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return projects.launchView(input.organizationId, input.id);
    }),
    owners: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const emps = (await db.listEmployeesByOrg(input.organizationId)).filter((e) => e.kind !== "projects" && e.kind !== "coo");
      const people = (await db.listMembers(input.organizationId)).map((m) => m.name || m.email);
      return [...people, ...emps.map((e) => e.name)];
    }),
    approvePlan: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return projects.approvePlan(input.organizationId, input.id, personName(ctx.user));
    }),
    dropLaunch: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return projects.dropLaunch(input.organizationId, input.id);
    }),
    markTask: protectedProcedure.input(orgInput.extend({ taskId: z.number().int().positive(), done: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return projects.markTaskDone(input.organizationId, input.taskId, input.done);
    }),
    updateTask: protectedProcedure
      .input(orgInput.extend({ taskId: z.number().int().positive(), title: z.string().max(200).optional(), details: z.string().max(2000).optional(), owner: z.string().max(120).optional(), due: z.string().max(10).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, taskId, ...rest } = input;
        return projects.updateTask(organizationId, taskId, rest);
      }),
    saveKpi: protectedProcedure
      .input(orgInput.extend({ id: z.number().int().positive().optional(), launchId: z.number().int().positive(), name: z.string().min(1).max(120), target: z.number().min(0).max(1_000_000), by: z.string().max(10), source: z.enum(KPI_SOURCES), manualValue: z.number().min(0).max(1_000_000).nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return projects.saveKpi(organizationId, rest);
      }),
    removeKpi: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await db.deleteKpi(input.id, input.organizationId);
      return { ok: true };
    }),
    sendReport: protectedProcedure.input(orgInput.extend({ launchId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return projects.weeklyReport(input.organizationId, input.launchId);
    }),
    settings: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const { ops } = await opsFor(input.organizationId);
      return { checkTime: ops.checkTime, reportDay: ops.reportDay };
    }),
    saveSettings: protectedProcedure.input(orgInput.extend({ checkTime: z.enum(["07:30", "08:30", "09:30"]), reportDay: z.union([z.literal(1), z.literal(5)]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      await saveOps(input.organizationId, { checkTime: input.checkTime, reportDay: input.reportDay });
      return { ok: true };
    }),
  }),

  // ==========================================
  // Simone (COO): meetings and the scorecard
  // ==========================================
  coo: router({
    meetings: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return coo.meetingsView(input.organizationId);
    }),
    meeting: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const v = await coo.meetingsView(input.organizationId);
      const m = [...v.upcoming, ...v.past].find((x) => x.id === input.id);
      if (m) return m;
      const raw = await db.getMeeting(input.id, input.organizationId);
      if (!raw) throw new TRPCError({ code: "NOT_FOUND", message: "That meeting is not in this workspace." });
      return { ...raw, state: "cancelled" as const, attendees: JSON.parse(raw.attendees || "[]") as coo.Attendee[], updatesFrom: JSON.parse(raw.updatesFrom || "[]") as string[], agenda: JSON.parse(raw.agenda || "[]") as coo.AgendaItem[], actionItems: JSON.parse(raw.actionItems || "[]") as coo.ActionItem[] };
    }),
    sendInvite: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const m = await db.getMeeting(input.id, input.organizationId);
      if (m && !m.agenda) await coo.buildAgenda(input.organizationId, m.id);
      return coo.sendInvite(input.organizationId, input.id, personName(ctx.user));
    }),
    rebuildAgenda: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return coo.buildAgenda(input.organizationId, input.id);
    }),
    editMeeting: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().int().positive(),
          title: z.string().max(160).optional(),
          date: z.string().max(10).optional(),
          time: z.string().max(5).optional(),
          minutes: z.number().int().optional(),
          attendees: z.array(z.string().max(200)).max(30).optional(),
          agenda: z.array(z.object({ item: z.string().max(200), who: z.string().max(120), minutes: z.number().int().min(1).max(120) })).max(12).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, ...rest } = input;
        return coo.editMeeting(organizationId, id, rest);
      }),
    cancelMeeting: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return coo.cancelMeeting(input.organizationId, input.id);
    }),
    saveNotes: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive(), notes: z.string().min(1).max(30_000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return coo.saveNotes(input.organizationId, input.id, input.notes);
    }),
    sendItems: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return coo.sendItems(input.organizationId, input.id);
    }),
    sendRecap: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return coo.sendRecap(input.organizationId, input.id, personName(ctx.user));
    }),
    scorecard: protectedProcedure.input(orgInput.extend({ weeksBack: z.number().int().min(0).max(26) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return coo.scorecard(input.organizationId, new Date(Date.now() - input.weeksBack * 7 * 86_400_000));
    }),
    settings: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const { ops } = await opsFor(input.organizationId);
      const people = (await db.listMembers(input.organizationId)).map((m) => ({ name: m.name || m.email, email: m.email }));
      const emps = (await db.listEmployeesByOrg(input.organizationId)).filter((e) => e.kind !== "coo").map((e) => ({ kind: e.kind, name: e.name }));
      const conn = async (p: "zoom" | "google_workspace") => (await db.getConnectionByProvider(input.organizationId, p))?.status === "connected";
      return { meetingLink: ops.meetingLink, recurring: ops.recurring, agendaWhen: ops.agendaWhen, afterMeeting: ops.afterMeeting, people, employees: emps, zoom: await conn("zoom"), google: await conn("google_workspace"), minutes: [...MEETING_MINUTES] };
    }),
    saveSettings: protectedProcedure
      .input(
        orgInput.extend({
          meetingLink: z.enum(["meet", "zoom"]),
          agendaWhen: z.enum(["day_before", "morning_of"]),
          afterMeeting: z.enum(["notes", "zoom"]),
          recurring: z.array(z.object({ id: z.string().max(20), name: z.string().min(1).max(120), day: z.number().int().min(0).max(6), time: z.string().regex(/^\d{2}:\d{2}$/), minutes: z.number().int(), attendees: z.array(z.string().max(200)).max(30), updatesFrom: z.array(z.string().max(30)).max(20) })).max(12),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, ...rest } = input;
        if (rest.meetingLink === "zoom" && (await db.getConnectionByProvider(organizationId, "zoom"))?.status !== "connected") throw new TRPCError({ code: "BAD_REQUEST", message: "Connect Zoom on Integrations first, or keep Google Meet." });
        const saved = await saveOps(organizationId, rest);
        // Upcoming drafts follow the new choices; invites already sent stay as they are.
        for (const m of (await db.listMeetings(organizationId)).filter((m) => m.status === "draft" && new Date(m.startsAt) > new Date() && m.seriesId)) {
          const s = saved.recurring.find((r) => r.id === m.seriesId);
          if (!s) await db.updateMeeting(m.id, organizationId, { status: "cancelled" });
          else await db.updateMeeting(m.id, organizationId, { linkKind: saved.meetingLink });
        }
        await coo.ensureMeetings(organizationId);
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved meeting settings", details: `${saved.recurring.length} repeating meetings` });
        return { ok: true };
      }),

    // Sitting in on meetings (Recall.ai)
    notetaker: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return notetaker.notetakerView(input.organizationId);
    }),
    notes: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return notetaker.notesOne(input.organizationId, input.id);
    }),
    transcript: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return notetaker.transcriptOf(input.organizationId, input.id);
    }),
    notetakerSettings: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return notetaker.notetakerSettings(input.organizationId);
    }),
    saveNotetaker: protectedProcedure
      .input(
        orgInput.extend({
          joins: z.enum(["mine", "any", "picked"]),
          skipWords: z.string().max(500),
          botName: z.string().max(60),
          notesTo: z.enum(["me", "everyone"]),
          keep: z.enum(["delete", "7", "30"]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const { organizationId, ...rest } = input;
        const saved = await notetaker.saveNotetaker(organizationId, rest);
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved notetaker settings", details: rest.joins === "any" ? "Joins every meeting with a link" : rest.joins === "picked" ? "Joins meetings you turn on" : "Joins the meetings you set up" });
        return saved;
      }),
    saveRecallKey: protectedProcedure.input(orgInput.extend({ apiKey: z.string().min(1).max(300) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      try {
        await integrations.saveRecallKey(input.organizationId, input.apiKey);
      } catch (e) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? (/401|403/.test(e.message) ? "Recall.ai didn't accept that key. Copy it again from Recall.ai, API Keys." : e.message) : "Could not save the key." });
      }
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Connected Recall.ai", details: "Key checked with Recall.ai and saved encrypted." });
      await notetaker.syncCalendar(input.organizationId, new Date(), true).catch(() => null);
      return { ok: true };
    }),
    setJoin: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive(), choice: z.enum(["join", "skip"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return notetaker.setChoice(input.organizationId, input.id, input.choice);
    }),
    refreshCalendar: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      if (!(await integrations.recallConnected(input.organizationId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Connect Recall.ai on Integrations first." });
      await notetaker.syncCalendar(input.organizationId, new Date(), true);
      return { ok: true };
    }),
    editNotes: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().int().positive(),
          summary: z.string().max(2000),
          decisions: z.array(z.string().max(300)).max(15),
          questions: z.array(z.string().max(300)).max(15),
          items: z.array(z.object({ text: z.string().max(200), owner: z.string().max(60), due: z.string().max(10) })).max(25),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, ...rest } = input;
        return notetaker.editNotes(organizationId, id, rest);
      }),
    sendNotesItems: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return notetaker.sendItems(input.organizationId, input.id);
    }),
    sendNotesRecap: protectedProcedure.input(orgInput.extend({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return notetaker.sendRecap(input.organizationId, input.id, { name: personName(ctx.user), email: ctx.user.email });
    }),
  }),

  team: router({
    activity: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listActivity(input.organizationId, 200);
    }),
  }),

  onboarding: router({
    get: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
      if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
      const tasksFor = (await db.listScheduledTasks(input.organizationId)).filter((t) => t.employeeId === emp.id);
      return {
        interview: await interview.interviewView(emp),
        dayToDay: (() => {
          try {
            return emp.dayToDay ? (JSON.parse(emp.dayToDay) as { when: string; what: string }[]) : [];
          } catch {
            return [];
          }
        })(),
        progress: onboardingProgress(emp),
        templates: TEMPLATES[emp.kind] ?? [],
        assignments: tasksFor.map((t) => ({ ...t, repeatLabel: describeRule(t) })),
        rules: team.autonomyView(emp),
        alwaysAsks: team.ALWAYS_ASKS,
        firstN: team.FIRST_N,
      };
    }),

    /** Works on its own: what this employee does without asking. */
    saveRules: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), rules: z.record(z.string(), z.enum(["ask", "first5", "auto"])) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        const saved = await team.saveAutonomy(emp, input.rules);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Changed what an employee does on its own", details: emp.name });
        return saved ? team.autonomyView(saved) : [];
      }),

    /** One part of the interview on the Onboarding tab. */
    savePart: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), section: z.string().max(40), answers: z.record(z.string(), z.union([z.string().max(800), z.array(z.string().max(100)).max(12)])), advance: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const emp = await empFor(ctx, input.organizationId, input.employeeId);
        const saved = await interview.savePart(emp, input.section, input.answers, input.advance);
        if (interview.readState(saved).done && !interview.readState(emp).done) await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Onboarded employee", details: emp.name });
        return interview.interviewView(saved);
      }),
    /** The Brain part: facts saved to the workspace or the Brain for every employee. */
    saveBrain: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), facts: z.record(z.string(), z.string().max(2000)), advance: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const emp = await empFor(ctx, input.organizationId, input.employeeId);
        await interview.saveBrainFacts(input.organizationId, emp.kind, input.facts);
        const next = input.advance ? await interview.goTo(emp, Math.max(interview.readState(emp).step, 1)) : emp;
        return interview.interviewView(next);
      }),
    samples: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.makeSamples(emp);
    }),
    examples: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), examples: z.array(z.object({ liked: z.boolean(), text: z.string().max(4000) })).max(8) }))
      .mutation(async ({ ctx, input }) => {
        const emp = await empFor(ctx, input.organizationId, input.employeeId);
        return interview.interviewView(await interview.setExamples(emp, input.examples));
      }),
    followup: protectedProcedure.input(orgInput.extend({ employeeId: z.number(), index: z.number().int().min(0).max(5), answer: z.string().max(100) })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.interviewView(await interview.answerFollowup(emp, input.index, input.answer));
    }),
    goTo: protectedProcedure.input(orgInput.extend({ employeeId: z.number(), step: z.number().int().min(0).max(12) })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.interviewView(await interview.goTo(emp, input.step));
    }),
    redo: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.interviewView(await interview.redo(emp));
    }),
    later: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.interviewView(await interview.later(emp));
    }),
    /** Start (or pick up) the interview in chat. */
    startChat: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      await interview.startInChat(emp, { name: personName(ctx.user), userId: ctx.user.id });
      return { ok: true };
    }),
    /** An answer from a question card in chat. */
    chatAnswer: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), key: z.string().max(60), value: z.union([z.string().max(800), z.array(z.string().max(100)).max(12), z.array(z.object({ liked: z.boolean(), text: z.string().max(4000) })).max(8), z.record(z.string(), z.string().max(2000))]) }))
      .mutation(async ({ ctx, input }) => {
        const emp = await empFor(ctx, input.organizationId, input.employeeId);
        await interview.answerInChat(emp, { name: personName(ctx.user), userId: ctx.user.id }, input.key, input.value);
        return { ok: true };
      }),
    /** "Write a test post": asks the employee in chat. */
    tryIt: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      const view = await interview.interviewView(emp);
      return sendChatMessage({ organizationId: input.organizationId, employeeId: emp.id, text: view.tryIt.prompt, authorName: personName(ctx.user), userId: ctx.user.id });
    }),

    rewriteDay: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
      if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
      return writeDayToDay(emp);
    }),
  }),

  guidelines: router({
    get: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
      if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
      return interview.guidelinesView(emp);
    }),
    saveSection: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), section: z.string().max(40), lines: z.array(z.object({ id: z.string().max(40).optional(), text: z.string().max(1500) })).max(40) }))
      .mutation(async ({ ctx, input }) => {
        const emp = await empFor(ctx, input.organizationId, input.employeeId);
        await requireDecide(ctx, input.organizationId, "guideline", "reviewer");
        const beforeView = interview.guidelinesView(emp);
        const sec = beforeView.sections.find((x) => x.key === input.section);
        const saved = await interview.saveGuideSection(emp, input.section, input.lines);
        const before = (sec?.items ?? []).map((i) => i.text);
        const after = (interview.guidelinesView(saved).sections.find((x) => x.key === input.section)?.items ?? []).map((i) => i.text);
        if (before.join("\n") !== after.join("\n")) {
          await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), userId: ctx.user.id, action: "Changed a guideline", details: `${emp.name}, ${sec?.title ?? input.section}`, data: JSON.stringify({ kind: "guideline", employeeId: emp.id, section: input.section, sectionTitle: sec?.title ?? input.section, before, after }) });
        }
        return interview.guidelinesView(saved);
      }),
    learn: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.guidelinesView(await interview.learnFromExamples(emp));
    }),
    check: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.guidelinesView(await interview.checkConflicts(emp));
    }),
    resolve: protectedProcedure.input(orgInput.extend({ employeeId: z.number(), conflictId: z.string().max(20), option: z.number().int().min(-1).max(3) })).mutation(async ({ ctx, input }) => {
      const emp = await empFor(ctx, input.organizationId, input.employeeId);
      return interview.guidelinesView(await interview.resolveConflict(emp, input.conflictId, input.option));
    }),
  }),

  // ==========================================
  // Hiring (Quinn)
  // ==========================================
  hiring: router({
    roles: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const [roles, people] = await Promise.all([db.listHrRoles(input.organizationId), db.listHrPeople(input.organizationId, "applicant")]);
      return roles.map((r) => ({ ...r, applicants: people.filter((p) => p.roleId === r.id).length }));
    }),

    saveRole: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().optional(),
          title: z.string().trim().min(2).max(120),
          employment: z.enum(["w2", "1099"]),
          hours: z.enum(["full", "part"]),
          place: z.enum(["in_person", "telehealth", "both"]),
          payFrom: z.string().trim().max(60),
          payTo: z.string().trim().max(60),
          licenses: z.array(z.string().max(40)).max(12),
          mustHave: z.string().trim().max(1000),
          niceToHave: z.string().trim().max(1000),
          post: z.string().max(20_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, id, licenses, ...rest } = input;
        const data = { ...rest, licenses: JSON.stringify(licenses), payFrom: rest.payFrom || null, payTo: rest.payTo || null };
        const role = id ? await db.updateHrRole(id, organizationId, data) : await db.createHrRole({ organizationId, ...data });
        if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "That role is not in this workspace." });
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: id ? "Edited role" : "Added role", details: role.title });
        return role;
      }),

    setRoleStatus: protectedProcedure.input(orgInput.extend({ id: z.number(), status: z.enum(["open", "closed"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return db.updateHrRole(input.id, input.organizationId, { status: input.status });
    }),

    writePost: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.writeJobPost(input.organizationId, input.id);
    }),

    markPosted: protectedProcedure.input(orgInput.extend({ id: z.number(), target: z.string().max(120), posted: z.boolean() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const role = await db.getHrRole(input.id, input.organizationId);
      if (!role) throw new TRPCError({ code: "NOT_FOUND", message: "That role is not in this workspace." });
      const targets = hiring.parse<hiring.Target[]>(role.targets, []).map((t) => (t.name === input.target ? { ...t, status: input.posted ? ("posted" as const) : ("ready" as const) } : t));
      return db.updateHrRole(input.id, input.organizationId, { targets: JSON.stringify(targets) });
    }),

    people: protectedProcedure.input(orgInput.extend({ source: z.enum(["applicant", "prospect"]).optional() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const [people, roles, queue] = await Promise.all([db.listHrPeople(input.organizationId, input.source), db.listHrRoles(input.organizationId), db.listOutboundItemsByOrg(input.organizationId, "hiring_email")]);
      return people.map(({ resumeText, ...p }) => ({
        ...p,
        roleTitle: roles.find((r) => r.id === p.roleId)?.title ?? null,
        queued: queue.some((q) => q.status === "pending_approval" && hiring.parse<{ personId?: number }>(q.metadata, {}).personId === p.id),
      }));
    }),

    find: protectedProcedure.input(orgInput.extend({ roleId: z.number().nullable().optional(), focus: z.string().max(300).optional() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const r = await hiring.findProspects(input.organizationId, { roleId: input.roleId ?? null, focus: input.focus });
      return { added: r.created.length, searches: r.queries.length };
    }),

    rewriteMessage: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.rewriteMessage(input.organizationId, input.id);
    }),

    saveMessage: protectedProcedure.input(orgInput.extend({ id: z.number(), message: z.string().max(5000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return db.updateHrPerson(input.id, input.organizationId, { message: input.message });
    }),

    markSent: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.markContacted(input.organizationId, input.id);
    }),

    emailPerson: protectedProcedure.input(orgInput.extend({ id: z.number(), purpose: z.enum(["outreach", "follow_up", "interview", "decline", "offer"]) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.queueEmail(input.organizationId, input.id, input.purpose);
    }),

    move: protectedProcedure.input(orgInput.extend({ id: z.number(), stage: z.enum(HR_STAGES) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const p = await hiring.moveTo(input.organizationId, input.id, input.stage);
      await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Moved candidate", details: `${p?.name ?? "Person"} to ${input.stage}` });
      return p;
    }),

    runChecks: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.runChecks(input.organizationId, input.id);
    }),

    rescreen: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.rescreen(input.organizationId, input.id);
    }),

    offer: protectedProcedure
      .input(orgInput.extend({ id: z.number(), startDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, "Type the start date as MM/DD/YYYY"), pay: z.string().trim().min(1).max(120) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return hiring.draftOffer(input.organizationId, input.id, { startDate: input.startDate, pay: input.pay });
      }),

    saveOffer: protectedProcedure.input(orgInput.extend({ id: z.number(), letter: z.string().max(40_000) })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const p = await db.getHrPerson(input.id, input.organizationId);
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
      const hire = hiring.parse<hiring.NewHire>(p.onboarding, { paperwork: [], credentialing: [] });
      return db.updateHrPerson(input.id, input.organizationId, { onboarding: JSON.stringify({ ...hire, offerLetter: input.letter }) });
    }),

    hire: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.markHired(input.organizationId, input.id);
    }),

    saveChecklist: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number(),
          list: z.enum(["paperwork", "credentialing"]),
          items: z.array(z.object({ item: z.string().trim().min(1).max(120), detail: z.string().max(200), status: z.enum(["to_do", "waiting", "pending", "done", "stuck"]) })).max(40),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return hiring.updateChecklist(input.organizationId, input.id, input.list, input.items);
      }),

    team: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await db.listHrTeamItems(input.organizationId)).map((t) => ({ ...t, daysLeft: hiring.daysUntil(t.due) }));
    }),

    saveTeamItem: protectedProcedure
      .input(
        orgInput.extend({
          id: z.number().optional(),
          person: z.string().trim().min(1).max(120),
          item: z.string().trim().min(1).max(160),
          due: z.string().regex(/^(\d{2}\/\d{2}\/\d{4})?$/, "Type the date as MM/DD/YYYY"),
          progress: z.string().trim().max(120),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return db.saveHrTeamItem(input.organizationId, { id: input.id, person: input.person, item: input.item, due: input.due || null, progress: input.progress || null });
      }),

    deleteTeamItem: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      await db.deleteHrTeamItem(input.id, input.organizationId);
      return { success: true };
    }),

    remind: protectedProcedure.input(orgInput.extend({ id: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      return hiring.remindTeamItem(input.organizationId, input.id);
    }),
  }),

  // ==========================================
  // Activity
  // ==========================================
  /** Hours saved and estimated AI cost for a month. */
  usage: router({
    summary: protectedProcedure.input(orgInput.extend({ back: z.number().int().min(0).max(1).default(0) })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return usageSummary(input.organizationId, input.back);
    }),
  }),

  audit: router({
    list: protectedProcedure
      .input(orgInput.extend({ limit: z.number().int().min(1).max(200).default(30) }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        return db.listAuditLogsByOrg(input.organizationId, input.limit);
      }),
  }),
});

export type AppRouter = typeof appRouter;
