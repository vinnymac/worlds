---
'@fantasticfour/world-azure': patch
'@fantasticfour/world-nats-jetstream': patch
---

Production-ready Azure Cosmos DB and NATS JetStream implementations

**Azure Cosmos DB (`@fantasticfour/world-azure`):**
- Implement CBOR binary serialization for workflow data (input/output/metadata)
- Add 409 Conflict error handling for idempotent document creation (emulator upsert is broken)
- Fix EventSchema validation to use decoded eventData
- Integrate official `@testcontainers/azure-cosmosdb-emulator` for testing
- Remove unused imports (lint clean)
- All 6 spec tests passing (100%)

**NATS JetStream (`@fantasticfour/world-nats-jetstream`):**
- Add defensive null checks when iterating KV bucket history (7 locations)
- Resolve race conditions in concurrent operations
- All 6 spec tests passing (100%)

Both worlds are now production-ready with full test coverage, proper error handling, and passing lints/types.
