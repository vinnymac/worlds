---
'@fantasticfour/world-nats-jetstream': minor
---

Replace the monolithic `nats` package with the split `@nats-io/transport-node`, `@nats-io/jetstream`, and `@nats-io/kv` packages. The old `nats` package is in maintenance mode, so this is the actively developed line now. JetStream and KV access move from methods on the connection (`nc.jetstream()`, `js.views.kv()`) to standalone functions and a `Kvm` handle. The package's own public API is unchanged.
