CREATE TABLE `compliance_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`recipients` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`sendAt` integer,
	`repeat` text DEFAULT 'none' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`lastSentAt` integer,
	`sentCount` integer DEFAULT 0 NOT NULL,
	`lastResult` text DEFAULT '' NOT NULL,
	`approvedBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `compliance_reminders_org_idx` ON `compliance_reminders` (`organizationId`,`status`);