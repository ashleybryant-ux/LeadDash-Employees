CREATE TABLE `team_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`kind` text DEFAULT 'page' NOT NULL,
	`site` text DEFAULT '' NOT NULL,
	`title` text,
	`description` text,
	`image` text,
	`embed` text,
	`duration` integer,
	`status` text DEFAULT 'none' NOT NULL,
	`fetchedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_links_url_unique` ON `team_links` (`url`);--> statement-breakpoint
ALTER TABLE `team_messages` ADD `hiddenPreviews` text;