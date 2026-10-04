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
  "hiring",
  "prospecting",
  "outreach",
  "leads",
  "coo",
  "projects",
  "developer",
  "onboarding",
  "platform",
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
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_idx").on(t.organizationId)]
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ==========================================
// Connections and the approval queue
// ==========================================

export const PROVIDERS = ["google_workspace", "linkedin", "facebook", "instagram", "wordpress", "x", "google_business", "submittable", "sessionize", "threads", "tiktok", "clickup", "zoom", "recall", "bidprime"] as const;
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
    platform: text("platform", { enum: ["zoom", "meet"] }).notNull(),
    meetingUrl: text("meetingUrl").notNull(),
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
    kind: text("kind", { enum: ["browse", "audit", "fix", "page", "publish"] }).notNull().default("browse"),
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
 * certain employees send from (outreach on its own domain).
 */
export const accountLinks = sqliteTable(
  "account_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    organizationId: integer("organizationId").notNull(),
    purpose: text("purpose", { enum: ["calendar", "send"] }).notNull(),
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
