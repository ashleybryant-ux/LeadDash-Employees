import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { extractJson, generateJson, type JsonSchema } from "../_core/llm";
import { withUsage } from "../usage";
import type { AIEmployee, PlatformFinding, PortalLogin, WebTask } from "../../drizzle/schema";
import { liveStart, runBrowserTask, type BrowserResult, type BrowserTask } from "./browser";
import { keepSession, platformLogin, startIn } from "./logins";
import { CHANGE_WORDS, liveCard, loginParts, newLiveId, parseRef, post, readResult, stuckPoster } from "./web";

/**
 * Zara, the platform specialist. She works in the LeadDash platform through
 * her browser, with the Website login locked to one sub-account:
 * - Audit: opens every workflow, reads the trigger and each step, changes
 *   nothing, and lists what's wrong with one exact fix for each.
 * - Fix: makes that one change and saves, only after the owner presses Fix.
 * - Pages: puts one of Jordan's pages into a funnel as a draft, and publishes
 *   it only when the owner presses Publish.
 */

export type WorkflowRead = { name: string; status: string; folder: string; trigger: string; steps: string[]; notes: string; url: string; error?: string };
type Studio = { workflows?: WorkflowRead[]; auditedAt?: string | null };

const MAX_WORKFLOWS = 40;
const NEVER_ON_PLATFORM = /\b(pay|purchase|buy|checkout|delete workflow|delete funnel|delete sub-?account|remove sub-?account|add sub-?account|switch sub-?account|agency view)\b/i;

const RULES = `- You are in the LeadDash platform, in one sub-account only. Never open another sub-account or the agency view; those pages are blocked.
- Never change contacts, conversations, payments, users or settings.`;

async function zara(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "platform");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Zara is not in this workspace." });
  return emp;
}

export function studioOf(emp: Pick<AIEmployee, "studio">): Studio {
  return parseRef<Studio>(emp.studio, {});
}

async function needLogin(orgId: number) {
  const login = await platformLogin(orgId);
  if (!login) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Add the LeadDash platform on Integrations under Website logins, locked to the LeadDash sub-account, and I'll start." });
  return login;
}

const failed = (note: string, url = ""): BrowserResult => ({ status: "failed", note, result: "", screenshotUrl: null, storageState: null, log: [], downloads: [], helped: [], url });

/** One browser run in the platform, with the lock, the saved sign-in and the session carried between runs. */
async function inPlatform(emp: AIEmployee, login: PortalLogin, t: WebTask, opts: Omit<BrowserTask, "orgId" | "secrets" | "storageState" | "allowUrl"> ) {
  const fresh = (await db.listPortalLogins(emp.organizationId)).find((l) => l.id === login.id) ?? login;
  const res = await runBrowserTask({ orgId: emp.organizationId, actor: `${emp.name}, the owner's LeadDash platform specialist`, ...loginParts(fresh, `web-${t.id}`), rules: RULES, ...opts }).catch((err) => failed((err as Error).message, opts.startUrl));
  await keepSession(emp.organizationId, fresh, res.storageState).catch(() => null);
  return res;
}

async function codeStop(emp: AIEmployee, t: WebTask, login: PortalLogin, res: BrowserResult) {
  db.updateWebTask(t.id, emp.organizationId, { status: "need_code", note: res.note.slice(0, 300) });
  await post(emp, `The LeadDash platform sent a sign-in code before I could start. Paste it here and I'll keep going.`, [{ type: "web_code", id: t.id, title: `${login.name} sign-in code`, subtitle: res.note ? res.note.slice(0, 200) : "Check your email or phone for it." }]);
}

const active = new Set<number>();
function background(orgId: number, t: WebTask, fn: () => Promise<unknown>) {
  if (active.has(t.id)) return;
  active.add(t.id);
  if (t.liveId) liveStart(orgId, t.liveId);
  void withUsage({ orgId, employeeId: t.employeeId, kind: "platform" }, fn)
    .catch(async (err) => {
      console.error(`[platform] job ${t.id} failed:`, err instanceof Error ? err.message : err);
      db.updateWebTask(t.id, orgId, { status: "failed", note: String(err instanceof Error ? err.message : err).slice(0, 500) });
    })
    .finally(() => active.delete(t.id));
}

