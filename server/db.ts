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

export async function listKnowledgeByOrg(orgId: number) {
  return getDb()
    .select()
    .from(organizationKnowledge)
    .where(eq(organizationKnowledge.organizationId, orgId))
    .orderBy(organizationKnowledge.category, organizationKnowledge.id)
    .all();
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
