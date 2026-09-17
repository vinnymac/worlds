---
'@fantasticfour/world-firestore-tasks': minor
---

Add a `dispatchDeadlineMs` option for the Cloud Tasks it creates. Cloud Tasks waits 10 minutes by default for an HTTP task's response, then marks the attempt `DEADLINE_EXCEEDED` and retries it, while the first request may still be running. A consumer whose steps run longer can now set a deadline that outlasts them, up to Cloud Tasks' 30 minute maximum. Values outside 15s to 30min throw at construction. Unset, Cloud Tasks' default applies as before.
