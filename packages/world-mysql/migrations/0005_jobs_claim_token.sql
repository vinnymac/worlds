-- Per-claim fencing token, regenerated on every claim. Settle statements
-- match it so an executor whose claim was reclaimed and redelivered cannot
-- complete, reschedule, or fail the newer claim. NULL for rows claimed
-- before this column existed. Appended last so MySQL < 8.0.29 can still use
-- ALGORITHM=INSTANT instead of rebuilding the table.
ALTER TABLE `workflow`.`workflow_jobs`
  ADD COLUMN `claim_token` VARCHAR(64) NULL;
