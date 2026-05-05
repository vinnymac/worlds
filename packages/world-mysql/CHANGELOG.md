# @fantasticfour/world-mysql

## 1.1.0

### Minor Changes

- cac9b57: feat(world-mysql): Add pure MySQL world with zero external dependencies

  Implements world-mysql using MySQL 8.0+ for storage, queueing, and streaming with no external dependencies (no Redis, no QStash).

  **Architecture:**

  - Storage: MySQL with Drizzle ORM + CBOR serialization
  - Queue: MySQL tables with FOR UPDATE SKIP LOCKED row-level locking
  - Streaming: MySQL polling at 100ms intervals

  **Key Innovation:**
  Uses MySQL 8.0+ `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent job queue processing, providing similar semantics to Redis BRPOPLPUSH but entirely within MySQL.

  **Key Features:**

  - Zero external dependencies - pure MySQL implementation
  - Atomic job claiming via MySQL row-level locks
  - Idempotency via ON DUPLICATE KEY UPDATE
  - Exponential backoff retry with configurable max attempts
  - FIFO job processing with configurable worker concurrency
  - TestContainers-based integration tests

  **Performance:**

  - Queue latency: <200ms p95 (polling-based)
  - Throughput: 50+ jobs/sec with 10 workers
  - Suitable for cost-sensitive deployments

  **Requirements:**

  - MySQL 8.0.1+ (for SKIP LOCKED support)

  **Use Cases:**

  - Simple deployments without Redis/external queue dependencies
  - Cost-sensitive environments (single database, lower operational complexity)
  - Existing MySQL infrastructure
  - Development and testing environments
