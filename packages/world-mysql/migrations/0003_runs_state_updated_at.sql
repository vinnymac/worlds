-- Epoch-ms ULID time of the most recent externally-originated event for the
-- run. A replay-origin create with a strictly older stateUpdatedAt gets 412.
ALTER TABLE `workflow`.`workflow_runs`
  ADD COLUMN `state_updated_at` BIGINT NULL AFTER `expired_at`;