/** A job that stopped for a sign-in code runs again once the code is in. */
export async function rerun(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId);
  if (!t) return;
  if (t.kind === "audit") background(orgId, t, () => runAudit(orgId, t.id));
  else if (t.kind === "fix") background(orgId, t, () => runFix(orgId, t.id));
  else if (t.kind === "page" || t.kind === "publish") background(orgId, t, () => runPage(orgId, t.id));
}

// ==========================================
// Audit
// ==========================================

export async function startAudit(orgId: number) {
  const emp = await zara(orgId);
  const login = await needLogin(orgId);
  const running = db.listWebTasks(orgId, 20).find((t) => t.kind === "audit" && (t.status === "queued" || t.status === "working"));
  if (running) return { task: running, already: true };
  const t = db.createWebTask({ organizationId: orgId, employeeId: emp.id, kind: "audit", loginId: login.id, title: "Workflow audit", goal: "Read every workflow and list what's wrong", startUrl: startIn(login, "automation/workflows"), liveId: newLiveId() });
  background(orgId, t, () => runAudit(orgId, t.id));
  return { task: t, already: false };
}

const LIST_GOAL = (sub: string) => `This is the Workflows list in the ${sub} sub-account. Sign in with the saved email and password only if asked.
Read the name and status (Published or Draft) of every workflow. Open each folder you see, and scroll or go to the next page until you have seen them all (up to ${MAX_WORKFLOWS}).
Change nothing. Never press Save, Publish, Delete or a toggle.
Use done with result as JSON: {"workflows":[{"name":"","status":"Published or Draft","folder":"the folder name or ''","url":"the workflow's own link if the list shows one, else ''"}]}`;

const READ_GOAL = (w: { name: string; folder: string; url: string }) => `Open the workflow "${w.name}"${w.folder ? ` (in the folder "${w.folder}")` : ""} from the Workflows list by clicking its name${w.url ? `, or go to ${w.url}` : ""}.
Read its trigger and its settings (which form, calendar, tag or pipeline), then every step in order: waits and how long, if/else branches and their conditions, and which email, text or form each step uses. Note whether it's Published or Draft.
Change nothing. Never press Save, Publish, Delete, a toggle or Test.
Use done with result as JSON: {"name":"","status":"","trigger":"the trigger and its settings","steps":["1. ...","2. ..."],"notes":"anything that looks wrong or empty, or ''","url":"this page's address"}`;

type Listed = { name: string; status: string; folder: string; url: string };

export function parseList(result: string): Listed[] {
  const data = extractJson(result) as { workflows?: Partial<Listed>[] } | undefined;
  const seen = new Set<string>();
  return (data?.workflows ?? [])
    .filter((w) => w && typeof w.name === "string" && w.name.trim())
    .map((w) => ({ name: String(w.name).trim().slice(0, 160), status: String(w.status ?? "").slice(0, 30), folder: String(w.folder ?? "").slice(0, 120), url: String(w.url ?? "").slice(0, 500) }))
    .filter((w) => (seen.has(w.name.toLowerCase()) ? false : (seen.add(w.name.toLowerCase()), true)))
    .slice(0, MAX_WORKFLOWS);
}

export function parseRead(result: string, fallback: Listed, url: string): WorkflowRead {
  const d = (extractJson(result) as Partial<WorkflowRead> | undefined) ?? {};
  return {
    name: String(d.name || fallback.name).slice(0, 160),
    status: String(d.status || fallback.status).slice(0, 30),
    folder: fallback.folder,
    trigger: String(d.trigger ?? "").slice(0, 600),
    steps: (Array.isArray(d.steps) ? d.steps : []).map((s) => String(s).slice(0, 400)).slice(0, 40),
    notes: String(d.notes ?? "").slice(0, 600),
    url: String(d.url || url || fallback.url).slice(0, 500),
  };
}

