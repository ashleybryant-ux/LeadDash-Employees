CREATE TABLE `pj_doc_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`docId` integer NOT NULL,
	`kind` text NOT NULL,
	`userId` integer,
	`employeeId` integer,
	`email` text DEFAULT '' NOT NULL,
	`level` text DEFAULT 'view' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_doc_shares_org_idx` ON `pj_doc_shares` (`organizationId`,`docId`);--> statement-breakpoint
CREATE TABLE `pj_portfolio_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`portfolioId` integer NOT NULL,
	`kind` text NOT NULL,
	`itemId` integer NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_portfolio_items_org_idx` ON `pj_portfolio_items` (`organizationId`,`portfolioId`);--> statement-breakpoint
CREATE TABLE `pj_portfolios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text DEFAULT '#1b6b4a' NOT NULL,
	`ownerType` text DEFAULT 'user' NOT NULL,
	`ownerId` integer,
	`ownerName` text DEFAULT '' NOT NULL,
	`startDate` text,
	`dueDate` text,
	`archivedAt` integer,
	`createdBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_portfolios_org_idx` ON `pj_portfolios` (`organizationId`);--> statement-breakpoint
CREATE TABLE `pj_stars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`kind` text NOT NULL,
	`itemId` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_stars_org_idx` ON `pj_stars` (`organizationId`,`userId`);--> statement-breakpoint
CREATE TABLE `pj_status_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text NOT NULL,
	`itemId` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`accomplishments` text DEFAULT '' NOT NULL,
	`blockers` text DEFAULT '' NOT NULL,
	`next` text DEFAULT '' NOT NULL,
	`highlights` text DEFAULT '[]' NOT NULL,
	`authorType` text DEFAULT 'user' NOT NULL,
	`authorId` integer,
	`authorName` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_status_updates_org_idx` ON `pj_status_updates` (`organizationId`,`kind`,`itemId`);--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `ownerUserId` integer;--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `private` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `workspaceWide` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `shareToken` text;--> statement-breakpoint
ALTER TABLE `pj_docs` ADD `archivedAt` integer;--> statement-breakpoint
ALTER TABLE `pj_folders` ADD `archivedAt` integer;--> statement-breakpoint
ALTER TABLE `pj_folders` ADD `archivedBy` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_lists` ADD `adminsOnly` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_lists` ADD `archivedAt` integer;--> statement-breakpoint
ALTER TABLE `pj_lists` ADD `archivedBy` text DEFAULT '' NOT NULL;