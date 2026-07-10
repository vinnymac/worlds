-- Remove the transactional outbox table. The pattern was never wired up
-- (no producer inserted rows), so the table is guaranteed empty; the queue
-- now provides durable redelivery natively via Redis sorted-set delay queues.
DROP TABLE IF EXISTS `workflow`.`workflow_outbox`;
