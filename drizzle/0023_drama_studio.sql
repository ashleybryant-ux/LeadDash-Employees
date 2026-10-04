CREATE TABLE `drama_cast` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'made_up' NOT NULL,
	`look` text DEFAULT '' NOT NULL,
	`photoUrl` text,
	`voiceId` text,
	`voiceName` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drama_cast_org_idx` ON `drama_cast` (`organizationId`);--> statement-breakpoint
CREATE TABLE `drama_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`logline` text DEFAULT '' NOT NULL,
	`beats` text DEFAULT '[]' NOT NULL,
	`shots` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'script' NOT NULL,
	`progress` text,
	`videoUrl` text,
	`costCents` integer DEFAULT 0 NOT NULL,
	`error` text,
	`madeAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `drama_episodes_org_idx` ON `drama_episodes` (`organizationId`);--> statement-breakpoint
CREATE TABLE `drama_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`premise` text DEFAULT '' NOT NULL,
	`look` text DEFAULT '' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drama_series_org_unique` ON `drama_series` (`organizationId`);