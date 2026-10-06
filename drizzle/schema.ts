import { integer, real, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

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
  /** The person's own photo (shown instead of their initials). */
  avatarUrl: text("avatarUrl"),
  /** admin = LeadDash staff (support access to every workspace). user = everyone else. */
  role: text("role", { enum: ["user", "admin"] }).notNull().default("user"),
  /** JSON {event: {push: boolean, email: boolean}} for the "Tell me when" choices. */
  notifyPrefs: text("notifyPrefs"),
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

/** What kind of organization a workspace is. It decides the roster, the titles and the client information rules. */
export const ORG_TYPES = ["business", "nonprofit", "healthcare"] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan", { enum: ["starter", "growth", "enterprise"] }).notNull().default("growth"),
  /** business, nonprofit or healthcare (a practice: no outbound sales, billing and compliance employees, client information rules). */
  orgType: text("orgType", { enum: ORG_TYPES }).notNull().default("business"),
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
  /** Who signs applications, e.g. "Ashley R. Bryant" and "CEO". */
  signerName: text("signerName"),
  signerTitle: text("signerTitle"),
  /** JSON sales settings: what the workspace sells, who Riley looks for, lead form token, meeting hours. */
  sales: text("sales"),
  /** JSON leadership settings: Simone's meetings (link, repeating meetings, agenda timing) and Nora's ClickUp choices. */
  ops: text("ops"),
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
    /** chat = team chat only: channels and direct messages, the Team page and their account, nothing else. */
    role: text("role", { enum: ["owner", "admin", "member", "chat", "reviewer"] }).notNull().default("member"),
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
  "hiring",
  "prospecting",
  "outreach",
  "leads",
  "coo",
  "projects",
  "developer",
  "onboarding",
  "platform",
  "ads",
  "billing",
  "compliance",
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
    /** False for a roster employee the organization type leaves off the team (Sales in a healthcare practice). Hidden everywhere; comes back if the type changes. */
    onTeam: integer("onTeam", { mode: "boolean" }).notNull().default(true),
    efficiency: integer("efficiency").notNull().default(98),
    tasksCompleted: integer("tasksCompleted").notNull().default(0),
    hoursSaved: integer("hoursSaved").notNull().default(0),
    description: text("description"),
    capabilities: text("capabilities"),
    /** Extra instructions the workspace adds on top of the built-in ones for this job. */
    systemPrompt: text("systemPrompt"),
    /** JSON {v: 2, sections: {key: [{id, text, source, at}]}, conflicts, dismissed}. Older rows hold {focus, avoid, signAs}. */
    guidelines: text("guidelines"),
    /** JSON {questionKey: answer}: the Onboarding answers. */
    onboarding: text("onboarding"),
    /** JSON: where the onboarding interview stands (part, done, welcome and reminder times, voice samples, examples, follow-ups). */
    interview: text("interview"),
    /** JSON [{when, what}]: "A day with" this employee, written from the answers. */
    dayToDay: text("dayToDay"),
    /** JSON {rules: {ruleKey: "ask"|"first5"|"auto"}, approved: {ruleKey: count}}: what it does on its own. */
    autonomy: text("autonomy"),
    /** JSON AvatarSettings: Elena's avatar videos of the owner (photo, voice, quality, monthly limit). */
    studio: text("studio"),
    onboardedAt: integer("onboardedAt", { mode: "timestamp" }),
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
  "procedures",
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
    /** Set for an employee's own Knowledge; null for the shared Brain. */
    employeeId: integer("employeeId"),
    /** Knowledge folder, e.g. "Past applications". */
    folder: text("folder"),
    /** How much was read: pages for PDF and Word, sheets for Excel, slides for PowerPoint. */
    pages: integer("pages"),
    /** "pages" | "sheets" | "slides" | "words" */
    pagesUnit: text("pagesUnit"),
    /** Characters of text read in full (the chunks hold all of it). */
    chars: integer("chars"),
    /** How the text was read, e.g. "from the image" for scanned PDFs. */
    readNote: text("readNote"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("organization_knowledge_org_idx").on(t.organizationId)]
);

/**
 * Every document an employee can read, split into passages. A full-text index
 * (knowledge_fts, created in migration 0002) finds the passages that answer
 * each application question, so long documents are read in full.
 */
export const knowledgeChunks = sqliteTable(
  "knowledge_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    /** "knowledge" = a Brain or Knowledge entry; "opp_file" = a file from a funder's package. */
    sourceType: text("sourceType", { enum: ["knowledge", "opp_file"] }).notNull(),
    sourceId: integer("sourceId").notNull(),
    employeeId: integer("employeeId"),
    seq: integer("seq").notNull(),
    heading: text("heading"),
    text: text("text").notNull(),
  },
  (t) => [index("knowledge_chunks_src_idx").on(t.organizationId, t.sourceType, t.sourceId)]
);

