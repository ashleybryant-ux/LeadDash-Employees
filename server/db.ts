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
  chatFiles,
  huddles,
  avatarVideos,
  historyImports,
  mcpLinks,
  devChanges,
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
  pushSubscriptions,
  hrRoles,
  hrPeople,
  hrTeamItems,
  reviewAccess,
  salesProspects,
  salesLeads,
  teamActivity,
  handbookParts,
  handbookAdditions,
  handbookChanges,
  sitePages,
  sitePageVersions,
  publicFiles,
  type SitePage,
  type ReviewAccess,
  type HrStage,
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
  launches,
  launchMilestones,
  launchTasks,
  launchKpis,
  launchReports,
  projectNotes,
  meetings,
  notetakerMeetings,
} from "../drizzle/schema";
import { EventEmitter } from "node:events";
import { ENV } from "./_core/env";

type DB = BetterSQLite3Database<typeof schema>;

/**
 * Things worth telling someone about. server/notify.ts listens and sends push
 * notices and emails; keeping it an event here avoids db importing notify.
 */
export const dbEvents = new EventEmitter();


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
    return { ...m, email: u?.email ?? "", name: u?.name ?? null, avatarUrl: u?.avatarUrl ?? null };
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
  if (rows[0]?.status === "pending_approval") dbEvents.emit("approval", rows[0]);
  return rows[0];
}

/** Approved posts whose scheduled time has come, in every workspace. */
export async function dueScheduledPosts(now: Date) {
  return getDb()
    .select()
    .from(outboundItems)
    .where(and(eq(outboundItems.status, "scheduled"), lt(outboundItems.scheduledFor, new Date(now.getTime() + 1000))))
    .orderBy(outboundItems.scheduledFor)
    .all();
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
  const before = data.status === "ready" ? await getApplication(id, orgId) : null;
  getDb()
    .update(applications)
    .set(data)
    .where(and(eq(applications.id, id), eq(applications.organizationId, orgId)))
    .run();
  const after = await getApplication(id, orgId);
  if (after && data.status === "ready" && before?.status !== "ready") dbEvents.emit("application_ready", after);
  return after;
}

/** Applications left "writing" by a restart are marked so they can be resumed. */
export async function markStuckApplications() {
  getDb()
    .update(applications)
    .set({ status: "error", errorNote: "The server restarted while this was being written. Press Write again." })
    .where(eq(applications.status, "writing"))
    .run();
  // "Apply" needs a score of 60 or more (older searches could label a 52 as Apply).
  getDb().update(opportunities).set({ fitCall: "skip" }).where(and(eq(opportunities.fitCall, "apply"), lt(opportunities.fitScore, 60))).run();
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

export function createChatFile(row: typeof chatFiles.$inferInsert) {
  return getDb().insert(chatFiles).values(row).returning().all()[0];
}
export function getChatFiles(orgId: number, ids: number[]) {
  if (!ids.length) return [];
  return getDb().select().from(chatFiles).where(and(eq(chatFiles.organizationId, orgId), inArray(chatFiles.id, ids))).all();
}
export function attachChatFiles(orgId: number, ids: number[], messageId: number) {
  if (!ids.length) return;
  getDb().update(chatFiles).set({ messageId }).where(and(eq(chatFiles.organizationId, orgId), inArray(chatFiles.id, ids))).run();
}
/** Files sent in an employee's chat, newest first. */
export function recentChatFiles(orgId: number, employeeId: number, limit = 10) {
  return getDb().select().from(chatFiles).where(and(eq(chatFiles.organizationId, orgId), eq(chatFiles.employeeId, employeeId))).orderBy(desc(chatFiles.id)).limit(limit).all().filter((f) => f.messageId != null);
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

// ==========================================
// Push notifications
// ==========================================

export async function listPushSubscriptions(userIds: number[]) {
  if (userIds.length === 0) return [];
  return getDb().select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds)).all();
}

export async function savePushSubscription(row: typeof pushSubscriptions.$inferInsert) {
  const existing = getDb().select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, row.endpoint)).limit(1).all()[0];
  if (existing) {
    getDb().update(pushSubscriptions).set({ userId: row.userId, p256dh: row.p256dh, auth: row.auth, device: row.device }).where(eq(pushSubscriptions.id, existing.id)).run();
    return { ...existing, ...row };
  }
  return getDb().insert(pushSubscriptions).values(row).returning().all()[0];
}

