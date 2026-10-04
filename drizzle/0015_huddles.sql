CREATE TABLE `huddles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`startedBy` integer,
	`startedByName` text NOT NULL,
	`kinds` text DEFAULT '[]' NOT NULL,
	`transcript` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'live' NOT NULL,
	`token` text NOT NULL,
	`meetingUrl` text,
	`botId` text,
	`meetingId` integer,
	`createdAt` integer NOT NULL,
	`endedAt` integer
);
--> statement-breakpoint
CREATE INDEX `huddles_org_idx` ON `huddles` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `huddles_token_idx` ON `huddles` (`token`);