import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as integrations from "./integrations";
import * as sales from "./employees/sales";
import * as team from "./employees/team";
import * as social from "./social";
import { encryptJson } from "./_core/crypto";

type Call = { url: string; init: any };
let calls: Call[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let llm: typeof import("./_core/llm");
beforeEach(async () => {
  calls = [];
  routes = [];
  integrations.setPollMs(0);
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

async function connectGoogle(orgId: number) {
  await db.upsertExternalConnection({ organizationId: orgId, provider: "google_workspace", accountLabel: "ashley@leaddash.io", status: "connected", settings: "{}", secretsEncrypted: encryptJson({ accessToken: "g" }), connectedAt: new Date(), lastCheckedAt: new Date() });
  routes.push([/calendar\/v3\/calendars\/primary\/events\?timeMin/, () => json({ items: [] })]);
  routes.push([/calendar\/v3\/calendars\/primary\/events\?sendUpdates=all/, () => json({ htmlLink: "https://calendar.google.com/event?eid=1" })]);
  routes.push([/gmail\.googleapis\.com/, () => json({ id: "m1", threadId: "t1" })]);
}

const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

function mockWriting() {
  vi.spyOn(llm, "searchJson").mockImplementation(async () => ({
    data: {
      items: [
        { name: "Hill Country Counseling Group", city: "Austin, TX", contactName: "Renee Alvarez", contactTitle: "LPC-S, Owner", email: "intake@hillcountry.example", phone: "", website: "https://hillcountry.example", foundOn: "Team page", sourceUrl: "https://hillcountry.example/team", size: "9 therapists", partnerType: "", fitScore: 91, fitReason: "Books by phone only and is hiring 2 clinicians." },
        { name: "Small Solo Practice", city: "Waco, TX", contactName: "", contactTitle: "", email: "", phone: "", website: "", foundOn: "Directory", sourceUrl: "https://hillcountry.example/dir", size: "1", partnerType: "", fitScore: 40, fitReason: "Solo." },
      ],
    },
    sources: [{ url: "https://hillcountry.example/team", title: "Team" }],
    queries: ["group practices Texas"],
  }) as any);
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "outreach_sequence") return { subject: "New clients waiting on a call back?", email1: "Hi Renee,\nBook here: link", email2: "Quick follow-up.", email3: "I'll leave it here." } as any;
    if (opts.schemaName === "lead_reply") return { subject: "Times to talk", body: "Hi,\nHere are three times." } as any;
    if (opts.schemaName === "posts_from_article") return { posts: [{ headline: "sleep tip one", caption: "Post one" }, { headline: "sleep tip two", caption: "Post two" }, { headline: "sleep tip three", caption: "Post three" }] } as any;
    return {} as any;
  });
}