export async function deletePushSubscription(id: number, userId: number) {
  getDb().delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId))).run();
}

export async function deletePushEndpoint(endpoint: string) {
  getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}

export async function touchPushSubscription(id: number) {
  getDb().update(pushSubscriptions).set({ lastSentAt: new Date() }).where(eq(pushSubscriptions.id, id)).run();
}

/** Everyone who should hear about a workspace: its team plus LeadDash staff. */
export async function notifyRecipients(orgId: number) {
  const members = getDb().select().from(organizationMembers).where(eq(organizationMembers.organizationId, orgId)).all();
  const staff = getDb().select().from(users).where(eq(users.role, "admin")).all();
  const ids = Array.from(new Set([...members.map((m) => m.userId), ...staff.map((u) => u.id)]));
  return getUsersByIds(ids);
}

// ==========================================
// Hiring (Quinn)
// ==========================================

export async function listHrRoles(orgId: number) {
  return getDb().select().from(hrRoles).where(eq(hrRoles.organizationId, orgId)).orderBy(desc(hrRoles.id)).all();
}

export async function getHrRole(id: number, orgId: number) {
  return getDb().select().from(hrRoles).where(and(eq(hrRoles.id, id), eq(hrRoles.organizationId, orgId))).limit(1).all()[0] || null;
}

export async function createHrRole(row: typeof hrRoles.$inferInsert) {
  return getDb().insert(hrRoles).values(row).returning().all()[0];
}

export async function updateHrRole(id: number, orgId: number, data: Partial<typeof hrRoles.$inferInsert>) {
  getDb().update(hrRoles).set(data).where(and(eq(hrRoles.id, id), eq(hrRoles.organizationId, orgId))).run();
  return getHrRole(id, orgId);
}

export async function listHrPeople(orgId: number, source?: "applicant" | "prospect") {
  const all = getDb().select().from(hrPeople).where(eq(hrPeople.organizationId, orgId)).orderBy(desc(hrPeople.fitScore), desc(hrPeople.id)).all();
  return source ? all.filter((p) => p.source === source) : all;
}

export async function getHrPerson(id: number, orgId: number) {
  return getDb().select().from(hrPeople).where(and(eq(hrPeople.id, id), eq(hrPeople.organizationId, orgId))).limit(1).all()[0] || null;
}

export async function createHrPerson(row: typeof hrPeople.$inferInsert) {
  return getDb().insert(hrPeople).values(row).returning().all()[0];
}

export async function updateHrPerson(id: number, orgId: number, data: Partial<typeof hrPeople.$inferInsert>) {
  getDb().update(hrPeople).set(data).where(and(eq(hrPeople.id, id), eq(hrPeople.organizationId, orgId))).run();
  return getHrPerson(id, orgId);
}

export async function setHrStage(id: number, orgId: number, stage: HrStage) {
  return updateHrPerson(id, orgId, { stage });
}

/** Deletes prospect cards nobody acted on once their 90 days are up (Do not contact stays). */
export async function purgeHrProspects(now = new Date()) {
  getDb()
    .delete(hrPeople)
    .where(and(eq(hrPeople.source, "prospect"), inArray(hrPeople.stage, ["prospect", "contacted", "passed"]), lt(hrPeople.purgeAt, now)))
    .run();
}

export async function listHrTeamItems(orgId: number) {
  return getDb().select().from(hrTeamItems).where(eq(hrTeamItems.organizationId, orgId)).orderBy(hrTeamItems.id).all();
}

export async function getHrTeamItem(id: number, orgId: number) {
  return getDb().select().from(hrTeamItems).where(and(eq(hrTeamItems.id, id), eq(hrTeamItems.organizationId, orgId))).limit(1).all()[0] || null;
}

export async function saveHrTeamItem(orgId: number, data: { id?: number; person: string; item: string; due: string | null; progress: string | null }) {
  if (data.id) {
    getDb().update(hrTeamItems).set({ person: data.person, item: data.item, due: data.due, progress: data.progress }).where(and(eq(hrTeamItems.id, data.id), eq(hrTeamItems.organizationId, orgId))).run();
    return getHrTeamItem(data.id, orgId);
  }
  return getDb().insert(hrTeamItems).values({ organizationId: orgId, person: data.person, item: data.item, due: data.due, progress: data.progress }).returning().all()[0];
}

