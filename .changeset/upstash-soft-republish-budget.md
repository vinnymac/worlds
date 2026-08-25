---
'@fantasticfour/world-upstash': patch
---

Stop `{ timeoutSeconds }` republishes from exhausting core's queue delivery
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
