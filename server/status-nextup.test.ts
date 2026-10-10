import { describe, expect, it } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { rememberNames } from "./ehr";
import { nextUp, shortTitle } from "./employees/calendarPage";

describe("statuses edited from the group header", () => {
  it("renames with its tasks, recolors, adds after, removes with tasks moved, and keeps one done status", async () => {
    const ws = await makeWorkspace("status-edit");
    const me = caller(ws.owner);
    const orgId = ws.orgId;
    const list = await me.pj.saveList({ organizationId: orgId, name: "Webinar", folderId: null });
    const a = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Landing page" });
    const b = await me.pj.create({ organizationId: orgId, listId: list.id, name: "Email 2" });
    const names = () => JSON.parse(db.work.lists.get(orgId, list.id)!.statuses).map((s: { name: string }) => s.name);
    const first = names()[0];
    await me.pj.update({ organizationId: orgId, id: b.id, patch: { status: names()[1] } });

    // Rename: the tasks in it follow.
    await me.pj.editStatus({ organizationId: orgId, listId: list.id, name: first, rename: { name: "Backlog", color: "#1090e0", type: "open" } });
    expect(names()[0]).toBe("backlog");
    expect(db.work.tasks.get(orgId, a.id)!.status).toBe("backlog");
    expect(JSON.parse(db.work.lists.get(orgId, list.id)!.statuses)[0]).toMatchObject({ name: "backlog", color: "#1090e0", type: "open" });
    // A name already on the list is refused.
    await expect(me.pj.editStatus({ organizationId: orgId, listId: list.id, name: "backlog", rename: { name: names()[1], color: "#1090e0", type: "open" } })).rejects.toThrow(/already a status/);
    // Add after.
    await me.pj.editStatus({ organizationId: orgId, listId: list.id, name: "backlog", addAfter: { name: "Review", color: "#f76808", type: "active" } });
    expect(names()[1]).toBe("review");
    // Remove with its tasks moved.
    const second = names()[2];
    await me.pj.editStatus({ organizationId: orgId, listId: list.id, name: second, remove: { moveTo: "review" } });
    expect(names()).not.toContain(second);
    expect(db.work.tasks.get(orgId, b.id)!.status).toBe("review");
    // The last done status cannot go.
    const done = JSON.parse(db.work.lists.get(orgId, list.id)!.statuses).filter((s: { type: string }) => s.type === "done" || s.type === "closed");
    for (const d of done.slice(0, -1)) await me.pj.editStatus({ organizationId: orgId, listId: list.id, name: d.name, remove: { moveTo: "review" } });
    await expect(me.pj.editStatus({ organizationId: orgId, listId: list.id, name: done[done.length - 1].name, remove: { moveTo: "review" } })).rejects.toThrow(/means done/);
    await expect(me.pj.editStatus({ organizationId: orgId, listId: list.id, name: "nope", rename: { name: "x", color: "#000000", type: "open" } })).rejects.toThrow(/isn't on this list/);
  });
});

describe("the Next up bar", () => {
  it("shortens client names to initials and shows the next timed event, link or not", async () => {
    const { orgId } = await makeWorkspace("next-up");
    rememberNames(orgId, ["Jane Doe"]);
    expect(shortTitle(orgId, "Individual Therapy with Jane Doe")).toBe("Individual Therapy with J. Doe");
    expect(shortTitle(orgId, "Couples session with Mark Anthony Smith")).toBe("Couples session, M. Smith");
    expect(shortTitle(orgId, "Team huddle")).toBe("Team huddle");
    // No calendar connected: nothing to show.
    expect((await nextUp(orgId)).connected).toBe(false);
    // A meeting Simone set with no link still counts.
    const start = new Date(Math.floor((Date.now() + 30 * 60_000) / 1000) * 1000);
    await db.createMeeting({ organizationId: orgId, title: "Supervision with Jane Doe", startsAt: start, minutes: 50 });
    const r = await nextUp(orgId);
    expect(r.connected).toBe(true);
    expect(r.item).toMatchObject({ title: "Supervision with J. Doe" });
    expect(new Date(r.item!.start).getTime()).toBe(start.getTime());
  });
});
