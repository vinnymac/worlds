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

Use the official `stripEventDataRefs` instead of dropping `eventData` wholesale.

Every world carried its own `filterEventData`, which deleted the entire
`eventData` key when `resolveData` was `'none'`. The official worlds do not do
that. `@workflow/world-local`, `@workflow/world-postgres` and
`@workflow/world-vercel` all use `stripEventDataRefs`, exported from
`@workflow/world`, and none of them contains a wholesale delete.

The difference is the display metadata. `stripEventDataRefs` removes only the
large ref field for the event type (`input` for `step_created`, `result` for
`step_completed`, `payload` for `hook_received`, and so on) and keeps the rest,
so a `step_created` read with `'none'` returns `eventData: { stepName }` rather
than nothing at all. Our worlds were discarding exactly the fields the
`@workflow/web` dashboard needs to label a row, which is what `'none'` is meant
to preserve while dropping the payload. Event types with no ref fields, such as
`step_started` and `wait_created`, are now returned untouched instead of losing
their `eventData`.

`stripEventDataRefs` has been exported since world 4.4.0, so this was a
divergence from an available helper rather than a gap being filled. Each world
drops its local copy along with the `as Event` cast it required.

world-azure additionally had no event filtering at all: `resolveData` was
honoured for runs, steps and hooks but ignored for every event reader and for
the `events.create` return path, including the `run_started` preload that
returns the run's entire event log. All of those now filter.

Tests were added or rewritten per world to pin the upstream contract. They
assert against event types that actually carry ref fields, since a type absent
from the ref map makes `'none'` a no-op and would pass vacuously; several of the
previous assertions had that flaw.
