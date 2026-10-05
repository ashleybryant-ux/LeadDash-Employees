import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as browser from "./employees/browser";
import { lockGuard, parseLockId } from "./employees/logins";
import type { BrowserResult, BrowserTask } from "./employees/browser";

// The test server has no internet: every site name resolves here.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => ({ address: "127.0.0.1", family: 4 })) }));

const blank = { reply: "", action: "none", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
const LOC = "AbCdEf1234567890xyz1";
const OTHER = "ZzLegacy0987654321ab";

afterEach(() => vi.restoreAllMocks());

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const result = (r: Partial<BrowserResult>): BrowserResult => ({ status: "done", result: "", note: "", storageState: '{"cookies":[]}', downloads: [], log: [{ step: 1, action: "click", detail: "x", url: "" }], screenshotUrl: null, helped: [], url: "https://app.leaddash.io/v2/location/" + LOC + "/x", ...r });

async function mockAi(decision: any, extra: (opts: any) => any = () => ({})) {
  const llm = await import("./_core/llm");
  vi.spyOn(llm, "generateJson").mockImplementation(async (opts: any) => {
    if (opts.schemaName === "chat_decision") return { ...blank, ...decision } as any;
    return extra(opts) as any;
  });
}

describe("website logins", () => {
  it("reads the sub-account from a pasted address, and a locked login opens only that sub-account", () => {
    expect(parseLockId(`https://app.leaddash.io/v2/location/${LOC}/dashboard`)).toBe(LOC);
    expect(parseLockId(LOC)).toBe(LOC);
    expect(parseLockId("LeadDash")).toBeNull();
    const ok = lockGuard({ lockId: LOC, url: "https://app.leaddash.io" })!;
    expect(ok(`https://app.leaddash.io/v2/location/${LOC}/automation/workflows`)).toBe(true);
    expect(ok(`https://app.leaddash.io/v2/location/${OTHER}/contacts`)).toBe(false);
    expect(ok(`https://app.leaddash.io/v2/location/${LOC}/x?locationId=${OTHER}`)).toBe(false);
    // Agency-level pages list other sub-accounts; sign-in pages are fine.
    expect(ok("https://app.leaddash.io/agency_dashboard")).toBe(false);
    expect(ok("https://app.leaddash.io/accounts")).toBe(false);
    expect(ok("https://app.leaddash.io/")).toBe(true);
    expect(ok("https://app.leaddash.io/login")).toBe(true);
    expect(ok("https://preview.example.com/page")).toBe(true);
    expect(lockGuard({ lockId: null, url: "https://bonfirehub.com" })).toBeUndefined();
  });

  it("saves a login for every employee, needs the sub-account's address to lock it, and never shows the password", async () => {
    const { orgId, owner } = await makeWorkspace("logins");
    const c = caller(owner);
    await expect(c.portals.save({ organizationId: orgId, name: "LeadDash platform", url: "https://app.leaddash.io", username: "ashley@leaddash.io", password: "pw-1", lockName: "LeadDash", lockAddress: "LeadDash" })).rejects.toThrow(/\/location\//);
    await c.portals.save({ organizationId: orgId, name: "LeadDash platform", url: "https://app.leaddash.io", username: "ashley@leaddash.io", password: "pw-1", lockName: "LeadDash", lockAddress: `https://app.leaddash.io/v2/location/${LOC}/dashboard` });
    await c.portals.save({ organizationId: orgId, name: "Bonfire", url: "https://bonfirehub.com", username: "ashley@legacyfs.org", password: "pw-2" });
    const list = await c.portals.list({ organizationId: orgId });
    expect(list.map((l) => l.name)).toEqual(["Bonfire", "LeadDash platform"]);
    expect(list[1]).toMatchObject({ lockName: "LeadDash", lockId: LOC, hasPassword: true });
    expect(JSON.stringify(list)).not.toContain("pw-1");
    // Editing without a new address keeps the lock.
    await c.portals.save({ organizationId: orgId, id: list[1].id, name: "LeadDash platform", url: "https://app.leaddash.io", username: "ashley@leaddash.io", lockName: "LeadDash" });
    expect((await c.portals.list({ organizationId: orgId }))[1].lockId).toBe(LOC);
  });
});

describe("every employee's browser", () => {
  it("opens a site from chat, stops before Submit, and presses it only after Finish it", async () => {
    const { orgId, owner } = await makeWorkspace("browse");
    const taylor = (await db.getEmployeeByKind(orgId, "speaking"))!;
    const runs: BrowserTask[] = [];
    vi.spyOn(browser, "runBrowserTask").mockImplementation(async (t) => {
      runs.push(t);
      return t.allowSubmit
        ? result({ result: JSON.stringify({ answer: "Submitted. The site showed confirmation HB-22.", pending: "" }) })
        : result({ result: JSON.stringify({ answer: "Speaker applications close Friday, January 15, 2027.", pending: "Submit" }) });
    });
    await mockAi({ action: "browse", goal: "Find the speaker application deadline", url: "heartlandbhsummit.org/call-for-speakers", title: "Speaker deadline" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: taylor.id, text: "Go to the Heartland summit site and find the speaker deadline." });
    expect(r.reply.content).toMatch(/^Opening it in my browser now/);
    expect(JSON.parse(r.reply.cards!)[0].type).toBe("browser_live");
    const task = db.listWebTasks(orgId)[0];
    await until(() => db.getWebTask(task.id, orgId)!.status === "done");
    expect(runs[0].startUrl).toBe("https://heartlandbhsummit.org/call-for-speakers");
    expect(runs[0].allowSubmit).toBe(false);
    expect(runs[0].submitWords!.test("Save changes")).toBe(true);
    expect(runs[0].submitWords!.test("Publish")).toBe(true);
    const done = db.getWebTask(task.id, orgId)!;
    expect(done.pending).toBe("Submit");
    const msgs = await db.listChatMessages(orgId, taylor.id, 10);
    const last = msgs[msgs.length - 1];
    expect(last.content).toContain("January 15, 2027");
    expect(last.content).toContain("Press Finish it");
    expect(JSON.parse(last.cards!)[0]).toMatchObject({ type: "web_task", id: task.id });

    const a = await caller(owner).web.approve({ organizationId: orgId, id: task.id });
    await until(() => db.getWebTask(a.id, orgId)!.status === "done");
    expect(runs[1].allowSubmit).toBe(true);
    expect(runs[1].neverWords!.test("Pay now")).toBe(true);
    expect(runs[1].goal).toContain('press "Submit"');
    expect(db.getWebTask(task.id, orgId)!.pending).toBeNull();
    await expect(caller(owner).web.approve({ organizationId: orgId, id: task.id })).rejects.toThrow(/nothing waiting/);
  });

  it("signs in with a saved login, asks for a code in chat, and keeps going once it's in", async () => {
    const { orgId, owner } = await makeWorkspace("browsecode");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    await caller(owner).portals.save({ organizationId: orgId, name: "Bonfire", url: "https://bonfirehub.com/login", username: "ashley@legacyfs.org", password: "bonfire-pw" });
    const runs: BrowserTask[] = [];
    vi.spyOn(browser, "runBrowserTask").mockImplementation(async (t) => {
      runs.push(t);
      return t.secrets?.code ? result({ result: JSON.stringify({ answer: "Two open bids are listed.", pending: "" }) }) : result({ status: "need_code", note: "We sent a code to your email." });
    });
    await mockAi({ action: "browse", goal: "List the open bids", target: "Bonfire" });
    await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "What's open on Bonfire?" });
    const task = db.listWebTasks(orgId)[0];
    await until(() => db.getWebTask(task.id, orgId)!.status === "need_code");
    expect(runs[0].secrets).toMatchObject({ email: "ashley@legacyfs.org", password: "bonfire-pw" });
    expect(runs[0].startUrl).toBe("https://bonfirehub.com/login");
    const msgs = await db.listChatMessages(orgId, morgan.id, 10);
    expect(JSON.parse(msgs[msgs.length - 1].cards!)[0]).toMatchObject({ type: "web_code", id: task.id });
    // The AI's system prompt names the saved login but never the password.
    await caller(owner).web.code({ organizationId: orgId, id: task.id, code: "482915" });
    await until(() => db.getWebTask(task.id, orgId)!.status === "done");
    expect(runs[1].secrets?.code).toBe("482915");
    // The session is kept (encrypted) for next time.
    expect((await db.listPortalLogins(orgId))[0].sessionEncrypted).toBeTruthy();
  });

  it("refuses a page outside a locked login's sub-account before opening anything", async () => {
    const { orgId, owner } = await makeWorkspace("browselock");
    const avery = (await db.getEmployeeByKind(orgId, "inbox"))!;
    await caller(owner).portals.save({ organizationId: orgId, name: "LeadDash platform", url: "https://app.leaddash.io", username: "a@leaddash.io", password: "pw", lockName: "LeadDash", lockAddress: LOC });
    const spy = vi.spyOn(browser, "runBrowserTask");
    await mockAi({ action: "browse", goal: "Read the contacts", target: "LeadDash platform", url: `https://app.leaddash.io/v2/location/${OTHER}/contacts` });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: avery.id, text: "Open the Legacy contacts" });
    expect(r.reply.content).toMatch(/outside the LeadDash sub-account/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Zara, the platform specialist", () => {
  async function setup(slug: string) {
    const ws = await makeWorkspace(slug);
    const zara = (await db.getEmployeeByKind(ws.orgId, "platform"))!;
    return { ...ws, zara };
  }

  it("asks for the locked login before she starts", async () => {
    const { orgId, owner, zara } = await setup("zaranologin");
    expect(zara.name).toBe("Zara");
    await mockAi({ action: "audit_workflows" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: zara.id, text: "Audit my workflows" });
    expect(r.reply.content).toMatch(/Website logins, locked to the LeadDash sub-account/);
  });

  it("audits every workflow without changing anything, then fixes one only after Fix", async () => {
    const { orgId, owner, zara } = await setup("zaraaudit");
    await caller(owner).portals.save({ organizationId: orgId, name: "LeadDash platform", url: "https://app.leaddash.io", username: "a@leaddash.io", password: "pw", lockName: "LeadDash", lockAddress: LOC });
    const runs: BrowserTask[] = [];
    vi.spyOn(browser, "runBrowserTask").mockImplementation(async (t) => {
      runs.push(t);
      if (/Workflows list in the LeadDash/.test(t.goal)) return result({ result: JSON.stringify({ workflows: [{ name: "Demo booked: reminders", status: "Published", folder: "", url: "" }, { name: "No-show follow-up", status: "Draft", folder: "", url: "" }] }) });
      if (/Make exactly this change/.test(t.goal)) return result({ result: JSON.stringify({ answer: "Added a wait until 1 hour before the appointment before the reminder text, and saved.", pending: "" }) });
      if (/Demo booked/.test(t.goal)) return result({ result: JSON.stringify({ name: "Demo booked: reminders", status: "Published", trigger: "Appointment booked (Demo calendar)", steps: ["1. Send email: You're booked", "2. Send text: Your demo starts in 1 hour", "3. Wait 1 day"], notes: "", url: `https://app.leaddash.io/v2/location/${LOC}/automation/workflows/wf1` }) });
      return result({ result: JSON.stringify({ name: "No-show follow-up", status: "Draft", trigger: "Appointment status: no-show", steps: ["1. Send text: Sorry we missed you"], notes: "" }) });
    });
    await mockAi({ action: "audit_workflows" }, (opts) =>
      opts.schemaName === "workflow_findings"
        ? { findings: [
            { workflow: "No-show follow-up", issue: "Still a draft, so it never runs.", detail: "No-shows never get a follow-up.", severity: "should_fix", fix: "Publish the workflow.", howItRuns: [] },
            { workflow: "Demo booked: reminders", issue: "The 1-hour reminder sends the moment someone books.", detail: "The reminder text has no wait before it.", severity: "fix_now", fix: "Add a wait before step 2: wait until 1 hour before the appointment.", howItRuns: [] },
            { workflow: "Made up workflow", issue: "x", detail: "", severity: "fix_now", fix: "x", howItRuns: [] },
          ] }
        : {}
    );
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: zara.id, text: "Audit the workflows in the LeadDash sub-account." });
    expect(r.reply.content).toMatch(/change nothing/);
    const audit = db.listWebTasks(orgId)[0];
    await until(() => db.getWebTask(audit.id, orgId)!.status === "done");
    expect(runs).toHaveLength(3);
    for (const t of runs) {
      expect(t.allowSubmit).toBeFalsy();
      expect(t.allowUrl!(`https://app.leaddash.io/v2/location/${OTHER}/contacts`)).toBe(false);
      expect(t.submitWords!.test("Save")).toBe(true);
    }
    expect(runs[0].startUrl).toBe(`https://app.leaddash.io/v2/location/${LOC}/automation/workflows`);
    const o = await caller(owner).platform.overview({ organizationId: orgId });
    expect(o.workflows.map((w) => w.name)).toEqual(["Demo booked: reminders", "No-show follow-up"]);
    // A finding about a workflow that wasn't read is dropped; Fix now comes first.
    expect(o.findings.map((f) => f.workflow)).toEqual(expect.arrayContaining(["Demo booked: reminders", "No-show follow-up"]));
    expect(o.findings).toHaveLength(2);
    const reminder = o.findings.find((f) => f.workflow === "Demo booked: reminders")!;
    expect(reminder.howItRuns[0]).toBe("Trigger: Appointment booked (Demo calendar)");
    const msgs = await db.listChatMessages(orgId, zara.id, 10);
    const last = msgs[msgs.length - 1];
    expect(last.content).toMatch(/^I read all 2 workflows\. 2 need fixing, and the first one is costing you leads now\. Nothing was changed\./);
    expect(JSON.parse(last.cards!)[0].type).toBe("platform_findings");

    await caller(owner).platform.fix({ organizationId: orgId, findingId: reminder.id });
    await until(() => db.getFinding(reminder.id, orgId)!.status === "fixed");
    const fixRun = runs[3];
    expect(fixRun.allowSubmit).toBe(true);
    expect(fixRun.goal).toContain("Add a wait before step 2");
    expect(fixRun.neverWords!.test("Delete workflow")).toBe(true);
    expect(fixRun.allowUrl!(`https://app.leaddash.io/v2/location/${OTHER}/automation/workflows`)).toBe(false);
    expect(db.getFinding(reminder.id, orgId)!.note).toMatch(/Added a wait/);
    await caller(owner).platform.dismiss({ organizationId: orgId, findingId: o.findings.find((f) => f.workflow === "No-show follow-up")!.id });
    expect((await caller(owner).platform.overview({ organizationId: orgId })).findings.filter((f) => f.status === "open")).toHaveLength(0);
  });

  it("puts Jordan's page into a funnel as a draft by pasting it, and publishes only on Publish", async () => {
    const { orgId, owner, zara } = await setup("zarapage");
    await caller(owner).portals.save({ organizationId: orgId, name: "LeadDash platform", url: "https://app.leaddash.io", username: "a@leaddash.io", password: "pw", lockName: "LeadDash", lockAddress: LOC });
    const page = db.createSitePage({ organizationId: orgId, title: "Breaking the Burnout Cycle keynote", goal: "Book the keynote", status: "ready", currentVersion: 3 });
    db.addSitePageVersion({ organizationId: orgId, pageId: page.id, version: 3, html: '<div class="ldp"><h1>Breaking the Burnout Cycle</h1></div>' });
    const runs: BrowserTask[] = [];
    vi.spyOn(browser, "runBrowserTask").mockImplementation(async (t) => {
      runs.push(t);
      return result({ result: JSON.stringify({ answer: t.goal.includes("publish it") ? "The page is live." : "Saved as a draft in the Speaking funnel.", pending: "" }) });
    });
    await mockAi({ action: "platform_page", page: "burnout", target: "Speaking" });
    const r = await caller(owner).chat.send({ organizationId: orgId, employeeId: zara.id, text: "Put Jordan's burnout keynote page in the Speaking funnel" });
    expect(r.reply.content).toMatch(/as a draft/);
    const t = db.listWebTasks(orgId)[0];
    await until(() => db.getWebTask(t.id, orgId)!.status === "done");
    expect(runs[0].secrets?.content).toBe('<div class="ldp"><h1>Breaking the Burnout Cycle</h1></div>');
    expect(runs[0].goal).not.toContain("<h1>");
    expect(runs[0].goal).toContain("/breaking-the-burnout-cycle-keynote");
    expect(runs[0].neverWords!.test("Publish")).toBe(true);
    const card = await caller(owner).platform.page({ organizationId: orgId, id: t.id });
    expect(card).toMatchObject({ funnel: "Speaking", version: 3, published: false });
    const msgs = await db.listChatMessages(orgId, zara.id, 10);
    expect(msgs[msgs.length - 1].content).toBe(`Jordan's "Breaking the Burnout Cycle keynote" page is now a page in your Speaking funnel. It's saved as a draft, so nothing is live until you publish it.`);

    const p = await caller(owner).platform.publish({ organizationId: orgId, id: t.id });
    await until(() => db.getWebTask(p.id, orgId)!.status === "done");
    expect(runs[1].allowSubmit).toBe(true);
    expect(runs[1].neverWords!.test("Publish")).toBe(false);
    expect((await caller(owner).platform.page({ organizationId: orgId, id: t.id }))!.published).toBe(true);
  });
});