export async function deleteHrTeamItem(id: number, orgId: number) {
  getDb().delete(hrTeamItems).where(and(eq(hrTeamItems.id, id), eq(hrTeamItems.organizationId, orgId))).run();
}

export async function markHrTeamItemReminded(id: number, orgId: number) {
  getDb().update(hrTeamItems).set({ lastRemindedAt: new Date() }).where(and(eq(hrTeamItems.id, id), eq(hrTeamItems.organizationId, orgId))).run();
}

export async function listAllOrganizationIds() {
  return getDb().select({ id: organizations.id }).from(organizations).all().map((r) => r.id);
}

// ==========================================
// App review access (one row, id 1)
// ==========================================

export function getReviewAccess(): ReviewAccess | null {
  return getDb().select().from(reviewAccess).where(eq(reviewAccess.id, 1)).get() ?? null;
}

export function saveReviewAccess(data: Partial<typeof reviewAccess.$inferInsert>): ReviewAccess {
  const existing = getReviewAccess();
  if (existing) {
    getDb().update(reviewAccess).set(data).where(eq(reviewAccess.id, 1)).run();
  } else {
    getDb().insert(reviewAccess).values({ ...data, id: 1 }).run();
  }
  return getReviewAccess()!;
}

// ==========================================
// Sales: prospects and leads
// ==========================================

export async function listProspects(orgId: number) {
  return getDb().select().from(salesProspects).where(eq(salesProspects.organizationId, orgId)).orderBy(desc(salesProspects.fitScore), desc(salesProspects.id)).all();
}

export async function getProspect(id: number, orgId: number) {
  return getDb().select().from(salesProspects).where(and(eq(salesProspects.id, id), eq(salesProspects.organizationId, orgId))).limit(1).all()[0] || null;
}

export async function createProspect(row: typeof salesProspects.$inferInsert) {
  return getDb().insert(salesProspects).values(row).returning().all()[0];
}

export async function updateProspect(id: number, orgId: number, data: Partial<typeof salesProspects.$inferInsert>) {
  getDb().update(salesProspects).set(data).where(and(eq(salesProspects.id, id), eq(salesProspects.organizationId, orgId))).run();
  return getProspect(id, orgId);
}

export async function listLeads(orgId: number) {
  return getDb().select().from(salesLeads).where(eq(salesLeads.organizationId, orgId)).orderBy(desc(salesLeads.createdAt), desc(salesLeads.id)).all();
}

export async function getLead(id: number, orgId: number) {
  return getDb().select().from(salesLeads).where(and(eq(salesLeads.id, id), eq(salesLeads.organizationId, orgId))).limit(1).all()[0] || null;
}

export async function createLead(row: typeof salesLeads.$inferInsert) {
  return getDb().insert(salesLeads).values(row).returning().all()[0];
}

export async function updateLead(id: number, orgId: number, data: Partial<typeof salesLeads.$inferInsert>) {
  getDb().update(salesLeads).set(data).where(and(eq(salesLeads.id, id), eq(salesLeads.organizationId, orgId))).run();
  return getLead(id, orgId);
}

/** Workspaces whose lead form or booking page uses this token. */
export async function findOrgBySalesToken(token: string) {
  if (!token || token.length < 12) return null;
  const rows = getDb().select().from(organizations).all();
  return rows.find((o) => {
    try {
      return JSON.parse(o.sales || "{}").token === token;
    } catch {
      return false;
    }
  }) ?? null;
}

// ==========================================
// Activity
// ==========================================

export async function addActivity(row: typeof teamActivity.$inferInsert) {
  return getDb().insert(teamActivity).values(row).returning().all()[0];
}

export async function listActivity(orgId: number, limit = 200) {
  return getDb().select().from(teamActivity).where(eq(teamActivity.organizationId, orgId)).orderBy(desc(teamActivity.createdAt), desc(teamActivity.id)).limit(limit).all();
}

// ==========================================
// Leadership: launches (Nora) and meetings (Simone)
// ==========================================

