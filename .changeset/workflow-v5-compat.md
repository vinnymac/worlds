---
'@fantasticfour/world-cloudflare': minor
'@fantasticfour/world-azure': minor
'@fantasticfour/world-firestore-tasks': minor
'@fantasticfour/world-mysql': minor
'@fantasticfour/world-mysql-redis': minor
'@fantasticfour/world-nats-jetstream': minor
'@fantasticfour/world-postgres-redis': minor
'@fantasticfour/world-redis': minor
'@fantasticfour/world-redis-bullmq': minor
'@fantasticfour/world-upstash': minor
---

Update all worlds to the workflow SDK v5 contract (`@workflow/world` 5.0.0-beta.25, `@workflow/errors` 5.0.0-beta.16, `@workflow/core` 5.0.0-beta.40). Streams now live under the nested `streams` surface (`write`/`close`/`get`/`list`/`getChunks`/`getInfo`), the queue model is single-kind (flow only), and runs/events/hooks schemas carry the v5 `attributes`, `errorCode`, `encryptionPublicKey`, `resumeId`, `resumeContext`, and `resumeCapabilities` fields.
