/**
 * Briefs the LeadDash sales team (Riley, Jada, Malik) on everything Ashley has
 * decided about selling LeadDash: plans and prices, founding member rules,
 * what is included and what is metered, how to answer the hard questions,
 * competitors, who buys, and how a sale runs. Only touches the workspace
 * named "LeadDash".
 *
 *   cd /home/ssm-user/employees && npx tsx scripts/brief-sales.ts
 *
 * Safe to run again: Brain entries you edited are kept, answers you changed
 * yourself are kept, and guideline lines are never added twice.
 */
import "dotenv/config";
import * as db from "../server/db";
import type { AIEmployee, EmployeeKind } from "../drizzle/schema";
import { readAnswers, readGuidelines, refreshGuidelines } from "../server/employees/interview";
import { indexKnowledge } from "../server/employees/kb";

type A = Record<string, string | string[]>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

// ---------- Brain entries for the whole workspace ----------

const ENTRIES: { title: string; category: string; content: string }[] = [
  {
    category: "financial_data",
    title: "Plans and pricing",
    content: `Every plan is month to month with no contract. Seat counts are hard caps: a practice that needs more users moves to the next plan.

- Core, $99 a month, 1 user: the HIPAA-compliant EHR (SOAP, DAP, BIRP and GIRP notes, scheduling, client records, treatment plans) plus the CRM and lead pipeline. No 24/7 receptionist, websites or marketing automation.
- Complete, $299 a month, up to 5 users: everything in Core plus the 24/7 receptionist answering and booking calls, a practice phone line with call tracking and missed-call text back, email and text automation, the website and funnel builder with web chat, review generation, team scheduling and role permissions, and LeadDash University with the weekly live Q&A.
- Practice, $797 a month, up to 10 users: everything in Complete plus staff calendar management across the team, advanced reporting on caseload, referrals and conversion, and priority support.
- Agency (11 to 40 clinicians) and Enterprise (40 or more, or several sites): custom pricing, set on a call.
- Done-For-You setup, $1,500 one time on any plan: a 10-day build of the receptionist, phone and email, workflows, booking and intake calendars, pipeline, and a team training call.
- Insurance billing and eFax are included on every plan.
- AI note-taking (DashNotes™) is $40 per clinician per month for practices that joined after the founding period.
- Ashley is considering raising Core to $129 now that billing and fax are included. [CONFIRM before quoting Core.]
- [CONFIRM whether the founding member offer closed on September 30, 2026 or was extended, and what a new practice pays today.]

Prices are for Ashley or the demo call to share. Employees never quote a price, discount or trial in writing.`,
  },
  {
    category: "financial_data",
    title: "Founding members",
    content: `- LeadDash had 5 founding members as of June 2026.
- The rule, in Ashley's words: everything LeadDash ships before September 30, 2026 is theirs at no additional charge for as long as they stay subscribed; anything shipped after that is priced separately; and their base rate never goes up while the subscription stays active.
- That includes insurance billing and AI note-taking at no charge.
- Not covered for founding members: eligibility-check packs past the monthly allowance, and fax page packs.
- Never name a current member practice to a prospect without Ashley's permission.`,
  },
  {
    category: "financial_data",
    title: "What is included and what is metered",
    content: `- Insurance eligibility checks: 1,000 per practice per month included. Past that, the practice is paused until an administrator buys a pack: 250 checks for $99, 500 for $179, 1,000 for $299. Packs are for the calendar month and do not roll over.
- eFax: each practice gets its own fax number when an administrator turns fax on, and can port an existing fax number in free. 100 outbound pages a month included; packs are 100 pages for $15 or 250 for $29. Incoming faxes are never capped.
- Texting: up to 4,000 texts a month per practice. Reminder texts say they are no-reply.
- Texts, calls, phone numbers and email are billed by usage. Practices buy their phone number inside LeadDash; bringing an outside phone number is not offered.
- Never state LeadDash's markup or cost to a prospect.`,
  },
  {
    category: "mission_profile",
    title: "Hard questions and true answers",
    content: `- Free trial? No. Prospects try the sandbox demo at demo.leaddash.io, then book a live walkthrough.
- E-prescribing? It is coming in the next phase of development; no date is quoted. Prescribers keep their current e-prescribing tool meanwhile. LeadDash does not build connections to outside e-prescribing systems.
- Switching from SimplePractice, TherapyNotes, Valant or another EHR? LeadDash moves clients, assigned clinicians, notes (unsigned notes come in as open drafts), visit history and each client's opening balance. Past appointments never trigger reminders.
- Insurance billing? Claim submission, electronic remittance (ERA), automatic payment posting, self-serve payer enrollment, secondary claims and eligibility checks are built in. The practice's own biller still works rejections and payer questions.
- Telehealth? Built into LeadDash, with a room per clinician and a client portal. Zoom and Google Meet are not used.
- Fax? Built in. Neither SimplePractice nor TherapyNotes has native fax.
- Interns and supervision? Co-signature is built in: a supervised clinician's note waits for the supervisor to approve or return it.
- Groups? Group sessions with one note per attendee are built in.
- Mobile? LeadDash installs on a phone as an app from the browser.
- HIPAA? Yes. Every practice signs a Business Associate Agreement, which is part of the LeadDash Subscription and Services Agreement.
- Contract? Month to month. The plan chosen at checkout is the order.
- Custom builds? No. Requests that would help every practice go on the roadmap.
- The receptionist is the "24/7 receptionist," never the "AI receptionist," and each practice names its own.
- Never name GoHighLevel or the claims clearinghouse. Everything is LeadDash.`,
  },
  {
    category: "mission_profile",
    title: "Competitors",
    content: `- Common current systems: SimplePractice, TherapyNotes, Jane, TheraNest, Valant.
- They charge per clinician, so the bill grows with every hire; AI scribe add-ons elsewhere commonly run $35 to $40 per clinician per month on top of the plan.
- None of them include the CRM, marketing automation, websites, 24/7 receptionist and phone system; practices pay for those separately.
- Neither SimplePractice nor TherapyNotes ships native fax.
- The pitch is "one bill replaces the subscriptions": EHR, billing, fax, phone, texting, telehealth and marketing.
- Never criticize a competitor. Compare what the practice pays now to one LeadDash bill.`,
  },
  {
    category: "mission_profile",
    title: "Who buys LeadDash",
    content: `- Best fit: group mental health practices with 4 or more clinicians that take insurance and run separate tools for notes, billing and marketing. Per-clinician pricing hurts them most.
- Good fit: practices with 2 or 3 clinicians that are hiring, and solo clinicians on Core.
- Prescribing practices that need e-prescribing or labs today: LeadDash can be their front office, phone and marketing alongside their current EHR until e-prescribing ships. Be honest about the gap.
- The marketing side (CRM, receptionist, websites, automation) also sells outside therapy, such as associations and conferences; keep that copy industry-neutral.
- January is switching season (new insurance year), so practices decide in the fourth quarter.`,
  },
  {
    category: "mission_profile",
    title: "How a LeadDash sale runs",
    content: `- Lists come from state licensing board public records (LPC, LCSW, LMFT and psychology boards in every state), Psychology Today group practices, LinkedIn and Google Maps. Cold email is the main channel; LinkedIn is a precision add-on.
- Demo sign-ups at demo.leaddash.io land in the LeadDash platform sub-account named "LeadDash" with the tag "received demo." Each one gets a follow-up.
- The sale is two calls: a practice audit (what systems they use, what breaks, what costs the most time) and then the walkthrough (demo, migration plan, pricing, close or set a decision date).
- Discovery comes first. The demo follows the practice's own problem: one lead's path from missed call to booked and paid session, not a feature tour.
- Price is anchored against what the practice pays now for its EHR, billing, phone, fax, texting, telehealth and marketing.
- Every call ends with a booked next step. The recap email goes out within 2 hours.
- Lead magnets: the CE series "Ethics in the Age of AI" and the webinar "Using AI in Clinical Work Without Risking Your License."
- Ashley's name stays out of outreach templates and booking details: "your LeadDash demo," because she won't run every demo.`,
  },
];

