---
'@fantasticfour/world-nats-jetstream': minor
---

Align with `@workflow/world` 4.2.1 contracts and fix several reliability issues
specific to the NATS JetStream backend.

`specVersion` is now read resiliently on startup so a missing or malformed
value no longer prevents the world from initialising. The typed error taxonomy
matches what `@workflow/core` checks by name. `hook_created` follows the
upstream conflict semantics: a race-losing create is treated as a conflict
rather than a silent duplicate, keeping hook state consistent under
concurrent writers.

Streamer streams migrate from Interest to Limits retention automatically
(delete and recreate, lossless since Interest retained nothing before a
reader attached). A `working()` heartbeat extends the 30-second ack deadline
through long dispatches while still letting crashed workers redeliver quickly.
Attempt numbers now derive from the real JetStream `deliveryCount`, `max_deliver`
is raised above core's 48-delivery budget, and naks use a backoff delay.

All run, step, and wait transitions go through revision-checked CAS loops,
eliminating lost-update races under concurrent writers. `history()` revision
scans are replaced with live-entry listing. Wait entities and a per-run event
index are added. A real `nats@2.x` client bug (KV `keys()` drops buffered
keys when awaited mid-iteration) is worked around throughout.
