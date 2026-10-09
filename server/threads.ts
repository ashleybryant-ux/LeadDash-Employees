/**
 * Who sees which conversations with the AI employees.
 *
 * Each person has their own conversation with each employee (chat_messages.threadUserId is the
 * person; null is the Workspace conversation: scheduled task reports and what employees post on
 * their own). Owners and admins see every conversation in the workspace and can write in any of
 * them. Everyone else sees their own, plus whatever the Team page opens for them, read only.
 */
import type { OrganizationMember } from "../drizzle/schema";

/** A conversation: a person's (their user id) or the Workspace one. */
export type Thread = number | "workspace";

export type ChatAccess = { mode: "own" | "some" | "all"; users: number[]; workspace: boolean };

export type Viewer = { userId: number; role: string; support?: boolean };

export const MANAGER_ROLES = ["owner", "admin"];

/** The conversations a member may open, as stored on their membership. */
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

/** Whether this viewer may read that conversation. */
export function canSee(viewer: Viewer, access: ChatAccess, thread: Thread): boolean {
  if (viewer.support || MANAGER_ROLES.includes(viewer.role)) return true;
  if (thread === viewer.userId) return true;
  if (access.mode === "all") return true;
  if (access.mode === "some") return thread === "workspace" ? access.workspace : access.users.includes(thread);
  return false;
}

/** Whether this viewer may write in that conversation: their own, or any one for owners and admins. */
export function canWrite(viewer: Viewer, thread: Thread): boolean {
  if (viewer.support || MANAGER_ROLES.includes(viewer.role)) return true;
  return thread === viewer.userId;
}

/** Which people and the Workspace conversation show in the picker, besides their own. */
export function pickable(viewer: Viewer, access: ChatAccess, memberIds: number[]): { users: number[]; workspace: boolean } {
  const others = memberIds.filter((id) => id !== viewer.userId);
  if (viewer.support || MANAGER_ROLES.includes(viewer.role) || access.mode === "all") return { users: others, workspace: true };
  if (access.mode === "some") return { users: others.filter((id) => access.users.includes(id)), workspace: access.workspace };
  return { users: [], workspace: false };
}

/** The read marker key for a conversation, from the viewer's side. */
export function readKey(viewer: { userId: number }, thread: Thread): string {
  return thread === "workspace" ? "workspace" : thread === viewer.userId ? "me" : `u:${thread}`;
}

/** The thread column value for a conversation. */
export function threadUserId(thread: Thread): number | null {
  return thread === "workspace" ? null : thread;
}

/** What the Team page shows in the Conversations column. */
export function accessLabel(m: Pick<OrganizationMember, "role" | "chatAccess" | "chatAccessList">): string {
  const a = accessOf(m);
  if (a.mode === "all") return "Everyone's";
  if (a.mode === "some") {
    const n = a.users.length + (a.workspace ? 1 : 0);
    return n ? `Own + ${n}` : "Own only";
  }
  return "Own only";
}
