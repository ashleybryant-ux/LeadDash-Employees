import { TRPCError } from "@trpc/server";
import * as db from "../db";
import type { PjDoc } from "../../drizzle/schema";
import { sendEmail } from "../_core/email";
import { ENV } from "../_core/env";
import { LEVEL_RANK, levelFor, type Viewer } from "./pjAccess";

/**
 * Who can open a doc, the way ClickUp's Docs hub works.
 *
 * - A doc on a project is open to whoever can see that project, unless it is
 *   marked private. A doc in a folder, or on its own, is open to the workspace.
 * - Private: only its owner, owners and admins, and the people it is shared
 *   with (a teammate, an AI employee, or an outside email for this doc only).
 * - Workspace wide: everyone in the workspace (never guests), wherever it lives.
 * - A public link opens a read-only copy with no sign-in; turning it off breaks
 *   the link.
 */

export type DocLevel = "view" | "comment" | "edit";
const RANK: Record<DocLevel, number> = { view: 1, comment: 2, edit: 3 };

export function docLevel(orgId: number, v: Viewer, d: PjDoc): DocLevel | null {
  if (v.kind === "system") return "edit";
  if (v.kind === "member" && (v.role === "owner" || v.role === "admin")) return "edit";
  if (v.kind === "member" && d.ownerUserId === v.userId) return "edit";
  const shares = db.work.docShares.where(orgId, "docId", d.id);
  const mine = shares.find((s) => (v.kind === "member" || v.kind === "guest" ? (s.kind === "user" || s.kind === "guest") && s.userId === v.userId : s.kind === "employee" && s.employeeId === v.employeeId));
  if (mine) return mine.level;
  if (d.private) return null;
  if (v.kind === "guest") return null;
  if (d.workspaceWide) return v.kind === "member" && v.role === "reviewer" ? "view" : "edit";
  if (d.listId) {
    const l = db.work.lists.get(orgId, d.listId);
    const lv = l ? levelFor(orgId, v, l) : null;
    if (!lv) return null;
    return LEVEL_RANK[lv] >= LEVEL_RANK.edit ? "edit" : lv === "comment" ? "comment" : "view";
  }
  return v.kind === "member" && v.role === "reviewer" ? "view" : "edit";
}

export function mustDocLevel(orgId: number, v: Viewer, id: number, need: DocLevel) {
  const d = db.work.docs.get(orgId, id);
  if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "That doc isn't in this workspace." });
  const have = docLevel(orgId, v, d);
  if (!have) throw new TRPCError({ code: "NOT_FOUND", message: "That doc isn't in this workspace." });
  if (RANK[have] < RANK[need]) throw new TRPCError({ code: "FORBIDDEN", message: `You can ${have === "view" ? "look at" : "comment on"} this doc but not change it.` });
  return { doc: d, level: have };
}

/** Only the owner, an owner or admin, or someone with edit may change who sees a doc. */
export function mustOwnDoc(orgId: number, v: Viewer, id: number) {
  const { doc, level } = mustDocLevel(orgId, v, id, "edit");
  if (v.kind === "guest") throw new TRPCError({ code: "FORBIDDEN", message: "Guests can't share docs." });
  return { doc, level };
}

