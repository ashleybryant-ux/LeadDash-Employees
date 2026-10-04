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
import { sendChatMessage, workingOn } from "./employees/chat";
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
import { REPEATS, HR_STAGES } from "../drizzle/schema";
import * as hiring from "./employees/hiring";
import { TEMPLATES, progress as onboardingProgress, writeDayToDay } from "./employees/onboarding";
import * as interview from "./employees/interview";
import * as integrations from "./integrations";
import * as review from "./review";
import * as handbook from "./employees/handbook";
import * as social from "./social";
import * as sales from "./employees/sales";
import * as team from "./employees/team";
import * as projects from "./employees/projects";
import * as coo from "./employees/coo";
import * as notetaker from "./employees/notetaker";
import { opsFor, saveOps, MEETING_MINUTES } from "./employees/ops";
import { KPI_SOURCES } from "../drizzle/schema";
import { postProblems, SOCIAL_CHANNELS, TIKTOK_PRIVACY, type SocialChannel } from "@shared/post-model";
import { isStaffEmail } from "./_core/auth";
import { EVENT_LABELS, NOTIFY_EVENTS, pushReady, pushTo, readPrefs, type Prefs } from "./notify";

// ==========================================
// Access rules
// ==========================================

type Role = "owner" | "admin" | "member" | "reviewer";
const RANK: Record<Role, number> = { reviewer: 1, member: 2, admin: 3, owner: 4 };

/**
 * Throws unless the signed-in person belongs to the workspace (with at least
 * the given role). LeadDash staff (users.role = admin) get support access to
 * every workspace without being added to its team.
 */
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

