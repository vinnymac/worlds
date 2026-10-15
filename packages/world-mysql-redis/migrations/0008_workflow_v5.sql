-- Workflow SDK v5 numbers each event by its position in its run's log
-- (`evnt_` + a zero-padded 1-based slot), so an event id is unique only
-- within its run. Re-key the events table on (run_id, id).
ALTER TABLE `workflow`.`workflow_events`
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`run_id`, `id`);

-- How many events each run's log holds. events.create advances it in the
-- transaction that appends the event, which is where the next slot comes
-- from. Runs created before this migration start at 0; their ULID-numbered
-- logs cannot be replayed by a v5 runtime anyway (drain them on the v4
-- build first).
ALTER TABLE `workflow`.`workflow_runs`
  ADD COLUMN `event_count` INT NOT NULL DEFAULT 0;

-- v5 serializes a run's or step's thrown value with the workflow
-- serialization pipeline; store it verbatim beside the legacy JSON text.
ALTER TABLE `workflow`.`workflow_runs`
  ADD COLUMN `error_cbor` MEDIUMBLOB NULL,
  ADD COLUMN `error_code` VARCHAR(255) NULL,
  ADD COLUMN `attributes` JSON NULL;

ALTER TABLE `workflow`.`workflow_steps`
  ADD COLUMN `error_cbor` MEDIUMBLOB NULL;
