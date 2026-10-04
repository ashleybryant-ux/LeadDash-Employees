ALTER TABLE `drama_episodes` ADD `kind` text DEFAULT 'drama' NOT NULL;--> statement-breakpoint
ALTER TABLE `drama_episodes` ADD `plan` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `drama_episodes` ADD `versions` text DEFAULT '{}' NOT NULL;