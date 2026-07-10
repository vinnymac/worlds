-- Add 'cancelled' to workflow_steps.status to match StepStatusSchema
-- (it was already present on workflow_runs.status and in the Drizzle schema).
ALTER TABLE `workflow`.`workflow_steps` MODIFY COLUMN `status` ENUM('pending','running','completed','failed','cancelled') NOT NULL;
