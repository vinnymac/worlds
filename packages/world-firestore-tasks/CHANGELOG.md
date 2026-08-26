# @fantasticfour/world-firestore-tasks

## 2.4.2

### Patch Changes

- a37b02f: Honour `resolveData` when reading events.
  
  Both worlds applied `resolveData` to runs, steps and hooks but ignored it for
  events, so `events.get`, `events.list` and `events.listByCorrelationId` returned
  full `eventData` even when the caller asked for `'none'`. That is how callers
  avoid shipping large payloads, and the observability dashboard `@workflow/web`
  requests `'none'` for its list views, so every dashboard list pulled complete
  event payloads over the wire from these two worlds.
  
  Both now use the same `filterEventData` helper the other seven worlds already
  share, which removes the `eventData` key entirely rather than setting it to
  undefined. The default stays `'all'`.
  
  Tests assert key absence rather than an undefined value, since an
  undefined-valued key would satisfy a looser check while diverging from the
  sibling worlds.
- 6de8be4: Honour `resolveData` on the `events.create` return path too.
  
  Fixing the three event readers left the create path unfiltered: twelve return
  sites handed back the event they had just written with full `eventData`,
  regardless of what the caller asked for. Every sibling world already filters
  here.
  
  The largest leak was the `run_started` preload, which returns the run's entire
  event log. Under `resolveData: 'none'` it was returning every event with full
  payloads, which is the opposite of what that option is for.
  
  `resolveData` is now resolved once at the top of `events.create` and applied to
  every returned event including the preload, so the exhaustiveness is greppable
  rather than a per-branch habit. The idempotent `run_started` replay is untouched
  because it returns no event.
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

## 2.4.1

### Patch Changes

- 27a84a5: Track workflow 4.8.4 (`@workflow/world` 4.4.0, `@workflow/world-testing` 4.1.19).
  
  The 4.4.0 contract is additive only: it adds a `WORKFLOW_NODE_HTTP` flag that
  swaps the HTTP client used by the Vercel and Local worlds, plus the
  `env-config` helpers (`envFlag`, `envNumber`, `getMaxEventsPerRun`) that back
  it. Neither the `World` interface nor the event schemas changed, so no world
  in this repo needed a code change. Every world's published
  `@workflow/world` peer range moves to 4.4.0 to match.

## 2.4.0

### Minor Changes

- b29bc83: Add full support for workflow 4.8.3 across every world, along with fixes for duplicate creation events, concurrent replay, fat payload encoding, Azure batch verification, and Firestore error codes.
  
  `createStreamer` now returns `CloudflareStreamer`, which declares that `writeToStream` and `closeStream` accept an unresolved `Promise<string>` run id. Every world already implemented that contract; only the return type hid it.

## 2.3.1

### Patch Changes

- 617b1c7: Add `files` field to restrict npm publish to `dist/` only. Saving 141-215 KB per package.

## 2.3.0

### Minor Changes

- ee02f27: Align with @workflow/world 4.2.1: transactional guards, corrected dedup
  semantics, typed error taxonomy, and `specVersion` support.

  The Cloud Tasks dedup marker is now written only after the handler succeeds,
  so a crash during processing causes the task to be retried rather than silently
  dropped. `timeoutSeconds` schedules a fresh delayed Cloud Task instead of
  acking the current one. Both fixes close the two production-stranding bugs.

  Every entity-mutating event now runs inside `firestore.runTransaction` with
  all guards applied atomically inside that transaction. The streamer orders
  chunks by monotonic `chunkId` (safe under same-millisecond bursts in both
  listener and polling modes), event ordering and cursor tracking move to
  `eventId`, and `firestore.indexes.json` is updated with the matching composite
  indexes. Wait entities reject duplicate completion.

  `specVersion` is declared with a binary-safe transport. The package adopts the
  typed error taxonomy that `@workflow/core` matches by name, and `hook_created`
  conflict semantics are handled consistently with the rest of the 4.2.1 surface.

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
