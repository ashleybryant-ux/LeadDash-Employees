import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as notetaker from "./employees/notetaker";
import { encryptJson } from "./_core/crypto";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let llm: typeof import("./_core/llm");

beforeEach(async () => {
  calls = [];
  routes = [];
  process.env.RECALL_API_KEY = "recall-key-1234567890abcdef";
  integrations.forgetRecallKey();
  llm = await import("./_core/llm");
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return json({ error: "no route " + url }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const at = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

describe("Avery's notetaker (notes go to Simone)", () => {
  it("finds Zoom, Google Meet and Teams links and ignores other links", () => {
    expect(integrations.meetingLinkOf({ hangoutLink: "https://meet.google.com/abc-defg-hij" })).toEqual({ platform: "meet", url: "https://meet.google.com/abc-defg-hij" });
    expect(integrations.meetingLinkOf({ location: "https://us02web.zoom.us/j/8123456789?pwd=xyz." })).toEqual({ platform: "zoom", url: "https://us02web.zoom.us/j/8123456789?pwd=xyz" });
    expect(integrations.meetingLinkOf({ description: "Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d." })).toEqual({ platform: "teams", url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d" });
    expect(integrations.meetingLinkOf({ description: "https://teams.live.com/meet/9876543210" })).toEqual({ platform: "teams", url: "https://teams.live.com/meet/9876543210" });
    expect(integrations.meetingLinkOf({ description: "Dial in: https://webex.example/join/1" })).toBeNull();
  });

  it("joins only the meetings the owner set up unless told otherwise", () => {
    const base = { skipWords: "", botName: "", notesTo: "me" as const, keep: "delete" as const };
    expect(notetaker.wantsJoin({ choice: "auto", lockReason: null, host: true }, { ...base, joins: "mine" })).toBe(true);
    expect(notetaker.wantsJoin({ choice: "auto", lockReason: null, host: false }, { ...base, joins: "mine" })).toBe(false);
    expect(notetaker.wantsJoin({ choice: "join", lockReason: null, host: false }, { ...base, joins: "mine" })).toBe(true);
    expect(notetaker.wantsJoin({ choice: "auto", lockReason: null, host: false }, { ...base, joins: "any" })).toBe(true);
    expect(notetaker.wantsJoin({ choice: "auto", lockReason: null, host: true }, { ...base, joins: "picked" })).toBe(false);
  });

  it("locks client sessions by word or LeadDash link", () => {
    const words = ["session", "intake", "therapy"];
    expect(notetaker.lockReasonFor("Client session with J.R.", words)).toBe('Has the word "session"');
    expect(notetaker.lockReasonFor("Telehealth https://portal.leaddash.io/v/abc", words)).toBe("Has a LeadDash link");
    expect(notetaker.lockReasonFor("Demo: Riverbend Counseling", words)).toBeNull();
    expect(notetaker.wantsJoin({ choice: "join", lockReason: 'Has the word "intake"', host: true }, { joins: "any", skipWords: "", botName: "", notesTo: "me", keep: "delete" })).toBe(false);
  });

  it("books bots from the calendar, skips locked meetings, then writes notes and deletes the recording", async () => {
    const { orgId, owner } = await makeWorkspace("notetaker");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "google_workspace", accountLabel: "Google", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });

    const c = caller(owner);
    // The key is LeadDash's, on the server; no workspace is asked for one.
    process.env.RECALL_API_KEY = "";
    expect(await notetaker.notetakerStatus(orgId)).toMatch(/meeting notes aren't set up on this server yet/);
    process.env.RECALL_API_KEY = "recall-key-1234567890abcdef";
    routes.push([
      /googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?/,
      () =>
        json({
          items: [
            { id: "ev1", summary: "Demo: Riverbend Counseling", start: { dateTime: at(180) }, end: { dateTime: at(210) }, hangoutLink: "https://meet.google.com/abc-defg-hij", organizer: { self: true }, attendees: [{ email: "lauren@riverbend.com", displayName: "Lauren Pierce" }] },
            { id: "ev2", summary: "Client session", start: { dateTime: at(240) }, end: { dateTime: at(290) }, location: "https://zoom.us/j/999", organizer: { self: true } },
            { id: "ev3", summary: "Vendor call", start: { dateTime: at(300) }, end: { dateTime: at(330) }, description: "https://webex.example/join/1" },
            // Someone else's meeting: listed, not joined, because it may not allow notetakers.
            { id: "ev4", summary: "Payer webinar", start: { dateTime: at(360) }, end: { dateTime: at(420) }, description: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0", organizer: { email: "host@payer.example" } },
          ],
        }),
    ]);
    let botN = 0;
    routes.push([/recall\.ai\/api\/v1\/bot\/$/, (_u, init) => (init.method === "POST" ? json({ id: `bot-${++botN}` }) : json({}))]);
    await notetaker.syncCalendar(orgId, new Date(), true);
    expect(calls.find((x) => /\/bot\/$/.test(x.url))!.init.headers.authorization).toBe("recall-key-1234567890abcdef");

    const view = await notetaker.notetakerView(orgId);
    expect(view.upcoming.map((r) => [r.title, r.platform, r.host, r.status])).toEqual([["Demo: Riverbend Counseling", "meet", true, "scheduled"], ["Client session", "zoom", true, "skipped"], ["Payer webinar", "teams", false, "skipped"]]);
    const demo = view.upcoming[0];
    const session = view.upcoming[1];
    expect(demo.status).toBe("scheduled");
    expect(session.lockReason).toBe('Has the word "session"');
    expect(session.botId).toBeNull();
    const booked = calls.filter((x) => /\/bot\/$/.test(x.url) && x.init.method === "POST").map((x) => JSON.parse(x.init.body));
    expect(booked).toHaveLength(1);
    expect(booked[0].meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(booked[0].join_at).toBeTruthy();
    expect(booked[0].chat.on_bot_join.message).toBe("I'm Avery, a LeadDash employee taking notes for Workspace notetaker. Ask me to leave anytime.");
    expect(booked[0].bot_name).toBe("Avery");
    // His portrait is the bot's camera: a 1280x720 JPEG.
    expect(booked[0].automatic_video_output.in_call_recording.kind).toBe("jpeg");
    const jpeg = Buffer.from(booked[0].automatic_video_output.in_call_recording.b64_data, "base64");
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(jpeg.length).toBeLessThan(1_300_000);
    const sharp = (await import("sharp")).default;
    expect(await sharp(jpeg).metadata()).toMatchObject({ width: 1280, height: 720 });
    await expect(c.coo.setJoin({ organizationId: orgId, id: session.id, choice: "join" })).rejects.toThrow(/never joins/);

    // The meeting happens: pretend it started already, then follow the bot through to notes.
    await db.updateNotetaker(demo.id, orgId, { startsAt: new Date(Date.now() - 40 * 60_000), endsAt: new Date(Date.now() - 5 * 60_000) });
    routes.unshift([/recall\.ai\/api\/v1\/bot\/bot-1\/$/, () => json({ id: "bot-1", status_changes: [{ code: "in_call_recording" }, { code: "call_ended" }, { code: "done" }], recordings: [{ id: "rec-1", status: { code: "done" } }] })]);
    routes.unshift([/recording\/rec-1\/create_transcript\//, () => json({ id: "tr-1" })]);
    await notetaker.followBots(orgId);
    expect((await db.getNotetaker(demo.id, orgId))!.transcriptId).toBe("tr-1");

    routes.unshift([/recall\.ai\/api\/v1\/transcript\/tr-1\//, () => json({ id: "tr-1", status: { code: "done" }, data: { download_url: "https://files.recall.ai/tr-1.json" } })]);
    routes.unshift([/files\.recall\.ai\/tr-1\.json/, () => json([{ participant: { name: "Lauren Pierce" }, words: [{ text: "We", end_timestamp: { relative: 1 } }, { text: "start", end_timestamp: { relative: 2 } }, { text: "Nov 1.", end_timestamp: { relative: 1900 } }] }, { participant: { name: "Ashley Bryant" }, words: [{ text: "Jada", end_timestamp: { relative: 1910 } }, { text: "sends", end_timestamp: { relative: 1911 } }, { text: "the trial link.", end_timestamp: { relative: 1920 } }] }])]);
    routes.unshift([/bot\/bot-1\/delete_media\//, () => json({})]);
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "meeting_notes") return { summary: "Riverbend starts a trial Nov 1.", decisions: ["Start the trial on 11/01/2026."], questions: [], items: [{ text: "Send the trial link", owner: "Jada", due: "10/07/2026" }, { text: "Schedule the import call", owner: "Ashley", due: "" }] } as any;
      return {} as any;
    });
    await notetaker.followBots(orgId);

    const done = await notetaker.notesOne(orgId, demo.id);
    expect(done.status).toBe("ready");
    expect(done.heldMinutes).toBe(32);
    expect(done.summary?.summary).toMatch(/trial/);
    expect(done.actionItems.map((i) => [i.owner, i.ownerKind, i.due])).toEqual([["Jada", "outreach", "10/07/2026"], ["Ashley", null, null]]);
    expect(done.mediaDeletedAt).toBeTruthy();
    expect(calls.some((x) => /delete_media/.test(x.url))).toBe(true);
    const tr = await c.coo.transcript({ organizationId: orgId, id: demo.id });
    expect(tr.transcript).toMatch(/^Lauren Pierce: We start Nov 1\.\nAshley Bryant: Jada sends the trial link\./);
    const simone = await db.getEmployeeByKind(orgId, "coo");
    const msgs = await db.listChatMessages(orgId, simone!.id, 5);
    expect(msgs.some((m) => (m.cards ?? "").includes("meeting_notes") && /^Avery sat in on Demo: Riverbend Counseling and sent me the notes/.test(m.content))).toBe(true);
    const avery = await db.getEmployeeByKind(orgId, "inbox");
    const mine = await db.listChatMessages(orgId, avery!.id, 5);
    expect(mine.some((m) => /sent the notes to Simone/.test(m.content))).toBe(true);
  });

  it("cancels a booked bot when you press Skip, and every bot when Avery is paused; a key saved in one workspace serves every workspace", async () => {
    const { orgId, owner } = await makeWorkspace("notetaker-skip");
    // No server key: the key LeadDash saved in another workspace is the one every workspace uses.
    process.env.RECALL_API_KEY = "";
    integrations.forgetRecallKey();
    const other = await makeWorkspace("notetaker-keyhome");
    await db.upsertExternalConnection({ organizationId: other.orgId, provider: "recall", accountLabel: "Recall.ai", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ apiKey: "recall-key-1234567890abcdef" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    expect(await integrations.recallConnected(orgId)).toBe(true);
    const a = await db.createNotetaker({ organizationId: orgId, eventId: "e1", title: "Board prep", startsAt: new Date(Date.now() + 3 * 3600_000), endsAt: new Date(Date.now() + 4 * 3600_000), platform: "meet", meetingUrl: "https://meet.google.com/abc-defg-hij", status: "scheduled", botId: "bot-a" });
    const b = await db.createNotetaker({ organizationId: orgId, eventId: "e2", title: "Sales check-in", startsAt: new Date(Date.now() + 5 * 3600_000), endsAt: new Date(Date.now() + 6 * 3600_000), platform: "zoom", meetingUrl: "https://zoom.us/j/1", status: "scheduled", botId: "bot-b" });
    routes.push([/recall\.ai\/api\/v1\/bot\/bot-[ab]\/$/, () => json({})]);
    const c = caller(owner);
    const skipped = await c.coo.setJoin({ organizationId: orgId, id: a.id, choice: "skip" });
    expect(skipped.status).toBe("skipped");
    expect(skipped.botId).toBeNull();
    expect(calls.some((x) => /bot-a\/$/.test(x.url) && x.init.method === "DELETE")).toBe(true);
    expect(calls.find((x) => /bot-a\/$/.test(x.url))!.init.headers.authorization).toBe("recall-key-1234567890abcdef");
    await notetaker.cancelAll(orgId);
    expect(calls.some((x) => /bot-b\/$/.test(x.url) && x.init.method === "DELETE")).toBe(true);
    expect((await db.getNotetaker(b.id, orgId))!.status).toBe("skipped");
    integrations.forgetRecallKey();
  });
  it("follows Avery: pausing Avery cancels booked bots, pausing Simone does not", async () => {
    const { orgId } = await makeWorkspace("notetaker-pause");
    await db.upsertExternalConnection({ organizationId: orgId, provider: "recall", accountLabel: "Recall.ai", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ apiKey: "recall-key-1234567890abcdef" }), connectedAt: new Date(), lastCheckedAt: new Date() });
    const a = await db.createNotetaker({ organizationId: orgId, eventId: "p1", title: "Partner call", startsAt: new Date(Date.now() + 3 * 3600_000), endsAt: new Date(Date.now() + 4 * 3600_000), platform: "meet", meetingUrl: "https://meet.google.com/abc-defg-hij", status: "scheduled", botId: "bot-p" });
    routes.push([/recall\.ai\/api\/v1\/bot\/bot-p\/$/, () => json({})]);
    const { cooTick } = await import("./employees/coo");
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    await db.updateEmployee(simone.id, orgId, { status: "paused" });
    await cooTick(orgId).catch(() => null);
    expect((await db.getNotetaker(a.id, orgId))!.botId).toBe("bot-p");
    await db.updateEmployee(avery.id, orgId, { status: "paused" });
    await cooTick(orgId).catch(() => null);
    expect((await db.getNotetaker(a.id, orgId))!.botId).toBeNull();
  });
});
