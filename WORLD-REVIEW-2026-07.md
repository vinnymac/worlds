# World implementations review & remediation — July 2026

Scope: upgrade of all 10 `@fantasticfour/world-*` packages from `@workflow/world` 4.1.1 to 4.2.1
(`@workflow/core` 4.6.0, `@workflow/errors` 4.1.4, `@workflow/world-testing` 4.1.11, vitest 4),
followed by a full multi-agent correctness review and remediation of every confirmed finding.

## Executive summary

- **100 findings raised** by a 10-reviewer team (one senior reviewer per world, each capped at 10
  itemized findings + overflow notes), each finding then adversarially verified by 2–3 independent
  verifier agents (correctness lens + contract lens + tiebreak).
- **97 confirmed real and fixed. 3 refuted** on contract grounds (details below). Zero findings
  were left unfixed for scope reasons; a small set of explicitly-listed residuals is recorded per
  world below.
- **All gates green** after remediation: `build` 12/12 · `typecheck` 12/12 · `oxlint
--deny-warnings` · `oxfmt --check` · `turbo test` 22/22 tasks (including the
  `@workflow/world-testing` conformance suite per world against real backends via
  testcontainers/emulators) · cloudflare `test:workers` 23/23 against real workerd.
- Every world now declares `specVersion: SPEC_VERSION_CURRENT` with a binary-safe queue transport
  and a transactional `run_started` bootstrap — the resilient-start path (core 4.6.0 fires
  `run_created` and the queue publish in parallel) works on all 10 backends.

## The systemic bug classes (found in most worlds, now fixed everywhere)

1. **Wrong error classes.** Core matches errors by NAME via static `.is()`. Worlds threw generic
   `WorkflowWorldError` where core requires `EntityConflictError` / `RunExpiredError` /
   `TooEarlyError` / `WorkflowRunNotFoundError` / `HookNotFoundError` — silently disabling core's
   replay tolerance and degrading recoverable conditions into 500-retry-drop loops.
   (Note: `StepNotFoundError` does not exist in `@workflow/errors` 4.1.4; upstream uses
   `WorkflowWorldError(404)` for missing steps and our worlds now match.)
2. **Discarded `{ timeoutSeconds }`.** The queue handler's return value is core's retry/sleep
   signal. Most production handlers acked it, permanently stranding sleeping/retrying runs. Each
   backend now maps it to its native redelivery idiom (503+Retry-After for DO queues, republish
   with delay for QStash, `moveToDelayed`+`DelayedError` for BullMQ, `scheduledEnqueueTimeUtc` for
   Service Bus, delayed task for Cloud Tasks, delayed-zset for the Redis families).
3. **In-process redelivery timers.** Retry/backoff/delay implemented as `setTimeout` before
   re-push — every message in that window is lost on crash/restart, usually while the idempotency
   key stayed held, deadlocking the run. Replaced with durable delayed queues (Redis sorted sets,
   scheduled messages) plus lease/visibility-based reclaim of crashed workers' in-flight messages.
4. **Millisecond-timestamp stream sequences.** `Date.now()`/ULID-timestamp-derived chunk sequences
   collide on same-millisecond writes → skipped or reordered chunks and wedged readers. All
   streamers now order by monotonic per-stream counters or full ULID chunkIds, honor `startIndex`
   (incl. negative), and implement `getStreamInfo`/`getStreamChunks`/`listStreamsByRunId`
   (world-redis excepted — see residuals).
5. **Missing terminal-state/idempotency guards & non-atomic writes.** Core deliberately re-delivers
   steps on every replay and relies on storage rejections. Guards were missing, racy
   (read-then-blind-write), or split across non-transactional writes. Every world now validates
   inside its backend's atomic primitive (DO `storage.transaction`, Firestore transactions, Cosmos
   transactional batches + `_etag`, SQL transactions with guarded UPDATEs, Redis Lua, NATS KV CAS).
6. **`hook_created` 4.2.1 semantics.** The pre-#2283 self-conflict bug (a run's own replay treated
   as a token conflict) existed nearly everywhere. Now: same-entity duplicate →
   `EntityConflictError`; crash orphan → complete the partial write; foreign holder →
   `hook_conflict` event carrying `conflictingRunId`; `hook_disposed` releases the token.
7. **createdAt-based event ordering/cursors.** Millisecond ties broke replay and skipped page
   boundaries. All ordering/pagination now uses monotonic IDs.

## The 3 refuted findings (not bugs)

- **world-cloudflare** "event appended before validation": the claimed trigger requires
  `run_started` without eventData, but core 4.6.0 always attaches runInput-derived eventData. (The
  transactional consolidation landed anyway as part of findings 2/4.)
- **world-nats-jetstream** "terminal run events on a missing run must throw
  WorkflowRunNotFoundError": `EventResult.run` is optional and upstream world-postgres logs the
  event with `run: undefined` — parity kept.
