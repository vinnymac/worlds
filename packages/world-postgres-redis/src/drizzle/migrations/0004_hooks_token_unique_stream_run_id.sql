-- Hook tokens must be unique: two concurrent hook_created calls for the same
-- token must not both insert. If this fails on an existing database, duplicate
-- tokens are present and must be resolved manually before upgrading.
DROP INDEX IF EXISTS "workflow"."workflow_hooks_token_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_hooks_token_index" ON "workflow"."workflow_hooks" USING btree ("token");--> statement-breakpoint

-- Owning run for stream chunks, enabling listStreamsByRunId. Nullable because
-- pre-existing rows predate the column.
ALTER TABLE "workflow"."workflow_stream_chunks" ADD COLUMN IF NOT EXISTS "run_id" varchar;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_stream_chunks_run_id_index" ON "workflow"."workflow_stream_chunks" USING btree ("run_id");
