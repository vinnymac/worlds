-- Enforce uniqueness of (run_id, correlation_id, type) for the
-- entity-creating events (step_created, hook_created, wait_created),
-- mirroring upstream world-postgres's workflow_events_entity_creation_unique
-- partial index (migration 0010).
--
-- Without this constraint, a redelivered orchestrator message replaying
-- step_created (or a wait_created replay — waits have no entity table to
-- dedupe against) appends a second creation event to the log. On the next
-- replay the runtime consumes the duplicate after the step has left the
-- invocation queue and fails with ReplayDivergenceError. The unique
-- violation is caught in events.create and surfaced as EntityConflictError,
-- which the runtime already handles as a dedup signal.
--
-- MySQL has no partial indexes, so the first key part is a functional
-- expression that is NULL for every other event type. Rows with a NULL in
-- any key part are exempt from UNIQUE enforcement, so only the three
-- creation event types are constrained.
--
-- Existing installations may already contain duplicate rows for these event
-- types — the previous storage behavior allowed them through. Deduplicate
-- before creating the index, keeping the earliest row per tuple (lowest
-- event id — ULIDs order chronologically). The rows removed are exactly the
-- ones that would have been rejected as EntityConflictError had the index
-- existed when they were inserted.
DELETE `e` FROM `workflow`.`workflow_events` AS `e`
JOIN (
	SELECT
		`id`,
		ROW_NUMBER() OVER (
			PARTITION BY `run_id`, `correlation_id`, `type`
			ORDER BY `id`
		) AS `row_num`
	FROM `workflow`.`workflow_events`
	WHERE `type` IN ('step_created', 'hook_created', 'wait_created')
) AS `d` ON `d`.`id` = `e`.`id`
WHERE `d`.`row_num` > 1;

-- Key-width note: all three parts are VARCHAR(255) utf8mb4 (4 bytes/char),
-- which would put the full-width key at ~3068 bytes - 4 bytes under the
-- 3072-byte InnoDB limit for DYNAMIC rows, and past the 767-byte per-part
-- limit for COMPACT/REDUNDANT rows (ERROR 1071 at migration time on servers
-- with innodb_default_row_format=compact). Bound the parts instead: run ids
-- are `wrun_` + ULID (31 chars, so SUBSTRING is the identity), `type` maxes
-- at 12 chars, and 128 chars of correlation id is far beyond practical
-- collision range. Worst case is now (64+128+32)*4 = 904 bytes, valid under
-- every InnoDB row format.
CREATE UNIQUE INDEX `workflow_events_entity_creation_unique`
	ON `workflow`.`workflow_events` (
		(CASE
			WHEN `type` IN ('step_created', 'hook_created', 'wait_created')
			THEN SUBSTRING(`run_id`, 1, 64)
			ELSE NULL
		END),
		`correlation_id`(128),
		`type`(32)
	);