- **world-postgres-redis** "hooks.get TypeError on missing hook": the contract specifies no error
  taxonomy for `hooks.get`; upstream behaves the same. (Typed `HookNotFoundError` was added anyway
  while fixing finding 7, since the code was already being touched.)

## Per-world outcomes

### world-azure (10/10 fixed + all overflow)

Event+entity writes now commit in one same-partition transactional batch guarded by `_etag`
(bounded retry loop) — closes the resurrection race and orphaned terminal events. Cosmos SDK's
plain-`Error` wrapping of batch failures (verified against @azure/cosmos 4.9.3) is unwrapped so
409/429 handling actually runs. Service Bus honors `timeoutSeconds`/`delaySeconds` via scheduled
messages; `start()` provisions duplicate detection and throws loudly if an existing queue lacks
it. Streamer rewritten (ULID chunkId ordering, full contract surface). Wait entities added.
Cursors moved off createdAt. `World.close()` added.
Residuals: pre-upgrade streams (numeric sequence, no runId) won't appear in `listStreamsByRunId`;
`getStreamChunks` malformed-cursor falls back to start (world-local parity, but a silent fallback).

### world-cloudflare (10/10 fixed)

Biggest rework of the fleet. New `apply-event.ts` core executes guards → schema validation →
event append → entity mutation inside ONE `ctx.storage.transaction()` per event (mocks delegate to
the same core). Streamer↔StreamDO rewritten to pure RPC with one chunk per key and a DO-internal
monotonic index; storage layout moved from single aggregate values (which hit DO per-value size
caps and wedged runs) to one key per event/step/hook with real cursor pagination. Production queue
consumer claims idempotency keys via a claim DO before invoking the handler; `timeoutSeconds` →
503 + `message.retry({delaySeconds})`. `runs.list` page-boundary drop fixed. `hooks.get`
implemented (was a 501 stub). DO storage schema bumped to v2 (pre-production; no back-compat shim).
Residuals: the world-testing spec suite can't run against this package (its subprocess needs a
module-path world factory; pre-existing); `listByCorrelationId` returns empty pending a
correlation index; DO classes aren't exported from the package build (deploys rely on
`src/worker.ts` via wrangler).

### world-firestore-tasks (10/10 fixed)

The two production-stranding bugs closed: dedup marker now written only AFTER the handler succeeds,
and `timeoutSeconds` schedules a fresh delayed Cloud Task. All entity-mutating events run in
`firestore.runTransaction` with guards inside. Streamer ordered by ULID chunkId (same-ms burst
tests in both listener and polling modes). Event ordering/cursors on eventId with
`firestore.indexes.json` updated. Wait entities added.
Residuals: the GCP TTL policy on `processed_tasks.expiresAt` is infra config (field is written);
narrow double-execution window between marker-check and handler (safe under at-least-once + the
transactional guards; an inflight lease would close it); no integration test for the production
Cloud Tasks handler (no emulator exists).

### world-mysql (10/10 fixed + MEDIUMBLOB/TIMESTAMP(3) overflow fixes)

Every entity+event pair in one drizzle transaction with `notInArray` guarded UPDATEs. Polling queue
reclaims stale `processing` locks (`visibilityTimeoutMs`, server-side cutoffs). Idempotency key
stored on the job row so release/TTL cleanup can't free live keys. Streamer on ULID chunkId with
the full contract surface. 64KB BLOB → MEDIUMBLOB; TIMESTAMP → TIMESTAMP(3) (sub-second
occurredAt/retryAfter). Tests now apply the real migration files — which caught two latent
migration-runner bugs (prepared-protocol DDL rejection; splitter breaking on `;` in comments).
Residuals: no unique index on `hooks.token` (upstream parity); drizzle timestamps assume DB
TZ=UTC (documented); no waits table.

### world-mysql-redis (10/10 fixed)

Queue rewritten around durable Redis structures: delayed zset with Lua promotion, lease-based
reclaim + orphan adoption, DLQ that releases the idempotency key so core's replay self-heals.
Inert transactional outbox DELETED with justification (storage and queue are invoked independently
by the contract — no shared transaction exists for a true outbox); migration history reconciled
safely (shipped `0001_outbox.sql` restored; new `0003_drop_outbox.sql`). Streamer on dense
per-stream sequences (`FOR UPDATE`), `cancelled` added to the steps status enum (migration 0004).
Found en route: pre-allocated eventIds made the synthetic `run_created` sort after `run_started` —
fixed by porting upstream's lazy allocation.
Residuals: cli.ts migration runner is one-shot (no tracking table) — existing DBs must apply
0002–0005 manually (documented); consider porting postgres-redis's `__migrations` table.

### world-nats-jetstream (9/9 fixed; zero `any` remaining in the package)

