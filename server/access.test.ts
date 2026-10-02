import { describe, expect, it } from "vitest";
import { caller, makeUser, makeWorkspace } from "./test/helpers";
import * as db from "./db";

describe("access control", () => {
  it("refuses every workspace route without a signed-in person (no demo mode)", async () => {
    const { orgId } = await makeWorkspace("anon");
    const anon = caller(null);
    await expect(anon.organizations.list()).rejects.toThrow(/sign in/i);
    await expect(anon.employees.list({ organizationId: orgId })).rejects.toThrow(/sign in/i);
    await expect(anon.publishing.listApprovalQueue({ organizationId: orgId })).rejects.toThrow(/sign in/i);
    await expect(anon.knowledge.list({ organizationId: orgId })).rejects.toThrow(/sign in/i);
  });

  it("keeps workspaces apart", async () => {
    const a = await makeWorkspace("tenant-a");
    const b = await makeWorkspace("tenant-b");
    const outsider = caller(a.owner);
    await expect(outsider.employees.list({ organizationId: b.orgId })).rejects.toThrow(/Access denied/);
    await expect(outsider.grants.listOpportunities({ organizationId: b.orgId })).rejects.toThrow(/Access denied/);
    const orgs = await outsider.organizations.list();
    expect(orgs.map((o) => o.id)).toEqual([a.orgId]);
  });

  it("will not act on another workspace's item even when the id is known", async () => {
    const a = await makeWorkspace("item-a");
    const b = await makeWorkspace("item-b");
    const item = await db.createOutboundItem({ organizationId: b.orgId, kind: "social_post", status: "pending_approval", title: "B's post" });
    await expect(
      caller(a.owner).publishing.approveAndDispatch({ organizationId: a.orgId, itemId: item.id, action: "approve_for_dispatch" })
    ).rejects.toThrow(/not found/);
    expect((await db.getOutboundItemForOrg(item.id, b.orgId))?.status).toBe("pending_approval");
  });

  it("starts every new workspace with the seven employees", async () => {
    const { orgId, owner } = await makeWorkspace("roster");
    const employees = await caller(owner).employees.list({ organizationId: orgId });
    expect(employees.map((e) => e.kind).sort()).toEqual(["blog", "grants", "inbox", "social", "speaking", "video", "website"]);
    expect(employees.find((e) => e.kind === "video")?.name).toBe("Elena");
  });

  it("only admins and owners manage the team; reviewers can approve", async () => {
    const { orgId, reviewer, owner } = await makeWorkspace("roles");
    await expect(caller(reviewer).members.add({ organizationId: orgId, email: "new@roles.test" })).rejects.toThrow(/role/);
    await caller(owner).members.add({ organizationId: orgId, email: "new@roles.test", name: "New Person" });
    const item = await db.createOutboundItem({ organizationId: orgId, kind: "email_draft", status: "pending_approval", title: "Hello" });
    const approved = await caller(reviewer).publishing.approveAndDispatch({ organizationId: orgId, itemId: item.id, action: "approve_for_dispatch", reviewerName: "Someone Else" });
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedBy).toBe(reviewer.name); // the signed-in person, never a name the browser sends
  });

  it("gives LeadDash staff support access without putting them on the team", async () => {
    const { orgId, staff } = await makeWorkspace("support");
    const employees = await caller(staff).employees.list({ organizationId: orgId });
    expect(employees.length).toBe(7);
    const team = await caller(staff).members.list({ organizationId: orgId });
    expect(team.some((m) => m.email === staff.email)).toBe(false);
    await expect(caller(staff).members.add({ organizationId: orgId, email: staff.email })).rejects.toThrow(/cannot be added/);
  });

  it("only LeadDash staff create workspaces", async () => {
    const someone = await makeUser("someone@example.com");
    await expect(caller(someone).organizations.create({ name: "Mine", slug: "mine", plan: "growth" })).rejects.toThrow(/permission/);
  });
});

describe("team role rules", () => {
  it("an admin cannot demote or remove an owner, and the last owner stays an owner", async () => {
    const { orgId, owner } = await makeWorkspace("owners");
    const admin = await makeUser("admin@owners.test", "user", "Admin Person");
    await db.addOrganizationMember({ organizationId: orgId, userId: admin.id, role: "admin" });
    await expect(caller(admin).members.updateRole({ organizationId: orgId, userId: owner.id, role: "reviewer" })).rejects.toThrow(/role/);
    await expect(caller(admin).members.remove({ organizationId: orgId, userId: owner.id })).rejects.toThrow(/role/);
    await expect(caller(owner).members.updateRole({ organizationId: orgId, userId: owner.id, role: "member" })).rejects.toThrow(/at least one owner/);
    await expect(caller(owner).members.updateRole({ organizationId: orgId, userId: 99999, role: "member" })).rejects.toThrow(/not on this workspace/);
  });

  it("dismiss only touches the right kind of item", async () => {
    const { orgId, owner } = await makeWorkspace("kinds");
    const plan = await db.createWorkItem({ organizationId: orgId, kind: "website_plan", title: "Home", data: "{}" });
    await expect(caller(owner).speaking.dismiss({ organizationId: orgId, id: plan.id })).rejects.toThrow(/not in this workspace/);
    expect((await db.getWorkItemForOrg(plan.id, orgId))?.status).toBe("new");
  });
});