export type KnowledgeChunk = typeof knowledgeChunks.$inferSelect;

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
    /** The person who did it, when a person did. */
    userId: integer("userId"),
    /** JSON: what Activity's People tab needs to show and undo it, e.g. {kind: "guideline", employeeId, section, before, after}. */
    data: text("data"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_idx").on(t.organizationId)]
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ==========================================
// Connections and the approval queue
// ==========================================

export const PROVIDERS = ["google_workspace", "linkedin", "facebook", "instagram", "wordpress", "x", "google_business", "submittable", "sessionize", "threads", "tiktok", "clickup", "zoom", "recall", "bidprime", "leaddash_ehr"] as const;
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

export const OUTBOUND_KINDS = ["email_draft", "calendar_hold", "social_post", "blog_post", "speaking_pitch", "hiring_email", "outreach_email", "lead_reply"] as const;
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
    /** "handoff" lines show another employee passing work to this one. */
    role: text("role", { enum: ["user", "employee", "handoff"] }).notNull(),
    /** The person's real name, the employee's name, or "Scheduled task". */
    authorName: text("authorName").notNull(),
    userId: integer("userId"),
    content: text("content").notNull(),
    /** JSON array of result cards shown under the message (grants, events, posts...). */
    cards: text("cards"),
    /** JSON array of the web searches run for this reply. */
    searchQueries: text("searchQueries"),
    /** JSON [{id, name, size, kind, url}]: files the person attached (chat_files). */
    attachments: text("attachments"),
    /** Said out loud in a one-on-one: the person spoke it, or the employee's answer was played. */
    spoken: integer("spoken", { mode: "boolean" }).notNull().default(false),
    /** The message this one answers (Reply on a message), shown as a quote above it. */
    replyToId: integer("replyToId"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_org_emp_idx").on(t.organizationId, t.employeeId)]
);

/** A file attached in an employee's chat: its stored copy and the text the employee reads from it. */
export const chatFiles = sqliteTable(
  "chat_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    userId: integer("userId"),
    /** Set once the file is sent with a message. */
    messageId: integer("messageId"),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    kind: text("kind", { enum: ["image", "document"] }).notNull(),
    fileUrl: text("fileUrl").notNull(),
    /** The document's text, or a description of the photo. */
    text: text("text").notNull().default(""),
    pages: integer("pages"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_files_org_idx").on(t.organizationId, t.employeeId)]
);
export type ChatFile = typeof chatFiles.$inferSelect;

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
    /** How the person hears about each run: a push notice, an email, or only the chat. */
    notify: text("notify", { enum: ["push", "email", "chat"] }).notNull().default("chat"),
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

// ==========================================
// Applying: opportunities, applications, registrations
// (one engine for Morgan's grants, pitch competitions and accelerators and
// Taylor's speaking calls)
// ==========================================

export const OPP_KINDS = ["grant", "pitch", "accelerator", "speaking", "bid", "media"] as const;
export type OppKind = (typeof OPP_KINDS)[number];

export const opportunities = sqliteTable(
  "opportunities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId"),
    kind: text("kind", { enum: OPP_KINDS }).notNull(),
    title: text("title").notNull(),
    /** Funder, competition host or event organizer. */
    host: text("host").notNull(),
    sourceUrl: text("sourceUrl"),
    source: text("source"),
    deadline: text("deadline"),
    /** Award range, prize, or what a speaking slot pays. */
    amount: text("amount"),
    equity: text("equity"),
    stage: text("stage"),
    eligibility: text("eligibility"),
    location: text("location"),
    eventDate: text("eventDate"),
    audience: text("audience"),
    /** Speaking: the session to pitch. */
    angle: text("angle"),
    summary: text("summary"),
    fitScore: integer("fitScore").notNull().default(0),
    fitCall: text("fitCall", { enum: ["apply", "partner", "skip"] }).notNull().default("apply"),
    fitReason: text("fitReason"),
    funderHistory: text("funderHistory"),
    funderHistoryUrl: text("funderHistoryUrl"),
    status: text("status", { enum: ["new", "applying", "dismissed"] }).notNull().default("new"),
    searchQueries: text("searchQueries"),
    /** JSON: what the host requires (questions, limits, scoring, attachments, AI rule). */
    requirements: text("requirements"),
    packageStatus: text("packageStatus", { enum: ["none", "fetching", "ready", "failed"] }).notNull().default("none"),
    packageNote: text("packageNote"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("opportunities_org_idx").on(t.organizationId, t.kind)]
);

export type Opportunity = typeof opportunities.$inferSelect;
export type InsertOpportunity = typeof opportunities.$inferInsert;

/** Files downloaded from a host's page: the RFP, question sheets, templates, forms. */
export const opportunityFiles = sqliteTable(
  "opportunity_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    opportunityId: integer("opportunityId").notNull(),
    name: text("name").notNull(),
    sourceUrl: text("sourceUrl"),
    fileUrl: text("fileUrl"),
    pages: integer("pages"),
    pagesUnit: text("pagesUnit"),
    chars: integer("chars"),
    status: text("status", { enum: ["read", "failed", "needs_signature"] }).notNull().default("read"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("opportunity_files_opp_idx").on(t.organizationId, t.opportunityId)]
);

export type OpportunityFile = typeof opportunityFiles.$inferSelect;

export const APPLICATION_STATUSES = [
  "writing",
  "needs_answer",
  "ready",
  "approved",
  "submitted",
  "awarded",
  "declined",
  "needs_setup",
  "error",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    opportunityId: integer("opportunityId").notNull(),
    employeeId: integer("employeeId"),
    title: text("title").notNull(),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("writing"),
    /** draft = the employee writes it; outline = the host restricts AI, so the person writes from an outline. */
    mode: text("mode", { enum: ["draft", "outline"] }).notNull().default("draft"),
    /** How it goes in: form, email, grants_gov, submittable, sessionize, portal. */
    channel: text("channel").notNull().default("form"),
    channelDetail: text("channelDetail"),
    /** JSON array of questions with answers. */
    questions: text("questions").notNull().default("[]"),
    /** JSON array of attachments. */
    attachments: text("attachments").notNull().default("[]"),
    /** JSON: pitch deck slides, video script, uploaded video. */
    extras: text("extras"),
    /** JSON: the reviewer check. */
    review: text("review"),
    progress: text("progress"),
    errorNote: text("errorNote"),
    certifiedBy: text("certifiedBy"),
    certifiedAt: integer("certifiedAt", { mode: "timestamp" }),
    submittedAt: integer("submittedAt", { mode: "timestamp" }),
    confirmation: text("confirmation"),
    receiptUrl: text("receiptUrl"),
    decisionExpected: text("decisionExpected"),
    /** JSON: award amount, period, restrictions, reports, spending. */
    award: text("award"),
    reviewerComments: text("reviewerComments"),
    reapplyDate: text("reapplyDate"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("applications_org_idx").on(t.organizationId)]
);

export type Application = typeof applications.$inferSelect;
export type InsertApplication = typeof applications.$inferInsert;

/** A fact the employee needs that the Brain does not have, asked with fixed choices. */
export const employeeQuestions = sqliteTable(
  "employee_questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    applicationId: integer("applicationId"),
    label: text("label").notNull(),
    question: text("question").notNull(),
    /** JSON array of choices. */
    options: text("options").notNull(),
    answer: text("answer"),
    answeredBy: text("answeredBy"),
    answeredAt: integer("answeredAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("employee_questions_org_idx").on(t.organizationId)]
);

export type EmployeeQuestion = typeof employeeQuestions.$inferSelect;

export const REGISTRATION_KINDS = ["sam", "grants_gov", "login_gov", "sbir", "state_supplier", "candid"] as const;
export type RegistrationKind = (typeof REGISTRATION_KINDS)[number];

export const registrations = sqliteTable(
  "registrations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    kind: text("kind", { enum: REGISTRATION_KINDS }).notNull(),
    status: text("status", { enum: ["active", "set_up", "not_verified", "not_started", "expired"] }).notNull().default("not_started"),
    /** JSON: uei, email, role, number, note. */
    details: text("details").notNull().default("{}"),
    /** MM/DD/YYYY. */
    expires: text("expires"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("registrations_org_kind_unique").on(t.organizationId, t.kind)]
);

export type Registration = typeof registrations.$inferSelect;

/** Website logins every employee can use in their browser (agency portals, the LeadDash platform...). Passwords and saved sessions are encrypted with SECRETS_KEY. */
export const portalLogins = sqliteTable(
  "portal_logins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    username: text("username").notNull(),
    secretEncrypted: text("secretEncrypted"),
    /** The one sub-account this login may open (its name, for people). */
    lockName: text("lockName"),
    /** That sub-account's id from its web address. Every other sub-account is refused. */
    lockId: text("lockId"),
    /** Encrypted cookies from the last run, so a sign-in code is rarely needed. */
    sessionEncrypted: text("sessionEncrypted"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("portal_logins_org_idx").on(t.organizationId)]
);

export type PortalLogin = typeof portalLogins.$inferSelect;

// ==========================================
// Push notifications
// ==========================================

/** One row per browser or phone that turned on push. */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("userId").notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** "iPhone", "Chrome on Mac"... from the browser. */
    device: text("device").notNull(),
    lastSentAt: integer("lastSentAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)]
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

// ==========================================
// Hiring (Quinn)
// ==========================================

export const hrRoles = sqliteTable(
  "hr_roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    employment: text("employment", { enum: ["w2", "1099"] }).notNull().default("w2"),
    hours: text("hours", { enum: ["full", "part"] }).notNull().default("full"),
    place: text("place", { enum: ["in_person", "telehealth", "both"] }).notNull().default("both"),
    payFrom: text("payFrom"),
    payTo: text("payTo"),
    /** JSON string[]: LPC, LMFT, LCSW, Licensed candidate, LADC... */
    licenses: text("licenses").notNull().default("[]"),
    mustHave: text("mustHave"),
    niceToHave: text("niceToHave"),
    /** The job post Quinn wrote. */
    post: text("post"),
    /** JSON [{name, status, url}]: where the post goes. */
    targets: text("targets").notNull().default("[]"),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("hr_roles_org_idx").on(t.organizationId)]
);

export type HrRole = typeof hrRoles.$inferSelect;

export const HR_STAGES = ["prospect", "contacted", "replied", "dnc", "new", "interview", "hold", "offer", "passed", "hired"] as const;
export type HrStage = (typeof HR_STAGES)[number];

/** Applicants and outreach prospects. Prospects hold work facts only. */
export const hrPeople = sqliteTable(
  "hr_people",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    roleId: integer("roleId"),
    source: text("source", { enum: ["applicant", "prospect"] }).notNull(),
    stage: text("stage", { enum: HR_STAGES }).notNull(),
    name: text("name").notNull(),
    /** "LPC", "LMFT, LADC"... */
    credentials: text("credentials"),
    currentRole: text("currentRole"),
    location: text("location"),
    /** "LinkedIn", "Practice team page"... */
    foundOn: text("foundOn"),
    sourceUrl: text("sourceUrl"),
    /** A work email: from the applicant, or published on the person's practice site. */
    email: text("email"),
    resumeUrl: text("resumeUrl"),
    resumeText: text("resumeText"),
    fitScore: integer("fitScore").notNull().default(0),
    fitReason: text("fitReason"),
    /** JSON [{item, met: "yes"|"no"|"unknown", kind: "must"|"nice"}]. */
    mustHaves: text("mustHaves").notNull().default("[]"),
    /** JSON [{name, detail, status: "clear"|"flag"|"manual"|"needs_setup", url, checkedAt}]. */
    checks: text("checks").notNull().default("[]"),
    /** The outreach message Quinn drafted. */
    message: text("message"),
    contactedAt: integer("contactedAt", { mode: "timestamp" }),
    followUpAt: integer("followUpAt", { mode: "timestamp" }),
    appliedOn: text("appliedOn"),
    /** MM/DD/YYYY. */
    startDate: text("startDate"),
    /** JSON {paperwork: [{item, detail, status}], credentialing: [...]} once hired. */
    onboarding: text("onboarding"),
    /** Prospects nobody acted on are deleted after this. */
    purgeAt: integer("purgeAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("hr_people_org_idx").on(t.organizationId)]
);

export type HrPerson = typeof hrPeople.$inferSelect;

/** Team expirations and hour counts: licenses, CE, supervision, CPR... */
export const hrTeamItems = sqliteTable(
  "hr_team_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    person: text("person").notNull(),
    item: text("item").notNull(),
    /** MM/DD/YYYY, or "" for hour counts. */
    due: text("due"),
    /** "1,240 of 3,000 hours", "12 of 20 CE hours"... */
    progress: text("progress"),
    lastRemindedAt: integer("lastRemindedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("hr_team_items_org_idx").on(t.organizationId)]
);

export type HrTeamItem = typeof hrTeamItems.$inferSelect;

// ==========================================
// App review access (Google and Meta reviewers)
// ==========================================

/**
 * One row (id 1). While enabled and before endsAt, the review email signs in
 * with a fixed code instead of an emailed one, and only reaches the demo workspace.
 */
export const reviewAccess = sqliteTable("review_access", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  email: text("email").notNull().default("review@leaddash.io"),
  /** The 6-digit code, encrypted with SECRETS_KEY so staff can read it back. */
  codeEncrypted: text("codeEncrypted"),
  /** MM/DD/YYYY. Access ends at the end of this day (Central time). */
  endsOn: text("endsOn"),
  /** The demo workspace the reviewer lands in. */
  organizationId: integer("organizationId"),
  lastSignInAt: integer("lastSignInAt", { mode: "timestamp" }),
  updatedAt: updatedAt(),
});

export type ReviewAccess = typeof reviewAccess.$inferSelect;

// ==========================================
// Sales: Riley (prospects), Jada (outreach), Malik (new leads)
// ==========================================

export const PROSPECT_STAGES = ["new", "outreach", "replied", "booked", "not_fit"] as const;

export const salesProspects = sqliteTable(
  "sales_prospects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    /** "practice" when the workspace sells to practices, "referral" for a practice's referral partners. */
    kind: text("kind", { enum: ["practice", "referral"] }).notNull().default("practice"),
    stage: text("stage", { enum: PROSPECT_STAGES }).notNull().default("new"),
    name: text("name").notNull(),
    city: text("city"),
    contactName: text("contactName"),
    contactTitle: text("contactTitle"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    /** Where it was found, e.g. "hillcountrycounseling.com/team · Texas LPC lookup". */
    foundOn: text("foundOn"),
    sourceUrl: text("sourceUrl"),
    fitScore: integer("fitScore").notNull().default(0),
    fitReason: text("fitReason"),
    /** JSON extra facts: {size, partnerType}. */
    details: text("details"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sales_prospects_org_idx").on(t.organizationId)]
);

export type SalesProspect = typeof salesProspects.$inferSelect;
export type InsertSalesProspect = typeof salesProspects.$inferInsert;

export const LEAD_STATUSES = ["new", "replied", "booked", "closed"] as const;

export const salesLeads = sqliteTable(
  "sales_leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    status: text("status", { enum: LEAD_STATUSES }).notNull().default("new"),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    company: text("company"),
    message: text("message"),
    /** "Website form", "LeadDash platform form", "Booking page", "Reply to outreach". */
    source: text("source").notNull(),
    prospectId: integer("prospectId"),
    repliedAt: integer("repliedAt", { mode: "timestamp" }),
    bookedFor: integer("bookedFor", { mode: "timestamp" }),
    /** JSON {replyItemId, eventUrl, offered: [iso]}. */
    meta: text("meta"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sales_leads_org_idx").on(t.organizationId)]
);

export type SalesLead = typeof salesLeads.$inferSelect;
export type InsertSalesLead = typeof salesLeads.$inferInsert;

// ==========================================
// Activity: handoffs and finished work across employees
// ==========================================

export const teamActivity = sqliteTable(
  "team_activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId"),
    kind: text("kind", { enum: ["handoff", "sent", "done"] }).notNull(),
    text: text("text").notNull(),
    toEmployeeId: integer("toEmployeeId"),
    /** Where Open goes, e.g. "/chats/outreach/work". */
    link: text("link"),
    createdAt: createdAt(),
  },
  (t) => [index("team_activity_org_idx").on(t.organizationId)]
);

export type TeamActivity = typeof teamActivity.$inferSelect;

// ==========================================
// Nora (Projects): launches, milestones, tasks, KPIs and status reports
// ==========================================

export const LAUNCH_STATUSES = ["planning", "active", "done", "dropped"] as const;

export const launches = sqliteTable(
  "launches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    launchDate: integer("launchDate", { mode: "timestamp" }).notNull(),
    status: text("status", { enum: LAUNCH_STATUSES }).notNull().default("planning"),
    /** What the owner asked for, kept for re-planning. */
    brief: text("brief"),
    /** An ongoing project has no launch day; its launchDate is only a far-off placeholder. */
    ongoing: integer("ongoing", { mode: "boolean" }).notNull().default(false),
    /** Where it started, in words: "the Oct 5 huddle". */
    sourceNote: text("sourceNote"),
    /** The launch's list in Projects (this app's own task manager). */
    pjListId: integer("pjListId"),
    /** From before Projects replaced ClickUp; kept so old links still work. */
    clickupListId: text("clickupListId"),
    clickupListUrl: text("clickupListUrl"),
    /** JSON {doneStatus, openStatus, syncedAt}. */
    clickup: text("clickup"),
    approvedBy: text("approvedBy"),
    approvedAt: integer("approvedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("launches_org_idx").on(t.organizationId)]
);
export type Launch = typeof launches.$inferSelect;

export const launchMilestones = sqliteTable(
  "launch_milestones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    launchId: integer("launchId").notNull(),
    name: text("name").notNull(),
    dueDate: integer("dueDate", { mode: "timestamp" }).notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("launch_milestones_launch_idx").on(t.launchId)]
);
export type LaunchMilestone = typeof launchMilestones.$inferSelect;

export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;

export const launchTasks = sqliteTable(
  "launch_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    launchId: integer("launchId").notNull(),
    milestoneId: integer("milestoneId"),
    title: text("title").notNull(),
    details: text("details"),
    /** An employee's kind ("blog") or "person". */
    ownerType: text("ownerType", { enum: ["employee", "person"] }).notNull().default("person"),
    ownerKind: text("ownerKind"),
    /** A team member's name, or the employee's name. */
    ownerName: text("ownerName").notNull(),
    ownerEmail: text("ownerEmail"),
    dueDate: integer("dueDate", { mode: "timestamp" }).notNull(),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("todo"),
    waitingOn: text("waitingOn"),
    /** Nora's latest note, e.g. "Due in 3 days and not started. I reminded Jordan." */
    note: text("note"),
    /** The same task in Projects. */
    pjTaskId: integer("pjTaskId"),
    /** From before Projects replaced ClickUp. */
    clickupTaskId: text("clickupTaskId"),
    clickupUrl: text("clickupUrl"),
    clickupStatus: text("clickupStatus"),
    remindedAt: integer("remindedAt", { mode: "timestamp" }),
    doneAt: integer("doneAt", { mode: "timestamp" }),
    /** Where it came from: "plan" or a meeting id ("meeting:12"). */
    source: text("source").notNull().default("plan"),
    /** What will exist when the task is finished, e.g. "Article approved and published". */
    doneWhen: text("doneWhen"),
    /** JSON TaskWork: the employee's work on it and Nora's check (state, refs, summary). */
    work: text("work"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("launch_tasks_launch_idx").on(t.launchId), index("launch_tasks_org_idx").on(t.organizationId)]
);
export type LaunchTask = typeof launchTasks.$inferSelect;

export const KPI_SOURCES = ["demos_booked", "new_leads", "practices_contacted", "reply_rate", "posts_published", "articles_published", "tasks_on_time", "manual"] as const;
export type KpiSource = (typeof KPI_SOURCES)[number];

export const launchKpis = sqliteTable(
  "launch_kpis",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    launchId: integer("launchId").notNull(),
    name: text("name").notNull(),
    target: integer("target").notNull(),
    unit: text("unit", { enum: ["count", "percent"] }).notNull().default("count"),
    byDate: integer("byDate", { mode: "timestamp" }).notNull(),
    source: text("source", { enum: KPI_SOURCES }).notNull().default("manual"),
    /** For "You enter it". */
    manualValue: integer("manualValue"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("launch_kpis_launch_idx").on(t.launchId)]
);
export type LaunchKpi = typeof launchKpis.$inferSelect;

export const launchReports = sqliteTable(
  "launch_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    launchId: integer("launchId").notNull(),
    week: integer("week").notNull(),
    weeks: integer("weeks").notNull(),
    status: text("status", { enum: ["on_track", "behind"] }).notNull(),
    /** JSON {overall, done, behind, next, needsYou, rating?: green | amber | red, risks?}. */
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("launch_reports_launch_idx").on(t.launchId)]
);
export type LaunchReport = typeof launchReports.$inferSelect;

export const PROJECT_NOTE_KINDS = ["idea", "risk", "blocker", "decision"] as const;
export type ProjectNoteKind = (typeof PROJECT_NOTE_KINDS)[number];

/** Nora's running list: ideas (no project yet), and each project's risks, blockers and decisions. */
export const projectNotes = sqliteTable(
  "project_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    launchId: integer("launchId"),
    kind: text("kind", { enum: PROJECT_NOTE_KINDS }).notNull(),
    text: text("text").notNull(),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    createdBy: text("createdBy"),
    closedAt: integer("closedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("project_notes_org_idx").on(t.organizationId)]
);
export type ProjectNote = typeof projectNotes.$inferSelect;

// ==========================================
// Simone (COO): meetings
// ==========================================

export const MEETING_STATUSES = ["draft", "invited", "cancelled", "held"] as const;

export const meetings = sqliteTable(
  "meetings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    /** The repeating meeting it came from (ops.recurring[].id), or null for a one-time meeting. */
    seriesId: text("seriesId"),
    /** A project meeting: Nora writes the agenda and recap, and action items go to this launch. Null for Simone's meetings. */
    launchId: integer("launchId"),
    title: text("title").notNull(),
    startsAt: integer("startsAt", { mode: "timestamp" }).notNull(),
    minutes: integer("minutes").notNull().default(30),
    /** JSON [{name, email}]. */
    attendees: text("attendees").notNull().default("[]"),
    /** JSON employee kinds whose work goes on the agenda. */
    updatesFrom: text("updatesFrom").notNull().default("[]"),
    /** JSON [{at: "9:05", item, who, minutes}]. */
    agenda: text("agenda"),
    status: text("status", { enum: MEETING_STATUSES }).notNull().default("draft"),
    linkKind: text("linkKind", { enum: ["meet", "zoom"] }).notNull().default("meet"),
    link: text("link"),
    calendarEventId: text("calendarEventId"),
    eventUrl: text("eventUrl"),
    zoomMeetingId: text("zoomMeetingId"),
    inviteSentAt: integer("inviteSentAt", { mode: "timestamp" }),
    notes: text("notes"),
    notesAt: integer("notesAt", { mode: "timestamp" }),
    /** JSON [{text, owner, ownerKind, taskId, status}]. */
    actionItems: text("actionItems"),
    recapSentAt: integer("recapSentAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("meetings_org_idx").on(t.organizationId)]
);
export type Meeting = typeof meetings.$inferSelect;

// ==========================================
// Simone's notetaker: meetings on the calendar she sits in on
// ==========================================

/**
 * skipped: she is not joining (your choice, the settings, or a word that marks a client session).
 * scheduled: a Recall.ai bot is booked to join. joining / in_call: the bot is in the meeting.
 * processing: the meeting ended and the transcript and notes are being made.
 * ready: notes are done. failed: the bot or transcript failed. removed: someone removed her
 * or she was not let in. cancelled: the event left the calendar.
 */
export const NOTETAKER_STATUSES = ["skipped", "scheduled", "joining", "in_call", "processing", "ready", "failed", "removed", "cancelled"] as const;
export type NotetakerStatus = (typeof NOTETAKER_STATUSES)[number];

export const notetakerMeetings = sqliteTable(
  "notetaker_meetings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    /** Google Calendar event id (each occurrence of a repeating event has its own). */
    eventId: text("eventId").notNull(),
    title: text("title").notNull(),
    startsAt: integer("startsAt", { mode: "timestamp" }).notNull(),
    endsAt: integer("endsAt", { mode: "timestamp" }).notNull(),
    platform: text("platform", { enum: ["zoom", "meet", "teams"] }).notNull(),
    meetingUrl: text("meetingUrl").notNull(),
    /** The owner set this meeting up (is its organizer on the calendar). The default join rule is these only. */
    host: integer("host", { mode: "boolean" }).notNull().default(false),
    /** JSON [{name, email}] from the calendar invite. */
    attendees: text("attendees").notNull().default("[]"),
    /** auto follows the settings; join and skip are your choice for this one meeting. */
    choice: text("choice", { enum: ["auto", "join", "skip"] }).notNull().default("auto"),
    /** Why it is locked out (a word from the never-join list). Locked meetings are never joined. */
    lockReason: text("lockReason"),
    status: text("status", { enum: NOTETAKER_STATUSES }).notNull().default("skipped"),
    botId: text("botId"),
    recordingId: text("recordingId"),
    transcriptId: text("transcriptId"),
    /** "Name: what they said" lines. Kept after the recording is deleted. */
    transcript: text("transcript"),
    /** JSON {summary, decisions, questions}. */
    summary: text("summary"),
    /** JSON [{text, owner, ownerKind, taskId, status, due}]. */
    actionItems: text("actionItems"),
    heldMinutes: integer("heldMinutes"),
    error: text("error"),
    mediaDeletedAt: integer("mediaDeletedAt", { mode: "timestamp" }),
    recapSentAt: integer("recapSentAt", { mode: "timestamp" }),
    /** Simone's own meeting (meetings.id) when this event is one she scheduled. */
    meetingId: integer("meetingId"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notetaker_org_event_unique").on(t.organizationId, t.eventId), index("notetaker_org_start_idx").on(t.organizationId, t.startsAt)]
);
export type NotetakerMeeting = typeof notetakerMeetings.$inferSelect;

// ==========================================
// Usage: time saved and what the AI cost, per workspace and employee
// ==========================================

/** task = a finished piece of work (minutes saved); the rest are AI costs. */
export const USAGE_TYPES = ["task", "writing", "search", "image", "meeting"] as const;

export const usageEvents = sqliteTable(
  "usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId"),
    type: text("type", { enum: USAGE_TYPES }).notNull(),
    /** Minutes of work saved (tasks only). */
    minutes: integer("minutes").notNull().default(0),
    /** Estimated cost in millionths of a dollar. */
    costMicros: integer("costMicros").notNull().default(0),
    /** Tokens, searches, image size or meeting minutes, for checking the math. */
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("usage_org_time_idx").on(t.organizationId, t.createdAt)]
);
export type UsageEvent = typeof usageEvents.$inferSelect;

// ==========================================
// Handbook: the LeadDash base every employee follows, plus each workspace's additions
// ==========================================

/** A part of the base handbook that LeadDash staff edited. Parts not here use the text in code. */
export const handbookParts = sqliteTable("handbook_parts", {
  key: text("key").primaryKey(),
  /** JSON HandbookPart (title, lead, sections). */
  content: text("content").notNull(),
  updatedBy: text("updatedBy"),
  updatedAt: updatedAt(),
});
export type HandbookPartRow = typeof handbookParts.$inferSelect;

/** A workspace's own rules under one part of the handbook. */
export const handbookAdditions = sqliteTable(
  "handbook_additions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    partKey: text("partKey").notNull(),
    /** JSON string[]. */
    rules: text("rules").notNull(),
    updatedBy: text("updatedBy"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("handbook_add_org_part_idx").on(t.organizationId, t.partKey)]
);
export type HandbookAddition = typeof handbookAdditions.$inferSelect;

/** Who changed what in the handbook. organizationId null = the LeadDash base. */
export const handbookChanges = sqliteTable(
  "handbook_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId"),
    partKey: text("partKey").notNull(),
    actorName: text("actorName").notNull(),
    summary: text("summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("handbook_changes_time_idx").on(t.createdAt)]
);
export type HandbookChange = typeof handbookChanges.$inferSelect;

// ==========================================
// Jordan: landing and website pages built as HTML, with versions
// ==========================================

export const SITE_PAGE_STATUSES = ["building", "ready", "approved", "failed"] as const;

export const sitePages = sqliteTable(
  "site_pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId"),
    title: text("title").notNull(),
    /** landing | website */
    pageType: text("pageType").notNull().default("landing"),
    goal: text("goal").notNull().default(""),
    status: text("status", { enum: SITE_PAGE_STATUSES }).notNull().default("building"),
    /** Where the page's main button goes (booking page, form, checkout). */
    buttonUrl: text("buttonUrl"),
    /** A form or calendar embed code pasted by the owner, placed on the page. */
    embedCode: text("embedCode"),
    currentVersion: integer("currentVersion").notNull().default(0),
    /** What Jordan is doing right now, or why the last build failed. */
    progress: text("progress"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("site_pages_org_idx").on(t.organizationId)]
);
export type SitePage = typeof sitePages.$inferSelect;

export const sitePageVersions = sqliteTable(
  "site_page_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    pageId: integer("pageId").notNull(),
    version: integer("version").notNull(),
    /** The HTML to paste: fonts link, one scoped style block and the page markup. */
    html: text("html").notNull(),
    /** What changed in this version, in a few words. */
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("site_page_versions_idx").on(t.pageId, t.version)]
);
export type SitePageVersion = typeof sitePageVersions.$inferSelect;

/** Files given a public link (photos and images used on published pages). */
export const publicFiles = sqliteTable(
  "public_files",
  {
    token: text("token").primaryKey(),
    organizationId: integer("organizationId").notNull(),
    /** The stored file's key under the uploads folder. */
    fileKey: text("fileKey").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("public_files_key_idx").on(t.fileKey)]
);
export type PublicFile = typeof publicFiles.$inferSelect;

// ==========================================
// Team huddles: talking out loud with the employees
// ==========================================

export type HuddleLine = { who: string; kind: string | null; text: string; at: number };

/**
 * A huddle: you talk, the employees answer out loud in their own voices. In the
 * app (mode "room") or inside a Zoom or Meet through a Recall.ai bot ("meeting").
 */
export const huddles = sqliteTable(
  "huddles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    startedBy: integer("startedBy"),
    startedByName: text("startedByName").notNull(),
    /** JSON employee kinds in the huddle. */
    kinds: text("kinds").notNull().default("[]"),
    /** JSON HuddleLine[]. */
    transcript: text("transcript").notNull().default("[]"),
    status: text("status", { enum: ["live", "ended"] }).notNull().default("live"),
    /** Random secret for the meeting bot's page and its transcript webhook. */
    token: text("token").notNull(),
    meetingUrl: text("meetingUrl"),
    botId: text("botId"),
    /** The meeting record holding the notes and action items after it ends. */
    meetingId: integer("meetingId"),
    createdAt: createdAt(),
    endedAt: integer("endedAt", { mode: "timestamp" }),
  },
  (t) => [index("huddles_org_idx").on(t.organizationId), uniqueIndex("huddles_token_idx").on(t.token)]
);
export type Huddle = typeof huddles.$inferSelect;

/** A video of the owner made by AI from her photo and her voice (Elena). */
export const avatarVideos = sqliteTable(
  "avatar_videos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    title: text("title").notNull(),
    /** The exact words the owner says on camera. */
    script: text("script").notNull(),
    status: text("status", { enum: ["draft", "making", "ready", "failed"] }).notNull().default("draft"),
    /** The Brain image used as the face. */
    imageId: integer("imageId"),
    voiceId: text("voiceId"),
    voiceName: text("voiceName"),
    quality: text("quality", { enum: ["standard", "pro"] }).notNull().default("standard"),
    /** Length in tenths of a second, once made. */
    tenths: integer("tenths"),
    /** What it cost (or will cost, while a draft), in cents. */
    costCents: integer("costCents").notNull().default(0),
    requestId: text("requestId"),
    videoUrl: text("videoUrl"),
    error: text("error"),
    madeAt: integer("madeAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("avatar_videos_org_idx").on(t.organizationId)]
);
export type AvatarVideo = typeof avatarVideos.$inferSelect;

/** Company history read from an export of the owner's Claude or ChatGPT chats into the Brain. */
export const historyImports = sqliteTable(
  "history_imports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    userId: integer("userId"),
    who: text("who").notNull(),
    fileName: text("fileName").notNull(),
    /** Where the uploaded export is kept until the import finishes. */
    filePath: text("filePath").notNull(),
    source: text("source", { enum: ["claude", "chatgpt", "unknown"] }).notNull().default("unknown"),
    status: text("status", { enum: ["reading", "running", "done", "stopped", "failed"] }).notNull().default("reading"),
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    skippedClient: integer("skippedClient").notNull().default(0),
    skippedOther: integer("skippedOther").notNull().default(0),
    /** JSON [{id, topic, fact, from}]: Brain entries this import saved. */
    items: text("items").notNull().default("[]"),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: integer("finishedAt", { mode: "timestamp" }),
  },
  (t) => [index("history_imports_org_idx").on(t.organizationId)]
);
export type HistoryImport = typeof historyImports.$inferSelect;

/** A person's Claude / ChatGPT connector link for one workspace. The link holds a secret; New link replaces it. */
export const mcpLinks = sqliteTable(
  "mcp_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    userId: integer("userId").notNull(),
    /** sha256 of the secret in the link, to look it up. */
    tokenHash: text("tokenHash").notNull(),
    /** The secret itself, encrypted, so Copy link works later. */
    tokenEncrypted: text("tokenEncrypted").notNull(),
    lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
    lastClient: text("lastClient"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mcp_links_token_idx").on(t.tokenHash), index("mcp_links_user_idx").on(t.userId, t.organizationId)]
);
export type McpLink = typeof mcpLinks.$inferSelect;

/** A fix or change Kai asked Claude for in one of the owner's GitHub repos. */
export const devChanges = sqliteTable(
  "dev_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    /** owner/name on GitHub, and the name the owner uses for it. */
    repo: text("repo").notNull(),
    label: text("label").notNull(),
    title: text("title").notNull(),
    /** What Kai asked Claude for. */
    request: text("request").notNull(),
    issueNumber: integer("issueNumber"),
    issueUrl: text("issueUrl"),
    branch: text("branch"),
    prNumber: integer("prNumber"),
    prUrl: text("prUrl"),
    /** handed_off: no GitHub token, so the owner posts the issue herself from the link and follows it on GitHub. */
    status: text("status", { enum: ["working", "ready", "merged", "closed", "failed", "handed_off"] }).notNull().default("working"),
    /** JSON string[]: what changed, in plain words. */
    summary: text("summary").notNull().default("[]"),
    files: integer("files"),
    checks: text("checks"),
    error: text("error"),
    /** Id of the last Claude comment read, so a new one is noticed. */
    seenComment: integer("seenComment"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("dev_changes_org_idx").on(t.organizationId)]
);
export type DevChange = typeof devChanges.$inferSelect;

// ==========================================
// Browser jobs and the LeadDash platform
// ==========================================

/** One job an employee does in their browser, started from chat. */
export const webTasks = sqliteTable(
  "web_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    employeeId: integer("employeeId").notNull(),
    /** browse: anything asked in chat. audit, fix, page, publish: Zara's platform work. */
    kind: text("kind", { enum: ["browse", "audit", "fix", "page", "publish", "sop"] }).notNull().default("browse"),
    loginId: integer("loginId"),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    startUrl: text("startUrl").notNull(),
    /** True only after the person approved the save, submit or publish. */
    allowSubmit: integer("allowSubmit", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["queued", "working", "done", "need_code", "failed"] }).notNull().default("queued"),
    result: text("result"),
    /** What the employee stopped short of (a Save or Submit button) and is waiting for approval to press. */
    pending: text("pending"),
    note: text("note"),
    steps: integer("steps"),
    lastUrl: text("lastUrl"),
    screenshotUrl: text("screenshotUrl"),
    liveId: text("liveId"),
    /** JSON details for Zara's work: the finding id, page id, funnel and path. */
    ref: text("ref").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("web_tasks_org_idx").on(t.organizationId)]
);

