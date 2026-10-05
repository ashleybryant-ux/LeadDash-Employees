CREATE TABLE `desk_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`urgency` text DEFAULT 'week' NOT NULL,
	`dueAt` integer,
	`fromKinds` text DEFAULT '[]' NOT NULL,
	`project` text DEFAULT '' NOT NULL,
	`minutes` integer,
	`amountCents` integer,
	`options` text DEFAULT '[]' NOT NULL,
	`suggested` integer,
	`suggestedWhy` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`link` text,
	`sourceKey` text,
	`status` text DEFAULT 'open' NOT NULL,
	`choice` text,
	`decidedBy` text,
	`decidedAt` integer,
	`laterUntil` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `desk_decisions_org_idx` ON `desk_decisions` (`organizationId`);--> statement-breakpoint
CREATE TABLE `desk_settings` (
	`organizationId` integer PRIMARY KEY NOT NULL,
	`rules` text DEFAULT '{}' NOT NULL,
	`lastBrief` text,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE TABLE `desk_waiting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text NOT NULL,
	`who` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`what` text NOT NULL,
	`blocks` text DEFAULT '' NOT NULL,
	`owner` text DEFAULT 'avery' NOT NULL,
	`heardIn` text DEFAULT '' NOT NULL,
	`plan` text DEFAULT '' NOT NULL,
	`askedAt` integer,
	`expectedAt` integer,
	`nudgeAt` integer,
	`escalateAt` integer,
	`nudgeSubject` text DEFAULT '' NOT NULL,
	`nudgeBody` text DEFAULT '' NOT NULL,
	`nudgedAt` integer,
	`sourceKey` text,
	`status` text DEFAULT 'open' NOT NULL,
	`doneBy` text,
	`doneAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `desk_waiting_org_idx` ON `desk_waiting` (`organizationId`);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `userId` integer;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `data` text;