export async function listLaunches(orgId: number) {
  return getDb().select().from(launches).where(eq(launches.organizationId, orgId)).orderBy(desc(launches.launchDate), desc(launches.id)).all();
}
export async function getLaunch(id: number, orgId: number) {
  return getDb().select().from(launches).where(and(eq(launches.id, id), eq(launches.organizationId, orgId))).limit(1).all()[0] || null;
}
export async function createLaunch(row: typeof launches.$inferInsert) {
  return getDb().insert(launches).values(row).returning().all()[0];
}
export async function updateLaunch(id: number, orgId: number, data: Partial<typeof launches.$inferInsert>) {
  getDb().update(launches).set(data).where(and(eq(launches.id, id), eq(launches.organizationId, orgId))).run();
  return getLaunch(id, orgId);
}

export async function listMilestones(launchId: number, orgId: number) {
  return getDb().select().from(launchMilestones).where(and(eq(launchMilestones.launchId, launchId), eq(launchMilestones.organizationId, orgId))).orderBy(launchMilestones.position, launchMilestones.dueDate).all();
}
export async function createMilestone(row: typeof launchMilestones.$inferInsert) {
  return getDb().insert(launchMilestones).values(row).returning().all()[0];
}
export async function updateMilestone(id: number, orgId: number, data: Partial<typeof launchMilestones.$inferInsert>) {
  getDb().update(launchMilestones).set(data).where(and(eq(launchMilestones.id, id), eq(launchMilestones.organizationId, orgId))).run();
}

export async function listLaunchTasks(launchId: number, orgId: number) {
  return getDb().select().from(launchTasks).where(and(eq(launchTasks.launchId, launchId), eq(launchTasks.organizationId, orgId))).orderBy(launchTasks.dueDate, launchTasks.id).all();
}
export async function listOrgLaunchTasks(orgId: number) {
  return getDb().select().from(launchTasks).where(eq(launchTasks.organizationId, orgId)).all();
}
export async function getLaunchTask(id: number, orgId: number) {
  return getDb().select().from(launchTasks).where(and(eq(launchTasks.id, id), eq(launchTasks.organizationId, orgId))).limit(1).all()[0] || null;
}
export async function createLaunchTask(row: typeof launchTasks.$inferInsert) {
  return getDb().insert(launchTasks).values(row).returning().all()[0];
}
export async function updateLaunchTask(id: number, orgId: number, data: Partial<typeof launchTasks.$inferInsert>) {
  getDb().update(launchTasks).set(data).where(and(eq(launchTasks.id, id), eq(launchTasks.organizationId, orgId))).run();
  return getLaunchTask(id, orgId);
}

export async function listKpis(launchId: number, orgId: number) {
  return getDb().select().from(launchKpis).where(and(eq(launchKpis.launchId, launchId), eq(launchKpis.organizationId, orgId))).orderBy(launchKpis.position, launchKpis.id).all();
}
export async function getKpi(id: number, orgId: number) {
  return getDb().select().from(launchKpis).where(and(eq(launchKpis.id, id), eq(launchKpis.organizationId, orgId))).limit(1).all()[0] || null;
}
export async function createKpi(row: typeof launchKpis.$inferInsert) {
  return getDb().insert(launchKpis).values(row).returning().all()[0];
}
export async function updateKpi(id: number, orgId: number, data: Partial<typeof launchKpis.$inferInsert>) {
  getDb().update(launchKpis).set(data).where(and(eq(launchKpis.id, id), eq(launchKpis.organizationId, orgId))).run();
  return getKpi(id, orgId);
}
export async function deleteKpi(id: number, orgId: number) {
  getDb().delete(launchKpis).where(and(eq(launchKpis.id, id), eq(launchKpis.organizationId, orgId))).run();
}

export async function listLaunchReports(launchId: number, orgId: number) {
  return getDb().select().from(launchReports).where(and(eq(launchReports.launchId, launchId), eq(launchReports.organizationId, orgId))).orderBy(desc(launchReports.createdAt), desc(launchReports.id)).all();
}
export async function createLaunchReport(row: typeof launchReports.$inferInsert) {
  return getDb().insert(launchReports).values(row).returning().all()[0];
}

