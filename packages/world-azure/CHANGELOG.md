# @fantasticfour/world-azure

## 1.1.1

### Patch Changes

- 2a1587e: Upgrade @workflow packages to stable 4.1.x

  Production dependencies upgraded from beta to stable 4.1.1:

  - @workflow/errors: 4.1.0-beta.20 → 4.1.1
  - @workflow/world: 4.1.0-beta.17 → 4.1.1
  - @workflow/world-local: 4.1.0-beta.51 → 4.1.1

  Dev dependency kept on compatible beta version:

  - @workflow/world-testing: 4.1.0-beta.53 (stable has breaking test changes)

  All validation passes: lint, typecheck, and full test suite.

## 1.1.0

### Minor Changes

- 7da6262: Add production-ready Azure Cosmos DB and NATS JetStream world implementations

  **Azure Cosmos DB (`@fantasticfour/world-azure`):**

  - Implement CBOR binary serialization for workflow data (input/output/metadata)
  - Add 409 Conflict error handling for idempotent document creation (emulator upsert is broken)
  - Fix EventSchema validation to use decoded eventData
  - Integrate official `@testcontainers/azure-cosmosdb-emulator` for testing
  - Add HTTPS agent configuration to handle emulator's self-signed certificates
  - Switch to `:vnext-preview` Docker image tag for ARM64 compatibility (Apple Silicon support)
  - Add SSL initialization delay for improved test stability
  - Enterprise-ready cloud deployment with proper SSL configuration
  - All 6 spec tests passing (100%)

  **NATS JetStream (`@fantasticfour/world-nats-jetstream`):**

  - Add defensive null checks when iterating KV bucket history (7 locations)
  - Resolve race conditions in concurrent operations
  - Fixed `TypeError: Cannot read properties of undefined (reading 'operation')` during concurrent operations
  - Single binary, distributed by default, with native streaming capabilities
  - All 6 spec tests passing (100%)

  Both worlds are production-ready with full test coverage, proper error handling, and passing lints/types.
