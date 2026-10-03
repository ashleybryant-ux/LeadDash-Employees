import type { EmployeeKind } from "../../drizzle/schema";

/**
 * The onboarding interview for each job, like a new hire's first week.
 * Every interview starts with "From your Brain" (what the employee already
 * knows) and ends with "Working together". The parts in between are the job's
 * own. Each answer becomes a numbered line in the employee's Guidelines under
 * the section named in `guide`.
 *
 * Question keys that other code reads stay the same as before (style, always,
 * buffer, how, platforms, greatFit, interviewHours, interviewFormat, panel...).
 */

export type QType = "choice" | "multi" | "text" | "samples" | "examples";
export type IQuestion = {
  key: string;
  label: string;
  type: QType;
  options?: string[];
  placeholder?: string;
  note?: string;
  /** Short name used when the answer becomes a guideline line ("Formality: Conversational"). */
  short?: string;
  /** Guidelines section the answer goes to. */
  guide: string;
};
export type ISection = { key: string; title: string; intro: string; questions: IQuestion[] };
export type GuideSection = { key: string; title: string };
/** A fact the employee needs from the Brain. field: an organization field; entry: a Brain entry title. */
export type BrainNeed = { key: string; label: string; field?: "name" | "website" | "description" | "audience" | "brandColors" | "ein" | "entity" | "annualBudget" | "state"; entry?: string; category?: "mission_profile" | "voice_tone" | "services_offers" | "financial_data" | "speaking" | "team_bios"; placeholder?: string };
export type Interview = { brain: BrainNeed[]; sections: ISection[]; guides: GuideSection[]; samplesOf?: string; tryIt: { label: string; prompt: string } };

const OFTEN = ["Every day", "Twice a week", "Weekly", "Only when I ask"];
const TONE3 = ["Warm and personal", "Brief and direct", "Formal"];

const BASE_BRAIN: BrainNeed[] = [
  { key: "name", label: "Business", field: "name" },
  { key: "description", label: "What you do", field: "description", placeholder: "Group therapy practice offering individual, couples and family therapy" },
  { key: "audience", label: "Who you serve", field: "audience", placeholder: "Adults, couples and families in central Oklahoma" },
  { key: "website", label: "Website", field: "website", placeholder: "https://" },
];
const BOOKING: BrainNeed = { key: "booking", label: "Booking link", entry: "Booking link", category: "services_offers", placeholder: "https://" };
const COLORS: BrainNeed = { key: "brandColors", label: "Brand colors", field: "brandColors", placeholder: "Green #1b6b4a, orange #e88a3a" };

const job = (goalLabel: string, goalOptions: string[] | null, guide: string, extra: IQuestion[] = []): ISection => ({
  key: "job",
  title: "The job",
  intro: "What you hired me to do and what good looks like.",
  questions: [
    goalOptions ? { key: "goal", label: goalLabel, type: "multi", options: goalOptions, short: "Main goal", guide } : { key: "goal", label: goalLabel, type: "text", short: "Main goal", guide },
    { key: "success90", label: "In 90 days, what would make you say I'm doing great?", type: "text", placeholder: "Be specific: numbers, habits, what you stop doing yourself", short: "Success in 90 days", guide },
    { key: "first", label: "What should I work on first?", type: "text", short: "Start with", guide },
    ...extra,
  ],
});

const working = (guide = "working"): ISection => ({
  key: "working",
  title: "Working together",
  intro: "How you want to hear from me.",
  questions: [
    { key: "report", label: "How should I keep you posted?", type: "choice", options: ["A short daily summary", "A weekly summary", "Only when something needs me"], short: "Updates", guide },
    { key: "reach", label: "When something is urgent, how should I reach you?", type: "choice", options: ["Push notification", "Email", "Chat only"], short: "Urgent items", guide },
    { key: "know", label: "Anything else a new hire should know?", type: "text", placeholder: "Pet peeves, how you like things done, who to ask", short: "Good to know", guide },
  ],
});

const voice = (guide: string, extra: IQuestion[] = []): ISection => ({
  key: "voice",
  title: "Voice and tone",
  intro: "How you sound, so what I write sounds like you.",
  questions: [
    { key: "samples", label: "Which sounds most like you?", type: "samples", note: "Written from your Brain. Pick one, or write 3 more.", short: "Sounds like", guide },
    { key: "formality", label: "How formal?", type: "choice", options: ["Casual", "Conversational", "Professional", "Clinical"], short: "Formality", guide },
    { key: "reading", label: "Reading level", type: "choice", options: ["Plain (grade 6 to 8)", "Educated adult", "Clinician to clinician"], short: "Reading level", guide },
    { key: "wordsUse", label: "Words you always use", type: "text", placeholder: "therapy (not counseling), clinicians, families", short: "Always say", guide },
    { key: "wordsAvoid", label: "Words you never use", type: "text", placeholder: "crazy, broken, fix, journey, unlock", short: "Never say", guide },
    ...extra,
  ],
});

