---
'@fantasticfour/world-cloudflare': patch
---

Honour `resolveData` on the `events.create` return path too.

Fixing the three event readers left the create path unfiltered: the outcome
event crossed the DO boundary and was returned with full `eventData` regardless
of what the caller asked for. Every sibling world already filters here.

The largest leak was the `run_started` duplicate-creation preload, which
returns the run's entire event log. Under `resolveData: 'none'` it was
returning every event with full payloads, which is the opposite of what that
option is for.

`resolveData` is now resolved once in `events.create` and applied to the
returned event and the preload via the same `stripEventDataRefs` the read
paths use.