export type WebTask = typeof webTasks.$inferSelect;

/** What Zara found wrong in a LeadDash platform workflow, and its fix. */
export const platformFindings = sqliteTable(
  "platform_findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    workflow: text("workflow").notNull(),
    workflowUrl: text("workflowUrl"),
    /** One line: what's wrong. */
    issue: text("issue").notNull(),
    detail: text("detail").notNull().default(""),
    severity: text("severity", { enum: ["fix_now", "should_fix"] }).notNull().default("should_fix"),
    /** JSON string[]: the trigger and each step, as the workflow runs today. */
    howItRuns: text("howItRuns").notNull().default("[]"),
    fix: text("fix").notNull(),
    status: text("status", { enum: ["open", "fixing", "fixed", "dismissed"] }).notNull().default("open"),
    note: text("note"),
    fixedAt: integer("fixedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("platform_findings_org_idx").on(t.organizationId)]
);

export type PlatformFinding = typeof platformFindings.$inferSelect;

// ==========================================
// Extra Google accounts and calendar links
// ==========================================

/**
 * Accounts connected beyond the workspace's main Google connection.
 * purpose calendar: a calendar source Avery checks (a Google account, or an
 * Outlook or iCloud calendar's private link). purpose send: a Gmail account
 * certain employees send from (outreach on its own domain). purpose press:
 * the inbox Taylor reads reporter requests from (HARO, Source of Sources,
 * Qwoted, Featured), signed in with an app password.
 */
export const accountLinks = sqliteTable(
  "account_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    purpose: text("purpose", { enum: ["calendar", "send", "press"] }).notNull(),
    kind: text("kind", { enum: ["google", "link"] }).notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#1b6b4a"),
    email: text("email"),
    /** Encrypted: Google tokens, or the calendar link (it works like a password). */
    secretsEncrypted: text("secretsEncrypted"),
    /** JSON [{id, name, primary, include}]: the calendars in this account and which ones Avery checks. */
    calendars: text("calendars").notNull().default("[]"),
    /** full: event names; busy: only when you're booked, never what the event is. */
    detail: text("detail", { enum: ["full", "busy"] }).notNull().default("full"),
    /** default: holds go here unless another calendar is named. yes: can go here. no: never. */
    holds: text("holds", { enum: ["default", "yes", "no"] }).notNull().default("no"),
    /** JSON string[]: the employee kinds that send from this account (purpose send). */
    sendsFor: text("sendsFor").notNull().default("[]"),
    status: text("status", { enum: ["connected", "error"] }).notNull().default("connected"),
    error: text("error"),
    /** JSON (purpose press): the last email read, when it was checked, and how many requests were found. */
    sync: text("sync").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("account_links_org_idx").on(t.organizationId)]
);

