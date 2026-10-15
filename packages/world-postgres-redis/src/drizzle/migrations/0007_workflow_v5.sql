-- Workflow SDK v5 numbers each event by its position in its run's log
-- (`evnt_` + a zero-padded 1-based slot), so an event id is unique only
-- within its run. Re-key the events table on (run_id, id).
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT IF EXISTS "workflow_events_pkey";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow"."workflow_events"
    ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY ("run_id", "id");
EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL;
END $$;
--> statement-breakpoint
-- How many events each run's log holds. events.create advances it in the
-- transaction that appends the event, which is where the next slot comes
-- from. Runs created before this migration start at 0; their ULID-numbered
-- logs cannot be replayed by a v5 runtime anyway (drain them on the v4
-- build first).
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "event_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- v5 serializes a run's or step's thrown value with the workflow
-- serialization pipeline; store it verbatim beside the legacy JSON text.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "error_cbor" bytea;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "error_code" varchar;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "attributes" jsonb;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD COLUMN IF NOT EXISTS "error_cbor" bytea;
