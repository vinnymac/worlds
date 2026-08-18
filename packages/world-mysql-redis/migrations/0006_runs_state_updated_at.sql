-- Optimistic-concurrency marker for `CreateEventParams.stateUpdatedAt`
-- (@workflow/world 4.3.1). Holds the epoch-ms ULID time of the most recent
-- externally-originated event (hook_received / step_completed created without
-- a stateUpdatedAt) recorded for the run. A replay-origin create whose
-- stateUpdatedAt is strictly older than this marker is rejected with 412.
ALTER TABLE `workflow`.`workflow_runs` ADD COLUMN `state_updated_at` BIGINT NULL AFTER `expired_at`;
