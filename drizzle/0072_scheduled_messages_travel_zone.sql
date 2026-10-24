CREATE TABLE `scheduled_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`authorName` text NOT NULL,
	`target` text NOT NULL,
	`channel` text,
	`employeeId` integer,
	`content` text DEFAULT '' NOT NULL,
	`attachmentIds` text,
	`sendAt` integer NOT NULL,
	`timezone` text,
	`status` text DEFAULT 'waiting' NOT NULL,
	`error` text,
	`sentAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_messages_due_idx` ON `scheduled_messages` (`status`,`sendAt`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_user_idx` ON `scheduled_messages` (`organizationId`,`userId`,`status`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `timezoneFollowUserId` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `timezone` text;--> statement-breakpoint
UPDATE `organizations` SET `timezoneFollowUserId` = (SELECT `userId` FROM `organization_members` m WHERE m.`organizationId` = `organizations`.`id` AND m.`role` = 'owner' ORDER BY m.`id` LIMIT 1) WHERE `timezoneFollowUserId` IS NULL;
