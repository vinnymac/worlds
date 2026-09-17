---
'@fantasticfour/world-mysql-redis': minor
---

Add a `visibilityTimeoutMs` option for the queue lease. Each dispatched item is leased once for `httpTimeoutMs` plus 30s and never renewed, so a step that blocks the event loop long enough to delay the fetch abort outlives its lease, and another worker re-delivers the item while the first execution is still running. The lease could previously only be lengthened by raising `httpTimeoutMs`, which also governs the abort. It can now be set on its own, matching `@fantasticfour/world-mysql`. A non-integer value or one below `httpTimeoutMs` throws a `RangeError` at startup. Unset, the lease stays `httpTimeoutMs + 30_000` as before.
