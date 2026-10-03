import { beforeEach, describe, expect, it, vi } from "vitest";

// The browser is scripted here; browser.test.ts drives a real one.
const browserCalls: any[] = [];
const chatSystems: string[] = [];
let browserReplies: ((task: any) => any)[] = [];
vi.mock("./employees/browser", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    runBrowserTask: vi.fn(async (task: any) => {
      browserCalls.push(task);
      const next = browserReplies.shift();
      if (!next) return { status: "failed", result: "", note: "no script", storageState: null, downloads: [], log: [], screenshotUrl: null };
      return { storageState: '{"cookies":[]}', downloads: [], log: [], screenshotUrl: "/files/org-1/browser/step.png", note: "", result: "", ...next(task) };
    }),
  };
});

vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async () => ({ queries: [], sources: [], data: { history: "", url: "" } })),
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName === "chat_decision") {
        chatSystems.push(opts.system);
        return { reply: "", action: "check_bidprime" };
      }
      if (opts.schemaName === "opportunity_details")
        return { title: "Behavioral Health EHR System", host: "Oklahoma County Purchasing", sourceUrl: "", deadline: "Nov 14, 2026", amount: "", equity: "", stage: "", eligibility: "Registered county vendors", location: "Oklahoma City", eventDate: "", audience: "", angle: "", summary: "A cloud EHR for 12 clinicians.", fitScore: 88, fitCall: "apply", fitReason: "Covers every module.", kind: "bid" };
      if (opts.schemaName === "requirements") return { due: "Nov 14, 2026", questions: [], attachments: [], channel: "portal", channelDetail: "oklahomacounty.bonfirehub.com", questionsDue: "Oct 24, 2026", questionsTo: "buyer@oklahomacounty.org", aiPolicy: { restricted: false, note: "", citation: "" } };
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as apply from "./employees/apply";
import * as bids from "./employees/bids";

beforeEach(() => {
  browserCalls.length = 0;
  browserReplies = [];
});

const lastChat = async (orgId: number) => {
  const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
  const msgs = await db.listChatMessages(orgId, morgan.id);
  return msgs[msgs.length - 1];
};

