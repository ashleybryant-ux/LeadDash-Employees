import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as ads from "./employees/ads";
import * as files from "./employees/files";

/**
 * Reese, the Ads Manager: a brief in chat becomes a campaign and a budget
 * split; the owner takes the split; one platform's set is written at a time
 * and waits for Approve; approving brings the next; Microsoft Ads copies
 * Google Search; notes carry into later sets; another version replaces a set.
 */

let llm: typeof import("./_core/llm");
let decision: any = { reply: "", action: "none", choices: [] };
let pages: string[] = [];

// Nothing in these tests reaches the web: the campaign page is served from
// here, and any other fetch gets a fast 404 (the real fetch has a 15 s
// timeout per call, which is longer than a test is allowed to run).
vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));

const blank = { focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [], remember_topic: "", remember_fact: "", remember_category: "" };

function mockAi() {
  vi.spyOn(files, "fetchWebpage").mockImplementation(async (url: string) => {
    pages.push(url);
    return { url, title: "Founding member offer", text: "Join as a founding member for $299 a month. Group practices only.", html: "" };
  });
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "chat_decision") return { ...blank, ...decision } as any;
    if (opts.schemaName === "ad_split") {
      const platforms: string[] = opts.schema.properties.shares.items.properties.platform.enum;
      const kept = platforms.filter((p) => p !== "nextdoor" && p !== "yelp");
      return { shares: kept.map((p, i) => ({ platform: p, share: i === 0 ? 100 - 5 * (kept.length - 1) : 5, why: `${p} reason` })), leftOut: platforms.filter((p) => p === "nextdoor" || p === "yelp"), leftOutWhy: "They reach neighbors, not practice owners." } as any;
    }
    if (String(opts.schemaName).startsWith("ad_")) {
      if (/The ads go to: leaddash\.io\/founding/.test(opts.prompt) && !/Join as a founding member/.test(opts.prompt)) throw new Error("the campaign page did not reach the prompt");
      const props = opts.schema.properties as Record<string, { type: string }>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (k === "summary") out[k] = `${opts.schemaName} summary${/version 2/.test(opts.prompt) ? " v2" : ""}`;
        else if (k === "imagePrompt") out[k] = "A desk with one laptop";
        else if (v.type === "array") out[k] = ["One", "Two", "Three", "Four"];
        else if (k === "headline") out[k] = "A headline that runs far past the forty character limit Meta allows";
        else out[k] = `${k} text${/Notes from the owner/.test(opts.system) ? " with notes" : ""}`;
      }
      return out as any;
    }
    return {} as any;
  });
}

beforeEach(async () => {
  llm = await import("./_core/llm");
  pages = [];
  mockAi();
});
afterEach(() => vi.restoreAllMocks());