describe("the sales team", () => {
  it("Riley finds prospects and passes good fits to Jada, who writes sequences that wait for the first 5 approvals", async () => {
    mockWriting();
    const { orgId, owner } = await makeWorkspace("sl-riley");
    await caller(owner).sales.saveSettings({ organizationId: orgId, sells: "software" });
    const r = await sales.findProspects(orgId);
    expect(r.created.map((p) => p.name)).toEqual(["Hill Country Counseling Group", "Small Solo Practice"]);
    expect(r.passed).toBe(1);
    await until(async () => (await db.listOutboundItemsByOrg(orgId, "outreach_email")).length === 3);

    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    const chat = await db.listChatMessages(orgId, jada.id, 10);
    expect(chat.some((m) => m.role === "handoff" && /Riley passed you Hill Country/.test(m.content))).toBe(true);
    const act = await caller(owner).team.activity({ organizationId: orgId });
    expect(act.some((a) => a.kind === "handoff")).toBe(true);

    const seqs = await caller(owner).sales.sequences({ organizationId: orgId });
    expect(seqs).toHaveLength(1);
    expect(seqs[0].tab).toBe("waiting");
    expect(seqs[0].steps.map((s) => s.title)).toEqual(["New clients waiting on a call back?", "Re: New clients waiting on a call back?", "Re: New clients waiting on a call back?"]);
    const t = seqs[0].steps.map((s) => new Date(s.scheduledFor!).getTime());
    expect(t[1] - t[0]).toBeGreaterThan(2 * 86400_000);
    expect(t[2] - t[1]).toBeGreaterThan(4 * 86400_000);

    await caller(owner).sales.approveSequence({ organizationId: orgId, sequence: seqs[0].sequence });
    const after = await caller(owner).sales.sequences({ organizationId: orgId });
    expect(after[0].tab).toBe("sending");
    expect(team.autonomyView((await db.getEmployeeByKind(orgId, "outreach"))!).find((x) => x.key === "first_email")).toMatchObject({ mode: "first5", approved: 1 });

    // After 5 approvals Jada starts sequences on her own.
    await db.updateEmployee(jada.id, orgId, { autonomy: JSON.stringify({ rules: {}, approved: { first_email: 5 } }) });
    expect(team.gate((await db.getEmployeeByKind(orgId, "outreach"))!, "first_email")).toBe("auto");
    // And "Ask me first" always asks.
    await caller(owner).onboarding.saveRules({ organizationId: orgId, employeeId: jada.id, rules: { first_email: "ask" } });
    expect(team.gate((await db.getEmployeeByKind(orgId, "outreach"))!, "first_email")).toBe("ask");
  });

  it("Replied stops the sequence and hands the person to Malik; booking stops it too and puts it on the calendar", async () => {
    mockWriting();
    const { orgId, owner } = await makeWorkspace("sl-reply");
    await caller(owner).sales.saveSettings({ organizationId: orgId, sells: "software" });
    const p = await db.createProspect({ organizationId: orgId, name: "Bayou Family Therapy", email: "kevin@bayou.example", contactName: "Kevin Tran", fitScore: 86, stage: "new" });
    await caller(owner).sales.startOutreach({ organizationId: orgId, ids: [p.id] });
    await until(async () => (await db.listOutboundItemsByOrg(orgId, "outreach_email")).length === 3);
    await caller(owner).sales.replied({ organizationId: orgId, prospectId: p.id });
    expect((await db.listOutboundItemsByOrg(orgId, "outreach_email")).every((m) => m.status === "cancelled")).toBe(true);
    expect((await db.getProspect(p.id, orgId))?.stage).toBe("replied");
    const malik = (await db.getEmployeeByKind(orgId, "leads"))!;
    expect((await db.listChatMessages(orgId, malik.id, 10)).some((m) => m.role === "handoff" && /Kevin Tran at Bayou Family Therapy replied/.test(m.content))).toBe(true);

    // A second prospect books through the link.
    await connectGoogle(orgId);
    const q = await db.createProspect({ organizationId: orgId, name: "Mesa Psychology", email: "sam@mesa.example", contactName: "Sam Ortiz", fitScore: 80, stage: "new" });
    await sales.passToOutreach(orgId, [q.id]);
    await until(async () => (await db.listOutboundItemsByOrg(orgId, "outreach_email")).filter((m) => m.status !== "cancelled").length === 3);
    const open = await sales.openTimes(orgId);
    expect(open.ready).toBe(true);
    const r = await sales.book(orgId, { at: open.times[0].toISOString(), name: "Sam Ortiz", email: "sam@mesa.example" });
    expect(r.lead?.status).toBe("booked");
    expect((await db.getProspect(q.id, orgId))?.stage).toBe("booked");
    expect((await db.listOutboundItemsByOrg(orgId, "outreach_email")).every((m) => m.status === "cancelled")).toBe(true);
    const ev = calls.find((c) => c.url.includes("sendUpdates=all"))!;
    expect(JSON.parse(ev.init.body).attendees).toEqual([{ email: "sam@mesa.example" }]);
    await expect(sales.book(orgId, { at: new Date(Date.now() + 3600_000).toISOString(), name: "X", email: "x@y.example" })).rejects.toThrow(/just taken/);
  });

  it("Malik replies to a new lead on his own with three open times; a practice's client inquiries wait for approval", async () => {
    mockWriting();
    const { orgId, owner } = await makeWorkspace("sl-lead");
    await caller(owner).sales.saveSettings({ organizationId: orgId, sells: "software", hoursFrom: "09:00", hoursTo: "16:00", days: [0, 1, 2, 3, 4, 5, 6] });
    await connectGoogle(orgId);
    const lead = await sales.newLead(orgId, { name: "Lauren Pierce", email: "lauren@riverbend.example", company: "Riverbend Counseling", message: "Can someone show us intake?", source: "Website form" });
    const reply = (await db.listOutboundItemsByOrg(orgId, "lead_reply"))[0];
    const meta = JSON.parse(reply.metadata!);
    expect(meta.offered).toHaveLength(3);
    const tz = "America/Chicago";
    expect(new Set(meta.offered.map((t: string) => social.localParts(new Date(t), tz).date)).size).toBe(3);
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
    if (hour >= 8 && hour < 20) {
      expect(reply.status).toBe("published");
      expect((await db.getLead(lead!.id, orgId))?.status).toBe("replied");
    } else expect(reply.status).toBe("scheduled");

    const therapy = await makeWorkspace("sl-therapy");
    await connectGoogle(therapy.orgId);
    await sales.newLead(therapy.orgId, { name: "J. Doe", email: "jd@example.com", source: "Website form" });
    expect((await db.listOutboundItemsByOrg(therapy.orgId, "lead_reply"))[0].status).toBe("pending_approval");

    const settings = await caller(owner).sales.settings({ organizationId: orgId });
    expect(settings.links.form).toMatch(/\/f\/[A-Za-z0-9_-]{20,}$/);
    expect(JSON.stringify(settings)).not.toContain('"token"');
    expect((await db.findOrgBySalesToken(settings.links.form.split("/f/")[1]))?.id).toBe(orgId);
  });

  it("Theo's approved article goes to Sienna, who puts 3 posts on the calendar; any employee can ask a teammate", async () => {
    mockWriting();
    const { orgId, owner } = await makeWorkspace("sl-team");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const article = await db.createOutboundItem({ organizationId: orgId, employeeId: theo.id, kind: "blog_post", status: "pending_approval", title: "Sleep and anxiety", body: "What actually helps." });
    await caller(owner).publishing.approveAndDispatch({ organizationId: orgId, itemId: article.id, action: "approve_for_dispatch" });
    await until(async () => (await db.listOutboundItemsByOrg(orgId, "social_post")).length === 3);
    const posts = await db.listOutboundItemsByOrg(orgId, "social_post");
    expect(posts.every((p) => p.status === "pending_approval" && p.scheduledFor)).toBe(true);
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const msgs = await db.listChatMessages(orgId, sienna.id, 10);
    expect(msgs.some((m) => m.role === "handoff" && /Theo passed you his new article, Sleep and anxiety/.test(m.content))).toBe(true);

    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => (opts.schemaName === "chat_decision" ? ({ reply: "", action: "ask_teammate", teammate: "Theo", message: "What did you publish this month?", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "" } as any) : ({} as any)));
    const text = vi.spyOn(llm, "generateText").mockImplementation(async () => "Theo published Sleep and anxiety this month.");
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: sienna.id, text: "Ask Theo what he published this month" });
    expect(r.reply.content).toBe("Theo published Sleep and anxiety this month.");
    expect(String(text.mock.calls[0][0].prompt)).toContain("Theo's facts");
  });
  it("Jada adds a LinkedIn step the owner sends: waits with the sequence, shows on the LinkedIn tab, stops with it", async () => {
    vi.spyOn(llm, "searchJson").mockImplementation(async (opts: any) => {
      if (opts.schemaName === "linkedin_profile") return { data: { url: "https://www.linkedin.com/in/renee-alvarez-lpc/?trk=x", page: "the practice's team page" }, sources: [], queries: [] } as any;
      return { data: { items: [{ name: "Hill Country Counseling Group", city: "Austin, TX", contactName: "Renee Alvarez", contactTitle: "Owner", email: "renee@hc.example", phone: "", website: "https://hc.example", foundOn: "Team page", sourceUrl: "https://hc.example/team", size: "", partnerType: "", fitScore: 90, fitReason: "Phone booking only.", linkedin: "" }] }, sources: [{ url: "https://hc.example/team", title: "Team" }], queries: ["q"] } as any;
    });
    vi.spyOn(llm, "generateJson").mockImplementation(async () => ({ subject: "Hi", email1: "One", email2: "Two", email3: "Three", linkedinNote: "Hi Renee, I work with group practices in Texas on online intake and would like to connect. ".repeat(4) }) as any);
    const { orgId, owner } = await makeWorkspace("sl-linkedin");
    const c = caller(owner);
    await c.sales.saveSettings({ organizationId: orgId, sells: "software" });
    await sales.findProspects(orgId);
    await until(async () => (await db.listOutboundItemsByOrg(orgId, "outreach_email")).length === 3 && !!JSON.parse((await db.listProspects(orgId))[0].details || "{}").linkedin);
    const seq = (await c.sales.sequences({ organizationId: orgId }))[0];
    expect(seq.tab).toBe("waiting");
    expect(seq.linkedin).toMatchObject({ url: "https://www.linkedin.com/in/renee-alvarez-lpc", status: "waiting", foundBy: "Jada, from the practice's team page" });
    expect(seq.linkedin!.note.length).toBeLessThanOrEqual(200);
    expect(await c.sales.linkedin({ organizationId: orgId })).toHaveLength(0);

    await c.sales.approveSequence({ organizationId: orgId, sequence: seq.sequence });
    const rows = await c.sales.linkedin({ organizationId: orgId });
    expect(rows).toHaveLength(1);
    await c.sales.linkedinNote({ organizationId: orgId, prospectId: rows[0].prospectId, note: "Hi Renee, glad to connect. Ashley" });
    expect((await c.sales.linkedin({ organizationId: orgId }))[0].note).toBe("Hi Renee, glad to connect. Ashley");
    await c.sales.linkedinAction({ organizationId: orgId, prospectId: rows[0].prospectId, action: "done" });
    expect(await c.sales.linkedin({ organizationId: orgId })).toHaveLength(0);

    // Turned off: no step. Stopping a sequence cancels a step that is still to do.
    await c.sales.saveSettings({ organizationId: orgId, linkedin: { on: false, when: "next_day", note: true } });
    expect((await c.sales.settings({ organizationId: orgId })).linkedin.on).toBe(false);
    const p = (await db.listProspects(orgId))[0];
    await db.updateProspect(p.id, orgId, { details: JSON.stringify({ linkedin: { url: "https://www.linkedin.com/in/x", note: "", due: new Date().toISOString(), status: "todo", foundBy: "Jada", sequence: seq.sequence } }) });
    await sales.stopSequence(orgId, p.id);
    expect(JSON.parse((await db.getProspect(p.id, orgId))!.details!).linkedin.status).toBe("cancelled");
  });
});
