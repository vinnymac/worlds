---
'@fantasticfour/world-postgres-redis': minor
---

Align with `@workflow/world` 4.2.1 and fix durable-queue reliability across
dedup, redelivery, reclaim, and migration tracking.

Specversion is now declared with a binary-safe queue transport, and the
resilient-start path (core 4.6.0 fires `run_created` and the queue publish in
parallel) is fully supported. The typed error taxonomy matches what
`@workflow/core` expects: `EntityConflictError`, `RunExpiredError`,
`TooEarlyError`, `WorkflowRunNotFoundError`, and `HookNotFoundError` are all
thrown where the contract requires them, so core's replay tolerance and
recoverable-condition handling work correctly instead of collapsing into
retry-drop loops. `hook_created` now follows 4.2.1 conflict semantics: a run's
own replay is allowed through, a crash orphan completes the partial write, and
a foreign holder gets a `hook_conflict` event carrying `conflictingRunId`.
`hooks.token` gains a UNIQUE constraint with the insert-race loser routed
through that same path.

The queue's durability story is rewritten end-to-end. Dedup keys are held for
the full message lifetime (not released on first delivery), so a re-queued
message cannot race its own idempotency key. Delayed redelivery (honoring
`{ timeoutSeconds }` from the handler) goes through a Redis sorted set with an
atomic Lua promotion loop instead of an in-process `setTimeout`, so delayed
messages survive worker restarts. Crashed workers' in-flight messages are
reclaimed via visibility deadlines, and messages that exhaust all attempts write
`run_failed` against the owning run rather than dropping silently.

Migration tracking is now durable: a `workflow.__migrations` table records
every applied file inside the same transaction, early migrations are made
idempotent so pre-tracking databases upgrade cleanly, and the orphaned
`0000_redundant_smasher.sql` file is deleted. The `cli.ts` runner applies and
records each file transactionally so a partial upgrade leaves the tracking table
consistent.
