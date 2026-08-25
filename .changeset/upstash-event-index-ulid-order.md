---
'@fantasticfour/world-upstash': patch
---

Order the event log by eventId, fixing a permanent `stateUpdatedAt` livelock.

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
