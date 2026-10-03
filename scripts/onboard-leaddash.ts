/**
 * Onboards all 13 employees in Ashley's own LeadDash workspace from what is
 * already known about LeadDash: interview answers, voice samples and examples,
 * Guidelines, and what each employee does on its own. New tenants never get
 * this; it only touches the workspace named "LeadDash".
 *
 *   cd /home/ssm-user/employees && node scripts/preload-leaddash.mjs && npx tsx scripts/onboard-leaddash.ts
 *
 * Safe to run twice: answers already given are kept, Brain facts already set
 * are kept, and guideline lines already there are not added again.
 */
import "dotenv/config";
import * as db from "../server/db";
import type { AIEmployee, EmployeeKind } from "../drizzle/schema";
import { INTERVIEWS, allQuestions } from "../server/employees/interview-defs";
import { readAnswers, readGuidelines, readState, refreshGuidelines, type Example } from "../server/employees/interview";
import { saveAutonomy, type Mode } from "../server/employees/team";

type A = Record<string, string | string[]>;

// ---------- Voice: how Ashley sounds ----------

const SAMPLES = (kind: EmployeeKind) => {
  const s: Record<string, { label: string; text: string }[]> = {
    social: [
      { label: "Direct and specific", text: "Two systems. Zero communication between them. And my admin bridging the gap by hand, every single day. That's the problem LeadDash was built to end." },
      { label: "Warm and personal", text: "If your evenings go to paperwork instead of your people, you're not doing it wrong. Your tools just don't talk to each other." },
      { label: "Playful", text: "Your EHR and your marketing walk into a bar. Neither one knows the other exists. Your admin pays the tab." },
    ],
    blog: [
      { label: "Direct and specific", text: "Most practices run on four to eight separate tools: notes, billing, fax, phone, texting, telehealth and marketing. Every handoff between them is work someone on your team does by hand." },
      { label: "Warm and personal", text: "When I started my group practice, I thought the hard part would be the clinical work. It was the double entry." },
      { label: "Academic", text: "Administrative burden is one of the most cited drivers of clinician burnout, and much of it comes from systems that do not share data." },
    ],
    outreach: [
      { label: "Direct and specific", text: "I saw your practice books new clients by phone and is hiring two clinicians. Practices your size usually lose a few inquiries a week to voicemail." },
      { label: "Warm and personal", text: "Congratulations on growing to nine clinicians. That stage is exciting and usually where the admin starts to pile up." },
      { label: "Formal", text: "I am writing to introduce LeadDash, a platform for mental health practices." },
    ],
    leads: [
      { label: "Direct and specific", text: "Thanks for reaching out. A January move gives you plenty of room. Here are three times for a 30-minute walkthrough of intake and billing." },
      { label: "Warm and personal", text: "So glad you found us. Switching systems is a big decision, and a short walkthrough is the easiest way to see if LeadDash fits." },
      { label: "Formal", text: "Thank you for your inquiry. A member of our team will contact you to schedule a demonstration." },
    ],
    inbox: [
      { label: "Direct and specific", text: "Here's what I found so far: the claim went out on Sept 28 and is waiting on the payer. I'll follow up Friday." },
      { label: "Warm and personal", text: "Thank you for checking in. Here's where things stand." },
      { label: "Formal", text: "Thank you for your email. Please find the requested information below." },
    ],
    website: [
      { label: "Direct and specific", text: "Fill your calendar. Run your practice. One platform." },
      { label: "Warm and personal", text: "Built by a therapist who got tired of her EHR and her marketing living in two different worlds." },
      { label: "Expert", text: "EHR, insurance billing, fax, phone, telehealth and marketing for mental health practices, on one bill." },
    ],
    video: [
      { label: "Direct and specific", text: "I run a group practice and I built my own EHR. Here's the one feature I'd never give up." },
      { label: "Story", text: "Three years ago my admin spent every Friday typing the same client into two systems. This is what she does now." },
      { label: "Trend", text: "Things therapists say at 9 PM that mean they need a new EHR." },
    ],
    speaking: [
      { label: "Direct and specific", text: "I'm a licensed therapist who built the platform I needed to run my own group practice. I'd like to show your members how to stop choosing between clinical tools and growth." },
      { label: "Warm and personal", text: "Your members became clinicians to help people, not to fight their software. I'd love to talk with them about that." },
      { label: "Formal", text: "I am writing to submit a proposal for your upcoming conference." },
    ],
  };
  return s[kind] ?? s.social;
};

