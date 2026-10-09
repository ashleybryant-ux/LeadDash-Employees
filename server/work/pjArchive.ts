import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { LEVEL_RANK, levelFor, mustMember, visibleLists, type Viewer } from "./pjAccess";

/**
 * Archiving a project (a list) or a folder: it leaves the tree, Everything,
 * Home, portfolios and the AI team's checks, keeps its tasks, docs and time,
 * opens read only from the Archived section, and comes back with Restore.
 * Archiving a folder archives every list in it.
 */

function mustFull(orgId: number, v: Viewer, listId: number) {
  const l = db.work.lists.get(orgId, listId);
  if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "That list isn't in this workspace." });
  // levelFor caps archived lists at view, so judge the list as if it were live.
  const lv = levelFor(orgId, v, { ...l, archivedAt: null });
  if (!lv || LEVEL_RANK[lv] < LEVEL_RANK.full) throw new TRPCError({ code: "FORBIDDEN", message: `Only someone with full access can archive or restore ${l.name}.` });
  return l;
}

export function archiveList(orgId: number, v: Viewer, id: number, by: string) {
  mustFull(orgId, v, id);
  db.work.lists.update(orgId, id, { archivedAt: new Date(), archivedBy: by });
  return { ok: true };
}

export function restoreList(orgId: number, v: Viewer, id: number) {
  const l = mustFull(orgId, v, id);
  db.work.lists.update(orgId, id, { archivedAt: null, archivedBy: "" });
  // Back in a live folder: a folder archived with it comes back too, with just this list.
  if (l.folderId) {
    const f = db.work.folders.get(orgId, l.folderId);
    if (f?.archivedAt) db.work.folders.update(orgId, f.id, { archivedAt: null, archivedBy: "" });
  }
  return { ok: true };
}

export function archiveFolder(orgId: number, v: Viewer, id: number, by: string) {
  mustMember(v);
  if (v.kind === "member" && v.role === "reviewer") throw new TRPCError({ code: "FORBIDDEN", message: "Reviewers can look but not archive." });
  const f = db.work.folders.get(orgId, id);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That folder isn't in this workspace." });
  const at = new Date();
  db.work.folders.update(orgId, id, { archivedAt: at, archivedBy: by });
  for (const l of db.work.lists.where(orgId, "folderId", id)) if (!l.archivedAt) db.work.lists.update(orgId, l.id, { archivedAt: at, archivedBy: by });
  return { ok: true };
}

export function restoreFolder(orgId: number, v: Viewer, id: number) {
  mustMember(v);
  if (v.kind === "member" && v.role === "reviewer") throw new TRPCError({ code: "FORBIDDEN", message: "Reviewers can look but not restore." });
  const f = db.work.folders.get(orgId, id);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That folder isn't in this workspace." });
  db.work.folders.update(orgId, id, { archivedAt: null, archivedBy: "" });
  for (const l of db.work.lists.where(orgId, "folderId", id)) if (l.archivedAt) db.work.lists.update(orgId, l.id, { archivedAt: null, archivedBy: "" });
  return { ok: true };
}

/** The Archived section of the tree: archived folders (with their lists) and archived lists on their own. */
export function archived(orgId: number, v: Viewer) {
  const lists = visibleLists(orgId, v, { archived: true }).filter((x) => x.list.archivedAt);
  const folders = db.work.folders.all(orgId).filter((f) => f.archivedAt).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const inArchivedFolder = new Set(folders.map((f) => f.id));
  const row = (x: (typeof lists)[number]) => ({ id: x.list.id, name: x.list.name, folderId: x.list.folderId, archivedAt: x.list.archivedAt, archivedBy: x.list.archivedBy });
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name, color: f.color, archivedAt: f.archivedAt, archivedBy: f.archivedBy, lists: lists.filter((x) => x.list.folderId === f.id).map(row) })),
    lists: lists.filter((x) => !x.list.folderId || !inArchivedFolder.has(x.list.folderId)).map(row).sort((a, b) => (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0)),
  };
}
