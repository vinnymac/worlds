---
'@fantasticfour/world-azure': patch
'@fantasticfour/world-cloudflare': patch
'@fantasticfour/world-firestore-tasks': patch
'@fantasticfour/world-mysql': patch
'@fantasticfour/world-mysql-redis': patch
'@fantasticfour/world-nats-jetstream': patch
'@fantasticfour/world-postgres-redis': patch
'@fantasticfour/world-redis': patch
'@fantasticfour/world-redis-bullmq': patch
'@fantasticfour/world-upstash': patch
---

Track workflow 4.8.5, and scope correlation-id event lookups to a run.

Move the catalog to @workflow/core 4.8.5, @workflow/world 4.5.0, and
@workflow/world-testing 4.1.20. @workflow/errors 4.2.1 and @workflow/utils 4.1.4
are unchanged; 4.8.5 still pins both.

Verified against the tarballs rather than the version numbers. world 4.5.0
changes exactly two source files: `events.ts` adds an optional `runId` to
`ListEventsByCorrelationIdParams`, and `recovery.ts` gives `reenqueueActiveRuns`
an optional `namespace` that defaults to `resolveQueueNamespace()`. The
recovery change needs nothing from us: no world passes a namespace, and the
default resolves the same `__wkf_workflow_` prefix the callers hardcoded
before, so world-mysql and world-postgres-redis keep their existing behaviour
and pick up `WORKFLOW_QUEUE_NAMESPACE` support for free. world-testing 4.1.20
ships a byte-identical conformance suite (only its bundled test app was rebuilt
against the new core) and still publishes no `exports` map, so the `eventLimit`
deep import stays as it is. Comments naming the pinned world-testing version
move to 4.1.20.

`events.listByCorrelationId` now honours `runId`. A correlation id is unique
within its run, not across runs, so a global correlation index can return
same-id events belonging to sibling runs. Core 4.8.5 sends `runId`, and each
world now scopes on it, matching world-local and world-postgres: the predicate
is applied before the `limit` slice everywhere, so `hasMore` and the returned
cursor describe the scoped set rather than the unfiltered one. Omitting `runId`
keeps the previous unscoped behaviour, so older cores are unaffected.

How each world scopes depends on its engine. world-mysql, world-mysql-redis and
world-postgres-redis push a `run_id` equality into the existing drizzle `WHERE`
clause. world-azure adds a `c.runId` condition and sets the Cosmos partition key
to the run, turning a cross-partition fan-out into a single-partition read.
world-firestore-tasks adds a server-side `where('runId', '==', ...)` ahead of
its `orderBy`, which requires two new composite indexes (both sort directions);
they are declared in `firestore.indexes.json` and deployers must apply them with
`firebase deploy --only firestore:indexes`. world-nats-jetstream routes the
scoped case through its existing `events_by_run` KV index, making it
O(events in run) instead of a full-bucket scan. world-redis, world-redis-bullmq
and world-upstash page their correlation index and filter, accumulating until
`limit + 1` matches are found so pagination stays exact; the unscoped path still
costs a single round trip.

world-cloudflare is unchanged: its `listByCorrelationId` is a stub that returns
an empty page, so there is nothing to scope. Its stale comment now records why
it is unimplemented and that returning empty is a silent fallback.
