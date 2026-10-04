import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let turn: any = { replies: [] };
let systems: string[] = [];
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

    const ended = await c.huddle.end({ organizationId: orgId, id: h.id });
    expect(ended.status).toBe("ended");
    const m = (await db.getMeeting(ended.meetingId!, orgId))!;
    expect(m.title).toMatch(/^Team huddle, /);
    expect(m.notes).toContain("Morgan: Two things are due");
    expect(JSON.parse(m.actionItems!)[0].text).toBe("Record the pitch video");
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
    expect(next.lines).toEqual([{ index: 1, kind: "coo", name: "Simone", text: "Three items for Thursday.", audioId: null }]);
    expect(huddle.botNext(token, 1).lines).toEqual([]);
    expect(huddle.botNext("f".repeat(48), -1).live).toBe(false);

    const remove = vi.spyOn(integrations, "removeRecallBot").mockResolvedValue(undefined as any);
    const out = await c.huddle.takeOut({ organizationId: orgId, id: h.id });
    expect(out.inMeeting).toBe(false);
    expect(remove).toHaveBeenCalledWith(orgId, "bot-1");
  });

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

  it("each employee has their own stock voice", () => {
    const voices = ["coo", "projects", "grants", "speaking", "prospecting", "outreach", "leads", "social", "blog", "website", "video", "inbox", "hiring"].map((k) => huddle.VOICES[k]);
    expect(new Set(voices).size).toBe(voices.length);
  });
});
