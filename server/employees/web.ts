import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { lookup } from "node:dns/promises";
import { extractJson, searchJson } from "../_core/llm";
import { storagePut } from "../storage";
import { withUsage } from "../usage";
import type { AIEmployee, PortalLogin, WebTask } from "../../drizzle/schema";
import { liveStart, runBrowserTask, type BrowserResult, type BrowserTask } from "./browser";
import { findLogin, keepSession, lockGuard, secretsOf, sessionOf, startIn } from "./logins";

/**
 * Every employee's browser. Asked in chat to do something on a website, the
 * employee opens it on the server, signs in with a saved Website login when
 * one fits, and posts what it found. The person can watch live and take over.
 *
 * Anything that saves, submits, sends, publishes or deletes is refused until
 * the person presses Finish it, which runs the job again approved.
 */

/** Buttons that change something. Refused until the person approves. */
export const CHANGE_WORDS = /\b(submit|save|publish|delete|remove|send (?:email|message|now|text|sms|campaign)|pay|purchase|buy|place (?:bid|order)|checkout|finali[sz]e|activate|go live|unpublish|archive)\b/i;
/** Refused even after approval. */
export const NEVER_WORDS = /\b(pay|purchase|buy|checkout|place order|close account|delete account|cancel (?:subscription|plan|account))\b/i;

// Sign-in codes stay in memory for 10 minutes only, never in the database.
const codes = new Map<string, { code: string; until: number }>();
export function takeCode(key: string) {
  const c = codes.get(key);
  if (!c || c.until < Date.now()) return undefined;
  return c.code;
}
export function putCode(key: string, code: string) {
  const clean = code.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9-]{4,12}$/.test(clean)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the code exactly as the site sent it." });
  codes.set(key, { code: clean, until: Date.now() + 10 * 60_000 });
}

export function newLiveId() {
  return Math.random().toString(36).slice(2, 12);
}

export function liveCard(liveId: string, title: string) {
  return { type: "browser_live" as const, id: 0, title, url: liveId };
}
export function webCard(t: Pick<WebTask, "id" | "title">) {
  return { type: "web_task" as const, id: t.id, title: t.title };
}

export async function post(emp: AIEmployee, content: string, cards: unknown[] = []) {
  return db.createChatMessage({ organizationId: emp.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: cards.length ? JSON.stringify(cards) : null });
}

/**
 * The reason a site stopped the browser, said safely: a sign-in wall never turns
 * into a request for a password. People sign in themselves on Take over, or save
 * a Website login; passwords never go through chat or the AI.
 */
export function safeReason(reason: string) {
  const r = reason.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (/password|credential|log ?in|sign ?in|username|e-?mail and/i.test(r)) return "it needs someone signed in, and there's no saved login for it. Take over and sign in yourself, or save a Website login for it on Integrations. I never see or ask for passwords";
  return r;
}

/** When the browser is stuck: a message with the live card, waiting for the person. */
export function stuckPoster(emp: AIEmployee, liveId: string, what: string) {
  return async (reason: string) => {
    await post(emp, `I'm stuck ${what}: ${safeReason(reason)}. Take over and get me past it, then press Hand back and I'll keep going. I'll wait 10 minutes.`, [liveCard(liveId, `${emp.name}'s browser`)]);
  };
}

export const parseRef = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Settings shared by every job in a login's site: the saved sign-in, the session and the sub-account lock. */
export function loginParts(login: PortalLogin | null, codeKey: string): Pick<BrowserTask, "secrets" | "storageState" | "allowUrl"> {
  if (!login) return { secrets: { code: takeCode(codeKey) } };
  return { secrets: { ...secretsOf(login), code: takeCode(codeKey) }, storageState: sessionOf(login), allowUrl: lockGuard(login) };
}

export async function loginFor(orgId: number, id: number | null) {
  if (!id) return null;
  return (await db.listPortalLogins(orgId)).find((l) => l.id === id) ?? null;
}

// ==========================================
// Starting a job from chat
// ==========================================

