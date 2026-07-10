---
'@fantasticfour/world-upstash': minor
---

Pass a retry budget to QStash that matches core's delivery expectation.

QStash's default hard-failure retry count is small (3 on the free plan), well
below core's `MAX_QUEUE_DELIVERIES` (48). Publishes (including the
`{ timeoutSeconds }` self-republish) now request 47 retries — 48 total
deliveries — so transient handler failures are redelivered right up to the
point where core would give up, instead of QStash dropping the message first.
The count is configurable via the new `qstashRetries` world option (QStash
still clamps it to your plan's maximum).
