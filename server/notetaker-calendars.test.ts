import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as calendars from "./employees/calendars";
import * as notetaker from "./employees/notetaker";
import { encryptJson } from "./_core/crypto";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };

beforeEach(() => {
  calls = [];
  routes = [];
  process.env.GOOGLE_CLIENT_ID = "g-id";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
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

async function mockAi(decision: any) {
  const llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => (opts.schemaName === "chat_decision" ? ({ ...blank, ...decision } as any) : ({} as any)));
}

const at = (min: number) => new Date(Date.now() + min * 60_000);
const iso = (min: number) => at(min).toISOString();

/** Recall.ai connected, and two Google accounts added under Calendars (no main Google connection). */
async function connect(orgId: number) {
  await db.upsertExternalConnection({ organizationId: orgId, provider: "recall", accountLabel: "Recall.ai", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ apiKey: "recall-key-1234567890abcdef" }), connectedAt: new Date(), lastCheckedAt: new Date() });
  routes.push([/recall\.ai\/api\/v1\/bot\/$/, (_u, init) => (init.method === "POST" ? json({ id: `bot-${calls.filter((c) => /bot\/$/.test(c.url) && c.init.method === "POST").length}` }) : json({}))]);
  let who = "leaddash";
  routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: `tok-${who}`, refresh_token: `ref-${who}`, expires_in: 3600 })]);
  routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: who === "leaddash" ? "ashley@leaddash.io" : "ashley@legacyfs.org" })]);
  routes.push([/calendarList/, (_u, init) => json({ items: init.headers.authorization === "Bearer tok-leaddash" ? [{ id: "ashley@leaddash.io", summary: "Ashley Bryant", primary: true }, { id: "webinars@group", summary: "Webinars" }] : [{ id: "ashley@legacyfs.org", summary: "Ashley Bryant", primary: true }] })]);
  const ld = await calendars.finishLink(orgId, "code1", { purpose: "calendar", name: "LeadDash" });
  who = "legacy";
  const lg = await calendars.finishLink(orgId, "code2", { purpose: "calendar", name: "Legacy Family Services" });
  calendars.saveCalendar(orgId, ld.id, { name: "LeadDash", include: ["ashley@leaddash.io", "webinars@group"], detail: "full", holds: "default" });
  return { ld, lg };
}

