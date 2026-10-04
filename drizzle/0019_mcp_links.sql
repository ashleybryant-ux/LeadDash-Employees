CREATE TABLE `mcp_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`userId` integer NOT NULL,
	`tokenHash` text NOT NULL,
	`tokenEncrypted` text NOT NULL,
	`lastUsedAt` integer,
	`lastClient` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_links_token_idx` ON `mcp_links` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `mcp_links_user_idx` ON `mcp_links` (`userId`,`organizationId`);