import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as coo from "./employees/coo";
import * as team from "./team";
import * as calendars from "./employees/calendars";
import { pingsFor } from "./notify";
import { encryptJson } from "./_core/crypto";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const blank = { reply: "", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const systems: string[] = [];

beforeEach(() => {
  calls = [];
  routes = [];
  systems.length = 0;
  integrations.setPollMs(0);
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

async function mockAi(decisions: any[]) {
  const llm = await import("./_core/llm");
  let n = 0;
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName !== "chat_decision") return {} as any;
    systems.push(opts.system);
    return { ...blank, ...decisions[Math.min(n++, decisions.length - 1)] } as any;
  });
}

async function connect(orgId: number, provider: "google_workspace" | "zoom") {
  await db.upsertExternalConnection({ organizationId: orgId, provider, accountLabel: provider, status: "connected", settings: "{}", secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
}
const ymd = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("Simone and the meetings she set up", () => {
  it("knows a booked meeting and its link, sends the link to Caroline in a DM, and says it is a Google Meet link when a Zoom link is asked for", async () => {
    const { orgId, owner } = await makeWorkspace("mtg-link");
    const caroline = await makeUser("caroline@mtg-link.test", "user", "Caroline Jones");
    await db.addOrganizationMember({ organizationId: orgId, userId: caroline.id, role: "member" });
    await connect(orgId, "google_workspace");
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    await mockAi([{ action: "share_meeting", target: "huddle", to: "Caroline", reply: "Sending it." }]);
    const m = await coo.scheduleMeeting(orgId, { title: "Nov Launch Team Huddle", date: ymd(2), time: "10:00 AM", minutes: 60, attendees: "Caroline", updatesFrom: [] });
    await db.updateMeeting(m.id, orgId, { status: "invited", link: "https://meet.google.com/abc-defg-hij", calendarEventId: "ev1", inviteSentAt: new Date() });

    const before = pingsFor(caroline.id, 0).latest;
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "send the link to the zoom meeting to Caroline in a DM and give me the link too here" });

    // She was told about the meeting, its state and its link, and that new meetings get Google Meet links.
    expect(systems[0]).toMatch(/Nov Launch Team Huddle: .* at 10:00 AM, 60 min, with Caroline Jones; invites sent, on the calendar; Google Meet link https:\/\/meet\.google\.com\/abc-defg-hij\./);
    expect(systems[0]).toContain("new meetings get a Google Meet link");
    expect(systems[0]).toContain("Zoom is NOT connected on Integrations");

    // The link went to Caroline in the direct messages between the owner and her, from Simone, and she was told.
    expect(r.reply.content).toMatch(/^Sent it to Caroline Jones in your direct messages\. Nov Launch Team Huddle, .* at 10:00 AM \(60 min\)\. Google Meet link: https:\/\/meet\.google\.com\/abc-defg-hij$/);
    const dm = await team.messages(orgId, owner.id, team.dmKey(owner.id, caroline.id));
    expect(dm.messages.map((x) => [x.authorName, x.employeeId])).toEqual([["Simone", simone.id]]);
    expect(dm.messages[0].content).toContain("Google Meet link: https://meet.google.com/abc-defg-hij");
    expect(pingsFor(caroline.id, before).pings.map((p) => [p.title, p.url])).toEqual([["Simone", `/chats/team/${team.dmKey(owner.id, caroline.id)}`]]);
  });

  it("sends the invite from chat (never through Approvals), and refuses a Zoom switch plainly when Zoom isn't connected", async () => {
    const { orgId, owner } = await makeWorkspace("mtg-invite");
    await connect(orgId, "google_workspace");
    routes.push([/calendar\/v3\/calendars\/primary\/events\?sendUpdates=all&conferenceDataVersion=1/, () => json({ id: "ev1", htmlLink: "https://calendar.google.com/e/1", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } })]);
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    await mockAi([{ action: "send_invite", target: "", reply: "Sending the invite." }]);
    const m = await coo.scheduleMeeting(orgId, { title: "Nov Launch Team Huddle", date: ymd(2), time: "10:00 AM", minutes: 60, attendees: "", updatesFrom: [] });
    expect(m.status).toBe("draft");

    let r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "send invite" });
    expect(r.reply.content).toBe("Sent the invite for Nov Launch Team Huddle to 2 people. Google Meet link: https://meet.google.com/abc-defg-hij");
    expect((await db.getMeeting(m.id, orgId))!.status).toBe("invited");
    expect(JSON.parse(r.reply.cards!)[0]).toMatchObject({ type: "meeting_agenda", id: m.id, status: "invited" });

    await mockAi([{ action: "switch_link", target: "huddle", to: "zoom", reply: "Switching it." }]);
    r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "make it a zoom" });
    expect(r.reply.content).toBe("Zoom isn't connected on Integrations, so I can't make a Zoom link. Connect it there and ask again.");
    expect((await db.getMeeting(m.id, orgId))!.linkKind).toBe("meet");
  });
});

