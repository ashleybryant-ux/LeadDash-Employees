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

/** Documents and pages longer than this are searched per task rather than pasted whole. */
export const LONG_DOC = 6000;

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
    if (org.entity) lines.push(`Legal entity: ${org.entity}`);
    if (org.description) lines.push(`What it is: ${org.description}`);
    if (org.audience) lines.push(`Who it serves: ${org.audience}`);
    if (org.brandColors) lines.push(`Brand colors: ${org.brandColors}`);
    if (org.fonts) lines.push(`Fonts: ${org.fonts}`);
  }
  const order = Object.keys(CATEGORY_LABELS) as KnowledgeCategory[];
  for (const cat of order) {
    const items = entries.filter((e) => e.category === cat && e.kind !== "image");
    if (items.length === 0) continue;
    lines.push("", `## ${CATEGORY_LABELS[cat]}`);
    for (const item of items) {
      const head = `### ${item.title}${item.sourceUrl ? ` (${item.sourceUrl})` : ""}`;
      // Long uploaded documents and pages (books, playbooks) are searched per task instead of
      // pasted into every task: their best-fitting passages appear under "From your documents".
      if ((item.kind === "document" || item.kind === "webpage") && item.content.trim().length > LONG_DOC) {
        const size = item.pages ? `${item.pages} ${item.pagesUnit ?? "pages"}` : `${Math.round(item.content.length / 1000)}k characters`;
        lines.push(head, `(${item.kind === "document" ? "Document" : "Web page"} on file, ${size}. The passages that fit each task appear under "From your documents".)`);
        continue;
      }
      lines.push(head, item.content.trim().slice(0, 6000));
    }
  }
  const images = entries.filter((e) => e.kind === "image");
  if (images.length) {
    lines.push("", "## Images on file");
    for (const i of images) lines.push(`- ${i.title}${i.content ? `: ${i.content}` : ""}`);
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
