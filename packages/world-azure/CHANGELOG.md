# @fantasticfour/world-azure

## 1.5.2

### Patch Changes

- b5ebeeb: Honour `pagination.cursor` in `events.listByCorrelationId`.
  
  The query never added a cursor predicate, so the parameter was accepted and
  silently ignored and every page returned the first one. A caller paginating a
  correlation lookup looped forever on duplicate events instead of advancing.
  `events.list` directly above it already pushed `c.eventId > @cursor`; this now
  uses the identical predicate and sort-order handling.
  
  Pre-existing, not introduced by the `runId` scoping in the same release. Found
  because the new run-scoping pagination test exercised a second page for the
  first time.
- e61c6c1: Use the official `stripEventDataRefs` instead of dropping `eventData` wholesale.
  
  Every world carried its own `filterEventData`, which deleted the entire
  `eventData` key when `resolveData` was `'none'`. The official worlds do not do
  that. `@workflow/world-local`, `@workflow/world-postgres` and
  `@workflow/world-vercel` all use `stripEventDataRefs`, exported from
  `@workflow/world`, and none of them contains a wholesale delete.
  
  The difference is the display metadata. `stripEventDataRefs` removes only the
  large ref field for the event type (`input` for `step_created`, `result` for
  `step_completed`, `payload` for `hook_received`, and so on) and keeps the rest,
  so a `step_created` read with `'none'` returns `eventData: { stepName }` rather
  than nothing at all. Our worlds were discarding exactly the fields the
  `@workflow/web` dashboard needs to label a row, which is what `'none'` is meant
  to preserve while dropping the payload. Event types with no ref fields, such as
  `step_started` and `wait_created`, are now returned untouched instead of losing
  their `eventData`.
  
  `stripEventDataRefs` has been exported since world 4.4.0, so this was a
  divergence from an available helper rather than a gap being filled. Each world
  drops its local copy along with the `as Event` cast it required.
  
  world-azure additionally had no event filtering at all: `resolveData` was
  honoured for runs, steps and hooks but ignored for every event reader and for
  the `events.create` return path, including the `run_started` preload that
  returns the run's entire event log. All of those now filter.
  
  Tests were added or rewritten per world to pin the upstream contract. They
  assert against event types that actually carry ref fields, since a type absent
  from the ref map makes `'none'` a no-op and would pass vacuously; several of the
  previous assertions had that flaw.
- 132c596: Track workflow 4.8.5, and scope correlation-id event lookups to a run.
  
  Move the catalog to @workflow/core 4.8.5, @workflow/world 4.5.0, and
  @workflow/world-testing 4.1.20. @workflow/errors 4.2.1 and @workflow/utils 4.1.4
  are unchanged; 4.8.5 still pins both.
  
  Verified against the tarballs rather than the version numbers. world 4.5.0
  changes exactly two source files: `events.ts` adds an optional `runId` to
  `ListEventsByCorrelationIdParams`, and `recovery.ts` gives `reenqueueActiveRuns`
  an optional `namespace` that defaults to `resolveQueueNamespace()`. The
  recovery change needs nothing from us: no world passes a namespace, and the
  default resolves the same `__wkf_workflow_` prefix the callers hardcoded
  before, so world-mysql and world-postgres-redis keep their existing behaviour
  and pick up `WORKFLOW_QUEUE_NAMESPACE` support for free. world-testing 4.1.20
  ships a byte-identical conformance suite (only its bundled test app was rebuilt
  against the new core) and still publishes no `exports` map, so the `eventLimit`
  deep import stays as it is. Comments naming the pinned world-testing version
  move to 4.1.20.
  
  `events.listByCorrelationId` now honours `runId`. A correlation id is unique
  within its run, not across runs, so a global correlation index can return
  same-id events belonging to sibling runs. Core 4.8.5 sends `runId`, and each
  world now scopes on it, matching world-local and world-postgres: the predicate
  is applied before the `limit` slice everywhere, so `hasMore` and the returned
  cursor describe the scoped set rather than the unfiltered one. Omitting `runId`
  keeps the previous unscoped behaviour, so older cores are unaffected.
  
  How each world scopes depends on its engine. world-mysql, world-mysql-redis and
  world-postgres-redis push a `run_id` equality into the existing drizzle `WHERE`
  clause. world-azure adds a `c.runId` condition and sets the Cosmos partition key
  to the run, turning a cross-partition fan-out into a single-partition read.
  world-firestore-tasks adds a server-side `where('runId', '==', ...)` ahead of
  its `orderBy`, which requires two new composite indexes (both sort directions);
  they are declared in `firestore.indexes.json` and deployers must apply them with
  `firebase deploy --only firestore:indexes`. world-nats-jetstream routes the
  scoped case through its existing `events_by_run` KV index, making it
  O(events in run) instead of a full-bucket scan. world-redis, world-redis-bullmq
  and world-upstash page their correlation index and filter, accumulating until
  `limit + 1` matches are found so pagination stays exact; the unscoped path still
  costs a single round trip.
  
  world-cloudflare is unchanged: its `listByCorrelationId` is a stub that returns
  an empty page, so there is nothing to scope. Its stale comment now records why
  it is unimplemented and that returning empty is a silent fallback.

## 1.5.1

### Patch Changes

- 27a84a5: Track workflow 4.8.4 (`@workflow/world` 4.4.0, `@workflow/world-testing` 4.1.19).
  
  The 4.4.0 contract is additive only: it adds a `WORKFLOW_NODE_HTTP` flag that
  swaps the HTTP client used by the Vercel and Local worlds, plus the
  `env-config` helpers (`envFlag`, `envNumber`, `getMaxEventsPerRun`) that back
  it. Neither the `World` interface nor the event schemas changed, so no world
  in this repo needed a code change. Every world's published
  `@workflow/world` peer range moves to 4.4.0 to match.

