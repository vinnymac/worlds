---
"@fantasticfour/world-mysql": minor
"@fantasticfour/world-mysql-redis": minor
"@fantasticfour/world-postgres-redis": minor
"@fantasticfour/world-redis-bullmq": minor
"@fantasticfour/world-nats-jetstream": minor
"@fantasticfour/world-cloudflare": minor
"@fantasticfour/world-upstash": minor
---

Duplicate creation events (`step_created`, `hook_created`, `wait_created`)
now throw `EntityConflictError` instead of silently succeeding — the dedup
signal `@workflow/core` expects on redelivery, matching the upstream
world-postgres/world-local/world-vercel contract. Previously a redelivered
creation event appended a second row to the event log, which poisons later
replays with `ReplayDivergenceError`. Crash orphans (entity written, event
write lost) still heal on retry.

SQL worlds add a unique index on `(run_id, correlation_id, type)` for the
three creation event types, with a pre-index dedup of any existing duplicate
rows: world-mysql migration `0004`, world-mysql-redis migration `0007`
(functional index — requires MySQL 8.0.13+), world-postgres-redis migration
`0006` (partial index, ported from upstream world-postgres migration 0010).

Upgrade ordering: deploy the new world code to ALL instances BEFORE applying
the schema migration. Old code does not translate the new index's
duplicate-key error into `EntityConflictError`, so a redelivered creation
event hitting an old instance after the index exists would fail the run
instead of deduping.