const fmtDate = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export async function docShares(orgId: number, v: Viewer, docId: number) {
  const { doc: d } = mustDocLevel(orgId, v, docId, "view");
  const rows = db.work.docShares.where(orgId, "docId", docId);
  const members = await db.listMembers(orgId);
  const emps = await db.listEmployeesByOrg(orgId);
  const guestUsers = await db.getUsersByIds(rows.filter((r) => r.kind === "guest" && r.userId).map((r) => r.userId!));
  const owner = d.ownerUserId ? members.find((m) => m.userId === d.ownerUserId) : null;
  const people = [
    ...(owner ? [{ shareId: null as number | null, kind: "user" as const, id: owner.userId, name: owner.name || owner.email, email: owner.email, avatarUrl: owner.avatarUrl, level: "edit" as DocLevel, fixed: true, note: "Owner" }] : []),
    ...members
      .filter((m) => (m.role === "owner" || m.role === "admin") && m.userId !== d.ownerUserId)
      .map((m) => ({ shareId: null as number | null, kind: "user" as const, id: m.userId, name: m.name || m.email, email: m.email, avatarUrl: m.avatarUrl, level: "edit" as DocLevel, fixed: true, note: m.role === "owner" ? "Workspace owner" : "Admin" })),
    ...rows
      .filter((r) => r.kind === "user")
      .map((r) => {
        const m = members.find((x) => x.userId === r.userId);
        return m && m.role !== "owner" && m.role !== "admin" && m.userId !== d.ownerUserId ? { shareId: r.id as number | null, kind: "user" as const, id: m.userId, name: m.name || m.email, email: m.email, avatarUrl: m.avatarUrl, level: r.level, fixed: false, note: m.email } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    ...rows
      .filter((r) => r.kind === "employee")
      .map((r) => {
        const e = emps.find((x) => x.id === r.employeeId);
        return e ? { shareId: r.id as number | null, kind: "employee" as const, id: e.id, name: e.name, email: "", avatarUrl: e.avatar ?? null, level: r.level, fixed: false, note: "AI employee" } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    ...rows
      .filter((r) => r.kind === "guest")
      .map((r) => {
        const u = guestUsers.find((x) => x.id === r.userId);
        return u ? { shareId: r.id as number | null, kind: "guest" as const, id: u.id, name: u.name || u.email, email: u.email, avatarUrl: u.avatarUrl ?? null, level: r.level, fixed: false, note: `Outside, this doc only · invited ${fmtDate(r.createdAt)}` } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
  ];
  const can = [
    ...members.filter((m) => m.role !== "owner" && m.role !== "admin" && m.userId !== d.ownerUserId && !rows.some((r) => r.kind === "user" && r.userId === m.userId)).map((m) => ({ kind: "user" as const, id: m.userId, name: m.name || m.email })),
    ...emps.filter((e) => !rows.some((r) => r.kind === "employee" && r.employeeId === e.id)).map((e) => ({ kind: "employee" as const, id: e.id, name: e.name })),
  ];
  const list = d.listId ? db.work.lists.get(orgId, d.listId) : null;
  return {
    private: d.private,
    workspaceWide: d.workspaceWide,
    inherits: list ? list.name : null,
    link: d.shareToken ? `${ENV.appUrl}/d/${d.shareToken}` : null,
    teamLink: `${ENV.appUrl}/projects?page=doc&id=${d.id}`,
    people,
    can,
  };
}

export async function shareDoc(orgId: number, v: Viewer, docId: number, input: { kind: "user" | "employee"; id: number; level: DocLevel } | { email: string; level: DocLevel }, by: string) {
  const { doc: d } = mustOwnDoc(orgId, v, docId);
  const rows = db.work.docShares.where(orgId, "docId", docId);
  if ("kind" in input) {
    if (input.kind === "user") {
      if (!(await db.getOrganizationMembership(orgId, input.id))) throw new TRPCError({ code: "NOT_FOUND", message: "That person isn't on this workspace." });
      if (!rows.some((r) => r.kind === "user" && r.userId === input.id)) db.work.docShares.insert({ organizationId: orgId, docId, kind: "user", userId: input.id, level: input.level });
    } else {
      if (!(await db.getEmployeeForOrg(input.id, orgId))) throw new TRPCError({ code: "NOT_FOUND", message: "That employee isn't on this workspace." });
      if (!rows.some((r) => r.kind === "employee" && r.employeeId === input.id)) db.work.docShares.insert({ organizationId: orgId, docId, kind: "employee", employeeId: input.id, level: input.level });
    }
    return { ok: true };
  }
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TRPCError({ code: "BAD_REQUEST", message: "That email address doesn't look right." });
  let user = await db.getUserByEmail(email);
  if (user?.role === "admin") throw new TRPCError({ code: "BAD_REQUEST", message: "LeadDash staff already see every workspace." });
  if (user && (await db.getOrganizationMembership(orgId, user.id))) {
    if (!rows.some((r) => r.kind === "user" && r.userId === user!.id)) db.work.docShares.insert({ organizationId: orgId, docId, kind: "user", userId: user.id, level: input.level });
    return { ok: true };
  }
  if (!user) user = await db.createUser({ email, name: null });
  if (!rows.some((r) => r.kind === "guest" && r.userId === user!.id)) db.work.docShares.insert({ organizationId: orgId, docId, kind: "guest", userId: user.id, email, level: input.level });
  const org = await db.getOrganizationById(orgId);
  void sendEmail(email, `${by} shared "${d.title}" with you`, `${by} at ${org?.name ?? "a workspace"} shared the doc "${d.title}" with you on LeadDash Employees.\n\nSign in with this email address at ${ENV.appUrl}/signin to open it. You'll see only what is shared with you.`).catch((err) => console.error("[projects] doc invite email failed:", err));
  return { ok: true };
}

export function setDocShareLevel(orgId: number, v: Viewer, docId: number, shareId: number, level: DocLevel) {
  mustOwnDoc(orgId, v, docId);
  const s = db.work.docShares.get(orgId, shareId);
  if (!s || s.docId !== docId) throw new TRPCError({ code: "NOT_FOUND", message: "That person isn't on this doc." });
  db.work.docShares.update(orgId, shareId, { level });
}
export function unshareDoc(orgId: number, v: Viewer, docId: number, shareId: number) {
  mustOwnDoc(orgId, v, docId);
  const s = db.work.docShares.get(orgId, shareId);
  if (s && s.docId === docId) db.work.docShares.remove(orgId, shareId);
}
/** Private: only the owner and the people it is shared with. Workspace wide: everyone on the team. The two can't both be on. */
export function setDocVisibility(orgId: number, v: Viewer, docId: number, input: { private?: boolean; workspaceWide?: boolean }) {
  mustOwnDoc(orgId, v, docId);
  const patch: Partial<PjDoc> = {};
  if (input.private !== undefined) {
    patch.private = input.private;
    if (input.private) patch.workspaceWide = false;
  }
  if (input.workspaceWide !== undefined) {
    patch.workspaceWide = input.workspaceWide;
    if (input.workspaceWide) patch.private = false;
  }
  db.work.docs.update(orgId, docId, patch);
}
/** Turns the public link on (a new key) or off. */
export function setDocLink(orgId: number, v: Viewer, docId: number, on: boolean) {
  mustOwnDoc(orgId, v, docId);
  const token = on ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}` : null;
  db.work.docs.update(orgId, docId, { shareToken: token });
  return token ? `${ENV.appUrl}/d/${token}` : null;
}
export function archiveDoc(orgId: number, v: Viewer, docId: number, on: boolean) {
  mustOwnDoc(orgId, v, docId);
  db.work.docs.update(orgId, docId, { archivedAt: on ? new Date() : null });
}

/** A star on a doc, whiteboard or form, for this person only. */
export function star(orgId: number, userId: number, kind: "doc" | "board" | "form", itemId: number, on: boolean) {
  const have = db.work.stars.all(orgId).find((s) => s.userId === userId && s.kind === kind && s.itemId === itemId);
  if (on && !have) db.work.stars.insert({ organizationId: orgId, userId, kind, itemId });
  if (!on && have) db.work.stars.remove(orgId, have.id);
}
export function starsOf(orgId: number, userId: number) {
  return db.work.stars.all(orgId).filter((s) => s.userId === userId).map((s) => `${s.kind}:${s.itemId}`);
}
