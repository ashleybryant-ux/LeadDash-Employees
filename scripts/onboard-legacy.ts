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
 * Safe to run again: anything you changed yourself is kept. Profile fields,
 * Brain entries and answers this script loaded before (scripts/data/legacy-v1.json)
 * are updated to the current version; guideline lines are never added twice.
 */
import "dotenv/config";
import * as db from "../server/db";
import type { AIEmployee, EmployeeKind } from "../drizzle/schema";
import { INTERVIEWS, allQuestions } from "../server/employees/interview-defs";
import { readAnswers, readGuidelines, readState, refreshGuidelines, type Example } from "../server/employees/interview";
import { saveAutonomy, type Mode } from "../server/employees/team";
import { indexKnowledge } from "../server/employees/kb";
import { ensureRoster } from "../server/employees/roster-sync";
import fs from "node:fs";
import path from "node:path";

/** What the first version of this script loaded, so a re-run can update it without touching your own edits. */
type V1Data = { profile: Record<string, string>; entries: { title: string; content: string }[]; answers: Record<string, A> };
const V1: V1Data = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "data", "legacy-v1.json"), "utf8"));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

type A = Record<string, string | string[]>;

const NAME = "Legacy Family Services";
const SLUG = "legacy-family-services";
const BOOKING = "https://schedulemytherapy.com";
const REBOOK = "https://reschedulemytherapy.com";
const PORTAL = "https://portal.leaddash.io/legacy";

// ---------- Workspace profile (only empty fields are filled) ----------

const PROFILE: Record<string, string> = {
  website: "legacyfs.org",
  state: "Oklahoma City, OK",
  entity: "Legacy Family Services, Inc.",
  description:
    "Group therapy practice in Oklahoma City, founded in 2015. Five licensed therapists see adults, couples, families, teens and children by video, with play therapy for younger children and flat-fee adult ADHD, autism and ADA workplace accommodation evaluations. Most major insurance plans are accepted.",
  audience:
    "Adults, couples and families in Oklahoma, Colorado, Texas and Florida looking for therapy; children and teens in Oklahoma; adults who need an ADHD, autism or ADA workplace accommodation evaluation. Referral partners include primary care offices, prescribers, pediatricians and employers.",
  focusAreas: "Outpatient mental health, individual therapy, couples therapy, family therapy, child and teen therapy, play therapy, adult ADHD and autism evaluations, ADA workplace accommodation evaluations, telehealth",
  signerName: "Ashley R. Bryant",
  signerTitle: "Owner and Director",
  timezone: "America/Chicago",
};

// ---------- Brain entries (skipped when the title already exists) ----------

