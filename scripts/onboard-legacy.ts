/**
 * Sets up Ashley's group practice, Legacy Family Services, as its own
 * workspace and onboards all 13 employees from what is already known about
 * the practice: workspace profile, Brain entries, interview answers, voice
 * samples and examples, Guidelines, and what each employee does on its own.
 * New tenants never get this; it only touches the workspace named
 * "Legacy Family Services" (and creates it if it is missing).
 *
 *   cd /home/ssm-user/employees && npx tsx scripts/onboard-legacy.ts
 *
 * Safe to run twice: profile fields already set are kept, Brain entries whose
 * title exists are kept, answers already given are kept, and guideline lines
 * already there are not added again.
 */
import "dotenv/config";
import * as db from "../server/db";
import type { AIEmployee, EmployeeKind } from "../drizzle/schema";
import { INTERVIEWS, allQuestions } from "../server/employees/interview-defs";
import { readAnswers, readGuidelines, readState, refreshGuidelines, type Example } from "../server/employees/interview";
import { saveAutonomy, type Mode } from "../server/employees/team";
import { indexKnowledge } from "../server/employees/kb";
import { ensureRoster } from "../server/employees/roster-sync";

type A = Record<string, string | string[]>;

const NAME = "Legacy Family Services";
const SLUG = "legacy-family-services";
const BOOKING = "https://portal.leaddash.io/book/legacy-family";
const PORTAL = "https://portal.leaddash.io/legacy";

// ---------- Workspace profile (only empty fields are filled) ----------

const PROFILE: Record<string, string> = {
  website: "legacyfs.org",
  state: "Oklahoma City, OK",
  entity: "Legacy Family Services, Inc.",
  description:
    "Group therapy practice in Oklahoma City, founded in 2015. Licensed therapists see individuals, couples and families in person in Oklahoma City and online by telehealth, and the practice offers adult clinical and ADHD assessments.",
  audience:
    "Adults, couples and families looking for therapy in Oklahoma, Colorado, Texas and Florida, plus adults who need a clinical or ADHD assessment. Referral partners include primary care offices and prescribers.",
  focusAreas: "Outpatient mental health, individual therapy, couples therapy, family therapy, adult clinical and ADHD assessments, telehealth",
  signerName: "Ashley R. Bryant",
  signerTitle: "Owner and Director",
  timezone: "America/Chicago",
};

// ---------- Brain entries (skipped when the title already exists) ----------

