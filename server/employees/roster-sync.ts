import * as db from "../db";
import { ROSTER } from "./roster";

/**
 * Every workspace has every employee on the roster. Runs when a workspace is
 * created and at every server start, so a job added to the roster later (like
 * Quinn) shows up in every existing workspace without anyone doing anything.
 */
export async function ensureRoster(organizationId: number) {
  const have = await db.listEmployeesByOrg(organizationId);
  let added = 0;
  for (const r of ROSTER) {
    if (have.some((e) => e.kind === r.kind)) continue;
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