describe("BidPrime", () => {
  it("saves the sign-in encrypted and never shows the password back", async () => {
    const { orgId, owner } = await makeWorkspace("bp-save");
    browserReplies.push(() => ({ status: "done", result: '{"bids":[]}' }));
    const v = await caller(owner).bidprime.save({ organizationId: orgId, email: "ashleyb@leaddash.io", password: "pw-123456" });
    expect(v.connected && v.email).toBe("ashleyb@leaddash.io");
    expect(JSON.stringify(v)).not.toContain("pw-123456");
    const conn = await db.getConnectionByProvider(orgId, "bidprime");
    expect(conn?.secretsEncrypted).toBeTruthy();
    expect(conn?.secretsEncrypted).not.toContain("pw-123456");
    await apply.idle();
  });

  it("reads new bids, skips ones already on Opportunities, opens each and saves its documents", async () => {
    const { orgId } = await makeWorkspace("bp-read");
    await bids.saveBidPrime(orgId, "a@b.co", "pw-123456");
    await db.createOpp({ organizationId: orgId, kind: "bid", title: "Janitorial Services", host: "Logan County", source: "BidPrime" });
    browserReplies.push((t) => {
      expect(t.secrets.password).toBe("pw-123456");
      expect(t.allowSubmit).toBeFalsy();
      return { status: "done", result: JSON.stringify({ bids: [{ title: "Behavioral Health EHR System", agency: "Oklahoma County Purchasing", detailUrl: "https://app.bidprime.example/bid/118" }, { title: "Janitorial Services", agency: "Logan County" }] }) };
    });
    browserReplies.push(() => ({ status: "done", result: "Scope: cloud EHR. Responses through Bonfire. Questions to buyer@oklahomacounty.org by Oct 24, 2026.", downloads: [{ name: "RFP 2026-118.txt", buf: Buffer.from("Request for proposals: behavioral health EHR. Due Nov 14, 2026."), mime: "text/plain", url: "https://app.bidprime.example/doc/1" }] }));
    const r = await bids.checkBidPrime(orgId, true);
    await apply.idle();
    expect(r.added).toBe(1);
    expect(browserCalls).toHaveLength(2);
    const opp = (await db.listOpps(orgId)).find((o) => o.title === "Behavioral Health EHR System")!;
    expect(opp.kind).toBe("bid");
    expect(opp.source).toBe("BidPrime");
    expect((await db.listOppFiles(orgId, opp.id)).map((f) => f.name)).toContain("RFP 2026-118.txt");
    expect((await lastChat(orgId)).content).toMatch(/1 new bid: 1 strong fit/);
    expect((await bids.bidprimeView(orgId)).connected).toBe(true);
  });

  it("asks for a sign-in code in chat, then checks again with it", async () => {
    const { orgId, owner } = await makeWorkspace("bp-code");
    await bids.saveBidPrime(orgId, "a@b.co", "pw-123456");
    browserReplies.push(() => ({ status: "need_code" }));
    await bids.checkBidPrime(orgId, true);
    const msg = await lastChat(orgId);
    expect(JSON.parse(msg.cards!)[0].type).toBe("bidprime_code");
    const v = await bids.bidprimeView(orgId);
    expect(v.connected && v.waitingCode).toBe(true);

    browserReplies.push((t) => {
      expect(t.secrets.code).toBe("482915");
      return { status: "done", result: '{"bids":[]}' };
    });
    await caller(owner).bidprime.code({ organizationId: orgId, code: "482 915" });
    await apply.idle();
    expect(browserCalls.at(-1).secrets.code).toBe("482915");
    expect((await lastChat(orgId)).content).toMatch(/Nothing new/);
  });

  it("checks once a day, after 7:00 in the workspace's time zone", async () => {
    const { orgId } = await makeWorkspace("bp-tick");
    await bids.saveBidPrime(orgId, "a@b.co", "pw-123456");
    const before = browserCalls.length;
    await bids.bidsTick(new Date("2026-10-05T11:30:00Z")); // 6:30 AM Chicago
    await apply.idle();
    expect(browserCalls.filter((c) => c.orgId === orgId).length).toBe(0);
    browserReplies.push(() => ({ status: "done", result: '{"bids":[]}' }));
    await bids.bidsTick(new Date("2026-10-05T12:30:00Z")); // 7:30 AM
    await apply.idle();
    expect(browserCalls.length).toBeGreaterThan(before);
    const mine = () => browserCalls.filter((c) => c.orgId === orgId).length;
    const after = mine();
    await bids.bidsTick(new Date("2026-10-05T18:00:00Z"));
    await apply.idle();
    expect(mine()).toBe(after);
  });
});

describe("Asking Morgan about BidPrime in chat", () => {
  it("knows it is connected, signs in with the saved login, and never asks for one", async () => {
    const { orgId, owner } = await makeWorkspace("bp-chat");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    const before = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "did you look in bidprime" });
    expect(before.reply.content).toMatch(/isn't connected/);
    await bids.saveBidPrime(orgId, "a@b.co", "pw-123456");
    browserReplies.push(() => ({ status: "done", result: '{"bids":[]}' }));
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "whats in my bidprime inbox?" });
    expect(r.reply.content).toMatch(/Signing in to BidPrime as a@b\.co/);
    expect(chatSystems.at(-1)).toContain("BidPrime: connected as a@b.co");
    expect(chatSystems.at(-1)).toContain("Never ask the person for a password");
    await apply.idle();
    expect(browserCalls.at(-1).secrets.email).toBe("a@b.co");
    expect((await lastChat(orgId)).content).toMatch(/Nothing new/);
  });
});