const ENTRIES: { title: string; category: string; content: string }[] = [
  {
    category: "mission_profile",
    title: "What Legacy Family Services is",
    content: `Legacy Family Services, Inc. is a group therapy practice in Oklahoma City, founded in 2015. "Mental health for you and your family." Five licensed therapists see adults, couples, families, teens and children by video, and the owner offers flat-fee adult evaluations.

Office: 11901 N MacArthur Blvd, Suite C6, Oklahoma City, OK 73162
Hours: Monday to Friday, 8 AM to 5 PM Central. Closed Saturday and Sunday.
Phone: (405) 370-4594
Fax: (405) 421-9530
Client email: client@legacyfs.org (a contact address only, never a login)
Website: legacyfs.org (state pages for Oklahoma, Colorado, Texas and Florida, and a blog)
New clients book: ${BOOKING} (pick a therapist and a time in under two minutes)
Existing clients rebook: ${REBOOK}
Careers: workatlegacy.org
Same-week openings are often available.`,
  },
  {
    category: "mission_profile",
    title: "Services",
    content: `Individual therapy (adults): 50-minute video sessions. $175 self-pay, or billed to insurance. Focus areas: relationships, family dynamics, depression, anxiety, stress, trauma, grief, self-confidence, feeling stuck, affirming therapy.

Couples therapy: 50-minute joint sessions, $175, self-pay only. Legacy does not bill any insurance for couples sessions, because insurance needs a mental health diagnosis and relationship concerns are not one. Most couples start weekly and adjust from there.

Children and teens (ages 12 and up, Oklahoma): virtual, conversation-based therapy with Delicia Porter or Amanda Case. The first session usually includes the parent; later sessions are one on one, with regular parent check-ins on themes and progress (details stay private unless there is a safety concern). Covers anxiety, depression, school stress, social media, friendships, bullying, family changes, grief, trauma, identity and self-esteem. Insurance or self-pay.

Play therapy (about ages 6 to 11, Oklahoma): with Amanda Case, LPC, RPT. Virtual, from home, using the child's own toys and art supplies. Insurance or self-pay.

Adult evaluations (18 and older, all virtual in Oklahoma, Colorado, Texas and Florida), done by Ashley R. Bryant, LPC, CRC. Self-pay, one flat fee, paid at booking, with a paid receipt:
- Adult ADHD evaluation: $525
- Adult autism evaluation: $695
- ADA workplace accommodation evaluation: $550
Each includes a clinical interview and history, validated screening tools scored against DSM-5 criteria, a written report with recommendations, and a virtual feedback session. Reports arrive 5 to 7 business days after the questionnaires are done. The ADHD report can be shared with a physician or psychiatric provider. These are clinical diagnostic assessments, not psychological or neuropsychological testing; anyone who needs standardized testing is referred to a licensed psychologist.`,
  },
  {
    category: "mission_profile",
    title: "Where we see clients",
    content: `- Sessions are by video. Ashley sees clients in Oklahoma, Colorado, Texas and Florida (LPC in Oklahoma, Colorado and Texas; LMHC in Florida).
- Amanda Case, Delicia Porter, K'Deshia Martin and Shalena Mosley are licensed in Oklahoma, so their clients must be in Oklahoma.
- Children, teens and play therapy are Oklahoma only.
- Adult evaluations are available in all four states.
- The Oklahoma City office is a single therapy room. [CONFIRM whether in-person sessions are offered there now; the website lists video sessions.]`,
  },
  {
    category: "financial_data",
    title: "Insurance and payment",
    content: `- Most major insurance plans are accepted for therapy: BlueCross BlueShield, UnitedHealthcare, Aetna, TRICARE, Cigna, Optum, HealthChoice, Healthcare Highways, and Lyra (EAP). Self-pay is welcome.
- Panels differ by therapist (from each profile): Amanda Case: BCBS, Aetna, HealthChoice, Optum, UnitedHealthcare. Delicia Porter: BCBS, Aetna, HealthChoice, Healthcare Highways, Optum, UnitedHealthcare. K'Deshia Martin: BCBS and Aetna. Shalena Mosley: BCBS. Ashley's panels: [CONFIRM].
- What a client pays depends on their plan's copay, coinsurance and deductible. Clients can call (405) 370-4594 to check coverage before booking.
- Legacy is not contracted with SoonerCare (Oklahoma Medicaid).
- Self-pay: $175 for a 50-minute session. Couples sessions and adult evaluations are self-pay only.
- Out of network: Legacy gives a superbill the client can submit for possible reimbursement.
- Copays and deductibles are due at the time of service. Cash, check and major credit cards are accepted.
- Clients without insurance, or who choose not to use it, can request a Good Faith Estimate under the No Surprises Act.
- A sliding scale may be available based on financial need; availability is limited and needs approval.
- Returned checks and declined payments carry a $35 fee.`,
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
    content: `New clients: ${BOOKING}
Existing clients: ${REBOOK}
Phone: (405) 370-4594`,
  },
  {
    category: "team_bios",
    title: "Team",
    content: `Clinicians (all Licensed Professional Counselors):
- Ashley R. Bryant, LPC, CRC: owner and founder. Adults and couples, plus all adult evaluations. Anxiety, depression, trauma and complex PTSD, grief, couples and premarital counseling, LGBTQ+ affirming care, veterans. Prolonged exposure, CBT, mindfulness and strength-based work. Licensed in Oklahoma, Colorado, Texas and Florida.
- Amanda Case, LPC, RPT: teens, adults and older adults; play therapy for younger children. Anxiety, stress, grief, self-esteem, bipolar disorder, chronic pain, disabilities and chronic conditions. CBT, DBT, person-centered, play therapy. Telehealth, Oklahoma.
- Delicia Porter, LPC: ages 10 and up; individuals, couples and families. Trauma, sexual abuse recovery, relationship challenges, low motivation. CBT and person-centered. Video, Oklahoma.
- K'Deshia Martin, LPC: adults. Anxiety, depression, trauma, grief. CBT, mindfulness, strength-based. Oklahoma.
- Shalena Mosley, LPC: school-age children, teens and adults; family and couples counseling. Domestic violence, adolescents. Client-guided sessions. Oklahoma.

Staff:
- BJ: COO and facility director.
- Angela St. Ville: client services, billing lead, compliance and HR. Signs in as angela@legacyfs.org.
- Amanda Case is also a help desk agent for client@legacyfs.org.`,
  },
  {
    category: "team_bios",
    title: "Owner bio: Ashley R. Bryant",
    content: `Ashley R. Bryant, PhD, LPC, CRC, founded and directs Legacy Family Services.
- Licensed Professional Counselor in Oklahoma, Colorado and Texas; Licensed Mental Health Counselor in Florida; Certified Rehabilitation Counselor.
- PhD in Workforce and Adult Education, Oklahoma State University. MS in Rehabilitation Counseling, Langston University (2012).
- 18 years of clinical experience, with a background in vocational rehabilitation and disability employment.
- Works with self-doubt, anxiety, depression, trauma and complex PTSD, grief, couples, LGBTQ+ clients, veterans, and people adjusting to the effects of disabilities.
- Creator of the P.U.L.S.E.™ Framework and author of Love with P.U.L.S.E.
- Featured on TLC's My 600-lb Life and in InStyle; also PBS and FOX. More than 100 speaking engagements.
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
- Call the evaluations "clinical diagnostic assessments," never "psychological testing."
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
  {
    category: "mission_profile",
    title: "Website and blog",
    content: `- legacyfs.org pages: home, services, individual therapy, couples therapy, children and teens therapy, play therapy with Amanda, adult evaluations (ADHD, autism, ADA workplace accommodation), a page for each state (Oklahoma, Colorado, Texas, Florida), team and therapist profiles, contact, blog, privacy policy, terms.
- Recent blog posts (2026): "AI Chatbots vs. Real Therapy: Why the Human Connection Still Wins in OKC" and "7 Mistakes You're Making When Searching for a Therapist in Oklahoma City" (Sept 1); "Goodbye August: Reflecting on Growth and Looking Toward September" (Aug 31); "Preparing Your Kids (and Yourself) for the First Week of School" (Aug 30); "Self-Confidence Boosters: Reclaiming Your Inner Strength" (Aug 29). Others: routine as summer ends, mental health tips for Floridians, grief and the anniversary effect, talking to your boss about mental health days, transitioning to college in Colorado.
- Don't repeat a topic already covered without a new angle.`,
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
    team: "Ashley: owner, director, clinician and evaluations. BJ: COO and facility director. Angela St. Ville: client services, billing, compliance and HR. Amanda Case, Delicia Porter, K'Deshia Martin and Shalena Mosley: licensed clinicians.",
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
    first: "Plan the switch to the LeadDash EHR booking page and portal, without turning off the current booking pages (schedulemytherapy.com and reschedulemytherapy.com) until the new link is out.",
    owners: "Ashley: approvals, clinical decisions and certification. Angela: client services, billing, paperwork and credentialing logistics. BJ: facility. Sienna, Theo and Jordan: marketing pieces.",
    approver: "Ashley",
    buffer: "2 days",
    how: "Small tasks, one owner each, every task tied to a milestone",
    noDue: ["Weekends"],
    done: "Live or sent, not just drafted, and approved by Ashley when clients will see it",
    kpis: "First sessions booked, evaluations booked, inquiries answered within a day",
    reportStyle: "Short: on track or not",
    ...WORKING,
  },
  grants: {
    goal: ["Grants", "Government contracts"],
    success90: "Two strong applications ready to sign, each with real numbers and no placeholders left",
    first: "Find behavioral health and workforce grants open to Oklahoma practices with deadlines in the next 90 days",
    often: "Weekly",
    staff: "Owner and director, four more licensed therapists, a COO and facility director, and a client services and billing lead. Office in Oklahoma City; telehealth across Oklahoma, Colorado, Texas and Florida.",
    programs: "Individual, couples and family therapy by telehealth; therapy for children and teens and play therapy in Oklahoma; adult ADHD, autism and ADA workplace accommodation evaluations; future supervised training for licensure candidates once ODMHSAS certification is complete",
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
    first: "Primary care offices and prescribers in the Oklahoma City metro who see adults with attention, autism, anxiety or mood concerns",
    often: "Weekly",
    weekly: "25",
    size: "Solo practices",
    specialty: ["Medical", "Psychiatry"],
    payer: "Either",
    states: "Oklahoma City metro first, then the rest of Oklahoma",
    ideal: "Primary care offices, psychiatric nurse practitioners and other prescribers who need somewhere to send adults for therapy or an ADHD or autism evaluation; pediatricians who need therapy or play therapy for children; employers and HR teams handling ADA accommodation requests",
    decider: ["Owner", "Office manager", "Clinical director"],
    skip: "Other therapy practices, hospital systems",
    ...WORKING,
  },
  outreach: {
    goal: ["Partnerships", "Replies"],
    success90: "Referral partners sending clients every month, with no complaints or unsubscribes",
    first: "Introduce the adult ADHD and autism evaluations to Riley's best-fit prescribers",
    offer: "A short call",
    cta: "Reply to set up a 15-minute call, or send referrals by fax to (405) 421-9530",
    proof: "Flat-fee adult ADHD ($525), autism ($695) and ADA accommodation ($550) evaluations, all virtual, with a written report in 5 to 7 business days that the client can share with their prescriber; therapy for adults, couples, teens and children, with most major insurance plans accepted; same-week openings; founded in 2015",
    objections: "\"We already refer elsewhere\": we often have same-week openings, and the client brings back a written report. \"Do you take insurance?\": therapy, yes (BCBS, UnitedHealthcare, Aetna, TRICARE, Cigna, Optum, HealthChoice, Healthcare Highways, Lyra); evaluations are a flat self-pay fee. \"Is this psychological testing?\": no, these are clinical diagnostic assessments; anyone who needs standardized testing is referred to a psychologist.",
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
    services: "Individual, couples and family therapy by video; therapy for children and teens 12 and up and play therapy for about ages 6 to 11 (Oklahoma); adult ADHD, autism and ADA workplace accommodation evaluations (all four states)",
    prices: "Share prices",
    priceList: "Individual therapy: $175 per 50-minute session self-pay, or billed to insurance. Couples therapy: $175, self-pay only. Adult ADHD evaluation: $525. Adult autism evaluation: $695. ADA workplace accommodation evaluation: $550. Evaluations are flat fees paid at booking. Insurance costs depend on the plan's copay, coinsurance and deductible.",
    faqs: "Which insurance do you take? BlueCross BlueShield, UnitedHealthcare, Aetna, TRICARE, Cigna, Optum, HealthChoice, Healthcare Highways and Lyra (EAP); call (405) 370-4594 to check your coverage. Couples counseling? Yes, $175, self-pay only, because insurance needs a diagnosis. Online sessions? Yes, by video. Do you see kids? Yes in Oklahoma: teens 12 and up, and play therapy for about ages 6 to 11. Evaluations? Adults 18 and up, all virtual, flat fee, report in 5 to 7 business days; they are clinical diagnostic assessments, not psychological testing. How soon? Same-week openings are often available. Office hours? Monday to Friday, 8 AM to 5 PM Central. Cancellations? 24 hours' notice, or the full session fee is charged.",
    qualifies: "Adults and couples in Oklahoma, Colorado, Texas or Florida looking for therapy; children and teens in Oklahoma; adults in those four states who want an ADHD, autism or ADA accommodation evaluation",
    notFit: "Anyone in crisis: 988 or 911, and alert Ashley. Evaluations for anyone under 18, or IQ, neuropsychological or standardized testing: say we don't offer them and suggest a licensed psychologist. Children and teens outside Oklahoma, and anyone outside the four states: say we can't see them yet.",
    handoff: ["Billing questions", "Complaints", "Anything urgent", "Insurance questions"],
    hours: "8 AM to 8 PM",
    tone: "Warm",
    formality: "Conversational",
    never: "A therapist or time slot that isn't on the booking page, insurance coverage before it's verified, a diagnosis or evaluation result, or any clinical advice",
    ...VOICE_CLIENT,
    samples: "Warm",
    ...WORKING,
  },
  social: {
    goal: ["Bring in clients", "Recruit staff"],
    success90: "3 posts a week going out on time, sounding like Legacy, with people booking from them",
    first: "Instagram and Facebook posts on what to expect in therapy, couples counseling, adult evaluations and therapy for kids and teens",
    formality: "Conversational",
    emoji: "One at most",
    hashtags: "2 or 3 at the end",
    signOff: "Legacy Family Services",
    platforms: ["Instagram", "Facebook", "LinkedIn"],
    audience: "Adults and couples in Oklahoma, Colorado, Texas and Florida thinking about starting therapy",
    often: "3 a week",
    pillars: "What to expect in therapy; relationships and couples counseling (P.U.L.S.E.™); adult ADHD, autism and ADA accommodation evaluations; kids, teens and parents (play therapy with Amanda); everyday mental health tips; we're hiring",
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
    first: "An article on adult autism evaluations by telehealth, and one on asking for ADA accommodations at work",
    reader: "Clients and families",
    questions: "How to find a therapist in Oklahoma City, whether insurance covers therapy, what couples counseling is like, how adult ADHD and autism are evaluated, how to ask for ADA accommodations, therapy and play therapy for kids, whether online therapy works",
    topics: "Starting therapy, couples and relationships, kids and teens, parenting, adult ADHD and autism, workplace accommodations, anxiety, depression, trauma and grief, telehealth",
    keywords: "therapist Oklahoma City, couples counseling Oklahoma City, adult ADHD evaluation Oklahoma, adult autism evaluation online, ADA accommodation evaluation, play therapy Oklahoma, teen therapy Oklahoma City, online therapy Texas, online therapy Colorado, online therapy Florida",
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
    first: "An insurance and fees page that lists every plan and price in one place, then refresh the therapist profiles so each shows states, ages and plans the same way",
    visitors: "Adults, couples and families in Oklahoma, Colorado, Texas and Florida comparing therapists, and prescribers looking for assessments",
    pages: "Home, services, individual, couples, children and teens, play therapy, adult evaluations (ADHD, autism, ADA), state pages, team and therapist profiles, insurance and fees, careers (workatlegacy.org)",
    cta: "Book an appointment",
    diff: "Online therapy in four states with same-week openings; adults, couples, teens and children under one roof, including a Registered Play Therapist; most major insurance plans accepted; flat-fee adult ADHD, autism and ADA evaluations with a report in 5 to 7 business days; culturally competent, affirming care",
    proof: "Founded in 2015; five licensed therapists; owner has 18 years of clinical experience, is licensed in Oklahoma, Colorado, Texas and Florida, and was featured on TLC's My 600-lb Life and in InStyle",
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
    licenses: "LPC, LMFT or LCSW, fully licensed in Oklahoma. Colorado, Texas or Florida licenses are a plus for telehealth. A Registered Play Therapist credential is a plus.",
    where: "workatlegacy.org (Legacy's careers site)",
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
    if (cur === v) continue;
    if (!cur || (k === "timezone" && created) || cur === String(V1.profile[k] ?? "").trim()) filled[k] = v;
  }
  if (Object.keys(filled).length) await db.updateOrganization(org.id, filled);

  // Brain entries: skip titles that exist.
  const brain = await db.listKnowledgeByOrg(org.id);
  let brainAdded = 0;
  let brainUpdated = 0;
  for (const e of ENTRIES) {
    const cur = brain.find((k) => k.title.trim().toLowerCase() === e.title.toLowerCase());
    if (!cur) {
      const saved = await db.createKnowledgeItem({ organizationId: org.id, title: e.title, category: e.category as never, kind: "fact", content: e.content });
      if (saved) indexKnowledge(saved);
      brainAdded++;
      continue;
    }
    // Update only what this script wrote last time; your own edits stay.
    const old = V1.entries.find((x) => x.title === e.title);
    if (cur.content.trim() !== e.content.trim() && old && cur.content.trim() === old.content.trim()) {
      const saved = await db.updateKnowledgeItem(cur.id, org.id, { content: e.content });
      if (saved) indexKnowledge(saved);
      brainUpdated++;
    }
  }
  console.log(`Workspace: ${org.name} (#${org.id})${created ? " created" : ""}`);
  console.log(`Profile fields filled: ${Object.keys(filled).length ? Object.keys(filled).join(", ") : "none (already set)"}`);
  console.log(`Brain entries: ${brainAdded} added, ${brainUpdated} updated, ${ENTRIES.length - brainAdded - brainUpdated} already current or edited by you`);

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
      if (same(current[k], v)) continue;
      // Fill blanks, and update answers this script gave before; never overwrite your own answer.
      if (has && !same(current[k], V1.answers[kind]?.[k])) continue;
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
    console.log(`${emp.name} (${emp.roleTitle}): ${added} answers added or updated, ${lines} practice lines, ${missing.length} left for you${missing.length ? `: ${missing.map((q) => q.label).join("; ")}` : ""}`);
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
