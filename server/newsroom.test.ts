import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts: Record<string, string[]> = {};
let scoutData: any = { reporters: [], stories: [], coverage: [] };
let scoutSources: { url: string; title: string }[] = [];
let grades: number[][] = [];
let replyData: any = null;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async (opts: any) => {
      (prompts[opts.schemaName] ??= []).push(`${opts.system}\n${opts.prompt}`);
      return { data: scoutData, queries: ["q"], sources: scoutSources, costUsd: 0 };
    }),
    generateJson: vi.fn(async (opts: any) => {
      (prompts[opts.schemaName] ??= []).push(`${opts.system}\n${opts.prompt}`);
      switch (opts.schemaName) {
        case "desk_profile":
          return { owns: "Product, health tech, AI employees", beats: ["AI in healthcare", "behavioral health technology"] };
        case "press_campaign":
          return { title: "LeadDash Employees launch", goal: "Earned coverage", audience: "Practice owners", story: "Small practices run with AI staff.", founderAngle: "A clinician built it.", proof: "Live demo", beats: ["health tech"], neverSay: "AI replacing therapists", order: "Exclusive first", angles: ["A1", "A2", "A3", "A4", "A5"] };
        case "press_picks":
          return { picks: [{ contactId: 0, angle: 1, why: "fits" }].map(() => ({ contactId: (globalThis as any).__pick, angle: 1, why: "fits" })) };
        case "press_pitch":
          return { subject: "The admin load behind this week's report", body: "Hi Dana, your Sept 22 piece on front-desk turnover ended on who picks up the work. Dr. Ashley Bryant, LPC, CRC" };
        case "press_grade": {
          const g = grades.shift() ?? [20, 20, 15, 15, 10, 10, 5, 5];
          return { scores: g, fixes: "Name the report." };
        }
        case "press_reply":
          return replyData;
        case "press_briefing":
          return { reporter: "Covers Oklahoma startups.", points: ["P1", "P2", "P3"], likely: ["Why software?"], hardQuestions: [{ q: "How do you handle HIPAA?", answerIndex: 0 }], dontClaim: "Customer numbers", where: "Zoom", bio: "Founder bio, 100 words", after: "Send the demo" };
        case "press_calendar":
          return { moments: [{ title: "Holiday stress and family conflict", date: "Dec 1, 2026", pitchBy: new Date(Date.now() + 20 * 86_400_000).toDateString(), lead: "short", angle: "Holiday stress" }, { title: "Made up moment", date: "", pitchBy: "not a date", lead: "short", angle: "" }] };
        default:
          return {};
      }
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as newsroom from "./employees/newsroom";
import * as pitching from "./employees/pitching";
import * as presslib from "./employees/presslib";
import * as calendars from "./employees/calendars";
import { settled } from "./social";

let calls: { url: string; init: any }[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  routes = [];
  grades = [];
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
});

const recent = (days: number) => {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

/** Two workspaces run by the same owner: LeadDash and Legacy. */
async function twoDesks(slug: string) {
  const a = await makeWorkspace(`${slug}a`);
  const b = await makeWorkspace(`${slug}b`);
  await db.addOrganizationMember({ organizationId: b.orgId, userId: a.owner.id, role: "owner" });
  return { a, b, owner: a.owner };
}

async function taylorSends(orgId: number) {
  routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: `tok-${orgId}`, refresh_token: "ref", expires_in: 3600 })]);
  routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: `press${orgId}@tryleaddash.com` })]);
  const link = await calendars.finishLink(orgId, "code", { purpose: "send", name: "Press" });
  calendars.saveSender(orgId, link.id, { name: "Press", sendsFor: ["speaking"] });
  routes.push([/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => json({ id: "m1", threadId: "t1" })]);
}

