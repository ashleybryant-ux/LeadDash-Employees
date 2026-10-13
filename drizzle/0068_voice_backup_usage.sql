CREATE TABLE `voice_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`month` text NOT NULL,
	`provider` text NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_usage_org_month_provider` ON `voice_usage` (`organizationId`,`month`,`provider`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `voiceBackup` text;