export type AccountLink = typeof accountLinks.$inferSelect;

// ==========================================
// Elena's mini drama studio
// ==========================================

/** One series per workspace: the show, its look, and the studio settings. */
export const dramaSeries = sqliteTable(
  "drama_series",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    premise: text("premise").notNull().default(""),
    /** The visual look every shot shares (light, color, lens, setting). */
    look: text("look").notNull().default(""),
    /** JSON studio settings: quality, monthly limit, episode length. */
    settings: text("settings").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("drama_series_org_unique").on(t.organizationId)]
);
export type DramaSeries = typeof dramaSeries.$inferSelect;

/** The cast: the owner (her photo and her voice) and made-up characters. */
export const dramaCast = sqliteTable(
  "drama_cast",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    /** owner: played by the owner from her photos. made_up: a fictional character. */
    kind: text("kind", { enum: ["owner", "made_up", "team"] }).notNull().default("made_up"),
    /** How they look, for every shot they're in. */
    look: text("look").notNull().default(""),
    /** The portrait every shot is matched to (the owner's photo, or one made for a made-up character). */
    photoUrl: text("photoUrl"),
    voiceId: text("voiceId"),
    voiceName: text("voiceName"),
    createdAt: createdAt(),
  },
  (t) => [index("drama_cast_org_idx").on(t.organizationId)]
);
export type DramaCastMember = typeof dramaCast.$inferSelect;

