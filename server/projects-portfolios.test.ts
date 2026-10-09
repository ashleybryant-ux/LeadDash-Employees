import { afterEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, generateJson: vi.fn(async () => ({ status: "risk", summary: "Booth work is behind.", accomplishments: "Banner ordered.", blockers: "Electricity unbooked.", next: "BJ calls the venue." })) };
});
afterEach(() => vi.restoreAllMocks());

const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  const me = caller(ws.owner);
  const angela = await makeUser(`angela@${slug}.test`, "user", "Angela");
  await db.addOrganizationMember({ organizationId: ws.orgId, userId: angela.id, role: "member" });
  const folder = await me.pj.saveFolder({ organizationId: ws.orgId, name: "Webinars", color: "#7c3aed" });
  const list = await me.pj.saveList({ organizationId: ws.orgId, name: "Grow Without Hiring", folderId: folder.id });
  const other = await me.pj.saveList({ organizationId: ws.orgId, name: "NABC Dallas", folderId: null });
  return { ...ws, me, angela, her: caller(angela), folder, list, other };
}

describe("Private projects, docs the ClickUp way, archive, portfolios", () => {
  it("hides an admins-only project from members even when it was shared with them", async () => {
    const { orgId, me, her, angela, list } = await setup("pj-admins");
    await me.pj.share({ organizationId: orgId, listId: list.id, kind: "user", id: angela.id, level: "edit" });
    await me.pj.setPrivate({ organizationId: orgId, listId: list.id, on: true });
    expect((await her.pj.tree({ organizationId: orgId })).folders[0].lists.map((l) => l.name)).toEqual(["Grow Without Hiring"]);
    await me.pj.setPrivate({ organizationId: orgId, listId: list.id, on: true, adminsOnly: true });
    expect((await her.pj.tree({ organizationId: orgId })).folders[0].lists).toEqual([]);
    await expect(her.pj.view({ organizationId: orgId, listId: list.id, folderId: null, scope: "list" })).rejects.toThrow(/isn't in this workspace/);
    const s = await me.pj.shares({ organizationId: orgId, listId: list.id });
    expect(s).toMatchObject({ private: true, adminsOnly: true });
    expect(s.teamLink).toContain(`/projects?list=${list.id}`);
    // Off again: the share works as before.
    await me.pj.setPrivate({ organizationId: orgId, listId: list.id, on: true, adminsOnly: false });
    expect((await her.pj.view({ organizationId: orgId, listId: list.id, folderId: null, scope: "list" })).list?.level).toBe("edit");
  });

  it("shares a doc with people, an outside email, the workspace, and a public link; private docs stay hidden", async () => {
    const { orgId, me, her, angela, list } = await setup("pj-docs");
    const d = await me.pj.saveDoc({ organizationId: orgId, title: "Webinar run of show", listId: list.id, blocks: [{ id: "a", type: "h1", text: "Run of show" }, { id: "b", type: "p", text: "Open with the **three mistakes**." }] });
    // On a project everyone sees: open to the team.
    expect((await her.pj.doc({ organizationId: orgId, id: d.id })).level).toBe("edit");
    // Private: the owner and admins only, until shared.
    await me.pj.setDocVisibility({ organizationId: orgId, id: d.id, private: true });
    await expect(her.pj.doc({ organizationId: orgId, id: d.id })).rejects.toThrow(/isn't in this workspace/);
    await me.pj.shareDoc({ organizationId: orgId, id: d.id, kind: "user", personId: angela.id, level: "comment" });
    expect((await her.pj.doc({ organizationId: orgId, id: d.id })).level).toBe("comment");
    await expect(her.pj.saveDoc({ organizationId: orgId, id: d.id, title: "Renamed" })).rejects.toThrow(/not change/);
    // The hub shows it under Shared with me for her, Private for me, with a lock.
    const hers = await her.pj.allDocs({ organizationId: orgId });
    expect(hers.docs.find((x) => x.id === d.id)).toMatchObject({ shared: true, private: true });
    expect(hers.counts.shared).toBe(1);
    const mine = await me.pj.allDocs({ organizationId: orgId });
    expect(mine.docs.find((x) => x.id === d.id)).toMatchObject({ mine: true, private: true });
    expect(mine.counts.private).toBe(1);
    // An outside person by email: a guest who sees only this doc.
    await me.pj.shareDoc({ organizationId: orgId, id: d.id, email: "lamar@tylernewmedia.test", level: "view" });
    const lamar = (await db.getUserByEmail("lamar@tylernewmedia.test"))!;
    const guest = caller(lamar);
    expect((await guest.pj.doc({ organizationId: orgId, id: d.id })).level).toBe("view");
    expect((await guest.pj.tree({ organizationId: orgId })).sharedDocs.map((x) => x.name)).toEqual(["Webinar run of show"]);
    await expect(guest.pj.docShares({ organizationId: orgId, id: d.id })).resolves.toBeTruthy();
    await expect(guest.pj.setDocLink({ organizationId: orgId, id: d.id, on: true })).rejects.toThrow();
    const shares = await me.pj.docShares({ organizationId: orgId, id: d.id });
    expect(shares.people.map((p) => [p.name, p.level])).toEqual(expect.arrayContaining([["Angela", "comment"], ["lamar@tylernewmedia.test", "view"]]));
    expect(shares.teamLink).toContain(`page=doc&id=${d.id}`);
    // Workspace wide turns private off; a star is mine alone; a public link opens with no sign-in.
    await me.pj.setDocVisibility({ organizationId: orgId, id: d.id, workspaceWide: true });
    expect((await me.pj.docShares({ organizationId: orgId, id: d.id }))).toMatchObject({ private: false, workspaceWide: true });
    await me.pj.star({ organizationId: orgId, kind: "doc", id: d.id, on: true });
    expect((await me.pj.allDocs({ organizationId: orgId })).docs.find((x) => x.id === d.id)?.starred).toBe(true);
    expect((await her.pj.allDocs({ organizationId: orgId })).docs.find((x) => x.id === d.id)?.starred).toBe(false);
    const { link } = await me.pj.setDocLink({ organizationId: orgId, id: d.id, on: true });
    expect(link).toMatch(/\/d\/[a-z0-9]+$/);
    const tok = link!.split("/d/")[1];
    expect(db.docByShareToken(tok)?.id).toBe(d.id);
    await me.pj.setDocLink({ organizationId: orgId, id: d.id, on: false });
    expect(db.docByShareToken(tok)).toBeNull();
    // Archived docs leave the counts and show under Archived.
    await me.pj.archiveDoc({ organizationId: orgId, id: d.id, on: true });
    const after = await me.pj.allDocs({ organizationId: orgId });
    expect(after.counts.all).toBe(0);
    expect(after.counts.archived).toBe(1);
  });

  it("archives a project (read only, out of the tree and Home) and restores it; a folder takes its lists with it", async () => {
    const { orgId, me, her, list, other, folder } = await setup("pj-archive");
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Record intro", dueDate: plus(-2) });
    await me.pj.archiveList({ organizationId: orgId, id: list.id, on: true });
    expect((await me.pj.tree({ organizationId: orgId })).folders[0].lists).toEqual([]);
    expect((await me.pj.tree({ organizationId: orgId })).archived).toBe(1);
    expect((await me.pj.archived({ organizationId: orgId })).lists.map((l) => [l.name, l.archivedBy])).toEqual([["Grow Without Hiring", "Owner pj-archive"]]);
    expect((await me.pj.home({ organizationId: orgId })).attention).toEqual([]);
    expect((await me.pj.view({ organizationId: orgId, listId: null, scope: "everything" })).tasks).toEqual([]);
    const v = await me.pj.view({ organizationId: orgId, listId: list.id, folderId: null, scope: "list" });
    expect(v.list).toMatchObject({ level: "view", archivedBy: "Owner pj-archive" });
    expect(v.tasks.map((t) => t.name)).toEqual(["Record intro"]);
    await expect(me.pj.create({ organizationId: orgId, listId: list.id, name: "New one" })).rejects.toThrow(/can't change/);
    await expect(her.pj.archiveList({ organizationId: orgId, id: other.id, on: true })).rejects.toThrow(/full access/);
    await me.pj.archiveList({ organizationId: orgId, id: list.id, on: false });
    expect((await me.pj.tree({ organizationId: orgId })).folders[0].lists.map((l) => l.name)).toEqual(["Grow Without Hiring"]);
    // A folder: everything in it.
    await me.pj.archiveFolder({ organizationId: orgId, id: folder.id, on: true });
    const a = await me.pj.archived({ organizationId: orgId });
    expect(a.folders.map((f) => [f.name, f.lists.map((l) => l.name)])).toEqual([["Webinars", ["Grow Without Hiring"]]]);
    expect((await me.pj.tree({ organizationId: orgId })).folders).toEqual([]);
    await me.pj.archiveFolder({ organizationId: orgId, id: folder.id, on: false });
    expect((await me.pj.tree({ organizationId: orgId })).folders[0].lists.map((l) => l.name)).toEqual(["Grow Without Hiring"]);
  });

  it("keeps portfolios of projects and portfolios, with status updates, progress, owner and dates per row", async () => {
    const { orgId, me, her, owner, list, other } = await setup("pj-port");
    const ab = { type: "user" as const, id: owner.id, name: "Owner pj-port" };
    const intro = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Record intro", startDate: plus(-9), dueDate: plus(0), assignees: [ab] });
    await me.pj.update({ organizationId: orgId, id: intro.id, patch: { priority: "high" } });
    const done = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Write script", dueDate: plus(-3), assignees: [ab] });
    await me.pj.update({ organizationId: orgId, id: done.id, patch: { status: "complete" } });
    await me.pj.create({ organizationId: orgId, listId: other.id, name: "Order banner", dueDate: plus(-4) });
    const p = await me.pj.savePortfolio({ organizationId: orgId, name: "Q4 launches", owner: ab });
    await me.pj.addWork({ organizationId: orgId, portfolioId: p.id, kind: "list", itemId: list.id });
    await me.pj.addWork({ organizationId: orgId, portfolioId: p.id, kind: "list", itemId: other.id });
    const ops = await me.pj.savePortfolio({ organizationId: orgId, name: "Legacy practice ops" });
    await me.pj.addWork({ organizationId: orgId, portfolioId: p.id, kind: "portfolio", itemId: ops.id });
    await expect(me.pj.addWork({ organizationId: orgId, portfolioId: ops.id, kind: "portfolio", itemId: p.id })).rejects.toThrow(/can't hold itself/);
    // A status update on a project shows on its row; the portfolio has its own.
    await me.pj.postStatus({ organizationId: orgId, kind: "list", itemId: list.id, status: "on", summary: "Script is recorded." });
    const pf = await me.pj.portfolio({ organizationId: orgId, id: p.id });
    expect(pf.rows.map((r) => [r.kind, r.name, r.status?.status ?? null, r.progress.pct, r.owner?.name ?? null, r.priority, r.end])).toEqual([
      ["list", "Grow Without Hiring", "on", 50, "Owner pj-port", "high", plus(0)],
      ["list", "NABC Dallas", null, 0, null, null, plus(-4)],
      ["portfolio", "Legacy practice ops", null, 0, null, null, null],
    ]);
    expect(pf.rows[0].start).toBe(plus(-9));
    expect(pf.tiles).toMatchObject({ total: 3, done: 1, open: 2, overdue: 1, pct: 33 });
    expect(pf.canAdd.portfolios).toEqual([]);
    expect(pf.status).toBeNull();
    await me.pj.postStatus({ organizationId: orgId, kind: "portfolio", itemId: p.id, status: "risk", summary: "Booth is behind.", blockers: "Electricity unbooked.", highlights: [{ itemId: list.id, name: "Grow Without Hiring", status: "on" }] });
    const again = await me.pj.portfolio({ organizationId: orgId, id: p.id });
    expect(again.status).toMatchObject({ status: "risk", by: "Owner pj-port" });
    expect(again.updates[0]).toMatchObject({ blockers: "Electricity unbooked.", highlights: [{ itemId: list.id, name: "Grow Without Hiring", status: "on" }] });
    expect((await me.pj.portfolios({ organizationId: orgId })).map((x) => [x.name, x.projects, x.portfolios, x.on, x.none, x.status?.status ?? null])).toEqual([
      ["Q4 launches", 2, 1, 1, 2, "risk"],
      ["Legacy practice ops", 0, 0, 0, 0, null],
    ]);
    // The project's own header carries its status; the portfolio scope of view gives every task in it.
    expect((await me.pj.view({ organizationId: orgId, listId: list.id, folderId: null, scope: "list" })).list?.status?.status).toBe("on");
    expect((await me.pj.view({ organizationId: orgId, listId: null, portfolioId: p.id, scope: "portfolio" })).tasks.map((t) => t.name).sort()).toEqual(["Order banner", "Record intro", "Write script"]);
    // Nora drafts an update from the tasks.
    const draft = await me.pj.draftStatus({ organizationId: orgId, kind: "portfolio", itemId: p.id });
    expect(draft).toMatchObject({ status: "risk", summary: "Booth work is behind.", highlights: [{ name: "Grow Without Hiring", status: "on" }, { name: "NABC Dallas", status: "off" }] });
    // A member sees only the projects they can see inside it; a reviewer can't change it.
    await me.pj.setPrivate({ organizationId: orgId, listId: other.id, on: true });
    expect((await her.pj.portfolio({ organizationId: orgId, id: p.id })).rows.map((r) => r.name)).toEqual(["Grow Without Hiring", "Legacy practice ops"]);
    const { reviewer } = await makeWorkspace("pj-port-r");
    await db.addOrganizationMember({ organizationId: orgId, userId: reviewer.id, role: "reviewer" });
    await expect(caller(reviewer).pj.savePortfolio({ organizationId: orgId, name: "Nope" })).rejects.toThrow(/Reviewers/);
    // Remove work, archive the portfolio.
    await me.pj.removeWork({ organizationId: orgId, portfolioId: p.id, rowId: pf.rows[1].itemId });
    expect((await me.pj.portfolio({ organizationId: orgId, id: p.id })).rows).toHaveLength(2);
    await me.pj.archivePortfolio({ organizationId: orgId, id: ops.id, on: true });
    expect((await me.pj.portfolios({ organizationId: orgId })).map((x) => x.name)).toEqual(["Q4 launches"]);
  });
});
