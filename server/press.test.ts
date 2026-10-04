import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prompts: Record<string, string> = {};
let picked: any = { requests: [] };
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async () => ({ queries: [], sources: [], data: {} })),
    generateJson: vi.fn(async (opts: any) => {
      prompts[opts.schemaName] = `${opts.system}\n${opts.prompt}`;
      if (opts.schemaName === "press_requests") return picked;
      if (opts.schemaName === "opportunity_details") {
        const good = /burnout/i.test(opts.prompt);
        return { title: good ? "Therapists on burnout in small practices" : "Best budget travel apps", host: good ? "Forbes" : "Travel blog", deadline: "Oct 6, 2026", amount: "", equity: "", stage: "", eligibility: "", location: "", eventDate: "", audience: "", angle: "", summary: "", sourceUrl: "", foundOn: "", fitScore: good ? 85 : 30, fitCall: good ? "apply" : "skip", fitReason: "Fits her practice ownership expertise.", status: "open", howToSubmit: "", contact: { name: "", title: "", phone: "", email: "" }, kind: "media" };
      }
      return {};
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as apply from "./employees/apply";
import * as press from "./employees/press";
import * as calendars from "./employees/calendars";

let calls: { url: string; init: any }[] = [];
let routes: [RegExp, (url: string, init: any) => any][] = [];
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let inbox: press.MailMessage[] = [];
const tested: any[] = [];
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
  press.setMailbox({
    async test(cfg) {
      tested.push(cfg);
      if (cfg.pass === "wrongpass") throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
    },
    async fetch(_cfg, afterUid) {
      return inbox.filter((m) => m.uid > afterUid);
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  press.setMailbox(null);
});

const HARO = `HARO Media Queries, Morning Edition
1) Summary: Therapists on burnout in small practices
Name: Anonymous  Category: Health  Email: query-8k2@helpareporter.com  Media Outlet: Forbes  Deadline: 5:00 PM ET - 6 October
Query: Looking for licensed therapists who own a group practice to talk about burnout.
2) Summary: Best budget travel apps
Query: Frequent travelers only.`;

describe("Taylor's press inbox", () => {
  it("connects an inbox with an app password it checks, reads only press emails, and pitches the requests that fit", async () => {
    const { orgId, owner } = await makeWorkspace("press");
    const c = caller(owner);
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;

    // A wrong app password is refused in plain words; a good one is saved encrypted.
    await expect(c.press.save({ organizationId: orgId, email: "press@gmail.com", password: "wrongpass" })).rejects.toThrow(/didn't accept that app password/);
    const v = await c.press.save({ organizationId: orgId, email: "Press@Gmail.com", password: "abcd efgh ijkl mnop" });
    expect(v).toMatchObject({ connected: true, email: "press@gmail.com", host: "imap.gmail.com", status: "connected" });
    expect(tested.pop()).toMatchObject({ host: "imap.gmail.com", port: 993, user: "press@gmail.com", pass: "abcdefghijklmnop" });
    expect(JSON.stringify(v)).not.toContain("abcdefgh");
    expect(press.pressLink(orgId)!.secretsEncrypted).not.toContain("abcdefgh");
    // A Workspace domain needs the server typed in.
    await expect(press.savePressInbox(orgId, { email: "press@leaddash.io", password: "x" })).rejects.toThrow(/imap\.gmail\.com/);
    // Changing the server keeps the saved password.
    await c.press.save({ organizationId: orgId, email: "press@gmail.com", host: "imap.gmail.com" });
    expect(tested.pop().pass).toBe("abcdefghijklmnop");

    inbox = [
      { uid: 7, messageId: "<m7@helpareporter.com>", from: "HARO <haro@helpareporter.com>", subject: "[HARO] Morning Edition", text: HARO },
      { uid: 8, messageId: "<m8@x>", from: "Friend <friend@example.com>", subject: "Lunch?", text: "Want to get lunch?" },
    ];
    picked = {
      requests: [
        { title: "Therapists on burnout in small practices", outlet: "Forbes", reporter: "", deadline: "Oct 6, 2026", query: "Looking for licensed therapists who own a group practice to talk about burnout.", respondBy: "email", replyTo: "query-8k2@helpareporter.com", link: "", fitReason: "She owns a group practice." },
        { title: "Best budget travel apps", outlet: "Travel blog", reporter: "", deadline: "", query: "Frequent travelers only.", respondBy: "platform", replyTo: "", link: "", fitReason: "" },
      ],
    };
    const r = await press.checkPress(orgId);
    expect(r).toEqual({ found: 2, pitched: 1 });
    // Only the HARO email went to the AI, with the owner's Brain and the rule against off-topic answers.
    expect(prompts.press_requests).toContain("Morning Edition");
    expect(prompts.press_requests).not.toContain("Want to get lunch");
    expect(prompts.press_requests).toContain("Reporters remove sources who answer off-topic");
    const opps = await db.listOpps(orgId, ["media"]);
    expect(opps.map((o) => [o.title, o.source, o.fitCall])).toEqual(expect.arrayContaining([["Therapists on burnout in small practices", "HARO", "apply"], ["Best budget travel apps", "HARO", "skip"]]));
    const burnout = opps.find((o) => o.fitCall === "apply")!;
    // The request is kept word for word with how to answer, for the pitch.
    expect((await db.listOppFiles(orgId, burnout.id))[0].name).toBe("HARO request.txt");
    expect(db.chunksOf(orgId, "opp_file", (await db.listOppFiles(orgId, burnout.id))[0].id).map((x) => x.text).join(" ")).toContain("Answer by email to query-8k2@helpareporter.com");
    expect(await db.getApplicationByOpp(burnout.id, orgId)).toBeTruthy();
    const msg = (await db.listChatMessages(orgId, taylor.id, 10)).pop()!;
    expect(msg.content).toMatch(/^2 new reporter requests from HARO fit you\. I'm writing a pitch for the best one\. Each will wait in Approvals until you send it/);
    expect(JSON.parse(msg.cards!)).toHaveLength(2);
    expect((await c.press.view({ organizationId: orgId }))).toMatchObject({ found: 2, pitched: 1 });

    // The same emails aren't read twice.
    expect(await press.checkPress(orgId)).toEqual({ found: 0, pitched: 0 });
    await apply.idle();
  }, 30_000);

  it("shows a sign-in problem on the card instead of failing quietly", async () => {
    const { orgId } = await makeWorkspace("press2");
    await press.savePressInbox(orgId, { email: "press@gmail.com", password: "goodpass" });
    press.setMailbox({ async test() {}, async fetch() { throw Object.assign(new Error("Invalid credentials"), { authenticationFailed: true }); } });
    await press.checkPress(orgId);
    expect(press.pressView(orgId)).toMatchObject({ status: "error", error: expect.stringMatching(/didn't accept that app password/) });
  });

  it("emails an approved pitch to the reporter from Taylor's sending address, in the body, with no attachments", async () => {
    const { orgId } = await makeWorkspace("press3");
    routes.push([/oauth2\.googleapis\.com\/token/, () => json({ access_token: "tok-taylor", refresh_token: "ref", expires_in: 3600 })]);
    routes.push([/openidconnect\.googleapis\.com\/v1\/userinfo/, () => json({ email: "press@tryleaddash.com" })]);
    const link = await calendars.finishLink(orgId, "code", { purpose: "send", name: "Press" });
    calendars.saveSender(orgId, link.id, { name: "Press", sendsFor: ["speaking"] });
    routes.push([/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => json({ id: "m1", threadId: "t1" })]);
    const opp = await db.createOpp({ organizationId: orgId, kind: "media", title: "Therapists on burnout", host: "Forbes", requirements: JSON.stringify({ channel: "email", channelDetail: "query-8k2@helpareporter.com" }), packageStatus: "ready" });
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    const app = await db.createApplication({
      organizationId: orgId,
      opportunityId: opp.id,
      employeeId: taylor.id,
      title: opp.title,
      status: "approved",
      channel: "email",
      channelDetail: "query-8k2@helpareporter.com",
      questions: JSON.stringify([
        { id: "q1", text: "Subject line", answer: "Group practice owner on burnout" },
        { id: "q2", text: "Your answer", answer: "Burnout in small practices starts with the admin load." },
      ]),
    });
    await (await import("./employees/bids")).autoSubmit(orgId, app.id);
    const sent = calls.find((x) => /messages\/send/.test(x.url))!;
    expect(sent.init.headers.authorization).toBe("Bearer tok-taylor");
    const raw = Buffer.from(JSON.parse(sent.init.body).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: query-8k2@helpareporter.com");
    expect(raw).toContain("Subject: Group practice owner on burnout");
    expect(raw).toContain("Burnout in small practices starts with the admin load.");
    expect(raw).not.toContain("multipart/mixed");
    expect((await db.getApplication(app.id, orgId))!.status).toBe("submitted");
    expect((await db.listChatMessages(orgId, taylor.id, 5)).pop()!.content).toMatch(/is in/);
  });
});
