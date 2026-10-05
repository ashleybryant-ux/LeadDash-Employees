CREATE TABLE `pj_boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`folderId` integer,
	`title` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`editedBy` text DEFAULT '' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_boards_org_idx` ON `pj_boards` (`organizationId`,`folderId`);--> statement-breakpoint
CREATE TABLE `pj_dashboards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`cards` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_dashboards_org_idx` ON `pj_dashboards` (`organizationId`);--> statement-breakpoint
CREATE TABLE `pj_doc_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`docId` integer NOT NULL,
	`quote` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`authorName` text NOT NULL,
	`authorId` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_doc_comments_doc_idx` ON `pj_doc_comments` (`organizationId`,`docId`);--> statement-breakpoint
CREATE TABLE `pj_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`folderId` integer,
	`parentId` integer,
	`title` text NOT NULL,
	`blocks` text DEFAULT '[]' NOT NULL,
	`taskIds` text DEFAULT '[]' NOT NULL,
	`editedBy` text DEFAULT '' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_docs_org_idx` ON `pj_docs` (`organizationId`,`folderId`);--> statement-breakpoint
CREATE TABLE `pj_form_answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`formId` integer NOT NULL,
	`taskId` integer,
	`answers` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_form_answers_form_idx` ON `pj_form_answers` (`organizationId`,`formId`);--> statement-breakpoint
CREATE TABLE `pj_forms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`folderId` integer,
	`listId` integer,
	`title` text NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`token` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_forms_org_idx` ON `pj_forms` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `pj_forms_token_idx` ON `pj_forms` (`token`);--> statement-breakpoint
CREATE TABLE `pj_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`taskId` integer NOT NULL,
	`otherId` integer NOT NULL,
	`kind` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_links_task_idx` ON `pj_links` (`organizationId`,`taskId`);--> statement-breakpoint
CREATE INDEX `pj_links_other_idx` ON `pj_links` (`organizationId`,`otherId`);--> statement-breakpoint
CREATE TABLE `pj_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pj_settings_key_idx` ON `pj_settings` (`organizationId`,`key`);--> statement-breakpoint
CREATE TABLE `pj_shares` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`listId` integer NOT NULL,
	`kind` text NOT NULL,
	`userId` integer,
	`employeeId` integer,
	`level` text DEFAULT 'edit' NOT NULL,
	`invitedBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_shares_list_idx` ON `pj_shares` (`organizationId`,`listId`);--> statement-breakpoint
CREATE INDEX `pj_shares_user_idx` ON `pj_shares` (`userId`);--> statement-breakpoint
CREATE TABLE `pj_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`folderName` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`createdBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_templates_org_idx` ON `pj_templates` (`organizationId`);--> statement-breakpoint
CREATE TABLE `pj_time` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`taskId` integer NOT NULL,
	`whoType` text NOT NULL,
	`whoId` integer NOT NULL,
	`whoName` text NOT NULL,
	`day` text NOT NULL,
	`minutes` integer,
	`startedAt` integer,
	`note` text DEFAULT '' NOT NULL,
	`billable` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_time_task_idx` ON `pj_time` (`organizationId`,`taskId`);--> statement-breakpoint
CREATE INDEX `pj_time_day_idx` ON `pj_time` (`organizationId`,`day`);--> statement-breakpoint
ALTER TABLE `pj_automations` ADD `folderId` integer;--> statement-breakpoint
ALTER TABLE `pj_folders` ADD `fields` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_lists` ADD `private` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_lists` ADD `shareToken` text;--> statement-breakpoint
ALTER TABLE `pj_tasks` ADD `repeat` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `pj_tasks` ADD `watchers` text DEFAULT '[]' NOT NULL;