export function listProjectNotes(orgId: number) {
  return getDb().select().from(projectNotes).where(eq(projectNotes.organizationId, orgId)).orderBy(desc(projectNotes.createdAt), desc(projectNotes.id)).all();
}
export function createProjectNote(row: typeof projectNotes.$inferInsert) {
  return getDb().insert(projectNotes).values(row).returning().all()[0];
}
export function updateProjectNote(id: number, orgId: number, data: Partial<typeof projectNotes.$inferInsert>) {
  getDb().update(projectNotes).set(data).where(and(eq(projectNotes.id, id), eq(projectNotes.organizationId, orgId))).run();
  return getDb().select().from(projectNotes).where(and(eq(projectNotes.id, id), eq(projectNotes.organizationId, orgId))).limit(1).all()[0] || null;
}

export async function listMeetings(orgId: number) {
  return getDb().select().from(meetings).where(eq(meetings.organizationId, orgId)).orderBy(meetings.startsAt, meetings.id).all();
}
export async function getMeeting(id: number, orgId: number) {
  return getDb().select().from(meetings).where(and(eq(meetings.id, id), eq(meetings.organizationId, orgId))).limit(1).all()[0] || null;
}
export async function createMeeting(row: typeof meetings.$inferInsert) {
  return getDb().insert(meetings).values(row).returning().all()[0];
}
export async function updateMeeting(id: number, orgId: number, data: Partial<typeof meetings.$inferInsert>) {
  getDb().update(meetings).set(data).where(and(eq(meetings.id, id), eq(meetings.organizationId, orgId))).run();
  return getMeeting(id, orgId);
}

// ==========================================
// Notetaker meetings
// ==========================================

export async function listNotetaker(orgId: number) {
  return getDb().select().from(notetakerMeetings).where(eq(notetakerMeetings.organizationId, orgId)).orderBy(notetakerMeetings.startsAt, notetakerMeetings.id).all();
}
export async function getNotetaker(id: number, orgId: number) {
  return getDb().select().from(notetakerMeetings).where(and(eq(notetakerMeetings.id, id), eq(notetakerMeetings.organizationId, orgId))).limit(1).all()[0] || null;
}
export async function getNotetakerByEvent(orgId: number, eventId: string) {
  return getDb().select().from(notetakerMeetings).where(and(eq(notetakerMeetings.organizationId, orgId), eq(notetakerMeetings.eventId, eventId))).limit(1).all()[0] || null;
}
export async function createNotetaker(row: typeof notetakerMeetings.$inferInsert) {
  return getDb().insert(notetakerMeetings).values(row).returning().all()[0];
}
export async function updateNotetaker(id: number, orgId: number, data: Partial<typeof notetakerMeetings.$inferInsert>) {
  getDb().update(notetakerMeetings).set({ ...data, updatedAt: new Date() }).where(and(eq(notetakerMeetings.id, id), eq(notetakerMeetings.organizationId, orgId))).run();
  return getNotetaker(id, orgId);
}

// ==========================================
// Handbook
// ==========================================

export function listHandbookParts() {
  return getDb().select().from(handbookParts).all();
}

export function saveHandbookPart(key: string, content: string, updatedBy: string) {
  getDb()
    .insert(handbookParts)
    .values({ key, content, updatedBy })
    .onConflictDoUpdate({ target: handbookParts.key, set: { content, updatedBy, updatedAt: new Date() } })
    .run();
}

export function deleteHandbookPart(key: string) {
  getDb().delete(handbookParts).where(eq(handbookParts.key, key)).run();
}

export function listHandbookAdditions(organizationId: number) {
  return getDb().select().from(handbookAdditions).where(eq(handbookAdditions.organizationId, organizationId)).all();
}

export function saveHandbookAddition(organizationId: number, partKey: string, rules: string, updatedBy: string) {
  getDb()
    .insert(handbookAdditions)
    .values({ organizationId, partKey, rules, updatedBy })
    .onConflictDoUpdate({ target: [handbookAdditions.organizationId, handbookAdditions.partKey], set: { rules, updatedBy, updatedAt: new Date() } })
    .run();
}

export function logHandbookChange(data: { organizationId: number | null; partKey: string; actorName: string; summary: string }) {
  getDb().insert(handbookChanges).values(data).run();
}

export function listHandbookChanges(organizationId: number | null, limit = 100) {
  const where = organizationId === null ? isNull(handbookChanges.organizationId) : eq(handbookChanges.organizationId, organizationId);
  return getDb().select().from(handbookChanges).where(where).orderBy(desc(handbookChanges.id)).limit(limit).all();
}

