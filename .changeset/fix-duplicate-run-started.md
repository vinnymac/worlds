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

Fix duplicate `run_started` event emitted during workflow replay after step completion. Added idempotency guard to the `run_started` handler in all world storage implementations: if the run is already past `pending` status, return existing run state without creating a duplicate event. The upstream runtime checks `status === 'pending'` before emitting `run_started`, but the storage layer now enforces this as defense-in-depth.
