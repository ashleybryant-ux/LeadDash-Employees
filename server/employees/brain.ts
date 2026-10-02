import * as db from "../db";
import type { KnowledgeCategory, Organization, OrganizationKnowledge } from "../../drizzle/schema";

export const CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  mission_profile: "Profile and mission",
  voice_tone: "Voice and signatures",
  services_offers: "Services and offers",
  past_performance: "Past results",
  certifications_licenses: "Licenses and certifications",
  team_bios: "Team",
  financial_data: "Funding facts",
  speaking: "Speaking",
};

/**
 * The Brain is everything an employee knows about the workspace: the profile
 * fields from Settings plus every Brain entry. Every employee gets it on
 * every task, so the grant writer and the social manager work from the same
 * facts.
 */
export function formatBrain(org: Organization | null, entries: OrganizationKnowledge[]) {
  const lines: string[] = [];
  if (org) {
    lines.push("## Workspace");
    lines.push(`Name: ${org.name}`);
    if (org.website) lines.push(`Website: ${org.website}`);
    if (org.state) lines.push(`Location: ${org.state}`);
    if (org.focusAreas) lines.push(`Focus areas: ${org.focusAreas}`);
    if (org.ein) lines.push(`EIN: ${org.ein}`);
    if (org.annualBudget) lines.push(`Annual budget: ${org.annualBudget}`);
  }
  const order = Object.keys(CATEGORY_LABELS) as KnowledgeCategory[];
  for (const cat of order) {
    const items = entries.filter((e) => e.category === cat);
    if (items.length === 0) continue;
    lines.push("", `## ${CATEGORY_LABELS[cat]}`);
    for (const item of items) {
      lines.push(`### ${item.title}`, item.content.trim());
    }
  }
  if (entries.length === 0) {
    lines.push("", "(The Brain has no entries yet. Use placeholders for any fact not listed above.)");
  }
  return lines.join("\n");
}

export async function loadBrain(organizationId: number) {
  const [org, entries] = await Promise.all([
    db.getOrganizationById(organizationId),
    db.listKnowledgeByOrg(organizationId),
  ]);
  return { org, entries, text: formatBrain(org, entries) };
}
