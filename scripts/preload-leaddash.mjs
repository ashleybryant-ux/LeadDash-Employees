#!/usr/bin/env node
/**
 * One-time preload for Ashley's own LeadDash workspace: fills the workspace
 * profile (only fields that are still empty) and adds Brain entries with what
 * is already known about LeadDash. New tenants never get this; it only touches
 * the workspace named "LeadDash".
 *
 *   cd /home/ssm-user/employees && node scripts/preload-leaddash.mjs
 *
 * Safe to run twice: entries whose title already exists are skipped.
 */
import "dotenv/config";
import path from "node:path";
import Database from "better-sqlite3";

const file = path.resolve(process.env.DATABASE_PATH || "./data/employees.db");
const db = new Database(file);
db.pragma("busy_timeout = 5000");

const orgs = db.prepare("SELECT id, name FROM organizations WHERE lower(trim(name)) LIKE 'leaddash%'").all();
const org = orgs.find((o) => o.name.trim().toLowerCase() === "leaddash") ?? orgs[0];
if (!org) {
  console.log('No workspace named "LeadDash" yet. Create it in the app (LD menu, New workspace, name it LeadDash), then run this again.');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);

// ---------- Workspace profile (only empty fields are filled) ----------

const profile = {
  website: "leaddash.io",
  state: "Oklahoma City, OK",
  entity: "LeadDash Marketing LLC (d/b/a LeadDash), for-profit",
  description:
    "HIPAA-compliant platform that combines an EHR, insurance billing, marketing automation, a 24/7 receptionist and a CRM, built for mental health private practices.",
  audience:
    "Solo and group mental health private practice owners and their staff. The marketing side also serves organizations outside therapy, such as a mental health conference.",
  focusAreas:
    "Mental health practice operations, EHR and insurance billing, practice marketing automation, behavioral health technology, clinician workforce",
  brandColors: "#0d3b2e, #e88a3a",
  signerName: "Ashley R. Bryant",
  signerTitle: "Founder and CEO",
};
const current = db.prepare("SELECT * FROM organizations WHERE id = ?").get(org.id);
const filled = [];
for (const [k, v] of Object.entries(profile)) {
  if (!current[k] || !String(current[k]).trim()) {
    db.prepare(`UPDATE organizations SET ${k} = ?, updatedAt = ? WHERE id = ?`).run(v, now, org.id);
    filled.push(k);
  }
}

// ---------- Brain entries ----------

