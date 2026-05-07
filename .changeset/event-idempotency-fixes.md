---
"@fantasticfour/world-azure": minor
"@fantasticfour/world-cloudflare": minor
"@fantasticfour/world-firestore-tasks": minor
"@fantasticfour/world-mysql": minor
"@fantasticfour/world-mysql-redis": minor
"@fantasticfour/world-nats-jetstream": minor
"@fantasticfour/world-postgres-redis": minor
"@fantasticfour/world-redis": minor
"@fantasticfour/world-redis-bullmq": minor
"@fantasticfour/world-upstash": minor
---

Reliability and observability enhancements across all world packages, plus event-idempotency bug fixes and a new shared utilities package.

## New Package

- `@fantasticfour/shared` — common utilities extracted from world packages: debug logging (`createDebugLogger`), JSON serialization helpers (`stringify`, `parse`, `dateReviver`, `uint8ArrayReplacer`/`uint8ArrayReviver`, `deepClone`), correlation context (`withCorrelation`, `getCorrelationId`, `createCorrelatedLogger`), health-check primitives (`HealthCheckResult`, `ComponentHealth`, `HealthCheckable`, `timeOperation`), `Cborized` type, and small utilities (`compact`, `Mutex`, `Rc`).

## Critical Bug Fixes — Event Idempotency

Event-sourced systems must be idempotent. Replaying creation events (for recovery, debugging, or state reconstruction) was causing entities to disappear from list queries because the "Always-Add Pattern" implementation skipped index updates and returned `undefined` on duplicates.

Fixed in:

- `world-redis-bullmq`, `world-upstash`, `world-redis` — SETNX-based handlers for `run_created`, `step_created`, `hook_created` now always update indexes (ZADD is idempotent) and return the existing entity on replay.
- `world-postgres-redis` — Drizzle `.onConflictDoNothing()` paths now fetch and return the existing row instead of `undefined`.
- `world-nats-jetstream` — KV-bucket creation handlers now read back the existing entity when the key already exists rather than returning `undefined`.

Naming: `existed` renamed to `wasCreated` for clarity.

## Reliability & Observability

### `world-azure`
- Cosmos DB transactional batches for multi-document writes
- RU/s throttling retry with backoff
- Service Bus session support

### `world-cloudflare`
- Durable Object storage transactions
- Permanent vs. transient error handling in queue consumers
- Schema migration framework for DO storage

### `world-firestore-tasks`
- Batched writes for atomic multi-document mutations
- Cloud Tasks idempotency keys
- Idempotent consumer pattern
- Composite indexes (`firestore.indexes.json`)
- Polling-mode streamer

### `world-mysql`
- TTL-based cleanup of idempotency rows
- Queue processing metrics (`src/metrics.ts`)

### `world-mysql-redis`
- Outbox pattern (`src/outbox.ts`, `migrations/0001_outbox.sql`)
- Deadlock retry logic
- Cross-backend health check

### `world-nats-jetstream`
- Secondary indexes for query patterns
- Configurable JetStream dedup window
- Worker health checks + exponential backoff
- Bucket TTL/compaction configuration

### `world-postgres-redis`
- Outbox pattern (`src/outbox.ts`)
- LISTEN/NOTIFY pub/sub (`src/notify.ts`, migration `0002_outbox_and_notify.sql`)
- Cross-backend health check (`src/health.ts`)
- Setup CLI improvements
- Unified idempotency handling

### `world-redis`
- Atomic Lua scripts for multi-key writes
- Queue/stream metrics
- Streams-based event log

### `world-redis-bullmq`
- Stalled-job recovery
- Configurable retry/backoff
- Queue metrics
- Delayed-job support

### `world-upstash`
- QStash signature verification
- Request deduplication
- Request-budget monitoring
- Streaming via polling

## Test Coverage

All 10 world packages now have idempotency test coverage. New test files added for `world-mysql`, `world-mysql-redis`, `world-azure`, `world-nats-jetstream`, and `world-upstash`. Existing suites in `world-redis-bullmq`, `world-redis`, `world-postgres-redis`, `world-cloudflare`, and `world-firestore-tasks` were expanded with idempotency cases. Tests verify:

1. Creating an entity twice returns the existing entity (not `undefined`/error)
2. Duplicate events do not create duplicate entries
3. Entities always appear in list/index queries after duplicate events

Test files were also DRYed up (helper simplification, direct `beforeEach` references, inlined schema setup) and storage API call signatures corrected (`.get(id)` rather than `.get({ id })`).

## Build

`tsup.config.ts` added to all world packages for consistent bundling.

## Migration

No breaking API changes. The new `@fantasticfour/shared` package is a workspace dependency consumed internally by the world packages. Outbox/NOTIFY migrations are additive (`0001_outbox.sql`, `0002_outbox_and_notify.sql`) and should be applied via the package's existing migration tooling.
