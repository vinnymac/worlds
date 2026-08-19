-- Add outbox table for transactional outbox pattern
-- Ensures atomicity between MySQL event writes and Redis queue pushes
CREATE TABLE IF NOT EXISTS `workflow`.`workflow_outbox` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `message_id` VARCHAR(36) NOT NULL UNIQUE,
  `payload` JSON NOT NULL,
  `created_at` TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `attempts` INT NOT NULL DEFAULT 0,
  `last_error` TEXT,
  INDEX `idx_outbox_created_at` (`created_at`)
) ROW_FORMAT=DYNAMIC;