const LIKED: Example[] = [
  { liked: true, text: "I'm a licensed therapist who got tired of my EHR and my marketing living in two different worlds, so I built one that does both. Now I help other therapists grow their practices without choosing between great clinical tools and great marketing." },
  { liked: true, text: "Two systems. Zero communication between them. And my admin bridging the gap by hand, every single day." },
  { liked: false, text: "Revolutionize your practice with our cutting-edge, AI-powered all-in-one solution! Unlock seamless growth today. 🚀" },
];

const VOICE_COMMON: A = {
  samples: "Direct and specific",
  reading: "Educated adult",
  wordsUse: "practice owners, clinicians, the LeadDash platform, LeadDash EHR, 24/7 receptionist, DashNotes™",
  wordsAvoid: "AI receptionist, GoHighLevel, revolutionize, game-changer, cutting-edge, seamless, unlock, journey, empower",
};
const EXAMPLES_COMMON: A = { dislikeWhy: ["Too salesy", "Not specific"], soundLike: "Ashley's own founder story: plain, specific, analytical, never hype" };
const WORKING: A = {
  report: "A weekly summary",
  reach: "Push notification",
  know: "Ashley runs LeadDash and her own group practice, Legacy Family Services. Never mention Legacy's clients. In messages to member practices, credit product work to the development team.",
};

// ---------- Interview answers for each employee ----------

