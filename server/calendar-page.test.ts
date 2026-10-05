import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as calendars from "./employees/calendars";
import { encryptJson } from "./_core/crypto";

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let routes: [RegExp, (url: string, init: any) => any][] = [];
let calls: string[] = [];

beforeEach(() => {
  routes = [];
  calls = [];
  process.env.GOOGLE_CLIENT_ID = "g-id";
  process.env.GOOGLE_CLIENT_SECRET = "g-secret";
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push(String(url));
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return json({ error: "no route " + url }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EVENTS = [
  { id: "ev1", summary: "Leadership huddle", start: { dateTime: "2026-10-05T09:00:00-05:00" }, end: { dateTime: "2026-10-05T09:30:00-05:00" }, organizer: { self: true } },
  {
    id: "ev2",
    summary: "Demo: Obsidian Therapy Group",
    start: { dateTime: "2026-10-05T11:00:00-05:00" },
    end: { dateTime: "2026-10-05T11:45:00-05:00" },
    location: "https://us02web.zoom.us/j/81234567890",
    organizer: { self: true },
    attendees: [{ email: "ashley@leaddash.io", self: true }, { email: "tamara@obsidian.test", displayName: "Tamara Ferebee" }],
  },
  { id: "ev3", summary: "HR2026 starts", start: { date: "2026-10-14" }, end: { date: "2026-10-15" } },
];

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  const conn = (provider: any) => db.upsertExternalConnection({ organizationId: ws.orgId, provider, accountLabel: provider, status: "connected", settings: "{}", secretsEncrypted: encryptJson({ accessToken: "t" }), connectedAt: new Date(), lastCheckedAt: new Date() });
  await conn("google_workspace");
  await conn("zoom");
  routes.push([/calendars\/primary\/events/, () => json({ items: EVENTS })]);
  return ws;
}

describe("Calendar page", () => {
  it("shows events with their meeting link, tasks due, and the AI team's work on one week starting Sunday", async () => {
    const { orgId, owner } = await setup("calpage");
    const launch = await db.createLaunch({ organizationId: orgId, name: "AI Employees launch", launchDate: new Date("2026-11-01T12:00:00Z"), status: "active" });
    await db.createLaunchTask({ organizationId: orgId, launchId: launch.id, title: "Landing page copy", ownerType: "person", ownerName: "Caroline", dueDate: new Date("2026-10-07T17:00:00Z") });
    const nora = (await db.getEmployeeByKind(orgId, "projects"))!;
    await db.createScheduledTask({ organizationId: orgId, employeeId: nora.id, title: "Weekly status report", instructions: "Write the weekly status report.", repeat: "weekly", weekday: 5, time: "10:00", enabled: true });

    const r = await caller(owner).calendar.range({ organizationId: orgId, from: "2026-10-04", days: 7 });
    const demo = r.items.find((i) => i.title === "Demo: Obsidian Therapy Group")!;
    expect(demo).toMatchObject({ kind: "event", allDay: false, host: true, meeting: { platform: "zoom", url: "https://us02web.zoom.us/j/81234567890" }, guests: ["Tamara Ferebee"] });
    expect(r.items.find((i) => i.title === "Landing page copy")).toMatchObject({ kind: "task", source: "tasks", allDay: true, who: "Caroline" });
    const status = r.items.find((i) => i.kind === "team" && /Weekly status report/.test(i.title))!;
    expect(status.title).toBe(`${nora.name}: Weekly status report`);
    expect(new Date(status.start).toISOString()).toBe("2026-10-09T05:00:00.000Z"); // Friday, Oct 9, 2026, midnight Central
    expect(r.sources.map((s) => s.name)).toEqual(["Google Calendar", "Tasks and deadlines", "Team work"]);
    // HR2026 is outside this week.
    expect(r.items.some((i) => i.title === "HR2026 starts")).toBe(false);
  });

  it("hides names, links and guests on a busy-times-only calendar", async () => {
    const { orgId, owner } = await makeWorkspace("calbusy");
    routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: "tok-legacy", refresh_token: "ref", expires_in: 3600 })]);
    routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: "ashley@legacyfs.org" })]);
    routes.push([/calendarList/, () => json({ items: [{ id: "ashley@legacyfs.org", summary: "Ashley", primary: true }] })]);
    const lg = await calendars.finishLink(orgId, "code", { purpose: "calendar", name: "Legacy" });
    calendars.saveCalendar(orgId, lg.id, { name: "Legacy", include: ["ashley@legacyfs.org"], detail: "busy", holds: "no" });
    routes.unshift([/calendars\/ashley%40legacyfs\.org\/events/, () => json({ items: [{ id: "s1", summary: "Session with J.R.", location: "https://us02web.zoom.us/j/99999999999", attendees: [{ email: "jr@client.test" }], start: { dateTime: "2026-10-05T13:00:00-05:00" }, end: { dateTime: "2026-10-05T14:00:00-05:00" } }] })]);
    const r = await caller(owner).calendar.range({ organizationId: orgId, from: "2026-10-05", days: 1 });
    const busy = r.items.find((i) => i.kind === "event")!;
    expect(busy).toMatchObject({ title: "Busy", busy: true, meeting: null, guests: [], location: "" });
    expect(JSON.stringify(r)).not.toMatch(/J\.R\.|jr@client|99999999999/);
  });

  it("gives the next meeting, and Start on Zoom opens the host link for the owner only", async () => {
    const { orgId, owner } = await setup("calnext");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T15:48:00Z")); // 10:48 AM Central
    try {
      const n = await caller(owner).calendar.next({ organizationId: orgId });
      expect(n.meeting).toMatchObject({ title: "Demo: Obsidian Therapy Group", host: true, meeting: { platform: "zoom" } });
    } finally {
      vi.useRealTimers();
    }
    routes.unshift([/api\.zoom\.us\/v2\/meetings\/81234567890/, () => json({ id: 81234567890, start_url: "https://us02web.zoom.us/s/81234567890?zak=abc" })]);
    const s = await caller(owner).calendar.start({ organizationId: orgId, url: "https://us02web.zoom.us/j/81234567890" });
    expect(s).toEqual({ url: "https://us02web.zoom.us/s/81234567890?zak=abc", started: true });
    // A team member joins instead; Zoom isn't asked.
    const member = await makeUser("caroline@calnext.test", "user", "Caroline");
    await db.addOrganizationMember({ organizationId: orgId, userId: member.id, role: "admin" });
    const before = calls.length;
    const j = await caller(member).calendar.start({ organizationId: orgId, url: "https://us02web.zoom.us/j/81234567890" });
    expect(j).toEqual({ url: "https://us02web.zoom.us/j/81234567890", started: false });
    expect(calls.slice(before).some((u) => /api\.zoom\.us/.test(u))).toBe(false);
    // Anything that isn't a Zoom or Meet link is refused.
    expect(await caller(owner).calendar.start({ organizationId: orgId, url: "https://evil.example/j/81234567890" })).toEqual({ url: null, started: false });
  });

  it("lists who is on what: people and the AI team, with what needs the owner", async () => {
    const { orgId, owner } = await setup("calwho");
    const member = await makeUser("caroline@calwho.test", "user", "Caroline Smith");
    await db.addOrganizationMember({ organizationId: orgId, userId: member.id, role: "admin" });
    const launch = await db.createLaunch({ organizationId: orgId, name: "Launch", launchDate: new Date(Date.now() + 30 * 86_400_000), status: "active" });
    await db.createLaunchTask({ organizationId: orgId, launchId: launch.id, title: "Webinar promo", ownerType: "person", ownerName: "Caroline", status: "in_progress", dueDate: new Date(Date.now() + 10 * 86_400_000) });
    const w = await caller(owner).calendar.who({ organizationId: orgId });
    const caroline = w.rows.find((r) => r.name === "Caroline Smith")!;
    expect(caroline).toMatchObject({ group: "people", role: "Admin", now: "Webinar promo", status: { label: "On track" } });
    expect(w.rows.some((r) => r.group === "people" && r.role === "Reviewer")).toBe(false);
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    expect(w.rows.find((r) => r.key === `e:${avery.id}`)).toMatchObject({ group: "ai", chat: "/chats/inbox", work: "/chats/inbox/work" });
  });
});

describe("Owner's first name", () => {
  it("skips a title like Dr.", async () => {
    const { orgId } = await makeWorkspace("calname");
    const owner = (await db.listMembers(orgId)).find((m) => m.role === "owner")!;
    await db.updateUser(owner.userId, { name: "Dr. Ashley Bryant" });
    expect(await (await import("./employees/desk")).ownerName(orgId)).toBe("Ashley");
  });
});
