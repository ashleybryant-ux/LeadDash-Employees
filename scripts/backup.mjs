// Copies the live database safely (works while the app is running).
//   node scripts/backup.mjs            -> data/backups/employees-YYYY-MM-DD.db
// Keeps the newest 14 backups.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

const src = process.env.DATABASE_PATH || "./data/employees.db";
const dir = path.resolve("data/backups");
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `employees-${new Date().toISOString().slice(0, 10)}.db`);
const db = new Database(src, { readonly: true });
await db.backup(dest);
db.close();
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
for (const old of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(dir, old));
console.log("backup written:", dest);