const entries = [
  {
    category: "mission_profile",
    title: "What LeadDash is",
    content: `LeadDash is a HIPAA-compliant software platform for mental health private practices. It combines an EHR, insurance billing, marketing automation, a 24/7 receptionist and a CRM in one system, so a practice runs its clinical work and its growth from one place and one bill.

Tagline: "The growth platform for private practice."
Homepage headline: "Fill your calendar. Run your practice. One platform."

Company: LeadDash Marketing LLC (d/b/a LeadDash), a for-profit company based in Oklahoma City, Oklahoma. Business address: 11901 N. MacArthur Blvd, Suite C6, Oklahoma City, OK 73162. Website: leaddash.io.`,
  },
  {
    category: "mission_profile",
    title: "Founder story",
    content: `In the founder's words: "I'm a licensed therapist who got tired of my EHR and my marketing living in two different worlds, so I built one that does both. Now I help other therapists grow their practices without choosing between great clinical tools and great marketing."

Ashley R. Bryant, PhD, LPC, CRC, founded LeadDash. She owns Legacy Family Services, a group therapy practice in Oklahoma City that runs on LeadDash, and has 18 years of clinical experience. The DoorDash trademark win is part of the company story, not the founder story.`,
  },
  {
    category: "team_bios",
    title: "Founder bio: Ashley R. Bryant",
    content: `Ashley R. Bryant, PhD, LPC, CRC. Founder and CEO of LeadDash.
- Licensed Professional Counselor in Oklahoma, Colorado and Texas; Licensed Mental Health Counselor in Florida; Certified Rehabilitation Counselor.
- PhD in Workforce and Adult Education, Oklahoma State University. MS in Rehabilitation Counseling, Langston University (2012).
- 18 years of clinical experience, with an extensive background in vocational rehabilitation and disability employment.
- Owner of Legacy Family Services, a group therapy practice in Oklahoma City.
- More than 100 speaking engagements.
- Featured on TLC, PBS, FOX, US Weekly and Daily Mail.
- Creator of the P.U.L.S.E.™ Framework (federally registered trademark) and author of Love with P.U.L.S.E.
Name use: "Ashley R. Bryant, LPC, CRC" for clinician audiences; "Dr. Ashley" in other client-facing marketing.`,
  },
  {
    category: "team_bios",
    title: "Team and support",
    content: `Ashley R. Bryant leads product and the company. Caroline is the full-time content and community manager. In messages to customers, product work is credited to "the development team."

Member support: LeadDash University (the member course and community where members post questions), a weekly Q&A call, knowledge base articles and 24/7 chat support on the marketing side, and a client success assistant. An in-app course walks new members through setup step by step.`,
  },
  {
    category: "services_offers",
    title: "What the platform includes",
    content: `EHR
- Progress notes with DashNotes™ AI note taking (session transcription and note drafting), treatment plans with a practice library, supervision and co-signature for interns, group session notes, prescriber notes and an EAP tracker.
- Client portal with paperwork, documents, billing and session booking.
- Native telehealth built into the platform (no separate video vendor) with per-clinician rooms and a waiting room.
- Mobile app (installable app with passkey sign-in), records export, audit trail.

Insurance billing
- Electronic claim submission, electronic remittance (ERA) with automatic payment posting, secondary claims, payer enrollment, and insurance eligibility checks.
- Invoicing and card payments, with the EHR ledger as the record of charges, payments and adjustments.
- Provider collections and payroll reporting.

Communication and marketing
- eFax with the practice's own fax number.
- HIPAA-compliant phone and texting, with calls, transcripts and texts saved to the client's chart.
- Marketing automation and CRM, booking pages, and a 24/7 receptionist each practice can name.`,
  },
  {
    category: "services_offers",
    title: "Plans and pricing",
    content: `- Plans: Core, Complete, Practice and Agency. Core is $99 a month (a move to $129 is under consideration). Each plan has a set number of clinician seats.
- Insurance billing and fax are included on every plan.
- Insurance eligibility checks: 1,000 per practice per month included; packs of 250 for $99, 500 for $179 and 1,000 for $299.
- Fax: 100 outbound pages per practice per month included; packs of 100 pages for $15 and 250 for $29. Incoming faxes are never capped.
- Texting: up to 4,000 texts a month per practice.
- Communications usage (texts, calls, phone numbers, email) is billed at 1.5 times the underlying carrier rates.
- Founding members keep a locked rate with insurance billing and AI notes included.
- No free trials. Prospects use a sandbox demo at demo.leaddash.io.`,
  },
  {
    category: "services_offers",
    title: "What sets LeadDash apart",
    content: `- One platform and one bill in place of the separate EHR, billing, fax, phone, texting, telehealth, marketing and receptionist tools a practice usually pays for ("one bill replaces eight subscriptions").
- Built by a practicing licensed therapist who runs her own group practice on it.
- Native fax: neither SimplePractice nor TherapyNotes ships fax built in. Practices can port an existing fax number in free.
- Telehealth is built in rather than resold from a video vendor.
- Clinical tools and marketing live in the same system, so a new lead becomes a client and a chart without changing tools.`,
  },
  {
    category: "past_performance",
    title: "Traction",
    content: `- Five founding member practices as of June 2026; actively marketing since.
- An enterprise group practice account was scheduled to go live October 1, 2026 [CONFIRM IT IS LIVE].
- Ashley's own group practice, Legacy Family Services, runs its clinical, billing and marketing work on LeadDash.
- Current figures to fill in before using: [NUMBER] practices live, [NUMBER] clinicians, [MONTHLY RECURRING REVENUE].`,
  },
  {
    category: "past_performance",
    title: "Federal trademark win against DoorDash",
    content: `LeadDash defended its federal trademark pro se against an opposition filed by DoorDash. The opposition was dismissed with prejudice in February 2026, and the registration issued April 28, 2026 (U.S. Registration No. 8,227,151). It is part of the company story and works as a media hook.`,
  },
  {
    category: "certifications_licenses",
    title: "Compliance and agreements",
    content: `- LeadDash is HIPAA-compliant and offers practices a Business Associate Agreement (part of the LeadDash Subscription and Services Agreement as Exhibit B, with subprocessors and security measures schedules).
- Infrastructure and AI vendors that handle health information are covered by BAAs, including Amazon Web Services and the AI transcription and note-writing service.
- The LeadDash name is a federally registered trademark (U.S. Registration No. 8,227,151). DashNotes™ and the P.U.L.S.E.™ Framework are marked with the trademark symbol.`,
  },
  {
    category: "financial_data",
    title: "Funding and unit economics",
    content: `- Revenue model: monthly SaaS subscriptions by plan, plus usage packs (eligibility checks, fax pages) and communications usage billed at 1.5 times carrier cost.
- Recurring cost per practice account is low: the claims clearinghouse is about $40 a month per tax ID, and texts, calls and email are passed through to the practice.
- Past funding applications: Amber Grant and HHS SBIR Phase I.
- Plans for fall 2026: more grants and pitch competitions for LeadDash.
- Figures to fill in: [ANNUAL REVENUE], [AMOUNT RAISED TO DATE], [AMOUNT BEING RAISED].`,
  },
  {
    category: "mission_profile",
    title: "Roadmap",
    content: `- E-prescribing built into the EHR in the next phase of development (no date quoted); prescribers keep their current e-prescribing tool meanwhile.
- In-app acceptance of the service agreement at first sign-in.
- A guided setup screen for a practice's own HIPAA-compliant phone number.
- AI employees (LeadDash Employees) for grants, speaking, social media, blog, website, video and inbox work.`,
  },
  {
    category: "speaking",
    title: "Speaking",
    content: `- More than 100 speaking engagements.
- Topics: private practice operations and growth, clinicians moving from agency work to private practice, intern supervision as a hiring pipeline, ethics of AI in clinical practice, and the P.U.L.S.E.™ Framework.
- Built a continuing education series, "Ethics in the Age of AI," as an NBCC ACEP program.
- Past proposals: NASW and the Colorado Counseling Association.
- Signature for clinician audiences: Ashley R. Bryant, LPC, CRC.`,
  },
  {
    category: "voice_tone",
    title: "Voice and naming rules",
    content: `- Never call the receptionist an "AI receptionist." It is the 24/7 receptionist, and each practice can name it.
- Never name GoHighLevel or the claims clearinghouse in customer-facing copy. Everything is presented as LeadDash.
- Always write DashNotes™ and P.U.L.S.E.™ with the trademark symbol.
- Do not mention Cornell or Therapy In Color in bios, pitches or marketing unless Ashley asks.
- Brand colors: dark forest green #0d3b2e; orange #e88a3a is for accents and buttons only, never a section background. The wordmark never sits on brand green.
- Plain, specific language written like a subject-matter expert. No em dashes, no hype, no invented statistics.`,
  },
];