const ANSWERS: Record<EmployeeKind, A> = {
  coo: {
    goal: ["Running meetings", "Agendas", "Notes and action items", "The weekly scorecard", "Keeping teams on track"],
    success90: "Every meeting has an agenda the day before and notes with action items the same day, and the scorecard reads in two minutes.",
    first: "Set up the weekly leadership meeting and the scorecard.",
    meetings: "A weekly leadership meeting with Caroline, and demo calls with practices as they are booked.",
    deciders: "Ashley makes the final call.",
    style: "Short: decisions first",
    always: "Anything late on a launch, demos booked this week, open member-practice issues",
    team: "Ashley: product, sales and the company. Caroline: content, community and day-to-day contact for member practices.",
    updatesFrom: "Nora on launches; Jada and Malik on sales; Sienna and Theo on content; Morgan on grants",
    numbers: "Demos booked, practices contacted, new practices signed, posts and articles published, grant applications sent",
    offTrack: "Put it first on the next agenda",
    recapTo: "Only me",
    keepOff: "Pay and contractor rates, anything about Legacy Family Services clients, any member practice's client information",
    ...WORKING,
  },
  projects: {
    goal: ["Product launches", "Webinars", "Campaigns", "New services"],
    horizon: "1 month",
    success90: "Every launch has a plan in ClickUp, owners know what's due, and I hear about anything late before it's late.",
    first: "Plan the next LeadDash launch or webinar once I give you the date.",
    owners: "Ashley: product, approvals and demos. Caroline: content and community. Sienna, Theo, Jordan and Elena: marketing pieces. Jada and Malik: outreach and demos.",
    approver: "Ashley",
    buffer: "2 days",
    how: "Small tasks, one owner each, every task tied to a milestone",
    noDue: ["Weekends"],
    done: "Live or sent, not just drafted, and approved by Ashley when it is customer-facing",
    kpis: "Demos booked, practices signed, webinar sign-ups",
    reportStyle: "Short: on track or not",
    ...WORKING,
  },
  grants: {
    goal: ["Grants", "Pitch competitions", "Accelerators"],
    success90: "At least 3 strong applications submitted or ready to sign, each with real numbers and no placeholders left",
    first: "Find grants and pitch competitions with deadlines in the next 60 days",
    often: "Weekly",
    status: "LLC or for-profit",
    staff: "Founder plus a full-time content and community manager; serves practices nationwide from Oklahoma City",
    programs: "LeadDash EHR, insurance billing, marketing automation and the 24/7 receptionist for mental health private practices; AI note taking (DashNotes™); intern supervision tools that help practices grow the clinician workforce",
    awards: "Applied to the Amber Grant and HHS SBIR Phase I",
    minAward: "$10,000",
    region: "My state first, then national",
    priorities: "Product development (e-prescribing, AI note taking), growth and hiring for LeadDash, behavioral health workforce, women- and Black-owned business programs",
    autoStart: "Start the application",
    signer: "Ashley R. Bryant, PhD, LPC, CRC, Founder and CEO, LeadDash Marketing LLC",
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  speaking: {
    goal: ["Conferences", "Webinars", "Podcasts", "Panels"],
    success90: "Two or more speaking slots booked, at least one of them paid",
    first: "Find calls for proposals at counseling and practice-owner conferences in the next 6 months",
    topics: "Building a practice that pays you back; moving from agency work to private practice; intern supervision as a hiring pipeline; Ethics in the Age of AI; the P.U.L.S.E.™ Framework",
    abstracts: "Practice owners leave with a plan to cut admin time; clinicians leave knowing what to check before using AI in sessions",
    bioShort: "Ashley R. Bryant, PhD, LPC, CRC, is a licensed therapist with 18 years in practice and the founder of LeadDash, the growth platform for private practice. She owns Legacy Family Services in Oklahoma City and has spoken at more than 100 events.",
    credentials: "PhD, LPC, CRC",
    pastEvents: "More than 100 talks; proposals to NASW and the Colorado Counseling Association; featured on TLC, PBS and FOX",
    paid: "Paid or visibility",
    travel: "Anywhere in the US",
    want: "Counselors, therapists, social workers, group practice owners, counseling programs and associations, behavioral health technology audiences",
    avoidAud: "Events that require naming Cornell or Therapy In Color",
    often: "Weekly",
    formality: "Professional",
    ...VOICE_COMMON,
    ...WORKING,
  },
  prospecting: {
    goal: ["Customers"],
    success90: "25 strong-fit practices a week, most with an owner name and a direct email",
    first: "Group practices in Oklahoma and Texas that are hiring clinicians",
    often: "Twice a week",
    weekly: "25",
    size: "2 or more clinicians",
    specialty: ["Mental health", "Substance use"],
    payer: "Either",
    states: "Oklahoma and Texas first, then nationwide",
    ideal: "Group mental health practices that take insurance, use separate tools for notes, billing and marketing, and are hiring clinicians",
    signals: ["Hiring clinicians", "Books by phone only", "No online paperwork", "Opening a new location"],
    decider: ["Owner", "Practice manager"],
    skip: "Hospital systems, national chains, practices already on LeadDash",
    competitors: "SimplePractice, TherapyNotes, Jane, TheraNest",
    ...WORKING,
  },
  outreach: {
    goal: ["Demos"],
    success90: "Demos booked every week from outreach, with no complaints or unsubscribes piling up",
    first: "Start sequences for Riley's best fits",
    offer: "A 20-minute demo",
    cta: "Pick a time for a 20-minute demo, or try the sandbox at demo.leaddash.io",
    proof: "Built by a licensed therapist who runs her own group practice on it; EHR, insurance billing, fax, phone, texting, telehealth and marketing on one platform and one bill",
    objections: "\"We already have an EHR\": LeadDash replaces it and the separate billing, fax, phone and marketing tools, and we help move your records. \"It costs more\": compare one bill to the subscriptions it replaces. \"No time to switch\": setup is guided step by step in LeadDash University.",
    tone: "Brief and direct",
    formality: "Conversational",
    signOff: "The LeadDash team",
    address: "LeadDash, 11901 N. MacArthur Blvd, Suite C6, Oklahoma City, OK 73162",
    ...VOICE_COMMON,
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  leads: {
    goal: ["Book meetings", "Answer questions", "Hand hot leads to me"],
    success90: "Every demo request answered within minutes and booked",
    first: "Answer demo sign-ups from demo.leaddash.io",
    services: "LeadDash EHR (notes, DashNotes™, treatment plans, client portal, telehealth), insurance billing, eFax, phone and texting, marketing automation and the 24/7 receptionist",
    prices: "Never share prices",
    faqs: "Free trial? No; try the sandbox demo at demo.leaddash.io. Can we move from SimplePractice or TherapyNotes? Yes, we help move your clients and records. HIPAA? Yes, and every practice gets a Business Associate Agreement. Insurance billing? Yes: claims, remittances and payment posting are built in.",
    qualifies: "Mental health practices, solo or group, and practice managers looking to switch systems or add marketing",
    notFit: "People looking for therapy: point them to their own provider, or 988 in a crisis. Vendors and job seekers: thank them and stop.",
    handoff: ["Billing questions", "Complaints", "Anything urgent"],
    hours: "8 AM to 8 PM",
    tone: "Warm",
    formality: "Conversational",
    never: "Prices, discounts, free trials, custom builds, or dates for features not built yet (like e-prescribing)",
    ...VOICE_COMMON,
    ...WORKING,
  },
  social: {
    goal: ["Bring in clients", "Build my name"],
    success90: "3 posts a week going out on time, sounding like me, with practice owners commenting and booking demos",
    first: "LinkedIn and Instagram posts on the problems LeadDash solves",
    formality: "Conversational",
    emoji: "None",
    hashtags: "2 or 3 at the end",
    platforms: ["LinkedIn", "Instagram", "Facebook", "Threads"],
    audience: "Therapists and group practice owners deciding how to run and grow their practice",
    often: "3 a week",
    pillars: "Running a private practice without the admin pile-up; what's new in LeadDash; insurance billing and intake made simple; the founder's story as a therapist who built her own platform; hiring and supervising clinicians",
    imageStyle: "Photos for people, illustrations for ideas",
    imageNotes: "Forest green #0d3b2e with orange #e88a3a for accents only; real-looking people, no stock handshakes; the wordmark never sits on brand green",
    avoid: "Client stories or details, Legacy Family Services clients, competitor bashing, prices that may change, GoHighLevel",
    composites: "Yes, labeled as made up",
    ...VOICE_COMMON,
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  blog: {
    goal: ["Rank on Google", "Teach other clinicians"],
    success90: "Two articles a month that rank for practice-software searches and send readers to the demo",
    first: "An article comparing one platform with separate tools for notes, billing and marketing",
    reader: "Practice owners",
    questions: "How to switch EHRs, how insurance billing works for small practices, how to get more clients, how to hire and supervise clinicians",
    topics: "Running a group practice, insurance billing, intake and paperwork, telehealth, hiring and supervision, ethics of AI in practice",
    keywords: "EHR for therapists, therapy practice software, insurance billing for therapists, group practice management",
    length: "1,200 words",
    often: "Twice a month",
    citations: "Cite a source for every fact",
    cta: "See it in the sandbox demo at demo.leaddash.io",
    author: "Ashley R. Bryant, LPC, CRC, founder of LeadDash and owner of a group practice in Oklahoma City",
    formality: "Conversational",
    ...VOICE_COMMON,
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  website: {
    goal: ["Book consultations", "Build trust"],
    success90: "A site that turns visitors into demo bookings",
    first: "The home page and the pricing page",
    visitors: "Therapists and group practice owners comparing EHRs and marketing tools",
    pages: "Home, pricing, insurance billing, DashNotes™, telehealth, about the founder",
    cta: "Book a demo",
    diff: "One platform and one bill in place of separate EHR, billing, fax, phone, texting, telehealth and marketing tools; built by a practicing therapist who runs her own group practice on it",
    proof: "18 years in practice; her own group practice runs on LeadDash; federally registered trademark; featured on TLC, PBS and FOX",
    voice: "Expert and direct",
    formality: "Professional",
    ...VOICE_COMMON,
    ...WORKING,
  },
  video: {
    goal: ["Build my name", "Teach"],
    success90: "Two videos a week I can film in under 15 minutes each",
    first: "Short videos on the founder story and one feature at a time",
    platforms: ["TikTok", "Instagram Reels", "YouTube Shorts"],
    length: "30 to 60 seconds",
    often: "2",
    captions: "Captions on every video",
    onCamera: "Me",
    avoid: "Clients, client records, anything with a client's name on screen, the Legacy waiting room",
    style: "Mix",
    formality: "Conversational",
    ...VOICE_COMMON,
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  inbox: {
    goal: ["Drafting replies", "Sorting what's urgent", "Scheduling meetings", "Follow-ups"],
    success90: "My inbox sorted every day, with replies drafted for anything that needs me",
    first: "Draft replies to member practices and prospects",
    who: "Member practices, prospects, vendors, partners such as NABC, speaking contacts and press",
    urgent: "A member practice that can't get in or can't bill, payers, my attorney, press with a deadline",
    archive: "Newsletters, cold sales emails, tool marketing",
    replyTo: "Member practices, prospects, partners and speaking contacts",
    noReply: "Cold sales emails from people I've never written to",
    never: "Dates for features not built yet, discounts, custom builds",
    slots: "30 minutes",
    buffer: "15 minutes",
    tone: "Brief and direct",
    formality: "Conversational",
    signature: "Ashley R. Bryant, LPC, CRC | Founder, LeadDash",
    ...VOICE_COMMON,
    ...WORKING,
  },
  hiring: {
    outreach: "Find people and draft messages",
    screening: "Quinn scores, I decide",
    interviewFormat: "Video call",
    ...WORKING,
  },
  custom: {},
};

// ---------- Extra guideline lines (brand rules), by employee and section ----------

const BRAND = [
  "Write DashNotes™ and P.U.L.S.E.™ with the trademark symbol.",
  "Say 24/7 receptionist, never AI receptionist. Never name GoHighLevel or the claims clearinghouse; everything is LeadDash.",
  "Plain, specific and analytical, like a clinician who runs a practice. No hype, no invented numbers, no em dashes.",
];
const EXTRA: Partial<Record<EmployeeKind, Record<string, string[]>>> = {
  social: { writing: [...BRAND, "Clinician-facing posts are signed Ashley R. Bryant, LPC, CRC; other marketing may say Dr. Ashley."] },
  blog: { writing: [...BRAND] },
  website: { writing: [...BRAND, "Orange is for buttons and accents only, never a section background."] },
  video: { style: [...BRAND] },
  outreach: { voice: [...BRAND], rules: ["Keep Ashley's name out of outreach templates and booking details; say \"your LeadDash demo\", since she won't run every demo."] },
  leads: { voice: [...BRAND], rules: ["Keep Ashley's name out of booking details; say \"your LeadDash demo\"."] },
  inbox: { writing: [...BRAND], rules: ["In emails to member practices, credit product work to the development team."] },
  speaking: { pitch: [...BRAND, "Do not mention Cornell or Therapy In Color unless Ashley asks."] },
  grants: { writing: ["Plain, specific, evidence-first; every number needs a source or a [PLACEHOLDER].", "The DoorDash trademark win is part of the company story, not the founder story."] },
};

// ---------- What each employee does on its own ----------
// The least approvals that still keep anyone from writing strangers unchecked.
const RULES: Partial<Record<EmployeeKind, Record<string, Mode>>> = {
  prospecting: { pass_to_outreach: "auto" },
  outreach: { first_email: "first5", follow_up: "auto", pass_replies: "auto" },
  leads: { reply: "first5" },
  inbox: { new_email: "ask" },
  social: { posts: "first5" },
  blog: { pass_to_social: "auto" },
  coo: { invites: "first5", recap: "ask", action_items: "auto" },
  projects: { create_plan: "ask", update_tasks: "auto", remind: "auto" },
};

// ---------- Run ----------

async function main() {
  const orgs = (await db.listAllOrganizationIds()).length ? await Promise.all((await db.listAllOrganizationIds()).map((id) => db.getOrganizationById(id))) : [];
  const org = orgs.find((o) => o && o.name.trim().toLowerCase() === "leaddash") ?? orgs.find((o) => o && o.name.trim().toLowerCase().startsWith("leaddash"));
  if (!org) {
    console.log('No workspace named "LeadDash". Create it in the app, then run this again.');
    process.exit(1);
  }
  const at = new Date().toISOString();
  for (const emp of await db.listEmployeesByOrg(org.id)) {
    if (emp.kind === "custom") continue;
    const kind = emp.kind;
    const qs = allQuestions(kind);
    const valid = new Set(qs.map((q) => q.key));
    const current = readAnswers(emp);
    const answers = { ...current };
    let filled = 0;
    for (const [k, v] of Object.entries(ANSWERS[kind] ?? {})) {
      if (!valid.has(k)) continue;
      const q = qs.find((x) => x.key === k)!;
      // Only real options for fixed choices.
      if (q.type === "choice" && (typeof v !== "string" || !q.options?.includes(v))) throw new Error(`${kind}.${k}: "${v}" is not an option`);
      if (q.type === "multi" && (!Array.isArray(v) || v.some((x) => !q.options?.includes(x)))) throw new Error(`${kind}.${k}: not all options are real`);
      const has = Array.isArray(current[k]) ? (current[k] as string[]).length > 0 : !!String(current[k] ?? "").trim();
      if (has) continue;
      answers[k] = v;
      filled++;
    }
    let next = (await db.updateEmployee(emp.id, org.id, { onboarding: JSON.stringify(answers) }))!;
    const st = readState(next);
    const hasSamples = qs.some((q) => q.type === "samples");
    const hasExamples = qs.some((q) => q.type === "examples");
    const state = {
      ...st,
      step: INTERVIEWS[kind].sections.length,
      done: true,
      doneAt: st.doneAt ?? at,
      welcomedAt: st.welcomedAt ?? at,
      remindAt: undefined,
      samples: hasSamples ? (st.samples?.length ? st.samples : SAMPLES(kind)) : st.samples,
      examples: hasExamples && !(st.examples ?? []).length ? LIKED : st.examples,
      followupsAsked: true,
    };
    next = (await db.updateEmployee(emp.id, org.id, { interview: JSON.stringify(state), onboardedAt: next.onboardedAt ?? new Date() }))!;
    next = await refreshGuidelines(next);

    // Brand rules as guideline lines, once.
    const g = readGuidelines(next);
    let added = 0;
    for (const [section, lines] of Object.entries(EXTRA[kind] ?? {})) {
      if (!g.sections[section]) continue;
      for (const text of lines) {
        if (g.sections[section].some((i) => i.text === text)) continue;
        g.sections[section].push({ id: `brand-${section}-${g.sections[section].length}-${Date.now() % 100000}`, text, source: "you", at });
        added++;
      }
    }
    next = (await db.updateEmployee(emp.id, org.id, { guidelines: JSON.stringify(g) }))!;

    if (RULES[kind]) await saveAutonomy(next as AIEmployee, RULES[kind]!);

    // "A day with ..." from the new Guidelines (needs the AI key on the server).
    const { writeDayToDay } = await import("../server/employees/onboarding");
    await writeDayToDay((await db.getEmployeeForOrg(emp.id, org.id))!).catch(() => null);

    const missing = qs.filter((q) => q.type !== "samples" && q.type !== "examples").filter((q) => {
      const v = answers[q.key];
      return Array.isArray(v) ? !v.length : !String(v ?? "").trim();
    });
    console.log(`${emp.name} (${emp.roleTitle}): ${filled} answers added, ${added} brand lines, ${missing.length} left for you${missing.length ? `: ${missing.map((q) => q.label).join("; ")}` : ""}`);
  }
  console.log(`\nDone. Workspace: ${org.name} (#${org.id}). Every employee is marked onboarded, so none will send a welcome message.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
