import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import type { EmployeeKind } from "../../drizzle/schema";
import { withUsage } from "../usage";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Which employee a route works for, when the route itself says so. */
const ROUTE_KIND: [RegExp, EmployeeKind][] = [
  [/^website\./, "website"],
  [/^video\./, "video"],
  [/^social\./, "social"],
  [/^blog\./, "blog"],
  [/^projects\./, "projects"],
  [/^coo\./, "coo"],
  [/^hiring\./, "hiring"],
  [/^assistant\.(draftEmailReply|scheduleAppointmentHold|suggestTime)/, "inbox"],
  [/^assistant\.(generatePostAndCreative|savePost|schedule|unschedule|schedulePlan|applyPlan|tiktokCreator)/, "social"],
  [/^assistant\.draftWordPressArticle/, "blog"],
  [/^sales\.(prospects|updateProspect|notFit)/, "prospecting"],
  [/^sales\.(startOutreach|sequences|approveSequence|updateStep|stop|linkedin)/, "outreach"],
  [/^sales\.(leads|closeLead|replied)/, "leads"],
];

/** Runs each workspace route inside a usage context, so AI costs land on the right workspace and employee. */
const usageScope = t.middleware(async ({ path, getRawInput, next }) => {
  let raw: any = null;
  try {
    raw = await getRawInput();
  } catch {
    raw = null;
  }
  const input = raw && typeof raw === "object" && "json" in raw ? raw.json : raw;
  const orgId = Number(input?.organizationId);
  if (!Number.isFinite(orgId) || orgId <= 0) return next();
  const employeeId = Number(input?.employeeId) > 0 ? Number(input.employeeId) : null;
  const named = input?.employee === "grants" || input?.employee === "speaking" ? (input.employee as EmployeeKind) : null;
  const kind = named ?? ROUTE_KIND.find(([re]) => re.test(path))?.[1] ?? null;
  return withUsage({ orgId, employeeId, kind }, () => next());
});

/** Every route that touches workspace data uses this (or adminProcedure). */
export const protectedProcedure = t.procedure.use(requireUser).use(usageScope);

export const adminProcedure = t.procedure.use(
  t.middleware(async ({ ctx, next }) => {
    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({ ctx: { ...ctx, user: ctx.user } });
  })
);
