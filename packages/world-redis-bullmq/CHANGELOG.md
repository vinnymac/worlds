# @fantasticfour/world-redis-bullmq

## 2.4.0

### Minor Changes

- b29bc83: Add full support for workflow 4.8.3 across every world, along with fixes for duplicate creation events, concurrent replay, fat payload encoding, Azure batch verification, and Firestore error codes.
  
  `createStreamer` now returns `CloudflareStreamer`, which declares that `writeToStream` and `closeStream` accept an unresolved `Promise<string>` run id. Every world already implemented that contract; only the return type hid it.

## 2.3.0

### Minor Changes

- ee02f27: Align with `@workflow/world` 4.2.1 and fix the BullMQ-specific reliability
  issues.

  `specVersion` is now declared with a binary-safe queue payload and a
  transactional `run_started` bootstrap, so the resilient-start path in core
  4.6.0 (parallel `run_created` + queue publish) works correctly. The typed error
  taxonomy (`EntityConflictError`, `RunExpiredError`, `TooEarlyError`,
  `WorkflowRunNotFoundError`, `HookNotFoundError`) replaces the generic
  `WorkflowWorldError` throws, matching the names core's static `.is()` checks
  expect. `hook_created` now follows the 4.2.1 conflict semantics: same-entity
  duplicate raises `EntityConflictError`, a crash orphan completes the partial
  write, a foreign holder emits `hook_conflict` with `conflictingRunId`, and
  `hook_disposed` releases the token.

  On the BullMQ side: `queue()` no longer swallows `add()` failures, dedup keys
  are released on job finalization instead of expiring after 60 s (which could
  free a live key mid-flight), and 503 deferral uses `moveToDelayed` plus
  `DelayedError` rather than acking and relying on an in-process timer. The full
  Redis connection options (including `tls` and `username`) now reach BullMQ.
  Six Lua scripts make every entity, index, and event write group atomic, and
  stream-entry IDs are now compared numerically. `close()` is implemented.

- b2931d6: Implement the full `Streamer` contract for the Redis Streams backends.

  `getStreamChunks`, `getStreamInfo`, and `listStreamsByRunId` were previously
  missing and hidden behind an `as any` cast, so paginated chunk reads, stream
  metadata lookups, and per-run stream enumeration silently returned nothing.
  They are now implemented against Redis Streams (`XRANGE`/`XREVRANGE`/`XLEN`)
  with a per-run stream index (`<prefix>streams:by_run:<runId>`), and the unsafe
  cast is gone so the world type-checks against the real interface.

## 2.2.0

### Minor Changes

- c4b795f: Slim down world packages by switching to an HTTP-callback architecture (matching our own
  `@fantasticfour/world-upstash`).

  **Dependency drops (runtime):**

  - `@workflow/world-local` removed from every world package.
  - `@vercel/queue` removed from `world-redis`, `world-redis-bullmq`,
    `world-postgres-redis`, `world-mysql-redis`, `world-nats-jetstream`.
  - `zod` removed from `world-redis`, `world-redis-bullmq`,
    `world-postgres-redis`, `world-mysql`, `world-mysql-redis`,
    `world-nats-jetstream` (replaced with hand-rolled validation for the two
    trivial schemas that used it; dead `Base64Buffer` codec deleted from
    `world-redis`).

  **Architectural change:**

  Workers no longer execute workflows in-process via `@workflow/world-local`.
  Instead, each world dispatches jobs over HTTP to the user's app server at
  `${baseUrl}/.well-known/workflow/v1/{flow|step}`, the same convention used by
  the Workflow DevKit. Three header fields carry the envelope:

  - `x-vqs-queue-name`
  - `x-vqs-message-id`
  - `x-vqs-message-attempt`

  A 503 response with `{ "timeoutSeconds": number }` is treated as a soft retry
  (does not consume an attempt). Other non-2xx responses trigger exponential
  backoff up to `maxAttempts`.

  For the cloud-managed worlds (`world-azure`, `world-cloudflare`,
  `world-firestore-tasks`), production paths are unchanged (Service Bus,
  Cloudflare Queues, Cloud Tasks with their native delivery wire formats). In
  test mode, each now ships a small in-process test pump that HTTP-dispatches
  back to the user's server using the same `x-vqs-*` headers as the other
  worlds, so test behaviour is consistent across the whole repo.

  **Breaking change for `start()` consumers:**

  If you call `world.start()` and previously relied on the embedded
  `@workflow/world-local` to execute workflows in-process, you now need a
  reachable HTTP server hosting `world.createQueueHandler(...)` at the standard
  routes. The `@workflow/world-testing` harness already does this, and any app
  following the Workflow DevKit convention is already compatible.

  New config knobs on each world (all optional):

  - `baseUrl`: overrides `process.env.WORKFLOW_BASE_URL` /
    `http://localhost:${process.env.PORT ?? 3000}`
  - `httpTimeoutMs`: per-job request timeout (default 300_000)
  - `maxAttempts` / `backoffDelayMs` / `backoffType` where applicable

  **Why:**

  Most packages were shipping 8-11 runtime deps. Dropping the three deps above
  trims every world to a leaner footprint. Build outputs are smaller, install
  trees lighter, and the in-repo `world-upstash` precedent (already on this
  architecture) made the target shape obvious.

