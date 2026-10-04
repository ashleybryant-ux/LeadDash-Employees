CREATE TABLE `dev_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`repo` text NOT NULL,
	`label` text NOT NULL,
	`title` text NOT NULL,
	`request` text NOT NULL,
	`issueNumber` integer,
	`issueUrl` text,
	`branch` text,
	`prNumber` integer,
	`prUrl` text,
	`status` text DEFAULT 'working' NOT NULL,
	`summary` text DEFAULT '[]' NOT NULL,
	`files` integer,
	`checks` text,
	`error` text,
	`seenComment` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `dev_changes_org_idx` ON `dev_changes` (`organizationId`);