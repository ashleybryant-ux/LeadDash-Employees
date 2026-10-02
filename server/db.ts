import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq, inArray, lt, gt, isNull } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../drizzle/schema";
import {
  users,
  loginCodes,
  sessions,
  organizations,
  organizationMembers,
  aiEmployees,
  grantOpportunities,
  grantProposals,
  workItems,
  organizationKnowledge,
  auditLogs,
  externalConnections,
  outboundItems,
  chatMessages,
  chatReads,
  scheduledTasks,
  taskRuns,
  knowledgeChunks,
  opportunities,
  opportunityFiles,
  applications,
  employeeQuestions,
  registrations,
  portalLogins,
  type InsertOpportunity,
  type InsertApplication,
  type RegistrationKind,
  type InsertChatMessage,
  type InsertScheduledTask,
  type InsertOrganization,
  type InsertOrganizationMember,
  type InsertAIEmployee,
  type InsertGrantOpportunity,
  type InsertGrantProposal,
  type InsertWorkItem,
  type InsertOrganizationKnowledge,
  type InsertAuditLog,
  type InsertExternalConnection,
  type InsertOutboundItem,
  type OutboundKind,
  type WorkItemKind,
  type Provider,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;

function migrationsFolder() {
  // Works from the source tree (tsx, vitest) and from the bundled dist/index.js.
  const candidates = [
    path.resolve(import.meta.dirname, "../drizzle"),
    path.resolve(import.meta.dirname, "../../drizzle"),
    path.resolve(process.cwd(), "drizzle"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "meta", "_journal.json"))) return dir;
  }
  throw new Error("Database migrations folder not found (expected ./drizzle)");
}

/** Opens the database file (creating it and running migrations on first use). */
export function getDb(): DB {
  if (_db) return _db;
  const file = ENV.databasePath;
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  _sqlite = new Database(file);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _sqlite.pragma("busy_timeout = 5000");
  _db = drizzle(_sqlite, { schema });
  migrate(_db, { migrationsFolder: migrationsFolder() });
  return _db;
}

/** For tests: close and forget the current connection. */
export function closeDb() {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

// ==========================================
// Users, sign-in codes, sessions
// ==========================================

export async function getUserByEmail(email: string) {
  const rows = getDb().select().from(users).where(eq(users.email, email.toLowerCase())).limit(1).all();
  return rows[0] || null;
}

export async function getUserById(id: number) {
  const rows = getDb().select().from(users).where(eq(users.id, id)).limit(1).all();
  return rows[0] || null;
}

export async function getUsersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return getDb().select().from(users).where(inArray(users.id, ids)).all();
}

export async function createUser(data: { email: string; name?: string | null; role?: "user" | "admin" }) {
  const rows = getDb()
    .insert(users)
    .values({ email: data.email.toLowerCase(), name: data.name ?? null, role: data.role ?? "user" })
    .returning()
    .all();
  return rows[0];
}

export async function updateUser(id: number, data: Partial<typeof users.$inferInsert>) {
  getDb().update(users).set(data).where(eq(users.id, id)).run();
  return getUserById(id);
}

export async function createLoginCode(email: string, codeHash: string, expiresAt: Date) {
  // Only the newest code for an email is valid.
  getDb()
    .update(loginCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(loginCodes.email, email), isNull(loginCodes.usedAt)))
    .run();
  getDb().insert(loginCodes).values({ email, codeHash, expiresAt }).run();
}

export async function getActiveLoginCode(email: string) {
  const rows = getDb()
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), isNull(loginCodes.usedAt), gt(loginCodes.expiresAt, new Date())))
    .orderBy(desc(loginCodes.id))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function countRecentLoginCodes(email: string, since: Date) {
  const rows = getDb()
    .select({ id: loginCodes.id })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, since)))
    .all();
  return rows.length;
}

/**
 * Checks a code in one synchronous transaction, so parallel requests cannot
 * all read the same attempt count. Every call counts as an attempt; the code
 * is spent on success or on the last allowed failure.
 */
