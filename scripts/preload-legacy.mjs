#!/usr/bin/env node
/**
 * One-time preload for Ashley's Legacy Family Services workspace: fills the
 * workspace profile (only fields that are still empty) and adds Brain entries
 * with what is already known about the practice. New tenants never get this;
 * it only touches the workspace whose name starts with "Legacy Family Services".
 * Everything it adds can be edited in the app (Workspace and Brain).
 *
 *   cd /home/ssm-user/employees && node scripts/preload-legacy.mjs
 *
 * Safe to run twice: entries whose title already exists are skipped.
 */
import "dotenv/config";
import path from "node:path";
import Database from "better-sqlite3";

const file = path.resolve(process.env.DATABASE_PATH || "./data/employees.db");
const db = new Database(file);
db.pragma("busy_timeout = 5000");

const orgs = db.prepare("SELECT id, name FROM organizations WHERE lower(trim(name)) LIKE 'legacy family services%'").all();
const org = orgs[0];
if (!org) {
  console.log('No workspace named "Legacy Family Services" yet. Create it in the app (LD menu, New workspace), then run this again.');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);

// ---------- Workspace profile (only empty fields are filled) ----------

const profile = {
  state: "Oklahoma City, OK",
  entity: "Legacy Family Services, Inc. [CONFIRM: for-profit corporation or 501(c)(3) nonprofit]",
  description: "Group outpatient counseling practice in Oklahoma City offering individual, couples and family therapy in person and by telehealth, and adult clinical evaluations.",
  audience: "Adults, couples and families in the Oklahoma City area, and across Oklahoma by telehealth.",
  focusAreas: "Outpatient mental health, individual, couples and family therapy, telehealth access, adult clinical evaluations, workplace accommodation (ADA) evaluations",
  signerName: "Ashley R. Bryant",
  signerTitle: "Owner",
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
    title: "About Legacy Family Services",
    content: `Legacy Family Services, Inc. is a group outpatient counseling practice in Oklahoma City, Oklahoma. Licensed clinicians provide individual, couples and family therapy in person and by telehealth, and the practice conducts adult clinical evaluations.

Legal name: Legacy Family Services, Inc.
Address: 11901 N MacArthur Blvd, Suite C6, Oklahoma City, OK 73162
Main phone: (405) 370-4594
Fax: (405) 421-9530
Client email: client@legacyfs.org
Entity type: [CONFIRM: for-profit corporation or 501(c)(3) nonprofit]. Grant eligibility depends on this.`,
  },
  {
    category: "services_offers",
    title: "Services",
    content: `- Individual, couples and family therapy, in person in Oklahoma City and by telehealth.
- Adult clinical evaluations using a structured battery of assessment instruments (adults only; no children or teens).
- ADA workplace accommodation evaluations (self-pay).
- Online booking for new clients; sessions start on the hour.
- Client portal for paperwork, documents and billing, and telehealth through the practice's own secure video rooms.
- Insurance billing, plus self-pay.
Populations served and payers accepted: [LIST PAYERS AND POPULATIONS].`,
  },
  {
    category: "team_bios",
    title: "Team",
    content: `- Ashley R. Bryant, PhD, LPC, CRC: owner. Licensed Professional Counselor in Oklahoma, Colorado and Texas, Licensed Mental Health Counselor in Florida, Certified Rehabilitation Counselor. 18 years of clinical experience, with a background in vocational rehabilitation and disability employment. PhD in Workforce and Adult Education (Oklahoma State University), MS in Rehabilitation Counseling (Langston University, 2012). Carries about 25 clients a week.
- BJ: COO and Facility Director.
- Angela St. Ville: administration and billing.
- Delicia Porter: clinician, sees clients by telehealth.
- Amanda Case: clinician, sees clients by telehealth.
Licenses and credentials for each clinician: [ADD LICENSE TYPE AND NUMBER].`,
  },
  {
    category: "certifications_licenses",
    title: "Certifications and licensure",
    content: `- Application submitted to the Oklahoma Department of Mental Health and Substance Abuse Services (ODMHSAS) for Outpatient Mental Health Treatment certification; awaiting a decision. [UPDATE WHEN CERTIFIED]
- Clinicians are licensed in Oklahoma; the owner also holds licensure in Colorado, Texas and Florida.
- Built a continuing education series, "Ethics in the Age of AI," as an NBCC ACEP program.`,
  },
  {
    category: "past_performance",
    title: "Results and numbers",
    content: `Figures to fill in before Morgan uses them:
- Clients served in the last 12 months: [NUMBER]
- Sessions delivered in the last 12 months: [NUMBER]
- Share of clients seen by telehealth: [PERCENT]
- Average days from first call to first session: [NUMBER]
- Counties served: [LIST]
- Outcome measures used (for example PHQ-9 and GAD-7) and average change: [RESULTS]`,
  },
  {
    category: "financial_data",
    title: "Funding facts",
    content: `- Annual operating budget: [AMOUNT]
- EIN: [EIN]
- SAM.gov UEI: [UEI, if registered]
- Current or past grants: [LIST]
- Payer mix: [PERCENT INSURANCE / MEDICAID / SELF-PAY]`,
  },
  {
    category: "voice_tone",
    title: "Voice and naming rules",
    content: `- Oklahoma licensing rules do not allow "Dr." in counseling practice marketing. Sign as "Ashley R. Bryant, LPC, CRC."
- Never include a client's name or any client health information in anything written for the practice.
- Plain, warm, specific language. No em dashes, no hype, no invented statistics.`,
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