const examples = (what: string, guide: string): ISection => ({
  key: "examples",
  title: "Examples",
  intro: `Show me ${what} you liked and one you didn't. I study both.`,
  questions: [
    { key: "examples", label: `${what[0].toUpperCase()}${what.slice(1)} you liked, and one you didn't`, type: "examples", short: "Examples", guide },
    { key: "dislikeWhy", label: "What was wrong with the one you didn't like?", type: "multi", options: ["Too salesy", "Too casual", "Too clinical", "Clickbait", "Too long", "Not specific"], short: "Avoid writing that is", guide },
    { key: "soundLike", label: "Anyone you'd like to sound like?", type: "text", placeholder: "Accounts, writers or businesses", short: "Sound like", guide },
  ],
});

const brainSection: ISection = { key: "brain", title: "From your Brain", intro: "I read your Brain first, so I only ask what's missing. Fix anything that's wrong.", questions: [] };

const build = (brain: BrainNeed[], middle: ISection[], guides: GuideSection[], tryIt: Interview["tryIt"], samplesOf?: string): Interview => ({
  brain: [...BASE_BRAIN, ...brain],
  sections: [brainSection, ...middle, working()],
  guides: [...guides, { key: "working", title: "How should I work with you?" }],
  tryIt,
  samplesOf,
});

