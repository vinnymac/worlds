---
'@fantasticfour/world-redis': patch
---

Bump `ioredis` to v6. RESP3 is now the default wire protocol, but `replyMapping` defaults to `"legacy"`, so reply shapes stay identical to v5 and no runtime changes are needed. The Node.js 20+ floor is already met. Two internal `zrange`/`zrevrange` call sites needed type-only fixes for v6's stricter, now string-only `stop` argument typing.
