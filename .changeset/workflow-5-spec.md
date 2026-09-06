---
'@fantasticfour/world-azure': major
'@fantasticfour/world-cloudflare': major
'@fantasticfour/world-firestore-tasks': major
'@fantasticfour/world-mysql': major
'@fantasticfour/world-mysql-redis': major
'@fantasticfour/world-nats-jetstream': major
'@fantasticfour/world-postgres-redis': major
'@fantasticfour/world-redis': major
'@fantasticfour/world-redis-bullmq': major
'@fantasticfour/world-upstash': major
---

Migrate every world to the Workflow 5 spec (@workflow/world 5.0.0-beta.33,
spec version 7).

Breaking changes shared by all worlds:

- Event IDs are slot positions, not ULIDs. Each world allocates the dense,
  1-based slot atomically in its store (Lua EVAL, SQL insert with a composite
  primary key, Firestore transaction, Durable Object transaction, Cosmos
  transactional batch, or NATS KV conditional create) and implements bump and
  report: a stale eventCount is never rejected, the write commits at the next
  free slot and the response carries the skipped events.
- The stateUpdatedAt 412 precondition guard is removed. Bump and report
  supersedes it.
- Streams move to the streams namespace with runId-first arguments.
- The step queue is retired. Steps and waits ride the workflow topic;
  waits are plain delaySeconds continuations.
- specVersion comes from SPEC_VERSION_CURRENT and every package exports a
  createWorld factory.
- New surface: attr_set events, experimentalSetAttributes, lazy step_started,
  run attributes, errorCode, and sinceCursor event deltas.

Rollout warning: runs created by 4.x worlds cannot be replayed by 5.x code.
There is no mixed scheme. Drain in-flight runs on the 4.x build before
deploying these versions. SQL worlds ship schema migrations (world-mysql
0005, world-postgres-redis 0007, world-mysql-redis 0008); world-upstash also
renames the queue wire field from message to payload, so in-flight QStash
messages need the same drain.
