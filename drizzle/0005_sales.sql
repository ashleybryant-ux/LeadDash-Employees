CREATE TABLE `sales_leads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`company` text,
	`message` text,
	`source` text NOT NULL,
	`prospectId` integer,
	`repliedAt` integer,
	`bookedFor` integer,
	`meta` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sales_leads_org_idx` ON `sales_leads` (`organizationId`);--> statement-breakpoint
CREATE TABLE `sales_prospects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text DEFAULT 'practice' NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`name` text NOT NULL,
	`city` text,
	`contactName` text,
	`contactTitle` text,
	`email` text,
	`phone` text,
	`website` text,
	`foundOn` text,
	`sourceUrl` text,
	`fitScore` integer DEFAULT 0 NOT NULL,
	`fitReason` text,
	`details` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sales_prospects_org_idx` ON `sales_prospects` (`organizationId`);--> statement-breakpoint
CREATE TABLE `team_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`toEmployeeId` integer,
	`link` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `team_activity_org_idx` ON `team_activity` (`organizationId`);--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `autonomy` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `sales` text;