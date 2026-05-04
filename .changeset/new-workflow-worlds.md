---
"@fantasticfour/world-mysql-upstash": minor
"@fantasticfour/world-azure": minor
"@fantasticfour/world-nats-jetstream": minor
---

Add three new workflow world implementations

- **@fantasticfour/world-mysql-upstash**: MySQL database with Upstash QStash queuing. Production-ready with full test coverage (5/5 tests passing).
- **@fantasticfour/world-azure**: Azure Cosmos DB with Service Bus queuing. Enterprise-ready cloud deployment with proper SSL configuration and ARM64 support.
- **@fantasticfour/world-nats-jetstream**: NATS JetStream for self-hosted deployments. Single binary, distributed by default, with native streaming capabilities (6/6 tests passing).

All three worlds implement the complete @workflow/world interface with event-sourced storage, dual-mode queuing, and comprehensive test coverage using Testcontainers.
