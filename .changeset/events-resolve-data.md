---
'@fantasticfour/world-cloudflare': patch
'@fantasticfour/world-firestore-tasks': patch
---

Honour `resolveData` when reading events.

Both worlds applied `resolveData` to runs, steps and hooks but ignored it for
events, so `events.get`, `events.list` and `events.listByCorrelationId` returned
full `eventData` even when the caller asked for `'none'`. That is how callers
avoid shipping large payloads, and the observability dashboard `@workflow/web`
requests `'none'` for its list views, so every dashboard list pulled complete
event payloads over the wire from these two worlds.

Both now use the same `filterEventData` helper the other seven worlds already
share, which removes the `eventData` key entirely rather than setting it to
undefined. The default stays `'all'`.

Tests assert key absence rather than an undefined value, since an
undefined-valued key would satisfy a looser check while diverging from the
sibling worlds.