const DANA = (desks: number[]) => ({
  name: "Dana Whitfield",
  outlet: "Care Ops Daily",
  title: "Senior reporter",
  beats: ["Healthcare operations"],
  location: "",
  email: "dana@careopsdaily.example",
  emailSource: "https://careopsdaily.example/authors/dana",
  authorPage: "https://careopsdaily.example/authors/dana",
  articles: [{ title: "Front desks are the new bottleneck", url: "https://careopsdaily.example/front-desks", date: recent(12), topics: "Staffing" }],
  why: "Four stories on admin automation.",
  profile: { storyType: "Trend analysis", sources: "Clinicians", launches: "Rarely", strongest: "Admin burden", likes: "Data" },
  fit: desks.map((d, i) => ({ deskId: d, score: i === 0 ? 95 : 30 })),
});

describe("Taylor's newsroom", () => {
  it("shares reporters across the owner's desks, keeps only proven reporters, and routes stories to the best desk", async () => {
    const { a, b, owner } = await twoDesks("nr1");
    const c = caller(owner);
    // A desk only links workspaces the person runs.
    const stranger = await makeWorkspace("nr1x");
    await expect(c.newsroom.saveSettings({ organizationId: a.orgId, shared: [stranger.orgId], coolingDays: 21, level: 1, alwaysNeedsYou: "Crisis", stopWords: "Breach, lawsuit" })).rejects.toThrow(/workspaces you run/);
    await c.newsroom.saveSettings({ organizationId: a.orgId, shared: [b.orgId], coolingDays: 21, level: 1, alwaysNeedsYou: "Crisis", stopWords: "Breach, lawsuit" });
    expect(newsroom.newsroomOrgs(a.orgId)).toEqual([a.orgId, b.orgId]);
    expect(newsroom.newsroomOrgs(b.orgId)).toEqual([b.orgId, a.orgId]);

    scoutSources = [{ url: "https://careopsdaily.example/front-desks", title: "x" }, { url: "https://careopsdaily.example/authors/dana", title: "x" }];
    scoutData = {
      reporters: [
        DANA([a.orgId, b.orgId]),
        // An old article only: dropped. A made-up site that never came up in the search: dropped.
        { ...DANA([a.orgId]), name: "Old Byline", articles: [{ title: "Old", url: "https://careopsdaily.example/old", date: "Jan 3, 2024", topics: "" }] },
        { ...DANA([a.orgId]), name: "Invented Person", articles: [{ title: "Fake", url: "https://notsearched.example/x", date: recent(3), topics: "" }] },
        // A guessed email (no public page in the search) is never kept.
        { ...DANA([b.orgId]), name: "Elise Moreau", outlet: "Mindful Living", email: "elise@guess.example", emailSource: "https://unknown.example/contact", fit: [{ deskId: b.orgId, score: 94 }] },
      ],
      stories: [{ title: "National report on clinician admin burden", source: "Industry report", sourceUrl: "https://careopsdaily.example/front-desks", windowEnds: recent(-5), score: 80, bestDeskId: a.orgId, alsoFits: [{ deskId: b.orgId, why: "Workplace angle" }], angle: "Admin burden is infrastructure.", offer: "Founder interview", reporters: ["Dana Whitfield"] }],
      coverage: [],
    };
    const r = await newsroom.scout(a.orgId, { quiet: true });
    expect(r).toMatchObject({ added: 2, stories: 1 });
    expect(prompts.press_scout.at(-1)).toContain(`id ${b.orgId}: Workspace nr1b`);
    // Legacy's desk sees the same reporters.
    const seen = (await caller(owner).newsroom.contacts({ organizationId: b.orgId })).map((x) => [x.name, x.email]);
    expect(seen).toEqual(expect.arrayContaining([["Dana Whitfield", "dana@careopsdaily.example"], ["Elise Moreau", null]]));
    expect(seen.map((x) => x[0])).not.toContain("Old Byline");
    expect(seen.map((x) => x[0])).not.toContain("Invented Person");
    const v = await c.newsroom.view({ organizationId: a.orgId });
    expect(v.stories[0]).toMatchObject({ title: "National report on clinician admin burden", alsoFits: [{ deskId: b.orgId, why: "Workplace angle" }] });
    expect(v.stories[0].reporters.map((x) => x.name)).toEqual(["Dana Whitfield"]);
    expect(v.desks.map((d) => d.id)).toEqual([a.orgId, b.orgId]);
    // A second scout that finds Dana at a new outlet records the move.
    scoutData = { reporters: [{ ...DANA([a.orgId]), outlet: "Health Systems Weekly", articles: [{ title: "New beat", url: "https://careopsdaily.example/new", date: recent(1), topics: "" }] }], stories: [], coverage: [] };
    scoutSources = [{ url: "https://careopsdaily.example/new", title: "x" }];
    const r2 = await newsroom.scout(a.orgId, { quiet: true });
    expect(r2.moved).toBe(1);
    expect(newsroom.contactsFor(a.orgId).find((x) => x.name === "Dana Whitfield")).toMatchObject({ outlet: "Health Systems Weekly", movedFrom: "Care Ops Daily" });
  });

  it("writes campaign pitches, rewrites any under 85, sends on approval from Taylor's address, and cools the reporter for the other desk", async () => {
    const { a, b, owner } = await twoDesks("nr2");
    const c = caller(owner);
    await c.newsroom.saveSettings({ organizationId: a.orgId, shared: [b.orgId], coolingDays: 21, level: 1, alwaysNeedsYou: "Crisis", stopWords: "Breach" });
    await taylorSends(a.orgId);
    scoutSources = [{ url: "https://careopsdaily.example/front-desks", title: "x" }, { url: "https://careopsdaily.example/authors/dana", title: "x" }];
    scoutData = { reporters: [DANA([a.orgId, b.orgId])], stories: [], coverage: [] };
    await newsroom.scout(a.orgId, { quiet: true });
    const dana = newsroom.contactsFor(a.orgId)[0];
    (globalThis as any).__pick = dana.id;

    const camp = await c.newsroom.planCampaign({ organizationId: a.orgId, brief: "The LeadDash Employees launch" });
    expect(camp.angles.map((x) => x.use)).toEqual([true, true, false, false, false]);
    // The first draft scores 70, so it's rewritten before the owner sees it.
    grades = [[10, 10, 10, 10, 10, 10, 5, 5], [20, 18, 14, 13, 9, 9, 5, 4]];
    await pitching.addReporters(a.orgId, camp.id);
    const p = (await c.newsroom.pitches({ organizationId: a.orgId }))[0];
    expect(p).toMatchObject({ status: "ready", score: 92, name: "Dana Whitfield" });
    expect(prompts.press_pitch.length).toBe(2);
    expect(prompts.press_pitch.at(-1)).toContain("It scored 70 of 100. Fix: Name the report.");
    expect(prompts.press_pitch.at(-1)).toContain('"Front desks are the new bottleneck"');
    expect(prompts.press_pitch.at(-1)).toContain("Never fake familiarity");
    // It waits in Approvals as an email from Taylor.
    const item = await db.getOutboundItemForOrg(db.press.pitches.get(p.id, a.orgId)!.itemId!, a.orgId);
    expect(item).toMatchObject({ status: "pending_approval", kind: "email_draft" });

    await c.newsroom.approvePitch({ organizationId: a.orgId, id: p.id });
    await settled();
    const sent = calls.find((x) => /messages\/send/.test(x.url))!;
    expect(sent.init.headers.authorization).toBe(`Bearer tok-${a.orgId}`);
    expect(Buffer.from(JSON.parse(sent.init.body).raw, "base64url").toString("utf8")).toContain("To: dana@careopsdaily.example");
    expect(db.press.pitches.get(p.id, a.orgId)).toMatchObject({ status: "sent" });
    expect(newsroom.contactFor(b.orgId, dana.id)).toMatchObject({ relationship: "contacted", lastContactOrgId: a.orgId });

    // Legacy's desk can't pitch Dana until the cooling period ends; nothing is written.
    const before = prompts.press_pitch.length;
    const cool = await pitching.writePitch(b.orgId, dana.id, { angle: "Burnout" });
    expect(cool.status).toBe("cooling");
    expect(new Date(cool.coolingUntil!).getTime()).toBeGreaterThan(Date.now() + 19 * 86_400_000);
    expect(prompts.press_pitch.length).toBe(before);
  });

  it("sorts a reporter's reply, keeps Do not contact for every desk, books the interview with a briefing, and stops the desk on crisis words", async () => {
    const { a, b, owner } = await twoDesks("nr3");
    const c = caller(owner);
    await c.newsroom.saveSettings({ organizationId: a.orgId, shared: [b.orgId], coolingDays: 21, level: 1, alwaysNeedsYou: "Crisis", stopWords: "Breach, lawsuit" });
    const dana = db.press.contacts.create({ organizationId: a.orgId, name: "Dana Whitfield", outlet: "Care Ops Daily", email: "dana@careopsdaily.example", relationship: "contacted", lastContactOrgId: a.orgId });
    const jordan = db.press.contacts.create({ organizationId: b.orgId, name: "Jordan Lee", outlet: "Tech Monthly", email: "jordan@techmonthly.example", relationship: "contacted" });

    replyData = { kind: "interview", askedFor: "", referralName: "", referralOutlet: "", referralEmail: "", newOutlet: "", proposedTime: new Date(Date.now() + 4 * 86_400_000).toISOString(), draft: "Hi Dana, Thursday at 10:00 AM works." };
    const r1 = await pitching.handleReply(b.orgId, { messageId: "<1@x>", fromEmail: "dana@careopsdaily.example", fromName: "Dana", subject: "Re: The admin load", text: "Yes, can she talk Thursday?" });
    // Dana was pitched by the LeadDash desk, so her answer lands there.
    expect(r1).toMatchObject({ organizationId: a.orgId, kind: "interview", status: "open" });
    expect(newsroom.contactFor(a.orgId, dana.id)?.relationship).toBe("engaged");
    const ivs = await c.newsroom.interviews({ organizationId: a.orgId });
    expect(ivs[0]).toMatchObject({ title: "Dana Whitfield, Care Ops Daily" });
    expect(ivs[0].briefing.points).toEqual(["P1", "P2", "P3"]);
    expect(ivs[0].briefing.hard[0]).toMatchObject({ q: "How do you handle HIPAA?", answer: "", approved: false });
    // Her answer to the hard question is saved to the library for next time.
    await c.newsroom.saveInterview({ organizationId: a.orgId, id: ivs[0].id, title: ivs[0].title, at: "", place: "Zoom", briefing: { ...ivs[0].briefing, hard: [{ q: "How do you handle HIPAA?", answer: "No client records ever reach the AI.", approved: false }] } });
    expect(db.press.library.list(a.orgId).find((x) => x.kind === "answer")).toMatchObject({ text: "No client records ever reach the AI.", approved: true });
    // The same email isn't handled twice.
    expect(await pitching.handleReply(b.orgId, { messageId: "<1@x>", fromEmail: "dana@careopsdaily.example", fromName: "Dana", subject: "Re", text: "again" })).toBeNull();

    replyData = { ...replyData, kind: "dnc", proposedTime: "", draft: "" };
    await pitching.handleReply(a.orgId, { messageId: "<2@x>", fromEmail: "jordan@techmonthly.example", fromName: "Jordan", subject: "Re", text: "Please take me off your list." });
    expect(newsroom.contactFor(a.orgId, jordan.id)?.doNotContact).toBe(true);
    expect((await pitching.writePitch(a.orgId, jordan.id, {})).status).toBe("skipped");

    // Crisis words: the desk stops, nothing is drafted, and Taylor won't send a reply.
    const r3 = await pitching.handleReply(a.orgId, { messageId: "<3@x>", fromEmail: "dana@careopsdaily.example", fromName: "Dana", subject: "Question", text: "Was there a data breach at a practice using LeadDash?" });
    expect(r3).toMatchObject({ kind: "crisis", draft: null });
    expect(newsroom.settingsOf(a.orgId)).toMatchObject({ paused: true });
    await expect(c.newsroom.approveReply({ organizationId: a.orgId, id: r3!.id })).rejects.toThrow(/crisis question yourself/);
    await expect(c.newsroom.scout({ organizationId: a.orgId })).rejects.toThrow(/paused/);
    const taylor = (await db.getEmployeeByKind(a.orgId, "speaking"))!;
    expect((await db.listChatMessages(a.orgId, taylor.id, 5)).pop()!.content).toMatch(/^I stopped all outreach on this desk\. Dana Whitfield asked about breach/);
    await c.newsroom.resume({ organizationId: a.orgId });
    expect(newsroom.settingsOf(a.orgId).paused).toBe(false);
  });

  it("sends strong pitches on its own at level 4, never on sensitive topics, and builds the seasonal calendar with alerts", async () => {
    const { a, owner } = await twoDesks("nr4");
    const c = caller(owner);
    await taylorSends(a.orgId);
    await c.newsroom.saveSettings({ organizationId: a.orgId, shared: [], coolingDays: 21, level: 4, alwaysNeedsYou: "regulators, legal", stopWords: "Breach" });
    const dana = db.press.contacts.create({ organizationId: a.orgId, name: "Dana Whitfield", outlet: "Care Ops Daily", email: "dana@careopsdaily.example" });
    const p = await pitching.writePitch(a.orgId, dana.id, { angle: "Admin burden" });
    await settled();
    expect(db.press.pitches.get(p.id, a.orgId)?.status).toBe("sent");
    expect(calls.filter((x) => /messages\/send/.test(x.url))).toHaveLength(1);

    const sam = db.press.contacts.create({ organizationId: a.orgId, name: "Sam Ortiz", outlet: "Health Systems Weekly", email: "sam@hsw.example" });
    const { generateJson } = await import("./_core/llm");
    (generateJson as any).mockImplementationOnce(async () => ({ subject: "What regulators will ask next", body: "Hi Sam, a legal question is coming for practices." }));
    const q = await pitching.writePitch(a.orgId, sam.id, {});
    await settled();
    expect(db.press.pitches.get(q.id, a.orgId)?.status).toBe("ready");
    expect(calls.filter((x) => /messages\/send/.test(x.url))).toHaveLength(1);

    expect(await presslib.fillLibrary(a.orgId, "calendar")).toBe(1);
    expect(await presslib.seasonalAlerts(a.orgId)).toBe(1);
    expect(await presslib.seasonalAlerts(a.orgId)).toBe(0);
    const taylor = (await db.getEmployeeByKind(a.orgId, "speaking"))!;
    expect((await db.listChatMessages(a.orgId, taylor.id, 5)).pop()!.content).toMatch(/^Coming up on the press calendar: Holiday stress and family conflict/);
    const camp = await c.newsroom.planMoment({ organizationId: a.orgId, id: db.press.library.list(a.orgId).find((x) => x.kind === "moment")!.id });
    expect(camp.status).toBe("scheduled");
    expect(camp.startsOn).toBeTruthy();

    const stats = (await c.newsroom.coverage({ organizationId: a.orgId })).stats;
    expect(stats).toMatchObject({ placements: 0, replyRate: 0 });
  });
});

