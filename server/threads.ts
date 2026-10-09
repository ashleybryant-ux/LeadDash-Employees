/**
 * Who sees what in an employee's chat.
 *
 * Every workspace has one chat per AI employee, and every message in it says who said it. Each
 * message also belongs to a person (chat_messages.threadUserId: the person who asked, with the
 * employee's answer filed under the same person) or to nobody (null: scheduled task reports).
 * What a viewer sees in the chat is the union of what they may read: owners and admins read
 * everything; everyone else reads their own messages and the employee's answers to them, plus
 * whatever the Team page opens for them (other people's, or the scheduled task reports).
 */
import type { OrganizationMember } from "../drizzle/schema";

export type ChatAccess = { mode: "own" | "some" | "all"; users: number[]; workspace: boolean };

export type Viewer = { userId: number; role: string; support?: boolean };

/** Which messages a viewer may read: every one, or those filed under these people (null: scheduled task reports). */
export type Visible = "all" | (number | null)[];

export const MANAGER_ROLES = ["owner", "admin"];

/** What a member may read beyond their own messages, as stored on their membership. */
export function accessOf(m: Pick<OrganizationMember, "role" | "chatAccess" | "chatAccessList"> | null | undefined): ChatAccess {
  if (!m) return { mode: "own", users: [], workspace: false };
  if (MANAGER_ROLES.includes(m.role)) return { mode: "all", users: [], workspace: true };
  let list: { users?: unknown; workspace?: unknown } = {};
  try {
    list = m.chatAccessList ? JSON.parse(m.chatAccessList) : {};
  } catch {
    list = {};
  }
  const users = Array.isArray(list.users) ? list.users.filter((u): u is number => Number.isInteger(u)) : [];
  return { mode: m.chatAccess === "some" || m.chatAccess === "all" ? m.chatAccess : "own", users, workspace: list.workspace === true };
}

/** The messages this viewer reads in an employee's chat. */
export function visibleFor(viewer: Viewer, access: ChatAccess): Visible {
  if (viewer.support || MANAGER_ROLES.includes(viewer.role) || access.mode === "all") return "all";
  const mine: (number | null)[] = [viewer.userId];
  if (access.mode === "some") {
    for (const id of access.users) if (!mine.includes(id)) mine.push(id);
    if (access.workspace) mine.push(null);
  }
  return mine;
}

/** Whether a message filed under this person (null: a scheduled task report) is within what the viewer reads. */
export function canSee(visible: Visible, threadUserId: number | null): boolean {
  return visible === "all" || visible.includes(threadUserId);
}

/**
 * Whose messages a new message is filed under. A person's own message is theirs. An owner or admin
 * replying (Reply) to someone else's message files it under that person, so they see the answer too.
 */
export function fileUnder(viewer: Viewer, quoted: { threadUserId: number | null } | null | undefined): number | null {
  if (quoted && quoted.threadUserId !== viewer.userId && (viewer.support || MANAGER_ROLES.includes(viewer.role))) return quoted.threadUserId;
  return viewer.userId;
}

/** What the Team page shows in the Sees column. */
export function accessLabel(m: Pick<OrganizationMember, "role" | "chatAccess" | "chatAccessList">): string {
  const a = accessOf(m);
  if (a.mode === "all") return "Everything";
  if (a.mode === "some") {
    const n = a.users.length + (a.workspace ? 1 : 0);
    return n ? `Own + ${n}` : "Own only";
  }
  return "Own only";
}
