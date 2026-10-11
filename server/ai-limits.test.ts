import { describe, expect, it, vi } from "vitest";

// Each chat decision can spend a set amount of AI cost, and do work that uses a set number of work hours.
let spend = 0;
let workHoursDone = 0;
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    generateJson: vi.fn(async (opts: any) => {
      if (opts.schemaName !== "chat_decision") return {};
      const usage = await import("./usage");
      // $3 per million input tokens on Sonnet 4.6: spend dollars = tokens / 333,333.
      if (spend > 0) await usage.recordTokens("claude-sonnet-4-6", Math.round((spend / 3) * 1_000_000), 0);
      const c = usage.usageContext();
      if (workHoursDone > 0 && c) await (await import("./workHours")).charge(c.orgId, null, "doc", workHoursDone);
      return { thinking: "", reply: "Done.", action: "none", plan: "", focus: "", topic: "", platforms: [], count: 0, title: "", notes: "", page: "", goal: "", from: "", subject: "", message: "", url: "", oppKind: "", target: "", to: "", date: "", time: "", attendees: "", teammate: "", choices: [] };
    }),
  };
});

import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { usageEvents, chatMessages } from "../drizzle/schema";
import { withUsage } from "./usage";
import * as lim from "./aiLimits";
import * as hours from "./workHours";

async function teamOf(slug: string) {
  const { orgId, owner } = await makeWorkspace(slug);
  await caller(owner).members.add({ organizationId: orgId, email: `caroline@${slug}.test`, name: "Caroline Jones", role: "member" });
  const caroline = (await db.getUserByEmail(`caroline@${slug}.test`))!;
  const theo = (await db.getEmployeeByKind(orgId, "blog"))!;
  return { orgId, owner, caroline, theo };
}

/** Uses work hours as this person, the way an employee's finished jobs would (a doc is 1 work hour). */
const workAs = (orgId: number, userId: number | null, n: number) => withUsage({ orgId, userId }, () => hours.charge(orgId, null, "doc", n));

