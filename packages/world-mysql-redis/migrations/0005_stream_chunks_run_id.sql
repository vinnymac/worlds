-- Associate stream chunks with their owning run so listStreamsByRunId can be
-- implemented. Nullable: rows written before this column existed have no owner.
ALTER TABLE `workflow`.`workflow_stream_chunks` ADD COLUMN `run_id` VARCHAR(255) NULL AFTER `stream_id`;
ALTER TABLE `workflow`.`workflow_stream_chunks` ADD INDEX `idx_stream_chunks_run_id` (`run_id`);
