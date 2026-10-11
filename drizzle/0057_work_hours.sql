CREATE TABLE `hour_packs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`minutes` integer NOT NULL,
	`remaining` integer NOT NULL,
	`note` text,
	`addedBy` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hour_packs_org_idx` ON `hour_packs` (`organizationId`);--> statement-breakpoint
ALTER TABLE `organization_members` ADD `aiLimitMinutes` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `workHours` text;--> statement-breakpoint
UPDATE `organization_members` SET `aiLimitMinutes` = CAST(ROUND(`aiLimitMicros` * 180.0 / 1000000) AS integer) WHERE `aiLimitMicros` IS NOT NULL;
