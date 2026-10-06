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
    expect(p.counts).toEqual({ channels: 3, messages: 5, reactions: 3, replies: 1, files: 1, active: 3, left: 1 });
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
});