describe("Showing that Morgan is still working", () => {
  it("says what she's doing in the background, and nothing when she's done", async () => {
    const { orgId, owner } = await makeWorkspace("bp-working");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    expect(await caller(owner).chat.working({ organizationId: orgId, employeeId: morgan.id })).toEqual({ busy: false, what: "" });
    const opp = await db.createOpp({ organizationId: orgId, kind: "bid", title: "County EHR", host: "County", packageStatus: "fetching" });
    expect(await caller(owner).chat.working({ organizationId: orgId, employeeId: morgan.id })).toMatchObject({ busy: true, what: "Downloading and reading the documents for County EHR" });
    await db.updateOpp(opp.id, orgId, { packageStatus: "ready" });
    expect((await caller(owner).chat.working({ organizationId: orgId, employeeId: morgan.id })).busy).toBe(false);
  });
});

describe("Submitting an approved response", () => {
  async function approvedBid(orgId: number, channel: string, channelDetail: string) {
    const opp = await db.createOpp({ organizationId: orgId, kind: "bid", title: "Behavioral Health EHR System", host: "Oklahoma County Purchasing", sourceUrl: "https://oklahomacounty.bonfirehub.com/opportunities/118", requirements: JSON.stringify({ channel, channelDetail, questionsTo: "buyer@oklahomacounty.org" }), packageStatus: "ready" });
    const app = await db.createApplication({ organizationId: orgId, opportunityId: opp.id, title: opp.title, status: "approved", channel, channelDetail, questions: JSON.stringify([{ id: "q1", text: "Company overview", answer: "LeadDash builds an EHR.", limit: "", maxWords: 0, sources: [], missing: [] }]), attachments: "[]" });
    return { opp, app };
  }

  it("signs in to the saved agency portal, uploads the response and records the confirmation", async () => {
    const { orgId, owner } = await makeWorkspace("bid-portal");
    await caller(owner).portals.save({ organizationId: orgId, name: "Oklahoma County Purchasing", url: "https://oklahomacounty.bonfirehub.com", username: "ashleyb@leaddash.io", password: "portal-pw" });
    const { app } = await approvedBid(orgId, "portal", "oklahomacounty.bonfirehub.com");
    const ready = await bids.readiness(orgId, app);
    expect(ready.route).toMatchObject({ how: "portal", ready: true });
    browserReplies.push((t) => {
      expect(t.allowSubmit).toBe(true);
      expect(t.secrets).toMatchObject({ email: "ashleyb@leaddash.io", password: "portal-pw" });
      expect(t.files.some((f: any) => /\.docx$/.test(f.name))).toBe(true);
      return { status: "done", result: '{"confirmation":"BF-2026-118-0441"}' };
    });
    await bids.autoSubmit(orgId, app.id);
    const after = (await db.getApplication(app.id, orgId))!;
    expect(after.status).toBe("submitted");
    expect(after.confirmation).toBe("BF-2026-118-0441");
    expect(after.receiptUrl).toMatch(/^\/files\//);
  });

  it("without a saved sign-in or Google, says plainly it's ready for the person to send", async () => {
    const { orgId } = await makeWorkspace("bid-manual");
    const { app } = await approvedBid(orgId, "email", "bids@city.example");
    expect((await bids.readiness(orgId, app)).route).toMatchObject({ how: "email", ready: false });
    await bids.autoSubmit(orgId, app.id);
    expect(browserCalls).toHaveLength(0);
    expect((await db.getApplication(app.id, orgId))!.status).toBe("approved");
    expect((await lastChat(orgId)).content).toMatch(/ready for you to send/);
  });

  it("drafts a question to the buyer that waits in Approvals", async () => {
    const { orgId, owner } = await makeWorkspace("bid-ask");
    const { opp } = await approvedBid(orgId, "portal", "");
    const item = await caller(owner).opps.ask({ organizationId: orgId, id: opp.id, question: "Is a hosted (cloud) system acceptable?" });
    expect(item.status).toBe("pending_approval");
    expect(JSON.parse(item.metadata!).email).toBe("buyer@oklahomacounty.org");
    expect(item.body).toContain("Is a hosted (cloud) system acceptable?");
  });
});