export const dramaEpisodes = sqliteTable(
  "drama_episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    logline: text("logline").notNull().default(""),
    /** JSON [{label, at, text}]: hook, turn, spike, cliffhanger. */
    beats: text("beats").notNull().default("[]"),
    /** JSON shots: framing, camera move, action, who is in it, the line spoken, seconds, and what was made. */
    shots: text("shots").notNull().default("[]"),
    /** The score under the episode: mood, tempo and where it builds. */
    music: text("music").notNull().default(""),
    /** drama: an episode of the series. campaign: a branded video (directions, voice-over, captions, call to action). */
    kind: text("kind", { enum: ["drama", "campaign"] }).notNull().default("drama"),
    /** JSON plan: campaign goal, the three directions, the chosen one, script, call to action; keyframes approved. */
    plan: text("plan").notNull().default("{}"),
    /** JSON finished versions: {"9:16": url, "1:1": url, "16:9": url}. */
    versions: text("versions").notNull().default("{}"),
    /** keyframes: the stills are made and wait for the owner's approval before anything is animated. */
    status: text("status", { enum: ["script", "making", "keyframes", "ready", "failed"] }).notNull().default("script"),
    progress: text("progress"),
    videoUrl: text("videoUrl"),
    /** What it cost (or is estimated to cost), in cents. */
    costCents: integer("costCents").notNull().default(0),
    error: text("error"),
    madeAt: integer("madeAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("drama_episodes_org_idx").on(t.organizationId)]
);
export type DramaEpisode = typeof dramaEpisodes.$inferSelect;

// ==========================================
// Taylor's newsroom: one shared press desk per workspace, sharing reporters
// across the workspaces the owner links (LeadDash, Legacy, Dr. Ashley Bryant).
// ==========================================

/** One record per reporter, shared by every linked desk. Every reporter carries article proof. */
export const pressContacts = sqliteTable(
  "press_contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The desk that added them. Linked desks see them too. */
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    outlet: text("outlet").notNull().default(""),
    title: text("title").notNull().default(""),
    /** JSON string[]: what they cover. */
    beats: text("beats").notNull().default("[]"),
    location: text("location").notNull().default(""),
    /** Only from a public source (an author or contact page); never guessed. */
    email: text("email"),
    emailSource: text("emailSource"),
    verifiedAt: integer("verifiedAt", { mode: "timestamp" }),
    authorPage: text("authorPage"),
    /** JSON [{title, url, date, topics}]: the proof, newest first. */
    articles: text("articles").notNull().default("[]"),
    /** Why this person, in two or three sentences. */
    why: text("why").notNull().default(""),
    /** JSON {storyType, sources, launches, strongest, likes}: how they work. */
    profile: text("profile").notNull().default("{}"),
    /** JSON {orgId: 0-100}: fit for each desk. */
    fit: text("fit").notNull().default("{}"),
    relationship: text("relationship", { enum: ["prospect", "contacted", "engaged", "source", "warm", "advocate"] }).notNull().default("prospect"),
    lastContactAt: integer("lastContactAt", { mode: "timestamp" }),
    lastContactOrgId: integer("lastContactOrgId"),
    lastPitch: text("lastPitch"),
    /** What they asked for ("usage numbers from more than one practice"), so the next pitch has it. */
    asks: text("asks"),
    notes: text("notes"),
    doNotContact: integer("doNotContact", { mode: "boolean" }).notNull().default(false),
    /** Their previous outlet, when they moved. */
    movedFrom: text("movedFrom"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("press_contacts_org_idx").on(t.organizationId)]
);
export type PressContact = typeof pressContacts.$inferSelect;

/** A story the desk could join: a report, a news event, a source request, a seasonal moment. */
export const pressStories = sqliteTable(
  "press_stories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    source: text("source").notNull().default(""),
    sourceUrl: text("sourceUrl"),
    /** "Oct 7, 2026" or "Rolling". */
    windowEnds: text("windowEnds").notNull().default(""),
    score: integer("score").notNull().default(0),
    /** JSON [{orgId, why}]: other desks it also fits. */
    alsoFits: text("alsoFits").notNull().default("[]"),
    angle: text("angle").notNull().default(""),
    offer: text("offer").notNull().default(""),
    spokesperson: text("spokesperson").notNull().default(""),
    quote: text("quote"),
    /** JSON number[]: reporters on it. */
    contactIds: text("contactIds").notNull().default("[]"),
    /** JSON [{contactId, reason}]: reporters skipped (another desk pitched them recently, do not contact). */
    skipped: text("skipped").notNull().default("[]"),
    /** A press inbox request (HARO, Qwoted...) behind this story. */
    oppId: integer("oppId"),
    status: text("status", { enum: ["open", "pitched", "dismissed"] }).notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [index("press_stories_org_idx").on(t.organizationId)]
);
export type PressStory = typeof pressStories.$inferSelect;

export const pressCampaigns = sqliteTable(
  "press_campaigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: ["planning", "pitching", "scheduled", "done"] }).notNull().default("planning"),
    /** "Jan 5, 2027" for a seasonal campaign that starts later. */
    startsOn: text("startsOn"),
    /** JSON {goal, audience, story, founderAngle, proof, beats, neverSay, order}. */
    plan: text("plan").notNull().default("{}"),
    /** JSON [{text, use}]: five story angles. */
    angles: text("angles").notNull().default("[]"),
    storyId: integer("storyId"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("press_campaigns_org_idx").on(t.organizationId)]
);
export type PressCampaign = typeof pressCampaigns.$inferSelect;

/** One pitch to one reporter, with its quality score. Sent only through Approvals. */
export const pressPitches = sqliteTable(
  "press_pitches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    campaignId: integer("campaignId"),
    storyId: integer("storyId"),
    contactId: integer("contactId").notNull(),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    score: integer("score").notNull().default(0),
    /** JSON [{name, points, max}]: the 8-part pitch check. */
    rubric: text("rubric").notNull().default("[]"),
    /** weak: still under 85 after rewrites. cooling: another desk pitched them recently. */
    status: text("status", { enum: ["draft", "weak", "ready", "pending", "sent", "cooling", "skipped", "replied"] }).notNull().default("draft"),
    coolingUntil: integer("coolingUntil", { mode: "timestamp" }),
    followUp: integer("followUp", { mode: "boolean" }).notNull().default(false),
    /** The Approvals item that sends it. */
    itemId: integer("itemId"),
    sentAt: integer("sentAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("press_pitches_org_idx").on(t.organizationId), index("press_pitches_contact_idx").on(t.contactId)]
);
export type PressPitch = typeof pressPitches.$inferSelect;

/** A reporter's answer, sorted, with a reply draft. */
export const pressReplies = sqliteTable(
  "press_replies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    contactId: integer("contactId"),
    pitchId: integer("pitchId"),
    messageId: text("messageId"),
    fromEmail: text("fromEmail").notNull().default(""),
    fromName: text("fromName").notNull().default(""),
    subject: text("subject").notNull().default(""),
    text: text("text").notNull().default(""),
    kind: text("kind", { enum: ["interview", "not_now", "questions", "dnc", "referral", "moved", "ooo", "crisis", "other"] }).notNull().default("other"),
    draft: text("draft"),
    status: text("status", { enum: ["open", "pending", "sent", "done"] }).notNull().default("open"),
    itemId: integer("itemId"),
    receivedAt: integer("receivedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [index("press_replies_org_idx").on(t.organizationId)]
);
export type PressReply = typeof pressReplies.$inferSelect;

export const pressInterviews = sqliteTable(
  "press_interviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    contactId: integer("contactId"),
    title: text("title").notNull(),
    at: integer("at", { mode: "timestamp" }),
    place: text("place").notNull().default(""),
    /** JSON briefing: reporter, points, likely questions, hard questions with answers, don't claim, logistics. */
    briefing: text("briefing").notNull().default("{}"),
    status: text("status", { enum: ["upcoming", "done"] }).notNull().default("upcoming"),
    createdAt: createdAt(),
  },
  (t) => [index("press_interviews_org_idx").on(t.organizationId)]
);
export type PressInterview = typeof pressInterviews.$inferSelect;

export const pressCoverage = sqliteTable(
  "press_coverage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    contactId: integer("contactId"),
    campaignId: integer("campaignId"),
    headline: text("headline").notNull(),
    outlet: text("outlet").notNull().default(""),
    url: text("url"),
    ranOn: text("ranOn").notNull().default(""),
    /** JSON {author, quotesUsed, messagesIn, messagesMissed, backlink, visits, demos}. */
    details: text("details").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (t) => [index("press_coverage_org_idx").on(t.organizationId)]
);
export type PressCoverage = typeof pressCoverage.$inferSelect;

/** Quote bank, bios, story bank, seasonal calendar, press kits and approved answers to hard questions. */
export const pressLibrary = sqliteTable(
  "press_library",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    kind: text("kind", { enum: ["quote", "bio", "story", "moment", "kit", "answer"] }).notNull(),
    topic: text("topic").notNull().default(""),
    text: text("text").notNull().default(""),
    /** JSON: desks, length and angle (bios), pitchBy and lead (calendar), question (answers), items (kits). */
    meta: text("meta").notNull().default("{}"),
    /** A draft Taylor wrote stays a draft until the owner approves it. */
    approved: integer("approved", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("press_library_org_idx").on(t.organizationId)]
);
export type PressLibraryItem = typeof pressLibrary.$inferSelect;

export const pressSettings = sqliteTable("press_settings", {
  organizationId: integer("organizationId").primaryKey(),
  /** JSON number[]: the workspaces sharing this newsroom (always includes this one). */
  shared: text("shared").notNull().default("[]"),
  coolingDays: integer("coolingDays").notNull().default(21),
  /** 1: you approve everything. 3: follow-ups send themselves. 4: strong pitches on safe topics send. 5: within your rules. */
  level: integer("level").notNull().default(1),
  alwaysNeedsYou: text("alwaysNeedsYou").notNull().default("Crisis, regulators, legal, sensitive clinical topics, statements about patients"),
  stopWords: text("stopWords").notNull().default("Breach, lawsuit, complaint, investigation, harm, death"),
  /** What this desk owns ("Product, health tech, AI employees..."). */
  owns: text("owns").notNull().default(""),
  /** JSON string[]: beats the weekly scout watches. */
  beats: text("beats").notNull().default("[]"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  pausedReason: text("pausedReason"),
  lastScoutAt: integer("lastScoutAt", { mode: "timestamp" }),
  lastBriefAt: integer("lastBriefAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});
export type PressSettings = typeof pressSettings.$inferSelect;

// ==========================================
// Jada's cold email: the owner's lead list, sent through Instantly.
// The list lives here; Instantly only holds the batch being emailed.
// ==========================================

export const COLD_STAGES = ["new", "queued", "in_campaign", "replied", "booked", "finished", "not_fit", "dnc"] as const;
export const COLD_REPLY_KINDS = ["hot", "interested", "demo", "objection", "question", "wrong_person", "referral", "not_now", "negative", "unsubscribe", "ooo", "other"] as const;

export const coldSettings = sqliteTable("cold_settings", {
  organizationId: integer("organizationId").primaryKey(),
  /** The Instantly API key, encrypted. Never sent to the AI or the browser. */
  keyEncrypted: text("keyEncrypted"),
  keyCheckedAt: integer("keyCheckedAt", { mode: "timestamp" }),
  keyError: text("keyError"),
  /** growth, hypergrowth, lightspeed or custom: sets the contact and monthly email limits. */
  plan: text("plan").notNull().default("growth"),
  contactsLimit: integer("contactsLimit").notNull().default(1000),
  emailsLimit: integer("emailsLimit").notNull().default(5000),
  /** Last "remaining in plan" Instantly reported when leads were added. */
  remainingInPlan: integer("remainingInPlan"),
  /** 1: owner approves every reply. 2: routine replies send. 3: playbook objections send and volume shifts. 4: runs cold email. */
  level: integer("level").notNull().default(1),
  perInbox: integer("perInbox").notNull().default(20),
  rampPct: integer("rampPct").notNull().default(10),
  bounceRest: integer("bounceRest").notNull().default(3),
  signature: text("signature").notNull().default(""),
  address: text("address").notNull().default(""),
  optOut: text("optOut").notNull().default("Not the right fit? Reply stop and I won't email again."),
  alwaysNeedsYou: text("alwaysNeedsYou").notNull().default("Security, HIPAA or legal questions, groups over 20 clinicians, contract terms, anything about a client"),
  /** The website pricing and address are read from. */
  website: text("website").notNull().default("https://leaddash.io"),
  /** JSON {plans: [{name, price, seats, includes}], address, notes, url}: read from the website. */
  site: text("site").notNull().default("{}"),
  siteCheckedAt: integer("siteCheckedAt", { mode: "timestamp" }),
  siteError: text("siteError"),
  /** New emails a day Jada allowed yesterday (the ramp starts from it). */
  dailyNew: integer("dailyNew").notNull().default(0),
  /** JSON {date, added}: new leads sent to Instantly today. */
  today: text("today").notNull().default("{}"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  /** Token in the webhook address. */
  hookToken: text("hookToken"),
  lastReplyCheckAt: integer("lastReplyCheckAt", { mode: "timestamp" }),
  lastInboxCheckAt: integer("lastInboxCheckAt", { mode: "timestamp" }),
  lastFeedAt: integer("lastFeedAt", { mode: "timestamp" }),
  lastReviewAt: integer("lastReviewAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});
export type ColdSettings = typeof coldSettings.$inferSelect;

/** One therapist on the list. Up to the whole 90,000. */
export const coldLeads = sqliteTable(
  "cold_leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    email: text("email").notNull(),
    firstName: text("firstName").notNull().default(""),
    lastName: text("lastName").notNull().default(""),
    license: text("license").notNull().default(""),
    licenseNumber: text("licenseNumber").notNull().default(""),
    licenseStatus: text("licenseStatus").notNull().default(""),
    state: text("state").notNull().default(""),
    city: text("city").notNull().default(""),
    phone: text("phone").notNull().default(""),
    practice: text("practice").notNull().default(""),
    website: text("website").notNull().default(""),
    /** Where the lead came from ("Texas license list.csv", "Instantly", "Referral from ..."). */
    source: text("source").notNull().default(""),
    /** JSON string[]: group_owner, solo_owner, size_3_15, hiring, ehr_simplepractice, telehealth, ... */
    segments: text("segments").notNull().default("[]"),
    /** 0-100, null until scored. */
    fit: integer("fit"),
    /** JSON [{label, points}]. */
    fitWhy: text("fitWhy").notNull().default("[]"),
    /** basic (list only), researched (website or search), moderate (after interest), full (pre-call report). */
    depth: text("depth", { enum: ["list", "researched", "moderate", "full"] }).notNull().default("list"),
    /** JSON research: practice facts, signals with evidence and sources. */
    research: text("research").notNull().default("{}"),
    researchedAt: integer("researchedAt", { mode: "timestamp" }),
    stage: text("stage", { enum: COLD_STAGES }).notNull().default("new"),
    notFitReason: text("notFitReason"),
    campaignId: integer("campaignId"),
    instantlyLeadId: text("instantlyLeadId"),
    addedAt: integer("addedAt", { mode: "timestamp" }),
    finishedAt: integer("finishedAt", { mode: "timestamp" }),
    lastReplyKind: text("lastReplyKind"),
    followUpAt: integer("followUpAt", { mode: "timestamp" }),
    followUpNote: text("followUpNote"),
    bookedFor: integer("bookedFor", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("cold_leads_org_email_unique").on(t.organizationId, t.email),
    index("cold_leads_org_stage_fit_idx").on(t.organizationId, t.stage, t.fit),
    index("cold_leads_org_campaign_idx").on(t.organizationId, t.campaignId),
  ]
);
export type ColdLead = typeof coldLeads.$inferSelect;

export const coldCampaigns = sqliteTable(
  "cold_campaigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    /** One of the angle keys (switcher, missed_calls, too_many, group_ops, growing, owner_time). */
    angle: text("angle").notNull(),
    /** JSON {segments: string[], minFit, states: string[], licenses: string[]}. */
    who: text("who").notNull().default("{}"),
    offer: text("offer").notNull().default(""),
    ask: text("ask").notNull().default(""),
    /** JSON [{day, subject, subjectB, body}]: the 4 emails. subjectB is the subject line test. */
    steps: text("steps").notNull().default("[]"),
    /** JSON {variable: "subject", a, b, winner}. */
    test: text("test").notNull().default("{}"),
    /** Percent of each day's new emails. */
    share: integer("share").notNull().default(25),
    status: text("status", { enum: ["draft", "sending", "paused", "done"] }).notNull().default("draft"),
    instantlyId: text("instantlyId"),
    /** JSON {added, sent, replies, positive, demos, bounced, unsubscribed, a: {replies, positive, demos}, b: {...}, at}. */
    stats: text("stats").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("cold_campaigns_org_idx").on(t.organizationId)]
);
export type ColdCampaign = typeof coldCampaigns.$inferSelect;

export const coldReplies = sqliteTable(
  "cold_replies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    leadId: integer("leadId").notNull(),
    campaignId: integer("campaignId"),
    /** The Instantly email id (to answer on the same thread) and the inbox it came to. */
    emailId: text("emailId").notNull(),
    inbox: text("inbox").notNull().default(""),
    subject: text("subject").notNull().default(""),
    text: text("text").notNull().default(""),
    kind: text("kind", { enum: COLD_REPLY_KINDS }).notNull().default("other"),
    /** "price", "competitor"... for objections; the topic for questions. */
    topic: text("topic").notNull().default(""),
    /** Which subject line version it answered (a or b). */
    variant: text("variant"),
    draft: text("draft"),
    /** What Jada did on her own, in words ("Closed the loop and added to do not contact"). */
    handled: text("handled"),
    status: text("status", { enum: ["open", "sent", "done"] }).notNull().default("open"),
    receivedAt: integer("receivedAt", { mode: "timestamp" }),
    sentAt: integer("sentAt", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cold_replies_org_email_unique").on(t.organizationId, t.emailId), index("cold_replies_org_idx").on(t.organizationId)]
);
export type ColdReply = typeof coldReplies.$inferSelect;

/** Objections, battle cards, approved facts, never say, and real examples from the owner's own answers. */
export const coldPlaybook = sqliteTable(
  "cold_playbook",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    kind: text("kind", { enum: ["objection", "battle", "fact", "never", "example"] }).notNull(),
    /** What they say (objection), the competitor (battle), the topic (fact), the phrase (never). */
    title: text("title").notNull(),
    /** JSON: objection {meaning, goal, facts, never, escalate, example}; battle {doesWell, differs, dontClaim, whySwitch, questions}; example {said, draft, better, tag}. */
    body: text("body").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("cold_playbook_org_idx").on(t.organizationId)]
);
export type ColdPlay = typeof coldPlaybook.$inferSelect;

export const coldInboxes = sqliteTable(
  "cold_inboxes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    email: text("email").notNull(),
    /** Instantly's account status number (1 active) and warmup score. */
    accountStatus: integer("accountStatus").notNull().default(1),
    warmupScore: integer("warmupScore"),
    sentToday: integer("sentToday").notNull().default(0),
    sent7: integer("sent7").notNull().default(0),
    bounced7: integer("bounced7").notNull().default(0),
    replies7: integer("replies7").notNull().default(0),
    status: text("status", { enum: ["healthy", "resting", "error"] }).notNull().default("healthy"),
    reason: text("reason"),
    restedAt: integer("restedAt", { mode: "timestamp" }),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("cold_inboxes_org_email_unique").on(t.organizationId, t.email)]
);
export type ColdInbox = typeof coldInboxes.$inferSelect;

export const coldReviews = sqliteTable(
  "cold_reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    /** JSON string[]. */
    points: text("points").notNull().default("[]"),
    /** JSON [{kind: share|pause|winner, campaignId, share?, version?, why}]. */
    changes: text("changes").notNull().default("[]"),
    status: text("status", { enum: ["waiting", "applied", "dismissed"] }).notNull().default("waiting"),
    createdAt: createdAt(),
  },
  (t) => [index("cold_reviews_org_idx").on(t.organizationId)]
);
export type ColdReview = typeof coldReviews.$inferSelect;

/** Never emailed: unsubscribed, bounced, asked to stop, existing clients. Every campaign and inbox. */
export const coldSuppress = sqliteTable(
  "cold_suppress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    email: text("email").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cold_suppress_org_email_unique").on(t.organizationId, t.email)]
);
export type ColdSuppress = typeof coldSuppress.$inferSelect;

/** The Pre-call report: a skill any employee can run before a meeting. */
export const precallReports = sqliteTable(
  "precall_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    leadId: integer("leadId"),
    person: text("person").notNull().default(""),
    practice: text("practice").notNull().default(""),
    email: text("email").notNull().default(""),
    website: text("website").notNull().default(""),
    meetingAt: integer("meetingAt", { mode: "timestamp" }),
    /** Who ran it ("Jada, when he booked", "You, from Simone's chat"). */
    runBy: text("runBy").notNull().default(""),
    /** JSON report (brief, tech, journey, growth, pains, demo, objections, committee, risks, sources). */
    report: text("report").notNull().default("{}"),
    /** JSON {changes: [{what, before, after}], nextStep, notesFrom}. */
    after: text("after"),
    status: text("status", { enum: ["running", "ready", "failed", "done"] }).notNull().default("running"),
    error: text("error"),
    refreshedAt: integer("refreshedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("precall_org_idx").on(t.organizationId)]
);
export type PrecallReport = typeof precallReports.$inferSelect;

// ==========================================
// Avery's desk: one queue for everything that needs the owner or the team
// ==========================================

/** A decision an employee needs from a person. Employees' approvals (posts, pitches, keyframes) are read live; these are the rest. */
export const deskDecisions = sqliteTable(
  "desk_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    why: text("why").notNull().default(""),
    /** What kind of decision it is (price, contract, press, legal, clinical, spend, event, keyframes, guideline, post, reply, email, hiring, other). Decides who may make it. */
    category: text("category").notNull().default("other"),
    urgency: text("urgency", { enum: ["now", "today", "week"] }).notNull().default("week"),
    dueAt: integer("dueAt", { mode: "timestamp" }),
    /** JSON employee kinds that asked. Repeats from other employees are merged here. */
    fromKinds: text("fromKinds").notNull().default("[]"),
    project: text("project").notNull().default(""),
    minutes: integer("minutes"),
    amountCents: integer("amountCents"),
    /** JSON [{label, text, source}]. */
    options: text("options").notNull().default("[]"),
    /** Index into options Avery suggests, or null. */
    suggested: integer("suggested"),
    suggestedWhy: text("suggestedWhy").notNull().default(""),
    /** JSON [{by, text, at}]: notes from the people who looked at it. */
    notes: text("notes").notNull().default("[]"),
    /** Where the work is in the app. */
    link: text("link"),
    /** Dedupe key from the source (task:12, meeting:4:2). */
    sourceKey: text("sourceKey"),
    status: text("status", { enum: ["open", "decided", "sent_back", "later"] }).notNull().default("open"),
    choice: text("choice"),
    decidedBy: text("decidedBy"),
    decidedAt: integer("decidedAt", { mode: "timestamp" }),
    laterUntil: integer("laterUntil", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("desk_decisions_org_idx").on(t.organizationId)]
);
export type DeskDecision = typeof deskDecisions.$inferSelect;
export type InsertDeskDecision = typeof deskDecisions.$inferInsert;

/** Something someone owes the owner (owed), or something the owner said she would do (promise). */
export const deskWaiting = sqliteTable(
  "desk_waiting",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    kind: text("kind", { enum: ["owed", "promise"] }).notNull(),
    /** Owed: who owes it. Promise: who it was promised to. */
    who: text("who").notNull(),
    email: text("email").notNull().default(""),
    what: text("what").notNull(),
    /** What it holds up. */
    blocks: text("blocks").notNull().default(""),
    /** Owed: avery, nora, outreach, speaking. Promise: who is on it (an employee kind, or "you"). */
    owner: text("owner").notNull().default("avery"),
    /** Where it was heard ("Demo notes, Oct 5, 2026"), and the words. */
    heardIn: text("heardIn").notNull().default(""),
    plan: text("plan").notNull().default(""),
    askedAt: integer("askedAt", { mode: "timestamp" }),
    expectedAt: integer("expectedAt", { mode: "timestamp" }),
    nudgeAt: integer("nudgeAt", { mode: "timestamp" }),
    escalateAt: integer("escalateAt", { mode: "timestamp" }),
    nudgeSubject: text("nudgeSubject").notNull().default(""),
    nudgeBody: text("nudgeBody").notNull().default(""),
    nudgedAt: integer("nudgedAt", { mode: "timestamp" }),
    sourceKey: text("sourceKey"),
    status: text("status", { enum: ["open", "done", "dismissed"] }).notNull().default("open"),
    doneBy: text("doneBy"),
    doneAt: integer("doneAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }),
  },
  (t) => [index("desk_waiting_org_idx").on(t.organizationId)]
);
export type DeskWaiting = typeof deskWaiting.$inferSelect;
export type InsertDeskWaiting = typeof deskWaiting.$inferInsert;

/** Avery's rules for a workspace: who decides, what she does on her own, the owner's time, who comes first, the brief. */
export const deskSettings = sqliteTable("desk_settings", {
  organizationId: integer("organizationId").primaryKey(),
  /** JSON DeskRules. */
  rules: text("rules").notNull().default("{}"),
  lastBrief: text("lastBrief"),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});
export type DeskSettings = typeof deskSettings.$inferSelect;

// ==========================================
// Team chat: channels, direct messages and threads, like Slack
// ==========================================

/**
 * A channel in a workspace. "everyone" is the general channel every workspace
 * has (key "everyone"); the rest get key "ch:<id>". Private channels are seen
 * only by their members. aiAllowed lets AI employees answer @mentions in it.
 */
export const teamChannels = sqliteTable(
  "team_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    key: text("key").notNull().default(""),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    private: integer("private", { mode: "boolean" }).notNull().default(false),
    aiAllowed: integer("aiAllowed", { mode: "boolean" }).notNull().default(true),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdBy: integer("createdBy"),
    /** Slack's channel id when it came from an import, so a second run updates instead of copying. */
    importedId: text("importedId"),
    createdAt: createdAt(),
  },
  (t) => [index("team_channels_org_idx").on(t.organizationId, t.key)]
);
export type TeamChannel = typeof teamChannels.$inferSelect;

/** Who is in a channel (every member of a private channel; anyone who left or changed notifications on a public one). */
export const teamChannelMembers = sqliteTable(
  "team_channel_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    channelId: integer("channelId").notNull(),
    userId: integer("userId").notNull(),
    /** all: every message; mentions: only @mentions; none: nothing. */
    notify: text("notify", { enum: ["all", "mentions", "none"] }).notNull().default("all"),
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    left: integer("left", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("team_channel_members_unique").on(t.channelId, t.userId)]
);
export type TeamChannelMember = typeof teamChannelMembers.$inferSelect;

/** channel: "everyone", "ch:<id>", or "dm:<lower user id>-<higher user id>" for two people. */
export const teamMessages = sqliteTable(
  "team_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    channel: text("channel").notNull(),
    /** 0 when the author has no account here (someone who left Slack before the import). */
    userId: integer("userId").notNull(),
    /** Set when an AI employee wrote it (answering an @mention in a thread). */
    employeeId: integer("employeeId"),
    authorName: text("authorName").notNull(),
    content: text("content").notNull().default(""),
    /** JSON [{id, name, size, kind, url}] from chat_files; imported Slack files have no url. */
    attachments: text("attachments"),
    /** The message this one replies to, for threads. */
    threadOf: integer("threadOf"),
    /** JSON {users: [ids], employees: [ids]} of who was @mentioned. */
    mentions: text("mentions"),
    editedAt: integer("editedAt", { mode: "timestamp" }),
    deletedAt: integer("deletedAt", { mode: "timestamp" }),
    pinnedBy: integer("pinnedBy"),
    pinnedAt: integer("pinnedAt", { mode: "timestamp" }),
    /** Slack's message ts when it came from an import. */
    importedId: text("importedId"),
    /** JSON [urls] whose preview card someone hid under this message. */
    hiddenPreviews: text("hiddenPreviews"),
    createdAt: createdAt(),
  },
  (t) => [index("team_messages_org_channel_idx").on(t.organizationId, t.channel, t.id), index("team_messages_thread_idx").on(t.threadOf)]
);
export type TeamMessage = typeof teamMessages.$inferSelect;

/**
 * What a link in a team chat message points at, read once from the site
 * (Loom and YouTube by oEmbed, pages by their Open Graph tags) and kept by
 * url so every message with that link shows the same card.
 */
export const teamLinks = sqliteTable(
  "team_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    /** video: plays in place; file: a Google Doc, Sheet, Slide or Drive file; page: anything else. */
    kind: text("kind", { enum: ["video", "file", "page"] }).notNull().default("page"),
    /** "Loom", "YouTube", "Google Sheets", or the site's name or host. */
    site: text("site").notNull().default(""),
    title: text("title"),
    description: text("description"),
    image: text("image"),
    /** The player url for a video (an iframe source). */
    embed: text("embed"),
    /** Seconds, when the site says. */
    duration: integer("duration"),
    /** ok: read; none: the site gave nothing to show. */
    status: text("status", { enum: ["ok", "none"] }).notNull().default("none"),
    fetchedAt: integer("fetchedAt", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("team_links_url_unique").on(t.url)]
);
export type TeamLink = typeof teamLinks.$inferSelect;

/** How far each person has read in each team channel, for unread counts and "Seen". */
export const teamReads = sqliteTable(
  "team_reads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    userId: integer("userId").notNull(),
    channel: text("channel").notNull(),
    lastReadId: integer("lastReadId").notNull().default(0),
    readAt: integer("readAt", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("team_reads_unique").on(t.organizationId, t.userId, t.channel)]
);
export type TeamRead = typeof teamReads.$inferSelect;

/** An emoji reaction on a message, one row per person per emoji. */
export const teamReactions = sqliteTable(
  "team_reactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    messageId: integer("messageId").notNull(),
    userId: integer("userId").notNull(),
    /** Someone who left Slack, kept by name on imported reactions. */
    authorName: text("authorName").notNull().default(""),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("team_reactions_msg_idx").on(t.messageId)]
);
export type TeamReaction = typeof teamReactions.$inferSelect;

/** A message someone saved for later. */
export const teamSaved = sqliteTable(
  "team_saved",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    userId: integer("userId").notNull(),
    messageId: integer("messageId").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("team_saved_unique").on(t.userId, t.messageId)]
);
export type TeamSaved = typeof teamSaved.$inferSelect;

// ==========================================
// Ads: Reese's campaigns, one creative set per platform
// ==========================================

export const AD_PLATFORMS = ["meta", "google", "youtube", "microsoft", "linkedin", "tiktok", "reddit", "spotify", "nextdoor", "yelp"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/**
 * A campaign brief: the goal, who it is for, the page the ads go to, which
 * platforms, the budget and its split. Reese writes one set per platform from
 * it, one at a time, and the owner approves each in chat.
 */
export const adCampaigns = sqliteTable(
  "ad_campaigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    goal: text("goal").notNull().default(""),
    audience: text("audience").notNull().default(""),
    /** The offer or page the ads go to. */
    page: text("page").notNull().default(""),
    /** JSON [platform] in the order Reese writes them. */
    platforms: text("platforms").notNull().default("[]"),
    budgetCents: integer("budgetCents").notNull().default(0),
    /** YYYY-MM-DD, or "" when not set. */
    startDate: text("startDate").notNull().default(""),
    endDate: text("endDate").notNull().default(""),
    /** reese: Reese's split; even: the same for every platform; custom: the owner's numbers. */
    splitMode: text("splitMode", { enum: ["reese", "even", "custom"] }).notNull().default("reese"),
    /** JSON {platform: {share, why}} with share as a whole percent. */
    split: text("split").notNull().default("{}"),
    formats: text("formats").notNull().default("any"),
    versions: integer("versions").notNull().default(1),
    mustSay: text("mustSay").notNull().default(""),
    neverSay: text("neverSay").notNull().default(""),
    /** JSON [notes the owner gave along the way], carried into every set written after. */
    notes: text("notes").notNull().default("[]"),
    /** budget: the split waits for the owner; writing: Reese is on a set; review: a set waits for the owner; done: every set approved or skipped. */
    status: text("status", { enum: ["budget", "writing", "review", "done"] }).notNull().default("budget"),
    /** The platform whose set is open right now. */
    currentPlatform: text("currentPlatform"),
    /** JSON [platform] Reese left out with a reason, e.g. local platforms on a practice-owner campaign. */
    leftOut: text("leftOut").notNull().default("[]"),
    leftOutWhy: text("leftOutWhy").notNull().default(""),
    createdBy: integer("createdBy"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ad_campaigns_org_idx").on(t.organizationId, t.id)]
);
export type AdCampaign = typeof adCampaigns.$inferSelect;

/** One platform's creative for a campaign: the copy as JSON fields, the picture, and where it stands. */
export const adSets = sqliteTable(
  "ad_sets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    campaignId: integer("campaignId").notNull(),
    platform: text("platform", { enum: AD_PLATFORMS }).notNull(),
    version: integer("version").notNull().default(1),
    status: text("status", { enum: ["writing", "review", "approved", "skipped", "replaced"] }).notNull().default("writing"),
    /** JSON {field: string | string[]} as the platform's fields define. */
    content: text("content").notNull().default("{}"),
    /** One line of the ad for lists. */
    summary: text("summary").notNull().default(""),
    imagePrompt: text("imagePrompt"),
    imageUrl: text("imageUrl"),
    imageError: text("imageError"),
    audioUrl: text("audioUrl"),
    audioError: text("audioError"),
    /** Why it could not be written, when writing failed. */
    error: text("error"),
    approvedBy: text("approvedBy"),
    approvedAt: integer("approvedAt", { mode: "timestamp" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ad_sets_campaign_idx").on(t.campaignId, t.platform)]
);
export type AdSet = typeof adSets.$inferSelect;

// ==========================================
// Goals: each workspace's own, set by the owner and Simone together
// ==========================================

/** Folders for goals (Revenue, Customers, Speaking...). */
export const goalFolders = sqliteTable(
  "goal_folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    parentId: integer("parentId"),
    name: text("name").notNull(),
    color: text("color").notNull().default("#1b6b4a"),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("goal_folders_org_idx").on(t.organizationId)]
);
export type GoalFolder = typeof goalFolders.$inferSelect;

/**
 * A goal. level: company, year, quarter or cycle (a 12-week cycle). parentId is
 * the goal it rolls up to. ownerType: user or employee. state: active, suggested
 * (Simone suggests it, waiting for the owner), draft (next year's draft), done,
 * dismissed or archived. status is the owner's own call (on, risk, off, done);
 * null means the app works it out from progress and pace.
 */
export const goals = sqliteTable(
  "goals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    folderId: integer("folderId"),
    parentId: integer("parentId"),
    level: text("level", { enum: ["company", "year", "quarter", "cycle"] }).notNull().default("quarter"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** "2026", "Q4 2026", "Cycle 1, 2026". */
    period: text("period").notNull().default(""),
    startDate: text("startDate").notNull(),
    dueDate: text("dueDate").notNull(),
    ownerType: text("ownerType", { enum: ["user", "employee"] }),
    ownerId: integer("ownerId"),
    color: text("color").notNull().default("#1b6b4a"),
    status: text("status", { enum: ["on", "risk", "off", "done"] }),
    /** Progress the owner set by hand (0 to 100) when the goal has no targets. */
    manualProgress: integer("manualProgress"),
    state: text("state", { enum: ["active", "suggested", "draft", "done", "dismissed", "archived"] }).notNull().default("active"),
    /** Why Simone suggests or drafted it. */
    why: text("why").notNull().default(""),
    setBy: text("setBy").notNull().default(""),
    agreedBy: text("agreedBy").notNull().default(""),
    agreedAt: integer("agreedAt", { mode: "timestamp" }),
    sort: integer("sort").notNull().default(0),
    clickupId: text("clickupId"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("goals_org_idx").on(t.organizationId, t.state)]
);
export type Goal = typeof goals.$inferSelect;

/**
 * What a goal counts. kind: number, currency, boolean (done or not), tasks (a
 * Projects list or the tasks tied to the goal), or measure (a scorecard measure).
 * history: JSON [{d: "YYYY-MM-DD", v: number}] of the current value over time.
 */
export const goalTargets = sqliteTable(
  "goal_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    goalId: integer("goalId").notNull(),
    kind: text("kind", { enum: ["number", "currency", "boolean", "tasks", "measure"] }).notNull().default("number"),
    name: text("name").notNull(),
    startValue: integer("startValue").notNull().default(0),
    currentValue: integer("currentValue").notNull().default(0),
    targetValue: integer("targetValue").notNull().default(0),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    listId: integer("listId"),
    measureId: integer("measureId"),
    history: text("history").notNull().default("[]"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("goal_targets_goal_idx").on(t.organizationId, t.goalId)]
);
export type GoalTarget = typeof goalTargets.$inferSelect;

/** A status update on a goal from a person or an employee. */
export const goalUpdates = sqliteTable(
  "goal_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    goalId: integer("goalId").notNull(),
    authorType: text("authorType", { enum: ["user", "employee"] }).notNull(),
    authorId: integer("authorId"),
    authorName: text("authorName").notNull(),
    status: text("status", { enum: ["on", "risk", "off", "done"] }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("goal_updates_goal_idx").on(t.organizationId, t.goalId)]
);
export type GoalUpdate = typeof goalUpdates.$inferSelect;

/**
 * A scorecard measure. source: manual (the owner types it in each week) or a
 * number the app counts (practices_contacted, demos_booked, ...). kind: leading
 * or result. direction: up (more is better) or down (less is better).
 */
export const measures = sqliteTable(
  "measures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    ownerType: text("ownerType", { enum: ["user", "employee"] }),
    ownerId: integer("ownerId"),
    weeklyGoal: real("weeklyGoal"),
    unit: text("unit", { enum: ["number", "currency", "percent", "hours"] }).notNull().default("number"),
    direction: text("direction", { enum: ["up", "down"] }).notNull().default("up"),
    kind: text("kind", { enum: ["leading", "result"] }).notNull().default("leading"),
    source: text("source").notNull().default("manual"),
    goalId: integer("goalId"),
    sort: integer("sort").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("measures_org_idx").on(t.organizationId)]
);
export type Measure = typeof measures.$inferSelect;

/** One week's number for a measure. weekStart is the Sunday, YYYY-MM-DD. */
export const measureValues = sqliteTable(
  "measure_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    measureId: integer("measureId").notNull(),
    weekStart: text("weekStart").notNull(),
    value: real("value").notNull(),
    enteredBy: text("enteredBy").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("measure_values_unique").on(t.organizationId, t.measureId, t.weekStart)]
);
export type MeasureValue = typeof measureValues.$inferSelect;

/**
 * Simone's weekly read: JSON items [{status, text, action, goalId?, measureId?}]
 * plus the one-line scorecard note. Also keeps the workspace's Goals dashboard layout.
 */
export const goalReads = sqliteTable(
  "goal_reads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    weekStart: text("weekStart").notNull(),
    note: text("note").notNull().default(""),
    items: text("items").notNull().default("[]"),
    createdAt: createdAt(),
  },
  (t) => [index("goal_reads_org_idx").on(t.organizationId, t.weekStart)]
);
export type GoalRead = typeof goalReads.$inferSelect;

/** Files attached to a goal, a goal update, a task or a task comment (from chat_files). */
export const itemFiles = sqliteTable(
  "item_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    itemType: text("itemType", { enum: ["goal", "task", "comment", "update"] }).notNull(),
    itemId: integer("itemId").notNull(),
    fileId: integer("fileId").notNull(),
    addedBy: text("addedBy").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("item_files_item_idx").on(t.organizationId, t.itemType, t.itemId)]
);
export type ItemFile = typeof itemFiles.$inferSelect;

// ==========================================
// Projects: folders, lists and tasks (in place of ClickUp)
// ==========================================

export const pjFolders = sqliteTable(
  "pj_folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#1b6b4a"),
    /** Custom fields every list in the folder has, same shape as a list's fields. */
    fields: text("fields").notNull().default("[]"),
    sort: integer("sort").notNull().default(0),
    clickupId: text("clickupId"),
    createdAt: createdAt(),
  },
  (t) => [index("pj_folders_org_idx").on(t.organizationId)]
);
export type PjFolder = typeof pjFolders.$inferSelect;

