CREATE TABLE `review_access` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`email` text DEFAULT 'review@leaddash.io' NOT NULL,
	`codeEncrypted` text,
	`endsOn` text,
	`organizationId` integer,
	`lastSignInAt` integer,
	`updatedAt` integer NOT NULL
);