/** Entries the first LeadDash preload wrote; replaced only if nobody has edited them since. */
const PRELOADED: Record<string, string> = {
  "Plans and pricing": `- Plans: Core, Complete, Practice and Agency. Core is $99 a month (a move to $129 is under consideration). Each plan has a set number of clinician seats.
- Insurance billing and fax are included on every plan.
- Insurance eligibility checks: 1,000 per practice per month included; packs of 250 for $99, 500 for $179 and 1,000 for $299.
- Fax: 100 outbound pages per practice per month included; packs of 100 pages for $15 and 250 for $29. Incoming faxes are never capped.
- Texting: up to 4,000 texts a month per practice.
- Communications usage (texts, calls, phone numbers, email) is billed at 1.5 times the underlying carrier rates.
- Founding members keep a locked rate with insurance billing and AI notes included.
- No free trials. Prospects use a sandbox demo at demo.leaddash.io.`,
};

// ---------- Interview answers (updated only where they still hold the old onboarding value) ----------

const UPDATES: Partial<Record<EmployeeKind, Record<string, { was: string | string[]; now: string | string[] }>>> = {
  prospecting: {
    ideal: {
      was: "Group mental health practices that take insurance, use separate tools for notes, billing and marketing, and are hiring clinicians",
      now: "Group mental health practices with 4 or more clinicians that take insurance, use separate tools for notes, billing and marketing, and are hiring clinicians; also growing practices of 2 or 3. Prescribing practices that need e-prescribing today are a weaker fit",
    },
    competitors: { was: "SimplePractice, TherapyNotes, Jane, TheraNest", now: "SimplePractice, TherapyNotes, Jane, TheraNest, Valant" },
  },
  outreach: {
    proof: {
      was: "Built by a licensed therapist who runs her own group practice on it; EHR, insurance billing, fax, phone, texting, telehealth and marketing on one platform and one bill",
      now: "Built by a licensed therapist who runs her own group practice on it; EHR, insurance billing, fax, phone, texting, telehealth and marketing on one platform and one bill; no per-clinician pricing; month to month with no contract; native fax, which SimplePractice and TherapyNotes don't have",
    },
    objections: {
      was: "\"We already have an EHR\": LeadDash replaces it and the separate billing, fax, phone and marketing tools, and we help move your records. \"It costs more\": compare one bill to the subscriptions it replaces. \"No time to switch\": setup is guided step by step in LeadDash University.",
      now: "\"We already have an EHR\": LeadDash replaces it and the separate billing, fax, phone and marketing tools, and we move your clients, notes and balances. \"It costs more\": add up what you pay now for the EHR per clinician, billing, phone, fax, texting and marketing, and compare it to one bill. \"No time to switch\": setup is guided step by step in LeadDash University, and Done-For-You setup builds it for you. \"Can we try it?\": the sandbox at demo.leaddash.io, then a live walkthrough. \"We need e-prescribing\": it is in the next phase with no date yet; keep your current tool meanwhile. \"Is it HIPAA compliant?\": yes, with a signed BAA. \"What if it doesn't work?\": month to month, no contract. \"We've never heard of you\": built by a therapist who runs her own group practice on it.",
    },
  },
  leads: {
    services: {
      was: "LeadDash EHR (notes, DashNotes™, treatment plans, client portal, telehealth), insurance billing, eFax, phone and texting, marketing automation and the 24/7 receptionist",
      now: "LeadDash EHR (notes, DashNotes™, treatment plans, supervision and co-signature, group sessions, client portal, built-in telehealth, phone app), insurance billing (claims, remittances, payment posting, secondary claims, eligibility checks), eFax with your own number, phone and texting, marketing automation, websites, reviews and the 24/7 receptionist",
    },
    faqs: {
      was: "Free trial? No; try the sandbox demo at demo.leaddash.io. Can we move from SimplePractice or TherapyNotes? Yes, we help move your clients and records. HIPAA? Yes, and every practice gets a Business Associate Agreement. Insurance billing? Yes: claims, remittances and payment posting are built in.",
      now: "Free trial? No; try the sandbox demo at demo.leaddash.io, then book a walkthrough. Can we move from SimplePractice, TherapyNotes or Valant? Yes: clients, notes, visit history and balances. HIPAA? Yes, and every practice signs a Business Associate Agreement. Insurance billing? Included on every plan: claims, remittances, payment posting, secondary claims and eligibility checks. E-prescribing? Coming in the next phase, no date yet; keep your current tool meanwhile. Fax? Built in, with your own number, and you can port your current fax number free. Telehealth? Built in; no Zoom needed. Contract? Month to month. Interns? Supervisor co-signature is built in. Phone app? Yes, it installs from the browser.",
    },
    never: {
      was: "Prices, discounts, free trials, custom builds, or dates for features not built yet (like e-prescribing)",
      now: "Prices, discounts, free trials, custom builds, dates for features not built yet (like e-prescribing), LeadDash's costs or markups, or the name of any current member practice",
    },
  },
};

