---
'@fantasticfour/world-mysql-redis': minor
---

Rewrite the Redis delay queue for durability and align the package with the
@workflow/world 4.2.1 contract.

The queue is rebuilt around a delayed sorted set with atomic Lua promotion,
per-message leases with orphan reclaim, and a dead-letter queue that releases
the idempotency key on exhaustion so core's replay self-heals the run. The
inert transactional outbox is removed: storage and queue are invoked
independently by the contract so no shared transaction ever existed for a true
outbox, and the durable queue now provides the actual guarantee. Migrations
0002-0005 ship with this release, covering `events.occurred_at`, the outbox
table drop, `cancelled` in the `steps.status` enum, and a per-run index on
`stream_chunks`.

`specVersion` is transported with a binary-safe encoding so it survives round
trips through MySQL string columns. The typed error taxonomy now matches the
names `@workflow/core` checks by name, `hook_created` conflict semantics match
upstream (race loser routes through the conflict path rather than throwing), and
dense per-stream sequences use `FOR UPDATE` to eliminate phantom gaps. A
pre-allocation bug that caused the synthetic `run_created` event to sort after
`run_started` is fixed by porting upstream's lazy `eventId` allocation.

Note: the CLI migration runner is one-shot and has no tracking table, so
existing databases must apply migrations 0002-0005 manually. See `cli.ts` for
the documented procedure.
