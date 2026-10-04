import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { ENV } from "../_core/env";
import { generateJson, type JsonSchema } from "../_core/llm";
import type { AIEmployee, DevChange } from "../../drizzle/schema";

/**
 * Kai, the developer. The owner tells Kai what's broken or what to change; Kai
 * writes it up as a GitHub issue that mentions @claude, and the Claude Code
 * GitHub Action (a workflow in the repo) does the work on its own branch. Kai
 * watches the issue, opens the pull request when Claude finishes, sums up what
 * changed, and brings it to the owner. Only the owner merges (the Merge button),
 * and nothing goes live until she runs the deploy. Kai never merges on his own.
 */

export type Repo = { label: string; repo: string; deploy: string };
export type DevSettings = { repos: Repo[] };

export const DEFAULT_REPOS: Repo[] = [
  { label: "LeadDash Employees", repo: "ashleybryant-ux/LeadDash-Employees", deploy: "cd /home/ssm-user/employees && ./deploy.sh" },
  { label: "LeadDash EHR", repo: "ashleybryant-ux/leaddash-ehr", deploy: "cd /home/ssm-user/server && ./deploy.sh" },
];

export const WORKFLOW_PATH = ".github/workflows/claude.yml";
export const WORKFLOW = `name: Claude
# Added by Kai (LeadDash Employees). Claude works on issues and comments that mention @claude.
on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  claude:
    if: |
      (github.event_name == 'issues' && contains(github.event.issue.body, '@claude')) ||
      (github.event_name != 'issues' && contains(github.event.comment.body, '@claude'))
    runs-on: ubuntu-latest
    timeout-minutes: 45
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 1
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: \${{ secrets.ANTHROPIC_API_KEY }}
          claude_args: "--max-turns 60"
`;

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const parse = <T,>(raw: string | null | undefined, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function settingsOf(emp: Pick<AIEmployee, "studio">): DevSettings {
  const s = parse<Partial<DevSettings>>(emp.studio, {});
  const repos = (s.repos ?? []).filter((r) => r && /^[\w.-]+\/[\w.-]+$/.test(r.repo));
  return { repos: repos.length ? repos : DEFAULT_REPOS };
}

async function kai(orgId: number) {
  const emp = await db.getEmployeeByKind(orgId, "developer");
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "Kai is not in this workspace." });
  return emp;
}

export async function saveSettings(orgId: number, repos: Repo[]) {
  const emp = await kai(orgId);
  const clean = repos
    .map((r) => ({ label: r.label.trim().slice(0, 60), repo: r.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, ""), deploy: r.deploy.trim().slice(0, 300) }))
    .filter((r) => r.label && /^[\w.-]+\/[\w.-]+$/.test(r.repo))
    .slice(0, 6);
  if (!clean.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Add at least one repo, like owner/name." });
  await db.updateEmployee(emp.id, orgId, { studio: JSON.stringify({ repos: clean }) });
  return { repos: clean };
}

