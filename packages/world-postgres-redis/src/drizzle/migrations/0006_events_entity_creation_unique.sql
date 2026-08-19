-- Enforce uniqueness of (run_id, correlation_id, type) for the
-- entity-creating events (step_created, hook_created, wait_created).
-- Port of upstream world-postgres migration
-- 0010_add_events_entity_creation_unique_index.
--
-- Without this constraint, a redelivered orchestrator message replaying
-- step_created (or a wait_created replay, waits having no entity table to
-- dedupe against) appends a second creation event to the log. On the next
-- replay the runtime consumes the duplicate after the step has left the
-- invocation queue and fails with ReplayDivergenceError. The unique
-- violation is caught in events.create and surfaced as EntityConflictError,
-- which the runtime already handles as a dedup signal.
--
-- Existing installations may already contain duplicate
-- (run_id, correlation_id, type) rows for these event types: the previous
-- storage behavior allowed them through. Deduplicate before creating the
-- unique partial index, otherwise the CREATE UNIQUE INDEX statement would
-- fail at migration time. Keep the earliest row per tuple (event ids are
-- monotonic ULIDs, so the lowest "id" is the chronologically-first write.
-- Upstream orders by ctid, but ctid is a physical locator that VACUUM
-- FULL/CLUSTER can reorder, so the ULID key is the sound ordering) and
-- drop the rest. The removed rows are exactly the ones that would have been
-- rejected as EntityConflictError had the index existed when they were
-- inserted.
--
-- CONCURRENTLY, because a plain CREATE INDEX takes a lock that blocks
-- writes for the whole build: a stall on a large live workflow_events
-- table during upgrade. CONCURRENTLY refuses to run inside a transaction
-- block, so the runner executes this file statement-by-statement outside
-- one (see NON_TRANSACTIONAL_MIGRATIONS in cli.ts). If the build fails
-- (e.g. a still-running old writer inserts a duplicate mid-build), it
-- leaves an INVALID index behind and the setup command exits nonzero.
-- Re-running setup recovers: the runner drops INVALID indexes before
-- applying migrations, and the delete above re-deduplicates.
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

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "workflow_events_entity_creation_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created');
