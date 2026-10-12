ALTER TABLE `organizations` ADD `internal` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Every workspace that exists today is LeadDash's own (Employees isn't sold yet); staff switch off any that isn't.
UPDATE `organizations` SET `internal` = 1;
