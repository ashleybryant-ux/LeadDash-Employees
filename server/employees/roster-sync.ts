import * as db from "../db";
import { OLD_TITLES, ROSTER } from "./roster";

/**
 * Every workspace has every employee on the roster. Runs when a workspace is
 * created and at every server start, so a job added to the roster later (like
 * Quinn) shows up in every existing workspace without anyone doing anything.
 * Existing roster employees get the current job description and capabilities.
 */
export async function ensureRoster(organizationId: number) {
  const have = await db.listEmployeesByOrg(organizationId);
  let added = 0;
  for (const r of ROSTER) {
    const current = have.find((e) => e.kind === r.kind);
    if (current) {
      // Keep the job text current. Names stay as the workspace set them.
      const caps = JSON.stringify(r.capabilities);
      const retitle = current.roleTitle === OLD_TITLES[r.roleTitle];
      if (current.description !== r.description || current.capabilities !== caps || retitle) {
        await db.updateEmployee(current.id, organizationId, { description: r.description, capabilities: caps, ...(retitle ? { roleTitle: r.roleTitle } : {}) });
      }
      continue;
    }
    await db.createEmployee({
      organizationId,
      kind: r.kind,
      name: r.name,
      avatar: null,
      roleTitle: r.roleTitle,
      department: r.department,
      status: "active",
      efficiency: 98,
      description: r.description,
      capabilities: JSON.stringify(r.capabilities),
      systemPrompt: null,
    });
    added++;
  }
  return added;
}

export async function ensureAllRosters() {
  let added = 0;
  for (const id of await db.listAllOrganizationIds()) added += await ensureRoster(id);
  if (added) console.log(`[roster] added ${added} employee${added === 1 ? "" : "s"} to existing workspaces`);
  return added;
}
