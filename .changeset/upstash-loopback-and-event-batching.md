---
'@fantasticfour/world-upstash': patch
---

Batch event-log reads into a single `MGET`, and bound loopback delivery
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
