CREATE TABLE `broll_clips` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'made' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`prompt` text,
	`url` text,
	`thumbUrl` text,
	`tenths` integer,
	`width` integer,
	`height` integer,
	`favorite` integer DEFAULT false NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`error` text,
	`createdBy` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `broll_clips_org_idx` ON `broll_clips` (`organizationId`);--> statement-breakpoint
ALTER TABLE `videos` ADD `sizes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `source` text DEFAULT 'idea' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `sourceUrl` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `look` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `videoUrls` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `voUrl` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `words` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `paidAt` integer;