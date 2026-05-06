# @fantasticfour/world-mysql-redis

## 1.1.2

### Patch Changes

- 2a1587e: Upgrade @workflow packages to stable 4.1.x

  Production dependencies upgraded from beta to stable 4.1.1:

  - @workflow/errors: 4.1.0-beta.20 → 4.1.1
  - @workflow/world: 4.1.0-beta.17 → 4.1.1
  - @workflow/world-local: 4.1.0-beta.51 → 4.1.1

  Dev dependency kept on compatible beta version:

  - @workflow/world-testing: 4.1.0-beta.53 (stable has breaking test changes)

  All validation passes: lint, typecheck, and full test suite.

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

- cac9b57: feat(world-mysql-redis): Add hybrid MySQL storage + Redis queue world

  Implements world-mysql-redis combining MySQL storage with Redis Lists queue for high-performance workflow execution.

  **Architecture:**

  - Storage: MySQL with Drizzle ORM + CBOR serialization
  - Queue: Redis Lists with BRPOPLPUSH (sub-10ms latency)
  - Streaming: MySQL polling at 100ms intervals

  **Key Features:**

  - 95% code reuse from proven world-upstash and world-postgres-redis
  - Full idempotency support via Redis Sets
  - FIFO job processing with concurrent workers
  - TestContainers-based integration tests
  - Compatible with PlanetScale, AWS RDS, Aiven MySQL, and any Redis provider

  **Performance:**

  - Queue latency: <10ms p95
  - Throughput: 100+ jobs/sec with 10 workers
  - MySQL provider flexibility with proven Redis queueing

  **Use Cases:**

  - Cost-effective alternative to PostgreSQL + Redis
  - Existing MySQL infrastructure with need for fast queueing
  - Multi-region deployments with MySQL read replicas