/**
 * A list of tasks, in a folder or on its own. statuses: JSON [{name, color,
 * type: open|active|done|closed}] in order. fields: JSON custom fields
 * [{id, name, type: text|number|dropdown|date|money|checkbox, options?: [{id, name, color}]}].
 */
export const pjLists = sqliteTable(
  "pj_lists",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    folderId: integer("folderId"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    statuses: text("statuses").notNull(),
    fields: text("fields").notNull().default("[]"),
    /** Private: only the people it's shared with (and owners and admins) see it. */
    private: integer("private", { mode: "boolean" }).notNull().default(false),
    /** A view-only link anyone can open; null when off. */
    shareToken: text("shareToken"),
    sort: integer("sort").notNull().default(0),
    clickupId: text("clickupId"),
    createdAt: createdAt(),
  },
  (t) => [index("pj_lists_org_idx").on(t.organizationId, t.folderId)]
);
export type PjList = typeof pjLists.$inferSelect;

/**
 * A task (or a subtask when parentId is set). assignees: JSON [{type: user|employee|name, id, name}].
 * Dates are YYYY-MM-DD. fields: JSON {fieldId: value}. checklist: JSON [{text, done}].
 * priority: urgent, high, normal, low or null.
 */
export const pjTasks = sqliteTable(
  "pj_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    listId: integer("listId").notNull(),
    parentId: integer("parentId"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull(),
    priority: text("priority", { enum: ["urgent", "high", "normal", "low"] }),
    startDate: text("startDate"),
    dueDate: text("dueDate"),
    timeEstimate: integer("timeEstimate"),
    tags: text("tags").notNull().default("[]"),
    assignees: text("assignees").notNull().default("[]"),
    fields: text("fields").notNull().default("{}"),
    checklist: text("checklist").notNull().default("[]"),
    goalId: integer("goalId"),
    /** How it repeats: JSON {every, unit: day|week|month|year, days?, mode: done|schedule, ends, count, until, keep, made, spawned}; "" when it doesn't. */
    repeat: text("repeat").notNull().default(""),
    /** People and employees who follow it without being assigned: JSON like assignees. */
    watchers: text("watchers").notNull().default("[]"),
    sort: integer("sort").notNull().default(0),
    closedAt: integer("closedAt", { mode: "timestamp" }),
    createdBy: text("createdBy").notNull().default(""),
    clickupId: text("clickupId"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("pj_tasks_list_idx").on(t.organizationId, t.listId), index("pj_tasks_due_idx").on(t.organizationId, t.dueDate)]
);
export type PjTask = typeof pjTasks.$inferSelect;

/** Comments on a task, and its activity lines (kind = activity). */
export const pjComments = sqliteTable(
  "pj_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    taskId: integer("taskId").notNull(),
    kind: text("kind", { enum: ["comment", "activity"] }).notNull().default("comment"),
    authorType: text("authorType", { enum: ["user", "employee", "system"] }).notNull(),
    authorId: integer("authorId"),
    authorName: text("authorName").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("pj_comments_task_idx").on(t.organizationId, t.taskId)]
);
export type PjComment = typeof pjComments.$inferSelect;

