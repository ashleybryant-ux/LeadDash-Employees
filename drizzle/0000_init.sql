CREATE TABLE `ai_employees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`roleTitle` text NOT NULL,
	`department` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`efficiency` integer DEFAULT 98 NOT NULL,
	`tasksCompleted` integer DEFAULT 0 NOT NULL,
	`hoursSaved` integer DEFAULT 0 NOT NULL,
	`description` text,
	`capabilities` text,
	`systemPrompt` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_employees_org_idx` ON `ai_employees` (`organizationId`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`actorType` text NOT NULL,
	`actorName` text NOT NULL,
	`action` text NOT NULL,
	`details` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_org_idx` ON `audit_logs` (`organizationId`);--> statement-breakpoint
CREATE TABLE `external_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`provider` text NOT NULL,
	`accountLabel` text NOT NULL,
	`accountHandle` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`capabilities` text,
	`settings` text,
	`secretsEncrypted` text,
	`connectedAt` integer,
	`lastCheckedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_connections_org_provider_unique` ON `external_connections` (`organizationId`,`provider`);--> statement-breakpoint
CREATE TABLE `grant_opportunities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`funder` text NOT NULL,
	`source` text NOT NULL,
	`sourceUrl` text,
	`deadline` text,
	`fundingAmount` text,
	`matchScore` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'discovered' NOT NULL,
	`summary` text,
	`eligibility` text,
	`fitReason` text,
	`deliverables` text,
	`searchQueries` text,
	`assignedEmployeeId` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `grant_opportunities_org_idx` ON `grant_opportunities` (`organizationId`);--> statement-breakpoint
CREATE TABLE `grant_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`opportunityId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`title` text NOT NULL,
	`version` text DEFAULT 'v1.0' NOT NULL,
	`status` text DEFAULT 'drafting' NOT NULL,
	`executiveSummary` text,
	`statementOfNeed` text,
	`programDesign` text,
	`budgetNarrative` text,
	`evaluationPlan` text,
	`complianceChecklist` text,
	`reviewerNotes` text,
	`approvedBy` text,
	`approvedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `grant_proposals_org_idx` ON `grant_proposals` (`organizationId`);--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`codeHash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expiresAt` integer NOT NULL,
	`usedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_codes_email_idx` ON `login_codes` (`email`);--> statement-breakpoint
CREATE TABLE `organization_knowledge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organization_knowledge_org_idx` ON `organization_knowledge` (`organizationId`);--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`title` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_members_user_organization_unique` ON `organization_members` (`organizationId`,`userId`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`plan` text DEFAULT 'growth' NOT NULL,
	`focusAreas` text,
	`ein` text,
	`annualBudget` text,
	`website` text,
	`state` text,
	`logoUrl` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `outbound_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer,
	`kind` text NOT NULL,
	`status` text DEFAULT 'drafting' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`targetChannels` text,
	`imagePrompt` text,
	`imageUrl` text,
	`metadata` text,
	`reviewerNotes` text,
	`scheduledFor` integer,
	`approvedBy` text,
	`approvedAt` integer,
	`externalReference` text,
	`publishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbound_items_org_idx` ON `outbound_items` (`organizationId`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`tokenHash` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`revokedAt` integer,
	`ip` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_tokenHash_unique` ON `sessions` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`userId`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`lastSignedIn` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer,
	`kind` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`title` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`sourceUrl` text,
	`searchQueries` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `work_items_org_kind_idx` ON `work_items` (`organizationId`,`kind`);