---
'@fantasticfour/world-cloudflare': patch
---

Stop `{ timeoutSeconds }` suspensions from consuming Cloudflare's retry budget,
which dead-lettered healthy runs after as few as three suspensions.

`{ timeoutSeconds }` is core's control-flow signal, not a failed delivery:
`sleep()`, step retry backoff, `TooEarlyError`, and `{ timeoutSeconds: 0 }`
("re-invoke me with a fresh replay", returned whenever the `stateUpdatedAt`
precondition guard exhausts its reloads or `run_completed` is rejected as
stale). The handler answered those with 503 + `Retry-After`, which the consumer
Worker maps onto `message.retry()`. Cloudflare Queues has no way to redeliver
without consuming an attempt, so every suspension both advanced
`CF-Queue-Retry-Count` (the counter core reads as `attempt`, capped at
`MAX_QUEUE_DELIVERIES` = 48) and burned one of the consumer's `max_retries`.
With the documented `max_retries = 3`, a workflow that merely slept a few times
was dead-lettered and the run wedged with no `run_failed` event ever recorded.

Suspensions now re-send a delayed copy of the envelope and ack, leaving the
retry budget untouched. The copy carries the original `messageId` plus a
`deliveryFailures` total so real failures still accumulate across suspensions
(matching world-upstash), and a `suspensionCount` bounded at 256 fails the
delivery loudly rather than letting a message re-send itself forever.

The consumer-side dedup claim now keys off the envelope's own `messageId`
rather than `CF-Queue-Message-Id`. A re-sent copy is a new Cloudflare message,
so keying on Cloudflare's id would have made the copy look like a duplicate of
the message it replaced, and it would have been acked without executing.

The reference `wrangler.toml` raises `max_retries` from 3 to 50. This budget is
now failures only, and it has to clear core's 48 before Cloudflare dead-letters
the message, otherwise the run wedges before core can record the failure.
