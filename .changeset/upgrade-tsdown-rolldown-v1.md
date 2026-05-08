---
"@fantasticfour/world-azure": patch
"@fantasticfour/world-cloudflare": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-mysql": patch
"@fantasticfour/world-mysql-redis": patch
"@fantasticfour/world-nats-jetstream": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-redis": patch
"@fantasticfour/world-redis-bullmq": patch
"@fantasticfour/world-upstash": patch
---

Bump tsdown to ^0.22.0 so the bundler resolves rolldown@1.0.0 (stable v1)
instead of the prior 1.0.0-rc.17. tsdown 0.22 drops Node < 22.18 support,
makes `unrun` optional, and adds a `tsx` config loader; CI already runs
Node 24, which uses the native TS config loader and needs neither.
No consumer-facing API change.
