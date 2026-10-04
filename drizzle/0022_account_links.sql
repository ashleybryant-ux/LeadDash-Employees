CREATE TABLE `account_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`purpose` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#1b6b4a' NOT NULL,
	`email` text,
	`secretsEncrypted` text,
	`calendars` text DEFAULT '[]' NOT NULL,
	`detail` text DEFAULT 'full' NOT NULL,
	`holds` text DEFAULT 'no' NOT NULL,
	`sendsFor` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `account_links_org_idx` ON `account_links` (`organizationId`);