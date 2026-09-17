---
'@fantasticfour/world-redis-bullmq': minor
---

Add a `lockDuration` option for the BullMQ workers. BullMQ renews a job's lock from the worker's own event loop once the lock is between a quarter and half of its duration old, so a step that blocks that loop for longer than half the lock (30s by default) can lose it, and another worker re-delivers the job while the first execution is still running. With the default `maxStalledCount` of 1, the next stall then fails the job outright. A consumer whose steps run long synchronous work can now set a lock of at least 2x the longest block. A non-integer value, one below 1, or one above 2147483647 (Node's timer limit) throws at construction. Unset, BullMQ's default applies as before.
