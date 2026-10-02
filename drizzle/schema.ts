import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/**
 * LeadDash Employees database (SQLite, one file on the server).
 *
 * Timestamps are stored as unix seconds and read back as Date objects.
 * Every table that belongs to a workspace carries organizationId, and every
 * query in server/db.ts filters on it.
 */

const createdAt = () =>
  integer("createdAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer("updatedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

// ==========================================
// People and sign-in
// ==========================================

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name"),
  /** admin = LeadDash staff (support access to every workspace). user = everyone else. */
  role: text("role", { enum: ["user", "admin"] }).notNull().default("user"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" }),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** One-time email sign-in codes. Only a hash of the code is stored. */
export const loginCodes = sqliteTable(
  "login_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    codeHash: text("codeHash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    usedAt: integer("usedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("login_codes_email_idx").on(t.email)]
);

/** Signed-in sessions. The cookie holds a random token; only its hash is stored. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId").notNull(),
    tokenHash: text("tokenHash").notNull().unique(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revokedAt", { mode: "timestamp" }),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)]
);

// ==========================================
// Workspaces
// ==========================================

export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan", { enum: ["starter", "growth", "enterprise"] }).notNull().default("growth"),
  focusAreas: text("focusAreas"),
  ein: text("ein"),
  annualBudget: text("annualBudget"),
  website: text("website"),
  state: text("state"),
  logoUrl: text("logoUrl"),
  /** What the business is, in a sentence or two. */
  description: text("description"),
  /** Who it serves. */
  audience: text("audience"),
  /** Legal entity, e.g. "LeadDash Marketing LLC (for-profit)". Grant eligibility depends on it. */
  entity: text("entity"),
  /** JSON array of hex colors. */
  brandColors: text("brandColors"),
  fonts: text("fonts"),
  /** IANA time zone for scheduled tasks, e.g. America/Chicago. */
  timezone: text("timezone").notNull().default("America/Chicago"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = typeof organizations.$inferInsert;

export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    userId: integer("userId").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "reviewer"] }).notNull().default("member"),
    title: text("title"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("organization_members_user_organization_unique").on(t.organizationId, t.userId)]
);

export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type InsertOrganizationMember = typeof organizationMembers.$inferInsert;

// ==========================================
// AI employees
// ==========================================

export const EMPLOYEE_KINDS = [
  "grants",
  "speaking",
  "inbox",
  "social",
  "blog",
  "website",
  "video",
  "custom",
] as const;
export type EmployeeKind = (typeof EMPLOYEE_KINDS)[number];

