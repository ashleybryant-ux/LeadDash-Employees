import type { Request, Response } from "express";
import { TRPCError } from "@trpc/server";
import { SESSION_COOKIE } from "@shared/const";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { randomCode, randomToken, safeEqual, sha256 } from "./crypto";
import { sendEmail } from "./email";
import { ENV } from "./env";
import { ensureReviewer, isReviewEmail, reviewCanSignIn, reviewCodeMatches } from "../review";

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 5;
const WINDOW_MINUTES = 15;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** ADMIN_EMAILS is the only source of LeadDash staff access. */
export function isStaffEmail(email: string) {
  return ENV.adminEmails.includes(email.toLowerCase());
}

/** Who may sign in: LeadDash staff, or anyone currently on a workspace. */
async function canSignIn(email: string) {
  if (isStaffEmail(email)) return true;
  // The app review email signs in only while review access is on.
  if (isReviewEmail(email)) return reviewCanSignIn(email);
  const user = await db.getUserByEmail(email);
  if (!user) return false;
  return (await db.countMembershipsForUser(user.id)) > 0;
}

/**
 * Always answers the same way, whether or not the email has an account, so the
 * sign-in page never reveals who uses the product.
 */
export async function requestCode(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  if ((await db.countRecentLoginCodes(email, since)) >= MAX_CODES_PER_WINDOW) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many codes requested. Try again in 15 minutes." });
  }
  if (!(await canSignIn(email))) {
    // Record a dummy code so the rate limit still applies to unknown emails.
    await db.createLoginCode(email, sha256(randomToken()), new Date(Date.now() + CODE_MINUTES * 60_000));
    return { sent: true };
  }

  // The reviewer types the fixed code from App review access; no email goes out.
  if (isReviewEmail(email)) {
    await db.createLoginCode(email, sha256(randomToken()), new Date(Date.now() + CODE_MINUTES * 60_000));
    return { sent: true };
  }

  const code = randomCode();
  await db.createLoginCode(email, sha256(code), new Date(Date.now() + CODE_MINUTES * 60_000));
  // Not awaited, so a real account answers as fast as an unknown email.
  void sendEmail(
    email,
    `Your LeadDash Employees code: ${code}`,
    `Your sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.\n\n${ENV.appUrl}/signin`,
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#14221c"><p>Your sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for ${CODE_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p></div>`
  ).catch((err) => console.error("[auth] sign-in email failed:", err));
  return { sent: true };
}

export async function verifyCode(rawEmail: string, rawCode: string, req: Request, res: Response) {
  const email = normalizeEmail(rawEmail);
  const code = rawCode.replace(/\D/g, "");
  const fail = () => new TRPCError({ code: "UNAUTHORIZED", message: "That code is not right or has expired." });
  if (code.length !== 6) throw fail();

  if (isReviewEmail(email)) {
    if (!reviewCodeMatches(email, code)) throw fail();
    const reviewer = await ensureReviewer(email);
    await db.updateUser(reviewer.id, { lastSignedIn: new Date() });
    await startSession(reviewer.id, req, res);
    return reviewer;
  }

  if (!db.consumeLoginCode(email, sha256(code), MAX_ATTEMPTS, safeEqual)) throw fail();

  // Re-check: someone removed from every workspace after the code was sent cannot finish.
  if (!(await canSignIn(email))) throw fail();

  let user = await db.getUserByEmail(email);
  const isStaff = isStaffEmail(email);
  if (!user) {
    if (!isStaff) throw fail();
    user = await db.createUser({ email, role: "admin" });
  } else if (isStaff !== (user.role === "admin")) {
    user = await db.updateUser(user.id, { role: isStaff ? "admin" : "user" });
  }
  if (!user) throw fail();
  await db.updateUser(user.id, { lastSignedIn: new Date() });

  await startSession(user.id, req, res);
  return user;
}

async function startSession(userId: number, req: Request, res: Response) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + ENV.sessionDays * 86400_000);
  await db.createSession(userId, sha256(token), expiresAt, req.ip ?? null);
  res.cookie(SESSION_COOKIE, token, { ...getSessionCookieOptions(req), maxAge: ENV.sessionDays * 86400_000 });
}

export async function signOut(tokenHash: string | null | undefined, req: Request, res: Response) {
  if (tokenHash) await db.revokeSession(tokenHash);
  res.clearCookie(SESSION_COOKIE, { ...getSessionCookieOptions(req), maxAge: undefined });
}