export async function startWebTask(emp: AIEmployee, input: { goal: string; url?: string; login?: string; title?: string; kind?: "browse" | "sop"; shots?: string }) {
  const org = emp.organizationId;
  const goal = input.goal.trim();
  if (!goal) throw new TRPCError({ code: "BAD_REQUEST", message: "What should I do on the site?" });
  let url = (input.url ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, "")}`;
  const login = findLogin(await db.listPortalLogins(org), input.login ?? "", url);
  const startUrl = url || (login ? startIn(login) : "");
  // No address: the browser looks the site up from the goal before it starts.
  const guard = login ? lockGuard(login) : undefined;
  if (guard && !guard(startUrl)) throw new TRPCError({ code: "FORBIDDEN", message: `That page is outside the ${login!.lockName} sub-account, and this login only opens that one.` });
  const title = (input.title || goal).replace(/\s+/g, " ").slice(0, 90);
  const t = db.createWebTask({ organizationId: org, employeeId: emp.id, kind: input.kind ?? "browse", loginId: login?.id ?? null, title, goal, startUrl, liveId: newLiveId(), ref: JSON.stringify(input.shots ? { shots: input.shots } : {}) });
  queueWebTask(org, t.id);
  return { task: t, login };
}

const active = new Set<number>();

/** Runs in the background; the browser itself takes one job at a time. */
export function queueWebTask(orgId: number, id: number) {
  if (active.has(id)) return false;
  const t = db.getWebTask(id, orgId);
  if (!t) return false;
  active.add(id);
  if (t.liveId) liveStart(orgId, t.liveId);
  db.updateWebTask(id, orgId, { status: "queued" });
  void withUsage({ orgId, employeeId: t.employeeId }, () => runWebTask(orgId, id))
    .catch((err) => console.error(`[web] job ${id} failed:`, err instanceof Error ? err.message : err))
    .finally(() => active.delete(id));
  return true;
}

function goalText(t: WebTask) {
  return `${t.goal}

When you're finished, use done with result as JSON: {"answer":"what you found or did, in plain full sentences for the owner","pending":"${t.allowSubmit ? "" : "the button you stopped before because it needs the owner's approval (like Save, Submit or Publish), or ''"}"}`;
}

export function readResult(result: string) {
  const data = extractJson(result) as { answer?: string; pending?: string } | undefined;
  if (data && typeof data === "object" && (data.answer || data.pending)) return { answer: String(data.answer ?? "").trim(), pending: String(data.pending ?? "").trim() };
  return { answer: result.trim(), pending: "" };
}

async function saveFiles(orgId: number, res: Pick<BrowserResult, "downloads">) {
  const out: string[] = [];
  for (const d of (res.downloads ?? []).slice(0, 5)) {
    try {
      const put = await storagePut(`org-${orgId}/browser/${Date.now()}-${d.name.replace(/[^\w.-]+/g, "_")}`, d.buf, d.mime);
      out.push(`${d.name}: ${put.url}`);
    } catch {
      /* a file that can't be kept is skipped */
    }
  }
  return out;
}

/** Whether a web address's site exists (its name resolves). */
export async function siteExists(url: string) {
  try {
    await lookup(new URL(url).hostname);
    return true;
  } catch {
    return false;
  }
}

/** A web address that doesn't exist: the real site, found by searching, or null. Only an address the search actually returned, and that exists, is used. */
export async function findRealSite(goal: string, badUrl: string) {
  const host = hostOf(badUrl);
  const r = await searchJson<{ url: string }>({
    system: "You find the official website for a task. Return the one web address the task should start on, exactly as it appears in a search result.",
    prompt: `Task: ${goal.slice(0, 600)}
The address ${host} does not exist. Find the right one.`,
    schemaName: "real_site",
    schema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" } } },
    maxUses: 3,
  });
  const url = (r.data?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const seen = (r.sources ?? []).some((x) => hostOf(x.url) === hostOf(url));
  if (!seen || !(await siteExists(url))) return null;
  return url;
}

/** Playwright's errors carry color codes and a call log; the owner gets one plain sentence. */
export function plainNote(note: string, url: string) {
  const text = note.replace(/\u001b\[[0-9;]*m/g, "").replace(/\[[0-9;]*m/g, "");
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(text)) return `there's no website at ${hostOf(url)}`;
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT/.test(text)) return `${hostOf(url)} didn't answer`;
  if (/Timeout \d+ms exceeded/.test(text)) return `${hostOf(url)} took too long to load`;
  return safeReason(text.split(/\n\s*Call log:/)[0].replace(/^page\.\w+:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 300));
}

