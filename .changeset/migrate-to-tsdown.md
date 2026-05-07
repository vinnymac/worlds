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

Migrate bundler from `tsup` to `tsdown` (Rolldown-based) across all world packages. Build is significantly faster and configs are simpler. Public `exports` map and emitted file extensions (`.js`, `.d.ts`) are unchanged. `dotenv` continues to be externalized in CLI bundles. Code-splitting is enabled (Rolldown default), so multi-entry packages now emit shared `chunk-*.js` files alongside existing entry artifacts.
