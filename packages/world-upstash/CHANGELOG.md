# @fantasticfour/world-upstash

## 1.5.2

### Patch Changes

- 71f9bf5: Order the event log by eventId, fixing a permanent `stateUpdatedAt` livelock.
  
  The event index scored entries by `createdAt.getTime()`, a wall clock read at
  append time, while the run's state marker and core's `stateUpdatedAt` both come
  from the ULID minted at the start of `events.create`. Those two clocks are
  separated by every intervening Redis round trip, so an event with an older ULID
  could sort last.
  
  That is fatal because `latestEventStateUpdatedAt` in core takes the ULID time of
  the LAST event the log returns, not the maximum. Once an older-ULID event sorted
  last, core sent a snapshot below the marker on every replay, the guard rejected
  it as stale, and core answered each rejection with `{ timeoutSeconds: 0 }` -
  re-invoke with a fresh replay. The fresh replay read the same ordering and
  computed the same value, so the run could never converge. A captured failure
  logged 58,725 rejections, every one exactly 1 ms short, with the flow message
  self-republishing up to 3,093 times while `deliveryCount` stayed 0.
  
  Core documents this guard as best-effort and states that it "fails open rather
  than livelocking"; ordering the log by a different quantity than the marker
  broke that contract. The event index now scores by `eventIdTime(eventId)`, so
  log order matches eventId order and the last event is always the newest, exactly
  as upstream world-postgres does with `orderBy(events.eventId)`. The synthesized
  `run_created` on the resilient-start path is backdated one millisecond ahead of
  the `run_started` that bootstraps it, preserving its position now that ordering
  follows the id rather than append time.
  
  Measured, not assumed: 36 consecutive `idempotency` runs with no failure, where
  the same build without this change still failed 1 run in 12, and roughly 1 in 5
  across all prior samples. All 66 package tests pass, including the six
  `stateUpdatedAt` guard tests, which are unchanged because the marker's
  representation is untouched.
  
  world-redis and world-redis-bullmq score their event indexes the same way and
  carry the identical latent defect. They are not fixed here.
- 44d6bf9: Reject an unresolvable pagination cursor instead of silently skipping an entry.
  
  Every paginated list resolved its cursor with `(rank ?? 0) + 1`. When `ZRANK`
  could not find the cursor in the index it returns null, so the expression
  produced `1` and the page started at rank 1, dropping the index's first entry
  without any signal. Callers got a page that looked complete and quietly lost an
  event, step, hook, or run.
  
  The six call sites now share one `resolveCursorRank` helper that throws
  `WorkflowWorldError` with status 400 for a cursor that is not in the index,
  matching world-redis. This is a behaviour change: a caller that previously
  passed a stale or fabricated cursor got a silently shifted page and now gets a
  400. That is the intent, since the previous result was wrong data rather than a
  smaller page.
  
  Noticed while adding correlation-id pagination coverage, which surfaced that the
  three Redis-family worlds disagreed here: world-redis threw, world-redis-bullmq
  restarts at rank 0 and repeats entries, and this world skipped one.
- 132c596: Batch event-log reads into a single `MGET`, and bound loopback delivery
  concurrency.
  
  `events.list`, `events.listByCorrelationId`, and the `run_started` event-log
  preload each read their events with one `GET` per event id. On this transport
  every command is a billed, rate-limited HTTP request, so an N-event replay cost
  N round trips. They now issue `MGET`s in parallel chunks of 500 keys, which is
  the dominant per-replay saving under load while keeping a long run (the
  `run_started` preload reads the whole log, up to `maxEvents` ids) under
  Upstash's per-request size cap.
  
  The `'loopback'` queue transport (tests and local development, where hosted
  QStash cannot reach the app) now bounds in-flight deliveries with a semaphore,
  configurable via `loopbackConcurrency` and defaulting to 10, mirroring
  world-redis and world-nats-jetstream's default worker-pool concurrency. Real
  QStash paces redelivery through network round trips; loopback self-POSTs have
  no such throttle, so an immediate `{ timeoutSeconds: 0 }` republish loop could
  otherwise fire unboundedly many concurrent requests at the harness server. A
  slot is held only while a request is in flight; a retry sleeping through its
  backoff releases it, so a down target cannot head-of-line block healthy
  deliveries. `'qstash'` mode is untouched.
  
  Note on the flaky `idempotency` conformance test: neither change fixes it, and
  this was measured rather than assumed. It still reproduces roughly 1 run in 3
  to 1 in 6 both with and without these changes, and on 4.8.4 and 4.8.5 alike.
  The failure is a `stateUpdatedAt` livelock, not a delivery-concurrency problem:
  in a captured failure the run logged 58,725 `PreconditionFailedError`
  rejections, every one of them with the run's state marker exactly 1 ms ahead of
  the `stateUpdatedAt` the replay reported, so core re-invoked with
  `{ timeoutSeconds: 0 }` forever. The flow message self-republished up to 3,093
  times and pinned `republishCount` at the `MAX_SOFT_REPUBLISHES` ceiling of 256
  while `deliveryCount` stayed 0, confirming the delivery-budget fix from the
  previous release is working and that the remaining stall is upstream of it. The
  marker is advanced by `step_completed` events under
  `EXTERNALLY_ORIGINATED_EVENT_TYPES`, and in the captured failure two of them
  shared a single millisecond. Adding one extra round trip to the read path made
  the failure disappear across 14 consecutive runs, so the race is tight and
  timing-sensitive. Diagnosing the last step is tracked separately; this release
  does not claim to fix it.
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

