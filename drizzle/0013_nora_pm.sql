CREATE TABLE `project_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`launchId` integer,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`createdBy` text,
	`closedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_notes_org_idx` ON `project_notes` (`organizationId`);--> statement-breakpoint
ALTER TABLE `launch_tasks` ADD `doneWhen` text;--> statement-breakpoint
ALTER TABLE `launch_tasks` ADD `work` text;--> statement-breakpoint
ALTER TABLE `meetings` ADD `launchId` integer;