import { describe, expect, it } from "vitest";
import { caller, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { monthRange, recordImage, recordMeeting, recordSearch, recordTokens, tokenCost, withUsage } from "./usage";
import { working } from "./employees/tasks";

describe("usage: hours saved and AI cost", () => {
  it("prices tokens by model from the published list", () => {
    expect(tokenCost("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18, 5);
    expect(tokenCost("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBeCloseTo(12, 5);
    expect(tokenCost("claude-opus-5-5", 1_000_000, 0)).toBeCloseTo(4, 5);
    expect(tokenCost("claude-haiku-4-5-20251001", 0, 1_000_000)).toBeCloseTo(5, 5);
  });

  it("months follow the workspace time zone", () => {
    const r = monthRange("America/Chicago", 0, new Date("2026-10-01T03:00:00Z")); // Sep 30, 10 PM in Chicago
    expect(r.label).toBe("September 2026");
    expect(r.start.toISOString()).toBe("2026-09-01T05:00:00.000Z");
    expect(monthRange("America/Chicago", 1, new Date("2026-01-15T12:00:00Z")).label).toBe("December 2025");
  });

  it("records work and AI costs against the employee doing it, and sums them by month", async () => {
    const { orgId, owner } = await makeWorkspace("usage-sum");
    const emps = await db.listEmployeesByOrg(orgId);
    const theo = emps.find((e) => e.kind === "blog")!;
    const morgan = emps.find((e) => e.kind === "grants")!;
    const simone = emps.find((e) => e.kind === "coo")!;

    // Theo writes an article: one task, the writing tokens, and a banner image.
    await working(theo, async () => {
      await recordTokens("claude-sonnet-4-6", 20_000, 3_000);
      await recordImage("1536x1024");
    });
    // Morgan searches from a route that only names the job.
    await withUsage({ orgId, kind: "grants" }, () => recordSearch("claude-sonnet-5-5", 50_000, 4_000, 5));
    // Simone's notetaker sat in for an hour.
    await recordMeeting(orgId, simone.id, 60);
    // Work outside any workspace is never recorded.
    await recordTokens("claude-sonnet-4-6", 1_000, 1_000);
    // A workspace call with no employee is shared.
    await withUsage({ orgId }, () => recordTokens("claude-sonnet-4-6", 10_000, 0));

    const s = await caller(owner).usage.summary({ organizationId: orgId });
    const row = (id: number) => s.employees.find((e) => e.id === id)!;
    expect(row(theo.id).tasks).toBe(1);
    expect(row(theo.id).hours).toBe(Math.round(((await import("./employees/roster")).rosterEntry("blog")!.minutesPerTask / 60) * 10) / 10);
    // 20k in x $3 + 3k out x $15 = $0.105, plus $0.041 image.
    expect(row(theo.id).cost).toBe(0.15);
    // 50k x $2 + 4k x $10 = $0.14, plus 5 searches x $0.01.
    expect(row(morgan.id).cost).toBe(0.19);
    expect(row(simone.id).cost).toBe(0.65);
    expect(s.shared).toBe(0.03);
    expect(s.tasks).toBe(1);
    expect(s.cost).toBeCloseTo(0.15 + 0.19 + 0.65 + 0.03, 1);
    expect(s.employees[0].id).toBe(theo.id);

    const last = await caller(owner).usage.summary({ organizationId: orgId, back: 1 });
    expect(last.tasks).toBe(0);
    expect(last.cost).toBe(0);
  });

  it("only people on the workspace can see its usage", async () => {
    const a = await makeWorkspace("usage-a");
    const b = await makeWorkspace("usage-b");
    await expect(caller(b.owner).usage.summary({ organizationId: a.orgId })).rejects.toThrow();
  });
});