describe("Avery reads every calendar on Integrations for meetings to sit in on", () => {
  it("finds meetings on an extra Google account and a second calendar, and leaves busy-only calendars alone", async () => {
    const { orgId } = await makeWorkspace("nt-cals");
    const { lg } = await connect(orgId);
    routes.unshift([/calendars\/ashley%40leaddash\.io\/events/, () => json({ items: [{ id: "ev-main", summary: "Board prep", start: { dateTime: iso(180) }, end: { dateTime: iso(240) }, hangoutLink: "https://meet.google.com/aaa-bbbb-ccc", organizer: { self: true } }] })]);
    routes.unshift([/calendars\/webinars%40group\/events/, () => json({ items: [{ id: "ev-web", summary: "Webinar run-through", start: { dateTime: iso(300) }, end: { dateTime: iso(330) }, location: "https://zoom.us/j/555", organizer: { self: true } }] })]);
    routes.unshift([/calendars\/ashley%40legacyfs\.org\/events/, () => json({ items: [{ id: "ev-legacy", summary: "Supervision", start: { dateTime: iso(400) }, end: { dateTime: iso(460) }, hangoutLink: "https://meet.google.com/ddd-eeee-fff", organizer: { self: true } }] })]);

    await notetaker.syncCalendar(orgId, new Date(), true);
    let view = await notetaker.notetakerView(orgId);
    expect(view.upcoming.map((r) => [r.title, r.status])).toEqual([["Board prep", "scheduled"], ["Webinar run-through", "scheduled"], ["Supervision", "scheduled"]]);
    expect(calls.some((c) => /calendars\/primary\/events/.test(c.url))).toBe(false);

    // Legacy set to busy times only: its links are hidden, so its meeting leaves the list and the status says why.
    calendars.saveCalendar(orgId, lg.id, { name: "Legacy Family Services", include: ["ashley@legacyfs.org"], detail: "busy", holds: "no" });
    await notetaker.syncCalendar(orgId, new Date(), true);
    view = await notetaker.notetakerView(orgId);
    expect(view.upcoming.map((r) => r.title)).toEqual(["Board prep", "Webinar run-through"]);
    const status = await notetaker.notetakerStatus(orgId);
    expect(status).toMatch(/Sitting in next: Board prep/);
    expect(status).toMatch(/Legacy Family Services is set to busy times only, which hides meeting links/);
  });

  it("explains why a meeting isn't being joined: no Recall.ai, no link, a busy-only calendar, or nothing at that time", async () => {
    const { orgId, owner } = await makeWorkspace("nt-explain");
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    const c = caller(owner);

    await mockAi({ action: "sitting_in", target: "11am" });
    let r = await c.chat.send({ organizationId: orgId, employeeId: simone.id, text: "are you joining the 11am meeting to take notes?" });
    expect(r.reply.content).toBe("Avery is not joining any meetings right now: Recall.ai isn't connected on Integrations. Connect it there and Avery will start sitting in.");

    const { lg } = await connect(orgId);
    // An 11:00 AM meeting tomorrow with no Zoom or Meet link, a locked session, and a Zoom meeting on the busy-only calendar.
    const tz = (await db.getOrganizationById(orgId))!.timezone || "America/Chicago";
    const tomorrow = new Date(Date.now() + 86_400_000);
    const ymd = tomorrow.toLocaleDateString("en-CA", { timeZone: tz });
    const { zonedToUtc } = await import("./employees/schedule");
    const [y, m, d] = ymd.split("-").map(Number);
    const eleven = zonedToUtc(y, m, d, 11, 0, tz);
    const noon = zonedToUtc(y, m, d, 12, 0, tz);
    const two = zonedToUtc(y, m, d, 14, 0, tz);
    routes.unshift([/calendars\/ashley%40leaddash\.io\/events/, () => json({ items: [
      { id: "ev-11", summary: "Payer contract review", start: { dateTime: eleven.toISOString() }, end: { dateTime: noon.toISOString() }, description: "Dial in: https://webex.example/join/1", organizer: { self: true } },
      { id: "ev-12", summary: "Client session", start: { dateTime: noon.toISOString() }, end: { dateTime: new Date(noon.getTime() + 3600_000).toISOString() }, location: "https://zoom.us/j/1" },
    ] })]);
    routes.unshift([/calendars\/webinars%40group\/events/, () => json({ items: [] })]);
    routes.unshift([/calendars\/ashley%40legacyfs\.org\/events/, () => json({ items: [{ id: "ev-2", summary: "Supervision", start: { dateTime: two.toISOString() }, end: { dateTime: new Date(two.getTime() + 3600_000).toISOString() }, location: "https://zoom.us/j/2" }] })]);
    calendars.saveCalendar(orgId, lg.id, { name: "Legacy Family Services", include: ["ashley@legacyfs.org"], detail: "busy", holds: "no" });

    r = await c.chat.send({ organizationId: orgId, employeeId: simone.id, text: "are you joining the 11am meeting to take notes?" });
    expect(r.reply.content).toMatch(/^Payer contract review \(.* at 11:00 AM, on LeadDash\) has no Zoom, Google Meet or Teams link, so Avery can't join it\. Add the link to the event and Avery will pick it up within 10 minutes\.$/);

    await mockAi({ action: "sitting_in", target: "12pm" });
    r = await c.chat.send({ organizationId: orgId, employeeId: avery.id, text: "are you in my noon?" });
    expect(r.reply.content).toMatch(/^No\. Client session \(.* at 12:00 PM\) has the word "session", so I never join it\./);

    await mockAi({ action: "sitting_in", target: "2pm" });
    r = await c.chat.send({ organizationId: orgId, employeeId: avery.id, text: "are you joining my 2pm?" });
    expect(r.reply.content).toMatch(/^Your .* at 2:00 PM is on Legacy Family Services, which is set to busy times only, so I can only see that you're booked/);

    await mockAi({ action: "join_or_skip", target: "4pm", to: "join" });
    r = await c.chat.send({ organizationId: orgId, employeeId: simone.id, text: "join my 4pm" });
    expect(r.reply.content).toMatch(/^Avery doesn't see anything at 4:00 PM in the next two days on the calendars Avery checks \(LeadDash, Legacy Family Services\)\. Legacy Family Services is set to busy times only/);
  });

  it("never opens Google Calendar in a browser: Simone reads the calendars through Integrations", async () => {
    const { orgId, owner } = await makeWorkspace("nt-browse");
    await connect(orgId);
    routes.unshift([/\/events\?timeMin/, () => json({ items: [{ id: "x", summary: "Leadership huddle", start: { dateTime: iso(90) }, end: { dateTime: iso(120) } }] })]);
    const simone = (await db.getEmployeeByKind(orgId, "coo"))!;
    const web = await import("./employees/web");
    const spy = vi.spyOn(web, "startWebTask");
    await mockAi({ action: "browse", goal: "Open Google Calendar and read what is on the calendar today", title: "Check calendar", url: "https://calendar.google.com" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: simone.id, text: "Check what's on my calendar" });
    expect(spy).not.toHaveBeenCalled();
    expect(r.reply.content).toMatch(/has (one thing|\d+ things)|is open on/);
    expect(JSON.parse(r.reply.cards!)[0].type).toBe("schedule");
    expect(calls.some((c) => /accounts\.google\.com/.test(c.url))).toBe(false);
  });
});
