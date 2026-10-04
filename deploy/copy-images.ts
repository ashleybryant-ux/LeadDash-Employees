/**
 * Copies every image in one workspace's Brain (photos, logos) into other
 * workspaces' Brains, with their descriptions. Each copy gets its own file in
 * the target workspace, so access stays per workspace. Images a target already
 * has (same title) are skipped, so running it again adds only new ones.
 *
 *   npx tsx deploy/copy-images.ts "Dr. Ashley Bryant" "LeadDash"
 *   npx tsx deploy/copy-images.ts "Dr. Ashley Bryant" --all
 *
 * --all copies into every other workspace and lists them first.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import * as db from "../server/db";
import { storagePut, uploadsRoot } from "../server/storage";
import { indexKnowledge } from "../server/employees/kb";

export async function copyImages(fromOrgId: number, toOrgId: number) {
  const source = (await db.listKnowledgeByOrg(fromOrgId)).filter((k) => k.kind === "image" && k.employeeId == null && k.fileUrl);
  const have = new Set((await db.listKnowledgeByOrg(toOrgId)).filter((k) => k.kind === "image").map((k) => k.title));
  let copied = 0;
  for (const img of source) {
    if (have.has(img.title)) continue;
    const key = img.fileUrl!.replace(/^\/files\//, "");
    const full = path.join(uploadsRoot(), key);
    if (!fs.existsSync(full)) continue;
    const ext = path.extname(full) || ".jpg";
    const saved = await storagePut(`org-${toOrgId}/brain/image${ext}`, await fs.promises.readFile(full));
    const item = await db.createKnowledgeItem({ organizationId: toOrgId, kind: "image", title: img.title, category: img.category, content: img.content, fileUrl: saved.url });
    indexKnowledge(item);
    copied++;
  }
  return { copied, total: source.length };
}

async function main() {
  const [fromName, target] = process.argv.slice(2);
  if (!fromName || !target) {
    console.log('Usage: npx tsx deploy/copy-images.ts "<from workspace>" "<to workspace>" (or --all)');
    process.exit(1);
  }
  const orgs = await db.listOrganizations();
  const byName = (n: string) => orgs.filter((o) => o.name.trim().toLowerCase() === n.trim().toLowerCase());
  const from = byName(fromName);
  if (from.length !== 1) {
    console.log(`${from.length ? "More than one" : "No"} workspace named "${fromName}". Workspaces:`);
    for (const o of orgs) console.log(`  ${o.name}`);
    process.exit(1);
  }
  const targets = target === "--all" ? orgs.filter((o) => o.id !== from[0].id) : byName(target);
  if (!targets.length) {
    console.log(`No workspace named "${target}". Workspaces:`);
    for (const o of orgs) console.log(`  ${o.name}`);
    process.exit(1);
  }
  for (const t of targets) {
    const r = await copyImages(from[0].id, t.id);
    console.log(`${t.name}: ${r.copied} added (${r.total - r.copied} already there)`);
  }
  console.log("IMAGES COPIED.");
}

if (process.argv[1] && process.argv[1].endsWith("copy-images.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