// ==========================================
// Site pages (Jordan) and public file links
// ==========================================

export function createSitePage(data: typeof sitePages.$inferInsert) {
  return getDb().insert(sitePages).values(data).returning().all()[0];
}

export function getSitePage(id: number, orgId: number) {
  return getDb().select().from(sitePages).where(and(eq(sitePages.id, id), eq(sitePages.organizationId, orgId))).get() ?? null;
}

export function listSitePages(orgId: number) {
  return getDb().select().from(sitePages).where(eq(sitePages.organizationId, orgId)).orderBy(desc(sitePages.updatedAt)).all();
}

export function updateSitePage(id: number, orgId: number, data: Partial<typeof sitePages.$inferInsert>) {
  getDb().update(sitePages).set(data).where(and(eq(sitePages.id, id), eq(sitePages.organizationId, orgId))).run();
  return getSitePage(id, orgId) as SitePage;
}

export function deleteSitePage(id: number, orgId: number) {
  getDb().delete(sitePageVersions).where(and(eq(sitePageVersions.pageId, id), eq(sitePageVersions.organizationId, orgId))).run();
  getDb().delete(sitePages).where(and(eq(sitePages.id, id), eq(sitePages.organizationId, orgId))).run();
}

export function addSitePageVersion(data: typeof sitePageVersions.$inferInsert) {
  return getDb().insert(sitePageVersions).values(data).returning().all()[0];
}

export function listSitePageVersions(pageId: number, orgId: number) {
  return getDb()
    .select()
    .from(sitePageVersions)
    .where(and(eq(sitePageVersions.pageId, pageId), eq(sitePageVersions.organizationId, orgId)))
    .orderBy(desc(sitePageVersions.version))
    .all();
}

export function publicFileByKey(fileKey: string) {
  return getDb().select().from(publicFiles).where(eq(publicFiles.fileKey, fileKey)).get() ?? null;
}

export function publicFileByToken(token: string) {
  return getDb().select().from(publicFiles).where(eq(publicFiles.token, token)).get() ?? null;
}

export function createPublicFile(data: typeof publicFiles.$inferInsert) {
  getDb().insert(publicFiles).values(data).onConflictDoNothing().run();
  return publicFileByKey(data.fileKey);
}

/** Pages left "building" by a restart stop with a note, keeping any earlier version. */
export function markStuckPages() {
  for (const p of getDb().select().from(sitePages).where(eq(sitePages.status, "building")).all()) {
    getDb().update(sitePages).set({ status: p.currentVersion ? "ready" : "failed", progress: "Stopped by a server restart. Ask again and I'll redo it." }).where(eq(sitePages.id, p.id)).run();
  }
}

// ==========================================
// Team huddles
// ==========================================

export function createHuddle(row: typeof huddles.$inferInsert) {
  return getDb().insert(huddles).values(row).returning().all()[0];
}
export function getHuddle(id: number, orgId: number) {
  return getDb().select().from(huddles).where(and(eq(huddles.id, id), eq(huddles.organizationId, orgId))).limit(1).all()[0] || null;
}
export function huddleByToken(token: string) {
  return getDb().select().from(huddles).where(eq(huddles.token, token)).limit(1).all()[0] || null;
}
export function listHuddles(orgId: number, limit = 20) {
  return getDb().select().from(huddles).where(eq(huddles.organizationId, orgId)).orderBy(desc(huddles.id)).limit(limit).all();
}
export function updateHuddle(id: number, orgId: number, data: Partial<typeof huddles.$inferInsert>) {
  getDb().update(huddles).set(data).where(and(eq(huddles.id, id), eq(huddles.organizationId, orgId))).run();
  return getHuddle(id, orgId);
}

// ==========================================
// Avatar videos (Elena)
// ==========================================

