CREATE TABLE `sop_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`sopId` integer,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT '' NOT NULL,
	`stages` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`filePath` text,
	`fileUrl` text,
	`seconds` integer,
	`webTaskId` integer,
	`createdBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sop_jobs_org_idx` ON `sop_jobs` (`organizationId`,`status`);--> statement-breakpoint
CREATE TABLE `sop_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`sopId` integer NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`changedBy` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sop_versions_sop_idx` ON `sop_versions` (`organizationId`,`sopId`);--> statement-breakpoint
CREATE TABLE `sops` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`title` text NOT NULL,
	`area` text DEFAULT 'admin' NOT NULL,
	`ownerKind` text DEFAULT 'coo' NOT NULL,
	`follows` text DEFAULT '' NOT NULL,
	`when` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`sourceKind` text DEFAULT 'manual' NOT NULL,
	`sourceNote` text DEFAULT '' NOT NULL,
	`sourceUrl` text,
	`reviewedAt` text,
	`nextReview` text,
	`knowledgeId` integer,
	`createdBy` text DEFAULT '' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sops_org_idx` ON `sops` (`organizationId`,`status`);