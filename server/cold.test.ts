import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts: Record<string, string[]> = {};
let replyData: any = null;
let sequence: any = null;
let reviewData: any = { points: [], changes: [] };
let searchData: any = { leads: [] };
let searchSources: { url: string; title: string }[] = [];
let pages: Record<string, string> = {};

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async (opts: any) => {
      (prompts[opts.schemaName] ??= []).push(`${opts.system}\n${opts.prompt}`);
      return { data: searchData, queries: ["q"], sources: searchSources, costUsd: 0 };
    }),
    generateJson: vi.fn(async (opts: any) => {
      (prompts[opts.schemaName] ??= []).push(`${opts.system}\n${opts.prompt}`);
      switch (opts.schemaName) {
        case "cold_site":
          return { plans: [{ name: "Core", price: "$99 per month", seats: "1 clinician", includes: "EHR" }, { name: "Made up", price: "$12 per month", seats: "", includes: "" }], address: "11901 N. MacArthur Blvd, Suite C6, Oklahoma City, OK 73162", notes: "Month to month" };
        case "cold_signals":
          return { practice: "Hill Country Counseling Group", website: "https://hillcountry.example", ownerRole: "owner", clinicians: 9, locations: 1, hiringClinicians: true, hiringAdmin: false, onlineBooking: true, telehealth: true, insurance: "yes", ehr: { name: "SimplePractice", confidence: "likely", evidence: "Client portal link" }, hospitalSystem: false, recentlyOpened: false, independentFound: true, specialties: ["Couples"], summary: "A 9-clinician group in Austin.", sources: ["https://hillcountry.example"] };
        case "cold_sequence": {
          const first = sequence ?? { name: "EHR switchers", offer: "", ask: "Worth sending a comparison?", emails: [{ subject: "still on SimplePractice?", subjectB: "quick question about [practice name]", body: "Hi [first name],\nAre you still using SimplePractice at [practice name]?" }, { subject: "", subjectB: "", body: "Hi [first name], after-hours calls?" }, { subject: "", subjectB: "", body: "Hi [first name], a side by side." }, { subject: "", subjectB: "", body: "Hi [first name], I'll close the loop." }] };
          sequence = { ...first, emails: first.emails.map((e: any, i: number) => (i === 0 ? { ...e, subjectB: "about [practice name]" } : e)) };
          return first;
        }
        case "cold_reply":
          return replyData;
        case "cold_review":
          return reviewData;
        case "cold_followup":
          return { draft: "Hi Jennifer, you said January. Still the plan? Ashley" };
        case "precall_after":
          return { changes: [{ what: "Clinicians", before: "6", after: "8, plus 2 in November" }], nextStep: "Send the comparison by Oct 8, 2026" };
        default:
          return {};
      }
    }),
  };
});
vi.mock("./employees/files", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    fetchWebpage: vi.fn(async (url: string) => {
      const text = pages[url];
      if (text === undefined) throw new Error("not found");
      return { title: "Page", text, url };
    }),
  };
});
vi.mock("./employees/browser", async (orig) => {
  const actual: any = await orig();
  return { ...actual, renderText: vi.fn(async () => "") };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as cold from "./employees/cold";
import * as coldreply from "./employees/coldreply";
import * as precall from "./employees/precall";

let calls: { url: string; method: string; body: any }[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sent = (re: RegExp, method?: string) => calls.filter((c) => re.test(c.url) && (!method || c.method === method));

beforeEach(() => {
  calls = [];
  routes = [];
  pages = {};
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    return json({ message: "no route " + url }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CSV = `First Name,Last Name,License Type,License Number,Status,City,State,Email,Website
Renee,Alvarez,LPC-S,12345,Active,Austin,TX,renee@hillcountry.example,hillcountry.example
KEVIN,TRAN,LMFT,555,Active,Houston,TX,kevin@bayou.example,
James,Whitfield,LCSW,777,Expired,Tulsa,OK,james@whitfield.example,
Dup,Person,LPC,1,Active,Austin,TX,renee@hillcountry.example,
No,Email,LPC,2,Active,Austin,TX,,
Stop,Me,LPC,3,Active,Austin,TX,stop@me.example,`;

/** Instantly with 3 inboxes, one of them bouncing. */
function instantly(opts: { bounce?: boolean } = {}) {
  routes.push([/api\.instantly\.ai\/api\/v2\/accounts\?/, () => json({ items: [{ email: "ashley@tryleaddash.com", status: 1 }, { email: "ashley.b@getleaddash.com", status: 1 }, { email: "hello@leaddashhq.com", status: 1 }] })]);
  routes.push([/api\/v2\/accounts\/analytics\/daily/, () => json([{ date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), email_account: "hello@leaddashhq.com", sent: 100, bounced: opts.bounce ? 9 : 0, replies: 1 }, { date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), email_account: "ashley@tryleaddash.com", sent: 100, bounced: 0, replies: 2 }])]);
  routes.push([/api\/v2\/campaigns\/analytics/, () => json([])]);
  routes.push([/api\/v2\/campaigns\/[\w-]+\/(activate|pause)/, () => json({ ok: true })]);
  routes.push([/api\/v2\/campaigns\/[\w-]+$/, () => json({ ok: true })]);
  routes.push([/api\/v2\/campaigns$/, () => json({ id: "camp-1" })]);
  routes.push([/api\/v2\/leads\/add/, (_u, init) => {
    const body = JSON.parse(init.body);
    return json({ leads_uploaded: body.leads.length, remaining_in_plan: 640, created_leads: body.leads.map((l: any, i: number) => ({ index: i, id: `lead-${l.email}`, email: l.email })) });
  }]);
  routes.push([/api\/v2\/leads\/[\w@.-]+$/, () => json({ ok: true })]);
  routes.push([/api\/v2\/block-lists-entries/, () => json({ id: "b1" })]);
  routes.push([/api\/v2\/emails\/reply/, () => json({ id: "r1" })]);
}

async function setup(slug: string) {
  const ws = await makeWorkspace(slug);
  instantly();
  await cold.connect(ws.orgId, "inst-key-123456");
  return ws;
}

describe("Jada's cold email", () => {
  it("adds a license list: maps columns, skips duplicates and leads without email, keeps expired licenses and do-not-contact out", async () => {
    const { orgId, owner } = await makeWorkspace("cold1");
    db.cold.suppress(orgId, "stop@me.example", "Asked to stop");
    const r = cold.importCsv(orgId, "Texas license list.csv", CSV);
    expect(r).toMatchObject({ rows: 6, added: 4, noEmail: 1, doNotContact: 1, inactive: 1 });
    const v = await caller(owner).cold.leads({ organizationId: orgId });
    expect(v.counts).toMatchObject({ total: 4, dnc: 1 });
    const kevin = v.rows.find((x) => x.email === "kevin@bayou.example")!;
    expect(kevin.name).toBe("Kevin Tran");
    const james = v.rows.find((x) => x.email === "james@whitfield.example")!;
    expect(james).toMatchObject({ stage: "not_fit", fit: 0 });
    expect(v.rows.find((x) => x.email === "renee@hillcountry.example")!.website).toBe("https://hillcountry.example");
    await expect(caller(owner).cold.leads({ organizationId: orgId, q: "tran" })).resolves.toMatchObject({ total: 1 });
    expect(() => cold.importCsv(orgId, "x.csv", "Name,Phone\nA,1")).toThrow(/no email column/);
  });

  it("reads pricing and the address from the website, keeping only prices that are on the page", async () => {
    const { orgId } = await makeWorkspace("cold2");
    pages["https://leaddash.io/pricing"] = "Pricing. Core $99 per month for 1 clinician. Complete $299 per month. ".repeat(10);
    pages["https://leaddash.io"] = "LeadDash. 11901 N. MacArthur Blvd, Suite C6, Oklahoma City, OK 73162";
    const site = await cold.refreshSite(orgId);
    expect(site!.plans.map((p) => p.name)).toEqual(["Core"]);
    expect(site!.address).toContain("11901 N. MacArthur");
    const s = cold.settingsOf(orgId);
    expect(cold.addressOf(s)).toContain("Oklahoma City");
    expect(cold.pricingText(s)).toContain("Core: $99 per month");
    expect(await cold.footerFor(orgId)).toMatch(/11901 N\. MacArthur[\s\S]*Reply stop/);
  });

  it("researches leads from their own website and scores them with the fit points", async () => {
    const { orgId } = await makeWorkspace("cold3");
    cold.importCsv(orgId, "list.csv", CSV);
    pages["https://hillcountry.example"] = "Hill Country Counseling Group. Our team of 9. Now hiring.";
    searchSources = [];
    searchData = { leads: [{ index: 0, practice: "", website: "https://invented.example", ownerRole: "unknown", clinicians: 0, locations: 0, hiringClinicians: false, hiringAdmin: false, onlineBooking: false, telehealth: false, insurance: "unknown", ehr: { name: "", confidence: "unknown", evidence: "" }, hospitalSystem: false, recentlyOpened: false, independentFound: false, specialties: [], summary: "", sources: ["https://invented.example"] }] };
    const r = await cold.research(orgId, 10);
    expect(r.done).toBe(2);
    const renee = db.cold.leadByEmail(orgId, "renee@hillcountry.example")!;
    expect(renee.fit).toBe(90);
    expect(JSON.parse(renee.fitWhy).map((x: any) => x.label)).toEqual(expect.arrayContaining(["Practice owner", "3 to 20 clinicians", "Hiring a clinician"]));
    expect(JSON.parse(renee.segments)).toEqual(expect.arrayContaining(["group_owner", "size_3_15", "hiring", "ehr_simplepractice"]));
    expect(prompts.cold_signals.at(-1)).toContain("Never personal details");
    // No practice found by search, and the invented website wasn't in the search results.
    const kevin = db.cold.leadByEmail(orgId, "kevin@bayou.example")!;
    expect(kevin).toMatchObject({ fit: 0, stage: "not_fit", website: "" });
  });

  it("writes a campaign, starts it in Instantly without tracking, and sends the day's batch within the plan", async () => {
    const { orgId, owner } = await setup("cold4");
    expect(db.cold.inboxes.list(orgId)).toHaveLength(3);
    cold.importCsv(orgId, "list.csv", CSV);
    pages["https://hillcountry.example"] = "Hill Country";
    searchData = { leads: [] };
    await cold.research(orgId, 10);
    const c = caller(owner);
    sequence = { name: "EHR switchers", offer: "", ask: "Worth sending a comparison?", emails: [{ subject: "still on SimplePractice?", subjectB: "quick question about [practice name]", body: "Hi [first name],\nAre you still using SimplePractice at [practice name]? I hope this finds you well." }, { subject: "", subjectB: "", body: "Hi [first name], after-hours calls?" }, { subject: "", subjectB: "", body: "Hi [first name], a side by side." }, { subject: "", subjectB: "", body: "Hi [first name], I'll close the loop." }] };
    const made = await c.cold.newCampaign({ organizationId: orgId, angle: "switcher" });
    // A draft that sounded like AI was written again.
    expect(prompts.cold_sequence.at(-1)).toMatch(/give it away as written by AI/);
    expect(made.status).toBe("draft");
    // No mailing address yet: it can't start.
    await expect(c.cold.startCampaign({ organizationId: orgId, id: made.id })).rejects.toThrow(/mailing address/);
    await c.cold.saveSettings({ organizationId: orgId, level: 2, perInbox: 20, rampPct: 10, bounceRest: 3, signature: "Ashley", address: "11901 N. MacArthur Blvd, Suite C6, Oklahoma City, OK 73162", optOut: "Not the right fit? Reply stop and I won't email again.", alwaysNeedsYou: "HIPAA, legal", plan: "growth", website: "https://leaddash.io" });
    await c.cold.startCampaign({ organizationId: orgId, id: made.id });
    const create = sent(/api\/v2\/campaigns$/, "POST")[0].body;
    expect(create).toMatchObject({ open_tracking: false, link_tracking: false, stop_on_reply: true, text_only: true });
    expect(create.email_list).toHaveLength(3);
    expect(create.sequences[0].steps.map((s: any) => s.delay)).toEqual([3, 4, 5, 0]);
    expect(create.sequences[0].steps[0].variants).toHaveLength(2);
    expect(create.sequences[0].steps[0].variants[0].body).toMatch(/\{\{firstName\}\}[\s\S]*11901 N\. MacArthur[\s\S]*Reply stop/);
    expect(create.sequences[0].steps[0].variants[1].subject).toContain("{{companyName}}");
    expect(sent(/campaigns\/camp-1\/activate/)).toHaveLength(1);

    const r = await cold.feed(orgId, new Date("2026-10-05T15:00:00Z"));
    expect(r.added).toBe(1);
    const renee = db.cold.leadByEmail(orgId, "renee@hillcountry.example")!;
    expect(renee).toMatchObject({ stage: "in_campaign", instantlyLeadId: "lead-renee@hillcountry.example" });
    expect(sent(/leads\/add/)[0].body).toMatchObject({ campaign_id: "camp-1", skip_if_in_workspace: true });
    expect(cold.settingsOf(orgId).remainingInPlan).toBe(640);
    // The same day doesn't send twice.
    await expect(cold.feed(orgId, new Date("2026-10-05T18:00:00Z"))).resolves.toMatchObject({ added: 0 });
    // Finished sequences come out of Instantly.
    const out = await cold.cleanup(orgId, new Date("2026-10-30T15:00:00Z"));
    expect(out.removed).toBe(1);
    expect(sent(/leads\/lead-renee/, "DELETE")).toHaveLength(1);
  });

  it("sorts replies: opt-outs at once, routine answers by level, hot leads to the owner", async () => {
    const { orgId, owner } = await setup("cold5");
    cold.importCsv(orgId, "list.csv", CSV);
    cold.saveSettings(orgId, { level: 2, perInbox: 20, rampPct: 10, bounceRest: 3, signature: "Ashley", address: "1 Main St, OKC, OK", optOut: "Reply stop.", alwaysNeedsYou: "HIPAA, legal", plan: "growth", website: "https://leaddash.io" });
    const mail = (id: string, from: string, text: string, extra: any = {}) => ({ id, from_address_email: from, eaccount: "ashley@tryleaddash.com", subject: "Re: still on SimplePractice?", body: { text }, timestamp_created: new Date().toISOString(), ...extra });
    const base = { topic: "", followUpDate: "", followUpNote: "", referralName: "", referralEmail: "", summary: "", safe: true, needsYou: "" };

    replyData = { ...base, kind: "unsubscribe", draft: "" };
    await coldreply.handleEmail(orgId, mail("e1", "renee@hillcountry.example", "Remove me please"));
    expect(db.cold.isSuppressed(orgId, "renee@hillcountry.example")).toBe(true);
    expect(sent(/block-lists-entries/)[0].body).toEqual({ bl_value: "renee@hillcountry.example" });
    expect(sent(/emails\/reply/)).toHaveLength(0);
    // The same email isn't handled twice.
    await expect(coldreply.handleEmail(orgId, mail("e1", "renee@hillcountry.example", "Remove me please"))).resolves.toBeNull();

    replyData = { ...base, kind: "hot", summary: "wants to leave SimplePractice", draft: "Hi Kevin, we can show you. Ashley" };
    const hot = await coldreply.handleEmail(orgId, mail("e2", "kevin@bayou.example", "We're looking to move off SimplePractice. How does migration work?"));
    expect(sent(/emails\/reply/)).toHaveLength(0);
    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    const msgs = await db.listChatMessages(orgId, jada.id);
    expect(msgs.at(-1)!.cards).toContain("cold_hot");
    // The owner rewrites it before sending: it goes on the same thread and becomes a real example.
    await caller(owner).cold.sendReply({ organizationId: orgId, id: hot!.id, text: "Hi Kevin, good timing. Want to see it Tuesday? Ashley" });
    const rep = sent(/emails\/reply/)[0].body;
    expect(rep).toMatchObject({ reply_to_uuid: "e2", eaccount: "ashley@tryleaddash.com", subject: "Re: still on SimplePractice?" });
    expect(db.cold.playbook.list(orgId).some((p) => p.kind === "example" && p.body.includes("good timing"))).toBe(true);

    db.cold.insertLeads([{ organizationId: orgId, email: "jen@north.example", firstName: "Jennifer", stage: "in_campaign" }]);
    replyData = { ...base, kind: "not_now", followUpDate: "2027-01-08", followUpNote: "Plan renews in January", draft: "Thanks Jennifer, I'll check back in January. Ashley" };
    await coldreply.handleEmail(orgId, mail("e3", "jen@north.example", "Try me in January when our plan renews."));
    expect(sent(/emails\/reply/)).toHaveLength(2);
    const jen = db.cold.leadByEmail(orgId, "jen@north.example")!;
    expect(jen.followUpAt!.toISOString().slice(0, 10)).toBe("2027-01-08");
    const n = await coldreply.followUpsDue(orgId, new Date("2027-01-09T15:00:00Z"));
    expect(n).toBe(1);
    expect((await caller(owner).cold.replies({ organizationId: orgId }))[0].draft).toContain("January");

    // A question that touches "always needs you" waits for the owner, even at level 2.
    db.cold.insertLeads([{ organizationId: orgId, email: "dana@fox.example", firstName: "Dana", stage: "in_campaign" }]);
    replyData = { ...base, kind: "question", topic: "HIPAA", draft: "Yes. Ashley" };
    const q = await coldreply.handleEmail(orgId, mail("e4", "dana@fox.example", "Is it HIPAA compliant? Do you sign a BAA?"));
    expect(db.cold.replies.get(q!.id, orgId)!.status).toBe("open");
    expect(sent(/emails\/reply/)).toHaveLength(2);
  });

  it("rests an inbox whose bounces pass the limit and takes it out of every sending campaign", async () => {
    const { orgId } = await setup("cold6");
    db.cold.campaigns.create({ organizationId: orgId, name: "Test", angle: "switcher", status: "sending", instantlyId: "camp-9", steps: "[]" });
    routes.unshift([/api\/v2\/accounts\/analytics\/daily/, () => json([{ date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), email_account: "hello@leaddashhq.com", sent: 100, bounced: 9, replies: 1 }])]);
    await cold.syncInboxes(orgId);
    const bad = db.cold.inboxByEmail(orgId, "hello@leaddashhq.com")!;
    expect(bad).toMatchObject({ status: "resting" });
    const patch = sent(/campaigns\/camp-9$/, "PATCH").at(-1)!.body;
    expect(patch.email_list).not.toContain("hello@leaddashhq.com");
    expect(patch.email_list).toHaveLength(2);
    const jada = (await db.getEmployeeByKind(orgId, "outreach"))!;
    expect((await db.listChatMessages(orgId, jada.id)).at(-1)!.content).toMatch(/out of rotation/);
  });

  it("writes the weekly review from the numbers and applies its changes at level 3", async () => {
    const { orgId } = await setup("cold7");
    cold.saveSettings(orgId, { level: 3, perInbox: 20, rampPct: 10, bounceRest: 3, signature: "Ashley", address: "1 Main St", optOut: "Reply stop.", alwaysNeedsYou: "", plan: "growth", website: "https://leaddash.io" });
    const a = db.cold.campaigns.create({ organizationId: orgId, name: "Switchers", angle: "switcher", status: "sending", instantlyId: "c-a", share: 50, steps: JSON.stringify([{ day: 1, subject: "A", subjectB: "B", body: "x" }]) });
    const b = db.cold.campaigns.create({ organizationId: orgId, name: "Missed calls", angle: "missed_calls", status: "sending", instantlyId: "c-b", share: 50, steps: "[]" });
    db.cold.insertLeads([{ organizationId: orgId, email: "x1@x.example", stage: "in_campaign" }]);
    db.cold.updateLead(db.cold.leadByEmail(orgId, "x1@x.example")!.id, orgId, { campaignId: a.id, addedAt: new Date() });
    reviewData = { points: ["Switchers booked 3 of 5 demos."], changes: [{ kind: "share", campaignId: a.id, share: 70, version: "", why: "Most demos" }, { kind: "winner", campaignId: a.id, share: 0, version: "a", why: "Too early" }, { kind: "pause", campaignId: 99999, share: 0, version: "", why: "Unknown campaign" }] };
    const r = await cold.weeklyReview(orgId);
    // The early winner call and the unknown campaign were dropped.
    expect(JSON.parse(r!.changes)).toHaveLength(1);
    expect(r!.status).toBe("applied");
    expect(db.cold.campaigns.get(a.id, orgId)!.share).toBeGreaterThan(db.cold.campaigns.get(b.id, orgId)!.share);
  });

  it("runs the pre-call report when a lead books, keeps only real sources, and saves what the call corrected", async () => {
    const { orgId, owner } = await setup("cold8");
    cold.importCsv(orgId, "list.csv", CSV);
    searchSources = [{ url: "https://bayou.example/team", title: "Team" }];
    searchData = {
      brief: { person: "Kevin Tran", role: "Owner", practice: "Bayou Family Therapy", location: "Houston, TX", size: "6 clinicians", currentSystem: "SimplePractice", currentConfidence: "verified", summary: "Growing practice." },
      profile: { background: "LMFT", authority: "Final say", publicInfo: "" },
      practice: { locations: "1", specialties: "Families", insurance: "Yes", telehealth: "Yes", services: "", hiring: "1 clinician" },
      tech: [{ job: "EHR", tool: "SimplePractice", confidence: "verified", evidence: "Portal link" }],
      costRange: "$250 to $450 a month",
      journey: { steps: ["Contact form"], friction: "Waits for a call back" },
      growth: { stage: "Emerging group", evidence: ["Hiring"], implication: "Show routing" },
      pains: [{ evidence: "Hiring", hypothesis: "Routing gets harder", question: "How do inquiries get routed?" }],
      opportunities: ["Receptionist"],
      demo: { leadWith: "the 24/7 receptionist", then: "EHR", dontLeadWith: "Marketing", order: ["Receptionist"], opening: "Kevin, before I show you anything..." },
      objections: [{ objection: "Switching", reason: "Established", response: "Talk about moving early" }],
      questions: ["What happens after hours?"],
      committee: [{ name: "Kevin Tran", role: "Owner", note: "" }],
      risks: [],
      sources: [{ title: "Team", url: "https://bayou.example/team", date: "Oct 6, 2026" }, { title: "Made up", url: "https://invented.example/x", date: "Oct 6, 2026" }],
    };
    const row = await coldreply.onBooked(orgId, "kevin@bayou.example", new Date("2026-10-06T15:00:00Z"));
    await vi.waitFor(() => expect(db.cold.precall.get(row!.id, orgId)!.status).toBe("ready"));
    expect(prompts.precall_report.at(-1)).toContain("Never impersonate a client");
    const v = await caller(owner).precall.get({ organizationId: orgId, id: row!.id });
    expect(v!.report.sources.map((s) => s.url)).toEqual(["https://bayou.example/team"]);
    expect(v!.battle?.title).toBe("SimplePractice");
    expect(db.cold.leadByEmail(orgId, "kevin@bayou.example")).toMatchObject({ stage: "booked", depth: "full" });
    const doc = await caller(owner).precall.docx({ organizationId: orgId, id: row!.id });
    expect(doc.name).toMatch(/Pre-call report Kevin Tran\.docx/);
    // No notes and Simone wasn't there: it asks for notes.
    await expect(caller(owner).precall.afterCall({ organizationId: orgId, id: row!.id, notes: "" })).rejects.toThrow(/Type what you learned/);
    await caller(owner).precall.afterCall({ organizationId: orgId, id: row!.id, notes: "They have 8 clinicians and 2 more in November." });
    await caller(owner).precall.approveAfter({ organizationId: orgId, id: row!.id });
    expect(JSON.parse(db.cold.leadByEmail(orgId, "kevin@bayou.example")!.research).afterCall.changes[0].after).toContain("8");

    // With no sources from the search, nothing can stay Verified.
    const cleaned = precall.cleanReport(searchData, []);
    expect(cleaned.tech[0].confidence).toBe("likely");
  });

  it("keeps the playbook seeded and editable, and won't remove a campaign that's sending", async () => {
    const { orgId, owner } = await setup("cold9");
    const c = caller(owner);
    const plays = await c.cold.playbook({ organizationId: orgId });
    expect(plays.filter((p) => p.kind === "objection").length).toBeGreaterThanOrEqual(10);
    expect(plays.some((p) => p.kind === "battle" && p.title === "SimplePractice")).toBe(true);
    expect(JSON.stringify(plays)).not.toMatch(/\$1,500/);
    const f = await c.cold.savePlay({ organizationId: orgId, kind: "fact", title: "Migration", body: { text: "We import your clients from SimplePractice." } });
    expect(f.kind).toBe("fact");
    const camp = db.cold.campaigns.create({ organizationId: orgId, name: "x", angle: "switcher", status: "sending", steps: "[]" });
    await expect(c.cold.removeCampaign({ organizationId: orgId, id: camp.id })).rejects.toThrow(/Pause/);
    // A reviewer can look but not change settings.
    const { reviewer } = await makeWorkspace("cold9b").then(async (w) => ({ reviewer: w.reviewer }));
    await expect(caller(reviewer).cold.overview({ organizationId: orgId })).rejects.toThrow();
  });
});
