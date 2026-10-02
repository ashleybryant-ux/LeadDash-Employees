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
  OUTBOUND_KINDS,
  PROVIDERS,
  type User,
} from "../drizzle/schema";
import { ROSTER } from "./employees/roster";
import * as tasks from "./employees/tasks";
import { sendChatMessage } from "./employees/chat";
import { describeRule, isValidTimeZone, nextRun } from "./employees/schedule";
import { runTaskNow } from "./employees/runner";
import { fetchWebpage, saveDocument, saveImage } from "./employees/files";
import { sendEmail } from "./_core/email";
import { ENV } from "./_core/env";
import { REPEATS } from "../drizzle/schema";

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
async function workItemOf(organizationId: number, id: number, kind: "speaking_opportunity" | "website_plan" | "video_plan") {
  const item = await db.getWorkItemForOrg(id, organizationId);
  if (!item || item.kind !== kind) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in this workspace." });
  return item;
}

/** Creates the seven starting employees for a new workspace. */
async function deployRoster(organizationId: number) {
  for (const r of ROSTER) {
    await db.createEmployee({
      organizationId,
      kind: r.kind,
      name: r.name,
      avatar: null,
      roleTitle: r.roleTitle,
      department: r.department,
      status: "active",
      efficiency: 98,
      description: r.description,
      capabilities: JSON.stringify(r.capabilities),
      systemPrompt: null,
    });
  }
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
  // Morgan: grants
  // ==========================================
  grants: router({
    listOpportunities: protectedProcedure
      .input(orgInput.extend({ status: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        const all = await db.listOpportunitiesByOrg(input.organizationId);
        if (input.status && input.status !== "all") return all.filter((o) => o.status === input.status);
        return all.filter((o) => o.status !== "archived");
      }),

    getOpportunity: protectedProcedure
      .input(z.object({ id: z.number(), organizationId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        return db.getOpportunityForOrg(input.id, input.organizationId);
      }),

    /** Real web search for open grants (replaces the old simulated scout). */
    scoutOpportunities: protectedProcedure
      .input(orgInput.extend({ focus: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const result = await tasks.findGrants(input.organizationId, input.focus);
        return { success: true, added: result.created.length, queries: result.queries };
      }),

    dismissOpportunity: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const opp = await db.updateOpportunity(input.id, input.organizationId, { status: "archived" });
        if (!opp) throw new TRPCError({ code: "NOT_FOUND", message: "That opportunity is not in this workspace." });
        return opp;
      }),

    startProposal: protectedProcedure
      .input(orgInput.extend({ opportunityId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return tasks.startProposal(input.organizationId, input.opportunityId, personName(ctx.user));
      }),

    listProposals: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      return db.listProposalsByOrg(input.organizationId);
    }),

    getProposal: protectedProcedure
      .input(orgInput.extend({ proposalId: z.number().optional(), opportunityId: z.number().optional() }))
      .query(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId);
        if (input.proposalId) return db.getProposalByIdForOrganization(input.proposalId, input.organizationId);
        if (input.opportunityId) return db.getProposalByOpportunityForOrganization(input.opportunityId, input.organizationId);
        return null;
      }),

    updateProposal: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          organizationId: z.number(),
          title: z.string().max(255).optional(),
          executiveSummary: z.string().max(50_000).optional(),
          statementOfNeed: z.string().max(50_000).optional(),
          programDesign: z.string().max(50_000).optional(),
          budgetNarrative: z.string().max(50_000).optional(),
          evaluationPlan: z.string().max(50_000).optional(),
          complianceChecklist: z.string().max(20_000).optional(),
          reviewerNotes: z.string().max(10_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const { id, organizationId, ...data } = input;
        const updated = await db.updateProposal(id, organizationId, data);
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "That proposal is not in this workspace." });
        await db.logAction({
          organizationId,
          actorType: "human_user",
          actorName: personName(ctx.user),
          action: "Edited proposal",
          details: `Edited "${updated.title}".`,
        });
        return updated;
      }),

    generateSection: protectedProcedure
      .input(
        orgInput.extend({
          proposalId: z.number(),
          sectionKey: z.enum(["executiveSummary", "statementOfNeed", "programDesign", "budgetNarrative", "evaluationPlan"]),
          guidancePrompt: z.string().max(2000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const result = await tasks.draftProposalSection(input.organizationId, input.proposalId, input.sectionKey, input.guidancePrompt);
        return { success: true, content: result.content };
      }),

    reviewProposal: protectedProcedure
      .input(
        orgInput.extend({
          proposalId: z.number(),
          action: z.enum(["approve", "request_edits", "mark_ready_for_portal"]),
          notes: z.string().max(5000).optional(),
          reviewerName: z.string().optional(), // ignored: the signed-in person is the reviewer
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "reviewer");
        const reviewer = personName(ctx.user);
        const status =
          input.action === "request_edits" ? "changes_requested" : input.action === "mark_ready_for_portal" ? "ready_for_portal" : "approved";
        const updated = await db.updateProposal(input.proposalId, input.organizationId, {
          status,
          reviewerNotes: input.notes ?? null,
          ...(input.action === "approve" ? { approvedBy: reviewer, approvedAt: new Date() } : {}),
        });
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "That proposal is not in this workspace." });
        if (status === "approved" || status === "ready_for_portal") {
          await db.updateOpportunity(updated.opportunityId, input.organizationId, { status: "approved_ready" });
        }
        await db.logAction({
          organizationId: input.organizationId,
          actorType: "human_user",
          actorName: reviewer,
          action: status === "changes_requested" ? "Sent proposal back" : status === "approved" ? "Approved proposal" : "Marked proposal ready to submit",
          details: `"${updated.title}".${input.notes ? ` Note: ${input.notes}` : ""}`,
        });
        return updated;
      }),
  }),

  // ==========================================
  // Des: speaking
  // ==========================================
  speaking: router({
    list: protectedProcedure.input(orgInput).query(async ({ ctx, input }) => {
      await requireMember(ctx, input.organizationId);
      const items = await db.listWorkItems(input.organizationId, "speaking_opportunity");
      return items.filter((i) => i.status !== "dismissed");
    }),
    find: protectedProcedure
      .input(orgInput.extend({ focus: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const r = await tasks.findSpeakingEvents(input.organizationId, input.focus);
        return { added: r.created.length, queries: r.queries };
      }),
    writePitch: protectedProcedure
      .input(orgInput.extend({ id: z.number(), guidance: z.string().max(1000).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return tasks.writePitch(input.organizationId, input.id, input.guidance);
      }),
    updatePitch: protectedProcedure
      .input(orgInput.extend({ id: z.number(), subject: z.string().max(300), body: z.string().max(10_000) }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        const item = await workItemOf(input.organizationId, input.id, "speaking_opportunity");
        const data = JSON.parse(item.data || "{}");
        return db.updateWorkItem(input.id, input.organizationId, {
          status: "drafted",
          data: JSON.stringify({ ...data, pitch: { subject: input.subject, body: input.body } }),
        });
      }),
    sendToApproval: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        return tasks.sendPitchToApproval(input.organizationId, input.id, personName(ctx.user));
      }),
    dismiss: protectedProcedure
      .input(orgInput.extend({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireMember(ctx, input.organizationId, "member");
        await workItemOf(input.organizationId, input.id, "speaking_opportunity");
        return db.updateWorkItem(input.id, input.organizationId, { status: "dismissed" });
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
        await db.createKnowledgeItem(input);
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
        });
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
        });
        await db.logAction({ organizationId: input.organizationId, actorType: "human_user", actorName: personName(ctx.user), action: "Added document to Brain", details: input.title });
        return item;
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
