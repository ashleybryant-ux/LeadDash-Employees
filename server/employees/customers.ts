import { TRPCError } from "@trpc/server";
import * as db from "../db";
import { generateJson, type JsonSchema } from "../_core/llm";
import { employeeFor, systemPromptFor, working, actor } from "./tasks";
import { HUMAN_EMAIL } from "./human";

/**
 * Imani, the onboarding specialist: gets a new customer from signed to live.
 * The plan is a project Nora tracks (worked back from the go-live date, with
 * Imani owning the customer-facing steps), and the welcome email waits in
 * Approvals. Customers' own client data never goes into a plan or an email.
 */

const str = { type: "string" } as const;
const obj = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const DEFAULT_STEPS = "welcome email with the setup checklist; kickoff call (30 minutes); practice info, team, locations and services set up; client import from their old system checked; staff training (the training videos, then a live Q&A); booking page and paperwork tested; go live, with a check-in that afternoon; check-ins 1 week and 30 days after go-live";

export async function onboardCustomer(orgId: number, input: { practice: string; contact: string; email: string; goLive: string; notes: string }) {
  const practice = input.practice.trim();
  if (!practice) throw new TRPCError({ code: "BAD_REQUEST", message: "Which practice is it?" });
  const imani = await employeeFor(orgId, "onboarding");
  const answers = (() => {
    try {
      return JSON.parse(imani.onboarding || "{}") as Record<string, string | string[]>;
    } catch {
      return {} as Record<string, string | string[]>;
    }
  })();
  const steps = typeof answers.steps === "string" && answers.steps.trim() ? answers.steps : DEFAULT_STEPS;
  const { planLaunch, planCounts } = await import("./projects");
  const r = await planLaunch(orgId, {
    name: `${practice} onboarding`,
    date: input.goLive,
    brief: `Customer onboarding: getting ${practice}, a new customer, from signed to live on the go-live date.${input.contact ? ` Their contact is ${input.contact}.` : ""}
The steps, in order: ${steps}.
Milestones follow those steps, with "Go live" on the go-live date. The onboarding specialist (job key: onboarding) owns the customer-facing steps: welcome email, scheduling, training, check-ins and reminders. The owner owns calls and anything only a person can decide. Never put the customer's own client or patient data in a task.${input.notes ? `\nAlso: ${input.notes}` : ""}`,
  });
  const counts = await planCounts(orgId, r.launch.id);

  let email: { id: number; title: string } | null = null;
  if (/@/.test(input.email)) {
    email = await working(imani, async () => {
      const { system } = await systemPromptFor(
        imani,
        `Your job: write the welcome email from the owner to a new customer who just signed up.
- A short subject, then 4 to 7 short sentences: welcome them, say what happens first (the kickoff call, which the owner will confirm), point to the setup checklist, name the go-live date, and say who to reply to with questions. Sign with the owner's name from the Brain.
- Where something is the owner's to decide (a call time), use a bracketed placeholder.

${HUMAN_EMAIL}`
      );
      const out = await generateJson<{ subject: string; body: string }>({
        system,
        prompt: `Practice: ${practice}\nContact: ${input.contact || "the practice owner"} <${input.email}>\nGo-live date: ${input.goLive}\nThe steps: ${steps}`,
        schemaName: "welcome_email",
        schema: obj({ subject: str, body: str }),
      });
      const item = await db.createOutboundItem({
        organizationId: orgId,
        employeeId: imani.id,
        kind: "email_draft",
        status: "pending_approval",
        title: out.subject || `Welcome to LeadDash, ${practice}`,
        body: out.body,
        targetChannels: JSON.stringify(["Gmail"]),
        metadata: JSON.stringify({ recipient: input.contact || practice, email: input.email.trim(), whatTheyWant: `Welcome to onboarding (${practice})`, urgency: "today", newEmail: true, launchId: r.launch.id }),
      });
      await db.logAction({ organizationId: orgId, actorType: "employee", actorName: actor(imani), action: "Drafted email", details: `Welcome email to ${practice} is waiting for approval.` });
      return { id: item.id, title: item.title };
    });
  }
  return { launch: r.launch, auto: r.auto, counts, email, steps };
}

/** Who Imani is onboarding right now, for her chat. */
export async function customersFacts(orgId: number) {
  const list = (await db.listLaunches(orgId)).filter((l) => / onboarding$/i.test(l.name) && l.status !== "dropped");
  if (!list.length) return "\nCustomers being onboarded: none yet.";
  const org = await db.getOrganizationById(orgId);
  const tz = org?.timezone || "America/Chicago";
  return `\nCustomers being onboarded (Nora tracks each plan on her Projects tab):\n${list
    .slice(0, 20)
    .map((l) => `- ${l.name.replace(/ onboarding$/i, "")}: go-live ${new Date(l.launchDate).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" })}, ${l.status}`)
    .join("\n")}`;
}
