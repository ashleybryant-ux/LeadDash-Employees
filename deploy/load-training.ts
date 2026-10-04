/**
 * Loads a company training file into one workspace's Brain, one entry per
 * "## [category] Title" section, named "Company training: Title".
 * Running it again updates those entries in place (nothing is duplicated).
 *
 *   npx tsx deploy/load-training.ts "LeadDash" deploy/training/leaddash.md
 *   npx tsx deploy/load-training.ts --all          (every file in deploy/training/workspaces.json)
 *
 * The first argument is the workspace name exactly as it shows in the app.
 * --all only adds sections a workspace doesn't have yet, so edits made on the
 * Brain page are never overwritten; deploy.sh runs it on every deploy.
 */
import "dotenv/config";
import fs from "node:fs";
import * as db from "../server/db";
import { indexKnowledge } from "../server/employees/kb";
import { KNOWLEDGE_CATEGORIES } from "../drizzle/schema";

type Cat = (typeof KNOWLEDGE_CATEGORIES)[number];

export function parseTraining(text: string) {
  const out: { title: string; category: Cat; content: string }[] = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const head = part.slice(0, nl).trim();
    const m = head.match(/^\[([a-z_]+)\]\s+(.+)$/);
    if (!m) throw new Error(`Section heading needs a [category]: ${head}`);
    if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(m[1])) throw new Error(`Unknown category "${m[1]}" in: ${head}`);
    out.push({ title: `Company training: ${m[2].trim()}`, category: m[1] as Cat, content: part.slice(nl + 1).trim() });
  }
  return out;
}

export async function loadTraining(orgId: number, text: string, opts: { addOnly?: boolean } = {}) {
  const sections = parseTraining(text);
  const existing = (await db.listKnowledgeByOrg(orgId)).filter((k) => k.employeeId == null);
  let created = 0;
  let updated = 0;
  for (const s of sections) {
    const have = existing.find((k) => k.title === s.title);
    if (have && opts.addOnly) continue;
    const item = have
      ? await db.updateKnowledgeItem(have.id, orgId, { content: s.content, category: s.category, kind: "fact" })
      : await db.createKnowledgeItem({ organizationId: orgId, title: s.title, category: s.category, kind: "fact", content: s.content });
    if (item) indexKnowledge(item);
    if (have) updated++;
    else created++;
  }
  return { created, updated, titles: sections.map((s) => s.title) };
}

/** Every training file into the workspaces named for it, adding only what's missing. */
async function loadAll() {
  const map = JSON.parse(fs.readFileSync("deploy/training/workspaces.json", "utf8")) as Record<string, string[]>;
  const orgs = await db.listOrganizations();
  for (const [file, names] of Object.entries(map)) {
    for (const name of names) {
      const org = orgs.find((o) => o.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (!org) {
        console.log(`  ${file}: no workspace named "${name}" (skipped)`);
        continue;
      }
      const r = await loadTraining(org.id, fs.readFileSync(`deploy/training/${file}`, "utf8"), { addOnly: true });
      console.log(`  ${org.name} <- ${file}: ${r.created ? `${r.created} section${r.created === 1 ? "" : "s"} added` : "already loaded"}`);
    }
  }
}

async function main() {
  if (process.argv[2] === "--all") return loadAll();
  const [name, file] = process.argv.slice(2);
  if (!name || !file) {
    console.log('Usage: npx tsx deploy/load-training.ts "<workspace name>" <training file>');
    process.exit(1);
  }
  const orgs = await db.listOrganizations();
  const matches = orgs.filter((o) => o.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (matches.length !== 1) {
    console.log(matches.length ? `More than one workspace is named "${name}".` : `No workspace is named "${name}".`);
    console.log("Workspaces:");
    for (const o of orgs) console.log(`  ${o.name}`);
    process.exit(1);
  }
  const org = matches[0];
  const r = await loadTraining(org.id, fs.readFileSync(file, "utf8"));
  console.log(`${org.name}: ${r.created} added, ${r.updated} updated`);
  for (const t of r.titles) console.log(`  ${t}`);
  console.log("TRAINING LOADED. Every employee in this workspace reads it from the Brain on their next task.");
}

if (process.argv[1] && process.argv[1].endsWith("load-training.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