// ---------- Guideline lines, added once ----------

const LINES: Partial<Record<EmployeeKind, Record<string, string[]>>> = {
  prospecting: {
    fit: ["Best fit is 4 or more clinicians: per-clinician pricing hurts them most. January is switching season, so fourth-quarter outreach matters most."],
    skip: ["Skip current LeadDash members and anyone who asked not to be contacted."],
  },
  outreach: {
    proof: ["Pitch \"one bill replaces the subscriptions\" (EHR, billing, fax, phone, texting, telehealth, marketing), never a feature list."],
    rules: [
      "Never quote a price, discount or trial in an email; offer the demo instead.",
      "Never name a current member practice without Ashley's permission, and never criticize a competitor.",
    ],
  },
  leads: {
    faqs: ["Every inquiry gets the sandbox link (demo.leaddash.io) and a booked walkthrough; every walkthrough ends with a booked next step."],
    rules: ["Never quote prices, LeadDash's costs or markups, or a date for e-prescribing."],
  },
};

async function main() {
  const orgs = await db.listOrganizations();
  const org = orgs.find((o) => o.name.trim().toLowerCase() === "leaddash") ?? orgs.find((o) => o.name.trim().toLowerCase().startsWith("leaddash"));
  if (!org) {
    console.log('No workspace named "LeadDash". Create it in the app, then run this again.');
    process.exit(1);
  }
  const at = new Date().toISOString();

  const brain = await db.listKnowledgeByOrg(org.id);
  let added = 0;
  let replaced = 0;
  for (const e of ENTRIES) {
    const cur = brain.find((k) => k.title.trim().toLowerCase() === e.title.toLowerCase());
    if (cur) {
      const before = PRELOADED[e.title];
      if (before && cur.content.trim() === before.trim()) {
        const saved = await db.updateKnowledgeItem(cur.id, org.id, { content: e.content, category: e.category as never });
        if (saved) indexKnowledge(saved);
        replaced++;
      }
      continue;
    }
    const saved = await db.createKnowledgeItem({ organizationId: org.id, title: e.title, category: e.category as never, kind: "fact", content: e.content });
    if (saved) indexKnowledge(saved);
    added++;
  }
  console.log(`Workspace: ${org.name} (#${org.id})`);
  console.log(`Brain entries: ${added} added, ${replaced} replaced with a fuller version, ${ENTRIES.length - added - replaced} already current or edited by you`);

  for (const kind of ["prospecting", "outreach", "leads"] as EmployeeKind[]) {
    const emp = await db.getEmployeeByKind(org.id, kind);
    if (!emp) continue;
    const answers: A = { ...readAnswers(emp) };
    let changed = 0;
    let kept = 0;
    for (const [k, u] of Object.entries(UPDATES[kind] ?? {})) {
      const cur = answers[k];
      if (same(cur, u.now)) continue;
      const blank = Array.isArray(cur) ? !cur.length : !String(cur ?? "").trim();
      if (blank || same(cur, u.was)) {
        answers[k] = u.now;
        changed++;
      } else kept++;
    }
    let next = (await db.updateEmployee(emp.id, org.id, { onboarding: JSON.stringify(answers) }))!;
    next = await refreshGuidelines(next);
    const g = readGuidelines(next);
    let lines = 0;
    for (const [section, list] of Object.entries(LINES[kind] ?? {})) {
      if (!g.sections[section]) continue;
      for (const text of list) {
        if (g.sections[section].some((i) => i.text === text)) continue;
        g.sections[section].push({ id: `sales-${section}-${g.sections[section].length}-${Date.now() % 100000}`, text, source: "you", at });
        lines++;
      }
    }
    next = (await db.updateEmployee(emp.id, org.id, { guidelines: JSON.stringify(g) }))!;
    const { writeDayToDay } = await import("../server/employees/onboarding");
    await writeDayToDay(next as AIEmployee).catch(() => null);
    console.log(`${emp.name} (${emp.roleTitle}): ${changed} answers updated${kept ? `, ${kept} kept because you changed them` : ""}, ${lines} guideline lines added`);
  }
  console.log("\nDone. The sales team reads the new Brain entries on their next task.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
