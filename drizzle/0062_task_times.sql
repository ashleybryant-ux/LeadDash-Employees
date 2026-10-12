CREATE TABLE `pj_task_times` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`taskId` integer NOT NULL,
	`userId` integer NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`minutes` integer DEFAULT 60 NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`moves` integer DEFAULT 0 NOT NULL,
	`movedFrom` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pj_task_times_user_idx` ON `pj_task_times` (`organizationId`,`userId`,`status`);--> statement-breakpoint
CREATE INDEX `pj_task_times_task_idx` ON `pj_task_times` (`organizationId`,`taskId`);