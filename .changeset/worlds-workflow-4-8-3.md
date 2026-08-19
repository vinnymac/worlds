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

Add full support for workflow 4.8.3 across every world, along with fixes for duplicate creation events, concurrent replay, fat payload encoding, Azure batch verification, and Firestore error codes.

`createStreamer` now returns `CloudflareStreamer`, which declares that `writeToStream` and `closeStream` accept an unresolved `Promise<string>` run id. Every world already implemented that contract; only the return type hid it.
