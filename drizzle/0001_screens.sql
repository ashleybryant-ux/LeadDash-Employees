CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`role` text NOT NULL,
	`authorName` text NOT NULL,
	`userId` integer,
	`content` text NOT NULL,
	`cards` text,
	`searchQueries` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_messages_org_emp_idx` ON `chat_messages` (`organizationId`,`employeeId`);--> statement-breakpoint
CREATE TABLE `chat_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`userId` integer NOT NULL,
	`lastReadAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_reads_unique` ON `chat_reads` (`organizationId`,`employeeId`,`userId`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`repeat` text NOT NULL,
	`weekday` integer,
	`monthDay` integer,
	`time` text NOT NULL,
	`onDate` text,
	`enabled` integer DEFAULT true NOT NULL,
	`nextRunAt` integer,
	`lastRunAt` integer,
	`lastStatus` text,
	`lastError` text,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_org_idx` ON `scheduled_tasks` (`organizationId`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`taskId` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`messageId` integer,
	`startedAt` integer NOT NULL,
	`finishedAt` integer
);
--> statement-breakpoint
CREATE INDEX `task_runs_org_idx` ON `task_runs` (`organizationId`,`taskId`);--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `guidelines` text;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `kind` text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `sourceUrl` text;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `fileUrl` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `description` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `audience` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `entity` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `brandColors` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `fonts` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `timezone` text DEFAULT 'America/Chicago' NOT NULL;--> statement-breakpoint
UPDATE `ai_employees` SET `name` = 'Taylor' WHERE `kind` = 'speaking' AND `name` = 'Des';--> statement-breakpoint
UPDATE `ai_employees` SET `name` = 'Jordan' WHERE `kind` = 'website' AND `name` = 'Wren';--> statement-breakpoint
UPDATE `ai_employees` SET `name` = 'Elena' WHERE `kind` = 'video' AND `name` = 'Nico';
