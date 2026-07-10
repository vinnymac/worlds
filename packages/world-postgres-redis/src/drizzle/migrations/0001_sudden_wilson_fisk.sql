ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."status";--> statement-breakpoint
CREATE TYPE "public"."status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "status" SET DATA TYPE "public"."status" USING "status"::"public"."status";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD COLUMN IF NOT EXISTS "spec_version" integer;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "spec_version" integer;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "is_webhook" boolean;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "spec_version" integer;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "expired_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD COLUMN IF NOT EXISTS "spec_version" integer;
