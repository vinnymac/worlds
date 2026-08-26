---
'@fantasticfour/world-redis': patch
'@fantasticfour/world-redis-bullmq': patch
---

Order the event log by eventId, and reject an unresolvable pagination cursor.

Both worlds scored their event index by `createdAt.getTime()`, a wall clock read
at append time, while their state marker uses `eventIdTime(eventId)` from the
ULID minted earlier in the same call. Core derives `stateUpdatedAt` from the
LAST event the log returns rather than the maximum, so once an older-ULID event
sorted last, core sent a snapshot below the marker, the guard rejected it, and
core's `{ timeoutSeconds: 0 }` retry recomputed the identical value forever.

This is the same defect diagnosed and fixed in world-upstash in this release,
where it reproduced as a hung run roughly once in five. These two worlds never
hit it in practice only because their round-trip latency is far lower, so the
window between the ULID and the append is narrower. It was latent, not absent.

The event index and the by-correlation index now score by `eventIdTime`. The
entity indexes still score by wall clock, so every fused script that writes
both takes the event score as a separate argument rather than reusing one
value: `wfCreateRunWithEvent`, and the step, hook, and wait creation scripts
(plus the bullmq `hook_conflict` fallback append), which had been left on the
wall-clock score and kept the mixed-order livelock reachable through the
step/hook/wait paths. The synthesized `run_created` on the resilient-start
path is backdated one millisecond ahead of the `run_started` that bootstraps
it, since ordering now follows the id rather than append time.

Separately, an unresolvable pagination cursor in world-redis-bullmq restarted
the page at rank 0, silently repeating entries a caller had already seen. It now
throws `WorkflowWorldError` at 400, matching world-redis and world-upstash. The
three Redis-family worlds previously disagreed on this: one threw, one repeated,
one skipped.
