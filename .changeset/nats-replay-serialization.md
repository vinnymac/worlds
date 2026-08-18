---
"@fantasticfour/world-nats-jetstream": patch
---

Serialize concurrent deliveries for the same workflow run in the queue
worker. Two workers could replay one run simultaneously, each allocating its
own `step_created` event, corrupting the event log with
`ReplayDivergenceError`. Step deliveries remain fully parallel; only
workflow-run replays are chained per run, matching the upstream
world-postgres mitigation.