/** GitHub's REST API with the owner's token. */
export async function gh(pathName: string, init: { method?: string; body?: unknown } = {}) {
  if (!ENV.githubToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Kai isn't connected to GitHub yet: GITHUB_TOKEN is missing on the server." });
  const res = await fetch(`https://api.github.com${pathName}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${ENV.githubToken}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "LeadDash-Employees", ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(`GitHub said no (${res.status}): ${data?.message ?? "unknown error"}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Whether each repo has Claude's workflow, so the Changes tab can say "Claude connected". */
export async function repoStatus(orgId: number) {
  const emp = await kai(orgId);
  const repos = settingsOf(emp).repos;
  // Without a token Kai can't look inside the repos: the owner adds Claude's workflow from a GitHub link.
  if (!ENV.githubToken) return repos.map((r) => ({ ...r, connected: false, linkOnly: true, reason: "", addUrl: workflowUrl(r.repo) }));
  if (process.env.NODE_ENV === "test") return repos.map((r) => ({ ...r, connected: false, linkOnly: false, reason: "", addUrl: workflowUrl(r.repo) }));
  return Promise.all(
    repos.map(async (r) => {
      try {
        await gh(`/repos/${r.repo}/contents/${WORKFLOW_PATH}`);
        return { ...r, connected: true, linkOnly: false, reason: "", addUrl: workflowUrl(r.repo) };
      } catch (err: any) {
        return { ...r, connected: false, linkOnly: false, addUrl: workflowUrl(r.repo), reason: err?.status === 404 ? "Claude's workflow isn't in this repo yet" : (err?.message ?? "Couldn't reach GitHub") };
      }
    })
  );
}

/** GitHub's "new file" page with Claude's workflow filled in: the owner presses Commit, signed in as herself. */
export function workflowUrl(repo: string) {
  return `https://github.com/${repo}/new/main?filename=${encodeURIComponent(WORKFLOW_PATH)}&value=${encodeURIComponent(WORKFLOW)}`;
}

/** GitHub's "new issue" page with Kai's write-up filled in. Posting it (as the owner) starts Claude. */
export function newIssueUrl(repo: string, title: string, body: string) {
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** Adds Claude's workflow file to a repo (the token needs Workflows: write). */
export async function connectRepo(orgId: number, repo: string) {
  const emp = await kai(orgId);
  const r = settingsOf(emp).repos.find((x) => x.repo === repo);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That repo isn't on Kai's list." });
  let sha: string | undefined;
  try {
    sha = (await gh(`/repos/${r.repo}/contents/${WORKFLOW_PATH}`)).sha;
  } catch {
    sha = undefined;
  }
  await gh(`/repos/${r.repo}/contents/${WORKFLOW_PATH}`, { method: "PUT", body: { message: "Add Claude workflow (Kai, LeadDash Employees)", content: Buffer.from(WORKFLOW).toString("base64"), ...(sha ? { sha } : {}) } });
  return repoStatus(orgId);
}

const RULES = `Rules for this change:
- Keep the change as small as it can be and match how the code is already written.
- Run the project's tests and type check before you finish, and fix anything you broke.
- Never commit keys, passwords or .env files, and never add or log client or patient data.
- When you're done, push your branch and end with a short plain summary: what was wrong, what you changed, and how to check it.`;

/** Kai writes the issue that starts Claude. */
export async function askClaude(orgId: number, input: { label: string; title: string; request: string }) {
  const emp = await kai(orgId);
  const repos = settingsOf(emp).repos;
  const want = input.label.trim().toLowerCase();
  const r = repos.find((x) => x.label.toLowerCase() === want || x.repo.toLowerCase() === want) ?? repos.find((x) => want && (x.label.toLowerCase().includes(want) || want.includes(x.label.toLowerCase().split(" ").pop() ?? "~"))) ?? (repos.length === 1 ? repos[0] : null);
  if (!r) throw new TRPCError({ code: "BAD_REQUEST", message: `Which code is it in: ${repos.map((x) => x.label).join(" or ")}?` });
  const title = input.title.trim().slice(0, 120) || "Fix";
  const body = `@claude ${input.request.trim()}\n\n${RULES}\n\n_Written by ${emp.name} for the owner in LeadDash Employees._`;
  // No token: the owner posts the issue from a link that has everything filled in, and follows it on GitHub.
  if (!ENV.githubToken) {
    return db.createDevChange({ organizationId: orgId, employeeId: emp.id, repo: r.repo, label: r.label, title, request: input.request.trim(), issueUrl: newIssueUrl(r.repo, title, body), status: "handed_off" });
  }
  const issue = await gh(`/repos/${r.repo}/issues`, { method: "POST", body: { title, body } });
  return db.createDevChange({ organizationId: orgId, employeeId: emp.id, repo: r.repo, label: r.label, title, request: input.request.trim(), issueNumber: issue.number, issueUrl: issue.html_url, status: "working" });
}

type Comment = { id: number; body: string; user?: { login?: string; type?: string } };
const isClaude = (c: Comment) => /claude/i.test(c.user?.login ?? "") && (c.user?.type === "Bot" || /\[bot\]/.test(c.user?.login ?? ""));

/** One look at a change: finds Claude's branch, opens the pull request, sums it up. */
export async function check(ch: DevChange) {
  if (ch.status !== "working" || !ch.issueNumber) return ch;
  const comments: Comment[] = await gh(`/repos/${ch.repo}/issues/${ch.issueNumber}/comments?per_page=100`);
  const claude = comments.filter(isClaude);
  const last = claude[claude.length - 1];
  // A comment already read (an earlier round) doesn't count again.
  if (!last || last.id === ch.seenComment) return ch;
  const finished = /claude finished/i.test(last.body);
  const failed = /claude encountered an error/i.test(last.body) && !finished;
  if (failed) return finish(ch, { status: "failed", seenComment: last.id, error: "Claude couldn't finish this one. Ask Kai to try again with more detail." });
  if (!finished) return ch;

  // Claude pushes to a branch named claude/issue-<number>-...
  let pr = ch.prNumber ? await gh(`/repos/${ch.repo}/pulls/${ch.prNumber}`) : null;
  if (!pr) {
    const open: any[] = await gh(`/repos/${ch.repo}/pulls?state=open&per_page=100`);
    pr = open.find((p) => String(p.head?.ref ?? "").startsWith(`claude/issue-${ch.issueNumber}-`)) ?? null;
  }
  if (!pr) {
    const branches: any[] = await gh(`/repos/${ch.repo}/branches?per_page=100`);
    const branch = branches.map((b) => String(b.name)).filter((n) => n.startsWith(`claude/issue-${ch.issueNumber}-`)).pop();
    if (!branch) {
      // Finished without changing code: Claude answered or asked something instead.
      return finish(ch, { status: "failed", seenComment: last.id, error: "Claude finished without changing any code. Its note is on the issue." });
    }
    const repoInfo = await gh(`/repos/${ch.repo}`);
    pr = await gh(`/repos/${ch.repo}/pulls`, { method: "POST", body: { title: ch.title, head: branch, base: repoInfo.default_branch ?? "main", body: `Closes #${ch.issueNumber}\n\nMade by Claude, opened by Kai in LeadDash Employees. Review it, then merge.` } });
  }
  const files: any[] = await gh(`/repos/${ch.repo}/pulls/${pr.number}/files?per_page=100`);
  let checks = "no checks";
  try {
    const runs = (await gh(`/repos/${ch.repo}/commits/${pr.head.sha}/check-runs`)).check_runs as { conclusion: string | null; status: string; name: string }[];
    const mine = runs.filter((r) => !/claude/i.test(r.name));
    if (mine.length) checks = mine.some((r) => r.status !== "completed") ? "checks running" : mine.every((r) => ["success", "neutral", "skipped"].includes(r.conclusion ?? "")) ? "checks pass" : "checks failing";
  } catch {
    checks = "no checks";
  }
  let summary: string[] = [];
  try {
    const out = await generateJson<{ points: string[] }>({
      system: "Sum up a code change for a busy business owner who isn't a developer. 1 to 4 plain sentences: what was wrong and what changed, and say whether tests passed if the note says. No file paths unless they help, no jargon, no em dashes.",
      prompt: `Request: ${ch.request}\n\nClaude's note:\n${last.body.slice(0, 6000)}\n\nFiles changed: ${files.map((f) => f.filename).join(", ")}`,
      schemaName: "dev_summary",
      schema: obj({ points: { type: "array", items: str } }),
      maxTokens: 500,
    });
    summary = (out.points ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 4);
  } catch {
    summary = [];
  }
  return finish(ch, { status: "ready", prNumber: pr.number, prUrl: pr.html_url, branch: pr.head?.ref ?? null, files: files.length, checks, summary: JSON.stringify(summary), seenComment: last.id });
}

async function finish(ch: DevChange, data: Partial<DevChange>) {
  const done = db.updateDevChange(ch.id, ch.organizationId, data)!;
  const emp = await db.getEmployeeForOrg(ch.employeeId, ch.organizationId);
  if (emp) {
    const content =
      done.status === "ready"
        ? `The fix for "${done.title}" is ready for you. Claude changed ${done.files} file${done.files === 1 ? "" : "s"}${done.checks && done.checks !== "no checks" ? `, and the ${done.checks}` : ""}. Nothing is live until you merge it and run the deploy.`
        : `"${done.title}" didn't finish: ${done.error}`;
    await db.createChatMessage({ organizationId: ch.organizationId, employeeId: emp.id, role: "employee", authorName: emp.name, content, cards: JSON.stringify([{ type: "dev_change", id: done.id, title: done.title }]) });
  }
  return done;
}

/** The owner pressed Merge. */
export async function merge(orgId: number, id: number) {
  const ch = db.getDevChange(id, orgId);
  if (!ch) throw new TRPCError({ code: "NOT_FOUND", message: "That change is not in this workspace." });
  if (ch.status !== "ready" || !ch.prNumber) throw new TRPCError({ code: "BAD_REQUEST", message: "That change isn't ready to merge." });
  try {
    await gh(`/repos/${ch.repo}/pulls/${ch.prNumber}/merge`, { method: "PUT", body: { merge_method: "squash", commit_title: `${ch.title} (#${ch.prNumber})` } });
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err?.status === 405 || err?.status === 409 ? "GitHub won't merge it yet (a check is failing, a review is required, or it conflicts). Open it on GitHub to see why." : (err?.message ?? "GitHub didn't merge it.") });
  }
  return db.updateDevChange(id, orgId, { status: "merged" })!;
}

/** The owner asked for changes: Claude picks the branch back up from a comment on the pull request. */
export async function askForChanges(orgId: number, id: number, notes: string) {
  const ch = db.getDevChange(id, orgId);
  if (!ch) throw new TRPCError({ code: "NOT_FOUND", message: "That change is not in this workspace." });
  if (!notes.trim()) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what to change." });
  const where = ch.prNumber ?? ch.issueNumber;
  if (!where) throw new TRPCError({ code: "BAD_REQUEST", message: "That change has nothing on GitHub yet." });
  await gh(`/repos/${ch.repo}/issues/${where}/comments`, { method: "POST", body: { body: `@claude ${notes.trim()}\n\nPush the fix to this same branch and end with a short plain summary.` } });
  // Claude will comment on the pull request now, so watch it there.
  return db.updateDevChange(id, orgId, { status: "working", issueNumber: where, error: null })!;
}

/** The scheduler's minute check. */
export async function devTicks() {
  if (!ENV.githubToken) return;
  for (const ch of db.listOpenDevChanges()) {
    if (ch.status !== "working") continue;
    await check(ch).catch((err) => console.warn("[dev] check failed:", err instanceof Error ? err.message : err));
  }
}

export function view(ch: DevChange) {
  return {
    id: ch.id,
    title: ch.title,
    label: ch.label,
    repo: ch.repo,
    request: ch.request,
    status: ch.status,
    issueNumber: ch.issueNumber,
    issueUrl: ch.issueUrl,
    prNumber: ch.prNumber,
    prUrl: ch.prUrl,
    files: ch.files,
    checks: ch.checks,
    summary: parse<string[]>(ch.summary, []),
    error: ch.error,
    createdAt: ch.createdAt,
  };
}
