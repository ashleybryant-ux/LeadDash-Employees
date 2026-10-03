CREATE TABLE `usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer,
	`type` text NOT NULL,
	`minutes` integer DEFAULT 0 NOT NULL,
	`costMicros` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_org_time_idx` ON `usage_events` (`organizationId`,`createdAt`);