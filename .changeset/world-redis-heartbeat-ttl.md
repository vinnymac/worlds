---
'@fantasticfour/world-redis': minor
---

Add a `heartbeatTtlMs` option for the queue workers' liveness key. Each worker refreshes that key from its own event loop every third of the TTL, so a step that blocks the loop for longer than two thirds of the TTL (90s by default) can let it expire, and the reclaimer returns the in-flight message to the ready list for another worker to execute while the first execution is still running. A consumer whose steps run long synchronous work can now set a TTL of at least 1.5x the longest block. A failed refresh is now logged instead of ignored. The key is now written with millisecond precision, and a non-integer value or one below 15000 (three BLMOVE block timeouts) throws at construction. Unset, the 90s default applies as before.