const exists = db.prepare("SELECT id FROM organization_knowledge WHERE organizationId = ? AND employeeId IS NULL AND title = ?");
const insert = db.prepare(
  "INSERT INTO organization_knowledge (organizationId, title, category, kind, content, chars, createdAt, updatedAt) VALUES (?, ?, ?, 'fact', ?, ?, ?, ?)"
);
const chunk = db.prepare(
  "INSERT INTO knowledge_chunks (organizationId, sourceType, sourceId, employeeId, seq, heading, text) VALUES (?, 'knowledge', ?, NULL, ?, ?, ?)"
);

let added = 0;
db.transaction(() => {
  for (const e of entries) {
    if (exists.get(org.id, e.title)) continue;
    const info = insert.run(org.id, e.title, e.category, e.content, e.content.length, now, now);
    // One passage per paragraph group keeps search hits specific.
    const parts = e.content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    parts.forEach((p, i) => chunk.run(org.id, info.lastInsertRowid, i, e.title, p));
    added++;
  }
})();

console.log(`Workspace: ${org.name} (#${org.id})`);
console.log(`Profile fields filled: ${filled.length ? filled.join(", ") : "none (already set)"}`);
console.log(`Brain entries added: ${added} of ${entries.length}${added < entries.length ? " (the rest were already there)" : ""}`);