describe("Zoom permissions", () => {
  it("names the missing create-meeting scope when Zoom was approved without it, and remembers it for Integrations", async () => {
    const { orgId, owner } = await makeWorkspace("zoom-scope");
    await connect(orgId, "google_workspace");
    await connect(orgId, "zoom");
    routes.push([/calendar\/v3\/calendars\/primary\/events\?sendUpdates=all&conferenceDataVersion=1/, () => json({ id: "ev1", htmlLink: "https://calendar.google.com/e/1", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } })]);
    routes.push([/api\.zoom\.us\/v2\/users\/me\/meetings/, () => json({ code: 4711, message: "Invalid access token, does not contain scopes:[meeting:write:meeting, meeting:write:meeting:admin]." }, 400)]);
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    await mockAi([{ action: "switch_link", target: "huddle", to: "zoom", reply: "Switching it." }]);
    const m = await coo.scheduleMeeting(orgId, { title: "Nov Launch Team Huddle", date: ymd(2), time: "10:00 AM", minutes: 60, attendees: "", updatesFrom: [] });
    await db.updateMeeting(m.id, orgId, { status: "invited", link: "https://meet.google.com/abc-defg-hij", calendarEventId: "ev1" });

    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "make it a zoom" });
    expect(r.reply.content).toBe(integrations.ZOOM_NO_CREATE);
    expect(r.reply.content).toContain("meeting:write:meeting");
    // The connection remembers it, so Integrations can say so and the next try doesn't call Zoom at all.
    expect(JSON.parse((await db.getConnectionByProvider(orgId, "zoom"))!.settings || "{}").canCreateMeetings).toBe(false);
    expect(await integrations.zoomCanCreate(orgId)).toBe(false);
    const before = calls.length;
    await expect(integrations.createZoomMeeting(orgId, { topic: "x", start: new Date(), minutes: 30, tz: "America/Chicago", agenda: "" })).rejects.toThrow(integrations.ZOOM_NO_CREATE);
    expect(calls.length).toBe(before);
    // From then on her facts carry the same sentence, so she answers it without trying again.
    expect(systems[0]).toContain("Zoom is connected.");
    await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "why no zoom link?" });
    expect(systems[1]).toContain(integrations.ZOOM_NO_CREATE);
  });

  it("reads the granted scopes when Zoom connects", () => {
    expect(integrations.zoomScopesCreate(["user:read:user", "meeting:read:meeting"])).toBe(false);
    expect(integrations.zoomScopesCreate(["user:read:user", "meeting:write:meeting"])).toBe(true);
    expect(integrations.zoomScopesCreate(["meeting:write:admin"])).toBe(true);
  });
});

describe("Reading the calendars", () => {
  it("always reads the main Google calendar, where sent invites land, and shows an event once when that account is also added under Calendars", async () => {
    const { orgId } = await makeWorkspace("cal-main");
    await connect(orgId, "google_workspace");
    const from = new Date(Date.now() + 86_400_000);
    const to = new Date(from.getTime() + 86_400_000);
    const ev = { id: "ev-huddle", summary: "Nov Launch Team Huddle", start: { dateTime: new Date(from.getTime() + 3600_000).toISOString() }, end: { dateTime: new Date(from.getTime() + 7200_000).toISOString() } };
    routes.push([/calendars\/primary\/events/, () => json({ items: [ev] })]);
    // No extra calendars yet: the main calendar is the one source.
    let s = await calendars.schedule(orgId, from, to);
    expect(s.sources).toBe(1);
    expect(s.events.map((e) => [e.title, e.calendar])).toEqual([["Nov Launch Team Huddle", "Google Calendar"]]);

    // The same account added under Calendars: the invite shows once, under that calendar's name, and the main read adds nothing.
    db.createAccountLink({ organizationId: orgId, purpose: "calendar", kind: "google", name: "LeadDash", email: "ashley@leaddash.io", status: "connected", color: "#1a73e8", calendars: JSON.stringify([{ id: "ashley@leaddash.io", name: "Ashley", include: true, primary: true }]), detail: "full", holds: "default", secretsEncrypted: encryptJson({ accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 3600_000 }) });
    routes.unshift([/calendars\/ashley%40leaddash\.io\/events/, () => json({ items: [ev] })]);
    s = await calendars.schedule(orgId, from, to);
    expect(s.sources).toBe(1);
    expect(s.events.map((e) => [e.title, e.calendar])).toEqual([["Nov Launch Team Huddle", "LeadDash"]]);

    // A different account under Calendars: both are read, two sources.
    routes.unshift([/calendars\/ashley%40leaddash\.io\/events/, () => json({ items: [{ ...ev, id: "ev-other", summary: "Supervision" }] })]);
    s = await calendars.schedule(orgId, from, to);
    expect(s.sources).toBe(2);
    expect(s.events.map((e) => [e.title, e.calendar]).sort()).toEqual([["Nov Launch Team Huddle", "Google Calendar"], ["Supervision", "LeadDash"]]);
  });
});
