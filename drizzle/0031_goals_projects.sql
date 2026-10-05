CREATE TABLE `goal_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`parentId` integer,
	`name` text NOT NULL,
	`color` text DEFAULT '#1b6b4a' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_folders_org_idx` ON `goal_folders` (`organizationId`);--> statement-breakpoint
CREATE TABLE `goal_reads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`weekStart` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_reads_org_idx` ON `goal_reads` (`organizationId`,`weekStart`);--> statement-breakpoint
CREATE TABLE `goal_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`goalId` integer NOT NULL,
	`kind` text DEFAULT 'number' NOT NULL,
	`name` text NOT NULL,
	`startValue` integer DEFAULT 0 NOT NULL,
	`currentValue` integer DEFAULT 0 NOT NULL,
	`targetValue` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`listId` integer,
	`measureId` integer,
	`history` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_targets_goal_idx` ON `goal_targets` (`organizationId`,`goalId`);--> statement-breakpoint
CREATE TABLE `goal_updates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`goalId` integer NOT NULL,
	`authorType` text NOT NULL,
	`authorId` integer,
	`authorName` text NOT NULL,
	`status` text,
	`body` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goal_updates_goal_idx` ON `goal_updates` (`organizationId`,`goalId`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`folderId` integer,
	`parentId` integer,
	`level` text DEFAULT 'quarter' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`period` text DEFAULT '' NOT NULL,
	`startDate` text NOT NULL,
	`dueDate` text NOT NULL,
	`ownerType` text,
	`ownerId` integer,
	`color` text DEFAULT '#1b6b4a' NOT NULL,
	`status` text,
	`manualProgress` integer,
	`state` text DEFAULT 'active' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`setBy` text DEFAULT '' NOT NULL,
	`agreedBy` text DEFAULT '' NOT NULL,
	`agreedAt` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`clickupId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `goals_org_idx` ON `goals` (`organizationId`,`state`);--> statement-breakpoint
CREATE TABLE `item_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`itemType` text NOT NULL,
	`itemId` integer NOT NULL,
	`fileId` integer NOT NULL,
	`addedBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `item_files_item_idx` ON `item_files` (`organizationId`,`itemType`,`itemId`);--> statement-breakpoint
CREATE TABLE `measure_values` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`measureId` integer NOT NULL,
	`weekStart` text NOT NULL,
	`value` real NOT NULL,
	`enteredBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measure_values_unique` ON `measure_values` (`organizationId`,`measureId`,`weekStart`);--> statement-breakpoint
CREATE TABLE `measures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`ownerType` text,
	`ownerId` integer,
	`weeklyGoal` real,
	`unit` text DEFAULT 'number' NOT NULL,
	`direction` text DEFAULT 'up' NOT NULL,
	`kind` text DEFAULT 'leading' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`goalId` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `measures_org_idx` ON `measures` (`organizationId`);--> statement-breakpoint
CREATE TABLE `pj_automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`listId` integer,
	`trigger` text NOT NULL,
	`action` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_automations_org_idx` ON `pj_automations` (`organizationId`);--> statement-breakpoint
CREATE TABLE `pj_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`taskId` integer NOT NULL,
	`kind` text DEFAULT 'comment' NOT NULL,
	`authorType` text NOT NULL,
	`authorId` integer,
	`authorName` text NOT NULL,
	`body` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_comments_task_idx` ON `pj_comments` (`organizationId`,`taskId`);--> statement-breakpoint
CREATE TABLE `pj_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#1b6b4a' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`clickupId` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_folders_org_idx` ON `pj_folders` (`organizationId`);--> statement-breakpoint
CREATE TABLE `pj_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`picks` text NOT NULL,
	`progress` text DEFAULT '' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`error` text,
	`startedBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL,
	`finishedAt` integer
);
--> statement-breakpoint
CREATE TABLE `pj_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`folderId` integer,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`statuses` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`clickupId` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_lists_org_idx` ON `pj_lists` (`organizationId`,`folderId`);--> statement-breakpoint
CREATE TABLE `pj_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`listId` integer NOT NULL,
	`parentId` integer,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`priority` text,
	`startDate` text,
	`dueDate` text,
	`timeEstimate` integer,
	`tags` text DEFAULT '[]' NOT NULL,
	`assignees` text DEFAULT '[]' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`checklist` text DEFAULT '[]' NOT NULL,
	`goalId` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`closedAt` integer,
	`createdBy` text DEFAULT '' NOT NULL,
	`clickupId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_tasks_list_idx` ON `pj_tasks` (`organizationId`,`listId`);--> statement-breakpoint
CREATE INDEX `pj_tasks_due_idx` ON `pj_tasks` (`organizationId`,`dueDate`);