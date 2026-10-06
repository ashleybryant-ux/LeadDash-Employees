ALTER TABLE `ai_employees` ADD `onTeam` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `orgType` text DEFAULT 'business' NOT NULL;