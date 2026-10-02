CREATE TABLE `launch_kpis` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`launchId` integer NOT NULL,
	`name` text NOT NULL,
	`target` integer NOT NULL,
	`unit` text DEFAULT 'count' NOT NULL,
	`byDate` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`manualValue` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launch_kpis_launch_idx` ON `launch_kpis` (`launchId`);--> statement-breakpoint
CREATE TABLE `launch_milestones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`launchId` integer NOT NULL,
	`name` text NOT NULL,
	`dueDate` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launch_milestones_launch_idx` ON `launch_milestones` (`launchId`);--> statement-breakpoint
CREATE TABLE `launch_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`launchId` integer NOT NULL,
	`week` integer NOT NULL,
	`weeks` integer NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launch_reports_launch_idx` ON `launch_reports` (`launchId`);--> statement-breakpoint
CREATE TABLE `launch_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`launchId` integer NOT NULL,
	`milestoneId` integer,
	`title` text NOT NULL,
	`details` text,
	`ownerType` text DEFAULT 'person' NOT NULL,
	`ownerKind` text,
	`ownerName` text NOT NULL,
	`ownerEmail` text,
	`dueDate` integer NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`waitingOn` text,
	`note` text,
	`clickupTaskId` text,
	`clickupUrl` text,
	`clickupStatus` text,
	`remindedAt` integer,
	`doneAt` integer,
	`source` text DEFAULT 'plan' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launch_tasks_launch_idx` ON `launch_tasks` (`launchId`);--> statement-breakpoint
CREATE INDEX `launch_tasks_org_idx` ON `launch_tasks` (`organizationId`);--> statement-breakpoint
CREATE TABLE `launches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`launchDate` integer NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`brief` text,
	`clickupListId` text,
	`clickupListUrl` text,
	`clickup` text,
	`approvedBy` text,
	`approvedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launches_org_idx` ON `launches` (`organizationId`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`seriesId` text,
	`title` text NOT NULL,
	`startsAt` integer NOT NULL,
	`minutes` integer DEFAULT 30 NOT NULL,
	`attendees` text DEFAULT '[]' NOT NULL,
	`updatesFrom` text DEFAULT '[]' NOT NULL,
	`agenda` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`linkKind` text DEFAULT 'meet' NOT NULL,
	`link` text,
	`calendarEventId` text,
	`eventUrl` text,
	`zoomMeetingId` text,
	`inviteSentAt` integer,
	`notes` text,
	`notesAt` integer,
	`actionItems` text,
	`recapSentAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `meetings_org_idx` ON `meetings` (`organizationId`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `ops` text;