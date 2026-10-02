import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse as parseCookies } from "cookie";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { SESSION_COOKIE } from "@shared/const";
import { sha256 } from "./crypto";
import { ENV } from "./env";
import { isReviewUser, reviewCanSignIn, sweepExpired } from "../review";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  sessionTokenHash?: string | null;
};

export async function authenticateRequest(req: CreateExpressContextOptions["req"]) {
  const token = parseCookies(req.headers.cookie ?? "")[SESSION_COOKIE];
  if (!token) return { user: null, tokenHash: null };
  const tokenHash = sha256(token);
  const session = await db.getSessionByTokenHash(tokenHash);
  if (!session) return { user: null, tokenHash: null };
  let user = await db.getUserById(session.userId);
  // Someone taken off ADMIN_EMAILS loses staff access on their next request.
  if (user && user.role === "admin" && !ENV.adminEmails.includes(user.email.toLowerCase())) {
    user = await db.updateUser(user.id, { role: "user" });
    if (user && (await db.countMembershipsForUser(user.id)) === 0) {
      await db.revokeSessionsForUser(user.id);
      return { user: null, tokenHash: null };
    }
  }
  // The app reviewer is signed out the moment review access is off or past its end date.
  if (user && isReviewUser(user)) {
    await sweepExpired();
    if (!reviewCanSignIn(user.email)) {
      await db.revokeSessionsForUser(user.id);
      return { user: null, tokenHash: null };
    }
  }
  return { user, tokenHash: user ? tokenHash : null };
}

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  let sessionTokenHash: string | null = null;
  try {
    const result = await authenticateRequest(opts.req);
    user = result.user;
    sessionTokenHash = result.tokenHash;
  } catch (error) {
    console.error("[auth] session lookup failed:", error);
  }
  return { req: opts.req, res: opts.res, user, sessionTokenHash };
}
