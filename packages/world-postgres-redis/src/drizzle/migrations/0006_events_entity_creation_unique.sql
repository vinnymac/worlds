-- Enforce uniqueness of (run_id, correlation_id, type) for the
-- entity-creating events (step_created, hook_created, wait_created).
-- Port of upstream world-postgres migration
-- 0010_add_events_entity_creation_unique_index.
--
-- Without this constraint, a redelivered orchestrator message replaying
-- step_created (or a wait_created replay — waits have no entity table to
-- dedupe against) appends a second creation event to the log. On the next
-- replay the runtime consumes the duplicate after the step has left the
-- invocation queue and fails with ReplayDivergenceError. The unique
-- violation is caught in events.create and surfaced as EntityConflictError,
-- which the runtime already handles as a dedup signal.
--
-- Existing installations may already contain duplicate
-- (run_id, correlation_id, type) rows for these event types — the previous
-- storage behavior allowed them through. Deduplicate before creating the
-- unique partial index, otherwise the CREATE UNIQUE INDEX statement would
-- fail at migration time. Keep the earliest row per tuple — event ids are
-- monotonic ULIDs, so the lowest "id" is the chronologically-first write
-- (upstream orders by ctid, but ctid is a physical locator that VACUUM
-- FULL/CLUSTER can reorder; the ULID key is the sound ordering) — and drop
-- the rest. The removed rows are exactly the ones that would have been
-- rejected as EntityConflictError had the index existed when they were
-- inserted.
WITH "ranked_workflow_events" AS (
	SELECT
		ctid,
		ROW_NUMBER() OVER (
			PARTITION BY "run_id", "correlation_id", "type"
			ORDER BY "id"
		) AS "row_num"
	FROM "workflow"."workflow_events"
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created')
)
DELETE FROM "workflow"."workflow_events"
WHERE ctid IN (
	SELECT ctid
	FROM "ranked_workflow_events"
	WHERE "row_num" > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_entity_creation_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created');
