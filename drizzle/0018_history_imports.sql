CREATE TABLE `history_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer,
	`who` text NOT NULL,
	`fileName` text NOT NULL,
	`filePath` text NOT NULL,
	`source` text DEFAULT 'unknown' NOT NULL,
	`status` text DEFAULT 'reading' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`skippedClient` integer DEFAULT 0 NOT NULL,
	`skippedOther` integer DEFAULT 0 NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`error` text,
	`createdAt` integer NOT NULL,
	`finishedAt` integer
);
--> statement-breakpoint
CREATE INDEX `history_imports_org_idx` ON `history_imports` (`organizationId`);