const ENTRIES: { title: string; category: string; content: string }[] = [
  {
    category: "mission_profile",
    title: "What Legacy Family Services is",
    content: `Legacy Family Services, Inc. is a group therapy practice in Oklahoma City, founded in 2015. Licensed therapists see individuals, couples and families, in person in Oklahoma City and online by telehealth.

Office: 11901 N MacArthur Blvd, Suite C6, Oklahoma City, OK 73162
Phone: (405) 370-4594
Fax: (405) 421-9530
Client email: client@legacyfs.org (a contact address only, never a login)
Website: legacyfs.org

Owner and director: Ashley R. Bryant, PhD, LPC, CRC.`,
  },
  {
    category: "mission_profile",
    title: "Services",
    content: `- Individual therapy for adults, in person or online.
- Couples therapy. Couples counseling is self-pay only: insurance usually requires a mental health diagnosis, and relationship concerns are not a diagnosis. Most couples start weekly and adjust from there.
- Family therapy.
- Adult clinical assessments and ADHD-focused assessments by telehealth, self-pay, $400 per client. Each comes with a written report; the ADHD report includes a statement for the client's prescriber. Adults only: no children or teens. Autism assessments are not offered.
- Standard sessions run about 50 to 55 minutes. Online booking is offered at the top of the hour.`,
  },
  {
    category: "mission_profile",
    title: "Where we see clients",
    content: `- In person at the Oklahoma City office.
- Online (telehealth) for clients in Oklahoma, Colorado, Texas and Florida.
- Ashley is licensed as an LPC in Oklahoma, Colorado and Texas and as an LMHC in Florida. Clinicians Amanda Case and Delicia Porter see clients by telehealth. [CONFIRM which states each clinician is licensed in before promising a state.]`,
  },
  {
    category: "financial_data",
    title: "Insurance and payment",
    content: `- Legacy accepts insurance and files claims as a courtesy when it is in network with the client's plan. In-network plans: [CONFIRM THE CURRENT LIST].
- Legacy is not contracted with SoonerCare (Oklahoma Medicaid).
- Out of network: Legacy gives a superbill the client can submit for possible reimbursement.
- Copays and deductibles are due at the time of service. Cash, check and major credit cards are accepted.
- Clients without insurance, or who choose not to use it, can request a Good Faith Estimate under the No Surprises Act.
- A sliding scale may be available based on financial need; availability is limited and needs approval.
- Returned checks and declined payments carry a $35 fee.
- Couples counseling and assessments are self-pay.`,
  },
  {
    category: "mission_profile",
    title: "Client policies",
    content: `- Cancel or reschedule at least 24 hours ahead, by phone, email, text or the client portal.
- Late cancellations (under 24 hours) and no-shows are charged the full session fee. Insurance does not cover these fees.
- A late arrival still ends at the scheduled time.
- Balances more than 60 days overdue may go to collections.
- In a genuine emergency, clients should contact the office as soon as they can.
- Client portal: ${PORTAL}`,
  },
  {
    category: "mission_profile",
    title: "Booking link",
    content: `${BOOKING}

New and existing clients book on the same page; the page asks whether they are new. [CONFIRM the new booking page is live before employees send it. Until then, send people to legacyfs.org or the office phone, (405) 370-4594.]`,
  },
  {
    category: "team_bios",
    title: "Team",
    content: `- Ashley R. Bryant, PhD, LPC, CRC: owner and director. Sees clients and runs the practice.
- BJ: COO and facility director.
- Angela St. Ville: client services, billing lead, compliance and HR. Signs in as angela@legacyfs.org.
- Amanda Case: licensed clinician, telehealth. Also a help desk agent for client@legacyfs.org.
- Delicia Porter: licensed clinician, telehealth.`,
  },
  {
    category: "team_bios",
    title: "Owner bio: Ashley R. Bryant",
    content: `Ashley R. Bryant, PhD, LPC, CRC, owns and directs Legacy Family Services.
- Licensed Professional Counselor in Oklahoma, Colorado and Texas; Licensed Mental Health Counselor in Florida; Certified Rehabilitation Counselor.
- PhD in Workforce and Adult Education, Oklahoma State University. MS in Rehabilitation Counseling, Langston University (2012).
- 18 years of clinical experience, with a background in vocational rehabilitation and disability employment.
- Creator of the P.U.L.S.E.™ Framework and author of Love with P.U.L.S.E.
- More than 100 speaking engagements; featured on TLC, PBS and FOX.
For Legacy marketing, sign as Ashley R. Bryant, LPC, CRC. Oklahoma rules do not allow "Dr." in counseling practice marketing.`,
  },
  {
    category: "voice_tone",
    title: "Privacy and safety rules",
    content: `- Never name a client, describe a client, or confirm that someone is a client, anywhere: posts, emails, notes, recaps or chat. Staff notices use initials only.
- Never give clinical advice or discuss a client's care by email, text or social media. Invite them to call the office or bring it to their session.
- Anyone who mentions thoughts of harming themselves or someone else, or a crisis: tell them to call or text 988 (Suicide and Crisis Lifeline) or call 911 for an emergency, and alert Ashley right away.
- Never ask current clients for reviews or testimonials, and never write made-up client stories that read as real.
- Never sit in on, record or take notes in client sessions.
- Keep client information out of tools outside LeadDash EHR.`,
  },
  {
    category: "voice_tone",
    title: "Voice and naming rules",
    content: `- Warm, plain and direct, like a therapist talking to someone deciding whether to start. Short sentences. No hype, no promises of results, no em dashes.
- Say "clients," not "patients." Say "licensed therapists."
- No "Dr." in Legacy marketing (an Oklahoma licensing rule). Sign as Ashley R. Bryant, LPC, CRC.
- Write P.U.L.S.E.™ with the trademark symbol.
- Name the practice "Legacy Family Services" in full the first time.`,
  },
  {
    category: "mission_profile",
    title: "Plans",
    content: `- Applying for ODMHSAS Outpatient Mental Health certification. Providers cannot contract with OHCA or ODMHSAS during the six-month Permit for Temporary Operation.
- After certification, Legacy can contract for SoonerCare and hire licensure candidates under supervision. Candidates cannot bill commercial insurance on their own.
- Moving booking and the client portal into LeadDash EHR (${PORTAL}), replacing the old SimplePractice portal.
- The office is a single therapy room, so filming and meetings there happen only when no client is present.`,
  },
];

