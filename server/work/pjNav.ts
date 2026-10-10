import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { parse } from "./projects";
import type { Viewer } from "./pjAccess";

/**
 * Customize sidebar: which items show at the top of the Projects sidebar and
 * in what order. The rest sit under More. Each person has their own.
 */

export const NAV_ITEMS = ["home", "mine", "everything", "docs", "portfolios", "dash", "time", "templates", "boards", "forms", "goals", "import"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];
export const DEFAULT_NAV: NavItem[] = ["home", "mine", "everything", "docs", "portfolios", "dash"];

const uidOf = (v: Viewer) => (v.kind === "member" ? v.userId : 0);

export function nav(orgId: number, v: Viewer): { shown: NavItem[]; more: NavItem[] } {
  const uid = uidOf(v);
  const row = uid ? db.work.prefs.where(orgId, "userId", uid).find((p) => p.key === "nav") : null;
  const shown = (row ? parse<string[]>(row.value, DEFAULT_NAV) : DEFAULT_NAV).filter((k): k is NavItem => (NAV_ITEMS as readonly string[]).includes(k));
  return { shown, more: NAV_ITEMS.filter((k) => !shown.includes(k)) };
}

export function setNav(orgId: number, v: Viewer, shown: string[]) {
  const uid = uidOf(v);
  if (!uid) throw new TRPCError({ code: "FORBIDDEN", message: "Sign in to keep that." });
  const clean = Array.from(new Set(shown.filter((k): k is NavItem => (NAV_ITEMS as readonly string[]).includes(k))));
  const row = db.work.prefs.where(orgId, "userId", uid).find((p) => p.key === "nav");
  if (row) db.work.prefs.update(orgId, row.id, { value: JSON.stringify(clean) });
  else db.work.prefs.insert({ organizationId: orgId, userId: uid, key: "nav", value: JSON.stringify(clean) });
  return nav(orgId, v);
}