export const aiEmployees = sqliteTable(
  "ai_employees",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    /** Which job this employee does. Decides its instructions, output shape and tools. */
    kind: text("kind", { enum: EMPLOYEE_KINDS }).notNull().default("custom"),
    name: text("name").notNull(),
    avatar: text("avatar"),
    roleTitle: text("roleTitle").notNull(),
    department: text("department").notNull(),
    status: text("status", { enum: ["active", "idle", "working", "paused"] }).notNull().default("active"),
    efficiency: integer("efficiency").notNull().default(98),
    tasksCompleted: integer("tasksCompleted").notNull().default(0),
    hoursSaved: integer("hoursSaved").notNull().default(0),
    description: text("description"),
    capabilities: text("capabilities"),
    /** Extra instructions the workspace adds on top of the built-in ones for this job. */
    systemPrompt: text("systemPrompt"),
    /** JSON {focus, avoid, signAs}: the three Guidelines fields. */
    guidelines: text("guidelines"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ai_employees_org_idx").on(t.organizationId)]
);

export type AIEmployee = typeof aiEmployees.$inferSelect;
export type InsertAIEmployee = typeof aiEmployees.$inferInsert;

// ==========================================
// Grants
// ==========================================

export const grantOpportunities = sqliteTable(
  "grant_opportunities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    funder: text("funder").notNull(),
    source: text("source").notNull(),
    sourceUrl: text("sourceUrl"),
    deadline: text("deadline"),
    fundingAmount: text("fundingAmount"),
    matchScore: integer("matchScore").notNull().default(0),
    status: text("status", {
      enum: ["discovered", "qualified", "drafting", "under_review", "approved_ready", "submitted", "archived"],
    })
      .notNull()
      .default("discovered"),
    summary: text("summary"),
    eligibility: text("eligibility"),
    /** Why this fits the workspace, in the employee's words. */
    fitReason: text("fitReason"),
    deliverables: text("deliverables"),
    /** JSON array of the web searches the employee ran to find this. */
    searchQueries: text("searchQueries"),
    assignedEmployeeId: integer("assignedEmployeeId"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("grant_opportunities_org_idx").on(t.organizationId)]
);

export type GrantOpportunity = typeof grantOpportunities.$inferSelect;
export type InsertGrantOpportunity = typeof grantOpportunities.$inferInsert;

export const grantProposals = sqliteTable(
  "grant_proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    opportunityId: integer("opportunityId").notNull(),
    employeeId: integer("employeeId").notNull(),
    title: text("title").notNull(),
    version: text("version").notNull().default("v1.0"),
    status: text("status", {
      enum: ["drafting", "pending_review", "changes_requested", "approved", "ready_for_portal"],
    })
      .notNull()
      .default("drafting"),
    executiveSummary: text("executiveSummary"),
    statementOfNeed: text("statementOfNeed"),
    programDesign: text("programDesign"),
    budgetNarrative: text("budgetNarrative"),
    evaluationPlan: text("evaluationPlan"),
    complianceChecklist: text("complianceChecklist"),
    reviewerNotes: text("reviewerNotes"),
    approvedBy: text("approvedBy"),
    approvedAt: integer("approvedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("grant_proposals_org_idx").on(t.organizationId)]
);

export type GrantProposal = typeof grantProposals.$inferSelect;
export type InsertGrantProposal = typeof grantProposals.$inferInsert;

// ==========================================
// Work items for the other employees (speaking, website, video)
// ==========================================

export const WORK_ITEM_KINDS = ["speaking_opportunity", "website_plan", "video_plan"] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const workItems = sqliteTable(
  "work_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId"),
    kind: text("kind", { enum: WORK_ITEM_KINDS }).notNull(),
    status: text("status", { enum: ["new", "drafted", "sent_to_approval", "dismissed", "done"] })
      .notNull()
      .default("new"),
    title: text("title").notNull(),
    /** JSON object; shape depends on kind (see server/employees/roster.ts). */
    data: text("data").notNull().default("{}"),
    sourceUrl: text("sourceUrl"),
    searchQueries: text("searchQueries"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("work_items_org_kind_idx").on(t.organizationId, t.kind)]
);

export type WorkItem = typeof workItems.$inferSelect;
export type InsertWorkItem = typeof workItems.$inferInsert;

// ==========================================
// Brain (shared knowledge every employee reads)
// ==========================================

export const KNOWLEDGE_CATEGORIES = [
  "mission_profile",
  "voice_tone",
  "services_offers",
  "past_performance",
  "certifications_licenses",
  "team_bios",
  "financial_data",
  "speaking",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const organizationKnowledge = sqliteTable(
  "organization_knowledge",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    category: text("category", { enum: KNOWLEDGE_CATEGORIES }).notNull(),
    /** fact = typed by a person; webpage = fetched from a URL; image / document = uploaded file. */
    kind: text("kind", { enum: ["fact", "webpage", "image", "document"] }).notNull().default("fact"),
    content: text("content").notNull(),
    sourceUrl: text("sourceUrl"),
    fileUrl: text("fileUrl"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("organization_knowledge_org_idx").on(t.organizationId)]
);

export type OrganizationKnowledge = typeof organizationKnowledge.$inferSelect;
export type InsertOrganizationKnowledge = typeof organizationKnowledge.$inferInsert;

// ==========================================
// Audit trail
// ==========================================

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    actorType: text("actorType", { enum: ["employee", "human_user", "system"] }).notNull(),
    actorName: text("actorName").notNull(),
    action: text("action").notNull(),
    details: text("details"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_idx").on(t.organizationId)]
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ==========================================
// Connections and the approval queue
// ==========================================

export const PROVIDERS = ["google_workspace", "linkedin", "facebook", "instagram", "wordpress", "x", "google_business"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const externalConnections = sqliteTable(
  "external_connections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    accountLabel: text("accountLabel").notNull(),
    accountHandle: text("accountHandle"),
    status: text("status", { enum: ["disconnected", "pending", "connected", "error"] })
      .notNull()
      .default("disconnected"),
    capabilities: text("capabilities"),
    /** Non-secret settings (JSON). Secret values are never stored here. */
    settings: text("settings"),
    /** Secret values (client secret, app password, tokens), AES-256-GCM encrypted with SECRETS_KEY. */
    secretsEncrypted: text("secretsEncrypted"),
    connectedAt: integer("connectedAt", { mode: "timestamp" }),
    lastCheckedAt: integer("lastCheckedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("external_connections_org_provider_unique").on(t.organizationId, t.provider)]
);

export type ExternalConnection = typeof externalConnections.$inferSelect;
export type InsertExternalConnection = typeof externalConnections.$inferInsert;

export const OUTBOUND_KINDS = ["email_draft", "calendar_hold", "social_post", "blog_post", "speaking_pitch"] as const;
export type OutboundKind = (typeof OUTBOUND_KINDS)[number];

export const outboundItems = sqliteTable(
  "outbound_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId"),
    kind: text("kind", { enum: OUTBOUND_KINDS }).notNull(),
    status: text("status", {
      enum: [
        "drafting",
        "pending_approval",
        "changes_requested",
        "approved",
        "scheduled",
        "published",
        "blocked_connection",
        "cancelled",
      ],
    })
      .notNull()
      .default("drafting"),
    title: text("title").notNull(),
    body: text("body"),
    targetChannels: text("targetChannels"),
    imagePrompt: text("imagePrompt"),
    imageUrl: text("imageUrl"),
    metadata: text("metadata"),
    reviewerNotes: text("reviewerNotes"),
    scheduledFor: integer("scheduledFor", { mode: "timestamp" }),
    approvedBy: text("approvedBy"),
    approvedAt: integer("approvedAt", { mode: "timestamp" }),
    externalReference: text("externalReference"),
    publishedAt: integer("publishedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outbound_items_org_idx").on(t.organizationId)]
);

export type OutboundItem = typeof outboundItems.$inferSelect;
export type InsertOutboundItem = typeof outboundItems.$inferInsert;

// ==========================================
// Chat with each employee
// ==========================================

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    role: text("role", { enum: ["user", "employee"] }).notNull(),
    /** The person's real name, the employee's name, or "Scheduled task". */
    authorName: text("authorName").notNull(),
    userId: integer("userId"),
    content: text("content").notNull(),
    /** JSON array of result cards shown under the message (grants, events, posts...). */
    cards: text("cards"),
    /** JSON array of the web searches run for this reply. */
    searchQueries: text("searchQueries"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_org_emp_idx").on(t.organizationId, t.employeeId)]
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type InsertChatMessage = typeof chatMessages.$inferInsert;

/** When each person last opened each chat, for unread counts. */
export const chatReads = sqliteTable(
  "chat_reads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    userId: integer("userId").notNull(),
    lastReadAt: integer("lastReadAt", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("chat_reads_unique").on(t.organizationId, t.employeeId, t.userId)]
);

// ==========================================
// Scheduled tasks
// ==========================================

export const REPEATS = ["once", "daily", "weekdays", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    title: text("title").notNull(),
    /** Sent to the employee as a chat message each time the task runs. */
    instructions: text("instructions").notNull(),
    repeat: text("repeat", { enum: REPEATS }).notNull(),
    /** 0 = Sunday ... 6 = Saturday, for weekly. */
    weekday: integer("weekday"),
    /** 1-28, for monthly. */
    monthDay: integer("monthDay"),
    /** Local time "HH:MM" in the workspace time zone. */
    time: text("time").notNull(),
    /** For "once": the local date "YYYY-MM-DD". */
    onDate: text("onDate"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextRunAt: integer("nextRunAt", { mode: "timestamp" }),
    lastRunAt: integer("lastRunAt", { mode: "timestamp" }),
    lastStatus: text("lastStatus", { enum: ["ok", "failed"] }),
    lastError: text("lastError"),
    createdBy: text("createdBy"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scheduled_tasks_org_idx").on(t.organizationId)]
);

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type InsertScheduledTask = typeof scheduledTasks.$inferInsert;

export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    taskId: integer("taskId").notNull(),
    status: text("status", { enum: ["ok", "failed"] }).notNull(),
    error: text("error"),
    messageId: integer("messageId"),
    startedAt: integer("startedAt", { mode: "timestamp" }).notNull(),
    finishedAt: integer("finishedAt", { mode: "timestamp" }),
  },
  (t) => [index("task_runs_org_idx").on(t.organizationId, t.taskId)]
);

export type TaskRun = typeof taskRuns.$inferSelect;