describe("Reese, Ads Manager", () => {
  it("is on every workspace's roster, in Marketing", async () => {
    const { orgId } = await makeWorkspace("ads-roster");
    const reese = await db.getEmployeeByKind(orgId, "ads");
    expect(reese).toMatchObject({ name: "Reese", roleTitle: "Ads Manager", department: "Marketing" });
    expect(ads.platformFromWords("Meta, Google and LinkedIn")).toEqual(["meta", "google", "linkedin"]);
    expect(ads.platformFromWords("all of them")).toHaveLength(10);
    expect(ads.platformFromWords("facebook and tiktok and bing")).toEqual(["meta", "microsoft", "tiktok"]);
    expect(ads.daysBetween("2026-10-01", "2026-12-31")).toBe(92);
    expect(ads.dateIn("10/01/2026")).toBe("2026-10-01");
    expect(ads.dateIn("Oct 1")).toBe("");
  });

  it("turns the brief into a campaign and a split in chat, then writes one platform at a time on approval", async () => {
    const { orgId, owner } = await makeWorkspace("ads-flow");
    const me = caller(owner);
    const reese = (await db.getEmployeeByKind(orgId, "ads"))!;
    // The brief: Reese has all four, so the action is ads_campaign.
    decision = { reply: "On it.", action: "ads_campaign", title: "Founding member offer", goal: "Sign-ups at $299 a month", target: "Owners of group practices", url: "leaddash.io/founding", notes: "all platforms", count: 3000, date: "2026-10-01", time: "2026-12-31" };
    const r = await me.chat.send({ organizationId: orgId, employeeId: reese.id, text: "Write ads for the founding member offer. All platforms, $3,000 from 10/01/2026 through 12/31/2026." });
    expect(r.reply.content).toContain("Here is the split for $3,000 over 92 days.");
    expect(r.reply.content).toContain("Nextdoor and Yelp are left out: They reach neighbors, not practice owners.");
    const cards = JSON.parse(r.reply.cards!);
    expect(cards[0].type).toBe("ad_budget");
    const list = await me.ads.campaigns({ organizationId: orgId });
    expect(list).toHaveLength(1);
    const c = list[0];
    expect(c).toMatchObject({ name: "Founding member offer", status: "budget", budget: "$3,000", days: 92, startDate: "2026-10-01", endDate: "2026-12-31" });
    expect(c.platforms).toHaveLength(10);
    expect(c.rows.filter((x) => x.leftOut).map((x) => x.platform)).toEqual(["nextdoor", "yelp"]);
    expect(c.rows.reduce((n, x) => n + x.share, 0)).toBe(100);
    const meta = c.rows.find((x) => x.platform === "meta")!;
    expect(meta.share).toBe(65);
    expect(meta.totalCents).toBe(195_000);
    expect(meta.perDayCents).toBe(2120);
    expect(c.counts).toEqual({ platforms: 8, approved: 0, skipped: 0, open: 8 });

    // Use this split: Meta is written first and waits in chat.
    await me.ads.start({ organizationId: orgId, id: c.id, mode: "reese" });
    await ads.settled();
    let v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    expect(v.status).toBe("review");
    expect(v.currentPlatform).toBe("meta");
    const metaSet = v.rows.find((x) => x.platform === "meta")!.set!;
    expect(metaSet.status).toBe("review");
    expect(metaSet.content.headline).toBe("A headline that runs far past the forty ");
    expect((metaSet.content.headline as string).length).toBe(40);
    expect(metaSet.imageUrl).toBeNull();
    expect(metaSet.imageError).toMatch(/OPENAI_API_KEY/);
    expect(v.rows.find((x) => x.platform === "google")!.set).toBeNull();
    let msgs = await db.listChatMessages(orgId, reese.id, 30);
    let last = msgs[msgs.length - 1];
    expect(last.content).toContain("Meta first. One platform at a time; the next one comes when you approve this one.");
    expect(JSON.parse(last.cards!)[0]).toMatchObject({ type: "ad_set", id: metaSet.id });
    const set = await me.ads.set({ organizationId: orgId, id: metaSet.id });
    expect(set.position).toEqual({ n: 1, of: 8 });
    expect(set.text).toContain("Founding member offer · Meta");
    expect(set.text).toContain("Headline:\nA headline that runs far past the forty");

    // Approve in words: Google Search comes next.
    decision = { reply: "", action: "ads_approve", target: "" };
    const a = await me.chat.send({ organizationId: orgId, employeeId: reese.id, text: "Approved." });
    expect(a.reply.content).toBe("Meta approved.");
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    expect(v.rows.find((x) => x.platform === "meta")!.set!.status).toBe("approved");
    const google = v.rows.find((x) => x.platform === "google")!.set!;
    expect(google.status).toBe("review");
    expect(google.content.headlines).toEqual(["One", "Two", "Three", "Four"]);
    msgs = await db.listChatMessages(orgId, reese.id, 30);
    expect(msgs[msgs.length - 1].content).toBe("Google Search next.");

    // A note carries into every set written after it.
    decision = { reply: "", action: "ads_note", notes: "Make the headlines shorter." };
    const n = await me.chat.send({ organizationId: orgId, employeeId: reese.id, text: "Make the headlines shorter on the next ones." });
    expect(n.reply.content).toContain("Noted for the rest of the set: Make the headlines shorter");
    expect((await me.ads.campaign({ organizationId: orgId, id: c.id })).notes).toEqual(["Make the headlines shorter."]);

    // Approve Google from the button, YouTube is written with the note, then Microsoft copies Google.
    await me.ads.approve({ organizationId: orgId, id: google.id });
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    const yt = v.rows.find((x) => x.platform === "youtube")!.set!;
    expect(yt.content.script).toBe("script text with notes");
    await me.ads.approve({ organizationId: orgId, id: yt.id });
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    const ms = v.rows.find((x) => x.platform === "microsoft")!.set!;
    expect(ms.summary).toBe("Copied from Google Search");
    expect(ms.content).toEqual(google.content);
    expect(ms.copies).toBe("Google Search");

    // Another version replaces the one in front of you; Edit keeps the owner's words; Skip moves on.
    decision = { reply: "", action: "ads_rewrite", notes: "A softer hook", target: "" };
    await me.chat.send({ organizationId: orgId, employeeId: reese.id, text: "Another version with a softer hook." });
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    const ms2 = v.rows.find((x) => x.platform === "microsoft")!.set!;
    expect(ms2.id).not.toBe(ms.id);
    expect(ms2.version).toBe(2);
    expect(db.ads.set(orgId, ms.id)!.status).toBe("replaced");
    const edited = await me.ads.saveSet({ organizationId: orgId, id: ms2.id, content: { headlines: ["EHR With Billing Built In", "No Add-On Fees, Ever"] } });
    expect(edited.content.headlines).toEqual(["EHR With Billing Built In", "No Add-On Fees, Ever"]);
    expect(edited.summary).toBe("EHR With Billing Built In");
    await me.ads.approve({ organizationId: orgId, id: ms2.id });
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    const li = v.rows.find((x) => x.platform === "linkedin")!.set!;
    await me.ads.skip({ organizationId: orgId, id: li.id });
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    expect(v.rows.find((x) => x.platform === "linkedin")!.set!.status).toBe("skipped");
    expect(v.currentPlatform).toBe("tiktok");
    expect(v.counts).toEqual({ platforms: 8, approved: 4, skipped: 1, open: 3 });

    // Through to the end: the campaign is done and Reese says so.
    for (const p of ["tiktok", "reddit", "spotify"]) {
      const s = (await me.ads.campaign({ organizationId: orgId, id: c.id })).rows.find((x) => x.platform === p)!.set!;
      await me.ads.approve({ organizationId: orgId, id: s.id });
      await ads.settled();
    }
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    expect(v.status).toBe("done");
    expect(v.currentPlatform).toBeNull();
    msgs = await db.listChatMessages(orgId, reese.id, 40);
    expect(msgs[msgs.length - 1].content).toContain("That is every platform for Founding member offer: 7 approved, 1 skipped.");

    // Status, a left-out platform written anyway, and the zip.
    decision = { reply: "", action: "ads_status" };
    const st = await me.chat.send({ organizationId: orgId, employeeId: reese.id, text: "Where are we?" });
    expect(st.reply.content).toBe("Founding member offer: 7 of 8 approved, finished.");
    await me.ads.writePlatform({ organizationId: orgId, id: c.id, platform: "nextdoor" });
    await ads.settled();
    v = await me.ads.campaign({ organizationId: orgId, id: c.id });
    expect(v.rows.find((x) => x.platform === "nextdoor")).toMatchObject({ leftOut: false, set: { status: "review" } });
    expect(v.counts.platforms).toBe(9);
    const zip = await me.ads.download({ organizationId: orgId, id: c.id });
    expect(zip.url).toMatch(/\/files\/org-\d+\/ads\/founding-member-offer[^/]*\.zip$/);
    expect(pages).toEqual(Array(8).fill("https://leaddash.io/founding"));
  }, 20_000);

  it("takes a brief from the Ads tab, with an even split and typed dates, and the budget can be changed", async () => {
    const { orgId, owner } = await makeWorkspace("ads-form");
    const me = caller(owner);
    const made = await me.ads.create({ organizationId: orgId, name: "EHR demo requests", goal: "Demo requests", audience: "Group practice owners", page: "leaddash.io/demo", platforms: ["meta", "google", "linkedin", "nextdoor"], budget: "$2,000", startDate: "11/02/2026", endDate: "12/31/2026", splitMode: "even", mustSay: "No add-on fees." });
    let v = await me.ads.campaign({ organizationId: orgId, id: made.id });
    expect(v).toMatchObject({ budget: "$2,000", startDate: "2026-11-02", endDate: "2026-12-31", days: 60, splitMode: "even", mustSay: "No add-on fees." });
    expect(v.rows.map((r) => [r.platform, r.share, r.leftOut])).toEqual([["meta", 34, false], ["google", 33, false], ["linkedin", 33, false], ["nextdoor", 0, true]]);
    // The budget card is in chat.
    const reese = (await db.getEmployeeByKind(orgId, "ads"))!;
    const msgs = await db.listChatMessages(orgId, reese.id, 10);
    expect(JSON.parse(msgs[msgs.length - 1].cards!)[0].type).toBe("ad_budget");
    // Change it: shares must add up to 100.
    await expect(me.ads.saveBudget({ organizationId: orgId, id: made.id, budget: "$2,400", startDate: "11/02/2026", endDate: "12/31/2026", shares: { meta: 50, google: 30, linkedin: 30 }, mode: "custom" })).rejects.toThrow(/add up to 110%/);
    v = await me.ads.saveBudget({ organizationId: orgId, id: made.id, budget: "$2,400", startDate: "11/02/2026", endDate: "12/31/2026", shares: { meta: 50, google: 30, linkedin: 20 }, mode: "custom" });
    expect(v.budget).toBe("$2,400");
    expect(v.rows.find((r) => r.platform === "meta")).toMatchObject({ share: 50, totalCents: 120_000, perDayCents: 2000 });
    expect(v.perDayCents).toBe(4000);
    // Edit the brief: fewer platforms.
    v = await me.ads.save({ organizationId: orgId, id: made.id, platforms: ["meta", "google"], neverSay: "Guaranteed results." });
    expect(v.platforms).toEqual(["meta", "google"]);
    expect(v.neverSay).toBe("Guaranteed results.");
  });
});