## 2.1.2

### Patch Changes

- 66826e7: Bump tsdown to ^0.22.0 so the bundler resolves rolldown@1.0.0 (stable v1)
  instead of the prior 1.0.0-rc.17. tsdown 0.22 drops Node < 22.18 support,
  makes `unrun` optional, and adds a `tsx` config loader; CI already runs
  Node 24, which uses the native TS config loader and needs neither.
  No consumer-facing API change.

## 2.1.1

### Patch Changes

- 59da2b7: Port `events.create` bug fixes and improvements from `@workflow/world-postgres@4.1.1` to all world storage implementations:

  - **run_started idempotency**: When run is already `running`, return existing run without appending a duplicate event
  - **Resilient start**: When `run_started` arrives for a non-existent run with eventData, bootstrap the run + synthetic `run_created` event atomically (recovery from partial start failures)
  - **RunExpiredError**: Throw `RunExpiredError` (not generic error) for `run_started` on terminal runs so the runtime exits without retrying; use `EntityConflictError` for other terminal state transitions
  - **Strip run_started eventData**: `run_started` events no longer store eventData (belongs on `run_created` only)
  - **Step cancelled terminal state**: Add `'cancelled'` to step terminal state checks
  - **Preloaded events (TTFB)**: `run_started` response now includes all events for the run, allowing the runtime to skip the initial `events.list` call

## 2.1.0

### Minor Changes

- e2d3f2e: Reliability and observability enhancements across all world packages, plus event-idempotency bug fixes and a new shared utilities package.

  ## New Package

  - `@fantasticfour/shared`: common utilities extracted from world packages: debug logging (`createDebugLogger`), JSON serialization helpers (`stringify`, `parse`, `dateReviver`, `uint8ArrayReplacer`/`uint8ArrayReviver`, `deepClone`), correlation context (`withCorrelation`, `getCorrelationId`, `createCorrelatedLogger`), health-check primitives (`HealthCheckResult`, `ComponentHealth`, `HealthCheckable`, `timeOperation`), `Cborized` type, and small utilities (`compact`, `Mutex`, `Rc`).

  ## Critical Bug Fixes: Event Idempotency

  Event-sourced systems must be idempotent. Replaying creation events (for recovery, debugging, or state reconstruction) was causing entities to disappear from list queries because the "Always-Add Pattern" implementation skipped index updates and returned `undefined` on duplicates.

  Fixed in:

  - `world-redis-bullmq`, `world-upstash`, `world-redis`: SETNX-based handlers for `run_created`, `step_created`, `hook_created` now always update indexes (ZADD is idempotent) and return the existing entity on replay.
  - `world-postgres-redis`: Drizzle `.onConflictDoNothing()` paths now fetch and return the existing row instead of `undefined`.
  - `world-nats-jetstream`: KV-bucket creation handlers now read back the existing entity when the key already exists rather than returning `undefined`.

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

### Patch Changes

- d9dc22d: Migrate bundler from `tsup` to `tsdown` (Rolldown-based) across all world packages. Build is significantly faster and configs are simpler. Public `exports` map and emitted file extensions (`.js`, `.d.ts`) are unchanged. `dotenv` continues to be externalized in CLI bundles. Code-splitting is enabled (Rolldown default), so multi-entry packages now emit shared `chunk-*.js` files alongside existing entry artifacts.

## 2.0.2

### Patch Changes

- 2a1587e: Upgrade @workflow packages to stable 4.1.x

  Production dependencies upgraded from beta to stable 4.1.1:

  - @workflow/errors: 4.1.0-beta.20 -> 4.1.1
  - @workflow/world: 4.1.0-beta.17 -> 4.1.1
  - @workflow/world-local: 4.1.0-beta.51 -> 4.1.1

  Dev dependency kept on compatible beta version:

  - @workflow/world-testing: 4.1.0-beta.53 (stable has breaking test changes)

  All validation passes: lint, typecheck, and full test suite.

## 2.0.1

### Patch Changes

- fecc1da: docs: rename world-mysql-upstash to world-upstash and fix Docker images

  **Documentation updates:**

  - Renamed `@fantasticfour/world-mysql-upstash` to `@fantasticfour/world-upstash` across all package documentation
  - Updated cross-references in README files and migration guides

  **CI/Test fixes:**

  - Replaced deprecated AWS ECR public mirror images (`public.ecr.aws/docker/library/*`) with official Docker Hub images
  - Fixed HTTP 404 errors in GitHub Actions workflows and testcontainers
  - Updated to use: `postgres:15-alpine`, `redis:7-alpine`, `mysql:8.0`, `nats:2.10-alpine`

## 2.0.0

### Major Changes

