---
'@fantasticfour/world-redis-bullmq': minor
---

Align with `@workflow/world` 4.2.1 and fix the BullMQ-specific reliability
issues.

`specVersion` is now declared with a binary-safe queue payload and a
transactional `run_started` bootstrap, so the resilient-start path in core
4.6.0 (parallel `run_created` + queue publish) works correctly. The typed error
taxonomy (`EntityConflictError`, `RunExpiredError`, `TooEarlyError`,
`WorkflowRunNotFoundError`, `HookNotFoundError`) replaces the generic
`WorkflowWorldError` throws, matching the names core's static `.is()` checks
expect. `hook_created` now follows the 4.2.1 conflict semantics: same-entity
duplicate raises `EntityConflictError`, a crash orphan completes the partial
write, a foreign holder emits `hook_conflict` with `conflictingRunId`, and
`hook_disposed` releases the token.

On the BullMQ side: `queue()` no longer swallows `add()` failures, dedup keys
are released on job finalization instead of expiring after 60 s (which could
free a live key mid-flight), and 503 deferral uses `moveToDelayed` plus
`DelayedError` rather than acking and relying on an in-process timer. The full
Redis connection options (including `tls` and `username`) now reach BullMQ.
Six Lua scripts make every entity, index, and event write group atomic, and
stream-entry IDs are now compared numerically. `close()` is implemented.
