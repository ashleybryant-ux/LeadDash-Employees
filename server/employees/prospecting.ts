import * as db from "../db";
import { notify } from "../notify";
import { partsIn } from "./schedule";
import type { Repeat } from "./sales";

/**
 * Riley's open search: the owner says who to find in her own words, and
 * Riley searches exactly that. This file holds the small pieces around it:
 * whether the federal NPI Registry helps, the label each prospect keeps,
 * and the saved search that repeats on Mondays or on the 1st.
 */

const HEALTH = /\b(therap|counsel|psycholog|psychiatr|social work|lcsw|lpc|lmft|mft|mental health|behavioral health|substance use|pediatric|primary care|family medicine|internal medicine|physician|doctor)/i;

/** The "who" part of a target: what comes before "who", "that" or "which" ("attorneys who refer families to counseling" is about attorneys). */
function head(target: string) {
  return target.split(/\b(?:who|that|which|whose)\b/i)[0] ?? target;
}

/**
 * The NPI Registry kinds that match a target, or [] when the target is not
 * about health or therapy providers. School counselors are not in the
 * registry, so they don't count.
 */
export function npiKindsFor(target: string): string[] {
  const h = head(target).replace(/\b(school|guidance) counsel\w*/gi, "");
  if (!HEALTH.test(h)) return [];
  const kinds: string[] = [];
  if (/pediatric/i.test(h)) kinds.push("Pediatric offices");
  if (/primary care|family medicine|internal medicine|physician|doctor/i.test(h)) kinds.push("Primary care");
  if (/therap|counsel|psycholog|psychiatr|social work|lcsw|lpc|lmft|mft|mental health|behavioral health|substance use/i.test(h)) kinds.push("practices");
  return kinds;
}

/** "referral" when the owner is looking for people who send clients, otherwise "practice" (a prospect who could buy). */
export function kindFor(target: string): "referral" | "practice" {
  return /\brefer/i.test(target) ? "referral" : "practice";
}

/** A short name for a search when the search did not give one: the "who" part, up to 60 characters. */
export function shortLabel(target: string) {
  const h = head(target).replace(/^\s*(find|look for|search for)\s+/i, "").replace(/[\s,:;.]+$/, "").trim() || target.trim();
  const cut = h.length > 60 ? `${h.slice(0, 57).replace(/\s+\S*$/, "")}...` : h;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** What each prospect keeps as its row subtitle: "Family law attorneys, Denver metro". */
export function searchLabel(label: string, area: string) {
  const l = label.trim().replace(/[.,;:]+$/, "");
  return (area.trim() ? `${l}, ${area.trim()}` : l).slice(0, 200);
}

/** The repeat on screens and in chat: "Every Monday, 25 new". */
export function repeatText(repeat: Repeat, count: number) {
  if (repeat === "weekly") return `Every Monday, ${count} new`;
  if (repeat === "monthly") return `The 1st of each month, ${count} new`;
  return "Off";
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The period a saved search belongs to in the workspace's time zone: the
 * week's Monday ("2026-10-12") or the month ("2026-10"). `first` is true on
 * the period's first day (Monday, or the 1st), when the search waits until 8:00 AM.
 */
export function repeatPeriod(now: Date, tz: string, repeat: Repeat): { key: string; first: boolean; hour: number } | null {
  if (repeat === "off") return null;
  const p = partsIn(now, tz);
  if (repeat === "monthly") return { key: `${p.y}-${String(p.m).padStart(2, "0")}`, first: p.d === 1, hour: p.h };
  const back = (p.wd + 6) % 7; // days since Monday
  const mon = new Date(Date.UTC(p.y, p.m - 1, p.d - back, 12));
  return { key: ymd(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate()), first: back === 0, hour: p.h };
}

/** Whether a saved search should run now: once per period, from 8:00 AM on Monday (or the 1st), catching up later in the period if the server was down. */
export function repeatDue(now: Date, tz: string, repeat: Repeat, lastRepeat: string) {
  const per = repeatPeriod(now, tz, repeat);
  if (!per || per.key === lastRepeat) return null;
  if (per.first && per.hour < 8) return null;
  return per.key;
}

let lastTick = 0;

/** Every 10 minutes: run each workspace's saved search when its Monday (or 1st) comes. Work hours are charged by findProspects. */
export async function prospectingTicks(now = new Date()) {
  if (now.getTime() - lastTick < 10 * 60_000) return;
  lastTick = now.getTime();
  const sales = await import("./sales");
  for (const orgId of await db.listAwakeOrganizationIds()) {
    try {
      const org = await db.getOrganizationById(orgId);
      if (!org?.sales) continue;
      const s = sales.readSales(org.sales);
      if (s.repeat === "off" || !s.target.trim()) continue;
      const due = repeatDue(now, org.timezone || "America/Chicago", s.repeat, s.lastRepeat);
      if (!due) continue;
      const riley = await db.getEmployeeByKind(orgId, "prospecting");
      if (!riley || riley.status === "paused") continue;
      // Mark the period first, so a slow search never runs twice.
      await sales.saveSalesSettings(orgId, { lastRepeat: due });
      const r = await sales.findProspects(orgId, { target: s.target, area: s.area, count: s.count });
      const text = sales.searchReply(r);
      await db.createChatMessage({ organizationId: orgId, employeeId: riley.id, role: "employee", authorName: riley.name, content: text });
      await notify(orgId, "report", { title: `${riley.name}: ${r.created.length} new prospects`, body: text, url: "/chats/prospecting/work" });
    } catch (err) {
      console.warn(`[prospecting] saved search for ${orgId} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** What Riley knows in chat: the saved search and where the workspace is, so "Where should I look?" offers real places. */
export async function prospectingFacts(orgId: number) {
  const sales = await import("./sales");
  const { settings: s, org, tz } = await sales.salesSettings(orgId);
  return `\nSaved search: ${s.target ? `"${s.target}"` : "none yet"}; area: ${s.area || "not set"}; repeat: ${repeatText(s.repeat, s.count)}.\nThis workspace: state ${org.state || "not set"}, time zone ${tz}.`;
}