export async function runAudit(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId)!;
  const emp = await zara(orgId);
  const login = await needLogin(orgId);
  const sub = login.lockName || "LeadDash";
  const liveId = t.liveId || newLiveId();
  db.updateWebTask(t.id, orgId, { status: "working" });
  const stuck = stuckPoster(emp, liveId, "in the LeadDash platform");

  const listed = await inPlatform(emp, login, t, { goal: LIST_GOAL(sub), startUrl: t.startUrl, submitWords: CHANGE_WORDS, neverWords: NEVER_ON_PLATFORM, maxSteps: 40, live: { id: liveId, onStuck: stuck, label: "Listing workflows." } });
  if (listed.status === "need_code") return codeStop(emp, t, login, listed);
  const list = listed.status === "done" ? parseList(listed.result) : [];
  if (!list.length) {
    db.updateWebTask(t.id, orgId, { status: "failed", note: listed.note || "No workflows found", screenshotUrl: listed.screenshotUrl });
    await post(emp, listed.status === "done" ? `I opened Workflows in the ${sub} sub-account and didn't find any workflows there.` : `I couldn't read the workflow list: ${listed.note.replace(/\.$/, "")}. Ask me again, or press Take over when I get stuck.`);
    return;
  }

  const reads: WorkflowRead[] = [];
  let steps = listed.log.length;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    const res = await inPlatform(emp, login, t, { goal: READ_GOAL(w), startUrl: t.startUrl, submitWords: CHANGE_WORDS, neverWords: NEVER_ON_PLATFORM, maxSteps: 25, live: { id: liveId, onStuck: stuck, label: `Workflow ${i + 1} of ${list.length}: reading "${w.name}".` } });
    steps += res.log.length;
    if (/^Stopped by you/.test(res.note)) {
      db.updateWebTask(t.id, orgId, { status: "failed", note: "Stopped by you.", steps });
      await post(emp, `Stopped. I read ${reads.length} of ${list.length} workflows and changed nothing. Ask me to audit again whenever you want.`);
      return;
    }
    if (res.status === "need_code") return codeStop(emp, t, login, res);
    reads.push(res.status === "done" ? parseRead(res.result, w, res.url) : { ...w, trigger: "", steps: [], notes: "", error: res.note.slice(0, 200) });
  }

  const found = await analyze(reads);
  db.clearOpenFindings(orgId);
  const byName = new Map(reads.map((r) => [r.name.toLowerCase(), r]));
  const saved = found.map((f) => {
    const r = byName.get(f.workflow.toLowerCase());
    return db.createFinding({ organizationId: orgId, workflow: f.workflow.slice(0, 160), workflowUrl: r?.url || null, issue: f.issue.slice(0, 300), detail: f.detail.slice(0, 1200), severity: f.severity === "fix_now" ? "fix_now" : "should_fix", howItRuns: JSON.stringify(r ? [r.trigger ? `Trigger: ${r.trigger}` : "", ...r.steps].filter(Boolean) : f.howItRuns), fix: f.fix.slice(0, 1200) });
  });
  await db.updateEmployee(emp.id, orgId, { studio: JSON.stringify({ ...studioOf(emp), workflows: reads, auditedAt: new Date().toISOString() }) });
  db.updateWebTask(t.id, orgId, { status: "done", steps, result: `${reads.length} workflows read, ${saved.length} need fixing`, ref: JSON.stringify({ findings: saved.map((f) => f.id), read: reads.length }) });

  const now = saved.filter((f) => f.severity === "fix_now").length;
  const unread = reads.filter((r) => r.error).length;
  const lines = [
    saved.length
      ? `I read all ${reads.length} workflows. ${saved.length} need fixing${now ? `, and ${now === saved.length ? (now === 1 ? "it's" : "they're all") : `the first ${now === 1 ? "one is" : `${now} are`}`} costing you leads now` : ""}. Nothing was changed. Each fix waits for you on my Workflows tab.`
      : `I read all ${reads.length} workflows and didn't find anything that needs fixing. Nothing was changed.`,
  ];
  if (unread) lines.push(`${unread === 1 ? "One workflow" : `${unread} workflows`} wouldn't open for me, so ${unread === 1 ? "it isn't" : "they aren't"} in this audit.`);
  const choices = saved.length ? [now ? `Fix the ${now === 1 ? "one" : now === 2 ? "first two" : `${now}`} marked Fix now` : "Fix the first one", `Show all ${saved.length}`] : [];
  await post(emp, lines.join("\n\n"), [...(saved.length ? [{ type: "platform_findings", id: t.id, title: "Workflow audit" }] : []), ...(choices.length ? [{ type: "choices", id: Date.now(), title: "", options: choices.map((c) => c.slice(0, 60)) }] : [])]);
}

type Found = { workflow: string; issue: string; detail: string; severity: "fix_now" | "should_fix"; fix: string; howItRuns: string[] };

