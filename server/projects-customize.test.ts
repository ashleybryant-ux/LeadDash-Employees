import { describe, expect, it } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import JSZip from "jszip";

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  const me = caller(ws.owner);
  const angela = await makeUser(`angela@${slug}.test`, "user", "Angela");
  await db.addOrganizationMember({ organizationId: ws.orgId, userId: angela.id, role: "member" });
  const folder = await me.pj.saveFolder({ organizationId: ws.orgId, name: "Webinars", color: "#7c3aed" });
  const list = await me.pj.saveList({ organizationId: ws.orgId, name: "Grow Without Hiring", folderId: folder.id });
  return { ...ws, me, angela, her: caller(angela), folder, list };
}

describe("Customize view, the Dashboards hub and the sidebar", () => {
  it("keeps the new view settings: group by tags or a field with a direction, subtasks, and the view options", async () => {
    const { orgId, me, list } = await setup("pj-cv");
    const f = await me.pj.addField({ organizationId: orgId, listId: list.id, scope: "list", name: "Channel", type: "dropdown", options: ["Email", "Ads"] });
    await me.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "list", settings: { group: `f:${f.id}`, dir: "desc", sort: "due", sortDir: "desc", subtasks: "expanded", showEmpty: true, wrap: true, locations: true, parentNames: true, estimates: true, closed: true } });
    const v = await me.pj.views({ organizationId: orgId, listId: list.id });
    expect(v.builtin.list).toEqual({ group: `f:${f.id}`, dir: "desc", sort: "due", sortDir: "desc", subtasks: "expanded", showEmpty: true, wrap: true, locations: true, parentNames: true, estimates: true, closed: true });
    // A field that isn't on the list, or a made-up group, is dropped; ascending is the default and isn't kept.
    await me.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "board", settings: { group: "f:nope", dir: "asc", subtasks: "collapsed" } });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).builtin.board).toEqual({});
    await me.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "board", settings: { group: "tags" } });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).builtin.board).toEqual({ group: "tags" });
  });

  it("protects a view, sets a default, autosaves for me, and favorites it for the sidebar", async () => {
    const { orgId, me, her, list } = await setup("pj-flags");
    // Protect: only an owner or admin can turn it on, and after that a member can't change the tab's settings.
    await expect(her.pj.setViewFlags({ organizationId: orgId, listId: list.id, kind: "list", protected: true })).rejects.toThrow(/owner or admin/);
    await me.pj.setViewFlags({ organizationId: orgId, listId: list.id, kind: "list", protected: true });
    await expect(her.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "list", settings: { group: "priority" } })).rejects.toThrow(/protected/);
    await me.pj.setBuiltinView({ organizationId: orgId, listId: list.id, kind: "list", settings: { group: "priority" } });
    let v = await her.pj.views({ organizationId: orgId, listId: list.id });
    expect(v.flags.list).toMatchObject({ protected: true, isDefault: false });
    expect(v.canProtect).toBe(false);
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).canProtect).toBe(true);
    // Default view: the Board tab opens first; setting another clears it.
    await me.pj.setViewFlags({ organizationId: orgId, listId: list.id, kind: "board", isDefault: true });
    expect((await her.pj.views({ organizationId: orgId, listId: list.id })).defaultView).toEqual({ kind: "board", savedId: null });
    const saved = await me.pj.saveView({ organizationId: orgId, listId: list.id, name: "Angela's week", kind: "list", settings: { who: "me" } });
    await me.pj.setViewFlags({ organizationId: orgId, listId: list.id, kind: "list", savedId: saved.id, isDefault: true, pinned: true });
    v = await me.pj.views({ organizationId: orgId, listId: list.id });
    expect(v.defaultView).toEqual({ kind: "list", savedId: saved.id });
    expect(v.flags.board.isDefault).toBe(false);
    expect(v.saved[0]).toMatchObject({ name: "Angela's week", pinned: true, isDefault: true });
    // A built-in tab can't be pinned or private.
    await expect(me.pj.setViewFlags({ organizationId: orgId, listId: list.id, kind: "list", pinned: true })).rejects.toThrow(/save it as a view/);
    // Autosave for me is per person.
    await her.pj.setAutosave({ organizationId: orgId, listId: list.id, kind: "list", on: true });
    expect((await her.pj.views({ organizationId: orgId, listId: list.id })).autosave).toEqual({ [`autosave:${list.id}:0:list:0`]: true });
    expect((await me.pj.views({ organizationId: orgId, listId: list.id })).autosave).toEqual({});
    // Favorite: the view shows under Favorites in the sidebar, with the list it belongs to.
    await her.pj.starView({ organizationId: orgId, listId: list.id, kind: "board", on: true });
    await her.pj.starView({ organizationId: orgId, listId: list.id, kind: "list", savedId: saved.id, on: true });
    const favs = await her.pj.favorites({ organizationId: orgId });
    expect(favs.map((f) => [f.kind, f.name, f.note, f.viewKind, f.savedId])).toEqual([["view", "Board", "Grow Without Hiring", "board", null], ["view", "Angela's week", "Grow Without Hiring", "list", saved.id]]);
    expect((await her.pj.views({ organizationId: orgId, listId: list.id })).starred).toHaveLength(2);
    await her.pj.starView({ organizationId: orgId, listId: list.id, kind: "board", on: false });
    expect((await her.pj.favorites({ organizationId: orgId })).map((f) => f.name)).toEqual(["Angela's week"]);
  });

  it("exports the rows on screen as CSV or an Excel file", async () => {
    const { orgId, me } = await setup("pj-export");
    const csv = await me.pj.exportView({ organizationId: orgId, name: "Grow Without Hiring", format: "csv", headers: ["Task", "Due date"], rows: [["Slides, final", "2026-10-18"], ['Say "hi"', ""]] });
    expect(csv.ext).toBe("csv");
    expect(Buffer.from(csv.base64, "base64").toString("utf8")).toBe('﻿Task,Due date\r\n"Slides, final",2026-10-18\r\n"Say ""hi""",');
    const xl = await me.pj.exportView({ organizationId: orgId, name: "Grow Without Hiring", format: "xlsx", headers: ["Task", "Due date"], rows: [["Slides & more", "2026-10-18"]] });
    expect(xl.ext).toBe("xlsx");
    const zip = await JSZip.loadAsync(Buffer.from(xl.base64, "base64"));
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("Slides &amp; more");
    expect(sheet).toContain('<c r="B2" t="inlineStr">');
    expect(await zip.file("xl/workbook.xml")!.async("string")).toContain('name="Grow Without Hiring"');
  });

  it("runs the Dashboards hub: owner, templates, private with sharing, last viewed, stars, duplicate", async () => {
    const { orgId, me, her, angela, list } = await setup("pj-hub");
    await me.pj.create({ organizationId: orgId, listId: list.id, name: "Late one", dueDate: "2020-01-01" });
    const d = await me.pj.saveDashboard({ organizationId: orgId, name: "Launch", template: "project", location: { kind: "list", id: list.id } });
    let hub = await her.pj.dashboards({ organizationId: orgId });
    expect(hub.dashboards.map((x) => [x.name, x.owner?.name, x.location.name, x.mine, x.canEdit, x.lastViewed])).toEqual([["Launch", expect.any(String), "Grow Without Hiring", false, false, null]]);
    expect(hub.counts).toEqual({ all: 1, mine: 0, shared: 0, private: 0 });
    expect(JSON.parse(d.cards)).toHaveLength(8);
    // The project template's cards look at the list it was made for.
    expect((await me.pj.dashboardData({ organizationId: orgId, id: d.id })).cards.find((c) => c.title === "Overdue")).toMatchObject({ number: 1, scopeName: "Grow Without Hiring" });
    // Opening it is remembered as Last viewed.
    await her.pj.dashboardData({ organizationId: orgId, id: d.id });
    expect((await her.pj.dashboards({ organizationId: orgId })).dashboards[0].lastViewed).not.toBeNull();
    // Only the owner or an admin changes it.
    await expect(her.pj.saveDashboard({ organizationId: orgId, id: d.id, name: "Mine now" })).rejects.toThrow(/made this dashboard/);
    // Private: she loses it until it is shared with her, then it sits under Shared with me.
    await me.pj.setDashboardSharing({ organizationId: orgId, id: d.id, private: true });
    expect((await her.pj.dashboards({ organizationId: orgId })).dashboards).toEqual([]);
    await expect(her.pj.dashboardData({ organizationId: orgId, id: d.id })).rejects.toThrow(/isn't here/);
    await me.pj.setDashboardSharing({ organizationId: orgId, id: d.id, add: [angela.id] });
    hub = await her.pj.dashboards({ organizationId: orgId });
    expect(hub.dashboards[0]).toMatchObject({ private: true, sharedWithMe: true, shared: [{ id: angela.id }] });
    expect(hub.counts).toEqual({ all: 1, mine: 0, shared: 1, private: 1 });
    expect((await me.pj.dashboards({ organizationId: orgId })).counts).toEqual({ all: 1, mine: 1, shared: 0, private: 1 });
    // Stars reach the sidebar; a duplicate is hers.
    await her.pj.starDashboard({ organizationId: orgId, id: d.id, on: true });
    expect((await her.pj.favorites({ organizationId: orgId })).map((f) => [f.kind, f.name])).toEqual([["dash", "Launch"]]);
    const copy = await her.pj.duplicateDashboard({ organizationId: orgId, id: d.id });
    expect(copy.name).toBe("Launch (copy)");
    expect((await her.pj.dashboards({ organizationId: orgId })).dashboards.find((x) => x.id === copy.id)).toMatchObject({ mine: true, canEdit: true });
    // Templates: the AI team center and the simple one.
    expect(JSON.parse((await me.pj.saveDashboard({ organizationId: orgId, name: "AI team", template: "ai" })).cards).map((c: { type: string }) => c.type)).toEqual(["count", "person", "time", "workload", "overdue", "tasks", "trend"]);
    expect(JSON.parse((await me.pj.saveDashboard({ organizationId: orgId, name: "Week" })).cards)).toHaveLength(7);
    await me.pj.removeDashboard({ organizationId: orgId, id: d.id });
    expect((await her.pj.favorites({ organizationId: orgId })).filter((f) => f.kind === "dash")).toEqual([]);
  });

  it("lets each person pick the sidebar items that show; the rest sit under More", async () => {
    const { orgId, me, her } = await setup("pj-nav");
    expect(await her.pj.nav({ organizationId: orgId })).toEqual({ shown: ["home", "mine", "everything", "docs", "portfolios", "dash"], more: ["time", "templates", "boards", "forms", "goals", "import"] });
    const out = await her.pj.setNav({ organizationId: orgId, shown: ["mine", "home", "time", "bogus", "mine"] });
    expect(out).toEqual({ shown: ["mine", "home", "time"], more: ["everything", "docs", "portfolios", "dash", "templates", "boards", "forms", "goals", "import"] });
    expect((await her.pj.nav({ organizationId: orgId })).shown).toEqual(["mine", "home", "time"]);
    expect((await me.pj.nav({ organizationId: orgId })).shown).toEqual(["home", "mine", "everything", "docs", "portfolios", "dash"]);
  });
});
