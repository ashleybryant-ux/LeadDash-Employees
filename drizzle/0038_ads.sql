CREATE TABLE `ad_campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`page` text DEFAULT '' NOT NULL,
	`platforms` text DEFAULT '[]' NOT NULL,
	`budgetCents` integer DEFAULT 0 NOT NULL,
	`startDate` text DEFAULT '' NOT NULL,
	`endDate` text DEFAULT '' NOT NULL,
	`splitMode` text DEFAULT 'reese' NOT NULL,
	`split` text DEFAULT '{}' NOT NULL,
	`formats` text DEFAULT 'any' NOT NULL,
	`versions` integer DEFAULT 1 NOT NULL,
	`mustSay` text DEFAULT '' NOT NULL,
	`neverSay` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'budget' NOT NULL,
	`currentPlatform` text,
	`leftOut` text DEFAULT '[]' NOT NULL,
	`leftOutWhy` text DEFAULT '' NOT NULL,
	`createdBy` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ad_campaigns_org_idx` ON `ad_campaigns` (`organizationId`,`id`);--> statement-breakpoint
CREATE TABLE `ad_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`campaignId` integer NOT NULL,
	`platform` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'writing' NOT NULL,
	`content` text DEFAULT '{}' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`imagePrompt` text,
	`imageUrl` text,
	`imageError` text,
	`audioUrl` text,
	`audioError` text,
	`error` text,
	`approvedBy` text,
	`approvedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ad_sets_campaign_idx` ON `ad_sets` (`campaignId`,`platform`);