export function consumeLoginCode(email: string, codeHash: string, maxAttempts: number, matches: (a: string, b: string) => boolean) {
  const sqlite = (getDb(), _sqlite!);
  const run = sqlite.transaction(() => {
    const row = sqlite
      .prepare(
        "SELECT id, codeHash, attempts FROM login_codes WHERE email = ? AND usedAt IS NULL AND expiresAt > ? ORDER BY id DESC LIMIT 1"
      )
      .get(email, Math.floor(Date.now() / 1000)) as { id: number; codeHash: string; attempts: number } | undefined;
    if (!row || row.attempts >= maxAttempts) return false;
    const attempts = row.attempts + 1;
    const ok = matches(row.codeHash, codeHash);
    const spent = ok || attempts >= maxAttempts;
    sqlite
      .prepare("UPDATE login_codes SET attempts = ?, usedAt = ? WHERE id = ?")
      .run(attempts, spent ? Math.floor(Date.now() / 1000) : null, row.id);
    return ok;
  });
  return run.immediate();
}

export async function recordLoginCodeAttempt(id: number, attempts: number, used: boolean) {
  getDb()
    .update(loginCodes)
    .set({ attempts, usedAt: used ? new Date() : null })
    .where(eq(loginCodes.id, id))
    .run();
}

export async function createSession(userId: number, tokenHash: string, expiresAt: Date, ip: string | null) {
  getDb().insert(sessions).values({ userId, tokenHash, expiresAt, ip }).run();
}

export async function getSessionByTokenHash(tokenHash: string) {
  const rows = getDb()
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function revokeSession(tokenHash: string) {
  getDb().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, tokenHash)).run();
}

export async function revokeSessionsForUser(userId: number) {
  getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .run();
}

export async function purgeExpiredAuthRecords() {
  const now = new Date();
  getDb().delete(loginCodes).where(lt(loginCodes.expiresAt, new Date(now.getTime() - 86400_000))).run();
  getDb().delete(sessions).where(lt(sessions.expiresAt, now)).run();
}

// ==========================================
// Workspaces and members
// ==========================================

export async function listOrganizations() {
  return getDb().select().from(organizations).orderBy(desc(organizations.createdAt)).all();
}

export async function listOrganizationsForUser(userId: number) {
  const memberships = getDb()
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .all();
  const ids = memberships.map((m) => m.organizationId);
  if (ids.length === 0) return [];
  return getDb()
    .select()
    .from(organizations)
    .where(inArray(organizations.id, ids))
    .orderBy(desc(organizations.createdAt))
    .all();
}

export async function getOrganizationById(orgId: number) {
  const rows = getDb().select().from(organizations).where(eq(organizations.id, orgId)).limit(1).all();
  return rows[0] || null;
}

export async function getOrganizationBySlug(slug: string) {
  const rows = getDb().select().from(organizations).where(eq(organizations.slug, slug)).limit(1).all();
  return rows[0] || null;
}

export async function createOrganization(org: InsertOrganization) {
  const rows = getDb().insert(organizations).values(org).returning().all();
  return rows[0];
}

export async function updateOrganization(orgId: number, data: Partial<InsertOrganization>) {
  getDb().update(organizations).set(data).where(eq(organizations.id, orgId)).run();
  return getOrganizationById(orgId);
}

