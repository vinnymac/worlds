-- Workflow v5 (spec 7): slot-numbered event ids and the schema the v5
-- Storage contract materializes.
--
-- Event ids become per-run slot positions (`evnt_` + 26-char zero-padded
-- 1-based position), so `id` alone is no longer unique across runs: the
-- primary key becomes (run_id, id). The old standalone run_id index is
-- redundant afterwards (the new key leads with it) and is dropped.
ALTER TABLE `workflow`.`workflow_events`
	DROP PRIMARY KEY,
	ADD PRIMARY KEY (`run_id`, `id`);

ALTER TABLE `workflow`.`workflow_events`
	DROP INDEX `idx_workflow_events_run_id`;

-- v5 adds the attr_set event type to the entity-creation dedup set. Same
-- functional-index shape and key-width bounds as migration 0004; the drop
-- and re-add run in one atomic ALTER so a re-run converges.
ALTER TABLE `workflow`.`workflow_events`
	DROP INDEX `workflow_events_entity_creation_unique`,
	ADD UNIQUE INDEX `workflow_events_entity_creation_unique` (
		(CASE
			WHEN `type` IN ('step_created', 'hook_created', 'wait_created', 'attr_set')
			THEN SUBSTRING(`run_id`, 1, 64)
			ELSE NULL
		END),
		`correlation_id`(128),
		`type`(32)
	);

-- Which runs are slot-numbered. A row exists iff the run is; its absence is
-- the "this run predates slots, keep minting ULIDs" signal. A marker, not a
-- counter: positions are allocated by the INSERT that occupies them.
CREATE TABLE `workflow`.`workflow_event_slots` (
	`run_id` VARCHAR(255) NOT NULL PRIMARY KEY
) ROW_FORMAT=DYNAMIC;

-- Wait entities (wait_created / wait_completed materialization).
CREATE TABLE `workflow`.`workflow_waits` (
	`wait_id` VARCHAR(255) NOT NULL PRIMARY KEY,
	`run_id` VARCHAR(255) NOT NULL,
	`status` ENUM('waiting', 'completed') NOT NULL,
	`resume_at` TIMESTAMP(3) NULL,
	`completed_at` TIMESTAMP(3) NULL,
	`created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`spec_version` INT,
	INDEX `idx_workflow_waits_run_id` (`run_id`)
) ROW_FORMAT=DYNAMIC;

-- v5 run fields: serialized run_failed error (CBOR), plaintext error code,
-- attributes (merged SQL-side via JSON_SET), and the run's encryption
-- public key. The legacy `error` text column stays as the deprecated
-- errorJson read fallback.
ALTER TABLE `workflow`.`workflow_runs`
	ADD COLUMN `error_cbor` MEDIUMBLOB,
	ADD COLUMN `error_code` VARCHAR(255),
	ADD COLUMN `attributes` JSON NOT NULL DEFAULT ('{}'),
	ADD COLUMN `encryption_public_key` VARCHAR(255);

-- The 4.x stateUpdatedAt optimistic-concurrency marker is retired: v5
-- replaced the 412 guard with bump-and-report.
ALTER TABLE `workflow`.`workflow_runs`
	DROP COLUMN `state_updated_at`;

-- v5 step errors are serialized data, stored verbatim in CBOR.
ALTER TABLE `workflow`.`workflow_steps`
	ADD COLUMN `error_cbor` MEDIUMBLOB;

-- v5 hook fields: minimum token retention, system-hook flag, and the
-- server-synthesized resume slice (left null by this backend).
ALTER TABLE `workflow`.`workflow_hooks`
	ADD COLUMN `token_retention_until` TIMESTAMP(3) NULL,
	ADD COLUMN `is_system` BOOLEAN DEFAULT FALSE,
	ADD COLUMN `resume_context` MEDIUMBLOB;
