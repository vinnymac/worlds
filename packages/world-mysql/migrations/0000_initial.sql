-- All tables pin ROW_FORMAT=DYNAMIC: several key columns are VARCHAR(255)
-- utf8mb4 (1020 bytes), past the 767-byte per-key-part index limit of
-- COMPACT/REDUNDANT rows, so a server configured with
-- innodb_default_row_format=compact would fail these CREATE TABLEs outright
-- (and the wide events unique index added later).

-- Create schema
CREATE SCHEMA IF NOT EXISTS `workflow`;

-- Create runs table
CREATE TABLE `workflow`.`workflow_runs` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `output` JSON,
  `output_cbor` BLOB,
  `deployment_id` VARCHAR(255) NOT NULL,
  `status` ENUM('pending','running','completed','failed','cancelled') NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `execution_context` JSON,
  `execution_context_cbor` BLOB,
  `input` JSON,
  `input_cbor` BLOB,
  `error` TEXT,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at` TIMESTAMP NULL,
  `started_at` TIMESTAMP NULL,
  `spec_version` INT,
  `expired_at` TIMESTAMP NULL,
  INDEX `idx_workflow_runs_name` (`name`),
  INDEX `idx_workflow_runs_status` (`status`)
) ROW_FORMAT=DYNAMIC;

-- Create events table
CREATE TABLE `workflow`.`workflow_events` (
  `id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `type` VARCHAR(255) NOT NULL,
  `correlation_id` VARCHAR(255),
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `run_id` VARCHAR(255) NOT NULL,
  `payload` JSON,
  `payload_cbor` BLOB,
  `spec_version` INT,
  INDEX `idx_workflow_events_run_id` (`run_id`),
  INDEX `idx_workflow_events_correlation_id` (`correlation_id`)
) ROW_FORMAT=DYNAMIC;

-- Create steps table
CREATE TABLE `workflow`.`workflow_steps` (
  `run_id` VARCHAR(255) NOT NULL,
  `step_id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `step_name` VARCHAR(255) NOT NULL,
  `status` ENUM('pending','running','completed','failed','cancelled') NOT NULL,
  `input` JSON,
  `input_cbor` BLOB,
  `output` JSON,
  `output_cbor` BLOB,
  `error` TEXT,
  `attempt` INT NOT NULL,
  `started_at` TIMESTAMP NULL,
  `completed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `retry_after` TIMESTAMP NULL,
  `spec_version` INT,
  INDEX `idx_workflow_steps_run_id` (`run_id`),
  INDEX `idx_workflow_steps_status` (`status`)
) ROW_FORMAT=DYNAMIC;

-- Create hooks table
CREATE TABLE `workflow`.`workflow_hooks` (
  `run_id` VARCHAR(255) NOT NULL,
  `hook_id` VARCHAR(255) NOT NULL PRIMARY KEY,
  `token` VARCHAR(255) NOT NULL,
  `owner_id` VARCHAR(255) NOT NULL,
  `project_id` VARCHAR(255) NOT NULL,
  `environment` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `metadata` JSON,
  `metadata_cbor` BLOB,
  `spec_version` INT,
  `is_webhook` BOOLEAN,
  INDEX `idx_workflow_hooks_run_id` (`run_id`),
  INDEX `idx_workflow_hooks_token` (`token`)
) ROW_FORMAT=DYNAMIC;

-- Create stream chunks table
CREATE TABLE `workflow`.`workflow_stream_chunks` (
  `id` VARCHAR(255) NOT NULL,
  `stream_id` VARCHAR(255) NOT NULL,
  `data` BLOB NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `eof` BOOLEAN NOT NULL,
  `sequence` BIGINT NOT NULL,
  PRIMARY KEY (`stream_id`, `id`),
  INDEX `idx_stream_chunks_sequence` (`stream_id`, `sequence`)
) ROW_FORMAT=DYNAMIC;

-- Create jobs table for the pure MySQL queue
CREATE TABLE `workflow`.`workflow_jobs` (
  `id` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `job_id` VARCHAR(255) NOT NULL UNIQUE,
  `queue_name` VARCHAR(255) NOT NULL,
  `payload` BLOB NOT NULL,
  `status` ENUM('pending','processing','failed') NOT NULL DEFAULT 'pending',
  `attempt` INT NOT NULL DEFAULT 0,
  `max_attempts` INT NOT NULL DEFAULT 3,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `locked_at` TIMESTAMP NULL,
  `locked_by` VARCHAR(255),
  `error` TEXT,
  `scheduled_for` TIMESTAMP NULL,
  INDEX `idx_jobs_queue_status` (`queue_name`, `status`, `id`),
  INDEX `idx_jobs_scheduled` (`scheduled_for`)
) ROW_FORMAT=DYNAMIC;

-- Create job idempotency table for the pure MySQL queue
CREATE TABLE `workflow`.`workflow_job_idempotency` (
  `idempotency_key` VARCHAR(255) NOT NULL PRIMARY KEY,
  `message_id` VARCHAR(255) NOT NULL,
  `queue_name` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_idempotency_created` (`created_at`)
) ROW_FORMAT=DYNAMIC;
