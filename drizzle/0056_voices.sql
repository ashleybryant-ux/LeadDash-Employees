ALTER TABLE `ai_employees` ADD `voiceProvider` text;--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `voiceId` text;--> statement-breakpoint
ALTER TABLE `ai_employees` ADD `voiceName` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `voiceProvider` text DEFAULT 'auto' NOT NULL;