Streams moved from Interest to Limits retention (Interest discarded chunks published before a
reader attached; old streams migrated losslessly). `working()` heartbeat extends the 30s ack
deadline through 300s dispatches. Attempt derived from JetStream `deliveryCount`; `max_deliver: 64`
(> core's 48); `nak(5000)` backoff. All KV mutations via revision-checked CAS loops. `history()`
revision-duplication scans replaced with live-entry listing. Wait entities added; events indexed
per run. Discovered + worked around a real nats@2.x client bug: KV `keys()` drops buffered keys if
you await mid-iteration (recorded in memory).
Residuals: `listByCorrelationId` is a full live scan; legacy (specVersion<2) `run_cancelled` path
still non-CAS; waits created pre-fix have no entity (mid-flight upgrades of sleeping runs would
404 on wait_completed).

### world-postgres-redis (9/9 fixed)

Durable dedup keys held for the full message lifetime; delayed redelivery via Redis zset + atomic
Lua promotion; visibility-deadline reclaim; at max attempts writes `run_failed` against the owning
run instead of silently dropping. Proper migration tracking added (`workflow.__migrations`,
transactional apply+record, early migrations made idempotent — verified against a live legacy DB;
orphan `0000_redundant_smasher.sql` deleted). `hooks.token` UNIQUE with race-loser routed through
conflict semantics.
Residuals: drizzle meta snapshots for 0002–0004 not regenerated; no entity-creation unique event
index; no waits table.

### world-redis (10/10 fixed)

Durable delayed zset + per-worker processing lists with heartbeat/reclaim; enqueue reserves the
idempotency key and pushes in one Lua script. Run/step transitions are full-JSON CAS Lua scripts
with re-validating retry loops (concurrent terminal transitions land exactly once). Wait entities
added. Date-reviver user-data corruption removed (schema coercion instead). `world.close()` added.
Residuals: **streamer still lacks `listStreamsByRunId`/`getStreamChunks`/`getStreamInfo` behind a
pre-existing `as any` cast — the only world missing them; recommend a follow-up**; delivery is
at-least-once by design (deduped by the storage guards).

### world-redis-bullmq (10/10 fixed + all overflow)

`queue()` no longer swallows `add()` failures; dedup keys released on job finalization instead of
a 60s TTL; 503 deferral via `moveToDelayed` + `DelayedError`; full redis connection options
(tls/username) passed to BullMQ; six Lua scripts make every entity+index+event write group atomic;
stream-entry IDs compared numerically. `close()` added.
Residuals: `cleanupHooks` deletes via a non-atomic pipeline (the hook_created self-heal recovers
the dangling-index case); event ZSET scores remain createdAt-ms with ULID-member tiebreak.

### world-upstash (10/10 — 8 findings independently re-verified by the fix agent, all confirmed)

`timeoutSeconds` → republish with delay (republish failure → 500 so QStash redelivers);
`opts.idempotencyKey` → `deduplicationId` (was a fresh ULID — dedup never deduped); SETNX-based
creation-event claims and token claims (also fixes a last-writer-wins race); streamer base64
corruption fixed (verified: `'hello world'` garbled before); `isWebhook` persisted. Bonus bug
found: the stream-closed flag compared `redis.get()` to `'1'` but Upstash auto-deserializes to
number `1` — streams never reported closed.
Residuals: QStash default 3 retries < core's 48-delivery expectation (add a `retries` config
passthrough); `readFromStream`'s upstash-specific 3rd `runId` arg means production stream reads
return empty (pre-existing, now typed via `UpstashStreamer`); pre-upgrade in-flight streams (raw
strings) decode as garbage post-upgrade.

## Cross-cutting follow-ups (recorded, not blocking)

1. `@fantasticfour/shared` is a devDependency used at runtime by world-azure/world-cloudflare/
   world-nats-jetstream — safe only because tsdown bundles it into dist. Worth a deliberate
   workspace convention (promote to dependency, or document the bundling contract).
2. world-redis streamer contract surface (see above).
3. `occurredAt` persistence: implemented in the SQL worlds; skipped elsewhere (upstream
   world-postgres 4.3.0 also skips it — parity-neutral).
4. Wait entities now exist in azure/firestore/nats/redis + the SQL worlds' event guards, but
   mysql/postgres-redis have no waits table (upstream parity today; revisit if core tightens
   duplicate `wait_completed` handling).
5. Migration-runner hardening: postgres-redis now has a `__migrations` tracking table; mysql and
   mysql-redis runners are still one-shot (documented in their cli.ts).

## Methodology note

Review ran as a scripted multi-agent workflow: 10 reviewers (one per world, seeded with the
systemic-bug-class checklist and the npm-packed upstream reference worlds
`@workflow/world-local@4.2.1` / `@workflow/world-postgres@4.3.0` as canonical comparators), then
2 adversarial verifiers per finding (correctness + contract lenses) with a high-effort tiebreak on
splits. ~405 agents total across review + verification (~9M tokens), plus 10 remediation agents.
Remediation was gated per package (build/typecheck/tests/lint/format) and then re-gated repo-wide.
