CREATE TABLE `chat_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`userId` integer,
	`messageId` integer,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`fileUrl` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`pages` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_files_org_idx` ON `chat_files` (`organizationId`,`employeeId`);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `attachments` text;