import * as db from "../db";
import type { AIEmployee, EmployeeKind, OutboundItem } from "../../drizzle/schema";
import { generateText } from "../_core/llm";
import { loadBrain } from "./brain";
import { BASE_RULES } from "./roster";

/**
 * Employees working as a team: what each one does on its own, handoffs from
 * one employee to another, the Activity feed, and asking a teammate.
 */

// ==========================================
// Works on its own
// ==========================================

export type Mode = "ask" | "first5" | "auto";
export type Rule = { key: string; label: string; default: Mode };

/** What each employee may do without asking. Anything not listed here always follows the employee's normal flow. */
export const RULES: Partial<Record<EmployeeKind, Rule[]>> = {
  prospecting: [{ key: "pass_to_outreach", label: "Passing good fits to Jada", default: "auto" }],
  outreach: [
    { key: "first_email", label: "First emails to new prospects", default: "first5" },
    { key: "follow_up", label: "Follow-up emails", default: "auto" },
    { key: "pass_replies", label: "Handing replies to Malik", default: "auto" },
  ],
  leads: [{ key: "reply", label: "Replies to new leads", default: "auto" }],
  inbox: [{ key: "new_email", label: "New emails you ask for", default: "auto" }],
  social: [{ key: "posts", label: "New posts", default: "ask" }],
  blog: [{ key: "pass_to_social", label: "Passing new articles to Sienna", default: "auto" }],
  coo: [
    { key: "invites", label: "Sending invites and agendas", default: "auto" },
    { key: "recap", label: "Sending the recap", default: "auto" },
    { key: "action_items", label: "Action items to Nora", default: "auto" },
  ],
  projects: [
    { key: "create_plan", label: "Creating a launch plan", default: "auto" },
    { key: "update_tasks", label: "Updating tasks and dates", default: "auto" },
    { key: "remind", label: "Reminding owners", default: "auto" },
    { key: "assign_work", label: "Starting employees on their tasks", default: "auto" },
    { key: "meetings", label: "Sending project meeting agendas and recaps", default: "auto" },
  ],
};

export const ALWAYS_ASKS = "Anything that signs for you, spends money, or makes an offer: grant and pitch submissions, ad budgets, job offers.";
export const FIRST_N = 5;

type Autonomy = { rules: Record<string, Mode>; approved: Record<string, number> };

export function readAutonomy(emp: Pick<AIEmployee, "autonomy">): Autonomy {
  try {
    const v = JSON.parse(emp.autonomy || "{}");
    return { rules: v.rules && typeof v.rules === "object" ? v.rules : {}, approved: v.approved && typeof v.approved === "object" ? v.approved : {} };
  } catch {
    return { rules: {}, approved: {} };
  }
}

/** The employee's rules with their current choice and how many first-5 approvals it has. */
export function autonomyView(emp: AIEmployee) {
  const a = readAutonomy(emp);
  return (RULES[emp.kind] ?? []).map((r) => ({ key: r.key, label: r.label, mode: (a.rules[r.key] ?? r.default) as Mode, approved: Math.min(FIRST_N, a.approved[r.key] ?? 0) }));
}

export async function saveAutonomy(emp: AIEmployee, rules: Record<string, Mode>) {
  const a = readAutonomy(emp);
  for (const r of RULES[emp.kind] ?? []) {
    const m = rules[r.key];
    if (m === "ask" || m === "first5" || m === "auto") a.rules[r.key] = m;
  }
  await db.updateEmployee(emp.id, emp.organizationId, { autonomy: JSON.stringify(a) });
  return db.getEmployeeForOrg(emp.id, emp.organizationId);
}

/** "auto" when the employee may do this now without asking, "ask" otherwise. */
export function gate(emp: AIEmployee, key: string): "auto" | "ask" {
  const rule = (RULES[emp.kind] ?? []).find((r) => r.key === key);
  if (!rule) return "ask";
  const a = readAutonomy(emp);
  const mode = a.rules[key] ?? rule.default;
  if (mode === "auto") return "auto";
  if (mode === "first5") return (a.approved[key] ?? 0) >= FIRST_N ? "auto" : "ask";
  return "ask";
}

