CREATE TABLE `video_shares` (
	`token` text PRIMARY KEY NOT NULL,
	`organizationId` integer NOT NULL,
	`source` text NOT NULL,
	`sourceId` integer NOT NULL,
	`createdBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_shares_source_idx` ON `video_shares` (`organizationId`,`source`,`sourceId`);--> statement-breakpoint
ALTER TABLE `chat_files` ADD `posterUrl` text;--> statement-breakpoint
ALTER TABLE `chat_files` ADD `seconds` integer;