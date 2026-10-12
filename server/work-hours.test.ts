import { describe, expect, it, vi } from "vitest";

// The chat decision the employee makes: set per test.
let decision: Record<string, unknown> = {};
let decisions = 0;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName !== "chat_decision") return {};
      decisions++;
      return { thinking: "", reply: "Done.", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [], ...decision };
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import * as hours from "./workHours";
import { working } from "./employees/tasks";
import { bigJobText } from "./employees/chat";
import { withUsage } from "./usage";
import crypto from "node:crypto";
import * as stripe from "./stripeHours";
import { CACHE_MARK, cachedSystem } from "./_core/llm";
import { systemPromptFor } from "./employees/tasks";

describe("Work hours", () => {
  it("charges each finished job its fixed hours, plan hours first, then bought hours, and stops work at 0", async () => {
    const { orgId, owner, staff } = await makeWorkspace("wh-plan");
    const sienna = (await db.getEmployeeByKind(orgId, "social"))!;
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;

    // No plan: work is counted, never limited.
    expect(await caller(owner).hours.get({ organizationId: orgId })).toMatchObject({ metered: false, leftMinutes: null });
    await working(theo, async () => "article", { job: "doc", label: "Intake tips" });
    expect((await hours.balance(orgId)).usedMinutes).toBe(60);

    // Only LeadDash staff set a plan.
    await expect(caller(owner).hours.setPlan({ organizationId: orgId, plan: "starter" })).rejects.toThrow();
    await caller(staff).hours.setPlan({ organizationId: orgId, plan: "starter" });
    let b = await caller(owner).hours.get({ organizationId: orgId });
    expect(b).toMatchObject({ metered: true, planName: "Starter", planMinutes: 3000, usedMinutes: 60, planLeftMinutes: 2940, leftMinutes: 2940, out: false });
    expect(b.resetsOn).toMatch(/^\w{3} 1, \d{4}$/);

    // Three posts from one batch use 30 minutes each; a failed job uses nothing.
    await working(sienna, async () => ["a", "b", "c"], { job: "post", count: (r) => r.length });
    await expect(working(theo, async () => { throw new Error("site down"); }, { job: "doc", label: "Broken page" })).rejects.toThrow("site down");
    await working(theo, async () => ({ status: "failed" }), { job: "website", done: (r) => r.status === "done", label: "portal.example" });
    b = await caller(owner).hours.get({ organizationId: orgId });
    expect(b.usedMinutes).toBe(60 + 90);
    const recent = await caller(owner).hours.recent({ organizationId: orgId });
    expect(recent.map((j) => [j.what, j.minutes, j.charged])).toEqual([
      ["Work done on a website for you: portal.example", 60, false],
      ["Blog post, doc, page or deck: Broken page", 60, false],
      ["Social post with picture (3)", 90, true],
      ["Blog post, doc, page or deck: Intake tips", 60, true],
    ]);
    expect(recent[2].employee!.name).toBe(sienna.name);

    // Bought hours: used once the plan's are gone, oldest first.
    await caller(staff).hours.addPack({ organizationId: orgId, hours: 10, note: "Paid Oct 11, 2026" });
    await withUsage({ orgId }, () => hours.charge(orgId, theo.id, "doc", 48)); // 150 + 2880 = 3030 used: the plan's 3000 and 30 bought minutes
    b = await caller(owner).hours.get({ organizationId: orgId });
    expect(b).toMatchObject({ planLeftMinutes: 0, packMinutes: 570, leftMinutes: 570, out: false });
    expect(b.packsGoodThrough).toMatch(/\d{4}$/);

    await withUsage({ orgId }, () => hours.charge(orgId, theo.id, "grant", 2));
    b = await caller(owner).hours.get({ organizationId: orgId });
    expect(b).toMatchObject({ leftMinutes: 0, out: true });
    await expect(working(theo, async () => "x", { job: "doc" })).rejects.toThrow(/out of work hours, so the employees are paused until \w{3} 1, \d{4}\. Chat still works/);

    // Staff see cost and margin; the workspace never sees dollars.
    const row = (await caller(staff).hours.staffList()).find((w) => w.id === orgId)!;
    expect(row).toMatchObject({ planName: "Starter", margin: 100, cost: 0 });
    expect(row.packs[0]).toMatchObject({ hours: "10", left: "0", note: "Paid Oct 11, 2026" });
    await expect(caller(owner).hours.staffList()).rejects.toThrow();
    expect(JSON.stringify(await caller(owner).hours.get({ organizationId: orgId }))).not.toMatch(/cost|margin/i);
  });

  it("asks in chat before a job of 3 hours or more on a plan, and Go ahead runs the job it asked about without deciding again", async () => {
    const { orgId, owner, staff } = await makeWorkspace("wh-ask");
    const morgan = (await db.getEmployeeByKind(orgId, "grants"))!;
    expect(bigJobText("grants", "apply")).toMatch(/8 work hours/);
    expect(bigJobText("speaking", "apply")).toMatch(/3 work hours/);
    expect(bigJobText("social", "write_post")).toBeNull();

    // Without a plan, nothing asks.
    decision = { action: "check_status", reply: "Here's where things stand." };
    const free = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "What's open?" });
    expect(free.reply.content).not.toMatch(/Before I start/);

    await caller(staff).hours.setPlan({ organizationId: orgId, plan: "growth" });
    decision = { action: "apply", target: "best", reply: "Starting it." };
    const asked = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Apply to the best one" });
    expect(asked.reply.content).toBe("Before I start: a full grant application uses 8 work hours (a pitch or accelerator application uses 3). You have 120 hr left.");
    expect(JSON.parse(asked.reply.cards!)[0]).toMatchObject({ type: "choices", options: ["Go ahead", "Not now"] });

    const before = decisions;
    const no = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Not now" });
    expect(no.reply.content).toBe("Okay, I won't start it.");
    expect(decisions).toBe(before);

    await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Apply to the best one" });
    const n = decisions;
    const go = await caller(owner).chat.send({ organizationId: orgId, employeeId: morgan.id, text: "Go ahead" });
    expect(decisions).toBe(n);
    expect(go.reply.content).not.toMatch(/Before I start/);
  });

  it("limits a talking video to its minutes, doubled in Pro, and shows hours instead of dollars on a plan", () => {
    expect(hours.videoMinutes(450)).toBe(480); // 45 seconds: 8 hours
    expect(hours.videoMinutes(700)).toBe(960); // 70 seconds: 2 minutes
    expect(hours.videoMinutes(450, "pro")).toBe(960);
    expect(hours.hoursText(30)).toBe("30 min");
    expect(hours.hoursText(90)).toBe("1.5 hr");
    expect(hours.hoursText(480)).toBe("8 hr");
  });

  it("adds a pack once when Stripe says a card checkout is paid, and checks Stripe's signature", async () => {
    const { orgId, owner } = await makeWorkspace("wh-stripe");
    // Without keys, buying by card says so (the app then opens the pricing page).
    await expect(caller(owner).hours.buy({ organizationId: orgId, hours: 10 })).rejects.toThrow(/Card payments aren't set up yet/);
    expect((await caller(owner).hours.get({ organizationId: orgId })).cardReady).toBe(false);

    const raw = Buffer.from(JSON.stringify({ hello: 1 }));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", "whsec_test").update(`${t}.${raw.toString()}`).digest("hex");
    expect(stripe.verifySignature(raw, `t=${t},v1=${sig}`, "whsec_test")).toBe(true);
    expect(stripe.verifySignature(raw, `t=${t},v1=${sig}`, "whsec_other")).toBe(false);
    expect(stripe.verifySignature(raw, `t=${t - 900},v1=${sig}`, "whsec_test")).toBe(false);

    const event = { type: "checkout.session.completed", data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: 4500, metadata: { kind: "work_hours", orgId: String(orgId), hours: "50" } } } };
    expect(await stripe.handleEvent(event)).toEqual({ added: true });
    expect(await stripe.handleEvent(event)).toEqual({ added: false }); // Stripe sends it again: added once
    expect(await stripe.handleEvent({ ...event, data: { object: { ...event.data.object, id: "cs_test_2", payment_status: "unpaid" } } })).toEqual({ added: false });
    expect((await hours.balance(orgId)).packMinutes).toBe(3000);
    expect(hours.packsFor(orgId)[0].note).toBe("Paid by card $45.00. Stripe cs_test_1");
  });

  it("puts what stays the same first in every prompt, so it's cached, and the task after it", async () => {
    const { orgId } = await makeWorkspace("wh-cache");
    const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
    const { system } = await systemPromptFor(theo, "Write a post about intake. Right now it is Oct 11, 2026.");
    const [head, tail] = system.split(CACHE_MARK);
    expect(head).toContain("# Brain");
    expect(head).not.toContain("Right now it is");
    expect(tail).toMatch(/^# The task in front of you\nWrite a post about intake/);
    const blocks = cachedSystem(system) as any[];
    expect(blocks[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(blocks[1].text).not.toContain("<<cache>>");
    expect(cachedSystem("no mark here")).toBe("no mark here");
  });
});
