ALTER TABLE `press_settings` ADD `listGoal` integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE `press_settings` ADD `lastBuildAt` integer;--> statement-breakpoint
ALTER TABLE `press_settings` ADD `buildCursor` integer DEFAULT 0 NOT NULL;