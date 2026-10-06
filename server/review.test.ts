import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { to: string }[] = [];
vi.mock("./_core/email", () => ({
  sendEmail: vi.fn(async (to: string) => {
    sent.push({ to });
  }),
}));

import { appRouter } from "./routers";
import { caller, makeCtx, makeWorkspace } from "./test/helpers";
import { SESSION_COOKIE } from "@shared/const";
import { createContext } from "./_core/context";
import * as db from "./db";
import { encryptJson } from "./_core/crypto";
import { resetReviewFails } from "./review";

const REVIEW = "review@leaddash.io";

async function turnOn(endsOn: string | null = null) {
  const { staff } = await makeWorkspace(`rv-${Math.random().toString(36).slice(2, 8)}`);
  const v = await caller(staff).review.save({ enabled: true, email: REVIEW, endsOn });
  return { staff, code: v.code! };
}

async function signIn(code: string) {
  const ctx = makeCtx(null);
  await appRouter.createCaller(ctx).auth.requestCode({ email: REVIEW });
  const user = await appRouter.createCaller(ctx).auth.verifyCode({ email: REVIEW, code });
  return { user, cookie: `${SESSION_COOKIE}=${ctx.res.cookies[SESSION_COOKIE]}` };
}

async function whoIs(cookie: string) {
  const ctx = await createContext({ req: { headers: { cookie }, ip: "127.0.0.1" }, res: {} } as never);
  return ctx.user;
}

describe("app review access", () => {
  beforeEach(() => {
    sent.length = 0;
    resetReviewFails();
  });

  it("is staff only", async () => {
    const { owner } = await makeWorkspace("rv-staff");
    await expect(caller(owner).review.get()).rejects.toThrow();
    await expect(caller(owner).review.save({ enabled: true, email: REVIEW, endsOn: null })).rejects.toThrow();
  });

  it("signs the reviewer in with the fixed code, sends no email, and opens only the demo workspace", async () => {
    const { code, staff } = await turnOn("12/31/2099");
    expect(code).toMatch(/^\d{6}$/);
    const { user, cookie } = await signIn(code);
    expect(sent.length).toBe(0);
    expect((await whoIs(cookie))?.id).toBe(user.id);
    expect(user.reviewer).toBe(true);

    const reviewer = (await db.getUserById(user.id))!;
    const orgs = await caller(reviewer).organizations.list();
    expect(orgs.map((o) => o.name)).toEqual(["Demo practice"]);
    const demoId = orgs[0].id;
    // Sample work waiting in Approvals, and every employee.
    expect((await caller(reviewer).publishing.listApprovalQueue({ organizationId: demoId })).length).toBeGreaterThanOrEqual(3);
    expect((await caller(reviewer).employees.list({ organizationId: demoId })).length).toBe(17);

    // No other workspace, and no changing the team.
    const other = await makeWorkspace("rv-other");
    await expect(caller(reviewer).employees.list({ organizationId: other.orgId })).rejects.toThrow(/Access denied/);
    await expect(caller(reviewer).members.add({ organizationId: demoId, email: "x@example.com" })).rejects.toThrow(/review account/);

    const view = await caller(staff).review.get();
    expect(view.lastSignInAt).toBeTruthy();
  });

  it("refuses a wrong code and locks after 10 wrong tries", async () => {
    const { code } = await turnOn();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) {
      await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: REVIEW, code: wrong })).rejects.toThrow(/not right/);
    }
    await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: REVIEW, code })).rejects.toThrow(/not right/);
  });

  it("turning access off signs the reviewer out and the code stops working", async () => {
    const { code, staff } = await turnOn();
    const { cookie } = await signIn(code);
    await caller(staff).review.save({ enabled: false, email: REVIEW, endsOn: null });
    expect(await whoIs(cookie)).toBeNull();
    await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: REVIEW, code })).rejects.toThrow(/not right/);
  });

  it("a new code signs the reviewer out and the old code stops working", async () => {
    const { code, staff } = await turnOn();
    const { cookie } = await signIn(code);
    const fresh = (await caller(staff).review.newCode()).code!;
    expect(await whoIs(cookie)).toBeNull();
    if (fresh !== code) {
      await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: REVIEW, code })).rejects.toThrow(/not right/);
    }
    await signIn(fresh);
  });

  it("ends after the end date", async () => {
    const { code } = await turnOn();
    const { cookie } = await signIn(code);
    db.saveReviewAccess({ endsOn: "01/01/2020", codeEncrypted: encryptJson({ code }) });
    expect(await whoIs(cookie)).toBeNull();
    await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: REVIEW, code })).rejects.toThrow(/not right/);
  });

  it("checks the end date and will not use someone's real email", async () => {
    const { staff, owner } = await makeWorkspace("rv-checks");
    await expect(caller(staff).review.save({ enabled: true, email: REVIEW, endsOn: "13/45/2026" })).rejects.toThrow(/MM\/DD\/YYYY/);
    await expect(caller(staff).review.save({ enabled: true, email: owner.email, endsOn: null })).rejects.toThrow(/already belongs/);
    await expect(caller(staff).review.save({ enabled: true, email: "staff@leaddash.io", endsOn: null })).rejects.toThrow(/already belongs/);
  });
});
