---
'@fantasticfour/world-redis-bullmq': minor
---

Add a `lockDuration` option for the BullMQ workers. BullMQ renews a job's lock from the worker's own event loop, so a step that blocks that loop for longer than the lock (30s by default) loses it, and another worker re-delivers the job while the first execution is still running. With the default `maxStalledCount` of 1, the next stall then fails the job outright. A consumer whose steps run long synchronous work can now hold a lock that outlasts them. Unset, BullMQ's default applies as before.
