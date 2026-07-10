---
'@fantasticfour/world-cloudflare': minor
---

Align `world-cloudflare` with `@workflow/world` 4.2.1: transactional event
core, reliable queue semantics, and the typed error taxonomy.

All event-sourced writes now flow through a shared `apply-event` core that
runs guards, schema validation, event append, and entity mutation inside a
single `ctx.storage.transaction()`. The storage layout moved from single
aggregate values (which hit the Durable Object per-value size cap and could
wedge runs) to one key per event, step, and hook with real cursor pagination.
The DO schema bumps to v2 with no back-compat shim; this is a pre-production
change and aggregate v1 keys are dropped.

The production queue consumer now claims an idempotency key via a claim DO
before invoking the handler, and returns 503 with a `Retry-After` header for
`timeoutSeconds` dispatches instead of acking prematurely. `hooks.get` is
implemented (previously a 501 stub), the `runs.list` page-boundary drop is
fixed, and `specVersion` is declared with a binary-safe envelope.

The streamer was rewritten to speak pure RPC to `StreamDO` with one chunk
per key and a DO-internal monotonic index. The typed error taxonomy adopted
by `@workflow/core` is now matched by name, and `hook_created` conflict
semantics follow the 4.2.1 contract.
