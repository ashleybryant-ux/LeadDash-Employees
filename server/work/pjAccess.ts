import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjList } from "../../drizzle/schema";
import { sendEmail } from "../_core/email";
import { ENV } from "../_core/env";

/**
 * Who sees which Projects lists, and what they can do there.
 *
 * - Owners and admins see and change everything.
 * - Members can change any list that isn't private; reviewers can only look.
 * - A private list shows only to the people and employees it's shared with.
 * - A guest is someone outside the workspace who sees only the lists shared
 *   with them, never chats, the Brain, Goals or anything else.
 *
 * Levels, lowest to highest: view, comment, edit, full (full can change the
 * list itself, share it and set its automations).
 */

export type Level = "view" | "comment" | "edit" | "full";
export const LEVEL_RANK: Record<Level, number> = { view: 1, comment: 2, edit: 3, full: 4 };

export type Viewer =
  | { kind: "member"; userId: number; role: "owner" | "admin" | "member" | "chat" | "reviewer"; name: string }
  | { kind: "guest"; userId: number; name: string }
  | { kind: "employee"; employeeId: number; name: string }
  | { kind: "system" };

export function levelFor(orgId: number, v: Viewer, list: PjList, shares = db.work.shares.where(orgId, "listId", list.id)): Level | null {
  // An archived list is read only for everyone until it is restored.
  const cap = (lv: Level | null): Level | null => (lv && list.archivedAt ? "view" : lv);
  if (v.kind === "system") return cap("full");
  if (v.kind === "member") {
    if (v.role === "owner" || v.role === "admin") return cap("full");
    // Private and admins only: nobody else, however it was shared before.
    if (list.private && list.adminsOnly) return null;
    const s = shares.find((x) => x.kind === "user" && x.userId === v.userId);
    if (s) return cap(s.level);
    if (list.private) return null;
    return cap(v.role === "reviewer" ? "view" : "edit");
  }
  if (list.private && list.adminsOnly) return null;
  if (v.kind === "guest") return cap(shares.find((x) => x.kind === "guest" && x.userId === v.userId)?.level ?? null);
  const s = shares.find((x) => x.kind === "employee" && x.employeeId === v.employeeId);
  if (s) return cap(s.level);
  return list.private ? null : cap("edit");
}

/** Every list this viewer can open, with their level on it. Archived lists stay out unless asked for. */
export function visibleLists(orgId: number, v: Viewer, opts: { archived?: boolean } = {}) {
  const shares = db.work.shares.all(orgId);
  return db.work.lists
    .all(orgId)
    .filter((l) => opts.archived || !l.archivedAt)
    .map((l) => ({ list: l, level: levelFor(orgId, v, l, shares.filter((s) => s.listId === l.id)) }))
    .filter((x): x is { list: PjList; level: Level } => x.level !== null);
}

