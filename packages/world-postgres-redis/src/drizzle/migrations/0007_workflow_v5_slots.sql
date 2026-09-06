-- Workflow v5: slot-numbered event ids and the surrounding schema.
CREATE TYPE "public"."wait_status" AS ENUM('completed', 'waiting');--> statement-breakpoint

-- Event ids are per-run slot positions, unique only with their run. The
-- composite key leads with run_id, so the standalone run_id index becomes
-- redundant write overhead on the hottest table.
ALTER TABLE "workflow"."workflow_events" DROP CONSTRAINT IF EXISTS "workflow_events_pkey";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD CONSTRAINT "workflow_events_run_id_id_pk" PRIMARY KEY ("run_id", "id");--> statement-breakpoint
DROP INDEX IF EXISTS "workflow"."workflow_events_run_id_index";--> statement-breakpoint

-- attr_set joins the one-shot correlated event types.
DROP INDEX IF EXISTS "workflow"."workflow_events_entity_creation_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_events_entity_creation_unique"
	ON "workflow"."workflow_events" ("run_id", "correlation_id", "type")
	WHERE "type" IN ('step_created', 'hook_created', 'wait_created', 'attr_set');--> statement-breakpoint

-- Marker table: a row exists iff the run is slot-numbered. Its absence is
-- the "this run predates slots, keep minting ULIDs" signal.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_event_slots" (
	"run_id" varchar PRIMARY KEY NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workflow"."workflow_waits" (
	"wait_id" varchar PRIMARY KEY NOT NULL,
	"run_id" varchar NOT NULL,
	"status" "public"."wait_status" NOT NULL,
	"resume_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"spec_version" integer
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_waits_run_id_index" ON "workflow"."workflow_waits" USING btree ("run_id");--> statement-breakpoint

-- v5 run surface: serialized error, error code, attributes, encryption key.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "error_cbor" bytea;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "error_code" varchar;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "encryption_public_key" varchar;--> statement-breakpoint

-- The stateUpdatedAt 412 guard is gone; bump-and-report replaced it.
ALTER TABLE "workflow"."workflow_runs" DROP COLUMN IF EXISTS "state_updated_at";--> statement-breakpoint

ALTER TABLE "workflow"."workflow_steps" ADD COLUMN IF NOT EXISTS "error_cbor" bytea;--> statement-breakpoint

ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "token_retention_until" timestamptz;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "is_system" boolean DEFAULT false;
