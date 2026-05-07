---
"@fantasticfour/world-azure": patch
"@fantasticfour/world-cloudflare": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-mysql-redis": patch
"@fantasticfour/world-mysql": patch
"@fantasticfour/world-nats-jetstream": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-redis-bullmq": patch
"@fantasticfour/world-redis": patch
"@fantasticfour/world-upstash": patch
---

Port `events.create` bug fixes and improvements from `@workflow/world-postgres@4.1.1` to all world storage implementations:

- **run_started idempotency**: When run is already `running`, return existing run without appending a duplicate event
- **Resilient start**: When `run_started` arrives for a non-existent run with eventData, bootstrap the run + synthetic `run_created` event atomically (recovery from partial start failures)
- **RunExpiredError**: Throw `RunExpiredError` (not generic error) for `run_started` on terminal runs so the runtime exits without retrying; use `EntityConflictError` for other terminal state transitions
- **Strip run_started eventData**: `run_started` events no longer store eventData (belongs on `run_created` only)
- **Step cancelled terminal state**: Add `'cancelled'` to step terminal state checks
- **Preloaded events (TTFB)**: `run_started` response now includes all events for the run, allowing the runtime to skip the initial `events.list` call
