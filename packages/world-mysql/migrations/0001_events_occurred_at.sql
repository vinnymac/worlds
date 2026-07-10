-- Add occurred_at column for client-side event occurrence timestamps
-- (distinct from created_at, which is when the world stored the event)
ALTER TABLE `workflow`.`workflow_events` ADD COLUMN `occurred_at` TIMESTAMP NULL AFTER `created_at`;
