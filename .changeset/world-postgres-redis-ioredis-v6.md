---
'@fantasticfour/world-postgres-redis': patch
---

Bump `ioredis` to v6. RESP3 is now the default wire protocol, but `replyMapping` defaults to `"legacy"`, so reply shapes stay identical to v5 and no source changes are needed. It also requires Node.js 20+, already satisfied by this repo's Node 24 baseline.
