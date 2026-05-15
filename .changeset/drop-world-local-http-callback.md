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

Slim down world packages by switching to an HTTP-callback architecture (matching
the reference `@workflow-worlds/redis` and our own `@fantasticfour/world-upstash`).

**Dependency drops (runtime):**

- `@workflow/world-local` removed from every world package.
- `@vercel/queue` removed from `world-redis`, `world-redis-bullmq`,
  `world-postgres-redis`, `world-mysql-redis`, `world-nats-jetstream`.
- `zod` removed from `world-redis`, `world-redis-bullmq`,
  `world-postgres-redis`, `world-mysql`, `world-mysql-redis`,
  `world-nats-jetstream` (replaced with hand-rolled validation for the two
  trivial schemas that used it; dead `Base64Buffer` codec deleted from
  `world-redis`).

**Architectural change:**

Workers no longer execute workflows in-process via `@workflow/world-local`.
Instead, each world dispatches jobs over HTTP to the user's app server at
`${baseUrl}/.well-known/workflow/v1/{flow|step}` — the same convention used by
the Workflow DevKit. Three header fields carry the envelope:

- `x-vqs-queue-name`
- `x-vqs-message-id`
- `x-vqs-message-attempt`

A 503 response with `{ "timeoutSeconds": number }` is treated as a soft retry
(does not consume an attempt). Other non-2xx responses trigger exponential
backoff up to `maxAttempts`.

For the cloud-managed worlds (`world-azure`, `world-cloudflare`,
`world-firestore-tasks`), production paths are unchanged (Service Bus,
Cloudflare Queues, Cloud Tasks with their native delivery wire formats). In
test mode, each now ships a small in-process test pump that HTTP-dispatches
back to the user's server using the same `x-vqs-*` headers as the other
worlds, so test behaviour is consistent across the whole repo.

**Breaking change for `start()` consumers:**

If you call `world.start()` and previously relied on the embedded
`@workflow/world-local` to execute workflows in-process, you now need a
reachable HTTP server hosting `world.createQueueHandler(...)` at the standard
routes. The `@workflow/world-testing` harness already does this, and any app
following the Workflow DevKit convention is already compatible.

New config knobs on each world (all optional):

- `baseUrl` — overrides `process.env.WORKFLOW_BASE_URL` /
  `http://localhost:${process.env.PORT ?? 3000}`
- `httpTimeoutMs` — per-job request timeout (default 300_000)
- `maxAttempts` / `backoffDelayMs` / `backoffType` where applicable

**Why:**

The reference `@workflow-worlds/redis@0.2.2` ships ~6 runtime deps; we were
shipping 8-11 across most packages. Dropping the three deps above brings every
world in line. Build outputs are smaller, install trees are leaner, and the
in-repo `world-upstash` precedent (already on this architecture) made the
target shape obvious.
