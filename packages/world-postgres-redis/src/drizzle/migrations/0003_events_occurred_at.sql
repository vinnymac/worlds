-- Client-side occurrence timestamp for events, distinct from created_at
-- (when the world stored the event).
ALTER TABLE "workflow"."workflow_events" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp;
