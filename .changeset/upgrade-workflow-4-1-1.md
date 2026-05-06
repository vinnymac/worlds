---
"@fantasticfour/world-mysql": patch
"@fantasticfour/world-mysql-redis": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-redis": patch
"@fantasticfour/world-redis-bullmq": patch
"@fantasticfour/world-nats-jetstream": patch
"@fantasticfour/world-azure": patch
"@fantasticfour/world-cloudflare": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-upstash": patch
---

Upgrade @workflow packages to stable 4.1.x

Production dependencies upgraded from beta to stable 4.1.1:
- @workflow/errors: 4.1.0-beta.20 → 4.1.1
- @workflow/world: 4.1.0-beta.17 → 4.1.1
- @workflow/world-local: 4.1.0-beta.51 → 4.1.1

Dev dependency kept on compatible beta version:
- @workflow/world-testing: 4.1.0-beta.53 (stable has breaking test changes)

All validation passes: lint, typecheck, and full test suite.
