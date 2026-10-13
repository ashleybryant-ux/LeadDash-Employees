import fs from "node:fs";
import path from "node:path";

/**
 * What Simone knows about making demo and training videos (and the SOP that goes with each).
 * - playbook.md: how to plan, record and finish one, for any site, in every workspace.
 * - One guide per LeadDash app (LeadDash EHR, LeadDash Employees, LeadDash Events), written from the
 *   apps' code: every screen and label, and tasks with where they start and when they're done.
 *   The app guides are LeadDash's own, so they're used only in LeadDash's own workspaces.
 * A browser run gets the parts of a guide that fit the job (sign-in and the demo, the Never list,
 * the app's words, and the closest tasks and screens), not the whole guide.
 */

export const APPS = {
  ehr: { label: "LeadDash EHR", file: "leaddash-ehr.md", hosts: ["demo.leaddash.io", "app.leaddash.io"], names: /leaddash ehr|\behr\b|demo\.leaddash/i },
  employees: { label: "LeadDash Employees", file: "leaddash-employees.md", hosts: ["employees.leaddash.io"], names: /leaddash employees|employees\.leaddash/i },
  events: { label: "LeadDash Events", file: "leaddash-events.md", hosts: ["events.leaddash.io"], names: /leaddash events|events\.leaddash/i },
} as const;
export type AppKey = keyof typeof APPS;

const dir = () => path.resolve(process.cwd(), "server/employees/videoGuides");
const cache = new Map<string, string>();
function read(file: string) {
  if (!cache.has(file)) {
    try {
      cache.set(file, fs.readFileSync(path.join(dir(), file), "utf8"));
    } catch {
      cache.set(file, "");
    }
  }
  return cache.get(file)!;
}

/** How to make a demo or training video, for any site. */
export const playbook = () => read("playbook.md");

/** The app a site belongs to, from its address or the saved login's name. */
export function appFor(...hints: (string | null | undefined)[]): AppKey | null {
  for (const h of hints) {
    if (!h) continue;
    let host = "";
    try {
      host = new URL(/^https?:/i.test(h) ? h : `https://${h}`).hostname.toLowerCase();
    } catch {
      host = "";
    }
    for (const k of Object.keys(APPS) as AppKey[]) if (APPS[k].hosts.some((x) => host === x)) return k;
    for (const k of Object.keys(APPS) as AppKey[]) if (APPS[k].names.test(h)) return k;
  }
  return null;
}

type Part = { title: string; body: string };
/** A guide split into its top sections, with the screens and tasks as their own parts. */
export function partsOf(md: string) {
  const top: Record<string, string> = {};
  const screens: Part[] = [];
  const tasks: Part[] = [];
  const chunks = md.split(/\n(?=## )/);
  for (const c of chunks) {
    const m = c.match(/^## (.+)/);
    if (!m) continue;
    const name = m[1].trim();
    if (/^screens/i.test(name) || /^tasks/i.test(name)) {
      const list = /^screens/i.test(name) ? screens : tasks;
      for (const s of c.split(/\n(?=### )/).slice(1)) {
        const t = s.match(/^### (.+)/);
        // Task groups ("Front desk") are headings with no task under them: only real tasks count.
        if (t && (list === screens || /Starts on:/.test(s))) list.push({ title: t[1].trim(), body: s.trim() });
      }
    } else top[name.toLowerCase()] = c.trim();
  }
  return { top, screens, tasks };
}

const STOP = new Set("a an the and or of in on at to with for from by is are into how do does what when who your our their this that it as be can show me video make record".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/, "")));
function score(want: Set<string>, p: Part) {
  const title = words(p.title);
  const body = words(p.body);
  let n = 0;
  want.forEach((w) => {
    if (title.has(w)) n += 3;
    else if (body.has(w)) n += 1;
  });
  return n;
}

/**
 * The parts of an app guide that fit one job: where and how, the Never list, the app's words,
 * the closest tasks (3) and screens (2). Only in LeadDash's own workspaces; null elsewhere.
 */
export function guideFor(org: { internal?: boolean | null } | null | undefined, job: { title: string; url?: string | null; login?: string | null }) {
  if (!org?.internal) return null;
  const app = appFor(job.url, job.login, job.title);
  if (!app) return null;
  const md = read(APPS[app].file);
  if (!md) return null;
  const { top, screens, tasks } = partsOf(md);
  const want = words(job.title);
  const best = (list: Part[], n: number) => list.map((p) => ({ p, s: score(want, p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p.body);
  const pick = (key: string) => Object.entries(top).find(([k]) => k.startsWith(key))?.[1] ?? "";
  const parts = [`# ${APPS[app].label}: what you need for "${job.title}"`, pick("where"), pick("never"), pick("words"), ...best(tasks, 3), ...best(screens, 2)].filter(Boolean);
  return { app, label: APPS[app].label, text: parts.join("\n\n") };
}