const FOUND_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["workflow", "issue", "detail", "severity", "fix", "howItRuns"],
        properties: {
          workflow: { type: "string", description: "The workflow's exact name" },
          issue: { type: "string", description: "One plain sentence, under 15 words: what's wrong" },
          detail: { type: "string", description: "Two sentences at most: what happens today and who it affects" },
          severity: { type: "string", enum: ["fix_now", "should_fix"] },
          fix: { type: "string", description: "The one exact change to make in the workflow builder, in plain words, and what stays the same" },
          howItRuns: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** What's wrong across the workflows, from what was read. Only problems the facts show. */
export async function analyze(reads: WorkflowRead[]): Promise<Found[]> {
  const readable = reads.filter((r) => !r.error);
  if (!readable.length) return [];
  const text = readable.map((r) => `### ${r.name} (${r.status || "status unknown"}${r.folder ? `, folder ${r.folder}` : ""})\nTrigger: ${r.trigger || "(not read)"}\n${r.steps.join("\n") || "(no steps read)"}${r.notes ? `\nNoticed: ${r.notes}` : ""}`).join("\n\n");
  const out = await generateJson<{ findings: Found[] }>({
    system: `You audit marketing and sales automations (workflows) in the LeadDash platform for a small business. Find real problems the facts show, each with one exact fix.
Look for: reminders or follow-ups with no wait before them (they send at once); waits that are too long or too short for what the message says; triggers on a form, calendar, tag or pipeline stage that looks wrong, old or missing; workflows that look finished but are still Draft; two workflows sending the same message to the same people; no stop when someone replies, books or buys; steps with empty or placeholder content; people re-entering the same workflow over and over; texts that could go out at night with no quiet hours.
Rules:
- Only report what the facts show. If a workflow wasn't read clearly, don't guess about it.
- fix_now: people are missing messages, getting wrong ones, or getting duplicates right now. should_fix: everything else worth doing.
- Each fix is one small change made inside that workflow (add a wait, change a trigger setting, add a goal or condition, turn on quiet hours, publish it). Never suggest deleting a workflow or rebuilding it.
- Fix now first. At most 12 findings. American English, plain words, no em dashes.`,
    prompt: text.slice(0, 60_000),
    schemaName: "workflow_findings",
    schema: FOUND_SCHEMA,
    maxTokens: 4000,
    timeoutMs: 120_000,
  });
  const names = new Set(readable.map((r) => r.name.toLowerCase()));
  return (out?.findings ?? [])
    .filter((f) => f && f.workflow && f.issue && f.fix && names.has(f.workflow.toLowerCase()))
    .map((f) => ({ ...f, issue: f.issue.replace(/[—–]/g, ", "), detail: (f.detail ?? "").replace(/[—–]/g, ", "), fix: f.fix.replace(/[—–]/g, ", ") }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fix_now" ? -1 : 1))
    .slice(0, 12);
}

// ==========================================
// Fix (only after the owner presses Fix)
// ==========================================

export async function startFix(orgId: number, findingId: number) {
  const emp = await zara(orgId);
  const login = await needLogin(orgId);
  const f = db.getFinding(findingId, orgId);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That finding isn't in this workspace." });
  if (f.status === "fixed") throw new TRPCError({ code: "BAD_REQUEST", message: "That one is already fixed." });
  if (f.status === "fixing") throw new TRPCError({ code: "BAD_REQUEST", message: "I'm fixing that one now." });
  db.updateFinding(f.id, orgId, { status: "fixing", note: null });
  const t = db.createWebTask({ organizationId: orgId, employeeId: emp.id, kind: "fix", loginId: login.id, title: `Fix: ${f.workflow}`, goal: f.fix, startUrl: startIn(login, "automation/workflows"), allowSubmit: true, liveId: newLiveId(), ref: JSON.stringify({ findingId: f.id }) });
  background(orgId, t, () => runFix(orgId, t.id));
  return { task: t, finding: f };
}

export async function runFix(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId)!;
  const emp = await zara(orgId);
  const login = await needLogin(orgId);
  const { findingId } = parseRef<{ findingId: number }>(t.ref, { findingId: 0 });
  const f = db.getFinding(findingId, orgId);
  if (!f) return;
  db.updateWebTask(t.id, orgId, { status: "working" });
  const how = parseRef<string[]>(f.howItRuns, []);
  const res = await inPlatform(emp, login, t, {
    goal: `Open the workflow "${f.workflow}" from the Workflows list by clicking its name${f.workflowUrl ? `, or go to ${f.workflowUrl}` : ""}.
How it runs today:
${how.join("\n") || "(see the builder)"}
Make exactly this change and nothing else: ${f.fix}
Then press Save. If it was published, keep it published. Never delete the workflow.
Use done with result as JSON: {"answer":"what you changed, in one or two plain sentences","pending":""}. If the change can't be made as described, use fail and say why.`,
    startUrl: t.startUrl,
    allowSubmit: true,
    neverWords: NEVER_ON_PLATFORM,
    maxSteps: 40,
    live: { id: t.liveId || newLiveId(), onStuck: stuckPoster(emp, t.liveId || "", `fixing "${f.workflow}"`), label: `Fixing "${f.workflow}".` },
  });
  if (res.status === "need_code") {
    db.updateFinding(f.id, orgId, { status: "open" });
    return codeStop(emp, t, login, res);
  }
  if (res.status === "done") {
    const { answer } = readResult(res.result);
    db.updateFinding(f.id, orgId, { status: "fixed", fixedAt: new Date(), note: answer.slice(0, 600) || null });
    db.updateWebTask(t.id, orgId, { status: "done", result: answer.slice(0, 2000), steps: res.log.length, lastUrl: res.url, screenshotUrl: res.screenshotUrl });
    await post(emp, `Fixed "${f.workflow}". ${answer || "The change is saved."}`.trim(), [{ type: "platform_findings", id: 0, title: "Still to fix" }]);
    return;
  }
  db.updateFinding(f.id, orgId, { status: "open", note: res.note.slice(0, 600) });
  db.updateWebTask(t.id, orgId, { status: "failed", note: res.note.slice(0, 900), steps: res.log.length, lastUrl: res.url, screenshotUrl: res.screenshotUrl });
  await post(emp, `I couldn't fix "${f.workflow}": ${res.note.replace(/\.$/, "")}. Nothing else was changed. Press Fix to try again, or Take over next time and show me.`);
}

export function dismiss(orgId: number, findingId: number) {
  const f = db.getFinding(findingId, orgId);
  if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "That finding isn't in this workspace." });
  return db.updateFinding(f.id, orgId, { status: "dismissed" });
}

