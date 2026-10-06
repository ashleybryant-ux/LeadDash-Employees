import * as db from "../db";
import type { OrgType } from "../../drizzle/schema";
import { ROSTER, defaultTitles, departmentFor, onTeam, titleFor } from "./roster";

/**
 * Every workspace has every employee on the roster its organization type
 * calls for. Runs when a workspace is created, when its type changes, and at
 * every server start, so a job added to the roster later shows up in every
 * existing workspace without anyone doing anything.
 * - Existing roster employees get the current job description, capabilities,
 *   and the title and department their type gives them (a title someone
 *   typed stays).
 * - A kind the type leaves off the team (Sales in a practice) is created but
 *   kept off the team, so it is hidden everywhere and comes back if the type
 *   changes.
 */
export async function ensureRoster(organizationId: number) {
  const org = await db.getOrganizationById(organizationId);
  const orgType: OrgType = (org?.orgType as OrgType | undefined) ?? "business";
  const have = await db.listAllEmployeesByOrg(organizationId);
  let added = 0;
  for (const r of ROSTER) {
    const current = have.find((e) => e.kind === r.kind);
    const title = titleFor(r, orgType);
    const department = departmentFor(r, orgType);
    const team = onTeam(r.kind, orgType);
    if (current) {
      // Keep the job text current. Names stay as the workspace set them; a typed title stays too.
      const caps = JSON.stringify(r.capabilities);
      const retitle = current.roleTitle !== title && defaultTitles(r).includes(current.roleTitle);
      const patch: Parameters<typeof db.updateEmployee>[2] = {};
      if (current.description !== r.description) patch.description = r.description;
      if (current.capabilities !== caps) patch.capabilities = caps;
      if (retitle) patch.roleTitle = title;
      if (current.department !== department) patch.department = department;
      if (current.onTeam !== team) patch.onTeam = team;
      if (Object.keys(patch).length) await db.updateEmployee(current.id, organizationId, patch);
      continue;
    }
    await db.createEmployee({
      organizationId,
      kind: r.kind,
      name: r.name,
      avatar: null,
      roleTitle: title,
      department,
      status: "active",
      onTeam: team,
      efficiency: 98,
      description: r.description,
      capabilities: JSON.stringify(r.capabilities),
      systemPrompt: null,
    });
    if (team) added++;
  }
  return added;
}

export async function ensureAllRosters() {
  let added = 0;
  for (const id of await db.listAllOrganizationIds()) added += await ensureRoster(id);
  if (added) console.log(`[roster] added ${added} employee${added === 1 ? "" : "s"} to existing workspaces`);
  return added;
}
