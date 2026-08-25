---
'@fantasticfour/world-azure': patch
'@fantasticfour/world-cloudflare': patch
'@fantasticfour/world-firestore-tasks': patch
'@fantasticfour/world-mysql': patch
'@fantasticfour/world-mysql-redis': patch
'@fantasticfour/world-nats-jetstream': patch
'@fantasticfour/world-postgres-redis': patch
'@fantasticfour/world-redis': patch
'@fantasticfour/world-redis-bullmq': patch
'@fantasticfour/world-upstash': patch
---

Track workflow 4.8.4 (`@workflow/world` 4.4.0, `@workflow/world-testing` 4.1.19).

The 4.4.0 contract is additive only: it adds a `WORKFLOW_NODE_HTTP` flag that
swaps the HTTP client used by the Vercel and Local worlds, plus the
`env-config` helpers (`envFlag`, `envNumber`, `getMaxEventsPerRun`) that back
it. Neither the `World` interface nor the event schemas changed, so no world
in this repo needed a code change. Every world's published
`@workflow/world` peer range moves to 4.4.0 to match.
