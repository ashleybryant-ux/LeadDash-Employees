CREATE TABLE `compliance_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`title` text NOT NULL,
	`who` text DEFAULT '' NOT NULL,
	`due` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`doneAt` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `compliance_items_org_idx` ON `compliance_items` (`organizationId`,`status`);--> statement-breakpoint
CREATE TABLE `ehr_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`data` text NOT NULL,
	`fetchedAt` integer NOT NULL,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ehr_snapshots_organizationId_unique` ON `ehr_snapshots` (`organizationId`);