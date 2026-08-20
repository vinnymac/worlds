---
'@fantasticfour/world-cloudflare': patch
'@fantasticfour/world-mysql-redis': patch
---

Ship the entrypoints these packages already built but never exported.

`world-cloudflare` re-exported `WorkflowRunDO` and `StreamDO` from
`src/worker.ts`, but `worker` was never a tsdown entry and `./worker` was never
an export, so the tarball contained neither class. Since the world reaches its
Durable Objects purely over `env.WORKFLOW_DB` RPC, a consumer had no way to
register them and `wrangler deploy` failed with `Your Worker depends on the
following Durable Objects, which are not exported in your entrypoint file`. The
classes are now published at `@fantasticfour/world-cloudflare/worker`, and the
README documents re-exporting them alongside the corrected binding names
(`WORKFLOW_DB`, `WORKFLOW_INDEX`, `WORKFLOW_QUEUE`, `WORKFLOW_STREAMS`) and the
required `new_sqlite_classes` migration.

`world-mysql-redis` built and shipped `dist/health.js` with no `./health`
subpath to reach it. `getHealth` is now importable from
`@fantasticfour/world-mysql-redis/health`.
