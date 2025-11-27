# @fantasticfour/world-postgres-redis

Hybrid workflow backend combining PostgreSQL for durable storage with Redis Lists for queue management. Provides SQL queryability and maximum durability while maintaining performant job processing.

## Why Use This Package

- **SQL Queryability**: Query workflow runs, steps, and events with SQL
- **Maximum Durability**: PostgreSQL ACID guarantees for workflow state
- **Relational Data**: Join workflows with your application tables
- **Audit & Compliance**: SQL-based reporting and audit trails
- **Hybrid Performance**: Postgres durability + Redis queue speed

Best for applications that need SQL access to workflow data, strong consistency guarantees, or integration with existing PostgreSQL databases.

## Installation

```bash
pnpm add @fantasticfour/world-postgres-redis
```

## Prerequisites

- **PostgreSQL**: 13+ required
- **Redis**: 6+ required

## Usage

### Environment Variables

```bash
# Required
export WORKFLOW_POSTGRES_URL="postgresql://user:password@localhost:5432/workflows"
export WORKFLOW_REDIS_URL="redis://localhost:6379"  # or REDIS_URL

# Optional
export WORKFLOW_POSTGRES_JOB_PREFIX="workflow_"         # Default: 'workflow_'
export WORKFLOW_POSTGRES_WORKER_CONCURRENCY="10"       # Default: 10
```

### Programmatic Usage

```typescript
import { createWorld } from '@fantasticfour/world-postgres-redis';

const world = createWorld({
  connectionString: 'postgresql://user:password@localhost:5432/workflows',
  redis: 'redis://localhost:6379',
  // or use RedisOptions object:
  // redis: { host: 'localhost', port: 6379, password: 'secret' },

  // Optional
  jobPrefix: 'workflow_',
  queueConcurrency: 10,
});

await world.start();
```

## Database Setup

### Running Migrations

The package includes a CLI tool to set up the database schema:

```bash
# Run migrations
pnpm --filter @fantasticfour/world-postgres-redis db:push

# Or with environment variables
WORKFLOW_POSTGRES_URL="postgresql://..." pnpm db:push
```

### Database Schema

The migrations create the following tables:

- `workflow_runs` - Workflow execution records
- `workflow_steps` - Individual step executions
- `workflow_events` - Event history
- `workflow_hooks` - Lifecycle hooks

All tables use ULID-based primary keys for monotonic ordering and include timestamps and indexes for efficient querying.

## Architecture

- **Storage**: PostgreSQL with Drizzle ORM
- **Queue**: Redis Lists (LPUSH/BRPOP pattern)
- **Streaming**: Redis Pub/Sub
- **Migrations**: Drizzle Kit for schema management
- **IDs**: ULID-based for sortable identifiers

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connectionString` | `string` | Required | PostgreSQL connection URL |
| `redis` | `string \| RedisOptions` | `redis://localhost:6379` | Redis connection URL or ioredis options |
| `jobPrefix` | `string` | `workflow_` | Prefix for Redis job queue keys |
| `queueConcurrency` | `number` | `10` | Number of concurrent queue workers |

## Querying Workflow Data

Query workflows directly with SQL:

```sql
-- Find all failed workflows in the last 24 hours
SELECT * FROM workflow_runs
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '24 hours';

-- Get step execution history for a run
SELECT * FROM workflow_steps
WHERE run_id = 'your-run-id'
ORDER BY created_at ASC;

-- Join with your application data
SELECT w.*, u.email
FROM workflow_runs w
JOIN users u ON w.user_id = u.id
WHERE w.status = 'running';
```

## Local Development

```bash
# Start PostgreSQL and Redis with Docker
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15-alpine
docker run -d -p 6379:6379 redis:7-alpine

# Set environment
export WORKFLOW_POSTGRES_URL="postgresql://postgres:postgres@localhost:5432/workflows"
export WORKFLOW_REDIS_URL="redis://localhost:6379"

# Run migrations
pnpm db:push

# Run your workflows
```

## When to Choose This Package

**Use world-postgres-redis when:**
- You need SQL queryability for workflow data
- Maximum durability and ACID guarantees required
- Integration with existing PostgreSQL databases
- Reporting and analytics on workflow execution
- Audit trails and compliance requirements

**Consider alternatives when:**
- Pure in-memory speed is priority → use @fantasticfour/world-redis
- You need advanced queue features → use @fantasticfour/world-redis-bullmq
- You're on serverless platforms → use @fantasticfour/world-neon-upstash
- You're on AWS → use @fantasticfour/world-dynamodb-sqs

## Performance Considerations

- **Write Latency**: Postgres writes are slower than pure Redis
- **Connection Pooling**: Use connection pooling (pg-pool) for production
- **Indexes**: Schema includes indexes on common query patterns
- **Queue Performance**: Redis Lists provide fast job processing
- **Scaling**: Scale Postgres reads with replicas, Redis with Sentinel/Cluster

## License

Apache License
