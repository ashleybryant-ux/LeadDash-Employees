CREATE TABLE `staff_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`staffId` text NOT NULL,
	`side` text NOT NULL,
	`content` text NOT NULL,
	`nudgeId` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `staff_messages_thread_idx` ON `staff_messages` (`organizationId`,`staffId`,`employeeId`);--> statement-breakpoint
CREATE TABLE `staff_nudges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`reminderId` integer,
	`staffId` text NOT NULL,
	`staffName` text DEFAULT '' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`baseline` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`readAt` integer,
	`doneAt` integer,
	`checkedAt` integer,
	`result` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `staff_nudges_org_staff_idx` ON `staff_nudges` (`organizationId`,`staffId`,`status`);