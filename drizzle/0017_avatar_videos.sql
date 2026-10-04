CREATE TABLE `avatar_videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`title` text NOT NULL,
	`script` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`imageId` integer,
	`voiceId` text,
	`voiceName` text,
	`quality` text DEFAULT 'standard' NOT NULL,
	`tenths` integer,
	`costCents` integer DEFAULT 0 NOT NULL,
	`requestId` text,
	`videoUrl` text,
	`error` text,
	`madeAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `avatar_videos_org_idx` ON `avatar_videos` (`organizationId`);--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `studio` text;