---
"@fantasticfour/world-firestore-tasks": patch
---

Preserve `error.code` on failed runs. `serializeError` dropped
`eventData.errorCode`, so coded failures (e.g. `MAX_EVENTS_EXCEEDED`)
surfaced with an undefined code.
