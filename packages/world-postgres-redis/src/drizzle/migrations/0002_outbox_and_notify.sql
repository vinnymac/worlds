-- Outbox table for atomic Postgres + Redis writes
CREATE TABLE IF NOT EXISTS "workflow"."workflow_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL UNIQUE,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outbox_unsent" ON "workflow"."workflow_outbox" USING btree ("created_at");
--> statement-breakpoint

-- LISTEN/NOTIFY trigger for real-time run status updates
CREATE OR REPLACE FUNCTION "workflow".notify_run_update() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(
    'workflow_run_update',
    json_build_object(
      'runId', NEW.id,
      'status', NEW.status,
      'updatedAt', NEW.updated_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS runs_notify_update ON "workflow"."workflow_runs";
--> statement-breakpoint
CREATE TRIGGER runs_notify_update
AFTER INSERT OR UPDATE ON "workflow"."workflow_runs"
FOR EACH ROW EXECUTE FUNCTION "workflow".notify_run_update();