/** For the chat: which findings "fix the first two" or "fix the reminders one" means. */
export function pickFindings(orgId: number, words: string, which: string) {
  const open = db.listFindings(orgId).filter((f) => f.status === "open").sort((a, b) => (a.severity === b.severity ? a.id - b.id : a.severity === "fix_now" ? -1 : 1));
  const w = words.trim().toLowerCase();
  if (w) {
    const hit = open.filter((f) => f.workflow.toLowerCase().includes(w) || f.issue.toLowerCase().includes(w));
    if (hit.length) return hit.slice(0, 1);
  }
  if (which === "fix_now") return open.filter((f) => f.severity === "fix_now");
  if (which === "all") return open;
  const n = Number(which);
  return open.slice(0, n > 0 ? Math.min(n, 12) : 1);
}

// ==========================================
// Pages: Jordan's page into a funnel, as a draft
// ==========================================

export function slugOf(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
}

export async function startPage(orgId: number, input: { page: string; funnel: string; path?: string }) {
  const emp = await zara(orgId);
  const login = await needLogin(orgId);
  const funnel = input.funnel.trim();
  if (!funnel) throw new TRPCError({ code: "BAD_REQUEST", message: "Which funnel should it go in?" });
  const w = input.page.trim().toLowerCase();
  const pages = db.listSitePages(orgId).filter((p) => p.currentVersion > 0);
  const page = (w ? pages.find((p) => p.title.toLowerCase().includes(w) || w.includes(p.title.toLowerCase())) : null) ?? (w ? null : pages[0]);
  if (!page) throw new TRPCError({ code: "NOT_FOUND", message: w ? `I don't see a page called "${input.page}" on Jordan's Pages tab.` : "Jordan hasn't built a page yet." });
  const version = db.listSitePageVersions(page.id, orgId).find((v) => v.version === page.currentVersion);
  if (!version) throw new TRPCError({ code: "NOT_FOUND", message: "That page has no saved version yet." });
  const path = slugOf(input.path?.replace(/^\//, "") || page.title);
  const t = db.createWebTask({ organizationId: orgId, employeeId: emp.id, kind: "page", loginId: login.id, title: page.title, goal: `Put Jordan's page into the ${funnel} funnel`, startUrl: startIn(login, "funnels-websites/funnels"), allowSubmit: true, liveId: newLiveId(), ref: JSON.stringify({ pageId: page.id, version: version.version, funnel, path, published: false }) });
  background(orgId, t, () => runPage(orgId, t.id));
  return { task: t, page };
}

/** Publish: only when the owner presses Publish on the page card. */
export async function startPublish(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId);
  if (!t || t.kind !== "page") throw new TRPCError({ code: "NOT_FOUND", message: "That page isn't in this workspace." });
  if (t.status !== "done") throw new TRPCError({ code: "BAD_REQUEST", message: "The page isn't in the platform yet." });
  const ref = parseRef<{ published?: boolean }>(t.ref, {});
  if (ref.published) throw new TRPCError({ code: "BAD_REQUEST", message: "It's already published." });
  const emp = await zara(orgId);
  const p = db.createWebTask({ organizationId: orgId, employeeId: emp.id, kind: "publish", loginId: t.loginId, title: t.title, goal: "Publish the page", startUrl: t.startUrl, allowSubmit: true, liveId: newLiveId(), ref: JSON.stringify({ ...ref, pageTask: t.id }) });
  await post(emp, `Publishing "${t.title}" now.`, [liveCard(p.liveId!, `${emp.name}'s browser`)]);
  background(orgId, p, () => runPage(orgId, p.id));
  return { id: p.id };
}

export async function runPage(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId)!;
  const emp = await zara(orgId);
  const login = await needLogin(orgId);
  const ref = parseRef<{ pageId: number; version: number; funnel: string; path: string; pageTask?: number }>(t.ref, { pageId: 0, version: 0, funnel: "", path: "" });
  db.updateWebTask(t.id, orgId, { status: "working" });
  const liveId = t.liveId || newLiveId();
  let res: BrowserResult;
  if (t.kind === "publish") {
    res = await inPlatform(emp, login, t, {
      goal: `Go to Sites, then Funnels, and open the funnel "${ref.funnel}". Open the step named "${t.title}" (path /${ref.path}) and publish it so the page is live. Change nothing else.
Use done with result as JSON: {"answer":"one sentence: the page is live, with its address if shown","pending":"","url":"the page's live address if shown, else ''"}`,
      startUrl: t.startUrl,
      allowSubmit: true,
      neverWords: NEVER_ON_PLATFORM,
      maxSteps: 30,
      live: { id: liveId, onStuck: stuckPoster(emp, liveId, `publishing "${t.title}"`), label: `Publishing "${t.title}".` },
    });
  } else {
    const html = db.listSitePageVersions(ref.pageId, orgId).find((v) => v.version === ref.version)?.html ?? "";
    if (!html) {
      db.updateWebTask(t.id, orgId, { status: "failed", note: "Jordan's page has no saved version." });
      await post(emp, "I couldn't find that version of Jordan's page anymore.");
      return;
    }
    const fresh = (await db.listPortalLogins(orgId)).find((l) => l.id === login.id) ?? login;
    const parts = loginParts(fresh, `web-${t.id}`);
    res = await runBrowserTask({
      orgId,
      actor: `${emp.name}, the owner's LeadDash platform specialist`,
      ...parts,
      secrets: { ...parts.secrets, content: html },
      rules: RULES,
      goal: `Go to Sites, then Funnels. Open the funnel "${ref.funnel}"; if there is no funnel with that name, create one with that name.
Add a new step named "${t.title}" with the path /${ref.path}, starting from a blank page.
Open that step's page in the editor. Add a Custom HTML (code) element to the page, open its code box, click into the code area and type secret "content" to paste the page.
Close the code box and press Save. Never press Publish.
Use done with result as JSON: {"answer":"one sentence: where the page is now","pending":"","url":"this page's address"}`,
      startUrl: t.startUrl,
      allowSubmit: true,
      neverWords: /\b(publish|delete|pay|purchase|buy|checkout)\b/i,
      maxSteps: 60,
      live: { id: liveId, onStuck: stuckPoster(emp, liveId, `putting "${t.title}" in the platform`), label: `Building "${t.title}".` },
    }).catch((err) => failed((err as Error).message, t.startUrl));
    await keepSession(orgId, fresh, res.storageState).catch(() => null);
  }
  if (res.status === "need_code") return codeStop(emp, t, login, res);
  if (res.status !== "done") {
    db.updateWebTask(t.id, orgId, { status: "failed", note: res.note.slice(0, 900), lastUrl: res.url, screenshotUrl: res.screenshotUrl });
    await post(emp, `I couldn't ${t.kind === "publish" ? "publish" : "finish"} "${t.title}": ${res.note.replace(/\.$/, "")}.${t.kind === "publish" ? " It's still a draft." : ""} Ask me again, or Take over next time and show me.`);
    return;
  }
  const { answer } = readResult(res.result);
  db.updateWebTask(t.id, orgId, { status: "done", result: answer.slice(0, 1000), steps: res.log.length, lastUrl: res.url, screenshotUrl: res.screenshotUrl });
  if (t.kind === "publish") {
    const parent = ref.pageTask ? db.getWebTask(ref.pageTask, orgId) : null;
    if (parent) db.updateWebTask(parent.id, orgId, { ref: JSON.stringify({ ...parseRef(parent.ref, {}), published: true }) });
    await post(emp, `"${t.title}" is live. ${answer}`.trim(), parent ? [{ type: "platform_page", id: parent.id, title: parent.title }] : []);
    return;
  }
  await post(emp, `Jordan's "${t.title}" page is now a page in your ${ref.funnel} funnel. It's saved as a draft, so nothing is live until you publish it.`, [{ type: "platform_page", id: t.id, title: t.title }]);
}