- 60bfbeb: Stop `{ timeoutSeconds }` republishes from exhausting core's queue delivery
  budget, which intermittently failed healthy runs.
  
  `{ timeoutSeconds }` is core's control-flow signal, not a failed delivery:
  `sleep()`, step retry backoff, `TooEarlyError`, and `{ timeoutSeconds: 0 }`
  ("re-invoke me with a fresh replay", returned whenever the `stateUpdatedAt`
  precondition guard exhausts its reloads or `run_completed` is rejected as
  stale). The handler was republishing those with `deliveryCount: attempt`, so
  every suspension pushed the counter core reads as `attempt` one step closer to
  `MAX_QUEUE_DELIVERIES` (48). A workflow that merely suspended often enough was
  then killed as a runaway, emitting `step_failed` with "exceeded max deliveries"
  and ending the run as `failed` despite nothing having gone wrong.
  
  This surfaced as a flaky `idempotency` conformance failure: `brokenWf` fans out
  20 parallel steps, and the resulting event contention makes core re-invoke the
  workflow repeatedly, so under load the flow message reached
  `exceeded max deliveries (49/48)`. Since `deliveryCount` was only ever written
  on this path and loopback caps `upstash-retried` at 4, an `attempt` of 49
  required at least 44 suspensions.
  
  Soft republishes now carry only the accumulated *failed* delivery total
  (`deliveryCount + retried`), matching world-redis, which parks soft retries
  "without incrementing attempt". Genuine hard failures still count, so QStash
  redelivery loops remain capped. A separate `republishCount` bounds consecutive
  suspensions at 256 (mirroring world-local's safety limit) and fails the
  delivery loudly rather than letting a message spin forever.
  
  Also release the loopback pump's dedup reservation when a delivery permanently
  fails. The key was left behind, so core's next re-enqueue of that step was
  silently swallowed and the run wedged; world-redis releases its reservation on
  final drop for the same reason.
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

## 1.4.0

### Minor Changes

- dbb9744: Pass a retry budget to QStash that matches core's delivery expectation.

  QStash's default hard-failure retry count is small (3 on the free plan), well
  below core's `MAX_QUEUE_DELIVERIES` (48). Publishes (including the
  `{ timeoutSeconds }` self-republish) now request 47 retries (48 total
  deliveries), so transient handler failures are redelivered right up to the
  point where core would give up, instead of QStash dropping the message first.
  The count is configurable via the new `qstashRetries` world option (QStash
  still clamps it to your plan's maximum).

- ee02f27: Align world-upstash with the @workflow/world 4.2.1 contract and fix several
  reliability bugs.

  `specVersion` is now declared and the body is transmitted as binary-safe
  base64, so the handshake succeeds on any QStash plan without content-encoding
  surprises. The typed error taxonomy from `@workflow/core` is adopted throughout,
  meaning `WorkflowNotFoundError`, `RunNotFoundError`, and friends are thrown by
  name rather than as generic errors, which lets `@workflow/core` route them
  correctly. Creation events and hook tokens are now claimed via `SETNX`, fixing
  a replay self-conflict where a run could fight itself on redelivery and a
  last-writer-wins race when two deliveries arrived in close succession.

  `opts.idempotencyKey` is forwarded as `deduplicationId` on every publish. The
  previous code generated a fresh ULID per call, so QStash deduplication was
  effectively disabled and callers who relied on it received duplicate processing.
  `isWebhook` is now persisted so the flag survives a redelivery cycle. The
  stream-closed flag comparison is also corrected: Upstash auto-deserializes the
  stored `"1"` to the number `1`, so the `=== '1'` guard always missed and streams
  never reported closed. Stream chunks are consistently base64 encoded, preventing
  string-chunk corruption that corrupted payloads like `'hello world'` on
  round-trip.

  `retryAfter` is now enforced on rate-limit responses, and `hook_created` conflict
  semantics match the 4.2.1 spec so a repeated webhook delivery is idempotent
  rather than raising an error.

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

- b8e251a: feat(world-upstash): Add serverless Upstash Redis + QStash world implementation

  Implements a pure Upstash world using Upstash Redis for storage and QStash for queueing, optimized for serverless and edge runtimes.

  **Architecture:**

  - Storage: Upstash Redis with REST API and CBOR serialization
  - Queue: Upstash QStash for HTTP-based job delivery
  - Streaming: Polling-based via getStreamChunks() (no real-time streaming)

  **Key Features:**

  - Zero infrastructure management required
  - Global distributed storage with Upstash Redis REST API
  - HTTP-based queue with QStash for reliable job delivery
  - Compatible with edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy)
  - Pay-per-use pricing model
  - Replaces removed mysql-upstash and postgres-upstash packages

  **Use Cases:**

  - Serverless environments without persistent infrastructure
  - Edge runtime deployments
  - Pay-per-use cost model preference
  - Global distribution requirements
