import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import fs from "node:fs";

let decision: any = { reply: "Thursday's training is on the Compliance and QA list, due Oct 8, 2026. Want me to add the PDF to it?", action: "none", choices: [] };
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return { ...actual, generateJson: vi.fn(async (opts: any) => (opts.schemaName === "chat_decision" ? decision : {})), generateText: vi.fn(async () => "") };
});

import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { pingsFor } from "./notify";
import { settled } from "./team";
import { hold, _test } from "./teamImport";
import { urlsIn, _test as linkTest } from "./teamLinks";

// The sites links point at, as the preview reader sees them. Anything else is unreachable.
const SITES: Record<string, { type: string; body: string; status?: number }> = {
  "https://www.loom.com/v1/oembed?url=https%3A%2F%2Fwww.loom.com%2Fshare%2Ff03c9f35fd9641a8a5b05f8c2351c68d": { type: "application/json", body: JSON.stringify({ title: "Role play: handling phone calls", duration: 372.4, thumbnail_url: "https://cdn.loom.com/sessions/thumbnails/f03c.jpg", html: "<iframe></iframe>" }) },
  "https://www.youtube.com/oembed?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&format=json": { type: "application/json", body: JSON.stringify({ title: "Front desk training", thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }) },
  "https://docs.google.com/spreadsheets/d/1a2b/edit": { type: "text/html", body: "<html><head><title>Accepted insurance list - Google Sheets</title></head></html>" },
  "https://docs.google.com/document/d/private/edit": { type: "text/html", body: "<html><head><title>Google Docs: Sign-in</title></head></html>" },
  "https://leaddash.io/": { type: "text/html; charset=utf-8", body: '<html><head><meta content="LeadDash EHR: one platform for your EHR, billing, phone, fax, and marketing" property="og:title"><meta property="og:description" content="Most practices pay for five or six separate tools. LeadDash replaces them with one login &amp; one bill."><meta property="og:image" content="/img/home.png"><meta property="og:site_name" content="LeadDash"></head><body></body></html>' },
  "https://example.test/nothing": { type: "text/html", body: "<html><body>no title here</body></html>" },
  "https://example.test/file.pdf": { type: "application/pdf", body: "%PDF" },
};
const fetchMock = vi.fn(async (input: string | URL) => {
  const url = String(input);
  const hit = SITES[url];
  if (!hit) return new Response("", { status: 404 });
  return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type } });
});
vi.stubGlobal("fetch", fetchMock);

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  const caroline = await makeUser(`caroline@${slug}.test`, "user", "Caroline Jones");
  const angela = await makeUser(`angela@${slug}.test`, "user", "Angela St. Ville");
  await db.addOrganizationMember({ organizationId: ws.orgId, userId: caroline.id, role: "admin" });
  await db.addOrganizationMember({ organizationId: ws.orgId, userId: angela.id, role: "member" });
  return { ...ws, caroline, angela };
}

