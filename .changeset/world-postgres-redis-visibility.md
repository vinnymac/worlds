---
'@fantasticfour/world-postgres-redis': minor
---

Add a `visibilityTimeoutMs` option for the Redis queue. A worker claims a job by writing a fixed deadline into the in-flight set, and any process's promote loop redelivers the job once that deadline passes. The deadline was always `httpTimeoutMs` plus 60s, so the only way to lengthen it was to lengthen the dispatch abort too. A step that blocks the event loop can outrun that deadline, because the abort timer itself fires late, and another worker then re-delivers the job while the first execution is still running. A consumer can now set the visibility window independently, matching `@fantasticfour/world-mysql`. The value must be an integer of at least `httpTimeoutMs`, or `createWorld` throws a `RangeError`. Unset, the default stays `httpTimeoutMs + 60000`.
