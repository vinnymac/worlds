---
'@fantasticfour/world-azure': patch
---

Honour `pagination.cursor` in `events.listByCorrelationId`.

The query never added a cursor predicate, so the parameter was accepted and
silently ignored and every page returned the first one. A caller paginating a
correlation lookup looped forever on duplicate events instead of advancing.
`events.list` directly above it already pushed `c.eventId > @cursor`; this now
uses the identical predicate and sort-order handling.

Pre-existing, not introduced by the `runId` scoping in the same release. Found
because the new run-scoping pagination test exercised a second page for the
first time.
