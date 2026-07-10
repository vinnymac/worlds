---
'@fantasticfour/world-firestore-tasks': minor
---

Align with @workflow/world 4.2.1: transactional guards, corrected dedup
semantics, typed error taxonomy, and `specVersion` support.

The Cloud Tasks dedup marker is now written only after the handler succeeds,
so a crash during processing causes the task to be retried rather than silently
dropped. `timeoutSeconds` schedules a fresh delayed Cloud Task instead of
acking the current one. Both fixes close the two production-stranding bugs.

Every entity-mutating event now runs inside `firestore.runTransaction` with
all guards applied atomically inside that transaction. The streamer orders
chunks by monotonic `chunkId` (safe under same-millisecond bursts in both
listener and polling modes), event ordering and cursor tracking move to
`eventId`, and `firestore.indexes.json` is updated with the matching composite
indexes. Wait entities reject duplicate completion.

`specVersion` is declared with a binary-safe transport. The package adopts the
typed error taxonomy that `@workflow/core` matches by name, and `hook_created`
conflict semantics are handled consistently with the rest of the 4.2.1 surface.
