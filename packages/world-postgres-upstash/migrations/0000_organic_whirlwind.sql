CREATE SCHEMA "workflow";
--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."status" AS ENUM('pending', 'running', 'completed', 'failed', 'paused', 'cancelled');--> statement-breakpoint
CREATE TABLE "workflow"."workflow_events" (
	"id" varchar PRIMARY KEY NOT NULL,
	"type" varchar NOT NULL,
	"correlation_id" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"run_id" varchar NOT NULL,
	"payload" jsonb,
	"payload_cbor" "bytea"
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_hooks" (
	"run_id" varchar NOT NULL,
	"hook_id" varchar PRIMARY KEY NOT NULL,
	"token" varchar NOT NULL,
	"owner_id" varchar NOT NULL,
	"project_id" varchar NOT NULL,
	"environment" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"metadata_cbor" "bytea"
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_runs" (
	"id" varchar PRIMARY KEY NOT NULL,
	"output" jsonb,
	"output_cbor" "bytea",
	"deployment_id" varchar NOT NULL,
	"status" "status" NOT NULL,
	"name" varchar NOT NULL,
	"execution_context" jsonb,
	"execution_context_cbor" "bytea",
	"input" jsonb,
	"input_cbor" "bytea",
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"started_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_steps" (
	"run_id" varchar NOT NULL,
	"step_id" varchar PRIMARY KEY NOT NULL,
	"step_name" varchar NOT NULL,
	"status" "step_status" NOT NULL,
	"input" jsonb,
	"input_cbor" "bytea",
	"output" jsonb,
	"output_cbor" "bytea",
	"error" text,
	"attempt" integer NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"retry_after" timestamp
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_stream_chunks" (
	"id" varchar NOT NULL,
	"stream_id" varchar NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"eof" boolean NOT NULL,
	CONSTRAINT "workflow_stream_chunks_stream_id_id_pk" PRIMARY KEY("stream_id","id")
);
--> statement-breakpoint
CREATE INDEX "workflow_events_run_id_index" ON "workflow"."workflow_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_events_correlation_id_index" ON "workflow"."workflow_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "workflow_hooks_run_id_index" ON "workflow"."workflow_hooks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_hooks_token_index" ON "workflow"."workflow_hooks" USING btree ("token");--> statement-breakpoint
CREATE INDEX "workflow_runs_name_index" ON "workflow"."workflow_runs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_index" ON "workflow"."workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_steps_run_id_index" ON "workflow"."workflow_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "workflow_steps_status_index" ON "workflow"."workflow_steps" USING btree ("status");