/** Counts an approval toward "Ask for the first 5, then on its own". */
export async function noteApproval(item: OutboundItem) {
  let meta: Record<string, any> = {};
  try {
    meta = JSON.parse(item.metadata || "{}");
  } catch {
    meta = {};
  }
  if (!meta.rule || !item.employeeId) return;
  const emp = await db.getEmployeeForOrg(item.employeeId, item.organizationId);
  if (!emp) return;
  const a = readAutonomy(emp);
  a.approved[meta.rule] = (a.approved[meta.rule] ?? 0) + 1;
  await db.updateEmployee(emp.id, emp.organizationId, { autonomy: JSON.stringify(a) });
}

// ==========================================
// Handoffs and Activity
// ==========================================

export const workLink = (kind: string) => `/chats/${kind}/work`;

export async function logActivity(emp: AIEmployee | null, kind: "sent" | "done", text: string, link?: string | null, orgId?: number) {
  const organizationId = emp?.organizationId ?? orgId!;
  return db.addActivity({ organizationId, employeeId: emp?.id ?? null, kind, text: text.slice(0, 500), link: link ?? (emp ? workLink(emp.kind) : null) });
}

/** One employee passes work to another: an Activity line and a handoff line in the receiving employee's chat. */
export async function handoff(orgId: number, fromKind: EmployeeKind, toKind: EmployeeKind, text: string, link?: string) {
  const from = await db.getEmployeeByKind(orgId, fromKind);
  const to = await db.getEmployeeByKind(orgId, toKind);
  if (!from || !to) return null;
  await db.addActivity({ organizationId: orgId, employeeId: from.id, toEmployeeId: to.id, kind: "handoff", text: text.slice(0, 500), link: link ?? workLink(to.kind) });
  // The handoff lands in the conversation the work came from: whoever was last talking with the sender.
  await db.createChatMessage({ organizationId: orgId, employeeId: to.id, role: "handoff", authorName: from.name, threadUserId: db.lastThreadUserId(orgId, from.id), content: text.slice(0, 1000) });
  return { from, to };
}

// ==========================================
// Asking a teammate
// ==========================================

/** Finds a teammate by name ("Theo") or job ("blog", "the social media person"). */
export async function findTeammate(orgId: number, ask: string) {
  const list = await db.listEmployeesByOrg(orgId);
  const t = ask.trim().toLowerCase();
  if (!t) return null;
  return (
    list.find((e) => e.name.toLowerCase() === t) ??
    list.find((e) => t.includes(e.name.toLowerCase())) ??
    list.find((e) => t.includes(e.kind) || t.includes(e.roleTitle.toLowerCase())) ??
    null
  );
}

/** What a teammate has been doing, as plain facts, so another employee can answer for them. */
export async function teamFacts(emp: AIEmployee) {
  const { factsFor } = await import("./onboarding");
  return factsFor(emp);
}

export async function askTeammate(asker: AIEmployee, who: string, question: string) {
  const mate = await findTeammate(asker.organizationId, who);
  if (!mate) return `I couldn't tell which teammate you mean. Ask by name, like Theo or Malik.`;
  if (mate.id === asker.id) return null;
  const brain = await loadBrain(asker.organizationId);
  const facts = await teamFacts(mate);
  const text = await generateText({
    system: `You are ${asker.name}, the ${asker.roleTitle} employee for ${brain.org?.name ?? "the workspace"}. The owner asked you to check with ${mate.name} (${mate.roleTitle}). Answer from ${mate.name}'s facts below and nothing else, in 1 to 4 short sentences, naming ${mate.name}. Write dates with the year. If the facts do not answer it, say what ${mate.name} has done instead and that the owner can ask ${mate.name} directly. Never include a client's name.\n\n${BASE_RULES}`,
    prompt: `Question: ${question}\n\n${mate.name}'s facts:\n${facts}`,
    maxTokens: 500,
  });
  return text.trim();
}