// ==========================================
// For the Workflows tab and chat
// ==========================================

export async function overview(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "platform");
  const st = emp ? studioOf(emp) : {};
  const login = await platformLogin(orgId);
  const findings = db.listFindings(orgId).map((f) => ({ ...f, howItRuns: parseRef<string[]>(f.howItRuns, []) }));
  const audit = db.listWebTasks(orgId, 30).find((t) => t.kind === "audit") ?? null;
  return {
    login: login ? { name: login.name, lockName: login.lockName } : null,
    auditedAt: st.auditedAt ?? null,
    auditing: audit ? audit.status === "queued" || audit.status === "working" : false,
    auditLiveId: audit && (audit.status === "queued" || audit.status === "working") ? audit.liveId : null,
    workflows: (st.workflows ?? []).map((w) => ({ name: w.name, status: w.status, folder: w.folder, trigger: w.trigger, steps: w.steps, url: w.url, error: w.error ?? null })),
    findings,
  };
}

export function pageView(orgId: number, id: number) {
  const t = db.getWebTask(id, orgId);
  if (!t || t.kind !== "page") return null;
  const ref = parseRef<{ funnel: string; path: string; version: number; published?: boolean }>(t.ref, { funnel: "", path: "", version: 0 });
  const publishing = db.listWebTasks(orgId, 50).some((x) => x.kind === "publish" && (x.status === "queued" || x.status === "working") && parseRef<{ pageTask?: number }>(x.ref, {}).pageTask === t.id);
  return { id: t.id, title: t.title, status: t.status, funnel: ref.funnel, path: ref.path, version: ref.version, published: Boolean(ref.published), publishing, lastUrl: t.lastUrl, note: t.note };
}

export async function platformFacts(orgId: number) {
  const login = await platformLogin(orgId);
  const o = await overview(orgId);
  const open = o.findings.filter((f) => f.status === "open");
  return `${login ? `\nThe LeadDash platform login is saved on Integrations, locked to the ${login.lockName} sub-account. You can't open any other sub-account.` : "\nThe LeadDash platform login isn't saved yet. To start, the owner adds it on Integrations under Website logins, locked to the LeadDash sub-account. Never ask for the password in chat."}
${o.auditing ? "An audit is running now." : o.auditedAt ? `Last audit: ${new Date(o.auditedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${o.workflows.length} workflows read.` : "No audit yet."}
Open findings (fix only when the owner says to):
${open.map((f) => `- ${f.workflow}: ${f.issue} (${f.severity === "fix_now" ? "Fix now" : "Should fix"}). Fix: ${f.fix}`).join("\n") || "- none"}
Jordan's pages you can put in the platform: ${db.listSitePages(orgId).filter((p) => p.currentVersion > 0).slice(0, 12).map((p) => `"${p.title}"`).join(", ") || "none yet"}`;
}

export type { PlatformFinding };
