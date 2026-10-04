CREATE TABLE `platform_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`workflow` text NOT NULL,
	`workflowUrl` text,
	`issue` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`severity` text DEFAULT 'should_fix' NOT NULL,
	`howItRuns` text DEFAULT '[]' NOT NULL,
	`fix` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`fixedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `platform_findings_org_idx` ON `platform_findings` (`organizationId`);--> statement-breakpoint
CREATE TABLE `web_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`kind` text DEFAULT 'browse' NOT NULL,
	`loginId` integer,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`startUrl` text NOT NULL,
	`allowSubmit` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`pending` text,
	`note` text,
	`steps` integer,
	`lastUrl` text,
	`screenshotUrl` text,
	`liveId` text,
	`ref` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `web_tasks_org_idx` ON `web_tasks` (`organizationId`);--> statement-breakpoint
ALTER TABLE `portal_logins` ADD `lockName` text;--> statement-breakpoint
ALTER TABLE `portal_logins` ADD `lockId` text;--> statement-breakpoint
ALTER TABLE `portal_logins` ADD `sessionEncrypted` text;