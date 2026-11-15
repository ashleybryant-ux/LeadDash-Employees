CREATE TABLE `inbox_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`linkId` integer NOT NULL,
	`externalId` text NOT NULL,
	`threadId` text DEFAULT '' NOT NULL,
	`messageId` text DEFAULT '' NOT NULL,
	`fromName` text DEFAULT '' NOT NULL,
	`fromEmail` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`receivedAt` integer NOT NULL,
	`bodyEncrypted` text,
	`state` text NOT NULL,
	`did` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`replyState` text DEFAULT 'none' NOT NULL,
	`sentAt` integer,
	`sentBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_messages_org_external_unique` ON `inbox_messages` (`organizationId`,`linkId`,`externalId`);--> statement-breakpoint
CREATE INDEX `inbox_messages_org_state_idx` ON `inbox_messages` (`organizationId`,`state`);