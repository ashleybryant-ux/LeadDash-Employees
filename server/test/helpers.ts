import type { TrpcContext } from "../_core/context";
import type { User } from "../../drizzle/schema";
import { appRouter } from "../routers";
import * as db from "../db";

export type FakeRes = TrpcContext["res"] & { cookies: Record<string, string>; cleared: string[] };

export function makeCtx(user: User | null, cookie?: string): TrpcContext & { res: FakeRes } {
  const cookies: Record<string, string> = {};
  const cleared: string[] = [];
  const res = {
    cookies,
    cleared,
    cookie: (name: string, value: string) => {
      cookies[name] = value;
    },
    clearCookie: (name: string) => {
      cleared.push(name);
    },
  } as unknown as FakeRes;
  return {
    user,
    req: { protocol: "https", headers: cookie ? { cookie } : {}, ip: "127.0.0.1" } as TrpcContext["req"],
    res,
    sessionTokenHash: null,
  };
}

export function caller(user: User | null) {
  return appRouter.createCaller(makeCtx(user));
}

export async function makeUser(email: string, role: "user" | "admin" = "user", name?: string) {
  return db.createUser({ email, role, name: name ?? null });
}

/** A workspace with an owner, a reviewer and the seven starting employees. */
export async function makeWorkspace(slug: string) {
  const staff = (await db.getUserByEmail("staff@leaddash.io")) ?? (await makeUser("staff@leaddash.io", "admin", "LeadDash Support"));
  const owner = await makeUser(`owner@${slug}.test`, "user", `Owner ${slug}`);
  const result = await caller(staff).organizations.create({
    name: `Workspace ${slug}`,
    slug,
    plan: "growth",
    state: "Oklahoma",
    ownerEmail: owner.email,
  });
  const reviewer = await makeUser(`reviewer@${slug}.test`, "user", `Reviewer ${slug}`);
  await db.addOrganizationMember({ organizationId: result.id!, userId: reviewer.id, role: "reviewer" });
  return { orgId: result.id!, owner: (await db.getUserById(owner.id))!, reviewer, staff };
}
