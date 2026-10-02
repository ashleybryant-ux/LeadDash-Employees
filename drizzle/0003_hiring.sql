CREATE TABLE `hr_people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`roleId` integer,
	`source` text NOT NULL,
	`stage` text NOT NULL,
	`name` text NOT NULL,
	`credentials` text,
	`currentRole` text,
	`location` text,
	`foundOn` text,
	`sourceUrl` text,
	`email` text,
	`resumeUrl` text,
	`resumeText` text,
	`fitScore` integer DEFAULT 0 NOT NULL,
	`fitReason` text,
	`mustHaves` text DEFAULT '[]' NOT NULL,
	`checks` text DEFAULT '[]' NOT NULL,
	`message` text,
	`contactedAt` integer,
	`followUpAt` integer,
	`appliedOn` text,
	`startDate` text,
	`onboarding` text,
	`purgeAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hr_people_org_idx` ON `hr_people` (`organizationId`);--> statement-breakpoint
CREATE TABLE `hr_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`employment` text DEFAULT 'w2' NOT NULL,
	`hours` text DEFAULT 'full' NOT NULL,
	`place` text DEFAULT 'both' NOT NULL,
	`payFrom` text,
	`payTo` text,
	`licenses` text DEFAULT '[]' NOT NULL,
	`mustHave` text,
	`niceToHave` text,
	`post` text,
	`targets` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hr_roles_org_idx` ON `hr_roles` (`organizationId`);--> statement-breakpoint
CREATE TABLE `hr_team_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`person` text NOT NULL,
	`item` text NOT NULL,
	`due` text,
	`progress` text,
	`lastRemindedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hr_team_items_org_idx` ON `hr_team_items` (`organizationId`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`userId` integer NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device` text NOT NULL,
	`lastSentAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`userId`);--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `onboarding` text;--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `dayToDay` text;--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `onboardedAt` integer;--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `notify` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `notifyPrefs` text;