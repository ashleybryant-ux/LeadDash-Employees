CREATE TABLE `roster_defaults` (
	`kind` text PRIMARY KEY NOT NULL,
	`avatarUrl` text,
	`voiceId` text,
	`voiceName` text,
	`updatedBy` text,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `ehrLocationId` text;