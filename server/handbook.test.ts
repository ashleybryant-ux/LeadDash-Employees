import { describe, expect, it } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";
import { handbookText } from "./employees/handbook";
import { systemPromptFor } from "./employees/tasks";

describe("handbook: the LeadDash base plus each workspace's additions", () => {
  it("every employee's instructions carry the handbook, with this workspace's additions and no one else's", async () => {
    const a = await makeWorkspace("hb-a");
    const b = await makeWorkspace("hb-b");
    const view = await caller(a.owner).handbook.view({ organizationId: a.orgId });
    expect(view.canEdit).toBe(true);
    expect(view.parts.map((p) => p.key)).toContain("autonomy");
    expect(view.parts.find((p) => p.key === "autonomy")!.ruleCount).toBeGreaterThan(5);

    await caller(a.owner).handbook.saveAdditions({ organizationId: a.orgId, partKey: "communicate", rules: ["Daily report at 8:00 AM Central, bullets only."] });
    const morgan = (await db.listEmployeesByOrg(a.orgId)).find((e) => e.kind === "grants")!;
    const { system } = await systemPromptFor(morgan, "Find grants.");
    expect(system).toContain("# LeadDash Employees Handbook");
    expect(system).toContain("Part 3: Ownership and autonomy");
    expect(system).toContain("Daily report at 8:00 AM Central, bullets only.");
    expect(handbookText(b.orgId)).not.toContain("Daily report at 8:00 AM Central");

    // Reviewers can read but not change additions.
    await expect(caller(a.reviewer).handbook.saveAdditions({ organizationId: a.orgId, partKey: "communicate", rules: [] })).rejects.toThrow();
    // Members of one workspace cannot read another's.
    await expect(caller(a.owner).handbook.view({ organizationId: b.orgId })).rejects.toThrow();
  });

  it("only LeadDash staff edit the base; every workspace gets the change, and it is logged", async () => {
    const { orgId, owner, staff } = await makeWorkspace("hb-base");
    await expect(caller(owner).handbook.base()).rejects.toThrow();
    const base = await caller(staff).handbook.base();
    const part = base.parts.find((p) => p.key === "never")!;
    await caller(staff).handbook.saveBase({ partKey: "never", part: { title: part.title, lead: part.lead, sections: [{ title: "Never", rules: [...part.sections[0].rules, "Never book travel without approval."] }] } });
    expect(handbookText(orgId)).toContain("Never book travel without approval.");
    const after = await caller(staff).handbook.base();
    expect(after.changes[0]).toMatchObject({ part: "Part 15: What you never do", actorName: "LeadDash Support", summary: "1 rule added" });
    expect(after.parts.find((p) => p.key === "never")!.updatedBy).toBe("LeadDash Support");

    await caller(staff).handbook.resetBase({ partKey: "never" });
    expect(handbookText(orgId)).not.toContain("Never book travel without approval.");
    const other = await makeUser("not-staff@x.test");
    await expect(caller(other).handbook.saveBase({ partKey: "never", part: { title: "x", lead: "", sections: [{ title: "", rules: ["x"] }] } })).rejects.toThrow();
  });

  it("each role reads its own job playbook; staff can edit one and every workspace gets it", async () => {
    const { orgId, staff } = await makeWorkspace("hb-playbooks");
    const emps = await db.listEmployeesByOrg(orgId);
    const by = (k: string) => emps.find((e) => e.kind === k)!;
    const morgan = (await systemPromptFor(by("grants"), "Find grants.")).system;
    expect(morgan).toContain("# Your job playbook: Grant Writer playbook");
    expect(morgan).toContain("compliance checklist");
    expect(morgan).not.toContain("Speaking Agent and Publicist playbook");
    const malik = (await systemPromptFor(by("leads"), "Reply to a lead.")).system;
    expect(malik).toContain("The four pillars of lead nurture");
    expect(malik).toContain("Never use made-up scarcity");
    const simone = (await systemPromptFor(by("coo"), "Write the agenda.")).system;
    expect(simone).not.toContain("# Your job playbook");

    const base = await caller(staff).handbook.base();
    expect(base.playbooks.map((p) => p.kind)).toEqual(["grants", "speaking", "prospecting", "outreach", "leads", "social", "blog", "website", "video"]);
    const pb = base.playbooks.find((p) => p.kind === "outreach")!;
    await caller(staff).handbook.saveBase({ partKey: pb.key, part: { title: pb.title, lead: pb.lead, sections: [...pb.sections, { title: "House rule", rules: ["Always mention the free booking-flow review."] }] } });
    const jada = (await systemPromptFor(by("outreach"), "Write a sequence.")).system;
    expect(jada).toContain("Always mention the free booking-flow review.");
    await caller(staff).handbook.resetBase({ partKey: pb.key });
    expect((await systemPromptFor(by("outreach"), "Write a sequence.")).system).not.toContain("free booking-flow review");
  });

  it("Taylor is the Speaking Agent and Publicist", async () => {
    const { orgId } = await makeWorkspace("hb-taylor");
    const taylor = (await db.listEmployeesByOrg(orgId)).find((e) => e.kind === "speaking")!;
    expect(taylor.roleTitle).toBe("Speaking Agent and Publicist");
    expect(taylor.description).toContain("press");
  });
});