// ---------- Voice: how Legacy sounds ----------

const SAMPLES = (kind: EmployeeKind) => {
  const s: Record<string, { label: string; text: string }[]> = {
    social: [
      { label: "Warm and personal", text: "Taking the first step toward therapy can feel daunting. It's also a promise to yourself that you're worth the effort. We're here when you're ready." },
      { label: "Direct and specific", text: "Couples counseling at Legacy is self-pay, and here's why: insurance needs a diagnosis, and a hard season in your relationship isn't one." },
      { label: "Playful", text: "You make time for oil changes. Your mind deserves a tune-up too." },
    ],
    blog: [
      { label: "Warm and personal", text: "Most people wait months between deciding they want therapy and booking the first session. If that's you, here's what the first session actually looks like." },
      { label: "Direct and specific", text: "An adult ADHD assessment at Legacy takes place by telehealth and ends with a written report your prescriber can use." },
      { label: "Academic", text: "Standardized screening tools such as the ASRS help clinicians separate attention concerns from anxiety and depression." },
    ],
    outreach: [
      { label: "Direct and specific", text: "Legacy Family Services offers adult ADHD and mental health assessments by telehealth, with a written report and a statement for the prescriber." },
      { label: "Warm and personal", text: "Many of your patients probably ask where they can get help between visits. We'd be glad to be one of the places you send them." },
      { label: "Formal", text: "I am writing to introduce the assessment and therapy services at Legacy Family Services." },
    ],
    leads: [
      { label: "Warm", text: "Thank you for reaching out. Here's the link to pick a time that works for you, in person or online." },
      { label: "Brief and direct", text: "Thanks for writing. You can book here, or call us at (405) 370-4594." },
      { label: "Formal", text: "Thank you for your inquiry. A member of our team will contact you." },
    ],
    inbox: [
      { label: "Warm and personal", text: "Thank you for letting us know. Here's where things stand." },
      { label: "Brief and direct", text: "Got it. Angela will send the superbill by Friday." },
      { label: "Formal", text: "Thank you for your email. Please find the requested information below." },
    ],
    website: [
      { label: "Warm and personal", text: "Licensed therapists you can genuinely trust, in person in Oklahoma City or online." },
      { label: "Direct and specific", text: "Individual, couples and family therapy. Insurance accepted. In person and online." },
      { label: "Expert", text: "Adult clinical and ADHD assessments by telehealth, with a written report for you and your prescriber." },
    ],
    video: [
      { label: "Direct and specific", text: "Three things that happen in a first therapy session, so you know what to expect." },
      { label: "Story", text: "A lot of couples wait until things are really bad to call. Here's what I wish they knew sooner." },
      { label: "Trend", text: "Things people say right before they realize they might need therapy." },
    ],
    speaking: [
      { label: "Direct and specific", text: "I'm a licensed therapist with 18 years in practice. I'd like to give your group practical tools for stronger relationships at home and at work." },
      { label: "Warm and personal", text: "Your members carry a lot. I'd love to spend an hour giving them something useful to take home." },
      { label: "Formal", text: "I am writing to propose a session for your upcoming event." },
    ],
  };
  return s[kind] ?? s.social;
};

const LIKED: Example[] = [
  { liked: true, text: "Taking the first step toward therapy can feel daunting, but it's also a step toward empowerment and self-discovery. It's a commitment to yourself, a promise that you are worth the effort and care. We're here to support you in making that commitment." },
  { liked: true, text: "Most couples start with weekly sessions, then adjust the frequency based on their progress and needs. Your therapist will work with you to find the schedule that helps most." },
  { liked: false, text: "Transform your life TODAY with our amazing, life-changing therapy! Book now before spots run out! 🔥" },
];

