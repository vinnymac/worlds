# @fantasticfour/world-mysql-redis

Hybrid world implementation combining MySQL for durable storage with Redis Lists for high-performance queue management.

## Features

- **Storage**: MySQL with Drizzle ORM + CBOR serialization
- **Queue**: Redis Lists with BRPOPLPUSH (sub-10ms latency)
- **Streaming**: MySQL polling at 100ms intervals
- **Performance**: 100+ jobs/sec with default 10 workers
- **Compatibility**: Works with PlanetScale, AWS RDS, Aiven MySQL, and any Redis provider

## Installation

```bash
pnpm add @fantasticfour/world-mysql-redis
```

## Quick Start

### 1. Set up environment variables

```bash
WORKFLOW_MYSQL_URL="mysql://user:pass@host:3306/database"
WORKFLOW_REDIS_URL="redis://localhost:6379"
```

### 2. Initialize database schema

```bash
pnpm world-mysql-redis-setup
```

Or programmatically:

```typescript
import { sql } from '@fantasticfour/world-mysql-redis/cli';
await sql(); // Runs migrations
```

### 3. Create and use the world

```typescript
import { createWorld } from '@fantasticfour/world-mysql-redis';

const world = createWorld({
  databaseUrl: process.env.WORKFLOW_MYSQL_URL,
  redis: process.env.WORKFLOW_REDIS_URL,
  queueConcurrency: 10, // Number of workers per queue
  jobPrefix: 'workflow_', // Redis key prefix
});

await world.start();
```

## Configuration

```typescript
interface MysqlRedisWorldConfig {
  databaseUrl: string; // MySQL connection string
  redis: string | RedisOptions; // Redis connection string or options
  jobPrefix?: string; // Redis key prefix (default: 'workflow_')
  queueConcurrency?: number; // Workers per queue (default: 10)
  deploymentId?: string; // Optional deployment tracking ID
}
```

## Performance Characteristics

- **Queue Latency**: <10ms p95 (Redis BRPOPLPUSH)
- **Throughput**: 100+ jobs/sec with 10 workers
- **Storage**: MySQL provider-dependent (20-200ms)
- **Streaming**: 100ms polling interval

## Use Cases

- Cost-effective alternative to PostgreSQL + Redis
- Existing MySQL infrastructure with need for fast queueing
- Multi-region deployments with MySQL read replicas
- Teams already comfortable with MySQL

## Migration from Other Worlds

### From world-postgres-redis

Replace PostgreSQL with MySQL - the queue layer is identical (Redis Lists).

### From world-upstash

Replace QStash HTTP queue with Redis Lists for 10-20x lower latency.

## Database Schema

The world creates the following tables:

- `workflow.workflow_runs` - Workflow execution state
- `workflow.workflow_events` - Event sourcing
- `workflow.workflow_steps` - Step execution tracking
- `workflow.workflow_hooks` - Webhook/callback management
- `workflow.workflow_stream_chunks` - Streaming data

All tables use CBOR serialization for efficient binary storage with JSON fallback for compatibility.

## Requirements

- MySQL 5.7+ (8.0+ recommended)
- Redis 3.2+
- Node.js 18+

## License

Apache-2.0
