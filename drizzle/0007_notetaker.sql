CREATE TABLE `notetaker_meetings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`eventId` text NOT NULL,
	`title` text NOT NULL,
	`startsAt` integer NOT NULL,
	`endsAt` integer NOT NULL,
	`platform` text NOT NULL,
	`meetingUrl` text NOT NULL,
	`attendees` text DEFAULT '[]' NOT NULL,
	`choice` text DEFAULT 'auto' NOT NULL,
	`lockReason` text,
	`status` text DEFAULT 'skipped' NOT NULL,
	`botId` text,
	`recordingId` text,
	`transcriptId` text,
	`transcript` text,
	`summary` text,
	`actionItems` text,
	`heldMinutes` integer,
	`error` text,
	`mediaDeletedAt` integer,
	`recapSentAt` integer,
	`meetingId` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notetaker_org_event_unique` ON `notetaker_meetings` (`organizationId`,`eventId`);--> statement-breakpoint
CREATE INDEX `notetaker_org_start_idx` ON `notetaker_meetings` (`organizationId`,`startsAt`);