import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as sales from "./employees/sales";
import { kindFor, npiKindsFor, prospectingTicks, repeatDue, repeatPeriod, shortLabel } from "./employees/prospecting";

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const npiUrls: string[] = [];
let llm: typeof import("./_core/llm");

const FOUND = (name: string, extra: Record<string, unknown> = {}) => ({ name, city: "Lakewood, CO", contactName: "J. Lowe", contactTitle: "Partner", email: "", phone: "303-555-0101", website: "https://hl.example", foundOn: "Firm site", sourceUrl: "https://hl.example/team", size: "", partnerType: "Family law", fitScore: 86, fitReason: "Mentions family counseling referrals.", linkedin: "", ...extra });

beforeEach(async () => {
  npiUrls.length = 0;
  llm = await import("./_core/llm");
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).startsWith("https://npiregistry.cms.hhs.gov/api/")) {
      npiUrls.push(String(url));
      return json({ result_count: 0, results: [] });
    }
    return json({ error: "no route" }, 500);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Riley finds whoever the owner asks for", () => {
  it("searches the open target in the area, labels each prospect with the search, and skips the NPI Registry for non-health targets", async () => {
    let call: any = null;
    vi.spyOn(llm, "searchJson").mockImplementation(async (opts: any) => {
      call = opts;
      return { data: { label: "Family law attorneys", items: [FOUND("Harper & Lowe Family Law"), FOUND("Front Range Mediation", { phone: "", contactName: "" })] }, sources: [{ url: "https://hl.example/team" }], queries: ["family law attorneys Denver"] } as any;
    });
    const { orgId } = await makeWorkspace("rs-open");
    const r = await sales.findProspects(orgId, { target: "Family law attorneys who might refer clients to us", area: "Denver metro", count: 10 });
    expect(call.prompt).toContain("Find: Family law attorneys who might refer clients to us");
    expect(call.prompt).toContain("Area: Denver metro");
    expect(call.system).toContain("Return up to 10");
    expect(npiUrls).toHaveLength(0);
    const rows = await db.listProspects(orgId);
    expect(rows.map((p) => p.search)).toEqual(["Family law attorneys, Denver metro", "Family law attorneys, Denver metro"]);
    expect(rows.every((p) => p.kind === "referral")).toBe(true);
    expect(sales.searchReply(r)).toBe("Found 2 family law attorneys in Denver metro. 1 lists a contact. They're on my Prospects tab.");
  });

  it("starts from the NPI Registry only when the target is about health or therapy providers", async () => {
    expect(npiKindsFor("Family law attorneys and school counselors who refer families to counseling")).toEqual([]);
    expect(npiKindsFor("Wedding venues")).toEqual([]);
    expect(npiKindsFor("Therapy practices")).toEqual(["practices"]);
    expect(npiKindsFor("Group practices with LPCs that take insurance")).toEqual(["practices"]);
    expect(npiKindsFor("Referral partners: Schools, Pediatric offices")).toEqual(["Pediatric offices"]);
    expect(kindFor("Pediatricians who refer kids to therapy")).toBe("referral");
    expect(kindFor("Therapy practices")).toBe("practice");
    expect(shortLabel("Family law attorneys who refer families to counseling")).toBe("Family law attorneys");

    vi.spyOn(llm, "searchJson").mockImplementation(async () => ({ data: { label: "", items: [] }, sources: [], queries: [] }) as any);
    const { orgId } = await makeWorkspace("rs-npi");
    await sales.findProspects(orgId, { target: "Counseling practices", area: "Austin, TX" });
    expect(npiUrls.some((u) => u.includes("taxonomy_description=Counselor") && u.includes("state=TX") && u.includes("city=Austin"))).toBe(true);
  });

  it("carries old settings over: therapy becomes referral partners, software becomes therapy practices", () => {
    expect(sales.readSales(JSON.stringify({ sells: "therapy", partnerTypes: ["Schools", "Churches", "Made up"] })).target).toBe("Referral partners: Schools, Churches");
    expect(sales.readSales(JSON.stringify({ sells: "software", area: "Texas" }))).toMatchObject({ target: "Therapy practices", area: "Texas", repeat: "off", count: 25 });
    expect(sales.readSales("{}")).toMatchObject({ target: "", repeat: "off", count: 25 });
    expect(sales.readSales(JSON.stringify({ target: "Wedding venues", repeat: "monthly", count: 50 }))).toMatchObject({ target: "Wedding venues", repeat: "monthly", count: 50 });
    expect(sales.readSales(JSON.stringify({ target: "x", repeat: "daily", count: 500 }))).toMatchObject({ repeat: "off", count: 25 });
  });

  it("repeats on Monday from 8:00 AM (or the 1st) in the workspace time zone, once per period", () => {
    const tz = "America/Denver";
    // Monday Oct 12, 2026: 7:30 AM is too early, 8:05 AM is due.
    expect(repeatDue(new Date("2026-10-12T13:30:00Z"), tz, "weekly", "")).toBeNull();
    expect(repeatDue(new Date("2026-10-12T14:05:00Z"), tz, "weekly", "")).toBe("2026-10-12");
    expect(repeatDue(new Date("2026-10-12T14:05:00Z"), tz, "weekly", "2026-10-12")).toBeNull();
    // Sunday evening in Denver is already Monday in UTC; it still belongs to the week before.
    expect(repeatPeriod(new Date("2026-10-12T02:00:00Z"), tz, "weekly")).toMatchObject({ key: "2026-10-05", first: false });
    // Tuesday catches up a Monday the server missed.
    expect(repeatDue(new Date("2026-10-13T18:00:00Z"), tz, "weekly", "2026-10-05")).toBe("2026-10-12");
    // Monthly: the 1st after 8:00 AM.
    expect(repeatDue(new Date("2026-11-01T14:30:00Z"), tz, "monthly", "2026-10")).toBeNull();
    expect(repeatDue(new Date("2026-11-01T16:00:00Z"), tz, "monthly", "2026-10")).toBe("2026-11");
    expect(repeatDue(new Date("2026-11-20T16:00:00Z"), tz, "monthly", "2026-11")).toBeNull();
    expect(repeatPeriod(new Date(), tz, "off")).toBeNull();
  });

  it("runs the saved search on schedule, posts what it found in Riley's chat, and not twice in a week", async () => {
    const search = vi.spyOn(llm, "searchJson").mockImplementation(async () => ({ data: { label: "Wedding venues", items: [FOUND("Aspen Barn")] }, sources: [{ url: "https://hl.example/team" }], queries: ["q"] }) as any);
    const { orgId, owner } = await makeWorkspace("rs-tick");
    await db.updateOrganization(orgId, { timezone: "America/Denver" });
    await caller(owner).sales.saveSettings({ organizationId: orgId, target: "Wedding venues", area: "Denver metro", repeat: "weekly", count: 10 });
    const saved = (await caller(owner).sales.settings({ organizationId: orgId }));
    // Turning it on today waits for the next Monday.
    expect(saved.lastRepeat).toBe(repeatPeriod(new Date(), "America/Denver", "weekly")!.key);

    // 8:05 AM in Denver (winter time) on Monday Jan 7, 2030.
    await prospectingTicks(new Date("2030-01-07T15:05:00Z"));
    expect(search).toHaveBeenCalledTimes(1);
    expect((await db.listProspects(orgId)).map((p) => p.search)).toEqual(["Wedding venues, Denver metro"]);
    const riley = (await db.getEmployeeByKind(orgId, "prospecting"))!;
    expect((await db.listChatMessages(orgId, riley.id, 5)).some((m) => m.role === "employee" && m.content.startsWith("Found 1 match in Denver metro."))).toBe(true);
    expect((await caller(owner).sales.settings({ organizationId: orgId })).lastRepeat).toBe("2030-01-07");

    await prospectingTicks(new Date("2030-01-08T16:00:00Z"));
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("in chat, Every Monday saves the search to repeat", async () => {
    const { orgId, owner } = await makeWorkspace("rs-chat");
    const riley = (await db.getEmployeeByKind(orgId, "prospecting"))!;
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) =>
      opts.schemaName === "chat_decision"
        ? ({ reply: "", action: "repeat_search", focus: "Denver metro", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "Family law attorneys who might refer clients to us", to: "weekly", date: "", time: "", attendees: "", teammate: "", choices: [] } as any)
        : ({} as any)
    );
    vi.spyOn(llm, "generateText").mockImplementation(async () => "Done.");
    await caller(owner).chat.send({ organizationId: orgId, employeeId: riley.id, text: "Every Monday" });
    expect(await caller(owner).sales.settings({ organizationId: orgId })).toMatchObject({ target: "Family law attorneys who might refer clients to us", area: "Denver metro", repeat: "weekly", count: 25 });
  });

  it("in chat, a search replies with what it found and offers to repeat it every Monday", async () => {
    vi.spyOn(llm, "searchJson").mockImplementation(async () => ({ data: { label: "Family law attorneys", items: [FOUND("Harper & Lowe Family Law")] }, sources: [{ url: "https://hl.example/team" }], queries: ["q"] }) as any);
    const { orgId, owner } = await makeWorkspace("rs-chat-find");
    const riley = (await db.getEmployeeByKind(orgId, "prospecting"))!;
    vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) =>
      opts.schemaName === "chat_decision"
        ? ({ reply: "", action: "find_prospects", focus: "Denver metro", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "Family law attorneys who might refer clients to us", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] } as any)
        : ({} as any)
    );
    vi.spyOn(llm, "generateText").mockImplementation(async (opts: any) => String(opts.prompt ?? ""));
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: riley.id, text: "Find family law attorneys who might refer clients to us in the Denver metro" });
    const cards = JSON.parse(r.reply.cards ?? "[]");
    expect(cards.find((c: any) => c.type === "choices")?.options).toEqual(["Every Monday", "Just this once"]);
    expect((await db.listProspects(orgId))[0].search).toBe("Family law attorneys, Denver metro");
  });
});