// The real browser: the lock and the paste, end to end.
const ready = await browser.browserReady();
let server: http.Server;
let base = "";
const seen: { opened: string[]; pasted?: string } = { opened: [] };
beforeAll(async () => {
  if (!ready) return;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.opened.push(url.pathname);
    const page = (b: string) => res.end(`<!doctype html><html><body>${b}</body></html>`);
    if (url.pathname === `/v2/location/${LOC}/home`) return page(`<h1>LeadDash</h1><a href="/v2/location/${OTHER}/contacts">Legacy contacts</a><form action="/v2/location/${LOC}/saved"><label for="h">Custom HTML</label><textarea id="h" name="h"></textarea><button>Save</button></form>`);
    if (url.pathname === `/v2/location/${LOC}/saved`) {
      seen.pasted = url.searchParams.get("h") ?? "";
      return page("<p>Saved</p>");
    }
    page(`<p>${url.pathname}</p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => (server ? new Promise<void>((r) => server.close(() => r())) : undefined));

describe.skipIf(!ready)("the lock and the paste in the real browser", () => {
  it("never opens another sub-account, and pastes a page the AI never types", async () => {
    const html = "<section><h2>Keynote</h2></section>";
    const allowUrl = lockGuard({ lockId: LOC, url: base })!;
    let step = 0;
    const r = await browser.runBrowserTask({
      orgId: 99,
      goal: "paste",
      startUrl: `${base}/v2/location/${LOC}/home`,
      allowUrl,
      allowSubmit: true,
      secrets: { content: html },
      decide: async (v) => {
        step++;
        const el = (re: RegExp) => v.elements.find((e) => re.test(`${e.label} ${e.text}`))!.i;
        if (step === 1) return { thought: "", action: "goto", index: -1, value: `${base}/v2/location/${OTHER}/contacts`, secret: "", fileIndex: -1, result: "" };
        if (step === 2) return { thought: "", action: "click", index: el(/Legacy contacts/), value: "", secret: "", fileIndex: -1, result: "" };
        if (step === 3) return { thought: "", action: "type", index: el(/Custom HTML/), value: "", secret: "content", fileIndex: -1, result: "" };
        if (step === 4) return { thought: "", action: "click", index: el(/Save/), value: "", secret: "", fileIndex: -1, result: "" };
        return { thought: "", action: "done", index: -1, value: "", secret: "", fileIndex: -1, result: "ok" };
      },
    });
    expect(r.status).toBe("done");
    expect(seen.opened).not.toContain(`/v2/location/${OTHER}/contacts`);
    expect(r.log.filter((l) => /outside what this login may open/.test(l.detail)).length).toBe(2);
    expect(seen.pasted).toBe(html);
  }, 60_000);
});