const VOICE_CLIENT: A = {
  samples: "Warm and personal",
  reading: "Plain (grade 6 to 8)",
  wordsUse: "clients, licensed therapists, in person or online, Legacy Family Services",
  wordsAvoid: "patients, cure, fix, guarantee, Dr., life-changing, transform, spots are filling fast",
};
const VOICE_PRO: A = {
  reading: "Clinician to clinician",
  wordsUse: "clients, licensed therapists, assessment, written report, telehealth",
  wordsAvoid: "patients' names, guarantee, Dr., life-changing",
};
const EXAMPLES_COMMON: A = { dislikeWhy: ["Too salesy", "Clickbait"], soundLike: "Legacy's own website: warm, plain, respectful, never pushy" };
const WORKING: A = {
  report: "A weekly summary",
  reach: "Push notification",
  know: "Legacy is Ashley's group practice. Client privacy comes first: never name or describe a client anywhere, staff notices use initials only, and crisis messages get 988 or 911 and an alert to Ashley. Angela St. Ville handles client services and billing.",
};

// ---------- Interview answers for each employee ----------

const ANSWERS: Record<EmployeeKind, A> = {
  coo: {
    goal: ["Running meetings", "Agendas", "Notes and action items", "Keeping teams on track"],
    success90: "Staff meetings have an agenda the day before and action items the same day, and nothing about certification or billing slips through.",
    first: "Set up a weekly staff check-in with Angela and a monthly team meeting with the clinicians.",
    deciders: "Ashley makes the final call.",
    style: "Short: decisions first",
    always: "Billing and claims follow-up, open client-services issues by initials only, ODMHSAS certification steps, hiring",
    team: "Ashley: owner, director and clinician. BJ: COO and facility director. Angela St. Ville: client services, billing, compliance and HR. Amanda Case and Delicia Porter: licensed clinicians by telehealth.",
    updatesFrom: "Angela on billing and client services; Nora on projects; Quinn on hiring; Malik on new client inquiries",
    numbers: "New client inquiries, first sessions booked, sessions held, claims sent and paid, open balances",
    offTrack: "Put it first on the next agenda",
    recapTo: "Only me",
    keepOff: "Client names and any clinical details (initials only), staff pay, personnel issues",
    ...WORKING,
  },
  projects: {
    goal: ["New services", "Campaigns", "Hiring pushes"],
    horizon: "1 month",
    success90: "The switch to the new booking page and portal is done, and the certification checklist has an owner and a date on every step.",
    first: "Plan the switch from the old booking page to the new LeadDash EHR booking page and portal, without turning off the old services until the new link is out.",
    owners: "Ashley: approvals, clinical decisions and certification. Angela: client services, billing, paperwork and credentialing logistics. BJ: facility. Sienna, Theo and Jordan: marketing pieces.",
    approver: "Ashley",
    buffer: "2 days",
    how: "Small tasks, one owner each, every task tied to a milestone",
    noDue: ["Weekends"],
    done: "Live or sent, not just drafted, and approved by Ashley when clients will see it",
    kpis: "First sessions booked, assessments booked, inquiries answered within a day",
    reportStyle: "Short: on track or not",
    ...WORKING,
  },
  grants: {
    goal: ["Grants", "Government contracts"],
    success90: "Two strong applications ready to sign, each with real numbers and no placeholders left",
    first: "Find behavioral health and workforce grants open to Oklahoma practices with deadlines in the next 90 days",
    often: "Weekly",
    staff: "Owner and director, a COO and facility director, a client services and billing lead, and two licensed clinicians. In person in Oklahoma City; telehealth across Oklahoma, Colorado, Texas and Florida.",
    programs: "Individual, couples and family therapy in person and by telehealth; adult clinical and ADHD assessments; future supervised training for licensure candidates once ODMHSAS certification is complete",
    minAward: "$10,000",
    region: "My state first, then national",
    priorities: "Access to therapy in Oklahoma, the behavioral health workforce (supervising licensure candidates), telehealth reach, and the ODMHSAS outpatient certification",
    autoStart: "Ask me first",
    signer: "Ashley R. Bryant, PhD, LPC, CRC, Owner and Director, Legacy Family Services, Inc.",
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  speaking: {
    goal: ["Workshops", "Panels", "Webinars"],
    success90: "Two community or workplace talks booked that send people to Legacy",
    first: "Find employer wellness, church and community events in the Oklahoma City metro looking for mental health speakers",
    topics: "Stronger relationships with the P.U.L.S.E.™ Framework; mental health at work; when to start therapy and what to expect",
    abstracts: "Couples leave with one practice they can use that night; employees leave knowing the signs that it's time to get support",
    bioShort: "Ashley R. Bryant, PhD, LPC, CRC, is a licensed therapist with 18 years in practice and the owner of Legacy Family Services in Oklahoma City. She created the P.U.L.S.E.™ Framework and has spoken at more than 100 events.",
    credentials: "PhD, LPC, CRC",
    pastEvents: "More than 100 speaking engagements; featured on TLC, PBS and FOX",
    paid: "Paid or visibility",
    travel: "In my state",
    want: "Employers, churches, community groups, universities and couples' events in Oklahoma",
    avoidAud: "Events that require naming Cornell or Therapy In Color",
    often: "Twice a week",
    formality: "Conversational",
    ...VOICE_CLIENT,
    samples: "Direct and specific",
    ...WORKING,
  },
  prospecting: {
    goal: ["Referral partners"],
    success90: "25 strong referral partners a week, each with a contact name and a direct email or fax",
    first: "Primary care offices and prescribers in the Oklahoma City metro who see adults with attention, anxiety or mood concerns",
    often: "Weekly",
    weekly: "25",
    size: "Solo practices",
    specialty: ["Medical", "Psychiatry"],
    payer: "Either",
    states: "Oklahoma City metro first, then the rest of Oklahoma",
    ideal: "Primary care offices, psychiatric nurse practitioners and other prescribers who need somewhere to send adults for therapy or an ADHD or mental health assessment",
    decider: ["Owner", "Office manager", "Clinical director"],
    skip: "Other therapy practices, hospital systems, pediatric-only offices (Legacy sees adults for assessments)",
    ...WORKING,
  },
  outreach: {
    goal: ["Partnerships", "Replies"],
    success90: "Referral partners sending clients every month, with no complaints or unsubscribes",
    first: "Introduce the adult ADHD and mental health assessments to Riley's best-fit prescribers",
    offer: "A short call",
    cta: "Reply to set up a 15-minute call, or send referrals by fax to (405) 421-9530",
    proof: "Adult clinical and ADHD assessments by telehealth, each with a written report and a statement for the prescriber; therapy in person in Oklahoma City and online in Oklahoma, Colorado, Texas and Florida; founded in 2015",
    objections: "\"We already refer elsewhere\": we can usually see adults for assessments sooner, and you get a written report back. \"Do you take insurance?\": therapy, yes, with a list of plans; assessments are self-pay.",
    tone: "Brief and direct",
    formality: "Professional",
    signOff: "Ashley R. Bryant, LPC, CRC, Owner and Director, Legacy Family Services",
    address: "Legacy Family Services, 11901 N MacArthur Blvd, Suite C6, Oklahoma City, OK 73162",
    ...VOICE_PRO,
    samples: "Direct and specific",
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  leads: {
    goal: ["Book meetings", "Answer questions", "Hand hot leads to me"],
    success90: "Every new client inquiry answered the same day with a booking link",
    first: "Answer new client inquiries and send them to the booking page",
    services: "Individual, couples and family therapy, in person in Oklahoma City or online; adult clinical and ADHD assessments by telehealth",
    prices: "Never share prices",
    faqs: "Do you take insurance? Yes for therapy; we check your plan when you book, and we can give a superbill if we are out of network. Couples counseling? Yes, self-pay only, because insurance needs a diagnosis. Online sessions? Yes, for clients in Oklahoma, Colorado, Texas and Florida. Do you see kids? Not for assessments; assessments are adults only. Cancellations? 24 hours' notice, or the full session fee is charged.",
    qualifies: "Adults, couples and families in Oklahoma, Colorado, Texas or Florida looking for therapy, and adults who want a clinical or ADHD assessment",
    notFit: "Anyone in crisis: 988 or 911, and alert Ashley. Children's assessments and autism assessments: say we don't offer them and suggest asking their doctor. People outside the four states: say we can't see them yet.",
    handoff: ["Billing questions", "Complaints", "Anything urgent", "Insurance questions"],
    hours: "8 AM to 8 PM",
    tone: "Warm",
    formality: "Conversational",
    never: "A specific therapist, a time slot that isn't on the booking page, prices, insurance coverage before it's verified, or any clinical advice",
    ...VOICE_CLIENT,
    samples: "Warm",
    ...WORKING,
  },
  social: {
    goal: ["Bring in clients", "Recruit staff"],
    success90: "3 posts a week going out on time, sounding like Legacy, with people booking from them",
    first: "Instagram and Facebook posts on what to expect in therapy, couples counseling and adult assessments",
    formality: "Conversational",
    emoji: "One at most",
    hashtags: "2 or 3 at the end",
    signOff: "Legacy Family Services",
    platforms: ["Instagram", "Facebook", "LinkedIn"],
    audience: "Adults and couples in Oklahoma, Colorado, Texas and Florida thinking about starting therapy",
    often: "3 a week",
    pillars: "What to expect in therapy; relationships and couples counseling (P.U.L.S.E.™); adult ADHD and mental health assessments; everyday mental health tips; we're hiring",
    imageStyle: "Photos for people, illustrations for ideas",
    imageNotes: "Real-looking, diverse adults and couples; calm settings; nothing that looks like a real client; no stock handshakes",
    avoid: "Clients or anything that could identify one, testimonials from clients, before-and-after promises, crisis content without 988, politics",
    composites: "No, never",
    ...VOICE_CLIENT,
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  blog: {
    goal: ["Bring in clients", "Rank on Google"],
    success90: "Two articles a month ranking for local therapy searches and sending readers to book",
    first: "An article on what to expect in a first therapy session, and one on adult ADHD assessments by telehealth",
    reader: "Clients and families",
    questions: "How to find a therapist in Oklahoma City, whether insurance covers therapy, what couples counseling is like, how adult ADHD is assessed, whether online therapy works",
    topics: "Starting therapy, couples and relationships, family therapy, adult ADHD, anxiety and depression in everyday life, telehealth",
    keywords: "therapist Oklahoma City, couples counseling Oklahoma City, adult ADHD assessment Oklahoma, online therapy Oklahoma, online therapy Texas, online therapy Colorado, online therapy Florida",
    length: "1,200 words",
    often: "Twice a month",
    citations: "Cite a source for every fact",
    cta: `Book online at ${BOOKING} or call (405) 370-4594`,
    author: "Ashley R. Bryant, LPC, CRC, owner of Legacy Family Services in Oklahoma City",
    formality: "Conversational",
    ...VOICE_CLIENT,
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  website: {
    goal: ["Book consultations", "Build trust", "Recruit staff"],
    success90: "A site that turns visitors into booked first sessions",
    first: "The home page and a booking page that embeds the new booking widget",
    visitors: "Adults, couples and families in Oklahoma, Colorado, Texas and Florida comparing therapists, and prescribers looking for assessments",
    pages: "Home, book now, couples counseling, adult assessments, insurance and fees, one page for each state served, careers",
    cta: "Book an appointment",
    diff: "In person in Oklahoma City and online in four states; individual, couples and family therapy under one roof; insurance accepted for therapy; adult ADHD and mental health assessments with a written report; culturally competent care",
    proof: "Founded in 2015; owner has 18 years of clinical experience and is licensed in Oklahoma, Colorado, Texas and Florida",
    voice: "Warm and personal",
    formality: "Conversational",
    ...VOICE_CLIENT,
    ...WORKING,
  },
  video: {
    goal: ["Bring in clients", "Teach"],
    success90: "Two short videos a week Ashley can film in under 15 minutes each",
    first: "Short videos answering the questions new clients ask most",
    platforms: ["Instagram Reels", "TikTok"],
    length: "30 to 60 seconds",
    often: "2",
    captions: "Captions on every video",
    onCamera: "Me",
    avoid: "Clients, client records, screens with client information, the office while any client is there",
    style: "Teaching",
    formality: "Conversational",
    ...VOICE_CLIENT,
    samples: "Direct and specific",
    ...EXAMPLES_COMMON,
    ...WORKING,
  },
  inbox: {
    goal: ["Drafting replies", "Sorting what's urgent", "Follow-ups"],
    success90: "The inbox sorted every day, with replies drafted for anything that needs me or Angela",
    first: "Sort the inbox and draft replies to referral sources and new inquiries",
    who: "New client inquiries, current clients, referral sources, insurance payers, ODMHSAS and other state agencies, staff",
    urgent: "Anything about safety or a crisis, ODMHSAS or licensing board deadlines, payer denials with a deadline, staff who can't see clients",
    archive: "Newsletters, vendor marketing, cold sales emails",
    replyTo: "New client inquiries, referral sources and scheduling questions",
    noReply: "Anything clinical from a client (flag it for their therapist), cold sales emails",
    never: "Clinical advice, insurance coverage before it's verified, a specific therapist or time not on the booking page, prices",
    slots: "30 minutes",
    buffer: "15 minutes",
    tone: "Warm and personal",
    formality: "Conversational",
    signature: "Ashley R. Bryant, LPC, CRC | Owner and Director, Legacy Family Services | (405) 370-4594",
    ...VOICE_CLIENT,
    ...WORKING,
  },
  hiring: {
    goal: ["Licensed clinicians"],
    success90: "A short list of strong licensed clinicians interviewed, with one ready for an offer",
    first: "Find fully licensed therapists in Oklahoma who want telehealth caseloads",
    often: "Weekly",
    mustHave: "An active, unrestricted license; comfortable with telehealth; committed to culturally competent care",
    licenses: "LPC, LMFT or LCSW, fully licensed in Oklahoma. Colorado, Texas or Florida licenses are a plus for telehealth.",
    greatFit: "Warm, steady clinicians who keep their notes current, work well with a small team, and care about clients who often get overlooked",
    panel: "Ashley interviews; Angela St. Ville handles the HR paperwork",
    interviewFormat: "Video call",
    outreach: "Find people and draft messages",
    screening: "Quinn scores, I decide",
    ...WORKING,
  },
  custom: {},
};

// ---------- Extra guideline lines, by employee and section ----------

const PRIVACY = "Never name, describe or confirm a client anywhere. Staff notices use initials only.";
const BRAND = [
  "No \"Dr.\" in Legacy marketing; sign as Ashley R. Bryant, LPC, CRC.",
  "Say clients, not patients. Write P.U.L.S.E.™ with the trademark symbol. No em dashes, no promises of results.",
  PRIVACY,
];
const CRISIS = "Anyone who mentions a crisis or harming themselves or someone else: point them to 988 or 911 and alert Ashley right away.";
const EXTRA: Partial<Record<EmployeeKind, Record<string, string[]>>> = {
  social: { writing: [...BRAND, "Never ask clients for reviews or testimonials, and never post made-up client stories."] },
  blog: { writing: [...BRAND, "End posts on hard topics with the 988 line."] },
  website: { writing: [...BRAND] },
  video: { style: [...BRAND] },
  outreach: { voice: [...BRAND] },
  leads: { voice: [...BRAND], rules: [CRISIS, "Never give clinical advice; invite them to book or call (405) 370-4594."] },
  inbox: { writing: [...BRAND], rules: [CRISIS, "Never discuss a client's care by email. Flag clinical messages for the client's therapist."] },
  speaking: { pitch: [...BRAND, "Do not mention Cornell or Therapy In Color unless Ashley asks."] },
  grants: { writing: ["Plain, specific, evidence-first; every number needs a source or a [PLACEHOLDER].", PRIVACY] },
  hiring: { rules: ["Never promise pay, start dates or a caseload size; Ashley makes every offer."] },
  coo: { recaps: [PRIVACY, "Never sit in on, record or take notes in client sessions."] },
};

// ---------- What each employee does on its own ----------
// Few approvals, but nothing goes to a client or a stranger unchecked at first.
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
  const at = new Date().toISOString();

  // The workspace: find it, or create it with every employee.
  let org = (await db.listOrganizations()).find((o) => o.name.trim().toLowerCase() === NAME.toLowerCase()) ?? (await db.getOrganizationBySlug(SLUG));
  let created = false;
  if (!org) {
    org = await db.createOrganization({ name: NAME, slug: SLUG, plan: "growth" });
    created = true;
  }
  await ensureRoster(org.id);

  // Mark everyone welcomed first, so no one posts a welcome while this runs.
  for (const emp of await db.listEmployeesByOrg(org.id)) {
    const st = readState(emp);
    if (!st.welcomedAt) await db.updateEmployee(emp.id, org.id, { interview: JSON.stringify({ ...st, welcomedAt: at }) });
  }

  // Profile: only empty fields.
  const filled: Record<string, string> = {};
  for (const [k, v] of Object.entries(PROFILE)) {
    const cur = String((org as Record<string, unknown>)[k] ?? "").trim();
    if (!cur || (k === "timezone" && created)) filled[k] = v;
  }
  if (Object.keys(filled).length) await db.updateOrganization(org.id, filled);

  // Brain entries: skip titles that exist.
  const have = new Set((await db.listKnowledgeByOrg(org.id)).map((k) => k.title.trim().toLowerCase()));
  let brainAdded = 0;
  for (const e of ENTRIES) {
    if (have.has(e.title.toLowerCase())) continue;
    const saved = await db.createKnowledgeItem({ organizationId: org.id, title: e.title, category: e.category as never, kind: "fact", content: e.content });
    if (saved) indexKnowledge(saved);
    brainAdded++;
  }
  console.log(`Workspace: ${org.name} (#${org.id})${created ? " created" : ""}`);
  console.log(`Profile fields filled: ${Object.keys(filled).length ? Object.keys(filled).join(", ") : "none (already set)"}`);
  console.log(`Brain entries added: ${brainAdded} of ${ENTRIES.length}${brainAdded < ENTRIES.length ? " (the rest were already there)" : ""}`);

  for (const emp of await db.listEmployeesByOrg(org.id)) {
    if (emp.kind === "custom") continue;
    const kind = emp.kind;
    const qs = allQuestions(kind);
    const valid = new Set(qs.map((q) => q.key));
    const current = readAnswers(emp);
    const answers = { ...current };
    let added = 0;
    for (const [k, v] of Object.entries(ANSWERS[kind] ?? {})) {
      if (!valid.has(k)) continue;
      const q = qs.find((x) => x.key === k)!;
      if (q.type === "samples") {
        if (typeof v !== "string" || !SAMPLES(kind).some((s) => s.label === v)) throw new Error(`${kind}.${k}: "${v}" is not one of the samples`);
      } else if (q.type === "choice" && (typeof v !== "string" || !q.options?.includes(v))) throw new Error(`${kind}.${k}: "${v}" is not an option`);
      if (q.type === "multi" && (!Array.isArray(v) || v.some((x) => !q.options?.includes(x)))) throw new Error(`${kind}.${k}: not all options are real`);
      const has = Array.isArray(current[k]) ? (current[k] as string[]).length > 0 : !!String(current[k] ?? "").trim();
      if (has) continue;
      answers[k] = v;
      added++;
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

    // Practice rules as guideline lines, once.
    const g = readGuidelines(next);
    let lines = 0;
    for (const [section, list] of Object.entries(EXTRA[kind] ?? {})) {
      if (!g.sections[section]) continue;
      for (const text of list) {
        if (g.sections[section].some((i) => i.text === text)) continue;
        g.sections[section].push({ id: `legacy-${section}-${g.sections[section].length}-${Date.now() % 100000}`, text, source: "you", at });
        lines++;
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
    console.log(`${emp.name} (${emp.roleTitle}): ${added} answers added, ${lines} practice lines, ${missing.length} left for you${missing.length ? `: ${missing.map((q) => q.label).join("; ")}` : ""}`);
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
