import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let turn: any = { replies: [] };
let systems: string[] = [];
let factsSystem = "";
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "huddle_turn") {
        systems.push(opts.system + "\n" + opts.prompt);
        return turn;
      }
      if (opts.schemaName === "action_items") return { items: [{ text: "Record the pitch video", owner: "Ashley" }] };
      if (opts.schemaName === "chat_decision") return { reply: "On it: the follow-up email is drafted and waiting in Approvals.", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
      if (opts.schemaName === "huddle_facts") factsSystem = opts.system;
      if (opts.schemaName === "huddle_facts") return { facts: [{ topic: "Founding member deadline", fact: "Founding member pricing closes December 31, 2026.", category: "services_offers" }] };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as huddle from "./employees/huddle";
import * as integrations from "./integrations";
import { encryptJson } from "./_core/crypto";

beforeEach(() => {
  turn = { replies: [] };
  systems = [];
});
afterEach(() => vi.restoreAllMocks());

describe("team huddle", () => {
  it("starts with the active employees, answers only when it should, keeps the transcript, and ends with notes for Simone", async () => {
    const { orgId, owner } = await makeWorkspace("huddle");
    const c = caller(owner);
    const h = await c.huddle.start({ organizationId: orgId, kinds: ["grants", "projects", "coo"] });
    expect(h.kinds.sort()).toEqual(["coo", "grants", "projects"]);
    expect((h as any).token).toBeUndefined();
    // Starting again returns the same live huddle.
    expect((await c.huddle.start({ organizationId: orgId })).id).toBe(h.id);

    // People talking to each other: nobody answers.
    turn = { replies: [] };
    const quiet = await c.huddle.say({ organizationId: orgId, id: h.id, text: "Give me a second to pull that up." });
    expect(quiet.replies).toEqual([]);

    turn = { replies: [{ kind: "grants", say: "Two things are due — Tulsa on Friday, November 6." }, { kind: "website", say: "Not in this huddle." }] };
    const r = await c.huddle.say({ organizationId: orgId, id: h.id, text: "Morgan, what's due this month?" });
    // Only employees in the huddle speak, and dashes are spoken as pauses.
    expect(r.replies.map((x) => x.name)).toEqual(["Morgan"]);
    expect(r.replies[0].text).toBe("Two things are due, Tulsa on Friday, November 6.");
    expect(r.replies[0].audioUrl).toBeNull(); // no voice in tests; the words still show
    expect(systems[1]).toContain("## Morgan (job key: grants");
    expect(systems[1]).toContain("## Nora (job key: projects");
    expect(systems[1]).not.toContain("## Jordan");
    expect(systems[1]).toContain(`${owner.name}: Morgan, what's due this month?`);
    expect(r.huddle.lines.map((l) => l.who)).toEqual([owner.name, owner.name, "Morgan"]);
    // Asked to do something: the employee starts now, through their own chat, not after the huddle.
    turn = { replies: [{ kind: "projects", say: "On it. I'll post it in my chat.", do: "Write the November 10 webinar follow-up email to all registrants" }] };
    await c.huddle.say({ organizationId: orgId, id: h.id, text: "Nora, write the webinar follow-up email." });
    await huddle.settled();
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    const noraChat = await db.listChatMessages(orgId, nora.id, 5);
    expect(noraChat.map((m) => [m.role, m.authorName, m.content])).toEqual([
      ["user", `${owner.name} (in the huddle)`, "Write the November 10 webinar follow-up email to all registrants"],
      ["employee", "Nora", "On it: the follow-up email is drafted and waiting in Approvals."],
    ]);

    const ended = await c.huddle.end({ organizationId: orgId, id: h.id });
    expect(ended.status).toBe("ended");
    const m = (await db.getMeeting(ended.meetingId!, orgId))!;
    expect(m.title).toMatch(/^Team huddle, /);
    expect(m.notes).toContain("Morgan: Two things are due");
    expect(JSON.parse(m.actionItems!)[0].text).toBe("Record the pitch video");
    // New facts from the huddle go to the Brain for everyone.
    const learned = (await db.listKnowledgeByOrg(orgId)).find((k) => k.title === "Learned: Founding member deadline")!;
    expect(learned.content).toMatch(/^Founding member pricing closes December 31, 2026\.\n\(.* told the team huddle on /);
    // Decisions can replace what the Brain already knew.
    expect(factsSystem).toContain("reuse that exact topic so the old fact is replaced");
    await expect(c.huddle.say({ organizationId: orgId, id: h.id, text: "Hello?" })).rejects.toThrow(/ended/);
  });

  it("sends the team into a meeting with a talking bot, hears the meeting through the webhook, and the bot page plays the answers", async () => {
    const { orgId, owner } = await makeWorkspace("huddle-bot");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "recall", accountLabel: "Recall.ai", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ apiKey: "k".repeat(40) }), connectedAt: new Date(), lastCheckedAt: new Date() });
    const c = caller(owner);
    const h = await c.huddle.start({ organizationId: orgId, kinds: ["coo"] });
    await expect(c.huddle.bring({ organizationId: orgId, id: h.id, url: "https://example.com/not-a-meeting" })).rejects.toThrow(/Zoom, Google Meet/);

    const { ENV } = await import("./_core/env");
    const before = ENV.appUrl;
    (ENV as any).appUrl = "https://employees.leaddash.io";
    const create = vi.spyOn(integrations, "createRecallTeamBot").mockResolvedValue("bot-1");
    const inMeeting = await c.huddle.bring({ organizationId: orgId, id: h.id, url: "https://us02web.zoom.us/j/123456789" });
    (ENV as any).appUrl = before;
    expect(inMeeting.inMeeting).toBe(true);
    const args = create.mock.calls[0][1];
    const token = db.getHuddle(h.id, orgId)!.token;
    expect(args.pageUrl).toBe(`https://employees.leaddash.io/voice/bot/${token}`);
    expect(args.webhookUrl).toBe(`https://employees.leaddash.io/api/voice/bot/${token}/transcript`);
    expect(args.botName).toBe("LeadDash Team (AI)");
    expect(args.message).toMatch(/AI employees/);

    // The bot's own voice is ignored; a person's line gets an answer the page can play.
    turn = { replies: [{ kind: "coo", say: "Three items for Thursday." }] };
    await huddle.botHeard(token, { event: "transcript.data", data: { data: { words: [{ text: "Hi" }], participant: { name: "LeadDash Team (AI)" } } } });
    expect(huddle.linesOf(db.getHuddle(h.id, orgId)!)).toHaveLength(0);
    await huddle.botHeard(token, { event: "transcript.data", data: { data: { words: [{ text: "Simone," }, { text: "what's" }, { text: "on" }, { text: "Thursday?" }], participant: { name: "BJ" } } } });
    const lines = huddle.linesOf(db.getHuddle(h.id, orgId)!);
    expect(lines.map((l) => `${l.who}: ${l.text}`)).toEqual(["BJ: Simone, what's on Thursday?", "Simone: Three items for Thursday."]);
    const next = huddle.botNext(token, -1);
    expect(next.lines).toEqual([{ index: 1, kind: "coo", name: "Simone", text: "Three items for Thursday.", audioId: null, age: expect.any(Number) }]);
    expect(huddle.botNext(token, 1).lines).toEqual([]);
    // Someone starts talking (a partial line): the page is told to stop playing; the bot's own partials never hush it.
    expect(next.hush).toBe(true); // BJ just spoke
    await new Promise((r) => setTimeout(r, 2600));
    expect(huddle.botNext(token, 1).hush).toBe(false);
    await huddle.botHeard(token, { event: "transcript.partial_data", data: { data: { words: [{ text: "Hang" }], participant: { name: "LeadDash Team (AI)" } } } });
    expect(huddle.botNext(token, 1).hush).toBe(false);
    await huddle.botHeard(token, { event: "transcript.partial_data", data: { data: { words: [{ text: "Hang" }, { text: "on" }], participant: { name: "BJ" } } } });
    expect(huddle.botNext(token, 1).hush).toBe(true);
    expect(huddle.linesOf(db.getHuddle(h.id, orgId)!)).toHaveLength(2); // a partial line is not part of the transcript
    // The team's own voice coming back through someone's speakers is not a person talking.
    await new Promise((r) => setTimeout(r, 2600));
    await huddle.botHeard(token, { event: "transcript.partial_data", data: { data: { words: [{ text: "three" }, { text: "items" }, { text: "for" }], participant: { name: "Ashley" } } } });
    expect(huddle.botNext(token, 1).hush).toBe(false);
    await huddle.botHeard(token, { event: "transcript.data", data: { data: { words: [{ text: "Three" }, { text: "items" }, { text: "for" }, { text: "Thursday." }], participant: { name: "Ashley" } } } });
    expect(huddle.linesOf(db.getHuddle(h.id, orgId)!)).toHaveLength(2);
    // One sound is not enough to stop them.
    await huddle.botHeard(token, { event: "transcript.partial_data", data: { data: { words: [{ text: "Mm" }], participant: { name: "Ashley" } } } });
    expect(huddle.botNext(token, 1).hush).toBe(false);
    expect(huddle.botNext("f".repeat(48), -1).live).toBe(false);

    const remove = vi.spyOn(integrations, "removeRecallBot").mockResolvedValue(undefined as any);
    const out = await c.huddle.takeOut({ organizationId: orgId, id: h.id });
    expect(out.inMeeting).toBe(false);
    expect(remove).toHaveBeenCalledWith(orgId, "bot-1");
  }, 15_000);

  it("matches ElevenLabs voices to each employee, women's voices for women and men's for men, never the same voice twice", () => {
    const v = (id: string, gender: string, accent = "american") => ({ voice_id: id, name: id, category: "premade", labels: { gender, accent } });
    const voices = [v("f1", "female"), v("f2", "female", "british"), v("f3", "female"), v("m1", "male"), v("m2", "male"), v("f4", "female"), v("f5", "female"), v("f6", "female"), v("f7", "female"), v("f8", "female"), v("m3", "male"), v("m4", "male"), v("m5", "male"), v("m6", "male")];
    const map = huddle.assignVoices(voices, { coo: "m6" });
    expect(map.coo).toBe("m6");
    expect(["f1", "f3", "f4", "f5", "f6", "f7", "f8"]).toContain(map.projects);
    expect(map.speaking.startsWith("m")).toBe(true);
    const kinds = ["coo", "projects", "grants", "speaking", "prospecting", "outreach", "leads", "social", "blog", "website", "video", "inbox", "hiring"];
    expect(new Set(kinds.map((k) => map[k])).size).toBe(kinds.length);
    // American accents come first.
    expect(Object.values(map).slice(0, 8)).not.toContain("f2");
  });

  it("shares in the meeting, stays on topic, never repeats itself, and takes one turn at a time", async () => {
    const { orgId, owner } = await makeWorkspace("huddle-rules");
    const c = caller(owner);
    const h = await c.huddle.start({ organizationId: orgId, kinds: ["coo", "speaking"] });
    turn = { replies: [{ kind: "speaking", say: "How Busy Practice Owners Build a Practice That Works 24/7." }, { kind: "speaking", say: "A second line from the same person." }, { kind: "coo", say: "How busy practice owners build a practice that works 24/7!" }] };
    const r = await c.huddle.say({ organizationId: orgId, id: h.id, text: "Taylor, what's the webinar title?" });
    // One answer per employee, and never the same words twice.
    expect(r.replies.map((x) => x.text)).toEqual(["How Busy Practice Owners Build a Practice That Works 24/7."]);
    const rules = systems[0];
    expect(rules).toContain("Share in the meeting");
    expect(rules).toContain("Never answer with \"I'll post it in my chat\"");
    expect(rules).toContain("Stay on what this meeting is about");
    expect(rules).toContain("ClickUp");
    expect(rules).toContain(`People on the team: ${owner.name}`);
    // Simone is told whether she can see the calendar.
    expect(rules).toContain("The owner's calendar: not connected");
    // Saying the same thing again is dropped, unless someone asks to hear it again.
    turn = { replies: [{ kind: "speaking", say: "How Busy Practice Owners Build a Practice That Works 24/7." }] };
    expect((await c.huddle.say({ organizationId: orgId, id: h.id, text: "Okay, what else?" })).replies).toEqual([]);
    expect((await c.huddle.say({ organizationId: orgId, id: h.id, text: "Taylor, repeat the title once more." })).replies).toHaveLength(1);
    // Lines that arrive together are answered one turn at a time; only the newest gets the answer.
    systems = [];
    turn = { replies: [{ kind: "coo", say: "Thursday works." }] };
    const [a, b2] = await Promise.all([
      huddle.say(orgId, h.id, "Caroline", "Simone, when can we meet next?"),
      huddle.say(orgId, h.id, "Caroline", "Not at 10, Ashley has a call."),
    ]);
    expect(a.replies).toEqual([]);
    expect(b2.replies.map((x) => x.text)).toEqual(["Thursday works."]);
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("Caroline: Simone, when can we meet next?\nCaroline: Not at 10, Ashley has a call.");
  });

  it("says web addresses the way people do and explains an empty voice account plainly", () => {
    expect(huddle.speakable("Book a demo at leaddash.io/demo or https://www.leaddash.io.", "LeadDash")).toBe("Book a demo at Lead Dash dot I O or Lead Dash dot I O.");
    expect(huddle.speakable("See example.com.", "LeadDash")).toBe("See example dot com.");
    expect(huddle.outOfCredits('{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota of 10000."}}')).toBe(true);
    expect(huddle.outOfCredits('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(huddle.outOfCredits('{"detail":{"status":"invalid_api_key"}}')).toBe(false);
    expect(huddle.ELEVEN_EMPTY).toContain("elevenlabs.io/app/subscription");
  });

  it("each employee has their own stock voice", () => {
    const voices = ["coo", "projects", "grants", "speaking", "prospecting", "outreach", "leads", "social", "blog", "website", "video", "inbox", "hiring"].map((k) => huddle.VOICES[k]);
    expect(new Set(voices).size).toBe(voices.length);
  });
});
