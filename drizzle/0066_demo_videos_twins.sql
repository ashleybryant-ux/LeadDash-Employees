CREATE TABLE `demo_videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'training' NOT NULL,
	`presenter` text DEFAULT 'screen' NOT NULL,
	`avatar` text DEFAULT '{}' NOT NULL,
	`voiceId` text,
	`voiceName` text,
	`ask` text DEFAULT '' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`socialStyle` text DEFAULT 'come' NOT NULL,
	`loginName` text,
	`url` text,
	`fromSopId` integer,
	`makeSop` integer DEFAULT true NOT NULL,
	`sopId` integer,
	`plan` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`step` text,
	`error` text,
	`take` text DEFAULT '{}' NOT NULL,
	`parts` text DEFAULT '{}' NOT NULL,
	`look` text DEFAULT '{}' NOT NULL,
	`sizes` text DEFAULT '["wide"]' NOT NULL,
	`videoUrls` text DEFAULT '{}' NOT NULL,
	`videoUrl` text,
	`tenths` integer,
	`paidMinutes` integer DEFAULT 0 NOT NULL,
	`paidAvatar` integer DEFAULT 0 NOT NULL,
	`webTaskId` integer,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `demo_videos_org_idx` ON `demo_videos` (`organizationId`);--> statement-breakpoint
CREATE TABLE `twin_looks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`twinId` integer NOT NULL,
	`name` text NOT NULL,
	`outfit` text DEFAULT 'keep' NOT NULL,
	`outfitText` text,
	`outfitPhoto` text,
	`background` text DEFAULT '{"type":"room"}' NOT NULL,
	`baseUrl` text,
	`thumbUrl` text,
	`status` text DEFAULT 'making' NOT NULL,
	`error` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `twin_looks_org_idx` ON `twin_looks` (`organizationId`,`twinId`);--> statement-breakpoint
CREATE TABLE `twins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`sourceUrl` text,
	`thumbUrl` text,
	`tenths` integer,
	`consentUrl` text,
	`consent` text DEFAULT 'needed' NOT NULL,
	`consentNote` text,
	`voiceId` text,
	`voiceName` text,
	`voiceNote` text,
	`status` text DEFAULT 'preparing' NOT NULL,
	`error` text,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `twins_org_idx` ON `twins` (`organizationId`);