describe("Team chat channels", () => {
  it("makes public and private channels; private ones are seen by members only; general stays", async () => {
    const { orgId, owner, caroline, angela } = await setup("tch-make");
    const me = caller(owner);
    const made = await me.teamChat.createChannel({ organizationId: orgId, name: "Training Videos", purpose: "Looms and how-tos", private: false });
    expect(made).toMatchObject({ name: "training-videos", key: `ch:${made.id}` });
    const priv = await me.teamChat.createChannel({ organizationId: orgId, name: "therapists-only", purpose: "", private: true, memberIds: [caroline.id], aiAllowed: false });
    await expect(me.teamChat.createChannel({ organizationId: orgId, name: "training videos", purpose: "", private: false })).rejects.toThrow(/already a #training-videos/);
    await expect(me.teamChat.createChannel({ organizationId: orgId, name: "!!!", purpose: "", private: false })).rejects.toThrow(/Give the channel a name/);

    expect((await me.teamChat.channels({ organizationId: orgId })).channels.map((c) => c.name)).toEqual(["general", "therapists-only", "training-videos"]);
    expect((await caller(caroline).teamChat.channels({ organizationId: orgId })).channels.map((c) => c.name)).toEqual(["general", "therapists-only", "training-videos"]);
    expect((await caller(angela).teamChat.channels({ organizationId: orgId })).channels.map((c) => c.name)).toEqual(["general", "training-videos"]);
    await expect(caller(angela).teamChat.messages({ organizationId: orgId, channel: priv.key })).rejects.toThrow(/isn't in this workspace/);
    await expect(caller(angela).teamChat.send({ organizationId: orgId, channel: priv.key, content: "hi" })).rejects.toThrow(/isn't in this workspace/);

    // The first message says who made it; the channel's details list its members.
    const m = await me.teamChat.messages({ organizationId: orgId, channel: made.key });
    expect(m).toMatchObject({ title: "training-videos", sub: "Looms and how-tos", private: false, aiAllowed: true, memberCount: 3 });
    expect(m.messages[0].content).toBe(`${owner.name} made this channel for: Looms and how-tos`);
    const d = await me.teamChat.details({ organizationId: orgId, channel: priv.key });
    expect(d.members.map((x) => x.name).sort()).toEqual(["Caroline Jones", owner.name].sort());
    expect(d.notIn.map((x) => x.name)).toEqual(["Angela St. Ville"]);
    expect(d.canEdit).toBe(true);

    // Adding Angela, then she leaves; general can't be left.
    await me.teamChat.addMembers({ organizationId: orgId, channelId: priv.id, userIds: [angela.id] });
    expect((await caller(angela).teamChat.channels({ organizationId: orgId })).channels.map((c) => c.name)).toContain("therapists-only");
    await caller(angela).teamChat.leaveChannel({ organizationId: orgId, channelId: priv.id });
    expect((await caller(angela).teamChat.channels({ organizationId: orgId })).channels.map((c) => c.name)).not.toContain("therapists-only");
    const general = (await me.teamChat.channels({ organizationId: orgId })).channels[0];
    await expect(me.teamChat.leaveChannel({ organizationId: orgId, channelId: general.id })).rejects.toThrow(/Everyone stays in general/);
    await expect(me.teamChat.archiveChannel({ organizationId: orgId, channelId: general.id })).rejects.toThrow(/general channel stays/);

    // Leaving a public one hides it and lists it under joinable; joining brings it back.
    await caller(angela).teamChat.leaveChannel({ organizationId: orgId, channelId: made.id });
    let hers = await caller(angela).teamChat.channels({ organizationId: orgId });
    expect(hers.channels.map((c) => c.name)).toEqual(["general"]);
    expect(hers.joinable.map((c) => c.name)).toEqual(["training-videos"]);
    await caller(angela).teamChat.joinChannel({ organizationId: orgId, channelId: made.id });
    hers = await caller(angela).teamChat.channels({ organizationId: orgId });
    expect(hers.channels.map((c) => c.name)).toEqual(["general", "training-videos"]);

    // Only the maker or an admin changes or archives it.
    await expect(caller(angela).teamChat.updateChannel({ organizationId: orgId, channelId: made.id, purpose: "x" })).rejects.toThrow(/Only the person who made/);
    await caller(caroline).teamChat.updateChannel({ organizationId: orgId, channelId: made.id, purpose: "Training Looms", aiAllowed: false });
    expect((await me.teamChat.messages({ organizationId: orgId, channel: made.key })).aiAllowed).toBe(false);
    await me.teamChat.archiveChannel({ organizationId: orgId, channelId: made.id });
    expect((await me.teamChat.channels({ organizationId: orgId })).channels.map((c) => c.name)).toEqual(["general", "therapists-only"]);
  });

  it("threads, reactions, pins, saved, edits and deletes", async () => {
    const { orgId, owner, caroline } = await setup("tch-thread");
    const me = caller(owner);
    const her = caller(caroline);
    const first = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "New appointment requests come through LeadDash EHR starting Wednesday." });
    const before = pingsFor(caroline.id, 0).latest;
    await her.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Do existing clients need anything?", threadOf: first.id });
    const reply = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "No, they carry over.", threadOf: first.id, alsoToChannel: true });
    // She hears about the thread reply; it links to the thread.
    expect(pingsFor(caroline.id, before).pings.map((p) => [p.title, p.url])).toEqual([[`${owner.name} in a thread in #general`, `/chats/team/everyone?thread=${first.id}`]]);

    const view = await her.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    // Replies stay in the thread; "also send to channel" adds one copy to the channel.
    expect(view.messages.map((m) => m.content)).toEqual(["New appointment requests come through LeadDash EHR starting Wednesday.", "No, they carry over."]);
    expect(view.messages[0].thread).toMatchObject({ count: 2, who: [{ name: "Caroline Jones" }, { name: owner.name }] });
    const t = await her.teamChat.thread({ organizationId: orgId, messageId: first.id });
    expect(t.channelName).toBe("general");
    expect(t.replies.map((r) => r.content)).toEqual(["Do existing clients need anything?", "No, they carry over."]);

    // Reactions toggle per person; pins and saved are flags.
    expect(await her.teamChat.react({ organizationId: orgId, messageId: first.id, emoji: "👍" })).toEqual({ on: true });
    await me.teamChat.react({ organizationId: orgId, messageId: first.id, emoji: "👍" });
    await me.teamChat.react({ organizationId: orgId, messageId: first.id, emoji: "🎉" });
    expect(await me.teamChat.react({ organizationId: orgId, messageId: first.id, emoji: "🎉" })).toEqual({ on: false });
    await me.teamChat.pin({ organizationId: orgId, messageId: first.id });
    await her.teamChat.save({ organizationId: orgId, messageId: reply.id });
    const mine = await me.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(mine.messages[0].reactions).toEqual([{ emoji: "👍", count: 2, me: true, names: ["Caroline Jones", owner.name] }]);
    expect(mine.messages[0].pinned).toBe(true);
    expect(mine.pinnedCount).toBe(1);
    expect(mine.messages[0].saved).toBe(false);
    const hers = await her.teamChat.view({ organizationId: orgId, kind: "saved" });
    expect(hers.kind === "saved" && hers.messages.map((m) => [m.content, m.channelName])).toEqual([["No, they carry over.", "general"]]);
    expect((await her.teamChat.channels({ organizationId: orgId })).counts.saved).toBe(1);

    // Edit your own; delete your own or, as an admin, anyone's.
    await expect(her.teamChat.edit({ organizationId: orgId, messageId: first.id, content: "x" })).rejects.toThrow(/only edit your own/);
    await me.teamChat.edit({ organizationId: orgId, messageId: first.id, content: "New appointment requests come through LeadDash EHR starting Thursday." });
    const edited = (await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages[0];
    expect(edited.content).toMatch(/Thursday/);
    expect(edited.editedAt).not.toBeNull();
    const copy = view.messages[1];
    await expect(her.teamChat.remove({ organizationId: orgId, messageId: reply.id })).resolves.toEqual({ ok: true }); // an admin can delete anyone's
    await me.teamChat.remove({ organizationId: orgId, messageId: copy.id });
    const gone = (await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages.find((m) => m.id === copy.id)!;
    expect(gone).toMatchObject({ deleted: true, content: "" });
    expect((await me.teamChat.thread({ organizationId: orgId, messageId: first.id })).replies.map((r) => r.deleted)).toEqual([false, true]);
    const d = await me.teamChat.details({ organizationId: orgId, channel: "everyone" });
    expect(d.pinned.map((p) => p.id)).toEqual([first.id]);
  });

  it("@mentions people and AI employees; an employee answers in a thread when the channel allows it", async () => {
    const { orgId, owner, caroline, angela } = await setup("tch-mention");
    const me = caller(owner);
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    // Angela only hears about mentions in general; Caroline muted it.
    const general = (await me.teamChat.channels({ organizationId: orgId })).channels[0];
    await caller(angela).teamChat.setNotify({ organizationId: orgId, channelId: general.id, notify: "mentions", muted: false });
    await caller(caroline).teamChat.setNotify({ organizationId: orgId, channelId: general.id, notify: "all", muted: true });
    const b1 = pingsFor(angela.id, 0).latest;
    const b2 = pingsFor(caroline.id, 0).latest;
    await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Fire inspection is at 1:00 today." });
    expect(pingsFor(angela.id, b1).pings).toHaveLength(0);
    expect(pingsFor(caroline.id, b2).pings).toHaveLength(0);
    const m = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "@Angela can you file the report? And @Nora what's due Thursday?" });
    expect(pingsFor(angela.id, b1).pings.map((p) => p.title)).toEqual([`${owner.name} in #general`]);
    const view = await caller(angela).teamChat.channels({ organizationId: orgId });
    expect(view.channels[0]).toMatchObject({ unread: 2, mentions: 1 });
    expect(view.counts.mentions).toBe(1);
    const mentioned = await caller(angela).teamChat.view({ organizationId: orgId, kind: "mentions" });
    expect(mentioned.kind === "mentions" && mentioned.messages.map((x) => x.id)).toEqual([m.id]);
    const msg = (await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages.find((x) => x.id === m.id)!;
    expect(msg.mentions).toEqual({ users: [angela.id], employees: [nora.id] });

    // Nora answered in the thread under the message.
    await settled();
    const t = await me.teamChat.thread({ organizationId: orgId, messageId: m.id });
    expect(t.replies.map((r) => [r.authorName, r.employeeId, r.content])).toEqual([["Nora", nora.id, decision.reply]]);
    expect(pingsFor(owner.id, b1).pings.map((p) => p.title)).toContain("Nora answered in #general");

    // Unreads shows what Angela hasn't read, by channel; reading clears it.
    const un = await caller(angela).teamChat.view({ organizationId: orgId, kind: "unreads" });
    expect(un.kind === "unreads" && un.groups.map((g) => [g.channelName, g.messages.length])).toEqual([["general", 2]]);
    await caller(angela).teamChat.markRead({ organizationId: orgId, channel: "everyone", lastId: m.id });
    const un2 = await caller(angela).teamChat.view({ organizationId: orgId, kind: "unreads" });
    expect(un2.kind === "unreads" && un2.groups).toEqual([]);

    // A channel that doesn't let AI employees in doesn't answer them, and the picker doesn't list them.
    const quiet = await me.teamChat.createChannel({ organizationId: orgId, name: "clinical", purpose: "", private: true, memberIds: [], aiAllowed: false });
    const q = await me.teamChat.send({ organizationId: orgId, channel: quiet.key, content: "@Nora anything?" });
    await settled();
    expect((await me.teamChat.thread({ organizationId: orgId, messageId: q.id })).replies).toEqual([]);
    expect((await me.teamChat.messages({ organizationId: orgId, channel: quiet.key })).employees).toEqual([]);
    expect((await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).employees.map((e) => e.name)).toContain("Nora");
  });

  it("team chat only people reach the channels, direct messages, the team and their account, nothing else", async () => {
    const { orgId, owner, caroline } = await setup("tch-chatonly");
    const me = caller(owner);
    await me.members.add({ organizationId: orgId, email: "delicia@tch-chatonly.test", name: "Delicia Porter", role: "chat" });
    const delicia = (await db.getUserByEmail("delicia@tch-chatonly.test"))!;
    const her = caller(delicia);
    // Her workspace list says what she is there; the team shows her role.
    expect((await her.organizations.list()).map((o) => [o.id, (o as { role?: string }).role])).toEqual([[orgId, "chat"]]);
    expect((await her.members.list({ organizationId: orgId })).find((m) => m.userId === delicia.id)?.role).toBe("chat");
    expect((await me.members.list({ organizationId: orgId })).map((m) => m.role)).toContain("chat");
    // She counts as a member of general and gets its messages, direct messages, threads and search.
    const hers = await her.teamChat.channels({ organizationId: orgId });
    expect(hers.channels.map((c) => c.name)).toEqual(["general"]);
    expect(hers.dms.map((d) => d.name)).toContain("Caroline Jones");
    const b = pingsFor(delicia.id, 0).latest;
    await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "@Delicia the front desk is covered until 2." });
    expect(pingsFor(delicia.id, b).pings.map((p) => p.title)).toEqual([`${owner.name} in #general`]);
    const sent = await her.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Thanks. @Nora what is due Thursday?" });
    await settled();
    // Nora is not offered to her and does not answer her, even in a channel that lets AI employees in.
    expect((await her.teamChat.messages({ organizationId: orgId, channel: "everyone" })).employees).toEqual([]);
    expect((await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages.find((m) => m.id === sent.id)?.mentions).toEqual({ users: [], employees: [] });
    expect((await me.teamChat.thread({ organizationId: orgId, messageId: sent.id })).replies).toEqual([]);
    const members = (await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).memberCount;
    expect(members).toBe(4);
    const dm = hers.dms.find((d) => d.name === "Caroline Jones")!;
    await her.teamChat.send({ organizationId: orgId, channel: dm.key, content: "Lunch at noon?" });
    expect((await caller(caroline).teamChat.messages({ organizationId: orgId, channel: dm.key })).messages.map((m) => m.content)).toEqual(["Lunch at noon?"]);
    expect((await her.teamChat.search({ organizationId: orgId, q: "front desk" })).hits).toHaveLength(1);
    // Everything else is closed to her: AI employees, Projects, Goals, approvals, the Brain, the team's settings.
    await expect(her.employees.list({ organizationId: orgId })).rejects.toThrow(/cannot do that/);
    await expect(her.chat.list({ organizationId: orgId, employeeId: (await db.getEmployeeByKind(orgId, "projects"))!.id })).rejects.toThrow(/cannot do that/);
    await expect(her.projects.launches({ organizationId: orgId })).rejects.toThrow(/cannot do that/);
    await expect(her.publishing.listApprovalQueue({ organizationId: orgId })).rejects.toThrow(/cannot do that/);
    await expect(her.members.add({ organizationId: orgId, email: "x@tch-chatonly.test", role: "member" })).rejects.toThrow(/cannot do that/);
    await expect(her.teamChat.slackPlan({ organizationId: orgId, token: "x" })).rejects.toThrow(/cannot do that/);
    // The owner can make her a member later, and back.
    await me.members.updateRole({ organizationId: orgId, userId: delicia.id, role: "member" });
    expect((await her.employees.list({ organizationId: orgId })).length).toBeGreaterThan(0);
    await me.members.updateRole({ organizationId: orgId, userId: delicia.id, role: "chat" });
    await expect(her.employees.list({ organizationId: orgId })).rejects.toThrow(/cannot do that/);
  });

  it("shows a card under a link: Loom and YouTube with a player, Google files by name, pages by their tags; Hide preview hides it for everyone", async () => {
    const { orgId, owner, caroline } = await setup("tch-links");
    const me = caller(owner);
    expect(urlsIn("See https://a.test/x, https://a.test/x and (https://b.test/y). Then https://c.test https://d.test https://e.test")).toEqual(["https://a.test/x", "https://b.test/y", "https://c.test"]);
    expect(linkTest.videoOf(new URL("https://www.loom.com/share/f03c9f35fd9641a8a5b05f8c2351c68d?sid=1"))?.embed).toBe("https://www.loom.com/embed/f03c9f35fd9641a8a5b05f8c2351c68d");
    expect(linkTest.videoOf(new URL("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))?.embed).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    expect(linkTest.videoOf(new URL("https://youtube.com/shorts/abc123def"))?.site).toBe("YouTube");
    expect(linkTest.googleOf(new URL("https://docs.google.com/presentation/d/1/edit"))).toBe("Google Slides");
    expect(linkTest.meta('<meta name="description" content="A &amp; B">', "description")).toBe("A & B");

    const loom = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Here is a role play on how to handle phone calls: https://www.loom.com/share/f03c9f35fd9641a8a5b05f8c2351c68d" });
    const yt = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "https://youtu.be/dQw4w9WgXcQ" });
    const sheet = await caller(caroline).teamChat.send({ organizationId: orgId, channel: "everyone", content: "The insurance list is here: https://docs.google.com/spreadsheets/d/1a2b/edit and the private one https://docs.google.com/document/d/private/edit" });
    const page = await caller(caroline).teamChat.send({ organizationId: orgId, channel: "everyone", content: "New homepage is live: https://leaddash.io" });
    const none = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Nothing to show: https://example.test/nothing or https://example.test/file.pdf or http://localhost:4000/x or https://gone.test/404" });
    await settled();
    const list = (await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages;
    const by = (id: number) => list.find((m) => m.id === id)!;
    expect(by(loom.id).previews).toEqual([{ url: "https://www.loom.com/share/f03c9f35fd9641a8a5b05f8c2351c68d", kind: "video", site: "Loom", title: "Role play: handling phone calls", description: null, image: "https://cdn.loom.com/sessions/thumbnails/f03c.jpg", embed: "https://www.loom.com/embed/f03c9f35fd9641a8a5b05f8c2351c68d", duration: 372 }]);
    expect(by(yt.id).previews).toEqual([{ url: "https://youtu.be/dQw4w9WgXcQ", kind: "video", site: "YouTube", title: "Front desk training", description: null, image: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", embed: "https://www.youtube.com/embed/dQw4w9WgXcQ", duration: null }]);
    expect(by(sheet.id).previews).toEqual([
      { url: "https://docs.google.com/spreadsheets/d/1a2b/edit", kind: "file", site: "Google Sheets", title: "Accepted insurance list", description: null, image: null, embed: null, duration: null },
      { url: "https://docs.google.com/document/d/private/edit", kind: "file", site: "Google Docs", title: null, description: null, image: null, embed: null, duration: null },
    ]);
    expect(by(page.id).previews).toEqual([{ url: "https://leaddash.io", kind: "page", site: "LeadDash", title: "LeadDash EHR: one platform for your EHR, billing, phone, fax, and marketing", description: "Most practices pay for five or six separate tools. LeadDash replaces them with one login & one bill.", image: "https://leaddash.io/img/home.png", embed: null, duration: null }]);
    expect(by(none.id).previews).toEqual([]);
    // Read once: the same link in another message uses what was kept.
    const fetches = fetchMock.mock.calls.length;
    const again = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Again: https://leaddash.io" });
    await settled();
    expect(fetchMock.mock.calls.length).toBe(fetches);
    expect((await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages.find((m) => m.id === again.id)!.previews[0].site).toBe("LeadDash");
    // Hide preview: the card goes for everyone, the link stays, other links on the message keep theirs.
    await caller(caroline).teamChat.hidePreview({ organizationId: orgId, messageId: sheet.id, url: "https://docs.google.com/document/d/private/edit" });
    const after = (await me.teamChat.messages({ organizationId: orgId, channel: "everyone" })).messages.find((m) => m.id === sheet.id)!;
    expect(after.previews.map((p) => p.site)).toEqual(["Google Sheets"]);
    expect(after.content).toContain("https://docs.google.com/document/d/private/edit");
    // Threads and search carry the cards too.
    const reply = await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Watch this one too https://youtu.be/dQw4w9WgXcQ", threadOf: loom.id });
    await settled();
    expect((await me.teamChat.thread({ organizationId: orgId, messageId: loom.id })).replies.find((r) => r.id === reply.id)!.previews[0].title).toBe("Front desk training");
  });

  it("searches channels, threads and direct messages with From, In, Has files and Date", async () => {
    const { orgId, owner, caroline } = await setup("tch-search");
    const me = caller(owner);
    const her = caller(caroline);
    const dm = (await me.teamChat.channels({ organizationId: orgId })).dms.find((d) => d.name === "Caroline Jones")!.key;
    await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "Fire inspection is at 1:00 today." });
    await her.teamChat.send({ organizationId: orgId, channel: "everyone", content: "The fire marshal needs the training log before the inspection." });
    await me.teamChat.send({ organizationId: orgId, channel: dm, content: "Can you book the fire inspection for the first week of October?" });
    const f = db.createChatFile({ organizationId: orgId, employeeId: 0, userId: owner.id, name: "Fire inspection 2026.pdf", mime: "application/pdf", size: 10, kind: "document", fileUrl: "/files/fire.pdf", text: "" });
    await me.teamChat.send({ organizationId: orgId, channel: "everyone", content: "", attachmentIds: [f.id] });

    const all = await her.teamChat.search({ organizationId: orgId, q: "fire inspection" });
    expect(all.hits.map((h) => [h.channelName, h.dm])).toEqual([["general", false], [owner.name, true], ["general", false], ["general", false]]);
    expect((await her.teamChat.search({ organizationId: orgId, q: "fire", from: caroline.id })).hits.map((h) => h.authorName)).toEqual(["Caroline Jones"]);
    expect((await her.teamChat.search({ organizationId: orgId, q: "fire", in: dm })).hits.map((h) => h.channelName)).toEqual([owner.name]);
    expect((await her.teamChat.search({ organizationId: orgId, q: "", files: true })).hits.map((h) => JSON.parse(h.attachments!)[0].name)).toEqual(["Fire inspection 2026.pdf"]);
    expect((await her.teamChat.search({ organizationId: orgId, q: "inspection", days: 7 })).hits).toHaveLength(4);
    expect((await her.teamChat.search({ organizationId: orgId, q: "" })).hits).toEqual([]);
  });
});

const p2Order = (chs: { general: boolean; archived: boolean; messages: number }[]) => chs[0].general && chs.every((c, i) => i === 0 || c.archived || !chs[i - 1].archived);

describe("Import from Slack", () => {
  const ts = (iso: string, n = 0) => `${Math.floor(new Date(iso).getTime() / 1000)}.${String(n).padStart(6, "0")}`;

  async function exportZip(file: string) {
    const zip = new JSZip();
    zip.file("users.json", JSON.stringify([
      { id: "U1", name: "ashley", real_name: "Ashley Bryant", profile: { email: "owner@tch-slack.test", real_name: "Ashley Bryant" } },
      { id: "U2", name: "caroline", real_name: "Caroline M", profile: { email: "CAROLINE@tch-slack.test", real_name: "Caroline M" } },
      { id: "U3", name: "bentlee", real_name: "Bentlee Smiley", deleted: true, profile: { email: "bentlee@old.test" } },
      { id: "U4", name: "amanda", real_name: "Amanda Case, LPC", profile: { email: "amanda@elsewhere.test" } },
      { id: "B1", name: "clickup", real_name: "ClickUp", is_bot: true, profile: {} },
    ]));
    zip.file("channels.json", JSON.stringify([
      { id: "C1", name: "general", is_general: true, purpose: { value: "Everyone at Legacy" }, members: ["U1", "U2", "U3"] },
      { id: "C2", name: "training-videos", purpose: { value: "Looms" }, members: ["U1", "U2"] },
      { id: "C3", name: "jane-training-videos", is_archived: true, purpose: { value: "" }, members: [] },
    ]));
    zip.file("general/2026-10-02.json", JSON.stringify([
      { type: "message", subtype: "channel_join", user: "U2", text: "<@U2> has joined the channel", ts: ts("2026-10-02T14:00:00Z") },
      { type: "message", user: "U1", text: "Hey ya'll! Starting *Wednesday* every new request comes through LeadDash EHR. <@U2> and the admin team will accept those.", ts: ts("2026-10-02T14:14:00Z"), thread_ts: ts("2026-10-02T14:14:00Z"), reply_count: 1, reactions: [{ name: "+1", users: ["U2", "U3"], count: 2 }, { name: "tada", users: ["U2"], count: 1 }], pinned_to: ["C1"] },
      { type: "message", user: "U3", text: "Got it. See <https://app.clickup.com/t/abc|the task> and <https://loom.com/share/1>.", ts: ts("2026-10-02T14:40:00Z"), thread_ts: ts("2026-10-02T14:14:00Z"), parent_user_id: "U1", edited: { ts: ts("2026-10-02T14:41:00Z") } },
      { type: "message", user: "U4", text: "", ts: ts("2026-10-02T15:00:00Z"), files: [{ id: "F1", name: "Couples Treatment Planner.pdf", size: 1200, mimetype: "application/pdf", url_private: "https://files.slack.com/x.pdf" }] },
      { type: "message", subtype: "bot_message", bot_id: "B1", text: "Task created", ts: ts("2026-10-02T15:10:00Z") },
      { type: "message", subtype: "channel_purpose", user: "U1", text: "set the purpose", ts: ts("2026-10-02T15:20:00Z") },
    ]));
    zip.file("training-videos/2026-10-03.json", JSON.stringify([{ type: "message", user: "U2", text: "New Loom on checking eligibility &amp; benefits.", ts: ts("2026-10-03T09:00:00Z") }]));
    zip.file("jane-training-videos/2022-02-01.json", JSON.stringify([{ type: "message", user: "U1", text: "Old video", ts: ts("2022-02-01T09:00:00Z") }]));
    await fs.promises.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  }

  it("converts Slack's markup", () => {
    const nameOf = (uid: string) => (uid === "U2" ? "Caroline Jones" : "someone");
    expect(_test.convertText("Hi <@U2>, see <#C9|random> and <https://a.test|A site> or <https://b.test>. *Bold* &amp; _it_", nameOf)).toBe("Hi @Caroline Jones, see #random and A site (https://a.test) or https://b.test. **Bold** & _it_");
    expect(_test.emojiOf("+1")).toBe("👍");
    expect(_test.emojiOf("heart::skin-tone-2")).toBe("❤️");
    expect(_test.emojiOf("flying_squirrel")).toBe(":flying_squirrel:");
    expect(_test.keep({ type: "message", subtype: "channel_join", text: "joined", ts: "1" })).toBe(false);
    expect(_test.keep({ type: "message", text: "", ts: "1", files: [{ name: "a.pdf" }] })).toBe(true);
  });

  it("plans from the export: channels, counts, people by email; then imports and reruns without copies", async () => {
    const { orgId, owner, caroline } = await setup("tch-slack");
    const me = caller(owner);
    const file = "/tmp/leaddash-employees-test-uploads/slack-test.zip";
    await fs.promises.mkdir("/tmp/leaddash-employees-test-uploads", { recursive: true });
    await exportZip(file);
    const p = await hold(orgId, "export.zip", file);
    expect(p.counts).toEqual({ channels: 3, dms: 0, messages: 5, reactions: 3, replies: 1, files: 1, active: 3, left: 1 });
    expect(p.channels.map((c) => [c.name, c.messages, c.becomes, c.take, c.archived])).toEqual([["general", 3, "general", true, false], ["training-videos", 1, "training-videos", true, false], ["jane-training-videos", 1, "jane-training-videos", false, true]]);
    expect(p2Order(p.channels)).toBe(true);
    expect(p.people.map((x) => [x.name, x.matched, x.userId, x.messages])).toEqual([["Ashley Bryant", "email", owner.id, 2], ["Amanda Case, LPC", "none", null, 1], ["Bentlee Smiley", "left", null, 1], ["Caroline M", "email", caroline.id, 1]]);
    expect(p.members.map((m) => m.name)).toContain("Caroline Jones");

    const r = await me.teamChat.slackImport({ organizationId: orgId, token: p.token, channels: p.channels.map((c) => ({ id: c.id, take: c.take, name: c.becomes })), people: p.people.map((x) => ({ id: x.id, userId: x.userId })) });
    expect(r).toMatchObject({ channelsMade: 1, added: 4, updated: 0, reactions: 3, files: 1 });

    const list = await me.teamChat.channels({ organizationId: orgId });
    expect(list.channels.map((c) => [c.name, c.unread])).toEqual([["general", 0], ["training-videos", 0]]);
    const g = await me.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(g.messages.map((m) => [m.authorName, m.userId, m.content])).toEqual([
      [owner.name, owner.id, "Hey ya'll! Starting **Wednesday** every new request comes through LeadDash EHR. @Caroline Jones and the admin team will accept those."],
      ["Amanda Case, LPC", 0, ""],
    ]);
    expect(g.messages[0]).toMatchObject({ pinned: true, mentions: { users: [caroline.id], employees: [] }, thread: { count: 1, who: [{ name: "Bentlee Smiley", userId: 0 }] } });
    expect(g.messages[0].reactions).toEqual([{ emoji: "👍", count: 2, me: false, names: ["Caroline Jones", "Bentlee Smiley"] }, { emoji: "🎉", count: 1, me: false, names: ["Caroline Jones"] }]);
    expect(new Date(g.messages[0].createdAt).toISOString()).toBe("2026-10-02T14:14:00.000Z");
    expect(JSON.parse(g.messages[1].attachments!)[0]).toMatchObject({ name: "Couples Treatment Planner.pdf", url: null, note: "Stored in Slack" });
    const t = await me.teamChat.thread({ organizationId: orgId, messageId: g.messages[0].id });
    expect(t.replies[0]).toMatchObject({ authorName: "Bentlee Smiley", content: "Got it. See the task (https://app.clickup.com/t/abc) and https://loom.com/share/1." });
    expect(t.replies[0].editedAt).not.toBeNull();
    const tv = await me.teamChat.messages({ organizationId: orgId, channel: list.channels[1].key });
    expect(tv.sub).toBe("Looms");
    expect(tv.messages.map((m) => m.content)).toEqual(["New Loom on checking eligibility & benefits."]);

    // Run it again (same export, now with Amanda matched to Caroline's account): nothing doubles, the mapping changes.
    await exportZip(file);
    const p2 = await hold(orgId, "export.zip", file);
    expect(p2.channels.map((c) => c.existing)).toEqual([true, true, false]);
    const r2 = await me.teamChat.slackImport({ organizationId: orgId, token: p2.token, channels: p2.channels.map((c) => ({ id: c.id, take: c.take, name: c.becomes })), people: p2.people.map((x) => ({ id: x.id, userId: x.name.startsWith("Amanda") ? caroline.id : x.userId })) });
    expect(r2).toMatchObject({ channelsMade: 0, added: 0, updated: 4, reactions: 0 });
    const again = await me.teamChat.messages({ organizationId: orgId, channel: "everyone" });
    expect(again.messages).toHaveLength(2);
    expect(again.messages[0].reactions[0].count).toBe(2);
    expect((await me.teamChat.channels({ organizationId: orgId })).channels).toHaveLength(2);
  });

  it("brings over direct messages and group messages from a full export, between people who are on the team here", async () => {
    const { orgId, owner, caroline, angela } = await setup("tch-slackdm");
    const me = caller(owner);
    const file = "/tmp/leaddash-employees-test-uploads/slack-dm-test.zip";
    await fs.promises.mkdir("/tmp/leaddash-employees-test-uploads", { recursive: true });
    const zip = new JSZip();
    zip.file("users.json", JSON.stringify([
      { id: "U1", name: "ashley", real_name: "Ashley Bryant", profile: { email: "owner@tch-slackdm.test" } },
      { id: "U2", name: "caroline", real_name: "Caroline M", profile: { email: "caroline@tch-slackdm.test" } },
      { id: "U3", name: "angela", real_name: "Angela St. Ville", profile: { email: "angela@tch-slackdm.test" } },
      { id: "U4", name: "amanda", real_name: "Amanda Case", profile: { email: "amanda@elsewhere.test" } },
    ]));
    zip.file("channels.json", JSON.stringify([{ id: "C1", name: "general", is_general: true, members: ["U1", "U2", "U3"] }]));
    zip.file("general/2026-10-01.json", JSON.stringify([{ type: "message", user: "U1", text: "Welcome", ts: ts("2026-10-01T14:00:00Z") }]));
    // A private channel in groups.json, a direct message by id, one with someone not here, and a group message by name.
    zip.file("groups.json", JSON.stringify([{ id: "G1", name: "therapists-only", members: ["U1", "U3"], purpose: { value: "Therapists" } }]));
    zip.file("therapists-only/2026-10-01.json", JSON.stringify([{ type: "message", user: "U3", text: "Supervision moved to 3.", ts: ts("2026-10-01T15:00:00Z") }]));
    zip.file("dms.json", JSON.stringify([{ id: "D1", members: ["U1", "U2"] }, { id: "D2", members: ["U1", "U4"] }, { id: "D3", members: ["U2", "U3"] }]));
    zip.file("D1/2026-10-01.json", JSON.stringify([
      { type: "message", user: "U1", text: "Can you send the promo copy by 4?", ts: ts("2026-10-01T16:00:00Z"), reactions: [{ name: "white_check_mark", users: ["U2"], count: 1 }] },
      { type: "message", user: "U2", text: "Yes, on it.", ts: ts("2026-10-01T16:05:00Z") },
    ]));
    zip.file("D2/2026-10-01.json", JSON.stringify([{ type: "message", user: "U4", text: "Hi Ashley", ts: ts("2026-10-01T17:00:00Z") }]));
    zip.file("mpims.json", JSON.stringify([{ id: "G2", name: "mpdm-ashley--caroline--angela-1", members: ["U1", "U2", "U3"] }, { id: "G3", name: "mpdm-ashley--amanda--bob-1", members: ["U1", "U4", "U5"] }]));
    zip.file("mpdm-ashley--caroline--angela-1/2026-10-01.json", JSON.stringify([{ type: "message", user: "U2", text: "Fire inspection passed.", ts: ts("2026-10-01T18:00:00Z") }]));
    zip.file("mpdm-ashley--amanda--bob-1/2026-10-01.json", JSON.stringify([{ type: "message", user: "U4", text: "Lunch?", ts: ts("2026-10-01T18:30:00Z") }]));
    await fs.promises.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));

    const p = await hold(orgId, "full-export.zip", file);
    expect(p.counts).toMatchObject({ channels: 2, dms: 4, messages: 7 });
    expect(p.channels.map((c) => [c.name, c.private])).toEqual([["general", false], ["therapists-only", true]]);
    expect(p.dms.map((d) => [d.id, d.group, d.names, d.messages, d.take])).toEqual([
      ["D1", false, ["Ashley Bryant", "Caroline M"], 2, true],
      ["D2", false, ["Ashley Bryant", "Amanda Case"], 1, true],
      ["G2", true, ["Ashley Bryant", "Caroline M", "Angela St. Ville"], 1, true],
      ["G3", true, ["Ashley Bryant", "Amanda Case", "Someone"], 1, true],
    ]);
    const r = await me.teamChat.slackImport({ organizationId: orgId, token: p.token, channels: p.channels.map((c) => ({ id: c.id, take: true, name: c.becomes })), people: p.people.map((x) => ({ id: x.id, userId: x.userId })), dms: p.dms.map((d) => ({ id: d.id, take: true })) });
    expect(r).toMatchObject({ channelsMade: 2, added: 5, dms: 2 });
    expect(r.log).toEqual([
      "#general: 1 messages",
      "#therapists-only: 1 messages",
      `Direct message (${owner.name}, Caroline Jones): 2 messages`,
      `Direct message (${owner.name}, Amanda Case): skipped, both people need to be on this team`,
      `#group-${owner.name.split(" ")[0].toLowerCase()}-caroline-angela (group message, ${owner.name}, Caroline Jones, Angela St. Ville): 1 messages`,
      `Group message (${owner.name}, Amanda Case, someone): skipped, at least two of its people need to be on this team`,
    ]);
    // The direct message is between the two of them, read, with its reaction; the group one is a private channel for its three people.
    const key = `dm:${Math.min(owner.id, caroline.id)}-${Math.max(owner.id, caroline.id)}`;
    const dm = await caller(caroline).teamChat.messages({ organizationId: orgId, channel: key });
    expect(dm.messages.map((m) => [m.authorName, m.content])).toEqual([[owner.name, "Can you send the promo copy by 4?"], ["Caroline Jones", "Yes, on it."]]);
    expect(dm.messages[0].reactions).toEqual([{ emoji: "✅", count: 1, me: true, names: ["Caroline Jones"] }]);
    expect((await caller(caroline).teamChat.channels({ organizationId: orgId })).dms.find((d) => d.key === key)?.unread).toBe(0);
    const chans = await caller(angela).teamChat.channels({ organizationId: orgId });
    const group = chans.channels.find((c) => c.name.startsWith("group-"))!;
    expect(group.private).toBe(true);
    expect((await caller(angela).teamChat.messages({ organizationId: orgId, channel: group.key })).messages.map((m) => m.content)).toEqual(["Fire inspection passed."]);
    expect((await caller(angela).teamChat.messages({ organizationId: orgId, channel: group.key })).memberCount).toBe(3);
    expect((await caller(angela).teamChat.messages({ organizationId: orgId, channel: chans.channels.find((c) => c.name === "therapists-only")!.key })).messages).toHaveLength(1);
    // Again: nothing doubles.
    await fs.promises.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    const p2 = await hold(orgId, "full-export.zip", file);
    expect(p2.dms.find((d) => d.id === "G2")?.existing).toBe(true);
    const r2 = await me.teamChat.slackImport({ organizationId: orgId, token: p2.token, channels: p2.channels.map((c) => ({ id: c.id, take: true, name: c.becomes })), people: p2.people.map((x) => ({ id: x.id, userId: x.userId })), dms: p2.dms.map((d) => ({ id: d.id, take: true })) });
    expect(r2).toMatchObject({ channelsMade: 0, added: 0, updated: 5, dms: 2 });
    expect((await caller(caroline).teamChat.messages({ organizationId: orgId, channel: key })).messages).toHaveLength(2);
    expect((await caller(angela).teamChat.channels({ organizationId: orgId })).channels.filter((c) => c.name.startsWith("group-"))).toHaveLength(1);
  });
});
