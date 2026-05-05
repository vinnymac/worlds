# @fantasticfour/world-mysql

Pure MySQL world implementation with zero external dependencies. Uses MySQL 8.0+ for storage, queueing, and streaming.

## Features

- **Storage**: MySQL with Drizzle ORM + CBOR serialization
- **Queue**: MySQL tables with `FOR UPDATE SKIP LOCKED` row-level locking
- **Streaming**: MySQL polling at 100ms intervals
- **Performance**: 50+ jobs/sec with default 10 workers
- **Zero Dependencies**: No Redis, no QStash - just MySQL

## Installation

```bash
pnpm add @fantasticfour/world-mysql
```

## Quick Start

### 1. Set up environment variable

```bash
DATABASE_URL="mysql://user:pass@host:3306/database"
```

### 2. Initialize database schema

```bash
pnpm world-mysql-setup
```

Or programmatically:

```typescript
import { setupDatabase } from '@fantasticfour/world-mysql/cli';
await setupDatabase(); // Runs migrations
```

### 3. Create and use the world

```typescript
import { createWorld } from '@fantasticfour/world-mysql';

const world = createWorld({
  databaseUrl: process.env.DATABASE_URL,
  queueConcurrency: 10, // Number of workers per queue
  pollInterval: 100, // Queue polling interval (ms)
  maxRetryAttempts: 3, // Max job retries
});

await world.start();
```

## Configuration

```typescript
interface MysqlWorldConfig {
  databaseUrl: string; // MySQL connection string
  deploymentId?: string; // Optional deployment tracking ID
  queueConcurrency?: number; // Workers per queue (default: 10)
  pollInterval?: number; // Queue poll interval in ms (default: 100)
  maxRetryAttempts?: number; // Max retries (default: 3)
}
```

## Performance Characteristics

- **Queue Latency**: <200ms p95 (polling-based)
- **Throughput**: 50+ jobs/sec with 10 workers
- **Storage**: MySQL provider-dependent (20-200ms)
- **Streaming**: 100ms polling interval

## Key Innovation

Uses MySQL 8.0+ `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent job queue processing:

```sql
SELECT * FROM workflow_jobs
WHERE queue_name = ? AND status = 'pending'
ORDER BY id
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

This provides similar semantics to Redis `BRPOPLPUSH` but entirely within MySQL, enabling:

- Atomic job claiming (no race conditions)
- Concurrent workers without blocking
- FIFO job processing
- Built-in MySQL transaction guarantees

## Use Cases

- **Simple Deployments**: Single database, lower operational complexity
- **Cost-Sensitive**: No additional Redis/queue service costs
- **Development/Testing**: Easy local setup with just MySQL
- **Existing MySQL Shops**: Teams already running MySQL
- **PlanetScale Users**: Works great with PlanetScale's MySQL-compatible database

## Database Schema

Creates the following tables:

- `workflow.workflow_runs` - Workflow execution state
- `workflow.workflow_events` - Event sourcing
- `workflow.workflow_steps` - Step execution tracking
- `workflow.workflow_hooks` - Webhook/callback management
- `workflow.workflow_stream_chunks` - Streaming data
- `workflow.workflow_jobs` - **Job queue**
- `workflow.workflow_job_idempotency` - **Idempotency tracking**

## Requirements

**Critical**: MySQL 8.0.1+ required for `SKIP LOCKED` support

Compatible providers:

- MySQL 8.0+
- PlanetScale
- AWS RDS for MySQL 8.0+
- Aiven MySQL
- Google Cloud SQL for MySQL
- Azure Database for MySQL

## Migration from Other Worlds

### From world-mysql-upstash

Replace QStash HTTP queue with pure MySQL queue. Same MySQL schema for storage.

### From world-mysql-redis

Remove Redis dependency - all queue logic moves to MySQL tables.

## Performance Tuning

### Adjust Poll Interval

Lower for lower latency (more database load):

```typescript
createWorld({ pollInterval: 50 }); // 50ms polling = ~20ms avg latency
```

Higher for lower database load:

```typescript
createWorld({ pollInterval: 500 }); // 500ms polling = lower DB queries
```

### Adjust Concurrency

More workers = higher throughput:

```typescript
createWorld({ queueConcurrency: 20 }); // 20 workers per queue
```

### Connection Pooling

The world automatically sets connection pool size to `2 × workers + 5`.

## Error Handling

Jobs automatically retry with exponential backoff:

- Attempt 1: Immediate
- Attempt 2: 2 seconds delay
- Attempt 3: 4 seconds delay
- Attempt 4+: Marked as failed

Configure max attempts:

```typescript
createWorld({ maxRetryAttempts: 5 });
```

## Idempotency

Uses MySQL `ON DUPLICATE KEY UPDATE` for race-condition-safe idempotency:

```typescript
// Same idempotency key = same job (no duplicates)
await world.queue('__wkf_workflow_abc', message, {
  idempotencyKey: 'unique-key-123',
});
```

## License

Apache-2.0
