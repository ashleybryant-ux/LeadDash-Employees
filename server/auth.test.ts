import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("./_core/email", () => ({
  sendEmail: vi.fn(async (to: string, subject: string, text: string) => {
    sent.push({ to, subject, text });
  }),
}));

import { appRouter } from "./routers";
import { makeCtx, makeWorkspace } from "./test/helpers";
import { SESSION_COOKIE } from "@shared/const";
import { createContext } from "./_core/context";

const codeFrom = (text: string) => text.match(/\b(\d{6})\b/)![1];

describe("email code sign-in", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("answers the same for an unknown email and sends nothing", async () => {
    const res = await appRouter.createCaller(makeCtx(null)).auth.requestCode({ email: "nobody@example.com" });
    expect(res).toEqual({ sent: true });
    expect(sent).toHaveLength(0);
  });

  it("signs in a workspace member with the emailed code and sets a session cookie", async () => {
    const { owner } = await makeWorkspace("signin");
    const anon = makeCtx(null);
    await appRouter.createCaller(anon).auth.requestCode({ email: owner.email });
    expect(sent).toHaveLength(1);
    const code = codeFrom(sent[0].text);

    const ctx = makeCtx(null);
    const user = await appRouter.createCaller(ctx).auth.verifyCode({ email: owner.email, code });
    expect(user.email).toBe(owner.email);
    const token = ctx.res.cookies[SESSION_COOKIE];
    expect(token).toBeTruthy();

    // The cookie authenticates the next request.
    const next = await createContext({ req: { headers: { cookie: `${SESSION_COOKIE}=${token}` } } as any, res: {} as any, info: {} as any });
    expect(next.user?.id).toBe(owner.id);

    // Signing out revokes that session.
    await appRouter.createCaller({ ...next, res: ctx.res }).auth.logout();
    const after = await createContext({ req: { headers: { cookie: `${SESSION_COOKIE}=${token}` } } as any, res: {} as any, info: {} as any });
    expect(after.user).toBeNull();
  });

  it("rejects a wrong code and locks the code after 5 tries", async () => {
    const { owner } = await makeWorkspace("lockout");
    await appRouter.createCaller(makeCtx(null)).auth.requestCode({ email: owner.email });
    const code = codeFrom(sent[0].text);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: owner.email, code: wrong })).rejects.toThrow(/not right/);
    }
    await expect(appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: owner.email, code })).rejects.toThrow(/not right/);
  });

  it("creates LeadDash staff from ADMIN_EMAILS on first sign-in", async () => {
    await appRouter.createCaller(makeCtx(null)).auth.requestCode({ email: "Staff@LeadDash.io" });
    const code = codeFrom(sent[0].text);
    const user = await appRouter.createCaller(makeCtx(null)).auth.verifyCode({ email: "staff@leaddash.io", code });
    expect(user.role).toBe("admin");
  });

  it("limits how many codes one email can request", async () => {
    const caller = appRouter.createCaller(makeCtx(null));
    for (let i = 0; i < 5; i++) await caller.auth.requestCode({ email: "flood@example.com" });
    await expect(caller.auth.requestCode({ email: "flood@example.com" })).rejects.toThrow(/Too many/);
  });
});