/**
 * A list's automation. trigger: JSON {on: "status" | "created", to?: status}.
 * action: JSON {do: "assign" | "priority" | "status" | "comment", value}.
 * listId null means every list in the workspace.
 */
export const pjAutomations = sqliteTable(
  "pj_automations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    listId: integer("listId"),
    /** When set (and listId is null), the rule covers every list in this folder. */
    folderId: integer("folderId"),
    trigger: text("trigger").notNull(),
    action: text("action").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("pj_automations_org_idx").on(t.organizationId)]
);
export type PjAutomation = typeof pjAutomations.$inferSelect;

/** A ClickUp import's progress. picks: JSON [{spaceId, name, mode: projects|goals}]. */
export const pjImports = sqliteTable("pj_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  organizationId: integer("organizationId").notNull(),
  status: text("status", { enum: ["running", "done", "failed"] }).notNull().default("running"),
  picks: text("picks").notNull(),
  progress: text("progress").notNull().default(""),
  counts: text("counts").notNull().default("{}"),
  error: text("error"),
  startedBy: text("startedBy").notNull().default(""),
  createdAt: createdAt(),
  finishedAt: integer("finishedAt", { mode: "timestamp" }),
});
export type PjImport = typeof pjImports.$inferSelect;


/** Links between tasks: kind "waits" means taskId waits on otherId; "link" relates them both ways. */
export const pjLinks = sqliteTable(
  "pj_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    taskId: integer("taskId").notNull(),
    otherId: integer("otherId").notNull(),
    kind: text("kind", { enum: ["waits", "link"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("pj_links_task_idx").on(t.organizationId, t.taskId), index("pj_links_other_idx").on(t.organizationId, t.otherId)]
);
export type PjLink = typeof pjLinks.$inferSelect;

/** Time on a task. A running timer has minutes null and startedAt set. day is YYYY-MM-DD. */
export const pjTime = sqliteTable(
  "pj_time",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    taskId: integer("taskId").notNull(),
    whoType: text("whoType", { enum: ["user", "employee"] }).notNull(),
    whoId: integer("whoId").notNull(),
    whoName: text("whoName").notNull(),
    day: text("day").notNull(),
    minutes: integer("minutes"),
    startedAt: integer("startedAt", { mode: "timestamp" }),
    note: text("note").notNull().default(""),
    billable: integer("billable", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("pj_time_task_idx").on(t.organizationId, t.taskId), index("pj_time_day_idx").on(t.organizationId, t.day)]
);
export type PjTime = typeof pjTime.$inferSelect;

/** A saved task, list or doc to reuse. data: JSON snapshot. */
export const pjTemplates = sqliteTable(
  "pj_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    kind: text("kind", { enum: ["task", "list", "doc"] }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    folderName: text("folderName").notNull().default(""),
    data: text("data").notNull(),
    createdBy: text("createdBy").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("pj_templates_org_idx").on(t.organizationId)]
);
export type PjTemplate = typeof pjTemplates.$inferSelect;

/**
 * A doc page in a folder; parentId makes it a page inside another doc.
 * blocks: JSON [{id, type: h1|h2|p|bullet|number|check|quote|table|image|task, text, done?, rows?, url?, taskId?}].
 * taskIds: JSON linked task ids.
 */
export const pjDocs = sqliteTable(
  "pj_docs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    folderId: integer("folderId"),
    parentId: integer("parentId"),
    listId: integer("listId"),
    title: text("title").notNull(),
    tags: text("tags").notNull().default("[]"),
    blocks: text("blocks").notNull().default("[]"),
    taskIds: text("taskIds").notNull().default("[]"),
    editedBy: text("editedBy").notNull().default(""),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("pj_docs_org_idx").on(t.organizationId, t.folderId)]
);
export type PjDoc = typeof pjDocs.$inferSelect;

