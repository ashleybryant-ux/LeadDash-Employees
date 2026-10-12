CREATE TABLE `video_styles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`refs` text DEFAULT '[]' NOT NULL,
	`createdBy` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `video_styles_org_idx` ON `video_styles` (`organizationId`);--> statement-breakpoint
ALTER TABLE `videos` ADD `style` text DEFAULT 'real' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `motion` text DEFAULT 'pictures' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `cast` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `drawing` text;