describe("the desk speaks for this workspace's company", () => {
  it("rewrites the beats around what the owner says, and the scout serves the desk it runs from", async () => {
    const { orgId } = await makeWorkspace("desk-beats");
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    db.press.saveSettings(orgId, { owns: "Talks for HR leaders", beats: JSON.stringify(["HR conferences", "workplace mental health"]) });

    const p = await (await import("./employees/newsroom")).setDeskProfile(taylor, "media list should be about tech, women in tech, women founders");
    expect(p.beats).toEqual(["AI in healthcare", "behavioral health technology"]);
    const ask = prompts.desk_profile[prompts.desk_profile.length - 1];
    expect(ask).toContain("Her words lead");
    expect(ask).toContain("tech, women in tech, women founders");
    expect(ask).toMatch(/Never let a talk you wrote decide this desk's beats/);
    expect(JSON.parse(db.press.getSettings(orgId)!.beats!)).toEqual(["AI in healthcare", "behavioral health technology"]);
    expect(db.press.getSettings(orgId)!.owns).toBe("Product, health tech, AI employees");

    await (await import("./employees/newsroom")).scout(orgId, { quiet: true });
    const scoutAsk = prompts.press_scout[prompts.press_scout.length - 1];
    expect(scoutAsk).toMatch(/This scout is for the Workspace desk-beats desk/);
    expect(scoutAsk).toContain("not the owner's speaking topics");
  });
});

describe("the media list builder", () => {
  it("builds the list a beat at a time every day until the goal, skips names on file, finds emails only from public pages, and reports progress", async () => {
    const { orgId, owner } = await makeWorkspace("list-build");
    const me = caller(owner);
    db.press.saveSettings(orgId, { owns: "LeadDash, the AI employees and the HIPAA-compliant EHR", beats: JSON.stringify(["AI for small business", "health tech", "women founders"]), listGoal: 4 });
    const reporter = (name: string, outlet: string, email = "") => ({
      ...DANA([orgId]),
      name,
      outlet,
      email,
      emailSource: email ? `https://${outlet.toLowerCase().replace(/\W/g, "")}.example/contact` : "",
      authorPage: "",
      articles: [{ title: `${name} on AI`, url: `https://${outlet.toLowerCase().replace(/\W/g, "")}.example/ai`, date: recent(20), topics: "AI" }],
    });
    // Each pass finds two reporters; the sources prove the article hosts. The contact pass finds one email from a public page and one it only guessed.
    let pass = 0;
    const { searchJson } = await import("./_core/llm");
    (searchJson as any).mockImplementation(async (opts: any) => {
      (prompts[opts.schemaName] ??= []).push(`${opts.system}\n${opts.prompt}`);
      if (opts.schemaName === "press_list") {
        pass++;
        const found = pass === 1 ? [reporter("Emma Burleigh", "Fortune", "emma@fortune.example"), reporter("Sherin Shibu", "Entrepreneur")] : pass === 2 ? [reporter("Craig Hale", "TechRadar"), reporter("Emma Burleigh", "Fortune")] : [reporter("Laura Lovett", "Behavioral Health Business")];
        return { data: { reporters: found }, queries: ["q"], sources: [{ url: "https://fortune.example/x", title: "" }, { url: "https://entrepreneur.example/x", title: "" }, { url: "https://techradar.example/x", title: "" }, { url: "https://behavioralhealthbusiness.example/x", title: "" }], costUsd: 0 };
      }
      if (opts.schemaName === "press_contacts") {
        const ids = [...opts.prompt.matchAll(/contactId (\d+): ([^,]+)/g)].map((m: any) => ({ id: Number(m[1]), name: m[2] }));
        const sherin = ids.find((x) => x.name === "Sherin Shibu");
        const craig = ids.find((x) => x.name === "Craig Hale");
        const found = [
          ...(sherin ? [{ contactId: sherin.id, email: "sshibu@entrepreneur.example", emailSource: "https://entrepreneur.example/author/sherin", authorPage: "https://entrepreneur.example/author/sherin", reach: "", reachSource: "" }] : []),
          ...(craig ? [{ contactId: craig.id, email: "craig.hale@techradar.example", emailSource: "https://somewhere-else.example/guess", authorPage: "", reach: "Tips: news@techradar.example", reachSource: "https://techradar.example/contact" }] : []),
        ];
        return { data: { found }, queries: ["q"], sources: [{ url: "https://entrepreneur.example/author/sherin", title: "" }, { url: "https://techradar.example/contact", title: "" }], costUsd: 0 };
      }
      return { data: scoutData, queries: ["q"], sources: scoutSources, costUsd: 0 };
    });

    const r = await newsroom.buildList(orgId, { passes: 2 });
    expect(r.beats).toEqual(["AI for small business", "health tech"]);
    expect(r.added).toBe(3);
    expect(r.updated).toBe(1);
    expect(r.count).toBe(3);
    expect(r.goal).toBe(4);
    // The second pass was told to skip the names from the first.
    expect(prompts.press_list[1]).toContain("Emma Burleigh (Fortune)");
    expect(prompts.press_list[1]).toContain("The beat to search now: health tech");
    expect(prompts.press_list[0]).toMatch(/talks and frameworks; those are speaking material/);
    // Emails: Emma's came with the article pass, Sherin's from her author page; Craig's guess from an unrelated page is dropped, his tips address kept.
    const list = newsroom.contactsFor(orgId);
    expect(list.find((c) => c.name === "Emma Burleigh")!.email).toBe("emma@fortune.example");
    expect(list.find((c) => c.name === "Sherin Shibu")!.email).toBe("sshibu@entrepreneur.example");
    const craig = list.find((c) => c.name === "Craig Hale")!;
    expect(craig.email).toBeNull();
    expect(JSON.parse(craig.profile!).reach).toContain("news@techradar.example");
    expect(r.emails).toBe(1);
    expect(r.withEmail).toBe(2);
    // The cursor moved on so the next build starts at the third beat, and Taylor said where the list stands.
    expect(db.press.getSettings(orgId)!.buildCursor).toBe(2);
    const msgs = await db.listChatMessages(orgId, (await db.getEmployeeByKind(orgId, "speaking"))!.id);
    expect(msgs[msgs.length - 1].content).toMatch(/Media list: 3 of 4 reporters, 2 with an email on file\. This pass added 3 new reporters and refreshed 1 on AI for small business, health tech, and found an email/);
    expect(msgs[msgs.length - 1].content).toContain("1 to go");

    // The daily tick builds again only when five hours have passed and the goal is not met; once met, it stops.
    db.press.saveSettings(orgId, { lastBuildAt: new Date(Date.now() - 6 * 3_600_000) });
    const noon = new Date();
    noon.setUTCHours(18, 0, 0, 0); // 1:00 PM Central
    if (noon.getTime() < Date.now()) noon.setTime(noon.getTime() + 86_400_000);
    await newsroom.newsroomTicks(noon);
    expect(newsroom.listProgress(orgId).count).toBe(4);
    // One pass (women founders) reached the goal, so the build stopped there and the cursor wrapped to the first beat.
    expect(prompts.press_list.filter((p) => p.includes("The beat to search now: women founders"))).toHaveLength(1);
    expect(db.press.getSettings(orgId)!.buildCursor).toBe(0);
    const before = pass;
    // An hour later (every desk built an hour ago in tick time): this desk is at its goal and the others wait their five hours.
    for (const id of await db.listAllOrganizationIds()) if (db.press.getSettings(id)) db.press.saveSettings(id, { lastBuildAt: noon });
    db.press.saveSettings(orgId, { lastBuildAt: new Date(noon.getTime() - 6 * 3_600_000) });
    await newsroom.newsroomTicks(new Date(noon.getTime() + 3_600_000));
    expect(pass).toBe(before);
    expect((await me.newsroom.view({ organizationId: orgId })).list).toMatchObject({ count: 4, goal: 4, withEmail: 2 });
    expect(await newsroom.newsroomFacts(orgId)).toMatch(/Media list: 4 of 4 reporters on file, 2 with an email/);
    expect(await newsroom.newsroomFacts(orgId)).toMatch(/frameworks in the Brain are speaking material/);
    (searchJson as any).mockImplementation(async () => ({ data: scoutData, queries: ["q"], sources: scoutSources, costUsd: 0 }));
  });
});
