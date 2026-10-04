CREATE TABLE `public_files` (
	`token` text PRIMARY KEY NOT NULL,
	`organizationId` integer NOT NULL,
	`fileKey` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_files_key_idx` ON `public_files` (`fileKey`);--> statement-breakpoint
CREATE TABLE `site_page_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`pageId` integer NOT NULL,
	`version` integer NOT NULL,
	`html` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_page_versions_idx` ON `site_page_versions` (`pageId`,`version`);--> statement-breakpoint
CREATE TABLE `site_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer,
	`title` text NOT NULL,
	`pageType` text DEFAULT 'landing' NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'building' NOT NULL,
	`buttonUrl` text,
	`embedCode` text,
	`currentVersion` integer DEFAULT 0 NOT NULL,
	`progress` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `site_pages_org_idx` ON `site_pages` (`organizationId`);