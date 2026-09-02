---
'@fantasticfour/world-redis-bullmq': patch
---

Bump `bullmq` and `ioredis` to v6. `ioredis` now defaults to RESP3, but `replyMapping` stays `"legacy"`, so reply shapes are unchanged from v5. `bullmq` v6 made `ioredis` an optional peer instead of a bundled dependency, which we already declare directly. We fixed three type-only issues along the way: `bullmq`'s new `Queue` generics didn't infer cleanly through a typed `Map`, `ioredis`'s `zrange` `stop` argument is now string-only, and `bullmq`'s connection-options type doesn't yet allow the `retryStrategy: null` that ioredis v6 accepts.