export const INTERVIEWS: Record<EmployeeKind, Interview> = {
  coo: build(
    [],
    [
      job("What should I take off your plate?", ["Running meetings", "Agendas", "Notes and action items", "The weekly scorecard", "Keeping teams on track"], "meetings"),
      {
        key: "meetings",
        title: "Your meetings",
        intro: "The meetings I'll run for you.",
        questions: [
          { key: "meetings", label: "Which meetings do you run, and how often?", type: "text", placeholder: "Leadership Mondays 9:00 AM; sales check-in Tuesdays 10:00 AM", short: "Meetings", guide: "meetings" },
          { key: "deciders", label: "Who makes the final call in each?", type: "text", placeholder: "Leadership: me. Sales: Caroline", short: "Final call", guide: "meetings" },
          { key: "style", label: "Agenda style", type: "choice", options: ["Short: decisions first", "Full: every team reports"], short: "Agenda style", guide: "agenda" },
          { key: "always", label: "Always on the agenda", type: "text", placeholder: "Cash on hand, open hiring, anything late", short: "Always on the agenda", guide: "agenda" },
          { key: "noMeet", label: "Meeting hours and no-meeting days", type: "text", placeholder: "No meetings before 9:30 AM or on Wednesdays", short: "Meeting hours", guide: "meetings" },
        ],
      },
      {
        key: "team",
        title: "Your team",
        intro: "Who does what, so I put the right people on each item.",
        questions: [
          { key: "team", label: "Who's on your team and what does each person own?", type: "text", placeholder: "Caroline: content and community. BJ: facilities and operations", short: "Team", guide: "team" },
          { key: "updatesFrom", label: "Who gives updates in meetings?", type: "text", placeholder: "Nora on launches, Jada and Malik on sales", short: "Updates from", guide: "team" },
        ],
      },
      {
        key: "scorecard",
        title: "Scorecard and notes",
        intro: "The numbers you watch and what goes in notes.",
        questions: [
          { key: "numbers", label: "Which numbers do you want every week?", type: "text", placeholder: "Demos booked, new clients, posts published, cash collected", short: "Weekly numbers", guide: "scorecard" },
          { key: "offTrack", label: "When a number is off track", type: "choice", options: ["Put it first on the next agenda", "Message me the same day", "Both"], short: "Off track", guide: "scorecard" },
          { key: "recapTo", label: "Who gets meeting recaps?", type: "choice", options: ["Only me", "Everyone who attended"], short: "Recaps go to", guide: "recaps" },
          { key: "keepOff", label: "Topics that never go in notes or recaps", type: "text", placeholder: "Pay, HR issues, client details", short: "Never in notes", guide: "recaps" },
        ],
      },
    ],
    [
      { key: "meetings", title: "How should I run meetings?" },
      { key: "agenda", title: "What goes on every agenda?" },
      { key: "team", title: "Who does what on your team?" },
      { key: "scorecard", title: "What numbers do you track?" },
      { key: "recaps", title: "What goes in notes and recaps?" },
    ],
    { label: "Write a test agenda", prompt: "Write the agenda for my next meeting." }
  ),

  projects: build(
    [],
    [
      job("What should I run for you?", ["Product launches", "Webinars", "Events", "Campaigns", "New services", "Hiring pushes"], "plans", [
        { key: "horizon", label: "How far ahead do you plan?", type: "choice", options: ["2 weeks", "1 month", "3 months", "6 months"], short: "Plan ahead", guide: "plans" },
      ]),
      {
        key: "owners",
        title: "Owners",
        intro: "Who I give tasks to.",
        questions: [
          { key: "owners", label: "Who owns what? Name each person's strengths.", type: "text", placeholder: "Caroline: content. BJ: vendors and space. Me: approvals", short: "Owners", guide: "owners" },
          { key: "approver", label: "Who approves a plan before it starts?", type: "text", placeholder: "Me", short: "Approves plans", guide: "owners" },
        ],
      },
      {
        key: "plans",
        title: "How you like plans",
        intro: "How I build and pace a plan.",
        questions: [
          { key: "buffer", label: "Finish tasks before their milestone by", type: "choice", options: ["1 day", "2 days", "1 week"], short: "Buffer before milestones", guide: "plans" },
          { key: "how", label: "How you like plans", type: "text", placeholder: "Small tasks, one owner each", short: "Plans", guide: "plans" },
          { key: "noDue", label: "Never make tasks due on", type: "multi", options: ["Mondays", "Fridays", "Weekends"], short: "No tasks due", guide: "plans" },
          { key: "done", label: "What does done mean for a task?", type: "text", placeholder: "Approved by the owner, not just drafted", short: "Done means", guide: "done" },
        ],
      },
      {
        key: "kpis",
        title: "Measuring a launch",
        intro: "How we know a launch worked.",
        questions: [
          { key: "kpis", label: "Which numbers prove a launch worked?", type: "text", placeholder: "20 demos, 8 practices signed, 150 webinar sign-ups", short: "Launch numbers", guide: "kpis" },
          { key: "reportStyle", label: "Weekly status report", type: "choice", options: ["Short: on track or not", "Full: every task"], short: "Report style", guide: "kpis" },
        ],
      },
    ],
    [
      { key: "plans", title: "How should I build plans?" },
      { key: "owners", title: "Who owns what?" },
      { key: "done", title: "What does done mean?" },
      { key: "kpis", title: "How do we measure a launch?" },
    ],
    { label: "Plan a test launch", prompt: "Plan a small test launch for 30 days from now so I can see how you build plans." }
  ),

  grants: build(
    [
      { key: "entity", label: "Legal entity", field: "entity", placeholder: "Legacy Family Services, LLC" },
      { key: "ein", label: "EIN", field: "ein", placeholder: "12-3456789" },
      { key: "annualBudget", label: "Annual budget", field: "annualBudget", placeholder: "$850,000" },
      { key: "state", label: "State", field: "state", placeholder: "Oklahoma" },
    ],
    [
      job("What should I apply for?", ["Grants", "Pitch competitions", "Accelerators", "Government contracts"], "fit", [
        { key: "often", label: "How often should I look?", type: "choice", options: OFTEN, short: "Look", guide: "fit" },
      ]),
      {
        key: "org",
        title: "Your organization",
        intro: "What every funder asks first.",
        questions: [
          { key: "status", label: "Tax status", type: "choice", options: ["501(c)(3) nonprofit", "LLC or for-profit", "Fiscal sponsor", "Not sure"], short: "Tax status", guide: "org" },
          { key: "sam", label: "SAM.gov registration", type: "choice", options: ["Registered, with a UEI", "In progress", "Not registered"], note: "Only federal awards need it. State, local and foundation grants don't.", short: "SAM.gov", guide: "org" },
          { key: "staff", label: "Staff size and service area", type: "text", placeholder: "14 clinicians; Oklahoma, Logan and Canadian counties", short: "Staff and area", guide: "org" },
          { key: "served", label: "People served per year", type: "text", placeholder: "About 1,200 clients in 2025", short: "Served per year", guide: "org" },
        ],
      },
      {
        key: "results",
        title: "Programs and results",
        intro: "What I can say you've done, with numbers.",
        questions: [
          { key: "programs", label: "Programs or services a funder would pay for", type: "text", placeholder: "Intern training clinic, rural telehealth, school-based counseling", short: "Programs", guide: "results" },
          { key: "outcomes", label: "Results with numbers", type: "text", placeholder: "82% of clients finished treatment in 2025", short: "Results", guide: "results" },
          { key: "awards", label: "Past grants and funders", type: "text", placeholder: "Inasmuch Foundation 2024, $25,000", short: "Past awards", guide: "results" },
        ],
      },
      {
        key: "fit",
        title: "What fits",
        intro: "Which opportunities are worth your time.",
        questions: [
          { key: "minAward", label: "Smallest award worth applying for", type: "choice", options: ["Any amount", "$5,000", "$10,000", "$25,000"], short: "Smallest award", guide: "fit" },
          { key: "region", label: "Where should funders be?", type: "choice", options: ["My state first, then national", "National only", "My state only"], short: "Funders", guide: "fit" },
          { key: "priorities", label: "What should funding pay for?", type: "text", placeholder: "Clinician hiring, intern supervision, rural access", short: "Funding pays for", guide: "fit" },
          { key: "match", label: "Can you match funds?", type: "choice", options: ["Yes, cash", "Yes, in-kind", "No match available"], short: "Match", guide: "fit" },
          { key: "autoStart", label: "When something scores 75 or higher", type: "choice", options: ["Start the application", "Ask me first"], short: "High scores", guide: "fit" },
          { key: "signer", label: "Who signs applications? Name and title", type: "text", placeholder: "Ashley R. Bryant, PhD, LPC, CRC, Owner", short: "Signs", guide: "signing" },
        ],
      },
      examples("past proposals or narratives", "writing"),
    ],
    [
      { key: "org", title: "What should funders know about us?" },
      { key: "results", title: "What results can I cite?" },
      { key: "fit", title: "What should I apply for?" },
      { key: "writing", title: "How should applications read?" },
      { key: "signing", title: "Who signs and approves?" },
    ],
    { label: "Find grants now", prompt: "Find grants that fit us this quarter." }
  ),

  speaking: build(
    [],
    [
      job("What kind of speaking?", ["Conferences", "Webinars", "Podcasts", "Panels", "Workshops"], "talks"),
      {
        key: "talks",
        title: "Your talks",
        intro: "What I pitch.",
        questions: [
          { key: "topics", label: "Talks you give best (titles)", type: "text", placeholder: "Building a practice that pays you back; the P.U.L.S.E. Framework", short: "Talks", guide: "talks" },
          { key: "abstracts", label: "One takeaway for each talk", type: "text", placeholder: "Practice owners leave with a 90-day hiring plan", short: "Takeaways", guide: "talks" },
        ],
      },
      {
        key: "bio",
        title: "Bio and media",
        intro: "How I introduce you.",
        questions: [
          { key: "bioShort", label: "Short bio (2 sentences)", type: "text", short: "Short bio", guide: "bio" },
          { key: "credentials", label: "Credentials to always list", type: "text", placeholder: "PhD, LPC, CRC", short: "Credentials", guide: "bio" },
          { key: "pastEvents", label: "Past events and testimonials", type: "text", placeholder: "100+ talks; ACA 2025; NABC 2024", short: "Past events", guide: "bio" },
        ],
      },
      {
        key: "terms",
        title: "Fees, travel and audiences",
        intro: "What's worth saying yes to.",
        questions: [
          { key: "paid", label: "Pay", type: "choice", options: ["Paid only", "Paid or visibility", "Anything that fits"], short: "Pay", guide: "terms" },
          { key: "fee", label: "Your fee or range", type: "text", placeholder: "$2,500 to $5,000 keynote; $750 webinar", short: "Fee", guide: "terms" },
          { key: "travel", label: "Travel", type: "choice", options: ["Virtual only", "In my state", "Anywhere in the US"], short: "Travel", guide: "terms" },
          { key: "blackout", label: "Dates you can't speak", type: "text", placeholder: "Last two weeks of December", short: "Unavailable", guide: "terms" },
          { key: "want", label: "Audiences you want", type: "text", placeholder: "Counselors, practice owners, HBCU programs", short: "Pitch to", guide: "audience" },
          { key: "avoidAud", label: "Audiences or events to avoid", type: "text", short: "Avoid", guide: "audience" },
          { key: "often", label: "How often should I look?", type: "choice", options: OFTEN, short: "Look", guide: "terms" },
        ],
      },
      voice("pitch"),
    ],
    [
      { key: "talks", title: "What do I pitch?" },
      { key: "bio", title: "How should I introduce you?" },
      { key: "terms", title: "Fees, travel and dates" },
      { key: "audience", title: "Who should I pitch to?" },
      { key: "pitch", title: "How should pitches sound?" },
    ],
    { label: "Find events now", prompt: "Find speaking events taking proposals that fit me." },
    "a speaker pitch email opening"
  ),

  prospecting: build(
    [],
    [
      job("Who am I finding?", ["Customers", "Referral partners", "Both"], "fit", [
        { key: "often", label: "How often should I look?", type: "choice", options: OFTEN, short: "Look", guide: "fit" },
        { key: "weekly", label: "Prospects a week", type: "choice", options: ["10", "25", "50", "100"], short: "Prospects a week", guide: "fit" },
      ]),
      {
        key: "fit",
        title: "Ideal customer",
        intro: "Who's a great fit.",
        questions: [
          { key: "size", label: "Smallest fit", type: "choice", options: ["Solo practices", "2 or more clinicians", "5 or more clinicians", "10 or more clinicians"], short: "Smallest fit", guide: "fit" },
          { key: "specialty", label: "Specialties", type: "multi", options: ["Mental health", "Substance use", "ABA and autism", "Psychiatry", "Medical", "Any"], short: "Specialties", guide: "fit" },
          { key: "payer", label: "Payer mix", type: "choice", options: ["Takes insurance", "Private pay", "Either"], short: "Payer mix", guide: "fit" },
          { key: "states", label: "States or cities", type: "text", placeholder: "Oklahoma and Texas", short: "Where", guide: "fit" },
          { key: "ideal", label: "What makes a great fit?", type: "text", placeholder: "Group practices that take insurance and book by phone", short: "Great fit", guide: "fit" },
        ],
      },
      {
        key: "signals",
        title: "Signals and skips",
        intro: "What makes me move fast, and who I leave alone.",
        questions: [
          { key: "signals", label: "Buying signals", type: "multi", options: ["Hiring clinicians", "Books by phone only", "No online paperwork", "Opening a new location", "Bad reviews about scheduling"], short: "Signals", guide: "signals" },
          { key: "decider", label: "Who decides?", type: "multi", options: ["Owner", "Practice manager", "Clinical director", "Office manager"], short: "Reach", guide: "contact" },
          { key: "skip", label: "Who should I skip?", type: "text", placeholder: "Hospital systems, current customers", short: "Skip", guide: "skip" },
          { key: "competitors", label: "Systems they might use now", type: "text", placeholder: "SimplePractice, TherapyNotes", short: "Current systems", guide: "signals" },
        ],
      },
    ],
    [
      { key: "fit", title: "Who is a great fit?" },
      { key: "skip", title: "Who should I skip?" },
      { key: "signals", title: "What buying signals matter?" },
      { key: "contact", title: "Who should I reach?" },
    ],
    { label: "Find prospects now", prompt: "Find 10 prospects that fit and show me the best 3." }
  ),

  outreach: build(
    [BOOKING],
    [
      job("What should outreach get?", ["Demos", "Consultations", "Partnerships", "Replies"], "offer"),
      {
        key: "offer",
        title: "Offer and proof",
        intro: "What I offer and what I can honestly say.",
        questions: [
          { key: "offer", label: "What to offer", type: "choice", options: ["A 20-minute demo", "A free consultation", "A short call"], short: "Offer", guide: "offer" },
          { key: "cta", label: "What should every email ask for?", type: "text", placeholder: "Pick a time for a 20-minute demo", short: "Ask for", guide: "offer" },
          { key: "proof", label: "Something true to mention", type: "text", placeholder: "Practices book intakes online and paperwork is done before the first session", short: "Proof", guide: "proof" },
          { key: "results", label: "Results with numbers you can share", type: "text", short: "Results", guide: "proof" },
        ],
      },
      {
        key: "objections",
        title: "Objections",
        intro: "What people push back on, and your answers.",
        questions: [{ key: "objections", label: "Common objections and your answers", type: "text", placeholder: "\"We already have an EHR\": we move your clients over for you", short: "Objections", guide: "objections" }],
      },
      voice("voice", [
        { key: "tone", label: "Tone", type: "choice", options: TONE3, short: "Tone", guide: "voice" },
        { key: "signOff", label: "Sign-off name and title", type: "text", placeholder: "Ashley Bryant, LPC, CRC, LeadDash", short: "Sign as", guide: "voice" },
        { key: "address", label: "Mailing address for the email footer", type: "text", note: "The law requires one on sales email.", short: "Footer address", guide: "rules" },
      ]),
      examples("outreach emails", "voice"),
    ],
    [
      { key: "offer", title: "What am I offering?" },
      { key: "proof", title: "What proof can I use?" },
      { key: "objections", title: "How do I answer objections?" },
      { key: "voice", title: "How should emails sound?" },
      { key: "rules", title: "What should I never say?" },
    ],
    { label: "Write a test email", prompt: "Write a first outreach email to a sample prospect so I can see your tone." },
    "the first two sentences of a cold outreach email"
  ),

  leads: build(
    [BOOKING],
    [
      job("What should I do with new leads?", ["Book meetings", "Answer questions", "Send pricing", "Hand hot leads to me"], "booking"),
      {
        key: "services",
        title: "Services and prices",
        intro: "What I can tell people.",
        questions: [
          { key: "services", label: "Services to talk about", type: "text", short: "Services", guide: "services" },
          { key: "prices", label: "Prices", type: "choice", options: ["Share prices", "Share a range", "Never share prices"], short: "Prices", guide: "services" },
          { key: "priceList", label: "Prices or ranges you're OK sharing", type: "text", short: "Price list", guide: "services" },
          { key: "faqs", label: "Questions leads ask most, with your answers", type: "text", placeholder: "Do you take Medicaid? Yes, SoonerCare for adults", short: "FAQs", guide: "faqs" },
        ],
      },
      {
        key: "booking",
        title: "Booking rules",
        intro: "Who I book and who I send to you.",
        questions: [
          { key: "qualifies", label: "Who is a good fit to book?", type: "text", short: "Book", guide: "booking" },
          { key: "notFit", label: "Where to send people who aren't a fit", type: "text", short: "Not a fit", guide: "booking" },
          { key: "handoff", label: "Always hand these to me", type: "multi", options: ["Billing questions", "Complaints", "Anything urgent", "Insurance questions"], short: "Hand to you", guide: "booking" },
          { key: "hours", label: "When should I reply?", type: "choice", options: ["Any time", "8 AM to 8 PM", "Business hours only"], short: "Reply hours", guide: "booking" },
        ],
      },
      voice("voice", [
        { key: "tone", label: "Reply tone", type: "choice", options: ["Warm", "Brief and direct", "Formal"], short: "Tone", guide: "voice" },
        { key: "never", label: "Never promise", type: "text", placeholder: "Prices not on the website, dates I have not confirmed", short: "Never promise", guide: "rules" },
      ]),
    ],
    [
      { key: "services", title: "What can I tell leads?" },
      { key: "faqs", title: "How do I answer common questions?" },
      { key: "booking", title: "Who should I book?" },
      { key: "voice", title: "How should replies sound?" },
      { key: "rules", title: "What should I never promise?" },
    ],
    { label: "Write a test reply", prompt: "Write a reply to a sample lead who asked about pricing and availability." },
    "a first reply to a new lead"
  ),

  social: build(
    [COLORS, BOOKING],
    [
      job("What should posts do?", ["Bring in clients", "Build my name", "Recruit staff", "Sell a product"], "themes"),
      voice("writing", [
        { key: "emoji", label: "Emoji", type: "choice", options: ["None", "One at most", "A few"], short: "Emoji", guide: "writing" },
        { key: "hashtags", label: "Hashtags", type: "choice", options: ["None", "2 or 3 at the end", "Only on Instagram"], short: "Hashtags", guide: "writing" },
        { key: "signOff", label: "How you sign off", type: "text", placeholder: "Dr. Ashley · Legacy Family Services", short: "Sign-off", guide: "writing" },
      ]),
      {
        key: "audience",
        title: "Your audience",
        intro: "Who you're talking to and where.",
        questions: [
          { key: "platforms", label: "Where do you post?", type: "multi", options: ["LinkedIn", "Instagram", "Facebook", "X", "Threads"], short: "Platforms", guide: "themes" },
          { key: "audience", label: "Who are you talking to?", type: "text", placeholder: "Couples and parents of teens in OKC; clinicians on LinkedIn", short: "Audience", guide: "themes" },
          { key: "often", label: "How many posts?", type: "choice", options: ["Every weekday", "3 a week", "Weekly"], short: "Posts", guide: "themes" },
        ],
      },
      {
        key: "content",
        title: "Content and images",
        intro: "What you post about and how it looks.",
        questions: [
          { key: "pillars", label: "3 to 5 topics you post about", type: "text", placeholder: "Couples, parenting teens, what therapy is like, our team", short: "Topics", guide: "themes" },
          { key: "imageStyle", label: "Image style", type: "choice", options: ["Photos", "Illustrations", "Photos for people, illustrations for ideas", "Text graphics"], short: "Images", guide: "image" },
          { key: "imageNotes", label: "Image notes", type: "text", placeholder: "Brand colors, real people, no stock handshakes", short: "Image notes", guide: "image" },
          { key: "avoid", label: "Never post about", type: "text", placeholder: "Client stories, politics, prices", short: "Never post", guide: "rules" },
          { key: "composites", label: "Can I write made-up examples?", type: "choice", options: ["Yes, labeled as made up", "No, never"], short: "Made-up examples", guide: "rules" },
        ],
      },
      examples("posts", "writing"),
    ],
    [
      { key: "themes", title: "Content themes" },
      { key: "image", title: "Image style" },
      { key: "writing", title: "Writing style" },
      { key: "rules", title: "What should I never post?" },
    ],
    { label: "Write a test post", prompt: "Write a test post for my main platform." },
    "a short social post"
  ),

  blog: build(
    [],
    [
      job("What should the blog do?", ["Bring in clients", "Rank on Google", "Build my name", "Teach other clinicians"], "topics"),
      {
        key: "readers",
        title: "Readers and topics",
        intro: "Who reads and what they search for.",
        questions: [
          { key: "reader", label: "Who reads the blog?", type: "choice", options: ["Clients and families", "Other clinicians", "Practice owners"], short: "Readers", guide: "readers" },
          { key: "questions", label: "What do readers search for?", type: "text", placeholder: "Does insurance cover couples counseling?", short: "Searches", guide: "readers" },
          { key: "topics", label: "Topics to cover", type: "text", placeholder: "Couples counseling, anxiety in teens, insurance questions", short: "Topics", guide: "topics" },
          { key: "keywords", label: "Search terms to rank for", type: "text", placeholder: "couples therapy OKC, family counseling Edmond", short: "Keywords", guide: "topics" },
        ],
      },
      {
        key: "structure",
        title: "How articles are built",
        intro: "Length, sources and the ending.",
        questions: [
          { key: "length", label: "Length", type: "choice", options: ["800 words", "1,200 words", "2,000 words"], short: "Length", guide: "structure" },
          { key: "often", label: "How many articles?", type: "choice", options: ["Weekly", "Twice a month", "Monthly"], short: "Articles", guide: "structure" },
          { key: "citations", label: "Sources", type: "choice", options: ["Cite a source for every fact", "Cite studies only", "No citations needed"], short: "Sources", guide: "structure" },
          { key: "cta", label: "Call to action at the end", type: "text", placeholder: "Book a first session", short: "Ending", guide: "structure" },
          { key: "author", label: "Author name and short bio", type: "text", short: "Author", guide: "writing" },
        ],
      },
      voice("writing"),
      examples("articles", "writing"),
    ],
    [
      { key: "readers", title: "Who am I writing for?" },
      { key: "topics", title: "What should I write about?" },
      { key: "structure", title: "How should articles be built?" },
      { key: "writing", title: "Writing style" },
    ],
    { label: "Write a test intro", prompt: "Write the opening paragraph and outline for an article on one of my topics." },
    "the first paragraph of a blog article"
  ),

  website: build(
    [COLORS, BOOKING],
    [
      job("What should the site do most?", ["Book consultations", "Sell a product", "Recruit staff", "Build trust"], "goals"),
      {
        key: "pages",
        title: "Pages and visitors",
        intro: "Which pages, and who each one is for.",
        questions: [
          { key: "visitors", label: "Who visits your site?", type: "text", short: "Visitors", guide: "goals" },
          { key: "pages", label: "Pages to work on first", type: "text", placeholder: "Home, couples counseling, careers", short: "Pages", guide: "pages" },
          { key: "cta", label: "Main call to action", type: "text", placeholder: "Book a free 15-minute call", short: "Call to action", guide: "pages" },
        ],
      },
      {
        key: "diff",
        title: "What sets you apart",
        intro: "Why someone picks you.",
        questions: [
          { key: "diff", label: "What makes you different from others nearby?", type: "text", short: "Different", guide: "diff" },
          { key: "proof", label: "Proof: reviews, credentials, years, numbers", type: "text", short: "Proof", guide: "diff" },
          { key: "likes", label: "Sites you like and why", type: "text", short: "Sites you like", guide: "diff" },
        ],
      },
      voice("writing", [{ key: "voice", label: "Voice", type: "choice", options: ["Warm and personal", "Expert and direct", "Simple and short"], short: "Voice", guide: "writing" }]),
    ],
    [
      { key: "goals", title: "What should the site do?" },
      { key: "pages", title: "Which pages and for whom?" },
      { key: "diff", title: "What sets you apart?" },
      { key: "writing", title: "How should copy sound?" },
    ],
    { label: "Plan a test page", prompt: "Plan my home page section by section." },
    "a website headline and the line under it"
  ),

  video: build(
    [COLORS],
    [
      job("What should videos do?", ["Bring in clients", "Build my name", "Recruit staff", "Teach"], "format"),
      {
        key: "format",
        title: "Platforms and format",
        intro: "Where videos go and how long.",
        questions: [
          { key: "platforms", label: "Where do videos go?", type: "multi", options: ["TikTok", "Instagram Reels", "YouTube Shorts"], short: "Platforms", guide: "format" },
          { key: "length", label: "Length", type: "choice", options: ["Under 30 seconds", "30 to 60 seconds", "1 to 3 minutes"], short: "Length", guide: "format" },
          { key: "often", label: "How many plans a week?", type: "choice", options: ["1", "2", "3", "5"], short: "Plans a week", guide: "format" },
          { key: "captions", label: "Captions", type: "choice", options: ["Captions on every video", "No captions"], short: "Captions", guide: "format" },
        ],
      },
      {
        key: "camera",
        title: "On camera",
        intro: "Who and what can be filmed.",
        questions: [
          { key: "onCamera", label: "Who is on camera?", type: "choice", options: ["Me", "My team", "No faces, text and b-roll"], short: "On camera", guide: "camera" },
          { key: "avoid", label: "Never film", type: "text", placeholder: "Clients, the waiting room", short: "Never film", guide: "rules" },
          { key: "where", label: "Where do you film?", type: "text", placeholder: "My office, the group room", short: "Film at", guide: "camera" },
          { key: "gear", label: "Equipment", type: "choice", options: ["Phone only", "Phone and mic", "Full setup"], short: "Equipment", guide: "camera" },
        ],
      },
      voice("style", [{ key: "style", label: "Style", type: "choice", options: ["Teaching", "Story", "Trend-based", "Mix"], short: "Style", guide: "style" }]),
      examples("videos", "style"),
    ],
    [
      { key: "format", title: "Where and how long?" },
      { key: "camera", title: "Who and what is on camera?" },
      { key: "style", title: "What style of video?" },
      { key: "rules", title: "What should never be filmed?" },
    ],
    { label: "Plan a test video", prompt: "Plan one short video for this week with a hook and shot list." },
    "a video hook (the first line spoken on camera)"
  ),

  inbox: build(
    [],
    [
      job("What should I take off your plate?", ["Drafting replies", "Sorting what's urgent", "Scheduling meetings", "Follow-ups"], "reply"),
      {
        key: "inbox",
        title: "Your inbox",
        intro: "Who writes to you and what matters.",
        questions: [
          { key: "who", label: "Who emails you most?", type: "text", placeholder: "Referral sources, payers, staff, vendors", short: "Who emails", guide: "reply" },
          { key: "urgent", label: "What counts as urgent?", type: "text", placeholder: "Payers, current clients, my attorney", short: "Urgent", guide: "reply" },
          { key: "archive", label: "What can wait or be ignored?", type: "text", placeholder: "Newsletters, cold sales emails", short: "Can wait", guide: "archive" },
        ],
      },
      {
        key: "replies",
        title: "Replies",
        intro: "What I draft and what I leave alone.",
        questions: [
          { key: "replyTo", label: "Which emails should I draft replies to?", type: "text", placeholder: "Referral sources, families, staff", short: "Draft replies to", guide: "reply" },
          { key: "noReply", label: "Which should I never reply to?", type: "text", placeholder: "Cold sales emails from people you've never written to", short: "Never reply to", guide: "reply" },
          { key: "never", label: "Never promise", type: "text", placeholder: "Discounts, dates I have not confirmed", short: "Never promise", guide: "rules" },
        ],
      },
      {
        key: "calendar",
        title: "Calendar",
        intro: "How you like meetings scheduled.",
        questions: [
          { key: "slots", label: "Default meeting length", type: "choice", options: ["15 minutes", "30 minutes", "45 minutes", "60 minutes"], short: "Meeting length", guide: "calendar" },
          { key: "hours", label: "Meeting hours and no-meeting days", type: "text", placeholder: "No meetings before 9:30 AM or on Wednesdays", short: "Meeting hours", guide: "calendar" },
          { key: "buffer", label: "Time between meetings", type: "choice", options: ["None", "10 minutes", "15 minutes", "30 minutes"], short: "Between meetings", guide: "calendar" },
        ],
      },
      voice("writing", [
        { key: "tone", label: "Reply tone", type: "choice", options: TONE3, short: "Tone", guide: "writing" },
        { key: "signature", label: "Email signature", type: "text", placeholder: "Dr. Ashley Bryant, LPC, CRC", short: "Signature", guide: "writing" },
      ]),
    ],
    [
      { key: "writing", title: "How should I write emails?" },
      { key: "reply", title: "Which emails should I draft a reply to, and which not?" },
      { key: "archive", title: "What can wait?" },
      { key: "calendar", title: "How do you like meetings scheduled?" },
      { key: "rules", title: "What should I never promise?" },
    ],
    { label: "Draft a test reply", prompt: "Draft a reply to a sample email from a referral source asking about openings." },
    "the opening of an email reply"
  ),

  hiring: build(
    [{ key: "state", label: "State", field: "state", placeholder: "Oklahoma" }],
    [
      job("Who are you hiring most?", ["Licensed clinicians", "Interns and candidates", "Front desk and billing", "Developers", "Sales"], "roles", [
        { key: "often", label: "How often should I look for people?", type: "choice", options: OFTEN, short: "Look", guide: "rules" },
      ]),
      {
        key: "roles",
        title: "Roles and must-haves",
        intro: "What every hire needs.",
        questions: [
          { key: "mustHave", label: "Must-haves for every hire", type: "text", placeholder: "Oklahoma license, 2 evenings a week, telehealth", short: "Must-haves", guide: "roles" },
          { key: "licenses", label: "Licenses and states accepted", type: "text", placeholder: "LPC, LMFT, LCSW; Oklahoma", short: "Licenses", guide: "roles" },
          { key: "greatFit", label: "What makes someone a great fit at your practice?", type: "text", placeholder: "Warm with families, organized with notes, open to feedback", short: "Great fit", guide: "roles" },
        ],
      },
      {
        key: "offer",
        title: "Pay and culture",
        intro: "What I can tell candidates.",
        questions: [
          { key: "pay", label: "Pay ranges by role", type: "text", placeholder: "LPC $40 to $55 an hour; intern $20", short: "Pay", guide: "offer" },
          { key: "benefits", label: "Benefits", type: "text", placeholder: "Free supervision, CEU budget, flexible schedule", short: "Benefits", guide: "offer" },
        ],
      },
      {
        key: "interviews",
        title: "Interviews and rules",
        intro: "How hiring runs here.",
        questions: [
          { key: "interviewFormat", label: "Interviews", type: "choice", options: ["Video call", "In person", "Either"], short: "Format", guide: "interviews" },
          { key: "interviewHours", label: "Interview hours", type: "text", placeholder: "Tue and Thu, 10:00 AM to 2:00 PM", short: "Hours", guide: "interviews" },
          { key: "panel", label: "Who else interviews", type: "text", placeholder: "Name and title", short: "Panel", guide: "interviews" },
          { key: "outreach", label: "Outreach", type: "choice", options: ["Find people and draft messages", "Applicants only, no outreach"], short: "Outreach", guide: "rules" },
          { key: "screening", label: "Who screens first?", type: "choice", options: ["Quinn scores, I decide", "Show me every applicant unscored"], short: "Screening", guide: "rules" },
          { key: "where", label: "Where should jobs be posted?", type: "text", placeholder: "Indeed, Psychology Today, LinkedIn, university boards", short: "Post jobs on", guide: "rules" },
        ],
      },
    ],
    [
      { key: "roles", title: "Who are we hiring?" },
      { key: "offer", title: "Pay, benefits and culture" },
      { key: "interviews", title: "How do interviews work?" },
      { key: "rules", title: "Hiring rules" },
    ],
    { label: "Write a test job post", prompt: "Write a job post for my most common opening." }
  ),

  custom: build(
    [],
    [
      job("What should this employee do for you?", null, "job", [{ key: "often", label: "How often?", type: "choice", options: ["Every day", "Weekly", "Only when I ask"], short: "How often", guide: "job" }]),
      voice("writing"),
    ],
    [
      { key: "job", title: "What is my job?" },
      { key: "writing", title: "How should I write?" },
      { key: "rules", title: "What should I never do?" },
    ],
    { label: "Try a task", prompt: "Show me a small example of your work." },
    "a short message"
  ),
};

/** Every question in the interview except the Brain part, in order. */
export function allQuestions(kind: EmployeeKind) {
  return INTERVIEWS[kind].sections.flatMap((s) => s.questions.map((q) => ({ ...q, section: s.key })));
}