export function createAvatarVideo(row: typeof avatarVideos.$inferInsert) {
  return getDb().insert(avatarVideos).values(row).returning().all()[0];
}
export function getAvatarVideo(id: number, orgId: number) {
  return getDb().select().from(avatarVideos).where(and(eq(avatarVideos.id, id), eq(avatarVideos.organizationId, orgId))).limit(1).all()[0] || null;
}
export function listAvatarVideos(orgId: number, limit = 200) {
  return getDb().select().from(avatarVideos).where(eq(avatarVideos.organizationId, orgId)).orderBy(desc(avatarVideos.id)).limit(limit).all();
}
export function listMakingAvatarVideos() {
  return getDb().select().from(avatarVideos).where(eq(avatarVideos.status, "making")).all();
}
export function updateAvatarVideo(id: number, orgId: number, data: Partial<typeof avatarVideos.$inferInsert>) {
  getDb().update(avatarVideos).set(data).where(and(eq(avatarVideos.id, id), eq(avatarVideos.organizationId, orgId))).run();
  return getAvatarVideo(id, orgId);
}
export function deleteAvatarVideo(id: number, orgId: number) {
  getDb().delete(avatarVideos).where(and(eq(avatarVideos.id, id), eq(avatarVideos.organizationId, orgId))).run();
}

// ==========================================
// History imports (Claude and ChatGPT exports into the Brain)
// ==========================================

export function createHistoryImport(row: typeof historyImports.$inferInsert) {
  return getDb().insert(historyImports).values(row).returning().all()[0];
}
export function getHistoryImport(id: number, orgId: number) {
  return getDb().select().from(historyImports).where(and(eq(historyImports.id, id), eq(historyImports.organizationId, orgId))).limit(1).all()[0] || null;
}
export function listHistoryImports(orgId: number, limit = 20) {
  return getDb().select().from(historyImports).where(eq(historyImports.organizationId, orgId)).orderBy(desc(historyImports.id)).limit(limit).all();
}
export function listRunningHistoryImports() {
  return getDb().select().from(historyImports).where(inArray(historyImports.status, ["reading", "running"])).all();
}
export function updateHistoryImport(id: number, orgId: number, data: Partial<typeof historyImports.$inferInsert>) {
  getDb().update(historyImports).set(data).where(and(eq(historyImports.id, id), eq(historyImports.organizationId, orgId))).run();
  return getHistoryImport(id, orgId);
}

// ==========================================
// Claude / ChatGPT connector links
// ==========================================

export function getMcpLink(userId: number, orgId: number) {
  return getDb().select().from(mcpLinks).where(and(eq(mcpLinks.userId, userId), eq(mcpLinks.organizationId, orgId))).limit(1).all()[0] || null;
}
export function mcpLinkByHash(tokenHash: string) {
  return getDb().select().from(mcpLinks).where(eq(mcpLinks.tokenHash, tokenHash)).limit(1).all()[0] || null;
}
export function replaceMcpLink(row: typeof mcpLinks.$inferInsert) {
  getDb().delete(mcpLinks).where(and(eq(mcpLinks.userId, row.userId), eq(mcpLinks.organizationId, row.organizationId))).run();
  return getDb().insert(mcpLinks).values(row).returning().all()[0];
}
export function touchMcpLink(id: number, client: string | null) {
  getDb().update(mcpLinks).set({ lastUsedAt: new Date(), ...(client ? { lastClient: client } : {}) }).where(eq(mcpLinks.id, id)).run();
}
export function deleteMcpLink(userId: number, orgId: number) {
  getDb().delete(mcpLinks).where(and(eq(mcpLinks.userId, userId), eq(mcpLinks.organizationId, orgId))).run();
}

// ==========================================
// Kai's code changes
// ==========================================

export function createDevChange(row: typeof devChanges.$inferInsert) {
  return getDb().insert(devChanges).values(row).returning().all()[0];
}
export function getDevChange(id: number, orgId: number) {
  return getDb().select().from(devChanges).where(and(eq(devChanges.id, id), eq(devChanges.organizationId, orgId))).limit(1).all()[0] || null;
}
export function listDevChanges(orgId: number, limit = 100) {
  return getDb().select().from(devChanges).where(eq(devChanges.organizationId, orgId)).orderBy(desc(devChanges.id)).limit(limit).all();
}
export function listOpenDevChanges() {
  return getDb().select().from(devChanges).where(inArray(devChanges.status, ["working", "ready"])).all();
}
export function updateDevChange(id: number, orgId: number, data: Partial<typeof devChanges.$inferInsert>) {
  getDb().update(devChanges).set({ ...data, updatedAt: new Date() }).where(and(eq(devChanges.id, id), eq(devChanges.organizationId, orgId))).run();
  return getDevChange(id, orgId);
}
