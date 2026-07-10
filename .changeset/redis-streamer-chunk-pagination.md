---
'@fantasticfour/world-redis': minor
'@fantasticfour/world-redis-bullmq': minor
---

Implement the full `Streamer` contract for the Redis Streams backends.

`getStreamChunks`, `getStreamInfo`, and `listStreamsByRunId` were previously
missing and hidden behind an `as any` cast, so paginated chunk reads, stream
metadata lookups, and per-run stream enumeration silently returned nothing.
They are now implemented against Redis Streams (`XRANGE`/`XREVRANGE`/`XLEN`)
with a per-run stream index (`<prefix>streams:by_run:<runId>`), and the unsafe
cast is gone so the world type-checks against the real interface.
