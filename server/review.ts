/**
 * App review access: a sign-in for the Google and Meta app reviewers.
 *
 * While access is on and before its end date, the review email signs in with
 * a fixed code (no email is sent), and it only reaches the demo workspace.
 * Turning access off, or passing the end date, signs the reviewer out and
 * disconnects anything they connected in the demo workspace.
 */
import type { ReviewAccess, User } from "../drizzle/schema";
import * as db from "./db";
import { decryptJson, encryptJson, randomCode, safeEqual } from "./_core/crypto";
import { ensureRoster } from "./employees/roster-sync";
import { disconnect } from "./integrations";

export const DEFAULT_REVIEW_EMAIL = "review@leaddash.io";
const DEMO_NAME = "Demo practice";
const DEMO_SLUG = "demo-practice";
const ZONE = "America/Chicago";

const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
let fails: number[] = [];

const norm = (email: string) => email.trim().toLowerCase();

/** "11/30/2026" to 20261130, or null when the text is not a real date. */
export function dateKey(mmddyyyy: string | null | undefined): number | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((mmddyyyy ?? "").trim());
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y * 10000 + mo * 100 + d;
}

function todayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return get("year") * 10000 + get("month") * 100 + get("day");
}

export function readCode(row: ReviewAccess | null): string | null {
  if (!row?.codeEncrypted) return null;
  try {
    return decryptJson<{ code: string }>(row.codeEncrypted)?.code ?? null;
  } catch {
    return null;
  }
}

/** On, has a code, and the end date (if any) has not passed. */
export function isActive(row: ReviewAccess | null, now = new Date()) {
  if (!row?.enabled || !row.codeEncrypted) return false;
  const end = dateKey(row.endsOn);
  return end === null ? !row.endsOn : todayKey(now) <= end;
}

export function isReviewEmail(email: string) {
  const row = db.getReviewAccess();
  return !!row && norm(row.email) === norm(email);
}

/** True when this signed-in user is the reviewer account. */
export function isReviewUser(user: Pick<User, "email"> | null | undefined) {
  return !!user && isReviewEmail(user.email);
}

/** The review email can sign in right now. */
export function reviewCanSignIn(email: string) {
  const row = db.getReviewAccess();
  return !!row && norm(row.email) === norm(email) && isActive(row);
}

/** Checks the fixed code. Locks for 15 minutes after 10 wrong tries. */
export function reviewCodeMatches(email: string, code: string) {
  const now = Date.now();
  fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
  if (fails.length >= MAX_FAILS) return false;
  const row = db.getReviewAccess();
  const real = readCode(row);
  if (!row || !real || !isActive(row) || norm(row.email) !== norm(email) || !safeEqual(code, real)) {
    fails.push(now);
    return false;
  }
  return true;
}

/** Test hook. */
export function resetReviewFails() {
  fails = [];
}

/** The demo workspace id, if one exists. */
export function demoOrgId(): number | null {
  return db.getReviewAccess()?.organizationId ?? null;
}

export function isDemoOrg(orgId: number) {
  const id = demoOrgId();
  return id !== null && id === orgId;
}

/** Creates the demo workspace with sample work the first time, or returns the existing one. */
export async function ensureDemoOrg(): Promise<number> {
  const row = db.getReviewAccess();
  if (row?.organizationId && (await db.getOrganizationById(row.organizationId))) return row.organizationId;
  let org = await db.getOrganizationBySlug(DEMO_SLUG);
  if (!org) {
    org = await db.createOrganization({
      name: DEMO_NAME,
      slug: DEMO_SLUG,
      plan: "growth",
      state: "Oklahoma City, OK",
      website: "example.com",
      description: "Sample group counseling practice used for app review. Every person and number here is made up.",
      audience: "Adults, couples and families",
      entity: "Demo Practice LLC (for-profit)",
      signerName: "Sam Rivera",
      signerTitle: "Owner",
    });
    await ensureRoster(org.id);
    await seedDemo(org.id);
  }
  db.saveReviewAccess({ organizationId: org.id });
  return org.id;
}

async function seedDemo(orgId: number) {
  const emps = await db.listEmployeesByOrg(orgId);
  const by = (kind: string) => emps.find((e) => e.kind === kind)?.id ?? null;
  await db.createOutboundItem({
    organizationId: orgId,
    employeeId: by("social"),
    kind: "social_post",
    status: "pending_approval",
    title: "Three small habits that help couples argue less",
    body: "Most couples we meet are not fighting about the dishes. They are fighting about feeling unheard. Three habits that help: say what you need before you are upset, repeat back what you heard, and take a 20-minute break when voices rise. Which one would help your home this week?",
    targetChannels: JSON.stringify(["LinkedIn", "Facebook", "Instagram"]),
    metadata: JSON.stringify({ platforms: ["LinkedIn", "Facebook", "Instagram"], tone: "warm" }),
  });
  await db.createOutboundItem({
    organizationId: orgId,
    employeeId: by("inbox"),
    kind: "email_draft",
    status: "pending_approval",
    title: "Meeting about the spring workshop",
    body: "Hi Jordan,\n\nCould we meet this week to plan the spring parenting workshop? Thursday at 3:00 PM works on my side, and I can send a calendar invite once you confirm.\n\nThank you,\nSam Rivera",
    targetChannels: JSON.stringify(["Gmail"]),
    metadata: JSON.stringify({ recipient: "Jordan Lee", email: "jordan@example.com", whatTheyWant: "Set a planning meeting", urgency: "this week", newEmail: true }),
  });
  await db.createOutboundItem({
    organizationId: orgId,
    employeeId: by("inbox"),
    kind: "calendar_hold",
    status: "pending_approval",
    title: "Spring workshop planning",
    body: "Agenda:\nTopics, room and sign-up page\n\nTime: Thursday at 3:00 PM\nAttendees: jordan@example.com",
    targetChannels: JSON.stringify(["Google Calendar"]),
    metadata: JSON.stringify({ date: "", time: "3:00 PM", attendees: ["jordan@example.com"] }),
  });
  const role = await db.createHrRole({
    organizationId: orgId,
    title: "Licensed Professional Counselor",
    employment: "w2",
    hours: "full",
    place: "both",
    payFrom: "$60,000",
    payTo: "$72,000",
    licenses: JSON.stringify(["LPC"]),
    mustHave: "Active Oklahoma LPC license",
    niceToHave: "Couples or family experience",
  });
  await db.createHrPerson({
    organizationId: orgId,
    roleId: role.id,
    source: "applicant",
    stage: "new",
    name: "Casey Morgan",
    credentials: "LPC",
    currentRole: "Counselor at a community clinic",
    location: "Oklahoma City, OK",
    appliedOn: "Website",
    fitScore: 82,
    fitReason: "Meets the license requirement and has 4 years of family work.",
    mustHaves: JSON.stringify([
      { item: "Active Oklahoma LPC license", met: "yes", kind: "must" },
      { item: "Couples or family experience", met: "yes", kind: "nice" },
    ]),
  });
}

