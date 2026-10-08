ALTER TABLE `organization_members` ADD `aiLimitMode` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_members` ADD `aiLimitMicros` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `aiLimits` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `userId` integer;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `estimated` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_org_user_time_idx` ON `usage_events` (`organizationId`,`userId`,`createdAt`);