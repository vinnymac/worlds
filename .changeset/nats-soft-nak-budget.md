---
'@fantasticfour/world-nats-jetstream': patch
---

Stop `{ timeoutSeconds }` suspensions from exhausting core's queue delivery
budget, which killed healthy runs as runaways.

`{ timeoutSeconds }` is core's control-flow signal, not a failed delivery:
`sleep()`, step retry backoff, `TooEarlyError`, and `{ timeoutSeconds: 0 }`
("re-invoke me with a fresh replay", returned whenever the `stateUpdatedAt`
precondition guard exhausts its reloads or `run_completed` is rejected as
stale). The worker reported `msg.info.deliveryCount` directly as `attempt`, and
JetStream's only durable redelivery timer is `nak(delay)`, which always
increments `num_delivered`. Every suspension therefore pushed the counter core
reads as `attempt` one step closer to `MAX_QUEUE_DELIVERIES` (48), past which
core emits `run_failed`/`step_failed` with "exceeded maximum queue deliveries"
and ends the run despite nothing having gone wrong. Measured against a real
JetStream consumer, 12 consecutive suspensions reported attempts 1 through 13.

Suspensions are now tallied per message in a `<jobPrefix>queue_soft_naks` KV
bucket and subtracted back out, so `attempt` reflects failed deliveries only.
The tally lives in KV rather than in memory so it survives a worker restart or
consumer rebalance, and the first delivery of a message skips the read
entirely. Genuine failures still increment `attempt`, so core's poison-pill
escalation continues to fire on a truly stuck message.

`max_deliver` rises from 64 to 320. Soft naks unavoidably share JetStream's
delivery counter, so the cap now has to clear the 256-suspension safety ceiling
plus core's own 48-failure budget; at the old value a legitimately long-sleeping
run would have been dropped by JetStream before core could record anything.
Existing durable consumers are reconciled in place on startup, as before.

A soft-nak ceiling of 256 (mirroring world-upstash's `MAX_SOFT_REPUBLISHES` and
world-local's safety limit) bounds consecutive suspensions. Past it the delivery
is nak'd as a real failure and logged, so the run ends with a recorded error
rather than a message spinning silently.
