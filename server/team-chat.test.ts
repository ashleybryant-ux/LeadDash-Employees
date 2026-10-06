import { describe, expect, it } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { pingsFor, readSound } from "./notify";

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  const caroline = await makeUser(`caroline@${slug}.test`, "user", "Caroline Jones");
  await db.addOrganizationMember({ organizationId: ws.orgId, userId: caroline.id, role: "admin" });
  return { ...ws, caroline };
}

describe("Team chat", () => {
  it("has a general channel and a direct message with each person, with unread counts and Seen", async () => {
    const { orgId, owner, caroline } = await setup("tc-basic");
    const me = caller(owner);
    const her = caller(caroline);
    const list = await me.teamChat.channels({ organizationId: orgId });
    expect(list.channels.map((c) => c.name)).toEqual(["general"]);
    expect(list.dms.map((c) => c.name)).toEqual(["Caroline Jones"]); // the reviewer isn't in team chat

    const before = pingsFor(caroline.id, 0).latest;
    await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Can you look at Sienna's posts before 3?" });
    let hers = await her.teamChat.channels({ organizationId: orgId });
    expect(hers.channels[0]).toMatchObject({ key: "everyone", unread: 1, last: { author: owner.name, text: "Can you look at Sienna's posts before 3?" } });
    expect(hers.counts.unread).toBe(1);
    // She gets the pop-up (and the sound, by her settings); the sender doesn't.
    expect(pingsFor(caroline.id, before).pings.map((p) => [p.event, p.title, p.url])).toEqual([["team_message", `${owner.name} in #general`, "/chats/team/everyone"]]);
    expect(pingsFor(owner.id, before).pings).toHaveLength(0);

    const msgs = await her.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    await her.teamChat.markRead({ organizationId: orgId, channel: "everyone", lastId: msgs.messages.at(-1)!.id });
    hers = await her.teamChat.channels({ organizationId: orgId });
    expect(hers.channels[0].unread).toBe(0);

    // A direct message, then Seen once she reads it.
    const dm = hers.dms[0];
    expect(dm.name).toBe(owner.name);
    await her.teamChat.send({ organizationId: orgId, channel: dm.key, content: "I'll send the promo copy by 4." });
    let mine = await me.teamChat.messages({ organizationId: orgId, channel: dm.key });
    expect(mine.title).toBe("Caroline Jones");
    expect(mine.seenAt).toBeNull();
    await me.teamChat.markRead({ organizationId: orgId, channel: dm.key, lastId: mine.messages.at(-1)!.id });
    const herView = await her.teamChat.messages({ organizationId: orgId, channel: dm.key });
    expect(herView.seenAt).not.toBeNull();
    // She's online: she just checked in.
    mine = await me.teamChat.messages({ organizationId: orgId, channel: dm.key });
    expect(mine.online).toBe(true);
  });

  it("keeps direct messages between the two people and each workspace to itself", async () => {
    const { orgId, owner, caroline } = await setup("tc-private");
    const angela = await makeUser("angela@tc-private.test", "user", "Angela St. Ville");
    await db.addOrganizationMember({ organizationId: orgId, userId: angela.id, role: "member" });
    const key = `dm:${Math.min(owner.id, caroline.id)}-${Math.max(owner.id, caroline.id)}`;
    await caller(owner).teamChat.send({ organizationId: orgId, channel: key, content: "Just between us." });
    await expect(caller(angela).teamChat.messages({ organizationId: orgId, channel: key })).rejects.toThrow(/isn't in this workspace/);
    await expect(caller(angela).teamChat.send({ organizationId: orgId, channel: key, content: "hi" })).rejects.toThrow(/isn't in this workspace/);
    const other = await makeWorkspace("tc-other");
    await expect(caller(other.owner).teamChat.messages({ organizationId: orgId, channel: "everyone" })).rejects.toThrow();
    // Files are shared from the person's own uploads only.
    const f = db.createChatFile({ organizationId: orgId, employeeId: 0, userId: owner.id, name: "notes.pdf", mime: "application/pdf", size: 10, kind: "document", fileUrl: "/files/notes.pdf", text: "" });
    await caller(owner).teamChat.send({ organizationId: orgId, channel: "everyone", content: "", attachmentIds: [f.id] });
    const m = await caller(caroline).teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(JSON.parse(m.messages.at(-1)!.attachments!)[0]).toMatchObject({ name: "notes.pdf", url: "/files/notes.pdf" });
    await expect(caller(caroline).teamChat.send({ organizationId: orgId, channel: "everyone", content: "", attachmentIds: [f.id] })).rejects.toThrow(/Write a message/);
  });

  it("saves a sound per notice, which sound, and how loud", async () => {
    const { owner } = await setup("tc-sound");
    const me = caller(owner);
    let a = await me.account.get();
    expect(a.events[0]).toEqual({ key: "team_message", label: "A teammate messages me" });
    expect(a.prefs.team_message).toEqual({ push: true, email: false, sound: true });
    expect(a.sound).toEqual({ kind: "chime", volume: 70 });
    await me.account.savePrefs({ team_message: { push: true, email: false, sound: false }, report: { push: false, email: true }, sound: { kind: "bell", volume: 40 } });
    a = await me.account.get();
    expect(a.prefs.team_message.sound).toBe(false);
    expect(a.prefs.report).toEqual({ push: false, email: true, sound: false });
    expect(a.sound).toEqual({ kind: "bell", volume: 40 });
    expect(readSound('{"_sound":{"kind":"siren","volume":900}}')).toEqual({ kind: "chime", volume: 100 });
  });
  it("shows a direct message in every workspace both people share, and keeps general to its own workspace", async () => {
    const { orgId: a, owner, caroline } = await setup("tc-two-a");
    const staff = (await db.getUserByEmail("staff@leaddash.io"))!;
    const b = (await caller(staff).organizations.create({ name: "Second workspace", slug: "tc-two-b", plan: "growth", state: "Oklahoma", ownerEmail: owner.email })).id!;
    await db.addOrganizationMember({ organizationId: b, userId: caroline.id, role: "member" });
    const me = caller(owner);
    const her = caller(caroline);
    const key = (await me.teamChat.channels({ organizationId: b })).dms[0].key;
    await me.teamChat.send({ organizationId: b, channel: key, content: "Did you see the webinar slides?" });
    await me.teamChat.send({ organizationId: b, channel: "everyone", content: "Only in the second workspace" });
    // Caroline is looking at the first workspace: the DM is there, unread.
    const hers = await her.teamChat.channels({ organizationId: a });
    expect(hers.dms.find((c) => c.key === key)).toMatchObject({ unread: 1, last: { text: "Did you see the webinar slides?" } });
    expect(hers.channels.find((c) => c.key === "everyone")).toMatchObject({ unread: 0, last: null });
    const msgs = await her.teamChat.messages({ organizationId: a, channel: key });
    expect(msgs.messages.map((m) => m.content)).toEqual(["Did you see the webinar slides?"]);
    await her.teamChat.markRead({ organizationId: a, channel: key, lastId: msgs.messages[0].id });
    expect((await her.teamChat.channels({ organizationId: b })).dms.find((c) => c.key === key)!.unread).toBe(0);
    expect((await me.teamChat.messages({ organizationId: b, channel: key })).seenAt).not.toBeNull();
    // Her reply from the first workspace reaches the owner in the second.
    await her.teamChat.send({ organizationId: a, channel: key, content: "Yes, they look good." });
    expect((await me.teamChat.messages({ organizationId: b, channel: key })).messages.map((m) => m.content)).toEqual(["Did you see the webinar slides?", "Yes, they look good."]);
  });
});
