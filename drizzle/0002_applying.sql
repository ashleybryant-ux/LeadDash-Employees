CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`opportunityId` integer NOT NULL,
	`employeeId` integer,
	`title` text NOT NULL,
	`status` text DEFAULT 'writing' NOT NULL,
	`mode` text DEFAULT 'draft' NOT NULL,
	`channel` text DEFAULT 'form' NOT NULL,
	`channelDetail` text,
	`questions` text DEFAULT '[]' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`extras` text,
	`review` text,
	`progress` text,
	`errorNote` text,
	`certifiedBy` text,
	`certifiedAt` integer,
	`submittedAt` integer,
	`confirmation` text,
	`receiptUrl` text,
	`decisionExpected` text,
	`award` text,
	`reviewerComments` text,
	`reapplyDate` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `applications_org_idx` ON `applications` (`organizationId`);--> statement-breakpoint
CREATE TABLE `employee_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer NOT NULL,
	`applicationId` integer,
	`label` text NOT NULL,
	`question` text NOT NULL,
	`options` text NOT NULL,
	`answer` text,
	`answeredBy` text,
	`answeredAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `employee_questions_org_idx` ON `employee_questions` (`organizationId`);--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`sourceType` text NOT NULL,
	`sourceId` integer NOT NULL,
	`employeeId` integer,
	`seq` integer NOT NULL,
	`heading` text,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `knowledge_chunks_src_idx` ON `knowledge_chunks` (`organizationId`,`sourceType`,`sourceId`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`employeeId` integer,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`host` text NOT NULL,
	`sourceUrl` text,
	`source` text,
	`deadline` text,
	`amount` text,
	`equity` text,
	`stage` text,
	`eligibility` text,
	`location` text,
	`eventDate` text,
	`audience` text,
	`angle` text,
	`summary` text,
	`fitScore` integer DEFAULT 0 NOT NULL,
	`fitCall` text DEFAULT 'apply' NOT NULL,
	`fitReason` text,
	`funderHistory` text,
	`funderHistoryUrl` text,
	`status` text DEFAULT 'new' NOT NULL,
	`searchQueries` text,
	`requirements` text,
	`packageStatus` text DEFAULT 'none' NOT NULL,
	`packageNote` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `opportunities_org_idx` ON `opportunities` (`organizationId`,`kind`);--> statement-breakpoint
CREATE TABLE `opportunity_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`opportunityId` integer NOT NULL,
	`name` text NOT NULL,
	`sourceUrl` text,
	`fileUrl` text,
	`pages` integer,
	`pagesUnit` text,
	`chars` integer,
	`status` text DEFAULT 'read' NOT NULL,
	`note` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `opportunity_files_opp_idx` ON `opportunity_files` (`organizationId`,`opportunityId`);--> statement-breakpoint
CREATE TABLE `portal_logins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`username` text NOT NULL,
	`secretEncrypted` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `portal_logins_org_idx` ON `portal_logins` (`organizationId`);--> statement-breakpoint
CREATE TABLE `registrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizationId` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`expires` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registrations_org_kind_unique` ON `registrations` (`organizationId`,`kind`);--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `employeeId` integer;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `folder` text;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `pages` integer;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `pagesUnit` text;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `chars` integer;--> statement-breakpoint
ALTER TABLE `organization_knowledge` ADD `readNote` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `signerName` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `signerTitle` text;--> statement-breakpoint
CREATE VIRTUAL TABLE `knowledge_fts` USING fts5(`text`, `heading`, content='knowledge_chunks', content_rowid='id', tokenize='porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_ai` AFTER INSERT ON `knowledge_chunks` BEGIN
  INSERT INTO knowledge_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_ad` AFTER DELETE ON `knowledge_chunks` BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
END;
--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_au` AFTER UPDATE ON `knowledge_chunks` BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
  INSERT INTO knowledge_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
--> statement-breakpoint
INSERT INTO `opportunities` (`organizationId`, `employeeId`, `kind`, `title`, `host`, `sourceUrl`, `source`, `deadline`, `amount`, `eligibility`, `summary`, `fitScore`, `fitCall`, `fitReason`, `status`, `searchQueries`, `packageStatus`, `createdAt`, `updatedAt`)
SELECT `organizationId`, `assignedEmployeeId`, 'grant', `title`, `funder`, `sourceUrl`, `source`, `deadline`, `fundingAmount`, `eligibility`, `summary`, `matchScore`, 'apply', `fitReason`,
  CASE WHEN `status` = 'archived' THEN 'dismissed' WHEN `status` IN ('drafting', 'under_review', 'approved_ready', 'submitted') THEN 'applying' ELSE 'new' END,
  `searchQueries`, 'none', `createdAt`, `updatedAt`
FROM `grant_opportunities`;
--> statement-breakpoint
INSERT INTO `opportunities` (`organizationId`, `employeeId`, `kind`, `title`, `host`, `sourceUrl`, `source`, `deadline`, `amount`, `audience`, `location`, `angle`, `fitScore`, `fitCall`, `status`, `searchQueries`, `packageStatus`, `createdAt`, `updatedAt`)
SELECT `organizationId`, `employeeId`, 'speaking', `title`, COALESCE(NULLIF(json_extract(`data`, '$.organizer'), ''), 'Organizer not listed'), `sourceUrl`,
  `sourceUrl`, json_extract(`data`, '$.deadline'), json_extract(`data`, '$.pays'), json_extract(`data`, '$.audience'), json_extract(`data`, '$.location'), json_extract(`data`, '$.angle'),
  70, 'apply', CASE WHEN `status` = 'dismissed' THEN 'dismissed' ELSE 'new' END, `searchQueries`, 'none', `createdAt`, `updatedAt`
FROM `work_items` WHERE `kind` = 'speaking_opportunity';
--> statement-breakpoint
INSERT INTO `applications` (`organizationId`, `opportunityId`, `employeeId`, `title`, `status`, `mode`, `channel`, `questions`, `attachments`, `createdAt`, `updatedAt`)
SELECT p.`organizationId`, o.`id`, p.`employeeId`, p.`title`,
  CASE WHEN p.`status` IN ('approved', 'ready_for_portal') THEN 'approved' ELSE 'ready' END,
  'draft', 'form',
  json_array(
    json_object('id', 'q1', 'text', 'Executive summary', 'limit', '', 'maxWords', NULL, 'answer', COALESCE(p.`executiveSummary`, ''), 'outline', json_array(), 'facts', json_array()),
    json_object('id', 'q2', 'text', 'Statement of need', 'limit', '', 'maxWords', NULL, 'answer', COALESCE(p.`statementOfNeed`, ''), 'outline', json_array(), 'facts', json_array()),
    json_object('id', 'q3', 'text', 'Program design and implementation plan', 'limit', '', 'maxWords', NULL, 'answer', COALESCE(p.`programDesign`, ''), 'outline', json_array(), 'facts', json_array()),
    json_object('id', 'q4', 'text', 'Budget narrative', 'limit', '', 'maxWords', NULL, 'answer', COALESCE(p.`budgetNarrative`, ''), 'outline', json_array(), 'facts', json_array()),
    json_object('id', 'q5', 'text', 'Evaluation plan', 'limit', '', 'maxWords', NULL, 'answer', COALESCE(p.`evaluationPlan`, ''), 'outline', json_array(), 'facts', json_array())
  ),
  '[]', p.`createdAt`, p.`updatedAt`
FROM `grant_proposals` p
JOIN `grant_opportunities` g ON g.`id` = p.`opportunityId` AND g.`organizationId` = p.`organizationId`
JOIN `opportunities` o ON o.`organizationId` = g.`organizationId` AND o.`kind` = 'grant' AND o.`title` = g.`title` AND o.`host` = g.`funder` AND o.`createdAt` = g.`createdAt`;
