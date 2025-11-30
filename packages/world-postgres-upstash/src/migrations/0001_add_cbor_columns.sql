ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "input_cbor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ALTER COLUMN "input_cbor" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD COLUMN "payload_cbor" "bytea";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN "metadata_cbor" "bytea";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "output_cbor" "bytea";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "execution_context_cbor" "bytea";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "input_cbor" "bytea";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD COLUMN "input_cbor" "bytea";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD COLUMN "output_cbor" "bytea";
