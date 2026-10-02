import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import type { TrpcContext } from "./_core/context";
import { requestCode, signOut, verifyCode } from "./_core/auth";
import { aiStatus } from "./_core/llm";
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
import { sendChatMessage } from "./employees/chat";
import * as apply from "./employees/apply";
import * as exportsFor from "./employees/exports";
import { indexKnowledge } from "./employees/kb";
import { describeRule, isValidTimeZone, nextRun } from "./employees/schedule";
import { runTaskNow } from "./employees/runner";
import { fetchWebpage, saveDocument, saveImage } from "./employees/files";
import { sendEmail } from "./_core/email";
import { ENV } from "./_core/env";
import { REPEATS, HR_STAGES } from "../drizzle/schema";
import * as hiring from "./employees/hiring";
import { QUESTIONS, TEMPLATES, parseAnswers, progress as onboardingProgress, saveAnswers, writeDayToDay } from "./employees/onboarding";
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

/** The person's real name for the audit trail and approvals. */
function personName(user: User) {
  return user.name?.trim() || user.email;
}

const orgInput = z.object({ organizationId: z.number().int().positive() });

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
      ctx.user ? { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, role: ctx.user.role } : null
    ),

    requestCode: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320) }))
      .mutation(({ input }) => requestCode(input.email)),

    verifyCode: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320), code: z.string().min(6).max(12) }))
      .mutation(async ({ ctx, input }) => {
        const user = await verifyCode(input.email, input.code, ctx.req, ctx.res);
        return { id: user.id, email: user.email, name: user.name, role: user.role };
      }),

    logout: publicProcedure.mutation(async ({ ctx }) => {
      await signOut(ctx.sessionTokenHash, ctx.req, ctx.res);
      return { success: true } as const;
    }),

    updateProfile: protectedProcedure
      .input(z.object({ name: z.string().trim().min(1).max(120) }))
      .mutation(async ({ ctx, input }) => {
        const user = await db.updateUser(ctx.user.id, { name: input.name });
        return { id: user!.id, email: user!.email, name: user!.name, role: user!.role };
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
      return db.listOrganizationsForUser(ctx.user.id);
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
          `${personName(ctx.user)} added you to ${org?.name ?? "a workspace"} on LeadDash Employees as ${input.role}.\n\nSign in with this email address at ${ENV.appUrl}`
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
      .input(orgInput.extend({ questionId: z.number(), answer: z.string().max(200) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return apply.answerQuestion(input.organizationId, input.questionId, input.answer, personName(ctx.user));
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
          targetPlatforms: z.array(z.enum(["linkedin", "instagram", "facebook", "x"])).min(1),
          tone: z.enum(["thought_leadership", "community_announcement", "clinical_advocacy", "event_invitation"]),
          generateImageFlag: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { organizationId, ...rest } = input;
        return tasks.writeSocialPost(organizationId, rest);
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
          action: z.enum(["approve_for_dispatch", "request_revisions", "cancel"]),
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
        const status =
          input.action === "approve_for_dispatch" ? "approved" : input.action === "request_revisions" ? "changes_requested" : "cancelled";
        const updated = await db.updateOutboundItem(input.itemId, input.organizationId, {
          status,
          reviewerNotes: input.notes ?? null,
          ...(status === "approved" ? { approvedBy: reviewer, approvedAt: new Date() } : {}),
        });
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: reviewer,
          action: status === "approved" ? "Approved" : status === "changes_requested" ? "Sent back" : "Cancelled",
          details: `"${item.title}". ${status === "approved" ? "Held until the channel is connected; nothing is sent automatically yet." : ""}${input.notes ? ` Note: ${input.notes}` : ""}`.trim(),
        });
        return updated;
      }),
  }),

  // ==========================================
  // Chats
  // ==========================================
  chat: router({
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
        email: me.email,
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
  // Onboarding (every employee)
  // ==========================================
  onboarding: router({
    get: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
      if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
      const tasksFor = (await db.listScheduledTasks(input.organizationId)).filter((t) => t.employeeId === emp.id);
      return {
        questions: QUESTIONS[emp.kind] ?? [],
        answers: parseAnswers(emp.onboarding),
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
      };
    }),

    save: protectedProcedure
      .input(orgInput.extend({ employeeId: z.number(), answers: z.record(z.string(), z.union([z.string().max(500), z.array(z.string().max(100)).max(12)])) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
        if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
        const saved = await saveAnswers(emp, input.answers);
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Onboarded employee", details: emp.name });
        return saved;
      }),

    rewriteDay: protectedProcedure.input(orgInput.extend({ employeeId: z.number() })).mutation(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId, "member");
      const emp = await db.getEmployeeForOrg(input.employeeId, input.organizationId);
      if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
      return writeDayToDay(emp);
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
