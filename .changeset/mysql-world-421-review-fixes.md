---
'@fantasticfour/world-mysql': minor
---

Align `world-mysql` with `@workflow/world` 4.2.1 and fix the reliability bugs
surfaced by a full correctness review.

Every entity-and-event write pair now commits inside a single drizzle
transaction with `notInArray`-guarded UPDATEs, closing the resurrection race
where a replay could overwrite a terminal state. `hook_created` gains the
4.2.1 conflict semantics: a same-entity duplicate from the owning run is a
no-op, a crash orphan is healed in place, and a foreign holder emits a
`hook_conflict` event carrying `conflictingRunId`. Error classes are now the
typed names that `@workflow/core` matches via static `.is()` (such as
`EntityConflictError` and `RunExpiredError`) instead of the generic
`WorkflowWorldError`, so core's replay tolerance and recoverable-condition
handling work correctly. The world also declares `specVersion: SPEC_VERSION_CURRENT`
and handles the resilient-start path introduced in core 4.6.0.

The polling queue reclaims stale `processing` locks via `visibilityTimeoutMs`
so crashes no longer strand runs indefinitely. The idempotency key is stored
on the job row rather than as a separate record, so release and TTL cleanup
cannot free a key that still belongs to a live job. The streamer now orders by
ULID `chunkId` (eliminating same-millisecond chunk collisions) and implements
the full contract surface including `getStreamChunks`, `getStreamInfo`, and
`listStreamsByRunId`. Payload columns are widened to `MEDIUMBLOB` and
timestamps gain millisecond precision via `TIMESTAMP(3)`.

Migrations `0000` through `0002` must be applied. The CLI migration runner is
one-shot (no tracking table), so fresh databases pick them up automatically.
Existing databases must apply any new migrations manually.