export async function getOrganizationMembership(organizationId: number, userId: number) {
  const rows = getDb()
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function listMembers(organizationId: number) {
  const members = getDb()
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(organizationMembers.id)
    .all();
  const people = await getUsersByIds(members.map((m) => m.userId));
  return members.map((m) => {
    const u = people.find((p) => p.id === m.userId);
    return { ...m, email: u?.email ?? "", name: u?.name ?? null };
  });
}

export async function addOrganizationMember(member: InsertOrganizationMember) {
  const rows = getDb().insert(organizationMembers).values(member).returning().all();
  return rows[0];
}

export async function updateMemberRole(organizationId: number, userId: number, role: InsertOrganizationMember["role"]) {
  getDb()
    .update(organizationMembers)
    .set({ role })
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .run();
}

export async function removeMember(organizationId: number, userId: number) {
  getDb()
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .run();
}

export async function countMembershipsForUser(userId: number) {
  return getDb()
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .all().length;
}

// ==========================================
// AI employees
// ==========================================

export async function listEmployeesByOrg(orgId: number) {
  return getDb().select().from(aiEmployees).where(eq(aiEmployees.organizationId, orgId)).orderBy(aiEmployees.id).all();
}

export async function getEmployeeForOrg(employeeId: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(aiEmployees)
    .where(and(eq(aiEmployees.id, employeeId), eq(aiEmployees.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function getEmployeeByKind(orgId: number, kind: InsertAIEmployee["kind"]) {
  const rows = getDb()
    .select()
    .from(aiEmployees)
    .where(and(eq(aiEmployees.organizationId, orgId), eq(aiEmployees.kind, kind!)))
    .orderBy(aiEmployees.id)
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function updateEmployee(employeeId: number, orgId: number, data: Partial<InsertAIEmployee>) {
  getDb()
    .update(aiEmployees)
    .set(data)
    .where(and(eq(aiEmployees.id, employeeId), eq(aiEmployees.organizationId, orgId)))
    .run();
  return getEmployeeForOrg(employeeId, orgId);
}

export async function recordEmployeeTask(employeeId: number, orgId: number, minutesSaved: number) {
  const emp = await getEmployeeForOrg(employeeId, orgId);
  if (!emp) return;
  // hoursSaved is stored in whole hours; keep the remainder by rounding the running total.
  const tasks = emp.tasksCompleted + 1;
  const hours = Math.round(((emp.hoursSaved * 60 + minutesSaved) / 60) * 10) / 10;
  await updateEmployee(employeeId, orgId, { tasksCompleted: tasks, hoursSaved: Math.round(hours) });
}

export async function createEmployee(emp: InsertAIEmployee) {
  const rows = getDb().insert(aiEmployees).values(emp).returning().all();
  return rows[0];
}

// ==========================================
// Grants
// ==========================================

export async function listOpportunitiesByOrg(orgId: number) {
  return getDb()
    .select()
    .from(grantOpportunities)
    .where(eq(grantOpportunities.organizationId, orgId))
    .orderBy(desc(grantOpportunities.createdAt), desc(grantOpportunities.id))
    .all();
}

export async function getOpportunityForOrg(oppId: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(grantOpportunities)
    .where(and(eq(grantOpportunities.id, oppId), eq(grantOpportunities.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function findOpportunityByTitle(orgId: number, title: string, funder: string) {
  const all = await listOpportunitiesByOrg(orgId);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return all.find((o) => norm(o.title) === norm(title) && norm(o.funder) === norm(funder)) || null;
}

export async function createOpportunity(opp: InsertGrantOpportunity) {
  const rows = getDb().insert(grantOpportunities).values(opp).returning().all();
  return rows[0];
}

export async function updateOpportunity(oppId: number, orgId: number, data: Partial<InsertGrantOpportunity>) {
  getDb()
    .update(grantOpportunities)
    .set(data)
    .where(and(eq(grantOpportunities.id, oppId), eq(grantOpportunities.organizationId, orgId)))
    .run();
  return getOpportunityForOrg(oppId, orgId);
}

export async function listProposalsByOrg(orgId: number) {
  return getDb()
    .select()
    .from(grantProposals)
    .where(eq(grantProposals.organizationId, orgId))
    .orderBy(desc(grantProposals.updatedAt))
    .all();
}

export async function getProposalByIdForOrganization(proposalId: number, organizationId: number) {
  const rows = getDb()
    .select()
    .from(grantProposals)
    .where(and(eq(grantProposals.id, proposalId), eq(grantProposals.organizationId, organizationId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function getProposalByOpportunityForOrganization(opportunityId: number, organizationId: number) {
  const rows = getDb()
    .select()
    .from(grantProposals)
    .where(and(eq(grantProposals.opportunityId, opportunityId), eq(grantProposals.organizationId, organizationId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function createProposal(prop: InsertGrantProposal) {
  const rows = getDb().insert(grantProposals).values(prop).returning().all();
  return rows[0];
}

export async function updateProposal(proposalId: number, organizationId: number, data: Partial<InsertGrantProposal>) {
  getDb()
    .update(grantProposals)
    .set(data)
    .where(and(eq(grantProposals.id, proposalId), eq(grantProposals.organizationId, organizationId)))
    .run();
  return getProposalByIdForOrganization(proposalId, organizationId);
}

// ==========================================
// Work items (speaking, website, video)
// ==========================================

export async function listWorkItems(orgId: number, kind: WorkItemKind) {
  return getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.organizationId, orgId), eq(workItems.kind, kind)))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
    .all();
}

export async function getWorkItemForOrg(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(workItems)
    .where(and(eq(workItems.id, id), eq(workItems.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function createWorkItem(item: InsertWorkItem) {
  const rows = getDb().insert(workItems).values(item).returning().all();
  return rows[0];
}

export async function updateWorkItem(id: number, orgId: number, data: Partial<InsertWorkItem>) {
  getDb()
    .update(workItems)
    .set(data)
    .where(and(eq(workItems.id, id), eq(workItems.organizationId, orgId)))
    .run();
  return getWorkItemForOrg(id, orgId);
}

// ==========================================
// Connections
// ==========================================

export async function listConnectionsByOrg(orgId: number) {
  return getDb()
    .select()
    .from(externalConnections)
    .where(eq(externalConnections.organizationId, orgId))
    .orderBy(externalConnections.provider)
    .all();
}

export async function getConnectionByProvider(orgId: number, provider: Provider) {
  const rows = getDb()
    .select()
    .from(externalConnections)
    .where(and(eq(externalConnections.organizationId, orgId), eq(externalConnections.provider, provider)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function upsertExternalConnection(item: InsertExternalConnection) {
  const existing = await getConnectionByProvider(item.organizationId, item.provider);
  if (existing) {
    getDb().update(externalConnections).set(item).where(eq(externalConnections.id, existing.id)).run();
  } else {
    getDb().insert(externalConnections).values(item).run();
  }
  return getConnectionByProvider(item.organizationId, item.provider);
}

// ==========================================
// Approval queue
// ==========================================

export async function listOutboundItemsByOrg(orgId: number, kind?: OutboundKind) {
  const where = kind
    ? and(eq(outboundItems.organizationId, orgId), eq(outboundItems.kind, kind))
    : eq(outboundItems.organizationId, orgId);
  return getDb().select().from(outboundItems).where(where).orderBy(desc(outboundItems.createdAt), desc(outboundItems.id)).all();
}

export async function getOutboundItemForOrg(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(outboundItems)
    .where(and(eq(outboundItems.id, id), eq(outboundItems.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function createOutboundItem(item: InsertOutboundItem) {
  const rows = getDb().insert(outboundItems).values(item).returning().all();
  return rows[0];
}

export async function updateOutboundItem(id: number, orgId: number, data: Partial<InsertOutboundItem>) {
  getDb()
    .update(outboundItems)
    .set(data)
    .where(and(eq(outboundItems.id, id), eq(outboundItems.organizationId, orgId)))
    .run();
  return getOutboundItemForOrg(id, orgId);
}

// ==========================================
// Brain
// ==========================================

/** The shared Brain: entries that belong to no single employee. */
export async function listKnowledgeByOrg(orgId: number) {
  return getDb()
    .select()
    .from(organizationKnowledge)
    .where(and(eq(organizationKnowledge.organizationId, orgId), isNull(organizationKnowledge.employeeId)))
    .orderBy(organizationKnowledge.category, organizationKnowledge.id)
    .all();
}

/** One employee's own Knowledge. */
export async function listEmployeeKnowledge(orgId: number, employeeId: number) {
  return getDb()
    .select()
    .from(organizationKnowledge)
    .where(and(eq(organizationKnowledge.organizationId, orgId), eq(organizationKnowledge.employeeId, employeeId)))
    .orderBy(desc(organizationKnowledge.createdAt), desc(organizationKnowledge.id))
    .all();
}

export async function getKnowledgeItem(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(organizationKnowledge)
    .where(and(eq(organizationKnowledge.id, id), eq(organizationKnowledge.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

/** Every Brain and Knowledge entry in a workspace (for indexing). */
export async function listAllKnowledge(orgId?: number) {
  const q = getDb().select().from(organizationKnowledge);
  return orgId ? q.where(eq(organizationKnowledge.organizationId, orgId)).all() : q.all();
}

export async function createKnowledgeItem(item: InsertOrganizationKnowledge) {
  const rows = getDb().insert(organizationKnowledge).values(item).returning().all();
  return rows[0];
}

export async function updateKnowledgeItem(id: number, orgId: number, data: Partial<InsertOrganizationKnowledge>) {
  getDb()
    .update(organizationKnowledge)
    .set(data)
    .where(and(eq(organizationKnowledge.id, id), eq(organizationKnowledge.organizationId, orgId)))
    .run();
  const rows = getDb()
    .select()
    .from(organizationKnowledge)
    .where(and(eq(organizationKnowledge.id, id), eq(organizationKnowledge.organizationId, orgId)))
    .all();
  return rows[0] || null;
}

export async function deleteKnowledgeItem(id: number, orgId: number) {
  getDb()
    .delete(organizationKnowledge)
    .where(and(eq(organizationKnowledge.id, id), eq(organizationKnowledge.organizationId, orgId)))
    .run();
  deleteChunks(orgId, "knowledge", id);
}

// ==========================================
// Passages and full-text search
// ==========================================

export function deleteChunks(orgId: number, sourceType: "knowledge" | "opp_file", sourceId: number) {
  getDb()
    .delete(knowledgeChunks)
    .where(and(eq(knowledgeChunks.organizationId, orgId), eq(knowledgeChunks.sourceType, sourceType), eq(knowledgeChunks.sourceId, sourceId)))
    .run();
}

export function replaceChunks(
  orgId: number,
  sourceType: "knowledge" | "opp_file",
  sourceId: number,
  employeeId: number | null,
  chunks: { heading: string | null; text: string }[]
) {
  const sqlite = (getDb(), _sqlite!);
  sqlite.transaction(() => {
    deleteChunks(orgId, sourceType, sourceId);
    const ins = sqlite.prepare(
      "INSERT INTO knowledge_chunks (organizationId, sourceType, sourceId, employeeId, seq, heading, text) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    chunks.forEach((c, i) => ins.run(orgId, sourceType, sourceId, employeeId, i, c.heading, c.text));
  })();
}

export function countChunks(orgId: number, sourceType: "knowledge" | "opp_file", sourceId: number) {
  const sqlite = (getDb(), _sqlite!);
  const row = sqlite
    .prepare("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE organizationId = ? AND sourceType = ? AND sourceId = ?")
    .get(orgId, sourceType, sourceId) as { n: number };
  return row.n;
}

export type ChunkHit = { id: number; sourceType: "knowledge" | "opp_file"; sourceId: number; heading: string | null; text: string; score: number };

/**
 * Finds the passages that best match a query, from the shared Brain, one
 * employee's Knowledge, and (optionally) one opportunity's package files.
 */
export function searchChunks(orgId: number, ftsQuery: string, opts: { employeeId?: number | null; opportunityFileIds?: number[]; limit?: number }) {
  if (!ftsQuery.trim()) return [] as ChunkHit[];
  const sqlite = (getDb(), _sqlite!);
  const fileIds = opts.opportunityFileIds ?? [];
  const scope = [
    "(c.sourceType = 'knowledge' AND (c.employeeId IS NULL" + (opts.employeeId ? " OR c.employeeId = ?" : "") + "))",
    fileIds.length ? `(c.sourceType = 'opp_file' AND c.sourceId IN (${fileIds.map(() => "?").join(",")}))` : null,
  ]
    .filter(Boolean)
    .join(" OR ");
  const params: unknown[] = [ftsQuery, orgId];
  if (opts.employeeId) params.push(opts.employeeId);
  params.push(...fileIds, opts.limit ?? 8);
  try {
    return sqlite
      .prepare(
        `SELECT c.id, c.sourceType, c.sourceId, c.heading, c.text, bm25(knowledge_fts) AS score
         FROM knowledge_fts JOIN knowledge_chunks c ON c.id = knowledge_fts.rowid
         WHERE knowledge_fts MATCH ? AND c.organizationId = ? AND (${scope})
         ORDER BY score LIMIT ?`
      )
      .all(...params) as ChunkHit[];
  } catch (err) {
    console.warn("[search] query failed:", (err as Error).message);
    return [];
  }
}

/** All passages of one source, in order (to read a whole package file). */
export function chunksOf(orgId: number, sourceType: "knowledge" | "opp_file", sourceId: number) {
  return getDb()
    .select()
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.organizationId, orgId), eq(knowledgeChunks.sourceType, sourceType), eq(knowledgeChunks.sourceId, sourceId)))
    .orderBy(knowledgeChunks.seq)
    .all();
}

// ==========================================
// Opportunities (grants, pitch competitions, accelerators, speaking calls)
// ==========================================

export async function listOpps(orgId: number, kinds?: string[]) {
  const all = getDb()
    .select()
    .from(opportunities)
    .where(eq(opportunities.organizationId, orgId))
    .orderBy(desc(opportunities.createdAt), desc(opportunities.id))
    .all();
  return kinds ? all.filter((o) => kinds.includes(o.kind)) : all;
}

export async function getOpp(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function createOpp(item: InsertOpportunity) {
  return getDb().insert(opportunities).values(item).returning().all()[0];
}

export async function updateOpp(id: number, orgId: number, data: Partial<InsertOpportunity>) {
  getDb()
    .update(opportunities)
    .set(data)
    .where(and(eq(opportunities.id, id), eq(opportunities.organizationId, orgId)))
    .run();
  return getOpp(id, orgId);
}

export async function listOppFiles(orgId: number, opportunityId: number) {
  return getDb()
    .select()
    .from(opportunityFiles)
    .where(and(eq(opportunityFiles.organizationId, orgId), eq(opportunityFiles.opportunityId, opportunityId)))
    .orderBy(opportunityFiles.id)
    .all();
}

export async function listOppFilesForOrg(orgId: number) {
  return getDb().select().from(opportunityFiles).where(eq(opportunityFiles.organizationId, orgId)).all();
}

export async function createOppFile(item: typeof opportunityFiles.$inferInsert) {
  return getDb().insert(opportunityFiles).values(item).returning().all()[0];
}

export async function setOppFileStatus(orgId: number, id: number, status: "read" | "failed" | "needs_signature") {
  getDb()
    .update(opportunityFiles)
    .set({ status })
    .where(and(eq(opportunityFiles.id, id), eq(opportunityFiles.organizationId, orgId)))
    .run();
}

export async function deleteOppFiles(orgId: number, opportunityId: number) {
  for (const f of await listOppFiles(orgId, opportunityId)) deleteChunks(orgId, "opp_file", f.id);
  getDb()
    .delete(opportunityFiles)
    .where(and(eq(opportunityFiles.organizationId, orgId), eq(opportunityFiles.opportunityId, opportunityId)))
    .run();
}

// ==========================================
// Applications
// ==========================================

export async function listApplications(orgId: number) {
  return getDb()
    .select()
    .from(applications)
    .where(eq(applications.organizationId, orgId))
    .orderBy(desc(applications.updatedAt), desc(applications.id))
    .all();
}

export async function getApplication(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(applications)
    .where(and(eq(applications.id, id), eq(applications.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function getApplicationByOpp(opportunityId: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(applications)
    .where(and(eq(applications.opportunityId, opportunityId), eq(applications.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function createApplication(item: InsertApplication) {
  return getDb().insert(applications).values(item).returning().all()[0];
}

export async function updateApplication(id: number, orgId: number, data: Partial<InsertApplication>) {
  getDb()
    .update(applications)
    .set(data)
    .where(and(eq(applications.id, id), eq(applications.organizationId, orgId)))
    .run();
  return getApplication(id, orgId);
}

/** Applications left "writing" by a restart are marked so they can be resumed. */
export async function markStuckApplications() {
  getDb()
    .update(applications)
    .set({ status: "error", errorNote: "The server restarted while this was being written. Press Write again." })
    .where(eq(applications.status, "writing"))
    .run();
}

// ==========================================
// Questions an employee asks with fixed choices
// ==========================================

export async function createEmployeeQuestion(item: typeof employeeQuestions.$inferInsert) {
  return getDb().insert(employeeQuestions).values(item).returning().all()[0];
}

export async function getEmployeeQuestion(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(employeeQuestions)
    .where(and(eq(employeeQuestions.id, id), eq(employeeQuestions.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function listOpenQuestions(orgId: number, applicationId?: number) {
  const rows = getDb()
    .select()
    .from(employeeQuestions)
    .where(and(eq(employeeQuestions.organizationId, orgId), isNull(employeeQuestions.answeredAt)))
    .all();
  return applicationId ? rows.filter((r) => r.applicationId === applicationId) : rows;
}

export async function answerEmployeeQuestion(id: number, orgId: number, answer: string, by: string) {
  getDb()
    .update(employeeQuestions)
    .set({ answer, answeredBy: by, answeredAt: new Date() })
    .where(and(eq(employeeQuestions.id, id), eq(employeeQuestions.organizationId, orgId)))
    .run();
  return getEmployeeQuestion(id, orgId);
}

// ==========================================
// Registrations and saved portal sign-ins
// ==========================================

export async function listRegistrations(orgId: number) {
  return getDb().select().from(registrations).where(eq(registrations.organizationId, orgId)).orderBy(registrations.id).all();
}

export async function upsertRegistration(orgId: number, kind: RegistrationKind, data: { status?: string; details?: string; expires?: string | null }) {
  const existing = getDb()
    .select()
    .from(registrations)
    .where(and(eq(registrations.organizationId, orgId), eq(registrations.kind, kind)))
    .limit(1)
    .all()[0];
  if (existing) {
    getDb().update(registrations).set(data as never).where(eq(registrations.id, existing.id)).run();
  } else {
    getDb().insert(registrations).values({ organizationId: orgId, kind, ...(data as object) }).run();
  }
  return getDb()
    .select()
    .from(registrations)
    .where(and(eq(registrations.organizationId, orgId), eq(registrations.kind, kind)))
    .limit(1)
    .all()[0];
}

/** Every registration across workspaces (for expiry reminders). */
export async function listAllRegistrations() {
  return getDb().select().from(registrations).all();
}

export async function listPortalLogins(orgId: number) {
  return getDb().select().from(portalLogins).where(eq(portalLogins.organizationId, orgId)).orderBy(portalLogins.name).all();
}

export async function savePortalLogin(item: typeof portalLogins.$inferInsert & { id?: number }) {
  if (item.id) {
    const { id, ...data } = item;
    getDb()
      .update(portalLogins)
      .set(data)
      .where(and(eq(portalLogins.id, id), eq(portalLogins.organizationId, item.organizationId)))
      .run();
    return getDb().select().from(portalLogins).where(eq(portalLogins.id, id)).all()[0] || null;
  }
  return getDb().insert(portalLogins).values(item).returning().all()[0];
}

export async function deletePortalLogin(id: number, orgId: number) {
  getDb()
    .delete(portalLogins)
    .where(and(eq(portalLogins.id, id), eq(portalLogins.organizationId, orgId)))
    .run();
}

// ==========================================
// Audit trail
// ==========================================

export async function listAuditLogsByOrg(orgId: number, limit = 25) {
  return getDb()
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, orgId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit)
    .all();
}

export async function logAction(item: InsertAuditLog) {
  try {
    getDb().insert(auditLogs).values(item).run();
  } catch (err) {
    console.warn("[audit] failed to write:", err);
  }
}

// ==========================================
// Chat
// ==========================================

export async function listChatMessages(orgId: number, employeeId: number, limit = 200) {
  const rows = getDb()
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.organizationId, orgId), eq(chatMessages.employeeId, employeeId)))
    .orderBy(desc(chatMessages.id))
    .limit(limit)
    .all();
  return rows.reverse();
}

export async function createChatMessage(msg: InsertChatMessage) {
  const rows = getDb().insert(chatMessages).values(msg).returning().all();
  return rows[0];
}

/** Last message and unread count for every employee in a workspace, for one person. */
export async function chatSummaries(orgId: number, userId: number) {
  const sqlite = (getDb(), _sqlite!);
  const last = sqlite
    .prepare(
      `SELECT m.employeeId, m.authorName, m.content, m.role, m.createdAt
       FROM chat_messages m
       JOIN (SELECT employeeId, MAX(id) AS id FROM chat_messages WHERE organizationId = ? GROUP BY employeeId) x ON x.id = m.id`
    )
    .all(orgId) as { employeeId: number; authorName: string; content: string; role: string; createdAt: number }[];
  const unread = sqlite
    .prepare(
      `SELECT m.employeeId, COUNT(*) AS n
       FROM chat_messages m
       LEFT JOIN chat_reads r ON r.organizationId = m.organizationId AND r.employeeId = m.employeeId AND r.userId = ?
       WHERE m.organizationId = ? AND m.role = 'employee' AND (r.lastReadAt IS NULL OR m.createdAt > r.lastReadAt)
       GROUP BY m.employeeId`
    )
    .all(userId, orgId) as { employeeId: number; n: number }[];
  return last.map((l) => ({
    employeeId: l.employeeId,
    authorName: l.authorName,
    content: l.content,
    role: l.role,
    createdAt: new Date(l.createdAt * 1000),
    unread: unread.find((u) => u.employeeId === l.employeeId)?.n ?? 0,
  }));
}

export async function markChatRead(orgId: number, employeeId: number, userId: number) {
  getDb()
    .insert(chatReads)
    .values({ organizationId: orgId, employeeId, userId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [chatReads.organizationId, chatReads.employeeId, chatReads.userId],
      set: { lastReadAt: new Date() },
    })
    .run();
}

// ==========================================
// Scheduled tasks
// ==========================================

export async function listScheduledTasks(orgId: number) {
  return getDb()
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.organizationId, orgId))
    .orderBy(scheduledTasks.nextRunAt, scheduledTasks.id)
    .all();
}

export async function getScheduledTaskForOrg(id: number, orgId: number) {
  const rows = getDb()
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.organizationId, orgId)))
    .limit(1)
    .all();
  return rows[0] || null;
}

export async function createScheduledTask(task: InsertScheduledTask) {
  const rows = getDb().insert(scheduledTasks).values(task).returning().all();
  return rows[0];
}

export async function updateScheduledTask(id: number, orgId: number, data: Partial<InsertScheduledTask>) {
  getDb()
    .update(scheduledTasks)
    .set(data)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.organizationId, orgId)))
    .run();
  return getScheduledTaskForOrg(id, orgId);
}

export async function deleteScheduledTask(id: number, orgId: number) {
  getDb()
    .delete(scheduledTasks)
    .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.organizationId, orgId)))
    .run();
}

/** Tasks due now, across every workspace (the runner's view). */
export async function dueScheduledTasks(now: Date) {
  return getDb()
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lt(scheduledTasks.nextRunAt, new Date(now.getTime() + 1000))))
    .all();
}

export async function createTaskRun(run: typeof taskRuns.$inferInsert) {
  const rows = getDb().insert(taskRuns).values(run).returning().all();
  return rows[0];
}

export async function listTaskRuns(orgId: number, limit = 50) {
  return getDb()
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.organizationId, orgId))
    .orderBy(desc(taskRuns.id))
    .limit(limit)
    .all();
}
