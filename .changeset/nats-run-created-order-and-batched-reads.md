---
'@fantasticfour/world-nats-jetstream': patch
---

Backdate the synthetic `run_created` event, and batch per-run event reads.

The resilient-start path minted the synthetic `run_created` with a fresh ULID
AFTER the `run_started` that bootstrapped it, so in the eventId-ordered log the
creation event sorted second. The redis family backdates the synthetic id one
millisecond below its `run_started`; this world now does the same, keeping the
creation event first everywhere the log is ordered by id.

Separately, `loadEventsForRun` read the events-by-run index and then fetched
each event body with a sequential awaited KV get, costing N round trips per
call. `events.listByCorrelationId` made this a hot path since it loads the full
run log per page request. The per-event gets now run in parallel; results were
always sorted afterwards, so the serialism bought nothing.
