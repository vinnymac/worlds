---
'@fantasticfour/world-redis': minor
---

Fence queue acks and defers against reclaimed claims. When a worker stalled past its heartbeat TTL, the reclaimer returned its message to the ready list for another worker, but the stalled worker's later ack still released the idempotency reservation while the redelivery was running, letting a third copy be enqueued, and its later defer parked a duplicate in the delayed set. Both now settle shared state only if the message is still in the worker's own processing list, and otherwise do nothing (logged under debug).