export function mustLevel(orgId: number, v: Viewer, listId: number, need: Level) {
  const l = db.work.lists.get(orgId, listId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const have = levelFor(orgId, v, l);
  if (!have) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  if (LEVEL_RANK[have] < LEVEL_RANK[need]) {
    const say = { view: "look at", comment: "comment on", edit: "change", full: "change the settings of" }[need];
    throw new TRPCError({ code: "FORBIDDEN", message: `You can't ${say} ${l.name}. Ask its owner for more access.` });
  }
  return { list: l, level: have };
}

/** A task's list level. */
export function mustTaskLevel(orgId: number, v: Viewer, taskId: number, need: Level) {
  const t = db.work.tasks.get(orgId, taskId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That task isn't in this workspace." });
  return { task: t, ...mustLevel(orgId, v, t.listId, need) };
}

/** Members only: guests never reach workspace-wide Projects pages (dashboards, timesheets, docs, forms). */
export function mustMember(v: Viewer) {
  if (v.kind === "guest") throw new TRPCError({ code: "FORBIDDEN", message: "Guests see only the lists shared with them." });
}

// ==========================================
// Sharing
// ==========================================

export async function sharesOf(orgId: number, listId: number) {
  const l = db.work.lists.get(orgId, listId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const rows = db.work.shares.where(orgId, "listId", listId);
  const members = await db.listMembers(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const guestUsers = await db.getUsersByIds(rows.filter((r) => r.kind === "guest" && r.userId).map((r) => r.userId!));
  const people = [
    // Owners and admins always have full access.
    ...members
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => ({ shareId: null as number | null, kind: "user" as const, id: m.userId, name: m.name || m.email, email: m.email, avatarUrl: m.avatarUrl, level: (m.role === "owner" ? "owner" : "full") as Level | "owner", fixed: true, note: m.role === "owner" ? "Owner" : "Admin" })),
    ...rows
      .filter((r) => r.kind === "user")
      .map((r) => {
        const m = members.find((x) => x.userId === r.userId);
        return m && m.role !== "owner" && m.role !== "admin" ? { shareId: r.id as number | null, kind: "user" as const, id: m.userId, name: m.name || m.email, email: m.email, avatarUrl: m.avatarUrl, level: r.level as Level | "owner", fixed: false, note: m.email } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    ...rows
      .filter((r) => r.kind === "employee")
      .map((r) => {
        const e = emps.find((x) => x.id === r.employeeId);
        return e ? { shareId: r.id as number | null, kind: "employee" as const, id: e.id, name: e.name, email: "", avatarUrl: e.avatar ?? null, level: r.level as Level | "owner", fixed: false, note: "AI employee" } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    ...rows
      .filter((r) => r.kind === "guest")
      .map((r) => {
        const u = guestUsers.find((x) => x.id === r.userId);
        return u ? { shareId: r.id as number | null, kind: "guest" as const, id: u.id, name: u.name || u.email, email: u.email, avatarUrl: u.avatarUrl ?? null, level: r.level as Level | "owner", fixed: false, note: `Only this list · invited ${fmtDate(r.createdAt)}` } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
  ];
  // Who could be added: teammates and employees not on the list yet.
  const can = [
    ...members.filter((m) => m.role !== "owner" && m.role !== "admin" && !rows.some((r) => r.kind === "user" && r.userId === m.userId)).map((m) => ({ kind: "user" as const, id: m.userId, name: m.name || m.email })),
    ...emps.filter((e) => !rows.some((r) => r.kind === "employee" && r.employeeId === e.id)).map((e) => ({ kind: "employee" as const, id: e.id, name: e.name })),
  ];
  return { private: l.private, adminsOnly: l.adminsOnly, link: l.shareToken ? `${ENV.appUrl}/share/${l.shareToken}` : null, teamLink: `${ENV.appUrl}/projects?list=${l.id}`, people, can };
}

const fmtDate = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Shares a list with a teammate, an employee, or by email (a guest when the email isn't on the team). */
export async function share(orgId: number, listId: number, input: { kind: "user" | "employee"; id: number; level: Level } | { email: string; level: Level }, by: string) {
  const l = db.work.lists.get(orgId, listId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  const rows = db.work.shares.where(orgId, "listId", listId);
  if ("kind" in input) {
    if (input.kind === "user") {
      if (!(await db.getOrganizationMembership(orgId, input.id))) throw new TRPCError({ code: "NOT_FOUND", message: "That person isn't on this workspace." });
      if (rows.some((r) => r.kind === "user" && r.userId === input.id)) return { ok: true };
      db.work.shares.insert({ organizationId: orgId, listId, kind: "user", userId: input.id, level: input.level, invitedBy: by });
    } else {
      if (!(await db.getEmployeeForOrg(input.id, orgId))) throw new TRPCError({ code: "NOT_FOUND", message: "That employee isn't on this workspace." });
      if (rows.some((r) => r.kind === "employee" && r.employeeId === input.id)) return { ok: true };
      db.work.shares.insert({ organizationId: orgId, listId, kind: "employee", employeeId: input.id, level: input.level, invitedBy: by });
    }
    return { ok: true };
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TRPCError({ code: "BAD_REQUEST", message: "That email address doesn't look right." });
  let user = await db.getUserByEmail(email);
  if (user?.role === "admin") throw new TRPCError({ code: "BAD_REQUEST", message: "LeadDash staff already see every workspace." });
  if (user && (await db.getOrganizationMembership(orgId, user.id))) {
    if (!rows.some((r) => r.kind === "user" && r.userId === user!.id)) db.work.shares.insert({ organizationId: orgId, listId, kind: "user", userId: user.id, level: input.level, invitedBy: by });
    return { ok: true };
  }
  if (!user) user = await db.createUser({ email, name: null });
  if (rows.some((r) => r.kind === "guest" && r.userId === user!.id)) return { ok: true };
  db.work.shares.insert({ organizationId: orgId, listId, kind: "guest", userId: user.id, level: input.level, invitedBy: by });
  const org = await db.getOrganizationById(orgId);
  void sendEmail(
    email,
    `${by} shared "${l.name}" with you`,
    `${by} at ${org?.name ?? "a workspace"} shared the list "${l.name}" with you on LeadDash Employees.\n\nSign in with this email address at ${ENV.appUrl}/signin to open it. You'll see only the lists shared with you.`
  ).catch((err) => console.error("[projects] guest invite email failed:", err));
  return { ok: true };
}

export function setShareLevel(orgId: number, shareId: number, level: Level) {
  if (!db.work.shares.get(orgId, shareId)) throw new TRPCError({ code: "NOT_FOUND", message: "That person isn't on this list." });
  db.work.shares.update(orgId, shareId, { level });
}
export function unshare(orgId: number, shareId: number) {
  db.work.shares.remove(orgId, shareId);
}
export function setPrivate(orgId: number, listId: number, on: boolean, adminsOnly = false) {
  db.work.lists.update(orgId, listId, { private: on, adminsOnly: on && adminsOnly });
}
/** Turns the view-only link on (a new key) or off. */
export function setLink(orgId: number, listId: number, on: boolean) {
  const token = on ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}` : null;
  db.work.lists.update(orgId, listId, { shareToken: token });
  return token ? `${ENV.appUrl}/share/${token}` : null;
}

/** Workspaces where this person is a guest (and not a member), with the lists they see. */
export async function guestWorkspaces(userId: number) {
  const rows = db.guestSharesForUser(userId);
  const orgIds = Array.from(new Set(rows.map((r) => r.organizationId)));
  const out = [];
  for (const id of orgIds) {
    if (await db.getOrganizationMembership(id, userId)) continue;
    const org = await db.getOrganizationById(id);
    if (org) out.push(org);
  }
  return out;
}
