CREATE TABLE `pj_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`listId` integer,
	`folderId` integer,
	`name` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'list' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`userId` integer,
	`pinned` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_views_org_idx` ON `pj_views` (`organizationId`,`listId`,`folderId`);--> statement-breakpoint
ALTER TABLE `pj_boards` ADD `listId` integer;--> statement-breakpoint
ALTER TABLE `pj_boards` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `listId` integer;--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `tags` text DEFAULT '[]' NOT NULL;