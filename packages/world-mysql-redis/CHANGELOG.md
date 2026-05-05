# @fantasticfour/world-mysql-redis

## 1.1.0

### Minor Changes

- cac9b57: feat(world-mysql-redis): Add hybrid MySQL storage + Redis queue world

  Implements world-mysql-redis combining MySQL storage with Redis Lists queue for high-performance workflow execution.

  **Architecture:**

  - Storage: MySQL with Drizzle ORM + CBOR serialization
  - Queue: Redis Lists with BRPOPLPUSH (sub-10ms latency)
  - Streaming: MySQL polling at 100ms intervals

  **Key Features:**

  - 95% code reuse from proven world-mysql-upstash and world-postgres-redis
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