describe("Work-hour limits per person", () => {
  it("records who asked, stops new work at the limit, and lets the person ask the owner to raise it", async () => {
    const { orgId, owner, caroline, theo } = await teamOf("ailim-stop");
    await caller(owner).usage.saveLimits({ organizationId: orgId, defaultHours: 20, ownersExempt: true, warnPct: 80, atLimit: "stop" });
    expect(await caller(owner).usage.limits({ organizationId: orgId })).toMatchObject({ defaultHours: 20 });

    // Work asked for in chat is recorded against the person who asked.
    spend = 3;
    await caller(caroline).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Draft a post about intake" });
    const mine = db.getDb().select().from(usageEvents).all().filter((e) => e.organizationId === orgId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.userId === caroline.id && !e.estimated)).toBe(true);

    // Past the limit: the employee says so instead of working, with a button to ask the owner.
    await workAs(orgId, caroline.id, 20);
    spend = 0;
    const r = await caller(caroline).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Write another" });
    expect(r.reply.content).toMatch(/^You've used your 20 work hours for \w+ \d{4}, so I can't start new work for you until \w{3} \d{1,2}, \d{4}\. Owner can raise your limit on the Team page\.$/);
    expect(JSON.parse(r.reply.cards!)[0]).toMatchObject({ type: "choices", options: ["Ask Owner to raise it"] });
    const asked = await caller(caroline).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Ask Owner to raise it" });
    expect(asked.reply.content).toBe("I asked Owner to raise your limit. I'll pick this back up as soon as it's raised.");

    // The owner has no limit by default.
    await workAs(orgId, owner.id, 50);
    const o = await caller(owner).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Write one more" });
    expect(o.reply.content).toBe("Done.");

    // Raising her own limit lets her work again; the Team column shows it.
    await caller(owner).members.setAiLimit({ organizationId: orgId, userId: caroline.id, mode: "custom", hours: 40 });
    const again = await caller(caroline).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Write another" });
    expect(again.reply.content).toBe("Done.");
    const col = await caller(owner).members.ai({ organizationId: orgId });
    expect(col.find((c) => c.userId === caroline.id)).toMatchObject({ used: 20, limit: 40, source: "own", mode: "custom", own: 40 });
    expect(col.find((c) => c.userId === owner.id)).toMatchObject({ limit: null, source: "exempt" });

    // A member can't change limits.
    await expect(caller(caroline).members.setAiLimit({ organizationId: orgId, userId: caroline.id, mode: "none", hours: null })).rejects.toThrow(/role/);
  });

  it("shows a heads-up under the reply when the work crosses 80%, and 'keep working' never blocks", async () => {
    const { orgId, owner, caroline, theo } = await teamOf("ailim-warn");
    await caller(owner).usage.saveLimits({ organizationId: orgId, defaultHours: 20, ownersExempt: true, warnPct: 80, atLimit: "warn" });
    await workAs(orgId, caroline.id, 15);
    workHoursDone = 2;
    const r = await caller(caroline).chat.send({ organizationId: orgId, employeeId: theo.id, text: "Draft a post" });
    const note = JSON.parse(r.reply.cards!).find((c: any) => c.type === "limit_note");
    expect(note.body).toMatch(/^You've used 17 of your 20 work hours for \w+ \d{4}\.$/);

    await workAs(orgId, caroline.id, 10);
    workHoursDone = 0;
    const over = await caller(caroline).chat.send({ organizationId: orgId, employeeId: theo.id, text: "And another" });
    expect(over.reply.content).toBe("Done.");
  });

  it("splits the month by person with scheduled work on its own row", async () => {
    const { orgId, owner, caroline } = await teamOf("ailim-person");
    await caller(owner).usage.saveLimits({ organizationId: orgId, defaultHours: 25, ownersExempt: true, warnPct: 80, atLimit: "stop" });
    await workAs(orgId, caroline.id, 6);
    await workAs(orgId, owner.id, 9);
    await workAs(orgId, null, 3);
    const r = await caller(owner).usage.byPerson({ organizationId: orgId, back: 0 });
    expect(r.total).toBe(18);
    expect(r.people).toBe(15);
    expect(r.scheduled).toBe(3);
    expect(r.rows.map((p) => [p.name, p.hours, p.limit, p.pct])).toEqual([["Owner ailim-person", 9, null, null], ["Caroline Jones", 6, 25, 24], ["Reviewer ailim-person", 0, 25, 0]]);
    // No dollar amounts reach the workspace.
    expect(JSON.stringify(r)).not.toMatch(/cost/);
  });

  it("back-counts earlier costs to the person whose chat message started them, once", async () => {
    const { orgId, caroline, theo } = await teamOf("ailim-back");
    expect(lim.readLimits(JSON.stringify({ defaultMicros: 20_000_000 })).defaultMinutes).toBe(3600); // a $20 limit from before work hours is 60 hours
    const t = new Date();
    const at = (min: number) => new Date(t.getTime() + min * 60_000);
    db.getDb().insert(chatMessages).values({ organizationId: orgId, employeeId: theo.id, role: "user", authorName: "Caroline Jones", userId: caroline.id, content: "Write a post", createdAt: at(-20) }).run();
    const ev = (min: number, employeeId: number | null) => db.getDb().insert(usageEvents).values({ organizationId: orgId, employeeId, type: "writing", costMicros: 1_000_000, createdAt: at(min) }).returning().all()[0];
    const matched = ev(-18, theo.id);
    const tooLate = ev(-18 + 45, theo.id); // 43 minutes after her message
    const noEmployee = ev(-17, null);

    const r = await lim.backfill(orgId);
    expect(r).toEqual({ matched: 1, skipped: false });
    const rows = db.getDb().select().from(usageEvents).all();
    expect(rows.find((e) => e.id === matched.id)).toMatchObject({ userId: caroline.id, estimated: true });
    expect(rows.find((e) => e.id === tooLate.id)!.userId).toBeNull();
    expect(rows.find((e) => e.id === noEmployee.id)!.userId).toBeNull();
    expect((await lim.backfill(orgId)).skipped).toBe(true);
  });
});
