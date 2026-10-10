CREATE TABLE `pj_prefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_prefs_org_idx` ON `pj_prefs` (`organizationId`,`userId`);--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `ownerUserId` integer;--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `ownerName` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `private` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `sharedWith` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `seen` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `location` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_dashboards` ADD `updatedAt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_views` ADD `protected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_views` ADD `isDefault` integer DEFAULT false NOT NULL;