/** Comments on a doc; quote is the text they were about. */
export const pjDocComments = sqliteTable(
  "pj_doc_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    docId: integer("docId").notNull(),
    quote: text("quote").notNull().default(""),
    body: text("body").notNull(),
    authorName: text("authorName").notNull(),
    authorId: integer("authorId"),
    createdAt: createdAt(),
  },
  (t) => [index("pj_doc_comments_doc_idx").on(t.organizationId, t.docId)]
);
export type PjDocComment = typeof pjDocComments.$inferSelect;

/** A whiteboard in a folder. items: JSON [{id, kind: sticky|rect|circle|text|pen|arrow|task|frame, x, y, w, h, color, text, from?, to?, taskId?, path?}]. */
export const pjBoards = sqliteTable(
  "pj_boards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    folderId: integer("folderId"),
    listId: integer("listId"),
    title: text("title").notNull(),
    tags: text("tags").notNull().default("[]"),
    items: text("items").notNull().default("[]"),
    editedBy: text("editedBy").notNull().default(""),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("pj_boards_org_idx").on(t.organizationId, t.folderId)]
);
export type PjBoard = typeof pjBoards.$inferSelect;

/**
 * A form whose answers become tasks. questions: JSON [{id, label, type, required, options?, mapTo}].
 * settings: JSON {status, assignTo, ask, thanks, intro}. token: the public link's key.
 */
export const pjForms = sqliteTable(
  "pj_forms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    folderId: integer("folderId"),
    listId: integer("listId"),
    title: text("title").notNull(),
    questions: text("questions").notNull().default("[]"),
    settings: text("settings").notNull().default("{}"),
    token: text("token").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("pj_forms_org_idx").on(t.organizationId), uniqueIndex("pj_forms_token_idx").on(t.token)]
);
export type PjForm = typeof pjForms.$inferSelect;

/** One answer to a form: answers JSON {questionId: value}; the task it made. */
export const pjFormAnswers = sqliteTable(
  "pj_form_answers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    formId: integer("formId").notNull(),
    taskId: integer("taskId"),
    answers: text("answers").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("pj_form_answers_form_idx").on(t.organizationId, t.formId)]
);
export type PjFormAnswer = typeof pjFormAnswers.$inferSelect;

/** A Projects dashboard. cards: JSON [{id, type, title, scope, size, options}]. */
export const pjDashboards = sqliteTable(
  "pj_dashboards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    name: text("name").notNull(),
    cards: text("cards").notNull().default("[]"),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("pj_dashboards_org_idx").on(t.organizationId)]
);
export type PjDashboard = typeof pjDashboards.$inferSelect;

/**
 * Who a list is shared with and how: kind user (a teammate), employee, or guest
 * (someone outside the workspace who sees only the lists shared with them).
 * level: full, edit, comment or view.
 */
export const pjShares = sqliteTable(
  "pj_shares",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    listId: integer("listId").notNull(),
    kind: text("kind", { enum: ["user", "employee", "guest"] }).notNull(),
    userId: integer("userId"),
    employeeId: integer("employeeId"),
    level: text("level", { enum: ["full", "edit", "comment", "view"] }).notNull().default("edit"),
    invitedBy: text("invitedBy").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("pj_shares_list_idx").on(t.organizationId, t.listId), index("pj_shares_user_idx").on(t.userId)]
);
export type PjShare = typeof pjShares.$inferSelect;

/**
 * Saved views on a list or a folder: a kind (list, board, calendar, gantt,
 * table, workload, timeline, mindmap) with its own filters, grouping, sort and
 * columns. A row with an empty name holds the settings of the built-in tab of
 * that kind. A view with a userId is private to that person. pinned views
 * come first.
 */
export const pjViews = sqliteTable(
  "pj_views",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    listId: integer("listId"),
    folderId: integer("folderId"),
    name: text("name").notNull().default(""),
    kind: text("kind").notNull().default("list"),
    settings: text("settings").notNull().default("{}"),
    userId: integer("userId"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdBy: text("createdBy").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("pj_views_org_idx").on(t.organizationId, t.listId, t.folderId)]
);

/** Small Projects settings and markers: weekly hours per person, automations already fired. */
export const pjSettings = sqliteTable(
  "pj_settings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pj_settings_key_idx").on(t.organizationId, t.key)]
);
export type PjSetting = typeof pjSettings.$inferSelect;

// ==========================================
// SOPs: how the workspace does things, written by the employees and reviewed by Simone
// ==========================================

export const SOP_AREAS = ["front_desk", "billing", "clinical", "marketing", "admin"] as const;
export const SOP_STATUSES = ["draft", "writing", "review", "current", "retired"] as const;

/** One step of an SOP: what to do, why or what to watch for, and the screenshot under it. */
export type SopStep = { title: string; detail: string; imageUrl: string | null };

export const sops = sqliteTable(
  "sops",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    title: text("title").notNull(),
    area: text("area", { enum: SOP_AREAS }).notNull().default("admin"),
    /** The employee that keeps it current (its roster kind), e.g. "inbox" for Avery. */
    ownerKind: text("ownerKind").notNull().default("coo"),
    /** Who at the practice follows it, in plain words. */
    follows: text("follows").notNull().default(""),
    /** When it applies, in plain words. */
    when: text("when").notNull().default(""),
    status: text("status", { enum: SOP_STATUSES }).notNull().default("draft"),
    version: integer("version").notNull().default(1),
    /** JSON SopStep[] */
    steps: text("steps").notNull().default("[]"),
    /** record (a screen recording), site (an employee walked the screens), chat (written from what was said), manual (typed). */
    sourceKind: text("sourceKind", { enum: ["record", "site", "chat", "manual"] }).notNull().default("manual"),
    sourceNote: text("sourceNote").notNull().default(""),
    sourceUrl: text("sourceUrl"),
    /** YYYY-MM-DD of the last review and the next one due. */
    reviewedAt: text("reviewedAt"),
    nextReview: text("nextReview"),
    /** The Brain entry that carries this SOP to the employees while it is current. */
    knowledgeId: integer("knowledgeId"),
    createdBy: text("createdBy").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sops_org_idx").on(t.organizationId, t.status)]
);
export type Sop = typeof sops.$inferSelect;

/** Every saved version of an SOP, so History shows who changed what. */
export const sopVersions = sqliteTable(
  "sop_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    sopId: integer("sopId").notNull(),
    version: integer("version").notNull(),
    /** JSON snapshot: { title, area, ownerKind, follows, when, steps } */
    snapshot: text("snapshot").notNull(),
    changedBy: text("changedBy").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("sop_versions_sop_idx").on(t.organizationId, t.sopId)]
);
export type SopVersion = typeof sopVersions.$inferSelect;

/** A screen recording or a site walk being turned into an SOP. */
export const sopJobs = sqliteTable(
  "sop_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    sopId: integer("sopId"),
    kind: text("kind", { enum: ["record", "site"] }).notNull(),
    title: text("title").notNull().default(""),
    status: text("status", { enum: ["queued", "working", "done", "failed"] }).notNull().default("queued"),
    /** What is happening now, for the progress card. */
    stage: text("stage").notNull().default(""),
    /** JSON of the stages done so far: [{ label, detail }] */
    stages: text("stages").notNull().default("[]"),
    note: text("note").notNull().default(""),
    /** The recording on disk (outside the served files) and, once saved, its public address. */
    filePath: text("filePath"),
    fileUrl: text("fileUrl"),
    /** Seconds recorded. */
    seconds: integer("seconds"),
    webTaskId: integer("webTaskId"),
    createdBy: text("createdBy").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sop_jobs_org_idx").on(t.organizationId, t.status)]
);
export type SopJob = typeof sopJobs.$inferSelect;

// ==========================================
// LeadDash EHR: what a healthcare practice's employees read from it
// ==========================================

/** The last snapshot read from LeadDash EHR for a workspace: claims, paperwork, appointments, notes, balances. Harper, Camille and Malik work from it; the next read is compared to it for what is new. */
export const ehrSnapshots = sqliteTable("ehr_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  organizationId: integer("organizationId").notNull().unique(),
  /** JSON EhrSnapshot */
  data: text("data").notNull(),
  fetchedAt: integer("fetchedAt", { mode: "timestamp" }).notNull(),
  /** The last read that failed, and why; cleared on the next good read. */
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export type EhrSnapshotRow = typeof ehrSnapshots.$inferSelect;

/** Camille's dates: CAQH attestations, license renewals, training, payer enrollments. Typed by the practice; nothing is looked up about a person. */
export const COMPLIANCE_KINDS = ["caqh", "license", "training", "enrollment", "other"] as const;
export const complianceItems = sqliteTable(
  "compliance_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    kind: text("kind", { enum: COMPLIANCE_KINDS }).notNull().default("other"),
    /** What it is: "CAQH attestation", "LPC renewal, Oklahoma", "HIPAA training", "BCBS of Oklahoma enrollment". */
    title: text("title").notNull(),
    /** Who it is for: a clinician or staff member's name. */
    who: text("who").notNull().default(""),
    /** YYYY-MM-DD */
    due: text("due"),
    status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
    note: text("note").notNull().default(""),
    doneAt: text("doneAt"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("compliance_items_org_idx").on(t.organizationId, t.status)]
);
export type ComplianceItem = typeof complianceItems.$inferSelect;
