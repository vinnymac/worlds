---
'@fantasticfour/world-mysql-redis': patch
---

Bump `ioredis` to v6. It defaults to RESP3 now, but keeps legacy RESP2-shaped replies unless you opt into `replyMapping: "resp3"`, so the queue's Lua scripts, list/zset commands, multi/exec, and brpoplpush calls all still work as-is. The Node 20+ floor is already met.