- bc84d8f: Migrate to @workflow 4.1.0-beta with event-sourced architecture

  This is a major update that migrates all 6 world implementations from @workflow 4.0.1-beta to 4.1.0-beta, implementing the new event-sourced architecture and API changes.

  ## Breaking Changes

  ### Event-Sourced Architecture

  All entity mutations now flow through `events.create()` instead of direct entity methods:

  - Removed: `runs.create()`, `runs.update()`, `runs.cancel()`, `runs.pause()`, `runs.resume()`
  - Removed: `steps.create()`, `steps.update()`
  - Removed: `hooks.create()`, `hooks.dispose()`
  - Updated: `events.create()` now accepts `runId: string | null` and returns `EventResult` containing the event plus affected entities

  ### API Signature Changes

  - `Events.create()` return type changed from `Event` to `EventResult`
  - `runs.get()` and `runs.list()` now support `resolveData` parameter ('all' | 'none')
  - `steps.get()` and `steps.list()` now support `resolveData` parameter ('all' | 'none')

  ### New Types

  - `EventResult` - contains event + affected run/step/hook/wait entities
  - `WorkflowRunWithoutData` / `StepWithoutData` - for `resolveData: 'none'`
  - `RunCreatedEventRequest` - for creating runs via events

  ### Dependency Updates

  - @workflow/errors: 4.0.1-beta.5 -> 4.1.0-beta.20
  - @workflow/world: 4.0.1-beta.6 -> 4.1.0-beta.17
  - @workflow/world-local: 4.0.1-beta.11 -> 4.1.0-beta.51
  - @workflow/world-testing: 4.0.1-beta.20 -> 4.1.0-beta.53
  - zod: 4.1.11 -> 4.3.6
  - ulid: 3.0.1 -> 3.0.2
  - ioredis: 5.8.2 -> 5.10.1
  - drizzle-orm: 0.44.7 -> 0.45.2
  - postgres: 3.4.7 -> 3.4.9
  - testcontainers: 11.8.1 -> 11.14.0

  ### Schema Changes (PostgreSQL packages)

  New columns added to support 4.1.0-beta:

  - `runs`: specVersion, expiredAt
  - `events`: specVersion
  - `steps`: specVersion
  - `hooks`: specVersion, isWebhook

  **Note**: Database migrations required for PostgreSQL packages. Run `pnpm --filter @fantasticfour/world-postgres-* run setup` to apply schema changes.

  ### Streamer Interface

  Added new required methods:

  - `listStreamsByRunId(runId: string): Promise<string[]>`
  - `getStreamChunks(name: string, runId: string, options?: GetChunksOptions): Promise<StreamChunksResponse>`
  - `getStreamInfo(name: string, runId: string): Promise<StreamInfoResponse>`

  ## Migration Guide

  ### Creating a Run

  ```typescript
  // Before (4.0.1-beta)
  const run = await world.runs.create({
    deploymentId,
    workflowName,
    input: [serializedInput],
  });

  // After (4.1.0-beta)
  const { run, event } = await world.events.create(null, {
    eventType: "run_created",
    eventData: { deploymentId, workflowName, input: serializedInput },
  });
  ```

  ### Updating a Run

  ```typescript
  // Before (4.0.1-beta)
  const run = await world.runs.update(runId, {
    status: "completed",
    output: serializedOutput,
  });

  // After (4.1.0-beta)
  const { run, event } = await world.events.create(runId, {
    eventType: "run_completed",
    eventData: { output: serializedOutput },
  });
  ```

  ### Creating a Hook

  ```typescript
  // Before (4.0.1-beta)
  const hook = await world.hooks.create(runId, {
    hookId,
    token,
    metadata,
  });

  // After (4.1.0-beta)
  const { hook, event } = await world.events.create(runId, {
    eventType: "hook_created",
    correlationId: hookId,
    eventData: { token, metadata },
  });
  ```

  ## Test Status

  - world-redis: 21/21 storage tests passing
  - world-redis-bullmq: 21/21 storage tests passing
  - world-postgres-redis: TypeScript compiles, requires database migration
  - world-firestore-tasks: 33/33 storage tests passing
  - world-cloudflare: 59/59 storage tests passing

### Patch Changes

- 6a85f71: Fix test failures by using exact versions in pnpm catalog

  All tests were failing due to version range misconfigurations in pnpm-workspace.yaml. The caret ranges (^4.0.1-beta.6) allowed pnpm to install incompatible 4.1.x versions of @workflow packages when the storage implementations were written for the 4.0.x API.

  Changes:

  - Changed @workflow package versions from caret ranges to exact versions in pnpm catalog
  - Added pnpm override to force zod@4.1.11 (required by @workflow/world@4.0.1-beta.6)
  - Updated CI workflow to remove non-existent @fantasticfour/world-dynamodb-sqs package

  All 293 tests now passing across 6 packages.

## 1.0.3

### Patch Changes

- d44be4d: Sync with upstream changes from world-postgres such as cbor-x

## 1.0.2

### Patch Changes

- c2b739f: Clean up package dependencies

  - Remove unused `@vercel/queue` dependency from world-cloudflare, world-firestore-tasks, and world-postgres-upstash
  - Move `dotenv` to devDependencies in world-postgres-redis, world-postgres-upstash, world-redis, and world-redis-bullmq (only used in CLI setup tools, not runtime)

  This reduces bundle sizes for consumers.

## 1.0.1

### Patch Changes

- 3899935: Initial release