## 1.5.0

### Minor Changes

- b29bc83: Add full support for workflow 4.8.3 across every world, along with fixes for duplicate creation events, concurrent replay, fat payload encoding, Azure batch verification, and Firestore error codes.
  
  `createStreamer` now returns `CloudflareStreamer`, which declares that `writeToStream` and `closeStream` accept an unresolved `Promise<string>` run id. Every world already implemented that contract; only the return type hid it.

## 1.4.1

### Patch Changes

- 617b1c7: Add `files` field to restrict npm publish to `dist/` only. Saving 141-215 KB per package.

## 1.4.0

### Minor Changes

- ee02f27: Aligns `world-azure` with `@workflow/world` 4.2.1 and closes four confirmed
  correctness bugs.

  Event and entity writes now commit in a single same-partition transactional
  batch guarded by `_etag`, closing the resurrection race where a crashed writer
  could leave orphaned terminal events. The Cosmos SDK wraps batch failures in a
  plain `Error`, discarding the inner 409/429 status; that wrapper is now unwrapped
  so conflict and throttle handling actually runs.

  Service Bus honors `timeoutSeconds` and `delaySeconds` via
  `scheduledEnqueueTimeUtc` on redelivered messages, replacing the previous
  in-process `setTimeout` that lost all pending retries on restart. `start()` now
  provisions the queue with duplicate detection enabled and throws loudly if an
  existing queue was created without it. The streamer is rewritten on ULID
  `chunkId` ordering and exposes the full contract surface
  (`getStreamChunks`, `getStreamInfo`, `listStreamsByRunId`).

  `specVersion` is declared with a binary-safe queue transport and a transactional
  `run_started` bootstrap so the resilient-start path in core 4.6.0 works
  correctly. The typed error taxonomy (`EntityConflictError`, `RunExpiredError`,
  `TooEarlyError`, `WorkflowRunNotFoundError`) replaces generic
  `WorkflowWorldError` throws so core's static `.is()` checks match by name.
  `hook_created` follows the 4.2.1 conflict semantics: same-entity duplicates
  throw `EntityConflictError`, crash orphans are completed, and foreign holders
  emit a `hook_conflict` event with `conflictingRunId`. Wait entities and
  `World.close()` are added.

## 1.3.0

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

## 1.2.2

### Patch Changes

- 66826e7: Bump tsdown to ^0.22.0 so the bundler resolves rolldown@1.0.0 (stable v1)
  instead of the prior 1.0.0-rc.17. tsdown 0.22 drops Node < 22.18 support,
  makes `unrun` optional, and adds a `tsx` config loader; CI already runs
  Node 24, which uses the native TS config loader and needs neither.
  No consumer-facing API change.

## 1.2.1

### Patch Changes

- 59da2b7: Port `events.create` bug fixes and improvements from `@workflow/world-postgres@4.1.1` to all world storage implementations:

  - **run_started idempotency**: When run is already `running`, return existing run without appending a duplicate event
  - **Resilient start**: When `run_started` arrives for a non-existent run with eventData, bootstrap the run + synthetic `run_created` event atomically (recovery from partial start failures)
  - **RunExpiredError**: Throw `RunExpiredError` (not generic error) for `run_started` on terminal runs so the runtime exits without retrying; use `EntityConflictError` for other terminal state transitions
  - **Strip run_started eventData**: `run_started` events no longer store eventData (belongs on `run_created` only)
  - **Step cancelled terminal state**: Add `'cancelled'` to step terminal state checks
  - **Preloaded events (TTFB)**: `run_started` response now includes all events for the run, allowing the runtime to skip the initial `events.list` call

## 1.2.0

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

## 1.1.1

### Patch Changes

- 2a1587e: Upgrade @workflow packages to stable 4.1.x

  Production dependencies upgraded from beta to stable 4.1.1:

  - @workflow/errors: 4.1.0-beta.20 -> 4.1.1
  - @workflow/world: 4.1.0-beta.17 -> 4.1.1
  - @workflow/world-local: 4.1.0-beta.51 -> 4.1.1

  Dev dependency kept on compatible beta version:

  - @workflow/world-testing: 4.1.0-beta.53 (stable has breaking test changes)

  All validation passes: lint, typecheck, and full test suite.

## 1.1.0

### Minor Changes

- 7da6262: Add production-ready Azure Cosmos DB and NATS JetStream world implementations

  **Azure Cosmos DB (`@fantasticfour/world-azure`):**

  - Implement CBOR binary serialization for workflow data (input/output/metadata)
  - Add 409 Conflict error handling for idempotent document creation (emulator upsert is broken)
  - Fix EventSchema validation to use decoded eventData
  - Integrate official `@testcontainers/azure-cosmosdb-emulator` for testing
  - Add HTTPS agent configuration to handle emulator's self-signed certificates
  - Switch to `:vnext-preview` Docker image tag for ARM64 compatibility (Apple Silicon support)
  - Add SSL initialization delay for improved test stability
  - Enterprise-ready cloud deployment with proper SSL configuration
  - All 6 spec tests passing (100%)

  **NATS JetStream (`@fantasticfour/world-nats-jetstream`):**

  - Add defensive null checks when iterating KV bucket history (7 locations)
  - Resolve race conditions in concurrent operations
  - Fixed `TypeError: Cannot read properties of undefined (reading 'operation')` during concurrent operations
  - Single binary, distributed by default, with native streaming capabilities
  - All 6 spec tests passing (100%)

  Both worlds are production-ready with full test coverage, proper error handling, and passing lints/types.
