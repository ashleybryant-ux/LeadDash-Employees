DROP INDEX `chat_reads_unique`;--> statement-breakpoint
ALTER TABLE `chat_reads` ADD `thread` text DEFAULT 'me' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `chat_reads_unique` ON `chat_reads` (`organizationId`,`employeeId`,`userId`,`thread`);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `threadUserId` integer;--> statement-breakpoint
ALTER TABLE `organization_members` ADD `chatAccess` text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_members` ADD `chatAccessList` text;--> statement-breakpoint
UPDATE `chat_messages` SET `threadUserId` = (
  SELECT u.`userId` FROM `chat_messages` u
  WHERE u.`organizationId` = `chat_messages`.`organizationId` AND u.`employeeId` = `chat_messages`.`employeeId`
    AND u.`role` = 'user' AND u.`id` <= `chat_messages`.`id`
  ORDER BY u.`id` DESC LIMIT 1
);