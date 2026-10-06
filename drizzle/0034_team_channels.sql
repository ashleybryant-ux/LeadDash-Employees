CREATE TABLE `team_channel_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`channelId` integer NOT NULL,
	`userId` integer NOT NULL,
	`notify` text DEFAULT 'all' NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`left` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_channel_members_unique` ON `team_channel_members` (`channelId`,`userId`);--> statement-breakpoint
CREATE TABLE `team_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`key` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`aiAllowed` integer DEFAULT true NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`createdBy` integer,
	`importedId` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_channels_org_idx` ON `team_channels` (`organizationId`,`key`);--> statement-breakpoint
CREATE TABLE `team_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`messageId` integer NOT NULL,
	`userId` integer NOT NULL,
	`authorName` text DEFAULT '' NOT NULL,
	`emoji` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_reactions_msg_idx` ON `team_reactions` (`messageId`);--> statement-breakpoint
CREATE TABLE `team_saved` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`messageId` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_saved_unique` ON `team_saved` (`userId`,`messageId`);--> statement-breakpoint
ALTER TABLE `team_messages` ADD `employeeId` integer;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `threadOf` integer;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `mentions` text;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `editedAt` integer;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `deletedAt` integer;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `pinnedBy` integer;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `pinnedAt` integer;--> statement-breakpoint
ALTER TABLE `team_messages` ADD `importedId` text;--> statement-breakpoint
CREATE INDEX `team_messages_thread_idx` ON `team_messages` (`threadOf`);