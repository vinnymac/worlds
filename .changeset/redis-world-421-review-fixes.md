---
'@fantasticfour/world-redis': minor
---

Align `world-redis` with the @workflow/world 4.2.1 contract and harden queue,
storage, and close semantics across the board.

Deferred deliveries now land in a durable delayed sorted set with a background
promoter. Enqueue reserves the idempotency key and pushes to the ready queue in
a single Lua script, so a crash between reserve and push can no longer leave a
key that blocks all future attempts. Workers hold their in-flight message in a
per-worker processing list, emit a heartbeat, and a reclaim pass recovers
messages whose worker disappears.

Run and step state transitions are now compare-and-swap Lua scripts with
re-validating retry loops. Concurrent terminal transitions (two handlers racing
to fail the same run) land exactly once instead of overwriting each other.
`hook_created` conflicts are rejected rather than silently overwritten, matching
the typed error taxonomy that `@workflow/core` checks by name
(`WorkflowConflictError`, `WorkflowNotFoundError`, and friends). Wait entities
are now persisted with the same duplicate-rejection guard. `specVersion` is
read with a resilient fallback so a missing field does not abort startup.

The JSON date reviver has been removed. It coerced any user payload that
happened to be shaped like a serialized `Date` string into a `Date` object,
corrupting data silently. Schema coercion handles the internal fields where a
date is actually expected. `world.close()` is now implemented.
