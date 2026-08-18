---
"@fantasticfour/world-azure": minor
"@fantasticfour/world-cloudflare": minor
"@fantasticfour/world-firestore-tasks": minor
"@fantasticfour/world-mysql": minor
"@fantasticfour/world-mysql-redis": minor
"@fantasticfour/world-nats-jetstream": minor
"@fantasticfour/world-postgres-redis": minor
"@fantasticfour/world-redis": minor
"@fantasticfour/world-redis-bullmq": minor
"@fantasticfour/world-upstash": minor
---

Full support for workflow 4.8.3 (`@workflow/world` 4.3.1 contract): the
`stateUpdatedAt` optimistic-concurrency guard (stale lifecycle events are
rejected with a typed `PreconditionFailedError`, atomically per backend) and
a configurable per-run event ceiling returned as `maxEvents` on `run_started`
(`maxEventsPerRun` config option, `WORKFLOW_MAX_EVENTS` env var, default
25,000). SQL worlds ship a `state_updated_at` migration; the new `eventLimit`
conformance suite is wired in where the backend supports it.
