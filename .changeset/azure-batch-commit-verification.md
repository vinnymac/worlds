---
"@fantasticfour/world-azure": patch
---

Verify Cosmos transactional batch results before treating writes as
committed. `Items.batch()` resolves (rather than throws) on rejected
batches, so duplicate-create and etag conflicts were previously treated as
successful writes, silently dropping events and run/step transitions.
