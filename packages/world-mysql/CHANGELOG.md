# @fantasticfour/world-mysql

## 1.1.1

### Patch Changes

- fecc1da: docs: rename world-mysql-upstash to world-upstash and fix Docker images

  **Documentation updates:**

  - Renamed `@fantasticfour/world-mysql-upstash` to `@fantasticfour/world-upstash` across all package documentation
  - Updated cross-references in README files and migration guides

  **CI/Test fixes:**

  - Replaced deprecated AWS ECR public mirror images (`public.ecr.aws/docker/library/*`) with official Docker Hub images
  - Fixed HTTP 404 errors in GitHub Actions workflows and testcontainers
  - Updated to use: `postgres:15-alpine`, `redis:7-alpine`, `mysql:8.0`, `nats:2.10-alpine`

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