export async function runWebTask(orgId: number, id: number) {
  let t = db.getWebTask(id, orgId);
  if (!t) return;
  const emp = await db.getEmployeeForOrg(t.employeeId, orgId);
  if (!emp) return;
  const login = await loginFor(orgId, t.loginId);
  db.updateWebTask(id, orgId, { status: "working" });
  // A made-up or mistyped address: look up the real site instead of failing on it.
  if (!login && !(await siteExists(t.startUrl))) {
    const real = await findRealSite(t.goal, t.startUrl).catch(() => null);
    if (!real) {
      const what = t.startUrl ? `There's no website at ${hostOf(t.startUrl)}, and a search didn't turn up the right one.` : "A search didn't turn up the right website.";
      const next = db.updateWebTask(id, orgId, { status: "failed", note: what })!;
      await post(emp, `${what} Send me the link and I'll go straight there.`, [webCard(next)]);
      return;
    }
    t = db.updateWebTask(id, orgId, { startUrl: real })!;
  }
  const liveId = t.liveId || newLiveId();
  const res = await runBrowserTask({
    orgId,
    actor: `${emp.name}, the owner's ${emp.roleTitle}`,
    goal: goalText(t),
    startUrl: t.startUrl,
    ...loginParts(login, `web-${t.id}`),
    allowSubmit: t.allowSubmit,
    submitWords: CHANGE_WORDS,
    neverWords: NEVER_WORDS,
    maxSteps: t.kind === "sop" ? 60 : 40,
    shots: parseRef<{ shots?: string }>(t.ref, {}).shots,
    live: { id: liveId, onStuck: stuckPoster(emp, liveId, "on that site") },
  }).catch((err) => ({ status: "failed", note: (err as Error).message, result: "", screenshotUrl: null, storageState: null, log: [], downloads: [], helped: [], url: t.startUrl }) as BrowserResult);
  if (login) await keepSession(orgId, login, res.storageState).catch(() => null);
  await finishWebTask(emp, t, res, login);
}

export async function finishWebTask(emp: AIEmployee, t: WebTask, res: BrowserResult, login: PortalLogin | null) {
  const orgId = emp.organizationId;
  const steps = res.log.filter((l) => l.action !== "person" && l.action !== "blocked").length;
  const base = { steps, lastUrl: res.url || null, screenshotUrl: res.screenshotUrl };
  if (t.kind === "sop" && res.status === "done") {
    const sops = await import("./sops");
    const next = db.updateWebTask(t.id, orgId, { ...base, status: "done", result: readResult(res.result).answer.slice(0, 8000), note: null })!;
    const sop = await sops.finishFromSite(emp, t, res).catch((err) => {
      console.error("[sops] writing from the site failed:", err instanceof Error ? err.message : err);
      return null;
    });
    if (sop) {
      const n = sops.stepsOf(sop).length;
      await post(emp, `Done. I went through the screens and wrote "${sop.title}" as ${n} step${n === 1 ? "" : "s"} with a screenshot under each one. Open the draft, or send it to ${(await sops.reviewer(orgId))?.name ?? "the owner"} for review.`, [sops.card(sop), webCard(next)]);
    } else {
      await post(emp, `I went through the screens but could not write the steps up. Ask me to try again, or record it yourself from the SOPs tab.`, [webCard(next)]);
    }
    return next;
  }
  if (t.kind === "sop") {
    const sops = await import("./sops");
    await sops.finishFromSite(emp, t, res).catch(() => null);
  }
  if (res.status === "done") {
    const { answer, pending } = readResult(res.result);
    const files = await saveFiles(orgId, res);
    const next = db.updateWebTask(t.id, orgId, { ...base, status: "done", result: answer.slice(0, 8000), pending: t.allowSubmit ? null : pending.slice(0, 200) || null, note: null })!;
    const lines = [answer || "Done."];
    if (next.pending) lines.push(`I stopped before pressing ${next.pending}, because that changes something. Press Finish it on the card and I'll do it.`);
    if (files.length) lines.push(`Files I downloaded:\n${files.map((f) => `- ${f}`).join("\n")}`);
    await post(emp, lines.join("\n\n"), [webCard(next)]);
    return next;
  }
  if (res.status === "need_code") {
    const next = db.updateWebTask(t.id, orgId, { ...base, status: "need_code", note: res.note.slice(0, 300) })!;
    const site = login?.name ?? hostOf(t.startUrl);
    await post(emp, `${site} sent a sign-in code before I could finish. Paste it here and I'll keep going.`, [{ type: "web_code", id: t.id, title: `${site} sign-in code`, subtitle: res.note ? res.note.slice(0, 200) : "Check your email or phone for it." }]);
    return next;
  }
  const next = db.updateWebTask(t.id, orgId, { ...base, status: "failed", note: res.note.slice(0, 900) })!;
  await post(emp, `I couldn't finish that: ${plainNote(res.note, res.url || t.startUrl).replace(/\.$/, "")}. Tell me what to change and I'll try again, or press Take over next time it gets stuck.`, [webCard(next)]);
  return next;
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "The site";
  }
}