/** The app reviewer can look around the demo workspace but cannot change its team. */
function blockReviewer(ctx: TrpcContext & { user: User }) {
  if (review.isReviewUser(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: "The review account cannot change the team." });
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
      if (ctx.user.role === "admin") return db.listOrganizations();
      const mine = await db.listOrganizationsForUser(ctx.user.id);
      return review.isReviewUser(ctx.user) ? mine.filter((o) => review.isDemoOrg(o.id)) : mine;
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
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.id, "admin");
        const { id, ...data } = input;
        if (data.timezone && !isValidTimeZone(data.timezone)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That time zone is not recognized. Use a name like America/Chicago." });
        }
        const updated = await db.updateOrganization(id, data);
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
      await requireMember(ctx, input.organizationId);
      return db.listMembers(input.organizationId);
    }),

    add: protectedProcedure
      .input(
        orgInput.extend({
          email: z.string().trim().email(),
          name: z.string().trim().max(120).optional(),
          role: z.enum(["admin", "member", "reviewer"]).default("member"),
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
          `${personName(ctx.user)} added you to ${org?.name ?? "a workspace"} on LeadDash Employees as ${input.role}.\n\nSign in with this email address at ${ENV.appUrl}/signin`
        ).catch((err) => console.error("[team] invite email failed:", err));
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Team member added",
          details: `Added ${input.name || input.email} as ${input.role}.`,
        });
        return { success: true };
      }),

    updateRole: protectedProcedure
      .input(orgInput.extend({ userId: z.number(), role: z.enum(["owner", "admin", "member", "reviewer"]) }))
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
          details: `${target.name || target.email} is now ${input.role}.`,
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
        return list
          .filter((o) => o.status !== "dismissed")
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
        await requireMember(ctx, input.organizationId, "member");
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

  portals: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return (await db.listPortalLogins(input.organizationId)).map(({ secretEncrypted, ...p }) => ({ ...p, hasPassword: Boolean(secretEncrypted) }));
    }),

    save: protectedProcedure
      .input(orgInput.extend({ id: z.number().optional(), name: z.string().trim().min(2).max(120), url: z.string().max(500).optional(), username: z.string().trim().min(1).max(200), password: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        const existing = input.id ? (await db.listPortalLogins(input.organizationId)).find((p) => p.id === input.id) : null;
        if (input.id && !existing) throw new TRPCError({ code: "NOT_FOUND", message: "That sign-in is not in this workspace." });
        await db.savePortalLogin({
          id: input.id,
          organizationId: input.organizationId,
          name: input.name,
          url: input.url || null,
          username: input.username,
          secretEncrypted: input.password ? encryptJson({ password: input.password }) : existing?.secretEncrypted ?? null,
        });
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved portal sign-in", details: input.name });
        return { success: true };
      }),

    remove: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        await db.deletePortalLogin(input.id, input.organizationId);
        return { success: true };
      }),
  }),

  // ==========================================
  // Wren: website
  // ==========================================
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
        await requireMember(ctx, input.organizationId, "reviewer");
        const item = await db.getOutboundItemForOrg(input.itemId, input.organizationId);
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Outbound item not found in this organization." });
        if (item.status === "published") throw new TRPCError({ code: "BAD_REQUEST", message: "This has already gone out." });
        const reviewer = personName(ctx.user);

        if (input.action === "request_revisions" || input.action === "cancel") {
          const status = input.action === "request_revisions" ? "changes_requested" : "cancelled";
          const updated = await db.updateOutboundItem(input.itemId, input.organizationId, { status, reviewerNotes: input.notes ?? null, scheduledFor: status === "cancelled" ? null : item.scheduledFor });
          await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: reviewer, action: status === "changes_requested" ? "Sent back" : "Cancelled", details: `"${item.title}".${input.notes ? ` Note: ${input.notes}` : ""}` });
          return updated;
        }

        if (input.action === "retry" && item.status === "pending_approval") throw new TRPCError({ code: "BAD_REQUEST", message: "Approve it first." });
        if (item.kind === "social_post" && input.action !== "retry") {
          const problems = postProblems(item);
          if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${problems.join(". ")}.` });
        }
        const approval = item.approvedBy ? {} : { approvedBy: reviewer, approvedAt: new Date() };
        const later = item.kind === "social_post" && item.scheduledFor && new Date(item.scheduledFor).getTime() > Date.now() + 30_000;

        // Jada's sequences are approved as a whole.
        if (item.kind === "outreach_email" && input.action !== "retry") {
          const seq = (() => {
            try {
              return JSON.parse(item.metadata || "{}").sequence as string | undefined;
            } catch {
              return undefined;
            }
          })();
          if (seq) {
            await sales.approveSequence(input.organizationId, seq, reviewer);
            return db.getOutboundItemForOrg(item.id, input.organizationId);
          }
        }
        if (input.action !== "retry") await team.noteApproval(item);

        // Approved, waiting for a time; or approved for a time already set.
        if (input.action === "approve_only" || (input.action === "approve_for_dispatch" && later)) {
          if (item.kind !== "social_post" && input.action === "approve_only") throw new TRPCError({ code: "BAD_REQUEST", message: "Only posts can wait for a time." });
          const status = later ? "scheduled" : "approved";
          const updated = await db.updateOutboundItem(input.itemId, input.organizationId, { status, reviewerNotes: input.notes ?? item.reviewerNotes ?? null, ...approval });
          const tz = (await db.getOrganizationById(input.organizationId))?.timezone || "America/Chicago";
          const when = later ? social.localParts(new Date(item.scheduledFor!), tz) : null;
          await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: reviewer, action: "Approved", details: `"${item.title}". ${when ? `Scheduled for ${when.date} at ${when.time}.` : "Waiting for a time on the calendar."}` });
          return updated;
        }

        // Theo's approved article goes to Sienna for posts, unless Theo is set to ask.
        if (item.kind === "blog_post" && input.action === "approve_for_dispatch") {
          const theo = item.employeeId ? await db.getEmployeeForOrg(item.employeeId, input.organizationId) : null;
          if (theo && team.gate(theo, "pass_to_social") === "auto") void tasks.postsFromArticle(input.organizationId, item.id).catch((err) => console.warn("[team] posts from article failed:", err instanceof Error ? err.message : err));
        }

        // Approve (or try again): post or send to every connected channel it is meant for.
        return social.postNow(item, reviewer, "human_user", input.action === "retry" ? "Tried again" : "Approved", { ...approval, ...(item.kind === "social_post" ? { scheduledFor: item.scheduledFor ?? new Date() } : {}) }, input.notes);
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

    markRead: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        await db.markChatRead(input.organizationId, input.employeeId, ctx.user.id);
        return { success: true };
      }),

    send: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), text: z.string().trim().min(1).max(20_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const result = await sendChatMessage({
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          text: input.text,
          authorName: personName(ctx.user),
          userId: ctx.user.id,
        });
        await db.markChatRead(input.organizationId, input.employeeId, ctx.user.id);
        return result;
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
    get: protectedProcedure.query(async ({ ctx }) => {
      const devices = await db.listPushSubscriptions([ctx.user.id]);
      const me = (await db.getUserById(ctx.user.id)) ?? ctx.user;
      return {
        name: me.name,
        avatarUrl: me.avatarUrl ?? null,
        email: me.email,
        staff: me.role === "admin",
        prefs: readPrefs(me.notifyPrefs),
        events: NOTIFY_EVENTS.map((k) => ({ key: k, label: EVENT_LABELS[k] })),
        pushReady: pushReady(),
        vapidPublicKey: ENV.vapidPublicKey || null,
        devices: devices.map((d) => ({ id: d.id, device: d.device, endpoint: d.endpoint, createdAt: d.createdAt, lastSentAt: d.lastSentAt })),
      };
    }),

    savePrefs: protectedProcedure
      .input(z.object(Object.fromEntries(NOTIFY_EVENTS.map((k) => [k, z.object({ push: z.boolean(), email: z.boolean() }).optional()]))))
      .mutation(async ({ ctx, input }) => {
        const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v)) as Partial<Prefs>;
        const me = (await db.getUserById(ctx.user.id)) ?? ctx.user;
        const prefs = { ...readPrefs(me.notifyPrefs), ...clean };
        await db.updateUser(ctx.user.id, { notifyPrefs: JSON.stringify(prefs) });
        return prefs;
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
      return (await db.listLaunches(input.organizationId)).filter((l) => l.status !== "dropped").map((l) => ({ id: l.id, name: l.name, launchDate: l.launchDate, status: l.status }));
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
      const cu = await integrations.clickupSettings(input.organizationId);
      return { clickup: cu ? { teamName: cu.teamName, spaces: cu.spaces, spaceId: cu.spaceId, spaceName: cu.spaceName } : null, taskOwners: ops.taskOwners, checkTime: ops.checkTime, reportDay: ops.reportDay };
    }),
    saveSettings: protectedProcedure
      .input(orgInput.extend({ spaceId: z.string().max(40).optional(), taskOwners: z.enum(["people", "employees"]), checkTime: z.enum(["07:30", "08:30", "09:30"]), reportDay: z.union([z.literal(1), z.literal(5)]) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "admin");
        if (input.spaceId && (await integrations.clickupSettings(input.organizationId))) await integrations.chooseClickupSpace(input.organizationId, input.spaceId);
        await saveOps(input.organizationId, { taskOwners: input.taskOwners, checkTime: input.checkTime, reportDay: input.reportDay });
        return { ok: true };
      }),
    refreshSpaces: protectedProcedure.input(orgInput).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "admin");
      return integrations.chooseClickupSpace(input.organizationId);
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
          joins: z.enum(["all", "picked"]),
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
        await db.logAction({ organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Saved notetaker settings", details: rest.joins === "all" ? "Joins every meeting with a link" : "Joins meetings you turn on" });
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
        return interview.guidelinesView(await interview.saveGuideSection(emp, input.section, input.lines));
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
