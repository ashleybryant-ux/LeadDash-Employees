CREATE TABLE `handbook_additions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`partKey` text NOT NULL,
	`rules` text NOT NULL,
	`updatedBy` text,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handbook_add_org_part_idx` ON `handbook_additions` (`organizationId`,`partKey`);--> statement-breakpoint
CREATE TABLE `handbook_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer,
	`partKey` text NOT NULL,
	`actorName` text NOT NULL,
	`summary` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `handbook_changes_time_idx` ON `handbook_changes` (`createdAt`);--> statement-breakpoint
CREATE TABLE `handbook_parts` (
	`key` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updatedBy` text,
	`updatedAt` integer NOT NULL
);