// ==========================================
// From the cards
// ==========================================

export function view(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId);
  if (!t) return null;
  const ref = parseRef<Record<string, unknown>>(t.ref, {});
  return { id: t.id, kind: t.kind, title: t.title, status: t.status, steps: t.steps, lastUrl: t.lastUrl, screenshotUrl: t.screenshotUrl, pending: t.pending, result: t.result, note: t.note, ref, createdAt: t.createdAt };
}

/** Finish it: the same job again, approved to press the button it stopped before. */
export async function approve(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId);
  if (!t || t.kind !== "browse") throw new TRPCError({ code: "NOT_FOUND", message: "That job isn't in this workspace." });
  if (t.status !== "done" || !t.pending) throw new TRPCError({ code: "BAD_REQUEST", message: "There's nothing waiting for your approval on that one." });
  const emp = await db.getEmployeeForOrg(t.employeeId, orgId);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "That employee is not in this workspace." });
  const goal = `${t.goal}\n\nLast time you did everything up to pressing "${t.pending}". The owner approved it. Do the job again from the start (the earlier entries may not have been saved), press "${t.pending}", and say what the site confirmed.`;
  const next = db.createWebTask({ organizationId: orgId, employeeId: emp.id, kind: "browse", loginId: t.loginId, title: t.title, goal, startUrl: t.startUrl, allowSubmit: true, liveId: newLiveId(), ref: JSON.stringify({ approvedFrom: t.id }) });
  db.updateWebTask(t.id, orgId, { pending: null, ref: JSON.stringify({ ...parseRef(t.ref, {}), approvedAs: next.id }) });
  await post(emp, `Finishing it now: I'll press ${t.pending}.`, [liveCard(next.liveId!, `${emp.name}'s browser`)]);
  queueWebTask(orgId, next.id);
  return { id: next.id };
}

/** A sign-in code for a job that stopped for one: kept 10 minutes, then the job runs again. */
export async function submitCode(orgId: number, id: number, code: string) {
  const t = db.getWebTask(id, orgId);
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "That job isn't in this workspace." });
  putCode(`web-${t.id}`, code);
  if (t.kind === "browse") queueWebTask(orgId, t.id);
  else await (await import("./platform")).rerun(orgId, t.id);
  return { success: true };
}

/** After a restart, jobs that were running can't pick up where they were. */
export function failInterrupted() {
  for (const t of db.listUnfinishedWebTasks()) {
    db.updateWebTask(t.id, t.organizationId, { status: "failed", note: "The server restarted while this was running. Ask again and I'll start over." });
    if (t.kind === "fix" || t.kind === "page" || t.kind === "publish") {
      const ref = parseRef<{ findingId?: number }>(t.ref, {});
      if (ref.findingId) db.updateFinding(ref.findingId, t.organizationId, { status: "open", note: "Stopped by a server restart. Press Fix again." });
    }
  }
}
