import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as calendars from "./employees/calendars";

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

/** Two Google accounts by sign-in (LeadDash, then Legacy) and an iCloud link. */
async function connectAll(orgId: number) {
  let who = "leaddash";
  routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: `tok-${who}`, refresh_token: `ref-${who}`, expires_in: 3600 })]);
  routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: who === "leaddash" ? "ashley@leaddash.io" : "ashley@legacyfs.org" })]);
  routes.push([/calendarList/, (_u, init) => json({ items: init.headers.authorization === "Bearer tok-leaddash" ? [{ id: "ashley@leaddash.io", summary: "Ashley Bryant", primary: true }, { id: "webinars@group", summary: "Webinars" }] : [{ id: "ashley@legacyfs.org", summary: "Ashley Bryant", primary: true }] })]);
  const ld = await calendars.finishLink(orgId, "code1", { purpose: "calendar", name: "LeadDash" });
  who = "legacy";
  const lg = await calendars.finishLink(orgId, "code2", { purpose: "calendar", name: "Legacy Family Services" });
  routes.push([/icloud\.example\/cal\.ics/, () => new Response("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART;TZID=America/Chicago:20261001T173000\r\nDTEND;TZID=America/Chicago:20261001T183000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nSUMMARY:Dinner with BJ\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", { status: 200 })]);
  await calendars.saveLink(orgId, { name: "Personal", url: "webcal://icloud.example/cal.ics" });
  return { ld, lg };
}

describe("Avery's calendars", () => {
  it("connects several Google accounts and a calendar link; the first takes holds, the link never does", async () => {
    const { orgId, owner } = await makeWorkspace("cals");
    const { ld, lg } = await connectAll(orgId);
    expect(ld).toMatchObject({ name: "LeadDash", email: "ashley@leaddash.io", holds: "default" });
    expect(calendars.calendarsOf(ld)).toEqual([
      { id: "ashley@leaddash.io", name: "Ashley Bryant", primary: true, include: true },
      { id: "webinars@group", name: "Webinars", primary: false, include: false },
    ]);
    expect(lg.holds).toBe("yes");
    expect(lg.secretsEncrypted).not.toContain("tok-legacy");
    const v = await caller(owner).accounts.list({ organizationId: orgId });
    expect(v.calendars.map((c) => [c.name, c.kind, c.holds])).toEqual([["LeadDash", "google", "default"], ["Legacy Family Services", "google", "yes"], ["Personal", "link", "no"]]);
    expect(new Set(v.calendars.map((c) => c.color)).size).toBe(3);
    expect(JSON.stringify(v)).not.toMatch(/tok-|icloud\.example/);
    // Legacy: busy times only, never holds.
    await caller(owner).accounts.saveCalendar({ organizationId: orgId, id: lg.id, name: "Legacy Family Services", include: ["ashley@legacyfs.org"], detail: "busy", holds: "no" });
    // A bad link is refused before it's saved.
    routes.unshift([/bad\.example/, () => new Response("<html>nope</html>", { status: 200 })]);
    await expect(caller(owner).accounts.saveLink({ organizationId: orgId, name: "Bad", url: "https://bad.example/x" })).rejects.toThrow(/didn't open as a calendar/);
  });

  it("lists every calendar together for a day, hides event names on a busy-only calendar, and calls out the overlap", async () => {
    const { orgId, owner } = await makeWorkspace("calsday");
    const { lg } = await connectAll(orgId);
    calendars.saveCalendar(orgId, lg.id, { name: "Legacy Family Services", include: ["ashley@legacyfs.org"], detail: "busy", holds: "no" });
    routes.unshift([/calendars\/ashley%40leaddash\.io\/events/, () => json({ items: [
      { summary: "Leadership huddle", start: { dateTime: "2026-10-05T09:00:00-05:00" }, end: { dateTime: "2026-10-05T09:30:00-05:00" } },
      { summary: "Demo: Obsidian Therapy Group", start: { dateTime: "2026-10-05T11:00:00-05:00" }, end: { dateTime: "2026-10-05T11:45:00-05:00" } },
    ] })]);
    routes.unshift([/calendars\/ashley%40legacyfs\.org\/events/, () => json({ items: [{ summary: "Session with J.R.", start: { dateTime: "2026-10-05T11:00:00-05:00" }, end: { dateTime: "2026-10-05T12:00:00-05:00" } }] })]);
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    await mockAi({ action: "check_schedule", date: "2026-10-05", count: 1 });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "What does my day look like tomorrow?" });
    expect(r.reply.content).toMatch(/^Monday, October 5, 2026 has 4 things across 3 calendars\. Two of them overlap: Demo: Obsidian Therapy Group on LeadDash and a busy block on Legacy Family Services at 11:00 AM\./);
    const card = JSON.parse(r.reply.cards!)[0];
    expect(card.type).toBe("schedule");
    expect(card.events.map((e: any) => [e.when, e.title, e.calendar, !!e.clash])).toEqual([
      ["9:00 to 9:30 AM", "Leadership huddle", "LeadDash", false],
      ["11:00 to 11:45 AM", "Demo: Obsidian Therapy Group", "LeadDash", true],
      ["11:00 AM to 12:00 PM", "Busy", "Legacy Family Services", true],
      ["5:30 to 6:30 PM", "Dinner with BJ", "Personal", false],
    ]);
    // The client's initials on the busy-only calendar never reach the reply.
    expect(JSON.stringify(r.reply)).not.toContain("J.R.");
  });

  it("puts a hold on the calendar named, refuses one that never takes holds, and adds it there on approval", async () => {
    const { orgId, owner } = await makeWorkspace("calshold");
    const { ld, lg } = await connectAll(orgId);
    calendars.saveCalendar(orgId, lg.id, { name: "Legacy Family Services", include: ["ashley@legacyfs.org"], detail: "busy", holds: "no" });
    routes.unshift([/\/events\?timeMin/, () => json({ items: [] })]);
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    await mockAi({ action: "calendar_hold", title: "Payroll review", date: "2026-10-09", time: "2:00 PM", target: "Legacy" });
    const no = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Put a hold on my Legacy calendar Friday at 2 for payroll review." });
    expect(no.reply.content).toMatch(/Legacy Family Services is set to never take holds/);

    await mockAi({ action: "calendar_hold", title: "Payroll review", date: "2026-10-09", time: "2:00 PM", target: "" });
    const ok = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Put a hold Friday at 2 for payroll review." });
    expect(ok.reply.content).toBe("Fri, Oct 9, 2026 at 2:00 PM is open on all your calendars. The hold for LeadDash is waiting for your OK in Approvals.");
    const item = (await db.listOutboundItemsByOrg(orgId)).find((i) => i.kind === "calendar_hold")!;
    expect(JSON.parse(item.metadata!).linkId).toBe(ld.id);
    routes.unshift([/calendars\/ashley%40leaddash\.io\/events\?sendUpdates=none/, () => json({ htmlLink: "https://calendar.google.com/event?eid=1" })]);
    const res = await integrations.dispatch(item);
    expect(res.results[0]).toMatchObject({ channel: "calendar", ok: true });
    const post = calls.find((c) => /events\?sendUpdates=none/.test(c.url))!;
    expect(post.init.headers.authorization).toBe("Bearer tok-leaddash");
  });
});

