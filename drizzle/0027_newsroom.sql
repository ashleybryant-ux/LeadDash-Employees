CREATE TABLE `press_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`startsOn` text,
	`plan` text DEFAULT '{}' NOT NULL,
	`angles` text DEFAULT '[]' NOT NULL,
	`storyId` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `press_campaigns_org_idx` ON `press_campaigns` (`organizationId`);--> statement-breakpoint
CREATE TABLE `press_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`outlet` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`beats` text DEFAULT '[]' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`email` text,
	`emailSource` text,
	`verifiedAt` integer,
	`authorPage` text,
	`articles` text DEFAULT '[]' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`profile` text DEFAULT '{}' NOT NULL,
	`fit` text DEFAULT '{}' NOT NULL,
	`relationship` text DEFAULT 'prospect' NOT NULL,
	`lastContactAt` integer,
	`lastContactOrgId` integer,
	`lastPitch` text,
	`asks` text,
	`notes` text,
	`doNotContact` integer DEFAULT false NOT NULL,
	`movedFrom` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `press_contacts_org_idx` ON `press_contacts` (`organizationId`);--> statement-breakpoint
CREATE TABLE `press_coverage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`contactId` integer,
	`campaignId` integer,
	`headline` text NOT NULL,
	`outlet` text DEFAULT '' NOT NULL,
	`url` text,
	`ranOn` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `press_coverage_org_idx` ON `press_coverage` (`organizationId`);--> statement-breakpoint
CREATE TABLE `press_interviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`contactId` integer,
	`title` text NOT NULL,
	`at` integer,
	`place` text DEFAULT '' NOT NULL,
	`briefing` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `press_interviews_org_idx` ON `press_interviews` (`organizationId`);--> statement-breakpoint
CREATE TABLE `press_library` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`approved` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `press_library_org_idx` ON `press_library` (`organizationId`);--> statement-breakpoint
CREATE TABLE `press_pitches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`campaignId` integer,
	`storyId` integer,
	`contactId` integer NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`rubric` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`coolingUntil` integer,
	`followUp` integer DEFAULT false NOT NULL,
	`itemId` integer,
	`sentAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `press_pitches_org_idx` ON `press_pitches` (`organizationId`);--> statement-breakpoint
CREATE INDEX `press_pitches_contact_idx` ON `press_pitches` (`contactId`);--> statement-breakpoint
CREATE TABLE `press_replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`contactId` integer,
	`pitchId` integer,
	`messageId` text,
	`fromEmail` text DEFAULT '' NOT NULL,
	`fromName` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`draft` text,
	`status` text DEFAULT 'open' NOT NULL,
	`itemId` integer,
	`receivedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `press_replies_org_idx` ON `press_replies` (`organizationId`);--> statement-breakpoint
CREATE TABLE `press_settings` (
	`organizationId` integer PRIMARY KEY NOT NULL,
	`shared` text DEFAULT '[]' NOT NULL,
	`coolingDays` integer DEFAULT 21 NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`alwaysNeedsYou` text DEFAULT 'Crisis, regulators, legal, sensitive clinical topics, statements about patients' NOT NULL,
	`stopWords` text DEFAULT 'Breach, lawsuit, complaint, investigation, harm, death' NOT NULL,
	`owns` text DEFAULT '' NOT NULL,
	`beats` text DEFAULT '[]' NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`pausedReason` text,
	`lastScoutAt` integer,
	`lastBriefAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `press_stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`sourceUrl` text,
	`windowEnds` text DEFAULT '' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`alsoFits` text DEFAULT '[]' NOT NULL,
	`angle` text DEFAULT '' NOT NULL,
	`offer` text DEFAULT '' NOT NULL,
	`spokesperson` text DEFAULT '' NOT NULL,
	`quote` text,
	`contactIds` text DEFAULT '[]' NOT NULL,
	`skipped` text DEFAULT '[]' NOT NULL,
	`oppId` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `press_stories_org_idx` ON `press_stories` (`organizationId`);