---
"@fantasticfour/world-cloudflare": patch
"@fantasticfour/world-firestore-tasks": patch
"@fantasticfour/world-postgres-redis": patch
"@fantasticfour/world-postgres-upstash": patch
"@fantasticfour/world-redis": patch
"@fantasticfour/world-redis-bullmq": patch
---

Clean up package dependencies

- Remove unused `@vercel/queue` dependency from world-cloudflare, world-firestore-tasks, and world-postgres-upstash
- Move `dotenv` to devDependencies in world-postgres-redis, world-postgres-upstash, world-redis, and world-redis-bullmq (only used in CLI setup tools, not runtime)

This reduces bundle sizes for consumers.