describe("sending addresses", () => {
  it("sends Jada's outreach from the outreach address and everyone else from the main account", async () => {
    const { orgId, owner } = await makeWorkspace("senders");
    routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: "tok-outreach", refresh_token: "ref", expires_in: 3600 })]);
    routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: "ashley@tryleaddash.com" })]);
    const link = await calendars.finishLink(orgId, "code", { purpose: "send", name: "Outreach" });
    expect(link).toMatchObject({ email: "ashley@tryleaddash.com", purpose: "send" });
    const v = await caller(owner).accounts.list({ organizationId: orgId });
    expect(v.senders[0].sendsFor).toEqual(["outreach", "leads"]);
    await caller(owner).accounts.saveSender({ organizationId: orgId, id: link.id, name: "Outreach", sendsFor: ["outreach"] });

    routes.push([/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => json({ id: "m1", threadId: "t1" })]);
    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    const item = await db.createOutboundItem({ organizationId: orgId, employeeId: jada.id, kind: "outreach_email", status: "approved", title: "Quick question", body: "Hi Dana,", metadata: JSON.stringify({ email: "dana@practice.example" }) });
    const res = await integrations.dispatch(item);
    expect(res.results[0]).toMatchObject({ channel: "gmail", ok: true });
    expect(calls.find((c) => /messages\/send/.test(c.url))!.init.headers.authorization).toBe("Bearer tok-outreach");
    // Malik was taken off, and there's no main Google account, so his reply waits.
    const malik = (await db.getEmployeeByKind(orgId, "leads"))!;
    const reply = await db.createOutboundItem({ organizationId: orgId, employeeId: malik.id, kind: "lead_reply", status: "approved", title: "Re: demo", body: "Hi,", metadata: JSON.stringify({ email: "x@y.example" }) });
    const r2 = await integrations.dispatch(reply);
    expect(r2.results[0].ok).toBe(false);
  });
});
