CREATE TABLE `team_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`channel` text NOT NULL,
	`userId` integer NOT NULL,
	`authorName` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`attachments` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_messages_org_channel_idx` ON `team_messages` (`organizationId`,`channel`,`id`);--> statement-breakpoint
CREATE TABLE `team_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`channel` text NOT NULL,
	`lastReadId` integer DEFAULT 0 NOT NULL,
	`readAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_reads_unique` ON `team_reads` (`organizationId`,`userId`,`channel`);