CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'broll' NOT NULL,
	`size` text DEFAULT 'vertical' NOT NULL,
	`seconds` integer DEFAULT 30 NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`script` text DEFAULT '{}' NOT NULL,
	`voiceId` text,
	`voiceName` text,
	`planId` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`videoUrl` text,
	`error` text,
	`tenths` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `videos_org_idx` ON `videos` (`organizationId`);--> statement-breakpoint
ALTER TABLE `hr_people` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `hr_people` ADD `offboarding` text;--> statement-breakpoint
ALTER TABLE `hr_roles` ADD `jd` text;--> statement-breakpoint
ALTER TABLE `hr_roles` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `hr_roles` ADD `publishedAt` integer;--> statement-breakpoint
ALTER TABLE `hr_roles` ADD `channels` text;--> statement-breakpoint
ALTER TABLE `sales_prospects` ADD `search` text;