---
'@fantasticfour/world-firestore-tasks': patch
---

Honour `resolveData` on the `events.create` return path too.

Fixing the three event readers left the create path unfiltered: twelve return
sites handed back the event they had just written with full `eventData`,
regardless of what the caller asked for. Every sibling world already filters
here.

The largest leak was the `run_started` preload, which returns the run's entire
event log. Under `resolveData: 'none'` it was returning every event with full
payloads, which is the opposite of what that option is for.

`resolveData` is now resolved once at the top of `events.create` and applied to
every returned event including the preload, so the exhaustiveness is greppable
rather than a per-branch habit. The idempotent `run_started` replay is untouched
because it returns no event.
