import { describe, expect, it, vi } from "vitest";

let call = 0;
const item = (n: number) => ({ title: `Contest ${n}`, host: `Host ${n}`, deadline: "Rolling", amount: "$10,000", equity: "", stage: "", eligibility: "", location: "", eventDate: "", audience: "", angle: "", summary: "", sourceUrl: `https://contest${n}.org/apply`, foundOn: "", fitScore: 80, fitCall: "apply", fitReason: "Fits", status: "open", howToSubmit: "", contact: { name: "", title: "", phone: "", email: "" } });
vi.mock("./_core/llm", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    searchJson: vi.fn(async (opts: any) => {
      call++;
      const nums = call === 1 ? [1, 2, 3, 4] : call === 2 ? [5, 6] : [];
      if (call > 1) expect(opts.prompt).toContain("Already on the list");
      return { queries: [`q${call}`], sources: nums.map((n) => ({ url: `https://contest${n}.org/x`, title: "" })), data: { items: nums.map(item) }, costUsd: 0.4 };
    }),
  };
});
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}), text: async () => "" })));

import { makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { findOpportunities, stillLooking } from "./employees/apply";

describe("searching until the field runs out", () => {
  it("keeps looking in rounds while rounds keep finding new ones, then stops and reports", async () => {
    const { orgId } = await makeWorkspace("keep-looking");
    const first = await findOpportunities(orgId, "grants", { kind: "pitch", keepLooking: true });
    expect(first.created).toHaveLength(4);
    expect(first.more).toBe(true);
    for (let i = 0; i < 50 && (stillLooking(orgId, "grants") || call < 2); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    expect((await db.listOpps(orgId, ["pitch"])).length).toBe(6);
    const morgan = (await db.listEmployeesByOrg(orgId)).find((e) => e.kind === "grants")!;
    const msgs = (await db.listChatMessages(orgId, morgan.id, 20)).map((m) => m.content);
    expect(msgs.some((m) => m.startsWith("Round 2: I found 2 more pitch competitions"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("Done looking: 2 search rounds"))).toBe(true);
    expect(call).toBe(2);
  });
});
