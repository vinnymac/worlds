-- Step status ENUM was missing 'cancelled' in databases provisioned from the
-- original 0000_initial.sql (schema drift vs StepStatusSchema). MODIFY is
-- idempotent for databases already carrying the full enum.
ALTER TABLE `workflow`.`workflow_steps`
  MODIFY COLUMN `status` ENUM('pending','running','completed','failed','cancelled') NOT NULL;

-- Track the effective enqueue idempotency key on the job row so completion
-- and permanent failure can release the matching workflow_job_idempotency row.
ALTER TABLE `workflow`.`workflow_jobs`
  ADD COLUMN `idempotency_key` VARCHAR(255) NULL AFTER `queue_name`;

-- Associate stream chunks with their run so listStreamsByRunId works.
ALTER TABLE `workflow`.`workflow_stream_chunks`
  ADD COLUMN `run_id` VARCHAR(255) NULL AFTER `stream_id`;

ALTER TABLE `workflow`.`workflow_stream_chunks`
  ADD INDEX `idx_stream_chunks_run_id` (`run_id`);

-- 64KB BLOB columns error on realistic large payloads in strict mode.
-- Widen all CBOR/payload columns to MEDIUMBLOB (16MB).
ALTER TABLE `workflow`.`workflow_runs`
  MODIFY COLUMN `output_cbor` MEDIUMBLOB,
  MODIFY COLUMN `execution_context_cbor` MEDIUMBLOB,
  MODIFY COLUMN `input_cbor` MEDIUMBLOB;

ALTER TABLE `workflow`.`workflow_events`
  MODIFY COLUMN `payload_cbor` MEDIUMBLOB;

ALTER TABLE `workflow`.`workflow_steps`
  MODIFY COLUMN `input_cbor` MEDIUMBLOB,
  MODIFY COLUMN `output_cbor` MEDIUMBLOB;

ALTER TABLE `workflow`.`workflow_hooks`
  MODIFY COLUMN `metadata_cbor` MEDIUMBLOB;

ALTER TABLE `workflow`.`workflow_stream_chunks`
  MODIFY COLUMN `data` MEDIUMBLOB NOT NULL;

ALTER TABLE `workflow`.`workflow_jobs`
  MODIFY COLUMN `payload` MEDIUMBLOB NOT NULL;

-- TIMESTAMP(0) truncates occurredAt/createdAt/retryAfter/scheduled_for to
-- whole seconds. Widen to millisecond precision.
ALTER TABLE `workflow`.`workflow_runs`
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `completed_at` TIMESTAMP(3) NULL,
  MODIFY COLUMN `started_at` TIMESTAMP(3) NULL,
  MODIFY COLUMN `expired_at` TIMESTAMP(3) NULL;

ALTER TABLE `workflow`.`workflow_events`
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `occurred_at` TIMESTAMP(3) NULL;

ALTER TABLE `workflow`.`workflow_steps`
  MODIFY COLUMN `started_at` TIMESTAMP(3) NULL,
  MODIFY COLUMN `completed_at` TIMESTAMP(3) NULL,
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `retry_after` TIMESTAMP(3) NULL;

ALTER TABLE `workflow`.`workflow_hooks`
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `workflow`.`workflow_stream_chunks`
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE `workflow`.`workflow_jobs`
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  MODIFY COLUMN `locked_at` TIMESTAMP(3) NULL,
  MODIFY COLUMN `scheduled_for` TIMESTAMP(3) NULL;

ALTER TABLE `workflow`.`workflow_job_idempotency`
  MODIFY COLUMN `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
