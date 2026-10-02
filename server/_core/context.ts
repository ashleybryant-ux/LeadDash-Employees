import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse as parseCookies } from "cookie";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { SESSION_COOKIE } from "@shared/const";
import { sha256 } from "./crypto";

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
  const user = await db.getUserById(session.userId);
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
