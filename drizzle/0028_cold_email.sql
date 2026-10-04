CREATE TABLE `cold_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`angle` text NOT NULL,
	`who` text DEFAULT '{}' NOT NULL,
	`offer` text DEFAULT '' NOT NULL,
	`ask` text DEFAULT '' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`test` text DEFAULT '{}' NOT NULL,
	`share` integer DEFAULT 25 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`instantlyId` text,
	`stats` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `cold_campaigns_org_idx` ON `cold_campaigns` (`organizationId`);--> statement-breakpoint
CREATE TABLE `cold_inboxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`email` text NOT NULL,
	`accountStatus` integer DEFAULT 1 NOT NULL,
	`warmupScore` integer,
	`sentToday` integer DEFAULT 0 NOT NULL,
	`sent7` integer DEFAULT 0 NOT NULL,
	`bounced7` integer DEFAULT 0 NOT NULL,
	`replies7` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'healthy' NOT NULL,
	`reason` text,
	`restedAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cold_inboxes_org_email_unique` ON `cold_inboxes` (`organizationId`,`email`);--> statement-breakpoint
CREATE TABLE `cold_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`email` text NOT NULL,
	`firstName` text DEFAULT '' NOT NULL,
	`lastName` text DEFAULT '' NOT NULL,
	`license` text DEFAULT '' NOT NULL,
	`licenseNumber` text DEFAULT '' NOT NULL,
	`licenseStatus` text DEFAULT '' NOT NULL,
	`state` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`practice` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`segments` text DEFAULT '[]' NOT NULL,
	`fit` integer,
	`fitWhy` text DEFAULT '[]' NOT NULL,
	`depth` text DEFAULT 'list' NOT NULL,
	`research` text DEFAULT '{}' NOT NULL,
	`researchedAt` integer,
	`stage` text DEFAULT 'new' NOT NULL,
	`notFitReason` text,
	`campaignId` integer,
	`instantlyLeadId` text,
	`addedAt` integer,
	`finishedAt` integer,
	`lastReplyKind` text,
	`followUpAt` integer,
	`followUpNote` text,
	`bookedFor` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cold_leads_org_email_unique` ON `cold_leads` (`organizationId`,`email`);--> statement-breakpoint
CREATE INDEX `cold_leads_org_stage_fit_idx` ON `cold_leads` (`organizationId`,`stage`,`fit`);--> statement-breakpoint
CREATE INDEX `cold_leads_org_campaign_idx` ON `cold_leads` (`organizationId`,`campaignId`);--> statement-breakpoint
CREATE TABLE `cold_playbook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `cold_playbook_org_idx` ON `cold_playbook` (`organizationId`);--> statement-breakpoint
CREATE TABLE `cold_replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`leadId` integer NOT NULL,
	`campaignId` integer,
	`emailId` text NOT NULL,
	`inbox` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`variant` text,
	`draft` text,
	`handled` text,
	`status` text DEFAULT 'open' NOT NULL,
	`receivedAt` integer,
	`sentAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cold_replies_org_email_unique` ON `cold_replies` (`organizationId`,`emailId`);--> statement-breakpoint
CREATE INDEX `cold_replies_org_idx` ON `cold_replies` (`organizationId`);--> statement-breakpoint
CREATE TABLE `cold_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`points` text DEFAULT '[]' NOT NULL,
	`changes` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cold_reviews_org_idx` ON `cold_reviews` (`organizationId`);--> statement-breakpoint
CREATE TABLE `cold_settings` (
	`organizationId` integer PRIMARY KEY NOT NULL,
	`keyEncrypted` text,
	`keyCheckedAt` integer,
	`keyError` text,
	`plan` text DEFAULT 'growth' NOT NULL,
	`contactsLimit` integer DEFAULT 1000 NOT NULL,
	`emailsLimit` integer DEFAULT 5000 NOT NULL,
	`remainingInPlan` integer,
	`level` integer DEFAULT 1 NOT NULL,
	`perInbox` integer DEFAULT 20 NOT NULL,
	`rampPct` integer DEFAULT 10 NOT NULL,
	`bounceRest` integer DEFAULT 3 NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`optOut` text DEFAULT 'Not the right fit? Reply stop and I won''t email again.' NOT NULL,
	`alwaysNeedsYou` text DEFAULT 'Security, HIPAA or legal questions, groups over 20 clinicians, contract terms, anything about a client' NOT NULL,
	`website` text DEFAULT 'https://leaddash.io' NOT NULL,
	`site` text DEFAULT '{}' NOT NULL,
	`siteCheckedAt` integer,
	`siteError` text,
	`dailyNew` integer DEFAULT 0 NOT NULL,
	`today` text DEFAULT '{}' NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`hookToken` text,
	`lastReplyCheckAt` integer,
	`lastInboxCheckAt` integer,
	`lastFeedAt` integer,
	`lastReviewAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `cold_suppress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`email` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cold_suppress_org_email_unique` ON `cold_suppress` (`organizationId`,`email`);--> statement-breakpoint
CREATE TABLE `precall_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`leadId` integer,
	`person` text DEFAULT '' NOT NULL,
	`practice` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`meetingAt` integer,
	`runBy` text DEFAULT '' NOT NULL,
	`report` text DEFAULT '{}' NOT NULL,
	`after` text,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`refreshedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `precall_org_idx` ON `precall_reports` (`organizationId`);