/** The reviewer's user row, on the demo workspace as an admin (so they can connect apps). */
export async function ensureReviewer(email: string) {
  const orgId = await ensureDemoOrg();
  let user = await db.getUserByEmail(norm(email));
  if (!user) user = await db.createUser({ email: norm(email), name: "App reviewer" });
  if (user.role === "admin") throw new Error("The review email cannot be a LeadDash staff email.");
  if (!(await db.getOrganizationMembership(orgId, user.id))) {
    await db.addOrganizationMember({ organizationId: orgId, userId: user.id, role: "admin", title: "App reviewer" });
  }
  db.saveReviewAccess({ lastSignInAt: new Date() });
  return user;
}

async function signOutReviewer(email: string) {
  const user = await db.getUserByEmail(norm(email));
  if (user && user.role !== "admin") await db.revokeSessionsForUser(user.id);
}

/** Signs the reviewer out everywhere and disconnects what they connected in the demo workspace. */
export async function endReviewerAccess(email: string) {
  await signOutReviewer(email);
  const orgId = demoOrgId();
  if (orgId) {
    for (const conn of await db.listConnectionsByOrg(orgId)) {
      if (conn.status === "connected" || conn.secretsEncrypted) await disconnect(orgId, conn.provider).catch(() => {});
    }
  }
}

/** Ends access that ran past its end date. Called by the runner tick and on each request. */
let lastSweep = 0;
export async function sweepExpired(now = new Date()) {
  if (now.getTime() - lastSweep < 60_000) return;
  lastSweep = now.getTime();
  const row = db.getReviewAccess();
  if (row?.enabled && row.endsOn && !isActive(row, now)) {
    db.saveReviewAccess({ enabled: false });
    await endReviewerAccess(row.email);
  }
}

export type ReviewView = {
  enabled: boolean;
  active: boolean;
  email: string;
  code: string | null;
  endsOn: string | null;
  opens: string;
  lastSignInAt: Date | null;
};

export async function reviewView(): Promise<ReviewView> {
  const row = db.getReviewAccess();
  const orgId = row?.organizationId ?? null;
  const org = orgId ? await db.getOrganizationById(orgId) : null;
  return {
    enabled: !!row?.enabled,
    active: isActive(row),
    email: row?.email ?? DEFAULT_REVIEW_EMAIL,
    code: readCode(row),
    endsOn: row?.endsOn ?? null,
    opens: `${org?.name ?? DEMO_NAME} (sample data)`,
    lastSignInAt: row?.lastSignInAt ?? null,
  };
}

/** Saves the card. Turning on makes a code (if none) and the demo workspace. */
export async function saveReview(input: { enabled: boolean; email: string; endsOn: string | null }, isTakenEmail: (email: string) => Promise<boolean>) {
  const before = db.getReviewAccess();
  const email = norm(input.email);
  if (input.endsOn && dateKey(input.endsOn) === null) throw new Error("Type the end date as MM/DD/YYYY.");
  if (input.endsOn && input.enabled && (dateKey(input.endsOn) ?? 0) < todayKey()) throw new Error("The end date has already passed.");
  if (await isTakenEmail(email)) throw new Error("That email already belongs to someone on LeadDash Employees. Use an address only reviewers get.");
  const emailChanged = !!before && norm(before.email) !== email;
  if (before && (emailChanged || (before.enabled && !input.enabled))) await endReviewerAccess(before.email);
  const data: Partial<ReviewAccess> = { enabled: input.enabled, email, endsOn: input.endsOn || null };
  if (!before?.codeEncrypted) data.codeEncrypted = encryptJson({ code: randomCode() });
  db.saveReviewAccess(data);
  if (input.enabled) await ensureDemoOrg();
  return reviewView();
}

/** A new code. The old one stops working and the reviewer is signed out. */
export async function newReviewCode() {
  const row = db.getReviewAccess();
  db.saveReviewAccess({ codeEncrypted: encryptJson({ code: randomCode() }) });
  if (row) await signOutReviewer(row.email);
  resetReviewFails();
  return reviewView();
}
